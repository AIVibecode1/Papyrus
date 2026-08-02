import { create } from "zustand";
import { fetchPapers } from "@/lib/arxiv";
import type { Paper } from "@/lib/types";

const DEFAULT_CATEGORY = "cs.AI";
const PAGE_SIZE = 20;

interface PapersState {
  category: string;
  papers: Paper[];
  loading: boolean;
  error: string | null;
  lastUpdated: number | null;
  setCategory: (category: string) => void;
  refresh: () => Promise<void>;
}

export const usePapersStore = create<PapersState>((set, get) => ({
  category: DEFAULT_CATEGORY,
  papers: [],
  loading: false,
  error: null,
  lastUpdated: null,

  setCategory: (category) => {
    if (category === get().category) return;
    set({ category, papers: [], error: null });
    void get().refresh();
  },

  refresh: async () => {
    const { category } = get();
    set({ loading: true, error: null });
    try {
      const papers = await fetchPapers(category, PAGE_SIZE);
      set({ papers, loading: false, lastUpdated: Date.now() });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
}));
