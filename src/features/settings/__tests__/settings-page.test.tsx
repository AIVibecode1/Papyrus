// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsPage } from "@/features/settings/settings-page";
import type { ProviderConfig } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  setView: vi.fn(),
  setThemeTo: vi.fn(),
  setSource: vi.fn(),
  setActiveProvider: vi.fn(),
  removeProvider: vi.fn(),
  setArabicFontTo: vi.fn(),
  deleteKey: vi.fn(async () => {}),
  hasKey: vi.fn(async () => true),
  exportSavedData: vi.fn(async () => "/tmp/papyrus-export.json"),
  importSavedData: vi.fn(async () => ({
    app: "papyrus",
    favorites: 2,
    chats: 1,
    notes: 0,
    readingHistory: 3,
  })),
  invoke: vi.fn(async () => {}),
  providers: [] as ProviderConfig[],
  activeProviderId: null as string | null,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

vi.mock("@/stores/ui", () => ({ useUiStore: () => ({ setView: mocks.setView }) }));
vi.mock("@/hooks/use-theme", () => ({
  useTheme: () => ({
    theme: "light",
    setThemeTo: mocks.setThemeTo,
    arabicFont: "plex",
    setArabicFontTo: mocks.setArabicFontTo,
  }),
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
vi.mock("@/lib/export", () => ({
  exportSavedData: mocks.exportSavedData,
  importSavedData: mocks.importSavedData,
}));

const provider: ProviderConfig = {
  id: "p1",
  name: "OpenRouter",
  baseUrl: "https://openrouter.ai/api/v1",
  model: "deepseek-v4-flash",
};

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn(); // Radix Select in jsdom
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

  it("runs the import flow from a chosen file and shows the summary", async () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Import data" }));
    const input = document.querySelector('input[type="file"]');
    expect(input).not.toBeNull();
    const file = new File(['{"app":"papyrus","favorites":[],"chat":{}}'], "export.json", {
      type: "application/json",
    });
    fireEvent.change(input!, { target: { files: [file] } });

    expect(
      await screen.findByText(
        /Imported 2 saved papers, 1 chat transcripts, 0 notes and 3 history entries/,
      ),
    ).toBeInTheDocument();
    expect(mocks.importSavedData).toHaveBeenCalledWith(
      '{"app":"papyrus","favorites":[],"chat":{}}',
    );
  });

  it("clears caches and saved data after a confirmation, keeping providers", async () => {
    localStorage.setItem("papyrus-digest-v2", "{}");
    localStorage.setItem("papyrus-favorites", "{}");
    localStorage.setItem("papyrus-reader-chat-v1", "{}");
    localStorage.setItem("papyrus-providers", "[{}]");
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { reload },
    });

    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Clear cache and saved data" }));
    // The destructive action requires an explicit confirmation.
    expect(screen.getByText(/Continue\?/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear everything" }));

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("clear_app_cache"));
    expect(localStorage.getItem("papyrus-digest-v2")).toBeNull();
    expect(localStorage.getItem("papyrus-favorites")).toBeNull();
    expect(localStorage.getItem("papyrus-reader-chat-v1")).toBeNull();
    // Providers are explicitly kept.
    expect(localStorage.getItem("papyrus-providers")).not.toBeNull();
    expect(reload).toHaveBeenCalled();
  });

  it("cancelling the clear confirmation keeps the data", () => {
    localStorage.setItem("papyrus-favorites", "{}");
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Clear cache and saved data" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(localStorage.getItem("papyrus-favorites")).not.toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("opens the provider form from the Add button", () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
    expect(screen.getByText("Base URL")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("empty state offers quick-add CTAs that prefill the preset", () => {
    render(<SettingsPage />);
    expect(
      screen.getByText("No providers yet. Add one to start explaining papers."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add DeepSeek" }));
    // The form opens with the DeepSeek preset's URL prefilled and the
    // model picker showing the preset's default model label.
    expect(screen.getByDisplayValue("https://api.deepseek.com/v1")).toBeInTheDocument();
    expect(screen.getByText("DeepSeek Chat")).toBeInTheDocument();
  });

  it("shows the version line", () => {
    render(<SettingsPage />);
    expect(screen.getByText(/Papyrus/)).toBeInTheDocument();
  });

  it("offers the Arabic font choice in the appearance section (plan 064)", () => {
    render(<SettingsPage />);
    expect(screen.getByText("Arabic font")).toBeInTheDocument();
    // The select shows the default and both options are listed.
    const trigger = screen.getByRole("combobox", { name: "Arabic font" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: "Amiri (Naskh serif)" }));
    expect(mocks.setArabicFontTo).toHaveBeenCalledWith("amiri");
  });

  it("deletes a provider that has no stored key", async () => {
    // Regression: a keyless provider (Ollama, or any provider whose key
    // was cleared) made the backend reject the delete with "No matching
    // entry found", so the row could never be removed. The backend now
    // treats a missing entry as success, and the row must go with it.
    mocks.providers = [provider];
    mocks.activeProviderId = "p1";
    render(<SettingsPage />);

    const del = screen.getAllByRole("button", { name: /^Delete/ })[0];
    fireEvent.click(del);
    // Confirm in the dialog.
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(mocks.deleteKey).toHaveBeenCalledWith("p1"));
    expect(mocks.removeProvider).toHaveBeenCalledWith("p1");
  });
});
