import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStreamBuffer, type StreamBufferOptions } from "@/lib/stream";

interface FakeState {
  text: string;
}

function makeBuffer(overrides?: Partial<StreamBufferOptions<FakeState>>) {
  let state: FakeState = { text: "" };
  const applied: string[] = [];
  const set = (fn: (s: FakeState) => FakeState | Partial<FakeState>) => {
    const next = fn(state);
    state = { ...state, ...next };
  };
  const buffer = createStreamBuffer<FakeState>(set, {
    isCurrent: () => true,
    apply: (s, text) => {
      applied.push(text);
      return { text: s.text + text };
    },
    ...overrides,
  });
  return {
    buffer,
    getState: () => state,
    getApplied: () => applied,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createStreamBuffer", () => {
  it("buffers chunks and applies them in one flush after the interval", () => {
    const { buffer, getApplied, getState } = makeBuffer();

    buffer.push("a");
    buffer.push("b");
    expect(getApplied()).toEqual([]);

    vi.advanceTimersByTime(50);
    expect(getApplied()).toEqual(["ab"]);
    expect(getState().text).toBe("ab");
  });

  it("keeps appending across multiple flushes", () => {
    const { buffer, getState } = makeBuffer();

    buffer.push("one ");
    vi.advanceTimersByTime(50);
    buffer.push("two ");
    vi.advanceTimersByTime(50);
    buffer.push("three");
    vi.advanceTimersByTime(50);

    expect(getState().text).toBe("one two three");
  });

  it("drops chunks after isCurrent flips to false", () => {
    let current = true;
    const { buffer, getApplied } = makeBuffer({ isCurrent: () => current });

    buffer.push("keep");
    current = false;
    buffer.push("drop");
    vi.advanceTimersByTime(50);

    expect(getApplied()).toEqual(["keep"]);
  });

  it("flushNow applies immediately and cancels the pending timer", () => {
    const { buffer, getApplied } = makeBuffer();

    buffer.push("tail");
    buffer.flushNow();
    expect(getApplied()).toEqual(["tail"]);

    // The armed timer must not fire a second flush with an empty buffer.
    vi.advanceTimersByTime(100);
    expect(getApplied()).toEqual(["tail"]);
  });

  it("dispose cancels a pending flush without applying", () => {
    const { buffer, getApplied } = makeBuffer();

    buffer.push("lost");
    buffer.dispose();
    vi.advanceTimersByTime(100);

    expect(getApplied()).toEqual([]);
  });

  it("never calls apply for an empty buffer", () => {
    const { buffer, getApplied } = makeBuffer();

    buffer.flushNow();
    vi.advanceTimersByTime(100);

    expect(getApplied()).toEqual([]);
  });

  it("uses the custom interval when provided", () => {
    const { buffer, getApplied } = makeBuffer({ intervalMs: 120 });

    buffer.push("x");
    vi.advanceTimersByTime(119);
    expect(getApplied()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(getApplied()).toEqual(["x"]);
  });
});
