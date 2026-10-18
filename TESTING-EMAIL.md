# Test email delivery without a separate worker service

Set `RUN_WORKER_IN_API=true` on the Render **backend API** service, then save and
deploy. With this setting enabled the API processes the existing encrypted MongoDB
outbox serially, using the same provider calls, retry policy and idempotency keys as
the standalone worker. Startup logs say `Embedded worker enabled; processing pauses
when this API sleeps.` No new public queue-processing route is exposed.

Keep RESEND_API_KEY and EMAIL_FROM on the backend service. Keep FRONTEND_ORIGIN set
to the real frontend HTTPS origin so activation links open the public website.
The test sender onboarding@resend.dev is restricted to the registered Resend account
recipient; verify your own sending domain before emailing arbitrary students.

The free API can sleep and email processing pauses with it. On wake, queued PENDING
jobs resume; retry deadlines and attempts are stored in MongoDB. Failed jobs retry
up to eight attempts, then become DEAD. Enabling a runner does not requeue DEAD jobs
or revive expired password tokens. Resend acceptance is not proof of inbox delivery.
Do not place passwords or setup-link tokens in logs or return them from admin APIs.

Only manually create a test student after an explicit owner action with a recorded
payment-exception reason; the normal flow still requires verified payment. Use your
registered Resend recipient for the first test. Check the Resend dashboard, inbox and
spam folder, then follow the 24-hour single-use setup link. Existing demo accounts
are not MongoDB student accounts.

When moving to a dedicated worker, set RUN_WORKER_IN_API=false on the API and deploy
the standalone worker with the same MongoDB URI and encryption key. Do not change
the encryption key as part of that move. Queue claims are transactional, but only
run the intended number of workers to control load.

Checks: `npm run build` and `node --import tsx --test test/configuration.test.ts
test/job-runner.test.ts`. Runner tests use in-memory test callbacks and do not send
emails or touch production data.
