import {createDatabase,databaseUrl,assertDatabaseReady} from "../src/database.js";
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";
import { configuration, transaction, audit } from "../src/core.js";
import { defaultPermissions } from "../src/auth.js";
const config = configuration.parse({...process.env,DATABASE_URL:databaseUrl()});
if (!config.ADMIN_EMAIL || !config.ADMIN_INITIAL_PASSWORD)
  throw new Error(
    "ADMIN_EMAIL and ADMIN_INITIAL_PASSWORD are required. No default credentials exist.",
  );
const db = createDatabase();
try {
  await assertDatabaseReady(db);
  const email = config.ADMIN_EMAIL.toLowerCase();
  const passwordHash = await argon2.hash(config.ADMIN_INITIAL_PASSWORD, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
  });
  await transaction(db, async (tx) => {
    for (const [role, permissions] of Object.entries(defaultPermissions))
      await tx.rolePermission.upsert({
        where: { role: role as any },
        update: {},
        create: { role: role as any, permissions },
      });
    const existing = await tx.user.findUnique({
      where: { email },
      include: { admin: true },
    });
    if (existing) {
      if (
        existing.role !== "ADMIN" ||
        existing.admin?.roleType !== "SUPER_ADMIN" ||
        existing.status !== "ACTIVE"
      )
        throw new Error(
          "Seed email is already assigned to an account that is not an active owner. Use the existing owner recovery process.",
        );
      return;
    }
    const owner = await tx.user.create({
      data: {
        email,
        phone: "",
        passwordHash,
        role: "ADMIN",
        mustChangePassword: true,
        admin: {
          create: {
            name: "Owner",
            roleType: "SUPER_ADMIN",
            permissions: defaultPermissions.SUPER_ADMIN,
          },
        },
      },
    });
    await audit(tx, owner.id, "OWNER_SEEDED", "User", owner.id, "seed");
    await tx.setting.upsert({
      where: { key: "studentIds" },
      update: {},
      create: {
        key: "studentIds",
        value: {
          prefix: config.STUDENT_ID_PREFIX,
          startingNumber: config.STUDENT_ID_START,
        },
      },
    });
  });
  console.log(
    "Owner seed complete. Existing credentials were not changed. Change the initial password and enrol TOTP at first login.",
  );
} finally {
  await db.$disconnect();
}
