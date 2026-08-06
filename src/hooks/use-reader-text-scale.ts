import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "papyrus-reader-text-scale";

/** Plan 064b: the reader's AI explanation text scale. "md" is the app
 * default (scale 1); "sm" and "lg" are 0.875x and 1.125x. Applied as
 * data-reader-scale on the reader root; index.css multiplies the AI
 * prose sizes with it. Persisted across sessions. */
export type ReaderTextScale = "sm" | "md" | "lg";

export const READER_TEXT_SCALES: readonly ReaderTextScale[] = ["sm", "md", "lg"];

export function isReaderTextScale(value: unknown): value is ReaderTextScale {
  return value === "sm" || value === "md" || value === "lg";
}

/** The next larger scale, clamped at lg (pure, exported for tests). */
export function nextScaleUp(current: ReaderTextScale): ReaderTextScale {
  const index = READER_TEXT_SCALES.indexOf(current);
  return READER_TEXT_SCALES[Math.min(index + 1, READER_TEXT_SCALES.length - 1)];
}

/** The next smaller scale, clamped at sm (pure, exported for tests). */
export function nextScaleDown(current: ReaderTextScale): ReaderTextScale {
  const index = READER_TEXT_SCALES.indexOf(current);
  return READER_TEXT_SCALES[Math.max(index - 1, 0)];
}

function getInitialScale(): ReaderTextScale {
  const stored = localStorage.getItem(STORAGE_KEY);
  return isReaderTextScale(stored) ? stored : "md";
}

export function useReaderTextScale() {
  const [scale, setScale] = useState<ReaderTextScale>(getInitialScale);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, scale);
  }, [scale]);

  const scaleUp = useCallback(() => setScale(nextScaleUp), []);
  const scaleDown = useCallback(() => setScale(nextScaleDown), []);

  return { scale, scaleUp, scaleDown };
}
