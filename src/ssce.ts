import { Router } from "express";
import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { wrap, parse, fail, transaction, audit, rate, idSchema } from "./core.js";
import { lock } from "./database.js";
import { moduleGuard } from "./auth.js";

/**
 * WAEC/NECO (SSCE) registration form, matching the school's paper form. An applicant completes it
 * before an application invoice can be issued; it locks once the payment is verified.
 */
export const nigerianStates = ["Abia", "Adamawa", "Akwa Ibom", "Anambra", "Bauchi", "Bayelsa", "Benue", "Borno", "Cross River", "Delta", "Ebonyi", "Edo", "Ekiti", "Enugu", "Gombe", "Imo", "Jigawa", "Kaduna", "Kano", "Katsina", "Kebbi", "Kogi", "Kwara", "Lagos", "Nasarawa", "Niger", "Ogun", "Ondo", "Osun", "Oyo", "Plateau", "Rivers", "Sokoto", "Taraba", "Yobe", "Zamfara", "Federal Capital Territory"] as const;
/** The four subjects printed on the school's form. */
export const compulsorySubjects = ["Mathematics", "English Language", "Civic Education", "Livestock Farming"] as const;
export const electiveSubjects = ["Agricultural Science", "Biology", "Chemistry", "Physics", "Further Mathematics", "Computer Studies", "Data Processing", "Economics", "Commerce", "Financial Accounting", "Marketing", "Government", "Geography", "History", "Literature in English", "Christian Religious Studies", "Islamic Studies", "Visual Arts", "Technical Drawing", "Food and Nutrition", "French", "Hausa", "Igbo", "Yoruba"] as const;
export const ssceOptions = { examBodies: ["WAEC", "NECO", "WAEC_NECO"], states: nigerianStates, compulsorySubjects, electiveSubjects, minElectives: 3, maxElectives: 5 };

const name = (max = 80) => z.string().trim().min(1).max(max).regex(/^[\p{L} .'-]+$/u, "Use letters only.");
const today = () => new Date().toISOString().slice(0, 10);
export const ssceFormSchema = z
  .object({
    examBody: z.enum(["WAEC", "NECO", "WAEC_NECO"]),
    surname: name(),
    firstName: name(),
    middleName: z.string().trim().max(80).regex(/^[\p{L} .'-]*$/u, "Use letters only.").default(""),
    dateOfBirth: z.string().date().refine((v) => v >= "1980-01-01" && v <= today(), "Enter a real date of birth."),
    stateOfOrigin: z.enum(nigerianStates),
    lga: z.string().trim().min(2).max(80),
    gender: z.enum(["Male", "Female"]),
    nin: z.string().trim().regex(/^\d{11}$/, "The NIN has 11 digits."),
    electives: z
      .array(z.enum(electiveSubjects))
      .min(3, "Choose at least 3 more subjects (7 in total).")
      .max(5, "Choose at most 5 more subjects (9 in total).")
      .refine((list) => new Set(list).size === list.length, "Each subject can be chosen once."),
    phone: z.string().trim().regex(/^\+?[0-9 ()-]{7,25}$/, "Enter a valid phone number."),
    signature: z.string().trim().min(3).max(160),
    declaration: z.literal(true),
  })
  .strict()
  .refine((form) => form.signature.toLowerCase().includes(form.surname.toLowerCase()), { message: "Sign by typing your full name, including your surname.", path: ["signature"] });

const formKey = (userId: string) => "SSCE_FORM:" + userId;
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

async function allocateFormNumber(tx: Prisma.TransactionClient, now = new Date()) {
  const year = new Intl.DateTimeFormat("en", { year: "numeric", timeZone: "Africa/Lagos" }).format(now);
  const key = "SSCE-" + year;
  await lock(tx, "FormNumber:" + key);
  const counter = await tx.idCounter.findUnique({ where: { key } });
  const number = counter?.nextNumber || 1;
  await tx.idCounter.upsert({ where: { key }, create: { key, nextNumber: number + 1 }, update: { nextNumber: number + 1 } });
  return "NWE-SSCE-" + year + "-" + String(number).padStart(4, "0");
}

/** Whether the account's application payment is already verified (the form is then locked). */
async function paid(db: PrismaClient | Prisma.TransactionClient, userId: string) {
  return Boolean(await db.invoice.findFirst({ where: { userId, kind: "APPLICATION", status: "PAID" } }));
}

export async function ssceForm(db: PrismaClient | Prisma.TransactionClient, userId: string) {
  return ((await db.portalRecord.findUnique({ where: { key: formKey(userId) } }))?.data as any) || null;
}

/** Routes added to the applicant router: the form and the bank-transfer receipt for the application invoice. */
export function ssceApplicantRoutes(r: Router, db: PrismaClient) {
  r.get("/ssce-form", wrap(async (req, res) => res.json({ form: await ssceForm(db, req.principal!.id), locked: await paid(db, req.principal!.id), options: ssceOptions })));
  r.put(
    "/ssce-form",
    wrap(async (req, res) => {
      const data = parse(ssceFormSchema, req.body);
      await rate(db, "ssce-form:" + req.principal!.id, 30, 3600);
      const saved = await transaction(db, async (tx) => {
        await lock(tx, "User:" + req.principal!.id);
        const user = await tx.user.findUniqueOrThrow({ where: { id: req.principal!.id }, include: { applicant: true } });
        if (user.role !== "APPLICANT" || !user.emailVerifiedAt || !user.applicant) fail(403, "EMAIL_VERIFICATION_REQUIRED", "Verify your email before filling the registration form.");
        if (await paid(tx, user.id)) fail(409, "FORM_LOCKED", "Your registration form is locked because your payment has been verified. Contact the school to correct it.");
        const before = await ssceForm(tx, user.id);
        const form = { ...data, email: user.email, formNumber: before?.formNumber || (await allocateFormNumber(tx)), applicantNumber: user.applicant.applicantNumber, submittedAt: before?.submittedAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
        await tx.portalRecord.upsert({ where: { key: formKey(user.id) }, create: { key: formKey(user.id), kind: "SSCE_FORM", data: json(form) }, update: { data: json(form) } });
        // The invoice and payment use the name and phone from the form.
        await tx.applicant.update({ where: { userId: user.id }, data: { firstName: data.firstName, lastName: data.surname } });
        await tx.user.update({ where: { id: user.id }, data: { phone: data.phone } });
        await audit(tx, user.id, before ? "SSCE_FORM_UPDATED" : "SSCE_FORM_SUBMITTED", "PortalRecord", formKey(user.id), req.ip || "", undefined, { formNumber: form.formNumber, examBody: form.examBody, subjects: compulsorySubjects.length + data.electives.length });
        return form;
      });
      res.json(saved);
    }),
  );
  r.get(
    "/payment-proofs",
    wrap(async (req, res) => {
      const invoices = await db.invoice.findMany({ where: { userId: req.principal!.id }, select: { reference: true } });
      const rows = await db.portalRecord.findMany({ where: { key: { in: invoices.map((row) => "PROOF:" + row.reference) } } });
      res.json(rows.map((row) => ({ ...(row.data as any), updatedAt: row.updatedAt })));
    }),
  );
  r.post(
    "/payment-proof",
    wrap(async (req, res) => {
      const data = parse(z.object({ invoiceId: idSchema, documentId: idSchema, paidAt: z.string().date(), note: z.string().max(500).default("") }).strict(), req.body);
      await rate(db, "applicant-proof:" + req.principal!.id, 20, 3600);
      const result = await transaction(db, async (tx) => {
        await lock(tx, "Invoice:" + data.invoiceId);
        const invoice = await tx.invoice.findFirst({ where: { id: data.invoiceId, userId: req.principal!.id } });
        if (!invoice || invoice.status !== "OPEN") fail(404, "INVOICE_UNAVAILABLE", "This invoice is not open for payment.");
        const payment = await tx.payment.findUnique({ where: { idempotencyKey: "invoice:" + invoice.id } });
        if (!payment || payment.provider !== "BANK" || payment.status !== "PENDING") fail(409, "PAYMENT_REQUIRED", "Start the bank transfer payment for this invoice first.");
        const file = await tx.document.findUnique({ where: { id: data.documentId } });
        if (!file || file.ownerId !== req.principal!.id || file.public || !["PENDING", "APPROVED"].includes(file.status) || !file.mime.startsWith("image/")) fail(422, "PROOF_INVALID", "Upload a screenshot or photo of your own transfer receipt (JPG, PNG or WebP).");
        await tx.document.update({ where: { id: file.id }, data: { type: "BANK_PROOF" } });
        const key = "PROOF:" + payment.reference;
        const proof = { reference: payment.reference, documentId: file.id, paidAt: data.paidAt, note: data.note, status: "AWAITING_REVIEW", applicantUserId: req.principal!.id };
        await tx.portalRecord.upsert({ where: { key }, create: { key, kind: "PROOF", data: json(proof) }, update: { data: json(proof) } });
        await audit(tx, req.principal!.id, "PORTAL_PROOF", "PortalRecord", key, req.ip || "", undefined, { reference: payment.reference });
        return proof;
      });
      res.json(result);
    }),
  );
}

/** Staff list of WAEC/NECO forms with the applicant's payment state. */
export function ssceAdminRouter(db: PrismaClient) {
  const r = Router();
  r.get(
    "/forms",
    moduleGuard("applications"),
    wrap(async (_req, res) => {
      const rows = await db.portalRecord.findMany({ where: { kind: "SSCE_FORM" }, orderBy: { updatedAt: "desc" }, take: 200 });
      res.json(
        await Promise.all(
          rows.map(async (row) => {
            const userId = row.key.slice("SSCE_FORM:".length);
            const [user, invoice] = await Promise.all([
              db.user.findUnique({ where: { id: userId }, select: { email: true, role: true, student: { select: { id: true, studentId: true } } } }),
              db.invoice.findFirst({ where: { userId, kind: "APPLICATION" }, orderBy: { createdAt: "desc" }, select: { reference: true, status: true, amountMinor: true, currency: true } }),
            ]);
            return { id: row.id, userId, form: row.data, updatedAt: row.updatedAt, account: user, invoice };
          }),
        ),
      );
    }),
  );
  return r;
}
