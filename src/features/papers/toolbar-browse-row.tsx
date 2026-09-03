import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { todayStr } from "@/stores/digest";
import { activeYearChip, buildYearChips, formatDay } from "./toolbar-helpers";

interface ToolbarBrowseRowProps {
  historyMode: boolean;
  searchActive: boolean;
  yearFrom: number | null;
  yearTo: number | null;
  onYearRange: (from: number | null, to: number | null) => void;
  limitToCategory: boolean;
  onLimitToCategory: (value: boolean) => void;
  source: "arxiv" | "semanticscholar";
  date: string | null;
  onPrevDay: () => void;
  onNextDay: () => void;
  onSetDate: (value: string) => void;
  onToday: () => void;
  digestDays: string[];
  dayCount: (day: string) => number;
  backfillActive: boolean;
  backfillProgress: { done: number; total: number } | null;
}

/**
 * The second toolbar row: history label, search year chips + category
 * scoping, or day navigation. Day navigation is hidden while a query is
 * active (searches ignore dates).
 */
export function ToolbarBrowseRow({
  historyMode,
  searchActive,
  yearFrom,
  yearTo,
  onYearRange,
  limitToCategory,
  onLimitToCategory,
  source,
  date,
  onPrevDay,
  onNextDay,
  onSetDate,
  onToday,
  digestDays,
  dayCount,
  backfillActive,
  backfillProgress,
}: ToolbarBrowseRowProps) {
  const { t, i18n } = useTranslation();
  const today = todayStr();

  if (historyMode) {
    return (
      <span className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
        {t("history.title")}
      </span>
    );
  }

  if (searchActive) {
    const yearChips = buildYearChips(t);
    const activeChip = activeYearChip(yearChips, yearFrom, yearTo);
    return (
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
    );
  }

  return (
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
  );
}
