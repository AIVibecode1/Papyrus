// @vitest-environment jsdom
// The citation badge is split into prefix / count / suffix so the exact
// number can sit in its own `dir="ltr"` span and Arabic punctuation can never
// reorder it. That split is also what makes the suffix a plural form, and it
// is easy to regress: drop the `{ count }` argument at a call site, or rename
// the keys, and the badge silently reads "Cited 1 times".
//
// These assertions go through the app's real i18next instance rather than a
// re-implementation of its plural rules, so they fail if the configuration
// or the resource tables stop selecting the right form. The expected words
// are read out of the locale files rather than pasted here, so the test
// pins plural *selection* and never drifts from the shipped copy.
import { describe, expect, it } from "vitest";

import i18n from "@/i18n";
import ar from "@/i18n/locales/ar.json";
import en from "@/i18n/locales/en.json";

/**
 * What the badge renders for a given count, in the given language.
 *
 * Uses `getFixedT` rather than switching the shared instance's language:
 * Vitest runs test files in parallel in one process, and four files call
 * `changeLanguage`. Mutating that singleton made this file's assertions
 * race the others — it passed alone and failed in the full run. A fixed
 * translator reads the language without publishing it.
 */
function badge(count: number, lang: "en" | "ar"): string {
  const t = i18n.getFixedT(lang);
  return `${t("papers.citedByPrefix")} ${count} ${t("papers.citedBySuffix", { count })}`;
}

/** The prefix and suffix the badge is expected to use, per form. */
function words(
  locale: typeof en | typeof ar,
  form: "zero" | "one" | "other",
): { prefix: string; suffix: string } {
  const papers = locale.papers as unknown as Record<string, string>;
  return {
    prefix: papers.citedByPrefix,
    suffix: papers[`citedBySuffix_${form}`],
  };
}

describe("citation count suffix", () => {
  it("uses the singular for exactly one citation in English", () => {
    const w = words(en, "one");
    expect(badge(1, "en")).toBe(`${w.prefix} 1 ${w.suffix}`);
    expect(w.suffix).toBe("time");
  });

  it("uses the plural for zero and for many citations", () => {
    const zero = words(en, "zero");
    const other = words(en, "other");
    expect(badge(0, "en")).toBe(`${zero.prefix} 0 ${zero.suffix}`);
    expect(badge(2, "en")).toBe(`${other.prefix} 2 ${other.suffix}`);
    expect(badge(1234, "en")).toBe(`${other.prefix} 1234 ${other.suffix}`);
    expect(zero.suffix).toBe(other.suffix);
  });

  it("keeps one Arabic noun form for every Arabic plural category", () => {
    // Arabic does not inflect this noun for number, so every category reads
    // the same; the count itself is what carries the number. i18next selects
    // zero/one/two/few/many/other here, so every one of them must be defined
    // or the badge falls back to printing the raw key.
    const counts = [0, 1, 2, 3, 11, 100];
    for (const count of counts) {
      const w = words(ar, count === 1 ? "one" : count === 0 ? "zero" : "other");
      expect(badge(count, "ar")).toBe(`${w.prefix} ${count} ${w.suffix}`);
    }
    // Every Arabic category resolves to the one noun form.
    const papers = ar.papers as unknown as Record<string, string>;
    for (const form of ["zero", "one", "two", "few", "many", "other"]) {
      expect(papers[`citedBySuffix_${form}`]).toBe(papers.citedBySuffix_one);
    }
  });

  it("defines the same plural forms in both languages", () => {
    const forms = (locale: typeof en | typeof ar) =>
      Object.keys(locale.papers as unknown as Record<string, string>)
        .filter((k) => k.startsWith("citedBySuffix_"))
        .sort();
    expect(forms(en)).toEqual(forms(ar));
  });
});
