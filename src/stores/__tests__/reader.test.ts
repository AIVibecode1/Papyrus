import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Paper, ProviderConfig } from "@/lib/types";

// The vitest environment is "node" — provide an in-memory localStorage so
// the chat persistence path is exercisable (same pattern as settings tests).
function createMemoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => {
      data.delete(key);
    },
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}
vi.stubGlobal("localStorage", createMemoryStorage());

// --- mocks ------------------------------------------------------------------
vi.mock("@/lib/pdf", () => ({ getPdfBytes: vi.fn() }));
vi.mock("@/lib/pdf-text", () => ({ extractTextFromPdf: vi.fn() }));
vi.mock("@/lib/reader-ai", () => ({
  streamSectionExplanation: vi.fn(),
  streamSynthesis: vi.fn(),
  streamAsk: vi.fn(),
}));
vi.mock("@/lib/ai", () => {
  let opCounter = 0;
  return {
    CANCELLED_MARKER: "🛑PAPYRUS_CANCELLED",
    // Distinct ids per stream so the store's operation-id compare-and-swap
    // semantics are exercisable (a constant id would hide clobbering bugs).
    newOperationId: () => `op-${++opCounter}`,
    stopExplanation: vi.fn(),
  };
});

import { getPdfBytes } from "@/lib/pdf";
import { extractTextFromPdf } from "@/lib/pdf-text";
import { stopExplanation } from "@/lib/ai";
import { streamAsk, streamSectionExplanation, streamSynthesis } from "@/lib/reader-ai";
import { useReaderStore } from "@/stores/reader";

const paper: Paper = {
  id: "2607.00001",
  title: "A Sample Paper",
  authors: ["Jane Doe"],
  published: "2026-07-30T00:00:00Z",
  summary: "Abstract.",
  pdfUrl: "https://arxiv.org/pdf/2607.00001",
  categories: ["cs.AI"],
};

const provider: ProviderConfig = {
  id: "p1",
  name: "Mock",
  baseUrl: "http://localhost:8765/v1",
  model: "mock-model",
};

const PDF_TEXT = [
  "1. Introduction",
  "Intro text about attention.",
  "2. Method",
  "Method text about the encoder.",
  "3. Results",
  "Results text.",
].join("\n");

/** Streams chunks with the same call signature the store uses. */
function chunkStream(chunks: string[]) {
  return async (opts: { onChunk: (c: string) => void }) => {
    for (const c of chunks) opts.onChunk(c);
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(getPdfBytes).mockResolvedValue(new Uint8Array([1, 2, 3]));
  vi.mocked(extractTextFromPdf).mockResolvedValue(PDF_TEXT);
  useReaderStore.setState({
    paper: null,
    pdfBytes: null,
    loadStatus: "idle",
    loadError: null,
    sections: [],
    extractStatus: "idle",
    extractError: null,
    sectionIndex: 0,
    sectionEntries: [],
    synthesis: null,
    chat: [],
    selection: null,
  });
});

describe("reader store", () => {
  it("open downloads the PDF and defers text extraction until asked", async () => {
    await useReaderStore.getState().open(paper);

    const s = useReaderStore.getState();
    expect(s.loadStatus).toBe("ready");
    expect(s.pdfBytes).not.toBeNull();
    expect(getPdfBytes).toHaveBeenCalledWith(paper.id, paper.pdfUrl);
    // The whole-paper parse is lazy: no extraction at open time.
    expect(extractTextFromPdf).not.toHaveBeenCalled();
    expect(s.sections).toHaveLength(0);
    expect(s.extractStatus).toBe("idle");

    // First use extracts once and caches the sections.
    expect(await useReaderStore.getState().ensureExtracted()).toBe(true);
    const extracted = useReaderStore.getState();
    expect(extracted.sections).toHaveLength(3);
    expect(extracted.sections[0]).toContain("Intro text");
    expect(extracted.extractStatus).toBe("done");

    await useReaderStore.getState().ensureExtracted();
    expect(extractTextFromPdf).toHaveBeenCalledTimes(1);
  });

  it("extraction failure is reported by ensureExtracted, not by open", async () => {
    vi.mocked(extractTextFromPdf).mockResolvedValue("");
    await useReaderStore.getState().open(paper);
    // The PDF itself is readable: the reader opens normally.
    expect(useReaderStore.getState().loadStatus).toBe("ready");

    expect(await useReaderStore.getState().ensureExtracted()).toBe(false);
    const s = useReaderStore.getState();
    expect(s.extractStatus).toBe("error");
    expect(s.extractError).toContain("No readable text");
  });

  it("open reports the underlying error", async () => {
    vi.mocked(getPdfBytes).mockRejectedValue(new Error("network down"));
    await useReaderStore.getState().open(paper);
    const s = useReaderStore.getState();
    expect(s.loadStatus).toBe("error");
    expect(s.loadError).toBe("network down");
  });

  it("a stale extraction cannot leak into a newer paper", async () => {
    // Extraction for paper A is slow; paper B opens in the meantime.
    let resolveExtract!: (v: string) => void;
    vi.mocked(extractTextFromPdf).mockReturnValue(new Promise((r) => (resolveExtract = r)));
    await useReaderStore.getState().open(paper);
    const ensureA = useReaderStore.getState().ensureExtracted();
    // Paper B opens while A's extraction is still in flight.
    const paperB = { ...paper, id: "2607.00002" };
    await useReaderStore.getState().open(paperB);
    resolveExtract("Text from paper A");
    expect(await ensureA).toBe(false);
    // Paper B's state must not contain paper A's sections.
    expect(useReaderStore.getState().sections).toHaveLength(0);
    expect(useReaderStore.getState().extractStatus).toBe("idle");
  });

  it("walks through sections then synthesis on continue", async () => {
    await useReaderStore.getState().open(paper);
    const store = useReaderStore.getState();

    vi.mocked(streamSectionExplanation).mockImplementation(chunkStream(["intro!"]));
    vi.mocked(streamSynthesis).mockImplementation(chunkStream(["final summary"]));

    await store.startWalkthrough(provider, "en");
    let s = useReaderStore.getState();
    expect(s.sectionEntries).toHaveLength(1);
    expect(s.sectionEntries[0].status).toBe("done");
    expect(s.sectionEntries[0].text).toBe("intro!");
    expect(s.synthesis).toBeNull();

    await useReaderStore.getState().continueWalkthrough(provider, "en");
    s = useReaderStore.getState();
    expect(s.sectionEntries).toHaveLength(2);
    expect(s.sectionIndex).toBe(2);

    await useReaderStore.getState().continueWalkthrough(provider, "en");
    s = useReaderStore.getState();
    expect(s.sectionEntries).toHaveLength(3);

    await useReaderStore.getState().continueWalkthrough(provider, "en");
    s = useReaderStore.getState();
    expect(s.synthesis?.status).toBe("done");
    expect(s.synthesis?.text).toBe("final summary");
  });

  it("section errors surface and stop the walkthrough", async () => {
    await useReaderStore.getState().open(paper);
    vi.mocked(streamSectionExplanation).mockRejectedValue(new Error("provider exploded"));

    await useReaderStore.getState().startWalkthrough(provider, "en");
    const s = useReaderStore.getState();
    expect(s.sectionEntries[0].status).toBe("error");
    expect(s.sectionEntries[0].error).toBe("provider exploded");
  });

  it("regenerate replaces the last section entry in place", async () => {
    await useReaderStore.getState().open(paper);
    vi.mocked(streamSectionExplanation).mockImplementation(chunkStream(["first try"]));

    await useReaderStore.getState().startWalkthrough(provider, "en");
    let s = useReaderStore.getState();
    expect(s.sectionEntries).toHaveLength(1);
    expect(s.sectionEntries[0].text).toBe("first try");
    expect(s.sectionIndex).toBe(1);

    // Redo the same section: the entry is replaced, not appended.
    vi.mocked(streamSectionExplanation).mockImplementation(chunkStream(["second try"]));
    await useReaderStore.getState().regenerateSection(provider, "en");

    s = useReaderStore.getState();
    expect(s.sectionEntries).toHaveLength(1);
    expect(s.sectionEntries[0].text).toBe("second try");
    expect(s.sectionEntries[0].status).toBe("done");
    expect(s.sectionIndex).toBe(1);
  });

  it("regenerate works on a stopped section too", async () => {
    await useReaderStore.getState().open(paper);
    vi.mocked(streamSectionExplanation).mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          // Simulates Stop: the stream rejects with the cancelled marker.
          reject(new Error("🛑PAPYRUS_CANCELLED"));
        }),
    );

    await useReaderStore.getState().startWalkthrough(provider, "en");
    expect(useReaderStore.getState().sectionEntries[0].status).toBe("stopped");

    vi.mocked(streamSectionExplanation).mockImplementation(chunkStream(["redone"]));
    await useReaderStore.getState().regenerateSection(provider, "en");
    const s = useReaderStore.getState();
    expect(s.sectionEntries).toHaveLength(1);
    expect(s.sectionEntries[0].text).toBe("redone");
    expect(s.sectionEntries[0].status).toBe("done");
  });

  it("stopping marks the active section as stopped", async () => {
    await useReaderStore.getState().open(paper);
    vi.mocked(streamSectionExplanation).mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error("🛑PAPYRUS_CANCELLED")), 20);
        }),
    );

    const promise = useReaderStore.getState().startWalkthrough(provider, "en");
    // Stop while the stream is in flight.
    await useReaderStore.getState().stop();
    await promise;

    const s = useReaderStore.getState();
    expect(s.sectionEntries[0].status).toBe("stopped");
  });

  it("a stream started during stop's round-trip stays cancellable", async () => {
    // stop() must not clobber the operation id of a NEW stream that
    // started while the stop IPC was in flight (compare-and-swap): a
    // subsequent stop must still reach the new stream's id.
    let releaseStop!: () => void;
    vi.mocked(stopExplanation).mockReturnValueOnce(
      new Promise((res) => {
        releaseStop = res;
      }),
    );
    await useReaderStore.getState().open(paper);

    // First stream (walkthrough): stays in flight until the backend
    // cancels it, so stop #1 actually runs the IPC.
    let rejectFirst!: (err: Error) => void;
    vi.mocked(streamSectionExplanation).mockImplementationOnce(
      () =>
        new Promise((_res, reject) => {
          rejectFirst = reject;
        }),
    );
    const first = useReaderStore.getState().startWalkthrough(provider, "en");
    await new Promise((r) => setTimeout(r, 20)); // let the stream start

    const stopPromise = useReaderStore.getState().stop();
    // Second stream (an ask answer) starts while the stop IPC is pending.
    let rejectAsk!: (err: Error) => void;
    vi.mocked(streamAsk).mockImplementationOnce(
      () =>
        new Promise((_res, reject) => {
          rejectAsk = reject;
        }),
    );
    const askPromise = useReaderStore.getState().ask("And now?", provider, "en");
    await new Promise((r) => setTimeout(r, 10));

    releaseStop();
    await stopPromise;
    // The backend cancels the first stream.
    rejectFirst(new Error("🛑PAPYRUS_CANCELLED"));
    await first;

    // The ask stream is still streaming: a new stop must reach ITS
    // operation id (op-2), not a stale null left by the first stop.
    const stop2 = useReaderStore.getState().stop();
    await new Promise((r) => setTimeout(r, 10));
    rejectAsk(new Error("🛑PAPYRUS_CANCELLED"));
    await stop2;
    await askPromise;

    expect(vi.mocked(stopExplanation).mock.calls[1]?.[0]).toBe(
      vi.mocked(streamAsk).mock.calls[0]?.[0].operationId,
    );
    expect(useReaderStore.getState().chat[1].status).toBe("stopped");
  });

  it("restores a persisted walkthrough on reopen instead of re-streaming", async () => {
    // Simulate a previous session: paper 2607.00001 has a completed
    // walkthrough stored under the walkthrough key.
    localStorage.setItem(
      "papyrus-reader-walkthrough-v1",
      JSON.stringify({
        "2607.00001": {
          sectionEntries: [
            { text: "Intro explained.", status: "done", error: null },
            { text: "Method explained.", status: "done", error: null },
          ],
          synthesis: { text: "Whole-paper synthesis.", status: "done", error: null },
        },
      }),
    );

    await useReaderStore.getState().open(paper);
    const s = useReaderStore.getState();
    expect(s.sectionEntries.map((e) => e.text)).toEqual(["Intro explained.", "Method explained."]);
    expect(s.synthesis?.text).toBe("Whole-paper synthesis.");
    // The walkthrough continues after the restored entries.
    expect(s.sectionIndex).toBe(2);
    // No re-stream happened for the restored content.
    expect(streamSectionExplanation).not.toHaveBeenCalled();
  });

  it("persists the walkthrough after a section completes", async () => {
    await useReaderStore.getState().open(paper);
    vi.mocked(streamSectionExplanation).mockImplementation(chunkStream(["hello section"]));

    await useReaderStore.getState().startWalkthrough(provider, "en");

    const raw = JSON.parse(localStorage.getItem("papyrus-reader-walkthrough-v1") ?? "{}");
    expect(raw["2607.00001"].sectionEntries[0].text).toBe("hello section");
  });

  it("never restores a busy-looking walkthrough entry", async () => {
    // A crashed session could leave status "streaming" in storage; the
    // restore must normalize it so the UI never sees a stuck spinner.
    localStorage.setItem(
      "papyrus-reader-walkthrough-v1",
      JSON.stringify({
        "2607.00001": {
          sectionEntries: [{ text: "half", status: "streaming", error: null }],
          synthesis: null,
        },
      }),
    );

    await useReaderStore.getState().open(paper);
    const s = useReaderStore.getState();
    expect(s.sectionEntries[0].status).toBe("stopped");
  });

  it("keeps appending chunks across multiple flushes", async () => {
    // Regression test: the first flush flips the entry to "streaming" and
    // later flushes must keep appending. Streaming slowly (20ms per chunk,
    // flush interval 50ms) forces several flush cycles.
    await useReaderStore.getState().open(paper);
    vi.mocked(streamSectionExplanation).mockImplementation(async (opts) => {
      for (const c of ["# ", "Mock ", "explanation", "\n\nMore ", "text"]) {
        await new Promise((r) => setTimeout(r, 20));
        opts.onChunk(c);
      }
    });

    await useReaderStore.getState().startWalkthrough(provider, "en");
    const s = useReaderStore.getState();
    expect(s.sectionEntries[0].status).toBe("done");
    expect(s.sectionEntries[0].text).toBe("# Mock explanation\n\nMore text");
  });

  it("appends ask answers across multiple flushes too", async () => {
    await useReaderStore.getState().open(paper);
    vi.mocked(streamAsk).mockImplementation(async (opts) => {
      for (const c of ["First ", "part", " then ", "rest"]) {
        await new Promise((r) => setTimeout(r, 20));
        opts.onChunk(c);
      }
    });

    await useReaderStore.getState().ask("Explain?", provider, "en");
    const s = useReaderStore.getState();
    expect(s.chat[1].status).toBe("done");
    expect(s.chat[1].text).toBe("First part then rest");
  });

  it("ask appends a user message and streams the answer", async () => {
    await useReaderStore.getState().open(paper);
    vi.mocked(streamAsk).mockImplementation(chunkStream(["answer!"]));

    await useReaderStore.getState().ask("What is the method?", provider, "en");

    const s = useReaderStore.getState();
    expect(s.chat).toHaveLength(2);
    expect(s.chat[0].role).toBe("user");
    expect(s.chat[0].text).toBe("What is the method?");
    expect(s.chat[1].role).toBe("assistant");
    expect(s.chat[1].status).toBe("done");
    expect(s.chat[1].text).toBe("answer!");
    // Context grounding: no selection, so the first section is used.
    expect(streamAsk).toHaveBeenCalledWith(
      expect.objectContaining({
        question: "What is the method?",
        selection: null,
        context: expect.any(String),
      }),
    );
  });

  it("ask uses the selection as context", async () => {
    await useReaderStore.getState().open(paper);
    useReaderStore.getState().setSelection("Method text about the encoder.");
    vi.mocked(streamAsk).mockImplementation(chunkStream(["ok"]));

    await useReaderStore.getState().ask("Explain this passage", provider, "en");

    const call = vi.mocked(streamAsk).mock.calls[0][0];
    expect(call.selection).toBe("Method text about the encoder.");
    expect(call.context).toContain("Method text");
  });

  it("ask sends the recent conversation as history", async () => {
    await useReaderStore.getState().open(paper);
    vi.mocked(streamAsk).mockImplementation(chunkStream(["first answer"]));
    await useReaderStore.getState().ask("First question", provider, "en");

    vi.mocked(streamAsk).mockImplementation(chunkStream(["second answer"]));
    await useReaderStore.getState().ask("Follow-up?", provider, "en");

    const call = vi.mocked(streamAsk).mock.calls[1][0];
    expect(call.history).toEqual([
      { role: "user", content: "First question" },
      { role: "assistant", content: "first answer" },
    ]);
  });

  it("retryAsk re-asks the question behind the last failed answer", async () => {
    await useReaderStore.getState().open(paper);
    vi.mocked(streamAsk).mockRejectedValueOnce(new Error("provider down"));
    await useReaderStore.getState().ask("Why does this work?", provider, "en");
    expect(useReaderStore.getState().chat[1].status).toBe("error");

    // Retry drops the failed message and re-asks the same question.
    vi.mocked(streamAsk).mockImplementation(chunkStream(["fresh answer"]));
    await useReaderStore.getState().retryAsk(provider, "en");

    const s = useReaderStore.getState();
    expect(s.chat).toHaveLength(2);
    expect(s.chat[0].text).toBe("Why does this work?");
    expect(s.chat[1].text).toBe("fresh answer");
    expect(s.chat[1].status).toBe("done");
    expect(vi.mocked(streamAsk)).toHaveBeenLastCalledWith(
      expect.objectContaining({ question: "Why does this work?" }),
    );
  });

  it("chat history persists and reloads per paper", async () => {
    await useReaderStore.getState().open(paper);
    vi.mocked(streamAsk).mockImplementation(chunkStream(["persisted answer"]));
    await useReaderStore.getState().ask("Remember me?", provider, "en");

    useReaderStore.getState().close();
    await useReaderStore.getState().open(paper);

    const s = useReaderStore.getState();
    expect(s.chat.length).toBeGreaterThanOrEqual(2);
    expect(s.chat[1].text).toBe("persisted answer");
    localStorage.removeItem("papyrus-reader-chat-v1");
  });

  it("caps persisted chat transcripts by paper count (plan 074)", async () => {
    // Seed 41 older papers, then ask on the open paper: 42 keys -> 2 evicted.
    const seed: Record<string, unknown[]> = {};
    for (let i = 0; i < 41; i++) seed[`x${i}`] = [{ role: "user", content: "old" }];
    localStorage.setItem("papyrus-reader-chat-v1", JSON.stringify(seed));

    await useReaderStore.getState().open(paper);
    vi.mocked(streamAsk).mockImplementation(chunkStream(["capped"]));
    await useReaderStore.getState().ask("Q?", provider, "en");

    const raw = JSON.parse(localStorage.getItem("papyrus-reader-chat-v1") ?? "{}") as Record<
      string,
      unknown
    >;
    const keys = Object.keys(raw);
    expect(keys.length).toBeLessThanOrEqual(40);
    // The active paper survives its own write; the oldest seeds went.
    expect(raw[paper.id]).toBeDefined();
    expect(raw.x0).toBeUndefined();
    expect(raw.x1).toBeUndefined();
  });

  it("evicts the oldest paper, never the just-touched active one (plan 074)", async () => {
    // The active paper is the OLDEST key: its own write must touch it to
    // the end of the LRU order so it survives while a newer key is evicted.
    const seed: Record<string, unknown[]> = {
      [paper.id]: [{ role: "user", content: "oldest" }],
    };
    for (let i = 0; i < 40; i++) seed[`x${i}`] = [{ role: "user", content: "old" }];
    localStorage.setItem("papyrus-reader-chat-v1", JSON.stringify(seed));

    await useReaderStore.getState().open(paper);
    vi.mocked(streamAsk).mockImplementation(chunkStream(["kept"]));
    await useReaderStore.getState().ask("Q?", provider, "en");

    const raw = JSON.parse(localStorage.getItem("papyrus-reader-chat-v1") ?? "{}") as Record<
      string,
      unknown
    >;
    expect(Object.keys(raw).length).toBeLessThanOrEqual(40);
    expect(raw[paper.id]).toBeDefined();
    expect(raw.x0).toBeUndefined();
    localStorage.removeItem("papyrus-reader-chat-v1");
  });

  it("close resets everything", async () => {
    await useReaderStore.getState().open(paper);
    useReaderStore.getState().close();
    const s = useReaderStore.getState();
    expect(s.paper).toBeNull();
    expect(s.pdfBytes).toBeNull();
    expect(s.sections).toHaveLength(0);
  });

  it("a slow open for paper A cannot overwrite paper B opened after it", async () => {
    const paperB = { ...paper, id: "2607.00002", title: "Paper B" };
    // Paper A's PDF download resolves AFTER paper B's open finished.
    let resolveA: (bytes: Uint8Array) => void = () => {};
    vi.mocked(getPdfBytes).mockImplementationOnce(
      () => new Promise<Uint8Array>((resolve) => (resolveA = resolve)),
    );
    const openA = useReaderStore.getState().open(paper);
    expect(useReaderStore.getState().loadStatus).toBe("loading");

    // Paper B opens and completes normally.
    vi.mocked(getPdfBytes).mockResolvedValueOnce(new Uint8Array([9, 9, 9]));
    await useReaderStore.getState().open(paperB);
    expect(useReaderStore.getState().paper?.id).toBe("2607.00002");
    expect(useReaderStore.getState().loadStatus).toBe("ready");

    // Now A's download finishes: its results must be dropped entirely.
    resolveA(new Uint8Array([1, 2, 3]));
    await openA;
    const s = useReaderStore.getState();
    expect(s.paper?.id).toBe("2607.00002");
    expect(s.pdfBytes).toEqual(new Uint8Array([9, 9, 9]));
    expect(s.loadStatus).toBe("ready");
  });

  it("close invalidates an in-flight open", async () => {
    let resolveBytes: (bytes: Uint8Array) => void = () => {};
    vi.mocked(getPdfBytes).mockImplementationOnce(
      () => new Promise<Uint8Array>((resolve) => (resolveBytes = resolve)),
    );
    const openPromise = useReaderStore.getState().open(paper);
    useReaderStore.getState().close();
    resolveBytes(new Uint8Array([1, 2, 3]));
    await openPromise;
    // The stale open must not resurrect a closed reader.
    expect(useReaderStore.getState().paper).toBeNull();
    expect(useReaderStore.getState().loadStatus).toBe("idle");
  });

  it("malformed persisted chat entries are dropped on load", async () => {
    localStorage.setItem(
      "papyrus-reader-chat-v1",
      JSON.stringify({
        [paper.id]: [
          { id: 1, role: "user", text: "valid", status: "done", error: null, selection: null },
          {
            id: 2,
            role: "system",
            text: "invalid role",
            status: "done",
            error: null,
            selection: null,
          },
          { id: 3, role: "assistant", text: 42, status: "done", error: null, selection: null },
          null,
        ],
      }),
    );
    await useReaderStore.getState().open(paper);
    const s = useReaderStore.getState();
    expect(s.chat).toHaveLength(1);
    expect(s.chat[0].text).toBe("valid");
  });
});
