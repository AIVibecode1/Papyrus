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
    useDigestStore.getState().storeDay("cs.AI", "2026-08-01", [paperFor("2026-08-01")]);
    useDigestStore.getState().storeDay("cs.AI", "2026-07-31", [paperFor("2026-07-31")]);

    const state = useDigestStore.getState();
    expect(state.days("cs.AI")).toEqual(["2026-08-01", "2026-07-31"]);
    expect(state.dayCount("cs.AI", "2026-08-01")).toBe(1);
    expect(state.days("cs.LG")).toEqual([]);
  });

  it("persists and restores across loads", () => {
    useDigestStore.getState().storeDay("cs.AI", "2026-08-01", [paperFor("2026-08-01")]);

    // Simulate a fresh session: unload, then load from the same storage.
    useDigestStore.setState({ loaded: false, byCategory: {}, lastChecked: {} });
    useDigestStore.getState().load();

    expect(useDigestStore.getState().days("cs.AI")).toEqual(["2026-08-01"]);
    expect(useDigestStore.getState().dayCount("cs.AI", "2026-08-01")).toBe(1);
  });

  it("load with corrupted storage does not throw", () => {
    localStorageMock.setItem("papyrus-digest-v1", "not json {{{");
    useDigestStore.setState({ loaded: false });
    expect(() => useDigestStore.getState().load()).not.toThrow();
    expect(useDigestStore.getState().loaded).toBe(true);
  });

  it("backfills every missing day and advances the checkpoint", async () => {
    // Seed: last checked 3 days ago, no stored days. Mark loaded so the
    // store does not re-load from (empty) storage and wipe the seed.
    // The checkpoint means that day was already fetched, so the backfill
    // starts the day after it: two missing days total.
    const threeDaysAgo = addDays(yesterday, -2);
    useDigestStore.setState({ loaded: true, lastChecked: { "cs.AI": threeDaysAgo } });

    vi.mocked(fetchPapers).mockImplementation(async (_cat, _max, _q, date) => [
      paperFor(date ?? ""),
    ]);

    await useDigestStore.getState().ensureHistory("cs.AI");

    const calls = vi.mocked(fetchPapers).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toBe("cs.AI");
    expect(calls[0][1]).toBe(50);
    expect(calls[0][3]).toBe(addDays(yesterday, -1));
    expect(calls[1][3]).toBe(yesterday);

    const state = useDigestStore.getState();
    expect(state.lastChecked["cs.AI"]).toBe(yesterday);
    expect(state.days("cs.AI")).toEqual([yesterday, addDays(yesterday, -1)]);
    expect(state.progress).toBeNull();
  });

  it("skips backfill when already up to date", async () => {
    useDigestStore.setState({ loaded: true, lastChecked: { "cs.AI": yesterday } });

    await useDigestStore.getState().ensureHistory("cs.AI");

    expect(vi.mocked(fetchPapers)).not.toHaveBeenCalled();
  });

  it("caps the first backfill window", async () => {
    // Never checked before: only the last BACKFILL_DAYS (14) are fetched.
    vi.mocked(fetchPapers).mockResolvedValue([]);

    await useDigestStore.getState().ensureHistory("cs.AI");

    const calls = vi.mocked(fetchPapers).mock.calls;
    expect(calls).toHaveLength(14);
    expect(calls[0][3]).toBe(addDays(yesterday, -13));
    expect(calls[13][3]).toBe(yesterday);
  });

  it("keeps the checkpoint behind a failed day for retry", async () => {
    useDigestStore.setState({
      loaded: true,
      lastChecked: { "cs.AI": addDays(yesterday, -2) },
    });
    const badDay = addDays(yesterday, -1);

    vi.mocked(fetchPapers).mockImplementation(async (_cat, _max, _q, date) => {
      if (date === badDay) throw new Error("network down");
      return [paperFor(date ?? "")];
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
});
