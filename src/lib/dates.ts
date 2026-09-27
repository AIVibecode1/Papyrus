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

/**
 * Formats a `YYYY-MM-DD` calendar day.
 *
 * A calendar day is not an instant, so it must never be rendered through
 * the machine's timezone. Appending `T00:00:00Z` pins the instant to UTC
 * midnight, but `Intl.DateTimeFormat` then formats it in the *runtime*
 * zone: in America/New_York, UTC midnight is 20:00 the previous day, so
 * `2026-07-31` printed as "Jul 30". Every day label in the day picker and
 * on each day's card was off by one for the whole Americas.
 *
 * Pinning the formatter to UTC instead makes the label equal the stored
 * key in every timezone, which is the only correct answer for a day the
 * backend filed papers under.
 */
export function formatCalendarDay(
  day: string,
  locale: string,
  options: Intl.DateTimeFormatOptions,
): string {
  return formatUiDate(`${day}T00:00:00Z`, locale, { ...options, timeZone: "UTC" });
}
