import { BookOpenText, Check, CircleAlert, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Markdown } from "@/components/markdown/markdown";
import { Button } from "@/components/ui/button";
import { SectionCard, StatusRow } from "./section-card";
import { cn } from "@/lib/utils";
import type { SectionEntry } from "@/stores/reader";
import type { ExtractStatus } from "@/stores/reader";

interface WalkthroughPanelProps {
  extractStatus: ExtractStatus;
  extractError: string | null;
  sectionsTotal: number;
  sectionEntries: SectionEntry[];
  sectionIndex: number;
  synthesis: SectionEntry | null;
  walkthroughDone: boolean;
  wtBusy: boolean;
  canRegenerate: boolean;
  onStart: () => void;
  onContinue: () => void;
  onRegenerate: () => void;
}

/** The section-by-section explanation tab: empty/loading/error states, section cards, synthesis and continue/regenerate actions. */
export function WalkthroughPanel({
  extractStatus,
  extractError,
  sectionsTotal,
  sectionEntries,
  sectionIndex,
  synthesis,
  walkthroughDone,
  wtBusy,
  canRegenerate,
  onStart,
  onContinue,
  onRegenerate,
}: WalkthroughPanelProps) {
  const { t } = useTranslation();

  return (
    <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto p-3">
      <div className="flex flex-col gap-3">
        {extractStatus === "error" && sectionEntries.length === 0 && (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-6 text-center">
            <CircleAlert className="size-10 text-destructive/70" />
            <p className="max-w-60 text-sm text-muted-foreground">
              {extractError ?? t("reader.noText")}
            </p>
            <Button variant="outline" onClick={onStart}>
              {t("reader.retryExtraction")}
            </Button>
          </div>
        )}

        {extractStatus !== "error" && sectionEntries.length === 0 && !synthesis && (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed bg-muted/20 p-6 text-center">
            {extractStatus === "loading" ? (
              <Loader2 className="size-10 animate-spin text-primary" />
            ) : (
              <div className="flex size-10 items-center justify-center rounded-full bg-primary/10">
                <BookOpenText className="size-5 text-primary" />
              </div>
            )}
            <p className="max-w-60 text-sm text-muted-foreground">{t("reader.explainWholeHint")}</p>
            <Button disabled={extractStatus === "loading"} onClick={onStart}>
              {extractStatus === "loading" ? t("reader.preparingPaper") : t("reader.explainWhole")}
            </Button>
          </div>
        )}

        {sectionEntries.map((entry, i) => (
          <SectionCard key={i} index={i} total={sectionsTotal} entry={entry} />
        ))}

        {synthesis !== null && (
          <div
            className={cn(
              "rounded-lg border border-primary/30 bg-primary/5 p-3.5",
              synthesis.status === "loading" && "animate-pulse",
            )}
          >
            <div className="mb-2 flex items-center gap-2">
              <span className="flex size-5 items-center justify-center rounded-full bg-primary/10">
                <Check className="size-3 text-primary" />
              </span>
              <p className="text-xs font-semibold text-primary">{t("reader.synthesis")}</p>
              {(synthesis.status === "loading" || synthesis.status === "streaming") && (
                <Loader2 className="size-3 animate-spin text-primary" />
              )}
            </div>
            {synthesis.text.length > 0 && <Markdown>{synthesis.text}</Markdown>}
            <StatusRow status={synthesis.status} error={synthesis.error} />
          </div>
        )}

        {!walkthroughDone && !wtBusy && sectionEntries.length > 0 && (
          <div className="flex flex-col gap-2">
            <Button
              variant={sectionIndex < sectionsTotal ? "default" : "outline"}
              className="w-full"
              onClick={onContinue}
            >
              {sectionIndex < sectionsTotal ? t("reader.continue") : t("reader.finishSynthesis")}
            </Button>
            {canRegenerate && (
              <Button variant="outline" className="w-full" onClick={onRegenerate}>
                {t("reader.regenerate")}
              </Button>
            )}
          </div>
        )}

        {walkthroughDone && (
          <p className="text-center text-xs text-muted-foreground">{t("reader.walkthroughDone")}</p>
        )}
      </div>
    </div>
  );
}
