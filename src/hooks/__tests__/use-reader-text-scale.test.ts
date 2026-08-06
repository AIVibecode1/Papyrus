// @vitest-environment jsdom
// Plan 064b: the reader explanation text scale (sm/md/lg) persists under
// papyrus-reader-text-scale and clamps at both ends.
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import {
  isReaderTextScale,
  nextScaleDown,
  nextScaleUp,
  READER_TEXT_SCALES,
  useReaderTextScale,
} from "@/hooks/use-reader-text-scale";

const STORAGE_KEY = "papyrus-reader-text-scale";

beforeEach(() => {
  localStorage.clear();
});

describe("scale helpers", () => {
  it("recognizes only the three scales", () => {
    expect(READER_TEXT_SCALES).toEqual(["sm", "md", "lg"]);
    expect(isReaderTextScale("sm")).toBe(true);
    expect(isReaderTextScale("md")).toBe(true);
    expect(isReaderTextScale("lg")).toBe(true);
    expect(isReaderTextScale("xl")).toBe(false);
    expect(isReaderTextScale(null)).toBe(false);
  });

  it("clamps at both ends", () => {
    expect(nextScaleUp("sm")).toBe("md");
    expect(nextScaleUp("lg")).toBe("lg");
    expect(nextScaleDown("lg")).toBe("md");
    expect(nextScaleDown("sm")).toBe("sm");
  });
});

describe("useReaderTextScale", () => {
  it("defaults to md and persists it", () => {
    const { result } = renderHook(() => useReaderTextScale());
    expect(result.current.scale).toBe("md");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("md");
  });

  it("steps up and down and persists", () => {
    const { result } = renderHook(() => useReaderTextScale());
    act(() => result.current.scaleUp());
    expect(result.current.scale).toBe("lg");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("lg");
    act(() => result.current.scaleDown());
    act(() => result.current.scaleDown());
    expect(result.current.scale).toBe("sm");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("sm");
  });

  it("restores a stored scale and ignores corrupted values", () => {
    localStorage.setItem(STORAGE_KEY, "lg");
    const { result } = renderHook(() => useReaderTextScale());
    expect(result.current.scale).toBe("lg");

    localStorage.setItem(STORAGE_KEY, "huge");
    const { result: corrupted } = renderHook(() => useReaderTextScale());
    expect(corrupted.current.scale).toBe("md");
  });
});
