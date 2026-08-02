import { create } from "zustand";
import { CANCELLED_MARKER, streamExplanation, stopExplanation } from "@/lib/ai";
import type { Paper, ProviderConfig } from "@/lib/types";

export type ExplainStatus = "idle" | "loading" | "streaming" | "done" | "error" | "stopped";

interface PaperExplanation {
  status: ExplainStatus;
  text: string;
  error: string | null;
  providerId: string | null;
}

interface ExplanationState {
  byPaper: Record<string, PaperExplanation>;
  expandedId: string | null;
  /** Per-paper generation counter: bumped on every start/stop so chunks
   * from a superseded run (e.g. after Stop) are dropped. */
  generations: Record<string, number>;
  toggle: (paperId: string) => void;
  start: (paper: Paper, provider: ProviderConfig, language: string) => Promise<void>;
  stop: () => Promise<void>;
}

export const useExplanationStore = create<ExplanationState>((set, get) => ({
  byPaper: {},
  expandedId: null,
  generations: {},

  toggle: (paperId) =>
    set((s) => ({ expandedId: s.expandedId === paperId ? null : paperId })),

  start: async (paper, provider, language) => {
    const id = paper.id;
    const gen = (get().generations[id] ?? 0) + 1;
    set((s) => ({
      expandedId: id,
      generations: { ...s.generations, [id]: gen },
      byPaper: {
        ...s.byPaper,
        [id]: { status: "loading", text: "", error: null, providerId: provider.id },
      },
    }));

    try {
      await streamExplanation({
        provider,
        paper,
        language,
        onChunk: (chunk) =>
          set((s) => {
            // A chunk from a superseded run (Stop happened, or a new start)
            // must be dropped: the status stays "stopped".
            if (s.generations[id] !== gen) return s;
            const cur = s.byPaper[id] ?? {
              status: "streaming" as const,
              text: "",
              error: null,
              providerId: provider.id,
            };
            return {
              byPaper: {
                ...s.byPaper,
                [id]: { ...cur, status: "streaming", text: cur.text + chunk },
              },
            };
          }),
      });
      set((s) => ({
        byPaper: {
          ...s.byPaper,
          [id]: { ...s.byPaper[id], status: "done" },
        },
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stopped = message.startsWith(CANCELLED_MARKER);
      const status: ExplainStatus = stopped ? "stopped" : "error";
      set((s) => ({
        byPaper: {
          ...s.byPaper,
          // On a user stop the panel shows the i18n "Stopped." text, so the
          // raw marker must not leak into the UI.
          [id]: { ...s.byPaper[id], status, error: stopped ? null : message },
        },
      }));
    }
  },

  stop: async () => {
    const active = get().expandedId;
    if (active) {
      // Bump the generation first so any chunk already in flight from the
      // old run is dropped and the status stays "stopped".
      set((s) => ({
        generations: {
          ...s.generations,
          [active]: (s.generations[active] ?? 0) + 1,
        },
      }));
    }
    await stopExplanation();
    // The in-flight stream rejects with CANCELLED_MARKER, which the catch
    // block maps to "stopped".
    if (active) {
      const cur = get().byPaper[active];
      if (cur && (cur.status === "loading" || cur.status === "streaming")) {
        set((s) => ({
          byPaper: { ...s.byPaper, [active]: { ...cur, status: "stopped" } },
        }));
      }
    }
  },
}));
