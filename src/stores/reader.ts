import { create } from "zustand";

import { CANCELLED_MARKER, stopExplanation } from "@/lib/ai";
import { getPdfBytes } from "@/lib/pdf";
import { extractTextFromPdf } from "@/lib/pdf-text";
import { capTotal, findContextSection, splitIntoSections } from "@/lib/paper-text";
import { streamAsk, streamSectionExplanation, streamSynthesis } from "@/lib/reader-ai";
import { createStreamBuffer } from "@/lib/stream";
import type { Paper, ProviderConfig } from "@/lib/types";

export type ReaderStatus = "idle" | "loading" | "ready" | "error";
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

const CHAT_STORAGE_KEY = "papyrus-reader-chat-v1";
const CHAT_PERSIST_LIMIT = 30;
interface ReaderState {
  paper: Paper | null;
  pdfBytes: Uint8Array | null;
  loadStatus: ReaderStatus;
  loadError: string | null;
  sections: string[];
  /** Index of the next section to explain (0-based). */
  sectionIndex: number;
  /** Explanations for the sections completed so far. */
  sectionEntries: SectionEntry[];
  synthesis: SectionEntry | null;
  chat: ChatMessage[];
  selection: string | null;
  open: (paper: Paper) => Promise<void>;
  close: () => void;
  setSelection: (text: string | null) => void;
  clearSelection: () => void;
  startWalkthrough: (provider: ProviderConfig, language: string) => Promise<void>;
  continueWalkthrough: (provider: ProviderConfig, language: string) => Promise<void>;
  ask: (question: string, provider: ProviderConfig, language: string) => Promise<void>;
  /** Re-asks the question behind the last failed assistant message. */
  retryAsk: (provider: ProviderConfig, language: string) => Promise<void>;
  stop: () => Promise<void>;
}

let messageId = 1;

function loadChat(paperId: string): ChatMessage[] {
  try {
    const raw = JSON.parse(localStorage.getItem(CHAT_STORAGE_KEY) ?? "{}") as Record<
      string,
      ChatMessage[]
    >;
    const list = raw[paperId] ?? [];
    return list.filter((m) => m && typeof m.text === "string");
  } catch {
    return [];
  }
}

function persistChat(paperId: string, messages: ChatMessage[]) {
  try {
    const raw = JSON.parse(localStorage.getItem(CHAT_STORAGE_KEY) ?? "{}") as Record<
      string,
      ChatMessage[]
    >;
    raw[paperId] = messages.slice(-CHAT_PERSIST_LIMIT);
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(raw));
  } catch {
    // Storage full or unavailable: chat history is best-effort.
  }
}

export const useReaderStore = create<ReaderState>((set, get) => {
  // Generation counters: bumping one invalidates in-flight chunks from
  // a superseded run (same pattern as the explanation store).
  let wtGen = 0;
  let chatGen = 0;

  return {
    paper: null,
    pdfBytes: null,
    loadStatus: "idle",
    loadError: null,
    sections: [],
    sectionIndex: 0,
    sectionEntries: [],
    synthesis: null,
    chat: [],
    selection: null,

    open: async (paper) => {
      set({ paper, pdfBytes: null, loadStatus: "loading", loadError: null });
      try {
        const bytes = await getPdfBytes(paper.id, paper.pdfUrl);
        const text = await extractTextFromPdf(bytes);
        const sections = splitIntoSections(text);
        if (sections.length === 0) {
          set({
            loadStatus: "error",
            loadError: "No readable text could be extracted from this PDF.",
          });
          return;
        }
        set({
          pdfBytes: bytes,
          sections,
          sectionIndex: 0,
          sectionEntries: [],
          synthesis: null,
          chat: loadChat(paper.id),
          selection: null,
          loadStatus: "ready",
        });
      } catch (err) {
        set({
          loadStatus: "error",
          loadError: err instanceof Error ? err.message : String(err),
        });
      }
    },

    close: () =>
      set({
        paper: null,
        pdfBytes: null,
        loadStatus: "idle",
        loadError: null,
        sections: [],
        sectionIndex: 0,
        sectionEntries: [],
        synthesis: null,
        chat: [],
        selection: null,
      }),

    setSelection: (text) => set({ selection: text }),
    clearSelection: () => set({ selection: null }),

    startWalkthrough: async (provider, language) => {
      const { sections } = get();
      if (sections.length === 0) return;
      set({ sectionEntries: [], synthesis: null, sectionIndex: 0 });
      try {
        await get().continueWalkthrough(provider, language);
      } catch (err) {
        // Belt and braces: any unexpected failure becomes a visible error
        // card instead of a silent no-op.
        const message = err instanceof Error ? err.message : String(err);
        set((s) => ({
          sectionEntries: [...s.sectionEntries, { text: "", status: "error", error: message }],
        }));
      }
    },

    continueWalkthrough: async (provider, language) => {
      const { paper, sections, sectionIndex, synthesis } = get();
      if (!paper) return;

      if (sectionIndex < sections.length) {
        const i = sectionIndex;
        const gen = ++wtGen;
        set((s) => ({
          sectionIndex: i + 1,
          sectionEntries: [...s.sectionEntries, { text: "", status: "loading", error: null }],
        }));

        const buffer = createStreamBuffer<ReaderState>(set, {
          isCurrent: () => wtGen === gen,
          apply: (s, text) => {
            const entry = s.sectionEntries[i];
            // Apply to loading AND streaming entries: the first flush flips
            // the status, and later flushes must keep appending.
            if (!entry || (entry.status !== "loading" && entry.status !== "streaming")) return s;
            const entries = [...s.sectionEntries];
            entries[i] = { ...entry, text: entry.text + text, status: "streaming" };
            return { sectionEntries: entries };
          },
        });

        try {
          await streamSectionExplanation({
            provider,
            paper,
            sectionIndex: i + 1,
            totalSections: sections.length,
            sectionText: sections[i],
            language,
            onChunk: (chunk) => buffer.push(chunk),
          });
          if (wtGen !== gen) return;
          buffer.flushNow();
          set((s) => {
            const entries = [...s.sectionEntries];
            const entry = entries[i];
            if (entry) entries[i] = { ...entry, status: "done" };
            return { sectionEntries: entries };
          });
        } catch (err) {
          if (wtGen !== gen) return;
          buffer.dispose();
          const message = err instanceof Error ? err.message : String(err);
          const stopped = message.startsWith(CANCELLED_MARKER);
          set((s) => {
            const entries = [...s.sectionEntries];
            const entry = entries[i];
            if (entry) {
              entries[i] = {
                ...entry,
                status: stopped ? "stopped" : "error",
                error: stopped ? null : message,
              };
            }
            return { sectionEntries: entries };
          });
        }
        return;
      }

      if (!synthesis || synthesis.status !== "done") {
        const gen = ++wtGen;
        set({ synthesis: { text: "", status: "loading", error: null } });
        const buffer = createStreamBuffer<ReaderState>(set, {
          isCurrent: () => wtGen === gen,
          apply: (s, text) => {
            const cur = s.synthesis;
            // loading OR streaming: the first flush flips the status and
            // later flushes must keep appending (same rule as sections).
            if (!cur || (cur.status !== "loading" && cur.status !== "streaming")) return s;
            return { synthesis: { ...cur, text: cur.text + text, status: "streaming" } };
          },
        });
        try {
          await streamSynthesis({
            provider,
            paper,
            sectionsText: capTotal(sections.join("\n\n")),
            language,
            onChunk: (chunk) => buffer.push(chunk),
          });
          if (wtGen !== gen) return;
          buffer.flushNow();
          set((s) => (s.synthesis ? { synthesis: { ...s.synthesis, status: "done" } } : {}));
        } catch (err) {
          if (wtGen !== gen) return;
          buffer.dispose();
          const message = err instanceof Error ? err.message : String(err);
          const stopped = message.startsWith(CANCELLED_MARKER);
          set((s) =>
            s.synthesis
              ? {
                  synthesis: {
                    ...s.synthesis,
                    status: stopped ? "stopped" : "error",
                    error: stopped ? null : message,
                  },
                }
              : {},
          );
        }
      }
    },

    ask: async (question, provider, language) => {
      const { paper, sections, selection } = get();
      if (!paper || !question.trim()) return;
      const gen = ++chatGen;
      // Both messages get real counter ids: deriving the assistant id as
      // id + 1 would collide with the next question's id.
      const id = messageId++;
      const assistantId = messageId++;
      const selectionSnapshot = selection;

      set((s) => ({
        chat: [
          ...s.chat,
          {
            id,
            role: "user",
            text: question.trim(),
            status: "done",
            error: null,
            selection: selectionSnapshot,
          },
          {
            id: assistantId,
            role: "assistant",
            text: "",
            status: "loading",
            error: null,
            selection: null,
          },
        ],
      }));

      const buffer = createStreamBuffer<ReaderState>(set, {
        isCurrent: () => chatGen === gen,
        apply: (s, text) => {
          const list = [...s.chat];
          const msg = list.find((m) => m.id === assistantId);
          // loading OR streaming: the first flush flips the status and
          // later flushes must keep appending (same rule as sections).
          if (!msg || (msg.status !== "loading" && msg.status !== "streaming")) return s;
          msg.text += text;
          msg.status = "streaming";
          return { chat: list };
        },
      });

      // Ground the answer: the section containing the selection (or the
      // first section when there is no selection), so the model never
      // answers without paper context.
      const context = findContextSection(sections, selectionSnapshot ?? "");

      // Real conversation context: the last few completed turns (oldest
      // first), so follow-up questions are answered in context. Only
      // messages strictly before the current question are included.
      const history = get()
        .chat.filter(
          (m) =>
            m.id < id && (m.status === "done" || m.status === "error" || m.status === "stopped"),
        )
        .slice(-8)
        .map((m) => ({ role: m.role, content: m.text }));

      try {
        await streamAsk({
          provider,
          paper,
          question: question.trim(),
          selection: selectionSnapshot,
          context,
          history,
          language,
          onChunk: (chunk) => buffer.push(chunk),
        });
        if (chatGen !== gen) return;
        buffer.flushNow();
        set((s) => {
          const list = s.chat.map((m) =>
            m.id === assistantId ? { ...m, status: "done" as const } : m,
          );
          persistChat(paper.id, list);
          return { chat: list };
        });
      } catch (err) {
        if (chatGen !== gen) return;
        buffer.dispose();
        const message = err instanceof Error ? err.message : String(err);
        const stopped = message.startsWith(CANCELLED_MARKER);
        const status: StreamStatus = stopped ? "stopped" : "error";
        set((s) => {
          const list = s.chat.map((m) =>
            m.id === assistantId ? { ...m, status, error: stopped ? null : message } : m,
          );
          persistChat(paper.id, list);
          return { chat: list };
        });
      }
    },

    stop: async () => {
      const { sectionEntries, synthesis, chat, sections, paper } = get();
      const wtBusy =
        sectionEntries.some((e) => e.status === "loading" || e.status === "streaming") ||
        (synthesis !== null &&
          (synthesis.status === "loading" || synthesis.status === "streaming"));
      const chatBusy = chat.some((m) => m.status === "loading" || m.status === "streaming");

      if (wtBusy) {
        wtGen += 1;
        await stopExplanation();
        set((s) => ({
          sectionEntries: s.sectionEntries.map((e) =>
            e.status === "loading" || e.status === "streaming"
              ? { ...e, status: "stopped" as const }
              : e,
          ),
          synthesis:
            s.synthesis && (s.synthesis.status === "loading" || s.synthesis.status === "streaming")
              ? { ...s.synthesis, status: "stopped" as const }
              : s.synthesis,
        }));
      } else if (chatBusy) {
        chatGen += 1;
        await stopExplanation();
        if (paper) {
          set((s) => {
            const list = s.chat.map((m) =>
              m.status === "loading" || m.status === "streaming"
                ? { ...m, status: "stopped" as const }
                : m,
            );
            persistChat(paper.id, list);
            return { chat: list };
          });
        }
      }

      void sections;
    },

    retryAsk: async (provider, language) => {
      const { chat } = get();
      // Find the last failed assistant message and the user question
      // directly before it; drop the failed message and re-ask.
      for (let i = chat.length - 1; i >= 0; i -= 1) {
        const failed = chat[i];
        if (failed.role !== "assistant" || failed.status !== "error") continue;
        let question = "";
        for (let j = i - 1; j >= 0; j -= 1) {
          if (chat[j].role === "user") {
            question = chat[j].text;
            break;
          }
        }
        if (!question) return;
        // Drop the failed message AND its user question: ask() re-adds
        // both, so the bubble pair is not duplicated.
        const end = i > 0 && chat[i - 1].role === "user" ? i - 1 : i;
        set({ chat: chat.slice(0, end) });
        // The next ask() persists the full list (minus the failed
        // message) when the new stream settles.
        return get().ask(question, provider, language);
      }
    },
  };
});
