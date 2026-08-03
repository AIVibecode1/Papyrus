import { useState } from "react";
import { Eye, EyeOff, KeyRound, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
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
import { PROVIDER_PRESETS, type ProviderConfig } from "@/lib/types";
import { useSettingsStore } from "@/stores/settings";

interface ProviderFormProps {
  editingId: string | null;
  initial: { baseUrl: string; model: string };
  onCancel: () => void;
  onSaved: () => void;
  onKeySaved: (id: string) => void;
}

export function ProviderForm({
  editingId,
  initial,
  onCancel,
  onSaved,
  onKeySaved,
}: ProviderFormProps) {
  const { t } = useTranslation();
  const { addProvider, updateProvider, saveKey } = useSettingsStore();

  const [form, setForm] = useState(() => ({
    baseUrl: initial.baseUrl,
    model: initial.model,
    key: "",
  }));
  const [preset, setPreset] = useState<string>("custom");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);

  // Preset base URLs are fixed; only Custom lets the user type one.
  const urlLocked = !editingId && preset !== "custom";
  const presetModels =
    !editingId && preset !== "custom" ? (PROVIDER_PRESETS[preset]?.models ?? undefined) : undefined;

  const applyPreset = (key: string) => {
    setPreset(key);
    const p = PROVIDER_PRESETS[key];
    if (p) setForm((f) => ({ ...f, baseUrl: p.baseUrl, model: p.model }));
  };

  const handleSave = async () => {
    if (!form.baseUrl.trim() || !form.model.trim()) return;
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
                {Object.entries(PROVIDER_PRESETS).map(([key, p]) => (
                  <SelectItem key={key} value={key}>
                    {t(p.key)}
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
            onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
            placeholder="https://api.example.com/v1"
            disabled={urlLocked}
          />
          {urlLocked && <p className="text-xs text-muted-foreground">{t("settings.urlLocked")}</p>}
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
              onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
              placeholder="gpt-4o-mini"
            />
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
