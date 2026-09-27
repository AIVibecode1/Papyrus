// Tailwind v4 ambiguous-utility inventory: fails if src/ uses a bare
// `text-(--var)` class without a type hint.
//
// `text-` is a shared namespace (font-size AND color), so when the value
// is a bare CSS variable Tailwind cannot infer the type and always
// resolves it to `color`. Emitting `text-(--text-card-title)` therefore
// produced `.text-\(--text-card-title\) { color: var(--text-card-title) }`.
// The custom property holds a LENGTH (0.9375rem), which is not a valid
// color, so the declaration was dropped at parse time and the card title
// silently fell back to the inherited 16px — the density tokens had no
// effect at all, with no build or lint error to signal it.
//
// The fix is Tailwind's data-type hint: `text-(length:--var)`, which
// forces the font-size interpretation. Colors legitimately using the bare
// form stay legal, so this test only rejects unhinted LONGHAND usage in a
// class attribute; a color use is fine and simply needs no change.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..");

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.tsx$/.test(entry)) out.push(full);
  }
  return out;
}

/** A bare `text-(--x)` not already disambiguated by `text-(length:--x)`. */
const UNHINTED_TEXT_VAR = /(?<!length:)\btext-\(--[a-z0-9-]+\)/g;

describe("Tailwind ambiguous text-() variables", () => {
  it("requires a length: hint on text-(--var) utilities", () => {
    const violations: string[] = [];
    for (const file of listSourceFiles(SRC)) {
      if (file.includes("__tests__")) continue;
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(UNHINTED_TEXT_VAR)) {
        // The variable is classified by how it is defined in index.css:
        // a length-valued token is what breaks, a color-valued one does not.
        const name = match[0].slice("text-(--".length, -1);
        const css = readFileSync(join(SRC, "index.css"), "utf8");
        const decl = new RegExp(`--${name}:\\s*([^;]+);`).exec(css);
        const value = decl?.[1]?.trim() ?? "";
        const isLength = /^\d*\.?\d+(rem|px|em|ch|vh|vw)$/.test(value);
        if (isLength) {
          const line = text.slice(0, match.index).split("\n").length;
          violations.push(
            `${file.replace(SRC, "src")}:${line} ${match[0]} -> length token; use text-(length:${match[0].slice(5)})`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
