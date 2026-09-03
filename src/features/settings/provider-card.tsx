import { useState } from "react";
import { CheckCircle2, CircleAlert, History, Loader2, Pencil, Trash2, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { ProviderConfig } from "@/lib/types";
import { categorizeTestError, redactSecrets, truncateError } from "@/lib/provider-errors";
import { useSettingsStore } from "@/stores/settings";
import { cn } from "@/lib/utils";
import { loadTestMemory, recordTestFailure, recordTestSuccess } from "./provider-test-memory";

interface ProviderCardProps {
  provider: ProviderConfig;
  isActive: boolean;
  hasKey: boolean;
  onSetActive: () => void;
  onEdit: () => void;
  onDelete: () => Promise<void>;
}

export function ProviderCard({
  provider,
  isActive,
  hasKey,
  onSetActive,
  onEdit,
  onDelete,
}: ProviderCardProps) {
  const { t } = useTranslation();
  const { testProvider } = useSettingsStore();

  const [confirming, setConfirming] = useState(false);
  const [testing, setTesting] = useState(false);
  // The last test result for this provider: the persisted memory on
  // mount, then whatever a fresh test reports.
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(() => {
    const remembered = loadTestMemory()[provider.id];
    if (!remembered) return null;
    return { ok: remembered.ok, msg: remembered.detail ?? "" };
  });

  const handleTest = async () => {
    setTesting(true);
    setTestResult({ ok: false, msg: "" });
    try {
      const reply = await testProvider(provider);
      setTestResult({ ok: true, msg: reply });
      recordTestSuccess(provider.id, reply);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setTestResult({ ok: false, msg: message });
      recordTestFailure(provider.id, message);
    } finally {
      setTesting(false);
    }
  };

  const handleDelete = async () => {
    setConfirming(false);
    await onDelete();
  };

  const category = testResult && !testResult.ok ? categorizeTestError(testResult.msg) : null;

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="font-medium">{provider.name}</span>
            {isActive && (
              <Badge variant="default" className="text-xs">
                {t("settings.active")}
              </Badge>
            )}
            {hasKey ? (
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
            {testResult && (
              <Badge
                variant="outline"
                className={cn("gap-1 text-xs", testResult.ok ? "text-primary" : "text-destructive")}
              >
                <History className="size-3" />
                {testResult.ok
                  ? t("settings.lastTestOk")
                  : t("settings.lastTestFailed", {
                      category: category ? t(`settings.testErrorShort.${category}`) : "",
                    })}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" onClick={() => void handleTest()} disabled={testing}>
              {testing ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Zap className="size-3.5" />
              )}
              {testing ? t("settings.testing") : t("settings.test")}
            </Button>
            <Button size="sm" variant="ghost" onClick={onSetActive} aria-pressed={isActive}>
              {t("settings.setActive")}
            </Button>
            <Button size="sm" variant="ghost" onClick={onEdit}>
              <Pencil className="size-3.5" />
            </Button>
            {confirming ? (
              <div
                role="group"
                aria-label={t("settings.confirmDeletePrompt")}
                className="flex items-center gap-1.5"
              >
                <span className="text-xs text-destructive">
                  {t("settings.confirmDeletePrompt")}
                </span>
                <Button
                  size="sm"
                  variant="destructive"
                  autoFocus
                  onClick={() => void handleDelete()}
                >
                  {t("settings.delete")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                  {t("settings.cancel")}
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setConfirming(true)}
                aria-label={t("settings.delete")}
              >
                <Trash2 className="size-3.5" />
              </Button>
            )}
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          <span dir="ltr" className="break-all font-mono">
            {provider.baseUrl}
          </span>
          <span className="mx-1 text-muted-foreground/60">·</span>
          <span dir="ltr" className="font-mono">
            {provider.model}
          </span>
        </p>

        {testResult && (
          <p className={cn("text-xs", testResult.ok ? "text-primary" : "text-destructive")}>
            {testResult.ok ? (
              <span dir="ltr">
                {t("settings.testOk", { reply: truncateError(testResult.msg) })}
              </span>
            ) : (
              <>
                <span>{t(`settings.testError.${category}`)}</span>
                {category === "unknown" && testResult.msg && (
                  <span dir="ltr" className="break-all">
                    {" "}
                    — {truncateError(redactSecrets(testResult.msg))}
                  </span>
                )}
              </>
            )}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
