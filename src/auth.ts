import {lock} from "./database.js";
import {
  Router,
  type RequestHandler,
  type Request,
  type Response,
} from "express";
import { PrismaClient, type User, type AdminRole } from "@prisma/client";
import argon2 from "argon2";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { authenticator } from "otplib";
import { z } from "zod";
import {
  type Config,
  wrap,
  parse,
  random,
  digest,
  equal,
  seal,
  unseal,
  fail,
  transaction,
  audit,
  queue,
  rate,
} from "./core.js";
export interface Principal {
  id: string;
  role: "APPLICANT" | "STUDENT" | "ADMIN";
  studentId?: string;
  adminRole?: AdminRole;
  permissions: { read: string[]; write: string[] };
  sessionId: string;
  mfaAt?: Date;
}
declare global {
  namespace Express {
    interface Request {
      principal?: Principal;
    }
  }
}
const passwordSchema = z.string().min(12).max(128);
export const defaultPermissions: Record<
  AdminRole,
  { read: string[]; write: string[] }
> = Object.fromEntries(
  Object.entries({
    SUPER_ADMIN: ["*"],
    EXAMS_OFFICER: ["dashboard","students","exams","enrolments","documents","announcements"],
    ADMISSIONS: [
      "dashboard",
      "students",
      "applications",
      "documents",
      "exams",
      "enrolments",
      "universities",
      "consultations",
      "messages",
      "announcements",
    ],
    FINANCE: ["dashboard", "students", "payments", "fees", "coupons"],
    HOSTEL: ["dashboard", "hostels", "rooms", "bookings", "slides", "media"],
    CONTENT: [
      "dashboard",
      "content",
      "slides",
      "universities",
      "courses",
      "countries",
      "announcements",
      "media",
    ],
  }).map(([role, keys]) => [role, { read: keys, write: keys }]),
) as any;
export function moduleGuard(module: string, write = false): RequestHandler {
  return (req, _res, next) => {
    try {
      const p = req.principal;
      if (p?.role !== "ADMIN") fail(403, "FORBIDDEN", "Staff access required.");
      if (
        ["users", "roles", "settings", "audit"].includes(module) &&
        p.adminRole !== "SUPER_ADMIN"
      )
        fail(403, "OWNER_REQUIRED", "Super Admin access required.");
      const allowed = write ? p.permissions.write : p.permissions.read;
      if (
        p.adminRole !== "SUPER_ADMIN" &&
        !allowed.includes("*") &&
        !allowed.includes(module)
      )
        fail(403, "FORBIDDEN", "This module is not permitted.");
      next();
    } catch (e) {
      next(e);
    }
  };
}
export const studentGuard: RequestHandler = (req, _res, next) => {
  try {
    if (req.principal?.role !== "STUDENT" || !req.principal.studentId)
      fail(403, "FORBIDDEN", "Student access required.");
    next();
  } catch (e) {
    next(e);
  }
};
export function authentication(
  db: PrismaClient,
  config: Config,
): RequestHandler {
  return wrap(async (req, _res, next) => {
    const token = req.cookies?.access;
    if (!token) fail(401, "AUTH_REQUIRED", "Sign in to continue.");
    let claims: any;
    try {
      claims = jwt.verify(token, config.JWT_SECRET, {
        algorithms: ["HS256"],
        issuer: config.PUBLIC_API_ORIGIN,
        audience: config.FRONTEND_ORIGIN,
      });
    } catch {
      fail(
        401,
        "SESSION_EXPIRED",
        "Your access token expired. Refresh your session.",
      );
    }
    const session = await db.session.findUnique({
      where: { id: claims.sid },
      include: { user: { include: { student: true, admin: true } } },
    });
    if (
      !session ||
      session.userId !== claims.sub ||
      session.expiresAt < new Date() ||
      session.user.status !== "ACTIVE" ||
      session.user.sessionVersion !== session.version ||
      session.user.mustChangePassword ||
      (session.user.role === "ADMIN" &&
        (!session.mfaAt ||
          Date.now() - session.lastSeen.getTime() > 20 * 60000))
    )
      fail(401, "SESSION_EXPIRED", "Your session expired or was revoked.");
    if (session.user.role === "ADMIN" && !session.user.twoFactorSecret)
      fail(401, "MFA_REQUIRED", "Complete two-factor setup.");
    const user = session.user;
    let permissions = { read: [] as string[], write: [] as string[] };
    if (user.admin) {
      const row = await db.rolePermission.findUnique({
        where: { role: user.admin.roleType },
      });
      permissions = (row?.permissions || user.admin.permissions) as any;
    }
    req.principal = {
      id: user.id,
      role: user.role,
      studentId: user.student?.id,
      adminRole: user.admin?.roleType,
      permissions,
      sessionId: session.id,
      mfaAt: session.mfaAt || undefined,
    };
    if (Date.now() - session.lastSeen.getTime() > 30000)
      await db.session.update({
        where: { id: session.id },
        data: { lastSeen: new Date() },
      });
    next();
  });
}
export function csrf(config: Config): RequestHandler {
  return (req, _res, next) => {
    try {
      if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
      if (req.headers.origin !== config.FRONTEND_ORIGIN)
        fail(403, "ORIGIN", "Request origin is not permitted.");
      const token = req.get("x-csrf-token") || "";
      const cookie = req.cookies?.csrf || "";
      const [nonce, mac] = token.split(".");
      if (
        !nonce ||
        !mac ||
        !equal(token, cookie) ||
        !equal(
          mac,
          crypto
            .createHmac("sha256", config.JWT_SECRET)
            .update(nonce)
            .digest("hex"),
        )
      )
        fail(403, "CSRF", "Refresh the page and try again.");
      next();
    } catch (e) {
      next(e);
    }
  };
}
function cookies(config: Config) {
  return {
    httpOnly: true,
    secure: config.COOKIE_SECURE === "true",
    sameSite: "lax" as const,
    path: "/",
  };
}
async function issue(
  db: PrismaClient,
  config: Config,
  user: User,
  res: Response,
  remember = false,
  mfa = false,
) {
  const refresh = random();
  const session = await db.session.create({
    data: {
      userId: user.id,
      refreshHash: digest(refresh),
      version: user.sessionVersion,
      csrfSecret: random(),
      expiresAt: new Date(
        Date.now() +
          (user.role === "ADMIN"
            ? 8 * 3600000
            : remember
              ? 30 * 86400000
              : 86400000),
      ),
      mfaAt: mfa ? new Date() : null,
    },
  });
  const token = jwt.sign({ sid: session.id }, config.JWT_SECRET, {
    subject: user.id,
    expiresIn: "10m",
    issuer: config.PUBLIC_API_ORIGIN,
    audience: config.FRONTEND_ORIGIN,
  });
  res.cookie("access", token, { ...cookies(config), maxAge: 10 * 60000 });
  res.cookie("refresh", refresh, {
    ...cookies(config),
    maxAge: session.expiresAt.getTime() - Date.now(),
  });
  return session;
}
export async function createPasswordLink(
  tx: any,
  config: Config,
  user: Pick<User, "id" | "email">,
  kind: "SET" | "RESET",
  key: string,
) {
  const raw = random();
  await tx.passwordToken.updateMany({
    where: { userId: user.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  await tx.passwordToken.create({
    data: {
      userId: user.id,
      hash: digest(raw),
      kind,
      expiresAt: new Date(Date.now() + (kind === "SET" ? 24 : 1) * 3600000),
    },
  });
  const student = await tx.student.findUnique({ where: { userId: user.id } });
  await queue(tx, config, key, "EMAIL", {
    to: user.email,
    template: (user as any).role==='APPLICANT'?'applicant-reset':'credentials',
    studentId: student?.studentId,
    link: `${config.FRONTEND_ORIGIN}/set-password#token=${raw}`,
    hours: kind === "SET" ? 24 : 1,
  });
}
async function checkPassword(
  db: PrismaClient,
  identifier: string,
  kind: "STUDENT" | "ADMIN",
  password: string,
  ip: string,
) {
  await rate(db, `login-ip:${ip}`, 30, 900);
  await rate(db, `login:${kind}:${identifier.toLowerCase()}`, 10, 900);
  const user =
    kind === "ADMIN"
      ? await db.user.findUnique({
          where: { email: identifier.toLowerCase() },
          include: { admin: true },
        })
      : await db.user.findFirst({
          where: identifier.includes('@')?{email:identifier.toLowerCase(),role:{in:['STUDENT','APPLICANT']}}:{role:'STUDENT',student:{studentId:identifier.toUpperCase()}},
          include: { admin: true },
        });
  const valid = user?.passwordHash
    ? await argon2.verify(user.passwordHash, password)
    : (await argon2.hash(password, { type: argon2.argon2id }), false);
  const result = await transaction(db, async (tx) => {
    if (!user) return null;
    await lock(tx,"User:"+(user.id));
    const current = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
    if (
      current.status !== "ACTIVE" ||
      (kind==='ADMIN'?current.role!=='ADMIN':!['STUDENT','APPLICANT'].includes(current.role)) ||
      current.passwordHash !== user.passwordHash ||
      current.sessionVersion !== user.sessionVersion ||
      (current.lockedUntil && current.lockedUntil > new Date())
    )
      return null;
    if (!valid) {
      const count = current.failedLoginCount + 1;
      await tx.user.update({
        where: { id: current.id },
        data: {
          failedLoginCount: count >= 5 ? 0 : count,
          lockedUntil: count >= 5 ? new Date(Date.now() + 15 * 60000) : null,
        },
      });
      if (kind === "ADMIN")
        await audit(tx, current.id, "LOGIN_FAILED", "User", current.id, ip);
      return null;
    }
    await tx.user.update({
      where: { id: current.id },
      data: { failedLoginCount: 0, lockedUntil: null },
    });
    return current;
  });
  if (!result)
    fail(
      401,
      "INVALID_CREDENTIALS",
      "Credentials are incorrect or access is temporarily unavailable.",
    );
  return result;
}
export function authRouter(db: PrismaClient, config: Config) {
  const r = Router();
  r.get("/csrf", (_req, res) => {
    const nonce = random();
    const token =
      nonce +
      "." +
      crypto
        .createHmac("sha256", config.JWT_SECRET)
        .update(nonce)
        .digest("hex");
    res.cookie("csrf", token, { ...cookies(config), maxAge: 86400000 });
    res.json({ csrfToken: token });
  });
  r.post(
    "/student/login",
    wrap(async (req, res) => {
      const data = parse(
        z
          .object({
            studentId: z.string().min(2).max(254),
            password: z.string().max(128),
            rememberMe: z.boolean().default(false),
          })
          .strict(),
        req.body,
      );
      const user = await checkPassword(
        db,
        data.studentId,
        "STUDENT",
        data.password,
        req.ip || "",
      );
      if (user.mustChangePassword)
        fail(
          403,
          "SET_PASSWORD_REQUIRED",
          "Complete the emailed password setup link.",
        );
      await issue(db, config, user, res, data.rememberMe);
      if(user.role==='APPLICANT'){const applicant=await db.applicant.findUniqueOrThrow({where:{userId:user.id}});res.json({role:'APPLICANT',applicant:{applicantNumber:applicant.applicantNumber,emailVerified:!!user.emailVerifiedAt}});return;}
      const student = await db.student.findUniqueOrThrow({
        where: { userId: user.id },
      });
      res.json({
        student: {
          id: student.id,
          studentId: student.studentId,
          name: student.firstName + " " + student.lastName,
        },
      });
    }),
  );
  r.post(
    "/admin/login",
    wrap(async (req, res) => {
      const data = parse(
        z
          .object({
            email: z
              .string()
              .email()
              .transform((v) => v.toLowerCase()),
            password: z.string().max(128),
          })
          .strict(),
        req.body,
      );
      const user = await checkPassword(
        db,
        data.email,
        "ADMIN",
        data.password,
        req.ip || "",
      );
      const raw = random();
      await db.authChallenge.create({
        data: {
          userId: user.id,
          hash: digest(raw),
          version: user.sessionVersion,
          expiresAt: new Date(Date.now() + 10 * 60000),
        },
      });
      res.json({
        challenge: raw,
        mfaRequired: true,
        requiresPasswordChange: user.mustChangePassword,
        requiresTwoFactorSetup: !user.twoFactorSecret,
      });
    }),
  );
  const challenge = async (raw: string) => {
    const c = await db.authChallenge.findUnique({
      where: { hash: digest(raw) },
      include: { user: true },
    });
    if (
      !c ||
      c.usedAt ||
      c.expiresAt < new Date() ||
      c.attempts >= 5 ||
      c.user.status !== "ACTIVE" ||
      c.version !== c.user.sessionVersion
    )
      fail(401, "CHALLENGE_INVALID", "Sign in again.");
    return c;
  };
  r.post(
    "/admin/onboarding/password",
    wrap(async (req, res) => {
      const d = parse(
        z
          .object({
            challenge: z.string().length(64),
            newPassword: passwordSchema,
          })
          .strict(),
        req.body,
      );
      const c = await challenge(d.challenge);
      if (!c.user.mustChangePassword)
        fail(409, "ALREADY_SET", "Initial password was already changed.");
      const passwordHash = await argon2.hash(d.newPassword, {
        type: argon2.argon2id,
      });
      await transaction(db, async (tx) => {
        const changed = await tx.user.updateMany({
          where: {
            id: c.userId,
            mustChangePassword: true,
            sessionVersion: c.version,
          },
          data: {
            passwordHash,
            mustChangePassword: false,
            sessionVersion: { increment: 1 },
          },
        });
        if (!changed.count)
          fail(409, "ALREADY_SET", "Initial password was already changed.");
        await tx.authChallenge.update({
          where: { id: c.id },
          data: { version: { increment: 1 } },
        });
        await audit(
          tx,
          c.userId,
          "INITIAL_PASSWORD_CHANGED",
          "User",
          c.userId,
          req.ip || "",
        );
      });
      res.json({ changed: true });
    }),
  );
  r.post(
    "/admin/2fa/setup",
    wrap(async (req, res) => {
      const { challenge: raw } = parse(
        z.object({ challenge: z.string().length(64) }).strict(),
        req.body,
      );
      const c = await challenge(raw);
      if (c.user.mustChangePassword || c.user.twoFactorSecret)
        fail(
          403,
          "SETUP_NOT_ALLOWED",
          "Complete initial password change or use the existing authenticator.",
        );
      const secret = c.encryptedSecret
        ? unseal<string>(c.encryptedSecret, config)
        : authenticator.generateSecret();
      await db.authChallenge.update({
        where: { id: c.id },
        data: { encryptedSecret: seal(secret, config) },
      });
      res.json({
        secret,
        otpauthUrl: authenticator.keyuri(
          c.user.email,
          "NewworldPathway",
          secret,
        ),
      });
    }),
  );
  r.post(
    "/admin/2fa/verify",
    wrap(async (req, res) => {
      const d = parse(
        z
          .object({
            challenge: z.string().length(64),
            code: z.string().min(6).max(64),
          })
          .strict(),
        req.body,
      );
      await rate(db, "mfa:" + req.ip, 20, 900);
      const c = await challenge(d.challenge);
      if (c.user.mustChangePassword)
        fail(
          403,
          "PASSWORD_CHANGE_REQUIRED",
          "Change your initial password first.",
        );
      const secret = c.user.twoFactorSecret
        ? unseal<string>(c.user.twoFactorSecret, config)
        : c.encryptedSecret
          ? unseal<string>(c.encryptedSecret, config)
          : null;
      if (!secret)
        fail(403, "MFA_SETUP_REQUIRED", "Set up your authenticator first.");
      const delta = authenticator.checkDelta(d.code, secret);
      const step = BigInt(Math.floor(Date.now() / 30000) + (delta || 0));
      const backupHash = digest(d.code);
      const backup =
        c.user.twoFactorSecret && c.user.backupCodes.includes(backupHash);
      const ok = (delta !== null && step > c.user.lastTotpStep) || backup;
      if (!ok) {
        await db.authChallenge.update({
          where: { id: c.id },
          data: { attempts: { increment: 1 } },
        });
        fail(401, "MFA_INVALID", "Code is invalid, replayed, or expired.");
      }
      const backups = !c.user.twoFactorSecret
        ? Array.from({ length: 10 }, () => random().slice(0, 20))
        : [];
      const user = await transaction(db, async (tx) => {
        await lock(tx,"User:"+(c.userId));
        const fresh = await tx.user.findUniqueOrThrow({
          where: { id: c.userId },
        });
        const ch = await tx.authChallenge.findUniqueOrThrow({
          where: { id: c.id },
        });
        if (fresh.twoFactorSecret && !c.user.twoFactorSecret)
          fail(
            401,
            "MFA_ALREADY_ENROLLED",
            "Sign in again with the enrolled authenticator.",
          );
        if (
          ch.usedAt ||
          fresh.sessionVersion !== c.version ||
          (!backup && step <= fresh.lastTotpStep) ||
          (backup && !fresh.backupCodes.includes(backupHash))
        )
          fail(401, "MFA_REPLAY", "Sign in again.");
        await tx.authChallenge.update({
          where: { id: c.id },
          data: { usedAt: new Date() },
        });
        const user = await tx.user.update({
          where: { id: c.userId },
          data: {
            twoFactorSecret: seal(secret, config),
            lastTotpStep: backup ? fresh.lastTotpStep : step,
            backupCodes: backups.length
              ? backups.map(digest)
              : fresh.backupCodes.filter((v) => v !== backupHash),
          },
        });
        await audit(
          tx,
          user.id,
          "ADMIN_LOGIN_MFA",
          "User",
          user.id,
          req.ip || "",
        );
        return user;
      });
      await issue(db, config, user, res, false, true);
      res.json({
        authenticated: true,
        backupCodes: backups.length ? backups : undefined,
      });
    }),
  );
  r.post(
    "/set-password",
    wrap(async (req, res) => {
      await rate(db, "password-set:" + req.ip, 10, 900);
      const d = parse(
        z
          .object({ token: z.string().length(64), password: passwordSchema })
          .strict(),
        req.body,
      );
      const hash = await argon2.hash(d.password, { type: argon2.argon2id });
      await transaction(db, async (tx) => {
        const token = await tx.passwordToken.findUnique({
          where: { hash: digest(d.token) },
          include: { user: true },
        });
        if (
          !token ||
          token.usedAt ||
          token.expiresAt < new Date() ||
          token.user.status !== "ACTIVE"
        )
          fail(410, "TOKEN_EXPIRED", "This link expired or was already used.");
        const consumed = await tx.passwordToken.updateMany({
          where: { id: token.id, usedAt: null },
          data: { usedAt: new Date() },
        });
        if (!consumed.count) fail(410, "TOKEN_USED", "Request a new link.");
        await tx.user.update({
          where: { id: token.userId },
          data: {
            passwordHash: hash,
            mustChangePassword: false,
            sessionVersion: { increment: 1 },
            failedLoginCount: 0,
            lockedUntil: null,
          },
        });
        await tx.passwordToken.updateMany({
          where: { userId: token.userId, usedAt: null },
          data: { usedAt: new Date() },
        });
        await tx.session.deleteMany({ where: { userId: token.userId } });
      });
      res.json({ passwordSet: true });
    }),
  );
  for (const mode of ["forgot-password", "recover-id"])
    r.post(
      "/student/" + mode,
      wrap(async (req, res) => {
        const d = parse(
          z
            .object({
              email: z
                .string()
                .email()
                .transform((v) => v.toLowerCase()),
              phone: z.string().max(30).optional(),
              paymentReference: z.string().max(150).optional(),
            })
            .strict(),
          req.body,
        );
        await rate(db, `reset-ip:${req.ip}`, 10, 900);
        await rate(db, `reset:${d.email}`, 3, 900);
        const user = await db.user.findUnique({
          where: { email: d.email },
          include: { student: true },
        });
        if ((user?.student||(mode==='forgot-password'&&user?.role==='APPLICANT')) && user.status === 'ACTIVE') {
          if (mode === "forgot-password")
            await transaction(db, (tx) =>
              createPasswordLink(
                tx,
                config,
                user,
                "RESET",
                "reset:" + random(),
              ),
            );
          else {
            const proof =
              (d.phone &&
                d.phone.replace(/\D/g, "") === user.phone.replace(/\D/g, "")) ||
              (d.paymentReference &&
                (await db.payment.findFirst({
                  where: {
                    reference: d.paymentReference,
                    studentId: user.student!.id,
                    status: "SUCCESS",
                  },
                })));
            if (proof)
              await transaction(db, (tx) =>
                queue(tx, config, "recover:" + random(), "EMAIL", {
                  to: user.email,
                  template: "recover",
                  studentId: user.student!.studentId,
                }),
              );
          }
        }
        res.status(202).json({
          message: "If an eligible account matches, an email will be sent.",
        });
      }),
    );
  r.post(
    "/refresh",
    wrap(async (req, res) => {
      const raw = req.cookies.refresh || "";
      if (!raw) fail(401, "AUTH_REQUIRED", "Sign in again.");
      const hash = digest(raw);
      const found = await db.session.findFirst({
        where: { OR: [{ refreshHash: hash }, { previousRefreshHash: hash }] },
        include: { user: true },
      });
      if (!found) fail(401, "SESSION_EXPIRED", "Sign in again.");
      if (found.previousRefreshHash === hash) {
        await db.session.deleteMany({ where: { userId: found.userId } });
        fail(401, "REFRESH_REUSED", "Sessions revoked. Sign in again.");
      }
      if (
        found.expiresAt < new Date() ||
        found.user.status !== "ACTIVE" ||
        found.version !== found.user.sessionVersion ||
        found.user.mustChangePassword ||
        (found.user.role === "ADMIN" &&
          (!found.mfaAt || Date.now() - found.lastSeen.getTime() > 20 * 60000))
      )
        fail(401, "SESSION_EXPIRED", "Sign in again.");
      const next = random();
      const changed = await db.session.updateMany({
        where: { id: found.id, refreshHash: hash },
        data: {
          previousRefreshHash: hash,
          refreshHash: digest(next),
          lastSeen: new Date(),
        },
      });
      if (!changed.count) fail(409, "REFRESH_RACE", "Retry authentication.");
      res.cookie("refresh", next, {
        ...cookies(config),
        maxAge: found.expiresAt.getTime() - Date.now(),
      });
      res.cookie(
        "access",
        jwt.sign({ sid: found.id }, config.JWT_SECRET, {
          subject: found.userId,
          expiresIn: "10m",
          issuer: config.PUBLIC_API_ORIGIN,
          audience: config.FRONTEND_ORIGIN,
        }),
        { ...cookies(config), maxAge: 600000 },
      );
      res.json({ refreshed: true });
    }),
  );
  r.use(authentication(db, config));
  r.get("/session", (req, res) => res.json(req.principal));
  for (const all of [false, true])
    r.post(
      all ? "/logout-all" : "/logout",
      wrap(async (req, res) => {
        await transaction(db, async (tx) => {
          if (all) {
            await tx.user.update({
              where: { id: req.principal!.id },
              data: { sessionVersion: { increment: 1 } },
            });
            await tx.session.deleteMany({
              where: { userId: req.principal!.id },
            });
          } else
            await tx.session.deleteMany({
              where: { id: req.principal!.sessionId },
            });
          if (req.principal!.role === "ADMIN")
            await audit(
              tx,
              req.principal!.id,
              all ? "LOGOUT_ALL" : "LOGOUT",
              "User",
              req.principal!.id,
              req.ip || "",
            );
        });
        res.clearCookie("access", cookies(config));
        res.clearCookie("refresh", cookies(config));
        res.json({ loggedOut: true });
      }),
    );
  return r;
}
