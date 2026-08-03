import { create } from "zustand";
import { fetchPapers } from "@/lib/arxiv";
import type { Paper } from "@/lib/types";

const STORAGE_KEY = "papyrus-digest-v2";
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

// Guards against concurrent backfills: per-category, so switching to a
// category whose backfill has not started is never skipped by another
// category's in-flight pass. arXiv politeness is enforced server-side by
// the shared per-source rate limiter, so concurrent passes are safe.
const runningCategories = new Set<string>();

/** Minimal Paper shape guard for persisted digest data. */
function isPaperLike(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && typeof v.title === "string";
}

/**
 * Drops malformed persisted days (non-arrays, entries that are not paper
 * shapes) so corrupted or hand-edited storage can never inject bad data
 * into the digest. Valid days are preserved verbatim.
 */
function sanitizeByCategory(raw: unknown): Record<string, Record<string, Paper[]>> {
  const out: Record<string, Record<string, Paper[]>> = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const [cat, days] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof days !== "object" || days === null) continue;
    const dayMap: Record<string, Paper[]> = {};
    for (const [date, papers] of Object.entries(days as Record<string, unknown>)) {
      if (Array.isArray(papers) && papers.every(isPaperLike)) {
        dayMap[date] = papers as Paper[];
      }
    }
    out[cat] = dayMap;
  }
  return out;
}

export const useDigestStore = create<DigestState>((set, get) => ({
  byCategory: {},
  lastChecked: {},
  loaded: false,
  progress: null,

  load: () => {
    if (get().loaded) return;
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>;
      const byCategory = sanitizeByCategory(raw.byCategory);
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
    if (runningCategories.has(category)) return;
    const today = todayStr();
    // The backfill covers today too: the day picker's newest day must be
    // the current day (yesterday-only made the picker lag a day behind,
    // showing e.g. July 31 as "newest" while today's papers exist).
    const last = get().lastChecked[category];
    // Already up to date, unless today's stored list is empty: the day
    // may have been fetched before arXiv announced anything, and must be
    // refetched once papers arrive (the empty day heals on the next pass).
    const storedToday = get().byCategory[category]?.[today];
    if (last && last >= today && storedToday?.length) return;

    runningCategories.add(category);
    try {
      const earliest = addDays(today, -(BACKFILL_DAYS - 1));
      let from = last && last > earliest ? addDays(last, 1) : earliest;
      // Today was already fetched but came back empty (arXiv announces
      // later in the day): refetch it so the day heals once papers land.
      if (last === today && !storedToday?.length) from = today;
      const missing: string[] = [];
      for (let d = from; d <= today; d = addDays(d, 1)) {
        // A day stored with an empty list counts as missing: empty days
        // were historically written when the arXiv query was malformed,
        // and refetching heals them.
        if (!get().byCategory[category]?.[d]?.length) missing.push(d);
      }
      if (missing.length === 0) {
        set((s) => ({ lastChecked: { ...s.lastChecked, [category]: today } }));
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
      const checkpoint = failedAt ? addDays(failedAt, -1) : today;
      set((s) => ({
        lastChecked: { ...s.lastChecked, [category]: checkpoint },
        progress: null,
      }));
      get().prune();
      get().persist();
    } finally {
      runningCategories.delete(category);
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
