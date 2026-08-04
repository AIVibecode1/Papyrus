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
  localStorage.clear();
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
    // The full guidance sentence, not the short category that also
    // appears in the "Last test" chip.
    expect(await screen.findByText(/Network error\. Check your connection/)).toBeInTheDocument();
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

  it("persists a failed test result with its category", async () => {
    testProvider.mockRejectedValueOnce(new Error("HTTP 401: unauthorized key"));
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    await screen.findByText(/Authentication failed\. Check the API key/);
    const memory = JSON.parse(localStorage.getItem("papyrus-provider-test-v1") ?? "{}") as Record<
      string,
      { ok: boolean; category?: string; detail?: string }
    >;
    expect(memory.p1.ok).toBe(false);
    expect(memory.p1.category).toBe("auth");
    // The stored detail must be redacted: no secret-shaped text survives.
    expect(memory.p1.detail).not.toContain("sk-");
  });

  it("shows the remembered last test result across sessions", async () => {
    // A previous session stored a failed auth test for this provider.
    localStorage.setItem(
      "papyrus-provider-test-v1",
      JSON.stringify({
        p1: { ok: false, category: "auth", at: "2026-08-04T00:00:00Z", detail: "HTTP 401" },
      }),
    );
    renderCard();
    // The chip appears without any new test run.
    expect(screen.getByText(/Last test: Failed/)).toBeInTheDocument();
    expect(testProvider).not.toHaveBeenCalled();
  });

  it("remembers a successful test", async () => {
    testProvider.mockResolvedValueOnce("Hello from the model");
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    await screen.findByText(/Last test: OK/);
    const memory = JSON.parse(localStorage.getItem("papyrus-provider-test-v1") ?? "{}") as Record<
      string,
      { ok: boolean }
    >;
    expect(memory.p1.ok).toBe(true);
  });
});
