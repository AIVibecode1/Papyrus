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
