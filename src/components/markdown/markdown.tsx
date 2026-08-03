import { memo, type MouseEvent, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import { openUrl } from "@tauri-apps/plugin-opener";

import { MermaidBlock } from "@/components/markdown/mermaid-block";
import { cn } from "@/lib/utils";

interface MarkdownProps {
  children: string;
  className?: string;
}

/**
 * Renders AI-generated markdown (with GFM tables and KaTeX math) inside
 * the app. Raw HTML is deliberately NOT enabled (rehype-raw is absent):
 * AI output is untrusted, so HTML passes through escaped.
 *
 * Links route through the opener plugin inside the Tauri app (the
 * webview blocks target="_blank") and fall back to window.open in a
 * plain browser preview. Code, math and tables are forced LTR even when
 * the surrounding text is Arabic/RTL.
 */
/**
 * Models often write LaTeX with \(...\) / \[...\] delimiters, which
 * remark-math does not parse (it only knows $...$ / $$...$$). Normalize
 * the paren forms so AI equations actually render as math.
 */
export function normalizeMathDelimiters(text: string): string {
  // In a replacement string, $$ is an escaped literal $, so $$$$ emits $$.
  return text
    .replace(/\\\[([\s\S]*?)\\\]/g, "$$$$\n$1\n$$$$")
    .replace(/\\\(([\s\S]*?)\\\)/g, "$$$1$");
}

export const Markdown = memo(function Markdown({ children, className }: MarkdownProps) {
  const handleLinkClick = (e: MouseEvent<HTMLAnchorElement>, href: string | undefined) => {
    if (!href) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    if ("__TAURI_INTERNALS__" in window) {
      void openUrl(href);
    } else {
      window.open(href, "_blank", "noreferrer");
    }
  };

  const components: Components = {
    a: ({ href, children }) => (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => handleLinkClick(e, href)}
        className="font-medium text-primary underline underline-offset-4 hover:text-primary/80"
      >
        {children}
      </a>
    ),
    h1: ({ children }) => (
      <h1 className="mb-2 mt-4 text-lg font-bold tracking-tight first:mt-0">{children}</h1>
    ),
    h2: ({ children }) => (
      <h2 className="mb-2 mt-4 text-base font-bold tracking-tight first:mt-0">{children}</h2>
    ),
    h3: ({ children }) => (
      <h3 className="mb-1.5 mt-3 text-sm font-bold tracking-tight first:mt-0">{children}</h3>
    ),
    h4: ({ children }) => (
      <h4 className="mb-1 mt-3 text-sm font-semibold first:mt-0">{children}</h4>
    ),
    p: ({ children }) => <p className="my-2 leading-relaxed first:mt-0 last:mb-0">{children}</p>,
    ul: ({ children }) => <ul className="my-2 list-disc space-y-1 ps-5">{children}</ul>,
    ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 ps-5">{children}</ol>,
    li: ({ children }) => <li className="leading-relaxed">{children}</li>,
    strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
    em: ({ children }) => <em>{children}</em>,
    blockquote: ({ children }) => (
      <blockquote className="my-2 border-s-2 border-primary/40 ps-3 text-muted-foreground">
        {children}
      </blockquote>
    ),
    hr: () => <hr className="my-4 border-border" />,
    pre: ({ children }) => (
      <div dir="ltr" className="my-2 overflow-x-auto rounded-md bg-muted/60 p-3">
        {children}
      </div>
    ),
    code: ({ className, children }) => {
      const language = className?.replace("language-", "");
      if (language === "mermaid") {
        return <MermaidBlock code={String(children).replace(/\n$/, "")} />;
      }
      const block = Boolean(language) || String(children).includes("\n");
      if (block) {
        return <code className="block text-xs leading-relaxed text-foreground">{children}</code>;
      }
      return (
        <code dir="ltr" className="rounded bg-muted/70 px-1 py-0.5 text-[0.85em]">
          {children}
        </code>
      );
    },
    table: ({ children }) => (
      <div dir="ltr" className="my-2 overflow-x-auto">
        <table className="w-full border-collapse text-sm">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className="bg-muted/60">{children}</thead>,
    th: ({ children }) => (
      <th className="border border-border px-2.5 py-1.5 text-start font-semibold">{children}</th>
    ),
    td: ({ children }) => (
      <td className="border border-border px-2.5 py-1.5 align-top">{children}</td>
    ),
    img: ({ src, alt }: { src?: string; alt?: string }): ReactNode => (
      <img src={src} alt={alt ?? ""} className="my-2 max-w-full rounded-md border border-border" />
    ),
  };

  return (
    <div className={cn("text-sm", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={components}
      >
        {normalizeMathDelimiters(children)}
      </ReactMarkdown>
    </div>
  );
});
