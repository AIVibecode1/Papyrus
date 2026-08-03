/**
 * Formats a date for the UI.
 *
 * Arabic locales embed bidi marks (RLM U+200F, LRM U+200E) around the
 * separators of numeric dates, which flips "31/07/2026" into
 * "2026/07/31" even inside an LTR container. The marks are stripped so
 * the digits always render in the order the locale printed them.
 */
export function formatUiDate(
  value: Date | string,
  locale: string,
  options: Intl.DateTimeFormatOptions,
): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat(locale, options).format(date).replace(/[\u200e\u200f]/g, "");
}
