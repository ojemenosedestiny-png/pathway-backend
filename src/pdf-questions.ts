import { fail } from "./core.js";

/**
 * PDF question import without AI: the PDF's own text is read line by line and matched against a
 * simple layout. Nothing is guessed or rewritten; anything that does not fit is reported in the preview.
 *
 *   1. Question text (may run over several lines)
 *   A. option   B. option        (one per line, or several on one line)
 *   Answer: B                    (or an "Answer key" section at the end: 1. B  2. C ...)
 *   Marks: 2                     (optional, default 1)
 *
 * A block of text that starts with "Passage", "Read the passage" or "Comprehension" becomes the
 * passage for the questions that follow it, until the next heading.
 */

const PAGE_NUMBER = /^(page\s*)?\d+(\s*(of|\/)\s*\d+)?$/i;
const QUESTION = /^(?:q(?:uestion)?\s*\.?\s*)?(\d{1,3})\s*[.):]\s*(.*)$/i;
const OPTION_START = /^\(?([A-Ha-h])\s*[.)]\s+/;
const OPTION_SPLIT = /\s+(?=\(?[A-H]\s*[.)]\s)/;
const ANSWER = /^(?:ans(?:wer)?|correct\s+answer|correct\s+option|key)\s*[:.\-=]?\s*\(?([A-Ha-h])\)?\s*\.?$/i;
const MARKS = /^\[?\(?\s*(?:marks?\s*[:\-=]?\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*marks?)\s*\)?\]?$/i;
const KEY_HEADING = /^(answer\s*key|answers|marking\s*scheme|key\s*to\s*(the\s*)?questions|solutions?)\s*:?$/i;
const KEY_PAIR = /(\d{1,3})\s*[.):\-=]?\s*\(?([A-H])\)?(?![A-Za-z])/g;
const PASSAGE_START = /^(passage\b|read\s+the\s+(following\s+)?passage|comprehension\b)/i;

/** Reads the text of every page, rebuilt into lines in reading order. */
export async function pdfLines(pdf: Buffer): Promise<string[]> {
  if (pdf.length < 5 || pdf.subarray(0, 5).toString("latin1") !== "%PDF-") fail(415, "NOT_PDF", "Upload a PDF question paper.");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  let doc: any;
  try {
    doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
  } catch (error: any) {
    if (error?.name === "PasswordException") fail(422, "PDF_LOCKED", "This PDF is password-protected. Remove the password and try again.");
    fail(422, "PDF_UNREADABLE", "This PDF could not be read. Save it again as a PDF, or use the Excel template.");
  }
  if (doc.numPages > 60) fail(422, "PDF_TOO_LONG", "Import at most 60 pages at a time. Split the paper into two PDFs.");
  const pages: string[][] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const lines: string[] = [];
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const items = (content.items as any[]).filter((i) => typeof i.str === "string" && i.str.trim()).map((i) => ({ text: i.str as string, x: i.transform[4] as number, y: i.transform[5] as number, w: (i.width as number) || 0, h: Math.abs(i.transform[3] as number) || 10 }));
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const rows: (typeof items)[] = [];
    for (const item of items) {
      const row = rows[rows.length - 1];
      if (row && Math.abs(row[0].y - item.y) <= Math.max(2, row[0].h * 0.4)) row.push(item); else rows.push([item]);
    }
    for (const row of rows) {
      row.sort((a, b) => a.x - b.x);
      let text = "", end = -Infinity;
      for (const item of row) { if (text && item.x - end > item.h * 0.15 && !text.endsWith(" ") && !item.text.startsWith(" ")) text += " "; text += item.text; end = item.x + item.w; }
      const clean = text.replace(/\s+/g, " ").trim();
      if (clean && !PAGE_NUMBER.test(clean)) lines.push(clean);
    }
    page.cleanup();
    pages.push(lines);
  }
  await doc.destroy();
  const lines = withoutRunningHeads(pages);
  if (!lines.length) fail(422, "PDF_NO_TEXT", "This PDF has no text that can be read. It may be a scanned picture. Use the Excel template, or a PDF saved from Word.");
  return lines;
}

/** Removes a heading or footer repeated at the top or bottom of two or more pages (never a question, choice or answer line). */
export function withoutRunningHeads(pages: string[][]): string[] {
  const edges = (page: string[]) => [...new Set([...page.slice(0, 2), ...page.slice(-2)])];
  const count = new Map<string, number>();
  for (const page of pages) for (const line of edges(page)) count.set(line, (count.get(line) || 0) + 1);
  const running = (line: string) => (count.get(line) || 0) >= 2 && !QUESTION.test(line) && !OPTION_START.test(line) && !ANSWER.test(line) && !KEY_HEADING.test(line);
  return pages.flatMap((page) => page.filter((line, i) => !((i < 2 || i >= page.length - 2) && running(line))));
}

export interface PdfQuestion { number: number; prompt: string; options: string[]; answer: string; marks: string; passage: string; notes: string[] }

/** Turns lines of text into questions. */
export function questionsFromText(lines: string[]): { questions: PdfQuestion[]; skipped: string[] } {
  const questions: PdfQuestion[] = [];
  let key = new Map<number, string>();
  let sectionStart = 0;
  const skipped: string[] = [];
  let current: PdfQuestion | null = null;
  let part: "prompt" | "options" | "done" = "prompt";
  let passage = "";
  let loose: string[] = [];
  let inKey = false;

  // An answer key fills in the questions of its own section only (numbering may restart in the next section).
  const applyKey = () => {
    for (const q of questions.slice(sectionStart)) if (!q.answer && key.has(q.number)) q.answer = key.get(q.number)!;
    key = new Map(); sectionStart = questions.length; inKey = false;
  };
  const settleLoose = () => {
    if (!loose.length) return;
    const start = loose.findIndex((l) => PASSAGE_START.test(l) || /\bpassage\b/i.test(l));
    const before = (start < 0 ? loose : loose.slice(0, start)).join(" ");
    if (before) skipped.push(before.length > 160 ? before.slice(0, 157) + "…" : before);
    passage = start < 0 ? "" : loose.slice(start).join(" ");
    loose = [];
  };
  const addOptions = (line: string) => {
    for (const piece of line.split(OPTION_SPLIT)) {
      const m = piece.match(OPTION_START);
      if (m && current) current.options.push(piece.slice(m[0].length).trim());
      else if (current?.options.length) current.options[current.options.length - 1] += " " + piece.trim();
    }
  };

  for (const line of lines) {
    if (KEY_HEADING.test(line)) { if (inKey) applyKey(); inKey = true; current = null; settleLoose(); continue; }
    if (inKey) {
      if (!line.replace(KEY_PAIR, "").replace(/[\s,;|.]/g, "")) { for (const m of line.matchAll(KEY_PAIR)) key.set(Number(m[1]), m[2].toUpperCase()); continue; }
      applyKey();
    }

    // Text between options (or before the answer line) was a wrapped option after all.
    const joinLoose = () => { if (current && part === "options" && loose.length && current.options.length) { current.options[current.options.length - 1] += " " + loose.join(" "); loose = []; } };
    const answer = line.match(ANSWER);
    if (answer && current) { joinLoose(); current.answer = answer[1].toUpperCase(); part = "done"; continue; }
    const marks = line.match(MARKS);
    if (marks && current) { joinLoose(); current.marks = marks[1] ?? marks[2]; continue; }

    const q = line.match(QUESTION);
    if (q && q[2].trim() && !OPTION_START.test(line)) {
      settleLoose();
      current = { number: Number(q[1]), prompt: q[2].trim(), options: [], answer: "", marks: "", passage, notes: [] };
      questions.push(current); part = "prompt";
      // "1. What is 2+2?  A. 3  B. 4" on a single line
      const inline = current.prompt.split(OPTION_SPLIT);
      if (inline.length > 1 && OPTION_START.test(inline[1])) { current.prompt = inline[0].trim(); addOptions(inline.slice(1).join(" ")); part = "options"; }
      continue;
    }
    if (current && part !== "done" && OPTION_START.test(line)) { joinLoose(); addOptions(line); part = "options"; continue; }
    if (current && part === "prompt") { current.prompt += " " + line; continue; }
    // A wrapped option continues in lower case or with punctuation; other text waits to see what follows.
    if (current && part === "options" && !loose.length && /^[a-z0-9(,;:)\-–]/.test(line)) { current.options[current.options.length - 1] += " " + line; continue; }
    loose.push(line);
  }
  settleLoose();
  applyKey();
  const seen = new Set<number>();
  for (const q of questions) { if (seen.has(q.number)) q.notes.push(`Question number ${q.number} appears more than once in the PDF.`); seen.add(q.number); }
  return { questions, skipped };
}

/** The same table the Excel import checks, so both imports share one set of rules. */
export function rowsFromPdfQuestions(questions: PdfQuestion[]): string[][] {
  const head = ["Question", "A", "B", "C", "D", "E", "F", "G", "H", "Answer", "Marks", "Passage"];
  const body = questions.map((q) => {
    const options = q.options.slice(0, 8);
    while (options.length < 8) options.push("");
    return [q.prompt, ...options, q.answer, q.marks, q.passage];
  });
  return [head, ...body];
}
