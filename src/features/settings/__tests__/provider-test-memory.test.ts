// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import {
  loadTestMemory,
  recordTestFailure,
  recordTestSuccess,
} from "@/features/settings/provider-test-memory";

beforeEach(() => {
  localStorage.clear();
});

describe("provider test memory", () => {
  it("round-trips a passed test with truncated detail", () => {
    recordTestSuccess("p1", "ok ".repeat(100));
    const remembered = loadTestMemory().p1;
    expect(remembered.ok).toBe(true);
    expect(remembered.detail).toBeTruthy();
    expect(remembered.detail!.length).toBeLessThan("ok ".repeat(100).length);
    expect(remembered.at).toBeTruthy();
  });

  it("stores the failure category and a redacted detail", () => {
    recordTestFailure("p1", "fetch failed: sk-abcdef123456 echoed back");
    const remembered = loadTestMemory().p1;
    expect(remembered.ok).toBe(false);
    expect(remembered.category).toBeTruthy();
    expect(remembered.detail).not.toContain("sk-abcdef123456");
  });

  it("survives corrupted storage", () => {
    localStorage.setItem("papyrus-provider-test-v1", "not json {{{");
    expect(loadTestMemory()).toEqual({});
  });
});
