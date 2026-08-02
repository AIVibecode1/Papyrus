import {
  ArrowLeft,
  BookOpenText,
  Check,
  Loader2,
  MessageSquareText,
  Send,
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
  const chatEndRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [reader.chat]);

  const handleAsk = () => {
    if (!question.trim() || !provider || chatBusy) return;
    void reader.ask(question, provider, i18n.language);
    setQuestion("");
  };

  return (
    <div className="flex h-screen flex-col">
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
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          {/* PDF viewer */}
          <div className="min-h-0 min-w-0 flex-1">
            {reader.pdfBytes && (
              <PdfViewer bytes={reader.pdfBytes} onSelect={(text) => reader.setSelection(text)} />
            )}
          </div>

          {/* AI panel: tabs on top, then per-tab content. The Ask tab keeps
              its input pinned at the bottom, always visible. */}
          <aside className="flex min-h-0 w-full shrink-0 flex-col border-t bg-background lg:w-[26rem] lg:border-s lg:border-t-0">
            <div className="flex shrink-0 items-center gap-1 border-b p-2">
              <Button
                variant={tab === "walkthrough" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setTab("walkthrough")}
                aria-pressed={tab === "walkthrough"}
              >
                <BookOpenText className="size-3.5" />
                {t("reader.walkthroughTab")}
              </Button>
              <Button
                variant={tab === "ask" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setTab("ask")}
                aria-pressed={tab === "ask"}
              >
                <MessageSquareText className="size-3.5" />
                {t("reader.askTab")}
              </Button>
              <div className="flex-1" />
              {providers.length === 0 && (
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-xs"
                  onClick={() => setView("settings")}
                >
                  {t("explain.goToSettings")}
                </Button>
              )}
            </div>

            {providers.length === 0 ? (
              <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center">
                <p className="text-sm text-muted-foreground">{t("explain.noProvider")}</p>
              </div>
            ) : tab === "walkthrough" ? (
              <div className="min-h-0 flex-1 overflow-y-auto p-3">
                <div className="flex flex-col gap-3">
                  {reader.sections.length > 0 &&
                    reader.sectionEntries.length === 0 &&
                    !reader.synthesis && (
                      <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed bg-muted/20 p-6 text-center">
                        <div className="flex size-10 items-center justify-center rounded-full bg-primary/10">
                          <BookOpenText className="size-5 text-primary" />
                        </div>
                        <p className="max-w-60 text-sm text-muted-foreground">
                          {t("reader.explainWholeHint")}
                        </p>
                        <Button
                          onClick={() => void reader.startWalkthrough(provider, i18n.language)}
                        >
                          {t("reader.explainWhole")}
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
                    <Button
                      variant={reader.sectionIndex < reader.sections.length ? "default" : "outline"}
                      className="w-full"
                      onClick={() => void reader.continueWalkthrough(provider, i18n.language)}
                    >
                      {reader.sectionIndex < reader.sections.length
                        ? t("reader.continue")
                        : t("reader.finishSynthesis")}
                    </Button>
                  )}

                  {walkthroughDone && (
                    <p className="text-center text-xs text-muted-foreground">
                      {t("reader.walkthroughDone")}
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col">
                {/* chat history scrolls; the input stays pinned below */}
                <div className="min-h-0 flex-1 overflow-y-auto p-3">
                  <div className="flex flex-col gap-3">
                    {reader.selection && (
                      <div className="flex items-start gap-2 rounded-md border border-primary/30 bg-primary/5 p-2.5">
                        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                          <span className="font-medium text-foreground">
                            {t("reader.selectionLabel")}:
                          </span>{" "}
                          <span dir="ltr" className="line-clamp-2">
                            {reader.selection}
                          </span>
                        </p>
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
                              m.role === "user"
                                ? "self-end bg-primary/10"
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
                              <p className="text-xs text-destructive">{m.error}</p>
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
