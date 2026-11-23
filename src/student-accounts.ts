import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import argon2 from "argon2";
import { randomInt } from "node:crypto";
import { z } from "zod";
import { type Config, wrap, parse, fail, transaction, audit, idSchema } from "./core.js";
import { moduleGuard } from "./auth.js";
import { allocateStudentId } from "./payments.js";

/**
 * Staff-created student accounts: one at a time or from a CSV file, each with a friendly temporary
 * password (e.g. "Emerald-4827") that must be changed at first sign-in.
 */
const words = ["Emerald", "Harbour", "Lantern", "Orchard", "Compass", "Horizon", "Granite", "Juniper", "Sapphire", "Meridian", "Cardinal", "Starling", "Highland", "Kingfisher", "Evergreen", "Sunbird"];
export function friendlyPassword(pick: (max: number) => number = randomInt) {
  return words[pick(words.length)] + "-" + String(pick(10000)).padStart(4, "0");
}
/** Students without an email get a reserved, undeliverable address; the mail worker skips it. */
export const noEmailDomain = "students.invalid";
export const placeholderEmail = (studentId: string) => studentId.toLowerCase() + "@" + noEmailDomain;

const optionalText = (max: number) => z.string().trim().max(max).default("");
export const studentRowSchema = z
  .object({
    firstName: z.string().trim().min(1, "First name is missing.").max(80),
    lastName: z.string().trim().min(1, "Last name is missing.").max(80),
    email: z.string().trim().max(254).default("").refine((v) => !v || z.string().email().safeParse(v).success, "Email address is not valid."),
    phone: z.string().trim().max(25).default("").refine((v) => !v || /^\+?[0-9 ()-]{7,25}$/.test(v), "Phone number is not valid."),
    programme: optionalText(100),
    cohort: optionalText(80),
  })
  .strict();
export type StudentRow = z.infer<typeof studentRowSchema>;
export interface RowCheck { row: number; input: Record<string, unknown>; value?: StudentRow; errors: string[] }

/** Validates every row and reports all problems per row, including duplicates in the file and existing emails. */
export async function checkRows(db: PrismaClient, rows: unknown[]): Promise<RowCheck[]> {
  const checks: RowCheck[] = rows.map((input, index) => {
    const result = studentRowSchema.safeParse(input);
    return result.success
      ? { row: index + 1, input: input as Record<string, unknown>, value: { ...result.data, email: result.data.email.toLowerCase() }, errors: [] }
      : { row: index + 1, input: (input || {}) as Record<string, unknown>, errors: [...new Set(result.error.issues.map((issue) => issue.message))] };
  });
  const seen = new Map<string, number>();
  for (const check of checks) {
    const email = check.value?.email;
    if (!email) continue;
    if (seen.has(email)) check.errors.push(`Same email as row ${seen.get(email)}.`);
    else seen.set(email, check.row);
  }
  const emails = [...seen.keys()];
  if (emails.length) {
    const taken = new Set((await db.user.findMany({ where: { email: { in: emails } }, select: { email: true } })).map((u) => u.email));
    for (const check of checks) if (check.value?.email && taken.has(check.value.email)) check.errors.push("This email already has an account.");
  }
  return checks;
}

export function studentAccountsRouter(db: PrismaClient, config: Config) {
  const r = Router();
  const rowsBody = z.object({ rows: z.array(z.record(z.unknown())).min(1, "Add at least one student.").max(1000, "Import at most 1,000 students at a time.") }).strict();

  r.post("/preview", moduleGuard("students", true), wrap(async (req, res) => {
    const { rows } = parse(rowsBody, req.body);
    const checks = await checkRows(db, rows);
    res.json({ rows: checks.map(({ row, value, input, errors }) => ({ row, value: value || input, errors })), valid: checks.filter((c) => !c.errors.length).length });
  }));

  r.post("/", moduleGuard("students", true), wrap(async (req, res) => {
    const { rows } = parse(rowsBody, req.body);
    const checks = await checkRows(db, rows);
    if (checks.some((c) => c.errors.length))
      return res.status(422).json({ error: { code: "ROWS_INVALID", message: "Fix the rows with problems, then import again. Nothing was added." }, rows: checks.map(({ row, value, input, errors }) => ({ row, value: value || input, errors })) });
    const created = [];
    for (const check of checks) {
      const row = check.value!;
      const password = friendlyPassword();
      const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
      const student = await transaction(db, async (tx) => {
        const studentId = await allocateStudentId(tx, config);
        const user = await tx.user.create({
          data: {
            role: "STUDENT", email: row.email || placeholderEmail(studentId), phone: row.phone, passwordHash, mustChangePassword: true,
            student: { create: { studentId, firstName: row.firstName, lastName: row.lastName, programme: row.programme || null, cohort: row.cohort || null, milestones: [{ stage: "Registered", at: new Date().toISOString() }] } },
          },
          include: { student: true },
        });
        await audit(tx, req.principal!.id, "STUDENT_ACCOUNT_CREATED", "Student", user.student!.id, req.ip || "", undefined, { studentId, row: check.row, source: rows.length > 1 ? "CSV" : "FORM" });
        return user.student!;
      });
      created.push({ row: check.row, id: student.id, studentId: student.studentId, name: student.firstName + " " + student.lastName, programme: student.programme, cohort: student.cohort, temporaryPassword: password });
    }
    res.status(201).json({ created });
  }));

  r.post("/:id/temporary-password", moduleGuard("students", true), wrap(async (req, res) => {
    const id = parse(idSchema, req.params.id);
    const password = friendlyPassword();
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const student = await transaction(db, async (tx) => {
      const found = await tx.student.findUnique({ where: { id } });
      if (!found) fail(404, "NOT_FOUND", "Student not found.");
      // A new password signs the student out everywhere and must be changed at the next sign-in.
      await tx.user.update({ where: { id: found.userId }, data: { passwordHash, mustChangePassword: true, sessionVersion: { increment: 1 }, failedLoginCount: 0, lockedUntil: null } });
      await tx.session.deleteMany({ where: { userId: found.userId } });
      await audit(tx, req.principal!.id, "STUDENT_PASSWORD_RESET", "Student", found.id, req.ip || "");
      return found;
    });
    res.json({ studentId: student.studentId, name: student.firstName + " " + student.lastName, temporaryPassword: password });
  }));
  return r;
}
