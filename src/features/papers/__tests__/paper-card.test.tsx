// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PaperCard } from "@/features/papers/paper-card";
import type { Paper, ProviderConfig } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  toggle: vi.fn(),
  isFavorite: vi.fn(() => false),
  openReader: vi.fn(),
  setView: vi.fn(),
  toggleExpand: vi.fn(),
  start: vi.fn(),
  isExpanded: vi.fn(() => false),
  providers: [] as ProviderConfig[],
  activeProviderId: null as string | null,
  citationCount: undefined as number | undefined,
}));

vi.mock("@/stores/favorites", () => ({
  useFavoritesStore: (sel: (s: unknown) => unknown) =>
    sel({ isFavorite: mocks.isFavorite, toggle: mocks.toggle }),
}));
vi.mock("@/stores/reader", () => ({
  useReaderStore: (sel: (s: unknown) => unknown) => sel({ open: mocks.openReader }),
}));
vi.mock("@/stores/ui", () => ({
  useUiStore: (sel: (s: unknown) => unknown) => sel({ setView: mocks.setView }),
}));
vi.mock("@/stores/explanation", () => ({
  useExplanationStore: (sel: (s: unknown) => unknown) =>
    sel({
      expandedId: mocks.isExpanded() ? "p1" : null,
      toggle: mocks.toggleExpand,
      start: mocks.start,
    }),
}));
vi.mock("@/stores/papers", () => ({
  usePapersStore: (sel: (s: unknown) => unknown) => sel({ citations: { p1: mocks.citationCount } }),
}));
vi.mock("@/stores/settings", () => ({
  // PaperCard destructures the whole store; other stores are selector-based.
  useSettingsStore: (sel?: (s: unknown) => unknown) =>
    sel
      ? sel({ providers: mocks.providers, activeProviderId: mocks.activeProviderId })
      : { providers: mocks.providers, activeProviderId: mocks.activeProviderId },
}));
vi.mock("@/features/papers/explain-panel", () => ({
  ExplainPanel: () => <div data-testid="explain-panel" />,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const arxivPaper: Paper = {
  id: "2607.00001v1",
  title: "Encoders are all you need",
  authors: ["A. Author"],
  published: "2026-07-30",
  summary: "A real abstract.",
  pdfUrl: "https://arxiv.org/pdf/2607.00001v1",
  categories: ["cs.AI"],
};

const scholarPaper: Paper = {
  ...arxivPaper,
  id: "s2:abc123",
  title: "Attention sinks explained",
  summary: "",
  tldr: "A model-generated one-liner.",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isFavorite.mockReturnValue(false);
  mocks.isExpanded.mockReturnValue(false);
  mocks.providers = [];
  mocks.citationCount = undefined;
});

describe("paper card", () => {
  it("keeps all actions available with Read as the primary action", () => {
    render(<PaperCard paper={arxivPaper} />);
    const read = screen.getByRole("button", { name: "Read" });
    const explain = screen.getByRole("button", { name: "Explain" });
    const openPdf = screen.getByRole("link", { name: "Open PDF" });
    const save = screen.getByRole("button", { name: "Save" });
    expect(read).toBeInTheDocument();
    expect(explain).toBeInTheDocument();
    expect(openPdf).toBeInTheDocument();
    expect(save).toBeInTheDocument();
    // Hierarchy: Read is the default (primary) variant, Explain is
    // outline, Open PDF is a plain ghost link.
    expect(read.className).toContain("bg-primary");
    expect(explain.className).toContain("shadow-xs");
    expect(openPdf.className).not.toContain("bg-primary");
    expect(openPdf.className).not.toContain("shadow-xs");
  });

  it("Read opens the in-app reader", () => {
    render(<PaperCard paper={arxivPaper} />);
    fireEvent.click(screen.getByRole("button", { name: "Read" }));
    expect(mocks.openReader).toHaveBeenCalledWith(arxivPaper);
    expect(mocks.setView).toHaveBeenCalledWith("reader");
  });

  it("labels the arXiv source with a direction-safe chip", () => {
    render(<PaperCard paper={arxivPaper} />);
    expect(screen.getByText("arXiv")).toHaveAttribute("dir", "ltr");
  });

  it("labels the Scholar source and flags a TLDR-only summary", () => {
    render(<PaperCard paper={scholarPaper} />);
    expect(screen.getByText("Scholar")).toBeInTheDocument();
    expect(screen.getByText("TLDR")).toBeInTheDocument();
  });

  it("shows no TLDR badge when the abstract is present", () => {
    render(<PaperCard paper={arxivPaper} />);
    expect(screen.queryByText("TLDR")).not.toBeInTheDocument();
  });

  it("explain is disabled without a provider and explains the difference in the tooltip", () => {
    render(<PaperCard paper={arxivPaper} />);
    expect(screen.getByRole("button", { name: "Explain" })).toBeDisabled();
  });
});
