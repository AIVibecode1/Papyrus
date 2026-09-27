import { describe, expect, it, vi } from "vitest";
// Shared resource: the same file the Rust backend reads (include_str! in
// src-tauri/src/ai.rs) — these tests pin the cross-language contract.
import prompts from "../../../src-tauri/prompts.json";
import { CANCELLED_MARKER, normalizeBaseUrl, streamExplanation } from "@/lib/ai";
import { buildQaUser, buildSectionUser } from "@/lib/reader-ai";
import type { Paper, ProviderConfig } from "@/lib/types";

// isTauri() checks "__TAURI_INTERNALS__" in window; node has no window, so
// provide an empty one to force the browser (fetch-based) path.
globalThis.window = {} as unknown as Window & typeof globalThis;

// Mirrors sample_paper() in src-tauri/src/ai.rs so the message-shape test
// asserts exactly what messages_follow_ui_language asserts in Rust.
const paper: Paper = {
  id: "2607.12345",
  title: "A Test Paper",
  authors: ["Jane Doe"],
  published: "2026-07-31T17:59:59Z",
  summary: "A summary of the test paper.",
  pdfUrl: "https://arxiv.org/pdf/2607.12345",
  categories: ["cs.AI"],
};

const provider: ProviderConfig = {
  id: "prov1",
  name: "Test provider",
  baseUrl: "https://example.com/v1",
  model: "test-model",
};

describe("shared AI resource (src-tauri/prompts.json)", () => {
  it("loads both system prompts", () => {
    // Mirrors the Rust messages_follow_ui_language assertions.
    expect(prompts.systemPromptEn).toContain("smart colleague");
    expect(prompts.systemPromptAr).toContain("واتساب");
    expect(prompts.systemPromptEn.length).toBeGreaterThan(0);
    expect(prompts.systemPromptAr.length).toBeGreaterThan(0);
  });

  it("exports the cancellation marker straight from the resource", () => {
    expect(CANCELLED_MARKER).toBe(prompts.cancelledMarker);
    expect(CANCELLED_MARKER).toBe("\u{1F6D1}PAPYRUS_CANCELLED");
  });

  it("system prompts follow the labmate-voice methodology", () => {
    // Labmate voice, vagueness-calling and the ~300-word shape must be
    // present in both languages (user mandate). Assertions track the
    // CURRENT prompts wording (the user rewrote them in v2 — Slack/WhatsApp
    // register with aim/avoid examples), not the original versions.
    const en = prompts.systemPromptEn;
    const ar = prompts.systemPromptAr;
    expect(en).toContain("smart colleague");
    expect(en).toContain("Slack");
    expect(en).toContain("300");
    expect(en).toContain("call that out");
    expect(ar).toContain("لزميل ذكي");
    expect(ar).toContain("واتساب");
    expect(ar).toContain("٣٠٠");
    expect(ar).toContain("لاتكس");
  });

  it("provides the full-paper journal-club structure for the reader feature", () => {
    // Saved as the single source for the whole-PDF reader walkthrough.
    expect(prompts.fullPaperStructureEn).toContain("journal club");
    expect(prompts.fullPaperStructureEn).toContain("equation");
    expect(prompts.fullPaperStructureAr).toContain("المعادلات");
    expect(prompts.fullPaperStructureAr).toContain("نقاش مقال بحثي");
  });

  it("provides qa and synthesis prompts in both languages", () => {
    expect(prompts.qaPromptEn).toContain("hallway");
    expect(prompts.qaPromptEn).toContain("question");
    expect(prompts.qaPromptAr).toContain("الممر");
    expect(prompts.synthesisPromptEn).toContain("ideas worth keeping");
    expect(prompts.synthesisPromptAr).toContain("أهم خمس أفكار");
  });

  it("reader message builders match the Rust format strings", () => {
    // Mirrors build_section_messages / build_qa_messages in ai.rs.
    const paper: Paper = {
      id: "2607.00001",
      title: "A Test Paper",
      authors: ["Jane Doe"],
      published: "2026-07-30T00:00:00Z",
      summary: "Abstract.",
      pdfUrl: "https://arxiv.org/pdf/2607.00001",
      categories: ["cs.AI"],
    };
    const section = buildSectionUser(paper, 2, 5, "The method uses a transformer.");
    expect(section).toContain("Paper title: A Test Paper");
    expect(section).toContain("Section 2 of 5:");
    expect(section).toContain("The method uses a transformer.");

    const qa = buildQaUser(paper, "Why does it work?", "Selected text.", "Section context.");
    expect(qa).toContain("Selected passage from the paper:\nSelected text.");
    expect(qa).toContain("Relevant part of the paper:\nSection context.");
    expect(qa).toContain("Question: Why does it work?");
  });
});

describe("cross-language contract checks", () => {
  it("normalizeBaseUrl matches the Rust build_chat_url contract for https", () => {
    // build_chat_url in src-tauri/src/ai.rs: trim, strip trailing slashes,
    // append /chat/completions unless already present (plan 008).
    expect(normalizeBaseUrl("https://x/v1")).toBe("https://x/v1/chat/completions");
    expect(normalizeBaseUrl("https://x/v1/")).toBe("https://x/v1/chat/completions");
    expect(normalizeBaseUrl("https://x/v1/chat/completions")).toBe("https://x/v1/chat/completions");
    // Loopback http:// is allowed Rust-side only (see the divergence note
    // above normalizeBaseUrl); the TS dev path keeps the simpler rule.
  });

  it("builds the user message in the exact shape messages_follow_ui_language asserts (Rust)", async () => {
    const onChunk = vi.fn();
    // A real provider sends at least one delta before [DONE]. Sending
    // [DONE] alone is treated as a failure (nothing was produced), so the
    // fixture has to be realistic to keep testing the request body.
    const sse = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' + "data: [DONE]\n\n";
    const fetchMock = vi.fn().mockResolvedValue(new Response(sse, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await streamExplanation({
        providers: [provider],
        paper,
        language: "en",
        operationId: "contract-op",
        onChunk,
      });
    } finally {
      vi.unstubAllGlobals();
    }

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    const user = body.messages[1];
    expect(user.role).toBe("user");
    // Exact field order per the Rust format string
    // "Title: {}\nAuthors: {}\nPublished: {}\nCategories: {}\n\nAbstract:\n{}":
    const lines: string[] = (user.content as string).split("\n");
    expect(lines[0]).toBe("Title: A Test Paper");
    expect(lines[1]).toBe("Authors: Jane Doe");
    expect(lines[2]).toBe("Published: 2026-07-31T17:59:59Z");
    expect(lines[3]).toBe("Categories: cs.AI");
    expect(lines[4]).toBe("");
    expect(lines[5]).toBe("Abstract:");
    expect(lines[6]).toBe("A summary of the test paper.");
    expect(lines).toHaveLength(7);
    // The system prompt in the same payload comes from the shared resource.
    expect(body.messages[0].content).toBe(prompts.systemPromptEn);
  });
});
