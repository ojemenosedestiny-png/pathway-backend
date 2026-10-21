import { PrismaClient } from "@prisma/client";
import { fileTypeFromBuffer } from "file-type";
import { type Config, unseal, queue, transaction, fail, log } from "./core.js";
import { storage, GetObjectCommand, DeleteObjectCommand } from "./storage.js";
import { providers } from "./providers.js";
import { audienceWhere } from "./portal.js";
import { PutObjectCommand } from "@aws-sdk/client-s3";
const escape = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
async function email(config: Config, key: string, d: any) {
  if (!config.RESEND_API_KEY || !config.EMAIL_FROM)
    throw new Error("Email delivery is not configured");
  const subject =
    d.template === 'student-ready'?'Your NewworldPathway Student ID':d.template === 'verify-email'?'Verify your NewworldPathway email':d.template==='applicant-reset'?'Reset your NewworldPathway password':d.template === "credentials"
      ? "Set up your Pathway account"
      : d.title || "Pathway payment receipt";
  const html =
    d.template==='student-ready'?`<p>Your application fee has been verified. Your student portal is ready.</p><p>Your Student ID: <strong>${escape(d.studentId)}</strong></p><p><a href="${escape(d.link)}">Sign in to your student portal</a> with your email address or Student ID and the password you created when you registered.</p><p><a href="${escape(d.resetLink)}">Reset your password</a> if you have forgotten it. For your security, we never send your password by email.</p>`:d.template==='verify-email'?`<p>Verify your email to continue your free NewworldPathway applicant account.</p><p><a href="${escape(d.link)}">Verify my email</a>. This link expires in 24 hours and can be used once.</p><p>If you did not request this account, contact the school. No payment or Student ID has been issued.</p>`:d.template==='applicant-reset'?`<p><a href="${escape(d.link)}">Reset your applicant account password</a>. This link expires in ${escape(d.hours)} hours.</p>`:d.template === "credentials"
      ? `<p>Your Student ID: <strong>${escape(d.studentId || "Administrator")}</strong></p><p><a href="${escape(d.link)}">Create your password and continue</a>. This link expires in ${escape(d.hours)} hours and can be used once.</p>${d.studentId?'<p>After setting your password, sign in with your Student ID or email address to continue registration. Your account does not confirm fee payment or official exam registration.</p>':''}`
      : d.template === "recover"
        ? `<p>Your Student ID: <strong>${escape(d.studentId)}</strong></p>`
        : d.template === "receipt"
          ? `<p>Payment verified: ${escape(d.reference)}</p>${d.purpose==='EXAM'?'<p>Exam preparation payment. Official exam registration is confirmed separately.</p>':''}<p>${escape(d.currency)} ${escape((Number(d.amountMinor) / 100).toFixed(2))}</p><p>Sign in to download your receipt.</p>`
          : `<p>${escape(d.body || "You have a new update in your portal.")}</p>`;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + config.RESEND_API_KEY,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify({
      from: config.EMAIL_FROM,
      to: [d.to],
      subject,
      html,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Error("Email provider rejected delivery: " + response.status);
}
export async function schedule(db: PrismaClient, config: Config) {
  await transaction(db, async (tx) => {
    await tx.hostelBooking.updateMany({
      where: { status: "HELD", holdExpiresAt: { lt: new Date() } },
      data: { status: "EXPIRED", holdExpiresAt: null },
    });
    const posts = await tx.announcement.findMany({
      where: { status: "SCHEDULED", publishAt: { lte: new Date() } },
    });
    for (const post of posts) {
      if (post.expireAt && post.expireAt <= new Date()) {
        await tx.announcement.update({
          where: { id: post.id },
          data: { status: "ARCHIVED" },
        });
        continue;
      }
      await tx.announcement.update({
        where: { id: post.id },
        data: { status: "PUBLISHED" },
      });
      await queue(
        tx,
        config,
        `announcement:${post.id}:${post.version}`,
        "ANNOUNCEMENT",
        { id: post.id },
      );
    }
    await tx.announcement.updateMany({
      where: { status: "PUBLISHED", expireAt: { lte: new Date() } },
      data: { status: "ARCHIVED" },
    });
    await tx.rateBucket.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    await tx.outbox.updateMany({
      where: {
        status: "PROCESSING",
        lockedAt: { lt: new Date(Date.now() - 10 * 60000) },
      },
      data: { status: "PENDING", lockedAt: null },
    });
  });
}
export async function runJob(
  db: PrismaClient,
  config: Config,
  kind: string,
  key: string,
  d: any,
) {
  if (kind === "EMAIL") return email(config, key, d);
  if (kind === "SMS") {
    if (!config.TERMII_API_KEY || !config.TERMII_SENDER)
      throw new Error("SMS delivery is not configured");
    const r = await fetch("https://v3.api.termii.com/api/sms/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: config.TERMII_API_KEY,
        to: d.to,
        from: config.TERMII_SENDER,
        sms: d.body,
        type: "plain",
        channel: "generic",
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error("SMS delivery failed");
    return;
  }
  if (kind === "WHATSAPP") {
    if (
      !config.WHATSAPP_ACCESS_TOKEN ||
      !config.WHATSAPP_PHONE_NUMBER_ID ||
      !config.WHATSAPP_NOTICE_TEMPLATE
    )
      throw new Error("WhatsApp approved template is not configured");
    const response = await fetch(
      `https://graph.facebook.com/${config.WHATSAPP_GRAPH_VERSION}/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + config.WHATSAPP_ACCESS_TOKEN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: d.to.replace(/\D/g, ""),
          type: "template",
          template: {
            name: config.WHATSAPP_NOTICE_TEMPLATE,
            language: { code: config.WHATSAPP_LANGUAGE },
            components: [
              { type: "body", parameters: [{ type: "text", text: d.body }] },
            ],
          },
        }),
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok)
      throw new Error(
        "WhatsApp provider rejected template delivery: " + response.status,
      );
    return;
  }
  if (kind === "SCAN") {
    const f = await db.document.findUniqueOrThrow({ where: { id: d.id } });
    if (f.status !== "SCANNING") return;
    if (!config.SCANNER_URL || !config.SCANNER_TOKEN)
      throw new Error("Malware scanner must be configured");
    const client = storage(config);
    const object = await client.send(
      new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: f.fileKey }),
    );
    if (object.ContentLength !== f.size) {
      (object.Body as any)?.destroy?.();
      await db.document.updateMany({
        where: { id: f.id, status: "SCANNING" },
        data: {
          status: "QUARANTINED",
          rejectionReason: "Uploaded object size changed.",
        },
      });
      return;
    }
    const bytes = await object.Body!.transformToByteArray();
    const detected = await fileTypeFromBuffer(bytes);
    if (bytes.length !== f.size || detected?.mime !== f.mime) {
      await db.document.updateMany({
        where: { id: f.id, status: "SCANNING" },
        data: {
          status: "QUARANTINED",
          rejectionReason: "File content does not match declared type.",
        },
      });
      return;
    }
    const result = await fetch(config.SCANNER_URL, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + config.SCANNER_TOKEN,
        "Content-Type": "application/octet-stream",
      },
      body: Buffer.from(bytes),
      signal: AbortSignal.timeout(60000),
    });
    if (!result.ok) throw new Error("Scanner unavailable");
    const verdict = (await result.json()) as any;
    if (verdict.clean !== true) {
      await db.document.updateMany({
        where: { id: f.id, status: "SCANNING" },
        data: {
          status: "QUARANTINED",
          rejectionReason: "Security scan rejected the file.",
        },
      });
      return;
    }
    if (f.public && !config.PUBLIC_MEDIA_BASE)
      throw new Error("Public media URL is not configured");
    // Publish the exact bytes that were scanned to a different, server-only key.
    // Replaying an unexpired upload URL can only rewrite quarantine, never an approved file.
    const destination =
      (f.public ? "public/" : "private/") +
      f.id +
      "/" +
      encodeURIComponent(f.filename);
    await client.send(
      new PutObjectCommand({
        Bucket: config.S3_BUCKET,
        Key: destination,
        Body: bytes,
        ContentType: f.mime,
        ContentLength: bytes.length,
      }),
    );
    const updated = await db.document.updateMany({
      where: { id: f.id, status: "SCANNING" },
      data: { fileKey: destination, status: f.public ? "APPROVED" : "PENDING" },
    });
    if (!updated.count)
      await client.send(
        new DeleteObjectCommand({ Bucket: config.S3_BUCKET, Key: destination }),
      );
    await client.send(
      new DeleteObjectCommand({ Bucket: config.S3_BUCKET, Key: f.fileKey }),
    );
    return;
  }
  if (kind === "DELETE_FILE") {
    const f = await db.document.findUnique({ where: { id: d.id } });
    if (f?.status === "DELETION_REQUESTED") {
      await storage(config).send(
        new DeleteObjectCommand({ Bucket: config.S3_BUCKET, Key: f.fileKey }),
      );
      await db.document.updateMany({
        where: { id: f.id, status: "DELETION_REQUESTED" },
        data: { status: "DELETED" },
      });
    }
    return;
  }
  if (kind === "ANNOUNCEMENT") {
    const post = await db.announcement.findUniqueOrThrow({
      where: { id: d.id },
    });
    if (
      post.status !== "PUBLISHED" ||
      (post.expireAt && post.expireAt < new Date())
    )
      return;
    let cursor: string | undefined;
    for (;;) {
      const students = await db.student.findMany({
        take: 100,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: "asc" },
        include: { user: true, enrolments: { select: { examId: true } } },
      });
      if (!students.length) break;
      for (const student of students) {
        if (student.user.status !== "ACTIVE") continue;
        const eligible = await db.announcement.findFirst({
          where: { id: post.id, ...audienceWhere(student) },
          select: { id: true },
        });
        if (!eligible) continue;
        await transaction(db, async (tx) => {
          if (post.channels.includes("EMAIL"))
            await queue(tx, config, `${key}:email:${student.id}`, "EMAIL", {
              to: student.user.email,
              title: post.title,
              body: "A new notice is available in your student portal.",
            });
          if (post.channels.includes("WHATSAPP"))
            await queue(
              tx,
              config,
              `${key}:whatsapp:${student.id}`,
              "WHATSAPP",
              { to: student.user.phone, body: post.title },
            );
          if (post.channels.includes("SMS"))
            await queue(tx, config, `${key}:sms:${student.id}`, "SMS", {
              to: student.user.phone,
              body: post.title,
            });
          if (post.channels.some((c) => ["IN_APP", "DASHBOARD"].includes(c))) {
            const uniqueKey = `${key}:notification:${student.id}`;
            const mark = await tx.outbox.findUnique({
              where: { key: uniqueKey },
            });
            if (!mark) {
              await tx.notification.create({
                data: {
                  userId: student.userId,
                  title: post.title,
                  body: "Read the full notice in your portal.",
                },
              });
              await queue(tx, config, uniqueKey, "NOOP", {});
            }
          }
        });
      }
      cursor = students[students.length - 1].id;
    }
    return;
  }
  if (kind === "REFUND") {
    const refund = await db.refund.findUniqueOrThrow({
      where: { id: d.refundId },
      include: { payment: true },
    });
    if (refund.status !== "REQUESTED") return;
    const adapter = providers(config)[refund.payment.provider];
    if (!adapter)
      throw new Error(
        "Refund provider unavailable; bank refunds require finance reconciliation",
      );
    const claimed = await db.refund.updateMany({
      where: { id: refund.id, status: "REQUESTED" },
      data: { status: "SUBMITTING" },
    });
    if (!claimed.count) return;
    const providerReference = await adapter.refund(
      refund.payment,
      refund.id,
      refund.amountMinor,
    );
    await transaction(db, async (tx) => {
      await tx.refund.update({
        where: { id: refund.id },
        data: { status: "SUBMITTED", providerReference },
      });
      await tx.auditLog.create({
        data: {
          actorId: refund.actorId,
          action: "REFUND_SUBMITTED",
          entity: "Refund",
          entityId: refund.id,
          ip: "worker",
          after: { providerReference },
        },
      });
    });
    return;
  }
  if (kind === "PRIVACY_REQUEST") {
    log.info(
      { requestId: d.userId || d.id },
      "Privacy request awaits authorised retention review",
    );
    return;
  }
  if (kind !== "NOOP") throw new Error("Unsupported job type");
}
export async function workOnce(db: PrismaClient, config: Config) {
  const job=await transaction(db,async tx=>{
    const next=await tx.outbox.findFirst({where:{status:'PENDING',runAt:{lte:new Date()}},orderBy:[{createdAt:'asc'},{id:'asc'}]});
    if(!next)return null;
    const claimed=await tx.outbox.updateMany({where:{id:next.id,status:'PENDING'},data:{status:'PROCESSING',lockedAt:new Date(),attempts:{increment:1}}});
    return claimed.count?tx.outbox.findUniqueOrThrow({where:{id:next.id}}):null;
  });
  const jobs=job?[job]:[];
  for (const job of jobs) {
    try {
      await runJob(db, config, job.kind, job.key, unseal(job.payload, config));
      await db.outbox.update({
        where: { id: job.id },
        data: { status: "DONE", lockedAt: null, payload: "" },
      });
    } catch (error) {
      const dead = job.attempts >= 8;
      await db.outbox.update({
        where: { id: job.id },
        data: {
          status: dead ? "DEAD" : "PENDING",
          lockedAt: null,
          runAt: new Date(
            Date.now() + Math.min(3600, 2 ** job.attempts * 15) * 1000,
          ),
          lastError:
            error instanceof Error
              ? error.message.slice(0, 200)
              : "Delivery failed",
        },
      });
      log.warn({ jobId: job.id, kind: job.kind, dead }, "Job failed");
    }
  }
  return jobs.length;
}
