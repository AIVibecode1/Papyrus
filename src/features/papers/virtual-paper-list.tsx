import { useEffect, useRef, useState, type ReactNode } from "react";

interface VirtualListProps<T> {
  items: T[];
  /** Estimated row height in px, used to slice the visible window. */
  estimateSize?: number;
  /** Renders one row (the PaperCard / history row). */
  renderItem: (item: T, index: number) => ReactNode;
  /** Accessible name for the list region. */
  ariaLabel: string;
}

/** Finds the real scroll container by walking up from the list: the
 * papers shell scrolls PaperList's own `overflow-y-auto` wrapper (the
 * #main-content ancestor is NOT the scroller), and history/saved lists
 * live under the same wrapper. Falls back to the list wrapper itself
 * when no scrollable ancestor exists (standalone tests). */
function findScrollParent(start: HTMLElement | null): HTMLElement | null {
  let node = start?.parentElement ?? null;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if (/(auto|scroll|overlay)/.test(overflowY) && node.scrollHeight > node.clientHeight + 4) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

/** Plan 075: windowed rendering for long paper / history / saved lists.
 * Mounts only the visible slice plus overscan, so a 200-entry history
 * or a large search result never builds hundreds of DOM cards. Rows use
 * estimated heights (uniform enough for paper cards); variable-height
 * rows re-flow within the window while scrolling, which is acceptable
 * for the feed and noted as a follow-up if jumpiness ever matters. */
export function VirtualList<T>({
  items,
  estimateSize = 96,
  renderItem,
  ariaLabel,
}: VirtualListProps<T>) {
  const listRef = useRef<HTMLDivElement>(null);
  const [window, setWindow] = useState({ start: 0, end: Math.min(items.length, 14) });

  useEffect(() => {
    const el = findScrollParent(listRef.current) ?? listRef.current;
    if (!el) return;
    const update = () => {
      const scrollTop = el.scrollTop;
      // jsdom reports 0-height containers; a minimum viewport keeps a
      // usable initial window in tests without affecting the real app.
      const viewport = Math.max(el.clientHeight, 400);
      const start = Math.max(0, Math.floor(scrollTop / estimateSize) - 6);
      const end = Math.min(items.length, Math.ceil((scrollTop + viewport) / estimateSize) + 6);
      setWindow({ start, end });
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    observer?.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [items.length, estimateSize]);

  const totalHeight = items.length * estimateSize;
  const topPad = window.start * estimateSize;
  const bottomPad = Math.max(0, totalHeight - window.end * estimateSize);

  return (
    <div ref={listRef} role="list" aria-label={ariaLabel}>
      <div style={{ paddingTop: topPad, paddingBottom: bottomPad }}>
        {items.slice(window.start, window.end).map((item, i) => (
          <div
            key={
              (item as { id?: string; paperId?: string }).id ??
              (item as { paperId?: string }).paperId ??
              String(window.start + i)
            }
            role="listitem"
            className="pb-4"
          >
            {renderItem(item, window.start + i)}
          </div>
        ))}
      </div>
    </div>
  );
}
