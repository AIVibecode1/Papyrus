export interface Paper {
  id: string;
  title: string;
  authors: string[];
  published: string;
  summary: string;
  pdfUrl: string;
  categories: string[];
}

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
}

export interface ProviderPreset {
  key: string;
  baseUrl: string;
  model: string;
  keyRequired: boolean;
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
};
