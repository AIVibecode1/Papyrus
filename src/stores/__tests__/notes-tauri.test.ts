import { beforeEach, describe, expect, it, vi } from "vitest";

// Desktop path: isTauri() is true, so the store goes through the Rust
// commands. This is where the failure handling that protects the user's
// notes actually lives, so it needs real coverage.
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@/lib/ai", () => ({ isTauri: () => true }));

import type { PaperNote } from "@/lib/types";
import { useNotesStore } from "@/stores/notes";

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

function reset() {
  invoke.mockReset();
  useNotesStore.setState({
    notes: [],
    loaded: false,
    loading: false,
    loadError: null,
    pendingDeletes: [],
    filterPaperId: null,
    query: "",
  });
}

/** Names of the commands invoked, in order. */
const calls = () => invoke.mock.calls.map((c) => c[0]);

describe("notes store on the desktop path", () => {
  beforeEach(reset);

  it("reports a failed read instead of showing an empty library", async () => {
    // The user must never see "you have no notes" when the real answer is
    // "the notes file could not be read" — that reads as data loss.
    invoke.mockRejectedValueOnce(new Error("Cannot read notes: disk error"));
    await useNotesStore.getState().load();

    const state = useNotesStore.getState();
    expect(state.loadError).toBe("Cannot read notes: disk error");
    expect(state.loading).toBe(false);
    expect(state.loaded).toBe(true);
  });

  it("clears loadError on a successful retry", async () => {
    invoke.mockRejectedValueOnce(new Error("transient"));
    await useNotesStore.getState().load();
    expect(useNotesStore.getState().loadError).not.toBeNull();

    invoke.mockResolvedValueOnce([makeNote()]);
    useNotesStore.setState({ loaded: false });
    await useNotesStore.getState().load();

    expect(useNotesStore.getState().loadError).toBeNull();
    expect(useNotesStore.getState().notes).toHaveLength(1);
  });

  it("rolls back an upsert the backend rejected", async () => {
    const original = makeNote({ id: "n1", body: "saved" });
    useNotesStore.setState({ notes: [original], loaded: true });
    invoke.mockRejectedValueOnce(new Error("disk full"));

    await expect(useNotesStore.getState().upsert({ ...original, body: "edited" })).rejects.toThrow(
      "disk full",
    );

    // Without the rollback the edit would sit in the UI looking saved and
    // then vanish on the next launch, because nothing reached disk.
    expect(useNotesStore.getState().notes[0].body).toBe("saved");
  });

  it("rolls back an import the backend rejected", async () => {
    const original = makeNote({ id: "n1", body: "mine", updatedAt: "2026-08-09T00:00:00Z" });
    useNotesStore.setState({ notes: [original], loaded: true });
    invoke.mockRejectedValueOnce(new Error("import too large"));

    await expect(
      useNotesStore
        .getState()
        .importNotes([makeNote({ id: "n2", body: "theirs", updatedAt: "2026-08-10T00:00:00Z" })]),
    ).rejects.toThrow("import too large");

    expect(useNotesStore.getState().notes).toEqual([original]);
  });

  it("sends only the notes an import actually changes, in one batch", async () => {
    const localNewer = makeNote({ id: "n1", body: "mine", updatedAt: "2026-08-09T00:00:00Z" });
    const localOlder = makeNote({ id: "n2", body: "mine too", updatedAt: "2026-08-01T00:00:00Z" });
    useNotesStore.setState({ notes: [localNewer, localOlder], loaded: true });
    invoke.mockResolvedValueOnce(2);

    await useNotesStore.getState().importNotes([
      // Older than local: ignored.
      makeNote({ id: "n1", body: "stale backup", updatedAt: "2026-08-05T00:00:00Z" }),
      // Newer than local: wins.
      makeNote({ id: "n2", body: "newer backup", updatedAt: "2026-08-20T00:00:00Z" }),
      // Unknown: added.
      makeNote({ id: "n3", body: "brand new", updatedAt: "2026-08-20T00:00:00Z" }),
    ]);

    // One batched command, not one upsert per note: the old path re-read
    // and re-wrote the entire notes file for every note it sent.
    expect(calls()).toEqual(["import_notes"]);
    const sent = invoke.mock.calls[0][1].notes as PaperNote[];
    expect(sent.map((n) => n.id).sort()).toEqual(["n2", "n3"]);

    const merged = useNotesStore.getState().notes;
    expect(merged.find((n) => n.id === "n1")?.body).toBe("mine");
    expect(merged.find((n) => n.id === "n2")?.body).toBe("newer backup");
    expect(merged).toHaveLength(3);
  });

  it("skips the backend entirely when an import changes nothing", async () => {
    const stored = makeNote({ id: "n1", body: "same", updatedAt: "2026-08-05T00:00:00Z" });
    useNotesStore.setState({ notes: [stored], loaded: true });

    await useNotesStore.getState().importNotes([{ ...stored }]);

    expect(invoke).not.toHaveBeenCalled();
    expect(useNotesStore.getState().notes).toEqual([stored]);
  });

  it("keeps a note saved during a slow read (plan 046)", async () => {
    let release: (notes: PaperNote[]) => void = () => {};
    invoke.mockImplementationOnce(() => new Promise<PaperNote[]>((resolve) => (release = resolve)));
    const loading = useNotesStore.getState().load();

    // The user saves before the snapshot lands.
    invoke.mockResolvedValueOnce({});
    await useNotesStore.getState().upsert({
      paperId: "p1",
      paperTitle: "T",
      kind: "note",
      body: "just written",
    });

    release([makeNote({ id: "old", body: "from disk" })]);
    await loading;

    const ids = useNotesStore.getState().notes.map((n) => n.body);
    expect(ids).toContain("just written");
    expect(ids).toContain("from disk");
  });
});
