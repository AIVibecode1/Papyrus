// @vitest-environment jsdom
// Regressions for the store races found in the round-6 audit. Each was
// reachable in normal use and each failed silently — no error surfaced, the
// list or the file just came out wrong.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { usePapersStore } from "@/stores/papers";
import { useSettingsStore } from "@/stores/settings";
import { useDigestStore } from "@/stores/digest";
import * as citationsApi from "@/lib/citations";
import * as arxiv from "@/lib/arxiv";
import type { Paper } from "@/lib/types";

const PROVIDER_KEY = "papyrus-providers";

function paper(id: string): Paper {
  return {
    id,
    title: `Paper ${id}`,
    authors: ["A. Author"],
    summary: "A summary.",
    pdfUrl: `https://arxiv.org/pdf/${id}`,
    published: "2026-01-01",
    categories: ["cs.AI"],
  };
}

/** A fetch that resolves only once the returned `release` is called. */
function deferred<T>(make: () => T) {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  return { gate, release, make };
}

function resetPapers() {
  usePapersStore.setState({
    category: "cs.AI",
    query: "",
    date: null,
    source: "arxiv",
    papers: [],
    loading: false,
    loadingMore: false,
    error: null,
    citations: {},
    citationsLoading: false,
    citationsReachable: true,
    lastUpdated: null,
  });
}

beforeEach(() => {
  localStorage.clear();
  resetPapers();
  vi.restoreAllMocks();
});

describe("Load more must not cancel an in-flight refresh", () => {
  it("keeps the background refresh result when Load more is clicked during it", async () => {
    // A cache-first day view paints its cached page 1 with `loading: false`
    // while the real fetch is still outstanding, so the button is enabled in
    // exactly that window. Load more used to bump the refresh's generation
    // token, so the refresh's result *and* its citation batch were dropped.
    const fresh = [paper("fresh-1"), paper("fresh-2")];
    const d = deferred(() => fresh);
    vi.spyOn(arxiv, "fetchPapers").mockImplementation(async () => {
      await d.gate;
      return { papers: fresh, fallbackNote: null };
    });

    // Seed the digest cache: the cache-first day path only paints (and only
    // clears `loading`) when this day is already collected.
    useDigestStore.setState({
      byCategory: { "cs.AI": { "2026-09-26": [paper("cached-1")] } },
    });
    usePapersStore.setState({ date: "2026-09-26" });
    void usePapersStore.getState().refresh();
    const refreshing = usePapersStore.getState().refresh();

    // Cached page 1 is on screen and `loading` is already false: the window.
    expect(usePapersStore.getState().papers).toEqual([paper("cached-1")]);
    expect(usePapersStore.getState().loading).toBe(false);

    const paging = usePapersStore.getState().loadMore();
    d.release();
    await refreshing;
    await paging;

    // The refresh's result is what survives; it was not cancelled.
    expect(usePapersStore.getState().papers).toEqual(fresh);
  });

  it("still drops a page whose scope changed mid-flight", async () => {
    // The flip side of the fix: pagination must still be invalidated by a
    // scope change, or a stale page-2 would be appended to a new list. The
    // mock answers per call so the two results are distinguishable — the
    // surviving list must be the *new* scope's, not old-1 merged with old-2.
    let call = 0;
    const d = deferred(() => undefined);
    vi.spyOn(arxiv, "fetchPapers").mockImplementation(async () => {
      await d.gate;
      call += 1;
      return call === 1
        ? { papers: [paper("old-2")], fallbackNote: null }
        : { papers: [paper("new-1")], fallbackNote: null };
    });

    usePapersStore.setState({ papers: [paper("old-1")] });
    const paging = usePapersStore.getState().loadMore();
    expect(usePapersStore.getState().loadingMore).toBe(true);

    // Switching category resets the list and must invalidate pagination.
    usePapersStore.getState().setCategory("cs.CV");
    d.release();
    await paging;
    await vi.waitFor(() => expect(usePapersStore.getState().papers).toEqual([paper("new-1")]));

    // The stale page-2 never reached the list...
    expect(usePapersStore.getState().papers.map((p) => p.id)).toEqual(["new-1"]);
    // ...and the busy flag is always released, or Load more sticks for the
    // whole session.
    expect(usePapersStore.getState().loadingMore).toBe(false);
  });
});

describe("resetList invalidates the previous list's citation batch", () => {
  it("does not merge a stale batch into the new list's counts", async () => {
    // resetList cleared `citations` but never advanced the citation token, so
    // a batch started for the *previous* list still passed the check, merged
    // the old counts, and set citationsReachable for a list it never queried
    // (which renders a bogus "citations unavailable — Retry" banner).
    const c = deferred(() => ({ counts: { "old-1": 42 }, reachable: true }));
    vi.spyOn(citationsApi, "fetchCitations").mockImplementation(async () => {
      await c.gate;
      return c.make();
    });
    const f = deferred(() => [paper("old-1")]);
    vi.spyOn(arxiv, "fetchPapers").mockImplementation(async () => {
      await f.gate;
      return { papers: [paper("old-1")], fallbackNote: null };
    });

    void usePapersStore.getState().loadCitations(["old-1"]);
    expect(usePapersStore.getState().citationsLoading).toBe(true);

    // Change scope mid-batch: the list resets and refetches.
    usePapersStore.getState().setCategory("cs.CV");
    void usePapersStore.getState().refresh();
    f.release();
    c.release();

    await vi.waitFor(() => expect(usePapersStore.getState().citationsLoading).toBe(false));
    expect(usePapersStore.getState().citations["old-1"]).toBeUndefined();
  });
});

describe("settings refuses to write over an unreadable provider blob", () => {
  it("keeps the on-disk list when a load error is outstanding", () => {
    localStorage.setItem(
      PROVIDER_KEY,
      JSON.stringify([
        { id: "a", name: "A", baseUrl: "https://a.test", model: "m" },
        { id: "b", name: "B", baseUrl: "https://b.test", model: "m" },
      ]),
    );
    useSettingsStore.setState({ loaded: true, loadError: "Unexpected token", providers: [] });

    useSettingsStore.getState().addProvider({
      id: "c",
      name: "C",
      baseUrl: "https://c.test",
      model: "m",
    } as never);

    // The in-memory list is untouched...
    expect(useSettingsStore.getState().providers).toEqual([]);
    // ...and, crucially, the file on disk is not replaced by a one-element
    // array, which is how every saved provider config used to be lost.
    expect(JSON.parse(localStorage.getItem(PROVIDER_KEY) ?? "[]")).toHaveLength(2);
  });

  it("reports the failure instead of pretending the list is empty", () => {
    localStorage.setItem(PROVIDER_KEY, "{ not json");
    useSettingsStore.setState({ loaded: false, loadError: null, providers: [] });
    useSettingsStore.getState().load();

    expect(useSettingsStore.getState().loadError).toBeTruthy();
    // The blob is still on disk, not consumed by a failed read.
    expect(localStorage.getItem(PROVIDER_KEY)).toBe("{ not json");
  });
});
