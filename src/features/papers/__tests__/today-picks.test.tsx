// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TodayPicks } from "@/features/papers/today-picks";
import type { Paper } from "@/lib/types";

const papers: Paper[] = [
  {
    id: "2607.00001v1",
    title: "Encoders are all you need",
    authors: [],
    published: "2026-07-30",
    summary: "",
    pdfUrl: "https://arxiv.org/pdf/2607.00001v1",
    categories: ["cs.AI"],
  },
  {
    id: "2607.00002v1",
    title: "Attention sinks explained",
    authors: [],
    published: "2026-07-30",
    summary: "",
    pdfUrl: "https://arxiv.org/pdf/2607.00002v1",
    categories: ["cs.AI"],
  },
];

describe("TodayPicks", () => {
  it("renders the picks with titles and a heuristic context label", () => {
    render(<TodayPicks papers={papers} date="2026-08-01" onDismiss={vi.fn()} onOpen={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Today's picks" })).toBeInTheDocument();
    expect(screen.getByText("Encoders are all you need")).toBeInTheDocument();
    expect(screen.getByText("Attention sinks explained")).toBeInTheDocument();
    expect(screen.getByText(/Newest picks from 2026-08-01/)).toBeInTheDocument();
  });

  it("opens a paper when its tile is clicked", () => {
    const onOpen = vi.fn();
    render(<TodayPicks papers={papers} date={null} onDismiss={vi.fn()} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: /Encoders are all you need/ }));
    expect(onOpen).toHaveBeenCalledWith(papers[0]);
  });

  it("dismisses the strip via the accessible close button", () => {
    const onDismiss = vi.fn();
    render(<TodayPicks papers={papers} date={null} onDismiss={onDismiss} onOpen={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss picks" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("keeps titles in LTR spans inside the RTL layout", () => {
    render(<TodayPicks papers={papers} date={null} onDismiss={vi.fn()} onOpen={vi.fn()} />);
    expect(screen.getByText("Encoders are all you need")).toHaveAttribute("dir", "ltr");
  });
});
