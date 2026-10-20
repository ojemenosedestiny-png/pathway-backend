# Website trust controls and draft examination research

Review branch: website-trust-review. This release inherits the pending Phase 2 migration; do not deploy it before following PHASE-2.md. New metadata uses the existing Setting collection, so no additional destructive schema migration is needed.

After backup and staged migration/release, preview `npm run seed:exam-research`. It validates 12 DRAFT references locally and does not connect to a database. Explicit `npm run seed:exam-research -- --apply` inserts the research collection, blank legal details and the unpublished refund draft without overwriting existing owner edits. No school preparation fee, invoice amount or charge is seeded. No seed was applied to production during development.

Owner controls (content permission) are under `/admin/trust`: legal, refund, research, exams/:id, exams/:id/import-research and media/:id. Public endpoints `/public/legal` and `/public/preparation` omit blank legal fields, private media records, refund drafts and unpublished fee references. References are separate from Exam.feeMinor, which remains the owner-controlled school preparation fee used for invoices and payments. Turning Offered by us off prevents new preparation enrolment/payment creation. Existing verified payments are not undone.

An official reference records country/candidate category, amount/currency, session, coverage, source URL, last verified date, confidence and DRAFT/PUBLISHED status. Publishing incomplete references is rejected. The public response adds Needs re-check at 90 days, unknown verification date, future date or a changed/unspecified current session. Freshness warnings do not silently rewrite prices or approve official registration.

The initial official-source allowlist is WAEC Nigeria, NECO, Cambridge International and College Board (including subdomains). A newly offered exam under another body needs research and a verified official-source host before its reference is published. Offering preparation does not establish the school's centre status or logo permission. The refund editor accepts DRAFT only and has no public publication endpoint.

Tests: both builds pass; final isolated MongoDB suite passes 32 tests. Reference/role/publication tests pass, and a real invoice test proves a deliberately different reference amount does not enter the school preparation charge. Frontend browser evidence is in the companion repo docs/website-review-2026-10-20.
