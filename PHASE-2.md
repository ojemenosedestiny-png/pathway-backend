# Phase 2 review: applicant accounts and invoices

This branch retains MongoDB Atlas. It is not deployed to production.

New API modules: `src/applicants.ts` (free signup, verification and owned profile) and `src/invoices.ts` (server-priced invoice snapshots and bank-payment foundations). Application-fee confirmation promotes the existing applicant account atomically; it keeps the password and issues one Student ID and receipt. New `EXAMS_OFFICER` permissions exclude finance and owner settings.

Before starting the API or worker for this release, back up the intended database and preview `npm run migrate:phase2`. After reviewing staging, explicitly apply with `npm run migrate:phase2 -- --apply`. The default command is read-only. The additive migration creates collections and unique indexes, fills missing optional fields and records its completion. Existing IDs, passwords, payment amounts and booking totals are preserved. Do not run Prisma database reset or use production data for tests.

Configure a published application fee with owner-only GET/PUT `/admin/application-fee-policy` (`feeId` references an active REGISTRATION fee). Existing invoices keep their snapshots after policy changes. Existing email/outbox worker settings still apply. No new credentials are needed.

The bank-proof upload/review experience is Phase 3, and the complete application form is Phase 4. No production deployment is included in this phase.

Validation: the isolated MongoDB suite passed 25 tests, including applicant signup, email verification and token replay rejection, ownership, forged-amount rejection, concurrent promotion, one receipt, unchanged password and email/ID login, and migration preview/repeat application. An additional invoice-math/Exams Officer permissions test passed separately. Frontend fixture journeys and screenshots are documented in the companion frontend repository under `docs/platform-phase-2`.
