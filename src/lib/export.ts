import { invoke } from "@tauri-apps/api/core";

import { isTauri } from "@/lib/ai";
import type { Paper } from "@/lib/types";
import { useFavoritesStore } from "@/stores/favorites";

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

/** Collects the user's saved data (favorites + chat transcripts). */
export function buildExportPayload(): ExportPayload {
  const favorites = useFavoritesStore.getState();
  if (!favorites.loaded) favorites.load();

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
