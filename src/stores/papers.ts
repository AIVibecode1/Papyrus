import { create } from "zustand";
import { fetchPapers } from "@/lib/arxiv";
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
  error: string | null;
  lastUpdated: number | null;
  setCategory: (category: string) => void;
  setQuery: (query: string) => void;
  setDate: (date: string | null) => void;
  refresh: () => Promise<void>;
}

export const usePapersStore = create<PapersState>((set, get) => ({
  category: DEFAULT_CATEGORY,
  query: "",
  date: null,
  papers: [],
  loading: false,
  error: null,
  lastUpdated: null,

  setCategory: (category) => {
    if (category === get().category) return;
    set({ category, papers: [], error: null });
    void get().refresh();
  },

  setQuery: (query) => {
    if (query === get().query) return;
    set({ query, papers: [], error: null });
    void get().refresh();
  },

  setDate: (date) => {
    if (date === get().date) return;
    set({ date, papers: [], error: null });
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
    } catch (err) {
      if (seq !== requestSeq) return;
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
}));
