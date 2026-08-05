import { Highlighter, Loader2, NotebookPen, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Markdown } from "@/components/markdown/markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { Paper, PaperNote } from "@/lib/types";
import { notesForPaperList, useNotesStore } from "@/stores/notes";

function ReaderNoteRow({
  note,
  confirmId,
  onConfirmDelete,
  onCancelDelete,
  onDelete,
}: {
  note: PaperNote;
  confirmId: string | null;
  onConfirmDelete: (id: string) => void;
  onCancelDelete: () => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useTranslation();
  const isConfirming = confirmId === note.id;

  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card p-3">
      {note.kind === "highlight" && note.quote && (
        <blockquote
          dir="ltr"
          className="border-s-2 border-accent bg-muted/40 px-2.5 py-1.5 text-xs italic text-foreground/90"
        >
          “{note.quote}”
        </blockquote>
      )}
      {note.body.trim() && (
        <div className="text-xs">
          <Markdown>{note.body}</Markdown>
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {note.kind === "highlight" && <Highlighter className="size-3 text-muted-foreground" />}
          {note.page != null && (
            <Badge variant="outline" className="font-mono text-[10px]" dir="ltr">
              {t("notes.page", { page: note.page })}
            </Badge>
          )}
        </div>
        {isConfirming ? (
          <span className="flex items-center gap-1.5">
            <span className="text-[11px] text-destructive">{t("notes.deleteConfirm")}</span>
            <Button
              variant="destructive"
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={() => onDelete(note.id)}
            >
              {t("notes.delete")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={onCancelDelete}
            >
              {t("settings.cancel")}
            </Button>
          </span>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-destructive"
            onClick={() => onConfirmDelete(note.id)}
            aria-label={t("notes.delete")}
          >
            <Trash2 className="size-3" />
          </Button>
        )}
      </div>
    </div>
  );
}

/** The reader's Notes tab (plan 042): existing notes for the open paper
 * plus an add-note form. Highlights created from a PDF selection land
 * here too. */
export function ReaderNotes({ paper }: { paper: Paper }) {
  const { t } = useTranslation();
  const notes = useNotesStore((s) => s.notes);
  const upsert = useNotesStore((s) => s.upsert);
  const remove = useNotesStore((s) => s.remove);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const paperNotes = useMemo(() => notesForPaperList(notes, paper.id), [notes, paper.id]);

  const handleSave = async () => {
    const body = draft.trim();
    if (!body) return;
    setSaving(true);
    try {
      await upsert({
        paperId: paper.id,
        paperTitle: paper.title,
        kind: "note",
        body,
      });
      setDraft("");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto p-3">
      <div className="flex flex-col gap-3">
        {paperNotes.length === 0 && (
          <p className="rounded-lg border border-dashed bg-muted/20 p-4 text-center text-xs text-muted-foreground">
            {t("notes.empty")}
          </p>
        )}

        {paperNotes.map((note) => (
          <ReaderNoteRow
            key={note.id}
            note={note}
            confirmId={confirmId}
            onConfirmDelete={setConfirmId}
            onCancelDelete={() => setConfirmId(null)}
            onDelete={(id) => {
              void remove(id);
              setConfirmId(null);
            }}
          />
        ))}

        <div className="mt-1 flex flex-col gap-2">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <NotebookPen className="size-3.5" />
            {t("notes.add")}
          </div>
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t("notes.comment")}
            aria-label={t("notes.add")}
            rows={3}
            className="text-sm"
          />
          <Button
            size="sm"
            className="self-start"
            onClick={() => void handleSave()}
            disabled={saving || !draft.trim()}
          >
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
            {t("notes.save")}
          </Button>
        </div>
      </div>
    </div>
  );
}
