import { Bookmark, BookmarkCheck, ExternalLink, Lightbulb } from "lucide-react";
import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ExplainPanel } from "@/features/papers/explain-panel";
import { useExplanationStore } from "@/stores/explanation";
import { useFavoritesStore } from "@/stores/favorites";
import { useSettingsStore } from "@/stores/settings";
import type { Paper } from "@/lib/types";
import { cn } from "@/lib/utils";

interface PaperCardProps {
  paper: Paper;
}

export function PaperCard({ paper }: PaperCardProps) {
  const { t, i18n } = useTranslation();
  const { providers, activeProviderId } = useSettingsStore();
  const isFavorite = useFavoritesStore((s) => s.isFavorite);
  const toggleFavorite = useFavoritesStore((s) => s.toggle);
  const expandedId = useExplanationStore((s) => s.expandedId);
  const toggle = useExplanationStore((s) => s.toggle);
  const start = useExplanationStore((s) => s.start);
  const expanded = expandedId === paper.id;
  const favorited = isFavorite(paper.id);

  const published = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: "medium",
  }).format(new Date(paper.published));

  // Tauri's webview blocks target="_blank" navigation, so route PDF links
  // through the opener plugin inside the app, and fall back to window.open
  // in a plain browser (dev preview).
  const handleOpenPdf = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    if ("__TAURI_INTERNALS__" in window) {
      void openUrl(paper.pdfUrl);
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
        "transition-all duration-200 hover:-translate-y-px hover:border-foreground/20 hover:shadow-sm",
        expanded && "border-primary/50",
      )}
    >
      <CardContent className="flex flex-col gap-2.5 p-5">
        <div className="flex items-start justify-between gap-3">
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

        <p className="text-xs text-muted-foreground">
          <time dateTime={paper.published}>{published}</time>
          {paper.authors.length > 0 && (
            <>
              {" · "}
              <span dir="ltr" className="line-clamp-1" title={paper.authors.join(", ")}>
                {paper.authors.join(", ")}
              </span>
            </>
          )}
        </p>

        <p
          dir={paper.summary ? "ltr" : undefined}
          className="line-clamp-3 text-sm leading-relaxed text-muted-foreground"
        >
          {paper.summary || t("papers.noAbstract")}
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
