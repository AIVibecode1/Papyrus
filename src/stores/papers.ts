import { create } from "zustand";
import { fetchPapers } from "@/lib/arxiv";
import { fetchCitations } from "@/lib/citations";
import { useDigestStore } from "@/stores/digest";
import type { Paper } from "@/lib/types";

const DEFAULT_CATEGORY = "cs.AI";
const PAGE_SIZE = 20;

// Monotonic token: a refresh() result is only applied if no newer refresh
// has started since (guards against stale responses clobbering newer state).
let requestSeq = 0;

interface PapersState {
  category: string;
  query: string;
  /** YYYY-MM-DD of the browsed day, or null for the latest papers. */
  date: string | null;
  papers: Paper[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  lastUpdated: number | null;
  /** citation counts keyed by paper id (Semantic Scholar enrichment). */
  citations: Record<string, number>;
  setCategory: (category: string) => void;
  setQuery: (query: string) => void;
  setDate: (date: string | null) => void;
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
  papers: [],
  loading: false,
  loadingMore: false,
  error: null,
  lastUpdated: null,
  citations: {},

  setCategory: (category) => {
    if (category === get().category) return;
    set({ category, papers: [], citations: {}, error: null });
    void get().refresh();
  },

  setQuery: (query) => {
    if (query === get().query) return;
    set({ query, papers: [], citations: {}, error: null });
    void get().refresh();
  },

  setDate: (date) => {
    if (date === get().date) return;
    set({ date, papers: [], citations: {}, error: null });
    void get().refresh();
  },

  refresh: async () => {
    const seq = ++requestSeq;
    const { category, query, date } = get();
    set({ loading: true, error: null });
    try {
      // Day views are cache-first: if the auto-collected history already
      // has this day, show it immediately and refresh in the background.
      if (date && !query.trim()) {
        const cached = useDigestStore.getState().byCategory[category]?.[date];
        if (cached && cached.length > 0) {
          if (seq !== requestSeq) return;
          set({ papers: cached, loading: false, lastUpdated: Date.now() });
        }
      }
      const papers = await fetchPapers(
        category,
        PAGE_SIZE,
        query.trim() || undefined,
        date ?? undefined,
      );
      if (seq !== requestSeq) return;
      set({ papers, loading: false, lastUpdated: Date.now() });
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
    const { papers, category, query, date, loading, loadingMore } = get();
    if (loading || loadingMore || papers.length === 0) return;
    set({ loadingMore: true });
    try {
      const next = await fetchPapers(
        category,
        PAGE_SIZE,
        query.trim() || undefined,
        date ?? undefined,
        papers.length,
      );
      // Merge, dropping duplicates (arXiv can shift entries between pages).
      const known = new Set(papers.map((p) => p.id));
      const fresh = next.filter((p) => !known.has(p.id));
      set({ papers: [...papers, ...fresh], loadingMore: false });
      get().loadCitations(fresh.map((p) => p.id));
    } catch (err) {
      set({
        loadingMore: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  loadCitations: (ids) => {
    if (ids.length === 0) return;
    void fetchCitations(ids).then((counts) => {
      const entries = Object.entries(counts);
      if (entries.length === 0) return;
      set((s) => ({ citations: { ...s.citations, ...Object.fromEntries(entries) } }));
    });
  },
}));
