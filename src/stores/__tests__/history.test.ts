// @vitest-environment jsdom
// Plan 060: reading history store behavior. The jsdom environment makes
// isTauri() false, so the store exercises the localStorage persistence
// path (same JSON shape the Rust disk path uses).
import { beforeEach, describe, expect, it } from "vitest";

import type { Paper, ReadingHistoryEntry } from "@/lib/types";
import { HISTORY_CAP, paperFromEntry, upsertHistory, useHistoryStore } from "@/stores/history";

const STORAGE_KEY = "papyrus-reading-history-v1";

const paper: Paper = {
  id: "p1",
  title: "Attention Is All You Need",
  authors: ["Ashish Vaswani"],
  published: "2017-06-12",
  summary: "",
  pdfUrl: "https://arxiv.org/pdf/1706.03762",
  categories: ["cs.CL"],
};

function entry(paperId: string, openedAt: string, title = `Paper ${paperId}`): ReadingHistoryEntry {
  return {
    paperId,
    title,
    authors: ["A. Author"],
    published: "2026-01-01",
    pdfUrl: `https://arxiv.org/pdf/${paperId}`,
    categories: ["cs.AI"],
    source: "arxiv",
    lastOpenedAt: openedAt,
  };
}

beforeEach(() => {
  localStorage.clear();
  useHistoryStore.setState({ entries: [], loaded: false });
});

describe("upsertHistory (pure)", () => {
  it("prepends new entries", () => {
    const list = upsertHistory([], entry("p1", "2026-08-01T00:00:00Z"));
    expect(list).toHaveLength(1);
    expect(list[0].paperId).toBe("p1");
  });

  it("moves an existing entry to the top with the fresh timestamp", () => {
    let list = [entry("p1", "2026-08-01T00:00:00Z"), entry("p2", "2026-08-02T00:00:00Z")];
    list = upsertHistory(list, entry("p1", "2026-08-03T00:00:00Z"));
    expect(list).toHaveLength(2);
    expect(list[0].paperId).toBe("p1");
    expect(list[0].lastOpenedAt).toBe("2026-08-03T00:00:00Z");
    expect(list[1].paperId).toBe("p2");
  });

  it("caps the list at 200, dropping the oldest-opened entries", () => {
    let list: ReadingHistoryEntry[] = [];
    for (let i = 0; i < 250; i += 1) {
      list = upsertHistory(list, entry(`p${i}`, `2026-08-01T00:00:${String(i).padStart(2, "0")}Z`));
    }
    expect(list).toHaveLength(HISTORY_CAP);
    expect(list[0].paperId).toBe("p249");
    expect(list.some((e) => e.paperId === "p0")).toBe(false);
  });
});

describe("useHistoryStore", () => {
  it("records an opened paper and persists it", () => {
    useHistoryStore.getState().recordOpen(paper);
    const state = useHistoryStore.getState();
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0].paperId).toBe("p1");
    expect(state.entries[0].title).toBe("Attention Is All You Need");
    expect(state.entries[0].source).toBe("arxiv");

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as ReadingHistoryEntry[];
    expect(stored).toHaveLength(1);
    expect(stored[0].paperId).toBe("p1");
  });

  it("reopening the same paper refreshes lastOpenedAt and stays at top", async () => {
    useHistoryStore.getState().recordOpen(paper);
    await new Promise((r) => setTimeout(r, 5));
    const first = useHistoryStore.getState().entries[0].lastOpenedAt;

    useHistoryStore.getState().recordOpen(paper);
    const entries = useHistoryStore.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].lastOpenedAt >= first).toBe(true);
  });

  it("loads persisted entries newest first and ignores corrupted storage", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        entry("p2", "2026-08-02T00:00:00Z"),
        entry("p1", "2026-08-03T00:00:00Z"),
        { garbage: true },
      ]),
    );
    await useHistoryStore.getState().load();
    const entries = useHistoryStore.getState().entries;
    expect(entries).toHaveLength(2);
    expect(entries[0].paperId).toBe("p1");
    expect(entries[1].paperId).toBe("p2");

    localStorage.setItem(STORAGE_KEY, "not json {{");
    useHistoryStore.setState({ loaded: false, entries: [] });
    await useHistoryStore.getState().load();
    expect(useHistoryStore.getState().entries).toEqual([]);
  });

  it("removes a single entry", async () => {
    useHistoryStore.getState().recordOpen(paper);
    await useHistoryStore.getState().remove("p1");
    expect(useHistoryStore.getState().entries).toEqual([]);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("[]");
  });

  it("clears the whole list", async () => {
    useHistoryStore.getState().recordOpen(paper);
    await useHistoryStore.getState().clear();
    expect(useHistoryStore.getState().entries).toEqual([]);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("[]");
  });

  it("imports merge by paperId keeping the newer lastOpenedAt", async () => {
    useHistoryStore.getState().recordOpen(paper);
    // Incoming copy is OLDER: local entry wins untouched.
    await useHistoryStore.getState().importHistory([entry("p1", "2000-01-01T00:00:00Z")]);
    expect(useHistoryStore.getState().entries).toHaveLength(1);
    expect(useHistoryStore.getState().entries[0].lastOpenedAt > "2000-01-01T00:00:00Z").toBe(true);

    // Incoming copy is NEWER and brings a fresh paper: both merge.
    const newer = { ...entry("p1", "2099-01-01T00:00:00Z"), title: "Updated title" };
    await useHistoryStore.getState().importHistory([newer, entry("p2", "2099-01-02T00:00:00Z")]);
    const entries = useHistoryStore.getState().entries;
    expect(entries).toHaveLength(2);
    expect(entries[0].paperId).toBe("p2");
    expect(entries.find((e) => e.paperId === "p1")?.title).toBe("Updated title");
  });
});

describe("paperFromEntry", () => {
  it("rebuilds a Paper the reader can open", () => {
    const rebuilt = paperFromEntry(entry("p1", "2026-08-01T00:00:00Z"));
    expect(rebuilt.id).toBe("p1");
    expect(rebuilt.pdfUrl).toBe("https://arxiv.org/pdf/p1");
    expect(rebuilt.summary).toBe("");
  });
});
