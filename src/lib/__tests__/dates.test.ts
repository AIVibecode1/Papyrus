import { describe, expect, it } from "vitest";
import { formatUiDate } from "@/lib/dates";

describe("formatUiDate", () => {
  it("formats a date in the given locale", () => {
    expect(formatUiDate("2026-07-31T00:00:00Z", "en", { dateStyle: "medium" })).toBe(
      "Jul 31, 2026",
    );
  });

  it("strips bidi marks so Arabic dates do not flip", () => {
    // ar locales wrap separators in RLM marks that reverse the digits
    // even inside an LTR container ("2026/07/31" instead of "31/07/2026").
    const out = formatUiDate("2026-07-31T00:00:00Z", "ar", { dateStyle: "medium" });
    expect(out).not.toMatch(/[\u200e\u200f]/);
  });
});
