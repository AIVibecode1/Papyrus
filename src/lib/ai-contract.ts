import type { Paper, ProviderConfig } from "@/lib/types";
// Single source of truth for the AI layer (system prompts + cancellation
// marker) — the same file the Rust backend reads via include_str!
// (see src-tauri/src/ai/). Edit the JSON, never the code.
import prompts from "../../src-tauri/prompts.json";

// The typed cancellation contract: Rust emits this exact string (from the
// shared resource) when a user stops an explanation, and the store classifies
// a stop by matching it as a prefix.
export const CANCELLED_MARKER = prompts.cancelledMarker;

/**
 * Shape expected by Rust after serde rename_all = "camelCase" (the
 * ProviderConfig struct in src-tauri/src/ai/mod.rs). Every provider that
 * crosses the IPC boundary must pass through here so the wire contract
 * stays explicit — a plain ProviderConfig object serializes to the same
 * keys, but this makes the dependency visible at each invoke site.
 */
export function toIpcProvider(p: ProviderConfig): {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
} {
  return {
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    model: p.model,
  };
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

// Keep in sync with redact_tokens in src-tauri/src/ai/ — same pattern
// list, same semantics (mask token-like runs of >= 6 chars, leave short
// prefixes like "sk-8" alone). Applied to provider error bodies before
// they surface in the UI, so a gateway that echoes the submitted key back
// in a 401/400 body cannot leak it into the explanation panel.
export function redactTokens(text: string): string {
  const prefixed = text.replace(
    /(sk-|sk_|key-|key_|ghp_|xai-|Bearer\s|bearer\s)[A-Za-z0-9_-]{6,}/g,
    "$1***",
  );
  // Generic fallback: long opaque runs (>= 32 token-ish chars) with no
  // recognizable prefix, e.g. raw keys echoed by custom gateways. Same
  // rule as the Rust side. Runs this long are never normal words.
  return prefixed.replace(/[A-Za-z0-9_.-]{32,}/g, "***");
}

export function buildMessages(paper: Paper, language: string) {
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
