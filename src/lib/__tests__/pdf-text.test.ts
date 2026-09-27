// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { buildReadableText } from "@/lib/pdf-text";
import { splitIntoSections } from "@/lib/paper-text";

/** Builds a pdf.js text item: str plus the transform that places it. */
function item(
  str: string,
  x: number,
  y: number,
  opts: { hasEOL?: boolean; width?: number } = {},
): { str: string; transform: number[]; width: number; height: number; hasEOL: boolean } {
  return {
    str,
    // [scaleX, skewY, skewX, scaleY, x, y] — pdf.js's text matrix.
    transform: [1, 0, 0, 1, x, y],
    width: opts.width ?? str.length * 5,
    height: 10,
    hasEOL: opts.hasEOL ?? false,
  };
}

/**
 * A single-column page: a heading on its own baseline, body lines
 * beneath it, matching how a real paper is typeset (a heading never
 * shares a line with the paragraph it introduces).
 */
function singleColumnPage(): ReturnType<typeof item>[] {
  return [
    item("1. Introduction", 72, 700),
    item("Transformers rely on", 72, 686, { width: 120 }),
    item("self-attention.", 72, 674),
    item("2. Method", 72, 650),
    item("We stack six layers.", 72, 636),
  ];
}

describe("buildReadableText", () => {
  it("preserves line structure so headings survive", () => {
    // The old extractor joined every item with a space and collapsed all
    // whitespace, so a page became ONE line and no heading was ever
    // detectable — section splitting silently degraded to a raw cut-up.
    const text = buildReadableText(singleColumnPage());
    const lines = text.split("\n").filter((l) => l.trim());
    expect(lines).toContain("1. Introduction");
    expect(lines).toContain("2. Method");
    // A heading and the body beneath it are separate blocks, so the
    // section splitter sees a heading line rather than a heading glued
    // to the first sentence of its own section.
    expect(text).toContain("1. Introduction\n\nTransformers rely on self-attention.");
    expect(text).toContain("2. Method\n\nWe stack six layers.");
  });

  it("keeps words on one line together and breaks between lines", () => {
    const text = buildReadableText(singleColumnPage());
    expect(text).toContain("Transformers rely on self-attention.");
  });

  it("feeds real sections to the walkthrough splitter", () => {
    // End-to-end: the extracted text must produce named sections, not
    // arbitrary character-count chunks.
    const sections = splitIntoSections(buildReadableText(singleColumnPage()));
    expect(sections).toHaveLength(2);
    expect(sections[0]).toContain("1. Introduction");
    expect(sections[1]).toContain("2. Method");
  });

  it("reads a two-column page in column order, not row-interleaved", () => {
    // A two-column paper emits both columns at the same y. Sorting by y
    // alone interleaves line 1 of each column: "Left A Right A Left B".
    // Column detection must yield "Left A Left B Right A Right B".
    // Enough lines on both sides for the detector to fire.
    const twoCol: ReturnType<typeof item>[] = [];
    for (let row = 0; row < 6; row += 1) {
      const y = 700 - row * 14;
      twoCol.push(item(`Left line ${row}`, 72, y));
      twoCol.push(item(`Right line ${row}`, 320, y));
    }
    const text = buildReadableText(twoCol);
    expect(text.indexOf("Left line 5")).toBeLessThan(text.indexOf("Right line 0"));
    // Each column's lines are contiguous, not alternated.
    expect(text).not.toMatch(/Left line 0 Right line 0/);
  });

  it("does not treat a single indented block as two columns", () => {
    // A pull quote indented to the right on a one-column page must not
    // trigger column reordering, which would move the aside to the top.
    const indented: ReturnType<typeof item>[] = [];
    for (let row = 0; row < 8; row += 1) {
      indented.push(item(`Body line ${row}`, 72, 700 - row * 14));
    }
    indented.push(item("An indented aside", 320, 300));
    const text = buildReadableText(indented);
    // Reading order is preserved top to bottom: the aside (lowest y) is
    // last, not hoisted to the front by a phantom column.
    expect(text.indexOf("Body line 0")).toBeLessThan(text.indexOf("Body line 7"));
    expect(text.indexOf("Body line 7")).toBeLessThan(text.indexOf("An indented aside"));
  });

  it("does not split a full-width heading across columns", () => {
    // A title spanning the page is one line, not two columns.
    const fullWidth: ReturnType<typeof item>[] = [
      item("Attention Is All You Need", 72, 740, { width: 400 }),
    ];
    for (let row = 0; row < 6; row += 1) {
      const y = 700 - row * 14;
      fullWidth.push(item(`Left ${row}`, 72, y));
      fullWidth.push(item(`Right ${row}`, 320, y));
    }
    const text = buildReadableText(fullWidth);
    expect(text).toContain("Attention Is All You Need");
    // The title is not swallowed into the left column's prose.
    expect(text.startsWith("Attention Is All You Need")).toBe(true);
  });

  it("does not reorder a title page's author grid into columns", () => {
    // A title page's byline is a grid of cells across the top: a second
    // cluster of origins, exactly what column detection looks for. Read
    // column-major it reorders the authors and repeats shared
    // affiliations ("Google Brain Google Brain"). Body columns run down
    // the page; the grid does not, so this must stay positional.
    const grid: ReturnType<typeof item>[] = [
      item("Attention Is All You Need", 72, 780, { width: 400 }),
    ];
    const authors = ["Ashish Vaswani", "Noam Shazeer", "Niki Parmar", "Jakob Uszkoreit"];
    for (let row = 0; row < 3; row += 1) {
      const y = 740 - row * 16;
      authors.forEach((name, col) => {
        grid.push(item(name, 72 + col * 120, y, { width: 90 }));
      });
    }
    const text = buildReadableText(grid);
    expect(text).toContain("Attention Is All You Need");
    // The byline keeps its row order, and no affiliation is duplicated.
    expect(text.indexOf("Ashish Vaswani")).toBeLessThan(text.indexOf("Noam Shazeer"));
    expect(text.indexOf("Noam Shazeer")).toBeLessThan(text.indexOf("Niki Parmar"));
  });

  it("strips page furniture that would waste a section slot", () => {
    // Section splitting is capped at MAX_SECTIONS. Page numbers, author
    // emails and arXiv's licence stamp each consumed a slot on a real
    // arXiv paper, so the walkthrough ran out of budget before Results.
    const furniture: ReturnType<typeof item>[] = [
      item("Provided proper attribution is provided, Google hereby grants", 72, 760),
      item("Attention Is All You Need", 72, 740, { width: 300 }),
      item("avaswani@google.com", 72, 700),
      item("2", 300, 500),
      item("1 Introduction", 72, 690),
    ];
    const text = buildReadableText(furniture);
    expect(text).not.toContain("Provided proper attribution");
    expect(text).not.toContain("avaswani@google.com");
    expect(text).toContain("Attention Is All You Need");
    expect(text).toContain("1 Introduction");
  });

  it("rejoins words hyphenated across a line break", () => {
    // "transforma-" / "tion" is one word; splitting it changes what the
    // AI is asked to explain and breaks search for the full term.
    const hyphenated = [item("The transforma-", 72, 700), item("tion of at-", 72, 686)];
    expect(buildReadableText(hyphenated)).toContain("transformation");
    // A mid-line hyphen is a real hyphen, never a line-break artifact.
    const midLine = [item("We compare state-of-the-art", 72, 700), item("baselines here", 72, 686)];
    expect(buildReadableText(midLine)).toContain("state-of-the-art baselines");
  });

  it("normalizes typographic ligatures and quotes", () => {
    const ligatures = [item("The ﬁrst deﬁnition of ﬂow", 72, 700)];
    const text = buildReadableText(ligatures);
    expect(text).toContain("first definition of flow");
    expect(text).not.toContain("ﬁ");
  });

  it("collapses runs of spaces inside a line", () => {
    const spaced = [item("a    b", 72, 700, { width: 60 }), item("c", 72, 686)];
    // Two prose lines fold into one flowing line with single spaces.
    expect(buildReadableText(spaced)).toBe("a b c");
  });

  it("returns an empty string for a page with no text", () => {
    expect(buildReadableText([])).toBe("");
  });

  it("tolerates items with no transform", () => {
    // A malformed item must not throw the whole extraction away.
    const broken = [item("kept", 72, 700), { str: "x" } as never];
    expect(buildReadableText(broken)).toContain("kept");
  });
});
