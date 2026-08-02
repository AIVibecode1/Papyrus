import { useEffect, useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
  Zap,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
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
import { cn } from "@/lib/utils";

const emptyForm = { name: "", baseUrl: "", model: "", key: "" };

export function SettingsPage() {
  const { t } = useTranslation();
  const {
    providers,
    activeProviderId,
    addProvider,
    updateProvider,
    removeProvider,
    setActiveProvider,
    saveKey,
    deleteKey,
    hasKey,
    testProvider,
  } = useSettingsStore();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [preset, setPreset] = useState<string>("custom");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [keyStates, setKeyStates] = useState<Record<string, boolean>>({});
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; msg: string }>>({});

  const refreshKeyStates = () => {
    for (const p of providers) {
      void hasKey(p.id).then((has) =>
        setKeyStates((s) => (s[p.id] === has ? s : { ...s, [p.id]: has })),
      );
    }
  };

  useEffect(() => {
    refreshKeyStates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers.length]);

  const applyPreset = (key: string) => {
    setPreset(key);
    const p = PROVIDER_PRESETS[key];
    if (p) setForm((f) => ({ ...f, baseUrl: p.baseUrl, model: p.model }));
  };

  const openNewForm = () => {
    setEditingId(null);
    setForm(emptyForm);
    setPreset("custom");
    setShowKey(false);
    setFormOpen(true);
  };

  const openEditForm = (p: ProviderConfig) => {
    setEditingId(p.id);
    setForm({ name: p.name, baseUrl: p.baseUrl, model: p.model, key: "" });
    setPreset("custom");
    setShowKey(false);
    setFormOpen(true);
  };

  const handleSave = async () => {
    if (!form.name.trim() || !form.baseUrl.trim() || !form.model.trim()) return;
    setSaving(true);
    try {
      const id = editingId ?? crypto.randomUUID();
      const config: ProviderConfig = {
        id,
        name: form.name.trim(),
        baseUrl: form.baseUrl.trim().replace(/\/+$/, ""),
        model: form.model.trim(),
      };
      if (editingId) updateProvider(config);
      else addProvider(config);
      if (form.key.trim()) {
        await saveKey(id, form.key.trim());
        setKeyStates((s) => ({ ...s, [id]: true }));
      }
      setFormOpen(false);
      setForm(emptyForm);
      setEditingId(null);
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async (p: ProviderConfig) => {
    setTestingId(p.id);
    setTestResults((r) => ({ ...r, [p.id]: { ok: false, msg: "" } }));
    try {
      const reply = await testProvider(p);
      setTestResults((r) => ({ ...r, [p.id]: { ok: true, msg: reply } }));
    } catch (err) {
      setTestResults((r) => ({
        ...r,
        [p.id]: { ok: false, msg: err instanceof Error ? err.message : String(err) },
      }));
    } finally {
      setTestingId(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id);
      return;
    }
    await deleteKey(id).catch(() => undefined);
    removeProvider(id);
    setConfirmDeleteId(null);
  };

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 p-6">
      <h1 className="text-xl font-semibold">{t("settings.title")}</h1>

      <div className="mt-4 flex items-center gap-2 rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
        <ShieldCheck className="size-4 shrink-0" />
        {t("settings.securityNote")}
      </div>

      <div className="mt-6 flex items-center justify-between">
        <h2 className="text-base font-semibold">{t("settings.providers")}</h2>
        <Button size="sm" onClick={openNewForm}>
          <Plus className="size-4" />
          {t("settings.addProvider")}
        </Button>
      </div>

      {providers.length === 0 && !formOpen && (
        <p className="mt-4 text-sm text-muted-foreground">{t("settings.noProviders")}</p>
      )}

      <div className="mt-3 flex flex-col gap-3">
        {providers.map((p) => (
          <Card key={p.id}>
            <CardContent className="flex flex-col gap-3 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{p.name}</span>
                  {activeProviderId === p.id && (
                    <Badge variant="default" className="text-xs">
                      {t("settings.active")}
                    </Badge>
                  )}
                  {keyStates[p.id] ? (
                    <Badge variant="secondary" className="gap-1 text-xs">
                      <CheckCircle2 className="size-3" />
                      {t("settings.keySaved")}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="gap-1 text-xs text-muted-foreground">
                      <CircleAlert className="size-3" />
                      {t("settings.keyMissing")}
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void handleTest(p)}
                    disabled={testingId === p.id}
                  >
                    {testingId === p.id ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Zap className="size-3.5" />
                    )}
                    {testingId === p.id ? t("settings.testing") : t("settings.test")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setActiveProvider(p.id)}>
                    {t("settings.setActive")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => openEditForm(p)}>
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant={confirmDeleteId === p.id ? "destructive" : "ghost"}
                    onClick={() => void handleDelete(p.id)}
                  >
                    <Trash2 className="size-3.5" />
                    {confirmDeleteId === p.id ? t("settings.confirmDelete") : ""}
                  </Button>
                </div>
              </div>

              <p className="break-all font-mono text-xs text-muted-foreground">
                {p.baseUrl} · {p.model}
              </p>

              {testResults[p.id] && (
                <p
                  className={cn(
                    "text-xs",
                    testResults[p.id].ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive",
                  )}
                >
                  {testResults[p.id].ok
                    ? t("settings.testOk", { reply: testResults[p.id].msg })
                    : `${t("settings.testFailed")}: ${testResults[p.id].msg}`}
                </p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {formOpen && (
        <Card className="mt-4 border-primary/40">
          <CardHeader>
            <CardTitle className="text-base">
              {editingId ? t("settings.editProvider") : t("settings.addProvider")}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {!editingId && (
              <div className="flex flex-col gap-2">
                <Label>{t("settings.preset")}</Label>
                <Select value={preset} onValueChange={applyPreset}>
                  <SelectTrigger className="w-full sm:w-72">
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
              <Label htmlFor="provider-name">{t("settings.name")}</Label>
              <Input
                id="provider-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="My Provider"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="provider-url">{t("settings.baseUrl")}</Label>
              <Input
                id="provider-url"
                dir="ltr"
                value={form.baseUrl}
                onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
                placeholder="https://api.example.com/v1"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="provider-model">{t("settings.model")}</Label>
              <Input
                id="provider-model"
                dir="ltr"
                value={form.model}
                onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
                placeholder="gpt-4o-mini"
              />
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
              <Button variant="outline" onClick={() => setFormOpen(false)}>
                {t("settings.cancel")}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
