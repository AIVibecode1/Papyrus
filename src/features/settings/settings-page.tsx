import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Clock,
  Download,
  Loader2,
  Plus,
  ShieldCheck,
  Trash2,
  Upload,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { PaperSource } from "@/lib/arxiv";
import { exportSavedData, importSavedData } from "@/lib/export";
import type { ProviderConfig } from "@/lib/types";
import { useTheme, type ArabicFont, type Theme } from "@/hooks/use-theme";
import { useHistoryStore } from "@/stores/history";
import { usePapersStore } from "@/stores/papers";
import { useSettingsStore } from "@/stores/settings";
import { useUiStore } from "@/stores/ui";
import { ProviderCard } from "./provider-card";
import { ProviderForm } from "./provider-form";
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
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearMessage, setClearMessage] = useState<string | null>(null);
  // Plan 060: history-only clear (favorites and notes are untouched).
  const [confirmHistoryClear, setConfirmHistoryClear] = useState(false);
  const [clearingHistory, setClearingHistory] = useState(false);
  const [historyMessage, setHistoryMessage] = useState<string | null>(null);

  const handleImportFile = async (file: File | undefined) => {
    if (!file) return;
    setImporting(true);
    setImportMessage(null);
    try {
      const content = await file.text();
      const summary = await importSavedData(content);
      setImportMessage(t("settings.importedCount", { ...summary }));
    } catch (err) {
      setImportMessage(t("settings.importFailed", { error: String(err) }));
    } finally {
      setImporting(false);
      if (importInputRef.current) importInputRef.current.value = "";
    }
  };

  const handleClear = async () => {
    setClearing(true);
    setClearMessage(null);
    try {
      await invoke("clear_app_cache");
      // Wipe the app's saved data (keep in sync with the stores'
      // STORAGE_KEY constants). Providers, the active provider, the
      // language and the theme are NOT touched. A reload re-initialises
      // every store from the now-empty storage.
      for (const key of [
        "papyrus-digest-v2",
        "papyrus-favorites",
        "papyrus-reader-chat-v1",
        "papyrus-reader-pos",
        "papyrus-reader-split",
        "papyrus-reader-walkthrough-v1",
        "papyrus-notes-v1",
        "papyrus-reading-history-v1",
      ]) {
        localStorage.removeItem(key);
      }
      window.location.reload();
    } catch (err) {
      setClearing(false);
      setConfirmClear(false);
      setClearMessage(t("settings.clearDataFailed", { error: String(err) }));
    }
  };

  const handleClearHistory = async () => {
    setClearingHistory(true);
    setHistoryMessage(null);
    try {
      await useHistoryStore.getState().clear();
      setConfirmHistoryClear(false);
      setHistoryMessage(t("history.clearDone"));
    } catch {
      setConfirmHistoryClear(false);
      setHistoryMessage(t("settings.clearDataFailed", { error: "history" }));
    } finally {
      setClearingHistory(false);
    }
  };

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
    <div className="mx-auto min-h-0 w-full max-w-3xl flex-1 overflow-y-auto p-6">
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

      <section aria-labelledby="data-heading" className="mt-6 border-t pt-4">
        <h2 id="data-heading" className="text-base font-semibold">
          {t("settings.data")}
        </h2>
        <div className="mt-3 flex flex-wrap items-center gap-2">
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
          <Button
            size="sm"
            variant="outline"
            onClick={() => importInputRef.current?.click()}
            disabled={importing}
          >
            {importing ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Upload className="size-4" />
            )}
            {t("settings.importData")}
          </Button>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            aria-hidden="true"
            tabIndex={-1}
            onChange={(e) => void handleImportFile(e.target.files?.[0])}
          />
        </div>
        {exportMessage && <p className="mt-2 text-xs text-muted-foreground">{exportMessage}</p>}
        {importMessage && (
          <p role="status" className="mt-2 text-xs text-muted-foreground">
            {importMessage}
          </p>
        )}

        <div className="mt-4 rounded-md border p-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">{t("settings.clearDataHint")}</p>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 text-destructive"
              onClick={() => setConfirmClear(true)}
            >
              <Trash2 className="size-4" />
              {t("settings.clearData")}
            </Button>
          </div>
          {confirmClear && (
            <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/5 p-3">
              <p className="text-xs text-destructive">{t("settings.clearDataPrompt")}</p>
              <div className="mt-2 flex gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  autoFocus
                  onClick={() => void handleClear()}
                  disabled={clearing}
                >
                  {clearing ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Trash2 className="size-4" />
                  )}
                  {clearing ? t("settings.clearing") : t("settings.clearConfirm")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmClear(false)}
                  disabled={clearing}
                >
                  {t("settings.cancel")}
                </Button>
              </div>
            </div>
          )}
          {clearMessage && (
            <p role="alert" className="mt-2 text-xs text-destructive">
              {clearMessage}
            </p>
          )}
        </div>

        {/* Plan 060: history-only clear. Favorites and notes are never
            touched; unlike the big clear above there is no reload. */}
        <div className="mt-4 rounded-md border p-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">{t("settings.clearHistoryHint")}</p>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 text-destructive"
              onClick={() => setConfirmHistoryClear(true)}
            >
              <Clock className="size-4" />
              {t("history.clear")}
            </Button>
          </div>
          {confirmHistoryClear && (
            <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/5 p-3">
              <p className="text-xs text-destructive">{t("history.clearPrompt")}</p>
              <div className="mt-2 flex gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  autoFocus
                  onClick={() => void handleClearHistory()}
                  disabled={clearingHistory}
                >
                  {clearingHistory ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Trash2 className="size-4" />
                  )}
                  {clearingHistory ? t("settings.clearing") : t("settings.clearConfirm")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmHistoryClear(false)}
                  disabled={clearingHistory}
                >
                  {t("settings.cancel")}
                </Button>
              </div>
            </div>
          )}
          {historyMessage && (
            <p role="status" className="mt-2 text-xs text-muted-foreground">
              {historyMessage}
            </p>
          )}
        </div>
      </section>

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
