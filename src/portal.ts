import {requirePreparation} from './trust-content.js';
import {learningRouter} from './learning.js';
import {lock} from "./database.js";
import { Router } from "express";
import { PrismaClient, Prisma } from "@prisma/client";
import { z } from "zod";
import {
  type Config,
  wrap,
  parse,
  fail,
  transaction,
  idSchema,
  pageSchema,
  queue,
} from "./core.js";
import { studentGuard } from "./auth.js";
export async function reserveBed(
  db: PrismaClient,
  studentId: string,
  data: { roomId: string; term: string; arrival: Date; departure: Date },
) {
  if (
    data.arrival >= data.departure ||
    data.arrival < new Date(new Date().toISOString().slice(0, 10))
  )
    fail(422, "DATES", "Choose a valid future date range.");
  return transaction(db, async (tx) => {
    await lock(tx,"Room:"+(data.roomId));
    const room = await tx.room.findUnique({
      where: { id: data.roomId },
      include: { hostel: true },
    });
    if (!room?.active || !room.hostel.active)
      fail(404, "ROOM_UNAVAILABLE", "Room unavailable.");
    await tx.hostelBooking.updateMany({
      where: {
        roomId: room.id,
        status: "HELD",
        holdExpiresAt: { lt: new Date() },
      },
      data: { status: "EXPIRED", holdExpiresAt: null },
    });
    const occupied = await tx.hostelBooking.findMany({
      where: {
        roomId: room.id,
        status: { in: ["HELD", "CONFIRMED", "CHECKED_IN"] },
        arrival: { lt: data.departure },
        departure: { gt: data.arrival },
      },
      select: { bed: true, studentId: true },
    });
    if (occupied.some((b) => b.studentId === studentId))
      fail(
        409,
        "ALREADY_BOOKED",
        "You already hold accommodation for these dates.",
      );
    const bed = Array.from({ length: room.capacity }, (_, i) => i + 1).find(
      (n) => !occupied.some((o) => o.bed === n),
    );
    if (!bed) fail(409, "ROOM_FULL", "No bed is available for these dates.");
    return tx.hostelBooking.create({
      data: {
        ...data,
        studentId,
        bed,
        amountMinor: room.priceMinor + room.depositMinor,
        roomAmountMinor:room.priceMinor,
        depositAmountMinor:room.depositMinor,
        holdExpiresAt: new Date(Date.now() + 15 * 60000),
      },
    });
  });
}
export async function bookSlot(
  db: PrismaClient,
  studentId: string,
  slotId: string,
) {
  return transaction(db, async (tx) => {
    await lock(tx,"ConsultationSlot:"+(slotId));
    const slot = await tx.consultationSlot.findUnique({
      where: { id: slotId },
      include: { booking: true },
    });
    if (!slot?.active || slot.startsAt <= new Date() || slot.booking)
      fail(409, "SLOT_UNAVAILABLE", "This consultation time is unavailable.");
    return tx.consultationBooking.create({
      data: { studentId, slotId, originalSlotId: slotId },
    });
  });
}
export function audienceWhere(
  student: {
    id: string;
    cohort: string | null;
    enrolments: { examId: string }[];
  } | null,
): Prisma.AnnouncementWhereInput {
  const audience: Prisma.AnnouncementWhereInput[] = [
    { audienceType: "Website" },
  ];
  if (student) {
    audience.push(
      { audienceType: "All students" },
      {
        AND: [
          { audienceType: "Student" },
          { audienceValue: student.id },
        ],
      },
    );
    if (student.cohort)
      audience.push({
        AND: [
          { audienceType: "Cohort" },
          { audienceValue: student.cohort },
        ],
      });
    for (const enrol of student.enrolments)
      audience.push({
        AND: [
          { audienceType: "Exam group" },
          { audienceValue: enrol.examId },
        ],
      });
  }
  return {
    status: "PUBLISHED",
    AND: [
      { OR: [{ publishAt: null }, { publishAt: { lte: new Date() } }] },
      { OR: [{ expireAt: null }, { expireAt: { gt: new Date() } }] },
      { OR: audience },
    ],
  };
}
export function portalRouter(db: PrismaClient, config: Config) {
  const r = Router();
  r.use(studentGuard);
  r.use('/learning',learningRouter(db));
  const sid = (req: any) => req.principal!.studentId as string;
  r.get(
    "/profile",
    wrap(async (req, res) => {
      const s = await db.student.findUniqueOrThrow({
        where: { id: sid(req) },
        include: {
          user: { select: { email: true, phone: true, status: true } },
        },
      });
      res.json(s);
    }),
  );
  r.patch(
    "/profile",
    wrap(async (req, res) => {
      const d = parse(
        z
          .object({
            firstName: z.string().min(1).max(80).optional(),
            lastName: z.string().max(80).optional(),
            dob: z.coerce.date().max(new Date()).optional(),
            nationality: z.string().max(80).optional(),
            countryOfResidence: z.string().max(80).optional(),
            guardian: z
              .object({
                name: z.string().max(150),
                email: z.string().email().optional(),
                phone: z.string().max(30).optional(),
              })
              .optional(),
          })
          .strict(),
        req.body,
      );
      res.json(await db.student.update({ where: { id: sid(req) }, data: d }));
    }),
  );
  r.get(
    "/journey",
    wrap(async (req, res) => {
      const s = await db.student.findUniqueOrThrow({
        where: { id: sid(req) },
        select: { journeyStage: true, milestones: true },
      });
      res.json(s);
    }),
  );
  r.get(
    "/applications",
    wrap(async (req, res) =>
      res.json(
        await db.application.findMany({
          where: { studentId: sid(req) },
          include: {
            university: true,
            course: true,
            history: { orderBy: { at: "asc" } },
          },
          ...parse(pageSchema, req.query),
        }),
      ),
    ),
  );
  r.post(
    "/applications",
    wrap(async (req, res) => {
      const d = parse(
        z.object({ universityId: idSchema, courseId: idSchema }).strict(),
        req.body,
      );
      const course = await db.course.findFirst({
        where: {
          id: d.courseId,
          universityId: d.universityId,
          active: true,
          university: { active: true },
        },
      });
      if (!course) fail(404, "COURSE_UNAVAILABLE", "Course unavailable.");
      res.status(201).json(
        await db.application.create({
          data: {
            ...d,
            studentId: sid(req),
            history: {
              create: {
                status: "DRAFT",
                comment: "Application started",
                changedBy: req.principal!.id,
              },
            },
          },
        }),
      );
    }),
  );
  r.get(
    "/applications/:id",
    wrap(async (req, res) => {
      const a = await db.application.findFirst({
        where: { id: parse(idSchema, req.params.id), studentId: sid(req) },
        include: { history: true, course: true, university: true },
      });
      if (!a) fail(404, "NOT_FOUND", "Application unavailable.");
      res.json(a);
    }),
  );
  r.post(
    "/applications/:id/submit",
    wrap(async (req, res) => {
      const a = await transaction(db, async (tx) => {
        const item = await tx.application.findFirst({
          where: { id: parse(idSchema, req.params.id), studentId: sid(req) },
        });
        if (!item) fail(404, "NOT_FOUND", "Application unavailable.");
        if (item.status !== "DRAFT")
          fail(409, "STATE", "Application was already submitted.");
        const docs = await tx.document.count({
          where: {
            ownerId: req.principal!.id,
            public: false,
            status: { in: ["PENDING", "APPROVED"] },
          },
        });
        if (!docs)
          fail(
            422,
            "DOCUMENTS_REQUIRED",
            "Upload your supporting documents first.",
          );
        return tx.application.update({
          where: { id: item.id },
          data: {
            status: "SUBMITTED",
            history: {
              create: {
                status: "SUBMITTED",
                comment: "Submitted by student",
                changedBy: req.principal!.id,
              },
            },
          },
        });
      });
      res.json(a);
    }),
  );
  r.get(
    "/documents",
    wrap(async (req, res) =>
      res.json(
        await db.document.findMany({
          where: { ownerId: req.principal!.id, public: false },
          select: {
            id: true,
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
  r.delete(
    "/documents/:id",
    wrap(async (req, res) => {
      const doc = await db.document.findFirst({
        where: {
          id: parse(idSchema, req.params.id),
          ownerId: req.principal!.id,
        },
      });
      if (!doc) fail(404, "NOT_FOUND", "Document unavailable.");
      await transaction(db, async (tx) => {
        await tx.document.update({
          where: { id: doc.id },
          data: { status: "DELETION_REQUESTED" },
        });
        await queue(tx, config, "delete-file:" + doc.id, "DELETE_FILE", {
          id: doc.id,
          key: doc.fileKey,
        });
      });
      res.status(202).json({ deletionRequested: true });
    }),
  );
  r.get(
    ["/exams", "/enrolments"],
    wrap(async (req, res) =>
      res.json(
        await db.examEnrolment.findMany({
          where: { studentId: sid(req) },
          include: { exam: true },
          ...parse(pageSchema, req.query),
        }),
      ),
    ),
  );
  r.post(
    "/exams",
    wrap(async (req, res) => {
      const { examId } = parse(
        z.object({ examId: idSchema }).strict(),
        req.body,
      );
      const item = await transaction(db, async (tx) => {
        await lock(tx,"Exam:"+(examId));
        const exam = await tx.exam.findUnique({ where: { id: examId } });
        if (
          !exam?.active ||
          exam.opensAt > new Date() ||
          exam.closesAt < new Date()
        )
          fail(409, "REGISTRATION_CLOSED", "Preparation enrolment is closed.");
        await requirePreparation(tx,exam);
        if (
          (await tx.examEnrolment.count({
            where: { examId, status: { not: "CANCELLED" } },
          })) >= exam.capacity
        )
          fail(409, "EXAM_FULL", "Exam capacity reached.");
        return tx.examEnrolment.create({
          data: { studentId: sid(req), examId },
        });
      });
      res.status(201).json(item);
    }),
  );
  r.get(
    "/payments",
    wrap(async (req, res) =>
      res.json(
        await db.payment.findMany({
          where: { studentId: sid(req) },
          select: {
            reference: true,
            purpose: true,
            amountMinor: true,
            currency: true,
            status: true,
            verifiedAt: true,
            createdAt: true,
            receipt: true,
          },
          ...parse(pageSchema, req.query),
        }),
      ),
    ),
  );
  r.get(
    "/fees",
    wrap(async (req, res) =>
      res.json(
        await db.fee.findMany({
          where: { active: true },
          ...parse(pageSchema, req.query),
        }),
      ),
    ),
  );
  r.get(
    "/bookings",
    wrap(async (req, res) =>
      res.json(
        await db.hostelBooking.findMany({
          where: { studentId: sid(req) },
          include: { room: { include: { hostel: true } } },
          ...parse(pageSchema, req.query),
        }),
      ),
    ),
  );
  r.post(
    "/bookings",
    wrap(async (req, res) => {
      const d = parse(
        z
          .object({
            roomId: idSchema,
            term: z.string().min(1).max(80),
            arrival: z.coerce.date(),
            departure: z.coerce.date(),
          })
          .strict(),
        req.body,
      );
      res.status(201).json(await reserveBed(db, sid(req), d));
    }),
  );
  r.post(
    "/bookings/:id/cancel",
    wrap(async (req, res) => {
      const b = await db.hostelBooking.findFirst({
        where: { id: parse(idSchema, req.params.id), studentId: sid(req) },
      });
      if (!b || b.status !== "HELD")
        fail(
          409,
          "STATE",
          "Only an unpaid hold can be cancelled. Contact staff about confirmed bookings.",
        );
      const changed = await db.hostelBooking.updateMany({
        where: { id: b.id, status: "HELD" },
        data: { status: "CANCELLED", holdExpiresAt: null },
      });
      if (!changed.count)
        fail(409, "STATE", "Booking status changed. Refresh and try again.");
      res.json({ cancelled: true });
    }),
  );
  r.get(
    "/consultations",
    wrap(async (req, res) =>
      res.json(
        await db.consultationBooking.findMany({
          where: { studentId: sid(req) },
          include: { slot: true },
          ...parse(pageSchema, req.query),
        }),
      ),
    ),
  );
  r.post(
    "/consultations",
    wrap(async (req, res) => {
      const { slotId } = parse(
        z.object({ slotId: idSchema }).strict(),
        req.body,
      );
      res.status(201).json(await bookSlot(db, sid(req), slotId));
    }),
  );
  r.post(
    "/consultations/:id/cancel",
    wrap(async (req, res) => {
      const id = parse(idSchema, req.params.id);
      const item = await db.consultationBooking.findFirst({
        where: { id, studentId: sid(req) },
        include: { slot: true },
      });
      if (
        !item ||
        item.status !== "CONFIRMED" ||
        (item.slot && item.slot.startsAt < new Date())
      )
        fail(409, "STATE", "This session cannot be cancelled.");
      res.json(
        await db.consultationBooking.update({
          where: { id },
          data: { status: "CANCELLED", slotId: null },
        }),
      );
    }),
  );
  r.patch(
    "/consultations/:id/reschedule",
    wrap(async (req, res) => {
      const { slotId } = parse(
        z.object({ slotId: idSchema }).strict(),
        req.body,
      );
      res.json(
        await transaction(db, async (tx) => {
          await lock(tx,"ConsultationSlot:"+(slotId));
          const old = await tx.consultationBooking.findFirst({
            where: {
              id: parse(idSchema, req.params.id),
              studentId: sid(req),
              status: "CONFIRMED",
            },
            include: { slot: true },
          });
          const slot = await tx.consultationSlot.findUnique({
            where: { id: slotId },
            include: { booking: true },
          });
          if (
            !old ||
            (old.slot && old.slot.startsAt < new Date()) ||
            !slot?.active ||
            slot.booking ||
            slot.startsAt <= new Date()
          )
            fail(409, "SLOT_UNAVAILABLE", "Choose an available future slot.");
          return tx.consultationBooking.update({
            where: { id: old.id },
            data: { slotId },
          });
        }),
      );
    }),
  );
  r.get(
    "/announcements",
    wrap(async (req, res) => {
      const student = await db.student.findUniqueOrThrow({
        where: { id: sid(req) },
        include: { enrolments: true },
      });
      res.json(
        await db.announcement.findMany({
          where: audienceWhere(student),
          include: {
            reads: {
              where: { userId: req.principal!.id },
              select: { readAt: true },
            },
          },
          orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
          ...parse(pageSchema, req.query),
        }),
      );
    }),
  );
  r.post(
    "/announcements/:id/read",
    wrap(async (req, res) => {
      const student = await db.student.findUniqueOrThrow({
        where: { id: sid(req) },
        include: { enrolments: true },
      });
      const post = await db.announcement.findFirst({
        where: {
          id: parse(idSchema, req.params.id),
          ...audienceWhere(student),
        },
      });
      if (!post) fail(404, "NOT_FOUND", "Announcement unavailable.");
      res.json(
        await db.announcementRead.upsert({
          where: {
            announcementId_userId: {
              announcementId: post.id,
              userId: req.principal!.id,
            },
          },
          update: {},
          create: { announcementId: post.id, userId: req.principal!.id },
        }),
      );
    }),
  );
  r.get(
    "/notifications",
    wrap(async (req, res) =>
      res.json(
        await db.notification.findMany({
          where: { userId: req.principal!.id },
          orderBy: { createdAt: "desc" },
          ...parse(pageSchema, req.query),
        }),
      ),
    ),
  );
  r.post(
    "/notifications/read",
    wrap(async (req, res) => {
      await db.notification.updateMany({
        where: { userId: req.principal!.id, readAt: null },
        data: { readAt: new Date() },
      });
      res.json({ read: true });
    }),
  );
  r.get(
    "/messages",
    wrap(async (req, res) =>
      res.json(
        await db.thread.findMany({
          where: { studentId: sid(req) },
          include: { messages: { orderBy: { createdAt: "asc" } } },
          ...parse(pageSchema, req.query),
        }),
      ),
    ),
  );
  r.post(
    "/messages",
    wrap(async (req, res) => {
      const d = parse(
        z
          .object({
            threadId: idSchema.optional(),
            subject: z.string().min(1).max(150),
            body: z.string().min(1).max(5000),
          })
          .strict(),
        req.body,
      );
      const t = d.threadId
        ? await db.thread.findFirst({
            where: { id: d.threadId, studentId: sid(req) },
          })
        : await db.thread.create({
            data: { studentId: sid(req), subject: d.subject },
          });
      if (!t) fail(404, "NOT_FOUND", "Thread unavailable.");
      res.status(201).json(
        await db.message.create({
          data: { threadId: t.id, authorId: req.principal!.id, body: d.body },
        }),
      );
    }),
  );
  r.get(
    "/export",
    wrap(async (req, res) => {
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="student-export.json"',
      );
      const student = await db.student.findUniqueOrThrow({
        where: { id: sid(req) },
        include: {
          user: { select: { email: true, phone: true, createdAt: true } },
          applications: { include: { history: true } },
          enrolments: true,
          bookings: true,
          consultations: true,
        },
      });
      res.json({
        student,
        documents: await db.document.findMany({
          where: { ownerId: req.principal!.id },
          select: {
            type: true,
            status: true,
            filename: true,
            rejectionReason: true,
          },
        }),
        payments: await db.payment.findMany({
          where: { studentId: sid(req) },
          select: {
            reference: true,
            status: true,
            amountMinor: true,
            currency: true,
            verifiedAt: true,
          },
        }),
        messages: await db.thread.findMany({
          where: { studentId: sid(req) },
          include: { messages: true },
        }),
      });
    }),
  );
  r.post(
    "/deletion-request",
    wrap(async (req, res) => {
      const d = parse(
        z.object({ reason: z.string().min(5).max(1000) }).strict(),
        req.body,
      );
      await transaction(db, async (tx) => {
        await queue(
          tx,
          config,
          "privacy:" + req.principal!.id,
          "PRIVACY_REQUEST",
          { userId: req.principal!.id, reason: d.reason },
        );
        await tx.notification.create({
          data: {
            userId: req.principal!.id,
            title: "Data deletion request received",
            body: "The school will review retention obligations and respond through your registered contact.",
          },
        });
      });
      res.status(202).json({ received: true });
    }),
  );
  return r;
}
