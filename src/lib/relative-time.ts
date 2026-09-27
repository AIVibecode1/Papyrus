/** Relative "Opened X ago" label in the active UI language.
 *
 * Pure and dependency-free, so it lives here rather than inside a
 * component module: a `.tsx` file that exports both a component and a
 * plain function cannot be Fast Refreshed (vite-plugin-react rejects the
 * mixed export), which forced a full page reload on every edit to the
 * history list. Falls back to the raw input when the date is unparseable.
 */
export function relativeOpened(iso: string, lang: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const minutes = Math.round((Date.now() - then) / 60_000);
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  if (Math.abs(minutes) < 60) return rtf.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return rtf.format(-hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return rtf.format(-days, "day");
  const months = Math.round(days / 30);
  if (Math.abs(months) < 12) return rtf.format(-months, "month");
  return rtf.format(Math.round(months / 12), "year");
}
