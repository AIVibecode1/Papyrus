// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import { buildExportPayload, importSavedData } from "@/lib/export";
import type { Paper } from "@/lib/types";
import { useFavoritesStore } from "@/stores/favorites";

const paper: Paper = {
  id: "p1",
  title: "Saved paper",
  authors: ["A. Author"],
  published: "2026-01-01",
  summary: "A summary.",
  pdfUrl: "https://arxiv.org/pdf/1234.5678",
  categories: ["cs.AI"],
};

describe("buildExportPayload", () => {
  beforeEach(() => {
    localStorage.clear();
    useFavoritesStore.setState({ ids: [], byId: {}, loaded: false });
  });

  it("includes favorites and chat transcripts", () => {
    useFavoritesStore.getState().toggle(paper);
    localStorage.setItem(
      "papyrus-reader-chat-v1",
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

  it("drops malformed chat entries and empty transcripts", () => {
    useFavoritesStore.setState({ loaded: true });
    localStorage.setItem(
      "papyrus-reader-chat-v1",
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
    localStorage.setItem("papyrus-reader-chat-v1", "not json {{{");

    const payload = buildExportPayload();

    expect(payload.chat).toEqual({});
    expect(payload.favorites).toEqual([]);
  });
});

describe("importSavedData", () => {
  beforeEach(() => {
    localStorage.clear();
    useFavoritesStore.setState({ ids: [], byId: {}, loaded: false });
  });

  const exportFile = JSON.stringify({
    app: "papyrus",
    exportedAt: "2026-08-04T00:00:00Z",
    favorites: [paper, { ...paper, id: "p2", title: "Imported paper" }],
    chat: { p1: [{ role: "user", content: "Imported question?" }] },
  });

  it("merges favorites (existing entries win) and appends chats", async () => {
    useFavoritesStore.getState().toggle(paper); // p1 already saved locally
    localStorage.setItem(
      "papyrus-reader-chat-v1",
      JSON.stringify({ p1: [{ role: "user", content: "local question" }] }),
    );

    const summary = await importSavedData(exportFile);

    expect(summary.app).toBe("papyrus");
    expect(summary.favorites).toBe(2);
    expect(summary.chats).toBe(1);
    // p2 was imported; p1 kept the LOCAL (newer) copy.
    const byId = useFavoritesStore.getState().byId;
    expect(byId.p2.title).toBe("Imported paper");
    expect(byId.p1).toEqual(paper);
    // Chat turns are appended, not replaced.
    const raw = JSON.parse(localStorage.getItem("papyrus-reader-chat-v1") ?? "{}");
    expect(raw.p1.map((t: { content: string }) => t.content)).toEqual([
      "local question",
      "Imported question?",
    ]);
  });

  it("rejects a file that is not a Papyrus export", async () => {
    await expect(importSavedData('{"app":"other"}')).rejects.toThrow("Not a Papyrus export file");
  });

  it("rejects invalid JSON", async () => {
    await expect(importSavedData("not json {{")).rejects.toThrow();
  });
});
