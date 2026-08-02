import { AlertCircle, Loader2, RotateCcw, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useExplanationStore } from "@/stores/explanation";
import { useSettingsStore } from "@/stores/settings";
import { useUiStore } from "@/stores/ui";
import type { Paper, ProviderConfig } from "@/lib/types";
import { cn } from "@/lib/utils";

interface ExplainPanelProps {
  paper: Paper;
}

export function ExplainPanel({ paper }: ExplainPanelProps) {
  const { t, i18n } = useTranslation();
  const { providers, activeProviderId, setActiveProvider } = useSettingsStore();
  const explanation = useExplanationStore((s) => s.byPaper[paper.id]);
  const start = useExplanationStore((s) => s.start);
  const stop = useExplanationStore((s) => s.stop);
  const setView = useUiStore((s) => s.setView);

  const status = explanation?.status ?? "idle";
  const busy = status === "loading" || status === "streaming";
  const provider = providers.find((p) => p.id === (explanation?.providerId ?? activeProviderId));

  const handleStart = (p: ProviderConfig) => {
    void start(paper, p, i18n.language);
  };

  return (
    <div className="mt-3 flex flex-col gap-3 border-t pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={explanation?.providerId ?? activeProviderId ?? undefined}
          onValueChange={(id) => setActiveProvider(id)}
          disabled={busy}
        >
          <SelectTrigger className="h-8 w-56 text-xs">
            <SelectValue placeholder={t("explain.selectProvider")} />
          </SelectTrigger>
          <SelectContent>
            {providers.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {busy && (
          <Button size="sm" variant="outline" onClick={() => void stop()}>
            <Square className="size-3.5" />
            {t("explain.stop")}
          </Button>
        )}
        {!busy && status !== "idle" && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => provider && handleStart(provider)}
          >
            <RotateCcw className="size-3.5" />
            {t("explain.regenerate")}
          </Button>
        )}
      </div>

      {providers.length === 0 && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <AlertCircle className="size-4" />
          {t("explain.noProvider")}
          <Button
            size="sm"
            variant="link"
            className="h-auto p-0"
            onClick={() => setView("settings")}
          >
            {t("explain.goToSettings")}
          </Button>
        </div>
      )}

      {status === "loading" && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t("explain.explaining")}
        </div>
      )}

      {explanation && explanation.text.length > 0 && (
        <div
          className={cn(
            "max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted/50 p-4 text-sm leading-relaxed",
            status === "streaming" && "border border-primary/30",
          )}
        >
          {explanation.text}
          {status === "streaming" && (
            <span className="inline-block h-4 w-1.5 animate-pulse bg-primary align-middle" />
          )}
        </div>
      )}

      {status === "error" && explanation?.error && (
        <div className="flex flex-col gap-2 rounded-md border border-destructive/40 p-3 text-sm">
          <span className="flex items-center gap-2 font-medium text-destructive">
            <AlertCircle className="size-4" />
            {t("explain.error")}
          </span>
          <span className="text-muted-foreground">{explanation.error}</span>
          {provider && (
            <Button size="sm" variant="outline" className="self-start" onClick={() => handleStart(provider)}>
              {t("explain.retry")}
            </Button>
          )}
        </div>
      )}

      {status === "stopped" && (
        <p className="text-sm text-muted-foreground">{t("explain.stopped")}</p>
      )}
    </div>
  );
}
