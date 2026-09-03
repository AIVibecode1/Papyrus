export type StreamStatus = "idle" | "loading" | "streaming" | "done" | "error" | "stopped";

export interface SectionEntry {
  text: string;
  status: StreamStatus;
  error: string | null;
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
  status: StreamStatus;
  error: string | null;
  selection: string | null;
}

export const CHAT_STORAGE_KEY = "papyrus-reader-chat-v1";
const CHAT_PERSIST_LIMIT = 30;
/** Papers whose chat transcripts are kept (oldest evicted first). 40
 * papers x up to 30 turns keeps the localStorage blob bounded for heavy
 * users; the walkthrough cap is 5 for comparison. */
const CHAT_PAPER_LIMIT = 40;

export function loadChat(paperId: string): ChatMessage[] {
  try {
    const raw = JSON.parse(localStorage.getItem(CHAT_STORAGE_KEY) ?? "{}") as Record<
      string,
      ChatMessage[]
    >;
    const list = raw[paperId] ?? [];
    return list.filter(
      (m) => m && typeof m.text === "string" && (m.role === "user" || m.role === "assistant"),
    );
  } catch {
    return [];
  }
}

export function persistChat(paperId: string, messages: ChatMessage[]) {
  try {
    const raw = JSON.parse(localStorage.getItem(CHAT_STORAGE_KEY) ?? "{}") as Record<
      string,
      ChatMessage[]
    >;
    // Plan 074: touch the active paper (delete + re-set) so the JSON
    // insertion order doubles as LRU order, then evict the oldest keys
    // beyond CHAT_PAPER_LIMIT. The active paper is always last after the
    // touch, so it can never be evicted by its own write. (JS orders
    // integer-like keys first; paper ids always contain dots or letters,
    // so insertion order is reliable here.)
    if (raw[paperId] !== undefined) delete raw[paperId];
    raw[paperId] = messages.slice(-CHAT_PERSIST_LIMIT);
    const keys = Object.keys(raw);
    if (keys.length > CHAT_PAPER_LIMIT) {
      for (const stale of keys.slice(0, keys.length - CHAT_PAPER_LIMIT)) {
        delete raw[stale];
      }
    }
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(raw));
  } catch {
    // Storage full or unavailable: chat history is best-effort.
  }
}

// --- walkthrough persistence -------------------------------------------------
// The section-by-section walkthrough and the final synthesis are persisted
// per paper so reopening a paper (or restarting the app) restores them
// instead of re-streaming ~10 provider calls. Chat already persists; this
// mirrors that pattern with the same best-effort semantics.

const WALKTHROUGH_STORAGE_KEY = "papyrus-reader-walkthrough-v1";
/** Papers whose walkthroughs are kept (oldest evicted first). */
const WALKTHROUGH_PERSIST_LIMIT = 5;

export interface WalkthroughSnapshot {
  sectionEntries: SectionEntry[];
  synthesis: SectionEntry | null;
}

export function loadWalkthrough(paperId: string): WalkthroughSnapshot {
  try {
    const raw = JSON.parse(localStorage.getItem(WALKTHROUGH_STORAGE_KEY) ?? "{}") as Record<
      string,
      WalkthroughSnapshot
    >;
    const snap = raw[paperId];
    if (!snap || !Array.isArray(snap.sectionEntries))
      return { sectionEntries: [], synthesis: null };
    // A restored entry must never look busy: it belongs to a finished
    // stream, and a "streaming" status would wedge the walkthrough UI.
    const entries = snap.sectionEntries
      .filter((e) => e && typeof e.text === "string")
      .map((e) => ({
        text: e.text,
        status: (e.status === "error" ? "error" : "stopped") as SectionEntry["status"],
        error: e.status === "error" ? e.error : null,
      }));
    const synthesis =
      snap.synthesis && typeof snap.synthesis.text === "string"
        ? { ...snap.synthesis, status: "stopped" as const, error: null }
        : null;
    return { sectionEntries: entries, synthesis };
  } catch {
    return { sectionEntries: [], synthesis: null };
  }
}

export function persistWalkthrough(
  paperId: string,
  sectionEntries: SectionEntry[],
  synthesis: SectionEntry | null,
) {
  try {
    const raw = JSON.parse(localStorage.getItem(WALKTHROUGH_STORAGE_KEY) ?? "{}") as Record<
      string,
      WalkthroughSnapshot
    >;
    // Keep the newest papers: drop oldest entries beyond the cap.
    raw[paperId] = { sectionEntries, synthesis };
    const ids = Object.keys(raw);
    if (ids.length > WALKTHROUGH_PERSIST_LIMIT) {
      for (const old of ids.slice(0, ids.length - WALKTHROUGH_PERSIST_LIMIT)) delete raw[old];
    }
    localStorage.setItem(WALKTHROUGH_STORAGE_KEY, JSON.stringify(raw));
  } catch {
    // Storage full or unavailable: walkthrough persistence is best-effort.
  }
}
