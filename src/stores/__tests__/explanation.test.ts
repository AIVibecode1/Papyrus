import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Paper, ProviderConfig } from "@/lib/types";

const { streamExplanationMock, stopExplanationMock, CANCELLED_MARKER, opSeq } = vi.hoisted(() => ({
  streamExplanationMock: vi.fn(),
  stopExplanationMock: vi.fn(),
  // Must mirror src/lib/ai.ts — the store matches rejections against it.
  CANCELLED_MARKER: "\u{1F6D1}PAPYRUS_CANCELLED",
  // Distinct id per call, like the real generator: the store keys its
  // cancellable runs by id, so a fixed id would hide id mix-ups.
  opSeq: { n: 0 },
}));

vi.mock("@/lib/ai", () => ({
  streamExplanation: streamExplanationMock,
  stopExplanation: stopExplanationMock,
  newOperationId: () => `op-${++opSeq.n}`,
  CANCELLED_MARKER,
}));

import { useExplanationStore } from "@/stores/explanation";
import { useSettingsStore } from "@/stores/settings";

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
  let resolveStream!: (v: string) => void;
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
      return new Promise<string>((resolve, reject) => {
        resolveStream = resolve;
        rejectStream = reject;
      });
    });
    useExplanationStore.setState({ byPaper: {}, expandedId: null, generations: {} });
    useSettingsStore.setState({ providers: [], activeProviderId: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("start sets loading then done", async () => {
    const p = useExplanationStore.getState().start(paper, provider, "en");
    expect(useExplanationStore.getState().byPaper[paper.id]?.status).toBe("loading");

    resolveStream(provider.id);
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

    resolveStream(provider.id);
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

    resolveStream(provider.id);
    await p;
    unsubscribe();
  });

  it("stop on one paper leaves a concurrent explanation on another running", async () => {
    // Two papers can stream at once (generations are keyed by paper id).
    // A single module-level operation id made stop() cancel whichever run
    // started last, not the card whose Stop button was clicked — and left
    // the other one unstoppable.
    const other: Paper = { ...paper, id: "p2", title: "Second paper" };
    let rejectA!: (e: unknown) => void;
    let rejectB!: (e: unknown) => void;
    // Both streams stay pending until the test rejects them at the end.
    streamExplanationMock.mockImplementationOnce(
      () =>
        new Promise<string>((_res, rej) => {
          rejectA = rej;
        }),
    );
    streamExplanationMock.mockImplementationOnce(
      () =>
        new Promise<string>((_res, rej) => {
          rejectB = rej;
        }),
    );

    const runA = useExplanationStore.getState().start(paper, provider, "en");
    const runB = useExplanationStore.getState().start(other, provider, "en");

    // Stop only paper A.
    await useExplanationStore.getState().stop(paper.id);
    expect(stopExplanationMock).toHaveBeenCalledTimes(1);
    expect(useExplanationStore.getState().byPaper[paper.id]?.status).toBe("stopped");
    // B must still be streaming, and still cancellable afterwards.
    expect(useExplanationStore.getState().byPaper[other.id]?.status).toBe("loading");

    await useExplanationStore.getState().stop(other.id);
    expect(stopExplanationMock).toHaveBeenCalledTimes(2);
    expect(useExplanationStore.getState().byPaper[other.id]?.status).toBe("stopped");
    // Two distinct ids: stopping B must not reuse A's.
    expect(stopExplanationMock.mock.calls[0][0]).not.toBe(stopExplanationMock.mock.calls[1][0]);

    // Settle both so the promises do not leak into the next test.
    rejectA(new Error("🛑PAPYRUS_CANCELLED"));
    rejectB(new Error("🛑PAPYRUS_CANCELLED"));
    await Promise.all([runA, runB]);
  });

  it("stop marks stopped and prevents further chunk appends", async () => {
    const p = useExplanationStore.getState().start(paper, provider, "en");
    onChunk("a");
    // Plan 015: commit the pre-stop chunk by advancing the flush window.
    vi.advanceTimersByTime(50);
    await useExplanationStore.getState().stop(paper.id);
    expect(useExplanationStore.getState().byPaper[paper.id]?.status).toBe("stopped");

    // Plan 005: a chunk already in flight from the pre-stop run must be
    // dropped — text stays unchanged and the status stays "stopped".
    onChunk("b");
    const after = useExplanationStore.getState().byPaper[paper.id];
    expect(after?.text).toBe("a");
    expect(after?.status).toBe("stopped");

    resolveStream(provider.id);
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

  it("start passes the provider chain and records the winning provider", async () => {
    const other: ProviderConfig = {
      id: "prov2",
      name: "Fallback provider",
      baseUrl: "https://fallback.example/v1",
      model: "fallback-model",
    };
    useSettingsStore.setState({
      providers: [provider, other],
      activeProviderId: provider.id,
    });

    const p = useExplanationStore.getState().start(paper, provider, "en");

    // The chain is the picked provider first, then the rest in order.
    const opts = streamExplanationMock.mock.calls[0][0];
    expect(opts.providers.map((x: ProviderConfig) => x.id)).toEqual(["prov1", "prov2"]);

    // The winning provider (a fallback) is recorded on the entry.
    resolveStream(other.id);
    await p;
    expect(useExplanationStore.getState().byPaper[paper.id]?.providerId).toBe("prov2");
  });

  it("start dedupes the picked provider in the chain", async () => {
    useSettingsStore.setState({ providers: [provider, provider], activeProviderId: provider.id });

    const p = useExplanationStore.getState().start(paper, provider, "en");
    const opts = streamExplanationMock.mock.calls[0][0];
    expect(opts.providers).toHaveLength(1);

    resolveStream(provider.id);
    await p;
  });
});
