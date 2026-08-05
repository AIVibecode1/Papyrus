import { create } from "zustand";
import { fetchPapers, type PaperSource, type SearchField } from "@/lib/arxiv";
import { fetchCitations } from "@/lib/citations";
import type { PaperSortMode } from "@/lib/paper-sort";
import { useDigestStore } from "@/stores/digest";
import type { Paper } from "@/lib/types";

const DEFAULT_CATEGORY = "cs.AI";
const PAGE_SIZE = 20;

// Non-secret search preferences survive restarts (the raw query string is
// deliberately NOT persisted: privacy + no surprise on reopen).
const FIELD_STORAGE_KEY = "papyrus-search-field";
const LIMIT_CATEGORY_STORAGE_KEY = "papyrus-search-limit-category";

function readStoredField(): SearchField {
  let value: string | null;
  try {
    value = localStorage.getItem(FIELD_STORAGE_KEY);
  } catch {
    // Node test env has no localStorage; defaults apply.
    value = null;
  }
  return value === "title" || value === "author" || value === "abstract" || value === "id"
    ? value
    : "all";
}

function readStoredLimitCategory(): boolean {
  try {
    // Missing key = off (plan 050: archive search must see other
    // categories by default; the checkbox is a deliberate opt-in).
    return localStorage.getItem(LIMIT_CATEGORY_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Error sentinel: the Semantic Scholar source needs a search term.
 * paper-list renders a friendly translated hint for this value.
 */
export const SCHOLAR_SEARCH_REQUIRED = "__scholar_search_required__";

// Monotonic token: a refresh() result is only applied if no newer refresh
// has started since (guards against stale responses clobbering newer state).
let requestSeq = 0;
// Same token for the citation batch: only the newest attempt may flip the
// loading flag (a slow stale batch must not clear a newer one's flag).
let citationsSeq = 0;

interface PapersState {
  category: string;
  query: string;
  /** YYYY-MM-DD of the browsed day, or null for the latest papers. */
  date: string | null;
  /** Paper source (arxiv | semanticscholar); search-only for the latter. */
  source: PaperSource;
  papers: Paper[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  /** Set when a non-arXiv source failed and arXiv served the list. */
  fallbackNote: string | null;
  lastUpdated: number | null;
  /** citation counts keyed by paper id (Semantic Scholar enrichment). */
  citations: Record<string, number>;
  /** True while a citation batch lookup is in flight. */
  citationsLoading: boolean;
  /** False when no citation source answered the last batch (retryable). */
  citationsReachable: boolean;
  /** How the visible list is ordered: feed order or most cited first. */
  sortMode: PaperSortMode;
  /** Field the free-text query targets (plan 041). */
  searchField: SearchField;
  /** Inclusive year bounds for the search; null = unbounded. */
  yearFrom: number | null;
  yearTo: number | null;
  /** AND the current category onto arXiv searches (S2 has its own ranking). */
  limitToCategory: boolean;
  setCategory: (category: string) => void;
  setQuery: (query: string) => void;
  setDate: (date: string | null) => void;
  setSource: (source: PaperSource) => void;
  setSortMode: (mode: PaperSortMode) => void;
  setSearchField: (field: SearchField) => void;
  setYearRange: (from: number | null, to: number | null) => void;
  setLimitToCategory: (value: boolean) => void;
  /**
   * Clears the search query and resets the field to `all`, restoring the
   * feed. Year chips are kept until the user clears them separately.
   */
  clearSearch: () => void;
  /** Clears the fallback notice (dismissed by the user). */
  clearFallbackNote: () => void;
  refresh: () => Promise<void>;
  /** Fetches the next page and appends it (arXiv start=N pagination). */
  loadMore: () => Promise<void>;
  /** Fills citation counts for the visible papers; failures are silent. */
  loadCitations: (ids: string[]) => void;
}

export const usePapersStore = create<PapersState>((set, get) => ({
  category: DEFAULT_CATEGORY,
  query: "",
  date: null,
  source: "arxiv",
  papers: [],
  loading: false,
  loadingMore: false,
  error: null,
  fallbackNote: null,
  lastUpdated: null,
  citations: {},
  citationsLoading: false,
  citationsReachable: true,
  sortMode: "newest",
  searchField: readStoredField(),
  yearFrom: null,
  yearTo: null,
  limitToCategory: readStoredLimitCategory(),

  setCategory: (category) => {
    if (category === get().category) return;
    set({
      category,
      papers: [],
      citations: {},
      citationsLoading: false,
      citationsReachable: true,
      error: null,
      fallbackNote: null,
    });
    void get().refresh();
  },

  setQuery: (query) => {
    if (query === get().query) return;
    set({
      query,
      papers: [],
      citations: {},
      citationsLoading: false,
      citationsReachable: true,
      error: null,
      fallbackNote: null,
    });
    void get().refresh();
  },

  setDate: (date) => {
    if (date === get().date) return;
    set({
      date,
      papers: [],
      citations: {},
      citationsLoading: false,
      citationsReachable: true,
      error: null,
      fallbackNote: null,
    });
    void get().refresh();
  },

  setSource: (source) => {
    if (source === get().source) return;
    set({
      source,
      papers: [],
      citations: {},
      citationsLoading: false,
      citationsReachable: true,
      error: null,
      fallbackNote: null,
    });
    void get().refresh();
  },

  setSortMode: (sortMode) => {
    if (sortMode === get().sortMode) return;
    set({ sortMode });
  },

  setSearchField: (searchField) => {
    if (searchField === get().searchField) return;
    try {
      localStorage.setItem(FIELD_STORAGE_KEY, searchField);
    } catch {
      // Best-effort persistence; the in-memory value still applies.
    }
    set({ searchField });
    // The field changes how the current query is interpreted: re-run it.
    if (get().query.trim()) void get().refresh();
  },

  setYearRange: (yearFrom, yearTo) => {
    if (yearFrom === get().yearFrom && yearTo === get().yearTo) return;
    set({ yearFrom, yearTo });
    if (get().query.trim()) void get().refresh();
  },

  setLimitToCategory: (limitToCategory) => {
    if (limitToCategory === get().limitToCategory) return;
    try {
      localStorage.setItem(LIMIT_CATEGORY_STORAGE_KEY, limitToCategory ? "1" : "0");
    } catch {
      // Best-effort persistence; the in-memory value still applies.
    }
    set({ limitToCategory });
    if (get().query.trim() && get().source === "arxiv") void get().refresh();
  },

  clearSearch: () => {
    if (!get().query && get().searchField === "all") return;
    set({ query: "", searchField: "all", papers: [], citations: {}, error: null });
    try {
      localStorage.setItem(FIELD_STORAGE_KEY, "all");
    } catch {
      // Best-effort persistence.
    }
    void get().refresh();
  },

  clearFallbackNote: () => set({ fallbackNote: null }),

  refresh: async () => {
    const seq = ++requestSeq;
    const { category, query, date, source, searchField, yearFrom, yearTo, limitToCategory } = get();
    set({ loading: true, error: null, fallbackNote: null });
    // Semantic Scholar is search-only: surface a friendly, translatable
    // state instead of hitting the backend and showing a raw Rust error.
    if (source === "semanticscholar" && !query.trim()) {
      if (seq !== requestSeq) return;
      set({ loading: false, papers: [], error: SCHOLAR_SEARCH_REQUIRED });
      return;
    }
    try {
      // Day views are cache-first: if the auto-collected history already
      // has this day, show it immediately and refresh in the background.
      if (date && !query.trim() && source === "arxiv") {
        const cached = useDigestStore.getState().byCategory[category]?.[date];
        if (cached && cached.length > 0) {
          if (seq !== requestSeq) return;
          set({ papers: cached, loading: false, lastUpdated: Date.now() });
        }
      }
      const { papers, fallbackNote } = await fetchPapers(
        category,
        PAGE_SIZE,
        query.trim() || undefined,
        date ?? undefined,
        0,
        source,
        searchField,
        yearFrom ?? undefined,
        yearTo ?? undefined,
        limitToCategory,
      );
      if (seq !== requestSeq) return;
      set({ papers, fallbackNote, loading: false, lastUpdated: Date.now() });
      get().loadCitations(papers.map((p) => p.id));
    } catch (err) {
      if (seq !== requestSeq) return;
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  loadMore: async () => {
    const {
      papers,
      category,
      query,
      date,
      source,
      loading,
      loadingMore,
      searchField,
      yearFrom,
      yearTo,
      limitToCategory,
    } = get();
    if (loading || loadingMore || papers.length === 0) return;
    // Same generation token as refresh: a category/query/source/date
    // change that lands while this request is in flight must invalidate
    // it, so a stale page-2 can never be appended to a newer list.
    const seq = ++requestSeq;
    set({ loadingMore: true });
    try {
      const { papers: next, fallbackNote } = await fetchPapers(
        category,
        PAGE_SIZE,
        query.trim() || undefined,
        date ?? undefined,
        papers.length,
        source,
        searchField,
        yearFrom ?? undefined,
        yearTo ?? undefined,
        limitToCategory,
      );
      if (seq !== requestSeq) {
        // Stale: never touch the list, but always release the busy flag
        // or loadMore would be stuck for the whole session.
        set({ loadingMore: false });
        return;
      }
      if (fallbackNote) set({ fallbackNote });
      // Merge, dropping duplicates (arXiv can shift entries between pages).
      const known = new Set(papers.map((p) => p.id));
      const fresh = next.filter((p) => !known.has(p.id));
      set({ papers: [...papers, ...fresh], loadingMore: false });
      get().loadCitations(fresh.map((p) => p.id));
    } catch (err) {
      if (seq !== requestSeq) {
        set({ loadingMore: false });
        return;
      }
      set({
        loadingMore: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  loadCitations: (ids) => {
    if (ids.length === 0) return;
    // Scholar search results already carry citation counts in the
    // payload: seed them instantly instead of waiting for the batch
    // lookup, so "Most cited" sorting works right after a search.
    const seeded = get()
      .papers.filter((p) => p.citationCount != null)
      .map((p) => [p.id, p.citationCount as number]);
    if (seeded.length > 0) {
      set((s) => ({ citations: { ...s.citations, ...Object.fromEntries(seeded) } }));
    }
    // Only batch-fetch ids whose counts are still unknown: seeded S2
    // papers need no extra request (the batch cannot resolve s2: ids
    // anyway).
    const known = new Set(Object.keys(get().citations));
    const needed = ids.filter((id) => !known.has(id));
    if (needed.length === 0) return;
    const seq = ++citationsSeq;
    set({ citationsLoading: true });
    void fetchCitations(needed).then(({ counts, reachable }) => {
      // A newer attempt superseded this one: never touch the flag.
      if (seq !== citationsSeq) return;
      // Defensive: a backend (or test mock) may answer without the counts
      // map; treat that as "no counts" instead of crashing the batch.
      const entries = Object.entries(counts ?? {});
      if (entries.length > 0) {
        set((s) => ({ citations: { ...s.citations, ...Object.fromEntries(entries) } }));
      }
      // The attempt COMPLETED (with counts, empty, or after the retries
      // gave up): clear the flag so the UI stops saying "loading…" and
      // shows the honest no-data state instead of spinning forever.
      set({ citationsLoading: false, citationsReachable: reachable });
    });
  },
}));
