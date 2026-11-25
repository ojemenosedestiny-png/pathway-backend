import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { staffSummaryRouter, lagosDayStart } from "../src/portal-home.js";

test("the school day starts at midnight in Nigeria", () => {
  assert.equal(new Date(lagosDayStart(Date.parse("2026-11-25T23:30:00Z"))).toISOString(), "2026-11-25T23:00:00.000Z");
  assert.equal(new Date(lagosDayStart(Date.parse("2026-11-25T22:30:00Z"))).toISOString(), "2026-11-24T23:00:00.000Z");
});

const now = Date.now(), iso = (h: number) => new Date(now + h * 3600e3).toISOString();
const records: Record<string, any[]> = {
  MOCK: [
    { key: "MOCK:a", data: { title: "Open", subject: "Maths", cohort: "SS3", published: true, opensAt: iso(-1), closesAt: iso(2) } },
    { key: "MOCK:b", data: { title: "Later", subject: "English", cohort: "", published: true, opensAt: iso(30), closesAt: iso(32) } },
    { key: "MOCK:c", data: { title: "Draft", subject: "Physics", published: false, opensAt: iso(-1), closesAt: iso(2) } },
    { key: "MOCK:d", data: { title: "Over", subject: "Biology", published: true, opensAt: iso(-50), closesAt: iso(-48) } },
  ],
  ATTEMPT: [{ data: { submitted: true, submittedAt: iso(0) } }, { data: { submitted: true, submittedAt: iso(-40) } }, { data: { submitted: false } }],
  FORM_SUBMISSION: [{ data: { status: "NEW" } }, { data: { status: "NEW" } }, { data: { status: "APPROVED" } }, { data: { status: "DRAFT" } }],
};
const db: any = { student: { count: async () => 212 }, portalRecord: { findMany: async ({ where }: any) => records[where.kind] || [] } };
const app = (permissions: any, adminRole = "STAFF") => express().use((req, _res, next) => { (req as any).principal = { id: "s", role: "ADMIN", adminRole, permissions }; next(); }).use("/", staffSummaryRouter(db));

test("staff home counts students, exams open now, scripts submitted today, forms awaiting review and upcoming exams", async () => {
  const body = (await request(app({ read: [], write: [] }, "SUPER_ADMIN")).get("/")).body;
  assert.equal(body.students, 212); assert.equal(body.mocksOpenNow, 1); assert.equal(body.formsAwaiting, 2);
  assert.ok(body.scriptsToday >= 1 && body.scriptsToday <= 2);
  assert.deepEqual(body.upcoming.map((m: any) => [m.title, m.open, m.cohort]), [["Open", true, "SS3"], ["Later", false, "All students"]]);
});

test("each tile is only sent to staff who may see that area", async () => {
  const body = (await request(app({ read: ["exams"], write: [] })).get("/")).body;
  assert.deepEqual(Object.keys(body).sort(), ["mocksOpenNow", "scriptsToday", "upcoming"]);
});
