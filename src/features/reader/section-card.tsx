import { Check, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Markdown } from "@/components/markdown/markdown";
import { redactSecrets, truncateError } from "@/lib/provider-errors";
import { cn } from "@/lib/utils";
import type { SectionEntry } from "@/stores/reader";

export function StatusRow({ status, error }: { status: string; error: string | null }) {
  const { t } = useTranslation();
  if (status === "error" && error) {
    // Defense in depth: upstream errors are already redacted at the
    // source, but no secret-shaped text may ever reach the screen even
    // if a future path forgets.
    return <p className="mt-2 text-xs text-destructive">{truncateError(redactSecrets(error))}</p>;
  }
  if (status === "stopped") {
    return <p className="mt-2 text-xs text-muted-foreground">{t("explain.stopped")}</p>;
  }
  return null;
}

export function SectionCard({
  index,
  total,
  entry,
}: {
  index: number;
  total: number;
  entry: SectionEntry;
}) {
  const { t } = useTranslation();
  const busy = entry.status === "loading" || entry.status === "streaming";
  return (
    <div
      className={cn(
        "rounded-lg border bg-card p-3.5 transition-colors",
        entry.status === "streaming" && "border-primary/40",
        entry.status === "done" && "border-border",
        entry.status === "error" && "border-destructive/40",
      )}
    >
      <div className="mb-2 flex items-center gap-2">
        <span
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold",
            entry.status === "done"
              ? "bg-primary/10 text-primary"
              : busy
                ? "bg-primary/10 text-primary"
                : "bg-muted text-muted-foreground",
          )}
        >
          {entry.status === "done" ? <Check className="size-3" /> : index + 1}
        </span>
        <p className="text-xs font-semibold text-muted-foreground">
          {t("reader.sectionOf", { current: index + 1, total })}
        </p>
        {busy && (
          <span className="flex items-center gap-1.5 text-[11px] text-primary">
            <Loader2 className="size-3 animate-spin" />
            {t("reader.explainingSection")}
          </span>
        )}
      </div>
      {entry.text.length > 0 && <Markdown>{entry.text}</Markdown>}
      {entry.status === "streaming" && (
        <span className="inline-block h-3.5 w-0.5 animate-pulse bg-primary align-middle" />
      )}
      <StatusRow status={entry.status} error={entry.error} />
    </div>
  );
}
