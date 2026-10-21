import {PDFDocument} from 'pdf-lib';
import {submitAdmission,admissionSchema,ensureAdmissionCollection} from '../src/admissions.js';
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import {MongoClient} from "mongodb";
import {createDatabase,setupMongoDatabase} from "../src/database.js";
import { PrismaClient, type Payment } from "@prisma/client";
import request from "supertest";
import argon2 from "argon2";
import { authenticator } from "otplib";
import {
  configuration,
  unseal,
  digest,
  transaction,
  random,
} from "../src/core.js";
import { createApp } from "../src/app.js";
import { allocateStudentId, settlePayment } from "../src/payments.js";
import { reserveBed, bookSlot } from "../src/portal.js";
import {
  providers,
  validateVerification,
  type PaymentProvider,
  type Verified,
} from "../src/providers.js";
import { defaultPermissions } from "../src/auth.js";
import { schedule, workOnce, runJob } from "../src/jobs.js";
import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { sanitize } from "../src/admin.js";
const mongoBase=process.env.TEST_MONGODB_URI||'mongodb://127.0.0.1:27019/?replicaSet=rs0&directConnection=true';
const testName='pathway_test_'+crypto.randomUUID().replace(/-/g,'');
const testUrl=new URL(mongoBase);testUrl.pathname='/'+testName;const url=testUrl.toString();
const config = configuration.parse({
  NODE_ENV: "test",
  DATABASE_URL: url,
  FRONTEND_ORIGIN: "http://localhost:3000",
  PUBLIC_API_ORIGIN: "http://localhost:4000",
  JWT_SECRET: random(),
  ENCRYPTION_KEY: random(),
  COOKIE_SECURE: "false",
  PAYSTACK_SECRET_KEY: random(),
});
const db = createDatabase(url);

const gateway: PaymentProvider = {
  async initialize(p) {
    return { id: p.reference, url: "https://checkout.example/" + p.reference };
  },
  async verify(p) {
    return verified(p);
  },
  webhook(raw, headers) {
    const signature = crypto
      .createHmac("sha512", config.PAYSTACK_SECRET_KEY!)
      .update(raw)
      .digest("hex");
    if (headers["x-paystack-signature"] !== signature)
      throw new Error("Invalid signature");
    const v = JSON.parse(raw.toString());
    return { eventId: v.id, reference: v.reference };
  },
  async refund() {
    return "refund-test";
  },
};
const app = createApp(db, config, { PAYSTACK: gateway });
const verified = (p: Payment): Verified => ({
  reference: p.reference,
  providerId: p.providerId || p.reference,
  amountMinor: p.amountMinor,
  currency: p.currency,
  status: "SUCCESS",
  payload: { verified: true },
});
const csrf = async (agent: any) => {
  const r = await agent.get("/auth/csrf");
  return r.body.csrfToken as string;
};
const post = (agent: any, token: string, url: string, body: unknown) =>
  agent
    .post(url)
    .set("Origin", config.FRONTEND_ORIGIN)
    .set("X-CSRF-Token", token)
    .send(body);
async function invoice(email = random().slice(0, 12) + "@example.test") {
  return db.payment.create({
    data: {
      reference: "T-" + random().slice(0, 24),
      provider: "PAYSTACK",
      purpose: "REGISTRATION",
      amountMinor: 2500000n,
      currency: "NGN",
      idempotencyKey: crypto.randomUUID(),
      requestHash: random(),
      payerEmail: email,
      payerName: "Test Student",
      payerPhone: "+2348000000000",
      statusTokenHash: digest(random()),
    },
  });
}
async function student() {
  const p = await invoice();
  const paid = await settlePayment(db, config, p.reference, verified(p));
  return db.student.findUniqueOrThrow({ where: { id: paid.studentId! } });
}
before(async()=>{await setupMongoDatabase(url);await db.$connect();},{timeout:120000});
after(async()=>{await db.$disconnect();const client=new MongoClient(url);await client.connect();try{if(!/^pathway_test_[a-f0-9]{32}$/.test(client.db().databaseName))throw new Error('Refusing to remove a non-test database');await client.db().dropDatabase();}finally{await client.close();}});
test("ID allocation stays unique and sequential under concurrent transactions", async () => {
  const ids = await Promise.all(
    Array.from({ length: 8 }, () =>
      transaction(db, (tx) => allocateStudentId(tx, config)),
    ),
  );
  assert.equal(new Set(ids).size, 8);
  const sorted = ids.map((i) => Number(i.slice(-6))).sort((a, b) => a - b);
  assert.equal(sorted[7] - sorted[0], 7);
  assert.match(ids[0], /^PU-\d{4}-\d{6}$/);
});
test("provider verification rejects wrong amount, currency, reference and provider identity", async () => {
  const p = await invoice();
  for (const difference of [
    { amountMinor: 1n },
    { currency: "USD" },
    { reference: "other" },
    { providerId: "" },
  ])
    assert.throws(() =>
      validateVerification(p, { ...verified(p), ...difference }),
    );
  assert.equal(
    await db.student.count({ where: { user: { email: p.payerEmail } } }),
    0,
  );
});
test("pending and failed payments never create students", async () => {
  for (const status of ["PENDING", "FAILED"] as const) {
    const p = await invoice();
    await settlePayment(db, config, p.reference, { ...verified(p), status });
    assert.equal(
      await db.student.count({ where: { user: { email: p.payerEmail } } }),
      0,
    );
  }
});
test("pay -> signed webhook -> one student/receipt -> password setup -> login -> private portal", async () => {
  const agent = request.agent(app),
    token = await csrf(agent);
  const fee = await db.fee.create({
    data: {
      name: "Registration",
      purpose: "REGISTRATION",
      amountMinor: 1234500n,
      currency: "NGN",
    },
  });
  const init = await post(agent, token, "/payments/initialize", {
    provider: "PAYSTACK",
    feeId: fee.id,
    applicant: {
      name: "Grace Student",
      email: "grace@example.test",
      phone: "+2348000000001",
    },
  }).set("Idempotency-Key", crypto.randomUUID());
  assert.equal(init.status, 201, JSON.stringify(init.body));
  const p = await db.payment.findUniqueOrThrow({
    where: { reference: init.body.payment.reference },
  });
  assert.equal(p.amountMinor, 1234500n);
  const payload = { id: "event-" + random(), reference: p.reference },
    raw = JSON.stringify(payload),
    signature = crypto
      .createHmac("sha512", config.PAYSTACK_SECRET_KEY!)
      .update(raw)
      .digest("hex");
  for (let i = 0; i < 3; i++) {
    const hook = await request(app)
      .post("/payments/webhook/paystack")
      .set("Content-Type", "application/json")
      .set("x-paystack-signature", signature)
      .send(raw);
    assert.equal(hook.status, 200, JSON.stringify(hook.body));
  }
  const paid = await db.payment.findUniqueOrThrow({
    where: { id: p.id },
    include: { student: true, receipt: true },
  });
  assert.ok(paid.student);
  assert.ok(paid.receipt);
  assert.equal(
    await db.student.count({ where: { user: { email: p.payerEmail } } }),
    1,
  );
  const job = await db.outbox.findUniqueOrThrow({
    where: { key: "credentials:" + paid.student.userId },
  });
  const mail = unseal<any>(job.payload, config);
  assert.equal(mail.studentId, paid.student.studentId);
  assert.ok(!("password" in mail));
  const setupToken = new URL(mail.link).hash.split("token=")[1];
  const setup = await post(agent, token, "/auth/set-password", {
    token: setupToken,
    password: "Strong-secret-42!",
  });
  assert.equal(setup.status, 200, JSON.stringify(setup.body));
  assert.equal(
    (
      await post(agent, token, "/auth/set-password", {
        token: setupToken,
        password: "Strong-secret-42!",
      })
    ).status,
    410,
  );
  const login = await post(agent, token, "/auth/student/login", {
    studentId: paid.student.studentId,
    password: "Strong-secret-42!",
    rememberMe: true,
  });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const profile = await agent.get("/portal/profile");
  assert.equal(profile.status, 200);
  assert.equal(profile.body.studentId, paid.student.studentId);
  assert.ok(!JSON.stringify(profile.body).includes("passwordHash"));
  assert.equal((await agent.get("/admin/students")).status, 403);
  const receipt = await agent.get("/payments/" + p.reference + "/receipt");
  assert.equal(receipt.status, 200);
  assert.match(receipt.headers["content-type"], /pdf/);
  assert.equal(
    (await request(app).get("/payments/verify/" + p.reference)).status,
    401,
  );
  await post(agent, token, "/auth/logout-all", {});
  assert.equal((await agent.get("/portal/profile")).status, 401);
});
test("real Paystack raw signature verification fails closed", () => {
  const adapter = providers(config).PAYSTACK!,
    raw = Buffer.from(
      JSON.stringify({
        event: "charge.success",
        data: { id: 42, reference: "ref" },
      }),
    );
  assert.throws(() => adapter.webhook(raw, { "x-paystack-signature": "bad" }));
  const signature = crypto
    .createHmac("sha512", config.PAYSTACK_SECRET_KEY!)
    .update(raw)
    .digest("hex");
  assert.equal(
    adapter.webhook(raw, { "x-paystack-signature": signature })?.reference,
    "ref",
  );
});
test("same payment settled concurrently has one student, ID and receipt", async () => {
  const p = await invoice();
  await Promise.all(
    Array.from({ length: 5 }, () =>
      settlePayment(db, config, p.reference, verified(p)),
    ),
  );
  assert.equal(
    await db.student.count({ where: { user: { email: p.payerEmail } } }),
    1,
  );
  assert.equal(await db.receipt.count({ where: { paymentId: p.id } }), 1);
});
test("room and consultation races admit exactly one student; expired holds release beds", async () => {
  const [a, b] = await Promise.all([student(), student()]);
  const hostel = await db.hostel.create({
    data: { name: "Test", description: "Test", gender: "MIXED", rules: "" },
  });
  const room = await db.room.create({
    data: {
      hostelId: hostel.id,
      name: "One bed",
      capacity: 1,
      priceMinor: 10000n,
      depositMinor: 0n,
      gender: "MIXED",
    },
  });
  const data = {
    roomId: room.id,
    term: "2027",
    arrival: new Date("2027-01-01"),
    departure: new Date("2027-06-01"),
  };
  const results = await Promise.allSettled([
    reserveBed(db, a.id, data),
    reserveBed(db, b.id, data),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const held = await db.hostelBooking.findFirstOrThrow({
    where: { roomId: room.id },
  });
  await db.hostelBooking.update({
    where: { id: held.id },
    data: { holdExpiresAt: new Date(Date.now() - 1000) },
  });
  await schedule(db, config);
  assert.equal(
    (await db.hostelBooking.findUniqueOrThrow({ where: { id: held.id } }))
      .status,
    "EXPIRED",
  );
  await reserveBed(db, b.id, data);
  const slot = await db.consultationSlot.create({
    data: {
      advisorId: crypto.randomUUID(),
      advisor: "Advisor",
      startsAt: new Date("2027-07-01T10:00:00Z"),
      endsAt: new Date("2027-07-01T10:30:00Z"),
      mode: "VIDEO",
    },
  });
  const bookings = await Promise.allSettled([
    bookSlot(db, a.id, slot.id),
    bookSlot(db, b.id, slot.id),
  ]);
  assert.equal(bookings.filter((r) => r.status === "fulfilled").length, 1);
});
test("strict CSRF, account locking and cross-student ownership", async () => {
  const s = await student();
  await db.user.update({
    where: { id: s.userId },
    data: {
      passwordHash: await argon2.hash("Correct-secret-77!"),
      mustChangePassword: false,
    },
  });
  const agent = request.agent(app),
    token = await csrf(agent);
  assert.equal(
    (
      await agent
        .post("/auth/student/login")
        .send({ studentId: s.studentId, password: "Correct-secret-77!" })
    ).status,
    403,
  );
  for (let i = 0; i < 5; i++)
    assert.equal(
      (
        await post(agent, token, "/auth/student/login", {
          studentId: s.studentId,
          password: "wrong",
        })
      ).status,
      401,
    );
  assert.ok(
    (await db.user.findUniqueOrThrow({ where: { id: s.userId } }))
      .lockedUntil! > new Date(),
  );
  assert.equal(
    (
      await post(agent, token, "/auth/student/login", {
        studentId: s.studentId,
        password: "Correct-secret-77!",
      })
    ).status,
    401,
  );
});
test("admin initial password change and TOTP required; backup code single-use; role limits", async () => {
  const admin = await db.user.create({
    data: {
      role: "ADMIN",
      email: "owner@example.test",
      phone: "",
      passwordHash: await argon2.hash("Initial-secret-44!"),
      admin: {
        create: {
          name: "Owner",
          roleType: "SUPER_ADMIN",
          permissions: defaultPermissions.SUPER_ADMIN,
        },
      },
    },
  });
  const agent = request.agent(app),
    token = await csrf(agent);
  let response = await post(agent, token, "/auth/admin/login", {
    email: admin.email,
    password: "Initial-secret-44!",
  });
  assert.equal(response.status, 200);
  const challenge = response.body.challenge;
  assert.equal((await agent.get("/admin/students")).status, 401);
  assert.equal(
    (await post(agent, token, "/auth/admin/2fa/setup", { challenge })).status,
    403,
  );
  assert.equal(
    (
      await post(agent, token, "/auth/admin/onboarding/password", {
        challenge,
        newPassword: "Changed-secret-55!",
      })
    ).status,
    200,
  );
  response = await post(agent, token, "/auth/admin/2fa/setup", { challenge });
  assert.equal(response.status, 200);
  const secret = response.body.secret;
  response = await post(agent, token, "/auth/admin/2fa/verify", {
    challenge,
    code: authenticator.generate(secret),
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.backupCodes.length, 10);
  assert.equal((await agent.get("/admin/students")).status, 200);
  assert.equal(
    (
      await post(agent, token, "/auth/admin/2fa/verify", {
        challenge,
        code: authenticator.generate(secret),
      })
    ).status,
    401,
  );
  const codes = response.body.backupCodes;
  await post(agent, token, "/auth/logout-all", {});
  const login = await post(agent, token, "/auth/admin/login", {
    email: admin.email,
    password: "Changed-secret-55!",
  });
  assert.equal(
    (
      await post(agent, token, "/auth/admin/2fa/verify", {
        challenge: login.body.challenge,
        code: codes[0],
      })
    ).status,
    200,
  );
  const next = await post(agent, token, "/auth/admin/login", {
    email: admin.email,
    password: "Changed-secret-55!",
  });
  assert.equal(
    (
      await post(agent, token, "/auth/admin/2fa/verify", {
        challenge: next.body.challenge,
        code: codes[0],
      })
    ).status,
    401,
  );
  await db.admin.update({
    where: { userId: admin.id },
    data: { roleType: "CONTENT", permissions: defaultPermissions.CONTENT },
  });
  assert.equal((await agent.get("/admin/payments")).status, 403);
  assert.equal((await agent.get("/admin/content")).status, 200);
  const created = await post(agent, token, "/admin/announcements", {
    title: "School update",
    body: '<p onclick="bad()">Hello <strong>students</strong></p>',
    attachments: [],
    category: "General",
    audience: { type: "Website" },
    channels: ["NEWS"],
    pinned: false,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.status, "DRAFT");
  assert.ok(!created.body.body.includes("onclick"));
  const published = await post(
    agent,
    token,
    "/admin/announcements/" + created.body.id + "/publish",
    {},
  );
  assert.equal(published.status, 200);
  const again = await post(
    agent,
    token,
    "/admin/announcements/" + created.body.id + "/publish",
    {},
  );
  assert.equal(again.body.version, published.body.version);
  const media = await db.document.create({
    data: {
      ownerId: admin.id,
      type: "MEDIA",
      filename: "image.png",
      mime: "image/png",
      size: 20,
      fileKey: "public/" + random(),
      public: true,
      status: "APPROVED",
    },
  });
  const removed = await agent
    .delete("/admin/media/" + media.id)
    .set("Origin", config.FRONTEND_ORIGIN)
    .set("X-CSRF-Token", token);
  assert.equal(removed.status, 202);
  assert.equal(
    (await db.document.findUniqueOrThrow({ where: { id: media.id } })).status,
    "DELETION_REQUESTED",
  );
  assert.equal(
    await db.auditLog.count({
      where: { entityId: media.id, action: "MEDIA_DELETE" },
    }),
    1,
  );
});
test("rich text sanitization removes scripts and unsafe links", () => {
  const output = sanitize(
    '<p onclick="x()">Hello<strong>World</strong><script>alert(1)</script><a href="javascript:alert(1)">link</a></p>',
  );
  assert.ok(output.includes("<strong>World</strong>"));
  assert.ok(!/script|onclick|javascript/.test(output));
});
test("application prevents audit mutation and ID reservation deletion", async () => {
  const id = await transaction(db, (tx) => allocateStudentId(tx, config));
  await assert.rejects(() =>
    db.idReservation.delete({ where: { studentId: id } }),
  );
  const audit = await db.auditLog.findFirstOrThrow();
  await assert.rejects(() => db.auditLog.delete({ where: { id: audit.id } }));
});
test("another student cannot read private files, message another thread or mark targeted posts read", async () => {
  const [a, b] = await Promise.all([student(), student()]);
  const hash = await argon2.hash("Ownership-secret-22!");
  await db.user.update({
    where: { id: b.userId },
    data: { passwordHash: hash, mustChangePassword: false },
  });
  const file = await db.document.create({
    data: {
      ownerId: a.userId,
      type: "RESULT",
      filename: "result.pdf",
      mime: "application/pdf",
      size: 12,
      fileKey: "test/" + random(),
      status: "APPROVED",
    },
  });
  const thread = await db.thread.create({
    data: { studentId: a.id, subject: "Private" },
  });
  const notice = await db.announcement.create({
    data: {
      title: "Private",
      body: "For A only",
      category: "General",
      audience: { type: "Student", value: a.id },
      channels: ["DASHBOARD"],
      status: "PUBLISHED",
    },
  });
  const agent = request.agent(app),
    token = await csrf(agent);
  assert.equal(
    (
      await post(agent, token, "/auth/student/login", {
        studentId: b.studentId,
        password: "Ownership-secret-22!",
      })
    ).status,
    200,
  );
  assert.equal(
    (await agent.get("/files/" + file.id + "/download-url")).status,
    404,
  );
  assert.equal(
    (
      await post(agent, token, "/portal/messages", {
        threadId: thread.id,
        subject: "Forged",
        body: "Access test",
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await post(
        agent,
        token,
        "/portal/announcements/" + notice.id + "/read",
        {},
      )
    ).status,
    404,
  );
  assert.ok(
    !(await agent.get("/portal/announcements")).body.some(
      (p: any) => p.id === notice.id,
    ),
  );
  assert.equal(
    (
      await post(agent, token, "/portal/bookings", {
        roomId: crypto.randomUUID(),
        studentId: a.id,
        term: "2027",
        arrival: "2027-01-01",
        departure: "2027-06-01",
      })
    ).status,
    400,
  );
});
test("expired reset tokens fail and refresh replay revokes all sessions", async () => {
  const s = await student(),
    raw = random();
  await db.user.update({
    where: { id: s.userId },
    data: {
      passwordHash: await argon2.hash("Refresh-secret-33!"),
      mustChangePassword: false,
    },
  });
  await db.passwordToken.create({
    data: {
      userId: s.userId,
      hash: digest(raw),
      kind: "RESET",
      expiresAt: new Date(Date.now() - 1000),
    },
  });
  const agent = request.agent(app),
    token = await csrf(agent);
  assert.equal(
    (
      await post(agent, token, "/auth/set-password", {
        token: raw,
        password: "New-password-44!",
      })
    ).status,
    410,
  );
  const login = await post(agent, token, "/auth/student/login", {
    studentId: s.studentId,
    password: "Refresh-secret-33!",
  });
  assert.equal(login.status, 200);
  const oldRefresh = (login.headers["set-cookie"] as unknown as string[])
    .find((c) => c.startsWith("refresh="))!
    .split(";")[0];
  assert.equal((await post(agent, token, "/auth/refresh", {})).status, 200);
  const replay = await request(app)
    .post("/auth/refresh")
    .set("Origin", config.FRONTEND_ORIGIN)
    .set("Cookie", [oldRefresh, "csrf=" + token])
    .set("X-CSRF-Token", token)
    .send({});
  assert.equal(replay.status, 401);
  assert.equal((await agent.get("/portal/profile")).status, 401);
});
test("exam payment confirms only an existing enrolment and bank payment uses shared student creation", async () => {
  const s = await student();
  const exam = await db.exam.create({
    data: {
      body: "WAEC",
      name: "Test exam",
      description: "Test",
      feeMinor: 10000n,
      currency: "NGN",
      opensAt: new Date(Date.now() - 86400000),
      closesAt: new Date(Date.now() + 86400000),
      centre: "Test",
      capacity: 1,
    },
  });
  await db.examEnrolment.create({ data: { studentId: s.id, examId: exam.id } });
  const p = await db.payment.create({
    data: {
      reference: "EX-" + random(),
      idempotencyKey: random(),
      requestHash: random(),
      provider: "PAYSTACK",
      purpose: "EXAM",
      amountMinor: 10000n,
      currency: "NGN",
      payerEmail: "exam@example.test",
      payerName: "Student",
      payerPhone: "+2348000000000",
      studentId: s.id,
      examId: exam.id,
      statusTokenHash: digest(random()),
    },
  });
  await settlePayment(db, config, p.reference, verified(p));
  assert.equal(
    (
      await db.examEnrolment.findUniqueOrThrow({
        where: { studentId_examId: { studentId: s.id, examId: exam.id } },
      })
    ).status,
    "CONFIRMED",
  );
  const bank = await invoice();
  await db.payment.update({
    where: { id: bank.id },
    data: { provider: "BANK" },
  });
  const settled = await settlePayment(
    db,
    config,
    bank.reference,
    verified(bank),
    "test-finance",
  );
  assert.ok(settled.studentId);
  assert.equal(settled.status, "SUCCESS");
});
test("scheduled announcements publish once, expire, and jobs fail into retry without secrets", async () => {
  const p = await db.announcement.create({
    data: {
      title: "Scheduled",
      body: "Public notice",
      category: "General",
      audience: { type: "Website" },
      channels: ["NEWS"],
      status: "SCHEDULED",
      publishAt: new Date(Date.now() - 1000),
      expireAt: new Date(Date.now() + 60000),
    },
  });
  await schedule(db, config);
  await schedule(db, config);
  assert.equal(
    (await db.announcement.findUniqueOrThrow({ where: { id: p.id } })).status,
    "PUBLISHED",
  );
  assert.equal(
    await db.outbox.count({ where: { key: "announcement:" + p.id + ":1" } }),
    1,
  );
  await db.announcement.update({
    where: { id: p.id },
    data: { expireAt: new Date(Date.now() - 1000) },
  });
  await schedule(db, config);
  assert.equal(
    (await db.announcement.findUniqueOrThrow({ where: { id: p.id } })).status,
    "ARCHIVED",
  );
  await workOnce(db, config);
  assert.ok(await db.outbox.count({ where: { attempts: { gte: 1 } } }));
  const documentation = await request(app).get("/openapi.json");
  assert.equal(documentation.status, 200);
  assert.ok(documentation.body.paths["/payments/webhook/{provider}"]);
});
test("scanned private uploads move away from replayable upload URLs", async () => {
  const s = await student();
  await db.user.update({
    where: { id: s.userId },
    data: {
      passwordHash: await argon2.hash("Upload-secret-22!"),
      mustChangePassword: false,
    },
  });
  const cfg = {
    ...config,
    S3_BUCKET: "private-tests",
    S3_ACCESS_KEY: random(),
    S3_SECRET_KEY: random(),
    S3_REGION: "us-east-1",
    SCANNER_URL: "https://scanner.example.test/scan",
    SCANNER_TOKEN: random(),
  };
  const agent = request.agent(createApp(db, cfg, { PAYSTACK: gateway })),
    token = await csrf(agent);
  assert.equal(
    (
      await post(agent, token, "/auth/student/login", {
        studentId: s.studentId,
        password: "Upload-secret-22!",
      })
    ).status,
    200,
  );
  const pdf=await PDFDocument.create();pdf.addPage();const bytes=Buffer.from(await pdf.save());
  const start = await post(agent, token, "/files/upload-url", {
    filename: "result.pdf",
    mime: "application/pdf",
    size: bytes.length,
    type: "RESULT",
  });
  assert.equal(start.status, 201, JSON.stringify(start.body));
  const file = await db.document.findUniqueOrThrow({
    where: { id: start.body.id },
  });
  assert.equal(
    (await agent.get("/files/" + file.id + "/download-url")).status,
    409,
  );
  const send = S3Client.prototype.send,
    fetchOriginal = globalThis.fetch;
  const writes: any[] = [];
  try {
    (S3Client.prototype as any).send = async (command: any) => {
      if (command instanceof HeadObjectCommand)
        return { ContentLength: bytes.length, ContentType: "application/pdf" };
      if (command instanceof GetObjectCommand)
        return {
          ContentLength: bytes.length,
          Body: { transformToByteArray: async () => bytes,async *[Symbol.asyncIterator](){yield bytes;} },
        };
      if (command instanceof PutObjectCommand) {
        writes.push(command.input);
        return {};
      }
      if (command instanceof DeleteObjectCommand) return {};
      throw new Error("Unexpected storage request");
    };
    assert.equal(
      (await post(agent, token, "/files/" + file.id + "/complete", {})).status,
      202,
    );
    const scanned = await db.document.findUniqueOrThrow({
      where: { id: file.id },
    });
    assert.equal(scanned.status, "PENDING");
    assert.match(scanned.fileKey, /^private\//);
    assert.notEqual(scanned.fileKey, file.fileKey);
    assert.equal((await PDFDocument.load(writes[0].Body)).getPageCount(),1);assert.notDeepEqual(Buffer.from(writes[0].Body),bytes);
    assert.equal(
      (await agent.get("/files/" + file.id + "/download-url")).status,
      200,
    );
  } finally {
    S3Client.prototype.send = send;
    globalThis.fetch = fetchOriginal;
  }
  assert.equal(
    (
      await post(agent, token, "/files/upload-url", {
        filename: "public.png",
        mime: "image/png",
        size: 10,
        type: "MEDIA",
        public: true,
      })
    ).status,
    403,
  );
});


test("public admissions persist once under concurrency without creating portal accounts", async()=>{
 await ensureAdmissionCollection(db);
 const id=crypto.randomUUID(),beforeStudents=await db.student.count(),beforeUsers=await db.user.count();
 const data=admissionSchema.parse({firstName:'Guest',lastName:'Applicant',email:'guest-'+id+'@example.test',phone:'+2348000000000',programme:'Cambridge Curriculum',consent:true});
 const responses=await Promise.all(Array.from({length:8},()=>submitAdmission(db,id,data,'127.0.0.1')));
 assert.equal(new Set(responses.map(row=>row.item.reference)).size,1);
 assert.equal(responses.filter(row=>row.created).length,1);
 assert.equal(await db.admissionApplication.count({where:{id}}),1);
 assert.equal(await db.auditLog.count({where:{entity:'AdmissionApplication',entityId:id,action:'ADMISSION_SUBMITTED'}}),1);
 assert.equal(await db.student.count(),beforeStudents);assert.equal(await db.user.count(),beforeUsers);
 const guest=request.agent(app),token=await csrf(guest);
 const result=await post(guest,token,'/public/applications',{...data}).set('Idempotency-Key',id);
 assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.email,undefined);
 assert.equal((await guest.get('/admin/applicants')).status,401);
});


test('accepted guest gets one Student ID and one usable password link, without a payment',async()=>{
 const {provisionAdmissionStudent}=await import('../src/admissions.js');
 const id=crypto.randomUUID(),email='approved-'+id+'@example.test';
 const application={id,email,phone:'+2348000000000',firstName:'Approved',lastName:'Applicant',reference:'APP-'+id};
 const paymentsBefore=await db.payment.count(),studentsBefore=await db.student.count();
 const results=await Promise.all(Array.from({length:5},()=>transaction(db,tx=>provisionAdmissionStudent(tx,config,application))));
 assert.equal(new Set(results.map(r=>r.studentId)).size,1);assert.equal(await db.student.count(),studentsBefore+1);assert.equal(await db.payment.count(),paymentsBefore);
 const user=await db.user.findUniqueOrThrow({where:{email},include:{student:true}});assert.equal(user.role,'STUDENT');assert.equal(user.passwordHash,null);assert.equal(user.student!.journeyStage,'Registration in progress');
 const key='admission-portal:'+id;assert.equal(await db.outbox.count({where:{key}}),1);assert.equal(await db.passwordToken.count({where:{userId:user.id,usedAt:null}}),1);
 const job=await db.outbox.findUniqueOrThrow({where:{key}});const payload=unseal<any>(job.payload,config);assert.equal(payload.studentId,results[0].studentId);assert.equal(payload.template,'credentials');assert.equal(payload.to,email);assert.equal(payload.password,undefined);
 const token=new URL(payload.link).hash.slice('#token='.length),password='Approved-student-passphrase-2046';
 const agent=request.agent(app),csrfToken=await csrf(agent);
 assert.equal((await post(agent,csrfToken,'/auth/set-password',{token,password})).status,200);
 assert.equal((await post(agent,csrfToken,'/auth/set-password',{token,password})).status,410);
 assert.equal((await post(agent,csrfToken,'/auth/student/login',{studentId:results[0].studentId,password})).status,200);
 assert.equal((await agent.get('/portal/profile')).status,200);
 const hash=(await db.user.findUniqueOrThrow({where:{email}})).passwordHash;
 await transaction(db,tx=>provisionAdmissionStudent(tx,config,application));assert.equal((await db.user.findUniqueOrThrow({where:{email}})).passwordHash,hash);assert.equal(await db.outbox.count({where:{key}}),1);
});

test('an application invoice remains payable after admissions issues the student ID',async()=>{
 const {provisionAdmissionStudent}=await import('../src/admissions.js');const id=crypto.randomUUID(),email='early-'+id+'@example.test';
 const user=await db.user.create({data:{email,phone:'+2348000000000',role:'APPLICANT',emailVerifiedAt:new Date(),passwordHash:'existing-password-hash',applicant:{create:{applicantNumber:'APP-'+id,firstName:'Early',lastName:'Applicant'}}}});
 const payment=await invoice(email);const bill=await db.invoice.create({data:{reference:'INV-'+id,userId:user.id,kind:'APPLICATION',sourceKey:id,amountMinor:payment.amountMinor,currency:payment.currency}});
 const pending=await db.payment.update({where:{id:payment.id},data:{payerUserId:user.id,invoiceId:bill.id}});
 const provisioned=await transaction(db,tx=>provisionAdmissionStudent(tx,config,{id,email,phone:user.phone,firstName:'Early',lastName:'Applicant',reference:'APP-'+id}));
 assert.equal((await db.user.findUniqueOrThrow({where:{id:user.id}})).passwordHash,'existing-password-hash');
 const settled=await settlePayment(db,config,pending.reference,verified(pending));
 const student=await db.student.findUniqueOrThrow({where:{userId:user.id}});assert.equal(student.studentId,provisioned.studentId);assert.equal(settled.studentId,student.id);assert.equal((await db.invoice.findUniqueOrThrow({where:{id:bill.id}})).status,'PAID');assert.equal(await db.student.count({where:{userId:user.id}}),1);
});

test('Phase 2: verified applicants promote atomically, retaining their password and identity', async()=>{
 const email=random().slice(0,12)+'@example.test', password='Applicant-passphrase-2046';
 const agent=request.agent(app), token=await csrf(agent);
 assert.equal((await post(agent,token,'/auth/applicant/signup',{email,password,consent:true})).status,202);
 const user=await db.user.findUniqueOrThrow({where:{email},include:{applicant:true,student:true}});
 assert.equal(user.role,'APPLICANT');assert.equal(user.student,null);assert.match(user.applicant!.applicantNumber,/^APP-\d{4}-\d{4,6}$/);
 assert.equal((await post(agent,token,'/auth/student/login',{studentId:email,password})).status,200);
 assert.equal((await agent.get('/portal/profile')).status,403);
 assert.equal((await post(agent,token,'/applicant/invoices/application',{})).status,403);
 assert.equal((await post(agent,token,'/applicant/invoices/exam',{sourceId:crypto.randomUUID()})).status,403);
 const job=await db.outbox.findFirstOrThrow({where:{key:{startsWith:'verify-email:'}},orderBy:{createdAt:'desc'}});
 const link=(unseal(job.payload,config) as {link:string}).link;
 const verifyToken=new URLSearchParams(new URL(link).hash.slice(1)).get('token');
 assert.equal((await post(agent,token,'/auth/applicant/verify-email',{token:verifyToken})).status,200);
 assert.equal((await post(agent,token,'/auth/applicant/verify-email',{token:verifyToken})).status,410);
 const patch=await agent.patch('/applicant/profile').set('Origin',config.FRONTEND_ORIGIN).set('X-CSRF-Token',token).send({firstName:'Ada',lastName:'Test',phone:'+2348000000011'});assert.equal(patch.status,200);
 const fee=await db.fee.create({data:{name:'Application fee',purpose:'REGISTRATION',amountMinor:1500000n,currency:'NGN'}});
 await db.setting.upsert({where:{key:'applicationFeePolicy'},create:{key:'applicationFeePolicy',value:{feeId:fee.id}},update:{value:{feeId:fee.id}}});
 assert.equal((await post(agent,token,'/applicant/invoices/application',{amountMinor:'1'})).status,400);
 const created=await post(agent,token,'/applicant/invoices/application',{});assert.equal(created.status,201);assert.equal(created.body.amountMinor,'1500000');
 const again=await post(agent,token,'/applicant/invoices/application',{});assert.equal(again.body.id,created.body.id);
 const stranger=request.agent(app),strangerCsrf=await csrf(stranger);
 assert.equal((await post(stranger,strangerCsrf,'/auth/student/login',{studentId:email,password})).status,200);
 const other=await db.user.create({data:{email:random().slice(0,12)+'@example.test',phone:'',role:'APPLICANT',passwordHash:await argon2.hash(password),mustChangePassword:false}});
 const foreign=await db.invoice.create({data:{userId:other.id,reference:random(),sourceKey:random(),kind:'APPLICATION',amountMinor:1n,currency:'NGN'}});
 assert.equal((await agent.get('/applicant/invoices/'+foreign.id)).status,404);
 const paymentResponse=await post(agent,token,'/applicant/invoices/'+created.body.id+'/payment',{});assert.equal(paymentResponse.status,201);
 const pay=await db.payment.findUniqueOrThrow({where:{reference:paymentResponse.body.payment.reference}});
 assert.equal(pay.payerUserId,user.id);assert.equal(pay.studentId,null);
 const results=await Promise.all(Array.from({length:3},()=>settlePayment(db,config,pay.reference,verified(pay))));
 assert.equal(new Set(results.map(p=>p.studentId)).size,1);
 const promoted=await db.user.findUniqueOrThrow({where:{id:user.id},include:{student:true,applicant:true}});
 assert.equal(promoted.role,'STUDENT');assert.equal(promoted.passwordHash,user.passwordHash);assert.ok(promoted.applicant!.applicationFeeVerifiedAt);
 const welcomeJobs=await db.outbox.findMany({where:{key:'student-id-issued:'+user.id}});assert.equal(welcomeJobs.length,1);
 const welcome=unseal(welcomeJobs[0].payload,config) as any;assert.equal(welcome.template,'student-ready');assert.equal(welcome.studentId,promoted.student!.studentId);assert.equal(welcome.link,config.FRONTEND_ORIGIN+'/student/login');assert.ok(!JSON.stringify(welcome).includes(password));

 assert.equal(await db.student.count({where:{userId:user.id}}),1);assert.equal(await db.receipt.count({where:{paymentId:pay.id}}),1);
 assert.equal((await db.invoice.findUniqueOrThrow({where:{id:created.body.id}})).status,'PAID');
 for(const identifier of[email,promoted.student!.studentId]){const a=request.agent(app),c=await csrf(a);assert.equal((await post(a,c,'/auth/student/login',{studentId:identifier,password})).status,200);assert.equal((await a.get('/portal/profile')).status,200);}
});

test('Phase 2 migration previews without writes and applies repeatably',async()=>{
 const {migratePhase2}=await import('../src/phase2-migration.js');
 const before=await db.schemaMigration.count();const dry=await migratePhase2(url);assert.equal(dry.mode,'dry-run');assert.equal(await db.schemaMigration.count(),before);
 await migratePhase2(url,true);const count=await db.schemaMigration.count();await migratePhase2(url,true);assert.equal(await db.schemaMigration.count(),count);
 const {assertPhase2Ready}=await import('../src/database.js');
 await assertPhase2Ready(db);
 const marker=await db.schemaMigration.findUniqueOrThrow({where:{key:'platform-phase-2-v1'}});
 assert.ok(marker.result);
 await db.$runCommandRaw({update:'SchemaMigration',updates:[{q:{_id:'platform-phase-2-v1'},u:{$unset:{result:''},$set:{resultJson:{usersBackfilled:2}}}}]});
 await migratePhase2(url,true);
 await assertPhase2Ready(db);
 const repaired=await db.schemaMigration.findUniqueOrThrow({where:{key:'platform-phase-2-v1'}});
 assert.deepEqual(repaired.result,{usersBackfilled:2});
 assert.equal(repaired.appliedAt.getTime(),marker.appliedAt.getTime());
});



test('official fee references cannot affect an exam preparation invoice and availability is enforced',async()=>{
 const {createInvoice}=await import('../src/invoices.js');const s=await student();
 const exam=await db.exam.create({data:{name:'WAEC WASSCE',body:'WAEC',description:'Preparation',feeMinor:1234500n,currency:'NGN',opensAt:new Date(Date.now()-86400000),closesAt:new Date(Date.now()+86400000),centre:'School',capacity:10}});
 await db.examEnrolment.create({data:{studentId:s.id,examId:exam.id}});
 await db.setting.create({data:{key:'trust.exam.'+exam.id,value:{offered:true,currentSession:'2026',officialFees:[{status:'PUBLISHED',amountMinor:'9999900',currency:'NGN',session:'2026',sourceUrl:'https://waecnigeria.org/',lastVerified:'2026-10-20'}]}}});
 const invoice=await createInvoice(db,s.userId,'EXAM',exam.id);assert.equal(invoice.amountMinor,1234500n);assert.match(invoice.items[0].description,/exam preparation/);assert.equal(invoice.items.length,1);
 await db.setting.update({where:{key:'trust.exam.'+exam.id},data:{value:{offered:false,currentSession:'2026',officialFees:[]}}});
 const other=await student();await db.examEnrolment.create({data:{studentId:other.id,examId:exam.id}});await assert.rejects(()=>createInvoice(db,other.userId,'EXAM',exam.id),/availability/);
});
