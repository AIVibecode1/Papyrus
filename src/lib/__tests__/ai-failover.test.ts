// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import { streamExplanation, stopExplanation, setBrowserKey } from "@/lib/ai";
import type { Paper, ProviderConfig } from "@/lib/types";

// Mirrors the Rust failover contract (ai.rs `explain_with_failover`):
// only pre-first-chunk failures are retried; once a provider has
// delivered content, any later error is terminal.

const paper: Paper = {
  id: "2607.00001",
  title: "A Sample Paper",
  authors: ["Jane Doe"],
  published: "2026-07-30T00:00:00Z",
  summary: "Abstract.",
  pdfUrl: "https://arxiv.org/pdf/2607.00001",
  categories: ["cs.AI"],
};

const p1: ProviderConfig = {
  id: "p1",
  name: "First",
  baseUrl: "http://localhost:9001/v1",
  model: "m",
};
const p2: ProviderConfig = {
  id: "p2",
  name: "Second",
  baseUrl: "http://localhost:9002/v1",
  model: "m",
};

/** SSE stream whose reads can throw mid-stream to simulate a reset. */
function sseResponse(chunks: string[], failAfter?: number) {
  let i = 0;
  return {
    ok: true,
    status: 200,
    text: async () => "",
    body: {
      getReader: () => ({
        read: async () => {
          if (failAfter !== undefined && i >= failAfter) {
            throw new Error("connection reset by provider");
          }
          if (i >= chunks.length) return { done: true, value: undefined };
          const value = new TextEncoder().encode(chunks[i]);
          i += 1;
          return { done: false, value };
        },
      }),
    },
  };
}

function sseEvent(content: string) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  setBrowserKey("p1", "k1");
  setBrowserKey("p2", "k2");
});

describe("browser failover (streamExplanationBrowser)", () => {
  it("does not retry after a provider has delivered content", async () => {
    // Provider 1 streams one chunk, then the connection resets: because
    // content was already delivered, the error must be terminal — no
    // failover to provider 2 (the Rust side has the same discriminator).
    fetchMock
      .mockResolvedValueOnce(sseResponse([sseEvent("partial answer")], /* failAfter */ 1))
      .mockResolvedValueOnce(sseResponse([sseEvent("should never be read")]));

    const chunks: string[] = [];
    await expect(
      streamExplanation({
        providers: [p1, p2],
        paper,
        language: "en",
        operationId: "op-failover-1",
        onChunk: (c) => chunks.push(c),
      }),
    ).rejects.toThrow("connection reset by provider");

    expect(chunks).toEqual(["partial answer"]);
    expect(fetchMock).toHaveBeenCalledTimes(1); // provider 2 never tried
  });

  it("fails over to the next provider when nothing was delivered", async () => {
    // Provider 1 fails with HTTP 500 before any chunk: that IS retried.
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => "boom" })
      .mockResolvedValueOnce(sseResponse([sseEvent("the real answer"), sseEvent("!")]));

    const chunks: string[] = [];
    const winner = await streamExplanation({
      providers: [p1, p2],
      paper,
      language: "en",
      operationId: "op-failover-2",
      onChunk: (c) => chunks.push(c),
    });

    expect(winner).toBe("p2");
    expect(chunks.join("")).toBe("the real answer!");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("propagates the cancellation marker without failover", async () => {
    // The stream hangs until the stop cancels its controller; the abort
    // surfaces as the typed cancellation marker and no provider is retried.
    fetchMock.mockImplementationOnce((_url: string, init?: RequestInit) => {
      return new Promise((_res, rej) => {
        init?.signal?.addEventListener("abort", () => {
          rej(new DOMException("aborted", "AbortError"));
        });
      });
    });

    const pending = streamExplanation({
      providers: [p1, p2],
      paper,
      language: "en",
      operationId: "op-failover-3",
      onChunk: () => {},
    });
    // Wait for the fetch to be in flight, then cancel it the same way
    // the UI does (stopExplanation aborts the active controller).
    await new Promise((r) => setTimeout(r, 10));
    await stopExplanation("op-failover-3");

    await expect(pending).rejects.toThrow("PAPYRUS_CANCELLED");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
