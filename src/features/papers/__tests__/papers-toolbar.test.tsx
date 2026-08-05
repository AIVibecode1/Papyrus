// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PapersToolbar } from "@/features/papers/papers-toolbar";

const baseProps = {
  lastUpdated: 1785600000000,
  query: "",
  searchValue: "",
  onSearchChange: vi.fn(),
  onClearSearch: vi.fn(),
  searchPlaceholder: "Search arXiv…",
  searchField: "all" as const,
  onFieldChange: vi.fn(),
  yearFrom: null,
  yearTo: null,
  onYearRange: vi.fn(),
  limitToCategory: false,
  onLimitToCategory: vi.fn(),
  historyMode: false,
  onToggleHistory: vi.fn(),
  source: "arxiv" as const,
  sortVisible: false,
  sortMode: "newest" as const,
  onSortChange: vi.fn(),
  countsPending: false,
  countsUnreachable: false,
  countsFresh: false,
  onRetryCitations: vi.fn(),
  savedOnly: false,
  onToggleSavedOnly: vi.fn(),
  onRefresh: vi.fn(),
  loading: false,
  date: null,
  onPrevDay: vi.fn(),
  onNextDay: vi.fn(),
  onSetDate: vi.fn(),
  onToday: vi.fn(),
  digestDays: [],
  dayCount: () => 0,
  backfillActive: false,
  backfillProgress: null,
};

describe("PapersToolbar search chrome", () => {
  it("shows the search status with the query and field while searching", () => {
    render(
      <PapersToolbar
        {...baseProps}
        query="attention"
        searchValue="attention"
        searchField="title"
      />,
    );
    expect(screen.getByText(/Best matches for “attention” · Title/)).toBeInTheDocument();
  });

  it("appends the limit-on suffix to the status while the category limit is active", () => {
    render(
      <PapersToolbar
        {...baseProps}
        query="attention"
        searchValue="attention"
        searchField="title"
        limitToCategory={true}
      />,
    );
    expect(
      screen.getByText(/Best matches for “attention” · Title · limited to current field/),
    ).toBeInTheDocument();
  });

  it("hides day navigation and shows year chips while a query is active", () => {
    const { rerender } = render(<PapersToolbar {...baseProps} />);
    expect(screen.getByRole("button", { name: "Previous day" })).toBeInTheDocument();

    rerender(<PapersToolbar {...baseProps} query="attention" searchValue="attention" />);
    expect(screen.queryByRole("button", { name: "Previous day" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Any time" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Last 5 years" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Before 2010" })).toBeInTheDocument();
  });

  it("applies the year range from a chip click", () => {
    const onYearRange = vi.fn();
    render(
      <PapersToolbar
        {...baseProps}
        query="attention"
        searchValue="attention"
        onYearRange={onYearRange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Before 2010" }));
    expect(onYearRange).toHaveBeenCalledWith(null, 2009);
    fireEvent.click(screen.getByRole("button", { name: "Any time" }));
    expect(onYearRange).toHaveBeenCalledWith(null, null);
  });

  it("shows the category-scoping checkbox only for arXiv", () => {
    const { rerender } = render(
      <PapersToolbar {...baseProps} query="attention" searchValue="attention" />,
    );
    const checkbox = screen.getByRole("checkbox", { name: "Limit to current field" });
    // Default is off (plan 050): the checkbox is a deliberate opt-in.
    expect(checkbox).not.toBeChecked();

    rerender(
      <PapersToolbar
        {...baseProps}
        query="attention"
        searchValue="attention"
        source="semanticscholar"
      />,
    );
    // S2 has its own relevance ranking; the scoping checkbox is off.
    expect(screen.getByRole("checkbox", { name: "Limit to current field" })).not.toBeChecked();
  });

  it("renders the feed status (updated time) when not searching", () => {
    render(<PapersToolbar {...baseProps} />);
    expect(screen.getByText(/Updated/)).toBeInTheDocument();
  });
});
