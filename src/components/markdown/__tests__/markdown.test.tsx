// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Markdown, normalizeMathDelimiters } from "@/components/markdown/markdown";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

// Mermaid is lazy-loaded; replace the dynamic import with a stub so the
// jsdom test never touches the real (DOM-heavy) library.
vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: '<svg data-testid="mmd"></svg>' }),
  },
}));

describe("Markdown renderer", () => {
  beforeEach(() => {
    vi.stubGlobal("open", vi.fn());
    window.open = vi.fn();
    // jsdom does not implement matchMedia; the theme hook needs it.
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  it("renders headings, paragraphs, bold text and lists", () => {
    render(
      <Markdown>
        {[
          "# Main heading",
          "",
          "Some **bold** text and a paragraph.",
          "",
          "- first item",
          "- second item",
        ].join("\n")}
      </Markdown>,
    );

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Main heading");
    expect(screen.getByText("bold")).toHaveTextContent("bold");
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("first item");
    expect(items[1]).toHaveTextContent("second item");
  });

  it("renders GFM tables", () => {
    render(
      <Markdown>
        {["| Method | Score |", "| --- | --- |", "| A | 47.2% |", "| B | 52.8% |"].join("\n")}
      </Markdown>,
    );

    const table = screen.getByRole("table");
    expect(table).toHaveTextContent("Method");
    expect(table).toHaveTextContent("47.2%");
    expect(table.closest("div")).toHaveAttribute("dir", "ltr");
  });

  it("renders LaTeX equations with KaTeX", () => {
    render(
      <Markdown>
        {[
          "Inline math $x^2 + y^2$ and a display block:",
          "",
          "$$L = \\sum_i (y_i - \\hat{y}_i)^2$$",
        ].join("\n")}
      </Markdown>,
    );

    expect(document.querySelector(".katex")).not.toBeNull();
  });

  it("keeps code blocks left-to-right and renders inline code", () => {
    render(
      <Markdown>
        {["Run `pnpm test` and then:", "", "```ts", "const x = 1;", "```"].join("\n")}
      </Markdown>,
    );

    const inline = screen.getByText("pnpm test");
    expect(inline.closest("code")).toHaveAttribute("dir", "ltr");
    const block = screen.getByText("const x = 1;");
    // The pre component renders a scrollable LTR div wrapper.
    expect(block.closest('div[dir="ltr"]')).not.toBeNull();
  });

  it("opens links in a new window in the browser preview", () => {
    render(
      <Markdown>{["Read [the paper](https://arxiv.org/abs/2607.00001) now."].join("\n")}</Markdown>,
    );

    const link = screen.getByRole("link", { name: "the paper" });
    fireEvent.click(link);
    expect(window.open).toHaveBeenCalledWith(
      "https://arxiv.org/abs/2607.00001",
      "_blank",
      "noreferrer",
    );
  });

  it("renders mermaid code fences as diagrams", async () => {
    render(
      <Markdown>
        {["A diagram:", "", "```mermaid", "graph TD;", "  A --> B;", "```"].join("\n")}
      </Markdown>,
    );

    // The lazy import resolves and the stubbed render returns an SVG.
    await waitFor(() => expect(screen.getByTestId("mmd")).toBeInTheDocument());
  });

  it("does not execute raw HTML from AI output", () => {
    render(<Markdown>{['<img src=x onerror="window.pwned = true">'].join("\n")}</Markdown>);

    // react-markdown escapes raw HTML (rehype-raw is not enabled).
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText(/<img/)).toBeInTheDocument();
  });

  it("renders $...$ math as KaTeX", () => {
    const { container } = render(<Markdown>{"Energy is $E = mc^2$."}</Markdown>);
    expect(container.querySelector(".katex")).toBeInTheDocument();
  });

  it("normalizes \\(...\\) inline math that models often emit", () => {
    const { container } = render(<Markdown>{"Energy is \\(E = mc^2\\)."}</Markdown>);
    expect(container.querySelector(".katex")).toBeInTheDocument();
  });

  it("normalizes \\[...\\] display math into a KaTeX block", () => {
    const { container } = render(<Markdown>{"\\[\\frac{1}{2}\\]"}</Markdown>);
    expect(container.querySelector(".katex-display")).toBeInTheDocument();
  });

  it("normalizeMathDelimiters leaves plain text and $...$ untouched", () => {
    const src = "Cost: $5 for \\frac{1}{2} of $L = 1$";
    const out = normalizeMathDelimiters(src);
    expect(out).toContain("Cost: $5 for");
    expect(out).toContain("$L = 1$");
  });

  it("gives every paragraph auto direction so English titles do not flip in Arabic answers", () => {
    const { container } = render(
      <Markdown>{"هذه ورقة مهمة بعنوان (Attention Is All You Need) وتشرح المحولات."}</Markdown>,
    );
    const p = container.querySelector("p");
    expect(p).toHaveAttribute("dir", "auto");
  });
});
