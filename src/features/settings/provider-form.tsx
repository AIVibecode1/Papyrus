import { useState } from "react";
import { CheckCircle2, ExternalLink, Eye, EyeOff, KeyRound, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { listProviderPresets, PROVIDER_PRESETS, type ProviderConfig } from "@/lib/types";
import { redactSecrets, truncateError } from "@/lib/provider-errors";
import { useSettingsStore } from "@/stores/settings";

interface ProviderFormProps {
  editingId: string | null;
  initial: { baseUrl: string; model: string };
  /** Preset to start from (quick-add from the empty state). */
  initialPreset?: string;
  onCancel: () => void;
  onSaved: () => void;
  onKeySaved: (id: string) => void;
}

interface FieldErrors {
  baseUrl?: string;
  model?: string;
}

export function ProviderForm({
  editingId,
  initial,
  initialPreset,
  onCancel,
  onSaved,
  onKeySaved,
}: ProviderFormProps) {
  const { t } = useTranslation();
  const { addProvider, updateProvider, saveKey } = useSettingsStore();

  const [form, setForm] = useState(() => {
    const preset = initialPreset ? PROVIDER_PRESETS[initialPreset] : undefined;
    return {
      baseUrl: initial.baseUrl || preset?.baseUrl || "",
      model: initial.model || preset?.model || "",
      key: "",
    };
  });
  const [preset, setPreset] = useState<string>(initialPreset ?? "custom");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [saveError, setSaveError] = useState<string | null>(null);

  // Preset base URLs are fixed; only Custom lets the user type one.
  const urlLocked = !editingId && preset !== "custom";
  const presetModels =
    !editingId && preset !== "custom" ? (PROVIDER_PRESETS[preset]?.models ?? undefined) : undefined;

  const applyPreset = (key: string) => {
    setPreset(key);
    setFieldErrors((e) => ({ ...e, baseUrl: undefined }));
    const p = PROVIDER_PRESETS[key];
    if (p) setForm((f) => ({ ...f, baseUrl: p.baseUrl, model: p.model }));
  };

  // The Codex help block links to OpenAI's key-management page through
  // the opener plugin (paper-card uses the same pattern for PDF links).
  const openApiKeysPage = () => {
    const url = "https://platform.openai.com/api-keys";
    if ("__TAURI_INTERNALS__" in window) {
      void openUrl(url).catch(() => window.open(url, "_blank", "noreferrer"));
    } else {
      window.open(url, "_blank", "noreferrer");
    }
  };

  const validate = (): boolean => {
    const errors: FieldErrors = {};
    const url = form.baseUrl.trim();
    const model = form.model.trim();
    if (!url) {
      errors.baseUrl = t("settings.urlRequired");
    } else if (preset === "custom" && !/^https?:\/\//i.test(url)) {
      errors.baseUrl = t("settings.urlInvalid");
    }
    if (!model) errors.model = t("settings.modelRequired");
    setFieldErrors(errors);
    return errors.baseUrl === undefined && errors.model === undefined;
  };

  const handleSave = async () => {
    setSaveError(null);
    if (!validate()) return;
    setSaving(true);
    try {
      const id = editingId ?? crypto.randomUUID();
      // The provider name is the model: the preset label when a picker
      // is used (e.g. "DeepSeek V4 Flash"), otherwise the model id.
      const label = presetModels?.find((m) => m.id === form.model)?.label;
      const config: ProviderConfig = {
        id,
        name: (label ?? form.model).trim(),
        baseUrl: form.baseUrl.trim().replace(/\/+$/, ""),
        model: form.model.trim(),
      };
      if (editingId) updateProvider(config);
      else addProvider(config);
      if (form.key.trim()) {
        await saveKey(id, form.key.trim());
        onKeySaved(id);
      }
      onSaved();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="mt-4 border-primary/40">
      <CardHeader>
        <CardTitle className="text-base">
          {editingId ? t("settings.editProvider") : t("settings.addProvider")}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!editingId && (
          <div className="flex flex-col gap-2">
            <Label htmlFor="provider-preset">{t("settings.preset")}</Label>
            <Select value={preset} onValueChange={applyPreset}>
              <SelectTrigger id="provider-preset" className="w-full sm:w-72">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="custom">{t("settings.custom")}</SelectItem>
                {listProviderPresets().map(({ id, preset }) => (
                  <SelectItem key={id} value={id}>
                    {t(preset.key)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <Label htmlFor="provider-url">{t("settings.baseUrl")}</Label>
          <Input
            id="provider-url"
            dir="ltr"
            value={form.baseUrl}
            onChange={(e) => {
              setForm((f) => ({ ...f, baseUrl: e.target.value }));
              if (fieldErrors.baseUrl) setFieldErrors((f) => ({ ...f, baseUrl: undefined }));
            }}
            placeholder="https://api.example.com/v1"
            disabled={urlLocked}
            aria-invalid={fieldErrors.baseUrl ? true : undefined}
            aria-describedby={fieldErrors.baseUrl ? "provider-url-error" : undefined}
          />
          {urlLocked && <p className="text-xs text-muted-foreground">{t("settings.urlLocked")}</p>}
          {fieldErrors.baseUrl && (
            <p id="provider-url-error" className="text-xs text-destructive">
              {fieldErrors.baseUrl}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="provider-model">{t("settings.model")}</Label>
          {presetModels ? (
            <Select value={form.model} onValueChange={(v) => setForm((f) => ({ ...f, model: v }))}>
              <SelectTrigger id="provider-model" className="w-full sm:w-72" dir="ltr">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {presetModels.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              id="provider-model"
              dir="ltr"
              value={form.model}
              onChange={(e) => {
                setForm((f) => ({ ...f, model: e.target.value }));
                if (fieldErrors.model) setFieldErrors((f) => ({ ...f, model: undefined }));
              }}
              placeholder="gpt-4o-mini"
              aria-invalid={fieldErrors.model ? true : undefined}
              aria-describedby={fieldErrors.model ? "provider-model-error" : undefined}
            />
          )}
          {fieldErrors.model && (
            <p id="provider-model-error" className="text-xs text-destructive">
              {fieldErrors.model}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="provider-key">{t("settings.apiKey")}</Label>
          <div className="relative">
            <Input
              id="provider-key"
              dir="ltr"
              type={showKey ? "text" : "password"}
              value={form.key}
              onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))}
              placeholder="sk-…"
              autoComplete="off"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute end-1 top-1/2 size-7 -translate-y-1/2"
              onClick={() => setShowKey((v) => !v)}
              aria-label={showKey ? t("settings.hideKey") : t("settings.showKey")}
            >
              {showKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </Button>
          </div>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <KeyRound className="size-3" />
            {t("settings.keyHint")}
          </p>
          {preset === "codex" && (
            <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
              <p>{t("settings.codexHelp")}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2 h-7 text-xs"
                onClick={openApiKeysPage}
              >
                <ExternalLink className="size-3" />
                {t("settings.codexOpenKeys")}
              </Button>
              <details className="mt-2">
                <summary className="cursor-pointer">{t("settings.codexChecklistTitle")}</summary>
                <ul className="mt-2 flex list-inside list-disc flex-col gap-1">
                  <li>
                    <CheckCircle2 className="me-1 inline size-3 text-primary" />
                    {t("settings.codexChecklistKey")}
                  </li>
                  <li>{t("settings.codexChecklistBilling")}</li>
                  <li>{t("settings.codexChecklistModel")}</li>
                </ul>
              </details>
            </div>
          )}
        </div>

        <div aria-live="polite">
          {saveError && (
            <p className="text-xs text-destructive">
              {t("settings.saveFailed", {
                error: truncateError(redactSecrets(saveError)),
              })}
            </p>
          )}
        </div>

        <div className="flex gap-2">
          <Button onClick={() => void handleSave()} disabled={saving}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            {t("settings.save")}
          </Button>
          <Button variant="outline" onClick={onCancel}>
            {t("settings.cancel")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
