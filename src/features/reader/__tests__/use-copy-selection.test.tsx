// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

import { useCopySelection } from "@/features/reader/use-copy-selection";
import { useReaderStore } from "@/stores/reader";

/** Installs a fake clipboard and returns its spy. */
function fakeClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
    writable: true,
  });
  return writeText;
}

/** Presses Ctrl+C (or Cmd+C on a Mac-shaped event) on `target`. */
function pressCopy(target: EventTarget, modifiers: { ctrlKey?: boolean; metaKey?: boolean } = {}) {
  const event = new KeyboardEvent("keydown", {
    key: "c",
    bubbles: true,
    cancelable: true,
    ctrlKey: modifiers.ctrlKey ?? true,
    metaKey: modifiers.metaKey ?? false,
  });
  target.dispatchEvent(event);
  return event;
}

/** A visible text node inside a non-input element (the AI panel's answer). */
function makeDomSelection(text: string): {
  element: HTMLElement;
  remove: () => void;
} {
  const holder = document.createElement("div");
  holder.innerHTML = `<p id="ai-answer">${text}</p>`;
  document.body.appendChild(holder);
  const node = holder.querySelector("#ai-answer")?.firstChild ?? null;
  const range = document.createRange();
  if (node) {
    range.selectNodeContents(node);
  }
  const selection = window.getSelection();
  selection?.removeAllRanges();
  if (node) selection?.addRange(range);
  return { element: holder, remove: () => holder.remove() };
}

describe("useCopySelection", () => {
  beforeEach(() => {
    useReaderStore.setState({ selection: null });
    window.getSelection()?.removeAllRanges();
    document.body.innerHTML = "";
  });

  it("copies the PDF selection on Ctrl+C when nothing else is selected", async () => {
    const writeText = fakeClipboard();
    useReaderStore.setState({ selection: "attention is all you need" });
    renderHook(() => useCopySelection());

    const event = pressCopy(window);
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("attention is all you need"));
    // The handler owns the event: the native copy must not double-fire.
    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves Ctrl+C alone when the user has selected text in the AI panel", async () => {
    const writeText = fakeClipboard();
    useReaderStore.setState({ selection: "attention is all you need" });
    const { element } = makeDomSelection("a streamed answer the user wants to copy");
    renderHook(() => useCopySelection());

    const event = pressCopy(window);
    await Promise.resolve();

    // The visible selection wins: hijacking here would silently copy the
    // PDF quote instead of the answer the user actually highlighted.
    expect(writeText).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    element.remove();
  });

  it("leaves Ctrl+C alone while typing in a text field", async () => {
    const writeText = fakeClipboard();
    useReaderStore.setState({ selection: "attention is all you need" });
    const input = document.createElement("input");
    document.body.appendChild(input);
    renderHook(() => useCopySelection());

    const event = pressCopy(input);
    await Promise.resolve();

    expect(writeText).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    input.remove();
  });

  it("does nothing when there is no PDF selection", async () => {
    const writeText = fakeClipboard();
    renderHook(() => useCopySelection());

    const event = pressCopy(window);
    await Promise.resolve();

    expect(writeText).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("honours Cmd+C as well as Ctrl+C", async () => {
    const writeText = fakeClipboard();
    useReaderStore.setState({ selection: "cmd path" });
    renderHook(() => useCopySelection());

    pressCopy(window, { ctrlKey: false, metaKey: true });
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("cmd path"));
  });
});
