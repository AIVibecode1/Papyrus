import { describe, expect, it } from "vitest";
import { normalizeBaseUrl } from "@/lib/ai";

describe("normalizeBaseUrl", () => {
  it("appends /chat/completions to a plain /v1 base URL", () => {
    expect(normalizeBaseUrl("https://api.openai.com/v1")).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
  });

  it("handles a trailing-slash base URL", () => {
    expect(normalizeBaseUrl("https://api.openai.com/v1/")).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
  });

  it("passes an already-full URL through unchanged", () => {
    expect(normalizeBaseUrl("https://api.openai.com/v1/chat/completions")).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
  });
});
