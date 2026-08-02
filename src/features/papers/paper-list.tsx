import { AlertCircle, BookOpenText, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { usePapersStore } from "@/stores/papers";
import { PaperCard } from "@/features/papers/paper-card";

function PaperSkeleton() {
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-5">
        <div className="flex items-start justify-between gap-3">
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-5 w-16 shrink-0" />
        </div>
        <Skeleton className="h-3.5 w-1/2" />
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-5/6" />
        <div className="mt-1 flex gap-2">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-24" />
        </div>
      </CardContent>
    </Card>
  );
}

export function PaperList() {
  const { t } = useTranslation();
  const { papers, loading, error, refresh, lastUpdated } = usePapersStore();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          {lastUpdated &&
            t("papers.updated", {
              time: new Intl.DateTimeFormat(undefined, {
                timeStyle: "short",
              }).format(new Date(lastUpdated)),
            })}
        </div>
        <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} />
          {t("papers.refresh")}
        </Button>
      </div>

      {loading && (
        <div className="flex flex-col gap-4" aria-label={t("papers.loading")}>
          {Array.from({ length: 5 }).map((_, i) => (
            <PaperSkeleton key={i} />
          ))}
        </div>
      )}

      {!loading && error && (
        <Card className="border-destructive/40">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <AlertCircle className="size-8 text-destructive" />
            <p className="text-sm font-medium">{t("papers.error")}</p>
            <p className="max-w-md text-xs text-muted-foreground">{error}</p>
            <Button size="sm" variant="outline" onClick={() => void refresh()}>
              {t("papers.retry")}
            </Button>
          </CardContent>
        </Card>
      )}

      {!loading && !error && papers.length === 0 && (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <BookOpenText className="size-8 text-muted-foreground" />
            <p className="text-sm font-medium text-muted-foreground">{t("papers.empty")}</p>
          </CardContent>
        </Card>
      )}

      {!loading && !error && papers.length > 0 && (
        <div className="flex flex-col gap-4">
          {papers.map((paper) => (
            <PaperCard key={paper.id} paper={paper} />
          ))}
        </div>
      )}
    </div>
  );
}
