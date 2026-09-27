import { Loader2, MessageSquareText, RotateCcw, Send } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Markdown } from "@/components/markdown/markdown";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { redactSecrets, truncateError } from "@/lib/provider-errors";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "@/stores/reader";

interface AskPanelProps {
  chat: ChatMessage[];
  chatBusy: boolean;
  /** Controlled draft: the view owns it so the notes tab can pre-fill it. */
  question: string;
  onQuestionChange: (value: string) => void;
  onAsk: () => void;
  onRetry: () => void;
}

/** The Q&A tab: chat history (self-scrolling) with the input pinned below. */
export function AskPanel({
  chat,
  chatBusy,
  question,
  onQuestionChange,
  onAsk,
  onRetry,
}: AskPanelProps) {
  const { t } = useTranslation();
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [chat]);

  return (
    <div role="tabpanel" className="flex min-h-0 flex-1 flex-col">
      {/* chat history scrolls; the input stays pinned below */}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div
          aria-live="polite"
          aria-label={t("reader.chatHistory")}
          className="flex flex-col gap-3"
        >
          {chat.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
              <div className="flex size-10 items-center justify-center rounded-full bg-muted/60">
                <MessageSquareText className="size-5 text-muted-foreground" />
              </div>
              <p className="max-w-56 text-sm text-muted-foreground">{t("reader.emptyChat")}</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {chat.map((m) => (
                <div
                  key={m.id}
                  className={cn(
                    "max-w-[95%] rounded-lg p-3",
                    // The two roles must resolve to OPPOSITE edges in both
                    // directions. `self-start`/`self-end` are logical: in a
                    // column flex container the cross axis is horizontal and
                    // follows `direction`, so in RTL `self-start` is the
                    // right and `self-end` the left. The user is pinned to
                    // the right in both (self-end in LTR, rtl:self-start in
                    // Arabic); the assistant therefore needs
                    // rtl:self-end, not a bare self-start — a bare one
                    // resolved to the right too, stacking both roles on the
                    // same side of an Arabic transcript.
                    m.role === "user"
                      ? "self-end bg-primary/10 rtl:self-start"
                      : "self-start border bg-card rtl:self-end",
                  )}
                >
                  {m.role === "assistant" && m.text.length === 0 && m.status === "loading" && (
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
                      <p className="text-xs text-destructive">
                        {/* Defense in depth: the backend redacts, but a key
                            echoed back by a gateway must never render. */}
                        {truncateError(redactSecrets(m.error))}
                      </p>
                      {/* Errors are direction: one click re-asks
                          the same question (retryAsk). */}
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={onRetry}
                      >
                        <RotateCcw className="size-3" />
                        {t("reader.retryAsk")}
                      </Button>
                    </div>
                  )}
                  {m.role === "assistant" && m.status === "stopped" && (
                    <p className="text-xs text-muted-foreground">{t("explain.stopped")}</p>
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
            onChange={(e) => onQuestionChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) onAsk();
            }}
            placeholder={t("reader.askPlaceholder")}
            disabled={chatBusy}
            className="h-9 flex-1 text-sm"
            aria-label={t("reader.askPlaceholder")}
          />
          <Button
            size="icon"
            onClick={onAsk}
            disabled={chatBusy || !question.trim()}
            aria-label={t("reader.send")}
          >
            <Send className="size-4 rtl:-scale-x-100" />
          </Button>
        </div>
      </div>
    </div>
  );
}
