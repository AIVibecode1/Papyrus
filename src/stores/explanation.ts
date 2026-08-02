import { create } from "zustand";
import { CANCELLED_MARKER, streamExplanation, stopExplanation } from "@/lib/ai";
import type { Paper, ProviderConfig } from "@/lib/types";

export type ExplainStatus = "idle" | "loading" | "streaming" | "done" | "error" | "stopped";

/** Chunk-coalescing window: store updates are bounded to ~1 per 50 ms
 * regardless of how fast the provider emits deltas (UX/perf knob). */
const FLUSH_INTERVAL_MS = 50;

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

  toggle: (paperId) => set((s) => ({ expandedId: s.expandedId === paperId ? null : paperId })),

  start: async (paper, provider, language) => {
    const id = paper.id;
    const gen = (get().generations[id] ?? 0) + 1;
    // Chunks land in a buffer and are committed in one set() per flush
    // window, bounding store updates (~20/s) regardless of chunk rate.
    let pending: string[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const clearFlushTimer = () => {
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
    };

    const flush = () => {
      flushTimer = null;
      const buf = pending;
      pending = [];
      if (buf.length === 0) return;
      set((s) => {
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
            [id]: { ...cur, status: "streaming", text: cur.text + buf.join("") },
          },
        };
      });
    };

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
        onChunk: (chunk) => {
          // A chunk from a superseded run (Stop happened, or a new start)
          // must be dropped: the status stays "stopped".
          if (get().generations[id] !== gen) return;
          pending.push(chunk);
          if (flushTimer === null) flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
        },
      });
      // Done: commit the tail first so the final chunk is not lost, then
      // mark done. A stale timer must not fire after completion.
      clearFlushTimer();
      flush();
      set((s) => ({
        byPaper: {
          ...s.byPaper,
          [id]: { ...s.byPaper[id], status: "done" },
        },
      }));
    } catch (err) {
      // No flush after an ended stream: a stale timer could otherwise
      // resurrect a stopped/errored entry.
      clearFlushTimer();
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
