import { Bookmark, BookmarkCheck, BookOpenText, ExternalLink, Lightbulb } from "lucide-react";
import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatUiDate } from "@/lib/dates";
import { Card, CardContent } from "@/components/ui/card";
import { ExplainPanel } from "@/features/papers/explain-panel";
import { useExplanationStore } from "@/stores/explanation";
import { useFavoritesStore } from "@/stores/favorites";
import { usePapersStore } from "@/stores/papers";
import { useReaderStore } from "@/stores/reader";
import { useSettingsStore } from "@/stores/settings";
import { useUiStore } from "@/stores/ui";
import type { Paper } from "@/lib/types";
import { cn } from "@/lib/utils";

interface PaperCardProps {
  paper: Paper;
  /** Position in the list; staggers the entry animation (capped). */
  index?: number;
}

export function PaperCard({ paper, index = 0 }: PaperCardProps) {
  const { t, i18n } = useTranslation();
  const { providers, activeProviderId } = useSettingsStore();
  const isFavorite = useFavoritesStore((s) => s.isFavorite);
  const toggleFavorite = useFavoritesStore((s) => s.toggle);
  const openReader = useReaderStore((s) => s.open);
  const setView = useUiStore((s) => s.setView);
  const citationCount = usePapersStore((s) => s.citations[paper.id]);
  const expandedId = useExplanationStore((s) => s.expandedId);
  const toggle = useExplanationStore((s) => s.toggle);
  const start = useExplanationStore((s) => s.start);
  const expanded = expandedId === paper.id;
  const favorited = isFavorite(paper.id);

  const published = formatUiDate(new Date(paper.published), i18n.language, {
    dateStyle: "medium",
  });

  // Tauri's webview blocks target="_blank" navigation, so route PDF links
  // through the opener plugin inside the app, and fall back to window.open
  // in a plain browser (dev preview).
  const handleOpenPdf = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    if ("__TAURI_INTERNALS__" in window) {
      openUrl(paper.pdfUrl).catch((err) => {
        // Surface failures instead of silently doing nothing: the opener
        // plugin rejects URLs outside its capability scope.
        console.error("openUrl failed for", paper.pdfUrl, err);
      });
    } else {
      window.open(paper.pdfUrl, "_blank", "noreferrer");
    }
  };

  const handleExplain = () => {
    if (expanded) {
      toggle(paper.id);
      return;
    }
    toggle(paper.id);
    const provider = providers.find((p) => p.id === activeProviderId) ?? providers[0];
    if (provider) {
      void start(paper, provider, i18n.language);
    }
  };

  const handleToggleFavorite = (e: MouseEvent<HTMLButtonElement>) => {
    // The card root has no click handler today, but keep the bookmark's
    // click isolated so a future card-level expand handler can't fire.
    e.stopPropagation();
    toggleFavorite(paper);
  };

  return (
    <Card
      className={cn(
        "animate-[card-in_0.6s_cubic-bezier(0.16,1,0.3,1)_both] transition-all duration-200 hover:-translate-y-px hover:border-foreground/20 hover:shadow-sm",
        expanded && "border-primary/50",
      )}
      style={{ animationDelay: `${Math.min(index, 10) * 40}ms` }}
    >
      <CardContent className="flex flex-col gap-2.5 p-5">
        {/* English paper content stays left-to-right inside the RTL layout:
            the title row and the meta row are anchored LTR, so the title
            reads from the left even in Arabic mode. */}
        <div dir="ltr" className="flex items-start justify-between gap-3">
          <h3
            dir="ltr"
            className="text-[15px] font-semibold leading-snug tracking-tight text-balance"
          >
            {paper.title}
          </h3>
          <Badge variant="secondary" className="shrink-0 font-mono text-xs" dir="ltr">
            {paper.categories[0] ?? paper.id.split("v")[0]}
          </Badge>
        </div>

        <p dir="ltr" className="font-mono text-[11px] leading-relaxed text-muted-foreground">
          <time dateTime={paper.published}>{published}</time>
          {paper.authors.length > 0 && (
            <>
              {" · "}
              <span dir="ltr" className="line-clamp-1" title={paper.authors.join(", ")}>
                {paper.authors.join(", ")}
              </span>
            </>
          )}
          {typeof citationCount === "number" && (
            <>
              {" · "}
              <span title={t("papers.citedBy", { count: citationCount })}>
                {t("papers.citedBy", { count: citationCount })}
              </span>
            </>
          )}
        </p>

        <p
          dir={paper.summary ? "ltr" : undefined}
          className="line-clamp-3 text-sm leading-relaxed text-muted-foreground"
        >
          {/* A TLDR is a model-generated one-liner: a fallback for missing
              abstracts, never a replacement for a present one (spike §4). */}
          {paper.summary || paper.tldr || t("papers.noAbstract")}
        </p>

        <div className="mt-1 flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleToggleFavorite}
            aria-pressed={favorited}
            aria-label={favorited ? t("papers.saved") : t("papers.save")}
            className={favorited ? "text-primary" : "text-muted-foreground"}
          >
            {favorited ? <BookmarkCheck className="size-4" /> : <Bookmark className="size-4" />}
          </Button>
          <Button variant="outline" size="sm" asChild>
            <a href={paper.pdfUrl} target="_blank" rel="noreferrer" onClick={handleOpenPdf}>
              <ExternalLink className="size-3.5" />
              {t("papers.openPdf")}
            </a>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void openReader(paper);
              setView("reader");
            }}
          >
            <BookOpenText className="size-3.5" />
            {t("papers.read")}
          </Button>
          <Button
            size="sm"
            disabled={providers.length === 0}
            title={providers.length === 0 ? t("explain.noProvider") : undefined}
            onClick={handleExplain}
            aria-expanded={expanded}
          >
            <Lightbulb className="size-3.5" />
            {t("papers.explain")}
          </Button>
        </div>

        {expanded && <ExplainPanel paper={paper} />}
      </CardContent>
    </Card>
  );
}
