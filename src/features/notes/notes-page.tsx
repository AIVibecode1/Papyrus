import { NotebookPen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Notes hub. Plan 042 replaces this stub with the real note-taking
 * surfaces; until then it must render a translated empty state so the
 * notes route slot never white-screens.
 */
export function NotesPage() {
  const { t } = useTranslation();

  return (
    <div className="mx-auto w-full max-w-3xl p-4 lg:p-6">
      <h1 className="text-xl font-semibold">{t("notes.title")}</h1>
      <Card className="mt-4 border-dashed">
        <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
          <NotebookPen className="size-8 text-muted-foreground" />
          <p className="text-sm font-medium text-muted-foreground">{t("notes.empty")}</p>
        </CardContent>
      </Card>
    </div>
  );
}
