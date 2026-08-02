import { create } from "zustand";

export type View = "papers" | "settings";

interface UiState {
  view: View;
  setView: (view: View) => void;
}

export const useUiStore = create<UiState>((set) => ({
  view: "papers",
  setView: (view) => set({ view }),
}));
