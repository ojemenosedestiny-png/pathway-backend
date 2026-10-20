# Phase 1 — platform audit

20 Oct 2026. Branch: `platform-phase-1`, based on production commit `f6c824d`.

The owner confirmed **MongoDB Atlas remains the database**, with Prisma. PostgreSQL in the supplied brief is superseded by that explicit choice. Future schema changes require repeatable MongoDB backfills/index provisioning, not SQL migrations.

No runtime, authentication, schema, API, bank-account or production-data changes are included in this phase. Stop for owner review before Phase 2.

Baseline: Prisma generation and TypeScript build passed; `npm test` passed 23 tests on a temporary localhost MongoDB replica set. Separate admissions/configuration/job-runner/storage tests passed 13 tests, with configuration/job-runner overlap. No real emails or production application records were created by these tests.

The current backend has no APPLICANT role, free signup/email-verification journey, general Invoice/InvoiceItem layer, structured timetable history or replayable SSE. Existing payment settlement, non-reusable Student IDs, private storage, staff MFA, RBAC, transactional booking guards and encrypted outbox are reusable. Current hostel holds are 15 minutes, not the requested configurable 48-hour default.

Earlier prototypes remain on `feature/catalogue-application-payments` at `cb09177`. Their guest-link entry and combined onboarding charge do not match the revised free-applicant/separate-invoice journey and are not merged here.

Full audit, protected curriculum list, route inventory, test inventory and phased acceptance plan are in the frontend repository under `docs/platform-phase-1/`. The frontend globe source and geometry are unchanged. One existing browser test reports page overflow at 320px; Phase 1 does not change the globe to conceal that baseline failure.
