import { Router, type Request } from "express";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { wrap, parse, fail, audit, transaction, type Config } from "./core.js";
import { storage } from "./storage.js";
import { changePassword } from "./account.js";
import { submissionKey, REGISTRATION } from "./forms.js";

/** Student profile: change password, and a profile photo (falls back to the registration form photo). */
export function studentProfileRouter(db: PrismaClient, config: Config) {
  const r = Router();
  const sid = (req: Request) => req.principal!.studentId as string;
  r.post("/password", changePassword(db));
  r.put("/profile/photo", wrap(async (req, res) => {
    const { documentId } = parse(z.object({ documentId: z.string().uuid() }).strict(), req.body);
    const doc = await db.document.findUnique({ where: { id: documentId } });
    if (!doc || doc.ownerId !== req.principal!.id || doc.public || !doc.mime.startsWith("image/") || !["PENDING", "APPROVED"].includes(doc.status))
      fail(422, "PHOTO_UNAVAILABLE", "This photo is not available. Upload it again.");
    await transaction(db, async (tx) => {
      await tx.student.update({ where: { id: sid(req) }, data: { photo: documentId } });
      await audit(tx, req.principal!.id, "PROFILE_PHOTO_CHANGED", "Student", sid(req), req.ip || "");
    });
    res.json({ photo: true });
  }));
  /** Streams the student's own photo, so it shows without exposing a storage link. */
  r.get("/profile/photo", wrap(async (req, res) => {
    const student = await db.student.findUniqueOrThrow({ where: { id: sid(req) }, select: { photo: true } });
    let id = student.photo;
    if (!id) id = ((await db.portalRecord.findUnique({ where: { key: submissionKey(REGISTRATION, sid(req)) } }))?.data as any)?.answers?.photo || null;
    const doc = id && z.string().uuid().safeParse(id).success ? await db.document.findUnique({ where: { id } }) : null;
    if (!doc || doc.ownerId !== req.principal!.id || !doc.mime.startsWith("image/") || !["PENDING", "APPROVED"].includes(doc.status)) {
      res.status(404).set("Cache-Control", "no-store").json({ error: { code: "NO_PHOTO", message: "No photo yet." } });
      return;
    }
    const object = await storage(config).send(new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: doc.fileKey }));
    res.setHeader("Content-Type", doc.mime);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const body = object.Body as any;
    body.on("error", () => res.destroy());
    body.pipe(res);
  }));
  return r;
}

const canRead = (req: Request, module: string) => {
  const p = req.principal!;
  return p.adminRole === "SUPER_ADMIN" || p.permissions.read.includes("*") || p.permissions.read.includes(module) || p.permissions.write.includes(module);
};
/** Start of the day in Nigeria (UTC+1, no daylight saving). */
export const lagosDayStart = (now = Date.now()) => { const local = new Date(now + 3600e3); return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - 3600e3; };

/** Staff home: counts for the dashboard tiles, each only for staff who may see that area. */
export function staffSummaryRouter(db: PrismaClient) {
  const r = Router();
  r.get("/", wrap(async (req, res) => {
    const now = Date.now();
    const out: Record<string, unknown> = {};
    if (canRead(req, "students")) out.students = await db.student.count();
    if (canRead(req, "exams")) {
      const mocks = (await db.portalRecord.findMany({ where: { kind: "MOCK" } })).map((m) => ({ id: m.key.slice(5), ...(m.data as any) }));
      const published = mocks.filter((m) => m.published);
      out.mocksOpenNow = published.filter((m) => Date.parse(m.opensAt) <= now && now <= Date.parse(m.closesAt)).length;
      const start = lagosDayStart(now);
      const attempts = await db.portalRecord.findMany({ where: { kind: "ATTEMPT" }, select: { data: true } });
      out.scriptsToday = attempts.filter((a) => { const d = a.data as any; return d.submitted && Date.parse(d.submittedAt) >= start; }).length;
      out.upcoming = published.filter((m) => Date.parse(m.closesAt) >= now).sort((a, b) => Date.parse(a.opensAt) - Date.parse(b.opensAt)).slice(0, 5)
        .map((m) => ({ id: m.id, title: m.title, subject: m.subject, cohort: m.studentIds?.length ? "Chosen students" : m.cohort || "All students", opensAt: m.opensAt, closesAt: m.closesAt, open: Date.parse(m.opensAt) <= now }));
    }
    if (canRead(req, "applications")) {
      const subs = await db.portalRecord.findMany({ where: { kind: "FORM_SUBMISSION" }, select: { data: true } });
      out.formsAwaiting = subs.filter((s) => (s.data as any).status === "NEW").length;
    }
    res.json(out);
  }));
  return r;
}
