// Browser operation registry tests: stopping one operation must never
// abort another, and late chunks after a stop are ignored by the caller.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { newOperationId, stopExplanation, streamChatBrowser } from "@/lib/ai";

function sseBody(chunks: string[]): string {
  return (
    chunks
      .map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`)
      .join("") + "data: [DONE]\n\n"
  );
}

describe("browser operation registry", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stop aborts only the targeted operation", async () => {
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    vi.mocked(fetch)
      // op A: a stream that hangs until aborted.
      .mockImplementationOnce(
        (_url, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
            controllerA.signal.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }),
      )
      // op B: a normal stream that completes.
      .mockImplementationOnce(
        (_url, init?: RequestInit) =>
          new Promise<Response>((resolve) => {
            init?.signal?.addEventListener("abort", () => controllerB.abort());
            const body = new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(sseBody(["B answer"])));
                controller.close();
              },
            });
            resolve(new Response(body, { status: 200 }));
          }),
      );

    const opA = newOperationId();
    const opB = newOperationId();
    const chunksB: string[] = [];
    const runA = streamChatBrowser(
      { id: "a", name: "A", baseUrl: "http://localhost:1/v1", model: "m" },
      [],
      () => {},
      opA,
    );
    const runB = streamChatBrowser(
      { id: "b", name: "B", baseUrl: "http://localhost:1/v1", model: "m" },
      [],
      (c) => chunksB.push(c),
      opB,
    );

    await stopExplanation(opA);
    await expect(runA).rejects.toThrow();
    // B must be completely unaffected: no abort, full content.
    await runB;
    expect(chunksB).toEqual(["B answer"]);
    expect(controllerB.signal.aborted).toBe(false);
  });

  it("stop with an unknown id is a no-op", async () => {
    await expect(stopExplanation(newOperationId())).resolves.toBeUndefined();
  });
});
