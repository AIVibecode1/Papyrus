import { describe, expect, it } from "vitest";

import { buildProviderConfig, validateProviderForm } from "@/features/settings/provider-form-logic";

const t = (key: string) => key;

describe("validateProviderForm", () => {
  it("requires both url and model", () => {
    expect(validateProviderForm("", "", "custom", t)).toEqual({
      baseUrl: "settings.urlRequired",
      model: "settings.modelRequired",
    });
  });

  it("rejects non-http(s) urls for the custom preset only", () => {
    expect(validateProviderForm("ftp://x", "m", "custom", t)).toEqual({
      baseUrl: "settings.urlInvalid",
    });
    // Preset urls are fixed by the app, so any stored value passes.
    expect(validateProviderForm("ftp://x", "m", "openai", t)).toEqual({});
  });

  it("accepts trimmed values", () => {
    expect(validateProviderForm("  https://x.ai/v1  ", "  m1  ", "custom", t)).toEqual({});
  });
});

describe("buildProviderConfig", () => {
  it("uses the preset model label as the display name", () => {
    const config = buildProviderConfig("id1", "https://x.ai/v1/", "deepseek-v4-flash", [
      { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
    ]);
    expect(config).toEqual({
      id: "id1",
      name: "DeepSeek V4 Flash",
      baseUrl: "https://x.ai/v1",
      model: "deepseek-v4-flash",
    });
  });

  it("falls back to the model id and strips trailing slashes", () => {
    const config = buildProviderConfig("id2", "https://x.ai/v1///", "gpt-4o-mini", undefined);
    expect(config.name).toBe("gpt-4o-mini");
    expect(config.baseUrl).toBe("https://x.ai/v1");
  });
});
