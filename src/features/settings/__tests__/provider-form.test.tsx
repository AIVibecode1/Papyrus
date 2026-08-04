// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PROVIDER_PRESETS } from "@/lib/types";
import { ProviderForm } from "@/features/settings/provider-form";

const { addProvider, updateProvider, saveKey } = vi.hoisted(() => ({
  addProvider: vi.fn(),
  updateProvider: vi.fn(),
  saveKey: vi.fn(),
}));

vi.mock("@/stores/settings", () => ({
  useSettingsStore: () => ({ addProvider, updateProvider, saveKey }),
}));

const EMPTY = { baseUrl: "", model: "" };
const noop = () => {};

function renderForm(editingId: string | null = null, initial = EMPTY) {
  return render(
    <ProviderForm
      editingId={editingId}
      initial={initial}
      onCancel={noop}
      onSaved={noop}
      onKeySaved={noop}
    />,
  );
}

async function pickPreset(name: string) {
  fireEvent.click(screen.getByRole("combobox", { name: "Preset" }));
  fireEvent.click(await screen.findByRole("option", { name }));
}

beforeEach(() => {
  vi.clearAllMocks();
  // Radix Select scrolls the highlighted option into view on open;
  // jsdom does not implement scrollIntoView.
  Element.prototype.scrollIntoView = vi.fn();
});

describe("provider presets", () => {
  it("ships the OpenCode Go preset with the DeepSeek V4 Flash model", () => {
    expect(PROVIDER_PRESETS.opencode).toEqual({
      key: "presets.opencode",
      baseUrl: "https://opencode.ai/zen/go/v1/chat/completions",
      model: "deepseek-v4-flash",
      keyRequired: true,
      models: [{ id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" }],
    });
  });

  it("lists DeepSeek models in the DeepSeek preset", () => {
    expect(PROVIDER_PRESETS.deepseek.models).toEqual([
      { id: "deepseek-chat", label: "DeepSeek Chat" },
      { id: "deepseek-reasoner", label: "DeepSeek Reasoner" },
    ]);
  });
});

describe("ProviderForm", () => {
  it("locks the preset URL and derives the provider name from the model label", async () => {
    renderForm();
    await pickPreset("DeepSeek");

    const url = screen.getByLabelText("Base URL") as HTMLInputElement;
    expect(url.value).toBe("https://api.deepseek.com/v1");
    expect(url.disabled).toBe(true);
    expect(screen.getByText(/fixed by the preset/)).toBeInTheDocument();

    // No name field anymore: the model picker stands in its place.
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();

    // Switch the model in the preset's picker.
    fireEvent.click(screen.getByRole("combobox", { name: "Model" }));
    fireEvent.click(await screen.findByRole("option", { name: "DeepSeek Reasoner" }));

    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-test" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(addProvider).toHaveBeenCalledWith({
        id: expect.any(String),
        name: "DeepSeek Reasoner",
        baseUrl: "https://api.deepseek.com/v1",
        model: "deepseek-reasoner",
      }),
    );
    expect(saveKey).toHaveBeenCalledWith(expect.any(String), "sk-test");
  });

  it("keeps the URL editable in Custom and names the provider by the model id", () => {
    renderForm();
    const url = screen.getByLabelText("Base URL") as HTMLInputElement;
    expect(url.disabled).toBe(false);

    fireEvent.change(url, { target: { value: "https://gateway.example.com/v1" } });
    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "my-model" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(addProvider).toHaveBeenCalledWith({
      id: expect.any(String),
      name: "my-model",
      baseUrl: "https://gateway.example.com/v1",
      model: "my-model",
    });
  });

  it("keeps the URL editable when editing an existing provider", () => {
    renderForm("prov-1", { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" });
    const url = screen.getByLabelText("Base URL") as HTMLInputElement;
    expect(url.disabled).toBe(false);
    // No preset picker in edit mode: the model stays a free input.
    expect(screen.queryByRole("combobox", { name: "Preset" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Model")).toHaveValue("gpt-4o-mini");
    expect(updateProvider).not.toHaveBeenCalled();
  });

  it("shows inline errors for missing URL and model and does not save", () => {
    renderForm();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Base URL is required.")).toBeInTheDocument();
    expect(screen.getByText("Model is required.")).toBeInTheDocument();
    expect(addProvider).not.toHaveBeenCalled();
    // Errors are wired to their fields for assistive tech.
    expect(screen.getByLabelText("Base URL")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Base URL")).toHaveAttribute(
      "aria-describedby",
      "provider-url-error",
    );
    expect(screen.getByLabelText("Model")).toHaveAttribute(
      "aria-describedby",
      "provider-model-error",
    );
  });

  it("rejects a custom URL that is not http(s)", () => {
    renderForm();
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "not-a-url" } });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "m" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText(/valid URL/)).toBeInTheDocument();
    expect(addProvider).not.toHaveBeenCalled();
  });

  it("clears the URL error as soon as the user types a valid value", () => {
    renderForm();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Base URL is required.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Base URL"), {
      target: { value: "https://api.example.com/v1" },
    });
    expect(screen.queryByText("Base URL is required.")).not.toBeInTheDocument();
  });

  it("surfaces a keychain save failure in the live region", async () => {
    saveKey.mockRejectedValueOnce(new Error("keychain locked"));
    renderForm();
    fireEvent.change(screen.getByLabelText("Base URL"), {
      target: { value: "https://api.example.com/v1" },
    });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "m" } });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-test" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/keychain locked/)).toBeInTheDocument();
    expect(screen.getByText(/keychain locked/).closest("[aria-live]")).not.toBeNull();
    expect(addProvider).toHaveBeenCalledTimes(1); // config is still saved
  });

  it("shows validation messages in Arabic", async () => {
    const { default: i18n } = await import("@/i18n");
    await i18n.changeLanguage("ar");
    renderForm();
    fireEvent.click(screen.getByRole("button", { name: "حفظ" }));
    expect(screen.getByText("رابط الأساس مطلوب.")).toBeInTheDocument();
    expect(screen.getByText("النموذج مطلوب.")).toBeInTheDocument();
    await i18n.changeLanguage("en");
  });
});
