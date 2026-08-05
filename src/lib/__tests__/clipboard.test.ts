// Plan 052: the clipboard helper must resolve (never hang) and fall back
// to execCommand when the async Clipboard API is unavailable.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { copyTextToClipboard } from "@/lib/clipboard";

beforeEach(() => {
  vi.stubGlobal(
    "navigator",
    {
      clipboard: {
        writeText: vi.fn(),
      },
    },
    // jsdom's navigator is read-only; deep-merge our clipboard over it.
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("copyTextToClipboard", () => {
  it("uses the async Clipboard API when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    await expect(copyTextToClipboard("hello")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back to execCommand when the async API hangs or rejects", async () => {
    // A webview that never settles the promise: the helper must time out
    // and use the textarea fallback instead of hanging forever.
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: vi.fn(
          () => new Promise((_resolve) => setTimeout(() => _resolve(undefined), 10_000)),
        ),
      },
      configurable: true,
    });
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", {
      value: execCommand,
      configurable: true,
    });

    await expect(copyTextToClipboard("fallback text")).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("returns false when both paths fail", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: vi.fn(() => Promise.reject(new Error("denied"))),
      },
      configurable: true,
    });
    Object.defineProperty(document, "execCommand", {
      value: vi.fn(() => {
        throw new Error("no execCommand");
      }),
      configurable: true,
    });

    await expect(copyTextToClipboard("nope")).resolves.toBe(false);
  });

  it("returns false for empty text", async () => {
    await expect(copyTextToClipboard("")).resolves.toBe(false);
    await expect(copyTextToClipboard("   ")).resolves.toBe(false);
  });
});
