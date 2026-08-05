import { beforeEach, describe, expect, it } from "vitest";
import { useUiStore } from "@/stores/ui";

describe("ui store", () => {
  beforeEach(() => {
    useUiStore.setState({ view: "papers" });
  });

  it("defaults to the papers feed", () => {
    expect(useUiStore.getState().view).toBe("papers");
  });

  it("accepts every view including the notes route slot", () => {
    const { setView } = useUiStore.getState();
    for (const view of ["papers", "reader", "settings", "notes"] as const) {
      setView(view);
      expect(useUiStore.getState().view).toBe(view);
    }
  });
});
