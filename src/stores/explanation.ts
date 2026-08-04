import { create } from "zustand";
import { CANCELLED_MARKER, newOperationId, streamExplanation, stopExplanation } from "@/lib/ai";
import { createStreamBuffer } from "@/lib/stream";
import { useSettingsStore } from "@/stores/settings";
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

export const useExplanationStore = create<ExplanationState>((set, get) => {
  // The operation id of the most recent start(); stop() targets exactly it
  // (the Rust registry ignores ids that already finished).
  let activeOperationId: string | null = null;

  return {
    byPaper: {},
    expandedId: null,
    generations: {},

    toggle: (paperId) => set((s) => ({ expandedId: s.expandedId === paperId ? null : paperId })),

    start: async (paper, provider, language) => {
      const id = paper.id;
      const gen = (get().generations[id] ?? 0) + 1;
      // Chunks land in a buffer and are committed in one set() per flush
      // window, bounding store updates (~20/s) regardless of chunk rate.
      const buffer = createStreamBuffer<ExplanationState>(set, {
        isCurrent: () => get().generations[id] === gen,
        apply: (s, text) => {
          // Plan 005 compose: a flush that fires after stop()/restart must
          // drop its buffer — the generation no longer matches.
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
              [id]: { ...cur, status: "streaming", text: cur.text + text },
            },
          };
        },
      });

      set((s) => ({
        expandedId: id,
        generations: { ...s.generations, [id]: gen },
        byPaper: {
          ...s.byPaper,
          [id]: { status: "loading", text: "", error: null, providerId: provider.id },
        },
      }));

      try {
        // Failover chain: the picked provider first, then the others in
        // configuration order (deduped). The Rust backend iterates it and
        // resolves with the winning provider's id.
        const chain = [
          provider,
          ...useSettingsStore.getState().providers.filter((p) => p.id !== provider.id),
        ];
        activeOperationId = newOperationId();
        const winnerId = await streamExplanation({
          providers: chain,
          paper,
          language,
          operationId: activeOperationId,
          onChunk: (chunk) => buffer.push(chunk),
        });
        // Done: commit the tail first so the final chunk is not lost, then
        // mark done. A stale timer must not fire after completion.
        buffer.flushNow();
        set((s) => ({
          byPaper: {
            ...s.byPaper,
            [id]: { ...s.byPaper[id], status: "done", providerId: winnerId },
          },
        }));
      } catch (err) {
        // No flush after an ended stream: a stale timer could otherwise
        // resurrect a stopped/errored entry.
        buffer.dispose();
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
      await stopExplanation(activeOperationId);
      activeOperationId = null;
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
  };
});
