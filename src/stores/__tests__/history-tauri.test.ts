import { beforeEach, describe, expect, it, vi } from "vitest";

// Desktop path: history persistence goes through the Rust commands. The
// batching and the "only send what changed" rule are what keep an import
// from rewriting the whole history file 200 times, so they are asserted
// against the real command calls.
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@/lib/ai", () => ({ isTauri: () => true }));

import type { ReadingHistoryEntry } from "@/lib/types";
import { useHistoryStore } from "@/stores/history";

function entry(paperId: string, lastOpenedAt: string): ReadingHistoryEntry {
  return {
    paperId,
    title: `Paper ${paperId}`,
    authors: ["A. Author"],
    published: "2026-01-01",
    pdfUrl: `https://arxiv.org/pdf/${paperId}`,
    categories: ["cs.AI"],
    lastOpenedAt,
  };
}

const calls = () => invoke.mock.calls.map((c) => c[0]);

describe("history import on the desktop path", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    useHistoryStore.setState({ entries: [], loaded: true });
  });

  it("sends only the entries an import changes, in one batch", async () => {
    const localNewer = entry("p1", "2026-08-09T00:00:00Z");
    const localOlder = entry("p2", "2026-08-01T00:00:00Z");
    useHistoryStore.setState({ entries: [localNewer, localOlder] });

    await useHistoryStore.getState().importHistory([
      // Older than local: ignored.
      entry("p1", "2026-08-05T00:00:00Z"),
      // Newer than local: wins.
      entry("p2", "2026-08-20T00:00:00Z"),
      // Unknown: added.
      entry("p3", "2026-08-21T00:00:00Z"),
    ]);

    // Regression: the old path replayed the whole merged list through
    // record_history — up to 200 calls, each re-reading and re-writing
    // the entire history file.
    expect(calls()).toEqual(["import_history"]);
    const sent = invoke.mock.calls[0][1].entries as ReadingHistoryEntry[];
    expect(sent.map((e) => e.paperId).sort()).toEqual(["p2", "p3"]);

    const merged = useHistoryStore.getState().entries;
    expect(merged.map((e) => e.paperId).sort()).toEqual(["p1", "p2", "p3"]);
    expect(merged.find((e) => e.paperId === "p2")?.lastOpenedAt).toBe("2026-08-20T00:00:00Z");
    // Most recent first.
    expect(merged[0].paperId).toBe("p3");
  });

  it("skips the backend entirely when an import changes nothing", async () => {
    const stored = entry("p1", "2026-08-05T00:00:00Z");
    useHistoryStore.setState({ entries: [stored] });

    await useHistoryStore.getState().importHistory([{ ...stored }]);

    expect(invoke).not.toHaveBeenCalled();
    expect(useHistoryStore.getState().entries).toEqual([stored]);
  });

  it("keeps the in-memory merge when the write fails", async () => {
    // History is explicitly best-effort (it must never block the reader),
    // so a disk failure is swallowed rather than surfaced as an error —
    // and the returned list stays consistent with the store.
    useHistoryStore.setState({ entries: [] });
    invoke.mockRejectedValueOnce(new Error("disk full"));

    const merged = await useHistoryStore
      .getState()
      .importHistory([entry("p1", "2026-08-05T00:00:00Z")]);

    expect(merged.map((e) => e.paperId)).toEqual(["p1"]);
    expect(useHistoryStore.getState().entries).toEqual(merged);
  });

  it("skips malformed entries instead of importing them", async () => {
    useHistoryStore.setState({ entries: [] });
    await useHistoryStore
      .getState()
      .importHistory([
        { paperId: 42, title: "bad", lastOpenedAt: "2026-08-05T00:00:00Z" } as never,
        entry("p9", "2026-08-06T00:00:00Z"),
      ]);

    const sent = invoke.mock.calls[0][1].entries as ReadingHistoryEntry[];
    expect(sent.map((e) => e.paperId)).toEqual(["p9"]);
  });

  it("an empty batch is a no-op", async () => {
    await useHistoryStore.getState().importHistory([]);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("history load failures", () => {
  beforeEach(() => {
    invoke.mockReset();
    useHistoryStore.setState({ entries: [], loaded: false, loadError: null });
  });

  it("reports a failed read instead of rendering as empty history", async () => {
    // A swallowed read failure tells the user their reading positions are
    // gone, which is both wrong and unrecoverable from their side.
    invoke.mockRejectedValueOnce(new Error("history store unreadable"));

    await useHistoryStore.getState().load();

    const state = useHistoryStore.getState();
    expect(state.loaded).toBe(true);
    expect(state.loadError).toBe("history store unreadable");
    expect(state.entries).toEqual([]);
  });

  it("clears the error on a successful retry", async () => {
    invoke.mockRejectedValueOnce(new Error("transient"));
    await useHistoryStore.getState().load();
    expect(useHistoryStore.getState().loadError).toBe("transient");

    // `load` is a no-op once `loaded` is set, so a retry resets the flag —
    // this is exactly what the retry button does.
    invoke.mockResolvedValueOnce([entry("p1", "2026-08-05T00:00:00Z")]);
    useHistoryStore.setState({ loaded: false, loadError: null });
    await useHistoryStore.getState().load();

    const state = useHistoryStore.getState();
    expect(state.loadError).toBeNull();
    expect(state.entries.map((e) => e.paperId)).toEqual(["p1"]);
  });
});
