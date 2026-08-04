import {
  ArrowLeft,
  BookOpenText,
  Check,
  CircleAlert,
  Copy,
  Loader2,
  MessageSquareText,
  RotateCcw,
  Send,
  Settings,
  Square,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Markdown } from "@/components/markdown/markdown";
import { PdfViewer } from "@/components/pdf-viewer/pdf-viewer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useReaderStore, type ChatMessage, type SectionEntry } from "@/stores/reader";
import { useSettingsStore } from "@/stores/settings";
import { useUiStore } from "@/stores/ui";
import { cn } from "@/lib/utils";

type Tab = "walkthrough" | "ask";

const SPLIT_KEY = "papyrus-reader-split";
/** PDF share of the row width (0.3 = panel dominates, 0.8 = PDF dominates). */
export function clampSplit(value: number): number {
  if (!Number.isFinite(value)) return 0.62;
  return Math.min(0.8, Math.max(0.3, value));
}

function initialSplit(): number {
  // No saved split means first launch: use the design default (0.62).
  // Number(null) is 0, so a missing key must not clamp to the 0.3 floor.
  const raw = localStorage.getItem(SPLIT_KEY);
  if (raw === null) return 0.62;
  try {
    return clampSplit(Number(raw));
  } catch {
    return 0.62;
  }
}

function isRowLayout(): boolean {
  return (
    typeof window.matchMedia !== "function" || window.matchMedia("(min-width: 1024px)").matches
  );
}

function StatusRow({ status, error }: { status: string; error: string | null }) {
  const { t } = useTranslation();
  if (status === "error" && error) {
    return <p className="mt-2 text-xs text-destructive">{error}</p>;
  }
  if (status === "stopped") {
    return <p className="mt-2 text-xs text-muted-foreground">{t("explain.stopped")}</p>;
  }
  return null;
}

function SectionCard({
  index,
  total,
  entry,
}: {
  index: number;
  total: number;
  entry: SectionEntry;
}) {
  const { t } = useTranslation();
  const busy = entry.status === "loading" || entry.status === "streaming";
  return (
    <div
      className={cn(
        "rounded-lg border bg-card p-3.5 transition-colors",
        entry.status === "streaming" && "border-primary/40",
        entry.status === "done" && "border-border",
        entry.status === "error" && "border-destructive/40",
      )}
    >
      <div className="mb-2 flex items-center gap-2">
        <span
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold",
            entry.status === "done"
              ? "bg-primary/10 text-primary"
              : busy
                ? "bg-primary/10 text-primary"
                : "bg-muted text-muted-foreground",
          )}
        >
          {entry.status === "done" ? <Check className="size-3" /> : index + 1}
        </span>
        <p className="text-xs font-semibold text-muted-foreground">
          {t("reader.sectionOf", { current: index + 1, total })}
        </p>
        {busy && (
          <span className="flex items-center gap-1.5 text-[11px] text-primary">
            <Loader2 className="size-3 animate-spin" />
            {t("reader.explainingSection")}
          </span>
        )}
      </div>
      {entry.text.length > 0 && <Markdown>{entry.text}</Markdown>}
      {entry.status === "streaming" && (
        <span className="inline-block h-3.5 w-0.5 animate-pulse bg-primary align-middle" />
      )}
      <StatusRow status={entry.status} error={entry.error} />
    </div>
  );
}

export function ReaderView() {
  const { t, i18n } = useTranslation();
  const setView = useUiStore((s) => s.setView);
  const { providers, activeProviderId } = useSettingsStore();
  const reader = useReaderStore();
  const [tab, setTab] = useState<Tab>("walkthrough");
  const [question, setQuestion] = useState("");
  const [copied, setCopied] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  // PDF share of the horizontal split (desktop); persisted between
  // sessions so the user's layout survives restarts.
  const [split, setSplit] = useState(initialSplit);
  const [isRow, setIsRow] = useState(isRowLayout);
  const draggingRef = useRef(false);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(min-width: 1024px)");
    const onChange = (e: MediaQueryListEvent) => setIsRow(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Drag the separator to resize the PDF/panel split. The PDF always
  // occupies the inline-start side, so the math flips in RTL.
  const startSplitDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const row = rowRef.current;
    if (!row) return;
    const rect = row.getBoundingClientRect();
    draggingRef.current = true;
    const onMove = (ev: PointerEvent) => {
      if (!draggingRef.current) return;
      const pdfWidth =
        document.documentElement.dir === "rtl" ? rect.right - ev.clientX : ev.clientX - rect.left;
      setSplit(clampSplit(pdfWidth / rect.width));
    };
    const onUp = () => {
      draggingRef.current = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      // Persist after the last move lands.
      try {
        localStorage.setItem(SPLIT_KEY, String(getSplitRef.current));
      } catch {
        // storage unavailable: keep the in-session layout
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  // Keep the persisted value in sync with the latest state at drag end.
  const getSplitRef = useRef(split);
  useEffect(() => {
    getSplitRef.current = split;
  }, [split]);

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

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [reader.chat]);

  const handleAsk = () => {
    if (!question.trim() || !provider || chatBusy) return;
    void reader.ask(question, provider, i18n.language);
    setQuestion("");
  };

  const handleCopySelection = async () => {
    if (!reader.selection) return;
    try {
      // Some embedded webviews hang instead of rejecting when the clipboard
      // permission is unavailable, so race the write against a timeout.
      await Promise.race([
        navigator.clipboard.writeText(reader.selection),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("clipboard unavailable")), 500),
        ),
      ]);
    } catch {
      // Fallback for restricted contexts (headless preview, older webviews):
      // select the text in a hidden textarea and execCommand("copy"). Some
      // webviews lack execCommand entirely — then the copy just does not
      // happen, but the UI still gives feedback.
      try {
        const textarea = document.createElement("textarea");
        textarea.value = reader.selection;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        if (typeof document.execCommand === "function") document.execCommand("copy");
        textarea.remove();
      } catch {
        // clipboard unavailable in this context; nothing more to try
      }
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex h-dvh flex-col">
      {/* header */}
      <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-background/80 px-3 backdrop-blur">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setView("papers")}
          aria-label={t("reader.back")}
          title={t("reader.back")}
        >
          {/* Back points left in LTR and right in RTL; one icon + rotation covers both. */}
          <ArrowLeft className="size-4 rtl:rotate-180" />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 dir="ltr" className="truncate text-sm font-semibold tracking-tight">
            {paper?.title ?? ""}
          </h1>
        </div>
        {busy && (
          <Button variant="outline" size="sm" onClick={() => void reader.stop()}>
            <Square className="size-3.5" />
            {t("explain.stop")}
          </Button>
        )}
      </header>

      {/* Reader context row: current mode, walkthrough progress, and the
          selected passage, so the user always knows what the AI panel is
          working with. Compact and direction-safe. */}
      {reader.loadStatus === "ready" && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted/20 px-4 py-1.5 text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground">
            {tab === "walkthrough" ? t("reader.walkthroughTab") : t("reader.askTab")}
          </span>
          {tab === "walkthrough" &&
            !walkthroughDone &&
            reader.sectionEntries.length > 0 &&
            reader.sections.length > 0 && (
              <span dir="ltr">
                {t("reader.sectionOf", {
                  current: Math.min(
                    reader.sectionEntries.length + (wtBusy ? 1 : 0),
                    reader.sections.length,
                  ),
                  total: reader.sections.length,
                })}
              </span>
            )}
          {tab === "walkthrough" && walkthroughDone && <span>{t("reader.synthesis")}</span>}
          {reader.selection && <span>{t("reader.passageSelected")}</span>}
        </div>
      )}

      {reader.loadStatus === "loading" && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
          <Loader2 className="size-6 animate-spin" />
          {t("reader.loadingPdf")}
        </div>
      )}

      {reader.loadStatus === "error" && (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10">
            <X className="size-6 text-destructive" />
          </div>
          <p className="max-w-sm text-sm text-muted-foreground">{reader.loadError}</p>
          <Button variant="outline" size="sm" onClick={() => setView("papers")}>
            {t("reader.back")}
          </Button>
        </div>
      )}

      {reader.loadStatus === "ready" && paper && (
        <div ref={rowRef} className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
          {/* PDF viewer: grows with the row on narrow windows, exact
              share of the split on desktop (inline-start side). */}
          <div
            className="min-h-0"
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
              <PdfViewer
                bytes={reader.pdfBytes}
                paperId={paper.id}
                onSelect={(text) => reader.setSelection(text)}
              />
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
            className="flex min-h-0 flex-col border-t bg-background lg:border-s lg:border-t-0"
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
              <div className="flex shrink-0 items-start gap-2 border-b bg-primary/5 p-2.5">
                <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{t("reader.selectionLabel")}:</span>{" "}
                  <span dir="ltr" className="line-clamp-2">
                    {reader.selection}
                  </span>
                </p>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={handleCopySelection}
                  aria-label={copied ? t("reader.copied") : t("reader.copySelection")}
                  title={copied ? t("reader.copied") : t("reader.copySelection")}
                >
                  {copied ? (
                    <Check className="size-3.5 text-primary" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => reader.clearSelection()}
                  aria-label={t("reader.clearSelection")}
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            )}
            <div
              className="flex shrink-0 items-center gap-1 border-b p-2"
              role="tablist"
              aria-label={t("reader.chatTabs")}
            >
              <Button
                variant={tab === "walkthrough" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setTab("walkthrough")}
                role="tab"
                aria-selected={tab === "walkthrough"}
              >
                <BookOpenText className="size-3.5" />
                {t("reader.walkthroughTab")}
              </Button>
              <Button
                variant={tab === "ask" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setTab("ask")}
                role="tab"
                aria-selected={tab === "ask"}
              >
                <MessageSquareText className="size-3.5" />
                {t("reader.askTab")}
              </Button>
              <div className="flex-1" />
            </div>

            {providers.length === 0 ? (
              <div
                role="tabpanel"
                className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
              >
                <p className="max-w-60 text-sm text-muted-foreground">{t("explain.noProvider")}</p>
                <Button size="sm" variant="outline" onClick={() => setView("settings")}>
                  <Settings className="size-3.5" />
                  {t("explain.goToSettings")}
                </Button>
              </div>
            ) : tab === "walkthrough" ? (
              <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto p-3">
                <div className="flex flex-col gap-3">
                  {reader.extractStatus === "error" && reader.sections.length === 0 && (
                    <div className="flex flex-col items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-6 text-center">
                      <CircleAlert className="size-10 text-destructive/70" />
                      <p className="max-w-60 text-sm text-muted-foreground">
                        {reader.extractError ?? t("reader.noText")}
                      </p>
                      <Button
                        variant="outline"
                        onClick={() => void reader.startWalkthrough(provider, i18n.language)}
                      >
                        {t("reader.retryExtraction")}
                      </Button>
                    </div>
                  )}

                  {reader.extractStatus !== "error" &&
                    reader.sectionEntries.length === 0 &&
                    !reader.synthesis && (
                      <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed bg-muted/20 p-6 text-center">
                        {reader.extractStatus === "loading" ? (
                          <Loader2 className="size-10 animate-spin text-primary" />
                        ) : (
                          <div className="flex size-10 items-center justify-center rounded-full bg-primary/10">
                            <BookOpenText className="size-5 text-primary" />
                          </div>
                        )}
                        <p className="max-w-60 text-sm text-muted-foreground">
                          {t("reader.explainWholeHint")}
                        </p>
                        <Button
                          disabled={reader.extractStatus === "loading"}
                          onClick={() => void reader.startWalkthrough(provider, i18n.language)}
                        >
                          {reader.extractStatus === "loading"
                            ? t("reader.preparingPaper")
                            : t("reader.explainWhole")}
                        </Button>
                      </div>
                    )}

                  {reader.sectionEntries.map((entry, i) => (
                    <SectionCard key={i} index={i} total={reader.sections.length} entry={entry} />
                  ))}

                  {reader.synthesis !== null && (
                    <div
                      className={cn(
                        "rounded-lg border border-primary/30 bg-primary/5 p-3.5",
                        reader.synthesis.status === "loading" && "animate-pulse",
                      )}
                    >
                      <div className="mb-2 flex items-center gap-2">
                        <span className="flex size-5 items-center justify-center rounded-full bg-primary/10">
                          <Check className="size-3 text-primary" />
                        </span>
                        <p className="text-xs font-semibold text-primary">
                          {t("reader.synthesis")}
                        </p>
                        {(reader.synthesis.status === "loading" ||
                          reader.synthesis.status === "streaming") && (
                          <Loader2 className="size-3 animate-spin text-primary" />
                        )}
                      </div>
                      {reader.synthesis.text.length > 0 && (
                        <Markdown>{reader.synthesis.text}</Markdown>
                      )}
                      <StatusRow status={reader.synthesis.status} error={reader.synthesis.error} />
                    </div>
                  )}

                  {!walkthroughDone && !wtBusy && reader.sectionEntries.length > 0 && (
                    <div className="flex flex-col gap-2">
                      <Button
                        variant={
                          reader.sectionIndex < reader.sections.length ? "default" : "outline"
                        }
                        className="w-full"
                        onClick={() => void reader.continueWalkthrough(provider, i18n.language)}
                      >
                        {reader.sectionIndex < reader.sections.length
                          ? t("reader.continue")
                          : t("reader.finishSynthesis")}
                      </Button>
                      {canRegenerate && (
                        <Button
                          variant="outline"
                          className="w-full"
                          onClick={() => void reader.regenerateSection(provider, i18n.language)}
                        >
                          {t("reader.regenerate")}
                        </Button>
                      )}
                    </div>
                  )}

                  {walkthroughDone && (
                    <p className="text-center text-xs text-muted-foreground">
                      {t("reader.walkthroughDone")}
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <div role="tabpanel" className="flex min-h-0 flex-1 flex-col">
                {/* chat history scrolls; the input stays pinned below */}
                <div className="min-h-0 flex-1 overflow-y-auto p-3">
                  <div
                    aria-live="polite"
                    aria-label={t("reader.chatHistory")}
                    className="flex flex-col gap-3"
                  >
                    {reader.chat.length === 0 ? (
                      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
                        <div className="flex size-10 items-center justify-center rounded-full bg-muted/60">
                          <MessageSquareText className="size-5 text-muted-foreground" />
                        </div>
                        <p className="max-w-56 text-sm text-muted-foreground">
                          {t("reader.emptyChat")}
                        </p>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-3">
                        {reader.chat.map((m: ChatMessage) => (
                          <div
                            key={m.id}
                            className={cn(
                              "max-w-[95%] rounded-lg p-3",
                              // The user's question sits on the reading
                              // start side: right in LTR, and right again
                              // in RTL (self-end would flip it to the
                              // left in Arabic).
                              m.role === "user"
                                ? "self-end bg-primary/10 rtl:self-start"
                                : "self-start border bg-card",
                            )}
                          >
                            {m.role === "assistant" &&
                              m.text.length === 0 &&
                              m.status === "loading" && (
                                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                  <Loader2 className="size-3.5 animate-spin" />
                                  {t("reader.thinking")}
                                </div>
                              )}
                            {m.text.length > 0 && (
                              <>
                                <Markdown>{m.text}</Markdown>
                                {m.status === "streaming" && (
                                  <span className="inline-block h-3.5 w-0.5 animate-pulse bg-primary align-middle" />
                                )}
                              </>
                            )}
                            {m.role === "assistant" && m.status === "error" && m.error && (
                              <div className="mt-2 flex flex-col items-start gap-1.5">
                                <p className="text-xs text-destructive">{m.error}</p>
                                {/* Errors are direction: one click re-asks
                                    the same question (retryAsk). */}
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 px-2 text-xs"
                                  onClick={() => void reader.retryAsk(provider, i18n.language)}
                                >
                                  <RotateCcw className="size-3" />
                                  {t("reader.retryAsk")}
                                </Button>
                              </div>
                            )}
                            {m.role === "assistant" && m.status === "stopped" && (
                              <p className="text-xs text-muted-foreground">
                                {t("explain.stopped")}
                              </p>
                            )}
                          </div>
                        ))}
                        <div ref={chatEndRef} />
                      </div>
                    )}
                  </div>
                </div>

                <div className="shrink-0 border-t bg-background p-3">
                  <div className="flex items-center gap-2">
                    <Input
                      value={question}
                      onChange={(e) => setQuestion(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) handleAsk();
                      }}
                      placeholder={t("reader.askPlaceholder")}
                      disabled={chatBusy}
                      className="h-9 flex-1 text-sm"
                      aria-label={t("reader.askPlaceholder")}
                    />
                    <Button
                      size="icon"
                      onClick={handleAsk}
                      disabled={chatBusy || !question.trim()}
                      aria-label={t("reader.send")}
                    >
                      <Send className="size-4 rtl:-scale-x-100" />
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
