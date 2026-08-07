// Reading position memory, keyed by paper id. Plan 073: extracted from
// the PDF viewer so history recording reads the same storage the viewer
// restores from — one source of truth, no second position store.
const POS_KEY = "papyrus-reader-pos";

/** The last page the reader was on for this paper, if remembered. */
export function readPdfPosition(paperId?: string): number | null {
  if (!paperId) return null;
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw) as Record<string, number>;
    return typeof map[paperId] === "number" ? map[paperId] : null;
  } catch {
    return null;
  }
}

export function savePdfPosition(paperId: string | undefined, page: number) {
  if (!paperId) return;
  try {
    const raw = localStorage.getItem(POS_KEY);
    const map = (raw ? JSON.parse(raw) : {}) as Record<string, number>;
    map[paperId] = page;
    localStorage.setItem(POS_KEY, JSON.stringify(map));
  } catch {
    // Position memory is best-effort.
  }
}
