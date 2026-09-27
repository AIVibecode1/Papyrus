/**
 * Shared streaming flush helper.
 *
 * Every streaming surface in the app (section walkthrough, synthesis,
 * chat, abstract explanation) buffers incoming chunks and commits them to
 * the Zustand store in one `set()` per flush window (~50 ms), bounding
 * store updates regardless of chunk rate. This module is the single
 * implementation of that pattern; the stores provide their own `apply`
 * closure so their state shapes and guard semantics stay local.
 */

export interface StreamBufferOptions<TState> {
  /**
   * Applies buffered text to the store. Return the next state, or the
   * unchanged state when the target entry is gone or terminal (the
   * caller's guard semantics — entry status or generation — live here).
   * Partial states are fine (Zustand merges them).
   */
  apply: (state: TState, text: string) => TState | Partial<TState>;
  /**
   * True while the stream is still current (generation match). Chunks
   * arriving after this flips are dropped.
   */
  isCurrent: () => boolean;
  /** Flush window in ms (default 50). */
  intervalMs?: number;
}

export interface StreamBuffer {
  /** Buffer a chunk and arm the flush timer if not already armed. */
  push: (chunk: string) => void;
  /** Commit any buffered text immediately (used on completion/error). */
  flushNow: () => void;
  /** Cancel a pending flush without committing (used on stop/dispose). */
  dispose: () => void;
}

export function createStreamBuffer<TState>(
  set: (fn: (state: TState) => TState | Partial<TState>) => void,
  opts: StreamBufferOptions<TState>,
): StreamBuffer {
  const intervalMs = opts.intervalMs ?? 50;
  let pending: string[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
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
    // Note: `isCurrent` is deliberately NOT re-checked here. Text already
    // accepted by `push` belongs to the user and must be committed even
    // if the run was superseded in the meantime. Deciding whether a late
    // flush may still touch a slot is the caller's business — the stores
    // guard their own `apply` with a generation check, which is where
    // "Stop then Regenerate reuses this index" is actually resolved.
    set((s) => opts.apply(s, buf.join("")));
  };

  return {
    push: (chunk) => {
      if (!opts.isCurrent()) return;
      pending.push(chunk);
      if (flushTimer === null) flushTimer = setTimeout(flush, intervalMs);
    },
    flushNow: () => {
      clearTimer();
      flush();
    },
    dispose: clearTimer,
  };
}
