// @vitest-environment jsdom
// Plan 075: windowed rendering. A long list must not mount every row.
import "@testing-library/jest-dom/vitest";
import "@/i18n";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { VirtualList } from "@/features/papers/virtual-paper-list";

const items = Array.from({ length: 60 }, (_, i) => ({ id: `p${i}`, title: `Paper ${i}` }));

describe("VirtualList", () => {
  it("renders only the visible window, not all rows (plan 075)", () => {
    render(
      <VirtualList
        items={items}
        estimateSize={120}
        ariaLabel="Papers"
        renderItem={(item) => <div>{item.title}</div>}
      />,
    );

    const rows = screen.getAllByRole("listitem");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(60);
    // The first row is in the initial window.
    expect(screen.getByText("Paper 0")).toBeInTheDocument();
    // The last row is not mounted.
    expect(screen.queryByText("Paper 59")).not.toBeInTheDocument();
  });

  it("pads the spacer so scrolling reaches the end", () => {
    render(
      <VirtualList
        items={items}
        estimateSize={120}
        ariaLabel="Papers"
        renderItem={(item) => <div>{item.title}</div>}
      />,
    );

    const spacer = screen.getByRole("list").firstElementChild as HTMLElement;
    const top = parseInt(spacer.style.paddingTop, 10);
    const bottom = parseInt(spacer.style.paddingBottom, 10);
    // Padding + the rendered window's estimated height span the full list.
    const rows = screen.getAllByRole("listitem").length;
    expect(top + bottom + rows * 120).toBe(60 * 120);
    expect(bottom).toBeGreaterThan(0);
  });
});
