// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import { buildExportPayload, importSavedData } from "@/lib/export";
import type { Paper, PaperNote } from "@/lib/types";
import { useFavoritesStore } from "@/stores/favorites";
import { useHistoryStore } from "@/stores/history";
import { useNotesStore } from "@/stores/notes";
import { CHAT_STORAGE_KEY } from "@/stores/reader-persist";

const paper: Paper = {
  id: "p1",
  title: "Saved paper",
  authors: ["A. Author"],
  published: "2026-01-01",
  summary: "A summary.",
  pdfUrl: "https://arxiv.org/pdf/1234.5678",
  categories: ["cs.AI"],
};

const note: PaperNote = {
  id: "n1",
  paperId: "p1",
  paperTitle: "Saved paper",
  kind: "note",
  body: "A local note.",
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-02T00:00:00Z",
};

describe("buildExportPayload", () => {
  beforeEach(() => {
    localStorage.clear();
    useFavoritesStore.setState({ ids: [], byId: {}, loaded: false });
    useNotesStore.setState({ notes: [], loaded: false });
  });

  it("includes favorites and chat transcripts", () => {
    useFavoritesStore.getState().toggle(paper);
    localStorage.setItem(
      CHAT_STORAGE_KEY,
      JSON.stringify({
        p1: [
          { id: 1, role: "user", content: "What is this?", status: "done" },
          { id: 2, role: "assistant", content: "A paper about things.", status: "done" },
        ],
      }),
    );

    const payload = buildExportPayload();

    expect(payload.app).toBe("papyrus");
    expect(payload.favorites).toEqual([paper]);
    expect(payload.chat.p1).toEqual([
      { role: "user", content: "What is this?" },
      { role: "assistant", content: "A paper about things." },
    ]);
  });

  it("includes saved notes", () => {
    useNotesStore.setState({ notes: [note], loaded: true });

    const payload = buildExportPayload();

    expect(payload.notes).toEqual([note]);
  });

  it("includes reading history", () => {
    useHistoryStore.setState({
      entries: [
        {
          paperId: "p1",
          title: "Saved paper",
          authors: ["A. Author"],
          published: "2026-01-01",
          pdfUrl: "https://arxiv.org/pdf/1234.5678",
          categories: ["cs.AI"],
          lastOpenedAt: "2026-08-01T00:00:00Z",
        },
      ],
      loaded: true,
    });

    const payload = buildExportPayload();

    expect(payload.readingHistory).toHaveLength(1);
    expect(payload.readingHistory[0].paperId).toBe("p1");
  });

  it("never exports key-shaped fields (security regression)", () => {
    useFavoritesStore.getState().toggle(paper);
    useNotesStore.setState({ notes: [note], loaded: true });

    const json = JSON.stringify(buildExportPayload());

    // API keys live only in the OS keychain: no provider config, no
    // apiKey field and no secret-shaped tokens may ever reach an export.
    expect(json).not.toMatch(/"apiKey"/);
    expect(json).not.toMatch(/"api_key"/);
    expect(json).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
    expect(json).not.toMatch(/"baseUrl"/);
  });

  it("drops malformed chat entries and empty transcripts", () => {
    useFavoritesStore.setState({ loaded: true });
    localStorage.setItem(
      CHAT_STORAGE_KEY,
      JSON.stringify({
        p1: [{ role: "user", content: "ok" }, { role: "assistant", content: 42 }, null],
        p2: [],
      }),
    );

    const payload = buildExportPayload();

    expect(payload.chat.p1).toEqual([{ role: "user", content: "ok" }]);
    expect(payload.chat.p2).toBeUndefined();
  });

  it("survives corrupted chat storage", () => {
    useFavoritesStore.setState({ loaded: true });
    localStorage.setItem(CHAT_STORAGE_KEY, "not json {{{");

    const payload = buildExportPayload();

    expect(payload.chat).toEqual({});
    expect(payload.favorites).toEqual([]);
  });
});

describe("importSavedData", () => {
  beforeEach(() => {
    localStorage.clear();
    useFavoritesStore.setState({ ids: [], byId: {}, loaded: false });
    useNotesStore.setState({ notes: [], loaded: false });
  });

  const exportFile = JSON.stringify({
    app: "papyrus",
    exportedAt: "2026-08-04T00:00:00Z",
    favorites: [paper, { ...paper, id: "p2", title: "Imported paper" }],
    chat: { p1: [{ role: "user", content: "Imported question?" }] },
    notes: [
      { ...note, id: "n1", body: "Imported (older) note", updatedAt: "2026-08-01T00:00:00Z" },
      { ...note, id: "n2", body: "Brand new imported note", updatedAt: "2026-08-03T00:00:00Z" },
    ],
  });

  it("merges favorites (existing entries win) and appends chats", async () => {
    useFavoritesStore.getState().toggle(paper); // p1 already saved locally
    localStorage.setItem(
      CHAT_STORAGE_KEY,
      JSON.stringify({ p1: [{ role: "user", content: "local question" }] }),
    );

    const summary = await importSavedData(exportFile);

    expect(summary.app).toBe("papyrus");
    expect(summary.favorites).toBe(2);
    expect(summary.chats).toBe(1);
    expect(summary.notes).toBe(2);
    // p2 was imported; p1 kept the LOCAL (newer) copy.
    const byId = useFavoritesStore.getState().byId;
    expect(byId.p2.title).toBe("Imported paper");
    expect(byId.p1).toEqual(paper);
    // Chat turns are appended, not replaced.
    const raw = JSON.parse(localStorage.getItem(CHAT_STORAGE_KEY) ?? "{}");
    expect(raw.p1.map((t: { content: string }) => t.content)).toEqual([
      "local question",
      "Imported question?",
    ]);
  });

  it("merges notes by id with the newer updatedAt winning", async () => {
    // The local copy of n1 is NEWER than the imported one.
    useNotesStore.setState({
      notes: [{ ...note, id: "n1", body: "Local (newer) note" }],
      loaded: true,
    });

    await importSavedData(exportFile);

    const merged = useNotesStore.getState().notes;
    expect(merged).toHaveLength(2);
    // n1 kept the local body; n2 was added.
    expect(merged.find((n) => n.id === "n1")?.body).toBe("Local (newer) note");
    expect(merged.find((n) => n.id === "n2")?.body).toBe("Brand new imported note");
  });

  it("rejects a file that is not a Papyrus export", async () => {
    await expect(importSavedData('{"app":"other"}')).rejects.toThrow("Not a Papyrus export file");
  });

  it("rejects invalid JSON", async () => {
    await expect(importSavedData("not json {{")).rejects.toThrow();
  });

  it("rejects oversize payloads (plan 072)", async () => {
    const big = '{"app":"papyrus","favorites":[' + '"x",'.repeat(5 * 1024 * 1024) + "]}";
    await expect(importSavedData(big)).rejects.toThrow("too large");
  });

  it("rejects malformed favorites entries (plan 072)", async () => {
    const bad = JSON.stringify({ app: "papyrus", favorites: [{ id: "a1" }] });
    await expect(importSavedData(bad)).rejects.toThrow("favorites.title must be a string");
  });

  it("rejects non-array sections (plan 072)", async () => {
    const bad = JSON.stringify({ app: "papyrus", readingHistory: {} });
    await expect(importSavedData(bad)).rejects.toThrow("readingHistory must be an array");
  });

  it("rejects bad chat roles and shapes (plan 072)", async () => {
    const badRole = JSON.stringify({
      app: "papyrus",
      chat: { p1: [{ role: "system", content: "x" }] },
    });
    await expect(importSavedData(badRole)).rejects.toThrow("role must be user or assistant");

    const badShape = JSON.stringify({ app: "papyrus", chat: { p1: {} } });
    await expect(importSavedData(badShape)).rejects.toThrow("chat[p1] must be an array");
  });

  it("accepts a minimal export with no sections (plan 072)", async () => {
    const summary = await importSavedData('{"app":"papyrus"}');
    expect(summary).toMatchObject({ favorites: 0, chats: 0, notes: 0, readingHistory: 0 });
  });
});
