import type { ProviderConfig, ProviderPresetModel } from "@/lib/types";

export interface ProviderFormErrors {
  baseUrl?: string;
  model?: string;
}

/**
 * Pure validation for the provider add/edit form. Extracted from
 * ProviderForm so the rules are unit-testable without mounting the
 * component (and without the i18n/store layers).
 *
 * @param t message formatter: `t("settings.urlRequired")` etc.
 */
export function validateProviderForm(
  baseUrl: string,
  model: string,
  preset: string,
  t: (key: string) => string,
): ProviderFormErrors {
  const errors: ProviderFormErrors = {};
  const url = baseUrl.trim();
  const modelId = model.trim();
  if (!url) {
    errors.baseUrl = t("settings.urlRequired");
  } else if (preset === "custom" && !/^https?:\/\//i.test(url)) {
    errors.baseUrl = t("settings.urlInvalid");
  }
  if (!modelId) errors.model = t("settings.modelRequired");
  return errors;
}

/**
 * Builds the stored provider config from the trimmed form values. The
 * display name is the preset model label when the model came from a
 * picker (e.g. "DeepSeek V4 Flash"), otherwise the model id itself.
 */
export function buildProviderConfig(
  id: string,
  baseUrl: string,
  model: string,
  presetModels: ProviderPresetModel[] | undefined,
): ProviderConfig {
  const label = presetModels?.find((m) => m.id === model)?.label;
  return {
    id,
    name: (label ?? model).trim(),
    baseUrl: baseUrl.trim().replace(/\/+$/, ""),
    model: model.trim(),
  };
}
