import { MongoClient } from "mongodb";
import { databaseUrl, setupMongoDatabase } from "./database.js";
export const phase2MigrationKey = "platform-phase-2-v1";
/** Read-only by default. Explicit application is additive and repeatable. */
export async function migratePhase2(url = databaseUrl(), apply = false, onlyIfNeeded = false) {
  const client = new MongoClient(url, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  try {
    const db = client.db();
    const users = db.collection("User");
    const applied = await db
      .collection("SchemaMigration")
      .findOne({ _id: phase2MigrationKey } as any);
    // Normal process restarts must not rebuild every index and scan collections.
    // Explicit migration runs retain the existing repair/backfill behavior.
    if (apply && onlyIfNeeded && applied?.result != null)
      return { mode: "apply", alreadyApplied: true, skipped: true, usersBackfilled: 0 };
    const missing = await users.countDocuments({
      emailVerifiedAt: { $exists: false },
    });
    if (!apply)
      return {
        mode: "dry-run",
        applied: !!applied,
        usersNeedingDefaults: missing,
      };
    await setupMongoDatabase(url);
    await users.updateMany(
      { emailVerifiedAt: { $exists: false } },
      { $set: { emailVerifiedAt: null } },
    );
    await db
      .collection("Payment")
      .updateMany(
        { payerUserId: { $exists: false } },
        { $set: { payerUserId: null } },
      );
    await db
      .collection("Payment")
      .updateMany(
        { invoiceId: { $exists: false } },
        { $set: { invoiceId: null } },
      );
    await db
      .collection("HostelBooking")
      .updateMany(
        { roomAmountMinor: { $exists: false } },
        { $set: { roomAmountMinor: null } },
      );
    await db
      .collection("HostelBooking")
      .updateMany(
        { depositAmountMinor: { $exists: false } },
        { $set: { depositAmountMinor: null } },
      );
    const result = { usersBackfilled: missing };
    await db
      .collection("SchemaMigration")
      .updateOne(
        { _id: phase2MigrationKey } as any,
        { $setOnInsert: { appliedAt: new Date(), result } },
        { upsert: true },
      );
    // Repair completion records written by the first release with the wrong field name.
    await db.collection("SchemaMigration").updateOne(
      { _id: phase2MigrationKey, result: null } as any,
      { $set: { result: applied?.resultJson ?? result } },
    );
    return { mode: "apply", alreadyApplied: !!applied, ...result };
  } finally {
    await client.close();
  }
}
