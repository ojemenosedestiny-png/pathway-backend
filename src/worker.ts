import {createDatabase,databaseUrl,assertDatabaseReady,assertPhase2Ready} from "./database.js";
import { PrismaClient } from "@prisma/client";
import { runtimeConfiguration, log } from "./core.js";
import { schedule, workOnce } from "./jobs.js";
const db = createDatabase(),
  config = runtimeConfiguration(process.env);
let stopping = false;
process.on("SIGTERM", () => (stopping = true));
process.on("SIGINT", () => (stopping = true));
await db.$connect();
await assertDatabaseReady(db);
await assertPhase2Ready(db);
while (!stopping) {
  try {
    await schedule(db, config);
    const count = await workOnce(db, config);
    if (!count) await new Promise((r) => setTimeout(r, 2000));
  } catch (e) {
    log.error(
      { type: e instanceof Error ? e.name : "Unknown" },
      "Worker iteration failed",
    );
    await new Promise((r) => setTimeout(r, 5000));
  }
}
await db.$disconnect();
