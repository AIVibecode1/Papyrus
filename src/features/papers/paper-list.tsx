import {
  AlertCircle,
  Bookmark,
  BookOpenText,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Loader2,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatUiDate } from "@/lib/dates";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { pickPapers } from "@/lib/picks";
import { sortPapers, type PaperSortMode } from "@/lib/paper-sort";
import { useFavoritesStore } from "@/stores/favorites";
import { usePapersStore, SCHOLAR_SEARCH_REQUIRED } from "@/stores/papers";
import { useDigestStore, addDays, todayStr } from "@/stores/digest";
import { useReaderStore } from "@/stores/reader";
import { useUiStore } from "@/stores/ui";
import { PaperCard } from "@/features/papers/paper-card";
import { TodayPicks } from "@/features/papers/today-picks";

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

function formatDay(date: string, language: string): string {
  return formatUiDate(`${date}T00:00:00Z`, language, { month: "short", day: "numeric" });
}

export function PaperList() {
  const { t, i18n } = useTranslation();
  const { papers, loading, error, refresh, lastUpdated, fallbackNote, clearFallbackNote } =
    usePapersStore();
  const category = usePapersStore((s) => s.category);
  const source = usePapersStore((s) => s.source);
  const date = usePapersStore((s) => s.date);
  const setDate = usePapersStore((s) => s.setDate);
  const setQuery = usePapersStore((s) => s.setQuery);
  const loadMore = usePapersStore((s) => s.loadMore);
  const loadingMore = usePapersStore((s) => s.loadingMore);
  const savedIds = useFavoritesStore((s) => s.ids);
  const savedBy = useFavoritesStore((s) => s.byId);
  // Select the stable byCategory reference and derive below. Calling a
  // store method inside the selector (e.g. s.days(category)) would return
  // a fresh array every render and trip React's getSnapshot loop guard.
  const byCategory = useDigestStore((s) => s.byCategory);
  const ensureHistory = useDigestStore((s) => s.ensureHistory);
  const progress = useDigestStore((s) => s.progress);
  const digestDays = Object.keys(byCategory[category] ?? {})
    .sort()
    .reverse();
  const dayCount = (d: string) => byCategory[category]?.[d]?.length ?? 0;
  const [savedOnly, setSavedOnly] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const openReader = useReaderStore((s) => s.open);
  const setView = useUiStore((s) => s.setView);
  // Per-category session dismissal for the picks strip: sessionStorage
  // survives re-mounts but resets on the next app launch.
  const picksKey = `papyrus-picks-dismissed-${category}`;
  const [picksDismissed, setPicksDismissed] = useState(
    () => sessionStorage.getItem(picksKey) === "1",
  );
  const picks = pickPapers(byCategory, category);

  const dismissPicks = () => {
    sessionStorage.setItem(picksKey, "1");
    setPicksDismissed(true);
  };

  const sortMode = usePapersStore((s) => s.sortMode);
  const setSortMode = usePapersStore((s) => s.setSortMode);
  const citations = usePapersStore((s) => s.citations);
  const citationsLoading = usePapersStore((s) => s.citationsLoading);
  const citationsReachable = usePapersStore((s) => s.citationsReachable);
  const loadCitations = usePapersStore((s) => s.loadCitations);
  // "Most cited" reorders the loaded list by the citation counts already
  // fetched (they arrive a moment after the list, and the list re-sorts
  // live as they land). Papers without a known count sort last.
  const visiblePapers = useMemo(
    () => sortPapers(papers, citations, sortMode),
    [papers, citations, sortMode],
  );
  // While in cited mode with no counts yet, tell the user the counts are
  // on their way instead of looking like the sort did nothing.
  const hasAnyCount = papers.some((p) => (citations[p.id] ?? 0) > 0);
  const countsPending =
    sortMode === "cited" && papers.length > 0 && !hasAnyCount && citationsLoading;
  const countsDone = sortMode === "cited" && papers.length > 0 && !hasAnyCount && !citationsLoading;
  // No citation source answered (network/S2 429 + OpenAlex down):
  // retryable — show a retry affordance.
  const countsUnreachable = countsDone && !citationsReachable;
  // Sources answered but the papers have no data: fresh papers are not
  // indexed anywhere for days — the sort keeps the feed order, which is
  // the honest state.
  const countsFresh = countsDone && citationsReachable;

  const handleSortChange = (v: string) => {
    setSortMode(v as PaperSortMode);
    // The batch lookup runs after every fetch; re-kick it when the user
    // asks for the most-cited order so slow counts do not look broken.
    if (v === "cited") loadCitations(papers.map((p) => p.id));
  };

  // Auto-aggregator: backfill recent days for the current field so the
  // day list is populated. ensureHistory is concurrency-guarded.
  useEffect(() => {
    void ensureHistory(category);
  }, [category, ensureHistory]);

  // Debounce the search box: typing updates local state immediately, but the
  // store only refreshes 400 ms after the user stops typing. The cleanup
  // clears the pending timer so it can never fire after unmount.
  useEffect(() => {
    const handle = setTimeout(() => setQuery(searchInput), 400);
    return () => clearTimeout(handle);
  }, [searchInput, setQuery]);

  const today = todayStr();
  const backfillActive = progress !== null && progress.category === category;

  // Read the CURRENT day from the store rather than this render's closure,
  // so rapid clicks (double-click, held button) step one day per click
  // instead of all collapsing onto the same day before React re-renders.
  const goPrevDay = () => {
    const current = usePapersStore.getState().date ?? today;
    setDate(addDays(current, -1));
  };

  const goNextDay = () => {
    const current = usePapersStore.getState().date;
    if (!current || current >= today) return;
    setDate(addDays(current, 1));
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The filter row (status, search, saved/refresh, day navigation)
          sits OUTSIDE the scroll container: main's list area scrolls
          below it, so the bar physically cannot move with the scroll —
          no sticky, no z-index, no gap it can float through. */}
      <div className="flex flex-col gap-4 pb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
            {lastUpdated &&
              t("papers.updated", {
                time: new Intl.DateTimeFormat(undefined, {
                  timeStyle: "short",
                }).format(new Date(lastUpdated)),
              })}
          </div>
          {/* Search box with the sort dropdown embedded at its end: the
            user picks Newest or Most cited without leaving the box. */}
          <div className="flex h-9 w-full max-w-md items-center gap-1.5 rounded-md border border-input bg-background px-2.5 transition-colors focus-within:border-ring">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder={t(
                source === "semanticscholar"
                  ? "papers.searchScholarPlaceholder"
                  : "papers.searchPlaceholder",
              )}
              aria-label={t(
                source === "semanticscholar"
                  ? "papers.searchScholarPlaceholder"
                  : "papers.searchPlaceholder",
              )}
              className="h-7 min-w-0 flex-1 border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0"
            />
            {papers.length > 0 && (
              <>
                <div className="h-4 w-px shrink-0 bg-border" />
                <Select value={sortMode} onValueChange={handleSortChange}>
                  <SelectTrigger
                    className="h-7 w-auto shrink-0 gap-1 border-0 bg-transparent p-0 text-xs shadow-none focus:ring-0"
                    aria-label={t("papers.sortBy")}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="newest">{t("papers.sortNewest")}</SelectItem>
                    <SelectItem value="cited">{t("papers.sortCited")}</SelectItem>
                  </SelectContent>
                </Select>
              </>
            )}
          </div>
          {countsPending && (
            <span className="text-[11px] text-muted-foreground">
              {t("papers.citationsLoading")}
            </span>
          )}
          {countsUnreachable && (
            <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
              {t("papers.citationsUnreachable")}
              <button
                type="button"
                onClick={() => loadCitations(papers.map((p) => p.id))}
                className="rounded border border-input px-1.5 py-0.5 text-[11px] text-foreground transition-colors hover:bg-accent"
              >
                {t("papers.citationsRetry")}
              </button>
            </span>
          )}
          {countsFresh && (
            <span className="text-[11px] text-muted-foreground">{t("papers.citationsFresh")}</span>
          )}
          <div className="flex items-center gap-2">
            <Button
              variant={savedOnly ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setSavedOnly((v) => !v)}
              aria-pressed={savedOnly}
            >
              <Bookmark className="size-4" />
              {t("papers.savedOnly")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={loading}>
              <RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} />
              {t("papers.refresh")}
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={goPrevDay}
            aria-label={t("papers.prevDay")}
            className="rtl:rotate-180"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Select
            value={date ?? "latest"}
            onValueChange={(v) => setDate(v === "latest" ? null : v)}
          >
            <SelectTrigger
              className="h-8 w-auto gap-2 text-xs"
              aria-label={t("papers.browseByDay")}
            >
              <CalendarDays className="size-3.5" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="latest">{t("papers.latest")}</SelectItem>
              {digestDays.slice(0, 14).map((d) => (
                <SelectItem key={d} value={d}>
                  {formatDay(d, i18n.language)} ({dayCount(d)})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={goNextDay}
            disabled={!date || date >= today}
            aria-label={t("papers.nextDay")}
            className="rtl:rotate-180"
          >
            <ChevronRight className="size-4" />
          </Button>
          {date && (
            <Button variant="ghost" size="sm" onClick={() => setDate(null)}>
              {t("papers.today")}
            </Button>
          )}
          {backfillActive && (
            <span className="text-xs text-muted-foreground">
              {t("papers.historyLoading", {
                done: progress.done,
                total: progress.total,
              })}
            </span>
          )}
        </div>
      </div>

      {/* Everything below the pinned bar scrolls in its own container.
          pe-2 keeps the paper cards clear of the scrollbar (logical
          edge: left in RTL, right in LTR); pt-1 guarantees a visible
          gap between the bar and the first card even when a strip
          above it (Today's picks) is dismissed. */}
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
                onClick={clearFallbackNote}
                aria-label={t("papers.dismiss")}
              >
                <X className="size-3.5" />
              </Button>
            </div>
          )}

          {/* Today's picks: heuristic strip on the latest view only (hidden
          while browsing a specific day or the saved list). */}
          {!loading &&
            !error &&
            !savedOnly &&
            !date &&
            picks.papers.length > 0 &&
            !picksDismissed && (
              <TodayPicks
                papers={picks.papers}
                date={picks.date}
                onDismiss={dismissPicks}
                onOpen={(p) => {
                  void openReader(p);
                  setView("reader");
                }}
              />
            )}

          {loading && (
            <div className="flex flex-col gap-4" aria-label={t("papers.loading")}>
              {Array.from({ length: 5 }).map((_, i) => (
                <PaperSkeleton key={i} />
              ))}
            </div>
          )}

          {!loading && error === SCHOLAR_SEARCH_REQUIRED && (
            <Card className="border-border">
              <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
                <Search className="size-8 text-muted-foreground" />
                <p className="text-sm font-medium">{t("papers.scholarNeedsQuery")}</p>
              </CardContent>
            </Card>
          )}

          {!loading && error && error !== SCHOLAR_SEARCH_REQUIRED && (
            <Card className="border-destructive/40">
              <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
                <AlertCircle className="size-8 text-destructive" />
                <p className="text-sm font-medium">{t("papers.error")}</p>
                <p className="max-w-md text-xs text-muted-foreground">{error}</p>
                <Button size="sm" variant="outline" onClick={() => void refresh()}>
                  {t("papers.retry")}
                </Button>
              </CardContent>
            </Card>
          )}

          {!loading &&
            !error &&
            savedOnly &&
            (savedIds.length === 0 ? (
              <Card className="border-dashed">
                <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
                  <Bookmark className="size-8 text-muted-foreground" />
                  <p className="text-sm font-medium text-muted-foreground">
                    {t("papers.noFavorites")}
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="flex flex-col gap-4">
                {savedIds.map((id, i) => (
                  <PaperCard key={id} paper={savedBy[id]} index={i} />
                ))}
              </div>
            ))}

          {!loading && !error && !savedOnly && papers.length === 0 && (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
                <BookOpenText className="size-8 text-muted-foreground" />
                <p className="text-sm font-medium text-muted-foreground">
                  {date ? t("papers.noPapersOnDay") : t("papers.empty")}
                </p>
              </CardContent>
            </Card>
          )}

          {!loading && !error && !savedOnly && papers.length > 0 && (
            <div className="flex flex-col gap-4">
              {visiblePapers.map((paper, i) => (
                <PaperCard key={paper.id} paper={paper} index={i} />
              ))}
              {papers.length >= 20 && (
                <Button
                  variant="outline"
                  size="sm"
                  className="self-center"
                  onClick={() => void loadMore()}
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
    </div>
  );
}
