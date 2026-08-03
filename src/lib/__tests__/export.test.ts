// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import { buildExportPayload } from "@/lib/export";
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
