import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Paper } from "@/lib/types";

// The vitest environment is "node" — provide an in-memory localStorage so
// the store's browser persistence path is exercisable (same pattern as the
// settings suite).
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

import { useFavoritesStore } from "@/stores/favorites";

function makePaper(id: string): Paper {
  return {
    id,
    title: `Paper ${id}`,
    authors: ["A. Author"],
    published: "2026-07-01T00:00:00Z",
    summary: "A test summary.",
    pdfUrl: `https://arxiv.org/pdf/${id}`,
    categories: ["cs.AI"],
  };
}

describe("favorites store", () => {
  beforeEach(() => {
    localStorageMock.clear();
    useFavoritesStore.setState({ ids: [], byId: {}, loaded: false });
  });

  it("toggle adds then removes", () => {
    const paper = makePaper("2607.00001v1");
    useFavoritesStore.getState().toggle(paper);
    expect(useFavoritesStore.getState().ids).toEqual(["2607.00001v1"]);
    useFavoritesStore.getState().toggle(paper);
    expect(useFavoritesStore.getState().ids).toEqual([]);
    expect(useFavoritesStore.getState().byId).toEqual({});
  });

  it("persists across load", () => {
    const paper = makePaper("2607.00001v1");
    useFavoritesStore.getState().toggle(paper);
    expect(localStorageMock.getItem("papyrus-favorites")).toBe(
      JSON.stringify({ "2607.00001v1": paper }),
    );
    useFavoritesStore.setState({ loaded: false });
    useFavoritesStore.getState().load();
    const s = useFavoritesStore.getState();
    expect(s.ids).toEqual(["2607.00001v1"]);
    expect(s.byId["2607.00001v1"]).toEqual(paper);
  });

  it("load with corrupted storage does not throw", () => {
    localStorageMock.setItem("papyrus-favorites", "not json");
    expect(() => useFavoritesStore.getState().load()).not.toThrow();
    const s = useFavoritesStore.getState();
    expect(s.ids).toEqual([]);
    expect(s.byId).toEqual({});
    expect(s.loaded).toBe(true);
  });

  it("saved order is insertion order", () => {
    useFavoritesStore.getState().toggle(makePaper("2607.00001v1"));
    useFavoritesStore.getState().toggle(makePaper("2607.00002v1"));
    expect(useFavoritesStore.getState().ids).toEqual([
      "2607.00001v1",
      "2607.00002v1",
    ]);
  });
});
