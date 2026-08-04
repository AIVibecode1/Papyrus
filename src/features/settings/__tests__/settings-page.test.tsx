// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsPage } from "@/features/settings/settings-page";
import type { ProviderConfig } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  setView: vi.fn(),
  setThemeTo: vi.fn(),
  setSource: vi.fn(),
  setActiveProvider: vi.fn(),
  removeProvider: vi.fn(),
  deleteKey: vi.fn(async () => {}),
  hasKey: vi.fn(async () => true),
  exportSavedData: vi.fn(async () => "/tmp/papyrus-export.json"),
  providers: [] as ProviderConfig[],
  activeProviderId: null as string | null,
}));

vi.mock("@/stores/ui", () => ({ useUiStore: () => ({ setView: mocks.setView }) }));
vi.mock("@/hooks/use-theme", () => ({
  useTheme: () => ({ theme: "light", setThemeTo: mocks.setThemeTo }),
}));
vi.mock("@/stores/papers", () => ({
  usePapersStore: () => ({ source: "arxiv", setSource: mocks.setSource }),
}));
vi.mock("@/stores/settings", () => ({
  useSettingsStore: () => ({
    providers: mocks.providers,
    activeProviderId: mocks.activeProviderId,
    removeProvider: mocks.removeProvider,
    setActiveProvider: mocks.setActiveProvider,
    deleteKey: mocks.deleteKey,
    hasKey: mocks.hasKey,
  }),
}));
vi.mock("@/lib/export", () => ({ exportSavedData: mocks.exportSavedData }));

const provider: ProviderConfig = {
  id: "p1",
  name: "OpenRouter",
  baseUrl: "https://openrouter.ai/api/v1",
  model: "deepseek-v4-flash",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.providers = [];
  mocks.activeProviderId = null;
});

describe("settings page", () => {
  it("groups the four task sections with accessible headings", () => {
    mocks.providers = [provider];
    mocks.activeProviderId = "p1";
    render(<SettingsPage />);
    const headings = screen.getAllByRole("heading", { level: 2 });
    expect(headings.map((h) => h.textContent)).toEqual([
      "Appearance",
      "Paper source",
      "Data",
      "AI Providers",
    ]);
    // Each section is labelled by its heading.
    for (const h of headings) {
      expect(h.closest("section")).toHaveAttribute("aria-labelledby", h.id);
    }
  });

  it("shows the active provider and switches it with the Use control", () => {
    mocks.providers = [provider, { ...provider, id: "p2", name: "Groq" }];
    mocks.activeProviderId = "p1";
    render(<SettingsPage />);
    expect(screen.getByText("Active")).toBeInTheDocument();
    const useButtons = screen.getAllByRole("button", { name: "Use for explanations" });
    expect(useButtons[0]).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(useButtons[1]);
    expect(mocks.setActiveProvider).toHaveBeenCalledWith("p2");
  });

  it("runs the export flow and shows the saved path", async () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Export my data" }));
    expect(await screen.findByText(/papyrus-export\.json/)).toBeInTheDocument();
  });

  it("opens the provider form from the Add button", () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
    expect(screen.getByText("Base URL")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("shows the version line", () => {
    render(<SettingsPage />);
    expect(screen.getByText(/Papyrus/)).toBeInTheDocument();
  });
});
