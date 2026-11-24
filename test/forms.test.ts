import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAnswers, formSchema, registrationForm, newReference, visibleTo, windowState, type Form } from "../src/forms.js";

const form: Form = formSchema.parse({
  title: "Course choice",
  fields: [
    { id: "name", type: "short", label: "Name", required: true },
    { id: "age", type: "number", label: "Age" },
    { id: "born", type: "date", label: "Date of birth" },
    { id: "mail", type: "email", label: "Email" },
    { id: "tel", type: "phone", label: "Phone" },
    { id: "course", type: "dropdown", label: "Course", required: true, options: ["Medicine", "Law"] },
    { id: "sports", type: "multiple", label: "Sports", options: ["Football", "Chess", "Tennis"] },
    { id: "pic", type: "photo", label: "Photo", required: true },
  ],
});

test("the built-in registration form passes the same rules as any form", () => {
  const { system, ...rest } = registrationForm;
  assert.equal(system, true);
  assert.doesNotThrow(() => formSchema.parse(rest));
  const steps = [...new Set(registrationForm.fields.map((f) => f.step))];
  assert.deepEqual(steps, ["Personal details", "Contact", "Parent or guardian", "Course and previous school", "Passport photo"]);
});

test("a draft keeps valid answers, drops invalid ones and does not demand required fields", () => {
  const { answers, errors } = checkAnswers(form, { name: "  Ada  ", age: "abc", course: "Medicine", sports: ["Chess", "Chess"], extra: "ignored" }, false);
  assert.deepEqual(answers, { name: "Ada", course: "Medicine", sports: ["Chess"] });
  assert.deepEqual(Object.keys(errors), ["age"]);
});

test("submitting checks every type and every required field", () => {
  const { errors } = checkAnswers(form, { age: "12.5", born: "2026-02-31x", mail: "not-mail", tel: "12", course: "Dancing", sports: ["Swimming"], pic: "not-an-id" }, true);
  assert.deepEqual(Object.keys(errors).sort(), ["born", "course", "mail", "name", "pic", "sports", "tel"]);
  assert.match(errors.name, /required/); assert.match(errors.mail, /email/); assert.match(errors.course, /listed options/);
  const ok = checkAnswers(form, { name: "Ada", course: "Law", pic: "11111111-1111-4111-8111-111111111111", tel: "+234 803 123 4567", born: "2008-05-01" }, true);
  assert.deepEqual(ok.errors, {});
});

test("the builder rejects choice fields with fewer than two or repeated choices, and repeated field ids", () => {
  assert.throws(() => formSchema.parse({ title: "x", fields: [{ id: "a", type: "single", label: "Pick", options: ["Yes"] }] }), /at least two choices/);
  assert.throws(() => formSchema.parse({ title: "x", fields: [{ id: "a", type: "dropdown", label: "Pick", options: ["Yes", "yes"] }] }), /same choice twice/);
  assert.throws(() => formSchema.parse({ title: "x", fields: [{ id: "a", type: "short", label: "A" }, { id: "a", type: "short", label: "B" }] }), /same id/);
  assert.throws(() => formSchema.parse({ title: "x", fields: [{ id: "a", type: "short", label: "A" }], opensAt: "2026-12-02T08:00:00.000Z", closesAt: "2026-12-01T08:00:00.000Z" }), /after the opening/);
});

test("audience and open/close window", () => {
  const f = { ...form, published: true, cohort: "SS3 2026" };
  assert.equal(visibleTo(f, "SS3 2026"), true); assert.equal(visibleTo(f, "SS2 2026"), false);
  assert.equal(visibleTo({ ...f, cohort: "" }, null), true); assert.equal(visibleTo({ ...f, published: false }, "SS3 2026"), false);
  const now = Date.parse("2026-11-24T09:00:00Z");
  assert.equal(windowState({ ...f, opensAt: "2026-11-25T08:00:00.000Z" }, now), "NOT_OPEN");
  assert.equal(windowState({ ...f, closesAt: "2026-11-24T08:00:00.000Z" }, now), "CLOSED");
  assert.equal(windowState(f, now), "OPEN");
});

test("references are short, readable and different each time", () => {
  const refs = Array.from({ length: 200 }, newReference);
  for (const r of refs) assert.match(r, /^NWP-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
  assert.equal(new Set(refs).size, 200);
});
