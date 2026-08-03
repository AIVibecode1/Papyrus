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
vi.mock("@/lib/ai", () => ({
  CANCELLED_MARKER: "🛑PAPYRUS_CANCELLED",
  stopExplanation: vi.fn(),
}));

import { getPdfBytes } from "@/lib/pdf";
import { extractTextFromPdf } from "@/lib/pdf-text";
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
    sectionIndex: 0,
    sectionEntries: [],
    synthesis: null,
    chat: [],
    selection: null,
  });
});

describe("reader store", () => {
  it("open extracts text, splits sections and loads chat", async () => {
    await useReaderStore.getState().open(paper);

    const s = useReaderStore.getState();
    expect(s.loadStatus).toBe("ready");
    expect(s.pdfBytes).not.toBeNull();
    expect(s.sections).toHaveLength(3);
    expect(s.sections[0]).toContain("Intro text");
    expect(getPdfBytes).toHaveBeenCalledWith(paper.id, paper.pdfUrl);
  });

  it("open reports an error when no text can be extracted", async () => {
    vi.mocked(extractTextFromPdf).mockResolvedValue("");
    await useReaderStore.getState().open(paper);
    expect(useReaderStore.getState().loadStatus).toBe("error");
  });

  it("open reports the underlying error", async () => {
    vi.mocked(getPdfBytes).mockRejectedValue(new Error("network down"));
    await useReaderStore.getState().open(paper);
    const s = useReaderStore.getState();
    expect(s.loadStatus).toBe("error");
    expect(s.loadError).toBe("network down");
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

  it("close resets everything", async () => {
    await useReaderStore.getState().open(paper);
    useReaderStore.getState().close();
    const s = useReaderStore.getState();
    expect(s.paper).toBeNull();
    expect(s.pdfBytes).toBeNull();
    expect(s.sections).toHaveLength(0);
  });
});
