import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderConfig } from "@/lib/types";

const { isTauriMock, browserKeys } = vi.hoisted(() => ({
  isTauriMock: vi.fn(() => false),
  browserKeys: new Map<string, string>(),
}));

// isTauri() is mocked false so the browser path runs; the in-memory browser
// key store lives here in the mock (mirrors @/lib/ai's browserKeys map).
vi.mock("@/lib/ai", () => ({
  isTauri: isTauriMock,
  setBrowserKey: (id: string, key: string) => {
    browserKeys.set(id, key);
  },
  getBrowserKey: (id: string) => browserKeys.get(id) ?? "",
  deleteBrowserKey: (id: string) => {
    browserKeys.delete(id);
  },
  hasBrowserKey: (id: string) => browserKeys.has(id),
  testProviderBrowser: vi.fn(async () => "Connected"),
}));

import { useSettingsStore } from "@/stores/settings";

// The vitest environment is "node" — provide an in-memory localStorage so the
// store's browser persistence path is exercisable.
function createMemoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => {
      data.delete(key);
    },
    setItem: (key, value) => {
      data.set(key, String(value));
    },
  } as Storage;
}

const localStorageMock = createMemoryStorage();
vi.stubGlobal("localStorage", localStorageMock);

const provider: ProviderConfig = {
  id: "prov1",
  name: "Test provider",
  baseUrl: "https://example.com/v1",
  model: "test-model",
};

describe("settings store", () => {
  beforeEach(() => {
    localStorageMock.clear();
    browserKeys.clear();
    useSettingsStore.setState({
      providers: [],
      activeProviderId: null,
      loaded: false,
    });
  });

  it("load with empty storage yields empty providers", () => {
    useSettingsStore.getState().load();
    const s = useSettingsStore.getState();
    expect(s.providers).toEqual([]);
    expect(s.activeProviderId).toBeNull();
    expect(s.loaded).toBe(true);
  });

  it("addProvider persists and sets active when none active", () => {
    useSettingsStore.getState().load();
    useSettingsStore.getState().addProvider(provider);
    const s = useSettingsStore.getState();
    expect(s.providers).toEqual([provider]);
    expect(s.activeProviderId).toBe(provider.id);
    expect(localStorageMock.getItem("papyrus-providers")).toBe(
      JSON.stringify([provider]),
    );
  });

  it("load with corrupted JSON does not throw", () => {
    localStorageMock.setItem("papyrus-providers", "not json");
    // Current behavior: load catches and returns empty (plan 012 extends
    // validation; keep this test as the baseline).
    expect(() => useSettingsStore.getState().load()).not.toThrow();
    const s = useSettingsStore.getState();
    expect(s.providers).toEqual([]);
    expect(s.loaded).toBe(true);
  });

  it("load drops malformed provider entries", () => {
    localStorageMock.setItem(
      "papyrus-providers",
      JSON.stringify([
        { id: "a", name: "A", baseUrl: "https://x", model: "m" },
        null,
        { id: "b" },
        "garbage",
      ]),
    );
    useSettingsStore.getState().load();
    const s = useSettingsStore.getState();
    expect(s.providers).toEqual([
      { id: "a", name: "A", baseUrl: "https://x", model: "m" },
    ]);
  });

  it("load with non-array JSON yields empty", () => {
    localStorageMock.setItem("papyrus-providers", "{}");
    expect(() => useSettingsStore.getState().load()).not.toThrow();
    const s = useSettingsStore.getState();
    expect(s.providers).toEqual([]);
    expect(s.loaded).toBe(true);
  });

  it("activeProviderId dangling id is repaired", () => {
    const validA: ProviderConfig = {
      id: "a",
      name: "A",
      baseUrl: "https://x",
      model: "m",
    };
    localStorageMock.setItem("papyrus-providers", JSON.stringify([validA]));
    localStorageMock.setItem("papyrus-active-provider", "ghost");
    useSettingsStore.getState().load();
    const s = useSettingsStore.getState();
    expect(s.providers).toEqual([validA]);
    expect(s.activeProviderId).toBe("a");
  });

  it("saveKey then hasKey is true (browser path)", async () => {
    await useSettingsStore.getState().saveKey(provider.id, "sk-test");
    expect(await useSettingsStore.getState().hasKey(provider.id)).toBe(true);
  });

  it("deleteKey makes hasKey false", async () => {
    await useSettingsStore.getState().saveKey(provider.id, "sk-test");
    expect(await useSettingsStore.getState().hasKey(provider.id)).toBe(true);
    await useSettingsStore.getState().deleteKey(provider.id);
    expect(await useSettingsStore.getState().hasKey(provider.id)).toBe(false);
  });
});
