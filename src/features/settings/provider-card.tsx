import { useState } from "react";
import { CheckCircle2, CircleAlert, Loader2, Pencil, Trash2, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { ProviderConfig } from "@/lib/types";
import { useSettingsStore } from "@/stores/settings";
import { cn } from "@/lib/utils";

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
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const handleTest = async () => {
    setTesting(true);
    setTestResult({ ok: false, msg: "" });
    try {
      const reply = await testProvider(provider);
      setTestResult({ ok: true, msg: reply });
    } catch (err) {
      setTestResult({
        ok: false,
        msg: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
  };

  const handleDelete = async () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    await onDelete();
  };

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
            <Button size="sm" variant="ghost" onClick={onSetActive}>
              {t("settings.setActive")}
            </Button>
            <Button size="sm" variant="ghost" onClick={onEdit}>
              <Pencil className="size-3.5" />
            </Button>
            <Button
              size="sm"
              variant={confirming ? "destructive" : "ghost"}
              onClick={() => void handleDelete()}
            >
              <Trash2 className="size-3.5" />
              {confirming ? t("settings.confirmDelete") : ""}
            </Button>
          </div>
        </div>

        <p className="break-all font-mono text-xs text-muted-foreground">
          {provider.baseUrl} · {provider.model}
        </p>

        {testResult && (
          <p
            className={cn(
              "text-xs",
              testResult.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive",
            )}
          >
            {testResult.ok
              ? t("settings.testOk", { reply: testResult.msg })
              : `${t("settings.testFailed")}: ${testResult.msg}`}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
