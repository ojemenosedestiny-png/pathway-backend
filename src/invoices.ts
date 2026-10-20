import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import {
  type Config,
  wrap,
  parse,
  fail,
  transaction,
  audit,
  rate,
  idSchema,
  pageSchema,
  random,
  digest,
} from "./core.js";
import { lock } from "./database.js";
import { moduleGuard } from "./auth.js";
export const calculateInvoice = (
  items: {
    description: string;
    amountMinor: bigint;
    currency: string;
    sourceId: string;
  }[],
) => {
  if (
    !items.length ||
    items.some((i) => i.amountMinor < 0n || i.currency !== items[0].currency)
  )
    fail(
      422,
      "INVOICE_ITEMS",
      "An invoice needs confirmed amounts in a single currency.",
    );
  const amountMinor = items.reduce((sum, item) => sum + item.amountMinor, 0n);
  if (amountMinor <= 0n)
    fail(
      422,
      "INVOICE_AMOUNT",
      "The school must confirm a positive fee before issuing this invoice.",
    );
  return { amountMinor, currency: items[0].currency };
};
export async function createInvoice(
  db: PrismaClient,
  userId: string,
  kind: "APPLICATION" | "EXAM" | "HOSTEL",
  sourceId?: string,
) {
  return transaction(db, async (tx) => {
    await lock(tx, "User:" + userId);
    const user = await tx.user.findUniqueOrThrow({
      where: { id: userId },
      include: { applicant: true, student: true },
    });
    if (user.status !== "ACTIVE")
      fail(403, "FORBIDDEN", "This account is unavailable.");
    if (
      kind === "APPLICATION" &&
      (user.role !== "APPLICANT" || !user.emailVerifiedAt)
    )
      fail(
        403,
        "EMAIL_VERIFICATION_REQUIRED",
        "Verify your email before requesting an application-fee invoice.",
      );
    if (kind !== "APPLICATION" && (user.role !== "STUDENT" || !user.student))
      fail(
        403,
        "APPLICATION_FEE_REQUIRED",
        "Your application fee must be verified before paying for exams or accommodation.",
      );
    let sourceKey = kind + ":" + userId + (sourceId ? ":" + sourceId : ""),
      items: {
        description: string;
        amountMinor: bigint;
        currency: string;
        sourceId: string;
      }[] = [],
      feeId: string | undefined,
      examId: string | undefined,
      bookingId: string | undefined;
    const existing = await tx.invoice.findUnique({
      where: { sourceKey },
      include: { items: true },
    });
    if (existing) return existing;
    if (kind === "APPLICATION") {
      if (!user.applicant?.firstName || !user.applicant.lastName || !user.phone)
        fail(
          422,
          "PROFILE_REQUIRED",
          "Add your name and phone number before requesting an application-fee invoice.",
        );
      const policy = await tx.setting.findUnique({
        where: { key: "applicationFeePolicy" },
      });
      const id = (policy?.value as any)?.feeId;
      if (!id)
        fail(
          503,
          "APPLICATION_FEE_UNCONFIGURED",
          "Admissions must confirm the application fee. No payment is due until the fee is published.",
        );
      const fee = await tx.fee.findUnique({ where: { id } });
      if (!fee?.active || fee.purpose !== "REGISTRATION")
        fail(
          503,
          "APPLICATION_FEE_UNCONFIGURED",
          "The application fee is unavailable. Contact admissions.",
        );
      feeId = fee.id;
      items = [
        {
          description: fee.name,
          amountMinor: fee.amountMinor,
          currency: fee.currency,
          sourceId: fee.id,
        },
      ];
    }
    if (kind === "EXAM") {
      if (!sourceId) fail(422, "EXAM_REQUIRED", "Choose an exam.");
      const exam = await tx.exam.findUnique({ where: { id: sourceId } });
      if (
        !exam?.active ||
        exam.opensAt > new Date() ||
        exam.closesAt < new Date()
      )
        fail(
          422,
          "EXAM_UNAVAILABLE",
          "This examination is not open for enrolment.",
        );
      const enrolment = await tx.examEnrolment.findUnique({
        where: {
          studentId_examId: { studentId: user.student!.id, examId: sourceId },
        },
      });
      if (!enrolment || enrolment.status !== "PENDING")
        fail(
          409,
          "ENROLMENT_REQUIRED",
          "Reserve your examination place before requesting an invoice.",
        );
      examId = exam.id;
      items = [
        {
          description: exam.name,
          amountMinor: exam.feeMinor,
          currency: exam.currency,
          sourceId: exam.id,
        },
      ];
    }
    if (kind === "HOSTEL") {
      if (!sourceId)
        fail(422, "BOOKING_REQUIRED", "Choose your accommodation reservation.");
      const booking = await tx.hostelBooking.findFirst({
        where: { id: sourceId, studentId: user.student!.id, status: "HELD" },
        include: { room: true },
      });
      if (!booking?.holdExpiresAt || booking.holdExpiresAt < new Date())
        fail(
          409,
          "HOLD_EXPIRED",
          "Your room hold has expired. Choose an available room again.",
        );
      if (
        booking.roomAmountMinor === null ||
        booking.depositAmountMinor === null
      )
        fail(
          409,
          "LEGACY_BOOKING",
          "Ask accommodation staff to confirm the price breakdown for this reservation.",
        );
      bookingId = booking.id;
      items = [
        {
          description: booking.room.name + " — room fee",
          amountMinor: booking.roomAmountMinor,
          currency: booking.room.currency,
          sourceId: booking.id,
        },
        {
          description: "Caution deposit",
          amountMinor: booking.depositAmountMinor,
          currency: booking.room.currency,
          sourceId: booking.id,
        },
      ];
      if (calculateInvoice(items).amountMinor !== booking.amountMinor)
        fail(409, "BOOKING_PRICE", "The reservation price needs staff review.");
    }
    const total = calculateInvoice(items);
    const invoice = await tx.invoice.create({
      data: {
        userId,
        kind,
        sourceKey,
        reference: "NWP-" + kind + "-" + random().slice(0, 20).toUpperCase(),
        ...total,
        feeId,
        examId,
        bookingId,
        items: { create: items },
      },
      include: { items: true },
    });
    await audit(
      tx,
      userId,
      "INVOICE_CREATED",
      "Invoice",
      invoice.id,
      "",
      undefined,
      { reference: invoice.reference, kind, amountMinor: invoice.amountMinor },
    );
    return invoice;
  });
}
export function invoiceRouter(db: PrismaClient, config: Config) {
  const r = Router();
  r.use((req, _res, next) => {
    try {
      if (
        !req.principal ||
        !["APPLICANT", "STUDENT"].includes(req.principal.role)
      )
        fail(403, "FORBIDDEN", "Applicant or student access required.");
      next();
    } catch (e) {
      next(e);
    }
  });
  r.get(
    "/",
    wrap(async (req, res) =>
      res.json(
        await db.invoice.findMany({
          where: { userId: req.principal!.id },
          orderBy: { createdAt: "desc" },
          include: { items: true },
          ...parse(pageSchema, req.query),
        }),
      ),
    ),
  );
  for (const [path, kind] of [
    ["application", "APPLICATION"],
    ["exam", "EXAM"],
    ["hostel", "HOSTEL"],
  ] as const)
    r.post(
      "/" + path,
      wrap(async (req, res) => {
        const input = parse(
          z.object({ sourceId: idSchema.optional() }).strict(),
          req.body,
        );
        if (kind === "APPLICATION" && input.sourceId)
          fail(
            422,
            "SOURCE_NOT_ALLOWED",
            "The school selects the application fee.",
          );
        await rate(db, "invoice-create:" + req.principal!.id, 20, 900);
        res
          .status(201)
          .json(
            await createInvoice(db, req.principal!.id, kind, input.sourceId),
          );
      }),
    );
  r.get(
    "/:id",
    wrap(async (req, res) => {
      const invoice = await db.invoice.findFirst({
        where: {
          id: parse(idSchema, req.params.id),
          userId: req.principal!.id,
        },
        include: { items: true },
      });
      if (!invoice) fail(404, "NOT_FOUND", "Invoice not found.");
      res.json(invoice);
    }),
  );
  r.post(
    "/:id/payment",
    wrap(async (req, res) => {
      parse(z.object({}).strict(), req.body);
      await rate(db, "invoice-payment:" + req.principal!.id, 20, 900);
      const result = await transaction(db, async (tx) => {
        const id = parse(idSchema, req.params.id);
        await lock(tx, "Invoice:" + id);
        const invoice = await tx.invoice.findFirst({
          where: { id, userId: req.principal!.id },
          include: { items: true },
        });
        if (!invoice) fail(404, "NOT_FOUND", "Invoice not found.");
        if (invoice.status !== "OPEN")
          fail(
            409,
            "INVOICE_CLOSED",
            "This invoice has already been paid or closed.",
          );
        const user = await tx.user.findUniqueOrThrow({
          where: { id: req.principal!.id },
          include: { applicant: true, student: true },
        });
        if (
          invoice.kind === "APPLICATION" &&
          (!user.emailVerifiedAt || user.role !== "APPLICANT")
        )
          fail(
            403,
            "EMAIL_VERIFICATION_REQUIRED",
            "Verify your applicant account before paying the application fee.",
          );
        if (
          invoice.kind !== "APPLICATION" &&
          (user.role !== "STUDENT" || !user.student)
        )
          fail(
            403,
            "APPLICATION_FEE_REQUIRED",
            "Your application fee must be verified first.",
          );
        const old = await tx.payment.findUnique({
          where: { idempotencyKey: "invoice:" + id },
        });
        if (old) return { payment: old, statusToken: undefined };
        const total = calculateInvoice(invoice.items);
        if (
          total.amountMinor !== invoice.amountMinor ||
          total.currency !== invoice.currency
        )
          fail(409, "INVOICE_PRICE", "This invoice needs staff review.");
        const statusToken = random();
        const payerName = user.student
          ? [user.student.firstName, user.student.lastName].join(" ")
          : [user.applicant!.firstName, user.applicant!.lastName].join(" ");
        const payment = await tx.payment.create({
          data: {
            reference: invoice.reference,
            idempotencyKey: "invoice:" + id,
            requestHash: digest(invoice.id + ":" + invoice.amountMinor),
            provider: "BANK",
            purpose:
              invoice.kind === "APPLICATION"
                ? "REGISTRATION"
                : invoice.kind === "EXAM"
                  ? "EXAM"
                  : "HOSTEL",
            amountMinor: invoice.amountMinor,
            currency: invoice.currency,
            payerEmail: user.email,
            payerPhone: user.phone,
            payerName,
            payerUserId: user.id,
            studentId: user.student?.id,
            invoiceId: id,
            feeId: invoice.feeId,
            examId: invoice.examId,
            bookingId: invoice.bookingId,
            statusTokenHash: digest(statusToken),
          },
        });
        return { payment, statusToken };
      });
      res
        .status(201)
        .json({
          payment: {
            reference: result.payment.reference,
            status: result.payment.status,
            amountMinor: result.payment.amountMinor,
            currency: result.payment.currency,
          },
          statusToken: result.statusToken,
        });
    }),
  );
  return r;
}
export function admissionPolicyRouter(db: PrismaClient) {
  const r = Router();
  r.get(
    "/application-fee-policy",
    moduleGuard("settings"),
    wrap(async (_req, res) =>
      res.json(
        (
          await db.setting.findUnique({
            where: { key: "applicationFeePolicy" },
          })
        )?.value || {},
      ),
    ),
  );
  r.put(
    "/application-fee-policy",
    moduleGuard("settings", true),
    wrap(async (req, res) => {
      const data = parse(z.object({ feeId: idSchema }).strict(), req.body);
      const fee = await db.fee.findUnique({ where: { id: data.feeId } });
      if (!fee?.active || fee.purpose !== "REGISTRATION")
        fail(
          422,
          "APPLICATION_FEE",
          "Select an active registration fee from the Fees manager.",
        );
      res.json(
        await transaction(db, async (tx) => {
          const before = await tx.setting.findUnique({
            where: { key: "applicationFeePolicy" },
          });
          const after = await tx.setting.upsert({
            where: { key: "applicationFeePolicy" },
            create: { key: "applicationFeePolicy", value: data },
            update: { value: data },
          });
          await audit(
            tx,
            req.principal!.id,
            "APPLICATION_FEE_POLICY",
            "Setting",
            "applicationFeePolicy",
            req.ip || "",
            before?.value,
            data,
          );
          return after.value;
        }),
      );
    }),
  );
  return r;
}
