// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PapersSearchField } from "@/features/papers/papers-search-field";

// Radix Select scrolls the highlighted option into view on open.
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

const baseProps = {
  value: "",
  onChange: vi.fn(),
  placeholder: "Search arXiv…",
  ariaLabel: "Search arXiv…",
  field: "all" as const,
  onFieldChange: vi.fn(),
  sortVisible: false,
  sortMode: "newest" as const,
  onSortChange: vi.fn(),
};

describe("PapersSearchField", () => {
  it("renders the clear button only when the query is non-empty", () => {
    const onClear = vi.fn();
    const { rerender } = render(<PapersSearchField {...baseProps} onClear={onClear} />);
    expect(screen.queryByRole("button", { name: "Clear search" })).not.toBeInTheDocument();

    rerender(<PapersSearchField {...baseProps} value="transformer" onClear={onClear} />);
    expect(screen.getByRole("button", { name: "Clear search" })).toBeInTheDocument();
  });

  it("clears via the X button", () => {
    const onClear = vi.fn();
    render(<PapersSearchField {...baseProps} value="transformer" onClear={onClear} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("clears via Escape while focused", () => {
    const onClear = vi.fn();
    render(<PapersSearchField {...baseProps} value="transformer" onClear={onClear} />);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("disables the WebView2 native autofill dropdown (v1.1.8)", () => {
    render(<PapersSearchField {...baseProps} />);
    expect(screen.getByRole("textbox")).toHaveAttribute("autocomplete", "off");
  });

  it("does not clear on Escape when the field is empty", () => {
    const onClear = vi.fn();
    render(<PapersSearchField {...baseProps} onClear={onClear} />);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(onClear).not.toHaveBeenCalled();
  });

  it("reports field-mode changes to the parent", () => {
    const onFieldChange = vi.fn();
    render(<PapersSearchField {...baseProps} onFieldChange={onFieldChange} />);
    fireEvent.click(screen.getByRole("combobox", { name: "Search in" }));
    fireEvent.click(screen.getByRole("option", { name: "Title" }));
    expect(onFieldChange).toHaveBeenCalledWith("title");
  });

  it("keeps directional chrome logical (no physical edge classes)", () => {
    const { container } = render(
      <div dir="rtl">
        <PapersSearchField {...baseProps} value="transformer" onClear={vi.fn()} />
      </div>,
    );
    // The search icon, field select and clear button must not be pinned
    // with physical left/right utilities, or RTL mirroring would break.
    const html = container.innerHTML;
    expect(html).not.toMatch(/\b(left|right)-/);
    expect(html).not.toMatch(/\b(ml|mr|pl|pr)-/);
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("carries no muddy dark fill on the input or dropdown triggers (plan 051)", () => {
    const { container } = render(
      <PapersSearchField {...baseProps} value="transformer" onClear={vi.fn()} sortVisible />,
    );
    const html = container.innerHTML;
    // The base Input/SelectTrigger ship dark:bg-input/30; the search
    // chrome must override it in BOTH themes or dark mode shows a gray
    // slab under the typed text and the dropdown value.
    expect(html).not.toContain("dark:bg-input/30");
    expect(html).toContain("dark:bg-transparent");
    // The control group itself is one bordered surface, no nested fill.
    expect(html).not.toContain("bg-muted");
  });
});
