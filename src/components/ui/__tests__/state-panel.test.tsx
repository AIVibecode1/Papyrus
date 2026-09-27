// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StatePanel } from "@/components/ui/state-panel";

const icon = <span data-testid="icon" />;

describe("StatePanel", () => {
  it("announces a loading state instead of swapping in silently", () => {
    // Without a live region, a screen reader user gets no signal that work
    // started or finished. role="status" implies aria-live="polite", so the
    // transition is announced without stealing focus.
    render(<StatePanel icon={icon} title="Loading papers…" busy muted />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveTextContent("Loading papers…");
  });

  it("hides a busy icon from assistive tech (the title is the message)", () => {
    render(<StatePanel icon={icon} title="Loading" busy />);
    expect(screen.getByTestId("icon").parentElement).toHaveAttribute("aria-hidden", "true");
  });

  it("stays silent for empty and error states", () => {
    // An empty list is not an event worth announcing on every render.
    const { rerender } = render(<StatePanel icon={icon} title="No notes yet" muted />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    rerender(<StatePanel icon={icon} title="Could not load" tone="destructive" />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows a description and action when given", () => {
    render(
      <StatePanel
        icon={icon}
        title="Could not load notes."
        description="disk error"
        action={<button type="button">Try again</button>}
        tone="destructive"
      />,
    );
    expect(screen.getByText("disk error")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});
