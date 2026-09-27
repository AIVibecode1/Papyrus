import { describe, expect, it } from "vitest";
import { formatCalendarDay, formatUiDate } from "@/lib/dates";

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

describe("formatCalendarDay", () => {
  const options = { month: "short", day: "numeric" } as const;

  it("prints the day the key names, whatever the machine's timezone", () => {
    // A calendar day is not an instant. "2026-07-31T00:00:00Z" is UTC
    // midnight, which is 20:00 on Jul 30 in New York — so a formatter
    // running in any western-offset zone printed the PREVIOUS day, and
    // every label in the day picker was off by one.
    const original = process.env.TZ;
    try {
      process.env.TZ = "America/New_York";
      expect(formatCalendarDay("2026-07-31", "en", options)).toBe("Jul 31");
      process.env.TZ = "America/Los_Angeles";
      expect(formatCalendarDay("2026-01-01", "en", options)).toBe("Jan 1");
      process.env.TZ = "Asia/Riyadh";
      expect(formatCalendarDay("2026-07-31", "en", options)).toBe("Jul 31");
    } finally {
      process.env.TZ = original;
    }
  });

  it("still strips bidi marks in Arabic", () => {
    const out = formatCalendarDay("2026-07-31", "ar", options);
    expect(out).not.toMatch(/[\u200e\u200f]/);
    expect(out).toContain("31");
  });
});
