import { create } from "zustand";

import { CANCELLED_MARKER, newOperationId, stopExplanation } from "@/lib/ai";
import { getPdfBytes } from "@/lib/pdf";
import { readPdfPosition } from "@/lib/pdf-position";
import { extractTextFromPdf } from "@/lib/pdf-text";
import { capTotal, findContextSection, splitIntoSections } from "@/lib/paper-text";
import { streamAsk, streamSectionExplanation, streamSynthesis } from "@/lib/reader-ai";
import { createStreamBuffer } from "@/lib/stream";
import type { Paper, ProviderConfig } from "@/lib/types";
import { useHistoryStore } from "@/stores/history";
import type { ChatMessage, SectionEntry, StreamStatus } from "./reader-persist";
import { loadChat, loadWalkthrough, persistChat, persistWalkthrough } from "./reader-persist";

export type { ChatMessage, SectionEntry, StreamStatus } from "./reader-persist";

export type ReaderStatus = "idle" | "loading" | "ready" | "error";
/** Whole-paper text extraction lifecycle (deferred until Walkthrough/Ask). */
export type ExtractStatus = "idle" | "loading" | "done" | "error";

interface ReaderState {
  paper: Paper | null;
  pdfBytes: Uint8Array | null;
  loadStatus: ReaderStatus;
  loadError: string | null;
  sections: string[];
  extractStatus: ExtractStatus;
  extractError: string | null;
  /** Index of the next section to explain (0-based). */
  sectionIndex: number;
  /** Explanations for the sections completed so far. */
  sectionEntries: SectionEntry[];
  synthesis: SectionEntry | null;
  chat: ChatMessage[];
  selection: string | null;
  open: (paper: Paper) => Promise<void>;
  close: () => void;
  /**
   * Extracts the whole-paper text once (lazy): the reader downloads and
   * shows the PDF immediately, and only pays for pdf.js text extraction
   * when Walkthrough or Ask actually needs it. Returns false when the
   * text is unavailable.
   */
  ensureExtracted: () => Promise<boolean>;
  setSelection: (text: string | null) => void;
  clearSelection: () => void;
  startWalkthrough: (provider: ProviderConfig, language: string) => Promise<void>;
  continueWalkthrough: (provider: ProviderConfig, language: string) => Promise<void>;
  /** Re-runs the last section's explanation, replacing its entry. */
  regenerateSection: (provider: ProviderConfig, language: string) => Promise<void>;
  explainSection: (
    i: number,
    provider: ProviderConfig,
    language: string,
    replace: boolean,
  ) => Promise<void>;
  ask: (question: string, provider: ProviderConfig, language: string) => Promise<void>;
  /** Re-asks the question behind the last failed assistant message. */
  retryAsk: (provider: ProviderConfig, language: string) => Promise<void>;
  stop: () => Promise<void>;
}

let messageId = 1;

export const useReaderStore = create<ReaderState>((set, get) => {
  // Generation counters: bumping one invalidates in-flight chunks from
  // a superseded run (same pattern as the explanation store).
  let wtGen = 0;
  let chatGen = 0;
  // Open-generation token: only the newest open() (or close()) may apply
  // its async PDF/text results, so a slow open for paper A can never
  // overwrite paper B opened right after it.
  let openGen = 0;
  // Extraction token: only the newest extraction (or open/close) may
  // apply its results, mirroring openGen for the lazy text pass.
  let extractGen = 0;
  // In-flight extraction shared by concurrent ensureExtracted() callers
  // (e.g. Ask sent while the walkthrough parse is still running): joining
  // it beats failing with "could not read the paper text".
  let extractPromise: Promise<boolean> | null = null;
  // Operation id of the most recent stream (section, synthesis or ask);
  // stop() targets exactly it, so a stop can never hit unrelated work.
  let activeOperationId: string | null = null;

  // Stops the in-flight stream via IPC and clears the operation id — but
  // only if no newer stream claimed it during the round-trip (a stream
  // started mid-stop owns activeOperationId, and clobbering it would make
  // the new stream un-cancellable). Callers bump their own generation
  // counter first and mark their entries stopped after.
  const stopActiveStream = async () => {
    const idToStop = activeOperationId;
    await stopExplanation(idToStop);
    if (activeOperationId === idToStop) activeOperationId = null;
  };

  // Persists the current paper's walkthrough after any completion or stop,
  // so reopening the paper restores it without re-streaming.
  const persistCurrentWalkthrough = () => {
    const { paper, sectionEntries, synthesis } = get();
    if (paper) persistWalkthrough(paper.id, sectionEntries, synthesis);
  };

  return {
    paper: null,
    pdfBytes: null,
    loadStatus: "idle",
    loadError: null,
    sections: [],
    extractStatus: "idle",
    extractError: null,
    sectionIndex: 0,
    sectionEntries: [],
    synthesis: null,
    chat: [],
    selection: null,

    open: async (paper) => {
      const gen = ++openGen;
      // A new paper invalidates any in-flight extraction of the old one,
      // and drops the shared promise so the next ensureExtracted() starts
      // fresh instead of joining the abandoned run.
      extractGen += 1;
      extractPromise = null;
      set({ paper, pdfBytes: null, loadStatus: "loading", loadError: null });
      try {
        const bytes = await getPdfBytes(paper.id, paper.pdfUrl);
        // A newer open (or close) superseded this one: drop the results.
        if (openGen !== gen) return;
        set({
          pdfBytes: bytes,
          sections: [],
          extractStatus: "idle",
          extractError: null,
          sectionIndex: 0,
          sectionEntries: [],
          synthesis: null,
          chat: loadChat(paper.id),
          selection: null,
          loadStatus: "ready",
        });
        // Plan 060: a successful PDF load records (or refreshes) the
        // reading-history entry. Fire-and-forget: history persistence is
        // best-effort and must never block the reader. Plan 073: the
        // saved reader position rides along as lastPage.
        useHistoryStore.getState().recordOpen(paper, readPdfPosition(paper.id) ?? undefined);
        // Restore a previous walkthrough of this paper (best-effort):
        // reopening a favorited paper must not re-stream ~10 sections.
        const { sectionEntries, synthesis } = loadWalkthrough(paper.id);
        if (sectionEntries.length > 0 || synthesis) {
          if (openGen !== gen) return;
          set({
            sectionEntries,
            synthesis,
            sectionIndex: sectionEntries.length,
          });
        }
      } catch (err) {
        if (openGen !== gen) return;
        set({
          loadStatus: "error",
          loadError: err instanceof Error ? err.message : String(err),
        });
      }
    },
    // Lazy whole-paper text extraction: the viewer needs only the bytes,
    // so the pdf.js parse for Walkthrough/Ask happens on first use and is
    // cached. A newer open/close invalidates an in-flight extraction.
    ensureExtracted: async () => {
      const { sections, extractStatus, pdfBytes } = get();
      if (sections.length > 0) return true;
      // Join an in-flight extraction instead of starting a second parse
      // (or failing while one is running).
      if (extractPromise) return extractPromise;
      if (extractStatus === "loading" || !pdfBytes) return false;
      const gen = ++extractGen;
      set({ extractStatus: "loading", extractError: null });
      const run = (async (): Promise<boolean> => {
        try {
          const text = await extractTextFromPdf(pdfBytes);
          if (extractGen !== gen) return false;
          const sections = splitIntoSections(text);
          if (sections.length === 0) {
            set({
              extractStatus: "error",
              extractError: "No readable text could be extracted from this PDF.",
            });
            return false;
          }
          set({ sections, extractStatus: "done" });
          return true;
        } catch (err) {
          if (extractGen !== gen) return false;
          set({
            extractStatus: "error",
            extractError: err instanceof Error ? err.message : String(err),
          });
          return false;
        }
      })();
      extractPromise = run.finally(() => {
        extractPromise = null;
      });
      return extractPromise;
    },

    close: () => {
      // Invalidate any in-flight open or extraction: closing the reader
      // must win.
      openGen += 1;
      extractGen += 1;
      extractPromise = null;
      set({
        paper: null,
        pdfBytes: null,
        loadStatus: "idle",
        loadError: null,
        sections: [],
        extractStatus: "idle",
        extractError: null,
        sectionIndex: 0,
        sectionEntries: [],
        synthesis: null,
        chat: [],
        selection: null,
      });
    },

    setSelection: (text) => set({ selection: text }),
    clearSelection: () => set({ selection: null }),

    startWalkthrough: async (provider, language) => {
      // The walkthrough needs the whole-paper text: extract it lazily on
      // first use (open() only downloads the PDF bytes).
      const ok = await get().ensureExtracted();
      if (!ok) return;
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
        await get().explainSection(sectionIndex, provider, language, false);
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
          activeOperationId = newOperationId();
          await streamSynthesis({
            provider,
            paper,
            sectionsText: capTotal(sections.join("\n\n")),
            language,
            operationId: activeOperationId,
            onChunk: (chunk) => buffer.push(chunk),
          });
          if (wtGen !== gen) return;
          buffer.flushNow();
          set((s) => (s.synthesis ? { synthesis: { ...s.synthesis, status: "done" } } : {}));
          persistCurrentWalkthrough();
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
          persistCurrentWalkthrough();
        }
      }
    },

    /**
     * Streams the explanation for section `i`. With `replace` it overwrites
     * the entry at that index (regenerate); otherwise it appends a fresh
     * entry (continue). Shared by continueWalkthrough and regenerateSection.
     */
    explainSection: async (i, provider, language, replace) => {
      const { paper, sections } = get();
      if (!paper || i < 0 || i >= sections.length) return;
      const gen = ++wtGen;
      set((s) => ({
        sectionIndex: i + 1,
        sectionEntries: replace
          ? s.sectionEntries.map((e, idx) =>
              idx === i ? { text: "", status: "loading", error: null } : e,
            )
          : [...s.sectionEntries, { text: "", status: "loading", error: null }],
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
        activeOperationId = newOperationId();
        await streamSectionExplanation({
          provider,
          paper,
          sectionIndex: i + 1,
          totalSections: sections.length,
          sectionText: sections[i],
          language,
          operationId: activeOperationId,
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
        persistCurrentWalkthrough();
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
        persistCurrentWalkthrough();
      }
    },

    /**
     * Re-runs the last section's explanation, replacing its entry: lets the
     * user redo a stopped (or finished) section instead of only moving on.
     */
    regenerateSection: async (provider, language) => {
      const { sections, sectionIndex, sectionEntries } = get();
      const i = sectionIndex - 1;
      if (i < 0 || i >= sections.length) return;
      const entry = sectionEntries[i];
      if (!entry || (entry.status !== "done" && entry.status !== "stopped")) return;
      await get().explainSection(i, provider, language, true);
    },

    ask: async (question, provider, language) => {
      const { paper, selection } = get();
      if (!paper || !question.trim()) return;
      // Ask is grounded in the whole-paper text: extract it lazily.
      await get().ensureExtracted();
      const { sections, extractError } = get();
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
          const index = s.chat.findIndex((m) => m.id === assistantId);
          if (index < 0) return s;
          const msg = s.chat[index];
          // loading OR streaming: the first flush flips the status and
          // later flushes must keep appending (same rule as sections).
          // Immutable update: never mutate the stored message in place,
          // so React and the buffer's own snapshot see a new reference.
          if (msg.status !== "loading" && msg.status !== "streaming") return s;
          const list = [...s.chat];
          list[index] = { ...msg, text: msg.text + text, status: "streaming" };
          return { chat: list };
        },
      });

      // Ground the answer: the section containing the selection (or the
      // first section when there is no selection), so the model never
      // answers without paper context.
      const context = findContextSection(sections, selectionSnapshot ?? "");

      // No paper text to ground on: surface the extraction problem on the
      // assistant message instead of streaming an ungrounded answer.
      if (sections.length === 0) {
        set((s) => ({
          chat: s.chat.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  status: "error",
                  error: extractError ?? "Could not read the paper text.",
                }
              : m,
          ),
        }));
        return;
      }

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
        activeOperationId = newOperationId();
        await streamAsk({
          provider,
          paper,
          question: question.trim(),
          selection: selectionSnapshot,
          context,
          history,
          language,
          operationId: activeOperationId,
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
      const { sectionEntries, synthesis, chat, paper } = get();
      const wtBusy =
        sectionEntries.some((e) => e.status === "loading" || e.status === "streaming") ||
        (synthesis !== null &&
          (synthesis.status === "loading" || synthesis.status === "streaming"));
      const chatBusy = chat.some((m) => m.status === "loading" || m.status === "streaming");

      if (wtBusy) {
        wtGen += 1;
        await stopActiveStream();
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
        await stopActiveStream();
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
