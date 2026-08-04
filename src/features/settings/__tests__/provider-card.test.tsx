// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderCard } from "@/features/settings/provider-card";
import type { ProviderConfig } from "@/lib/types";

const testProvider = vi.hoisted(() => vi.fn());

vi.mock("@/stores/settings", () => ({
  useSettingsStore: () => ({ testProvider }),
}));

const provider: ProviderConfig = {
  id: "p1",
  name: "OpenRouter",
  baseUrl: "https://openrouter.ai/api/v1",
  model: "deepseek-v4-flash",
};

const noop = () => {};
const asyncNoop = async () => {};

function renderCard(overrides: Partial<Parameters<typeof ProviderCard>[0]> = {}) {
  return render(
    <ProviderCard
      provider={provider}
      isActive={false}
      hasKey
      onSetActive={noop}
      onEdit={noop}
      onDelete={asyncNoop}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("provider card", () => {
  it("renders the provider name and active badge", () => {
    renderCard({ isActive: true });
    expect(screen.getByText("OpenRouter")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("shows URL and model in separate LTR spans", () => {
    renderCard();
    const url = screen.getByText(provider.baseUrl);
    const model = screen.getByText(provider.model);
    expect(url).toHaveAttribute("dir", "ltr");
    expect(model).toHaveAttribute("dir", "ltr");
    // The exact metadata must not be glued into one bidirectional node.
    const row = url.parentElement;
    expect(row?.textContent).toContain(provider.baseUrl);
    expect(row?.textContent).toContain(provider.model);
  });

  it("marks the active-provider button with aria-pressed", () => {
    renderCard({ isActive: true });
    expect(screen.getByRole("button", { name: "Use for explanations" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("requires a two-step confirm before deleting, with focus on the destructive button", () => {
    const onDelete = vi.fn(async () => {});
    renderCard({ onDelete });
    // First click arms the confirmation; deletion must not happen yet.
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByText("Delete this provider and its saved key?")).toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: "Delete" });
    expect(confirm).toHaveFocus();
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(confirm);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("cancelling the confirm keeps the provider", () => {
    const onDelete = vi.fn(async () => {});
    renderCard({ onDelete });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByText("Delete this provider and its saved key?")).not.toBeInTheDocument();
  });

  it("renders translated guidance for a network test failure", async () => {
    testProvider.mockRejectedValueOnce(new Error("error sending request for url"));
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    expect(await screen.findByText(/Network error\./)).toBeInTheDocument();
  });

  it("shows truncated, redacted detail only for unknown failures", async () => {
    testProvider.mockRejectedValueOnce(new Error("odd failure with sk-abc12345XYZ__more9 token"));
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    const msg = await screen.findByText(/odd failure/);
    expect(msg).toHaveAttribute("dir", "ltr");
    expect(msg.textContent).not.toContain("sk-abc12345XYZ__more9");
    expect(msg.textContent).toContain("[redacted]");
  });
});
