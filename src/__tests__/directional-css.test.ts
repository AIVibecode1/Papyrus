// Directional CSS inventory (plan 044 WU1): fails if src/ introduces
// physical direction utilities in directional layout. Logical properties
// (ms/me/ps/pe/start/end) keep RTL correct by construction; physical
// left/right edge classes silently break Arabic layout.
//
// Allowlisted (intentional, direction-agnostic):
// - `slide-in-from-*` / `slide-out-to-*`: Radix animation classes that
//   reference physical sides for all four data-side variants.
// - `-translate-y-*` / `translate-y-*`: vertical centering, not
//   directional layout.
// - `-scale-x-100` / `rtl:-scale-x-100`: intentional mirroring for
//   arrow/send icons (always paired with rtl: toggles).
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
    else if (/\.(tsx|css)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Physical-direction class tokens (classnames, not CSS rules). */
const PHYSICAL_TOKENS = [
  /\bml-\d/g, // margin-inline-start spelled physically
  /\bmr-\d/g,
  /\bpl-\d/g, // padding-inline-start spelled physically
  /\bpr-\d/g,
  /\btext-left\b/g,
  /\btext-right\b/g,
  /\bleft-\d/g,
  /\bright-\d/g,
];

/** Direction-agnostic patterns that legitimately mention these tokens. */
const ALLOWLIST = [
  "slide-in-from-left",
  "slide-in-from-right",
  "slide-out-to-left",
  "slide-out-to-right",
  "data-[side=left]",
  "data-[side=right]",
];

describe("directional CSS inventory", () => {
  it("allows no physical direction utilities in src/", () => {
    const violations: string[] = [];
    for (const file of listSourceFiles(SRC)) {
      if (file.includes("__tests__")) continue;
      const text = readFileSync(file, "utf8");
      for (const token of PHYSICAL_TOKENS) {
        for (const match of text.matchAll(token)) {
          const line = text.slice(0, match.index).split("\n").length;
          const snippet = text.slice(Math.max(0, match.index - 40), match.index + 40);
          const allowed = ALLOWLIST.some((a) => snippet.includes(a));
          if (!allowed) {
            violations.push(`${file.replace(SRC, "src")}:${line} ${snippet.trim()}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
