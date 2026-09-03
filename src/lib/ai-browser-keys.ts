// ---------------------------------------------------------------------------
// Dev-only key store for the browser preview (when the app runs outside Tauri
// there is no OS keychain). Keys stay in memory only — never persisted.
// ---------------------------------------------------------------------------
const browserKeys = new Map<string, string>();

export function setBrowserKey(id: string, key: string) {
  browserKeys.set(id, key);
}

export function getBrowserKey(id: string) {
  return browserKeys.get(id) ?? "";
}

export function deleteBrowserKey(id: string) {
  browserKeys.delete(id);
}

export function hasBrowserKey(id: string) {
  return browserKeys.has(id);
}

export function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}
