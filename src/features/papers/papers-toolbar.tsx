import { Bookmark, CalendarDays, ChevronLeft, ChevronRight, Clock, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { SearchField } from "@/lib/arxiv";
import { formatUiDate } from "@/lib/dates";
import type { PaperSortMode } from "@/lib/paper-sort";
import { todayStr } from "@/stores/digest";
import { PapersSearchField } from "@/features/papers/papers-search-field";

interface PapersToolbarProps {
  lastUpdated: number | null;
  /** The committed store query (debounced); drives the search state. */
  query: string;
  /** The raw input value; drives the field itself. */
  searchValue: string;
  onSearchChange: (value: string) => void;
  onClearSearch: () => void;
  searchPlaceholder: string;
  searchField: SearchField;
  onFieldChange: (field: SearchField) => void;
  yearFrom: number | null;
  yearTo: number | null;
  onYearRange: (from: number | null, to: number | null) => void;
  limitToCategory: boolean;
  onLimitToCategory: (value: boolean) => void;
  source: "arxiv" | "semanticscholar";
  sortVisible: boolean;
  sortMode: PaperSortMode;
  onSortChange: (value: string) => void;
  countsPending: boolean;
  countsUnreachable: boolean;
  countsFresh: boolean;
  onRetryCitations: () => void;
  savedOnly: boolean;
  onToggleSavedOnly: () => void;
  /** Plan 060: History mode shows the automatic reading-history list. */
  historyMode: boolean;
  onToggleHistory: () => void;
  onRefresh: () => void;
  loading: boolean;
  /** YYYY-MM-DD of the browsed day, or null for the latest papers. */
  date: string | null;
  onPrevDay: () => void;
  onNextDay: () => void;
  onSetDate: (value: string) => void;
  onToday: () => void;
  digestDays: string[];
  dayCount: (day: string) => number;
  /** True while the digest auto-aggregator is backfilling this field. */
  backfillActive: boolean;
  backfillProgress: { done: number; total: number } | null;
}

function formatDay(date: string, language: string): string {
  return formatUiDate(`${date}T00:00:00Z`, language, { month: "short", day: "numeric" });
}

/** Inclusive years label for the status line (e.g. "2010–2016"). */
function yearsLabel(yearFrom: number | null, yearTo: number | null): string {
  if (yearFrom != null && yearTo != null) return `${yearFrom}–${yearTo}`;
  if (yearFrom != null) return `${yearFrom}–`;
  if (yearTo != null) return `–${yearTo}`;
  return "";
}

/**
 * The papers filter row (status line, search box, saved/refresh actions,
 * day navigation / search year chips). Sits OUTSIDE the scroll container
 * by construction: PaperList renders it as a static sibling above the
 * list's own overflow-y-auto div, so the bar physically cannot move with
 * the scroll (no sticky, no z-index).
 */
export function PapersToolbar({
  lastUpdated,
  query,
  searchValue,
  onSearchChange,
  onClearSearch,
  searchPlaceholder,
  searchField,
  onFieldChange,
  yearFrom,
  yearTo,
  onYearRange,
  limitToCategory,
  onLimitToCategory,
  source,
  sortVisible,
  sortMode,
  onSortChange,
  countsPending,
  countsUnreachable,
  countsFresh,
  onRetryCitations,
  savedOnly,
  onToggleSavedOnly,
  historyMode,
  onToggleHistory,
  onRefresh,
  loading,
  date,
  onPrevDay,
  onNextDay,
  onSetDate,
  onToday,
  digestDays,
  dayCount,
  backfillActive,
  backfillProgress,
}: PapersToolbarProps) {
  const { t, i18n } = useTranslation();
  const today = todayStr();
  const searchActive = query.trim().length > 0;
  const fieldKey =
    searchField === "title"
      ? "papers.fieldTitle"
      : searchField === "author"
        ? "papers.fieldAuthor"
        : searchField === "abstract"
          ? "papers.fieldAbstract"
          : searchField === "id"
            ? "papers.fieldId"
            : "papers.fieldAll";
  const years = yearsLabel(yearFrom, yearTo);
  const currentYear = new Date().getFullYear();

  const yearChips: Array<{
    key: string;
    label: string;
    from: number | null;
    to: number | null;
  }> = [
    { key: "any", label: t("papers.yearAny"), from: null, to: null },
    { key: "last5", label: t("papers.yearLast5"), from: currentYear - 5, to: currentYear },
    { key: "2010-2016", label: t("papers.yearRange2010_2016"), from: 2010, to: 2016 },
    { key: "before2010", label: t("papers.yearBefore2010"), from: null, to: 2009 },
  ];
  const activeChip = yearChips.find((c) => c.from === yearFrom && c.to === yearTo)?.key;

  return (
    <div className="flex flex-col gap-4 pb-4">
      {/* Plan 063: direction-aware 3-column grid. The middle track is a
          fixed max (28rem = max-w-md) so the search field keeps its size,
          and the two 1fr side tracks stay equal, which keeps the search
          optically centered in BOTH directions (RTL included) no matter
          how long the status or actions are. Narrow windows stack. */}
      <div className="grid grid-cols-1 items-center gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,28rem)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 sm:justify-self-start">
          <div className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
            {searchActive
              ? years
                ? t("papers.searchStatusYears", {
                    query,
                    field: t(fieldKey),
                    years,
                  }) + (limitToCategory ? t("papers.searchStatusLimitOn") : "")
                : t("papers.searchStatus", { query, field: t(fieldKey) }) +
                  (limitToCategory ? t("papers.searchStatusLimitOn") : "")
              : lastUpdated &&
                t("papers.updated", {
                  time: new Intl.DateTimeFormat(undefined, {
                    timeStyle: "short",
                  }).format(new Date(lastUpdated)),
                })}
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
                onClick={onRetryCitations}
                className="rounded border border-input px-1.5 py-0.5 text-[11px] text-foreground transition-colors hover:bg-accent"
              >
                {t("papers.citationsRetry")}
              </button>
            </span>
          )}
          {countsFresh && (
            <span className="text-[11px] text-muted-foreground">{t("papers.citationsFresh")}</span>
          )}
        </div>
        {/* Search box with the field-mode select at its start and the sort
          dropdown embedded at its end: the user picks All/Title/Author/
          Abstract/ID and Newest/Most cited without leaving the box. The
          parent owns the max width; the field just fills it. */}
        <div className="w-full justify-self-center">
          <PapersSearchField
            value={searchValue}
            onChange={onSearchChange}
            onClear={onClearSearch}
            placeholder={searchPlaceholder}
            ariaLabel={searchPlaceholder}
            field={searchField}
            onFieldChange={onFieldChange}
            sortVisible={sortVisible}
            sortMode={sortMode}
            onSortChange={onSortChange}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:justify-self-end">
          <Button
            variant={savedOnly ? "secondary" : "ghost"}
            size="sm"
            onClick={onToggleSavedOnly}
            aria-pressed={savedOnly}
          >
            <Bookmark className="size-4" />
            {t("papers.savedOnly")}
          </Button>
          <Button
            variant={historyMode ? "secondary" : "ghost"}
            size="sm"
            onClick={onToggleHistory}
            aria-pressed={historyMode}
          >
            <Clock className="size-4" />
            {t("history.title")}
          </Button>
          <Button variant="ghost" size="sm" onClick={onRefresh} disabled={loading}>
            <RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} />
            {t("papers.refresh")}
          </Button>
        </div>
      </div>

      {historyMode ? (
        <span className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
          {t("history.title")}
        </span>
      ) : searchActive ? (
        /* Search chrome: year chips + category scoping. Day navigation is
           hidden while a query is active (searches ignore dates). */
        <div className="flex flex-wrap items-center gap-2">
          {yearChips.map((chip) => (
            <Button
              key={chip.key}
              variant={activeChip === chip.key ? "secondary" : "ghost"}
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={() => onYearRange(chip.from, chip.to)}
              aria-pressed={activeChip === chip.key}
            >
              {chip.label}
            </Button>
          ))}
          <label className="ms-2 flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={limitToCategory && source === "arxiv"}
              onChange={(e) => onLimitToCategory(e.target.checked)}
              className="size-3.5 accent-primary"
            />
            {t("papers.limitToCategory")}
          </label>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onPrevDay}
            aria-label={t("papers.prevDay")}
            className="rtl:rotate-180"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Select value={date ?? "latest"} onValueChange={onSetDate}>
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
            onClick={onNextDay}
            disabled={!date || date >= today}
            aria-label={t("papers.nextDay")}
            className="rtl:rotate-180"
          >
            <ChevronRight className="size-4" />
          </Button>
          {date && (
            <Button variant="ghost" size="sm" onClick={onToday}>
              {t("papers.today")}
            </Button>
          )}
          {backfillActive && backfillProgress && (
            <span className="text-xs text-muted-foreground">
              {t("papers.historyLoading", {
                done: backfillProgress.done,
                total: backfillProgress.total,
              })}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
