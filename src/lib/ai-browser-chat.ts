import type { ProviderConfig } from "@/lib/types";
import { getBrowserKey } from "./ai-browser-keys";
import { CANCELLED_MARKER, buildMessages, normalizeBaseUrl, redactTokens } from "./ai-contract";
import type { ExplainOptions } from "./ai-contract";
import { isOperationAborted, trackOperation, untrackOperation } from "./ai-operations";

// SSE parser contract (both languages MUST match):
// - Lines are split on \n (stripping trailing \r).
// - Only lines starting with "data:" carry payloads; ": " comments and
//   blanks are ignored.
// - "[DONE]" ends the stream successfully.
// - A clean close WITHOUT [DONE] is SUCCESS if content was received
//   (Rust: Ok(full); TS: resolve) and an error if nothing was received.
// - Cancellation surfaces the CANCELLED_MARKER string (Rust: Err(marker);
//   TS: throw Error(marker)).
// - Delta payloads are JSON objects; content lives at choices[0].delta.content.
// - A data frame carrying `error` is a stream failure, not a delta.

/** Mirrors MAX_SSE_LINE_BYTES in src-tauri/src/ai/stream.rs. */
const MAX_SSE_LINE_CHARS = 1024 * 1024;
/** Mirrors MAX_STREAM_TEXT_BYTES in src-tauri/src/ai/stream.rs. */
const MAX_STREAM_TEXT_CHARS = 4 * 1024 * 1024;

export async function streamChatBrowser(
  provider: ProviderConfig,
  messages: { role: string; content: string }[],
  onChunk: (chunk: string) => void,
  operationId: string,
): Promise<void> {
  const key = getBrowserKey(provider.id);

  const controller = trackOperation(operationId);
  try {
    const res = await fetch(normalizeBaseUrl(provider.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({
        model: provider.model,
        messages,
        stream: true,
        temperature: 0.4,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${redactTokens(text).slice(0, 300)}`);
    }
    if (!res.body) throw new Error("Provider returned an empty response.");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let received = false;
    let total = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // A peer that never emits a newline would grow `buf` without bound.
      // One SSE event is normally a few hundred bytes.
      if (buf.length > MAX_SSE_LINE_CHARS) {
        throw new Error("Provider sent an oversized stream frame");
      }
      let newline: number;
      while ((newline = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, newline).replace(/\r$/, "");
        buf = buf.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          // Mirrors the Rust side: [DONE] with nothing before it is a
          // failure, not an empty success.
          if (!received) throw new Error("Provider returned no content");
          return;
        }
        // Parse in its own try: only malformed JSON is tolerated here.
        // Throwing inside the same try would let the catch below swallow
        // the deliberate error-frame/bounds failures.
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue; // keep-alive comments and partial JSON are ignored
        }
        const value = parsed as {
          error?: { message?: unknown };
          choices?: { delta?: { content?: unknown } }[];
        };
        // Gateways report mid-stream failures as a data frame carrying
        // `error`; without this it is dropped and the run "succeeds".
        const errMessage = value?.error?.message;
        if (typeof errMessage === "string") {
          throw new Error(redactTokens(errMessage).slice(0, 300));
        }
        const content = value?.choices?.[0]?.delta?.content;
        if (typeof content === "string" && content) {
          received = true;
          if (total + content.length > MAX_STREAM_TEXT_CHARS) {
            throw new Error("Provider response exceeded the size limit");
          }
          total += content.length;
          onChunk(content);
        }
      }
    }
    // Clean close without [DONE]: success only if content arrived.
    if (!received) throw new Error("Stream ended unexpectedly");
  } catch (err) {
    // A stop aborts the fetch signal; surface it through the same typed
    // cancellation contract the Tauri path uses (plan 005).
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(CANCELLED_MARKER, { cause: err });
    }
    throw err;
  } finally {
    untrackOperation(operationId);
  }
}

export async function streamExplanationBrowser(opts: ExplainOptions): Promise<string> {
  const { providers, paper, language, operationId, onChunk } = opts;
  const messages = buildMessages(paper, language);
  // Browser mirror of the Rust failover loop (same discriminator: only
  // pre-first-chunk failures are retried; the marker is terminal).
  const failures: string[] = [];
  for (const provider of providers) {
    if (isOperationAborted(operationId)) throw new Error(CANCELLED_MARKER);
    let delivered = false;
    try {
      await streamChatBrowser(
        provider,
        messages,
        (chunk) => {
          delivered = true;
          onChunk(chunk);
        },
        operationId,
      );
      return provider.id;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith(CANCELLED_MARKER)) throw err;
      if (delivered) throw err;
      failures.push(`${provider.name}: ${message}`);
    }
  }
  throw new Error(
    `All ${providers.length} providers failed: ${failures.join(" | ").slice(0, 500)}`,
  );
}

/** Minimal chat request used by the Settings "Test" button (browser preview). */
export async function testProviderBrowser(p: ProviderConfig): Promise<string> {
  const key = getBrowserKey(p.id);
  const res = await fetch(normalizeBaseUrl(p.baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({
      model: p.model,
      messages: [{ role: "user", content: "Reply with the single word: OK" }],
      stream: false,
      max_tokens: 8,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${redactTokens(text).slice(0, 300)}`);
  }
  const json = await res.json();
  return json?.choices?.[0]?.message?.content?.trim() ?? "Connected";
}
