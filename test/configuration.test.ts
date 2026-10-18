import { test } from "node:test";
import assert from "node:assert/strict";
import { configuration, runtimeConfiguration, random } from "../src/core.js";
const env = {
  DATABASE_URL: "mongodb://localhost/test",
  FRONTEND_ORIGIN: "http://localhost:3000",
  PUBLIC_API_ORIGIN: "http://localhost:4000",
  JWT_SECRET: random(),
  ENCRYPTION_KEY: random(),
  ADMIN_EMAIL: "owner@example.test",
  ADMIN_INITIAL_PASSWORD: "short",
};
test("runtime ignores seed-only credentials; seed still enforces password requirements", () => {
  const config = runtimeConfiguration(env);
  assert.equal(config.ADMIN_INITIAL_PASSWORD, undefined);
  assert.equal(config.ADMIN_EMAIL, undefined);
  assert.equal(env.ADMIN_INITIAL_PASSWORD, "short");
  assert.equal(configuration.safeParse(env).success, false);
  assert.equal(
    configuration.safeParse({ ...env, ADMIN_INITIAL_PASSWORD: random() })
      .success,
    true,
  );
});
test("runtime continues to validate required security secrets", () => {
  assert.throws(() => runtimeConfiguration({ ...env, JWT_SECRET: "" }));
  assert.throws(() => runtimeConfiguration({ ...env, ENCRYPTION_KEY: "" }));
});
