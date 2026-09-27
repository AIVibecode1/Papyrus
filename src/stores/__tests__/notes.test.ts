import { beforeEach, describe, expect, it, vi } from "vitest";

// The browser preview path is exercised: isTauri() resolves false in the
// node test env, so the store persists to the in-memory localStorage.
vi.mock("@/lib/ai", () => ({ isTauri: () => false }));

import type { PaperNote } from "@/lib/types";
import { filterNotes, notesForPaperList, useNotesStore } from "@/stores/notes";

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

// The browser preview path is exercised: isTauri() resolves false in the
// node test env, so the store persists to the in-memory localStorage.

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

describe("notes store", () => {
  beforeEach(() => {
    localStorageMock.clear();
    useNotesStore.setState({
      notes: [],
      loaded: false,
      filterPaperId: null,
      query: "",
    });
  });

  it("loads notes from browser storage once", async () => {
    const stored = [makeNote()];
    localStorageMock.setItem("papyrus-notes-v1", JSON.stringify(stored));

    await useNotesStore.getState().load();
    await useNotesStore.getState().load(); // second call is a no-op

    expect(useNotesStore.getState().notes).toEqual(stored);
    expect(useNotesStore.getState().loaded).toBe(true);
  });

  it("tolerates corrupted storage", async () => {
    localStorageMock.setItem("papyrus-notes-v1", "not json {{");

    await useNotesStore.getState().load();

    expect(useNotesStore.getState().notes).toEqual([]);
  });

  it("upserts notes (add then update by id) and persists", async () => {
    await useNotesStore.getState().upsert({
      paperId: "p1",
      paperTitle: "Attention Is All You Need",
      kind: "note",
      body: "First draft",
    });
    const first = useNotesStore.getState().notes[0];
    expect(first.id).toBeTruthy();
    expect(first.body).toBe("First draft");
    expect(first.createdAt).toBe(first.updatedAt);

    await useNotesStore.getState().upsert({
      id: first.id,
      paperId: "p1",
      paperTitle: "Attention Is All You Need",
      kind: "note",
      body: "Second draft",
    });
    const notes = useNotesStore.getState().notes;
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toBe("Second draft");
    // createdAt is preserved across updates; updatedAt moves forward.
    expect(notes[0].createdAt).toBe(first.createdAt);
    expect(notes[0].updatedAt >= first.updatedAt).toBe(true);

    // Persisted to browser storage.
    const raw = JSON.parse(localStorageMock.getItem("papyrus-notes-v1") ?? "[]");
    expect(raw).toHaveLength(1);
  });

  it("removes a note", async () => {
    await useNotesStore.getState().upsert({
      paperId: "p1",
      paperTitle: "A",
      kind: "note",
      body: "x",
    });
    const id = useNotesStore.getState().notes[0].id;

    await useNotesStore.getState().remove(id);

    expect(useNotesStore.getState().notes).toEqual([]);
  });

  it("filters by paper and query", () => {
    const notes = [
      makeNote({ id: "a", paperId: "p1", paperTitle: "Alpha", body: "transformers" }),
      makeNote({ id: "b", paperId: "p2", paperTitle: "Beta", body: "cnns" }),
      makeNote({
        id: "c",
        paperId: "p1",
        paperTitle: "Alpha",
        kind: "highlight",
        quote: "attention is all you need",
        body: "",
        updatedAt: "2026-08-03T00:00:00Z", // newest: sorts first
      }),
    ];

    expect(notesForPaperList(notes, "p1").map((n) => n.id)).toEqual(["c", "a"]);
    expect(filterNotes(notes, null, "").map((n) => n.id)).toEqual(["c", "a", "b"]);
    expect(filterNotes(notes, "p1", "attention").map((n) => n.id)).toEqual(["c"]);
    expect(filterNotes(notes, null, "alpha").map((n) => n.id)).toEqual(["c", "a"]);
    expect(filterNotes(notes, "p2", "").map((n) => n.id)).toEqual(["b"]);
  });

  it("imports notes merging by id with the newer updatedAt winning", async () => {
    useNotesStore.setState({
      notes: [makeNote({ id: "n1", body: "local newer", updatedAt: "2026-08-05T00:00:00Z" })],
      loaded: true,
    });

    await useNotesStore
      .getState()
      .importNotes([
        makeNote({ id: "n1", body: "imported older", updatedAt: "2026-08-04T00:00:00Z" }),
        makeNote({ id: "n2", body: "imported only", updatedAt: "2026-08-04T00:00:00Z" }),
      ]);

    const merged = useNotesStore.getState().notes;
    expect(merged).toHaveLength(2);
    expect(merged.find((n) => n.id === "n1")?.body).toBe("local newer");
    expect(merged.find((n) => n.id === "n2")?.body).toBe("imported only");
  });

  it("re-importing an identical backup changes nothing", async () => {
    // Regression: importNotes replayed the WHOLE merged set to the
    // backend, so re-importing the same file rewrote every note on disk
    // for no reason. Nothing changed means nothing is sent.
    const stored = makeNote({ id: "n1", body: "same", updatedAt: "2026-08-05T00:00:00Z" });
    useNotesStore.setState({ notes: [stored], loaded: true });
    localStorageMock.setItem("papyrus-notes-v1", JSON.stringify([stored]));

    await useNotesStore.getState().importNotes([{ ...stored }]);

    expect(useNotesStore.getState().notes).toHaveLength(1);
    expect(useNotesStore.getState().notes[0].body).toBe("same");
  });
});
