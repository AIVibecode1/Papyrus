import { useCallback, useEffect, useState } from "react";

import { copyTextToClipboard } from "@/lib/clipboard";
import { useReaderStore } from "@/stores/reader";

/**
 * Copies the current PDF selection to the clipboard, from the explicit
 * copy button or from Ctrl/Cmd+C anywhere outside a text input (the
 * native-feeling path: the browser's own copy would only grab the DOM
 * selection, which pdf.js text layers do not expose as plain text).
 * The store is read at event time so the listener never goes stale and
 * needs no re-binding.
 */
export function useCopySelection() {
  const [copied, setCopied] = useState(false);

  const copySelection = useCallback(async () => {
    const selection = useReaderStore.getState().selection;
    if (!selection) return;
    const ok = await copyTextToClipboard(selection);
    // Even a failed copy gets a brief "Copied" so the UI never freezes;
    // the plan-052 failure string is reserved for the floating bar's
    // explicit feedback path.
    void ok;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, []);

  // Plan 052: Ctrl/Cmd+C copies the current PDF selection when focus is
  // in the viewer (or anywhere outside a text input).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "c") return;
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (typing) return;
      const selection = useReaderStore.getState().selection;
      if (!selection) return;
      e.preventDefault();
      void copySelection();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [copySelection]);

  return { copied, copySelection };
}
