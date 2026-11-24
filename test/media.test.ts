import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { mediaRouter, isPublicMediaKey, publicMediaUrl } from "../src/media.js";
import { checkRoomPhotos } from "../src/admin.js";

const ID = "81892d7d-e402-4541-aed9-6018b56ad2c2";
test("public pictures get an address on the site itself", () => {
  assert.equal(publicMediaUrl({ FRONTEND_ORIGIN: "https://newworldpathwayuniversity.com/" }, `public/${ID}/file.webp`), `https://newworldpathwayuniversity.com/backend-api/media/public/${ID}/file.webp`);
  assert.equal(isPublicMediaKey(`public/${ID}/file.webp`), true);
  for (const bad of [`private/${ID}/file.webp`, `public/${ID}/file.pdf`, `public/../private/${ID}/file.webp`, `public/not-an-id/file.webp`]) assert.equal(isPublicMediaKey(bad), false, bad);
});

test("room photos may use the new address or the older media address, never other websites", () => {
  const config = { PUBLIC_MEDIA_BASE: "https://media.example.org", FRONTEND_ORIGIN: "https://newworldpathwayuniversity.com" };
  assert.doesNotThrow(() => checkRoomPhotos([`https://newworldpathwayuniversity.com/backend-api/media/public/${ID}/file.webp`, "https://media.example.org/public/a/file.webp"], config));
  assert.throws(() => checkRoomPhotos(["https://newworldpathwayuniversity.com/backend-api/media/private/x/file.webp"], config), (e: any) => e.code === "ROOM_PHOTO_SOURCE");
  assert.throws(() => checkRoomPhotos(["https://www.pinterest.com/pin/1/"], config), (e: any) => e.code === "ROOM_PHOTO_SOURCE");
});

test("only approved public pictures are served; private, unapproved or unknown files are not found", async () => {
  const docs: Record<string, any> = {
    [`public/${ID}/file.webp`]: { public: true, status: "PENDING", mime: "image/webp" },
    [`public/11111111-1111-4111-8111-111111111111/file.webp`]: { public: false, status: "APPROVED", mime: "image/webp" },
  };
  const db: any = { document: { findUnique: async ({ where }: any) => docs[where.fileKey] ?? null } };
  const app = express().use("/media", mediaRouter(db, {} as any));
  for (const path of [`/media/public/${ID}/file.webp`, "/media/public/11111111-1111-4111-8111-111111111111/file.webp", "/media/public/22222222-2222-4222-8222-222222222222/file.webp", `/media/public/${ID}/file.svg`]) {
    const res = await request(app).get(path);
    assert.equal(res.status, 404, path); assert.equal(res.headers["cache-control"], "no-store");
  }
});
