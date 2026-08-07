import { AlertCircle, Bookmark, BookOpenText, Loader2, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StatePanel } from "@/components/ui/state-panel";
import { pickPapers } from "@/lib/picks";
import { sortPapers, type PaperSortMode } from "@/lib/paper-sort";
import { useFavoritesStore } from "@/stores/favorites";
import { usePapersStore, SCHOLAR_SEARCH_REQUIRED } from "@/stores/papers";
import { useDigestStore, addDays, todayStr } from "@/stores/digest";
import { useReaderStore } from "@/stores/reader";
import { useUiStore } from "@/stores/ui";
import { PaperCard } from "@/features/papers/paper-card";
import { ContinueReading } from "@/features/papers/continue-reading";
import { PapersToolbar } from "@/features/papers/papers-toolbar";
import { VirtualList } from "@/features/papers/virtual-paper-list";
import { HistoryList } from "@/features/papers/history-list";
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

export function PaperList() {
  const { t } = useTranslation();
  const { papers, loading, error, refresh, lastUpdated, fallbackNote, clearFallbackNote, query } =
    usePapersStore();
  const category = usePapersStore((s) => s.category);
  const source = usePapersStore((s) => s.source);
  const date = usePapersStore((s) => s.date);
  const setDate = usePapersStore((s) => s.setDate);
  const setQuery = usePapersStore((s) => s.setQuery);
  const clearSearch = usePapersStore((s) => s.clearSearch);
  const searchField = usePapersStore((s) => s.searchField);
  const setSearchField = usePapersStore((s) => s.setSearchField);
  const yearFrom = usePapersStore((s) => s.yearFrom);
  const yearTo = usePapersStore((s) => s.yearTo);
  const setYearRange = usePapersStore((s) => s.setYearRange);
  const limitToCategory = usePapersStore((s) => s.limitToCategory);
  const setLimitToCategory = usePapersStore((s) => s.setLimitToCategory);
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
  // Plan 060: History mode swaps the list for the automatic reading
  // history (independent of the Saved toggle; both are list filters).
  const [historyMode, setHistoryMode] = useState(false);
  // Seed the input from the store so external prefills (e.g. the reader's
  // "Search this title" action) are visible in the box; the effect below
  // keeps them in sync without fighting the debounce.
  const [searchInput, setSearchInput] = useState(() => usePapersStore.getState().query);
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

  // One-way store -> input sync for external prefills (search-this-title,
  // future deep links). Safe with the debounce: the store only changes
  // after the debounce has already applied the same text.
  useEffect(() => {
    setSearchInput(query);
  }, [query]);

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
      <PapersToolbar
        lastUpdated={lastUpdated}
        query={query}
        searchValue={searchInput}
        onSearchChange={setSearchInput}
        onClearSearch={() => {
          setSearchInput("");
          clearSearch();
        }}
        searchPlaceholder={t(
          source === "semanticscholar"
            ? "papers.searchScholarPlaceholder"
            : "papers.searchPlaceholder",
        )}
        searchField={searchField}
        onFieldChange={setSearchField}
        yearFrom={yearFrom}
        yearTo={yearTo}
        onYearRange={setYearRange}
        limitToCategory={limitToCategory}
        onLimitToCategory={setLimitToCategory}
        source={source}
        sortVisible={papers.length > 0}
        sortMode={sortMode}
        onSortChange={handleSortChange}
        countsPending={countsPending}
        countsUnreachable={countsUnreachable}
        countsFresh={countsFresh}
        onRetryCitations={() => loadCitations(papers.map((p) => p.id))}
        savedOnly={savedOnly}
        onToggleSavedOnly={() => setSavedOnly((v) => !v)}
        historyMode={historyMode}
        onToggleHistory={() => setHistoryMode((v) => !v)}
        onRefresh={() => void refresh()}
        loading={loading}
        date={date}
        onPrevDay={goPrevDay}
        onNextDay={goNextDay}
        onSetDate={(v) => setDate(v === "latest" ? null : v)}
        onToday={() => setDate(null)}
        digestDays={digestDays}
        dayCount={dayCount}
        backfillActive={backfillActive}
        backfillProgress={progress}
      />

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

          {/* Plan 073: Continue-reading strip on the main feed (hidden
          while browsing saved / history / search / day views). */}
          {!loading && !error && !savedOnly && !historyMode && !date && !query.trim() && (
            <ContinueReading />
          )}

          {/* Today's picks: heuristic strip on the latest view only (hidden
          while browsing a specific day or the saved list). */}
          {!loading &&
            !error &&
            !savedOnly &&
            !historyMode &&
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
                <Button size="sm" variant="outline" onClick={() => void refresh()}>
                  {t("papers.retry")}
                </Button>
              }
            />
          )}

          {!historyMode &&
            !loading &&
            !error &&
            savedOnly &&
            (savedIds.length === 0 ? (
              <StatePanel
                icon={<Bookmark className="size-8" />}
                title={t("papers.noFavorites")}
                muted
              />
            ) : (
              <div className="flex flex-col gap-4">
                <VirtualList
                  items={savedIds.map((id) => savedBy[id])}
                  estimateSize={320}
                  ariaLabel={t("papers.savedList")}
                  renderItem={(p, i) => <PaperCard paper={p} index={i} />}
                />
              </div>
            ))}

          {!historyMode && !loading && !error && !savedOnly && papers.length === 0 && (
            <StatePanel
              icon={
                query.trim() ? <Search className="size-8" /> : <BookOpenText className="size-8" />
              }
              title={
                query.trim()
                  ? t("papers.noSearchResults", { query: query.trim() })
                  : date
                    ? t("papers.noPapersOnDay")
                    : t("papers.empty")
              }
              muted
              action={
                query.trim() ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setSearchInput("");
                      clearSearch();
                    }}
                  >
                    {t("papers.clearSearch")}
                  </Button>
                ) : undefined
              }
            />
          )}

          {!historyMode && !loading && !error && !savedOnly && papers.length > 0 && (
            <div className="flex flex-col gap-4">
              <VirtualList
                items={visiblePapers}
                estimateSize={320}
                ariaLabel={t("papers.paperList")}
                renderItem={(p, i) => <PaperCard paper={p} index={i} />}
              />
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
