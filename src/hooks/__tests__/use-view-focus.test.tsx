// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useViewFocus } from "@/hooks/use-view-focus";
import type { View } from "@/stores/ui";

describe("useViewFocus", () => {
  it("moves focus to the view root when the view changes", () => {
    document.body.innerHTML = `<button id="trigger">go</button><main data-view-root tabindex="-1">papers</main>`;
    document.getElementById("trigger")?.focus();
    expect(document.activeElement?.id).toBe("trigger");

    const { rerender } = renderHook(({ view }: { view: View }) => useViewFocus(view), {
      initialProps: { view: "papers" as View },
    });
    expect(document.activeElement?.tagName).toBe("MAIN");

    // Switching views re-focuses the (new) root instead of leaving
    // focus on the control that triggered the switch.
    document.body.innerHTML = `<button id="trigger">go</button><div data-view-root tabindex="-1">reader</div>`;
    document.getElementById("trigger")?.focus();
    rerender({ view: "reader" });
    expect(document.activeElement?.textContent).toBe("reader");
  });
});
