/**
 * Robust clipboard copy (plan 052): prefers the async Clipboard API,
 * races it against a timeout (some embedded webviews HANG instead of
 * rejecting when the permission is unavailable), then falls back to a
 * hidden textarea + execCommand for restricted contexts. Always
 * resolves; the boolean tells the UI whether to show a failure string.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text.trim()) return false;
  try {
    await Promise.race([
      navigator.clipboard.writeText(text),
      // 1500ms is generous for slow Windows webviews; the async API can
      // hang forever without a permission prompt, so never await it
      // indefinitely.
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("clipboard unavailable")), 1500),
      ),
    ]);
    return true;
  } catch {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const ok = typeof document.execCommand === "function" && document.execCommand("copy");
      textarea.remove();
      return ok;
    } catch {
      // No clipboard surface at all in this context.
      return false;
    }
  }
}
