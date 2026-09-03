import { AlertCircle, Bookmark, BookOpenText, Loader2, Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StatePanel } from "@/components/ui/state-panel";
import type { Paper } from "@/lib/types";
import { SCHOLAR_SEARCH_REQUIRED } from "@/stores/papers";
import { ContinueReading } from "./continue-reading";
import { HistoryList } from "./history-list";
import { PaperCard } from "./paper-card";
import { TodayPicks } from "./today-picks";
import { VirtualList } from "./virtual-paper-list";

function PaperSkeleton() {
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-5">
        <div className="flex items-start justify-between gap-3">
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-5 w-16 shrink-0" />
        </div>
        <Skeleton className="h-3.5 w-1/2" />
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-5/6" />
        <div className="mt-1 flex gap-2">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-24" />
        </div>
      </CardContent>
    </Card>
  );
}

export interface PicksStrip {
  papers: Paper[];
  date: string | null;
}

interface PaperListContentProps {
  loading: boolean;
  error: string | null;
  fallbackNote: boolean;
  onDismissFallback: () => void;
  savedOnly: boolean;
  historyMode: boolean;
  date: string | null;
  queryTrim: string;
  showContinue: boolean;
  showPicks: boolean;
  picks: PicksStrip;
  onDismissPicks: () => void;
  onOpenPaper: (paper: Paper) => void;
  savedPapers: Paper[];
  visiblePapers: Paper[];
  showLoadMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onRetry: () => void;
  onClearSearch: () => void;
}

/**
 * Everything below the pinned toolbar: fallback note, continue-reading
 * and picks strips, history mode, and the loading / error / saved /
 * empty / feed states. Pure render of precomputed props — all store
 * wiring lives in PaperList.
 */
export function PaperListContent({
  loading,
  error,
  fallbackNote,
  onDismissFallback,
  savedOnly,
  historyMode,
  date,
  queryTrim,
  showContinue,
  showPicks,
  picks,
  onDismissPicks,
  onOpenPaper,
  savedPapers,
  visiblePapers,
  showLoadMore,
  loadingMore,
  onLoadMore,
  onRetry,
  onClearSearch,
}: PaperListContentProps) {
  const { t } = useTranslation();

  return (
    <div className="min-h-0 flex-1 overflow-y-auto pe-2 pt-1">
      <div className="flex flex-col gap-4">
        {!loading && fallbackNote && (
          <div
            role="status"
            className="flex items-start justify-between gap-3 rounded-md border border-border bg-secondary p-3 text-xs text-secondary-foreground"
          >
            <span className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              {t("papers.sourceFallback")}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onDismissFallback}
              aria-label={t("papers.dismiss")}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        )}

        {/* Plan 073: Continue-reading strip on the main feed (hidden
        while browsing saved / history / search / day views). */}
        {showContinue && <ContinueReading />}

        {/* Today's picks: heuristic strip on the latest view only (hidden
        while browsing a specific day or the saved list). */}
        {showPicks && (
          <TodayPicks
            papers={picks.papers}
            date={picks.date}
            onDismiss={onDismissPicks}
            onOpen={onOpenPaper}
          />
        )}

        {/* Plan 060: History mode replaces the feed entirely. */}
        {historyMode && <HistoryList />}

        {!historyMode && loading && (
          <div className="flex flex-col gap-4" aria-label={t("papers.loading")}>
            {Array.from({ length: 5 }).map((_, i) => (
              <PaperSkeleton key={i} />
            ))}
          </div>
        )}

        {!historyMode && !loading && error === SCHOLAR_SEARCH_REQUIRED && (
          <StatePanel
            icon={<Search className="size-8" />}
            title={t("papers.scholarNeedsQuery")}
            muted
          />
        )}

        {!historyMode && !loading && error && error !== SCHOLAR_SEARCH_REQUIRED && (
          <StatePanel
            icon={<AlertCircle className="size-8 text-destructive" />}
            title={t("papers.error")}
            description={error}
            tone="destructive"
            action={
              <Button size="sm" variant="outline" onClick={onRetry}>
                {t("papers.retry")}
              </Button>
            }
          />
        )}

        {!historyMode && !loading && !error && savedOnly && savedPapers.length === 0 && (
          <StatePanel
            icon={<Bookmark className="size-8" />}
            title={t("papers.noFavorites")}
            muted
          />
        )}

        {!historyMode && !loading && !error && savedOnly && savedPapers.length > 0 && (
          <div className="flex flex-col gap-4">
            <VirtualList
              items={savedPapers}
              estimateSize={320}
              ariaLabel={t("papers.savedList")}
              renderItem={(p, i) => <PaperCard paper={p} index={i} />}
            />
          </div>
        )}

        {!historyMode && !loading && !error && !savedOnly && visiblePapers.length === 0 && (
          <StatePanel
            icon={queryTrim ? <Search className="size-8" /> : <BookOpenText className="size-8" />}
            title={
              queryTrim
                ? t("papers.noSearchResults", { query: queryTrim })
                : date
                  ? t("papers.noPapersOnDay")
                  : t("papers.empty")
            }
            muted
            action={
              queryTrim ? (
                <Button size="sm" variant="outline" onClick={onClearSearch}>
                  {t("papers.clearSearch")}
                </Button>
              ) : undefined
            }
          />
        )}

        {!historyMode && !loading && !error && !savedOnly && visiblePapers.length > 0 && (
          <div className="flex flex-col gap-4">
            <VirtualList
              items={visiblePapers}
              estimateSize={320}
              ariaLabel={t("papers.paperList")}
              renderItem={(p, i) => <PaperCard paper={p} index={i} />}
            />
            {showLoadMore && (
              <Button
                variant="outline"
                size="sm"
                className="self-center"
                onClick={onLoadMore}
                disabled={loadingMore}
              >
                {loadingMore ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" />
                    {t("papers.loadingMore")}
                  </>
                ) : (
                  t("papers.loadMore")
                )}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
