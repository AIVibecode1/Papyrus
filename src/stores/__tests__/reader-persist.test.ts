import { beforeEach, describe, expect, it } from "vitest";

import { loadWalkthrough, type SectionEntry } from "@/stores/reader-persist";

const KEY = "papyrus-reader-walkthrough-v1";

function seed(paperId: string, sectionEntries: SectionEntry[], synthesis: SectionEntry | null) {
  localStorage.setItem(KEY, JSON.stringify({ [paperId]: { sectionEntries, synthesis } }));
}

function entry(status: SectionEntry["status"]): SectionEntry {
  return { text: "body", status, error: status === "error" ? "boom" : null };
}

describe("loadWalkthrough", () => {
  beforeEach(() => localStorage.clear());

  // A restored walkthrough exists so reopening a paper does not re-stream
  // every section. What it must NOT do is rewrite history: telling the
  // user a finished section was "stopped" loses the checkmark and reports
  // completed work as abandoned.
  it("preserves done and error, and only demotes in-flight statuses", () => {
    seed(
      "p1",
      [
        entry("done"),
        entry("error"),
        entry("loading"),
        entry("streaming"),
        entry("idle"),
        entry("stopped"),
      ],
      entry("done"),
    );

    const snap = loadWalkthrough("p1");

    expect(snap.sectionEntries.map((e) => e.status)).toEqual([
      "done",
      "error",
      "stopped",
      "stopped",
      "stopped",
      "stopped",
    ]);
    expect(snap.synthesis?.status).toBe("done");
  });

  it("keeps the error message on a restored error", () => {
    seed("p1", [entry("error")], null);
    expect(loadWalkthrough("p1").sectionEntries[0].error).toBe("boom");
  });

  it("returns an empty snapshot for an unknown paper", () => {
    expect(loadWalkthrough("missing")).toEqual({ sectionEntries: [], synthesis: null });
  });

  it("survives corrupt storage", () => {
    localStorage.setItem(KEY, "{not json");
    expect(loadWalkthrough("p1")).toEqual({ sectionEntries: [], synthesis: null });
  });
});
