import {lock} from "./database.js";
import { Router } from "express";
import {
  PrismaClient,
  Prisma,
  type Provider,
  type Payment,
} from "@prisma/client";
import { z } from "zod";
import PDFDocument from "pdfkit";
import {
  type Config,
  wrap,
  parse,
  fail,
  random,
  digest,
  equal,
  transaction,
  audit,
  queue,
  rate,
} from "./core.js";
import { authentication, moduleGuard, createPasswordLink } from "./auth.js";
import {
  type PaymentProvider,
  type Verified,
  validateVerification,
} from "./providers.js";
export async function allocateStudentId(
  tx: Prisma.TransactionClient,
  config: Config,
) {
  const setting = await tx.setting.findUnique({ where: { key: "studentIds" } });
  const value = setting?.value as any;
  const prefix = value?.prefix || config.STUDENT_ID_PREFIX;
  const start = Number(value?.startingNumber || config.STUDENT_ID_START);
  if (
    !/^[A-Z][A-Z0-9]{1,9}$/.test(prefix) ||
    !Number.isInteger(start) ||
    start < 1 ||
    start > 999999
  )
    fail(422, "ID_SETTINGS", "Invalid Student ID settings.");
  const year = new Intl.DateTimeFormat("en", {
    year: "numeric",
    timeZone: "Africa/Lagos",
  }).format(new Date());
  const key = prefix + "-" + year;
  const existing=await tx.idCounter.findUnique({where:{key}});
  const number=Math.max(existing?.nextNumber||start,start);
  if(existing)await tx.idCounter.update({where:{key},data:{nextNumber:number+1}});
  else await tx.idCounter.create({data:{key,nextNumber:number+1}});
  if (number > 999999)
    fail(409, "ID_EXHAUSTED", "Student ID sequence is exhausted.");
  const id = `${key}-${String(number).padStart(6, "0")}`;
  await tx.idReservation.create({ data: { studentId: id } });
  return id;
}
export async function settlePayment(
  db: PrismaClient,
  config: Config,
  reference: string,
  verified: Verified,
  actor = "provider",
  ip = "",
) {
  return transaction(db, async (tx) => {
    await lock(tx,"Payment:"+(reference));
    let p = await tx.payment.findUnique({ where: { reference } });
    if (!p) fail(404, "PAYMENT_NOT_FOUND", "Payment not found.");
    validateVerification(p, verified);
    const invoice=p.invoiceId?await (async()=>{await lock(tx,'Invoice:'+p!.invoiceId);const row=await tx.invoice.findUniqueOrThrow({where:{id:p!.invoiceId!}});if(row.status==='VOID'||row.amountMinor!==p!.amountMinor||row.currency!==p!.currency||row.userId!==p!.payerUserId)fail(409,'INVOICE_MISMATCH','This payment does not match an open invoice.');if(row.status==='PAID'&&p!.status!=='SUCCESS'&&p!.status!=='REFUNDED')fail(409,'INVOICE_ALREADY_PAID','This invoice already has a verified payment.');if(row.kind==='APPLICATION'&&p!.purpose!=='REGISTRATION')fail(409,'INVOICE_PURPOSE','Application invoices require a registration payment.');return row;})():null;
    if (p.status === "SUCCESS" || p.status === "REFUNDED") return p;
    if (verified.status !== "SUCCESS") {
      if (verified.status === "FAILED")
        await tx.payment.update({
          where: { id: p.id },
          data: { status: "FAILED" },
        });
      return p;
    }
    if(p.payerUserId)await lock(tx,"User:"+p.payerUserId);
    let studentId = p.studentId;
    if (["REGISTRATION", "ENROLMENT"].includes(p.purpose) && !studentId) {
      let user = await tx.user.findUnique({
        where: { email: p.payerEmail },
        include: { student: true,applicant:true },
      });
      if (user) {
        if(invoice?.kind==='APPLICATION'&&user.id===invoice.userId&&user.role==='APPLICANT'&&user.status==='ACTIVE'&&user.emailVerifiedAt&&user.applicant&&!user.student){
          const publicId=await allocateStudentId(tx,config);
          user=await tx.user.update({where:{id:user.id},data:{role:'STUDENT',student:{create:{studentId:publicId,firstName:user.applicant.firstName,lastName:user.applicant.lastName,milestones:[{stage:'Application fee verified',at:new Date().toISOString()}]}}},include:{student:true,applicant:true}});
          studentId=user.student!.id;
          await tx.applicant.update({where:{userId:user.id},data:{applicationFeeVerifiedAt:new Date()}});
          await queue(tx,config,'student-id-issued:'+user.id,'EMAIL',{to:user.email,title:'Your NewworldPathway Student ID',body:'Your application fee has been verified. Your Student ID is '+publicId+'. Sign in with your email address or Student ID and your existing password.'});
          await audit(tx,actor,'APPLICANT_PROMOTED','User',user.id,ip,undefined,{studentId:publicId,invoiceId:invoice.id});
        }else fail(
          409,
          "IDENTITY_CONFLICT",
          "Admissions must review the applicant identity.",
        );
      } else {
        const publicId = await allocateStudentId(tx, config);
        const [firstName, ...rest] = p.payerName.trim().split(/\s+/);
        user = await tx.user.create({
          data: {
            email: p.payerEmail,
            phone: p.payerPhone,
            role: "STUDENT",
            student: {
              create: {
                studentId: publicId,
                firstName,
                lastName: rest.join(" "),
                milestones: [
                  { stage: "Registered", at: new Date().toISOString() },
                ],
              },
            },
          },
          include: { student: true,applicant:true },
        });
        studentId = user.student!.id;
        await createPasswordLink(
          tx,
          config,
          user,
          "SET",
          `credentials:${user.id}`,
        );
      }
    }
    if (!studentId)
      fail(
        422,
        "STUDENT_REQUIRED",
        "This fee requires an authenticated student.",
      );
    if (p.examId) {
      await lock(tx,"Exam:"+(p.examId));
      const exam = await tx.exam.findUniqueOrThrow({ where: { id: p.examId } });
      const enrol = await tx.examEnrolment.findUnique({
        where: { studentId_examId: { studentId, examId: p.examId } },
      });
      if (!enrol || enrol.status === "CANCELLED")
        fail(
          409,
          "ENROLMENT_REQUIRED",
          "Reserve the exam place before payment.",
        );
      await tx.examEnrolment.update({
        where: { id: enrol.id },
        data: { status: "CONFIRMED" },
      });
    }
    if (p.bookingId) {
      const booking = await tx.hostelBooking.findUniqueOrThrow({
        where: { id: p.bookingId },
      });
      await lock(tx,"Room:"+(booking.roomId));
      if (
        booking.status !== "HELD" ||
        !booking.holdExpiresAt ||
        booking.holdExpiresAt < new Date()
      )
        fail(
          409,
          "HOLD_EXPIRED",
          "Payment received after the room hold expired. Staff must reconcile before confirming.",
        );
      await tx.hostelBooking.update({
        where: { id: booking.id },
        data: { status: "CONFIRMED", holdExpiresAt: null },
      });
    }
    p = await tx.payment.update({
      where: { id: p.id },
      data: {
        status: "SUCCESS",
        verifiedAt: new Date(),
        studentId,
        rawPayload: verified.payload as Prisma.InputJsonValue,
      },
    });
    if(invoice)await tx.invoice.update({where:{id:invoice.id},data:{status:'PAID',paidAt:new Date()}});
    await tx.receipt.upsert({
      where: { paymentId: p.id },
      update: {},
      create: { paymentId: p.id, receiptNumber: "RCPT-" + p.reference },
    });
    const student = await tx.student.findUniqueOrThrow({
      where: { id: studentId },
      include: { user: true },
    });
    await queue(tx, config, `receipt:${p.id}`, "EMAIL", {
      to: student.user.email,
      template: "receipt",
      reference: p.reference,
      studentId: student.studentId,
      amountMinor: p.amountMinor.toString(),
      currency: p.currency,
    });
    await audit(tx, actor, "PAYMENT_VERIFIED", "Payment", p.id, ip, undefined, {
      reference,
      status: "SUCCESS",
      studentId,
    });
    return p;
  });
}
const initSchema = z
  .object({
    provider: z.enum(["PAYSTACK", "FLUTTERWAVE", "STRIPE", "BANK"]),
    feeId: z.string().uuid().optional(),
    bookingId: z.string().uuid().optional(),
    examId: z.string().uuid().optional(),
    coupon: z.string().max(60).optional(),
    applicant: z
      .object({
        name: z.string().min(2).max(150),
        email: z
          .string()
          .email()
          .transform((v) => v.toLowerCase()),
        phone: z.string().regex(/^\+?[0-9 ]{7,25}$/),
      })
      .optional(),
  })
  .strict()
  .refine(
    (v) => [v.feeId, v.bookingId, v.examId].filter(Boolean).length === 1,
    "Choose exactly one server fee, booking, or exam.",
  );
export function paymentRouter(
  db: PrismaClient,
  config: Config,
  adapters: Partial<Record<Provider, PaymentProvider>>,
) {
  const r = Router();
  r.post(
    "/initialize",
    wrap(async (req, res) => {
      await rate(db, `payment:${req.ip}`, 20, 900);
      const d = parse(initSchema, req.body);
      const idem = parse(z.string().uuid(), req.get("idempotency-key"));
      const requestHash = digest(JSON.stringify(d));
      let studentId: string | undefined;
      let user: any;
      if (req.cookies.access) {
        await new Promise<void>((resolve, reject) =>
          authentication(db, config)(req, res, (e) =>
            e ? reject(e) : resolve(),
          ),
        );
        studentId = req.principal!.studentId;
        user = await db.user.findUniqueOrThrow({
          where: { id: req.principal!.id },
        });
        if(user.role==='APPLICANT')fail(403,'APPLICATION_INVOICE_REQUIRED','Use your account’s application-fee invoice. Other payments unlock after it is verified.');
      }
      let amountMinor: bigint, currency: string, purpose: any;
      let fee: any, booking: any;
      if (d.feeId) {
        fee = await db.fee.findUnique({ where: { id: d.feeId } });
        if (!fee?.active) fail(404, "FEE_NOT_FOUND", "Fee unavailable.");
        amountMinor = fee.amountMinor;
        currency = fee.currency;
        purpose = fee.purpose;
      } else if (d.bookingId) {
        if (!studentId) fail(401, "AUTH_REQUIRED", "Sign in first.");
        booking = await db.hostelBooking.findFirst({
          where: { id: d.bookingId, studentId, status: "HELD" },
          include: { room: true },
        });
        if (
          !booking ||
          !booking.holdExpiresAt ||
          booking.holdExpiresAt < new Date()
        )
          fail(409, "HOLD_EXPIRED", "Room hold expired.");
        amountMinor = booking.amountMinor;
        currency = booking.room.currency;
        purpose = "HOSTEL";
      } else {
        if (!studentId) fail(401, "AUTH_REQUIRED", "Sign in first.");
        const exam = await db.exam.findUnique({ where: { id: d.examId } });
        if (!exam?.active) fail(404, "EXAM_NOT_FOUND", "Exam unavailable.");
        if (
          exam.opensAt > new Date() ||
          exam.closesAt < new Date() ||
          !(await db.examEnrolment.findFirst({
            where: { studentId, examId: exam.id, status: "PENDING" },
          }))
        )
          fail(
            409,
            "ENROLMENT_REQUIRED",
            "Reserve an exam place during the registration window first.",
          );
        amountMinor = exam.feeMinor;
        currency = exam.currency;
        purpose = "EXAM";
      }
      if (!studentId && !["REGISTRATION", "ENROLMENT"].includes(purpose))
        fail(401, "AUTH_REQUIRED", "Sign in before paying this fee.");
      if (studentId && ["REGISTRATION", "ENROLMENT"].includes(purpose))
        fail(409, "ALREADY_ENROLLED", "This account already has a Student ID.");
      if (d.coupon) {
        const coupon = await db.coupon.findUnique({
          where: { code: d.coupon.toUpperCase() },
        });
        if (!coupon?.active || coupon.expiresAt < new Date())
          fail(422, "COUPON_INVALID", "Coupon unavailable.");
        amountMinor = (amountMinor * BigInt(100 - coupon.percent)) / 100n;
      }
      if (amountMinor <= 0n)
        fail(422, "ZERO_AMOUNT", "This fee cannot be paid through checkout.");
      if (
        (d.provider === "STRIPE" && currency !== "USD") ||
        (["PAYSTACK", "FLUTTERWAVE", "BANK"].includes(d.provider) &&
          currency !== "NGN")
      )
        fail(
          422,
          "CURRENCY",
          "Provider does not support this invoice currency.",
        );
      if (d.provider !== "BANK" && !adapters[d.provider])
        fail(
          503,
          "PROVIDER_UNCONFIGURED",
          "This payment provider is not configured.",
        );
      const applicant =
        d.applicant ||
        (user && {
          name: (
            await db.student.findUniqueOrThrow({ where: { userId: user.id } })
          ).firstName,
          email: user.email,
          phone: user.phone,
        });
      if (!applicant)
        fail(400, "APPLICANT_REQUIRED", "Applicant details are required.");
      const old = await db.payment.findUnique({
        where: { idempotencyKey: idem },
      });
      if (old) {
        if (old.requestHash !== requestHash)
          fail(
            409,
            "IDEMPOTENCY_CONFLICT",
            "This key was used for a different request.",
          );
        fail(
          409,
          "CHECKOUT_EXISTS",
          "Use the original checkout reference and status token.",
        );
      }
      const statusToken = random();
      let p = await db.payment.create({
        data: {
          reference: "PAY-" + random().slice(0, 24),
          idempotencyKey: idem,
          requestHash,
          provider: d.provider,
          purpose,
          amountMinor,
          currency,
          payerEmail: applicant.email,
          payerName: applicant.name,
          payerPhone: applicant.phone,
          statusTokenHash: digest(statusToken),
          studentId,
          feeId: d.feeId,
          bookingId: d.bookingId,
          examId: d.examId,
        },
      });
      if (d.provider !== "BANK") {
        const checkout = await adapters[d.provider]!.initialize(p);
        p = await db.payment.update({
          where: { id: p.id },
          data: { providerId: checkout.id, checkoutUrl: checkout.url },
        });
      }
      res.status(201).json({
        payment: {
          reference: p.reference,
          status: p.status,
          amountMinor: p.amountMinor.toString(),
          currency: p.currency,
        },
        checkoutUrl: p.checkoutUrl,
        statusToken,
      });
    }),
  );
  const owner = async (req: any, res: any, reference: string) => {
    const p = await db.payment.findUnique({ where: { reference } });
    if (!p) fail(404, "NOT_FOUND", "Payment unavailable.");
    const token = req.get("x-payment-token") || "";
    if (token && equal(digest(token), p.statusTokenHash)) return p;
    await new Promise<void>((resolve, reject) =>
      authentication(db, config)(req, res, (e: any) =>
        e ? reject(e) : resolve(),
      ),
    );
    if (
      !(p.payerUserId&&req.principal.id===p.payerUserId)&&
      !(p.studentId&&req.principal.studentId===p.studentId)&&
      !(
        req.principal.role === "ADMIN" &&
        (req.principal.adminRole === "SUPER_ADMIN" ||
          req.principal.permissions.read.includes("payments"))
      )
    )
      fail(404, "NOT_FOUND", "Payment unavailable.");
    return p;
  };
  r.get(
    "/verify/:reference",
    wrap(async (req, res) => {
      await rate(db, `verify:${req.ip}`, 60, 900);
      let p = await owner(req, res, req.params.reference);
      if (p.provider !== "BANK" && p.status !== "REFUNDED") {
        const adapter = adapters[p.provider];
        if (!adapter)
          fail(503, "PROVIDER_UNCONFIGURED", "Payment provider unavailable.");
        p = await settlePayment(
          db,
          config,
          p.reference,
          await adapter.verify(p),
        );
      }
      const student = p.studentId
        ? await db.student.findUnique({
            where: { id: p.studentId },
            select: { studentId: true },
          })
        : null;
      res.json({
        reference: p.reference,
        status: p.status,
        verified: !!p.verifiedAt,
        studentId: student?.studentId || null,
      });
    }),
  );
  r.post(
    "/:reference/retry",
    wrap(async (req, res) => {
      parse(z.object({}).strict(), req.body);
      await rate(db, "payment-retry:" + req.ip, 10, 900);
      const p = await owner(req, res, req.params.reference);
      if (
        p.status === "SUCCESS" ||
        p.status === "REFUNDED" ||
        p.provider === "BANK"
      )
        fail(409, "RETRY_NOT_ALLOWED", "This payment cannot be retried.");
      const adapter = adapters[p.provider];
      if (!adapter) fail(503, "PROVIDER_UNCONFIGURED", "Provider unavailable.");
      const checked = await adapter.verify(p);
      if (checked.status === "SUCCESS") {
        await settlePayment(db, config, p.reference, checked);
        return res.json({ status: "SUCCESS" });
      }
      if (p.bookingId) {
        const hold = await db.hostelBooking.findUniqueOrThrow({
          where: { id: p.bookingId },
        });
        if (
          hold.status !== "HELD" ||
          !hold.holdExpiresAt ||
          hold.holdExpiresAt < new Date()
        )
          fail(409, "HOLD_EXPIRED", "Reserve a new bed hold before retrying.");
      }
      if (checked.status === "PENDING")
        return res.json({
          status: "PENDING",
          checkoutUrl: p.checkoutUrl,
          reference: p.reference,
        });
      const statusToken = random();
      let retry = await db.payment.create({
        data: {
          reference: "PAY-" + random().slice(0, 24),
          idempotencyKey: random(),
          requestHash: p.requestHash,
          provider: p.provider,
          purpose: p.purpose,
          amountMinor: p.amountMinor,
          currency: p.currency,
          payerEmail: p.payerEmail,
          payerName: p.payerName,
          payerPhone: p.payerPhone,
          statusTokenHash: digest(statusToken),
          studentId: p.studentId,
          feeId: p.feeId,
          bookingId: p.bookingId,
          examId: p.examId,
        },
      });
      const checkout = await adapter.initialize(retry);
      retry = await db.payment.update({
        where: { id: retry.id },
        data: { providerId: checkout.id, checkoutUrl: checkout.url },
      });
      res.status(201).json({
        checkoutUrl: retry.checkoutUrl,
        reference: retry.reference,
        statusToken,
      });
    }),
  );
  r.get(
    "/:reference/receipt",
    wrap(async (req, res) => {
      const p = await owner(req, res, req.params.reference);
      const receipt = await db.receipt.findUnique({
        where: { paymentId: p.id },
        include: { payment: { include: { student: true } } },
      });
      if (!receipt)
        fail(404, "NO_RECEIPT", "A verified receipt is not available.");
      res
        .type("pdf")
        .setHeader(
          "Content-Disposition",
          `attachment; filename="${receipt.receiptNumber}.pdf"`,
        );
      const pdf = new PDFDocument({ margin: 55 });
      pdf.pipe(res);
      pdf.fontSize(25).text("NewworldPathway");
      pdf.fontSize(13).text("Payment receipt").moveDown();
      for (const line of [
        receipt.receiptNumber,
        `Reference: ${p.reference}`,
        `Date: ${p.verifiedAt?.toISOString()}`,
        `Student: ${p.payerName}`,
        `Student ID: ${receipt.payment.student?.studentId || ""}`,
        `Amount: ${p.currency} ${(Number(p.amountMinor) / 100).toFixed(2)}`,
        `Purpose: ${p.purpose}`,
        `Status: ${p.status}`,
      ])
        pdf.text(line);
      pdf.end();
    }),
  );
  return r;
}
export function webhook(
  db: PrismaClient,
  config: Config,
  adapters: Partial<Record<Provider, PaymentProvider>>,
) {
  return wrap(async (req, res) => {
    const provider = parse(
      z.enum(["PAYSTACK", "FLUTTERWAVE", "STRIPE"]),
      String(req.params.provider).toUpperCase(),
    );
    const adapter = adapters[provider];
    if (!adapter) fail(503, "PROVIDER_UNCONFIGURED", "Provider unavailable.");
    const event = adapter.webhook(req.body, req.headers);
    if (!event) return res.json({ received: true });
    const existing = await db.webhookEvent.findUnique({
      where: { provider_eventId: { provider, eventId: event.eventId } },
    });
    if (existing?.processedAt)
      return res.json({ received: true, duplicate: true });
    const payment = await db.payment.findUnique({
      where: { reference: event.reference },
    });
    if (!payment || payment.provider !== provider)
      fail(404, "PAYMENT_NOT_FOUND", "Payment reference unavailable.");
    await db.webhookEvent.upsert({
      where: { provider_eventId: { provider, eventId: event.eventId } },
      update: {},
      create: { provider, eventId: event.eventId, reference: event.reference },
    });
    const verified = await adapter.verify(payment);
    if (verified.status === "PENDING")
      fail(
        503,
        "PAYMENT_PENDING",
        "Provider verification is pending; retry webhook.",
      );
    await settlePayment(db, config, payment.reference, verified);
    await db.webhookEvent.update({
      where: { provider_eventId: { provider, eventId: event.eventId } },
      data: { processedAt: new Date() },
    });
    res.json({ received: true });
  });
}
