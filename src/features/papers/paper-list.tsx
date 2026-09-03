import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { pickPapers } from "@/lib/picks";
import { sortPapers, type PaperSortMode } from "@/lib/paper-sort";
import type { Paper } from "@/lib/types";
import { useFavoritesStore } from "@/stores/favorites";
import { usePapersStore } from "@/stores/papers";
import { useDigestStore, addDays, todayStr } from "@/stores/digest";
import { useReaderStore } from "@/stores/reader";
import { useUiStore } from "@/stores/ui";
import { PapersToolbar } from "@/features/papers/papers-toolbar";
import { PaperListContent } from "@/features/papers/paper-list-content";

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
      <PaperListContent
        loading={loading}
        error={error}
        fallbackNote={!!fallbackNote}
        onDismissFallback={clearFallbackNote}
        savedOnly={savedOnly}
        historyMode={historyMode}
        date={date}
        queryTrim={query.trim()}
        showContinue={!loading && !error && !savedOnly && !historyMode && !date && !query.trim()}
        showPicks={
          !loading &&
          !error &&
          !savedOnly &&
          !historyMode &&
          !date &&
          picks.papers.length > 0 &&
          !picksDismissed
        }
        picks={picks}
        onDismissPicks={dismissPicks}
        onOpenPaper={(p: Paper) => {
          void openReader(p);
          setView("reader");
        }}
        savedPapers={savedIds.map((id) => savedBy[id])}
        visiblePapers={visiblePapers}
        showLoadMore={papers.length >= 20}
        loadingMore={loadingMore}
        onLoadMore={() => void loadMore()}
        onRetry={() => void refresh()}
        onClearSearch={() => {
          setSearchInput("");
          clearSearch();
        }}
      />
    </div>
  );
}
