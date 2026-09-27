/**
 * Models often write LaTeX with \(...\) / \[...\] delimiters, which
 * remark-math does not parse (it only knows $...$ / $$...$$). Normalize
 * the paren forms so AI equations actually render as math.
 *
 * Pure and dependency-free, so it lives here rather than inside the
 * Markdown component module: a `.tsx` file exporting both a component
 * and a plain function cannot be Fast Refreshed, which forced a full
 * page reload on every edit to the renderer.
 */
export function normalizeMathDelimiters(text: string): string {
  // In a replacement string, $$ is an escaped literal $, so $$$$ emits $$.
  return text
    .replace(/\\\[([\s\S]*?)\\\]/g, "$$$$\n$1\n$$$$")
    .replace(/\\\(([\s\S]*?)\\\)/g, "$$$1$");
}
