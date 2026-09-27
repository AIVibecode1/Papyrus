/**
 * Safe categorization of provider test failures.
 *
 * The backend (Rust test_provider) never returns key material, but
 * defense in depth: anything that looks like a token is redacted here
 * too, and raw messages are truncated before they reach the UI.
 *
 * Reuse note: `redactTokens` in @/lib/ai is the single canonical masker
 * (it mirrors `redact_tokens` in src-tauri/src/ai/stream.rs). This file
 * used to carry its own weaker `sk-`-only regex, which meant a `key_…`
 * or prefixless key echoed by a custom gateway was masked in Rust but
 * rendered raw in the cards that call this module.
 */

import { redactTokens } from "@/lib/ai";

export type TestErrorCategory = "url" | "auth" | "network" | "model" | "unknown";

/** Anything that looks like a bearer/API key token. */
export function redactSecrets(message: string): string {
  return redactTokens(message);
}

/** Caps raw provider messages so details never flood the UI. */
export function truncateError(message: string, max = 160): string {
  return message.length > max ? `${message.slice(0, max)}…` : message;
}

/**
 * Maps backend error text to a translated guidance category. Check order
 * matters: reqwest network errors embed the URL ("error sending request
 * for url ..."), so network wins over url; auth checks come before model
 * because auth errors can mention the model.
 */
export function categorizeTestError(message: string): TestErrorCategory {
  const m = message.toLowerCase();
  if (
    m.includes("error sending request") ||
    m.includes("timed out") ||
    m.includes("timeout") ||
    m.includes("connect") ||
    m.includes("network") ||
    m.includes("dns") ||
    m.includes("resolve") ||
    m.includes("tls") ||
    m.includes("certificate") ||
    m.includes("refused")
  ) {
    return "network";
  }
  if (
    m.includes("401") ||
    m.includes("403") ||
    m.includes("unauthorized") ||
    m.includes("forbidden") ||
    m.includes("authentication") ||
    m.includes("api key") ||
    m.includes("key not found")
  ) {
    return "auth";
  }
  if (
    m.includes("model") ||
    m.includes("404") ||
    m.includes("not found") ||
    m.includes("no such")
  ) {
    return "model";
  }
  if (m.includes("url") || m.includes("invalid provider")) {
    return "url";
  }
  return "unknown";
}
