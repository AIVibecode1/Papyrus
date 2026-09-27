import { BookOpenText, Loader2, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Markdown } from "@/components/markdown/markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatUiDate } from "@/lib/dates";
import type { PaperNote } from "@/lib/types";

export function NoteCard({
  note,
  openingId,
  confirmId,
  onConfirmDelete,
  onCancelDelete,
  onDelete,
  onOpen,
  onFilterPaper,
}: {
  note: PaperNote;
  openingId: string | null;
  confirmId: string | null;
  onConfirmDelete: (id: string) => void;
  onCancelDelete: () => void;
  onDelete: (id: string) => void;
  onOpen: (note: PaperNote) => void;
  onFilterPaper: (paperId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const isConfirming = confirmId === note.id;
  const openedAt = formatUiDate(new Date(note.updatedAt), i18n.language, {
    dateStyle: "medium",
  });

  return (
    <Card className={note.kind === "highlight" ? "border-accent/50" : undefined}>
      <CardContent className="flex flex-col gap-2.5 p-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge
            variant={note.kind === "highlight" ? "secondary" : "outline"}
            className="text-[10px]"
          >
            {note.kind === "highlight" ? t("notes.kindHighlight") : t("notes.kindNote")}
          </Badge>
          {note.page != null && (
            <Badge variant="outline" className="font-mono text-[10px]" dir="ltr">
              {t("notes.page", { page: note.page })}
            </Badge>
          )}
          <span className="text-[11px] text-muted-foreground">{openedAt}</span>
        </div>

        {note.kind === "highlight" && note.quote && (
          <blockquote
            dir="ltr"
            className="border-s-2 border-accent bg-muted/40 px-3 py-2 text-sm italic text-foreground/90"
          >
            “{note.quote}”
          </blockquote>
        )}

        {note.body.trim() && (
          <div className="text-sm">
            <Markdown>{note.body}</Markdown>
          </div>
        )}

        <div className="mt-1 flex flex-wrap items-center justify-between gap-2 border-t pt-2">
          <button
            type="button"
            onClick={() => onFilterPaper(note.paperId)}
            className="min-w-0 truncate text-start text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            title={t("notes.filteredTo", { title: note.paperTitle })}
          >
            {t("notes.forPaper", { title: note.paperTitle })}
          </button>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => onOpen(note)}
              disabled={openingId === note.id}
            >
              {openingId === note.id ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <BookOpenText className="size-3" />
              )}
              {t("notes.openPaper")}
            </Button>
            {isConfirming ? (
              <span className="flex items-center gap-1.5">
                <span className="text-xs text-destructive">{t("notes.deleteConfirm")}</span>
                <Button
                  variant="destructive"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => onDelete(note.id)}
                >
                  {t("notes.delete")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={onCancelDelete}
                >
                  {t("settings.cancel")}
                </Button>
              </span>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                onClick={() => onConfirmDelete(note.id)}
              >
                <Trash2 className="size-3" />
                {t("notes.delete")}
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
