// RTL layout guards for the two fixes that only manifest in Arabic.
//
// Both were found by measuring the live DOM, not by reading the CSS: each
// looked correct in English and was wrong in RTL. These tests assert the
// class contract, because the defect IS a class-contract error — a logical
// utility that resolves to the same physical edge as its neighbour.
//
//   chat bubbles: `self-start` is the RIGHT in a column flex container
//     under `direction: rtl`, and so is `rtl:self-start`. A bare
//     `self-start` assistant therefore stacked on the same side as the
//     user. Measured: old rtl user=RIGHT assistant=RIGHT.
//
//   reader title: `dir="ltr"` on the <h1> is needed for a Latin title, but
//     on a block it also flips the block's `text-align: start` to the left.
//     Measured: title ink 429px from the right edge in RTL, vs 40px in LTR.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

describe("chat bubbles sit on opposite edges in both directions", () => {
  const source = read("features/reader/ask-panel.tsx");

  it("gives the assistant rtl:self-end so it opposes the user", () => {
    // The user is pinned right in both directions (self-end in LTR,
    // rtl:self-start in Arabic). The assistant must therefore flip in RTL,
    // or both roles resolve to the right and stack.
    expect(source).toMatch(/"self-start border bg-card rtl:self-end"/);
  });

  it("keeps the user pinned to the same edge in both directions", () => {
    expect(source).toMatch(/"self-end bg-primary\/10 rtl:self-start"/);
  });
});

describe("reader title isolates direction without moving the block", () => {
  const source = read("features/reader/reader-header.tsx");

  it("puts dir=ltr on an inner span, not on the heading block", () => {
    // `dir` on the h1 is what stranded the title against the left edge in
    // Arabic; only the text needs the isolation.
    expect(source).not.toMatch(/<h1[^>]*\bdir=/);
    expect(source).toMatch(/<span dir="ltr">\{title\}<\/span>/);
  });
});
