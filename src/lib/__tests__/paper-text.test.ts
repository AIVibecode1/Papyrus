import { describe, expect, it } from "vitest";

import {
  capTotal,
  countMatches,
  findContextSection,
  MAX_SECTIONS,
  splitIntoSections,
  truncateMiddle,
} from "@/lib/paper-text";

describe("splitIntoSections", () => {
  it("splits on numbered headings", () => {
    const text = [
      "1. Introduction",
      "Some intro text.",
      "2. Method",
      "The method text.",
      "3. Results",
      "The results text.",
    ].join("\n");
    const sections = splitIntoSections(text);
    expect(sections).toHaveLength(3);
    expect(sections[0]).toContain("Some intro text.");
    expect(sections[1]).toContain("The method text.");
    expect(sections[2]).toContain("The results text.");
  });

  it("recognizes known keywords like Abstract and Conclusion", () => {
    const text = [
      "Abstract",
      "The abstract text.",
      "Some body paragraph without a heading.",
      "Conclusion",
      "The conclusion text.",
    ].join("\n");
    const sections = splitIntoSections(text);
    expect(sections).toHaveLength(2);
    expect(sections[0]).toContain("The abstract text.");
    expect(sections[1]).toContain("The conclusion text.");
  });

  it("does not split on ordinary sentences", () => {
    const text = [
      "This is a long paragraph about the paper.",
      "It contains several sentences but no headings.",
      "Attention is all you need, but this line is not a heading.",
    ].join("\n");
    const sections = splitIntoSections(text);
    expect(sections).toHaveLength(1);
  });

  it("hard-splits oversized sections by paragraph", () => {
    const big = "word ".repeat(30_000);
    const text = ["1. Introduction", big, "2. Method", "short"].join("\n");
    const sections = splitIntoSections(text);
    expect(sections.length).toBeGreaterThanOrEqual(2);
    for (const section of sections) {
      expect(section.length).toBeLessThanOrEqual(14_500);
    }
  });

  it("caps the number of sections", () => {
    const lines: string[] = [];
    for (let i = 1; i <= 30; i += 1) {
      lines.push(`${i}. Heading ${i}`, `Body ${i}.`);
    }
    const sections = splitIntoSections(lines.join("\n"));
    expect(sections.length).toBeLessThanOrEqual(MAX_SECTIONS);
  });

  it("returns a single section when there is no structure", () => {
    const sections = splitIntoSections("just some text without headings at all");
    expect(sections).toHaveLength(1);
    expect(sections[0]).toContain("just some text");
  });
});

describe("countMatches", () => {
  it("counts case-insensitive occurrences", () => {
    expect(countMatches("Transformer transformers TRANSFORMER", "transformer")).toBe(3);
  });

  it("returns zero for empty queries", () => {
    expect(countMatches("anything", "")).toBe(0);
    expect(countMatches("anything", "   ")).toBe(0);
  });
});

describe("truncateMiddle", () => {
  it("keeps short text intact", () => {
    expect(truncateMiddle("short")).toBe("short");
  });

  it("truncates the middle of long text", () => {
    const out = truncateMiddle("a".repeat(500), 100);
    expect(out.length).toBeLessThan(101);
    expect(out.startsWith("a")).toBe(true);
    expect(out.endsWith("a")).toBe(true);
    expect(out).toContain("…");
  });
});

describe("findContextSection", () => {
  const sections = ["Section one text about attention.", "Section two text about results."];

  it("finds the section containing the selection", () => {
    expect(findContextSection(sections, "Section two text about results.")).toBe(sections[1]);
  });

  it("falls back to the first section for short selections", () => {
    expect(findContextSection(sections, "hi")).toBe(sections[0]);
  });

  it("falls back to the first section when nothing matches", () => {
    expect(findContextSection(sections, "completely unrelated selection text here")).toBe(
      sections[0],
    );
  });

  it("returns empty for no sections", () => {
    expect(findContextSection([], "anything")).toBe("");
  });
});

describe("capTotal", () => {
  it("keeps short text intact", () => {
    expect(capTotal("short text", 100)).toBe("short text");
  });

  it("truncates long text with a marker", () => {
    const out = capTotal("x".repeat(10_000), 1_000);
    expect(out.length).toBeLessThan(1_100);
    expect(out).toContain("[text truncated]");
  });
});
