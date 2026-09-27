import { describe, expect, it } from "vitest";

import { relativeOpened } from "@/lib/relative-time";

describe("relativeOpened", () => {
  it("produces a relative label in the given language", () => {
    const twoHours = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    expect(relativeOpened(twoHours, "en")).toBe("2 hours ago");
    // Arabic uses the dual form for two hours.
    expect(relativeOpened(twoHours, "ar")).toMatch(/ساعتين|ساعة/);
  });

  it("falls back to the raw value for unparseable dates", () => {
    expect(relativeOpened("not-a-date", "en")).toBe("not-a-date");
  });
});
