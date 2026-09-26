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

#: An ODF `mimetype` entry is a single media-type string. Anything larger
#: is not one, and must not be inflated to find out.
_MIMETYPE_MAX_BYTES = 256

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
            joined = "\n".join(names)
            # `[Content_Types].xml` is present in all OOXML; the payload
            # folder is what distinguishes them.
            if "xl/" in joined:
                return XLSX
            if "word/" in joined:
                return DOCX
            if "ppt/" in joined:
                return PPTX
            if "mimetype" in names:
                # ONE open (this one), and never inflate an entry just
                # because it is named `mimetype`: a real ODF declaration
                # is well under 100 bytes, and a crafted 200 MB entry
                # under that name drove 419 MB of allocation here — a
                # 200 KB upload able to thrash the pipeline worker. The
                # declared size is checked before anything is read.
                info = zf.getinfo("mimetype")
                if info.file_size <= _MIMETYPE_MAX_BYTES:
                    mt = zf.read("mimetype").decode("ascii", "replace")
                    if "opendocument" in mt:
                        return ODF
    except Exception:  # noqa: BLE001 — an unreadable zip is still a zip
        return ZIP_UNKNOWN
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


#: The containers that reach NO reader in this engine, on any path: an
#: Office document is neither a balance PDF nor a workbook, so every
#: branch refuses these and only these unconditionally. Everything else
#: is decided per-branch by the caller, from what that branch's readers
#: actually accept — `parse_trial_balance` dispatches on magic bytes, so
#: an .xlsx under a .pdf name, or a balance PDF under a .xls name, is
#: read today and must keep being read. Kept HERE, beside the labels, so
#: the two call sites cannot drift apart.
REACHES_NO_READER = frozenset({DOCX, PPTX, ODF})


def claimed_extension(filename: Optional[str], kind: str) -> str:
    """The extension to quote back at the person — theirs, not ours.

    `_classify_file` maps any `application/pdf` MIME to kind 'pdf' and any
    'spreadsheet' MIME to 'xlsx' BEFORE it looks at the name, so a message
    built from `kind` could quote the file's own name and then deny it:
    a LibreOffice `balanta.ods` was being told it "is named .xlsx/.xls".
    The real suffix is what the person typed and what they can change.
    """
    if filename and "." in filename.rsplit("/", 1)[-1]:
        suffix = filename.rsplit(".", 1)[-1].strip().lower()
        if suffix and len(suffix) <= 12 and suffix.isalnum():
            return "." + suffix
    return {"xlsx": ".xlsx/.xls", "csv": ".csv", "pdf": ".pdf",
            "image_jpeg": ".jpg", "image_png": ".png",
            "text": ".txt"}.get(kind, "that type")


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
    DOC_OLE2: ("a legacy Word document (.doc)",
               "open it and use File → Save as → PDF, or upload the balance "
               "as .xlsx or .csv"),
    ZIP_UNKNOWN: ("a ZIP archive, not a document",
                  "upload the balance file itself, not an archive of it"),
    TEXT: ("a text file",
           "rename it to .csv if it is a trial balance export, or upload the PDF or Excel"),
    UNKNOWN: ("not a readable document",
              "re-export the balance from your accounting software as PDF, .xlsx or .csv"),
}


#: The extensions each label legitimately wears. Used only to tell a
#: MISMATCH ("named .pdf, actually Word") from an UNSUPPORTED FORMAT
#: ("a Word document, named .docx"). Without the distinction, a person
#: who uploads an honestly-named balanta.docx is told their file "is
#: named .docx but its contents are a Word document (.docx)" — a sentence
#: that contradicts itself and blames them for a naming error they did
#: not make.
_NATURAL_EXTENSIONS = {
    PDF: {".pdf"},
    XLSX: {".xlsx", ".xlsm", ".xlsb"},
    DOCX: {".docx", ".docm"},
    PPTX: {".pptx", ".ppt"},
    ODF: {".ods", ".odt", ".odp"},
    XLS_OLE2: {".xls", ".doc"},
    DOC_OLE2: {".doc"},
    TEXT: {".txt", ".csv", ".tsv"},
}


def mismatch_message(claimed_extension: str, real_kind: str,
                     filename: Optional[str] = None) -> str:
    """One sentence of fact and one of instruction, for a file this engine
    will not read. Kept here beside the labels so a new label cannot be
    added without an answer for the person reading it.

    Two shapes, because two different things go wrong: a file whose bytes
    contradict its name, and a file that is exactly what it says it is and
    still unreadable here.
    """
    described, action = _ADVICE.get(real_kind, _ADVICE[UNKNOWN])
    shown = f" {filename!r}" if filename else ""
    claimed = (claimed_extension or "").lower()
    if claimed in _NATURAL_EXTENSIONS.get(real_kind, frozenset()):
        return (
            f"This file{shown} is {described}, which this app cannot read. "
            f"To fix it: {action}."
        )
    return (
        f"This file{shown} is named {claimed_extension} but its contents are "
        f"{described}, so no reader can open it as {claimed_extension}. "
        f"To fix it: {action}."
    )
