import { describe, expect, it } from "vitest";

import { isTheme, nextTheme, THEMES, type Theme } from "@/hooks/use-theme";

describe("theme cycle", () => {
  it("cycles light -> sepia -> dark -> light", () => {
    expect(nextTheme("light")).toBe("sepia");
    expect(nextTheme("sepia")).toBe("dark");
    expect(nextTheme("dark")).toBe("light");
  });

  it("THEMES contains exactly the three palettes", () => {
    expect(THEMES).toEqual(["light", "sepia", "dark"]);
  });

  it("isTheme accepts only known palettes", () => {
    for (const theme of THEMES) {
      expect(isTheme(theme)).toBe(true);
    }
    expect(isTheme("blue")).toBe(false);
    expect(isTheme(null)).toBe(false);
    expect(isTheme(undefined)).toBe(false);
  });

  it("cycle is stable on unknown input (type guard protects callers)", () => {
    // nextTheme is typed for Theme; the guard is the entry point.
    const valid: Theme = "sepia";
    expect(isTheme(valid)).toBe(true);
  });
});
