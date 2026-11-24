import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { wrap, type Config } from "./core.js";
import { storage } from "./storage.js";

/**
 * Public school pictures (hostel carousel, university logos, room photos) are served by the backend
 * straight from storage, so they work on the site's own address and never depend on a separate media host.
 * Only files uploaded as public media and approved by the file check are served.
 */
export const mediaBase = (config: Pick<Config, "FRONTEND_ORIGIN">) => config.FRONTEND_ORIGIN.replace(/\/$/, "") + "/backend-api/media";
export const publicMediaUrl = (config: Pick<Config, "FRONTEND_ORIGIN">, fileKey: string) => mediaBase(config) + "/" + fileKey;
const keyPattern = /^public\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/file\.(webp|jpe?g|png)$/i;
export const isPublicMediaKey = (key: string) => keyPattern.test(key);

export function mediaRouter(db: PrismaClient, config: Config) {
  const r = Router();
  r.get("/public/:id/:name", wrap(async (req, res) => {
    const key = `public/${req.params.id}/${req.params.name}`;
    const notFound = () => res.status(404).set("Cache-Control", "no-store").json({ error: { code: "NOT_FOUND", message: "Picture not found." } });
    if (!isPublicMediaKey(key)) return notFound();
    const file = await db.document.findUnique({ where: { fileKey: key } });
    if (!file || !file.public || file.status !== "APPROVED") return notFound();
    let object;
    try { object = await storage(config).send(new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: key })); }
    catch (error: any) { if (error?.name === "NoSuchKey" || error?.$metadata?.httpStatusCode === 404) return notFound(); throw error; }
    res.status(200);
    res.setHeader("Content-Type", object.ContentType && object.ContentType.startsWith("image/") ? object.ContentType : file.mime);
    if (object.ContentLength) res.setHeader("Content-Length", String(object.ContentLength));
    // Each upload has its own id, so a picture at this address never changes.
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
    const body = object.Body as any;
    body.on("error", () => res.destroy());
    body.pipe(res);
  }));
  return r;
}
