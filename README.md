# Pathway backend

TypeScript/Express API, PostgreSQL/Prisma, durable PostgreSQL outbox, private S3 uploads, and mandatory administrator TOTP. This is separate from the existing SQLite preview server. The Journey frontend design and mock service files have not been changed. Follow [FRONTEND-INTEGRATION.md](FRONTEND-INTEGRATION.md) to replace the mocks.

## Local setup

Requires Node 24 and PostgreSQL 18, or Docker Compose. Copy `.env.example` to `.env`. Generate JWT_SECRET and ENCRYPTION_KEY with cryptographic randomness as described there. Set an owner email and a unique initial password of at least 12 characters. Secrets belong in your deployment secret manager; never commit `.env`.

```powershell
cd backend
npm ci
npm run generate
# Set DATABASE_URL to a development PostgreSQL database first.
npm run migrate
npm run seed
npm run build
npm start
# In another terminal:
npm run worker
```

Seed is repeatable and never resets an existing owner's password. It creates no default student or payment records. ADMIN_EMAIL and ADMIN_INITIAL_PASSWORD are seed-only settings: the API and worker ignore them at startup, while the seed script requires a valid email and a password of at least 12 characters. Configure your actual fees through the Finance module before accepting money. On first admin login: change the initial password, enrol an authenticator, verify a TOTP, and save the ten recovery codes offline. Remove ADMIN_INITIAL_PASSWORD from the running application's environment after seeding.

Docker development:

```powershell
docker compose up --build -d
docker compose run --rm api npm run seed
```

Compose starts PostgreSQL, a one-shot migration service, API, and worker. In `.env`, set POSTGRES_USER, POSTGRES_PASSWORD, and POSTGRES_DB; URL-encode password punctuation in DATABASE_URL. Compose is a local-development configuration; production needs TLS, secure cookies, managed secrets, network policies, backups, resource limits, and a separate restricted runtime database account. Do not expose PostgreSQL publicly.

API: `http://localhost:4000`; Swagger: `/docs`; machine-readable contract: `/openapi.json`; process health: `/health/live`; database readiness: `/health/ready`. `/me/*` aliases `/portal/*`.

## Verification

```powershell
npm run build
npm test
npm audit
```

Tests start an isolated embedded PostgreSQL database on a random port, apply the actual migrations, and use a test payment adapter. They do not charge cards or send real messages. Test database directories remain under `.test-pg` for diagnosis and are ignored by Git. Alternatively set TEST_DATABASE_URL to a **dedicated empty test database**; never use a live database. Windows may require permission to launch the bundled database process.

The suite covers concurrent ID allocation, exact provider invoice matching, pending/failed payments, signed webhook-to-student-to-password-to-portal flow, repeated/concurrent settlement, PDF receipts, room and consultation races, hold expiry, account lockout, CSRF, TOTP/recovery-code replay, role restrictions, rich-text sanitization, and append-only audit/ID ledgers. Provider adapters, S3, the malware scanner, email/SMS, and Docker need environment-specific staging checks before launch. Passing local tests does not certify a deployment.

## Payment operations

Amounts are integer **minor units**, serialized as strings (`"2500000"` = NGN 25,000). Never send a client amount to checkout. Use an active server Fee ID, held booking ID, or reserved exam ID. NGN supports Paystack/Flutterwave/bank; USD supports Stripe. Configure webhook URLs as `/payments/webhook/paystack`, `/flutterwave`, or `/stripe` on your public HTTPS API origin.

Signatures use the raw body; settlement always makes a separate provider verify request and compares reference, amount, currency and checkout identity. Student creation, unique counter reservation, receipt and encrypted credential outbox commit together. A repeated webhook cannot issue a second ID. The permanent reservation ledger prevents ID reuse; lowering the configured start never rewinds the counter. Years use Africa/Lagos.

The post-checkout status token is returned once. Keep it in sessionStorage for that checkout and send it in X-Payment-Token; do not put it in URLs or logs. A browser redirect is not proof of payment. Unknown existing applicant emails, expired accommodation holds, or verification mismatches stop provisioning and require reconciliation. Inspect the provider dashboard before refunding/retrying a disputed payment. Fees for students who already have an ID must use TUITION/EXAM/HOSTEL/INSTALMENT rather than a second registration.

Refund submission is audited and asynchronous. SUBMITTED means the gateway accepted a request, **not** that money has reached the customer. A non-idempotent provider request that times out remains SUBMITTING for manual gateway reconciliation; do not automatically replay it. Stripe uses provider idempotency keys. Finance must reconcile final outcomes against the gateway. Bank refunds require an actual bank transfer outside the API and an audit record.

Provider references: [Paystack webhook signatures](https://paystack.com/docs/payments/webhooks/), [Flutterwave HMAC signatures](https://developer.flutterwave.com/v4.0/docs/webhooks), [Flutterwave verify by reference](https://developer.flutterwave.com/reference/verify-transaction-with-tx_ref), [Stripe webhooks](https://docs.stripe.com/webhooks). Flutterwave is configured for the documented HMAC `flutterwave-signature`, not the legacy static `verif-hash` header.

## Uploads and delivery

Create a private bucket with public access blocked. Allow browser PUT CORS only from FRONTEND_ORIGIN and restrict the worker/IAM role to the required prefixes. Quarantine and student objects must remain private. A CDN may expose only the `public/` prefix after successful scanning. PUBLIC_MEDIA_BASE must point to that restricted prefix distribution, not an open bucket. Set a bucket lifecycle rule to remove abandoned `quarantine/` objects after one day. Approved files are written to a different key using the exact scanned bytes, so replaying an upload URL cannot overwrite an approved document. Student downloads use an authenticated 60-second signed URL; uploads expire in 5 minutes, allow PDF/JPEG/PNG and max 10 MiB, and remain unavailable until validation.

SCANNER_URL must be an authenticated internal HTTPS service that accepts raw bytes and returns JSON `{ "clean": true }` only after a genuine antivirus scan. Scanner failure never approves a file. Production scanners should enforce their own size/decompression/time limits. No scanner is fabricated or bypassed in development.

Configure Resend sender verification and Termii credentials. Email credentials contain an expiring link and ID, never a plaintext password. Outbox payloads are AES-256-GCM encrypted and cleared after delivery. Jobs retry eight times with exponential backoff, then become DEAD. Resend gets a stable idempotency key. SMS transports may deliver more than once if acknowledgement is lost; queue delivery is at least once. Monitor DEAD jobs, oldest pending age, scanner failures and SUBMITTING refunds. Do not expose encrypted/raw outbox payloads in an admin response.

WhatsApp uses Meta Cloud API approved template delivery. Configure WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_GRAPH_VERSION, WHATSAPP_NOTICE_TEMPLATE and WHATSAPP_LANGUAGE. The approved notice template must have exactly one body text parameter for the notice title. Obtain recipient consent before external broadcasts. Missing credentials or rejected templates fail visibly and enter the retry queue. See [Meta's official messaging collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api).

## Security and deployment

Deploy API and frontend on the same site (for example app.school.example and api.school.example), with HTTPS throughout and COOKIE_SECURE=true. SameSite=Lax intentionally does not support unrelated cross-site cookie embedding. Terminate TLS at a trusted proxy; set TRUST_PROXY_HOPS to its exact hop count. Restrict database traffic and use TLS in the production DATABASE_URL (`sslmode=require`, with your driver's certificate policy). Use a migration account for schema changes and a separate runtime account with only required table/sequence privileges, no schema DDL, superuser, or trigger-alter privileges. Audit and ID reservation triggers reject updates/deletes; a database superuser can bypass protections and must not be the API account.

Refresh tokens are opaque and hashed at rest; access JWTs last ten minutes. Every authenticated call checks database session revocation, account status and server permissions. Admin idle timeout is 20 minutes, absolute lifetime eight hours, sensitive finance actions require MFA within 15 minutes. Students get one day, or 30 days with rememberMe. Five wrong passwords lock for 15 minutes. Store encryption keys and backups separately and retain old keys during an intentional re-encryption migration; changing ENCRYPTION_KEY blindly loses TOTP/outbox access.

## Data protection and backups

GET `/portal/export` exports the student's own information without credentials/secrets. POST `/portal/deletion-request` records a retention review request. An authorised owner must verify the requester, document the decision and applicable retention periods, export requested records, revoke sessions/tokens, delete private objects, anonymize or remove non-required profile/messages/applications, and retain only the records required by the school's approved retention policy. Preserve the minimal Student ID reservation and audit trail. Financial receipts and backups may have different retention obligations; do not promise immediate destruction of those records. Record the completed action in the append-only audit log and communicate the outcome through the registered contact. This is an operational workflow, not an automatic legal determination.

Run `ops/backup.sh` daily at 02:00 UTC using a restricted PGPASSFILE and PGHOST/PGPORT/PGDATABASE/PGUSER environment. Send dumps to an encrypted, access-controlled backup destination separate from the database host. Schedule with `0 2 * * * /opt/pathway/backend/ops/backup.sh`; the scheduler must inject credentials and BACKUP_DIR. Retain e.g. 7 daily/4 weekly/12 monthly snapshots according to the approved policy; alert on nonzero exit and missing daily backups. For managed PostgreSQL enable automated snapshots and point-in-time recovery. Restore a recent dump into an isolated database monthly with `pg_restore --no-owner --exit-on-error --dbname=<restore-db> <dump>` and run readiness and reconciliation checks. A backup is not verified until restored.

See [API-CONTRACT.md](API-CONTRACT.md) and [FRONTEND-INTEGRATION.md](FRONTEND-INTEGRATION.md) for exact integration conventions and current deployment dependencies.
