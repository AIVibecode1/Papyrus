import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Paper, ProviderConfig } from "@/lib/types";

const { streamExplanationMock, stopExplanationMock, CANCELLED_MARKER } = vi.hoisted(() => ({
  streamExplanationMock: vi.fn(),
  stopExplanationMock: vi.fn(),
  // Must mirror src/lib/ai.ts — the store matches rejections against it.
  CANCELLED_MARKER: "\u{1F6D1}PAPYRUS_CANCELLED",
}));

vi.mock("@/lib/ai", () => ({
  streamExplanation: streamExplanationMock,
  stopExplanation: stopExplanationMock,
  CANCELLED_MARKER,
}));

import { useExplanationStore } from "@/stores/explanation";

const paper: Paper = {
  id: "p1",
  title: "Test paper",
  authors: ["A. Author"],
  published: "2026-01-01",
  summary: "A summary.",
  pdfUrl: "https://arxiv.org/pdf/1234.5678",
  categories: ["cs.AI"],
};

const provider: ProviderConfig = {
  id: "prov1",
  name: "Test provider",
  baseUrl: "https://example.com/v1",
  model: "test-model",
};

describe("explanation store", () => {
  let resolveStream!: (v: void) => void;
  let rejectStream!: (e: unknown) => void;
  let onChunk!: (chunk: string) => void;

  beforeEach(() => {
    // Chunk appends are coalesced into a 50 ms flush window (plan 015), so
    // tests that assert text need deterministic timer control.
    vi.useFakeTimers();
    streamExplanationMock.mockReset();
    stopExplanationMock.mockReset();
    streamExplanationMock.mockImplementation((opts: { onChunk: (chunk: string) => void }) => {
      onChunk = opts.onChunk;
      return new Promise<void>((resolve, reject) => {
        resolveStream = resolve;
        rejectStream = reject;
      });
    });
    useExplanationStore.setState({ byPaper: {}, expandedId: null, generations: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("start sets loading then done", async () => {
    const p = useExplanationStore.getState().start(paper, provider, "en");
    expect(useExplanationStore.getState().byPaper[paper.id]?.status).toBe("loading");

    resolveStream();
    await p;

    const after = useExplanationStore.getState().byPaper[paper.id];
    expect(after?.status).toBe("done");
    expect(after?.text).toBe("");
    expect(after?.error).toBeNull();
  });

  it("chunks flip status to streaming and append text", async () => {
    const p = useExplanationStore.getState().start(paper, provider, "en");
    onChunk("a");
    onChunk("b");
    // Plan 015: chunks commit on the flush window, not per chunk.
    vi.advanceTimersByTime(50);

    const mid = useExplanationStore.getState().byPaper[paper.id];
    expect(mid?.status).toBe("streaming");
    expect(mid?.text).toBe("ab");

    resolveStream();
    await p;
    expect(useExplanationStore.getState().byPaper[paper.id]?.status).toBe("done");
  });

  it("chunks within the same flush window are batched into one store update", async () => {
    // Plan 015: two chunks arriving inside one flush window must produce a
    // single state change, not one per chunk.
    const texts: (string | undefined)[] = [];
    const unsubscribe = useExplanationStore.subscribe((s) => {
      texts.push(s.byPaper[paper.id]?.text);
    });

    const p = useExplanationStore.getState().start(paper, provider, "en");
    expect(texts).toEqual([""]); // only the start() update so far

    onChunk("a");
    onChunk("b");
    expect(texts).toEqual([""]); // buffered — nothing committed yet

    vi.advanceTimersByTime(50);
    expect(texts).toEqual(["", "ab"]); // one batched update for both chunks

    resolveStream();
    await p;
    unsubscribe();
  });

  it("stop marks stopped and prevents further chunk appends", async () => {
    const p = useExplanationStore.getState().start(paper, provider, "en");
    onChunk("a");
    // Plan 015: commit the pre-stop chunk by advancing the flush window.
    vi.advanceTimersByTime(50);
    await useExplanationStore.getState().stop();
    expect(useExplanationStore.getState().byPaper[paper.id]?.status).toBe("stopped");

    // Plan 005: a chunk already in flight from the pre-stop run must be
    // dropped — text stays unchanged and the status stays "stopped".
    onChunk("b");
    const after = useExplanationStore.getState().byPaper[paper.id];
    expect(after?.text).toBe("a");
    expect(after?.status).toBe("stopped");

    resolveStream();
    await p;
  });

  it("error sets status error with message", async () => {
    const p = useExplanationStore.getState().start(paper, provider, "en");
    rejectStream("boom");
    await p;

    const after = useExplanationStore.getState().byPaper[paper.id];
    expect(after?.status).toBe("error");
    expect(after?.error).toBe("boom");
  });

  it("error containing the word but not the marker is an error", async () => {
    // Plan 005: classification matches the typed marker, not the word — a
    // provider error that merely contains "stopped" is NOT a user stop.
    const p = useExplanationStore.getState().start(paper, provider, "en");
    rejectStream(new Error("stream stopped unexpectedly"));
    await p;

    const after = useExplanationStore.getState().byPaper[paper.id];
    expect(after?.status).toBe("error");
    expect(after?.error).toBe("stream stopped unexpectedly");
  });

  it("rejection with the exact marker is stopped with no error", async () => {
    // Plan 005: the typed marker means a user stop — status "stopped" and
    // the raw marker must not leak into the UI (error is null).
    const p = useExplanationStore.getState().start(paper, provider, "en");
    rejectStream(new Error(CANCELLED_MARKER));
    await p;

    const after = useExplanationStore.getState().byPaper[paper.id];
    expect(after?.status).toBe("stopped");
    expect(after?.error).toBeNull();
  });
});
