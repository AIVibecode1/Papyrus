import { useEffect, useState } from "react";
import { ArrowLeft, Download, Loader2, Plus, ShieldCheck } from "lucide-react";
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
import { exportSavedData } from "@/lib/export";
import type { ProviderConfig } from "@/lib/types";
import { useTheme, type Theme } from "@/hooks/use-theme";
import { usePapersStore } from "@/stores/papers";
import { useSettingsStore } from "@/stores/settings";
import { useUiStore } from "@/stores/ui";
import { ProviderCard } from "./provider-card";
import { ProviderForm } from "./provider-form";

const emptyForm = { baseUrl: "", model: "", key: "" };

export function SettingsPage() {
  const { t } = useTranslation();
  const setView = useUiStore((s) => s.setView);
  const { theme, setThemeTo } = useTheme();
  const source = usePapersStore((s) => s.source);
  const setSource = usePapersStore((s) => s.setSource);
  const { providers, activeProviderId, removeProvider, setActiveProvider, deleteKey, hasKey } =
    useSettingsStore();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const [keyStates, setKeyStates] = useState<Record<string, boolean>>({});
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState<string | null>(null);

  const handleExport = async () => {
    setExporting(true);
    setExportMessage(null);
    try {
      const path = await exportSavedData();
      setExportMessage(t("settings.exportedTo", { path }));
    } catch (err) {
      setExportMessage(
        t("settings.exportFailed", { error: err instanceof Error ? err.message : String(err) }),
      );
    } finally {
      setExporting(false);
    }
  };

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

  const openNewForm = () => {
    setEditingId(null);
    setDeleteError(null);
    setFormKey((k) => k + 1);
    setFormOpen(true);
  };

  const openEditForm = (p: ProviderConfig) => {
    setEditingId(p.id);
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
    <div className="mx-auto w-full max-w-3xl flex-1 p-6">
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

      <div className="mt-6 flex items-center justify-between">
        <h2 className="text-base font-semibold">{t("settings.appearance")}</h2>
        <Select
          value={theme}
          onValueChange={(v) => setThemeTo(v as Theme)}
          aria-label={t("settings.appearance")}
        >
          <SelectTrigger className="h-8 w-40 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="light">{t("settings.themeLight")}</SelectItem>
            <SelectItem value="sepia">{t("settings.themeSepia")}</SelectItem>
            <SelectItem value="dark">{t("settings.themeDark")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="mt-6 flex items-center justify-between border-t pt-4">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold">{t("settings.paperSource")}</h2>
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
              <SelectItem value="semanticscholar">{t("settings.sourceSemanticScholar")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="mt-6 flex items-center justify-between border-t pt-4">
        <h2 className="text-base font-semibold">{t("settings.export")}</h2>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void handleExport()}
          disabled={exporting}
        >
          {exporting ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Download className="size-4" />
          )}
          {t("settings.exportData")}
        </Button>
      </div>
      {exportMessage && <p className="mt-2 text-xs text-muted-foreground">{exportMessage}</p>}

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
          onCancel={() => setFormOpen(false)}
          onSaved={() => {
            setFormOpen(false);
            setEditingId(null);
          }}
          onKeySaved={(id) => setKeyStates((s) => ({ ...s, [id]: true }))}
        />
      )}
    </div>
  );
}
