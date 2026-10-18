import {createDatabase,databaseUrl,assertDatabaseReady} from "./database.js";
import { PrismaClient } from "@prisma/client";
import { runtimeConfiguration, log } from "./core.js";
import { createApp } from "./app.js";
const config = runtimeConfiguration(process.env);
if (config.NODE_ENV === "production" && config.COOKIE_SECURE !== "true")
  throw new Error("Production requires secure cookies.");
const db = createDatabase();
await db.$connect();
await assertDatabaseReady(db);
const server = createApp(db, config).listen(config.PORT, () =>
  log.info({ port: config.PORT }, "API listening"),
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.close(async () => {
    await db.$disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 15000).unref();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
