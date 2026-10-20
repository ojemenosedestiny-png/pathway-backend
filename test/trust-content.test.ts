import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import {
  trustAdminRouter,
  trustPublicRouter,
  needsRecheck,
  defaultOffered,
  officialFeeSchema,
  requirePreparation,
} from "../src/trust-content.js";
const id = "00000000-0000-4000-8000-000000000001";
const fee = {
  status: "DRAFT",
  amountMinor: "3000000",
  currency: "NGN",
  session: "2026 Internal",
  category: "Nigeria / school candidate",
  coverage: "Entry",
  sourceUrl: "https://neco.gov.ng/2026%20GUIDELINES.pdf",
  lastVerified: "2026-10-20",
  confidence: "HIGH",
  notes: "",
};
function fixture(role = "ADMIN") {
  const store = new Map<string, any>();
  const exam = {
    id,
    name: "WAEC WASSCE",
    active: true,
    feeMinor: 123456n,
    currency: "NGN",
  };
  const audit: any[] = [];
  const db: any = {
    setting: {
      findUnique: async ({ where }: any) =>
        store.has(where.key)
          ? { key: where.key, value: store.get(where.key) }
          : null,
      upsert: async ({ where, create, update }: any) => {
        const value = store.has(where.key) ? update.value : create.value;
        store.set(where.key, value);
        return { key: where.key, value };
      },
    },
    exam: { findUnique: async () => exam, findMany: async () => [exam] },
    auditLog: { create: async (value: any) => audit.push(value) },
    $transaction: async (fn: any) => fn(db),
  };
  const app = express();
  app.use(express.json());
  app.set("json replacer", (_k: string, v: any) =>
    typeof v === "bigint" ? String(v) : v,
  );
  app.use((req, _res, next) => {
    req.principal = {
      id,
      role,
      adminRole: "SUPER_ADMIN",
      permissions: { read: ["*"], write: ["*"] },
    } as any;
    next();
  });
  app.use("/admin/trust", trustAdminRouter(db));
  app.use("/public", trustPublicRouter(db));
  app.use((e: any, _req: any, res: any, _next: any) =>
    res.status(e.status || 400).json({ error: e.message }),
  );
  return { app, store, exam, audit, db };
}
test("draft references stay private and cannot change the school preparation charge", async () => {
  const f = fixture();
  const policy = {
    offered: true,
    currentSession: "2026 Internal",
    officialFees: [fee],
  };
  assert.equal(
    (
      await request(f.app)
        .put("/admin/trust/exams/" + id)
        .send({ ...policy, schoolPreparationFeeMinor: "1" })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(f.app)
        .put("/admin/trust/exams/" + id)
        .send(policy)
    ).status,
    200,
  );
  assert.equal(f.exam.feeMinor, 123456n);
  assert.equal(
    (await request(f.app).get("/public/preparation")).body.exams[0].officialFees
      .length,
    0,
  );
  const published = {
    ...policy,
    officialFees: [{ ...fee, status: "PUBLISHED" }],
  };
  assert.equal(
    (
      await request(f.app)
        .put("/admin/trust/exams/" + id)
        .send(published)
    ).status,
    200,
  );
  assert.equal(
    (await request(f.app).get("/public/preparation")).body.exams[0]
      .officialFees[0].amountMinor,
    "3000000",
  );
  assert.equal(f.exam.feeMinor, 123456n);
  assert.equal(f.audit.length, 2);
});
test("unfilled legal details are hidden, refund remains draft and students cannot edit", async () => {
  const f = fixture();
  assert.deepEqual((await request(f.app).get("/public/legal")).body, {});
  await request(f.app)
    .put("/admin/trust/legal")
    .send({
      legalName: "",
      registrationNumber: "TEST",
      registeringBody: "",
      address: "",
    });
  assert.deepEqual((await request(f.app).get("/public/legal")).body, {
    registrationNumber: "TEST",
  });
  assert.equal(
    (
      await request(f.app)
        .put("/admin/trust/refund")
        .send({
          status: "PUBLISHED",
          items: "x",
          timeLimits: "x",
          requestProcess: "x",
        })
    ).status,
    400,
  );
  assert.equal((await request(f.app).get("/public/refund")).status, 404);
  assert.equal(
    (await request(fixture("STUDENT").app).get("/admin/trust/legal")).status,
    403,
  );
});
test("references need re-check at 90 days or session change; invalid sources cannot be published", () => {
  const now = new Date("2026-10-20T00:00:00Z");
  assert.equal(
    needsRecheck({ lastVerified: "2026-07-23", session: "S" }, "S", now),
    false,
  );
  assert.equal(
    needsRecheck({ lastVerified: "2026-07-22", session: "S" }, "S", now),
    true,
  );
  assert.equal(
    needsRecheck({ lastVerified: "2026-10-20", session: "old" }, "new", now),
    true,
  );
  assert.equal(
    needsRecheck({ lastVerified: null, session: "S" }, "S", now),
    true,
  );
  assert.equal(
    officialFeeSchema.safeParse({
      ...fee,
      sourceUrl: "https://neco.gov.ng.attacker.test/fee",
    }).success,
    false,
  );
  assert.equal(
    officialFeeSchema.safeParse({ ...fee, lastVerified: "2026-02-30" }).success,
    false,
  );
});
test("offered toggle is enforced and unrelated examinations default to enquiry", async () => {
  for (const name of [
    "WAEC WASSCE",
    "NECO SSCE",
    "Cambridge Checkpoint",
    "Cambridge IGCSE",
    "Cambridge AS Level",
    "Cambridge A Level",
    "BECE",
    "SAT",
    "HMB (Pre-Degree)",
  ])
    assert.ok(defaultOffered(name), name);
  assert.equal(defaultOffered("MCAT"), false);
  const f = fixture();
  f.store.set("trust.exam." + id, {
    offered: false,
    currentSession: "",
    officialFees: [],
  });
  await assert.rejects(() => requirePreparation(f.db, f.exam));
});
