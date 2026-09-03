import { Loader2, Settings, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

interface LoadErrorProps {
  onBack: () => void;
  loadError: string | null;
}

/** Loading spinner for the reader workspace while the PDF downloads. */
export function LoadState() {
  const { t } = useTranslation();

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
      <Loader2 className="size-6 animate-spin" />
      {t("reader.loadingPdf")}
    </div>
  );
}

/** PDF-load failure with a way back to the papers list. */
export function LoadError({ onBack, loadError }: LoadErrorProps) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10">
        <X className="size-6 text-destructive" />
      </div>
      <p className="max-w-sm text-sm text-muted-foreground">{loadError}</p>
      <Button variant="outline" size="sm" onClick={onBack}>
        {t("reader.back")}
      </Button>
    </div>
  );
}

export function NoProviderCta({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useTranslation();

  return (
    <div
      role="tabpanel"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
    >
      <p className="max-w-60 text-sm text-muted-foreground">{t("explain.noProvider")}</p>
      <Button size="sm" variant="outline" onClick={onOpenSettings}>
        <Settings className="size-3.5" />
        {t("explain.goToSettings")}
      </Button>
    </div>
  );
}
