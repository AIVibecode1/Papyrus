import { BookOpenText, ExternalLink, Lightbulb } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatUiDate } from "@/lib/dates";
import type { Paper } from "@/lib/types";

interface ReaderOverviewProps {
  paper: Paper;
  citationCount?: number;
  explainDisabled: boolean;
  /** True when no provider exists at all: the overview then shows the
   * settings shortcut inline (plan 045 WU1 keeps the guidance visible on
   * the default tab). */
  noProvider: boolean;
  onOpenSettings: () => void;
  /** Switches to the walkthrough tab and starts the section mentor. */
  onExplain: () => void;
  /** Jumps to the papers view with the title prefilled (plan 045 WU4). */
  onSearchScholar: () => void;
}

/** The reader's Overview tab (plan 045 WU1): paper metadata, abstract and
 * the two entry points (mentor walkthrough, title search). Renders
 * without an AI provider — it is pure metadata. */
export function ReaderOverview({
  paper,
  citationCount,
  explainDisabled,
  noProvider,
  onOpenSettings,
  onExplain,
  onSearchScholar,
}: ReaderOverviewProps) {
  const { t, i18n } = useTranslation();
  const published = formatUiDate(new Date(paper.published), i18n.language, {
    dateStyle: "medium",
  });

  return (
    <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto p-3">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="font-mono text-[10px]" dir="ltr">
            {paper.id}
          </Badge>
          {paper.categories.slice(0, 3).map((c) => (
            <Badge key={c} variant="secondary" className="shrink-0 font-mono text-[10px]" dir="ltr">
              {c}
            </Badge>
          ))}
        </div>

        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <time dateTime={paper.published}>{published}</time>
          {paper.venue && (
            <>
              <span aria-hidden="true" className="text-muted-foreground/50">
                ·
              </span>
              <span dir="ltr">{paper.venue}</span>
            </>
          )}
          {typeof citationCount === "number" && (
            <>
              <span aria-hidden="true" className="text-muted-foreground/50">
                ·
              </span>
              <span>
                {t("papers.citedByPrefix")}{" "}
                <span dir="ltr" className="font-mono">
                  {citationCount}
                </span>{" "}
                {t("papers.citedBySuffix")}
              </span>
            </>
          )}
        </p>

        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-semibold text-foreground">{t("reader.overviewAbstract")}</p>
          <p
            dir="ltr"
            className="rounded-lg border bg-card p-3 text-sm leading-relaxed text-muted-foreground"
          >
            {paper.summary || paper.tldr || t("papers.noAbstract")}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Button size="sm" onClick={onExplain} disabled={explainDisabled}>
            <BookOpenText className="size-3.5" />
            {t("reader.overviewExplain")}
          </Button>
          {noProvider && (
            <div className="flex flex-col gap-1.5 rounded-lg border border-dashed p-3">
              <p className="text-xs text-muted-foreground">{t("explain.noProvider")}</p>
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onOpenSettings}>
                {t("explain.goToSettings")}
              </Button>
            </div>
          )}
          <Button size="sm" variant="outline" onClick={onSearchScholar}>
            <ExternalLink className="size-3.5" />
            {t("reader.overviewSearchScholar")}
          </Button>
        </div>

        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Lightbulb className="size-3" />
          {t("reader.overviewHint")}
        </p>
      </div>
    </div>
  );
}
