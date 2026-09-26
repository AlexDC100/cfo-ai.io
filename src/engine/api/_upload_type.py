"""What a stored upload ACTUALLY is, read from its bytes.

A filename is a claim, not evidence. On 2026-09-23 a prospect uploaded
`balanta_de_verificare_07.2025.pdf` which was a Word document renamed —
the PDF branch handed it to Claude, and because the Anthropic balance was
empty the user was told "Claude extraction failed: your credit balance is
too low". Three things were wrong with that: the file was never a PDF, no
reader could ever have read it, and the message blamed our billing for
the user's mistake.

PURE — bytes in, a label out. No I/O, no network, no logging, so the
upload path can consult it before spending anything.

ZIP CONTAINERS ARE NOT INTERCHANGEABLE. xlsx, docx and pptx are all
`PK\\x03\\x04`, which is why `_detect_spreadsheet_format` calling every
zip "xlsx" is not enough to answer this question: it would send a Word
document to openpyxl. The part that discriminates is the archive's own
directory — OOXML puts its payload under `xl/`, `word/` or `ppt/` — so
that is what this reads.
"""
from __future__ import annotations

import io
import zipfile
from typing import Optional

#: `%PDF-` — every PDF begins with it. Some writers emit leading bytes
#: before the header, so callers search a small window rather than
#: demanding offset 0 (see `looks_like_pdf`).
PDF_MAGIC = b"%PDF-"

#: How far into the file the PDF header may sit. Acrobat tolerates junk
#: ahead of `%PDF-`; a Word document has no `%PDF-` anywhere near the
#: front, so a generous window costs nothing and avoids refusing a
#: slightly malformed but real PDF.
PDF_MAGIC_WINDOW = 1024

_ZIP_MAGIC = (b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08")
_OLE2_MAGIC = b"\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1"

#: Labels this returns. `zip_unknown` and `unknown` are deliberately
#: distinct: the first says "a zip we do not recognise", the second
#: "we cannot name this at all", and the messages differ.
PDF = "pdf"
XLSX = "xlsx"
DOCX = "docx"
PPTX = "pptx"
ODF = "odf"
XLS_OLE2 = "xls_ole2"
DOC_OLE2 = "doc_ole2"
ZIP_UNKNOWN = "zip_unknown"
TEXT = "text"
UNKNOWN = "unknown"


def looks_like_pdf(file_bytes: bytes) -> bool:
    """True when `%PDF-` appears within the first `PDF_MAGIC_WINDOW` bytes."""
    if not file_bytes:
        return False
    return PDF_MAGIC in file_bytes[:PDF_MAGIC_WINDOW]


def _zip_flavour(file_bytes: bytes) -> str:
    """Name an OOXML/ODF zip by the directories inside it.

    A truncated or encrypted archive raises inside zipfile; that is
    `zip_unknown`, not a crash — this function never raises.
    """
    try:
        with zipfile.ZipFile(io.BytesIO(file_bytes)) as zf:
            names = zf.namelist()
    except Exception:  # noqa: BLE001 — an unreadable zip is still a zip
        return ZIP_UNKNOWN
    joined = "\n".join(names)
    # `[Content_Types].xml` is present in all OOXML; the payload folder is
    # what distinguishes them.
    if "xl/" in joined:
        return XLSX
    if "word/" in joined:
        return DOCX
    if "ppt/" in joined:
        return PPTX
    for n in names:
        if n == "mimetype":
            try:
                with zipfile.ZipFile(io.BytesIO(file_bytes)) as zf:
                    mt = zf.read("mimetype").decode("ascii", "replace")
            except Exception:  # noqa: BLE001
                return ZIP_UNKNOWN
            if "opendocument" in mt:
                return ODF
    return ZIP_UNKNOWN


def sniff_container(file_bytes: bytes) -> str:
    """The real container behind an upload's bytes.

    Order matters, and NOT in the obvious direction: the unambiguous
    offset-0 signatures (zip, OLE2) decide before the PDF window search,
    because that search can match text sitting inside another container.
    A text heuristic is the last resort. Returns one of the module's
    label constants; never raises.
    """
    if not file_bytes:
        return UNKNOWN
    # CONTAINER MAGIC FIRST, and the order is load-bearing. `%PDF-` is
    # searched for in a window rather than demanded at offset 0, so a zip
    # that merely CONTAINS that text early — an embedded PDF, or an entry
    # name in the archive directory — was being called a PDF and waved
    # through the guard (measured: a docx with "%PDF-" at offset 54
    # returned `pdf`). A zip or OLE2 signature at offset 0 is unambiguous
    # and no PDF can carry one, so those decide first.
    head = file_bytes[:8]
    if head[:4] in _ZIP_MAGIC:
        return _zip_flavour(file_bytes)
    if head == _OLE2_MAGIC:
        # OLE2 carries both .xls and .doc. Telling them apart needs the
        # CFB directory, which is more machinery than this decision
        # deserves: the caller only has to know it is not a PDF, and the
        # spreadsheet path already has `_detect_spreadsheet_format`.
        return XLS_OLE2
    # Only now the PDF window search — see the ordering note above.
    if looks_like_pdf(file_bytes):
        return PDF
    # Text last, and NUL bytes disqualify it: `b"\x00" * n` decodes as
    # valid UTF-8, so a decode test alone calls a binary file "a text
    # file" — a label that goes straight into the message a person reads.
    head = file_bytes[:2048]
    if b"\x00" in head:
        return UNKNOWN
    try:
        head.decode("utf-8")
    except UnicodeDecodeError:
        return UNKNOWN
    return TEXT


#: What to tell a person whose .pdf is not a PDF. Each line names the
#: real type and the action that fixes it — never our own billing, which
#: is what the old message did.
_ADVICE = {
    # PDF is the healthy case on the .pdf path and never refused there;
    # it IS the real type when a PDF arrives named .xlsx or .csv, and
    # without this entry that refusal would fall through to the UNKNOWN
    # advice and tell someone their perfectly good PDF is unreadable.
    PDF: ("a PDF document",
          "rename it to .pdf and upload it again"),
    XLSX: ("an Excel workbook (.xlsx)",
           "rename it to .xlsx and upload it again — Excel balances are read directly"),
    DOCX: ("a Word document (.docx)",
           "open it and use File → Save as → PDF, or upload the balance as .xlsx or .csv"),
    PPTX: ("a PowerPoint file (.pptx)",
           "upload the trial balance itself, as PDF, .xlsx or .csv"),
    ODF: ("an OpenDocument file (LibreOffice)",
           "export it as PDF or .xlsx and upload that"),
    XLS_OLE2: ("a legacy Microsoft Office file (.xls or .doc)",
               "rename an Excel balance to .xls, or save a Word file as PDF"),
    ZIP_UNKNOWN: ("a ZIP archive, not a document",
                  "upload the balance file itself, not an archive of it"),
    TEXT: ("a text file",
           "rename it to .csv if it is a trial balance export, or upload the PDF or Excel"),
    UNKNOWN: ("not a readable document",
              "re-export the balance from your accounting software as PDF, .xlsx or .csv"),
}


def mismatch_message(claimed_extension: str, real_kind: str,
                     filename: Optional[str] = None) -> str:
    """One sentence of fact and one of instruction, for a file whose
    bytes contradict its name. Kept here beside the labels so a new
    label cannot be added without an answer for the person reading it."""
    described, action = _ADVICE.get(real_kind, _ADVICE[UNKNOWN])
    shown = f" {filename!r}" if filename else ""
    return (
        f"This file{shown} is named {claimed_extension} but its contents are "
        f"{described}, so no reader can open it as {claimed_extension}. "
        f"To fix it: {action}."
    )
