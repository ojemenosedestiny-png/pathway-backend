import { Router } from "express";
import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import crypto from "node:crypto";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { wrap, parse, fail, audit, transaction, rate, type Config } from "./core.js";
import { moduleGuard } from "./auth.js";
import { lock } from "./database.js";
import { storage } from "./storage.js";

/**
 * Forms: the registration form (always present) and any form staff publish.
 * One submission per student per form (the record key is unique). Students read only their own.
 */
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

export const fieldTypes = ["short", "long", "number", "date", "email", "phone", "single", "multiple", "dropdown", "file", "photo"] as const;
const choiceTypes = new Set(["single", "multiple", "dropdown"]);
export const fieldSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, "Field ids use letters, numbers, - and _."),
  type: z.enum(fieldTypes),
  label: z.string().trim().min(1, "Every field needs a label.").max(200),
  help: z.string().trim().max(500).default(""),
  required: z.boolean().default(false),
  options: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
  step: z.string().trim().max(80).default(""),
}).strict().superRefine((f, ctx) => {
  if (choiceTypes.has(f.type) && f.options.length < 2) ctx.addIssue({ code: "custom", message: `"${f.label}" needs at least two choices.` });
  if (choiceTypes.has(f.type) && new Set(f.options.map((o) => o.toLowerCase())).size !== f.options.length) ctx.addIssue({ code: "custom", message: `"${f.label}" has the same choice twice.` });
});
export type Field = z.infer<typeof fieldSchema>;
export const formSchema = z.object({
  title: z.string().trim().min(1, "Give the form a title.").max(150),
  description: z.string().trim().max(2000).default(""),
  fields: z.array(fieldSchema).min(1, "Add at least one field.").max(60),
  cohort: z.string().trim().max(80).default(""),
  opensAt: z.string().datetime().nullable().default(null),
  closesAt: z.string().datetime().nullable().default(null),
  published: z.boolean().default(false),
}).strict().superRefine((f, ctx) => {
  if (new Set(f.fields.map((x) => x.id)).size !== f.fields.length) ctx.addIssue({ code: "custom", message: "Two fields have the same id." });
  if (f.opensAt && f.closesAt && ms(f.closesAt) <= ms(f.opensAt)) ctx.addIssue({ code: "custom", message: "The closing time must be after the opening time." });
});
export type Form = z.infer<typeof formSchema> & { system?: boolean };

export const REGISTRATION = "registration";
/** The registration form every student has. Staff may adjust its fields; it is always published to everyone. */
export const registrationForm: Form = {
  system: true,
  title: "Registration form",
  description: "Tell us about yourself so the school can complete your registration. Your answers save as you go.",
  cohort: "", opensAt: null, closesAt: null, published: true,
  fields: [
    { id: "fullName", type: "short", label: "Full name", help: "As it appears on your school records.", required: true, options: [], step: "Personal details" },
    { id: "dateOfBirth", type: "date", label: "Date of birth", help: "", required: true, options: [], step: "Personal details" },
    { id: "gender", type: "dropdown", label: "Gender", help: "", required: true, options: ["Female", "Male"], step: "Personal details" },
    { id: "stateOfOrigin", type: "short", label: "State of origin", help: "", required: false, options: [], step: "Personal details" },
    { id: "email", type: "email", label: "Email address", help: "", required: true, options: [], step: "Contact" },
    { id: "phone", type: "phone", label: "Phone number", help: "For example 0803 123 4567.", required: true, options: [], step: "Contact" },
    { id: "address", type: "long", label: "Home address", help: "", required: true, options: [], step: "Contact" },
    { id: "guardianName", type: "short", label: "Parent or guardian name", help: "", required: true, options: [], step: "Parent or guardian" },
    { id: "guardianRelationship", type: "dropdown", label: "Relationship to you", help: "", required: true, options: ["Mother", "Father", "Guardian", "Other"], step: "Parent or guardian" },
    { id: "guardianPhone", type: "phone", label: "Parent or guardian phone", help: "", required: true, options: [], step: "Parent or guardian" },
    { id: "guardianEmail", type: "email", label: "Parent or guardian email", help: "", required: false, options: [], step: "Parent or guardian" },
    { id: "programme", type: "short", label: "Intended course or programme", help: "For example Medicine, or A Level Sciences.", required: true, options: [], step: "Course and previous school" },
    { id: "previousSchool", type: "short", label: "Previous school", help: "", required: true, options: [], step: "Course and previous school" },
    { id: "grades", type: "long", label: "Subjects and grades", help: "One per line, for example: English Language – B3.", required: true, options: [], step: "Course and previous school" },
    { id: "photo", type: "photo", label: "Passport photograph", help: "A clear, recent photo of your face on a plain background. JPG or PNG, up to 3 MB.", required: true, options: [], step: "Passport photo" },
  ],
};

export const formKey = (id: string) => "FORM:" + id;
export const submissionKey = (formId: string, studentId: string) => `FORMSUB:${formId}:${studentId}`;
const formIdSchema = z.union([z.literal(REGISTRATION), z.string().uuid()]);
export const statuses = ["NEW", "REVIEWED", "APPROVED", "NEEDS_CHANGES"] as const;
type Status = (typeof statuses)[number] | "DRAFT";
export interface Submission { formId: string; answers: Record<string, string | string[]>; status: Status; staffNote: string; reference: string; savedAt: string; submittedAt: string | null; reviewedAt?: string | null }

async function loadForm(db: PrismaClient | Prisma.TransactionClient, id: string): Promise<Form | null> {
  const row = await db.portalRecord.findUnique({ where: { key: formKey(id) } });
  if (row) return { ...(row.data as any), ...(id === REGISTRATION ? { system: true, published: true, cohort: "", opensAt: null, closesAt: null } : {}) };
  return id === REGISTRATION ? registrationForm : null;
}
export const visibleTo = (form: Form, cohort: string | null | undefined) => form.published && (!form.cohort || form.cohort === (cohort || ""));
export function windowState(form: Form, now = Date.now()): "OPEN" | "NOT_OPEN" | "CLOSED" {
  if (form.opensAt && now < ms(form.opensAt)) return "NOT_OPEN";
  if (form.closesAt && now > ms(form.closesAt)) return "CLOSED";
  return "OPEN";
}
const editable = (s: Submission | null) => !s || s.status === "DRAFT" || s.status === "NEEDS_CHANGES";

const phoneRe = /^\+?[\d\s()-]{7,20}$/, emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/**
 * Checks answers against the form. Every given value is checked; required fields only when `complete`.
 * Returns the cleaned answers and per-field error messages.
 */
export function checkAnswers(form: Form, raw: unknown, complete: boolean) {
  const input = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const answers: Record<string, string | string[]> = {};
  const errors: Record<string, string> = {};
  for (const f of form.fields) {
    const v = input[f.id];
    if (f.type === "multiple") {
      const list = Array.isArray(v) ? v.map(String) : [];
      const bad = list.filter((x) => !f.options.includes(x));
      if (bad.length) errors[f.id] = "Choose from the listed options.";
      else if (list.length) answers[f.id] = [...new Set(list)];
      if (complete && f.required && !list.length) errors[f.id] = "Choose at least one option.";
      continue;
    }
    const text = typeof v === "string" ? v.trim() : v === undefined || v === null ? "" : String(v).trim();
    if (!text) { if (complete && f.required) errors[f.id] = f.type === "photo" ? "Upload your photo." : f.type === "file" ? "Upload the file." : ["single", "dropdown"].includes(f.type) ? "Choose an option." : "This is required."; continue; }
    const max = f.type === "long" ? 5000 : 300;
    if (text.length > max) { errors[f.id] = `Keep this under ${max} characters.`; continue; }
    if (f.type === "number" && !/^-?\d+(\.\d+)?$/.test(text)) errors[f.id] = "Enter a number.";
    else if (f.type === "date" && (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(text + "T00:00:00Z")))) errors[f.id] = "Enter a date.";
    else if (f.type === "email" && !emailRe.test(text)) errors[f.id] = "Enter an email address, for example name@example.com.";
    else if (f.type === "phone" && !phoneRe.test(text)) errors[f.id] = "Enter a phone number, for example 0803 123 4567.";
    else if ((f.type === "single" || f.type === "dropdown") && !f.options.includes(text)) errors[f.id] = "Choose one of the listed options.";
    else if ((f.type === "file" || f.type === "photo") && !z.string().uuid().safeParse(text).success) errors[f.id] = "Upload the file again.";
    else answers[f.id] = text;
  }
  return { answers, errors };
}
/** Uploaded files must belong to this student and have passed the file check. */
async function checkFiles(db: PrismaClient, form: Form, answers: Record<string, string | string[]>, ownerId: string, errors: Record<string, string>) {
  for (const f of form.fields.filter((x) => (x.type === "file" || x.type === "photo") && answers[x.id])) {
    const doc = await db.document.findUnique({ where: { id: answers[f.id] as string } });
    const ok = doc && doc.ownerId === ownerId && !doc.public && ["PENDING", "APPROVED"].includes(doc.status) && (f.type !== "photo" || doc.mime.startsWith("image/"));
    if (!ok) { errors[f.id] = doc?.status === "SCANNING" ? "Your file is still being checked. Wait a moment, then try again." : "This file is not available. Upload it again."; delete answers[f.id]; }
  }
}
const referenceAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const newReference = () => "NWP-" + Array.from(crypto.randomBytes(8), (b) => referenceAlphabet[b % 32]).join("").replace(/^(.{4})/, "$1-");

const lastSaved = (row: { data: unknown } | null) => (row?.data as Submission | undefined) ?? null;

/** Fills a new registration draft from what the school already knows. */
async function registrationStart(db: PrismaClient, studentId: string): Promise<Record<string, string>> {
  const s = await db.student.findUnique({ where: { id: studentId }, include: { user: true } });
  const old = ((await db.portalRecord.findUnique({ where: { key: "REGISTRATION:" + studentId } }))?.data || {}) as Record<string, string>;
  const start: Record<string, string> = {
    fullName: s ? `${s.firstName} ${s.lastName}`.trim() : "",
    email: s?.user.email && !s.user.email.endsWith("@students.invalid") ? s.user.email : "",
    phone: s?.user.phone || "",
    programme: s?.programme || old.programme || "",
    dateOfBirth: s?.dob ? s.dob.toISOString().slice(0, 10) : "",
    address: old.address || "", previousSchool: old.currentSchool || "", guardianName: old.guardianName || "", guardianPhone: old.guardianPhone || "",
  };
  return Object.fromEntries(Object.entries(start).filter(([, v]) => v));
}

export function studentFormsRouter(db: PrismaClient) {
  const r = Router();
  const sid = (req: any) => req.principal.studentId as string;
  const me = async (req: any) => db.student.findUniqueOrThrow({ where: { id: sid(req) }, select: { id: true, cohort: true } });
  const formFor = async (req: any) => {
    const id = parse(formIdSchema, req.params.id);
    const [form, student] = await Promise.all([loadForm(db, id), me(req)]);
    const sub = lastSaved(await db.portalRecord.findUnique({ where: { key: submissionKey(id, student.id) } }));
    // A form that is unpublished or for another cohort stays readable only if the student already submitted it.
    if (!form || (!visibleTo(form, student.cohort) && !(sub && sub.status !== "DRAFT"))) fail(404, "NOT_FOUND", "This form is not available.");
    return { id, form, student, sub };
  };

  r.get("/", wrap(async (req, res) => {
    const student = await me(req);
    const rows = await db.portalRecord.findMany({ where: { kind: "FORM" } });
    const forms = new Map<string, Form>([[REGISTRATION, registrationForm]]);
    for (const row of rows) forms.set(row.key.slice(5), row.key === formKey(REGISTRATION) ? { ...(row.data as any), system: true, published: true, cohort: "", opensAt: null, closesAt: null } : (row.data as any));
    const subs = await db.portalRecord.findMany({ where: { kind: "FORM_SUBMISSION", studentId: student.id } });
    const mine = new Map(subs.map((s) => [(s.data as any).formId as string, s.data as unknown as Submission]));
    const list = [...forms.entries()]
      .filter(([id, f]) => visibleTo(f, student.cohort) || (mine.get(id) && mine.get(id)!.status !== "DRAFT"))
      .map(([id, f]) => { const s = mine.get(id); return { id, title: f.title, description: f.description, system: !!f.system, opensAt: f.opensAt, closesAt: f.closesAt, state: windowState(f), fieldCount: f.fields.length, status: s?.status || "NOT_STARTED", reference: s?.reference || null, submittedAt: s?.submittedAt || null, staffNote: s?.status === "NEEDS_CHANGES" ? s.staffNote : "" }; })
      .sort((a, b) => Number(b.system) - Number(a.system) || a.title.localeCompare(b.title));
    res.json(list);
  }));
  r.get("/:id", wrap(async (req, res) => {
    const { id, form, student, sub } = await formFor(req);
    const answers = sub?.answers ?? (id === REGISTRATION ? await registrationStart(db, student.id) : {});
    const files = await db.document.findMany({ where: { id: { in: form.fields.filter((f) => f.type === "file" || f.type === "photo").map((f) => answers[f.id]).filter((v): v is string => typeof v === "string") }, ownerId: req.principal!.id }, select: { id: true, filename: true, mime: true, status: true } });
    res.json({ id, title: form.title, description: form.description, fields: form.fields, state: windowState(form), closesAt: form.closesAt, opensAt: form.opensAt, answers, files, status: sub?.status || "NOT_STARTED", reference: sub?.reference || null, submittedAt: sub?.submittedAt || null, savedAt: sub?.savedAt || null, staffNote: sub?.staffNote || "" });
  }));
  r.put("/:id/draft", wrap(async (req, res) => {
    await rate(db, "form-draft:" + req.principal!.id, 600, 3600);
    const { id, form, student } = await formFor(req);
    if (windowState(form) !== "OPEN") fail(409, "FORM_CLOSED", windowState(form) === "CLOSED" ? "This form has closed." : "This form is not open yet.");
    const { answers } = checkAnswers(form, req.body?.answers, false);
    const key = submissionKey(id, student.id);
    const saved = await transaction(db, async (tx) => {
      await lock(tx, key);
      const before = lastSaved(await tx.portalRecord.findUnique({ where: { key } }));
      if (!editable(before)) fail(409, "ALREADY_SUBMITTED", "You have already submitted this form.");
      const data: Submission = { formId: id, answers, status: before?.status === "NEEDS_CHANGES" ? "NEEDS_CHANGES" : "DRAFT", staffNote: before?.staffNote || "", reference: before?.reference || "", savedAt: new Date().toISOString(), submittedAt: before?.submittedAt || null };
      await tx.portalRecord.upsert({ where: { key }, create: { key, kind: "FORM_SUBMISSION", studentId: student.id, data: json(data) }, update: { data: json(data) } });
      return data;
    });
    res.json({ savedAt: saved.savedAt });
  }));
  r.post("/:id/submit", wrap(async (req, res) => {
    await rate(db, "form-submit:" + req.principal!.id, 60, 3600);
    const { id, form, student } = await formFor(req);
    if (windowState(form) !== "OPEN") fail(409, "FORM_CLOSED", windowState(form) === "CLOSED" ? "This form has closed." : "This form is not open yet.");
    const { answers, errors } = checkAnswers(form, req.body?.answers, true);
    await checkFiles(db, form, answers, req.principal!.id, errors);
    if (Object.keys(errors).length) { res.status(422).json({ error: { code: "FORM_INCOMPLETE", message: "Some answers need attention. Check the highlighted fields.", fields: errors } }); return; }
    const key = submissionKey(id, student.id);
    const saved = await transaction(db, async (tx) => {
      await lock(tx, key);
      const before = lastSaved(await tx.portalRecord.findUnique({ where: { key } }));
      if (!editable(before)) fail(409, "ALREADY_SUBMITTED", "You have already submitted this form.");
      const now = new Date().toISOString();
      const data: Submission = { formId: id, answers, status: "NEW", staffNote: before?.status === "NEEDS_CHANGES" ? before.staffNote : "", reference: before?.reference || newReference(), savedAt: now, submittedAt: now };
      const row = await tx.portalRecord.upsert({ where: { key }, create: { key, kind: "FORM_SUBMISSION", studentId: student.id, data: json(data) }, update: { data: json(data) } });
      await audit(tx, req.principal!.id, "FORM_SUBMITTED", "PortalRecord", row.id, req.ip || "", undefined, { formId: id, reference: data.reference });
      return data;
    });
    res.json({ reference: saved.reference, submittedAt: saved.submittedAt, status: saved.status });
  }));
  return r;
}

export function staffFormsRouter(db: PrismaClient, config?: Config) {
  const r = Router();
  const submissionsOf = async (id: string) => {
    const rows = await db.portalRecord.findMany({ where: { kind: "FORM_SUBMISSION", key: { startsWith: `FORMSUB:${id}:` } } });
    const sent = rows.filter((row) => (row.data as any).status !== "DRAFT");
    const students = await db.student.findMany({ where: { id: { in: sent.map((s) => s.studentId!).filter(Boolean) } }, select: { id: true, studentId: true, firstName: true, lastName: true, cohort: true } });
    const byId = new Map(students.map((s) => [s.id, s]));
    return sent.map((row) => { const s = byId.get(row.studentId!); const d = row.data as unknown as Submission; return { studentId: row.studentId!, studentNumber: s?.studentId || "", name: s ? `${s.firstName} ${s.lastName}` : "Removed student", cohort: s?.cohort || "", ...d }; })
      .sort((a, b) => ms(b.submittedAt) - ms(a.submittedAt));
  };
  const formOr404 = async (raw: string) => { const id = parse(formIdSchema, raw); const form = await loadForm(db, id); if (!form) fail(404, "NOT_FOUND", "Form not found."); return { id, form }; };

  r.get("/", moduleGuard("applications"), wrap(async (_req, res) => {
    const rows = await db.portalRecord.findMany({ where: { kind: "FORM" } });
    const forms = new Map<string, Form>([[REGISTRATION, registrationForm]]);
    for (const row of rows) forms.set(row.key.slice(5), row.key === formKey(REGISTRATION) ? { ...(row.data as any), system: true, published: true } : (row.data as any));
    const subs = await db.portalRecord.findMany({ where: { kind: "FORM_SUBMISSION" }, select: { data: true } });
    const counts = new Map<string, { submitted: number; waiting: number }>();
    for (const s of subs) { const d = s.data as any; if (d.status === "DRAFT") continue; const c = counts.get(d.formId) || { submitted: 0, waiting: 0 }; c.submitted++; if (d.status === "NEW") c.waiting++; counts.set(d.formId, c); }
    res.json([...forms.entries()].map(([id, f]) => ({ id, ...f, system: !!f.system, state: windowState(f), ...(counts.get(id) || { submitted: 0, waiting: 0 }) }))
      .sort((a, b) => Number(b.system) - Number(a.system) || a.title.localeCompare(b.title)));
  }));
  r.put("/:id", moduleGuard("applications", true), wrap(async (req, res) => {
    const id = parse(formIdSchema, req.params.id);
    const data: Form = parse(formSchema, req.body);
    if (id === REGISTRATION) Object.assign(data, { published: true, cohort: "", opensAt: null, closesAt: null });
    const key = formKey(id);
    const row = await transaction(db, async (tx) => {
      const before = await tx.portalRecord.findUnique({ where: { key } });
      const saved = await tx.portalRecord.upsert({ where: { key }, create: { key, kind: "FORM", data: json(data) }, update: { data: json(data) } });
      await audit(tx, req.principal!.id, before ? "FORM_UPDATED" : "FORM_CREATED", "PortalRecord", saved.id, req.ip || "", undefined, { title: data.title, fields: data.fields.length, published: data.published });
      return saved;
    });
    res.json({ id, ...(row.data as any) });
  }));
  r.get("/:id/submissions", moduleGuard("applications"), wrap(async (req, res) => {
    const { id, form } = await formOr404(req.params.id);
    res.json({ form: { id, title: form.title, fields: form.fields, system: !!form.system }, submissions: (await submissionsOf(id)).map(({ answers: _a, ...rest }) => rest) });
  }));
  r.get("/:id/submissions.csv", moduleGuard("applications"), wrap(async (req, res) => {
    const { id, form } = await formOr404(req.params.id);
    const subs = await submissionsOf(id);
    const cell = (v: unknown) => { let t = String(v ?? ""); if (/^[=+@\-\t\r]/.test(t)) t = "'" + t; return '"' + t.replaceAll('"', '""') + '"'; };
    const fileFields = form.fields.filter((f) => f.type === "file" || f.type === "photo");
    const docs = await db.document.findMany({ where: { id: { in: subs.flatMap((s) => fileFields.map((f) => s.answers[f.id])).filter((v): v is string => typeof v === "string") } }, select: { id: true, filename: true } });
    const names = new Map(docs.map((d) => [d.id, d.filename]));
    const lagos = (iso: string | null) => (iso ? new Date(ms(iso) + 3600e3).toISOString().slice(0, 16).replace("T", " ") : "");
    const lines = [["Reference", "Student ID", "Name", "Cohort", "Status", "Submitted (Lagos time)", "Note to student", ...form.fields.map((f) => f.label)],
      ...subs.map((s) => [s.reference, s.studentNumber, s.name, s.cohort, s.status, lagos(s.submittedAt), s.staffNote, ...form.fields.map((f) => { const v = s.answers[f.id]; return Array.isArray(v) ? v.join("; ") : f.type === "file" || f.type === "photo" ? (v ? names.get(v) || "uploaded file" : "") : v ?? ""; })])];
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${form.title.replace(/[^\w .-]/g, "_").slice(0, 80)}-submissions.csv"`);
    res.send("﻿" + lines.map((l) => l.map(cell).join(",")).join("\r\n"));
  }));
  r.get("/:id/submissions/:studentId", moduleGuard("applications"), wrap(async (req, res) => {
    const { id, form } = await formOr404(req.params.id);
    const studentId = parse(z.string().uuid(), req.params.studentId);
    const sub = (await submissionsOf(id)).find((s) => s.studentId === studentId);
    if (!sub) fail(404, "NOT_FOUND", "Submission not found.");
    const files = await db.document.findMany({ where: { id: { in: form.fields.map((f) => sub.answers[f.id]).filter((v): v is string => typeof v === "string" && z.string().uuid().safeParse(v).success) } }, select: { id: true, filename: true, mime: true, status: true } });
    res.json({ form: { id, title: form.title, fields: form.fields }, submission: sub, files });
  }));
  r.put("/:id/submissions/:studentId/status", moduleGuard("applications", true), wrap(async (req, res) => {
    const { id } = await formOr404(req.params.id);
    const studentId = parse(z.string().uuid(), req.params.studentId);
    const body = parse(z.object({ status: z.enum(statuses), note: z.string().trim().max(1000).default("") }).strict(), req.body);
    if (body.status === "NEEDS_CHANGES" && !body.note) fail(400, "NOTE_REQUIRED", "Tell the student what to change.");
    const key = submissionKey(id, studentId);
    const saved = await transaction(db, async (tx) => {
      await lock(tx, key);
      const row = await tx.portalRecord.findUnique({ where: { key } });
      const d = lastSaved(row);
      if (!row || !d || d.status === "DRAFT") fail(404, "NOT_FOUND", "Submission not found.");
      const data: Submission = { ...d, status: body.status, staffNote: body.note, reviewedAt: new Date().toISOString() };
      await tx.portalRecord.update({ where: { key }, data: { data: json(data) } });
      await audit(tx, req.principal!.id, "FORM_SUBMISSION_STATUS", "PortalRecord", row.id, req.ip || "", { status: d.status }, { status: body.status });
      return data;
    });
    res.json({ status: saved.status, staffNote: saved.staffNote });
  }));
  /** Staff open a file only through a submission that holds it. */
  r.get("/:id/submissions/:studentId/files/:fileId", moduleGuard("applications"), wrap(async (req, res) => {
    const { id, form } = await formOr404(req.params.id);
    const studentId = parse(z.string().uuid(), req.params.studentId), fileId = parse(z.string().uuid(), req.params.fileId);
    const d = lastSaved(await db.portalRecord.findUnique({ where: { key: submissionKey(id, studentId) } }));
    if (!d || d.status === "DRAFT" || !form.fields.some((f) => (f.type === "file" || f.type === "photo") && d.answers[f.id] === fileId)) fail(404, "NOT_FOUND", "File unavailable.");
    const f = await db.document.findUnique({ where: { id: fileId } });
    if (!f || !["PENDING", "APPROVED"].includes(f.status)) fail(409, "FILE_UNAVAILABLE", "This file is not available.");
    if (!config?.S3_BUCKET) fail(503, "STORAGE_UNCONFIGURED", "File storage is not configured.");
    await db.auditLog.create({ data: { actorId: req.principal!.id, action: "FILE_DOWNLOAD", entity: "Document", entityId: f.id, ip: req.ip || "" } });
    const inline = req.query.view === "1" && f.mime.startsWith("image/");
    res.json({ url: await getSignedUrl(storage(config), new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: f.fileKey, ResponseContentDisposition: `${inline ? "inline" : "attachment"}; filename="${f.filename}"` }), { expiresIn: 60 }), expiresIn: 60, filename: f.filename });
  }));
  return r;
}
