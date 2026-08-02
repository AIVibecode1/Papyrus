import { Channel, invoke } from "@tauri-apps/api/core";
import type { Paper, ProviderConfig } from "@/lib/types";

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

export function normalizeBaseUrl(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  return `${trimmed}/chat/completions`;
}

// Keep in sync with src-tauri/src/ai.rs (SYSTEM_PROMPT_EN / SYSTEM_PROMPT_AR).
const SYSTEM_PROMPT_EN =
  "You are Papyrus, an assistant that explains academic research papers to a general audience. Explain the paper in simple, clear language. Structure your answer as short paragraphs covering: (1) What the paper is about — the main idea, (2) How it works — the method in plain terms, (3) Key results, (4) Why it matters. Keep it around 200-300 words. Do not use markdown tables. Always respond in English.";

const SYSTEM_PROMPT_AR =
  "أنت «بابيروس»، مساعد يشرح الأوراق البحثية الأكاديمية لعامة الجمهور بلغة بسيطة وواضحة. نظّم إجابتك في فقرات قصيرة تغطي: (1) ما موضوع الورقة — الفكرة الرئيسية، (2) كيف تعمل — المنهج بعبارات بسيطة، (3) النتائج الرئيسية، (4) لماذا هي مهمة. اجعل الشرح حوالي ٢٠٠-٣٠٠ كلمة. لا تستخدم جداول ماركداون. أجب دائمًا باللغة العربية الفصحى.";

function buildMessages(paper: Paper, language: string) {
  const system = language === "ar" ? SYSTEM_PROMPT_AR : SYSTEM_PROMPT_EN;
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
  provider: ProviderConfig;
  paper: Paper;
  language: string;
  onChunk: (chunk: string) => void;
}

/** Streams an explanation. Inside Tauri it goes through the Rust backend
 * (key fetched from the OS keychain there); in a plain browser it calls the
 * provider directly using the in-memory dev key. */
export async function streamExplanation(opts: ExplainOptions): Promise<void> {
  const { provider, paper, language, onChunk } = opts;

  if (isTauri()) {
    const channel = new Channel<string>();
    channel.onmessage = (msg) => onChunk(msg);
    await invoke("explain_paper", { provider, paper, language, onChunk: channel });
    return;
  }

  await streamExplanationBrowser(opts);
}

export async function stopExplanation(): Promise<void> {
  if (isTauri()) {
    await invoke("stop_explaining");
  }
}

async function streamExplanationBrowser(opts: ExplainOptions): Promise<void> {
  const { provider, paper, language, onChunk } = opts;
  const key = getBrowserKey(provider.id);

  const res = await fetch(normalizeBaseUrl(provider.baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({
      model: provider.model,
      messages: buildMessages(paper, language),
      stream: true,
      temperature: 0.4,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
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
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  return json?.choices?.[0]?.message?.content?.trim() ?? "Connected";
}
