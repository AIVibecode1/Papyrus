import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import {
  deleteBrowserKey,
  hasBrowserKey,
  isTauri,
  setBrowserKey,
  testProviderBrowser,
} from "@/lib/ai";
import type { ProviderConfig } from "@/lib/types";

const STORAGE_KEY = "papyrus-providers";
const ACTIVE_KEY = "papyrus-active-provider";

// Mirrors the Rust validate_provider limits (ai.rs): id <= 64, name 1-64,
// model non-empty, baseUrl non-empty. Keeps corrupted/legacy localStorage
// from leaking malformed providers into explain requests.
function isProviderConfig(value: unknown): value is ProviderConfig {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" && v.id.length > 0 && v.id.length <= 64 &&
    typeof v.name === "string" && v.name.length > 0 && v.name.length <= 64 &&
    typeof v.baseUrl === "string" && v.baseUrl.length > 0 &&
    typeof v.model === "string" && v.model.length > 0
  );
}

interface SettingsState {
  providers: ProviderConfig[];
  activeProviderId: string | null;
  loaded: boolean;
  load: () => void;
  addProvider: (p: ProviderConfig) => void;
  updateProvider: (p: ProviderConfig) => void;
  removeProvider: (id: string) => void;
  setActiveProvider: (id: string) => void;
  saveKey: (providerId: string, key: string) => Promise<void>;
  deleteKey: (providerId: string) => Promise<void>;
  hasKey: (providerId: string) => Promise<boolean>;
  testProvider: (p: ProviderConfig) => Promise<string>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  providers: [],
  activeProviderId: null,
  loaded: false,

  load: () => {
    if (get().loaded) return;
    try {
      const parsed = JSON.parse(
        localStorage.getItem(STORAGE_KEY) ?? "[]",
      ) as unknown;
      const providers = Array.isArray(parsed)
        ? parsed.filter(isProviderConfig)
        : [];
      let activeProviderId = localStorage.getItem(ACTIVE_KEY);
      if (
        typeof activeProviderId === "string" &&
        !providers.some((p) => p.id === activeProviderId)
      ) {
        activeProviderId = providers[0]?.id ?? null;
      }
      set({ providers, activeProviderId, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  addProvider: (p) =>
    set((s) => {
      const providers = [...s.providers, p];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(providers));
      return { providers, activeProviderId: s.activeProviderId ?? p.id };
    }),

  updateProvider: (p) =>
    set((s) => {
      const providers = s.providers.map((x) => (x.id === p.id ? p : x));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(providers));
      return { providers };
    }),

  removeProvider: (id) =>
    set((s) => {
      const providers = s.providers.filter((x) => x.id !== id);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(providers));
      return {
        providers,
        activeProviderId:
          s.activeProviderId === id ? (providers[0]?.id ?? null) : s.activeProviderId,
      };
    }),

  setActiveProvider: (id) => {
    localStorage.setItem(ACTIVE_KEY, id);
    set({ activeProviderId: id });
  },

  saveKey: async (providerId, key) => {
    if (isTauri()) {
      await invoke("save_api_key", { providerId, key });
    } else {
      setBrowserKey(providerId, key);
    }
  },

  deleteKey: async (providerId) => {
    if (isTauri()) {
      await invoke("delete_api_key", { providerId });
    } else {
      deleteBrowserKey(providerId);
    }
  },

  hasKey: async (providerId) => {
    if (isTauri()) {
      return invoke<boolean>("has_api_key", { providerId });
    }
    return hasBrowserKey(providerId);
  },

  testProvider: async (p) => {
    if (isTauri()) {
      return invoke<string>("test_provider", { provider: p });
    }
    return testProviderBrowser(p);
  },
}));
