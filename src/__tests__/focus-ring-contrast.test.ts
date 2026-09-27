// Focus-indicator contrast inventory: fails if a focus ring is used at
// reduced alpha.
//
// WCAG 1.4.11 requires a focus indicator to reach 3:1 against the adjacent
// background. `focus-visible:ring-ring/50` composites the ring colour at
// half alpha over the surface, which measured 2.13:1 (light), 2.08:1
// (sepia) and 2.76:1 (dark) — every one below the threshold, so the ring
// was effectively invisible to a keyboard user on the affected controls.
// The solid `ring-ring` measures 5.8:1 / 5.36:1 / 7.1:1.
//
// `button.tsx` was fixed for this and documents the measurement; the
// input, textarea, select, badge, search-clear, top-bar, sidebar and
// today-picks variants kept the 50% form. This test makes the whole set
// fail together if it comes back.
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

describe("focus indicator contrast", () => {
  it("no control renders its focus ring at reduced alpha", () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      text.split("\n").forEach((line, i) => {
        // A comment may name the old value while explaining why it is gone.
        const code = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
        if (/ring-ring\/\d/.test(code)) {
          offenders.push(`${file.slice(SRC.length + 1)}:${i + 1}`);
        }
      });
    }
    expect(
      offenders,
      `focus ring at reduced alpha fails WCAG 1.4.11 (3:1). Use focus-visible:ring-ring:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
