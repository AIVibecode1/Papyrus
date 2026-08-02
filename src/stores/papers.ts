import { create } from "zustand";
import { fetchPapers } from "@/lib/arxiv";
import type { Paper } from "@/lib/types";

const DEFAULT_CATEGORY = "cs.AI";
const PAGE_SIZE = 20;

// Monotonic token: a refresh() result is only applied if no newer refresh
// has started since (guards against stale responses clobbering newer state).
let requestSeq = 0;

interface PapersState {
  category: string;
  query: string;
  papers: Paper[];
  loading: boolean;
  error: string | null;
  lastUpdated: number | null;
  setCategory: (category: string) => void;
  setQuery: (query: string) => void;
  refresh: () => Promise<void>;
}

export const usePapersStore = create<PapersState>((set, get) => ({
  category: DEFAULT_CATEGORY,
  query: "",
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

  refresh: async () => {
    const seq = ++requestSeq;
    const { category, query } = get();
    set({ loading: true, error: null });
    try {
      const papers = await fetchPapers(category, PAGE_SIZE, query.trim() || undefined);
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
