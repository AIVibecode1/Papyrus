import { useEffect, useState } from "react";
import { ArrowLeft, Plus, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { PaperSource } from "@/lib/arxiv";
import type { ProviderConfig } from "@/lib/types";
import { useTheme, type ArabicFont, type Theme } from "@/hooks/use-theme";
import { usePapersStore } from "@/stores/papers";
import { useSettingsStore } from "@/stores/settings";
import { useUiStore } from "@/stores/ui";
import { ProviderCard } from "./provider-card";
import { ProviderForm } from "./provider-form";
import { DataSection } from "./settings-data-section";
import pkg from "../../../package.json";

const emptyForm = { baseUrl: "", model: "", key: "" };

export function SettingsPage() {
  const { t } = useTranslation();
  const setView = useUiStore((s) => s.setView);
  const { theme, setThemeTo, arabicFont, setArabicFontTo } = useTheme();
  const source = usePapersStore((s) => s.source);
  const setSource = usePapersStore((s) => s.setSource);
  const { providers, activeProviderId, removeProvider, setActiveProvider, deleteKey, hasKey } =
    useSettingsStore();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [formKey, setFormKey] = useState(0);
  /** Preset to prefill in the add form (quick-add from the empty state). */
  const [initialPreset, setInitialPreset] = useState<string | undefined>(undefined);
  const [keyStates, setKeyStates] = useState<Record<string, boolean>>({});
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const refreshKeyStates = () => {
    for (const p of providers) {
      void hasKey(p.id).then((has) =>
        setKeyStates((s) => (s[p.id] === has ? s : { ...s, [p.id]: has })),
      );
    }
  };

  const providerIds = providers.map((p) => p.id).join(",");

  useEffect(() => {
    refreshKeyStates();
  }, [providerIds]);

  const openNewForm = (preset?: string) => {
    setEditingId(null);
    setInitialPreset(preset);
    setDeleteError(null);
    setFormKey((k) => k + 1);
    setFormOpen(true);
  };

  const openEditForm = (p: ProviderConfig) => {
    setEditingId(p.id);
    setInitialPreset(undefined);
    setDeleteError(null);
    setFormKey((k) => k + 1);
    setFormOpen(true);
  };

  const handleDeleteProvider = async (id: string) => {
    setDeleteError(null);
    try {
      await deleteKey(id);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
      return; // provider row stays; key was not removed
    }
    removeProvider(id);
  };

  const editingProvider = editingId ? providers.find((p) => p.id === editingId) : undefined;

  return (
    <div
      data-view-root
      tabIndex={-1}
      className="mx-auto min-h-0 w-full max-w-3xl flex-1 overflow-y-auto p-6 focus:outline-none"
    >
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setView("papers")}
          aria-label={t("settings.back")}
          title={t("settings.back")}
        >
          <ArrowLeft className="size-4 rtl:rotate-180" />
        </Button>
        <h1 className="text-xl font-semibold">{t("settings.title")}</h1>
      </div>

      <div className="mt-4 flex items-center gap-2 rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
        <ShieldCheck className="size-4 shrink-0" />
        {t("settings.securityNote")}
      </div>

      <section aria-labelledby="appearance-heading" className="mt-6">
        <div className="flex items-center justify-between">
          <h2 id="appearance-heading" className="text-base font-semibold">
            {t("settings.appearance")}
          </h2>
          <Select value={theme} onValueChange={(v) => setThemeTo(v as Theme)}>
            <SelectTrigger className="h-8 w-40 text-xs" aria-label={t("settings.appearance")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="light">{t("settings.themeLight")}</SelectItem>
              <SelectItem value="sepia">{t("settings.themeSepia")}</SelectItem>
              <SelectItem value="dark">{t("settings.themeDark")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {/* Plan 064: user-selectable Arabic font. Amiri ships 400/700
          only; intermediate weights resolve to the nearest real face
          (body sets font-synthesis: style). */}
        <div className="mt-3 flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">{t("settings.arabicFont")}</p>
            <p className="text-xs text-muted-foreground">{t("settings.arabicFontHint")}</p>
          </div>
          <Select value={arabicFont} onValueChange={(v) => setArabicFontTo(v as ArabicFont)}>
            <SelectTrigger className="h-8 w-44 text-xs" aria-label={t("settings.arabicFont")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="plex">{t("settings.fontPlex")}</SelectItem>
              <SelectItem value="amiri">{t("settings.fontAmiri")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </section>

      <section aria-labelledby="source-heading" className="mt-6 border-t pt-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 id="source-heading" className="text-base font-semibold">
              {t("settings.paperSource")}
            </h2>
            <Select
              value={source}
              onValueChange={(v) => setSource(v as PaperSource)}
              aria-label={t("settings.paperSource")}
            >
              <SelectTrigger className="h-8 w-52 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="arxiv">{t("settings.sourceArxiv")}</SelectItem>
                <SelectItem value="semanticscholar">
                  {t("settings.sourceSemanticScholar")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </section>

      <DataSection />

      <section aria-labelledby="providers-heading" className="mt-6 border-t pt-4">
        <div className="flex items-center justify-between">
          <h2 id="providers-heading" className="text-base font-semibold">
            {t("settings.providers")}
          </h2>
          <Button size="sm" onClick={() => openNewForm()}>
            <Plus className="size-4" />
            {t("settings.addProvider")}
          </Button>
        </div>

        {providers.length === 0 && !formOpen && (
          <div className="mt-4 rounded-md border p-4">
            <p className="text-sm text-muted-foreground">{t("settings.noProviders")}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => openNewForm("deepseek")}>
                {t("settings.addDeepSeek")}
              </Button>
              <Button size="sm" variant="outline" onClick={() => openNewForm("openrouter")}>
                {t("settings.addOpenRouter")}
              </Button>
              <Button size="sm" variant="outline" onClick={() => openNewForm("openai")}>
                {t("settings.addOpenAI")}
              </Button>
            </div>
          </div>
        )}

        {deleteError && (
          <p className="mt-4 text-xs text-destructive">
            {t("settings.deleteKeyFailed", { error: deleteError })}
          </p>
        )}

        <div className="mt-3 flex flex-col gap-3">
          {providers.map((p) => (
            <ProviderCard
              key={p.id}
              provider={p}
              isActive={activeProviderId === p.id}
              hasKey={keyStates[p.id] ?? false}
              onSetActive={() => setActiveProvider(p.id)}
              onEdit={() => openEditForm(p)}
              onDelete={() => handleDeleteProvider(p.id)}
            />
          ))}
        </div>

        {formOpen && (
          <ProviderForm
            key={formKey}
            editingId={editingId}
            initial={editingProvider ?? emptyForm}
            initialPreset={initialPreset}
            onCancel={() => setFormOpen(false)}
            onSaved={() => {
              setFormOpen(false);
              setEditingId(null);
            }}
            onKeySaved={(id) => setKeyStates((s) => ({ ...s, [id]: true }))}
          />
        )}
      </section>

      <p className="mt-8 text-center text-xs text-muted-foreground">
        {t("settings.version", { version: pkg.version })}
      </p>
    </div>
  );
}
