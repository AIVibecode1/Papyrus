import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CANCELLED_MARKER, stopExplanation, streamExplanation } from "@/lib/ai";
import type { Paper, ProviderConfig } from "@/lib/types";

// isTauri() checks "__TAURI_INTERNALS__" in window; node has no window, so
// provide an empty one to force the browser (fetch-based) path.
globalThis.window = {} as any;

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

function sseResponse(chunks: (string | Uint8Array)[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          typeof chunk === "string" ? encoder.encode(chunk) : chunk,
        );
      }
      controller.close();
    },
  });
  return new Response(body, { status });
}

describe("streamExplanation (browser SSE parser)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses streamed SSE deltas in order", async () => {
    const onChunk = vi.fn();
    fetchMock.mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );

    await streamExplanation({ provider, paper, language: "en", onChunk });

    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(onChunk).toHaveBeenCalledWith("Hello");
  });

  it("handles split lines across chunks", async () => {
    const onChunk = vi.fn();
    fetchMock.mockResolvedValue(
      sseResponse([
        // First chunk ends mid-line — TextDecoder stream:true + line buffer
        // must reassemble it.
        'data: {"choices":[{"delta":{"content":"Hel',
        'lo"}}]}\n\ndata: [DONE]\n\n',
      ]),
    );

    await streamExplanation({ provider, paper, language: "en", onChunk });

    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(onChunk).toHaveBeenCalledWith("Hello");
  });

  it("ignores keep-alive lines", async () => {
    const onChunk = vi.fn();
    fetchMock.mockResolvedValue(
      sseResponse([
        ": ping\n\n",
        "event: message\n",
        'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );

    await streamExplanation({ provider, paper, language: "en", onChunk });

    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(onChunk).toHaveBeenCalledWith("Hi");
  });

  it("surfaces HTTP errors with status code", async () => {
    const onChunk = vi.fn();
    fetchMock.mockResolvedValue(new Response("unauthorized", { status: 401 }));

    await expect(
      streamExplanation({ provider, paper, language: "en", onChunk }),
    ).rejects.toThrow("HTTP 401: unauthorized");
    expect(onChunk).not.toHaveBeenCalled();
  });

  it("clean close without [DONE] exits normally", async () => {
    const onChunk = vi.fn();
    fetchMock.mockResolvedValue(
      sseResponse(['data: {"choices":[{"delta":{"content":"Bye"}}]}\n\n']),
    );

    // Current behavior: the loop breaks on done — no throw. (The Rust parser
    // errors here; fixed by plan 001 — the TS side is the reference.)
    await expect(
      streamExplanation({ provider, paper, language: "en", onChunk }),
    ).resolves.toBeUndefined();
    expect(onChunk).toHaveBeenCalledWith("Bye");
  });
});

describe("stopExplanation (browser abort)", () => {
  it("stop aborts the in-flight browser stream and surfaces the cancellation marker", async () => {
    const encoder = new TextEncoder();
    let chunkDelivered: () => void;
    const chunkPromise = new Promise<void>((resolve) => {
      chunkDelivered = resolve;
    });
    const onChunk = vi.fn(() => chunkDelivered());

    let fetchInit: RequestInit | undefined;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      fetchInit = init;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'),
          );
          // Never end the stream; a stop must abort the fetch signal, which
          // errors the body reader with AbortError (as real fetch does).
          init?.signal?.addEventListener("abort", () => {
            controller.error(
              new DOMException("The operation was aborted.", "AbortError"),
            );
          });
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = streamExplanation({
      provider,
      paper,
      language: "en",
      onChunk,
    });
    await chunkPromise; // stream is in flight and delivered its first chunk
    await stopExplanation();

    await expect(promise).rejects.toThrow(CANCELLED_MARKER);
    expect(fetchInit?.signal).toBeInstanceOf(AbortSignal);
    expect(onChunk).toHaveBeenCalledTimes(1); // nothing streams after the stop
  });
});
