import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Paper, ProviderConfig } from "@/lib/types";

const { streamExplanationMock, stopExplanationMock } = vi.hoisted(() => ({
  streamExplanationMock: vi.fn(),
  stopExplanationMock: vi.fn(),
}));

vi.mock("@/lib/ai", () => ({
  streamExplanation: streamExplanationMock,
  stopExplanation: stopExplanationMock,
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
    streamExplanationMock.mockReset();
    stopExplanationMock.mockReset();
    streamExplanationMock.mockImplementation(
      (opts: { onChunk: (chunk: string) => void }) => {
        onChunk = opts.onChunk;
        return new Promise<void>((resolve, reject) => {
          resolveStream = resolve;
          rejectStream = reject;
        });
      },
    );
    useExplanationStore.setState({ byPaper: {}, expandedId: null });
  });

  it("start sets loading then done", async () => {
    const p = useExplanationStore.getState().start(paper, provider, "en");
    expect(useExplanationStore.getState().byPaper[paper.id]?.status).toBe(
      "loading",
    );

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

    const mid = useExplanationStore.getState().byPaper[paper.id];
    expect(mid?.status).toBe("streaming");
    expect(mid?.text).toBe("ab");

    resolveStream();
    await p;
    expect(useExplanationStore.getState().byPaper[paper.id]?.status).toBe(
      "done",
    );
  });

  it("stop marks stopped and prevents further chunk appends", async () => {
    const p = useExplanationStore.getState().start(paper, provider, "en");
    onChunk("a");
    await useExplanationStore.getState().stop();
    expect(useExplanationStore.getState().byPaper[paper.id]?.status).toBe(
      "stopped",
    );

    // KNOWN BUG (plan 011/005 fixes: chunk after stop must be ignored).
    // Current behavior: a late chunk still appends and flips status back to
    // streaming — assert it so the fix can flip this test.
    onChunk("b");
    const after = useExplanationStore.getState().byPaper[paper.id];
    expect(after?.text).toBe("ab");
    expect(after?.status).toBe("streaming");

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

  it('error containing "Stopped" is classified as stopped', async () => {
    // KNOWN BUG (plan 005: typed cancellation) — classification relies on a
    // fragile string contract. Keep asserting current behavior.
    const p = useExplanationStore.getState().start(paper, provider, "en");
    rejectStream(new Error("Stopped by the user"));
    await p;

    const after = useExplanationStore.getState().byPaper[paper.id];
    expect(after?.status).toBe("stopped");
    expect(after?.error).toBe("Stopped by the user");
  });
});
