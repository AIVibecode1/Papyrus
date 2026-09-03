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

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, newline).replace(/\r$/, "");
        buf = buf.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          const parsed = JSON.parse(data);
          const content = parsed?.choices?.[0]?.delta?.content;
          if (content) onChunk(content);
        } catch {
          // keep-alive comments and partial JSON are ignored
        }
      }
    }
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
