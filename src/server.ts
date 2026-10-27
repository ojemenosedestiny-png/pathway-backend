import {ensureAdmissionCollection} from './admissions.js';
import {ensureLearningCollection} from './learning.js';
import {ensureUkUniversities} from './catalogue-seed.js';
import {createDatabase,databaseUrl,assertDatabaseReady,assertPhase2Ready} from "./database.js";
import { PrismaClient } from "@prisma/client";
import { runtimeConfiguration, log } from "./core.js";
import { createApp } from "./app.js";
import { schedule, workOnce } from "./jobs.js";
import { startJobRunner } from "./job-runner.js";
const config = runtimeConfiguration(process.env);
if (config.NODE_ENV === "production" && config.COOKIE_SECURE !== "true")
  throw new Error("Production requires secure cookies.");
const db = createDatabase();
await db.$connect();
await assertDatabaseReady(db);
await assertPhase2Ready(db);
await ensureAdmissionCollection(db);
await ensureLearningCollection(db);
// Never block the API on catalogue content: a failure here is logged and retried on the next start.
await ensureUkUniversities(db).catch(error=>log.error({type:error instanceof Error?error.name:'Unknown'},'Catalogue destinations not added'));
const server = createApp(db, config).listen(config.PORT, () =>
  log.info({ port: config.PORT }, "API listening"),
);
const runner = config.RUN_WORKER_IN_API === "true" ? startJobRunner({
  schedule: () => schedule(db, config),
  work: () => workOnce(db, config),
  onError: error => log.error({type: error instanceof Error ? error.name : "Unknown"}, "Embedded worker iteration failed"),
}) : undefined;
if (runner) log.info("Embedded worker enabled; processing pauses when this API sleeps.");
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 30000);
  deadline.unref();
  await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), runner?.stop()]);
  await db.$disconnect();
  clearTimeout(deadline);
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
