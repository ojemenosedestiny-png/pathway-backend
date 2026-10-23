import {adminConsultationsRouter} from './consultation-requests.js';
import {learningRouter} from './learning.js';
import {assistantRouter} from './assistant.js';
import {accountRouter} from './account.js';
import {trustAdminRouter} from './trust-content.js';
import {adminAdmissionsRouter} from './admissions.js';
import {guardCatalogWrite,guardCatalogDelete} from "./catalog-integrity.js";
import {lock} from "./database.js";
import { Router } from "express";
import { PrismaClient, Prisma, type Provider } from "@prisma/client";
import { z } from "zod";
import sanitizeHtml from "sanitize-html";
import {
  type Config,
  rate,
  wrap,
  parse,
  idSchema,
  moneySchema,
  pageSchema,
  transaction,
  audit,
  queue,
  fail,
  random,
} from "./core.js";
import { moduleGuard, createPasswordLink, defaultPermissions } from "./auth.js";
import { allocateStudentId, settlePayment } from "./payments.js";
import type { PaymentProvider } from "./providers.js";
export const sanitize = (value: string) =>
  sanitizeHtml(value, {
    allowedTags: [
      "p",
      "br",
      "strong",
      "em",
      "u",
      "ul",
      "ol",
      "li",
      "h2",
      "h3",
      "blockquote",
      "a",
    ],
    allowedAttributes: { a: ["href", "rel"] },
    allowedSchemes: ["https", "mailto"],
    allowProtocolRelative: false,
  });
const text = z.string().max(10000);
const amount = moneySchema;
const date = z.coerce.date();
const json = z.unknown().transform((v) => v as Prisma.InputJsonValue);
const currencies = z.enum(["NGN", "USD"]);
const audience = z
  .object({
    type: z.enum([
      "Website",
      "All students",
      "Exam group",
      "Cohort",
      "Student",
    ]),
    value: z.string().max(120).optional(),
  })
  .strict();
export const resourceSchemas = {
  countries: z.object({
    name: z.string().min(1).max(100),
    code: z.string().regex(/^[A-Z]{2}$/),
    featured: z.boolean().default(false),
  }),
  universities: z.object({
    countryId: idSchema,
    name: z.string().min(1).max(150),
    description: text,
    entryRequirements: json,
    tuitionMinor: amount,
    currency: currencies,
    deadline: date.nullable().optional(),
    featured: z.boolean().default(false),
    active: z.boolean().default(true),
    logo: z.string().max(1000).optional(),
    image: z.string().max(1000).optional(),
  }),
  courses: z.object({
    universityId: idSchema,
    name: z.string().min(1).max(150),
    requirements: json,
    tuitionMinor: amount,
    currency: currencies,
    deadline: date.nullable().optional(),
    active: z.boolean().default(true),
  }),
  exams: z.object({
    body: z.enum(["WAEC", "NECO", "CAMBRIDGE", "OTHER"]),
    name: z.string().min(1).max(150),
    description: text,
    feeMinor: amount,
    currency: currencies,
    opensAt: date,
    closesAt: date,
    timetable: json,
    requirements: json,
    centre: z.string().max(200),
    capacity: z.number().int().min(1).max(100000),
    active: z.boolean().default(true),
  }),
  hostels: z.object({
    name: z.string().min(1).max(150),
    description: text,
    gender: z.enum(["FEMALE", "MALE", "MIXED"]),
    rules: text,
    active: z.boolean().default(true),
  }),
  rooms: z.object({
    hostelId: idSchema,
    name: z.string().min(1).max(100),
    capacity: z.number().int().min(1).max(1000),
    priceMinor: amount,
    depositMinor: amount,
    currency: currencies,
    amenities: json,
    gender: z.enum(["FEMALE", "MALE", "MIXED"]),
    photos: json,
    active: z.boolean().default(true),
  }),
  slides: z.object({
    image: z.string().min(1).max(1000),
    caption: text,
    title: z.string().max(150),
    order: z.number().int().min(0),
    visible: z.boolean().default(true),
  }),
  fees: z.object({
    name: z.string().min(1).max(150),
    purpose: z.enum([
      "REGISTRATION",
      "ENROLMENT",
      "TUITION",
      "EXAM",
      "HOSTEL",
      "INSTALMENT",
    ]),
    amountMinor: amount,
    currency: currencies,
    instalments: z.number().int().min(1).max(24),
    active: z.boolean().default(true),
  }),
  coupons: z.object({
    code: z.string().regex(/^[A-Z0-9_-]{3,60}$/),
    percent: z.number().int().min(1).max(99),
    expiresAt: date,
    active: z.boolean().default(true),
  }),
  slots: z.object({
    advisorId: idSchema,
    advisor: z.string().min(1).max(150),
    startsAt: date,
    endsAt: date,
    mode: z.enum(["VIDEO", "PHONE", "IN_PERSON"]),
    active: z.boolean().default(true),
  }),
  announcements: z.object({
    title: z.string().min(1).max(200),
    body: text.transform(sanitize),
    attachments: z.array(z.object({ documentId: idSchema })).max(10),
    category: z.string().max(80),
    audience,
    channels: z.array(
      z.enum([
        "BANNER",
        "NEWS",
        "DASHBOARD",
        "IN_APP",
        "EMAIL",
        "SMS",
        "WHATSAPP",
      ]),
    ),
    publishAt: date.nullable().optional(),
    expireAt: date.nullable().optional(),
    pinned: z.boolean().default(false),
  }),
  content: z.object({
    key: z.string().regex(/^[a-zA-Z0-9_.-]{1,150}$/),
    value: json,
  }),
  settings: z.object({
    key: z.string().regex(/^[a-zA-Z0-9_.-]{1,80}$/),
    value: json,
  }),
};
const delegate: Record<string, string> = {
  countries: "country",
  universities: "university",
  courses: "course",
  exams: "exam",
  hostels: "hostel",
  rooms: "room",
  slides: "carouselSlide",
  fees: "fee",
  coupons: "coupon",
  slots: "consultationSlot",
  announcements: "announcement",
  content: "siteContent",
  settings: "setting",
};
const resourceModule = (resource: string) =>
  resource === "slots" ? "consultations" : resource;
export function adminRouter(
  db: PrismaClient,
  config: Config,
  adapters: Partial<Record<Provider, PaymentProvider>>,
) {
  const r = Router();
  r.use('/trust',trustAdminRouter(db));
  r.use((req, res, next) =>
    req.principal?.role === "ADMIN"
      ? next()
      : res.status(403).json({
          error: { code: "FORBIDDEN", message: "Staff access required." },
        }),
  );
  const actor = (req: any) => req.principal.id;
  const freshMfa = (req: any) => {
    if (
      !req.principal.mfaAt ||
      Date.now() - req.principal.mfaAt.getTime() > 15 * 60000
    )
      fail(
        403,
        "RECENT_MFA_REQUIRED",
        "Sign in with your authenticator again.",
      );
  };
  r.use('/assistant',assistantRouter(db,config));
  r.use('/account',accountRouter(db));
  r.use(adminAdmissionsRouter(db,config));
  r.use('/learning',learningRouter(db,true,config));
  r.use(adminConsultationsRouter(db));
  r.use(admissionPolicyRouter(db));
  r.get(
    "/media",
    moduleGuard("media"),
    wrap(async (req, res) =>
      res.json(
        await db.document.findMany({
          where: { public: true },
          select: {
            id: true,
            filename: true,
            mime: true,
            size: true,
            status: true,
            fileKey: true,
          },
          ...parse(pageSchema, req.query),
        }),
      ),
    ),
  );
  r.get(
    "/advisors",
    moduleGuard("consultations"),
    wrap(async (req, res) =>
      res.json(
        await db.admin.findMany({
          where: {
            roleType: { in: ["SUPER_ADMIN", "ADMISSIONS"] },
            user: { status: "ACTIVE" },
          },
          select: { userId: true, name: true },
          ...parse(pageSchema, req.query),
        }),
      ),
    ),
  );
  r.delete(
    "/media/:id",
    moduleGuard("media", true),
    wrap(async (req, res) => {
      await transaction(db, async (tx) => {
        const file = await tx.document.findFirst({
          where: { id: parse(idSchema, req.params.id), public: true },
        });
        if (!file) fail(404, "NOT_FOUND", "Media unavailable.");
        await tx.document.update({
          where: { id: file.id },
          data: { status: "DELETION_REQUESTED" },
        });
        await queue(tx, config, "delete-file:" + file.id, "DELETE_FILE", {
          id: file.id,
        });
        await audit(
          tx,
          actor(req),
          "MEDIA_DELETE",
          "Document",
          file.id,
          req.ip || "",
        );
      });
      res.status(202).json({ deletionRequested: true });
    }),
  );
  r.post(
    "/consultations/:id/cancel",
    moduleGuard("consultations", true),
    wrap(async (req, res) => {
      const { reason } = parse(
        z.object({ reason: z.string().min(5).max(1000) }).strict(),
        req.body,
      );
      res.json(
        await transaction(db, async (tx) => {
          const b = await tx.consultationBooking.findUniqueOrThrow({
            where: { id: parse(idSchema, req.params.id) },
          });
          if (b.status !== "CONFIRMED")
            fail(409, "STATE", "Session is not active.");
          const item = await tx.consultationBooking.update({
            where: { id: b.id },
            data: { status: "CANCELLED", slotId: null, notes: reason },
          });
          await audit(
            tx,
            actor(req),
            "CONSULTATION_CANCEL",
            "ConsultationBooking",
            b.id,
            req.ip || "",
            undefined,
            { reason },
          );
          return item;
        }),
      );
    }),
  );
  r.patch(
    "/consultations/:id/reschedule",
    moduleGuard("consultations", true),
    wrap(async (req, res) => {
      const { slotId } = parse(
        z.object({ slotId: idSchema }).strict(),
        req.body,
      );
      res.json(
        await transaction(db, async (tx) => {
          await lock(tx,"ConsultationSlot:"+(slotId));
          const b = await tx.consultationBooking.findUniqueOrThrow({
            where: { id: parse(idSchema, req.params.id) },
          });
          const slot = await tx.consultationSlot.findUnique({
            where: { id: slotId },
            include: { booking: true },
          });
          if (
            b.status !== "CONFIRMED" ||
            !slot?.active ||
            slot.booking ||
            slot.startsAt <= new Date()
          )
            fail(409, "SLOT_UNAVAILABLE", "Choose an available future slot.");
          const item = await tx.consultationBooking.update({
            where: { id: b.id },
            data: { slotId },
          });
          await audit(
            tx,
            actor(req),
            "CONSULTATION_RESCHEDULE",
            "ConsultationBooking",
            b.id,
            req.ip || "",
            { slotId: b.slotId },
            { slotId },
          );
          return item;
        }),
      );
    }),
  );
  for (const [resource, schema] of Object.entries(resourceSchemas)) {
    const model = delegate[resource];
    const mod = resourceModule(resource);
    r.get(
      "/" + resource,
      moduleGuard(mod),
      wrap(async (req, res) =>
        res.json(
          await (db as any)[model].findMany(parse(pageSchema, req.query)),
        ),
      ),
    );
    r.post(
      "/" + resource,
      moduleGuard(mod, true),
      wrap(async (req, res) => {
        const data: any = parse(schema.strict(), req.body);
        if (
          (resource === "exams" && data.closesAt <= data.opensAt) ||
          (resource === "slots" && data.endsAt <= data.startsAt)
        )
          fail(422, "DATES", "End time must follow start time.");
        if (resource === "content") data.updatedBy = actor(req);
        if (resource === "announcements") {
          data.status = "DRAFT";
          if (
            data.expireAt &&
            data.publishAt &&
            data.expireAt <= data.publishAt
          )
            fail(422, "DATES", "Expiry must follow publish time.");
        }
        if (resource === "settings" && data.key === "studentIds")
          data.value = parse(
            z
              .object({
                prefix: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/),
                startingNumber: z.number().int().min(1).max(999999),
              })
              .strict(),
            data.value,
          );
        const item = await transaction(db, async (tx) => {
          await guardCatalogWrite(tx,resource,data);
          const result = await (tx as any)[model].create({ data });
          await audit(
            tx,
            actor(req),
            "CREATE",
            resource,
            result.id || result.key,
            req.ip || "",
            undefined,
            result,
          );
          return result;
        });
        res.status(201).json(item);
      }),
    );
    r.patch(
      "/" + resource + "/:id",
      moduleGuard(mod, true),
      wrap(async (req, res) => {
        const identifier = ["content", "settings"].includes(resource)
          ? parse(z.string().max(150), req.params.id)
          : parse(idSchema, req.params.id);
        const data: any = parse(schema.partial().strict(), req.body);
        delete data.key;
        if (resource === "content") data.updatedBy = actor(req);
        if (resource === "settings")
          fail(
            422,
            "USE_SETTINGS_PUT",
            "Use PUT /admin/settings/:key to update a validated setting.",
          );
        res.json(
          await transaction(db, async (tx) => {
            const table = (tx as any)[model];
            const where = ["content", "settings"].includes(resource)
              ? { key: identifier }
              : { id: identifier };
            const before = await table.findUnique({ where });
            if (!before) fail(404, "NOT_FOUND", "Record unavailable.");
            const combined = { ...before, ...data };
            await guardCatalogWrite(tx,resource,combined,before);
            if (
              (resource === "exams" && combined.closesAt <= combined.opensAt) ||
              (resource === "slots" && combined.endsAt <= combined.startsAt)
            )
              fail(422, "DATES", "Invalid date range.");
            if (resource === "rooms" && data.capacity < before.capacity) {
              const occupancy = await tx.hostelBooking.count({
                where: {
                  roomId: identifier,
                  bed: { gt: data.capacity },
                  status: { in: ["HELD", "CONFIRMED", "CHECKED_IN"] },
                },
              });
              if (occupancy > 0)
                fail(
                  409,
                  "OCCUPIED",
                  "Room capacity cannot be reduced below occupied spaces.",
                );
            }
            if (resource === "announcements" && before.status !== "DRAFT")
              fail(
                409,
                "POST_STATE",
                "Archive the post or create a new draft before changing published content.",
              );
            const after = await table.update({ where, data });
            await audit(
              tx,
              actor(req),
              "UPDATE",
              resource,
              identifier,
              req.ip || "",
              before,
              after,
            );
            return after;
          }),
        );
      }),
    );
    r.delete(
      "/" + resource + "/:id",
      moduleGuard(mod, true),
      wrap(async (req, res) => {
        const identifier = ["content", "settings"].includes(resource)
          ? parse(z.string().max(150), req.params.id)
          : parse(idSchema, req.params.id);
        await transaction(db, async (tx) => {
          const where = ["content", "settings"].includes(resource)
            ? { key: identifier }
            : { id: identifier };
          const table = (tx as any)[model];
          const before = await table.findUnique({ where });
          if (!before) fail(404, "NOT_FOUND", "Record unavailable.");
          await guardCatalogDelete(tx,resource,before);
          await table.delete({ where });
          await audit(
            tx,
            actor(req),
            "DELETE",
            resource,
            identifier,
            req.ip || "",
            before,
          );
        });
        res.status(204).end();
      }),
    );
  }
  r.put(
    "/settings/:key",
    moduleGuard("settings", true),
    wrap(async (req, res) => {
      const key = parse(
        z.enum(["studentIds", "currencies", "notificationPreferences"]),
        req.params.key,
      );
      const schema =
        key === "studentIds"
          ? z
              .object({
                prefix: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/),
                startingNumber: z.number().int().min(1).max(999999),
              })
              .strict()
          : key === "currencies"
            ? z.array(currencies).min(1)
            : z
                .object({
                  applicationEmail: z.boolean(),
                  documentEmail: z.boolean(),
                })
                .strict();
      const value = parse(schema, req.body);
      res.json(
        await transaction(db, async (tx) => {
          const before = await tx.setting.findUnique({ where: { key } });
          const after = await tx.setting.upsert({
            where: { key },
            create: { key, value },
            update: { value },
          });
          await audit(
            tx,
            actor(req),
            "SETTINGS",
            "Setting",
            key,
            req.ip || "",
            before,
            after,
          );
          return after;
        }),
      );
    }),
  );
  r.post(
    "/slides/reorder",
    moduleGuard("slides", true),
    wrap(async (req, res) => {
      const { ids } = parse(
        z.object({ ids: z.array(idSchema).min(1).max(200) }).strict(),
        req.body,
      );
      if (new Set(ids).size !== ids.length)
        fail(422, "DUPLICATES", "Duplicate slide IDs.");
      await transaction(db, async (tx) => {
        for (const [order, id] of ids.entries())
          await tx.carouselSlide.update({ where: { id }, data: { order } });
        await audit(
          tx,
          actor(req),
          "REORDER",
          "CarouselSlide",
          ids.join(","),
          req.ip || "",
        );
      });
      res.json({ reordered: true });
    }),
  );
  r.get(
    "/students",
    moduleGuard("students"),
    wrap(async (req, res) =>
      res.json(
        await db.student.findMany({
          include: {
            payments: {
              select: { reference: true, status: true, purpose: true },
              orderBy: { createdAt: "desc" },
              take: 10,
            },
            user: {
              select: {
                email: true,
                phone: true,
                status: true,
                mustChangePassword: true,
              },
            },
          },
          ...parse(pageSchema, req.query),
        }),
      ),
    ),
  );
  r.patch(
    "/students/:id",
    moduleGuard("students", true),
    wrap(async (req, res) => {
      const id = parse(idSchema, req.params.id);
      const d = parse(
        z
          .object({
            firstName: z.string().min(1).max(80).optional(),
            lastName: z.string().max(80).optional(),
            cohort: z.string().max(80).optional(),
            journeyStage: z.string().max(80).optional(),
            milestones: z
              .array(
                z.object({
                  stage: z.string().max(80),
                  at: z.string().datetime(),
                }),
              )
              .max(30)
              .optional(),
          })
          .strict(),
        req.body,
      );
      res.json(
        await transaction(db, async (tx) => {
          const before = await tx.student.findUniqueOrThrow({ where: { id } });
          const after = await tx.student.update({ where: { id }, data: d });
          await audit(
            tx,
            actor(req),
            "UPDATE_STUDENT",
            "Student",
            id,
            req.ip || "",
            before,
            after,
          );
          return after;
        }),
      );
    }),
  );
  r.post(
    "/students/manual",
    moduleGuard("students", true),
    wrap(async (req, res) => {
      if (req.principal!.adminRole !== "SUPER_ADMIN")
        fail(
          403,
          "OWNER_REQUIRED",
          "Owner approval is required for a payment exception.",
        );
      freshMfa(req);
      const d = parse(
        z
          .object({
            firstName: z.string().min(1).max(80),
            lastName: z.string().max(80),
            email: z
              .string()
              .email()
              .transform((v) => v.toLowerCase()),
            phone: z.string().min(7).max(30),
            reason: z.string().min(10).max(1000),
          })
          .strict(),
        req.body,
      );
      const student = await transaction(db, async (tx) => {
        const studentId = await allocateStudentId(tx, config);
        const user = await tx.user.create({
          data: {
            role: "STUDENT",
            email: d.email,
            phone: d.phone,
            student: {
              create: {
                studentId,
                firstName: d.firstName,
                lastName: d.lastName,
                milestones: [
                  { stage: "Registered", at: new Date().toISOString() },
                ],
              },
            },
          },
          include: { student: true },
        });
        await createPasswordLink(tx, config, user, "SET", "manual:" + user.id);
        await audit(
          tx,
          actor(req),
          "MANUAL_STUDENT",
          "Student",
          user.student!.id,
          req.ip || "",
          undefined,
          { reason: d.reason, studentId },
        );
        return user.student;
      });
      res.status(201).json(student);
    }),
  );
  for (const action of ["resend-credentials", "reset-password"])
    r.post(
      "/students/:id/" + action,
      moduleGuard("students", true),
      wrap(async (req, res) => {
        await rate(db, "credentials:" + req.params.id, 3, 900);
        const student = await db.student.findUniqueOrThrow({
          where: { id: parse(idSchema, req.params.id) },
          include: { user: true },
        });
        if (student.user.status !== "ACTIVE")
          fail(409, "SUSPENDED", "Reactivate the student first.");
        await transaction(db, async (tx) => {
          await createPasswordLink(
            tx,
            config,
            student.user,
            student.user.mustChangePassword ? "SET" : "RESET",
            action + ":" + random(),
          );
          await audit(
            tx,
            actor(req),
            action,
            "Student",
            student.id,
            req.ip || "",
          );
        });
        res.status(202).json({ queued: true });
      }),
    );
  r.patch(
    "/students/:id/status",
    moduleGuard("students", true),
    wrap(async (req, res) => {
      const d = parse(
        z
          .object({
            status: z.enum(["ACTIVE", "SUSPENDED"]),
            reason: z.string().min(5).max(1000),
          })
          .strict(),
        req.body,
      );
      const student = await db.student.findUniqueOrThrow({
        where: { id: parse(idSchema, req.params.id) },
      });
      await transaction(db, async (tx) => {
        await tx.user.update({
          where: { id: student.userId },
          data: { status: d.status, sessionVersion: { increment: 1 } },
        });
        await tx.session.deleteMany({ where: { userId: student.userId } });
        await audit(
          tx,
          actor(req),
          "STUDENT_STATUS",
          "Student",
          student.id,
          req.ip || "",
          undefined,
          d,
        );
      });
      res.json({ status: d.status });
    }),
  );
  r.get(
    "/applications",
    moduleGuard("applications"),
    wrap(async (req, res) =>
      res.json(
        await db.application.findMany({
          include: { student: true, history: true, course: true },
          ...parse(pageSchema, req.query),
        }),
      ),
    ),
  );
  r.patch(
    "/applications/:id/status",
    moduleGuard("applications", true),
    wrap(async (req, res) => {
      const d = parse(
        z
          .object({
            status: z.enum([
              "UNDER_REVIEW",
              "NEEDS_DOCUMENTS",
              "ACCEPTED",
              "REJECTED",
            ]),
            comment: z.string().min(1).max(3000),
            assignedTo: idSchema.optional(),
          })
          .strict(),
        req.body,
      );
      const item = await transaction(db, async (tx) => {
        const before = await tx.application.findUniqueOrThrow({
          where: { id: parse(idSchema, req.params.id) },
          include: { student: { include: { user: true } } },
        });
        if (before.status === "DRAFT")
          fail(
            409,
            "NOT_SUBMITTED",
            "Student must submit the application first.",
          );
        const after = await tx.application.update({
          where: { id: before.id },
          data: {
            status: d.status,
            notes: d.comment,
            assignedTo: d.assignedTo,
            history: {
              create: {
                status: d.status,
                comment: d.comment,
                changedBy: actor(req),
              },
            },
          },
        });
        await tx.notification.create({
          data: {
            userId: before.student.userId,
            title: "Application " + d.status,
            body: d.comment,
          },
        });
        const preferences = await tx.setting.findUnique({
          where: { key: "notificationPreferences" },
        });
        if ((preferences?.value as any)?.applicationEmail !== false)
          await queue(
            tx,
            config,
            `application:${before.id}:${random()}`,
            "EMAIL",
            {
              to: before.student.user.email,
              template: "status",
              title: "Application " + d.status,
              body: d.comment,
            },
          );
        await audit(
          tx,
          actor(req),
          "APPLICATION_STATUS",
          "Application",
          before.id,
          req.ip || "",
          { status: before.status },
          d,
        );
        return after;
      });
      res.json(item);
    }),
  );
  r.get(
    "/documents",
    moduleGuard("documents"),
    wrap(async (req, res) =>
      res.json(
        await db.document.findMany({
          select: {
            id: true,
            ownerId: true,
            type: true,
            filename: true,
            size: true,
            status: true,
            rejectionReason: true,
            createdAt: true,
          },
          ...parse(pageSchema, req.query),
        }),
      ),
    ),
  );
  r.patch(
    "/documents/:id/review",
    moduleGuard("documents", true),
    wrap(async (req, res) => {
      const d = parse(
        z
          .object({
            status: z.enum(["APPROVED", "REJECTED"]),
            reason: z.string().max(2000).default(""),
          })
          .strict(),
        req.body,
      );
      if (d.status === "REJECTED" && !d.reason.trim())
        fail(422, "REASON_REQUIRED", "Give a rejection reason.");
      res.json(
        await transaction(db, async (tx) => {
          const doc = await tx.document.findUniqueOrThrow({
            where: { id: parse(idSchema, req.params.id) },
            include: { owner: true },
          });
          if (!["PENDING", "APPROVED", "REJECTED"].includes(doc.status))
            fail(
              409,
              "NOT_SCANNED",
              "File must pass validation and malware scanning first.",
            );
          const updated = await tx.document.update({
            where: { id: doc.id },
            data: { status: d.status, rejectionReason: d.reason },
          });
          await tx.notification.create({
            data: {
              userId: doc.ownerId,
              title: "Document " + d.status,
              body: d.reason || doc.filename,
            },
          });
          const preferences = await tx.setting.findUnique({
            where: { key: "notificationPreferences" },
          });
          if ((preferences?.value as any)?.documentEmail !== false)
            await queue(
              tx,
              config,
              "document:" + doc.id + ":" + random(),
              "EMAIL",
              {
                to: doc.owner.email,
                template: "status",
                title: "Document " + d.status,
                body: d.reason || doc.filename,
              },
            );
          await audit(
            tx,
            actor(req),
            "DOCUMENT_REVIEW",
            "Document",
            doc.id,
            req.ip || "",
            { status: doc.status },
            d,
          );
          return {
            id: updated.id,
            status: updated.status,
            rejectionReason: updated.rejectionReason,
          };
        }),
      );
    }),
  );
  r.get(
    "/enrolments",
    moduleGuard("enrolments"),
    wrap(async (req, res) =>
      res.json(
        await db.examEnrolment.findMany({
          include: { student: true, exam: true },
          ...parse(pageSchema, req.query),
        }),
      ),
    ),
  );
  r.patch(
    "/enrolments/:id",
    moduleGuard("enrolments", true),
    wrap(async (req, res) => {
      const d = parse(
        z
          .object({
            candidateNumber: z.string().max(80).optional(),
            status: z
              .enum([
                "PENDING",
                "CONFIRMED",
                "WRITTEN",
                "RESULTS_AVAILABLE",
                "CANCELLED",
              ])
              .optional(),
            result: z
              .object({
                grade: z.string().max(200),
                documentId: idSchema.optional(),
              })
              .optional(),
          })
          .strict(),
        req.body,
      );
      res.json(
        await transaction(db, async (tx) => {
          const before = await tx.examEnrolment.findUniqueOrThrow({
            where: { id: parse(idSchema, req.params.id) },
            include: { student: true },
          });
          if (
            d.result?.documentId &&
            !(await tx.document.findFirst({
              where: {
                id: d.result.documentId,
                ownerId: before.student.userId,
                public: false,
                status: { in: ["PENDING", "APPROVED"] },
              },
            }))
          )
            fail(
              422,
              "RESULT_DOCUMENT",
              "Result must be a scanned private document owned by this student.",
            );
          const item = await tx.examEnrolment.update({
            where: { id: before.id },
            data: d,
            include: { student: true },
          });
          await tx.notification.create({
            data: {
              userId: item.student.userId,
              title: "Exam registration updated",
              body: item.status,
            },
          });
          await audit(
            tx,
            actor(req),
            "ENROLMENT_UPDATE",
            "ExamEnrolment",
            item.id,
            req.ip || "",
            undefined,
            d,
          );
          return item;
        }),
      );
    }),
  );
  r.get(
    "/bookings",
    moduleGuard("bookings"),
    wrap(async (req, res) =>
      res.json(
        await db.hostelBooking.findMany({
          include: { room: true, student: true },
          ...parse(pageSchema, req.query),
        }),
      ),
    ),
  );
  r.patch(
    "/bookings/:id",
    moduleGuard("bookings", true),
    wrap(async (req, res) => {
      const d = parse(
        z
          .object({
            status: z.enum(["CANCELLED", "CHECKED_IN", "CHECKED_OUT"]),
          })
          .strict(),
        req.body,
      );
      res.json(
        await transaction(db, async (tx) => {
          const before = await tx.hostelBooking.findUniqueOrThrow({
            where: { id: parse(idSchema, req.params.id) },
          });
          if (
            (d.status === "CHECKED_IN" && before.status !== "CONFIRMED") ||
            (d.status === "CHECKED_OUT" && before.status !== "CHECKED_IN")
          )
            fail(409, "BOOKING_STATE", "Invalid booking transition.");
          const item = await tx.hostelBooking.update({
            where: { id: before.id },
            data: { status: d.status, holdExpiresAt: null },
          });
          await audit(
            tx,
            actor(req),
            "BOOKING_STATUS",
            "HostelBooking",
            item.id,
            req.ip || "",
            { status: before.status },
            d,
          );
          return item;
        }),
      );
    }),
  );
  r.get(
    "/consultations",
    moduleGuard("consultations"),
    wrap(async (req, res) =>
      res.json(
        await db.consultationBooking.findMany({
          include: { slot: true, student: true },
          ...parse(pageSchema, req.query),
        }),
      ),
    ),
  );
  r.patch(
    "/consultations/:id",
    moduleGuard("consultations", true),
    wrap(async (req, res) => {
      const d = parse(
        z
          .object({
            link: z.string().url().startsWith("https://").optional(),
            notes: z.string().max(5000).optional(),
          })
          .strict(),
        req.body,
      );
      res.json(
        await transaction(db, async (tx) => {
          const item = await tx.consultationBooking.update({
            where: { id: parse(idSchema, req.params.id) },
            data: d,
          });
          await audit(
            tx,
            actor(req),
            "CONSULTATION_UPDATE",
            "ConsultationBooking",
            item.id,
            req.ip || "",
            undefined,
            d,
          );
          return item;
        }),
      );
    }),
  );
  for (const action of ["publish", "archive"])
    r.post(
      "/announcements/:id/" + action,
      moduleGuard("announcements", true),
      wrap(async (req, res) => {
        parse(z.object({}).strict(), req.body);
        res.json(
          await transaction(db, async (tx) => {
            const post = await tx.announcement.findUniqueOrThrow({
              where: { id: parse(idSchema, req.params.id) },
            });
            if (
              action === "publish" &&
              ((post.expireAt && post.expireAt <= new Date()) ||
                !post.channels.length)
            )
              fail(422, "POST_INVALID", "Post is expired or has no channel.");
            const target = post.audience as any;
            if (
              action === "publish" &&
              target.type !== "Website" &&
              post.channels.some((c) => ["BANNER", "NEWS"].includes(c))
            )
              fail(
                422,
                "AUDIENCE",
                "Private posts cannot use public placements.",
              );
            if (
              action === "publish" &&
              ["PUBLISHED", "SCHEDULED"].includes(post.status)
            )
              return post;
            if (
              action === "publish" &&
              ["Student", "Cohort", "Exam group"].includes(target.type) &&
              !target.value
            )
              fail(422, "AUDIENCE_REQUIRED", "Choose the target audience.");
            for (const attachment of (action === "publish"
              ? post.attachments
              : []) as any[]) {
              const file = await tx.document.findUnique({
                where: { id: attachment.documentId },
              });
              if (
                !file ||
                file.status !== "APPROVED" ||
                (target.type === "Website" && !file.public)
              )
                fail(
                  422,
                  "ATTACHMENT_UNAVAILABLE",
                  "Attachments must be approved; public posts need public media.",
                );
            }
            const status =
              action === "archive"
                ? "ARCHIVED"
                : post.publishAt && post.publishAt > new Date()
                  ? "SCHEDULED"
                  : "PUBLISHED";
            const after = await tx.announcement.update({
              where: { id: post.id },
              data: { status, version: { increment: 1 } },
            });
            if (status === "PUBLISHED")
              await queue(
                tx,
                config,
                `announcement:${post.id}:${after.version}`,
                "ANNOUNCEMENT",
                { id: post.id },
              );
            await audit(
              tx,
              actor(req),
              action.toUpperCase(),
              "Announcement",
              post.id,
              req.ip || "",
              { status: post.status },
              { status },
            );
            return after;
          }),
        );
      }),
    );
  r.get(
    "/payments",
    moduleGuard("payments"),
    wrap(async (req, res) =>
      res.json(
        await db.payment.findMany({
          select: {
            id: true,
            reference: true,
            provider: true,
            purpose: true,
            status: true,
            amountMinor: true,
            currency: true,
            studentId: true,
            payerEmail: true,
            createdAt: true,
            verifiedAt: true,
            receipt: true,
            refunds: true,
          },
          ...parse(pageSchema, req.query),
        }),
      ),
    ),
  );
  r.post(
    "/payments/:reference/verify-offline",
    moduleGuard("payments", true),
    wrap(async (req, res) => {
      freshMfa(req);
      const { reason } = parse(
        z.object({ reason: z.string().min(10).max(2000) }).strict(),
        req.body,
      );
      const p = await db.payment.findUniqueOrThrow({
        where: { reference: req.params.reference },
      });
      if (p.provider !== "BANK")
        fail(
          422,
          "NOT_OFFLINE",
          "Only bank-transfer records can be manually verified.",
        );
      res.json(
        await settlePayment(
          db,
          config,
          p.reference,
          {
            reference: p.reference,
            providerId: p.reference,
            status: "SUCCESS",
            amountMinor: p.amountMinor,
            currency: p.currency,
            payload: { reason, verifiedBy: actor(req) },
          },
          actor(req),
          req.ip || "",
        ),
      );
    }),
  );
  r.post(
    "/payments/:reference/refund",
    moduleGuard("payments", true),
    wrap(async (req, res) => {
      freshMfa(req);
      const d = parse(
        z.object({ reason: z.string().min(10).max(2000) }).strict(),
        req.body,
      );
      const refund = await transaction(db, async (tx) => {
        const p = await tx.payment.findUniqueOrThrow({
          where: { reference: req.params.reference },
        });
        await lock(tx,"Payment:"+(p.id));
        if (
          p.status !== "SUCCESS" ||
          (await tx.refund.count({
            where: { paymentId: p.id, status: { not: "FAILED" } },
          }))
        )
          fail(
            409,
            "REFUND_STATE",
            "Payment is not refundable or already has a refund in progress.",
          );
        const item = await tx.refund.create({
          data: {
            paymentId: p.id,
            reason: d.reason,
            amountMinor: p.amountMinor,
            actorId: actor(req),
          },
        });
        await queue(tx, config, "refund:" + item.id, "REFUND", {
          refundId: item.id,
        });
        await audit(
          tx,
          actor(req),
          "REFUND_REQUESTED",
          "Payment",
          p.id,
          req.ip || "",
          undefined,
          { reason: d.reason },
        );
        return item;
      });
      res.status(202).json(refund);
    }),
  );
  r.get(
    "/users",
    moduleGuard("users"),
    wrap(async (req, res) =>
      res.json(
        await db.admin.findMany({
          include: {
            user: {
              select: { id: true, email: true, status: true, createdAt: true },
            },
          },
          ...parse(pageSchema, req.query),
        }),
      ),
    ),
  );
  r.post(
    "/users",
    moduleGuard("users", true),
    wrap(async (req, res) => {
      const d = parse(
        z
          .object({
            name: z.string().min(1).max(150),
            email: z
              .string()
              .email()
              .transform((v) => v.toLowerCase()),
            phone: z.string().max(30),
            roleType: z.enum([
              "SUPER_ADMIN",
              "ADMISSIONS",
            "EXAMS_OFFICER",
              "FINANCE",
              "HOSTEL",
              "CONTENT",
            ]),
          })
          .strict(),
        req.body,
      );
      res.status(201).json(
        await transaction(db, async (tx) => {
          const user = await tx.user.create({
            data: {
              role: "ADMIN",
              email: d.email,
              phone: d.phone,
              admin: {
                create: {
                  name: d.name,
                  roleType: d.roleType,
                  permissions: defaultPermissions[d.roleType],
                },
              },
            },
            include: { admin: true },
          });
          await createPasswordLink(
            tx,
            config,
            user,
            "SET",
            "admin-invite:" + user.id,
          );
          await audit(
            tx,
            actor(req),
            "ADMIN_INVITED",
            "User",
            user.id,
            req.ip || "",
            undefined,
            { email: d.email, role: d.roleType },
          );
          return { id: user.id, email: user.email, role: d.roleType };
        }),
      );
    }),
  );
  r.patch(
    "/users/:id",
    moduleGuard("users", true),
    wrap(async (req, res) => {
      const d = parse(
        z
          .object({
            roleType: z
              .enum([
                "SUPER_ADMIN",
                "ADMISSIONS",
            "EXAMS_OFFICER",
                "FINANCE",
                "HOSTEL",
                "CONTENT",
              ])
              .optional(),
            status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
            name: z.string().max(150).optional(),
          })
          .strict(),
        req.body,
      );
      await transaction(db, async (tx) => {
        await lock(tx,"owners");
        const admin = await tx.admin.findUniqueOrThrow({
          where: { userId: parse(idSchema, req.params.id) },
          include: { user: true },
        });
        if (
          admin.roleType === "SUPER_ADMIN" &&
          ((d.roleType && d.roleType !== "SUPER_ADMIN") ||
            d.status === "SUSPENDED") &&
          (await tx.admin.count({
            where: { roleType: "SUPER_ADMIN", user: { status: "ACTIVE" } },
          })) <= 1
        )
          fail(409, "LAST_OWNER", "Keep an active Super Admin.");
        await tx.admin.update({
          where: { userId: admin.userId },
          data: { roleType: d.roleType, name: d.name },
        });
        await tx.user.update({
          where: { id: admin.userId },
          data: { status: d.status, sessionVersion: { increment: 1 } },
        });
        await tx.session.deleteMany({ where: { userId: admin.userId } });
        await audit(
          tx,
          actor(req),
          "ADMIN_UPDATED",
          "User",
          admin.userId,
          req.ip || "",
          undefined,
          d,
        );
      });
      res.json({ updated: true });
    }),
  );
  r.delete(
    "/users/:id",
    moduleGuard("users", true),
    wrap(async (req, res) => {
      await transaction(db, async (tx) => {
        await lock(tx,"owners");
        const a = await tx.admin.findUniqueOrThrow({
          where: { userId: parse(idSchema, req.params.id) },
        });
        if (
          a.roleType === "SUPER_ADMIN" &&
          (await tx.admin.count({
            where: { roleType: "SUPER_ADMIN", user: { status: "ACTIVE" } },
          })) <= 1
        )
          fail(409, "LAST_OWNER", "Keep an active Super Admin.");
        await tx.user.update({
          where: { id: a.userId },
          data: { status: "DELETED", sessionVersion: { increment: 1 } },
        });
        await tx.session.deleteMany({ where: { userId: a.userId } });
        await audit(
          tx,
          actor(req),
          "ADMIN_REMOVED",
          "User",
          a.userId,
          req.ip || "",
        );
      });
      res.status(204).end();
    }),
  );
  r.get(
    "/roles",
    moduleGuard("roles"),
    wrap(async (_req, res) => res.json(await db.rolePermission.findMany())),
  );
  r.put(
    "/roles/:role",
    moduleGuard("roles", true),
    wrap(async (req, res) => {
      const role = parse(
        z.enum(["ADMISSIONS", "FINANCE", "HOSTEL", "CONTENT"]),
        req.params.role,
      );
      const d = parse(
        z
          .object({
            read: z.array(z.string().regex(/^[a-z]+$/)).max(40),
            write: z.array(z.string().regex(/^[a-z]+$/)).max(40),
          })
          .strict(),
        req.body,
      );
      const ownerOnly = new Set(["users", "roles", "settings", "audit"]);
      if ([...d.read, ...d.write].some((m) => ownerOnly.has(m)))
        fail(422, "OWNER_MODULE", "Owner-only modules cannot be delegated.");
      const permissions = {
        read: [...new Set([...d.read, ...d.write])],
        write: [...new Set(d.write)],
      };
      res.json(
        await transaction(db, async (tx) => {
          const item = await tx.rolePermission.upsert({
            where: { role },
            create: { role, permissions },
            update: { permissions },
          });
          await audit(
            tx,
            actor(req),
            "ROLE_PERMISSIONS",
            "RolePermission",
            role,
            req.ip || "",
            undefined,
            permissions,
          );
          return item;
        }),
      );
    }),
  );
  r.get(
    "/audit",
    moduleGuard("audit"),
    wrap(async (req, res) =>
      res.json(
        await db.auditLog.findMany({
          orderBy: { at: "desc" },
          ...parse(pageSchema, req.query),
        }),
      ),
    ),
  );
  r.get(
    "/messages",
    moduleGuard("messages"),
    wrap(async (req, res) =>
      res.json(
        await db.thread.findMany({
          include: { student: true, messages: true },
          ...parse(pageSchema, req.query),
        }),
      ),
    ),
  );
  r.post(
    "/messages/:threadId",
    moduleGuard("messages", true),
    wrap(async (req, res) => {
      const d = parse(
        z.object({ body: z.string().min(1).max(5000) }).strict(),
        req.body,
      );
      res.status(201).json(
        await transaction(db, async (tx) => {
          const thread = await tx.thread.findUniqueOrThrow({
            where: { id: parse(idSchema, req.params.threadId) },
            include: { student: true },
          });
          const item = await tx.message.create({
            data: { threadId: thread.id, authorId: actor(req), body: d.body },
          });
          await tx.notification.create({
            data: {
              userId: thread.student.userId,
              title: "Admissions replied",
              body: d.body.slice(0, 300),
            },
          });
          await audit(
            tx,
            actor(req),
            "MESSAGE_SENT",
            "Thread",
            thread.id,
            req.ip || "",
          );
          return item;
        }),
      );
    }),
  );
  r.get(
    "/dashboard",
    moduleGuard("dashboard"),
    wrap(async (_req, res) =>
      res.json({
        applicants: await db.application.count(),
        enrolments: await db.examEnrolment.count(),
        bookings: await db.hostelBooking.count({
          where: { status: { in: ["CONFIRMED", "CHECKED_IN"] } },
        }),
        revenue: await db.payment.groupBy({
          by: ["currency"],
          where: { status: "SUCCESS" },
          _sum: { amountMinor: true },
        }),
        upcomingConsultations: await db.consultationBooking.count({
          where: {
            status: "CONFIRMED",
            slot: { startsAt: { gte: new Date() } },
          },
        }),
      }),
    ),
  );
  return r;
}
import {admissionPolicyRouter} from './invoices.js';
