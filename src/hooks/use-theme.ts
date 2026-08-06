import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "papyrus-theme";
const ARABIC_FONT_KEY = "papyrus-arabic-font";

export type Theme = "light" | "sepia" | "dark";

/** The three themes in cycle order (light -> sepia -> dark -> light). */
export const THEMES: readonly Theme[] = ["light", "sepia", "dark"];

export function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "sepia" || value === "dark";
}

/** Plan 064: the user-selectable Arabic font (IBM Plex = sans default,
 * Amiri = Naskh serif). */
export type ArabicFont = "plex" | "amiri";

export const ARABIC_FONTS: readonly ArabicFont[] = ["plex", "amiri"];

export function isArabicFont(value: unknown): value is ArabicFont {
  return value === "plex" || value === "amiri";
}

/** The next theme in the cycle (pure, exported for tests). */
export function nextTheme(current: Theme): Theme {
  const index = THEMES.indexOf(current);
  return THEMES[(index + 1) % THEMES.length];
}

function getInitialTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (isTheme(stored)) return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function getInitialArabicFont(): ArabicFont {
  const stored = localStorage.getItem(ARABIC_FONT_KEY);
  return isArabicFont(stored) ? stored : "plex";
}

/** Applies the theme to the document: the `dark` class drives Tailwind's
 * dark: variants, and `data-theme` drives the per-theme CSS tokens
 * (light/sepia/dark palettes in index.css). */
function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.dataset.theme = theme;
}

/** Plan 064: `data-arabic-font` drives the --font-arabic swap in
 * index.css (plex -> IBM Plex Sans Arabic, amiri -> Amiri). */
function applyArabicFont(font: ArabicFont) {
  document.documentElement.dataset.arabicFont = font;
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [arabicFont, setArabicFont] = useState<ArabicFont>(getInitialArabicFont);

  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    applyArabicFont(arabicFont);
    localStorage.setItem(ARABIC_FONT_KEY, arabicFont);
  }, [arabicFont]);

  const toggleTheme = useCallback(() => setTheme((t) => nextTheme(t)), []);
  const setThemeTo = useCallback((t: Theme) => setTheme(t), []);
  const setArabicFontTo = useCallback((f: ArabicFont) => setArabicFont(f), []);

  return { theme, toggleTheme, setThemeTo, arabicFont, setArabicFontTo };
}
