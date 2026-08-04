import { Sparkles, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { Paper } from "@/lib/types";

interface TodayPicksProps {
  papers: Paper[];
  /** Newest contributing digest day, for the context label. */
  date: string | null;
  onDismiss: () => void;
  onOpen: (paper: Paper) => void;
}

/**
 * "Today's picks": a bounded, heuristic strip of the newest papers in the
 * current field (see pickPapers). Labeled as a quick look, not as
 * authoritative ranking, and dismissible for the session.
 */
export function TodayPicks({ papers, date, onDismiss, onOpen }: TodayPicksProps) {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="today-picks-heading" className="rounded-md border bg-card/60 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2">
          <Sparkles className="mt-0.5 size-3.5 shrink-0 text-primary" />
          <div>
            <h2 id="today-picks-heading" className="text-xs font-semibold">
              {t("papers.todayPicks")}
            </h2>
            <p className="text-[11px] text-muted-foreground">
              {date ? t("papers.picksContext", { date }) : t("papers.picksHint")}
            </p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onDismiss}
          aria-label={t("papers.picksDismiss")}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
        {papers.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onOpen(p)}
            className="group flex w-56 shrink-0 flex-col gap-1.5 rounded-md border bg-background p-2.5 text-start transition-colors hover:border-primary/40"
          >
            <span dir="ltr" className="line-clamp-2 text-xs font-medium leading-snug">
              {p.title}
            </span>
            <span dir="ltr" className="font-mono text-[10px] text-muted-foreground">
              {p.categories[0] ?? p.id.split("v")[0]}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
