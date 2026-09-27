import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@/lib/ai";
import type { Paper, ReadingHistoryEntry } from "@/lib/types";

const BROWSER_STORAGE_KEY = "papyrus-reading-history-v1";
/** Cap: 200 entries; oldest-opened dropped first (matches history.rs). */
export const HISTORY_CAP = 200;

// The desktop path persists through the Rust history.rs commands (app
// data dir, atomic writes). The browser dev preview falls back to
// localStorage with the SAME JSON shape, so migrating to disk later is a
// straight copy. Recording is automatic; failures are always best-effort
// and never block opening a paper.

function isEntry(value: unknown): value is ReadingHistoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.paperId === "string" &&
    v.paperId.length > 0 &&
    typeof v.title === "string" &&
    typeof v.lastOpenedAt === "string"
  );
}

function loadBrowserHistory(): ReadingHistoryEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(BROWSER_STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(isEntry)
      .sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt))
      .slice(0, HISTORY_CAP);
  } catch {
    return [];
  }
}

function saveBrowserHistory(entries: ReadingHistoryEntry[]) {
  try {
    localStorage.setItem(BROWSER_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Best-effort in the preview path.
  }
}

/** Builds the denormalized history entry for a successfully opened paper. */
export function entryFromPaper(paper: Paper): ReadingHistoryEntry {
  return {
    paperId: paper.id,
    title: paper.title,
    authors: paper.authors,
    published: paper.published,
    pdfUrl: paper.pdfUrl,
    categories: paper.categories,
    source: paper.id.startsWith("s2:") ? "semanticscholar" : "arxiv",
    lastOpenedAt: new Date().toISOString(),
  };
}

/** Rebuilds a Paper from a history entry (position restore needs only
 * id + pdfUrl; the rest feeds the reader header and overview). */
export function paperFromEntry(entry: ReadingHistoryEntry): Paper {
  return {
    id: entry.paperId,
    title: entry.title,
    authors: entry.authors,
    published: entry.published,
    summary: "",
    pdfUrl: entry.pdfUrl,
    categories: entry.categories,
  };
}

/** Pure upsert: existing paperId moves to the top with a fresh
 * lastOpenedAt; new entries are inserted at the top; the list is trimmed
 * to the cap. Used by the store and tested directly. */
export function upsertHistory(
  entries: ReadingHistoryEntry[],
  entry: ReadingHistoryEntry,
): ReadingHistoryEntry[] {
  const rest = entries.filter((e) => e.paperId !== entry.paperId);
  return [entry, ...rest].slice(0, HISTORY_CAP);
}

interface HistoryState {
  entries: ReadingHistoryEntry[];
  loaded: boolean;
  /** Set when the initial read failed. A failed read must not render as
   * "no reading history": that reads as data loss for reading positions
   * the user still has. */
  loadError: string | null;
  load: () => Promise<void>;
  /** Records a successful open; sync and never throws (fire-and-forget
   * from the reader so history can never block opening a paper). */
  /** Records (or refreshes) the entry for a successfully opened paper.
   * Plan 073: `lastPage` rides along from the reader position memory
   * when known, so the Continue-reading strip can show where to resume. */
  recordOpen: (paper: Paper, lastPage?: number) => void;
  remove: (paperId: string) => Promise<void>;
  clear: () => Promise<void>;
  /** Merges imported history; same paperId -> the newer lastOpenedAt
   * wins. Returns the merged list. */
  importHistory: (entries: ReadingHistoryEntry[]) => Promise<ReadingHistoryEntry[]>;
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  entries: [],
  loaded: false,
  loadError: null,

  load: async () => {
    if (get().loaded) return;
    let entries: ReadingHistoryEntry[] = [];
    let failure: string | null = null;
    if (isTauri()) {
      try {
        entries = await invoke<ReadingHistoryEntry[]>("list_history");
      } catch (err) {
        // Surface the fault. Treating a failed read as "no history" tells
        // the user their reading positions are gone, which is both wrong
        // and unrecoverable from their side.
        failure = err instanceof Error ? err.message : String(err);
      }
    } else {
      entries = loadBrowserHistory();
    }
    set({
      entries: entries.filter(isEntry).sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt)),
      loaded: true,
      loadError: failure,
    });
  },

  recordOpen: (paper, lastPage) => {
    const entry = {
      ...entryFromPaper(paper),
      ...(lastPage !== undefined ? { lastPage } : {}),
    };
    set((s) => ({ entries: upsertHistory(s.entries, entry) }));
    // Persistence is best-effort and fire-and-forget: a storage failure
    // must never surface in the reader flow.
    void (async () => {
      try {
        if (isTauri()) {
          await invoke("record_history", { entry });
        } else {
          saveBrowserHistory(get().entries);
        }
      } catch {
        // History write failed; the in-memory entry still stands.
      }
    })();
  },

  remove: async (paperId) => {
    set((s) => ({ entries: s.entries.filter((e) => e.paperId !== paperId) }));
    if (isTauri()) {
      await invoke("remove_history_entry", { paperId }).catch(() => undefined);
    } else {
      saveBrowserHistory(get().entries);
    }
  },

  clear: async () => {
    set({ entries: [] });
    if (isTauri()) {
      await invoke("clear_history").catch(() => undefined);
    } else {
      saveBrowserHistory([]);
    }
  },

  importHistory: async (entries) => {
    if (entries.length === 0) return get().entries;
    // Map-indexed: a findIndex per incoming entry made the merge
    // quadratic in the size of the user's history.
    const byId = new Map(get().entries.map((e) => [e.paperId, e]));
    // Only entries the batch actually changes are sent: the old path
    // replayed the entire merged list (up to 200) through record_history,
    // each call re-reading and re-writing the whole history file.
    const winners: ReadingHistoryEntry[] = [];
    for (const incoming of entries) {
      if (!isEntry(incoming)) continue;
      const local = byId.get(incoming.paperId);
      if (local && local.lastOpenedAt >= incoming.lastOpenedAt) continue;
      byId.set(incoming.paperId, incoming);
      winners.push(incoming);
    }
    if (winners.length === 0) return get().entries;

    const capped = [...byId.values()]
      .sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt))
      .slice(0, HISTORY_CAP);
    set({ entries: capped });
    try {
      if (isTauri()) {
        await invoke("import_history", { entries: winners });
      } else {
        saveBrowserHistory(capped);
      }
    } catch {
      // History is explicitly best-effort (recordOpen behaves the same
      // way), and the returned list must match what the store now holds,
      // so a disk failure keeps the in-memory merge rather than silently
      // diverging from the return value.
    }
    return capped;
  },
}));
