import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@/lib/ai";
import type { PaperNote } from "@/lib/types";

const BROWSER_STORAGE_KEY = "papyrus-notes-v1";

// The desktop path persists through the Rust notes.rs commands (app data
// dir, atomic writes). The browser dev preview falls back to localStorage
// so the UI is demonstrable outside Tauri; that path is never the primary
// storage story.

function loadBrowserNotes(): PaperNote[] {
  try {
    const raw = JSON.parse(localStorage.getItem(BROWSER_STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (n): n is PaperNote =>
        typeof n === "object" &&
        n !== null &&
        typeof (n as PaperNote).id === "string" &&
        typeof (n as PaperNote).paperId === "string" &&
        typeof (n as PaperNote).body === "string",
    );
  } catch {
    return [];
  }
}

function saveBrowserNotes(notes: PaperNote[]) {
  try {
    localStorage.setItem(BROWSER_STORAGE_KEY, JSON.stringify(notes));
  } catch {
    // Best-effort in the preview path.
  }
}

export type NoteInput = Omit<PaperNote, "id" | "createdAt" | "updatedAt"> & { id?: string };

interface NotesState {
  notes: PaperNote[];
  loaded: boolean;
  /** True while the first disk snapshot is in flight (plan 046): marks
   * the window where a concurrent upsert/remove must survive the merge. */
  loading: boolean;
  /** Ids removed while the snapshot was in flight (tombstones). */
  pendingDeletes: string[];
  /** When set, the hub shows only notes for this paper. */
  filterPaperId: string | null;
  /** Hub search: matches title, body and quote. */
  query: string;
  load: () => Promise<void>;
  upsert: (input: NoteInput) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setFilterPaperId: (id: string | null) => void;
  setQuery: (q: string) => void;
  /** Merges imported notes; same id -> the newer updatedAt wins. */
  importNotes: (notes: PaperNote[]) => Promise<void>;
}

/** Union merge: local optimistic copies win when they are NEWER than the
 * disk snapshot (they were written after the snapshot was taken), and
 * ids in `pendingDeletes` (removed while the snapshot was in flight) are
 * never resurrected. */
export function mergeNotes(
  disk: PaperNote[],
  local: PaperNote[],
  pendingDeletes: string[] = [],
): PaperNote[] {
  const byId = new Map<string, PaperNote>();
  for (const note of local) byId.set(note.id, note);
  for (const note of disk) {
    if (pendingDeletes.includes(note.id)) continue;
    const localNote = byId.get(note.id);
    if (!localNote || localNote.updatedAt <= note.updatedAt) {
      byId.set(note.id, note);
    }
  }
  return [...byId.values()];
}

/** Notes for one paper, newest first (pure helper for reactive selectors). */
export function notesForPaperList(notes: PaperNote[], paperId: string): PaperNote[] {
  return notes
    .filter((n) => n.paperId === paperId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Notes for one paper, newest first. */
export function notesForPaper(state: NotesState, paperId: string): PaperNote[] {
  return notesForPaperList(state.notes, paperId);
}

/** Pure filter used by the hub page (reactive selectors) and tests. */
export function filterNotes(
  notes: PaperNote[],
  filterPaperId: string | null,
  query: string,
): PaperNote[] {
  let list = notes;
  if (filterPaperId) list = list.filter((n) => n.paperId === filterPaperId);
  const q = query.trim().toLowerCase();
  if (q) {
    list = list.filter(
      (n) =>
        n.paperTitle.toLowerCase().includes(q) ||
        n.body.toLowerCase().includes(q) ||
        (n.quote ?? "").toLowerCase().includes(q),
    );
  }
  return [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Hub listing: filtered by paper and/or query, reverse-chronological. */
export function filteredNotes(state: NotesState): PaperNote[] {
  return filterNotes(state.notes, state.filterPaperId, state.query);
}

export const useNotesStore = create<NotesState>((set, get) => ({
  notes: [],
  loaded: false,
  loading: false,
  pendingDeletes: [],
  filterPaperId: null,
  query: "",

  load: async () => {
    if (get().loaded) return;
    // Mark loaded optimistically: any upsert/remove that lands while the
    // disk snapshot is in flight is local truth and must survive the
    // merge below (plan 046: a slow list_notes must not clobber a note
    // saved a moment ago).
    set({ loaded: true, loading: true });
    let disk: PaperNote[] = [];
    if (isTauri()) {
      try {
        disk = await invoke<PaperNote[]>("list_notes");
      } catch {
        disk = [];
      }
    } else {
      disk = loadBrowserNotes();
    }
    set((s) => ({
      notes: mergeNotes(disk, s.notes, s.pendingDeletes),
      loading: false,
      pendingDeletes: [],
    }));
  },

  upsert: async (input) => {
    const existing = get().notes.find((n) => n.id === input.id);
    const now = new Date().toISOString();
    const note: PaperNote = {
      ...input,
      id: input.id ?? crypto.randomUUID(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    // Optimistic apply; the Rust command is the source of truth on disk.
    set((s) => {
      const notes = s.notes.some((n) => n.id === note.id)
        ? s.notes.map((n) => (n.id === note.id ? note : n))
        : [...s.notes, note];
      return { notes };
    });
    if (isTauri()) {
      await invoke("upsert_note", { note });
    } else {
      saveBrowserNotes(get().notes);
    }
  },

  remove: async (id) => {
    set((s) => ({ notes: s.notes.filter((n) => n.id !== id) }));
    // Tombstone the id while the first snapshot is in flight so the
    // merge cannot resurrect it (plan 046).
    if (get().loading) {
      set((s) => ({ pendingDeletes: [...s.pendingDeletes, id] }));
    }
    if (isTauri()) {
      await invoke("delete_note", { id });
    } else {
      saveBrowserNotes(get().notes);
    }
  },

  setFilterPaperId: (filterPaperId) => set({ filterPaperId }),
  setQuery: (query) => set({ query }),

  importNotes: async (notes) => {
    if (notes.length === 0) return;
    // Same id -> the newer updatedAt wins; incoming unknown ids are added.
    const merged = [...get().notes];
    for (const incoming of notes) {
      const idx = merged.findIndex((n) => n.id === incoming.id);
      if (idx === -1) {
        merged.push(incoming);
      } else if (incoming.updatedAt > merged[idx].updatedAt) {
        merged[idx] = incoming;
      }
    }
    set({ notes: merged });
    if (isTauri()) {
      // The file lives in Rust; replay the winning notes through the
      // same command the UI uses (bounded by export size).
      for (const note of merged) {
        await invoke("upsert_note", { note });
      }
    } else {
      saveBrowserNotes(merged);
    }
  },
}));
