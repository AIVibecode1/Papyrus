export interface Paper {
  id: string;
  title: string;
  authors: string[];
  published: string;
  summary: string;
  pdfUrl: string;
  categories: string[];
  /** Semantic Scholar enrichment; absent for arXiv papers. */
  citationCount?: number;
  /** Model-generated one-liner (S2); used as a summary fallback only. */
  tldr?: string;
  venue?: string;
}

export type NoteKind = "note" | "highlight";

/** A note or highlight attached to a paper (plan 042). Persisted by the
 * Rust notes.rs commands in the app data dir; never leaves the device
 * unless the user exports. */
export interface PaperNote {
  id: string; // uuid v4
  paperId: string;
  /** Denormalized for the hub list without re-fetching papers. */
  paperTitle: string;
  kind: NoteKind;
  /** Markdown; for highlights, the user comment (may be empty). */
  body: string;
  /** Required for highlights. */
  quote?: string;
  /** 1-based page number when known. */
  page?: number;
  createdAt: string; // ISO
  updatedAt: string; // ISO
  /** Max 5 short tags. */
  tags?: string[];
}

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
}

export interface ProviderPresetModel {
  id: string;
  /** Human label shown in the model picker (e.g. "DeepSeek V4 Flash"). */
  label: string;
}

export interface ProviderPreset {
  key: string;
  baseUrl: string;
  model: string;
  keyRequired: boolean;
  /** When present, the model field becomes a picker of these models. */
  models?: ProviderPresetModel[];
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  // OpenAI via the standard API key path (plan 053): "OpenAI" is the
  // preset name — Codex is an OpenAI app, not the account model, and a
  // ChatGPT Plus login is NOT an API key. gpt-5.3-codex stays listed as
  // one of the models (it is a real public API model, verified 2026-08);
  // the 5.6 family is the current frontier (Sol/Terra/Luna).
  openai: {
    key: "presets.openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.3-codex",
    keyRequired: true,
    models: [
      { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
      { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
      { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
    ],
  },
  openrouter: {
    key: "presets.openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "deepseek/deepseek-chat",
    keyRequired: true,
  },
  deepseek: {
    key: "presets.deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    keyRequired: true,
    models: [
      { id: "deepseek-chat", label: "DeepSeek Chat" },
      { id: "deepseek-reasoner", label: "DeepSeek Reasoner" },
    ],
  },
  groq: {
    key: "presets.groq",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile",
    keyRequired: true,
  },
  ollama: {
    key: "presets.ollama",
    baseUrl: "http://localhost:11434/v1",
    model: "llama3.2",
    keyRequired: false,
  },
  opencode: {
    key: "presets.opencode",
    baseUrl: "https://opencode.ai/zen/go/v1/chat/completions",
    model: "deepseek-v4-flash",
    keyRequired: true,
    models: [{ id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" }],
  },
};

/**
 * All provider presets in insertion order: the single source of truth
 * for Settings quick-add and the preset picker. Keeps the registry easy
 * to extend (043 adds Codex here) without callers poking at the record
 * ad hoc.
 */
export function listProviderPresets(): Array<{ id: string; preset: ProviderPreset }> {
  return Object.entries(PROVIDER_PRESETS).map(([id, preset]) => ({ id, preset }));
}
