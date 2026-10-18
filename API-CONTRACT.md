# API contract v1

Base URL is PUBLIC_API_ORIGIN. JSON UTF-8; dates are UTC ISO 8601; database IDs are UUIDs. Student.studentId (`PU-2026-000123`) is the public login ID, while Student.id is the UUID used by relationships/admin routes. All BigInt money values serialize as integer minor-unit **strings**. No float or client-submitted checkout amount is accepted.

Lists return arrays, with `?skip=0&take=25` (take 1–100). Follow with incremented skip until fewer than take rows return. Unknown mutation fields are rejected. A missing optional field preserves its value on PATCH; nullable date fields accept null where Swagger indicates it. Server-generated id, status, dates, actor, version and credentials must not be sent in generic CRUD bodies.

Errors: `{ "error": { "code": "VALIDATION", "message": "..." } }`. Codes distinguish 400 invalid input, 401 authentication/code failure, 403 permission/CSRF, 404 absent/inaccessible record, 409 state/booking/uniqueness conflict, 410 used/expired password link, 422 business validation, 429 rate limit, 503 unavailable configured dependency. All responses have X-Request-ID. Do not assume a browser redirect or a 2xx initialization response means payment success.

## Browser security handshake

1. `GET /auth/csrf` with `credentials: 'include'` returns `{csrfToken}` and a cookie.
2. Send `X-CSRF-Token: <csrfToken>` and `Content-Type: application/json` on every POST/PATCH/PUT/DELETE, including unauthenticated login/reset/payment requests. Browser Origin must exactly match FRONTEND_ORIGIN. The CSRF cookie is httpOnly; obtain the token from the response, not document.cookie.
3. Login sets httpOnly `access` and `refresh` cookies. Never copy these into localStorage. One refresh request at a time per tab; retry a failed API request only after a successful refresh, and never blindly repeat a financial mutation.
4. Payment webhooks bypass browser CSRF and require a valid gateway signature on the original raw bytes.

## Authentication

| Method + route                       | Request                                    | Successful response / behavior                                                                                 |
| ------------------------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| GET /auth/csrf                       | none                                       | `{csrfToken}`                                                                                                  |
| POST /auth/student/login             | `{studentId,password,rememberMe?:boolean}` | `{student:{id,studentId,name}}`; cookies                                                                       |
| POST /auth/admin/login               | `{email,password}`                         | `{challenge,mfaRequired:true,requiresPasswordChange,requiresTwoFactorSetup}`; no authenticated cookie yet      |
| POST /auth/admin/onboarding/password | `{challenge,newPassword}`                  | `{changed:true}`; forced one-time initial change                                                               |
| POST /auth/admin/2fa/setup           | `{challenge}`                              | `{secret,otpauthUrl}`; render QR locally, never log it                                                         |
| POST /auth/admin/2fa/verify          | `{challenge,code}`                         | `{authenticated:true,backupCodes?:string[]}`; cookies; ten backup codes only on initial enrolment              |
| POST /auth/set-password              | `{token,password}`                         | `{passwordSet:true}`; token consumed and all sessions revoked                                                  |
| POST /auth/student/forgot-password   | `{email}`                                  | 202 `{message}` generic acknowledgement                                                                        |
| POST /auth/student/recover-id        | `{email,phone? ,paymentReference?}`        | 202 `{message}`; email sent only with matching corroborating evidence                                          |
| POST /auth/refresh                   | `{}` plus refresh cookie                   | `{refreshed:true}`; refresh/access rotated                                                                     |
| GET /auth/session                    | access cookie                              | `{id,role,studentId?,adminRole?,permissions:{read,write},sessionId,mfaAt?}`; `studentId` here is internal UUID |
| POST /auth/logout                    | `{}`                                       | `{loggedOut:true}`; current session removed                                                                    |
| POST /auth/logout-all                | `{}`                                       | `{loggedOut:true}`; session version incremented, every device revoked                                          |

Passwords: 12–128 characters. Set-password links expire in 24 hours, reset links in one hour. Link token is in the URL **fragment**, not query. Challenges are random 64-character values expiring in ten minutes; maximum five wrong MFA codes per challenge. TOTP steps and backup codes cannot be replayed. A successful password setup fulfills the initial password-change requirement; there is no emailed temporary password.

## Payments

```json
POST /payments/initialize
Idempotency-Key: "a UUID generated for this checkout attempt"
{
  "provider":"PAYSTACK",
  "feeId":"server-fee-uuid",
  "applicant":{"name":"Applicant Name","email":"applicant@example.com","phone":"+2348000000000"}
}
```

Choose **exactly one** of feeId, bookingId, examId; optional coupon. Applicant is required before registration, otherwise the logged-in student's server profile supplies payer identity. Fee IDs use server Fee records. Exam fees require a PENDING enrolment inside its registration window. Hostel payments require an unexpired own bed hold.

201 response:

```json
{
  "payment": {
    "reference": "PAY-...",
    "status": "PENDING",
    "amountMinor": "2500000",
    "currency": "NGN"
  },
  "checkoutUrl": "https://gateway.example/...",
  "statusToken": "random-secret"
}
```

BANK has null checkoutUrl. Retain statusToken securely for this checkout. A repeated idempotency key with a changed request returns IDEMPOTENCY_CONFLICT; the same request returns CHECKOUT_EXISTS to prevent starting a second checkout. Resume the stored original reference/token. After an ambiguous network failure, reconcile through finance rather than creating repeated registration invoices.

| Route                                          | Authentication                                      | Response                                                                                                                                                                                                                 |
| ---------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| GET /payments/verify/:reference                | X-Payment-Token or matching student/finance session | `{reference,status,verified,studentId:null                                                                                                                                                                               | string}` after independent gateway verification |
| POST /payments/:reference/retry                | same, plus CSRF; `{}`                               | Checks original gateway first; pending attempts resume their existing checkout rather than starting another payment; `{status:"SUCCESS"}` if paid, otherwise 201 `{checkoutUrl,reference,statusToken}` for a new attempt |
| GET /payments/:reference/receipt               | same                                                | application/pdf attachment; only after verified receipt exists                                                                                                                                                           |
| POST /payments/webhook/:provider               | raw JSON + signature                                | `{received:true,duplicate?:true}`                                                                                                                                                                                        |
| POST /admin/payments/:reference/verify-offline | finance write + recent MFA; `{reason}` min 10       | settled Payment; BANK only                                                                                                                                                                                               |
| POST /admin/payments/:reference/refund         | finance write + recent MFA; `{reason}` min 10       | 202 Refund row; full amount, asynchronous submission                                                                                                                                                                     |

Webhook provider names: paystack, flutterwave, stripe. Headers: `x-paystack-signature` HMAC SHA512 hex, `flutterwave-signature` HMAC SHA256 base64, `stripe-signature` using the Stripe SDK timestamp verification. Do not JSON-parse/re-serialize raw requests before signature checking. Signed pending events return retryable 503, not a premature processed acknowledgement. Only verified SUCCESS provisions a student. Idempotent success returns the existing payment without repeating receipt/credential creation. An existing email with another student account requires admissions reconciliation rather than linking based on email alone.

## Public reads

GET `/public/content` returns `{key,value,updatedBy,updatedAt}[]`. Content keys such as `hero.title`, `hero.image`, `faqs`, `stats`, `testimonials`, `partners`, `footer`, and `seo` belong to the school; keep rendering schema validation on the frontend. GET `/public/faqs` returns the `faqs` JSON value or `[]`.

GET `/public/countries`, `/universities`, `/courses`, `/exams`, `/hostels`, `/rooms`, `/slides`, `/fees` return their active/visible model rows. Room capacity is configured stock, **not date-specific availability**; POST booking determines actual availability transactionally. GET `/public/announcements` returns only published, unexpired Website-targeted posts. GET `/public/consultation-slots?from=<UTC>&to=<UTC>&timezone=Africa/Lagos` returns future unbooked active slots with canonical UTC startsAt/endsAt plus timezone/localStartsAt. Send slot UUID when booking, never the formatted string.

## Student routes

Every `/portal/*` route (also `/me/*`) requires a STUDENT session and checks ownership.

| Route                                      | Input                                                                                          | Output                                                                                                                            |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| GET /portal/profile                        | none                                                                                           | Student with safe `user:{email,phone,status}`                                                                                     |
| PATCH /portal/profile                      | optional firstName,lastName,dob,nationality,countryOfResidence,guardian `{name,email?,phone?}` | updated Student; account email/phone changes require staff identity review                                                        |
| GET /portal/journey                        | none                                                                                           | `{journeyStage,milestones}`                                                                                                       |
| GET /portal/applications                   | pagination                                                                                     | Application[] with university/course/history                                                                                      |
| POST /portal/applications                  | `{universityId,courseId}`                                                                      | 201 DRAFT Application                                                                                                             |
| GET /portal/applications/:id               | UUID                                                                                           | own application with status history                                                                                               |
| POST /portal/applications/:id/submit       | `{}`                                                                                           | SUBMITTED Application; needs a scanned private supporting document                                                                |
| GET /portal/documents                      | pagination                                                                                     | own document metadata; no fileKey                                                                                                 |
| DELETE /portal/documents/:id               | UUID                                                                                           | 202 `{deletionRequested:true}`; queued object deletion                                                                            |
| GET /portal/exams or /portal/enrolments    | pagination                                                                                     | ExamEnrolment[] with exam, timetable and result                                                                                   |
| POST /portal/exams                         | `{examId}`                                                                                     | 201 PENDING enrolment; capacity/window checked under lock                                                                         |
| GET /portal/payments                       | pagination                                                                                     | own payments plus receipt metadata; no raw provider payload                                                                       |
| GET /portal/fees                           | pagination                                                                                     | active Fee[]                                                                                                                      |
| GET /portal/bookings                       | pagination                                                                                     | own HostelBooking[] plus room/hostel                                                                                              |
| POST /portal/bookings                      | `{roomId,term,arrival,departure}`                                                              | 201 HELD booking, bed, amountMinor, holdExpiresAt (15 minutes)                                                                    |
| POST /portal/bookings/:id/cancel           | `{}`                                                                                           | `{cancelled:true}`; only unpaid HELD                                                                                              |
| GET /portal/consultations                  | pagination                                                                                     | own bookings with UTC slot                                                                                                        |
| POST /portal/consultations                 | `{slotId}`                                                                                     | 201 CONFIRMED ConsultationBooking                                                                                                 |
| PATCH /portal/consultations/:id/reschedule | `{slotId}`                                                                                     | updated booking; future active unoccupied slot only                                                                               |
| POST /portal/consultations/:id/cancel      | `{}`                                                                                           | CANCELLED booking; old slot released                                                                                              |
| GET /portal/announcements                  | pagination                                                                                     | eligible posts with `reads:[{readAt}]`; empty means unread                                                                        |
| POST /portal/announcements/:id/read        | `{}`                                                                                           | AnnouncementRead; eligible audience only                                                                                          |
| GET /portal/notifications                  | pagination                                                                                     | Notification[] with nullable readAt                                                                                               |
| POST /portal/notifications/read            | `{}`                                                                                           | `{read:true}`                                                                                                                     |
| GET /portal/messages                       | pagination                                                                                     | own Thread[] with chronological Message[]                                                                                         |
| POST /portal/messages                      | `{subject,body,threadId?}`                                                                     | 201 Message; creates own thread if omitted                                                                                        |
| GET /portal/export                         | none                                                                                           | downloadable JSON of own profile, applications/history, exams, bookings, consultations, documents metadata, payments and messages |
| POST /portal/deletion-request              | `{reason}` min 5                                                                               | 202 `{received:true}`; retention review, not instant erasure                                                                      |

## Admin CMS and operations

All routes require ADMIN authentication **after TOTP** and module read/write permissions. Super Admin retains all modules; users/roles/settings/audit cannot be delegated. Roles: SUPER_ADMIN, ADMISSIONS, FINANCE, HOSTEL, CONTENT. See default module lists in `src/auth.ts`. Client hiding is supplementary; server guards are authoritative.

Generic GET/POST `/admin/<resource>` and PATCH/DELETE `/admin/<resource>/:id` exist for the following resources. POST returns 201 created row, PATCH returns updated row, DELETE returns 204. Foreign-key protection rejects deleting in-use parents. Prefer `active:false` for catalog retirement. POST announcement always creates DRAFT. Content/settings identifiers are keys, not UUIDs. Update settings with the typed PUT endpoint, not PATCH.

| Resource      | Writable fields (see /openapi.json for exact types, defaults and limits)                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| countries     | name,code (ISO two letters),featured                                                                                                       |
| universities  | countryId,name,description,entryRequirements JSON,tuitionMinor,currency,deadline?,featured,active,logo?,image?                             |
| courses       | universityId,name,requirements JSON,tuitionMinor,currency,deadline?,active                                                                 |
| exams         | body WAEC/NECO/CAMBRIDGE/OTHER,name,description,feeMinor,currency,opensAt,closesAt,timetable JSON,requirements JSON,centre,capacity,active |
| hostels       | name,description,gender FEMALE/MALE/MIXED,rules,active                                                                                     |
| rooms         | hostelId,name,capacity,priceMinor,depositMinor,currency,amenities JSON,gender,photos JSON,active                                           |
| slides        | image,caption,title,order,visible                                                                                                          |
| fees          | name,purpose REGISTRATION/ENROLMENT/TUITION/EXAM/HOSTEL/INSTALMENT,amountMinor,currency,instalments,active                                 |
| coupons       | code,percent 1–99,expiresAt,active                                                                                                         |
| slots         | advisorId (staff UUID),advisor,startsAt,endsAt,mode VIDEO/PHONE/IN_PERSON,active                                                           |
| announcements | title,body (sanitized HTML),attachments `[{documentId}]`,category,audience `{type,value?}`,channels[],publishAt?,expireAt?,pinned          |
| content       | key,value JSON                                                                                                                             |
| settings      | key,value JSON; studentIds validated                                                                                                       |

Audience type values: `Website`, `All students`, `Exam group`, `Cohort`, `Student`. Target value is exam UUID, cohort text, or Student UUID respectively. Channels: BANNER, NEWS, DASHBOARD, IN_APP, EMAIL, SMS, WHATSAPP. BANNER/NEWS require Website audience. Attachments must be approved scanned documents; Website posts require public media. Published content must be archived and recreated as a draft before editing; publish is idempotent. Future publishAt creates SCHEDULED; worker activates it and archives at expireAt.

| Route                                                          | Body / response                                                                                                                      |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| POST /admin/slides/reorder                                     | `{ids:uuid[]}` -> `{reordered:true}`                                                                                                 |
| GET /admin/students                                            | Student[] with safe account metadata                                                                                                 |
| PATCH /admin/students/:id                                      | optional firstName,lastName,cohort,journeyStage,milestones `[{stage,at}]`                                                            |
| POST /admin/students/manual                                    | `{firstName,lastName,email,phone,reason}`; Super Admin + recent MFA -> Student and credentials queued                                |
| POST /admin/students/:id/resend-credentials or /reset-password | `{}` -> 202 `{queued:true}`; active account, per-student rate limit                                                                  |
| PATCH /admin/students/:id/status                               | `{status:"ACTIVE"                                                                                                                    | "SUSPENDED",reason}`->`{status}`; session revocation                            |
| GET /admin/applications                                        | Application[] with student/course/history                                                                                            |
| PATCH /admin/applications/:id/status                           | `{status,comment,assignedTo?}`; UNDER_REVIEW/NEEDS_DOCUMENTS/ACCEPTED/REJECTED -> updated Application, history and notification      |
| GET /admin/documents                                           | safe metadata list                                                                                                                   |
| PATCH /admin/documents/:id/review                              | `{status:"APPROVED"                                                                                                                  | "REJECTED",reason?}`; rejection requires reason; scanner must have cleared file |
| GET /admin/enrolments                                          | exam registrations                                                                                                                   |
| PATCH /admin/enrolments/:id                                    | optional candidateNumber,status,result `{grade,documentId?}`; result document must be scanned private file belonging to that student |
| GET /admin/bookings                                            | hostel bookings                                                                                                                      |
| PATCH /admin/bookings/:id                                      | `{status:"CANCELLED"                                                                                                                 | "CHECKED_IN"                                                                    | "CHECKED_OUT"}`; valid transition required; paid confirmation comes from payment pipeline |
| GET /admin/consultations                                       | consultation bookings                                                                                                                |
| PATCH /admin/consultations/:id                                 | `{link?:httpsURL,notes?}`                                                                                                            |
| PATCH /admin/consultations/:id/reschedule                      | `{slotId}`; locking/availability checks                                                                                              |
| POST /admin/consultations/:id/cancel                           | `{reason}`; releases slot                                                                                                            |
| GET /admin/advisors                                            | eligible active staff `{userId,name}[]`; invite/edit via users routes                                                                |
| GET /admin/media                                               | public document metadata/status/fileKey; only approved prefix may be used on CDN                                                     |
| POST /admin/announcements/:id/publish or /archive              | `{}` -> Announcement                                                                                                                 |
| GET /admin/payments                                            | payment/receipt/refund metadata                                                                                                      |
| GET /admin/users                                               | Admin[] plus safe User metadata                                                                                                      |
| POST /admin/users                                              | `{name,email,phone,roleType}` -> 201 `{id,email,role}`; emailed setup link, mandatory TOTP                                           |
| PATCH /admin/users/:id                                         | optional name,roleType,status -> `{updated:true}`; sessions revoked; last active owner protected                                     |
| DELETE /admin/users/:id                                        | soft-delete User; 204, audit retained                                                                                                |
| GET /admin/roles                                               | RolePermission[]                                                                                                                     |
| PUT /admin/roles/:role                                         | `{read:string[],write:string[]}`; write implies read; owner modules cannot be delegated                                              |
| PUT /admin/settings/studentIds                                 | `{prefix,startingNumber}` -> Setting; counter never rewinds                                                                          |
| PUT /admin/settings/currencies                                 | `["NGN","USD"]` -> Setting                                                                                                           |
| PUT /admin/settings/notificationPreferences                    | `{applicationEmail:boolean,documentEmail:boolean}` -> Setting                                                                        |
| GET /admin/audit                                               | append-only AuditLog[], newest first                                                                                                 |
| GET /admin/messages                                            | Thread[] with students/messages                                                                                                      |
| POST /admin/messages/:threadId                                 | `{body}` -> Message and student notification                                                                                         |
| GET /admin/dashboard                                           | `{applicants,enrolments,bookings,revenue:[{currency,_sum:{amountMinor}}],upcomingConsultations}`; no currency conversion             |

## Files

POST `/files/upload-url`: `{filename,mime,size,type,public?:false,ownerId?}` -> 201 `{id,uploadUrl,expiresIn:300,headers:{"Content-Type":mime}}`. Types PASSPORT/RESULT/IDENTITY/OTHER/MEDIA. Only permitted staff can set public:true or upload a result on behalf of a target student's **User UUID**. PUT the original File bytes directly to uploadUrl with returned headers, then POST `/files/:id/complete` `{}` -> 202 `{id,status:"SCANNING"}`. Poll own documents/admin media for result. MIME mismatch/malware becomes QUARANTINED; private clean documents become PENDING for staff review, public clean media APPROVED. A 202 response is not approval.

GET `/files/:id/download-url` -> `{url,expiresIn:60}`. Owner, permitted document staff, or an eligible recipient of a published announcement attachment only. No public bucket URL for passport/results. Delete own private files through `/portal/documents/:id`. Result files uploaded by staff use ownerId=student.userId, then attach documentId through enrolment update.

## Worker contract

Outbox kinds EMAIL/SMS/WHATSAPP/SCAN/DELETE_FILE/ANNOUNCEMENT/REFUND/PRIVACY_REQUEST/NOOP. PostgreSQL SKIP LOCKED claims work across worker processes. Payload is encrypted, retries are bounded, stale 10-minute leases recover. Scheduler publishes/expires posts and releases 15-minute bed holds. External email/SMS/WhatsApp is at least once; notify recipients accordingly. PRIVATE scan failure never falls back to public access. Operational privacy and ambiguous refund cases require authorised human reconciliation as described in README.

DELETE `/admin/media/:id` requires media write permission, queues storage deletion and writes an audit record; returns 202 `{deletionRequested:true}`.
