// @vitest-environment jsdom
// Plan 064: the Arabic font preference lives in use-theme, applied to
// <html data-arabic-font> and persisted under papyrus-arabic-font.
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { ARABIC_FONTS, isArabicFont, useTheme } from "@/hooks/use-theme";

const FONT_KEY = "papyrus-arabic-font";

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.arabicFont;
  // Seed the theme so getInitialTheme never touches matchMedia (jsdom
  // does not implement it).
  localStorage.setItem("papyrus-theme", "light");
});

describe("isArabicFont", () => {
  it("accepts only the two bundled families", () => {
    expect(ARABIC_FONTS).toEqual(["plex", "amiri"]);
    expect(isArabicFont("plex")).toBe(true);
    expect(isArabicFont("amiri")).toBe(true);
    expect(isArabicFont("comic-sans")).toBe(false);
    expect(isArabicFont(null)).toBe(false);
  });
});

describe("useTheme arabic font", () => {
  it("defaults to IBM Plex and applies the data attribute", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.arabicFont).toBe("plex");
    expect(document.documentElement.dataset.arabicFont).toBe("plex");
    expect(localStorage.getItem(FONT_KEY)).toBe("plex");
  });

  it("switches to Amiri, applying the attribute and persisting it", () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setArabicFontTo("amiri"));
    expect(document.documentElement.dataset.arabicFont).toBe("amiri");
    expect(localStorage.getItem(FONT_KEY)).toBe("amiri");
    expect(result.current.arabicFont).toBe("amiri");
  });

  it("restores a stored choice on mount", () => {
    localStorage.setItem(FONT_KEY, "amiri");
    const { result } = renderHook(() => useTheme());
    expect(result.current.arabicFont).toBe("amiri");
    expect(document.documentElement.dataset.arabicFont).toBe("amiri");
  });

  it("ignores corrupted storage and falls back to the default", () => {
    localStorage.setItem(FONT_KEY, "wingdings");
    const { result } = renderHook(() => useTheme());
    expect(result.current.arabicFont).toBe("plex");
    expect(document.documentElement.dataset.arabicFont).toBe("plex");
  });
});
