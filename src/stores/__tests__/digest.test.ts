import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Paper } from "@/lib/types";

vi.mock("@/lib/arxiv", () => ({ fetchPapers: vi.fn() }));

import { fetchPapers } from "@/lib/arxiv";
import { useDigestStore, addDays, todayStr } from "@/stores/digest";

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
