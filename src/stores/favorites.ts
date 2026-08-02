import { create } from "zustand";
import type { Paper } from "@/lib/types";

const STORAGE_KEY = "papyrus-favorites";

// Light shape check in the spirit of plan 012's validator (settings.ts):
// plan 012's isProviderConfig is provider-specific, so papers get their
// own minimal guard — corrupted/legacy entries are dropped on load.
function isPaper(value: unknown): value is Paper {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && typeof v.title === "string";
}

interface FavoritesState {
  ids: string[];
  byId: Record<string, Paper>;
  loaded: boolean;
  load: () => void;
  toggle: (paper: Paper) => void;
  isFavorite: (id: string) => boolean;
}

export const useFavoritesStore = create<FavoritesState>((set, get) => ({
  ids: [],
  byId: {},
  loaded: false,
  load: () => {
    if (get().loaded) return;
    try {
      const raw = JSON.parse(
        localStorage.getItem(STORAGE_KEY) ?? "{}",
      ) as unknown;
      const byId: Record<string, Paper> = {};
      if (raw && typeof raw === "object") {
        for (const [id, value] of Object.entries(raw)) {
          if (isPaper(value) && value.id === id) byId[id] = value;
        }
      }
      set({ byId, ids: Object.keys(byId), loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  toggle: (paper) =>
    set((s) => {
      const ids = s.ids.includes(paper.id)
        ? s.ids.filter((id) => id !== paper.id)
        : [...s.ids, paper.id];
      const byId = { ...s.byId };
      if (ids.includes(paper.id)) byId[paper.id] = paper;
      else delete byId[paper.id];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(byId));
      return { ids, byId };
    }),
  isFavorite: (id) => get().ids.includes(id),
}));
