import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { createDatabase, assertDatabaseReady } from "../src/database.js";
import { officialFeeSchema } from "../src/trust-content.js";
import { z } from "zod";
const rows = z
  .array(officialFeeSchema.extend({ exam: z.string().min(1) }))
  .parse(
    JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), "prisma/exam-research-draft.json"),
        "utf8",
      ),
    ),
  );
if (rows.some((row) => row.status !== "DRAFT"))
  throw Error("Seed references must remain DRAFT.");
if (process.argv.slice(2).some((arg) => arg !== "--apply"))
  throw Error("Usage: npm run seed:exam-research -- [--apply]");
if (!process.argv.includes("--apply"))
  console.log(
    JSON.stringify({
      mode: "preview",
      draftReferences: rows.length,
      publishes: 0,
      changesSchoolFees: false,
    }),
  );
else {
  const db = createDatabase();
  try {
    await assertDatabaseReady(db);
    await db.$transaction(async (tx) => {
      await tx.setting.upsert({
        where: { key: "trust.research" },
        create: { key: "trust.research", value: rows },
        update: {},
      });
      await tx.setting.upsert({
        where: { key: "trust.legal" },
        create: {
          key: "trust.legal",
          value: {
            legalName: "",
            registrationNumber: "",
            registeringBody: "",
            address: "",
          },
        },
        update: {},
      });
      await tx.setting.upsert({
        where: { key: "trust.refund" },
        create: {
          key: "trust.refund",
          value: {
            status: "DRAFT",
            items: "[to be approved by the school]",
            timeLimits: "[to be approved by the school]",
            requestProcess: "[to be approved by the school]",
          },
        },
        update: {},
      });
    });
    console.log(
      "Draft research and unpublished refund policy ready; existing owner edits preserved.",
    );
  } finally {
    await db.$disconnect();
  }
}
