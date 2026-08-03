import { create } from "zustand";
import { fetchPapers } from "@/lib/arxiv";
import type { Paper } from "@/lib/types";

const STORAGE_KEY = "papyrus-digest-v1";
/** Max days fetched in one backfill pass (arXiv's 3 s politeness rule applies). */
const BACKFILL_DAYS = 14;
/** How much history to keep per category. */
const RETENTION_DAYS = 30;
/** Papers requested per day (a field can get more than 20 papers/day). */
const DAY_PAGE_SIZE = 50;

/** Today as YYYY-MM-DD in local time. */
export function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/** Adds `n` days to a YYYY-MM-DD date (negative goes back). */
export function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(
    dt.getUTCDate(),
  ).padStart(2, "0")}`;
}

interface DigestState {
  /** category -> YYYY-MM-DD -> papers collected for that day. */
  byCategory: Record<string, Record<string, Paper[]>>;
  /** category -> last YYYY-MM-DD that was fully collected. */
  lastChecked: Record<string, string>;
  loaded: boolean;
  /** Non-null while a backfill is running (for the progress hint). */
  progress: { category: string; done: number; total: number } | null;
  load: () => void;
  /** Backfills the recent history for a category, then prunes old days. */
  ensureHistory: (category: string) => Promise<void>;
  /** All stored days for a category, newest first. */
  days: (category: string) => string[];
  dayCount: (category: string, date: string) => number;
  /** Caches a fetched day so navigation and the day list stay consistent. */
  storeDay: (category: string, date: string, papers: Paper[]) => void;
  /** Drops days older than the retention window. */
  prune: () => void;
  /** Writes the digest to localStorage (best-effort). */
  persist: () => void;
}

// Guards against concurrent backfills of the same or different categories.
let running = false;

export const useDigestStore = create<DigestState>((set, get) => ({
  byCategory: {},
  lastChecked: {},
  loaded: false,
  progress: null,

  load: () => {
    if (get().loaded) return;
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>;
      const byCategory =
        raw.byCategory && typeof raw.byCategory === "object"
          ? (raw.byCategory as Record<string, Record<string, Paper[]>>)
          : {};
      const lastChecked =
        raw.lastChecked && typeof raw.lastChecked === "object"
          ? (raw.lastChecked as Record<string, string>)
          : {};
      set({ byCategory, lastChecked, loaded: true });
      get().prune();
    } catch {
      set({ loaded: true });
    }
  },

  ensureHistory: async (category) => {
    get().load();
    if (running) return;
    const today = todayStr();
    const yesterday = addDays(today, -1);
    const last = get().lastChecked[category];
    if (last && last >= yesterday) return; // already up to date

    running = true;
    try {
      const earliest = addDays(yesterday, -(BACKFILL_DAYS - 1));
      const from = last && last > earliest ? addDays(last, 1) : earliest;
      const missing: string[] = [];
      for (let d = from; d <= yesterday; d = addDays(d, 1)) {
        if (!get().byCategory[category]?.[d]) missing.push(d);
      }
      if (missing.length === 0) {
        set((s) => ({ lastChecked: { ...s.lastChecked, [category]: yesterday } }));
        return;
      }

      set({ progress: { category, done: 0, total: missing.length } });
      let failedAt: string | null = null;
      for (let i = 0; i < missing.length; i++) {
        const day = missing[i];
        try {
          const { papers } = await fetchPapers(category, DAY_PAGE_SIZE, undefined, day);
          get().storeDay(category, day, papers);
        } catch {
          // Transient failure: leave the day missing so the next launch
          // retries it, and stop advancing the checkpoint past it.
          failedAt ??= day;
        }
        set({ progress: { category, done: i + 1, total: missing.length } });
      }
      const checkpoint = failedAt ? addDays(failedAt, -1) : yesterday;
      set((s) => ({
        lastChecked: { ...s.lastChecked, [category]: checkpoint },
        progress: null,
      }));
      get().prune();
      get().persist();
    } finally {
      running = false;
    }
  },

  days: (category) =>
    Object.keys(get().byCategory[category] ?? {})
      .sort()
      .reverse(),

  dayCount: (category, date) => get().byCategory[category]?.[date]?.length ?? 0,

  storeDay: (category, date, papers) => {
    set((s) => ({
      byCategory: {
        ...s.byCategory,
        [category]: { ...(s.byCategory[category] ?? {}), [date]: papers },
      },
    }));
    get().persist();
  },

  /** Drops days older than RETENTION_DAYS (runs on load and after backfill). */
  prune: () => {
    const cutoff = addDays(todayStr(), -RETENTION_DAYS);
    const byCategory = get().byCategory;
    let changed = false;
    const pruned: Record<string, Record<string, Paper[]>> = {};
    for (const cat of Object.keys(byCategory)) {
      pruned[cat] = {};
      for (const [date, papers] of Object.entries(byCategory[cat] ?? {})) {
        if (date >= cutoff) pruned[cat][date] = papers;
        else changed = true;
      }
    }
    if (changed) set({ byCategory: pruned });
  },

  persist: () => {
    const { byCategory, lastChecked } = get();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ byCategory, lastChecked }));
    } catch {
      // Storage full or unavailable: the digest is best-effort.
    }
  },
}));
