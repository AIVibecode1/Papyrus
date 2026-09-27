import { afterEach, describe, expect, it, vi } from "vitest";

import { streamChatBrowser } from "@/lib/ai-browser-chat";
import type { ProviderConfig } from "@/lib/types";

const provider: ProviderConfig = {
  id: "p1",
  name: "Test",
  baseUrl: "https://api.example.com/v1",
  model: "m",
};

function sseResponse(body: string): Response {
  return new Response(body, { status: 200 });
}

/** Builds an SSE body from raw `data:` payloads, newline-terminated. */
function frame(payload: string): string {
  return `data: ${payload}\n\n`;
}

const DELTA = (content: string) => frame(JSON.stringify({ choices: [{ delta: { content } }] }));

async function run(body: string): Promise<{ text: string; chunks: string[] }> {
  const chunks: string[] = [];
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse(body)));
  try {
    await streamChatBrowser(
      provider,
      [{ role: "user", content: "hi" }],
      (c) => chunks.push(c),
      "op-1",
    );
  } finally {
    vi.unstubAllGlobals();
  }
  return { text: chunks.join(""), chunks };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("streamChatBrowser SSE handling", () => {
  it("delivers deltas across split chunks and returns on [DONE]", async () => {
    const { text } = await run(DELTA("Hel") + DELTA("lo") + frame("[DONE]"));
    expect(text).toBe("Hello");
  });

  it("reassembles an event split mid-line across reads", async () => {
    // The first read ends without a newline, so the payload is only
    // parseable once the second read completes it.
    const enc = new TextEncoder();
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(enc.encode('data: {"choices":[{"delta":{"cont'));
        } else {
          controller.enqueue(enc.encode('ent":"split"}}]}\n\ndata: [DONE]\n\n'));
          controller.close();
        }
      },
    });
    const chunks: string[] = [];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
    await streamChatBrowser(
      provider,
      [{ role: "user", content: "hi" }],
      (c) => chunks.push(c),
      "op-1",
    );
    vi.unstubAllGlobals();
    expect(chunks.join("")).toBe("split");
  });

  it("treats [DONE] with no content as a failure, not empty success", async () => {
    // Regression: this used to resolve successfully, so the panel showed
    // a blank explanation card marked "done" with no way to tell it failed.
    await expect(run(frame("[DONE]"))).rejects.toThrow(/no content/i);
  });

  it("treats a clean close with no content as a failure", async () => {
    await expect(run("")).rejects.toThrow(/ended unexpectedly|no content/i);
  });

  it("surfaces a mid-stream error frame instead of dropping it", async () => {
    // OpenAI-compatible gateways report mid-stream failures as a data
    // frame carrying `error`. It parses as JSON but has no delta.content,
    // so it used to be ignored and the run reported success.
    const body = DELTA("partial") + frame(JSON.stringify({ error: { message: "rate limited" } }));
    await expect(run(body)).rejects.toThrow(/rate limited/);
  });

  it("redacts a secret echoed inside a mid-stream error frame", async () => {
    const secret = "sk-ABCDEFGHIJKLMNOP";
    const body = frame(JSON.stringify({ error: { message: `bad key ${secret}` } }));
    await expect(run(body)).rejects.toThrow(/bad key/);
    await expect(run(body)).rejects.not.toThrow(new RegExp("ABCDEFGHIJKLMNOP"));
  });

  it("ignores keep-alive comments and role-only deltas", async () => {
    const body =
      ": keep-alive\n\n" +
      frame(JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })) +
      DELTA("ok") +
      frame("[DONE]");
    const { text } = await run(body);
    expect(text).toBe("ok");
  });
});
