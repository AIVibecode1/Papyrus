import { useEffect, useRef, useState } from "react";

import { useTheme } from "@/hooks/use-theme";

let blockCounter = 0;

interface MermaidBlockProps {
  code: string;
}

/**
 * Renders a mermaid diagram from an AI-generated code fence. The mermaid
 * library is lazy-loaded only when a diagram actually appears, keeping
 * the startup bundle small.
 *
 * Security: `securityLevel: "strict"` escapes HTML inside labels. The
 * rendered SVG comes from mermaid's own sanitizer; it is injected as
 * markup because that is the library's documented rendering path.
 *
 * The theme is re-applied on light/dark switches (re-render with a new
 * mermaid instance state). On failure the raw code is shown instead of
 * a silent blank.
 */
export function MermaidBlock({ code }: MermaidBlockProps) {
  const { theme } = useTheme();
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef(`papyrus-mmd-${++blockCounter}`);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setError(null);

    (async () => {
      try {
        const { default: mermaid } = await import("mermaid");
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: theme === "dark" ? "dark" : "neutral",
        });
        const { svg: rendered } = await mermaid.render(idRef.current, code);
        if (!cancelled) setSvg(rendered);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [code, theme]);

  if (error) {
    return (
      <div
        dir="ltr"
        className="my-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive"
      >
        <p className="mb-1 font-medium">Diagram could not be rendered</p>
        <pre className="whitespace-pre-wrap">{code}</pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div
        aria-label="Rendering diagram"
        className="my-2 h-24 animate-pulse rounded-md bg-muted/60"
      />
    );
  }

  return (
    <div dir="ltr" className="my-2 flex justify-center">
      {/* mermaid's sanitized SVG output (securityLevel: strict) */}
      <div dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  );
}
