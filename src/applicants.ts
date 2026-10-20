import { Router } from "express";
import { PrismaClient, Prisma } from "@prisma/client";
import argon2 from "argon2";
import { z } from "zod";
import {
  type Config,
  wrap,
  parse,
  fail,
  rate,
  transaction,
  random,
  digest,
  queue,
  audit,
} from "./core.js";
import { lock } from "./database.js";
export async function allocateApplicantNumber(
  tx: Prisma.TransactionClient,
  now = new Date(),
) {
  const year = new Intl.DateTimeFormat("en", {
      year: "numeric",
      timeZone: "Africa/Lagos",
    }).format(now),
    key = "APP-" + year;
  await lock(tx, "ApplicantNumber:" + key);
  const counter = await tx.idCounter.findUnique({ where: { key } });
  const number = counter?.nextNumber || 1;
  if (number > 999999)
    fail(
      409,
      "APPLICANT_NUMBERS_EXHAUSTED",
      "Contact admissions to allocate your applicant number.",
    );
  await tx.idCounter.upsert({
    where: { key },
    create: { key, nextNumber: number + 1 },
    update: { nextNumber: number + 1 },
  });
  const value = key + "-" + String(number).padStart(4, "0");
  await tx.applicantNumberReservation.create({ data: { number: value } });
  return value;
}
async function verificationEmail(
  tx: Prisma.TransactionClient,
  config: Config,
  user: { id: string; email: string },
) {
  const token = random();
  await tx.emailVerification.updateMany({
    where: { userId: user.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  const item = await tx.emailVerification.create({
    data: {
      userId: user.id,
      hash: digest(token),
      expiresAt: new Date(Date.now() + 24 * 3600000),
    },
  });
  await queue(tx, config, "verify-email:" + item.id, "EMAIL", {
    to: user.email,
    template: "verify-email",
    link: config.FRONTEND_ORIGIN + "/verify-email#token=" + token,
  });
}
export function applicantAuthRouter(db: PrismaClient, config: Config) {
  const r = Router();
  r.post(
    "/applicant/signup",
    wrap(async (req, res) => {
      const data = parse(
        z
          .object({
            email: z
              .string()
              .trim()
              .email()
              .max(254)
              .transform((v) => v.toLowerCase()),
            password: z.string().min(12).max(128),
            consent: z.literal(true),
          })
          .strict(),
        req.body,
      );
      await rate(db, "signup-ip:" + req.ip, 10, 900);
      await rate(db, "signup-email:" + data.email, 3, 3600);
      const passwordHash = await argon2.hash(data.password, {
        type: argon2.argon2id,
      });
      await transaction(db, async (tx) => {
        await lock(tx, "Signup:" + digest(data.email));
        if (await tx.user.findUnique({ where: { email: data.email } })) return;
        const number = await allocateApplicantNumber(tx);
        const user = await tx.user.create({
          data: {
            role: "APPLICANT",
            email: data.email,
            phone: "",
            passwordHash,
            mustChangePassword: false,
            applicant: { create: { applicantNumber: number } },
          },
        });
        await verificationEmail(tx, config, user);
        await audit(
          tx,
          user.id,
          "APPLICANT_SIGNUP",
          "User",
          user.id,
          req.ip || "",
          undefined,
          { consentAt: new Date().toISOString() },
        );
      });
      res
        .status(202)
        .json({
          message:
            "If this email can be registered, a verification link has been queued. Check your inbox and spam folder. Existing account holders can sign in or reset their password.",
        });
    }),
  );
  r.post(
    "/applicant/verify-email",
    wrap(async (req, res) => {
      const { token } = parse(
        z.object({ token: z.string().min(32).max(200) }).strict(),
        req.body,
      );
      await rate(db, "verify-email-ip:" + req.ip, 30, 900);
      await transaction(db, async (tx) => {
        const item = await tx.emailVerification.findUnique({
          where: { hash: digest(token) },
        });
        if (!item || item.usedAt || item.expiresAt < new Date())
          fail(
            410,
            "VERIFICATION_EXPIRED",
            "This verification link is invalid, expired or already used. Sign in to request another.",
          );
        await lock(tx, "User:" + item.userId);
        const user = await tx.user.findUniqueOrThrow({
          where: { id: item.userId },
        });
        if (user.role !== "APPLICANT" || user.status !== "ACTIVE")
          fail(
            410,
            "VERIFICATION_EXPIRED",
            "This account cannot use the verification link.",
          );
        const changed = await tx.emailVerification.updateMany({
          where: { id: item.id, usedAt: null },
          data: { usedAt: new Date() },
        });
        if (changed.count !== 1)
          fail(
            410,
            "VERIFICATION_EXPIRED",
            "This verification link has already been used.",
          );
        await tx.user.update({
          where: { id: user.id },
          data: { emailVerifiedAt: new Date() },
        });
        await audit(
          tx,
          user.id,
          "EMAIL_VERIFIED",
          "User",
          user.id,
          req.ip || "",
        );
      });
      res.json({ verified: true });
    }),
  );
  return r;
}
export function applicantRouter(db: PrismaClient, config: Config) {
  const r = Router();
  r.use((req, _res, next) => {
    try {
      if (
        !req.principal ||
        !["APPLICANT", "STUDENT"].includes(req.principal.role)
      )
        fail(403, "FORBIDDEN", "Applicant access required.");
      next();
    } catch (error) {
      next(error);
    }
  });
  r.get(
    "/profile",
    wrap(async (req, res) => {
      const user = await db.user.findUniqueOrThrow({
        where: { id: req.principal!.id },
        include: { applicant: true, student: true },
      });
      res.json({
        id: user.id,
        email: user.email,
        phone: user.phone,
        role: user.role,
        emailVerified: !!user.emailVerifiedAt,
        applicant: user.applicant,
        student: user.student
          ? {
              studentId: user.student.studentId,
              firstName: user.student.firstName,
              lastName: user.student.lastName,
            }
          : null,
      });
    }),
  );
  r.post(
    "/resend-verification",
    wrap(async (req, res) => {
      await rate(db, "resend-verification:" + req.principal!.id, 3, 3600);
      await transaction(db, async (tx) => {
        await lock(tx, "User:" + req.principal!.id);
        const user = await tx.user.findUniqueOrThrow({
          where: { id: req.principal!.id },
        });
        if (user.role === "APPLICANT" && !user.emailVerifiedAt)
          await verificationEmail(tx, config, user);
      });
      res.json({
        message:
          "If verification is needed, a fresh link has been queued to your email.",
      });
    }),
  );
  r.patch(
    "/profile",
    wrap(async (req, res) => {
      const data = parse(
        z
          .object({
            firstName: z.string().trim().min(1).max(80),
            lastName: z.string().trim().min(1).max(80),
            phone: z
              .string()
              .trim()
              .regex(/^\+?[0-9 ()-]{7,25}$/),
          })
          .strict(),
        req.body,
      );
      await transaction(db, async (tx) => {
        await lock(tx, "User:" + req.principal!.id);
        const user = await tx.user.findUniqueOrThrow({
          where: { id: req.principal!.id },
        });
        if (user.role !== "APPLICANT" || !user.emailVerifiedAt)
          fail(
            403,
            "EMAIL_VERIFICATION_REQUIRED",
            "Verify your email before updating your application details.",
          );
        await tx.applicant.update({
          where: { userId: user.id },
          data: { firstName: data.firstName, lastName: data.lastName },
        });
        await tx.user.update({
          where: { id: user.id },
          data: { phone: data.phone },
        });
        await audit(
          tx,
          user.id,
          "APPLICANT_PROFILE_UPDATED",
          "User",
          user.id,
          req.ip || "",
        );
      });
      res.json({ saved: true });
    }),
  );
  return r;
}
