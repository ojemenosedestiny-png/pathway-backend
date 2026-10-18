# Replace the Journey mocks

The existing screens and CSS remain unchanged. This backend does **not** silently redirect the current preview to a live payment gateway. Replace the implementations in `journey/access-service.ts`, `journey/services.ts`, and `student-services/api.js` using the mapping below, then test with provider sandbox accounts before enabling real payments. Delete demo identity/profile selection, local-owner bootstrap, simulated payments and mail previews from production navigation.

## Shared transport

Configure one API origin at build time, e.g. `http://localhost:4000` in development. The current vanilla TypeScript frontend has no automatic Vite environment loader: inject an explicit `window.PATHWAY_API_ORIGIN` config from the deployment or import your own generated config module. Never include backend secrets in it. Include cookies in every fetch. Keep the CSRF token in memory; obtain it from GET /auth/csrf. Cookie auth requires the frontend/API to be on the same site in production.

```ts
const origin = window.PATHWAY_API_ORIGIN;
let csrfToken: string;
async function api(path: string, method = "GET", body?: unknown, extra = {}) {
  if (!csrfToken) {
    const r = await fetch(origin + "/auth/csrf", { credentials: "include" });
    if (!r.ok) throw new Error("Unable to initialise a secure session.");
    csrfToken = (await r.json()).csrfToken;
  }
  const response = await fetch(origin + path, {
    method,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(method === "GET" ? {} : { "X-CSRF-Token": csrfToken }),
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error?.message || "Request failed.");
  }
  return response.status === 204 ? undefined : response.json();
}
```

Add a single-flight POST /auth/refresh on expired access sessions, then retry the original read once. For receipt PDFs consume Blob instead of JSON, retaining the same credentials/payment token authorization. Keep frontend role checks for navigation but derive them from GET /auth/session. Never treat sessionStorage as authorization. Do not persist passwords, MFA secrets, setup links, access/refresh tokens or outbox payloads.

## `journey/access-service.ts`

| Existing function                            | Replacement                                                                                                                            |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| authenticated(kind), allowed(module,write)   | Cache safe GET /auth/session result for UI; server rechecks every call                                                                 |
| touchSession                                 | GET /auth/session; activity updates the server session                                                                                 |
| createPayment(details)                       | POST /payments/initialize with provider enum + server feeId + applicant; remove client amount/currency authority; Idempotency-Key UUID |
| verifyPayment(reference)                     | GET /payments/verify/:reference with X-Payment-Token or own session                                                                    |
| simulateProvider                             | Remove in production. Only signed gateway webhook and server verify may settle                                                         |
| createStudentAfterPayment(reference)         | GET /payments/verify/:reference; server transaction performs creation, return studentId only after SUCCESS                             |
| generateStudentId                            | Remove browser allocator. ID generated only in server settlement/manual exception transaction                                          |
| syncStudent                                  | Remove. User/Student/payment/outbox already share one DB transaction                                                                   |
| setupPassword(raw,password)                  | POST /auth/set-password `{token:raw,password}`                                                                                         |
| loginStudent(studentId,password,remember)    | POST /auth/student/login `{studentId,password,rememberMe:remember}`, then GET /portal/profile                                          |
| requestPasswordReset(email)                  | POST /auth/student/forgot-password `{email}`                                                                                           |
| recoverStudentId(email,evidence)             | POST /auth/student/recover-id `{email,phone:evidence}` or `{email,paymentReference:evidence}`; generic acknowledgement                 |
| resendCredentials(studentId)                 | Resolve public ID to Student UUID from admin list; POST /admin/students/:id/resend-credentials `{}`                                    |
| listStudents                                 | GET /admin/students, page through results                                                                                              |
| setStudentStatus(publicId,status)            | PATCH /admin/students/:uuid/status `{status:uppercase,reason}`                                                                         |
| setStudentGroups(publicId,cohort,examGroups) | PATCH /admin/students/:uuid `{cohort}`; exam groups derive from actual ExamEnrolment records, never arbitrary client membership        |
| manuallyCreateStudent(details)               | POST /admin/students/manual; split name into firstName/lastName, include reason; owner-only MFA exception                              |
| verifyOfflinePayment(reference)              | POST /admin/payments/:reference/verify-offline `{reason}`                                                                              |
| settings, saveIdSettings                     | GET /admin/settings; PUT /admin/settings/studentIds `{prefix,startingNumber}`                                                          |
| bootstrapOwner                               | Remove. Run backend `npm run seed` from protected environment                                                                          |
| hasOwner                                     | Remove public owner-discovery flow. Backend seed is an operations task                                                                 |
| loginAdmin(email,password)                   | POST /auth/admin/login; retain short-lived challenge in memory                                                                         |
| verifyAdmin2FA(code)                         | POST /auth/admin/2fa/verify `{challenge,code}`; first onboarding also calls /admin/onboarding/password and /admin/2fa/setup            |
| logout(all)                                  | POST /auth/logout or /auth/logout-all `{}`; clear UI caches                                                                            |
| listAdmins                                   | GET /admin/users                                                                                                                       |
| saveAdmin                                    | POST /admin/users `{name,email,phone,roleType}` or PATCH /admin/users/:userUuid `{name?,roleType?,status?}`                            |
| removeAdmin                                  | DELETE /admin/users/:userUuid                                                                                                          |
| permissions, savePermissions                 | GET /admin/roles; PUT /admin/roles/:role `{read,write}`                                                                                |
| deliveries                                   | Remove browser outbox/mail preview. Actual delivery occurs in protected worker; never expose token-bearing messages                    |
| payments                                     | GET /admin/payments                                                                                                                    |
| audit                                        | GET /admin/audit                                                                                                                       |
| createAnnouncement                           | POST /admin/announcements; always DRAFT                                                                                                |
| savePost                                     | POST /admin/announcements or PATCH /admin/announcements/:uuid for a draft                                                              |
| publishAnnouncement                          | POST /admin/announcements/:uuid/publish `{}`                                                                                           |
| archivePost                                  | POST /admin/announcements/:uuid/archive `{}`                                                                                           |
| listPosts                                    | GET /admin/announcements                                                                                                               |
| visiblePosts(placement)                      | GET /public/announcements for guests, /portal/announcements for students; filter returned channel for desired placement                |
| markPostRead                                 | POST /portal/announcements/:uuid/read `{}`                                                                                             |

## `journey/services.ts`

| Existing function                          | Replacement                                                                                                                                                                      |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| list(collection)                           | Public collections -> /public/:resource; own collections -> /portal/:resource; staff -> /admin/:resource. Table below maps renamed resources                                     |
| save(collection,values)                    | Catalog/CMS -> POST or PATCH /admin/:resource; operational students/documents/applications/enrolments/bookings/consultations/payments use dedicated endpoints in API-CONTRACT.md |
| remove(collection,ids)                     | DELETE each /admin/:resource/:uuid with bounded sequential requests; deactivate in-use parents rather than remove historical data                                                |
| reorder(collection,ids)                    | Slides -> POST /admin/slides/reorder `{ids}`; other collections have no implicit arbitrary sort mutation                                                                         |
| getSite                                    | GET /public/content; map `{key,value}` to existing `{[name]:value}`                                                                                                              |
| getUniversities/getHostels/getRooms        | GET /public/universities, /public/hostels, /public/rooms; adapt relational country/hostel UUIDs and money fields                                                                 |
| saveHostel                                 | POST/PATCH /admin/hostels                                                                                                                                                        |
| updateApplicationStatus                    | PATCH /admin/applications/:uuid/status `{status,comment}`                                                                                                                        |
| registerStudent                            | Keep redirect to /enrol; registration requires verified payment                                                                                                                  |
| getStudent/updateProfile                   | GET/PATCH /portal/profile                                                                                                                                                        |
| enrolExam                                  | POST /portal/exams `{examId}`, then initialize exam payment by examId                                                                                                            |
| uploadDocument                             | POST /files/upload-url, direct PUT File bytes, POST /files/:uuid/complete; poll until scanner/reviewer result                                                                    |
| removeDocument                             | DELETE /portal/documents/:uuid                                                                                                                                                   |
| sendMessage                                | POST /portal/messages `{subject,body,threadId?}` or /admin/messages/:threadUuid `{body}`                                                                                         |
| markRead                                   | POST /portal/notifications/read `{}`                                                                                                                                             |
| createStudentRecord                        | Replace by specific POST /payments/initialize, /portal/applications, /portal/bookings or /portal/consultations; never create arbitrary student-owned rows                        |
| updateOwnRecord                            | Payments -> verify, not client status writes; consultation -> cancel/reschedule endpoints                                                                                        |
| ownRecords                                 | GET /portal/:resource                                                                                                                                                            |
| publishAnnouncement                        | POST /admin/announcements/:uuid/publish `{}`                                                                                                                                     |
| availableConsultationSlots(day)            | Convert chosen day to an actual UTC range for user's timezone; GET /public/consultation-slots?from=...&to=...&timezone=...; retain slot UUIDs                                    |
| bookConsultation(details,reference?)       | POST /portal/consultations `{slotId}` or PATCH /portal/consultations/:uuid/reschedule                                                                                            |
| reserveRoom                                | POST /portal/bookings BEFORE paying, then POST /payments/initialize `{provider,bookingId}`; confirm only after payment verification                                              |
| submitApplication                          | Create draft with universityId/courseId, upload supporting documents, then POST /portal/applications/:uuid/submit `{}`                                                           |
| demoUsers                                  | Remove preview-profile selector; use authenticated identity                                                                                                                      |
| session/setSession/signOut/can/requireRole | Safe in-memory server session cache + /auth/session, logout and role checks; no client-authoritative role/identity                                                               |
| subscribe                                  | Re-fetch after successful mutation/focus, or bounded polling for server updates; localStorage events no longer sync records                                                      |
| uid/milestones                             | uid only for client draft keys and idempotency UUIDs; DB returns persisted IDs. Journey milestone labels remain UI constants                                                     |

Collection mapping:

| Frontend collection                                                                 | Backend resource                                                                                |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| content                                                                             | SiteContent /public/content, /admin/content (key/value); PATCH key instead of record UUID       |
| faqs, stats, testimonials, partners                                                 | SiteContent keys `faqs`, `stats`, `testimonials`, `partners`, each storing validated JSON array |
| universities, exams, hostels, rooms, slides, fees                                   | same plural resources                                                                           |
| slots                                                                               | /public/consultation-slots or /admin/slots                                                      |
| enrolments                                                                          | /portal/exams or /admin/enrolments                                                              |
| applications, documents, payments, bookings, consultations, messages, notifications | /portal equivalents; staff endpoints where provided                                             |
| announcements                                                                       | /public/announcements, /portal/announcements, /admin/announcements                              |
| students                                                                            | /portal/profile for self; /admin/students for staff                                             |
| roles, audit                                                                        | /admin/roles, /admin/audit                                                                      |

## `student-services/api.js`

| Function                                                   | API                                                                                                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| listPayments/createPayment                                 | GET /portal/payments; POST /payments/initialize with server feeId                                                                           |
| simulatePayment                                            | Remove from live build                                                                                                                      |
| listApplications                                           | GET /portal/applications                                                                                                                    |
| submitApplication                                          | create draft -> upload/scan -> POST submit; select a real Course UUID, not free text                                                        |
| saveDraft/loadDraft/clearDraft                             | Keep local draft convenience without uploaded sensitive bytes, or use a DRAFT Application ID; clear local personal data after submit/logout |
| listConsultations/availableSlots                           | GET /portal/consultations; GET /public/consultation-slots                                                                                   |
| bookConsultation/rescheduleConsultation/cancelConsultation | POST /portal/consultations; PATCH /:uuid/reschedule; POST /:uuid/cancel                                                                     |
| listRooms                                                  | GET /public/rooms plus /public/hostels; use approved CDN image URLs                                                                         |
| reserveRoom/listBookings                                   | POST /portal/bookings before checkout; GET /portal/bookings                                                                                 |
| getSite/listFees                                           | GET /public/content; GET /public/fees                                                                                                       |

## Required shape adaptations

- Translate role labels: Super Admin -> SUPER_ADMIN, Admissions Officer -> ADMISSIONS, Finance -> FINANCE, Hostel Manager -> HOSTEL, Content Editor -> CONTENT. Frontend module `adminUsers` -> users, `posts` -> announcements, `idSettings` -> settings. Use the server's module permission arrays.
- Translate title-case UI statuses into uppercase API enums and map back for labels. Payment `Paid`/`success` -> SUCCESS; `Active` -> ACTIVE. Do not infer payment success from labels or redirects.
- Convert display money using decimal-safe parsing into minor units when editing **admin** fee/catalog fields; payment checkout only sends their IDs. Render returned strings with the proper currency. Database capacity is not mutable availability; remove the manual room `available` input.
- Student name maps to firstName + lastName, email/phone are under safe `user`, country maps to countryOfResidence. Account contact changes require verified staff review.
- Exam UI `fee/opens/closes/limit` map to feeMinor/opensAt/closesAt/capacity. Enrolment result is `{grade,documentId?}`; request a signed URL when opening it. Exam logo fields from the frontend may be stored in SiteContent `partners` keyed by exam body, preserving the existing logos without changing the backend Exam schema.
- Announcement `audience` + `audienceValue` become `{type,value}`. Combine placements and external channels into API channels: Homepage banner -> BANNER, News -> NEWS, Student dashboard -> DASHBOARD, Notification bell -> IN_APP. Frontend `expiresAt` maps to `expireAt`; file attachments store documentId only, not base64/data URLs. Empty dates become null. Read/unread uses per-user reads[].
- Existing DEMO IDs/localStorage data are not database UUIDs. Import reviewed catalog/content through admin endpoints or a controlled migration; do not copy browser-generated IDs, passwords, simulated successful payments or Student IDs into live identity records.

## Environment values to fill

| Group           | Backend-only variables                                                                                                        |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Core            | DATABASE_URL, FRONTEND_ORIGIN, PUBLIC_API_ORIGIN, JWT_SECRET, ENCRYPTION_KEY, NODE_ENV, PORT, COOKIE_SECURE, TRUST_PROXY_HOPS |
| First owner     | ADMIN_EMAIL, ADMIN_INITIAL_PASSWORD (seed only)                                                                               |
| ID policy       | STUDENT_ID_PREFIX, STUDENT_ID_START (subsequently editable settings)                                                          |
| NGN gateways    | PAYSTACK_SECRET_KEY and/or FLUTTERWAVE_SECRET_KEY + FLUTTERWAVE_WEBHOOK_SECRET                                                |
| USD gateway     | STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET                                                                                      |
| Email/SMS       | RESEND_API_KEY, EMAIL_FROM, TERMII_API_KEY, TERMII_SENDER                                                                     |
| WhatsApp        | WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_GRAPH_VERSION, WHATSAPP_NOTICE_TEMPLATE, WHATSAPP_LANGUAGE          |
| Storage/scanner | S3_ENDPOINT (if needed), S3_REGION, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY, PUBLIC_MEDIA_BASE, SCANNER_URL, SCANNER_TOKEN    |
| Compose only    | POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB                                                                                 |
| Tests/backups   | optional TEST_DATABASE_URL; backup job PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSFILE, BACKUP_DIR                             |

Frontend receives **only** the API origin and public media URLs; no provider, owner, JWT, encryption, storage, scanner or messaging secret.
