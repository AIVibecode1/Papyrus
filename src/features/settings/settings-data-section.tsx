import { useRef, useState } from "react";
import { Clock, Download, Loader2, Trash2, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";

import { Button } from "@/components/ui/button";
import { exportSavedData, importSavedData } from "@/lib/export";
import { useHistoryStore } from "@/stores/history";

/**
 * The Settings "data" section: export/import backup, full cache+data
 * wipe, and history-only clear. Fully self-contained (own state and
 * handlers) so the settings page stays a thin shell.
 */
export function DataSection() {
  const { t } = useTranslation();
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

  return (
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
          {importing ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
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
  );
}
