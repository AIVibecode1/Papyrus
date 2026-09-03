import { useEffect } from "react";
import type { View } from "@/stores/ui";

/**
 * SPA route-change focus: keyboard/screen-reader users land at the top
 * of the new view instead of being stranded on the control that
 * triggered the switch. Each App branch marks its root with
 * `data-view-root` + `tabIndex={-1}`.
 */
export function useViewFocus(view: View) {
  useEffect(() => {
    document.querySelector<HTMLElement>("[data-view-root]")?.focus({ preventScroll: true });
  }, [view]);
}
