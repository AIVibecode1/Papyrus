import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "papyrus-theme";

export type Theme = "light" | "sepia" | "dark";

/** The three themes in cycle order (light -> sepia -> dark -> light). */
export const THEMES: readonly Theme[] = ["light", "sepia", "dark"];

export function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "sepia" || value === "dark";
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

/** Applies the theme to the document: the `dark` class drives Tailwind's
 * dark: variants, and `data-theme` drives the per-theme CSS tokens
 * (light/sepia/dark palettes in index.css). */
function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.dataset.theme = theme;
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);

  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  const toggleTheme = useCallback(() => setTheme((t) => nextTheme(t)), []);
  const setThemeTo = useCallback((t: Theme) => setTheme(t), []);

  return { theme, toggleTheme, setThemeTo };
}
