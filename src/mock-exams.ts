import express, { Router } from "express";
import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import ExcelJS from "exceljs";
import { wrap, parse, fail, audit, transaction, rate, type Config } from "./core.js";
import { moduleGuard, studentGuard } from "./auth.js";
import { lock } from "./database.js";
import { drawPaper, paperOf, paperQuestions, markPaper, normalisedAnswers, importMockPdf } from "./learning.js";

/**
 * Mock examinations. Stored as PortalRecords: MOCK:<id>, one ATTEMPT:<mock>:<student> per student
 * (the unique key is the one-attempt rule) and MAKEUP:<mock>:<student> for personal windows.
 * The server owns time: deadline = min(start + duration, the student's closing time).
 */
const text = (max = 3000) => z.string().trim().min(1).max(max);
const imageRef = z.string().trim().max(1500).default("").refine((v) => !v || /^https:\/\//.test(v), "Upload the diagram first.");
export const questionSchema = z
  .object({
    prompt: text(),
    options: z.array(text(1000)).min(2, "Give at least 2 options.").max(8, "Use at most 8 options."),
    answer: z.number().int().min(0).max(7),
    marks: z.number().min(0.5).max(100).default(1),
    passage: z.string().trim().max(8000).default(""),
    image: imageRef,
    explanation: z.string().max(1500).default(""),
  })
  .strict()
  .refine((q) => q.answer < q.options.length, "The correct answer must be one of the options.")
  .refine((q) => new Set(q.options.map((o) => o.toLowerCase())).size === q.options.length, "Two options are the same.");
export const mockSchema = z
  .object({
    title: text(200),
    subject: text(100),
    cohort: z.string().trim().max(80).default(""),
    studentIds: z.array(z.string().uuid()).max(3000).default([]),
    durationMinutes: z.number().int().min(1).max(300),
    opensAt: z.string().datetime(),
    closesAt: z.string().datetime(),
    instructions: z.string().trim().max(4000).default(""),
    shuffleQuestions: z.boolean().default(true),
    shuffleOptions: z.boolean().default(true),
    showAnswersAfterClose: z.boolean().default(false),
    passMark: z.number().min(0).max(100).default(50),
    published: z.boolean(),
    releaseResults: z.boolean().default(false),
    questionsPerAttempt: z.number().int().min(1).max(200).nullable().default(null),
    questions: z.array(questionSchema).min(1).max(200),
  })
  .strict()
  .refine((m) => m.opensAt < m.closesAt, "The closing time must be after the opening time.")
  .refine((m) => !m.questionsPerAttempt || m.questionsPerAttempt <= m.questions.length, "Questions per student cannot exceed the questions in the paper.");
type Mock = z.infer<typeof mockSchema>;
/** Everything that defines the paper itself is locked once a student has started; times are not. */
const lockedFields = ["questions", "durationMinutes", "questionsPerAttempt", "shuffleQuestions", "shuffleOptions"] as const;

const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
const ms = (iso: string) => new Date(iso).getTime();
const mockKey = (id: string) => "MOCK:" + id;
const attemptKey = (mockId: string, studentId: string) => "ATTEMPT:" + mockId + ":" + studentId;
const makeupKey = (mockId: string, studentId: string) => "MAKEUP:" + mockId + ":" + studentId;
/** Older mocks were saved before these settings existed; they keep their original behaviour. */
export const withDefaults = (data: any): Mock => ({ cohort: "", studentIds: [], instructions: "", shuffleQuestions: true, shuffleOptions: true, showAnswersAfterClose: false, passMark: 50, releaseResults: false, questionsPerAttempt: null, ...data });

interface Makeup { opensAt: string; closesAt: string }
/** Whether a student may see the exam: named students, else a cohort, else everyone. A make-up window always counts. */
export function assigned(mock: Mock, student: { id: string; cohort?: string | null }, makeup?: Makeup | null) {
  if (makeup) return true;
  if (mock.studentIds?.length) return mock.studentIds.includes(student.id);
  if (mock.cohort) return (student.cohort || "").trim().toLowerCase() === mock.cohort.trim().toLowerCase();
  return true;
}
export const windowFor = (mock: Mock, makeup?: Makeup | null) => (makeup ? { opensAt: makeup.opensAt, closesAt: makeup.closesAt } : { opensAt: mock.opensAt, closesAt: mock.closesAt });
export function stateOf(mock: Mock, makeup: Makeup | null | undefined, now = Date.now()) {
  const w = windowFor(mock, makeup);
  return now < ms(w.opensAt) ? "UPCOMING" : now > ms(w.closesAt) ? "CLOSED" : "OPEN";
}
/** Answers may be reviewed only when the exam has closed for everyone, make-ups included. */
export const closedForEveryone = (mock: Mock, makeups: Makeup[], now = Date.now()) => now > Math.max(ms(mock.closesAt), ...makeups.map((m) => ms(m.closesAt)));
export const bandOf = (percent: number, passMark: number) => (percent >= passMark ? "PASS" : "BELOW_PASS");
const percentOf = (score: number, maximum: number) => (maximum ? Math.round((score / maximum) * 1000) / 10 : 0);

/** Reads question rows from an Excel (.xlsx) or CSV file. Text is kept exactly as written. */
export async function sheetRows(file: Buffer): Promise<string[][]> {
  if (file.subarray(0, 2).toString() === "PK") {
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(file as any);
    const sheet = book.worksheets[0];
    if (!sheet) fail(422, "SHEET_EMPTY", "The workbook has no sheets.");
    const rows: string[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      for (let c = 1; c <= Math.max(row.cellCount, 12); c++) cells.push(String(row.getCell(c).text ?? ""));
      rows.push(cells);
    });
    return rows;
  }
  return parseCsv(file.toString("utf8"));
}
export function parseCsv(source: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ""; let quoted = false;
  const s = source.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c; continue; }
    if (c === '"') quoted = true; else if (c === ",") { row.push(cell); cell = ""; } else if (c === "\n" || c === "\r") { if (c === "\r" && s[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim()));
}
const letters = ["A", "B", "C", "D", "E", "F", "G", "H"];
export interface SheetQuestion { row: number; question: z.infer<typeof questionSchema> | null; problems: string[]; warnings: string[]; source: Record<string, string> }
/** Turns sheet rows into questions. Rows with problems are reported and never added; nothing is rewritten. */
export function questionsFromRows(rows: string[][]): SheetQuestion[] {
  const [head, ...body] = rows;
  if (!head) fail(422, "SHEET_EMPTY", "The file is empty.");
  const index: Record<string, number> = {};
  head.forEach((h, i) => { const key = h.trim().toLowerCase(); if (key && !(key in index)) index[key] = i; });
  if (!("question" in index) || !("answer" in index)) fail(422, "SHEET_HEADINGS", 'The first row must hold the headings, including "Question", "A", "B" and "Answer". Download the template to see the layout.');
  const cell = (r: string[], name: string) => (name in index ? String(r[index[name]] ?? "") : "");
  return body.map((r, i) => {
    const source: Record<string, string> = { question: cell(r, "question"), answer: cell(r, "answer"), marks: cell(r, "marks"), passage: cell(r, "passage") };
    letters.forEach((l) => (source[l] = cell(r, l.toLowerCase())));
    const problems: string[] = [], warnings: string[] = [];
    if (!source.question.trim()) problems.push("The question is empty.");
    const filled = letters.filter((l) => source[l].trim());
    const lastFilled = filled.length ? letters.indexOf(filled[filled.length - 1]) : -1;
    const gaps = letters.slice(0, lastFilled + 1).filter((l) => !source[l].trim());
    if (gaps.length) problems.push(`Choice ${gaps.join(", ")} is empty but a later choice is filled.`);
    if (filled.length < 2) problems.push("Give at least two choices.");
    const options = filled.map((l) => source[l]);
    const lower = options.map((o) => o.trim().toLowerCase());
    const dupes = filled.filter((_, k) => lower.indexOf(lower[k]) !== k);
    if (dupes.length) problems.push(`Choice ${dupes.join(", ")} repeats an earlier choice.`);
    const answer = source.answer.trim().toUpperCase();
    if (!answer) problems.push("The answer letter is missing.");
    else if (!letters.includes(answer) || !source[answer]?.trim()) problems.push(`Answer "${source.answer.trim()}" does not match a filled choice.`);
    let marks = 1;
    if (source.marks.trim()) { marks = Number(source.marks.trim()); if (!Number.isFinite(marks) || marks <= 0 || marks > 100) problems.push(`Marks "${source.marks.trim()}" must be a number from 0.5 to 100.`); }
    else warnings.push("No marks given: 1 mark.");
    let question: SheetQuestion["question"] = null;
    if (!problems.length) {
      const parsed = questionSchema.safeParse({ prompt: source.question, options, answer: letters.indexOf(answer), marks, passage: source.passage });
      if (parsed.success) question = parsed.data; else problems.push(...new Set(parsed.error.issues.map((x) => x.message)));
    }
    return { row: i + 2, question, problems, warnings, source };
  });
}

/**
 * The server owns time: an attempt whose deadline has passed is marked on the answers saved
 * before time ran out, even if the student never came back to submit.
 */
export async function finalise(db: PrismaClient | Prisma.TransactionClient, row: { id: string; data: unknown }, mock: Mock, now = Date.now()) {
  const a = row.data as any;
  if (a.submitted || now <= ms(a.deadline) + 5000) return a;
  const paper = paperOf(a, mock.questions);
  const final = normalisedAnswers(paper, a.answers);
  const { score, maximum } = markPaper(mock.questions, paper, final);
  const data = { ...a, submitted: true, submittedAt: a.deadline, answers: final, flags: [], expired: true, autoSubmitted: true, score, maximum, percent: percentOf(score, maximum) };
  await db.portalRecord.update({ where: { id: row.id }, data: { data: json(data) } });
  return data;
}
async function studentOf(db: PrismaClient | Prisma.TransactionClient, studentId: string) {
  const student = await db.student.findUnique({ where: { id: studentId }, select: { id: true, cohort: true, programme: true } });
  if (!student) fail(404, "NOT_FOUND", "Student not found.");
  return student;
}
const makeupFor = async (db: PrismaClient | Prisma.TransactionClient, mockId: string, studentId: string) => ((await db.portalRecord.findUnique({ where: { key: makeupKey(mockId, studentId) } }))?.data as unknown as Makeup) || null;
const makeupsOf = async (db: PrismaClient, mockId: string) => (await db.portalRecord.findMany({ where: { key: { startsWith: "MAKEUP:" + mockId + ":" } } })).map((r) => ({ studentId: r.key.split(":")[2], ...(r.data as any) }));
const saveSchema = z.object({ answers: z.array(z.number().int().min(-1).max(7)).max(200), flags: z.array(z.number().int().min(0).max(199)).max(200).default([]), focusLosses: z.number().int().min(0).max(10000).default(0) }).strict();

/** Student routes: list, start, autosave, submit, results and the post-close review. */
export function studentMockRouter(db: PrismaClient) {
  const r = Router();
  r.use(studentGuard);
  const sid = (req: any) => req.principal.studentId as string;
  r.get("/mocks", wrap(async (req, res) => {
    const student = await studentOf(db, sid(req));
    const [mocks, attempts, makeups] = await Promise.all([
      db.portalRecord.findMany({ where: { kind: "MOCK" }, orderBy: { createdAt: "desc" }, take: 500 }),
      db.portalRecord.findMany({ where: { kind: "ATTEMPT", studentId: student.id } }),
      db.portalRecord.findMany({ where: { kind: "MAKEUP", studentId: student.id } }),
    ]);
    const now = Date.now();
    const finalised = new Map<string, any>();
    for (const a of attempts) {
      const mockRow = mocks.find((m) => m.key === mockKey((a.data as any).mockId));
      finalised.set(a.id, mockRow ? await finalise(db, a, withDefaults(mockRow.data), now) : a.data);
    }
    res.json(mocks.flatMap((row) => {
      const mock = withDefaults(row.data); const id = row.key.slice(5);
      if (!mock.published) return [];
      const makeup = (makeups.find((m) => m.key === makeupKey(id, student.id))?.data as unknown as Makeup) || null;
      if (!assigned(mock, student, makeup)) return [];
      const attemptRow = attempts.find((a) => a.key === attemptKey(id, student.id));
      const attempt = attemptRow ? finalised.get(attemptRow.id) : undefined;
      const w = windowFor(mock, makeup);
      return [{ id, title: mock.title, subject: mock.subject, instructions: mock.instructions, durationMinutes: mock.durationMinutes, questionCount: mock.questionsPerAttempt || mock.questions.length, opensAt: w.opensAt, closesAt: w.closesAt, makeup: Boolean(makeup), state: stateOf(mock, makeup, now), attemptStatus: attempt ? (attempt.submitted ? "SUBMITTED" : "IN_PROGRESS") : null, resultReleased: Boolean(attempt?.submitted && mock.releaseResults) }];
    }));
  }));
  r.post("/mocks/:id/start", wrap(async (req, res) => {
    const mockId = parse(z.string().uuid(), req.params.id);
    const result = await transaction(db, async (tx) => {
      await lock(tx, "ATTEMPT:" + mockId + ":" + sid(req));
      const row = await tx.portalRecord.findUnique({ where: { key: mockKey(mockId) } });
      const mock = row ? withDefaults(row.data) : null;
      const student = await studentOf(tx, sid(req));
      const makeup = await makeupFor(tx, mockId, student.id);
      if (!mock?.published || !assigned(mock, student, makeup)) fail(404, "NOT_FOUND", "This mock exam is not available to you.");
      const key = attemptKey(mockId, student.id);
      let attempt = await tx.portalRecord.findUnique({ where: { key } });
      if (!attempt) {
        if (stateOf(mock, makeup) !== "OPEN") fail(409, "MOCK_CLOSED", stateOf(mock, makeup) === "UPCOMING" ? "This mock exam has not opened yet." : "This mock exam has closed.");
        const now = Date.now();
        const paper = drawPaper(mock.questions, { perAttempt: mock.questionsPerAttempt, shuffleQuestions: mock.shuffleQuestions, shuffleOptions: mock.shuffleOptions });
        const deadline = new Date(Math.min(now + mock.durationMinutes * 60000, ms(windowFor(mock, makeup).closesAt))).toISOString();
        attempt = await tx.portalRecord.create({ data: { key, kind: "ATTEMPT", studentId: student.id, data: json({ mockId, title: mock.title, subject: mock.subject, startedAt: new Date(now).toISOString(), deadline, ...paper, answers: paper.order.map(() => -1), flags: [], focusLosses: 0, submitted: false }) } });
      }
      const a = attempt.data as any;
      if (a.submitted) fail(409, "ALREADY_SUBMITTED", "You have already submitted this mock exam.");
      const paper = paperOf(a, mock.questions);
      return { mockId, title: a.title, subject: a.subject, startedAt: a.startedAt, deadline: a.deadline, serverNow: new Date().toISOString(), savedAt: a.savedAt || null, answers: normalisedAnswers(paper, a.answers), flags: a.flags || [], questions: paperQuestions(mock.questions, paper) };
    });
    res.json(result);
  }));
  r.put("/mocks/:id/answers", wrap(async (req, res) => {
    const mockId = parse(z.string().uuid(), req.params.id);
    const body = parse(saveSchema, req.body);
    const key = attemptKey(mockId, sid(req));
    const savedAt = new Date().toISOString();
    await transaction(db, async (tx) => {
      await lock(tx, key);
      const attempt = await tx.portalRecord.findUnique({ where: { key } });
      if (!attempt) fail(404, "NOT_FOUND", "Start the mock exam first.");
      const a = attempt.data as any;
      if (a.submitted) fail(409, "ALREADY_SUBMITTED", "This mock exam has already been submitted.");
      if (Date.now() > ms(a.deadline) + 5000) fail(409, "TIME_EXPIRED", "Time is up. Your last saved answers will be marked.");
      const mock = withDefaults((await tx.portalRecord.findUniqueOrThrow({ where: { key: mockKey(mockId) } })).data);
      const paper = paperOf(a, mock.questions);
      if (body.answers.length !== paper.order.length) fail(400, "ANSWERS", "Send one answer for each question.");
      await tx.portalRecord.update({ where: { id: attempt.id }, data: { data: json({ ...a, answers: normalisedAnswers(paper, body.answers), flags: [...new Set(body.flags.filter((n) => n < paper.order.length))], focusLosses: Math.max(Number(a.focusLosses) || 0, body.focusLosses), savedAt }) } });
    });
    res.json({ saved: true, savedAt, serverNow: savedAt });
  }));
  r.post("/mocks/:id/submit", wrap(async (req, res) => {
    const mockId = parse(z.string().uuid(), req.params.id);
    const body = parse(saveSchema, req.body);
    const key = attemptKey(mockId, sid(req));
    const result = await transaction(db, async (tx) => {
      await lock(tx, key);
      const attempt = await tx.portalRecord.findUnique({ where: { key } });
      if (!attempt) fail(404, "NOT_FOUND", "Start the mock exam first.");
      const a = attempt.data as any;
      if (a.submitted) return { submitted: true };
      const mock = withDefaults((await tx.portalRecord.findUniqueOrThrow({ where: { key: mockKey(mockId) } })).data);
      const paper = paperOf(a, mock.questions);
      const expired = Date.now() > ms(a.deadline) + 5000;
      if (!expired && body.answers.length !== paper.order.length) fail(400, "ANSWERS", "Send one answer for each question.");
      // Late submissions are marked on the answers saved before time ran out.
      const final = normalisedAnswers(paper, expired ? a.answers : body.answers);
      const { score, maximum } = markPaper(mock.questions, paper, final);
      await tx.portalRecord.update({ where: { id: attempt.id }, data: { data: json({ ...a, submitted: true, submittedAt: new Date().toISOString(), answers: final, flags: [], focusLosses: Math.max(Number(a.focusLosses) || 0, body.focusLosses), expired, score, maximum, percent: percentOf(score, maximum) }) } });
      await audit(tx, req.principal!.id, "MOCK_SUBMITTED", "PortalRecord", attempt.id, req.ip || "");
      return { submitted: true, expired };
    });
    res.json(result);
  }));
  r.get("/results", wrap(async (req, res) => {
    const student = sid(req);
    const manual = (await db.portalRecord.findMany({ where: { kind: "RESULT", studentId: student } })).filter((row) => (row.data as any).published).map((row) => ({ id: row.id, kind: "SCHOOL", ...(row.data as any) }));
    const attempts = await db.portalRecord.findMany({ where: { kind: "ATTEMPT", studentId: student } });
    const released = [];
    for (const row of attempts) {
      const mock = (await db.portalRecord.findUnique({ where: { key: mockKey((row.data as any).mockId) } }))?.data;
      if (!mock) continue;
      const m = withDefaults(mock);
      const a = await finalise(db, row, m);
      if (!a.submitted) continue;
      if (!m.releaseResults) continue;
      const maximum = Number(a.maximum) || 0, percent = a.percent ?? percentOf(Number(a.score) || 0, maximum);
      const reviewAvailable = m.showAnswersAfterClose && closedForEveryone(m, await makeupsOf(db, a.mockId));
      released.push({ id: row.id, kind: "MOCK", mockId: a.mockId, title: a.title, subject: a.subject, score: a.score, maximum, percent, band: bandOf(percent, m.passMark), passMark: m.passMark, expired: Boolean(a.expired), submittedAt: a.submittedAt, reviewAvailable });
    }
    res.json([...released, ...manual]);
  }));
  r.get("/mocks/:id/review", wrap(async (req, res) => {
    const mockId = parse(z.string().uuid(), req.params.id);
    const attempt = (await db.portalRecord.findUnique({ where: { key: attemptKey(mockId, sid(req)) } }))?.data as any;
    const row = await db.portalRecord.findUnique({ where: { key: mockKey(mockId) } });
    if (!attempt?.submitted || !row) fail(404, "NOT_FOUND", "No submitted attempt for this mock exam.");
    const mock = withDefaults(row.data);
    // The key is shown only after release, when enabled, and once the exam has closed for everyone.
    if (!mock.releaseResults || !mock.showAnswersAfterClose || !closedForEveryone(mock, await makeupsOf(db, mockId))) fail(403, "REVIEW_UNAVAILABLE", "The answer review opens after the exam has closed for everyone.");
    const paper = paperOf(attempt, mock.questions);
    const answers = normalisedAnswers(paper, attempt.answers);
    res.json({ title: mock.title, subject: mock.subject, score: attempt.score, maximum: attempt.maximum, questions: paperQuestions(mock.questions, paper).map((q, i) => ({ ...q, chosen: answers[i], correct: paper.optionOrders[i].indexOf(mock.questions[paper.order[i]].answer), explanation: mock.questions[paper.order[i]].explanation || "" })) });
  }));
  return r;
}

/** Staff routes: builder, Excel/CSV/PDF import, assignment look-up, make-ups, live results, extra time and release. */
export function staffMockRouter(db: PrismaClient, config?: Config) {
  const r = Router();
  r.get("/mocks", moduleGuard("exams"), wrap(async (_req, res) => {
    const [rows, attempts] = await Promise.all([
      db.portalRecord.findMany({ where: { kind: "MOCK" }, orderBy: { createdAt: "desc" }, take: 500 }),
      db.portalRecord.findMany({ where: { kind: "ATTEMPT" }, select: { key: true, data: true } }),
    ]);
    res.json(rows.map((row) => {
      const id = row.key.slice(5);
      const mine = attempts.filter((a) => a.key.startsWith("ATTEMPT:" + id + ":"));
      return { ...row, data: withDefaults(row.data), started: mine.length, submitted: mine.filter((a) => (a.data as any).submitted).length, locked: mine.length > 0 };
    }));
  }));
  r.put("/mocks/:id", moduleGuard("exams", true), wrap(async (req, res) => {
    const mockId = parse(z.string().uuid(), req.params.id);
    const data = parse(mockSchema, req.body);
    const key = mockKey(mockId);
    const saved = await transaction(db, async (tx) => {
      await lock(tx, key);
      const before = await tx.portalRecord.findUnique({ where: { key } });
      if (before && (await tx.portalRecord.count({ where: { kind: "ATTEMPT", key: { startsWith: "ATTEMPT:" + mockId + ":" } } }))) {
        const old = withDefaults(before.data);
        const changed = lockedFields.filter((f) => JSON.stringify(old[f] ?? null) !== JSON.stringify((data as any)[f] ?? null));
        if (changed.length) fail(409, "MOCK_LOCKED", "A student has started this mock exam, so its questions, duration and shuffle settings are locked. You can still change the times, assignment and results settings. Duplicate the exam to make a new version.");
      }
      if (data.studentIds.length) {
        const found = await tx.student.count({ where: { id: { in: data.studentIds } } });
        if (found !== new Set(data.studentIds).size) fail(422, "STUDENTS_UNKNOWN", "Some chosen students no longer exist. Choose them again.");
      }
      const row = await tx.portalRecord.upsert({ where: { key }, create: { key, kind: "MOCK", data: json(data) }, update: { data: json(data) } });
      await audit(tx, req.principal!.id, before ? "MOCK_UPDATED" : "MOCK_CREATED", "PortalRecord", row.id, req.ip || "", undefined, { title: data.title, questions: data.questions.length, published: data.published });
      return row;
    });
    res.json(saved);
  }));
  r.post("/mocks/import", moduleGuard("exams", true), express.raw({ type: "application/pdf", limit: "15mb" }), wrap(async (req, res) => {
    if (!config) fail(503, "AI_NOT_CONFIGURED", "PDF import is not available.");
    if (!Buffer.isBuffer(req.body)) fail(415, "NOT_PDF", "Upload a PDF question paper.");
    await rate(db, "mock-import:" + req.principal!.id, 20, 3600);
    const result = await importMockPdf(config, req.body);
    await transaction(db, (tx) => audit(tx, req.principal!.id, "MOCK_PDF_IMPORTED", "PortalRecord", "mock-import", req.ip || "", undefined, { questions: result.questions.length, bytes: req.body.length }));
    res.json(result);
  }));
  r.post("/mocks/import-sheet", moduleGuard("exams", true), express.raw({ type: () => true, limit: "5mb" }), wrap(async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) fail(415, "NO_FILE", "Choose an Excel (.xlsx) or CSV file.");
    await rate(db, "mock-sheet:" + req.principal!.id, 60, 3600);
    let rows: string[][];
    try { rows = await sheetRows(req.body); } catch (error: any) { if (error?.status) throw error; fail(422, "SHEET_UNREADABLE", "This file could not be read. Save it as .xlsx or CSV and try again."); }
    if (rows.length > 501) fail(422, "SHEET_TOO_LONG", "Import at most 500 questions at a time.");
    const checked = questionsFromRows(rows);
    res.json({ rows: checked, ready: checked.filter((c) => c.question).length });
  }));
  r.get("/mocks/template.xlsx", moduleGuard("exams"), wrap(async (_req, res) => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("Questions");
    sheet.addRow(["Question", "A", "B", "C", "D", "E", "F", "G", "H", "Answer", "Marks", "Passage"]);
    sheet.addRow(["What is 7 × 8?", "54", "56", "58", "64", "", "", "", "", "B", 1, ""]);
    sheet.addRow(["Which word in the passage means 'happy'?", "Gloomy", "Cheerful", "Tired", "Angry", "", "", "", "", "B", 2, "Ada was cheerful as she walked to school."]);
    sheet.getRow(1).font = { bold: true };
    sheet.columns.forEach((c, i) => (c.width = i === 0 || i === 11 ? 48 : 14));
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="mock-questions-template.xlsx"');
    res.send(Buffer.from(await book.xlsx.writeBuffer()));
  }));
  r.get("/mocks/students", moduleGuard("exams"), wrap(async (req, res) => {
    const q = parse(z.string().trim().max(80).default(""), req.query.q);
    const students = await db.student.findMany({
      where: q ? { OR: [{ firstName: { contains: q, mode: "insensitive" } }, { lastName: { contains: q, mode: "insensitive" } }, { studentId: { contains: q.toUpperCase() } }] } : {},
      select: { id: true, studentId: true, firstName: true, lastName: true, cohort: true, programme: true }, orderBy: { lastName: "asc" }, take: q ? 50 : 3000,
    });
    res.json(students);
  }));
  r.get("/mocks/:id/makeups", moduleGuard("exams"), wrap(async (req, res) => res.json(await makeupsOf(db, parse(z.string().uuid(), req.params.id)))));
  r.put("/mocks/:id/makeups/:studentId", moduleGuard("exams", true), wrap(async (req, res) => {
    const mockId = parse(z.string().uuid(), req.params.id), studentId = parse(z.string().uuid(), req.params.studentId);
    const body = parse(z.object({ opensAt: z.string().datetime(), closesAt: z.string().datetime() }).strict().refine((w) => w.opensAt < w.closesAt, "The make-up must close after it opens."), req.body);
    if (!(await db.portalRecord.findUnique({ where: { key: mockKey(mockId) } }))) fail(404, "NOT_FOUND", "Mock exam not found.");
    await studentOf(db, studentId);
    const attempt = (await db.portalRecord.findUnique({ where: { key: attemptKey(mockId, studentId) } }))?.data as any;
    if (attempt?.submitted) fail(409, "ALREADY_SUBMITTED", "This student has already submitted the exam.");
    const key = makeupKey(mockId, studentId);
    await transaction(db, async (tx) => {
      await tx.portalRecord.upsert({ where: { key }, create: { key, kind: "MAKEUP", studentId, data: json(body) }, update: { data: json(body) } });
      await audit(tx, req.principal!.id, "MOCK_MAKEUP_SET", "PortalRecord", key, req.ip || "", undefined, body);
    });
    res.json({ studentId, ...body });
  }));
  r.delete("/mocks/:id/makeups/:studentId", moduleGuard("exams", true), wrap(async (req, res) => {
    const key = makeupKey(parse(z.string().uuid(), req.params.id), parse(z.string().uuid(), req.params.studentId));
    await db.portalRecord.deleteMany({ where: { key } });
    res.json({ removed: true });
  }));
  r.get("/mocks/:id/results", moduleGuard("exams"), wrap(async (req, res) => res.json(await resultsOf(db, parse(z.string().uuid(), req.params.id)))));
  r.get("/mocks/:id/results.csv", moduleGuard("exams"), wrap(async (req, res) => {
    const data = await resultsOf(db, parse(z.string().uuid(), req.params.id));
    const cell = (v: unknown) => { let t = String(v ?? ""); if (/^[=+@\-\t\r]/.test(t)) t = "'" + t; return '"' + t.replaceAll('"', '""') + '"'; };
    const lines = [["Student ID", "Name", "Cohort", "Status", "Score", "Out of", "Percent", "Band", "Left the exam screen", "Started", "Submitted"], ...data.students.map((s) => [s.studentId, s.name, s.cohort, s.status, s.score ?? "", s.maximum ?? "", s.percent ?? "", s.band ?? "", s.focusLosses ?? "", s.startedAt ?? "", s.submittedAt ?? ""])];
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${data.title.replace(/[^\w .-]/g, "_").slice(0, 80)}-results.csv"`);
    res.send("﻿" + lines.map((l) => l.map(cell).join(",")).join("\r\n"));
  }));
  r.post("/mocks/:id/attempts/:studentId/extra-time", moduleGuard("exams", true), wrap(async (req, res) => {
    const mockId = parse(z.string().uuid(), req.params.id), studentId = parse(z.string().uuid(), req.params.studentId);
    const { minutes } = parse(z.object({ minutes: z.union([z.literal(5), z.literal(10), z.literal(15)]) }).strict(), req.body);
    const key = attemptKey(mockId, studentId);
    const result = await transaction(db, async (tx) => {
      await lock(tx, key);
      const attempt = await tx.portalRecord.findUnique({ where: { key } });
      const a = attempt?.data as any;
      if (!attempt || a.submitted) fail(409, "NOT_WRITING", "Extra time can only be given to a student who is still writing.");
      if (Date.now() > ms(a.deadline) + 5000) fail(409, "TIME_EXPIRED", "This student's time has already run out.");
      const deadline = new Date(ms(a.deadline) + minutes * 60000).toISOString();
      await tx.portalRecord.update({ where: { id: attempt.id }, data: { data: json({ ...a, deadline, extraMinutes: (Number(a.extraMinutes) || 0) + minutes }) } });
      await audit(tx, req.principal!.id, "MOCK_EXTRA_TIME", "PortalRecord", attempt.id, req.ip || "", undefined, { minutes });
      return { deadline };
    });
    res.json(result);
  }));
  r.put("/mocks/:id/release", moduleGuard("exams", true), wrap(async (req, res) => {
    const mockId = parse(z.string().uuid(), req.params.id);
    const { released } = parse(z.object({ released: z.boolean() }).strict(), req.body);
    const key = mockKey(mockId);
    await transaction(db, async (tx) => {
      await lock(tx, key);
      const row = await tx.portalRecord.findUnique({ where: { key } });
      if (!row) fail(404, "NOT_FOUND", "Mock exam not found.");
      await tx.portalRecord.update({ where: { id: row.id }, data: { data: json({ ...(row.data as any), releaseResults: released }) } });
      await audit(tx, req.principal!.id, released ? "MOCK_RESULTS_RELEASED" : "MOCK_RESULTS_WITHHELD", "PortalRecord", row.id, req.ip || "");
    });
    res.json({ released });
  }));
  return r;
}

/** Live progress and statistics for one exam: every assigned student, writing, submitted or not started. */
export async function resultsOf(db: PrismaClient, mockId: string) {
  const row = await db.portalRecord.findUnique({ where: { key: mockKey(mockId) } });
  if (!row) fail(404, "NOT_FOUND", "Mock exam not found.");
  const mock = withDefaults(row.data);
  const [rawAttempts, makeups] = await Promise.all([db.portalRecord.findMany({ where: { kind: "ATTEMPT", key: { startsWith: "ATTEMPT:" + mockId + ":" } } }), makeupsOf(db, mockId)]);
  const attempts = await Promise.all(rawAttempts.map(async (row) => ({ ...row, data: await finalise(db, row, mock) })));
  const where: Prisma.StudentWhereInput = mock.studentIds.length ? { id: { in: mock.studentIds } } : mock.cohort ? { cohort: { equals: mock.cohort, mode: "insensitive" } } : {};
  const ids = new Set([...attempts.map((a) => a.studentId!), ...makeups.map((m) => m.studentId)]);
  const students = await db.student.findMany({ where: { OR: [where, { id: { in: [...ids] } }] }, select: { id: true, studentId: true, firstName: true, lastName: true, cohort: true }, take: 5000 });
  const now = Date.now();
  const list = students.map((s) => {
    const a = attempts.find((x) => x.studentId === s.id)?.data as any;
    const makeup = makeups.find((m) => m.studentId === s.id) || null;
    const writing = a && !a.submitted && now <= ms(a.deadline) + 5000;
    const status = !a ? "NOT_STARTED" : a.submitted ? "SUBMITTED" : writing ? "WRITING" : "TIME_UP";
    const percent = a?.submitted ? a.percent ?? percentOf(Number(a.score) || 0, Number(a.maximum) || 0) : null;
    return { id: s.id, studentId: s.studentId, name: `${s.firstName} ${s.lastName}`.trim(), cohort: s.cohort || "", status, score: a?.submitted ? a.score : null, maximum: a?.submitted ? a.maximum : null, percent, band: percent === null ? null : bandOf(percent, mock.passMark), focusLosses: a ? Number(a.focusLosses) || 0 : null, startedAt: a?.startedAt || null, submittedAt: a?.submittedAt || null, deadline: a?.deadline || null, extraMinutes: a?.extraMinutes || 0, makeup };
  }).sort((x, y) => x.name.localeCompare(y.name));
  const marked = list.filter((s) => s.percent !== null).map((s) => s.percent as number);
  const stats = marked.length ? { average: Math.round((marked.reduce((t, n) => t + n, 0) / marked.length) * 10) / 10, highest: Math.max(...marked), lowest: Math.min(...marked), passRate: Math.round((marked.filter((p) => p >= mock.passMark).length / marked.length) * 1000) / 10 } : null;
  const count = (status: string) => list.filter((s) => s.status === status).length;
  return { id: mockId, title: mock.title, subject: mock.subject, cohort: mock.cohort, passMark: mock.passMark, releaseResults: mock.releaseResults, opensAt: mock.opensAt, closesAt: mock.closesAt, progress: { writing: count("WRITING"), submitted: count("SUBMITTED"), notStarted: count("NOT_STARTED"), timeUp: count("TIME_UP") }, stats, students: list };
}
