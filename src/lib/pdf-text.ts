// Vite resolves this to the worker asset URL; pdf.js needs a worker to
// parse PDFs off the main thread.
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

let workerConfigured = false;

/** The parts of a pdf.js text item this module reads. */
interface TextItem {
  str: string;
  /** [scaleX, skewY, skewX, scaleY, x, y] — the text matrix. */
  transform?: number[];
  width?: number;
  hasEOL?: boolean;
}

/** An item with its geometry resolved: baseline origin plus the text. */
interface Positioned {
  str: string;
  x: number;
  y: number;
  width: number;
  /** True when pdf.js flagged the item as the end of a line. */
  hasEOL: boolean;
}

/** Vertical tolerance (PDF units) for treating items as the same line. */
const LINE_TOLERANCE = 2.5;

/** A heading line spans the page: no column-sized gap between its items. */
const COLUMN_GAP = 50;

/** Minimum share of page height a body column must span (see below). */
const TALL_COLUMN_SHARE = 0.25;

/**
 * True when both sides of `splitAt` run down a real fraction of the page
 * height.
 *
 * Without this, a title page's author grid passes every other test:
 * authors sit in evenly spaced cells across the top, which is a second
 * well-separated cluster of origins on several lines. Reading that
 * column-major reorders the byline and repeats shared affiliations. Body
 * columns, by contrast, span most of the page, so requiring each side to
 * cover a quarter of the page height separates the two cases.
 */
function isTallColumn(lines: Positioned[][], splitAt: number): boolean {
  const ys = lines.map((line) => line[0].y);
  const top = Math.max(...ys);
  const bottom = Math.min(...ys);
  const pageHeight = top - bottom;
  if (pageHeight <= 0) return false;

  const span = (predicate: (x: number) => boolean): number => {
    // "Has an item on this side", not "starts on this side": in a
    // two-column body every line STARTS in the left column and also
    // carries a right-column item, so testing line[0] would measure the
    // right column as empty and reject real body pages.
    const side = lines.filter((line) => line.some((i) => predicate(i.x))).map((l) => l[0].y);
    if (side.length === 0) return 0;
    return Math.max(...side) - Math.min(...side);
  };
  const leftSpan = span((x) => x < splitAt - 20);
  const rightSpan = span((x) => x >= splitAt);
  return leftSpan >= pageHeight * TALL_COLUMN_SHARE && rightSpan >= pageHeight * TALL_COLUMN_SHARE;
}

/**
 * True when a line's items form one contiguous run rather than two
 * columns side by side. A body line in a two-column paper has a
 * column-wide gap between its left and right item; a full-width heading
 * (the paper title, a section head) has no such gap.
 */
function isContiguousLine(line: Positioned[]): boolean {
  if (line.length < 2) return true;
  for (let i = 1; i < line.length; i += 1) {
    const previous = line[i - 1];
    const gap = line[i].x - (previous.x + previous.width);
    if (gap > COLUMN_GAP) return false;
  }
  return true;
}

/**
 * Typographic characters that carry no meaning for the AI but wreck
 * word-level search: the fi/fl ligatures PDF text layers emit as single
 * code points, and the curly quotes and dashes a paper is typeset with.
 * Folding them makes "definition" findable in both the reader's search
 * and the extracted text.
 */
const CHARACTER_FOLDING: [RegExp, string][] = [
  [/ﬀ/g, "ff"],
  [/ﬁ/g, "fi"],
  [/ﬂ/g, "fl"],
  [/ﬃ/g, "ffi"],
  [/ﬄ/g, "ffl"],
  [/ﬅ|ﬆ/g, "st"],
  [/[‘’‚‛′]/g, "'"],
  [/[“”„‟″]/g, '"'],
  [/[‐‑‒–—―−]/g, "-"],
  [/[\u00a0\u2007\u202f]/g, " "],
];

/** Folds ligatures, curly quotes and exotic dashes to ASCII. */
export function foldCharacters(text: string): string {
  let out = text;
  for (const [pattern, replacement] of CHARACTER_FOLDING) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Resolves an item's geometry, tolerating a malformed one. */
function position(item: TextItem): Positioned | null {
  const str = typeof item.str === "string" ? item.str : "";
  if (!str.trim()) return null;
  const transform = Array.isArray(item.transform) ? item.transform : null;
  const x = transform && transform.length >= 6 ? (transform[4] as number) : 0;
  const y = transform && transform.length >= 6 ? (transform[5] as number) : 0;
  return {
    str,
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
    width: typeof item.width === "number" && Number.isFinite(item.width) ? item.width : 0,
    hasEOL: item.hasEOL === true,
  };
}

/** Groups items into visual lines, top to bottom. */
function groupIntoLines(items: Positioned[]): Positioned[][] {
  if (items.length === 0) return [];
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Positioned[][] = [];
  let current: Positioned[] = [sorted[0]];
  let baseline = sorted[0].y;
  for (const item of sorted.slice(1)) {
    if (Math.abs(item.y - baseline) <= LINE_TOLERANCE) {
      current.push(item);
    } else {
      lines.push(current);
      current = [item];
      baseline = item.y;
    }
  }
  lines.push(current);
  // Within a line, reading order is left to right.
  return lines.map((line) => [...line].sort((a, b) => a.x - b.x));
}

/**
 * Detects a two-column body: a second well-separated cluster of item
 * origins carrying text on a decent share of lines. Papers in the
 * two-column style emit both columns at the same baseline, so ordering
 * by y alone interleaves them ("left line 1, right line 1, left line 2,
 * ..") and the AI is handed sentences spliced into an unrelated one.
 *
 * Returns the x threshold separating the columns, or null for a
 * single-column page.
 */
function detectColumnSplit(lines: Positioned[][]): number | null {
  // Only body lines are evidence: a full-width title is one line, not a
  // column pair.
  const xs = lines.filter((line) => line.length >= 2).map((line) => line[0].x);
  if (xs.length < 4) return null;
  // The page's left margin is the most common origin by far.
  const sortedXs = [...xs].sort((a, b) => a - b);
  const leftMargin = sortedXs[Math.floor(sortedXs.length / 4)];

  // Candidate column starts: origins well right of the left margin.
  const candidates = new Map<number, number>();
  for (const line of lines) {
    for (const item of line) {
      if (item.x - leftMargin < 80) continue;
      const key = Math.round(item.x / 10) * 10;
      candidates.set(key, (candidates.get(key) ?? 0) + 1);
    }
  }
  let best: { x: number; count: number } | null = null;
  for (const [x, count] of candidates) {
    if (count < 3) continue;
    if (!best || count > best.count) best = { x, count };
  }
  if (!best) return null;
  const splitAt = best.x;
  // The tall-box gate. A title page lays authors out in a grid, which
  // looks exactly like columns to any x-based test, and reading it
  // column-major reorders the byline and duplicates affiliations. Real
  // body columns run most of the page height; an author grid does not.
  // Both sides must be tall, or fall back to positional order (which is
  // the correct reading for a title page anyway).
  if (!isTallColumn(lines, splitAt)) return null;
  // Both columns must carry text on a decent share of the lines.
  const leftCount = lines.filter((line) => line.some((i) => i.x < splitAt - 20)).length;
  const rightCount = lines.filter((line) => line.some((i) => i.x >= splitAt)).length;
  if (leftCount < 3 || rightCount < 3) return null;
  // A tiny "right column" is an indented pull quote or list, not a
  // second column of prose.
  if (rightCount < lines.length / 3) return null;
  return splitAt;
}

/**
 * Builds readable text from one page's pdf.js text items: real heading
 * lines, two-column papers in column order, de-hyphenated line wraps,
 * and folded ligatures.
 *
 * Pure and exported for testing: this is the quality surface of every AI
 * feature in the reader (the walkthrough's sections and the chat's
 * grounding both read its output), so it must be verifiable without
 * loading a real PDF.
 */
export function buildReadableText(items: TextItem[]): string {
  const positioned = items.map(position).filter((p): p is Positioned => p !== null);
  if (positioned.length === 0) return "";

  const lines = groupIntoLines(positioned);
  const splitAt = detectColumnSplit(lines);

  let ordered: string[];
  if (splitAt === null) {
    ordered = lines.map(joinLine);
  } else {
    // Read the left column top to bottom, then the right one. Lines
    // that straddle the threshold (a full-width heading) come first, in
    // y order, so the paper's title is not filed under a column.
    const fullWidth: { y: number; text: string }[] = [];
    const left: { y: number; text: string }[] = [];
    const right: { y: number; text: string }[] = [];
    for (const line of lines) {
      // Split the line's ITEMS, not the line itself. A body line in a
      // two-column page has one item per column at the same baseline:
      // classifying whole lines put every one of them in the left column
      // and left the right column empty.
      const leftItems = line.filter((i) => i.x < splitAt - 20);
      const rightItems = line.filter((i) => i.x >= splitAt);
      // A heading that reaches across the gap (a paper title, a
      // full-width section head) belongs to neither column. Continuity
      // is the signal: a body line's left and right items are separated
      // by a column-wide gap, a title's words are not.
      if (leftItems.length > 0 && rightItems.length > 0 && isContiguousLine(line)) {
        fullWidth.push({ y: line[0].y, text: joinLine(line) });
        continue;
      }
      if (leftItems.length > 0) left.push({ y: line[0].y, text: joinLine(leftItems) });
      if (rightItems.length > 0) right.push({ y: line[0].y, text: joinLine(rightItems) });
    }
    fullWidth.sort((a, b) => b.y - a.y);
    ordered = [
      ...fullWidth.map((l) => l.text),
      ...left.map((l) => l.text),
      ...right.map((l) => l.text),
    ];
  }

  return dropBoilerplate(joinWrappedLines(ordered));
}

/**
 * Strips page furniture that is not part of the paper's content: bare
 * page numbers, standalone email addresses, and arXiv's licence stamp.
 *
 * These are not cosmetic. Section splitting is capped at MAX_SECTIONS,
 * so on a typical arXiv paper the licence notice, the byline and the
 * author emails consumed three of a dozen slots and the walkthrough ran
 * out of budget before Training, Results and Conclusion — the sections
 * users most want explained. Content the user cannot explain from is
 * also content the model should not be asked to explain.
 */
function dropBoilerplate(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t) return true;
      // A bare page number: "1", "12", "iv".
      if (/^\d{1,4}$/.test(t)) return false;
      // A single email address, with or without a trailing comma.
      if (/^[\w.+-]+@[\w-]+\.[\w.]+[,;]?$/.test(t)) return false;
      // arXiv's permission notice, which is on the title page verbatim.
      if (t.startsWith("Provided proper attribution is provided")) return false;
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Joins one visual line's items left to right. */
function joinLine(line: Positioned[]): string {
  return foldCharacters(
    line
      .map((item) => item.str)
      .join(" ")
      .replace(/[ \t]{2,}/g, " ")
      .trim(),
  );
}

/**
 * Re-joins words split across a line break ("transforma-" / "tion") and
 * folds prose lines together, while keeping each heading on its own line
 * and ending the block it introduced: the section splitter needs headings
 * findable, and the AI reads a heading as a heading rather than as the
 * first words of the paragraph beneath it.
 */
function joinWrappedLines(lines: string[]): string {
  const blocks: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // A heading always starts a block, and it also ENDS the block it
    // opens: the prose beneath it must not be glued to the heading, or
    // the section splitter sees "1. Introduction Transformers rely on
    // ..." and the heading is never a heading again.
    if (blocks.length === 0 || isBlockHeading(line) || isBlockHeading(lastLineOf(blocks))) {
      blocks.push(line);
      continue;
    }
    const previous = lastLineOf(blocks);
    // Hyphenation: a trailing "-" continues the word, never a space.
    blocks[blocks.length - 1] = /[A-Za-z]-$/.test(previous)
      ? `${previous.slice(0, -1)}${line}`
      : `${previous} ${line}`;
  }
  return blocks.join("\n\n").trim();
}

/** The trailing line of the current block (blocks hold folded prose). */
function lastLineOf(blocks: string[]): string {
  return blocks[blocks.length - 1];
}

/**
 * True for a line that should start its own block, i.e. a heading.
 *
 * Deliberately stricter than the section splitter's own heuristic:
 * here a false positive splits a sentence away from its paragraph, and
 * a false negative merely leaves two paragraphs merged. A prose line
 * ("Transformers rely on ...") fails because it carries lowercase words
 * and ends without a period, and a real heading either is numbered or
 * is Title Case with every significant word capitalised.
 */
function isBlockHeading(line: string): boolean {
  const t = line.trim();
  if (t.length < 2 || t.length > 80) return false;
  // Numbered: "1. Introduction", "3.2 Experiments", "1 Introduction".
  if (/^\d+(\.\d+)*\.?\s+[A-Za-z]/.test(t)) return true;
  // Prose is not a heading: a heading carries no sentence punctuation
  // and no lowercase function words.
  if (/[.,;:]$/.test(t)) return false;
  const words = t.split(/\s+/);
  if (words.length > 6) return false;
  const significant = words.filter((w) => w.length > 3);
  if (significant.length === 0) return false;
  return significant.every((w) => /^[A-Z]/.test(w));
}

/**
 * Extracts plain text from PDF bytes with pdf.js (one page per call to
 * `buildReadableText`, pages joined with blank lines). Used by the reader
 * to build the section walkthrough and the grounded chat.
 *
 * pdf.js is a ~350 kB dependency and the reader store imports this module
 * eagerly, so a static top-level import put it in the startup bundle: the
 * app paid for (and parsed) the whole parser before the user opened a
 * single paper. Loading it on first use keeps startup lean and moves the
 * cost to the reader, which needs it anyway. The viewer lazy-loads the
 * same module, so the browser caches it across both paths.
 */
export async function extractTextFromPdf(bytes: Uint8Array): Promise<string> {
  const pdfjsLib = await import("pdfjs-dist");
  if (!workerConfigured) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
    workerConfigured = true;
  }

  const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  const pages: string[] = [];
  try {
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum += 1) {
      const page = await doc.getPage(pageNum);
      const content = await page.getTextContent();
      // Reconstruct the page, do not concatenate its items: joining them
      // with spaces and collapsing all whitespace turned every page into
      // one line, so no heading was ever detectable and the walkthrough
      // fell back to cutting the paper at arbitrary character counts.
      const text = buildReadableText(content.items as TextItem[]);
      if (text) pages.push(text);
    }
  } finally {
    await doc.cleanup();
  }
  return pages.join("\n\n");
}
