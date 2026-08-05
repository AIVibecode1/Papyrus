// Regression pack (plan 046): the notes store must not lose a note saved
// while the first list_notes snapshot is still in flight. Runs the Tauri
// path with a deferred invoke so the interleaving is deterministic.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai", () => ({ isTauri: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@/lib/ai";
import type { PaperNote } from "@/lib/types";
import { mergeNotes, useNotesStore } from "@/stores/notes";

function makeNote(overrides: Partial<PaperNote> = {}): PaperNote {
  return {
    id: "n1",
    paperId: "p1",
    paperTitle: "Attention Is All You Need",
    kind: "note",
    body: "A thought.",
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-02T00:00:00Z",
    ...overrides,
  };
}

/** A promise whose resolution the test controls. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.clearAllMocks();
  useNotesStore.setState({
    notes: [],
    loaded: false,
    loading: false,
    pendingDeletes: [],
    filterPaperId: null,
    query: "",
  });
});

describe("mergeNotes (plan 046)", () => {
  it("keeps a newer optimistic copy over an older disk snapshot", () => {
    const disk = [makeNote({ id: "a", updatedAt: "2026-08-01T00:00:00Z" })];
    const local = [makeNote({ id: "a", body: "edited", updatedAt: "2026-08-02T00:00:00Z" })];
    expect(mergeNotes(disk, local)).toEqual(local);
  });

  it("takes the disk copy for ids the local list never touched", () => {
    const disk = [makeNote({ id: "a" })];
    expect(mergeNotes(disk, [])).toEqual(disk);
  });

  it("never resurrects a note deleted while the snapshot was in flight", () => {
    const disk = [makeNote({ id: "gone" })];
    expect(mergeNotes(disk, [], ["gone"])).toEqual([]);
  });

  it("unions notes added and deleted during the window independently", () => {
    const disk = [makeNote({ id: "kept" }), makeNote({ id: "gone" })];
    const local = [makeNote({ id: "added", body: "brand new" })];
    const merged = mergeNotes(disk, local, ["gone"]);
    expect(merged.map((n) => n.id).sort()).toEqual(["added", "kept"]);
  });
});

describe("notes load/upsert race (plan 046)", () => {
  it("a slow list_notes cannot clobber a note saved while it was in flight", async () => {
    const snapshot = deferred<PaperNote[]>();

    // First call: the in-flight list_notes snapshot. Later calls (the
    // upsert's write) resolve immediately.
    vi.mocked(invoke).mockImplementationOnce(() => snapshot.promise as never);

    const loadPromise = useNotesStore.getState().load();
    // The load is in flight; the user saves a highlight now.
    await useNotesStore.getState().upsert({
      id: "fresh",
      paperId: "p1",
      paperTitle: "Attention Is All You Need",
      kind: "highlight",
      body: "",
      quote: "we call it attention",
    });

    // The stale snapshot (taken BEFORE the highlight existed) resolves.
    snapshot.resolve([makeNote({ id: "old", paperId: "p1" })]);
    await loadPromise;

    const notes = useNotesStore.getState().notes;
    expect(notes.map((n) => n.id).sort()).toEqual(["fresh", "old"]);
  });

  it("a note deleted while list_notes was in flight stays deleted", async () => {
    const snapshot = deferred<PaperNote[]>();
    vi.mocked(invoke).mockImplementationOnce(() => snapshot.promise as never);

    const loadPromise = useNotesStore.getState().load();
    await useNotesStore.getState().remove("gone");

    // The snapshot still contains the note (it predates the delete).
    snapshot.resolve([makeNote({ id: "gone" })]);
    await loadPromise;

    expect(useNotesStore.getState().notes).toEqual([]);
  });
});
