/**
 * Vitest setup: repair the web Storage globals under jsdom.
 *
 * Node 25+ exposes experimental `localStorage` / `sessionStorage` globals
 * whose getter returns `undefined` unless the process is started with
 * `--localstorage-file`. Node installs those on `globalThis` before the
 * test environment starts, and vitest's jsdom environment does not replace
 * globals that already exist there — so `window.localStorage` (and
 * `window === globalThis` under vitest) stayed `undefined` and every test
 * touching storage died with
 * "Cannot read properties of undefined (reading 'getItem')".
 *
 * CI pins Node 22, where these globals do not exist, so the suite passed
 * in CI while failing for anyone on current Node. Restoring the globals
 * here makes the suite behave identically on both and leaves the
 * `// @vitest-environment jsdom` test files themselves untouched.
 *
 * Strategy: prefer a real jsdom `Storage` (correct semantics, no
 * hand-rolled behaviour to keep in sync) and fall back to a minimal
 * spec-compliant in-memory implementation if no real one is reachable.
 * In the `node` environment there is no `window` at all, so this is a
 * no-op there and pure-logic tests are unaffected.
 */

type StorageGlobals = "localStorage" | "sessionStorage";

/** Minimal WHATWG Storage surface — enough for the app and its tests. */
function createMemoryStorage(): Storage {
  let map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      map.set(String(key), String(value));
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => {
      map = new Map();
    },
  } as Storage;
}

/**
 * A same-origin iframe gets its own jsdom window, whose Storage is not
 * shadowed by Node's broken global. Returns null when the DOM is
 * unavailable or the iframe window cannot be reached.
 */
function realStorageFromIframe(): Storage | null {
  try {
    const doc = globalThis.document;
    if (!doc?.body) return null;
    const frame = doc.createElement("iframe");
    doc.body.appendChild(frame);
    const storage = (frame.contentWindow as { localStorage?: Storage } | null)?.localStorage;
    if (!storage || typeof storage.getItem !== "function") {
      frame.remove();
      return null;
    }
    return storage;
  } catch {
    return null;
  }
}

function install(name: StorageGlobals, value: Storage): void {
  // Redefine rather than assign: Node's entry is an accessor, so a plain
  // assignment throws in strict mode instead of replacing it.
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
    enumerable: true,
  });
}

function repair(name: StorageGlobals): void {
  const scope = globalThis as unknown as Record<string, unknown>;
  // Healthy already: an object. Only an `undefined` read is the bug.
  if (scope[name] != null) return;
  // `window` is the very object being repaired here, so take a *fresh*
  // window's Storage instead of reading the shadowed one back.
  install(name, realStorageFromIframe() ?? createMemoryStorage());
}

repair("localStorage");
repair("sessionStorage");
