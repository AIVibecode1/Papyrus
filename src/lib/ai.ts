import { Channel, invoke } from "@tauri-apps/api/core";
import type { Paper, ProviderConfig } from "@/lib/types";
// Single source of truth for the AI layer (system prompts + cancellation
// marker) — the same file the Rust backend reads via include_str! in
// src-tauri/src/ai.rs. Edit the JSON, never the code.
import prompts from "../../src-tauri/prompts.json";

// The typed cancellation contract: Rust emits this exact string (from the
// shared resource) when a user stops an explanation, and the store classifies
// a stop by matching it as a prefix.
export const CANCELLED_MARKER = prompts.cancelledMarker;

// Operation registry: each in-flight stream owns its AbortController,
// keyed by the same operation id the Rust backend registers. Stopping one
// operation can never abort another (mirror of the Rust registry in
// src-tauri/src/ai.rs).
const activeControllers = new Map<string, AbortController>();

/** Fresh unique operation id for one stream command (browser + Tauri). */
export function newOperationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `op-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Dev-only key store for the browser preview (when the app runs outside Tauri
// there is no OS keychain). Keys stay in memory only — never persisted.
// ---------------------------------------------------------------------------
const browserKeys = new Map<string, string>();

export function setBrowserKey(id: string, key: string) {
  browserKeys.set(id, key);
}
export function getBrowserKey(id: string) {
  return browserKeys.get(id) ?? "";
}
export function deleteBrowserKey(id: string) {
  browserKeys.delete(id);
}
export function hasBrowserKey(id: string) {
  return browserKeys.has(id);
}

export function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

// Divergence from the Rust URL contract (build_chat_url, plan 008): Rust
// rejects plaintext http:// for remote hosts and allows it only for loopback
// servers; the browser dev path keeps the simpler rule (no scheme validation)
// because it only talks to local preview servers. The https path is shared
// and cross-checked by ai-contract.test.ts.
export function normalizeBaseUrl(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  return `${trimmed}/chat/completions`;
}

// Keep in sync with redact_tokens in src-tauri/src/ai.rs — same pattern
// list, same semantics (mask token-like runs of >= 6 chars, leave short
// prefixes like "sk-8" alone). Applied to provider error bodies before
// they surface in the UI, so a gateway that echoes the submitted key back
// in a 401/400 body cannot leak it into the explanation panel.
export function redactTokens(text: string): string {
  return text.replace(/(sk-|sk_|key-|key_|ghp_|xai-|Bearer\s|bearer\s)[A-Za-z0-9_-]{6,}/g, "$1***");
}

function buildMessages(paper: Paper, language: string) {
  const system = language === "ar" ? prompts.systemPromptAr : prompts.systemPromptEn;
  const user = [
    `Title: ${paper.title}`,
    `Authors: ${paper.authors.join(", ")}`,
    `Published: ${paper.published}`,
    `Categories: ${paper.categories.join(", ")}`,
    "",
    "Abstract:",
    paper.summary,
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

export interface ExplainOptions {
  /** Ordered chain: the picked provider first, then fallbacks (deduped). */
  providers: ProviderConfig[];
  paper: Paper;
  language: string;
  /** Operation id shared with the Rust registry; Stop targets exactly this. */
  operationId: string;
  onChunk: (chunk: string) => void;
}

/** Streams an explanation through the provider chain. Inside Tauri the
 * Rust backend tries each provider (keys fetched from the OS keychain
 * there); in a plain browser the same loop runs here with the in-memory
 * dev keys. Resolves with the WINNING provider id. */
export async function streamExplanation(opts: ExplainOptions): Promise<string> {
  const { providers, paper, language, operationId, onChunk } = opts;

  if (isTauri()) {
    const channel = new Channel<string>();
    channel.onmessage = (msg) => onChunk(msg);
    return await invoke<string>("explain_paper", {
      operationId,
      providers,
      paper,
      language,
      onChunk: channel,
    });
  }

  return streamExplanationBrowser(opts);
}

export { streamChatBrowser };

export async function stopExplanation(operationId: string | null): Promise<void> {
  if (isTauri()) {
    await invoke("stop_explaining", { operationId });
    return;
  }
  if (operationId) {
    activeControllers.get(operationId)?.abort();
  }
}

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
async function streamChatBrowser(
  provider: ProviderConfig,
  messages: { role: string; content: string }[],
  onChunk: (chunk: string) => void,
  operationId: string,
): Promise<void> {
  const key = getBrowserKey(provider.id);

  const controller = new AbortController();
  activeControllers.set(operationId, controller);
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
    activeControllers.delete(operationId);
  }
}

async function streamExplanationBrowser(opts: ExplainOptions): Promise<string> {
  const { providers, paper, language, operationId, onChunk } = opts;
  const messages = buildMessages(paper, language);
  // Browser mirror of the Rust failover loop (same discriminator: only
  // pre-first-chunk failures are retried; the marker is terminal).
  const failures: string[] = [];
  for (const provider of providers) {
    if (activeControllers.get(operationId)?.signal.aborted) throw new Error(CANCELLED_MARKER);
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
