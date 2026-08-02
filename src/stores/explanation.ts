import { create } from "zustand";
import { streamExplanation, stopExplanation } from "@/lib/ai";
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
  toggle: (paperId: string) => void;
  start: (paper: Paper, provider: ProviderConfig, language: string) => Promise<void>;
  stop: () => Promise<void>;
}

export const useExplanationStore = create<ExplanationState>((set, get) => ({
  byPaper: {},
  expandedId: null,

  toggle: (paperId) =>
    set((s) => ({ expandedId: s.expandedId === paperId ? null : paperId })),

  start: async (paper, provider, language) => {
    const id = paper.id;
    set((s) => ({
      expandedId: id,
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
      const status: ExplainStatus = message.includes("Stopped") ? "stopped" : "error";
      set((s) => ({
        byPaper: {
          ...s.byPaper,
          [id]: { ...s.byPaper[id], status, error: message },
        },
      }));
    }
  },

  stop: async () => {
    await stopExplanation();
    // The in-flight stream exits with "Stopped by the user", which sets status.
    const active = get().expandedId;
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
