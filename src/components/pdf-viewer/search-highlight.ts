/**
 * Search-hit helpers for the PDF text layer (pure, exported for reuse).
 * Occurrences are wrapped in <mark> elements; all other text is
 * HTML-escaped so a paper containing markup can never inject HTML.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Wraps every case-insensitive occurrence of `query` in the span's text
 * with <mark> elements. Returns the number of matches found.
 */
export function highlightSpan(span: HTMLElement, query: string): number {
  const text = span.textContent ?? "";
  if (!query.trim() || !text.toLowerCase().includes(query.toLowerCase())) return 0;
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  let count = 0;
  let html = "";
  let cursor = 0;
  let idx = lower.indexOf(needle);
  while (idx >= 0) {
    html += `${escapeHtml(text.slice(cursor, idx))}<mark>${escapeHtml(text.slice(idx, idx + needle.length))}</mark>`;
    count += 1;
    cursor = idx + needle.length;
    idx = lower.indexOf(needle, cursor);
  }
  html += escapeHtml(text.slice(cursor));
  span.innerHTML = html;
  return count;
}
