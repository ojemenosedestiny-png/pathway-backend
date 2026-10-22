import {imageTypes,processImageUpload} from './image-upload.js';
import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { z } from "zod";
import { audienceWhere } from "./portal.js";
import {
  type Config,
  wrap,
  parse,
  idSchema,
  fail,
  random,
  transaction,
  queue,
  audit,
} from "./core.js";
export function storage(config: Config) {
  if (!config.S3_BUCKET || !config.S3_ACCESS_KEY || !config.S3_SECRET_KEY)
    fail(503, "STORAGE_UNCONFIGURED", "File storage is unavailable.");
  if(config.S3_REGION==='auto'&&!config.S3_ENDPOINT)
    fail(503,"STORAGE_UNCONFIGURED","Cloudflare R2 endpoint is missing. Set S3_ENDPOINT on the backend service before uploading.");
  return new S3Client({
    region: config.S3_REGION,
    endpoint: config.S3_ENDPOINT,
    forcePathStyle: !!config.S3_ENDPOINT,
    // The browser supplies the body later; do not sign a checksum of an empty body.
    requestChecksumCalculation: 'WHEN_REQUIRED',

    credentials: {
      accessKeyId: config.S3_ACCESS_KEY,
      secretAccessKey: config.S3_SECRET_KEY,
    },
  });
}
export function fileRouter(db: PrismaClient, config: Config) {
  const r = Router();
  r.post(
    "/upload-url",
    wrap(async (req, res) => {
      const d = parse(
        z
          .object({
            filename: z
              .string()
              .min(1)
              .max(150)
              .regex(/^[\w .()-]+$/),
            mime: z.enum(["application/pdf", "image/jpeg", "image/png", "image/webp"]),
            size: z
              .number()
              .int()
              .min(1)
              .max(50 * 1024 * 1024),
            type: z.enum(["PASSPORT", "RESULT", "IDENTITY", "OTHER", "MEDIA"]),
            public: z.boolean().default(false),
            ownerId: idSchema.optional(),
          })
          .strict(),
        req.body,
      );
      const p = req.principal!;
      const video = d.mime.startsWith("video/");
      if (video && (!d.public || d.type !== "MEDIA"))
        fail(422, "MEDIA_ONLY", "Videos must be uploaded as public school media.");
      if (!video && d.size > 10 * 1024 * 1024)
        fail(422, "FILE_TOO_LARGE", "Images and documents must be 10 MB or smaller.");
      if (
        d.public &&
        (p.role !== "ADMIN" ||
          (p.adminRole !== "SUPER_ADMIN" &&
            !p.permissions.write.includes("media")))
      )
        fail(403, "FORBIDDEN", "Public media requires content permissions.");
      if(d.public&&!imageTypes.includes(d.mime))fail(422,"PUBLIC_IMAGE_ONLY","Public media must be a JPG, PNG or WebP image. Upload PDFs as private documents.");
      const { ownerId, ...fields } = d;
      if (ownerId && ownerId !== p.id) {
        if (
          p.role !== "ADMIN" ||
          (p.adminRole !== "SUPER_ADMIN" &&
            !p.permissions.write.includes("documents") &&
            !p.permissions.write.includes("enrolments"))
        )
          fail(403, "FORBIDDEN", "Document management permission required.");
        if (!(await db.student.findUnique({ where: { userId: ownerId } })))
          fail(422, "STUDENT_REQUIRED", "Target owner must be a student.");
      }
      const missing=[config.S3_REGION==='auto'&&!config.S3_ENDPOINT&&'S3_ENDPOINT',!config.S3_BUCKET&&'S3_BUCKET',!config.S3_ACCESS_KEY&&'S3_ACCESS_KEY',!config.S3_SECRET_KEY&&'S3_SECRET_KEY',d.public&&!config.PUBLIC_MEDIA_BASE&&'PUBLIC_MEDIA_BASE'].filter(Boolean);
      if(missing.length)fail(503,"STORAGE_UNCONFIGURED",p.role==='ADMIN'?'Uploads are not configured on the backend Render service. Missing settings: '+missing.join(', ')+'. Configure storage, then redeploy.':'Photo and document uploads are temporarily unavailable. Please contact the school to complete upload setup. Your account is unaffected.');
      storage(config);
      const file = await transaction(db, async (tx) => {
        const item = await tx.document.create({
          data: {
            ...fields,
            ownerId: ownerId || p.id,
            fileKey: "quarantine/" + random(),
          },
        });
        if (p.role === "ADMIN")
          await audit(
            tx,
            p.id,
            "FILE_UPLOAD_CREATED",
            "Document",
            item.id,
            req.ip || "",
            undefined,
            { ownerId: item.ownerId, type: item.type, public: item.public },
          );
        return item;
      });
      const url = await getSignedUrl(
        storage(config),
        new PutObjectCommand({
          Bucket: config.S3_BUCKET,
          Key: file.fileKey,
          ContentType: d.mime,
          ContentLength: d.size,
        }),
        { expiresIn: 300 },
      );
      res.status(201).json({
        id: file.id,
        uploadUrl: url,
        expiresIn: 300,
        headers: { "Content-Type": d.mime },
      });
    }),
  );
  r.get("/:id/status", wrap(async (req, res) => {
    const f = await db.document.findUnique({ where: { id: parse(idSchema, req.params.id) } });
    const p = req.principal!;
    const mediaAccess = p.role === "ADMIN" && (p.adminRole === "SUPER_ADMIN" || p.permissions.read.includes("media") || p.permissions.write.includes("media"));
    if (!f || (f.ownerId !== p.id && !(mediaAccess && f.public))) fail(404, "NOT_FOUND", "File unavailable.");
    const url = f.public && f.status === "APPROVED" && f.fileKey.startsWith("public/") && config.PUBLIC_MEDIA_BASE
      ? config.PUBLIC_MEDIA_BASE.replace(/\/$/, "") + "/" + f.fileKey : null;
    res.json({ id: f.id, filename: f.filename, mime: f.mime, status: f.status, url });
  }));
  r.post(
    "/:id/complete",
    wrap(async (req, res) => {
      parse(z.object({}).strict(), req.body);
      const f = await db.document.findFirst({
        where: {
          id: parse(idSchema, req.params.id),
          OR: [
            { ownerId: req.principal!.id },
            ...(req.principal!.role === "ADMIN" &&
            (req.principal!.adminRole === "SUPER_ADMIN" ||
              req.principal!.permissions.write.includes("documents") ||
              req.principal!.permissions.write.includes("enrolments"))
              ? [{}]
              : []),
          ],
        },
      });
      if (!f) fail(404, "NOT_FOUND", "File not found.");
      if(f.status!=="UPLOADING"){
        if(f.status==='SCANNING')await processImageUpload(db,storage(config),config.S3_BUCKET!,f);
        const current=await db.document.findUniqueOrThrow({where:{id:f.id}});res.status(202).json({id:f.id,status:current.status});return;
      }
      const head = await storage(config).send(
        new HeadObjectCommand({ Bucket: config.S3_BUCKET, Key: f.fileKey }),
      );
      if (head.ContentLength !== f.size || head.ContentType !== f.mime)
        fail(422, "FILE_MISMATCH", "Uploaded size or content type differs.");
      await transaction(db, async (tx) => {
        const changed = await tx.document.updateMany({
          where: { id: f.id, status: "UPLOADING" },
          data: { status: "SCANNING" },
        });
        if (changed.count)
          await queue(tx, config, "scan:" + f.id, "SCAN", { id: f.id });
        if (changed.count && req.principal!.role === "ADMIN")
          await audit(
            tx,
            req.principal!.id,
            "FILE_SCAN_QUEUED",
            "Document",
            f.id,
            req.ip || "",
          );
      });
      await processImageUpload(db,storage(config),config.S3_BUCKET!,{...f,status:'SCANNING'});
      const processed=await db.document.findUniqueOrThrow({where:{id:f.id}});
      res.status(202).json({ id: f.id, status: processed.status });
    }),
  );
  r.get(
    "/:id/download-url",
    wrap(async (req, res) => {
      const f = await db.document.findUnique({
        where: { id: parse(idSchema, req.params.id) },
      });
      const p = req.principal!;
      let permitted =
        !!f &&
        (f.ownerId === p.id ||
          (p.role === "ADMIN" &&
            (p.adminRole === "SUPER_ADMIN" ||
              p.permissions.read.includes("documents") ||
              (p.permissions.read.includes("payments") && f.type === "BANK_PROOF") ||
              (p.permissions.read.includes("media") && f.public))));
      if (f && !permitted && p.studentId) {
        const student = await db.student.findUniqueOrThrow({
          where: { id: p.studentId },
          include: { enrolments: true },
        });
        permitted = !!(await db.announcement.findFirst({
          where: {
            ...audienceWhere(student),
            attachmentIds: { has: f.id },
          },
        }));
      }
      if (!f || !permitted) fail(404, "NOT_FOUND", "File unavailable.");
      if (!["PENDING", "APPROVED", "REJECTED"].includes(f.status))
        fail(409, "FILE_UNAVAILABLE", "File has not passed security scanning.");
      await db.auditLog.create({
        data: {
          actorId: p.id,
          action: "FILE_DOWNLOAD",
          entity: "Document",
          entityId: f.id,
          ip: req.ip || "",
        },
      });
      res.json({
        url: await getSignedUrl(
          storage(config),
          new GetObjectCommand({
            Bucket: config.S3_BUCKET,
            Key: f.fileKey,
            ResponseContentDisposition:
              'attachment; filename="' + f.filename + '"',
          }),
          { expiresIn: 60 },
        ),
        expiresIn: 60,
      });
    }),
  );
  return r;
}
export { GetObjectCommand, DeleteObjectCommand };
