import {admissionSchema} from './admissions.js';
import { zodToJsonSchema } from "zod-to-json-schema";
import { resourceSchemas } from "./admin.js";
const json = (schema: object) => ({ "application/json": { schema } });
const object = (
  properties: Record<string, unknown>,
  required = Object.keys(properties),
) => ({ type: "object", additionalProperties: false, properties, required });
const string = { type: "string" },
  uuid = { type: "string", format: "uuid" },
  password = { type: "string", minLength: 12, maxLength: 128 };
export const openapi: any = {
  openapi: "3.0.3",
  info: {
    title: "Pathway API",
    version: "1.0.0",
    description:
      "Money uses integer minor-unit decimal strings. Cookie authentication, signed CSRF token and exact Origin required for browser mutations. See API-CONTRACT.md for workflows and field tables.",
  },
  servers: [{ url: "/" }],
  components: {
    securitySchemes: {
      cookieAuth: { type: "apiKey", in: "cookie", name: "access" },
      csrf: { type: "apiKey", in: "header", name: "X-CSRF-Token" },
      paymentToken: { type: "apiKey", in: "header", name: "X-Payment-Token" },
    },
    schemas: {
      Error: object({ error: object({ code: string, message: string }) }),
    },
  },
  paths: {},
};
function endpoint(
  method: string,
  path: string,
  summary: string,
  body?: object,
  secured = false,
) {
  const parameters = [...path.matchAll(/\{(\w+)\}/g)].map((m) => ({
    name: m[1],
    in: "path",
    required: true,
    schema: string,
  }));
  openapi.paths[path] ??= {};
  openapi.paths[path][method] = {
    summary,
    parameters,
    ...(secured ? { security: [{ cookieAuth: [] }] } : {}),
    ...(body ? { requestBody: { required: true, content: json(body) } } : {}),
    responses: {
      "200": {
        description:
          "Successful response; shapes documented in API-CONTRACT.md",
      },
      "400": {
        description: "Invalid input",
        content: json({ $ref: "#/components/schemas/Error" }),
      },
      "401": { description: "Authentication required" },
      "403": { description: "Role, ownership or CSRF failure" },
      "409": { description: "State or concurrency conflict" },
      "429": { description: "Rate limit exceeded" },
    },
  };
}
endpoint("get", "/auth/csrf", "Issue signed CSRF token");
endpoint(
  "post",
  "/auth/student/login",
  "Student ID and password login",
  object(
    {
      studentId: string,
      password: string,
      rememberMe: { type: "boolean", default: false },
    },
    ["studentId", "password"],
  ),
);
endpoint(
  "post",
  "/auth/admin/login",
  "Start mandatory admin MFA",
  object({ email: { type: "string", format: "email" }, password: string }),
);
endpoint(
  "post",
  "/auth/admin/onboarding/password",
  "Change seed password",
  object({ challenge: string, password }),
);
endpoint(
  "post",
  "/auth/admin/2fa/setup",
  "Create TOTP enrolment secret",
  object({ challenge: string }),
);
endpoint(
  "post",
  "/auth/admin/2fa/verify",
  "Complete MFA; returns recovery codes once on enrolment",
  object({ challenge: string, code: string }),
);
endpoint(
  "post",
  "/auth/set-password",
  "Consume single-use set/reset token",
  object({ token: string, password }),
);
endpoint(
  "post",
  "/auth/student/forgot-password",
  "Generic acknowledgement; email reset link",
  object({ email: string }),
);
endpoint(
  "post",
  "/auth/student/recover-id",
  "Recover Student ID with email and corroborating phone/reference",
  object({ email: string, phone: string, paymentReference: string }, ["email"]),
);
for (const action of ["refresh", "logout", "logout-all"])
  endpoint("post", "/auth/" + action, action, object({}), action !== "refresh");
endpoint("get", "/auth/session", "Current identity", undefined, true);
endpoint(
  "post",
  "/payments/initialize",
  "Create server-priced checkout; Idempotency-Key UUID required",
  object(
    {
      provider: {
        type: "string",
        enum: ["PAYSTACK", "FLUTTERWAVE", "STRIPE", "BANK"],
      },
      feeId: uuid,
      bookingId: uuid,
      examId: uuid,
      coupon: string,
      applicant: object({ name: string, email: string, phone: string }),
    },
    ["provider"],
  ),
);
endpoint(
  "get",
  "/payments/verify/{reference}",
  "Verify gateway reference and settle atomically",
);
endpoint(
  "post",
  "/payments/{reference}/retry",
  "Check gateway before retrying",
  object({}),
);
endpoint(
  "get",
  "/payments/{reference}/receipt",
  "Download authorised PDF receipt",
);
endpoint(
  "post",
  "/payments/webhook/{provider}",
  "Raw gateway payload; provider-specific signature required",
  { type: "object", additionalProperties: true },
);
for (const name of [
  "countries",
  "universities",
  "courses",
  "exams",
  "hostels",
  "rooms",
  "slides",
  "fees",
  "content",
  "announcements",
])
  endpoint("get", "/public/" + name, "Public " + name);
for (const name of [
  "profile",
  "journey",
  "applications",
  "documents",
  "exams",
  "enrolments",
  "payments",
  "fees",
  "bookings",
  "consultations",
  "announcements",
  "notifications",
  "messages",
  "export",
])
  endpoint("get", "/portal/" + name, "Own " + name, undefined, true);
for (const name of [
  "students",
  "applications",
  "documents",
  "enrolments",
  "bookings",
  "consultations",
  "payments",
  "users",
  "roles",
  "audit",
  "messages",
  "dashboard",
  "countries",
  "universities",
  "courses",
  "exams",
  "hostels",
  "rooms",
  "slides",
  "fees",
  "coupons",
  "slots",
  "announcements",
  "content",
  "settings",
])
  endpoint("get", "/admin/" + name, "Role-checked " + name, undefined, true);
for (const name of [
  "countries",
  "universities",
  "courses",
  "exams",
  "hostels",
  "rooms",
  "slides",
  "fees",
  "coupons",
  "slots",
  "announcements",
  "content",
  "settings",
]) {
  endpoint(
    "post",
    "/admin/" + name,
    "Create " + name,
    {
      type: "object",
      description: "Exact validated field schema: API-CONTRACT.md",
    },
    true,
  );
  endpoint(
    "patch",
    "/admin/" + name + "/{id}",
    "Update " + name,
    { type: "object" },
    true,
  );
  endpoint(
    "delete",
    "/admin/" + name + "/{id}",
    "Delete " + name,
    undefined,
    true,
  );
}
for (const action of ["publish", "archive"])
  endpoint(
    "post",
    "/admin/announcements/{id}/" + action,
    action + " announcement",
    object({}),
    true,
  );
endpoint(
  "post",
  "/files/upload-url",
  "Create private quarantine upload",
  object(
    {
      filename: string,
      mime: {
        type: "string",
        enum: ["application/pdf", "image/jpeg", "image/png", "image/webp", "video/mp4", "video/webm"],
      },
      size: { type: "integer", minimum: 1, maximum: 52428800, description: "Images/PDF up to 10 MiB; public MEDIA videos up to 50 MiB." },
      type: {
        type: "string",
        enum: ["PASSPORT", "RESULT", "IDENTITY", "OTHER", "MEDIA"],
      },
      public: { type: "boolean", default: false },
    },
    ["filename", "mime", "size", "type"],
  ),
  true,
);
endpoint(
  "post",
  "/files/{id}/complete",
  "Queue MIME and malware validation",
  object({}),
  true,
);
endpoint(
  "get",
  "/files/{id}/status",
  "Own upload or permitted public media status; returns id, filename, mime, status and url (null until approved public media)",
  undefined,
  true,
);
endpoint(
  "get",
  "/files/{id}/download-url",
  "Authorised signed download, expires in 60s",
  undefined,
  true,
);
for (const [resource, schema] of Object.entries(resourceSchemas)) {
  const full = zodToJsonSchema(schema.strict(), {
    target: "openApi3",
    $refStrategy: "none",
  });
  const partial = zodToJsonSchema(schema.partial().strict(), {
    target: "openApi3",
    $refStrategy: "none",
  });
  openapi.paths["/admin/" + resource].post.requestBody.content = json(full);
  openapi.paths["/admin/" + resource + "/{id}"].patch.requestBody.content =
    json(partial);
}
openapi.paths["/auth/admin/onboarding/password"].post.requestBody.content =
  json(object({ challenge: string, newPassword: password }));
const mutations: [string, string, string, object][] = [
  [
    "patch",
    "/portal/profile",
    "Update own profile",
    object(
      {
        firstName: string,
        lastName: string,
        dob: { type: "string", format: "date" },
        nationality: string,
        countryOfResidence: string,
        guardian: object({ name: string, email: string, phone: string }, [
          "name",
        ]),
      },
      [],
    ),
  ],
  [
    "post",
    "/portal/applications",
    "Create application draft",
    object({ universityId: uuid, courseId: uuid }),
  ],
  [
    "post",
    "/portal/applications/{id}/submit",
    "Submit draft with scanned documents",
    object({}),
  ],
  ["post", "/portal/exams", "Reserve exam enrolment", object({ examId: uuid })],
  [
    "post",
    "/portal/bookings",
    "Hold a bed for 15 minutes",
    object({
      roomId: uuid,
      term: string,
      arrival: { type: "string", format: "date-time" },
      departure: { type: "string", format: "date-time" },
    }),
  ],
  ["post", "/portal/bookings/{id}/cancel", "Cancel unpaid hold", object({})],
  [
    "post",
    "/portal/consultations",
    "Book consultation",
    object({ slotId: uuid }),
  ],
  [
    "post",
    "/portal/consultations/{id}/cancel",
    "Cancel future consultation",
    object({}),
  ],
  [
    "patch",
    "/portal/consultations/{id}/reschedule",
    "Change consultation slot",
    object({ slotId: uuid }),
  ],
  [
    "post",
    "/portal/announcements/{id}/read",
    "Mark targeted notice read",
    object({}),
  ],
  [
    "post",
    "/portal/notifications/read",
    "Mark own notifications read",
    object({}),
  ],
  [
    "post",
    "/portal/messages",
    "Send student message",
    object({ threadId: uuid, subject: string, body: string }, [
      "subject",
      "body",
    ]),
  ],
  [
    "post",
    "/portal/deletion-request",
    "Request data protection review",
    object({ reason: string }),
  ],
  [
    "post",
    "/admin/slides/reorder",
    "Reorder carousel",
    object({ ids: { type: "array", items: uuid } }),
  ],
  [
    "post",
    "/admin/students/manual",
    "Owner exception creates student with audit reason",
    object({
      firstName: string,
      lastName: string,
      email: string,
      phone: string,
      reason: string,
    }),
  ],
  [
    "patch",
    "/admin/students/{id}",
    "Update student journey/cohort",
    object(
      {
        firstName: string,
        lastName: string,
        cohort: string,
        journeyStage: string,
        milestones: {
          type: "array",
          items: object({
            stage: string,
            at: { type: "string", format: "date-time" },
          }),
        },
      },
      [],
    ),
  ],
  [
    "patch",
    "/admin/students/{id}/status",
    "Suspend/reactivate and revoke sessions",
    object({
      status: { type: "string", enum: ["ACTIVE", "SUSPENDED"] },
      reason: string,
    }),
  ],
  [
    "post",
    "/admin/students/{id}/resend-credentials",
    "Queue setup or reset email",
    object({}),
  ],
  [
    "post",
    "/admin/students/{id}/reset-password",
    "Queue one-hour reset email",
    object({}),
  ],
  [
    "patch",
    "/admin/applications/{id}/status",
    "Update application pipeline and history",
    object(
      {
        status: {
          type: "string",
          enum: ["UNDER_REVIEW", "NEEDS_DOCUMENTS", "ACCEPTED", "REJECTED"],
        },
        comment: string,
        assignedTo: uuid,
      },
      ["status", "comment"],
    ),
  ],
  [
    "patch",
    "/admin/documents/{id}/review",
    "Review scanned document",
    object(
      {
        status: { type: "string", enum: ["APPROVED", "REJECTED"] },
        reason: string,
      },
      ["status"],
    ),
  ],
  [
    "patch",
    "/admin/enrolments/{id}",
    "Candidate number and results",
    object(
      {
        candidateNumber: string,
        status: {
          type: "string",
          enum: [
            "PENDING",
            "CONFIRMED",
            "WRITTEN",
            "RESULTS_AVAILABLE",
            "CANCELLED",
          ],
        },
        result: object({ grade: string, documentId: uuid }, ["grade"]),
      },
      [],
    ),
  ],
  [
    "patch",
    "/admin/bookings/{id}",
    "Check in/out or cancel booking",
    object({
      status: {
        type: "string",
        enum: ["CANCELLED", "CHECKED_IN", "CHECKED_OUT"],
      },
    }),
  ],
  [
    "patch",
    "/admin/consultations/{id}",
    "Update session notes and meeting URL",
    object({ link: { type: "string", format: "uri" }, notes: string }, []),
  ],
  [
    "post",
    "/admin/payments/{reference}/verify-offline",
    "Verify bank payment using shared settlement transaction",
    object({ reason: string }),
  ],
  [
    "post",
    "/admin/payments/{reference}/refund",
    "Queue audited full refund",
    object({ reason: string }),
  ],
  [
    "post",
    "/admin/users",
    "Invite administrator; no password in response",
    object({
      name: string,
      email: string,
      phone: string,
      roleType: {
        type: "string",
        enum: ["SUPER_ADMIN", "ADMISSIONS", "FINANCE", "HOSTEL", "CONTENT"],
      },
    }),
  ],
  [
    "patch",
    "/admin/users/{id}",
    "Change role/status; revoke sessions",
    object(
      {
        name: string,
        status: { type: "string", enum: ["ACTIVE", "SUSPENDED"] },
        roleType: {
          type: "string",
          enum: ["SUPER_ADMIN", "ADMISSIONS", "FINANCE", "HOSTEL", "CONTENT"],
        },
      },
      [],
    ),
  ],
  [
    "put",
    "/admin/roles/{role}",
    "Set module permissions",
    object({
      read: { type: "array", items: string },
      write: { type: "array", items: string },
    }),
  ],
  [
    "put",
    "/admin/settings/{key}",
    "Update typed ID/currency/notification setting",
    {
      oneOf: [
        object({
          prefix: string,
          startingNumber: { type: "integer", minimum: 1, maximum: 999999 },
        }),
        { type: "array", items: { type: "string", enum: ["NGN", "USD"] } },
        object({
          applicationEmail: { type: "boolean" },
          documentEmail: { type: "boolean" },
        }),
      ],
    },
  ],
  [
    "post",
    "/admin/messages/{threadId}",
    "Reply to student",
    object({ body: string }),
  ],
];
mutations.push(
  [
    "post",
    "/admin/consultations/{id}/cancel",
    "Cancel a consultation and release its slot",
    object({ reason: string }),
  ],
  [
    "patch",
    "/admin/consultations/{id}/reschedule",
    "Move consultation to an available slot",
    object({ slotId: uuid }),
  ],
);
for (const name of ["media", "advisors"])
  endpoint("get", "/admin/" + name, "Role-checked " + name, undefined, true);
endpoint(
  "delete",
  "/admin/media/{id}",
  "Queue public media deletion",
  undefined,
  true,
);
openapi.paths["/files/upload-url"].post.requestBody.content[
  "application/json"
].schema.properties.ownerId = uuid;
openapi.paths["/payments/initialize"].post.parameters.push({
  name: "Idempotency-Key",
  in: "header",
  required: true,
  schema: uuid,
});
for (const path of [
  "/payments/verify/{reference}",
  "/payments/{reference}/retry",
  "/payments/{reference}/receipt",
]) {
  const operation = Object.values(openapi.paths[path])[0] as any;
  operation.security = [{ cookieAuth: [] }, { paymentToken: [] }];
}
for (const [method, path, title, body] of mutations)
  endpoint(method, path, title, body, true);
endpoint(
  "get",
  "/portal/applications/{id}",
  "Own application and history",
  undefined,
  true,
);
endpoint(
  "delete",
  "/portal/documents/{id}",
  "Request deletion of own file",
  undefined,
  true,
);
endpoint(
  "delete",
  "/admin/users/{id}",
  "Deactivate staff account, preserve audit",
  undefined,
  true,
);
for (const name of ["consultation-slots", "faqs"])
  endpoint("get", "/public/" + name, "Public " + name);
for (const [path, methods] of Object.entries(openapi.paths) as [
  string,
  any,
][]) {
  for (const [method, operation] of Object.entries(methods) as [
    string,
    any,
  ][]) {
    if (
      ["post", "patch", "put", "delete"].includes(method) &&
      !path.includes("/webhook/")
    )
      operation.parameters.push(
        { name: "X-CSRF-Token", in: "header", required: true, schema: string },
        {
          name: "Origin",
          in: "header",
          required: true,
          schema: { type: "string", format: "uri" },
        },
      );
    if (
      method === "get" &&
      !["/auth/csrf", "/auth/session"].includes(path) &&
      !path.includes("{")
    )
      operation.parameters.push(
        { name: "skip", in: "query", schema: { type: "integer", default: 0 } },
        {
          name: "take",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 100, default: 25 },
        },
      );
  }
}

endpoint('get','/public/admission-programmes','Available pre-portal admission programmes');
endpoint('post','/public/applications','Submit admissions application without a student account',zodToJsonSchema(admissionSchema,{$refStrategy:'none',target:'openApi3'}));
openapi.paths['/public/applications'].post.parameters.push({name:'Idempotency-Key',in:'header',required:true,schema:uuid});
endpoint('get','/admin/applicants','Admissions intake list; applications read permission',undefined,true);
endpoint('patch','/admin/applicants/{id}/status','Review intake without creating a portal',object({status:{type:'string',enum:['UNDER_REVIEW','NEEDS_INFORMATION','ACCEPTED','REJECTED']},comment:{type:'string',minLength:1,maxLength:2000}}),true);
