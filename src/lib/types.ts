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
  openai: {
    key: "presets.openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    keyRequired: true,
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
