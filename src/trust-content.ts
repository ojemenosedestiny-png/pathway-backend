import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { moduleGuard } from "./auth.js";
import { wrap, parse, fail, idSchema, transaction, audit } from "./core.js";
export const draftProgrammes = [
  "WAEC WASSCE",
  "NECO SSCE",
  "Cambridge Checkpoint",
  "Cambridge IGCSE",
  "Cambridge AS Level",
  "Cambridge A Level",
  "BECE",
  "SAT",
  "HMB (Pre-Degree)",
];
export const defaultOffered = (name: string) =>
  /^(WAEC(?: WASSCE)?|NECO(?: SSCE)?|SSCE WAEC|SSCE NECO|Cambridge (?:Checkpoint|IGCSE|AS(?: and A)? Level|A Level)|Checkpoint Cambridge|IGCSE JSS 3|BECE(?: ERC NECO JSS 3)?|SAT|HMB Pre Degree)(?: preparation)?$/i.test(
    name.replace(/[^a-z0-9]+/gi, " ").trim(),
  );
const short = z.string().trim().max(500),
  day = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(
      (v) =>
        !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().startsWith(v),
    );
export const officialFeeSchema = z
  .object({
    status: z.enum(["DRAFT", "PUBLISHED"]).default("DRAFT"),
    amountMinor: z
      .string()
      .regex(/^\d{1,15}$/)
      .nullable(),
    currency: z.enum(["NGN", "USD", "GBP", "EUR"]).nullable(),
    session: short,
    category: short,
    coverage: z.string().max(3000),
    sourceUrl: z
      .string()
      .url()
      .refine((v) => {
        const u = new URL(v);
        return (
          u.protocol === "https:" &&
          [
            "waecnigeria.org",
            "neco.gov.ng",
            "cambridgeinternational.org",
            "collegeboard.org",
          ].some((d) => u.hostname === d || u.hostname.endsWith("." + d))
        );
      }),
    lastVerified: day.nullable(),
    confidence: z.enum(["HIGH", "UNVERIFIED"]),
    notes: z.string().max(5000),
  })
  .strict();
export const needsRecheck = (
  fee: { lastVerified: string | null; session: string },
  session: string,
  now = new Date(),
) =>
  !fee.lastVerified ||
  !session ||
  fee.session !== session ||
  now.getTime() - Date.parse(fee.lastVerified + "T00:00:00Z") >=
    90 * 86400000 ||
  Date.parse(fee.lastVerified + "T00:00:00Z") > now.getTime();
const legalSchema = z
  .object({
    legalName: short,
    registrationNumber: short,
    registeringBody: short,
    address: short,
  })
  .strict();
const examSchema = z
  .object({
    offered: z.boolean(),
    currentSession: short,
    officialFees: z.array(officialFeeSchema).max(30),
  })
  .strict()
  .superRefine((v, c) => {
    for (const fee of v.officialFees)
      if (
        fee.status === "PUBLISHED" &&
        (!fee.lastVerified ||
          !fee.session ||
          !fee.currency ||
          fee.amountMinor === null ||
          fee.confidence !== "HIGH")
      )
        c.addIssue({
          code: "custom",
          message:
            "Published references need a verified amount, currency, session and date.",
        });
  });
async function get(db: PrismaClient, key: string) {
  return (await db.setting.findUnique({ where: { key } }))?.value as any;
}
async function save(db: PrismaClient, req: any, key: string, value: any) {
  return transaction(db, async (tx) => {
    const before = await tx.setting.findUnique({ where: { key } });
    await tx.setting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
    await audit(
      tx,
      req.principal.id,
      "TRUST_CONTENT_UPDATED",
      "Setting",
      key,
      req.ip || "",
      before?.value,
      value,
    );
    return value;
  });
}
export async function examPreparation(
  db: PrismaClient,
  exam: { id: string; name: string },
) {
  return (
    (await get(db, "trust.exam." + exam.id)) || {
      offered: defaultOffered(exam.name),
      currentSession: "",
      officialFees: [],
    }
  );
}
export async function requirePreparation(
  db: any,
  exam: { id: string; name: string },
) {
  const policy = await examPreparation(db, exam);
  if (!policy.offered)
    fail(
      409,
      "PREPARATION_UNAVAILABLE",
      "Enquire: availability confirmed by the school. This preparation programme is not currently open for enrolment.",
    );
}
export function trustAdminRouter(db: PrismaClient) {
  const r = Router();
  r.use(moduleGuard("content"));
  r.get(
    "/legal",
    wrap(async (_req, res) =>
      res.json(
        (await get(db, "trust.legal")) || {
          legalName: "",
          registrationNumber: "",
          registeringBody: "",
          address: "",
        },
      ),
    ),
  );
  r.put(
    "/legal",
    moduleGuard("content", true),
    wrap(async (req, res) =>
      res.json(
        await save(db, req, "trust.legal", parse(legalSchema, req.body)),
      ),
    ),
  );
  r.get(
    "/exams/:id",
    wrap(async (req, res) => {
      const exam = await db.exam.findUnique({
        where: { id: parse(idSchema, req.params.id) },
      });
      if (!exam) fail(404, "NOT_FOUND", "Preparation programme not found.");
      const value = await examPreparation(db, exam);
      res.json({
        ...value,
        schoolPreparationFeeMinor: exam.feeMinor,
        schoolPreparationCurrency: exam.currency,
        officialFees: value.officialFees.map((fee: any) => ({
          ...fee,
          needsRecheck: needsRecheck(fee, value.currentSession),
        })),
      });
    }),
  );
  r.put(
    "/exams/:id",
    moduleGuard("content", true),
    wrap(async (req, res) => {
      const id = parse(idSchema, req.params.id);
      if (!(await db.exam.findUnique({ where: { id } })))
        fail(404, "NOT_FOUND", "Preparation programme not found.");
      res.json(
        await save(db, req, "trust.exam." + id, parse(examSchema, req.body)),
      );
    }),
  );
  r.post(
    "/exams/:id/import-research",
    moduleGuard("content", true),
    wrap(async (req, res) => {
      const id = parse(idSchema, req.params.id);
      const { index } = parse(
        z.object({ index: z.number().int().min(0).max(1000) }).strict(),
        req.body,
      );
      const exam = await db.exam.findUnique({ where: { id } });
      if (!exam) fail(404, "NOT_FOUND", "Preparation programme not found.");
      const rows = (await get(db, "trust.research")) || [];
      const row = rows[index];
      if (!row) fail(404, "NOT_FOUND", "Draft research record not found.");
      const { exam: label, ...reference } = row;
      const fee = officialFeeSchema.parse({ ...reference, status: "DRAFT" });
      const p = await examPreparation(db, exam);
      if (
        !p.officialFees.some(
          (f: any) =>
            f.sourceUrl === fee.sourceUrl &&
            f.session === fee.session &&
            f.category === fee.category,
        )
      )
        p.officialFees.push(fee);
      res.json(await save(db, req, "trust.exam." + id, p));
    }),
  );
  r.get(
    "/research",
    wrap(async (_req, res) =>
      res.json((await get(db, "trust.research")) || []),
    ),
  );
  r.get(
    "/refund",
    wrap(async (_req, res) =>
      res.json(
        (await get(db, "trust.refund")) || {
          status: "DRAFT",
          items: "[to be approved by the school]",
          timeLimits: "[to be approved by the school]",
          requestProcess: "[to be approved by the school]",
        },
      ),
    ),
  );
  r.put(
    "/refund",
    moduleGuard("content", true),
    wrap(async (req, res) =>
      res.json(
        await save(
          db,
          req,
          "trust.refund",
          parse(
            z
              .object({
                status: z.literal("DRAFT"),
                items: short,
                timeLimits: short,
                requestProcess: short,
              })
              .strict(),
            req.body,
          ),
        ),
      ),
    ),
  );
  const media = z
    .object({
      source: short,
      sourceUrl: z.union([
        z.literal(""),
        z
          .string()
          .url()
          .refine((v) => new URL(v).protocol === "https:"),
      ]),
      licence: short,
      permission: z.enum([
        "UNCONFIRMED",
        "OWNED",
        "LICENSED",
        "WRITTEN_PERMISSION",
      ]),
      credit: short,
    })
    .strict();
  r.get(
    "/media/:id",
    wrap(async (req, res) =>
      res.json(
        (await get(
          db,
          "trust.media." +
            parse(z.string().regex(/^[a-zA-Z0-9._-]{1,150}$/), req.params.id),
        )) || {
          source: "",
          sourceUrl: "",
          licence: "",
          permission: "UNCONFIRMED",
          credit: "",
        },
      ),
    ),
  );
  r.put(
    "/media/:id",
    moduleGuard("content", true),
    wrap(async (req, res) =>
      res.json(
        await save(
          db,
          req,
          "trust.media." +
            parse(z.string().regex(/^[a-zA-Z0-9._-]{1,150}$/), req.params.id),
          parse(media, req.body),
        ),
      ),
    ),
  );
  return r;
}
export function trustPublicRouter(db: PrismaClient) {
  const r = Router();
  r.get(
    "/legal",
    wrap(async (_req, res) => {
      const data = (await get(db, "trust.legal")) || {};
      res.json(
        Object.fromEntries(
          Object.entries(data).filter(
            ([key, v]) =>
              [
                "legalName",
                "registrationNumber",
                "registeringBody",
                "address",
              ].includes(key) &&
              typeof v === "string" &&
              v.trim(),
          ),
        ),
      );
    }),
  );
  r.get(
    "/preparation",
    wrap(async (_req, res) => {
      const exams = await db.exam.findMany({
        where: { active: true },
        take: 1000,
      });
      res.json({
        programmes: draftProgrammes,
        exams: await Promise.all(
          exams.map(async (exam) => {
            const p = await examPreparation(db, exam);
            return {
              id: exam.id,
              name: exam.name,
              offered: p.offered,
              currentSession: p.currentSession,
              officialFees: p.officialFees
                .filter((f: any) => f.status === "PUBLISHED")
                .map((f: any) => ({
                  ...f,
                  needsRecheck: needsRecheck(f, p.currentSession),
                })),
            };
          }),
        ),
      });
    }),
  );
  return r;
}
