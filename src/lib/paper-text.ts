/**
 * Pure helpers for the whole-paper reader: splitting extracted PDF text
 * into sections, searching, and bounding sizes. No I/O, fully testable.
 */

/** Known academic section headings (case-insensitive match). */
const SECTION_KEYWORDS = [
  "abstract",
  "introduction",
  "background",
  "related work",
  "method",
  "methods",
  "approach",
  "methodology",
  "experiments",
  "experimental setup",
  "results",
  "discussion",
  "conclusion",
  "conclusions",
  "limitations",
  "acknowledgements",
  "appendix",
  "references",
];

export const MAX_SECTIONS = 12;
export const MAX_SECTION_CHARS = 14_000;
export const MAX_TOTAL_CHARS = 60_000;

function isHeading(line: string): boolean {
  const t = line.trim();
  if (t.length < 2 || t.length > 80) return false;
  const lower = t.toLowerCase().replace(/[:\s]+$/, "");
  // Keyword headings: the keyword alone, "Keyword:", or "Keyword (x)".
  // A sentence that merely STARTS with a keyword ("Results show that...")
  // is not a heading.
  if (
    SECTION_KEYWORDS.some(
      (k) => lower === k || lower.startsWith(`${k}:`) || lower.startsWith(`${k} (`),
    )
  ) {
    return true;
  }
  // Numbered headings: "1. Introduction", "3.2 Experiments", "1 Introduction"
  if (/^\d+(\.\d+)*\.?\s+[A-Za-z]/.test(t)) return true;
  // Short title-case lines that look like headings (e.g. "Our Approach")
  if (/^[A-Z][A-Za-z &/-]{2,40}$/.test(t) && !t.endsWith(".")) return true;
  return false;
}

/**
 * Splits extracted paper text into sections on heading-like lines.
 * Sections are hard-capped by size (paragraph breaks) and count.
 */
export function splitIntoSections(text: string): string[] {
  const lines = text.split("\n");
  const sections: string[] = [];
  let current: string[] = [];

  const flush = () => {
    const joined = current.join("\n").trim();
    if (joined.length > 0) sections.push(joined);
    current = [];
  };

  for (const line of lines) {
    if (isHeading(line) && current.length > 0 && sections.length < MAX_SECTIONS) {
      flush();
    }
    current.push(line);
  }
  flush();

  // Hard-split any section that is still too big (no headings inside).
  const result: string[] = [];
  for (const section of sections) {
    if (section.length <= MAX_SECTION_CHARS) {
      result.push(section);
      continue;
    }
    const paragraphs = section.split(/\n\s*\n/);
    let bucket = "";
    for (let paragraph of paragraphs) {
      // A single paragraph larger than the cap is cut into MAX-sized
      // chunks so no section can exceed the limit.
      while (paragraph.length > MAX_SECTION_CHARS) {
        const cut = Math.min(paragraph.length, MAX_SECTION_CHARS);
        const space = paragraph.lastIndexOf(" ", cut);
        const boundary = space > MAX_SECTION_CHARS / 2 ? space : cut;
        let piece = paragraph.slice(0, boundary).trim();
        if (piece.length === 0) piece = paragraph.slice(0, cut);
        if (bucket.length > 0 && bucket.length + piece.length > MAX_SECTION_CHARS) {
          result.push(bucket.trim());
          bucket = "";
        }
        if (bucket.length > 0) bucket += "\n\n";
        bucket += piece;
        if (bucket.length > MAX_SECTION_CHARS) {
          result.push(bucket.trim());
          bucket = "";
        }
        paragraph = paragraph.slice(boundary).trim();
      }
      if (paragraph.length === 0) continue;
      if (bucket.length + paragraph.length > MAX_SECTION_CHARS && bucket.length > 0) {
        result.push(bucket.trim());
        bucket = paragraph;
      } else {
        bucket += `\n\n${paragraph}`;
      }
    }
    if (bucket.trim().length > 0) result.push(bucket.trim());
  }

  return result.slice(0, MAX_SECTIONS);
}

/** Case-insensitive occurrence count of `query` in `text`. */
export function countMatches(text: string, query: string): number {
  if (!query.trim()) return 0;
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  let count = 0;
  let idx = lower.indexOf(needle);
  while (idx >= 0) {
    count += 1;
    idx = lower.indexOf(needle, idx + needle.length);
  }
  return count;
}

/** Truncates the middle of a long string, keeping the head and tail. */
export function truncateMiddle(text: string, max = 200): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 1) / 2);
  return `${text.slice(0, half)}…${text.slice(text.length - half)}`;
}

/**
 * Finds the section containing the selected passage (used to ground
 * "ask about this selection" answers). Falls back to the first section.
 */
export function findContextSection(sections: string[], selection: string): string {
  const needle = selection.trim();
  if (needle.length >= 20) {
    const found = sections.find((s) => s.includes(needle.slice(0, 120)));
    if (found) return found;
  }
  return sections[0] ?? "";
}

/** Caps the total paper text passed to a synthesis call. */
export function capTotal(text: string, max = MAX_TOTAL_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…\n[text truncated]`;
}
