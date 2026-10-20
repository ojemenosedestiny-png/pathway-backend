import {publicAdmissionsRouter} from './admissions.js';
import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import crypto from "node:crypto";
import { PrismaClient, Prisma } from "@prisma/client";
import { ZodError } from "zod";
import swaggerUi from "swagger-ui-express";
import {
  type Config,
  HttpError,
  log,
  wrap,
  jsonSafe,
  pageSchema,
  parse,
  rate,
} from "./core.js";
import { authRouter, authentication, csrf } from "./auth.js";
import { paymentRouter, webhook } from "./payments.js";
import { providers, type PaymentProvider } from "./providers.js";
import { portalRouter } from "./portal.js";
import { adminRouter } from "./admin.js";
import { fileRouter } from "./storage.js";
import { openapi } from "./openapi.js";
import { z } from "zod";
export function createApp(
  db: PrismaClient,
  config: Config,
  adapters = providers(config),
) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.TRUST_PROXY_HOPS);
  app.set("json replacer", (_k: string, v: unknown) =>
    typeof v === "bigint" ? v.toString() : v,
  );
  app.use(
    helmet(),
    cors({
      origin: config.FRONTEND_ORIGIN,
      credentials: true,
      allowedHeaders: [
        "Content-Type",
        "X-CSRF-Token",
        "Idempotency-Key",
        "X-Payment-Token",
      ],
    }),
  );
  app.use((req, res, next) => {
    const requestId = crypto.randomUUID();
    res.setHeader("X-Request-ID", requestId);
    const start = Date.now();
    res.on("finish", () =>
      log.info(
        {
          requestId,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: Date.now() - start,
        },
        "request",
      ),
    );
    next();
  });
  app.post(
    "/payments/webhook/:provider",
    express.raw({ type: "application/json", limit: "1mb" }),
    webhook(db, config, adapters),
  );
  app.use(express.json({ limit: "256kb" }), cookieParser());
  app.get("/health/live", (_req, res) => res.json({ status: "ok" }));
  app.get(
    "/health/ready",
    wrap(async (_req, res) => {
      await db.$runCommandRaw({ping:1});
      res.json({ status: "ready" });
    }),
  );
  app.get("/openapi.json", (_req, res) => res.json(openapi));
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(openapi));
  app.use(
    wrap(async (req, _res, next) => {
      await rate(db, "api:" + req.ip, 600, 60);
      next();
    }),
    csrf(config),
  );
  app.use("/auth", authRouter(db, config));
  app.use("/public", publicAdmissionsRouter(db));
  app.use("/payments", paymentRouter(db, config, adapters));
  for (const [path, model] of Object.entries({
    countries: "country",
    universities: "university",
    courses: "course",
    exams: "exam",
    hostels: "hostel",
    rooms: "room",
    slides: "carouselSlide",
    fees: "fee",
  }))
    app.get(
      "/public/" + path,
      wrap(async (req, res) => {
        const where =
          path === "slides"
            ? { visible: true }
            : path === "countries"
              ? {}
              : { active: true };
        res.json(
          await (db as any)[model].findMany({
            where,
            ...parse(pageSchema, req.query),
          }),
        );
      }),
    );
  app.get(
    "/public/content",
    wrap(async (_req, res) => res.json(await db.siteContent.findMany())),
  );
  app.get(
    "/public/faqs",
    wrap(async (_req, res) =>
      res.json(
        (await db.siteContent.findUnique({ where: { key: "faqs" } }))?.value ||
          [],
      ),
    ),
  );
  app.get(
    "/public/consultation-slots",
    wrap(async (req, res) => {
      const d = parse(
        pageSchema.extend({
          from: z.coerce.date().optional(),
          to: z.coerce.date().optional(),
          timezone: z.string().max(100).default("Africa/Lagos"),
        }),
        req.query,
      );
      try {
        new Intl.DateTimeFormat("en", { timeZone: d.timezone });
      } catch {
        throw new HttpError(400, "TIMEZONE", "Invalid IANA timezone.");
      }
      const slots = await db.consultationSlot.findMany({
        where: {
          active: true,
          startsAt: {
            gte: d.from && d.from > new Date() ? d.from : new Date(),
            ...(d.to ? { lt: d.to } : {}),
          },
          booking: null,
        },
        skip: d.skip,
        take: d.take,
        orderBy: { startsAt: "asc" },
      });
      res.json(
        slots.map((slot) => ({
          ...slot,
          timezone: d.timezone,
          localStartsAt: slot.startsAt.toLocaleString("en-GB", {
            timeZone: d.timezone,
            hour12: false,
          }),
        })),
      );
    }),
  );
  app.get(
    "/public/announcements",
    wrap(async (req, res) =>
      res.json(
        await db.announcement.findMany({
          where: {
            status: "PUBLISHED",
            audienceType: "Website",
            OR: [{ expireAt: null }, { expireAt: { gt: new Date() } }],
          },
          ...parse(pageSchema, req.query),
          orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
        }),
      ),
    ),
  );
  app.use(
    ["/portal", "/me"],
    authentication(db, config),
    portalRouter(db, config),
  );
  app.use(
    "/admin",
    authentication(db, config),
    adminRouter(db, config, adapters),
  );
  app.use("/files", authentication(db, config), fileRouter(db, config));
  app.use((_req, res) =>
    res
      .status(404)
      .json({ error: { code: "NOT_FOUND", message: "Endpoint not found." } }),
  );
  app.use(
    (
      err: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      let status = 500,
        code = "INTERNAL_ERROR",
        message = "The request could not be completed.";
      if (err instanceof HttpError) {
        status = err.status;
        code = err.code;
        message = err.message;
      } else if (err instanceof ZodError) {
        status = 400;
        code = "VALIDATION";
        message = err.issues
          .map((x) => x.path.join(".") + ": " + x.message)
          .join("; ");
      } else if (err instanceof Prisma.PrismaClientKnownRequestError) {
        if (err.code === "P2025") {
          status = 404;
          code = "NOT_FOUND";
          message = "Record not found.";
        } else if (["P2002", "P2003", "P2004", "P2034"].includes(err.code)) {
          status = 409;
          code = "CONFLICT";
          message =
            "The requested change conflicts with another record or booking.";
        }
      } else if (err.type === "entity.parse.failed") {
        status = 400;
        code = "INVALID_JSON";
        message = "Invalid JSON body.";
      }
      if (status === 500)
        log.error({ errorType: err?.name, code: err?.code }, "request failed");
      res.status(status).json({ error: { code, message } });
    },
  );
  return app;
}
