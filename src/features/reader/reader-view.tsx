import { useState } from "react";
import { useTranslation } from "react-i18next";

import { PdfViewer } from "@/components/pdf-viewer/pdf-viewer";
import { ReaderNotes } from "@/features/reader/reader-notes";
import { ReaderOverview } from "@/features/reader/reader-overview";
import { AskPanel } from "@/features/reader/ask-panel";
import { ContextRow } from "@/features/reader/context-row";
import { LoadError, LoadState, NoProviderCta } from "@/features/reader/load-states";
import { PanelSelectionStrip } from "@/features/reader/panel-selection-strip";
import { ReaderHeader } from "@/features/reader/reader-header";
import { type Tab } from "@/features/reader/reader-tabs";
import { TabList } from "@/features/reader/tab-list";
import { SelectionBar } from "@/features/reader/selection-bar";
import { WalkthroughPanel } from "@/features/reader/walkthrough-panel";
import { useCopySelection } from "@/features/reader/use-copy-selection";
import { useReaderSplit } from "@/features/reader/use-reader-split";
import { useNotesStore } from "@/stores/notes";
import { usePapersStore } from "@/stores/papers";
import { useReaderTextScale } from "@/hooks/use-reader-text-scale";
import { useReaderStore } from "@/stores/reader";
import { useSettingsStore } from "@/stores/settings";
import { useUiStore } from "@/stores/ui";

export type { Tab } from "@/features/reader/reader-tabs";

export { clampSplit } from "@/features/reader/use-reader-split";

export function ReaderView() {
  const { t, i18n } = useTranslation();
  const setView = useUiStore((s) => s.setView);
  const { scale, scaleUp, scaleDown } = useReaderTextScale();
  const { providers, activeProviderId } = useSettingsStore();
  // Subscribed (not getState): the Overview citation count must refresh
  // when the async batch resolves after the reader is already open.
  const citations = usePapersStore((s) => s.citations);
  const reader = useReaderStore();
  const [tab, setTab] = useState<Tab>("overview");
  const [question, setQuestion] = useState("");
  const [savingHighlight, setSavingHighlight] = useState(false);
  const upsertNote = useNotesStore((s) => s.upsert);
  const { split, isRow, rowRef, startSplitDrag } = useReaderSplit();
  const { copied, copySelection } = useCopySelection();

  const paper = reader.paper;
  const provider = providers.find((p) => p.id === activeProviderId) ?? providers[0];

  const wtBusy =
    reader.sectionEntries.some((e) => e.status === "loading" || e.status === "streaming") ||
    (reader.synthesis !== null &&
      (reader.synthesis.status === "loading" || reader.synthesis.status === "streaming"));
  const chatBusy = reader.chat.some((m) => m.status === "loading" || m.status === "streaming");
  const busy = wtBusy || chatBusy;

  const walkthroughDone =
    reader.sections.length > 0 &&
    reader.sectionIndex >= reader.sections.length &&
    reader.synthesis !== null &&
    reader.synthesis.status === "done";
  const lastSectionEntry = reader.sectionEntries[reader.sectionEntries.length - 1];
  // Regenerate is offered when the last section is finished or was stopped,
  // so the user can redo it instead of only moving forward.
  const canRegenerate =
    !wtBusy &&
    lastSectionEntry !== undefined &&
    (lastSectionEntry.status === "done" || lastSectionEntry.status === "stopped");

  const handleAsk = () => {
    if (!question.trim() || !provider || chatBusy) return;
    void reader.ask(question, provider, i18n.language);
    setQuestion("");
  };

  // Saves the current PDF selection as a highlight note (explicit user
  // action — selecting text never auto-saves anything).
  const handleSaveHighlight = async () => {
    if (!reader.selection || !paper) return;
    setSavingHighlight(true);
    try {
      await upsertNote({
        paperId: paper.id,
        paperTitle: paper.title,
        kind: "highlight",
        body: "",
        quote: reader.selection,
      });
      setTab("notes");
      reader.clearSelection();
    } finally {
      setSavingHighlight(false);
    }
  };

  return (
    <div
      className="reader-ai-panel flex h-dvh flex-col focus:outline-none"
      data-reader-scale={scale}
      data-view-root
      tabIndex={-1}
    >
      {/* header */}
      <ReaderHeader
        title={paper?.title ?? ""}
        busy={busy}
        onBack={() => setView("papers")}
        onStop={() => void reader.stop()}
        scale={scale}
        onScaleUp={scaleUp}
        onScaleDown={scaleDown}
      />

      {/* Reader context row: current mode, walkthrough progress, and the
          selected passage, so the user always knows what the AI panel is
          working with. Compact and direction-safe. */}
      {reader.loadStatus === "ready" && (
        <ContextRow
          tab={tab}
          walkthroughDone={walkthroughDone}
          walkthroughBusy={wtBusy}
          sectionsDone={reader.sectionEntries.length}
          sectionsTotal={reader.sections.length}
          hasSelection={reader.selection !== null}
        />
      )}

      {reader.loadStatus === "loading" && <LoadState />}

      {reader.loadStatus === "error" && (
        <LoadError onBack={() => setView("papers")} loadError={reader.loadError} />
      )}

      {reader.loadStatus === "ready" && paper && (
        <div ref={rowRef} className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
          {/* PDF viewer: grows with the row on narrow windows, exact
              share of the split on desktop (inline-start side). */}
          <div
            className="min-h-0 dark:bg-[oklch(0.145_0.008_60)]"
            style={
              isRow
                ? {
                    flexBasis: `${split * 100}%`,
                    flexGrow: 0,
                    flexShrink: 0,
                    // The divider must never crush a pane below a usable
                    // reading width, whatever the window size.
                    minWidth: 280,
                  }
                : { flex: "3 1 0%" }
            }
          >
            {reader.pdfBytes && (
              <>
                {reader.selection && (
                  <SelectionBar
                    selection={reader.selection}
                    copied={copied}
                    saving={savingHighlight}
                    onCopy={() => void copySelection()}
                    onSaveHighlight={handleSaveHighlight}
                    onAsk={() => setTab("ask")}
                    onClear={() => reader.clearSelection()}
                  />
                )}
                <PdfViewer
                  bytes={reader.pdfBytes}
                  paperId={paper.id}
                  onSelect={(text) => reader.setSelection(text)}
                />
              </>
            )}
          </div>

          {/* Resize handle (desktop only): drag to change the split. */}
          {isRow && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={t("reader.resizeSplit")}
              title={t("reader.resizeSplit")}
              onPointerDown={startSplitDrag}
              className="w-1.5 shrink-0 cursor-col-resize touch-none border-x border-border/60 bg-muted/40 transition-colors hover:bg-primary/20 active:bg-primary/30"
            />
          )}

          {/* AI panel: tabs on top, then per-tab content. The Ask tab keeps
              its input pinned at the bottom, always visible. */}
          <aside
            className="flex min-h-0 flex-col border-t bg-card/40 lg:border-s lg:border-t-0"
            style={
              isRow
                ? {
                    flexBasis: `${(1 - split) * 100}%`,
                    flexGrow: 0,
                    flexShrink: 0,
                    minWidth: 280,
                  }
                : { flex: "2 1 0%" }
            }
          >
            {reader.selection && (
              <PanelSelectionStrip
                selection={reader.selection}
                copied={copied}
                saving={savingHighlight}
                onCopy={copySelection}
                onClear={() => reader.clearSelection()}
                onSaveHighlight={handleSaveHighlight}
              />
            )}
            <TabList tab={tab} onTab={setTab} />

            {tab === "notes" ? (
              <ReaderNotes
                paper={paper}
                onAskAbout={(note) => {
                  // Pre-fill the chat with the note as context; the user
                  // edits and sends (explicit, cancellable).
                  const context = note.quote ?? note.body;
                  setQuestion(`${t("notes.askAbout")}: “${context.trim().slice(0, 500)}”`);
                  setTab("ask");
                }}
              />
            ) : tab === "overview" ? (
              <ReaderOverview
                paper={paper}
                citationCount={citations[paper.id]}
                explainDisabled={!provider}
                noProvider={providers.length === 0}
                onOpenSettings={() => setView("settings")}
                onExplain={() => {
                  setTab("walkthrough");
                  if (provider) void reader.startWalkthrough(provider, i18n.language);
                }}
              />
            ) : providers.length === 0 ? (
              <NoProviderCta onOpenSettings={() => setView("settings")} />
            ) : tab === "walkthrough" ? (
              <WalkthroughPanel
                extractStatus={reader.extractStatus}
                extractError={reader.extractError}
                sectionsTotal={reader.sections.length}
                sectionEntries={reader.sectionEntries}
                sectionIndex={reader.sectionIndex}
                synthesis={reader.synthesis}
                walkthroughDone={walkthroughDone}
                wtBusy={wtBusy}
                canRegenerate={canRegenerate}
                onStart={() => void reader.startWalkthrough(provider, i18n.language)}
                onContinue={() => void reader.continueWalkthrough(provider, i18n.language)}
                onRegenerate={() => void reader.regenerateSection(provider, i18n.language)}
              />
            ) : (
              <AskPanel
                chat={reader.chat}
                chatBusy={chatBusy}
                question={question}
                onQuestionChange={setQuestion}
                onAsk={handleAsk}
                onRetry={() => void reader.retryAsk(provider, i18n.language)}
              />
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
