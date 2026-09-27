import { describe, expect, it } from "vitest";
import { redactTokens } from "@/lib/ai";

// Mirrors the Rust unit tests for redact_tokens in src-tauri/src/ai.rs —
// the two implementations must stay in sync.

describe("redactTokens", () => {
  it("redacts token-shaped substrings", () => {
    const body = `{"error": "invalid key sk-abcdef123456"}`;
    const out = redactTokens(body);
    expect(out).toContain("sk-***");
    expect(out).not.toContain("abcdef123456");
  });

  it("leaves normal error text untouched", () => {
    const body = "Provider returned HTTP 401: rate limit exceeded";
    expect(redactTokens(body)).toBe(body);
  });

  it("masks every token in a body", () => {
    const body = "invalid keys: sk-abcdef123456 and key_GHIJKLmnopqr";
    const out = redactTokens(body);
    expect(out).toContain("sk-***");
    expect(out).toContain("key_***");
    expect(out).not.toContain("abcdef123456");
    expect(out).not.toContain("GHIJKLmnopqr");
  });

  it("ignores short prefixes like sk-8", () => {
    expect(redactTokens("The sk-8 model")).toBe("The sk-8 model");
  });

  it("still masks a real key that follows a short sk- shaped run", () => {
    // Regression: a short "sk-8" earlier in the body once aborted the
    // whole scan on the Rust side, so a real key echoed after it reached
    // the UI. The 32-char fallback cannot cover it — real keys are
    // routinely shorter than that.
    const secret = "sk-ABCDEFGHIJKLMNOP";
    expect(redactTokens(`model sk-8 rejected; credential ${secret}`)).not.toContain(
      "ABCDEFGHIJKLMNOP",
    );
    expect(redactTokens(`sk-8 ${secret}`)).not.toContain("ABCDEFGHIJKLMNOP");
  });

  it("masks prefixless long keys (mirrors the Rust fallback)", () => {
    const body = "401 invalid api_key: a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f";
    const out = redactTokens(body);
    expect(out).not.toContain("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f");
    expect(out).toContain("***");
  });

  it("keeps urls and short hashes (mirrors the Rust fallback)", () => {
    const body = "check https://example.com/status/abc123 for details (id 42)";
    expect(redactTokens(body)).toBe(body);
  });
});
