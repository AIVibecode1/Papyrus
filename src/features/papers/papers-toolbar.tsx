import { Bookmark, CalendarDays, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatUiDate } from "@/lib/dates";
import type { PaperSortMode } from "@/lib/paper-sort";
import { todayStr } from "@/stores/digest";
import { PapersSearchField } from "@/features/papers/papers-search-field";

interface PapersToolbarProps {
  lastUpdated: number | null;
  searchValue: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder: string;
  sortVisible: boolean;
  sortMode: PaperSortMode;
  onSortChange: (value: string) => void;
  countsPending: boolean;
  countsUnreachable: boolean;
  countsFresh: boolean;
  onRetryCitations: () => void;
  savedOnly: boolean;
  onToggleSavedOnly: () => void;
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

/**
 * The papers filter row (status line, search box, saved/refresh actions,
 * day navigation). Sits OUTSIDE the scroll container by construction:
 * PaperList renders it as a static sibling above the list's own
 * overflow-y-auto div, so the bar physically cannot move with the scroll
 * (no sticky, no z-index).
 */
export function PapersToolbar({
  lastUpdated,
  searchValue,
  onSearchChange,
  searchPlaceholder,
  sortVisible,
  sortMode,
  onSortChange,
  countsPending,
  countsUnreachable,
  countsFresh,
  onRetryCitations,
  savedOnly,
  onToggleSavedOnly,
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

  return (
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
        <PapersSearchField
          value={searchValue}
          onChange={onSearchChange}
          placeholder={searchPlaceholder}
          ariaLabel={searchPlaceholder}
          sortVisible={sortVisible}
          sortMode={sortMode}
          onSortChange={onSortChange}
        />
        {countsPending && (
          <span className="text-[11px] text-muted-foreground">{t("papers.citationsLoading")}</span>
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
        <div className="flex items-center gap-2">
          <Button
            variant={savedOnly ? "secondary" : "ghost"}
            size="sm"
            onClick={onToggleSavedOnly}
            aria-pressed={savedOnly}
          >
            <Bookmark className="size-4" />
            {t("papers.savedOnly")}
          </Button>
          <Button variant="ghost" size="sm" onClick={onRefresh} disabled={loading}>
            <RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} />
            {t("papers.refresh")}
          </Button>
        </div>
      </div>

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
    </div>
  );
}
