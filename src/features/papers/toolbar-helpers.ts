import type { TFunction } from "i18next";
import { formatCalendarDay } from "@/lib/dates";

export function formatDay(date: string, language: string): string {
  return formatCalendarDay(date, language, { month: "short", day: "numeric" });
}

/** Inclusive years label for the status line (e.g. "2010–2016"). */
export function yearsLabel(yearFrom: number | null, yearTo: number | null): string {
  if (yearFrom != null && yearTo != null) return `${yearFrom}–${yearTo}`;
  if (yearFrom != null) return `${yearFrom}–`;
  if (yearTo != null) return `–${yearTo}`;
  return "";
}

export interface YearChip {
  key: string;
  label: string;
  from: number | null;
  to: number | null;
}

/** The four search year chips; the current year anchors "Last 5 years". */
export function buildYearChips(t: TFunction): YearChip[] {
  const currentYear = new Date().getFullYear();
  return [
    { key: "any", label: t("papers.yearAny"), from: null, to: null },
    { key: "last5", label: t("papers.yearLast5"), from: currentYear - 5, to: currentYear },
    { key: "2010-2016", label: t("papers.yearRange2010_2016"), from: 2010, to: 2016 },
    { key: "before2010", label: t("papers.yearBefore2010"), from: null, to: 2009 },
  ];
}

export function activeYearChip(
  chips: YearChip[],
  yearFrom: number | null,
  yearTo: number | null,
): string | undefined {
  return chips.find((c) => c.from === yearFrom && c.to === yearTo)?.key;
}
