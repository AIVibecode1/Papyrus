import { Bookmark, Clock, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { SearchField } from "@/lib/arxiv";
import type { PaperSortMode } from "@/lib/paper-sort";
import { PapersSearchField } from "@/features/papers/papers-search-field";
import { ToolbarBrowseRow } from "./toolbar-browse-row";
import { yearsLabel } from "./toolbar-helpers";

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
  const { t } = useTranslation();
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

  return (
    <div className="flex flex-col gap-4 pb-4">
      {/* Plan 063: optically centered search. From lg (1024) up: a
          3-column grid with equal 1fr side tracks keeps the search
          dead-center in both directions regardless of side content; the
          action buttons are icon-only (aria-labels + tooltips) because
          the content column is capped at ~1152px (the grid is ~880px
          even maximized at 1920) and text labels would always collide
          with the centered field. Below lg the row is a plain flex: the
          field grows/shrinks to fill, so search and actions share one
          line with zero overlap at every width (the sidebar leaves only
          ~600px of column at 768-1023, too narrow for a centered 448px
          field beside any buttons). The status line is hidden below
          lg. */}
      <div className="flex items-center gap-3 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)_minmax(0,1fr)]">
        <div className="hidden min-w-0 items-center gap-x-3 lg:flex lg:w-full">
          <div className="truncate font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
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
        <div className="w-full min-w-0 justify-self-center lg:max-w-md">
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
        <div className="flex items-center justify-end gap-1 whitespace-nowrap sm:justify-self-end">
          <Button
            variant={savedOnly ? "secondary" : "ghost"}
            size="sm"
            className="px-2"
            onClick={onToggleSavedOnly}
            aria-pressed={savedOnly}
            aria-label={t("papers.savedOnly")}
            title={t("papers.savedOnly")}
          >
            <Bookmark className="size-4" />
            <span className="sr-only">{t("papers.savedOnly")}</span>
          </Button>
          <Button
            variant={historyMode ? "secondary" : "ghost"}
            size="sm"
            className="px-2"
            onClick={onToggleHistory}
            aria-pressed={historyMode}
            aria-label={t("history.title")}
            title={t("history.title")}
          >
            <Clock className="size-4" />
            <span className="sr-only">{t("history.title")}</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="px-2"
            onClick={onRefresh}
            disabled={loading}
            aria-label={t("papers.refresh")}
            title={t("papers.refresh")}
          >
            <RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} />
            <span className="sr-only">{t("papers.refresh")}</span>
          </Button>
        </div>
      </div>

      <ToolbarBrowseRow
        historyMode={historyMode}
        searchActive={searchActive}
        yearFrom={yearFrom}
        yearTo={yearTo}
        onYearRange={onYearRange}
        limitToCategory={limitToCategory}
        onLimitToCategory={onLimitToCategory}
        source={source}
        date={date}
        onPrevDay={onPrevDay}
        onNextDay={onNextDay}
        onSetDate={onSetDate}
        onToday={onToday}
        digestDays={digestDays}
        dayCount={dayCount}
        backfillActive={backfillActive}
        backfillProgress={backfillProgress}
      />
    </div>
  );
}
