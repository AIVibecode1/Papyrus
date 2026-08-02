"""Generates src/dev/sample.pdf: a tiny 2-page PDF with headings and
paragraphs so the browser preview can exercise the in-app reader
(pdf.js viewer, text extraction, section splitting, search).
"""

from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "src" / "dev" / "sample.pdf"

PAGE1 = """1. Introduction
This is a sample paper used by the browser preview to test the Papyrus reader. It has two sections and some text about transformers and attention.
The authors propose a simple method that improves the results on standard benchmarks. The key idea is to normalize the inputs before the core model runs.
2. Method
The method section explains the approach in detail. First the encoder maps the tokens to vectors. Then the core model processes them. Finally the decoder ranks the outputs.
We evaluate on three datasets. The results show a clear improvement over the baselines."""

PAGE2 = """3. Results
The experiments confirm the claims. The table shows the scores for every model.
4. Conclusion
We conclude that the method is simple, effective, and easy to reproduce. Future work will extend it to larger models and other fields."""


def esc(text: str) -> bytes:
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)").encode()


def make_pdf(pages: list[str]) -> bytes:
    objects: list[bytes] = []
    font_obj = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
    page_ids: list[int] = []
    content_ids: list[int] = []
    obj_counter = 1  # 1 = catalog, 2 = pages

    def add(data: bytes) -> int:
        nonlocal obj_counter
        obj_counter += 1
        objects.append(data)
        return obj_counter

    for text in pages:
        content = (
            b"BT /F1 12 Tf 72 760 Td 18 TL\n"
            + b"".join(
                b"(" + esc(line) + b") Tj T*\n" for line in text.splitlines()
            )
            + b"ET"
        )
        cid = add(b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"\nendstream")
        pid = add(
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents "
            + str(cid).encode()
            + b" 0 R /Resources << /Font << /F1 5 0 R >> >> >>"
        )
        page_ids.append(pid)
        content_ids.append(cid)

    pages_obj = (
        b"<< /Type /Pages /Kids ["
        + b" ".join(str(p).encode() + b" 0 R" for p in page_ids)
        + b"] /Count "
        + str(len(page_ids)).encode()
        + b" >>"
    )
    catalog = b"<< /Type /Catalog /Pages 2 0 R >>"

    # Build the file with a computed xref table.
    body = bytearray()
    offsets = [0]
    body += b"%PDF-1.4\n"
    body += b"1 0 obj\n" + catalog + b"\nendobj\n"
    offsets.append(len(body))
    body += b"2 0 obj\n" + pages_obj + b"\nendobj\n"
    for i, data in enumerate(objects):
        offsets.append(len(body))
        body += str(i + 3).encode() + b" 0 obj\n" + data + b"\nendobj\n"

    xref_pos = len(body)
    body += b"xref\n0 " + str(obj_counter + 1).encode() + b"\n"
    body += b"0000000000 65535 f \n"
    for off in offsets[1:]:
        body += f"{off:010d} 00000 n \n".encode()
    body += (
        b"trailer\n<< /Size "
        + str(obj_counter + 1).encode()
        + b" /Root 1 0 R >>\nstartxref\n"
        + str(xref_pos).encode()
        + b"\n%%EOF\n"
    )
    return bytes(body)


if __name__ == "__main__":
    OUT.write_bytes(make_pdf([PAGE1, PAGE2]))
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
