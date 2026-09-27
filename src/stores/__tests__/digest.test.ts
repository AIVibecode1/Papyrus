import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Paper } from "@/lib/types";

vi.mock("@/lib/arxiv", () => ({ fetchPapers: vi.fn() }));

import { fetchPapers } from "@/lib/arxiv";
import { useDigestStore, addDays, todayStr, evictToBudget } from "@/stores/digest";

// The vitest environment is "node" — provide an in-memory localStorage so
// the digest store's persistence can be exercised (same pattern as the
// settings store tests).
function createMemoryStorage(): Storage {
  let data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => {
      data = new Map();
    },
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => Array.from(data.keys())[index] ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

const localStorageMock = createMemoryStorage();

function paperFor(date: string): Paper {
  return {
    id: `p-${date}`,
    title: `Paper on ${date}`,
    authors: ["A. Author"],
    published: `${date}T12:00:00Z`,
    summary: "Summary.",
    pdfUrl: `https://arxiv.org/pdf/${date}`,
    categories: ["cs.AI"],
  };
}

/** A realistic day: 50 papers with abstracts, matching what the digest
 * actually stores (~1.7 KB of JSON per paper, measured from the bundled
 * arXiv fixture). Sized like this, 60 days overruns the 3 MB budget,
 * which is exactly the condition eviction exists for. */
function bigDay(date: string): Paper[] {
  return Array.from({ length: 50 }, (_, i) => ({
    ...paperFor(date),
    id: `${date}-${i}`,
    summary: "x".repeat(1400),
  }));
}

describe("digest store", () => {
  const today = todayStr();
  const yesterday = addDays(today, -1);

  beforeEach(() => {
    vi.mocked(fetchPapers).mockReset();
    localStorageMock.clear();
    vi.stubGlobal("localStorage", localStorageMock);
    useDigestStore.setState({
      byCategory: {},
      lastChecked: {},
      loaded: false,
      progress: null,
    });
  });

  it("storeDay caches a day and days() lists newest first", () => {
    // Relative dates: the store prunes days older than its 30-day
    // retention window on load, so fixed calendar dates rot as time passes.
    useDigestStore.getState().storeDay("cs.AI", today, [paperFor(today)]);
    useDigestStore.getState().storeDay("cs.AI", yesterday, [paperFor(yesterday)]);

    const state = useDigestStore.getState();
    expect(state.days("cs.AI")).toEqual([today, yesterday]);
    expect(state.dayCount("cs.AI", today)).toBe(1);
    expect(state.days("cs.LG")).toEqual([]);
  });

  it("persists and restores across loads", () => {
    useDigestStore.getState().storeDay("cs.AI", today, [paperFor(today)]);

    // Simulate a fresh session: unload, then load from the same storage.
    useDigestStore.setState({ loaded: false, byCategory: {}, lastChecked: {} });
    useDigestStore.getState().load();

    expect(useDigestStore.getState().days("cs.AI")).toEqual([today]);
    expect(useDigestStore.getState().dayCount("cs.AI", today)).toBe(1);
  });

  it("load with corrupted storage does not throw", () => {
    localStorageMock.setItem("papyrus-digest-v2", "not json {{{");
    useDigestStore.setState({ loaded: false });
    expect(() => useDigestStore.getState().load()).not.toThrow();
    expect(useDigestStore.getState().loaded).toBe(true);
  });

  it("backfills every missing day including today and advances the checkpoint", async () => {
    // Seed: last checked 3 days ago, no stored days. Mark loaded so the
    // store does not re-load from (empty) storage and wipe the seed.
    // The checkpoint means that day was already fetched, so the backfill
    // starts the day after it: three missing days (yesterday-1, yesterday,
    // today — today is included so the day picker shows the current day).
    const threeDaysAgo = addDays(yesterday, -2);
    useDigestStore.setState({ loaded: true, lastChecked: { "cs.AI": threeDaysAgo } });

    vi.mocked(fetchPapers).mockImplementation(async (_cat, _max, _q, date) => ({
      papers: [paperFor(date ?? "")],
      fallbackNote: null,
    }));

    await useDigestStore.getState().ensureHistory("cs.AI");

    const calls = vi.mocked(fetchPapers).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[0][0]).toBe("cs.AI");
    expect(calls[0][1]).toBe(50);
    expect(calls[0][3]).toBe(addDays(yesterday, -1));
    expect(calls[1][3]).toBe(yesterday);
    expect(calls[2][3]).toBe(today);

    const state = useDigestStore.getState();
    expect(state.lastChecked["cs.AI"]).toBe(today);
    expect(state.days("cs.AI")).toEqual([today, yesterday, addDays(yesterday, -1)]);
    expect(state.progress).toBeNull();
  });

  it("skips backfill when already up to date", async () => {
    useDigestStore.setState({ loaded: true, lastChecked: { "cs.AI": today } });
    useDigestStore.getState().storeDay("cs.AI", today, [paperFor(today)]);

    await useDigestStore.getState().ensureHistory("cs.AI");

    expect(fetchPapers).not.toHaveBeenCalled();
  });

  it("refetches today when its stored list is empty", async () => {
    // Today was fetched before arXiv announced anything: the empty day
    // must be refetched (healed) once papers arrive, even though the
    // checkpoint already advanced to today.
    useDigestStore.setState({ loaded: true, lastChecked: { "cs.AI": today } });
    useDigestStore.getState().storeDay("cs.AI", today, []);

    vi.mocked(fetchPapers).mockResolvedValue({ papers: [paperFor(today)], fallbackNote: null });

    await useDigestStore.getState().ensureHistory("cs.AI");

    expect(fetchPapers).toHaveBeenCalledTimes(1);
    const state = useDigestStore.getState();
    expect(state.dayCount("cs.AI", today)).toBe(1);
  });

  it("caps the first backfill window", async () => {
    // Never checked before: only the last BACKFILL_DAYS (14) are fetched.
    vi.mocked(fetchPapers).mockResolvedValue({ papers: [], fallbackNote: null });

    await useDigestStore.getState().ensureHistory("cs.AI");

    const calls = vi.mocked(fetchPapers).mock.calls;
    expect(calls).toHaveLength(14);
    expect(calls[0][3]).toBe(addDays(today, -13));
    expect(calls[13][3]).toBe(today);
  });

  it("keeps the checkpoint behind a failed day for retry", async () => {
    useDigestStore.setState({
      loaded: true,
      lastChecked: { "cs.AI": addDays(yesterday, -2) },
    });
    const badDay = addDays(yesterday, -1);

    vi.mocked(fetchPapers).mockImplementation(async (_cat, _max, _q, date) => {
      if (date === badDay) throw new Error("network down");
      return { papers: [paperFor(date ?? "")], fallbackNote: null };
    });

    await useDigestStore.getState().ensureHistory("cs.AI");

    // The day before the failure becomes the checkpoint, so the next
    // launch retries the failed day. Successful days stay cached.
    const state = useDigestStore.getState();
    expect(state.lastChecked["cs.AI"]).toBe(addDays(badDay, -1));
    expect(state.days("cs.AI")).toContain(yesterday);
    expect(state.days("cs.AI")).not.toContain(badDay);
  });

  it("prunes days older than the retention window on load", () => {
    const oldDay = addDays(today, -40);
    useDigestStore.getState().storeDay("cs.AI", oldDay, [paperFor(oldDay)]);
    useDigestStore.getState().storeDay("cs.AI", yesterday, [paperFor(yesterday)]);

    // The prune runs inside load(); simulate a fresh session.
    useDigestStore.setState({ loaded: false });
    useDigestStore.getState().load();

    const state = useDigestStore.getState();
    expect(state.days("cs.AI")).toEqual([yesterday]);
    expect(state.days("cs.AI")).not.toContain(oldDay);
  });

  it("a backfill running for one category does not block another category", async () => {
    // Hold cs.AI's backfill open with a deferred promise.
    let releaseAi: () => void = () => {};
    vi.mocked(fetchPapers).mockImplementationOnce(
      () =>
        new Promise<{ papers: Paper[]; fallbackNote: string | null }>((resolve) => {
          releaseAi = () => resolve({ papers: [paperFor(today)], fallbackNote: null });
        }),
    );
    useDigestStore.setState({ loaded: true, lastChecked: { "cs.AI": today, "cs.LG": today } });
    // Force a missing day so both categories have work to do.
    useDigestStore.getState().storeDay("cs.AI", today, []);
    useDigestStore.getState().storeDay("cs.LG", today, []);

    const aiRun = useDigestStore.getState().ensureHistory("cs.AI");
    // The AI pass is in flight; switching to cs.LG must start its own pass.
    vi.mocked(fetchPapers).mockResolvedValue({ papers: [paperFor(today)], fallbackNote: null });
    await useDigestStore.getState().ensureHistory("cs.LG");

    expect(vi.mocked(fetchPapers).mock.calls.some((c) => c[0] === "cs.LG")).toBe(true);
    expect(useDigestStore.getState().lastChecked["cs.LG"]).toBe(today);

    releaseAi();
    await aiRun;
    expect(useDigestStore.getState().lastChecked["cs.AI"]).toBe(today);
  });

  it("a second backfill for the same category while running is skipped", async () => {
    let releaseAi: () => void = () => {};
    vi.mocked(fetchPapers).mockImplementationOnce(
      () =>
        new Promise<{ papers: Paper[]; fallbackNote: string | null }>((resolve) => {
          releaseAi = () => resolve({ papers: [paperFor(today)], fallbackNote: null });
        }),
    );
    useDigestStore.setState({ loaded: true, lastChecked: { "cs.AI": today } });
    useDigestStore.getState().storeDay("cs.AI", today, []);

    const first = useDigestStore.getState().ensureHistory("cs.AI");
    const second = useDigestStore.getState().ensureHistory("cs.AI");
    releaseAi();
    await Promise.all([first, second]);

    // Only the first pass fetched anything (one call, not two).
    expect(vi.mocked(fetchPapers).mock.calls).toHaveLength(1);
  });

  it("load drops malformed day entries that are not paper lists", () => {
    localStorage.setItem(
      "papyrus-digest-v2",
      JSON.stringify({
        byCategory: {
          "cs.AI": { [today]: [{ id: "x", title: "ok" }], "2026-01-01": "not an array" },
          "cs.LG": { [today]: [{ id: "y" }] },
        },
        lastChecked: { "cs.AI": today },
      }),
    );
    useDigestStore.setState({ loaded: false });
    useDigestStore.getState().load();
    const state = useDigestStore.getState();
    expect(state.days("cs.AI")).toEqual([today]);
    expect(state.days("cs.LG")).toEqual([]);
  });
});

describe("evictToBudget", () => {
  it("leaves a digest that already fits untouched (same reference)", () => {
    const input = { "cs.AI": { "2026-01-02": [paperFor("2026-01-02")] } };
    expect(evictToBudget(input, 1_000_000)).toBe(input);
  });

  it("holds the budget on the measured output, not just the estimate", () => {
    // The fast path tracks an estimate; the guarantee is on the real
    // serialized value. Sweep budgets so both the estimate-driven path and
    // the exact fallback are exercised against the real byte count.
    const byCategory: Record<string, Record<string, Paper[]>> = {};
    for (let c = 0; c < 3; c += 1) {
      const map: Record<string, Paper[]> = {};
      for (let d = 1; d <= 20; d += 1) {
        const date = `2026-01-${String(d).padStart(2, "0")}`;
        map[date] = Array.from({ length: 6 }, (_, i) => ({
          ...paperFor(date),
          id: `${date}-${i}`,
          summary: "x".repeat(120),
        }));
      }
      byCategory[`cs.C${c}`] = map;
    }
    const full = JSON.stringify(byCategory).length;
    for (const budget of [full, full * 0.9, full * 0.5, full * 0.1, 500, 50]) {
      const out = evictToBudget(byCategory, budget);
      expect(JSON.stringify(out).length).toBeLessThanOrEqual(budget);
      // Eviction only ever removes whole days, never a partial one.
      for (const [cat, map] of Object.entries(out)) {
        for (const [date, papers] of Object.entries(map)) {
          expect(byCategory[cat]?.[date]).toEqual(papers);
        }
      }
    }
  });

  it("drops the oldest days until the digest fits the budget", () => {
    const input = {
      "cs.AI": {
        "2026-01-01": bigDay("2026-01-01"),
        "2026-01-02": bigDay("2026-01-02"),
        "2026-01-03": bigDay("2026-01-03"),
      },
    };
    const full = JSON.stringify(input).length;
    // Budget for roughly two days: the oldest must go, the newest stay.
    const out = evictToBudget(input, Math.floor((full / 3) * 2));
    expect(out["cs.AI"]["2026-01-01"]).toBeUndefined();
    expect(out["cs.AI"]["2026-01-03"]).toBeDefined();
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(Math.floor((full / 3) * 2));
  });

  it("evicts across categories oldest-first and never mutates the input", () => {
    const newer = { "cs.LG": { "2026-01-05": bigDay("2026-01-05") } };
    const input = { "cs.AI": { "2026-01-01": bigDay("2026-01-01") }, ...newer };
    // Budget is the size of the day we expect to survive, plus envelope
    // slack (the real budget is megabytes; this pins the ordering rule).
    const budget = JSON.stringify(newer).length + 512;
    const out = evictToBudget(input, budget);
    // The newer category survives. The older day is dropped, which empties
    // its category, and an emptied category is removed entirely.
    expect(out["cs.AI"]).toBeUndefined();
    expect(out["cs.LG"]["2026-01-05"]).toBeDefined();
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(budget);
    // Input untouched.
    expect(input["cs.AI"]["2026-01-01"]).toBeDefined();
  });
});

describe("digest storage budget", () => {
  const today = todayStr();
  beforeEach(() => {
    localStorageMock.clear();
    vi.stubGlobal("localStorage", localStorageMock);
    useDigestStore.setState({ byCategory: {}, lastChecked: {}, loaded: true, progress: null });
  });

  it("keeps the persisted blob under the localStorage budget", () => {
    // Each day is ~40 papers; 60 days would be ~4 MB of paper JSON, well
    // past the 3 MB budget. persist() must evict rather than let the
    // write throw and silently stop persisting the digest.
    for (let i = 0; i < 60; i += 1) {
      const date = addDays(today, -i);
      useDigestStore.getState().storeDay("cs.AI", date, bigDay(date));
    }
    const written = localStorageMock.getItem("papyrus-digest-v2");
    expect(written).not.toBeNull();
    expect(written!.length).toBeLessThanOrEqual(3 * 1024 * 1024);
    // The newest day is always kept; the oldest is evicted first.
    expect(useDigestStore.getState().days("cs.AI")).toContain(today);
    expect(useDigestStore.getState().days("cs.AI")).not.toContain(addDays(today, -59));
  });
});
