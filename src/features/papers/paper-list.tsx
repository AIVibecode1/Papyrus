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
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useFavoritesStore } from "@/stores/favorites";
import { usePapersStore, SCHOLAR_SEARCH_REQUIRED } from "@/stores/papers";
import { useDigestStore, addDays, todayStr } from "@/stores/digest";
import { PaperCard } from "@/features/papers/paper-card";

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
  return new Intl.DateTimeFormat(language, { month: "short", day: "numeric" }).format(
    new Date(`${date}T00:00:00Z`),
  );
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
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
          {lastUpdated &&
            t("papers.updated", {
              time: new Intl.DateTimeFormat(undefined, {
                timeStyle: "short",
              }).format(new Date(lastUpdated)),
            })}
        </div>
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
          className="h-9 w-full max-w-xs"
        />
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
        <Select value={date ?? "latest"} onValueChange={(v) => setDate(v === "latest" ? null : v)}>
          <SelectTrigger className="h-8 w-auto gap-2 text-xs" aria-label={t("papers.browseByDay")}>
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

      {!loading && fallbackNote && (
        <div
          role="status"
          className="flex items-start justify-between gap-3 rounded-md border border-amber-300/60 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-200"
        >
          <span className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
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

      {loading && (
        <div className="flex flex-col gap-4" aria-label={t("papers.loading")}>
          {Array.from({ length: 5 }).map((_, i) => (
            <PaperSkeleton key={i} />
          ))}
        </div>
      )}

      {!loading && error === SCHOLAR_SEARCH_REQUIRED && (
        <Card className="border-amber-300/60 dark:border-amber-500/30">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <Search className="size-8 text-amber-600 dark:text-amber-400" />
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
              <p className="text-sm font-medium text-muted-foreground">{t("papers.noFavorites")}</p>
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
          {papers.map((paper, i) => (
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
  );
}
