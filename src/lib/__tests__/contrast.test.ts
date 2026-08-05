// Contrast audit (plan 044 WU5): --muted-foreground must reach WCAG AA
// (4.5:1) on --card and --background in all three themes. The test uses
// hex constants duplicated from the oklch tokens in src/index.css —
// keep them in sync when the tokens change (the audit in the commit
// message recomputes them from oklch).
import { describe, expect, it } from "vitest";

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function hexToRgb(hex: string): Rgb {
  const value = hex.replace("#", "");
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

function linearize(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(color: Rgb): number {
  return 0.2126 * linearize(color.r) + 0.7152 * linearize(color.g) + 0.0722 * linearize(color.b);
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const l1 = luminance(a);
  const l2 = luminance(b);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** Theme tokens duplicated from src/index.css (oklch -> sRGB hex). */
const THEMES = {
  light: {
    mutedForeground: "#736E67",
    card: "#FCFBF8",
    background: "#F6F4F1",
  },
  sepia: {
    mutedForeground: "#756657",
    card: "#F8F1E5",
    background: "#F1E9DD",
  },
  dark: {
    mutedForeground: "#9B9893",
    card: "#1E1B19",
    background: "#141210",
  },
};

describe("muted-foreground contrast (WCAG AA)", () => {
  for (const [theme, tokens] of Object.entries(THEMES)) {
    for (const surface of ["card", "background"] as const) {
      it(`${theme}: muted text on ${surface} is >= 4.5:1`, () => {
        const ratio = contrastRatio(hexToRgb(tokens.mutedForeground), hexToRgb(tokens[surface]));
        expect(ratio).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});
