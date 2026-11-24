import { test } from "node:test";
import assert from "node:assert/strict";
import PDFDocument from "pdfkit";
import { pdfLines, questionsFromText, rowsFromPdfQuestions, withoutRunningHeads } from "../src/pdf-questions.js";
import { questionsFromRows, checkPdfQuestions } from "../src/mock-exams.js";

/** Builds a real PDF whose lines are drawn exactly as given (a line may hold several columns). */
function makePdf(lines: (string | string[])[]): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const parts: Buffer[] = [];
    doc.on("data", (b) => parts.push(b)); doc.on("end", () => resolve(Buffer.concat(parts)));
    doc.font("Helvetica").fontSize(11);
    let y = 60;
    for (const line of lines) {
      if (y > 780) { doc.addPage(); y = 60; }
      if (Array.isArray(line)) line.forEach((t, i) => doc.text(t, 60 + i * 120, y, { lineBreak: false }));
      else doc.text(line, 60, y, { lineBreak: false });
      y += 18;
    }
    doc.end();
  });
}

test("reads numbered questions, options on their own lines and answers under each question", async () => {
  const pdf = await makePdf(["SS3 Mathematics Test", "Answer all questions.", "1. What is 7 x 8?", "A. 54", "B. 56", "C. 58", "D. 64", "Answer: B", "2. Which is a prime number?", "(a) 9", "(b) 15", "(c) 17", "(d) 21", "Ans: C", "Marks: 2", "1"]);
  const lines = await pdfLines(pdf);
  const { questions, skipped } = questionsFromText(lines);
  assert.equal(questions.length, 2);
  assert.deepEqual(questions[0], { number: 1, prompt: "What is 7 x 8?", options: ["54", "56", "58", "64"], answer: "B", marks: "", passage: "", notes: [] });
  assert.deepEqual(questions[1].options, ["9", "15", "17", "21"]);
  assert.equal(questions[1].answer, "C"); assert.equal(questions[1].marks, "2");
  assert.deepEqual(skipped, ["SS3 Mathematics Test Answer all questions."]);
});

test("options side by side on one line, and an answer key at the end", async () => {
  const pdf = await makePdf(["1. The capital of Nigeria is", ["A. Lagos", "B. Abuja", "C. Kano", "D. Ibadan"], "2. 10 + 5 =", ["A. 15", "B. 20"], "", "ANSWER KEY", "1. B   2. A"]);
  const { questions } = questionsFromText(await pdfLines(pdf));
  assert.deepEqual(questions.map((q) => [q.prompt, q.options, q.answer]), [["The capital of Nigeria is", ["Lagos", "Abuja", "Kano", "Ibadan"], "B"], ["10 + 5 =", ["15", "20"], "A"]]);
});

test("a question and its options on a single line", () => {
  const { questions } = questionsFromText(["3. Pick the noun: A. run B. table C. quickly", "Answer: B"]);
  assert.deepEqual([questions[0].number, questions[0].prompt, questions[0].options, questions[0].answer], [3, "Pick the noun:", ["run", "table", "quickly"], "B"]);
});

test("wrapped question text and wrapped options are joined, not lost", () => {
  const { questions } = questionsFromText(["1. Which of these statements about the water cycle", "is correct?", "A. Evaporation turns vapour", "into ice", "B. Condensation forms clouds", "C. Rain is", "Not part of it", "D. None", "Answer: B"]);
  assert.equal(questions[0].prompt, "Which of these statements about the water cycle is correct?");
  assert.deepEqual(questions[0].options, ["Evaporation turns vapour into ice", "Condensation forms clouds", "Rain is Not part of it", "None"]);
});

test("a passage applies to the questions after it until the next heading", () => {
  const { questions, skipped } = questionsFromText(["Read the passage below and answer questions 1 and 2.", "Ada smiled all the way to school.", "1. How did Ada feel?", "A. Sad", "B. Happy", "2. Where was she going?", "A. School", "B. Market", "Answer key", "1. B 2. A", "SECTION B: MATHEMATICS", "1. 2 + 2 =", "A. 3", "B. 4", "Answers", "1. A"]);
  assert.equal(questions[0].passage, "Read the passage below and answer questions 1 and 2. Ada smiled all the way to school.");
  assert.equal(questions[1].passage, questions[0].passage);
  assert.equal(questions[2].passage, "");
  assert.deepEqual(skipped, ["SECTION B: MATHEMATICS"]);
  assert.deepEqual(questions.map((q) => q.answer), ["B", "A", "A"], "each answer key fills only its own section");
});

test("problems are shown in the preview, not guessed: missing answer, one option, repeated number", () => {
  const { questions } = questionsFromText(["1. No answer here", "A. x", "B. y", "2. Only one choice", "A. x", "Answer: A", "2. Repeated", "A. p", "B. q", "Answer: Z"]);
  const rows = questionsFromRows(rowsFromPdfQuestions(questions));
  assert.match(rows[0].problems.join(" "), /answer letter is missing/);
  assert.match(rows[1].problems.join(" "), /at least two choices/);
  assert.equal(questions[2].answer, "", "Z is not a choice letter, so no answer is taken");
  assert.match(questions[2].notes.join(" "), /appears more than once/);
});

test("rejects files that are not PDFs and PDFs without text", async () => {
  await assert.rejects(pdfLines(Buffer.from("hello")), (e: any) => e.code === "NOT_PDF");
  const blank = await makePdf([]);
  await assert.rejects(pdfLines(blank), (e: any) => e.code === "PDF_NO_TEXT");
});

test("a heading repeated at the top of every page is dropped, but repeated choices are kept", () => {
  const lines = withoutRunningHeads([["SS3 STUDENT COPY", "1. First?", "A. 4", "B. 5"], ["SS3 STUDENT COPY", "2. Second?", "A. 4", "B. 5"]]);
  assert.deepEqual(lines, ["1. First?", "A. 4", "B. 5", "2. Second?", "A. 4", "B. 5"]);
});

test("a passage after a section heading is found; the heading itself is reported as skipped", () => {
  const { questions, skipped } = questionsFromText(["ENGLISH - SECTION A: COMPREHENSION", "Read the passage carefully and answer Questions 1 to 2.", "Ada smiled.", "1. How did Ada feel?", "A. Sad", "B. Happy"]);
  assert.equal(questions[0].passage, "Read the passage carefully and answer Questions 1 to 2. Ada smiled.");
  assert.deepEqual(skipped, ["ENGLISH - SECTION A: COMPREHENSION"]);
});

test("a student copy without answers still imports, with the answer left for the teacher to tick", () => {
  const { questions } = questionsFromText(["1. 2 + 2 =", "A. 3", "B. 4", "2. Refer to the triangle shown. Find AC.", "A. 8 cm", "B. 10 cm", "3. Only one", "A. x"]);
  const checked = checkPdfQuestions(questions);
  assert.equal(checked[0].question?.answer, null); assert.deepEqual(checked[0].question?.options, ["3", "4"]);
  assert.match(checked[0].warnings.join(" "), /tick the correct answer/);
  assert.match(checked[1].warnings.join(" "), /add the picture/);
  assert.equal(checked[2].question, null); assert.match(checked[2].problems.join(" "), /at least two choices/);
  assert.deepEqual(checked.map((c) => c.row), [1, 2, 3]);
});
