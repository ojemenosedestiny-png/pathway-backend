import "dotenv/config";
import { z } from "zod";
import { Prisma, PrismaClient } from "@prisma/client";
import crypto from "node:crypto";
import {databaseUrl} from "./database.js";
import pino from "pino";
import type { Request, Response, NextFunction, RequestHandler } from "express";
export const configuration = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().default(4000),
  RUN_WORKER_IN_API: z.enum(["true", "false"]).default("false"),
  DATABASE_URL: z.string().min(1),
  FRONTEND_ORIGIN: z.string().url(),
  PUBLIC_API_ORIGIN: z.string().url(),
  JWT_SECRET: z.string().min(48),
  ENCRYPTION_KEY: z.string().regex(/^[a-f0-9]{64}$/i),
  COOKIE_SECURE: z.enum(["true", "false"]).default("true"),
  ADMIN_EMAIL: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().email().optional(),
  ),
  ADMIN_INITIAL_PASSWORD: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().min(12).optional(),
  ),
  STUDENT_ID_PREFIX: z
    .string()
    .regex(/^[A-Z][A-Z0-9]{1,9}$/)
    .default("PU"),
  STUDENT_ID_START: z.coerce.number().int().min(1).max(999999).default(1),
  PAYSTACK_SECRET_KEY: z.string().optional(),
  FLUTTERWAVE_SECRET_KEY: z.string().optional(),
  FLUTTERWAVE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  TERMII_API_KEY: z.string().optional(),
  TERMII_SENDER: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_GRAPH_VERSION: z
    .string()
    .regex(/^v[0-9]+\.[0-9]+$/)
    .default("v23.0"),
  WHATSAPP_NOTICE_TEMPLATE: z.string().optional(),
  WHATSAPP_LANGUAGE: z.string().default("en"),
  S3_ENDPOINT: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().url().optional(),
  ),
  S3_REGION: z.string().default("auto"),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  PUBLIC_MEDIA_BASE: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().url().optional(),
  ),
  SCANNER_URL: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().url().optional(),
  ),
  SCANNER_TOKEN: z.string().optional(),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
  // Optional: enables the staff AI assistant and mock-paper PDF import.
  OPENAI_API_KEY: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().min(20).optional(),
  ),
  OPENAI_MODEL: z.string().min(1).default("gpt-5-mini"),
});
export type Config = z.infer<typeof configuration>;
// Owner credentials are only consumed by the seed script, never by API/worker startup.
export function runtimeConfiguration(env: NodeJS.ProcessEnv): Config {
  return configuration.parse({
    ...env,
    DATABASE_URL: databaseUrl(env),
    ADMIN_EMAIL: undefined,
    ADMIN_INITIAL_PASSWORD: undefined,
  });
}
export const log = pino({
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "password",
      "passwordHash",
      "token",
      "secret",
      "code",
      "rawPayload",
      "payload",
    ],
    remove: true,
  },
});
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function fail(status: number, code: string, message: string): never {
  throw new HttpError(status, code, message);
}
export const random = () => crypto.randomBytes(32).toString("hex");
export const digest = (value: string) =>
  crypto.createHash("sha256").update(value).digest("hex");
export function equal(a: string, b: string) {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
export function seal(value: unknown, config: Config) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    Buffer.from(config.ENCRYPTION_KEY, "hex"),
    iv,
  );
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}
export function unseal<T>(value: string, config: Config): T {
  const b = Buffer.from(value, "base64");
  const cipher = crypto.createDecipheriv(
    "aes-256-gcm",
    Buffer.from(config.ENCRYPTION_KEY, "hex"),
    b.subarray(0, 12),
  );
  cipher.setAuthTag(b.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([cipher.update(b.subarray(28)), cipher.final()]).toString(),
  );
}
export async function transaction<T>(
  db: PrismaClient,
  task: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await db.$transaction(task, {
        timeout: 15000,
        maxWait: 15000,
      });
    } catch (e) {
      if (
        i < 10 &&
        e instanceof Prisma.PrismaClientKnownRequestError &&
        (e.code === "P2034" || e.code === "P2002" ||
          (e.code === "P2010" &&
            ["40001", "40P01"].includes(String(e.meta?.code))))
      ) {
        await new Promise((r) => setTimeout(r, 20 * (i + 1)));
        continue;
      }
      throw e;
    }
  }
}
export async function audit(
  tx: Prisma.TransactionClient,
  actorId: string,
  action: string,
  entity: string,
  entityId: string,
  ip: string,
  before?: unknown,
  after?: unknown,
) {
  const safe = (v: unknown) =>
    v === undefined
      ? undefined
      : JSON.parse(
          JSON.stringify(v, (_k, x) =>
            typeof x === "bigint" ? x.toString() : x,
          ),
        );
  await tx.auditLog.create({
    data: {
      actorId,
      action,
      entity,
      entityId,
      ip,
      before: safe(before),
      after: safe(after),
    },
  });
}
export async function queue(
  tx: Prisma.TransactionClient,
  config: Config,
  key: string,
  kind: string,
  payload: unknown,
) {
  await tx.outbox.upsert({
    where: { key },
    update: {},
    create: { key, kind, payload: seal(payload, config) },
  });
}
export const wrap =
  (
    fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
  ): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
export const parse = <T extends z.ZodTypeAny>(
  schema: T,
  data: unknown,
): z.infer<T> => schema.parse(data);
export const idSchema = z.string().uuid();
export const moneySchema = z
  .string()
  .regex(/^\d{1,12}$/)
  .transform(BigInt);
export const pageSchema = z.object({
  skip: z.coerce.number().int().min(0).max(100000).default(0),
  take: z.coerce.number().int().min(1).max(100).default(25),
});
export async function rate(
  db: PrismaClient,
  key: string,
  max: number,
  seconds: number,
) {
  const counter=await transaction(db,async tx=>{
    const id=digest(key),now=new Date();
    const current=await tx.rateBucket.findUnique({where:{key:id}});
    if(!current)return tx.rateBucket.create({data:{key:id,count:1,expiresAt:new Date(Date.now()+seconds*1000)}});
    return tx.rateBucket.update({where:{key:id},data:current.expiresAt<=now?{count:1,expiresAt:new Date(Date.now()+seconds*1000)}:{count:{increment:1}}});
  });
  if(counter.count>max)fail(429,'RATE_LIMIT','Too many requests. Please try again later.');
}
/**
 * In-process fixed-window limiter for the high-volume per-request API limit. It avoids a database
 * transaction on every call; security-sensitive limits (logins, resets, payments) keep using rate().
 */
export function memoryRate(max:number,seconds:number,now=()=>Date.now()){
  const buckets=new Map<string,{count:number;resetAt:number}>();let swept=now();
  return (key:string)=>{
    const time=now();
    if(time-swept>seconds*1000){for(const [k,bucket] of buckets)if(bucket.resetAt<=time)buckets.delete(k);swept=time;}
    let bucket=buckets.get(key);
    if(!bucket||bucket.resetAt<=time){bucket={count:0,resetAt:time+seconds*1000};buckets.set(key,bucket);}
    if(++bucket.count>max)fail(429,'RATE_LIMIT','Too many requests. Please try again later.');
  };
}
export function jsonSafe(value: unknown) {
  return JSON.parse(
    JSON.stringify(value, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    ),
  );
}
