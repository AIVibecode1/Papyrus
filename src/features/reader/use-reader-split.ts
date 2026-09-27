import { useEffect, useRef, useState } from "react";

const SPLIT_KEY = "papyrus-reader-split";

/** PDF share of the row width (0.3 = panel dominates, 0.8 = PDF dominates). */
export function clampSplit(value: number): number {
  if (!Number.isFinite(value)) return 0.62;
  return Math.min(0.8, Math.max(0.3, value));
}

function initialSplit(): number {
  // No saved split means first launch: use the design default (0.62).
  // Number(null) is 0, so a missing key must not clamp to the 0.3 floor.
  const raw = localStorage.getItem(SPLIT_KEY);
  if (raw === null) return 0.62;
  try {
    return clampSplit(Number(raw));
  } catch {
    return 0.62;
  }
}

function isRowLayout(): boolean {
  return (
    typeof window.matchMedia !== "function" || window.matchMedia("(min-width: 1024px)").matches
  );
}

/**
 * The draggable PDF/panel split: persisted share state, desktop-vs-stacked
 * layout detection, and the separator drag handlers. The PDF always
 * occupies the inline-start side, so the drag math flips in RTL.
 */
export function useReaderSplit() {
  const rowRef = useRef<HTMLDivElement>(null);
  // PDF share of the horizontal split (desktop); persisted between
  // sessions so the user's layout survives restarts.
  const [split, setSplit] = useState(initialSplit);
  const [isRow, setIsRow] = useState(isRowLayout);
  const draggingRef = useRef(false);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(min-width: 1024px)");
    const onChange = (e: MediaQueryListEvent) => setIsRow(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Keep the persisted value in sync with the latest state at drag end.
  const getSplitRef = useRef(split);
  useEffect(() => {
    getSplitRef.current = split;
  }, [split]);

  // Drag the separator to resize the PDF/panel split.
  const startSplitDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const row = rowRef.current;
    if (!row) return;
    const rect = row.getBoundingClientRect();
    draggingRef.current = true;
    const onMove = (ev: PointerEvent) => {
      if (!draggingRef.current) return;
      const pdfWidth =
        document.documentElement.dir === "rtl" ? rect.right - ev.clientX : ev.clientX - rect.left;
      setSplit(clampSplit(pdfWidth / rect.width));
    };
    const onUp = () => {
      draggingRef.current = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      // Without this, a pointercancel (touch gesture taken over by the
      // OS, a pen leaving range) leaves both listeners attached for the
      // session and every later pointermove keeps resizing the pane.
      window.removeEventListener("pointercancel", onUp);
      // Persist after the last move lands.
      try {
        localStorage.setItem(SPLIT_KEY, String(getSplitRef.current));
      } catch {
        // storage unavailable: keep the in-session layout
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  // Keyboard equivalent of the drag. A focusable `separator` that only
  // responds to a pointer advertises a widget assistive tech cannot
  // operate (WCAG 2.1.1); Arrow keys and Home/End are the APG pattern.
  const onSplitKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // The PDF pane is on the left in LTR and the right in RTL, so the
    // arrow that grows it depends on the writing direction.
    const rtl = document.documentElement.dir === "rtl";
    const step = e.shiftKey ? 0.1 : 0.02;
    let next: number;
    switch (e.key) {
      case "ArrowLeft":
        next = clampSplit(split + (rtl ? step : -step));
        break;
      case "ArrowRight":
        next = clampSplit(split + (rtl ? -step : step));
        break;
      case "Home":
        next = clampSplit(rtl ? 0.8 : 0.3);
        break;
      case "End":
        next = clampSplit(rtl ? 0.3 : 0.8);
        break;
      default:
        return;
    }
    e.preventDefault();
    setSplit(next);
    try {
      localStorage.setItem(SPLIT_KEY, String(next));
    } catch {
      // storage unavailable: keep the in-session layout
    }
  };

  return { split, isRow, rowRef, startSplitDrag, onSplitKeyDown };
}
