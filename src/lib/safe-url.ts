/** Plan 071: AI output and notes are untrusted text; markdown links
 * must never reach the OS opener unless they are absolute http(s).
 * Rejects javascript:, data:, file:, vbscript:, blob:, mailto:,
 * relative paths and protocol-relative URLs. */
const SAFE_SCHEMES = new Set(["http", "https"]);

export function isSafeOpenUrl(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed) return false;
  // A URL with a scheme: "scheme:rest". Anything without a scheme
  // (relative paths, "//host/path") is not an absolute web URL.
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
  if (!match) return false;
  return SAFE_SCHEMES.has(match[1].toLowerCase());
}
