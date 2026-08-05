import { invoke } from "@tauri-apps/api/core";

import { isTauri } from "@/lib/ai";
import type { Paper, PaperNote, ReadingHistoryEntry } from "@/lib/types";
import { useFavoritesStore } from "@/stores/favorites";
import { useHistoryStore } from "@/stores/history";
import { useNotesStore } from "@/stores/notes";

const CHAT_STORAGE_KEY = "papyrus-reader-chat-v1";

export interface ExportChatTurn {
  role: string;
  content: string;
}

export interface ExportPayload {
  app: "papyrus";
  exportedAt: string;
  favorites: Paper[];
  /** Chat transcripts keyed by paper id (role/content only — no ids). */
  chat: Record<string, ExportChatTurn[]>;
  /** Notes and highlights (plan 042); imported merged by note id. */
  notes: PaperNote[];
  /** Reading history (plan 060); imported merged by paperId keeping the
   * newer lastOpenedAt. */
  readingHistory: ReadingHistoryEntry[];
}

/** Maps a chat message to its exportable { role, content } shape; returns
 * null for anything malformed. Internal fields (ids, status) never leave
 * the app — they are session-local implementation details. */
function toChatTurn(value: unknown): ExportChatTurn | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.role === "string" && typeof v.content === "string") {
    return { role: v.role, content: v.content };
  }
  return null;
}

/** Collects the user's saved data (favorites + chat transcripts + notes
 * + reading history). */
export function buildExportPayload(): ExportPayload {
  const favorites = useFavoritesStore.getState();
  if (!favorites.loaded) favorites.load();
  const notes = useNotesStore.getState();
  if (!notes.loaded) void notes.load();
  const history = useHistoryStore.getState();
  if (!history.loaded) void history.load();

  let chatRaw: unknown = {};
  try {
    chatRaw = JSON.parse(localStorage.getItem(CHAT_STORAGE_KEY) ?? "{}");
  } catch {
    // Corrupted chat storage exports as an empty chat section.
  }
  const chat: Record<string, ExportChatTurn[]> = {};
  if (chatRaw && typeof chatRaw === "object") {
    for (const [paperId, list] of Object.entries(chatRaw as Record<string, unknown>)) {
      if (Array.isArray(list)) {
        const turns = list.map(toChatTurn).filter((t): t is ExportChatTurn => t !== null);
        if (turns.length > 0) chat[paperId] = turns;
      }
    }
  }

  return {
    app: "papyrus",
    exportedAt: new Date().toISOString(),
    favorites: Object.values(favorites.byId),
    chat,
    notes: notes.notes,
    readingHistory: history.entries,
  };
}

/**
 * Exports the saved data. Inside Tauri the Rust backend writes a
 * timestamped JSON file to the Documents folder and returns its path; in
 * the browser preview it triggers a download instead.
 */
export async function exportSavedData(): Promise<string> {
  const payload = JSON.stringify(buildExportPayload(), null, 2);

  if (isTauri()) {
    return invoke<string>("export_data", { payload });
  }

  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `papyrus-export-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  return "Downloaded";
}

export interface ImportSummary {
  app: string;
  favorites: number;
  chats: number;
  notes: number;
  readingHistory: number;
}

/** Structural validation for the browser path (the Tauri path validates
 * server-side in import_data; the same rules apply here). */
function parseExportPayload(raw: string): ExportPayload {
  const value = JSON.parse(raw) as Partial<ExportPayload>;
  if (value.app !== "papyrus") throw new Error("Not a Papyrus export file");
  if (!Array.isArray(value.favorites)) value.favorites = [];
  if (!value.chat || typeof value.chat !== "object") value.chat = {};
  if (!Array.isArray(value.notes)) value.notes = [];
  if (!Array.isArray(value.readingHistory)) value.readingHistory = [];
  return value as ExportPayload;
}

/**
 * Imports a Papyrus export file: validates it (Rust in the desktop app,
 * locally in the browser preview), merges the favorites into the store
 * (dedup by id) and appends the chat transcripts to the per-paper chat
 * storage. Provider keys are never part of exports, so nothing secret is
 * touched. Returns what was imported.
 */
export async function importSavedData(fileContent: string): Promise<ImportSummary> {
  const payload = parseExportPayload(fileContent);

  let summary: ImportSummary;
  if (isTauri()) {
    summary = await invoke<ImportSummary>("import_data", { payload: fileContent });
  } else {
    summary = {
      app: "papyrus",
      favorites: payload.favorites.length,
      chats: Object.keys(payload.chat).length,
      notes: payload.notes.length,
      readingHistory: payload.readingHistory.length,
    };
  }

  // Merge reading history: same paperId -> the newer lastOpenedAt wins.
  await useHistoryStore.getState().importHistory(payload.readingHistory);

  // Merge notes: same id -> the newer updatedAt wins (incoming notes
  // with a newer timestamp replace, older ones are skipped).
  await useNotesStore.getState().importNotes(payload.notes);

  // Merge favorites: existing entries win (the user's current data is
  // newer), imported ones fill the gaps.
  const favorites = useFavoritesStore.getState();
  if (!favorites.loaded) favorites.load();
  useFavoritesStore.getState().importPapers(payload.favorites);

  // Append chat transcripts per paper, skipping malformed turns.
  try {
    const raw = JSON.parse(localStorage.getItem(CHAT_STORAGE_KEY) ?? "{}") as Record<
      string,
      unknown
    >;
    for (const [paperId, turns] of Object.entries(payload.chat)) {
      if (!Array.isArray(turns) || turns.length === 0) continue;
      const existing = Array.isArray(raw[paperId]) ? (raw[paperId] as unknown[]) : [];
      const merged = [...existing, ...turns];
      raw[paperId] = merged.slice(-30);
    }
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(raw));
  } catch {
    // Storage full or unavailable: favorites still import in memory.
  }

  return summary;
}
