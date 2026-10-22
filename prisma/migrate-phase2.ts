import "dotenv/config";
import { migratePhase2 } from "../src/phase2-migration.js";
if (process.argv.slice(2).some((arg) => !["--apply", "--if-needed"].includes(arg)))
  throw Error("Usage: npm run migrate:phase2 -- [--apply] [--if-needed]");
console.log(
  JSON.stringify(
    await migratePhase2(undefined, process.argv.includes("--apply"), process.argv.includes("--if-needed")),
  ),
);
