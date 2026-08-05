// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { ReaderNotes } from "@/features/reader/reader-notes";
import type { Paper, PaperNote } from "@/lib/types";
import { useNotesStore } from "@/stores/notes";

const paper: Paper = {
  id: "1706.03762",
  title: "Attention Is All You Need",
  authors: ["Vaswani et al."],
  published: "2017-06-12",
  summary: "The transformer architecture.",
  pdfUrl: "https://arxiv.org/pdf/1706.03762",
  categories: ["cs.CL"],
};

function makeNote(overrides: Partial<PaperNote> = {}): PaperNote {
  return {
    id: "n1",
    paperId: paper.id,
    paperTitle: paper.title,
    kind: "note",
    body: "Existing note body.",
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-02T00:00:00Z",
    ...overrides,
  };
}

describe("ReaderNotes", () => {
  beforeEach(() => {
    useNotesStore.setState({ notes: [], loaded: true, filterPaperId: null, query: "" });
  });

  it("lists the notes for the open paper only", () => {
    useNotesStore.setState({
      notes: [
        makeNote(),
        makeNote({ id: "n2", paperId: "other", paperTitle: "Other", body: "Other paper" }),
      ],
      loaded: true,
    });

    render(<ReaderNotes paper={paper} />);

    expect(screen.getByText("Existing note body.")).toBeInTheDocument();
    expect(screen.queryByText("Other paper")).not.toBeInTheDocument();
  });

  it("adds a note through the form", async () => {
    render(<ReaderNotes paper={paper} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Add note" }), {
      target: { value: "A fresh thought" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // The store is updated optimistically; the draft is cleared.
    const notes = useNotesStore.getState().notes;
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toBe("A fresh thought");
    expect(notes[0].paperId).toBe(paper.id);
    // The note renders through the markdown pipeline (not the textarea).
    await screen.findByText("A fresh thought", { selector: "p" });
  });

  it("shows highlight quotes with a page badge", () => {
    useNotesStore.setState({
      notes: [makeNote({ kind: "highlight", quote: "we call it attention", page: 3, body: "" })],
      loaded: true,
    });

    render(<ReaderNotes paper={paper} />);

    expect(screen.getByText(/“we call it attention”/)).toBeInTheDocument();
    expect(screen.getByText("Page 3")).toBeInTheDocument();
  });
});
