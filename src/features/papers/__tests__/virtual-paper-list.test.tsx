// @vitest-environment jsdom
// Plan 075: windowed rendering. A long list must not mount every row.
import "@testing-library/jest-dom/vitest";
import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
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

  it("advances the window when a scrollable ancestor scrolls (regression)", () => {
    // The papers shell scrolls PaperList's own wrapper, NOT #main-content:
    // the window must track the real scroll container.
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    Object.defineProperty(scroller, "scrollHeight", { value: 60 * 120, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 400, configurable: true });
    document.body.appendChild(scroller);

    render(
      <VirtualList
        items={items}
        estimateSize={120}
        ariaLabel="Papers"
        renderItem={(item) => <div>{item.title}</div>}
      />,
      { container: scroller },
    );
    expect(screen.queryByText("Paper 30")).not.toBeInTheDocument();

    scroller.scrollTop = 30 * 120; // middle of the list
    fireEvent.scroll(scroller);
    expect(screen.getByText("Paper 30")).toBeInTheDocument();

    scroller.remove();
  });

  it("recomputes the window when the item list changes (regression)", () => {
    // A list that grows while mounted — "Load more" on the feed, or a
    // category switch to a field with more papers — must re-derive its
    // window. The scroll-binding effect keys on items.length, so it
    // re-runs and re-measures on a growth; this guards that the spacer
    // then accounts for the LONGER list. If the effect ever stopped
    // re-running, the bottom pad would stay sized for the old list and the
    // scrollbar would stop short of the newly loaded papers.
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    Object.defineProperty(scroller, "scrollHeight", { value: 60 * 120, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 400, configurable: true });
    document.body.appendChild(scroller);

    const first = Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, title: `Paper ${i}` }));
    const { rerender } = render(
      <VirtualList
        items={first}
        estimateSize={120}
        ariaLabel="Papers"
        renderItem={(item) => <div>{item.title}</div>}
      />,
      { container: scroller },
    );

    // 40 more papers arrive (Load more).
    const grown = Array.from({ length: 60 }, (_, i) => ({ id: `p${i}`, title: `Paper ${i}` }));
    rerender(
      <VirtualList
        items={grown}
        estimateSize={120}
        ariaLabel="Papers"
        renderItem={(item) => <div>{item.title}</div>}
      />,
    );

    // The spacer must account for the longer list, otherwise the scrollbar
    // is sized for 20 rows and the user cannot reach the new ones.
    const spacer = screen.getByRole("list").firstElementChild as HTMLElement;
    const rows = screen.getAllByRole("listitem").length;
    const top = parseInt(spacer.style.paddingTop, 10);
    const bottom = parseInt(spacer.style.paddingBottom, 10);
    expect(top + bottom + rows * 120).toBe(60 * 120);

    scroller.remove();
  });
});
