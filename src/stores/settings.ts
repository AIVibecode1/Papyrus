import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import {
  deleteBrowserKey,
  hasBrowserKey,
  isTauri,
  setBrowserKey,
  testProviderBrowser,
  toIpcProvider,
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
    typeof v.id === "string" &&
    v.id.length > 0 &&
    v.id.length <= 64 &&
    typeof v.name === "string" &&
    v.name.length > 0 &&
    v.name.length <= 64 &&
    typeof v.baseUrl === "string" &&
    v.baseUrl.length > 0 &&
    typeof v.model === "string" &&
    v.model.length > 0
  );
}

interface SettingsState {
  providers: ProviderConfig[];
  activeProviderId: string | null;
  loaded: boolean;
  /** Set when the saved provider blob could not be read. Until it is
   * cleared, writes are refused: the list on disk is intact but unread, so
   * persisting the empty in-memory list would destroy it. */
  loadError: string | null;
  load: () => void;
  /** Discards an unreadable provider blob and starts a fresh list. Only the
   * user may call this: it is the one action that can destroy the old blob. */
  discardUnreadableProviders: () => void;
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
  loadError: null,

  load: () => {
    if (get().loaded) return;
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as unknown;
      const providers = Array.isArray(parsed) ? parsed.filter(isProviderConfig) : [];
      let activeProviderId = localStorage.getItem(ACTIVE_KEY);
      if (
        typeof activeProviderId === "string" &&
        !providers.some((p) => p.id === activeProviderId)
      ) {
        activeProviderId = providers[0]?.id ?? null;
      }
      set({ providers, activeProviderId, loaded: true, loadError: null });
    } catch (err) {
      // Do NOT mark this loaded-and-empty as success. The blob is still on
      // disk, so the next addProvider would rewrite it with a one-element
      // array and every saved provider config would be lost with no warning.
      // Surface the failure and refuse writes until the user clears it.
      set({
        loaded: true,
        loadError: err instanceof Error ? err.message : String(err),
      });
    }
  },

  discardUnreadableProviders: () => {
    // The user chose to start over. API keys are NOT touched: they live in
    // the OS keychain under their own ids, so a provider can be re-added
    // and re-pointed at its existing key.
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(ACTIVE_KEY);
    set({ providers: [], activeProviderId: null, loaded: true, loadError: null });
  },

  addProvider: (p) =>
    set((s) => {
      // Refuse to persist over an unreadable blob. The user's providers are
      // still on disk; writing the empty in-memory list here would replace
      // them with a single entry and the loss would be silent.
      if (s.loadError) return {};
      const providers = [...s.providers, p];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(providers));
      return { providers, activeProviderId: s.activeProviderId ?? p.id };
    }),

  updateProvider: (p) =>
    set((s) => {
      if (s.loadError) return {};
      const providers = s.providers.map((x) => (x.id === p.id ? p : x));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(providers));
      return { providers };
    }),

  removeProvider: (id) =>
    set((s) => {
      if (s.loadError) return {};
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
      // The backend binds the key to this base URL, so the stored key is
      // only ever sent to the host the user saved it for — a caller
      // cannot later point a real provider id at a host of its choosing.
      const provider = get().providers.find((p) => p.id === providerId);
      await invoke("save_api_key", {
        providerId,
        key,
        baseUrl: provider?.baseUrl ?? null,
      });
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
      return invoke<string>("test_provider", { provider: toIpcProvider(p) });
    }
    return testProviderBrowser(p);
  },
}));
