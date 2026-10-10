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

ONE UPLOAD POLICY, READ BY REAL TYPE (coordinator ruling 2026-10-02).
This module is the ONE authority on what an upload is and whether any
reader opens it: `classify` (the branch its name claims), `sniff_container`
(what its bytes are), `reads_as_pdf` (the bytes go through the .pdf
branch's readers whatever the name says), `reads_as_workbook` (workbook
bytes named .pdf go through the spreadsheet branch's readers), `refused_on`
(no reader on the branch opens them) and `upload_refusal` (the verdict and
the sentence).
`pipeline.stage_extract` reads it at both guard sites and the workspace
upload card's routes (`_uploads`, /api/uploads/identify and /commit) read
the SAME function — what the pipeline reads the card reads, what it
refuses the card refuses, in the same sentence, in the reader's language.

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
#: Excel's BINARY workbook: a zip with `xl/workbook.bin`. openpyxl and
#: xlrd both refuse it, so it is told apart from XLSX — calling it XLSX
#: would advise "rename it to .xlsx", which reads nothing.
XLSB = "xlsb"
DOCX = "docx"
PPTX = "pptx"
ODF = "odf"
#: A zip that declares itself Open XML (`[Content_Types].xml`) but carries
#: no `xl/`, `word/` or `ppt/` payload. openpyxl locates the workbook part
#: through that manifest, so a workbook with an unusual layout lands here
#: and must stay readable where openpyxl runs.
OOXML_UNKNOWN = "ooxml_unknown"
#: OLE2 (compound file) containers, told apart by the stream names at the
#: root of their directory. XLS_OLE2 is ALSO the answer for any OLE2 file
#: that cannot be named with certainty — a real .xls must never be
#: refused because its directory was unusual.
XLS_OLE2 = "xls_ole2"
DOC_OLE2 = "doc_ole2"
PPT_OLE2 = "ppt_ole2"
ZIP_UNKNOWN = "zip_unknown"
TEXT = "text"
#: Zero bytes. Not UNKNOWN: "we cannot name this" is the wrong sentence
#: for a file that arrived empty, and the fix is different.
EMPTY = "empty"
UNKNOWN = "unknown"


def looks_like_pdf(file_bytes: bytes) -> bool:
    """True when `%PDF-` appears within the first `PDF_MAGIC_WINDOW` bytes."""
    if not file_bytes:
        return False
    return PDF_MAGIC in file_bytes[:PDF_MAGIC_WINDOW]


#: How far into an UNREADABLE zip the payload folder names are looked for
#: (from each end), so a cut-off Word file is still named a Word file.
_TRUNCATED_ZIP_WINDOW = 262144


def _zip_flavour(file_bytes: bytes) -> str:
    """Name an OOXML/ODF zip by the directories inside it.

    A truncated or encrypted archive raises inside zipfile. Its payload
    folder names still sit in the local file headers, so a cut-off Word or
    PowerPoint file is named by them (no reader opens either, whole or
    cut); anything else unreadable is `zip_unknown` — never a crash, this
    function never raises. A cut-off workbook is NOT named XLSX: that
    label is read on the .pdf and spreadsheet branches, and no reader
    opens a truncated archive.
    """
    try:
        with zipfile.ZipFile(io.BytesIO(file_bytes)) as zf:
            names = zf.namelist()
            joined = "\n".join(names)
            # `[Content_Types].xml` is present in all OOXML; the payload
            # folder is what distinguishes them.
            if "xl/workbook.bin" in names:
                return XLSB
            if "xl/" in joined:
                return XLSX
            if "word/" in joined:
                return DOCX
            if "ppt/" in joined:
                return PPTX
            if "mimetype" in names:
                # Never inflate an entry just because it is named
                # `mimetype`: a real ODF declaration is well under 100
                # bytes, and a crafted 200 MB entry under that name drove
                # 419 MB of allocation here. The DECLARED size is not a
                # bound — an archive can declare 39 bytes and still carry
                # a 1 GB stream, and `zf.read()` inflates the whole stream
                # in one call before truncating it (measured: +201 MB for
                # a 199 KB upload, +1,001 MB for 995 KB). Only a bounded
                # read is: at most `_MIMETYPE_MAX_BYTES + 1` bytes come
                # out, whatever the header claims.
                info = zf.getinfo("mimetype")
                if info.file_size <= _MIMETYPE_MAX_BYTES:
                    with zf.open(info) as fh:
                        mt = fh.read(_MIMETYPE_MAX_BYTES + 1).decode(
                            "ascii", "replace")
                    if "opendocument" in mt:
                        return ODF
            if "[Content_Types].xml" in names:
                return OOXML_UNKNOWN
    except Exception:  # noqa: BLE001 — an unreadable zip is still a zip
        window = file_bytes[:_TRUNCATED_ZIP_WINDOW] + file_bytes[-_TRUNCATED_ZIP_WINDOW:]
        if b"word/" in window:
            return DOCX
        if b"ppt/" in window:
            return PPTX
        return ZIP_UNKNOWN
    return ZIP_UNKNOWN


def _ole2_flavour(file_bytes: bytes) -> str:
    """Name an OLE2 compound file by the streams at the root of its
    directory: `Workbook` / `Book` is Excel (BIFF8 / BIFF5 — the two
    names xlrd itself looks for), `WordDocument` is Word, `PowerPoint
    Document` is PowerPoint.

    2026-10-01 review: every OLE2 file used to be called XLS_OLE2, so a
    legacy Word .doc passed the guard under every name and repeated the
    2026-09-23 incident word for word ("Claude extraction failed: … credit
    balance is too low"). Reading the directory costs no stream content.

    CONSERVATIVE BY CONSTRUCTION: a workbook stream wins over anything
    else at the root, and a directory that cannot be read, or that names
    none of the three, stays XLS_OLE2 — the label the spreadsheet branch
    reads. Only the ROOT is consulted: a Word file with an embedded Excel
    object carries a `Workbook` stream inside `ObjectPool`, not at the root.
    """
    try:
        from xlrd import compdoc  # pinned in requirements-lock; pure
        cd = compdoc.CompDoc(file_bytes, logfile=io.StringIO())
        root = {cd.dirlist[c].name.lower() for c in cd.dirlist[0].children}
    except Exception:  # noqa: BLE001 — unreadable directory: stay XLS
        return XLS_OLE2
    if "workbook" in root or "book" in root:
        return XLS_OLE2
    if "worddocument" in root:
        return DOC_OLE2
    if "powerpoint document" in root:
        return PPT_OLE2
    return XLS_OLE2


def sniff_container(file_bytes: bytes) -> str:
    """The real container behind an upload's bytes.

    Order matters, and NOT in the obvious direction: the unambiguous
    offset-0 signatures (zip, OLE2) decide before the PDF window search,
    because that search can match text sitting inside another container.
    A text heuristic is the last resort. Returns one of the module's
    label constants; never raises.
    """
    if not file_bytes:
        return EMPTY
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
        # OLE2 carries .xls, .doc and .ppt alike; the root of the CFB
        # directory tells them apart (see `_ole2_flavour`).
        return _ole2_flavour(file_bytes)
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
    except UnicodeDecodeError as exc:
        # Two kinds of real text fail that test, and "not a readable
        # document" is the wrong sentence for a CSV that reads the moment it
        # is named .csv:
        #  · a UTF-8 file cut mid-character by the 2,048-byte window — valid
        #    up to its last three bytes, and longer than the window;
        #  · a legacy code-page export (cp1250 / ISO-8859-2 — what a
        #    Romanian ERP writes), invalid the moment it carries a diacritic.
        if len(file_bytes) > len(head) and exc.start >= len(head) - 3:
            return TEXT
        return TEXT if _looks_like_legacy_text(head) else UNKNOWN
    return TEXT


#: Non-letters above 0x7F that ordinary text carries in a Central European
#: code page: the no-break space, quotation marks, dashes, the ellipsis, the
#: euro, degree and section signs.
_LEGACY_TEXT_MARKS = frozenset("\u00a0\u201e\u201d\u201c\u2019\u2018\u2013\u2014\u2026\u20ac\u00b0\u00a7\u00ab\u00bb")


def _looks_like_legacy_text(head: bytes) -> bool:
    """True when bytes that are not UTF-8 read as text in cp1250: no control
    byte but whitespace, every byte defined in the code page, and every
    character above ASCII a LETTER (ă, â, î, ş, ţ and their capitals sit at
    the same code points in cp1250 and ISO-8859-2) or an ordinary
    typographic mark. Deliberately narrow — a label that goes into the
    sentence a person reads: a binary file's high bytes decode to symbols
    (a PNG's first byte is "‰", a JPEG's "˙"), never to a run of letters,
    and stay unnameable."""
    if any(b < 0x20 and b not in (0x09, 0x0A, 0x0C, 0x0D) for b in head):
        return False
    try:
        text = head.decode("cp1250")
    except UnicodeDecodeError:
        return False
    return all(ch.isalpha() or ch in _LEGACY_TEXT_MARKS for ch in text if ord(ch) > 0x7F)


def classify(filename: Optional[str], mime: Optional[str]) -> str:
    """The branch an upload's NAME and declared MIME type claim: 'pdf' |
    'xlsx' | 'csv' | 'image_jpeg' | 'image_png' | 'text' | 'unknown'.

    A claim, not evidence — `stage_extract` and the upload routes both
    start from it and then read the bytes. It lives here (it was
    `pipeline._classify_file`, which now delegates) so the route and the
    pipeline classify one way.
    """
    mime = (mime or "").lower()
    name = (filename or "").lower()
    if mime == "application/pdf" or name.endswith(".pdf"):
        return "pdf"
    if "spreadsheet" in mime or name.endswith(".xlsx") or name.endswith(".xls"):
        return "xlsx"
    if mime == "text/csv" or name.endswith(".csv"):
        return "csv"
    if mime == "image/jpeg" or name.endswith((".jpg", ".jpeg")):
        return "image_jpeg"
    if mime == "image/png" or name.endswith(".png"):
        return "image_png"
    if mime.startswith("text/") or name.endswith(".txt"):
        return "text"
    return "unknown"


#: The containers that reach NO reader in this engine, on any path: an
#: Office document is neither a balance PDF nor a workbook (a legacy .doc
#: or .ppt no more than a .docx or .pptx), a binary .xlsb is read by
#: neither openpyxl nor xlrd, and an empty file is nothing at all — so
#: every branch refuses these unconditionally. Everything else is decided
#: per branch by `refused_on`, from what that branch's readers actually
#: accept.
REACHES_NO_READER = frozenset({DOCX, PPTX, ODF, DOC_OLE2, PPT_OLE2, XLSB, EMPTY})

#: Workbook and archive containers. `stage_extract`'s text branches (csv,
#: text, image, unknown) cannot read them: their readers are the CSV parser
#: (which decodes the bytes as text) and Claude's text or image lane, so a
#: workbook or any archive becomes decoded binary — measured: an Excel
#: balance named balanta.csv went to the model as 172,681 characters of
#: zip bytes, and named .png as `image/png`. A PDF is NOT in this set: PDF
#: bytes are read by the .pdf branch's readers under every name
#: (`reads_as_pdf`).
_CONTAINERS_NO_TEXT_READER = frozenset({XLSX, XLS_OLE2, OOXML_UNKNOWN, ZIP_UNKNOWN})

#: `%%EOF` — the last line of every PDF. How far from the end it may sit.
_PDF_TRAILER = b"%%EOF"
_PDF_TRAILER_WINDOW = 2048


def reads_as_pdf(kind: str, real: str, file_bytes: bytes) -> bool:
    """True when these bytes are read by the .pdf branch's readers on
    `stage_extract`'s `kind` branch — the strict text-line balanta reader
    first (its refusal is final), then the positional reader under the .pdf
    branch's acceptance gate, then the PDF model lane. ONE reading of a PDF,
    whatever its name: `stage_extract` re-enters its own .pdf branch with
    the bytes, so a balance PDF named .xls, .xlsx or .csv yields the
    extraction the same bytes yield named .pdf, or the same refusal.

    (Before 2026-10-02 the spreadsheet branch sent `%PDF` bytes straight to
    the positional reader and accepted on "any rows": a five-pair balanta
    named .xls was served with ONE account and a credit-first one with its
    net profit sign-flipped — the read the .pdf branch refuses.)

    · sniffed PDF (`%PDF-` in the first 1,024 bytes, no zip / OLE2
      signature): on every branch.
    · text or unnameable bytes carrying `%PDF-` further in (a header pushed
      past the sniffer's window — pdfminer and the model both tolerate it):
      on the .pdf and spreadsheet branches, where no other reader opens
      such bytes; on the text and image branches only when the file also
      ENDS like a PDF (`%%EOF` in its last 2,048 bytes) — a CSV that
      merely mentions "%PDF-" stays a CSV.
    """
    if real == PDF:
        return True
    if real in (TEXT, UNKNOWN) and PDF_MAGIC in file_bytes:
        if kind in ("pdf", "xlsx"):
            return True
        return _PDF_TRAILER in file_bytes[-_PDF_TRAILER_WINDOW:]
    return False


#: The containers the spreadsheet branch's readers open: any Open XML zip
#: through openpyxl (it finds the workbook part through `[Content_Types].xml`,
#: so an unrecognised Open XML zip is tried too) and OLE2 through xlrd.
_WORKBOOK_CONTAINERS = frozenset({XLSX, XLS_OLE2, OOXML_UNKNOWN})


def reads_as_workbook(kind: str, real: str) -> bool:
    """True when these bytes are read by the SPREADSHEET branch's readers on
    `stage_extract`'s `kind` branch: a workbook under its own name, and a
    workbook named .pdf — the mirror of `reads_as_pdf`. `stage_extract`
    re-enters its spreadsheet branch with the bytes, so a workbook named
    .pdf yields the extraction the same bytes yield named .xlsx or .xls —
    the statutory F30/F10 detector, the trial-balance reader on the
    spreadsheet branch's own acceptance, the workbook rendered as text for
    the model — or the same failure.

    (Before 2026-10-02, review round 3, the .pdf branch read a workbook with
    its positional reader under the .pdf acceptance gate — account 121 or 50
    accounts — and refused what that declined: a small balanced balance and
    a statutory F30/F10 return, both read under their own names, were refused
    as "named .pdf but its contents are an Excel workbook" AFTER the upload
    card had answered that the file is read. One verdict now, at both
    layers, and one read.)

    NOT on the text and image branches: a workbook named .csv, .txt or .png
    is refused there by name (`_CONTAINERS_NO_TEXT_READER`) — the person
    chose a text or image type, and the fix is said in one sentence.
    """
    return kind in ("pdf", "xlsx") and real in _WORKBOOK_CONTAINERS


def refused_on(kind: str, real: str, file_bytes: bytes) -> bool:
    """True when NO reader on `stage_extract`'s `kind` branch can open a
    file whose bytes are `real` — the one policy every guard site reads
    (both of `stage_extract`'s, and the upload routes through
    `upload_refusal`), kept HERE beside the labels so they cannot drift.

    Per branch, from the readers that branch actually runs:

    · everywhere — `REACHES_NO_READER` is refused, and bytes that
      `reads_as_pdf` are never refused: the .pdf branch's readers read them.
    · `pdf` and `xlsx` — the same answer, because the two names lead to the
      same two families of reader: PDF bytes to the .pdf branch's readers
      (`reads_as_pdf`) and a workbook to the spreadsheet branch's
      (`reads_as_workbook`), which open any zip through openpyxl (it needs
      `[Content_Types].xml`) and OLE2 through xlrd. So XLSX, OOXML_UNKNOWN
      and XLS_OLE2 are read. A zip
      with no Open XML manifest is not, and text or unnameable bytes are
      not: measured 2026-10-02 on the spreadsheet branch, `_xlsx_to_text`
      and `parse_trial_balance` both raise on them and the AI lane's
      renderer is openpyxl only — a CSV named .xls ended "RuntimeError:
      Unrecognized spreadsheet format … try Save As → Excel Workbook",
      in English, with the wrong fix.
    · `csv` / `text` / `unknown` — text readers only:
      `_CONTAINERS_NO_TEXT_READER` is refused. Text and unnameable bytes
      (a UTF-16 CSV is "unknown") are not.
    · `image_*` — the model's image lane only, so text is refused too.
      Unnameable bytes are not: every real PNG or JPEG sniffs `unknown`.
    """
    if real in REACHES_NO_READER:
        return True
    if reads_as_pdf(kind, real, file_bytes):
        return False
    if kind in ("pdf", "xlsx"):
        return real in (ZIP_UNKNOWN, TEXT, UNKNOWN)
    if real in _CONTAINERS_NO_TEXT_READER:
        return True
    if kind in ("image_jpeg", "image_png") and real == TEXT:
        return True
    return False


def claimed_extension(filename: Optional[str], kind: str) -> str:
    """The extension to quote back at the person — theirs, not ours.

    `_classify_file` maps any `application/pdf` MIME to kind 'pdf' and any
    'spreadsheet' MIME to 'xlsx' BEFORE it looks at the name, so a message
    built from `kind` could quote the file's own name and then deny it:
    a LibreOffice `balanta.ods` was being told it "is named .xlsx/.xls".
    The real suffix is what the person typed and what they can change.

    A name with no suffix on a branch chosen by nothing but the bytes
    (`unknown`) returns "" — there is no claim to contradict, so
    `mismatch_message` uses its no-extension shape instead of printing a
    placeholder ("is named that type") into the sentence.
    """
    if filename and "." in filename.rsplit("/", 1)[-1]:
        suffix = filename.rsplit(".", 1)[-1].strip().lower()
        if suffix and len(suffix) <= 12 and suffix.isalnum():
            return "." + suffix
    return {"xlsx": ".xlsx/.xls", "csv": ".csv", "pdf": ".pdf",
            "image_jpeg": ".jpg", "image_png": ".png",
            "text": ".txt"}.get(kind, "")


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
    XLSB: ("an Excel binary workbook (.xlsb)",
           "open it in Excel and use File → Save as → Excel Workbook (.xlsx), "
           "then upload that"),
    DOCX: ("a Word document (.docx)",
           "open it and use File → Save as → PDF, or upload the balance as .xlsx or .csv"),
    PPTX: ("a PowerPoint file (.pptx)",
           "upload the trial balance itself, as PDF, .xlsx or .csv"),
    PPT_OLE2: ("a legacy PowerPoint file (.ppt)",
               "upload the trial balance itself, as PDF, .xlsx or .csv"),
    ODF: ("an OpenDocument file (LibreOffice)",
           "export it as PDF or .xlsx and upload that"),
    OOXML_UNKNOWN: ("an Office file of a kind this app does not recognise",
                    "save the balance as .xlsx or PDF and upload that"),
    XLS_OLE2: ("an older Microsoft Office file (such as .xls)",
               "if it is an Excel balance, rename it to .xls and upload it "
               "again; otherwise save it as PDF or .xlsx"),
    DOC_OLE2: ("a legacy Word document (.doc)",
               "open it and use File → Save as → PDF, or upload the balance "
               "as .xlsx or .csv"),
    ZIP_UNKNOWN: ("a ZIP archive or a damaged file, not a document",
                  "upload the balance file itself, not an archive of it; if "
                  "the file was cut off, export or download it again"),
    TEXT: ("a text file",
           "rename it to .csv if it is a trial balance export, or upload the PDF or Excel"),
    EMPTY: ("an empty file (0 bytes)",
            "export or download the balance again and upload the complete file"),
    UNKNOWN: ("not a readable document",
              "re-export the balance from your accounting software as PDF, .xlsx or .csv"),
}

#: The same table for a reader in the Romanian interface (§26: every word
#: in the reader's language). Informal "tu", as across ro.json. Kept beside
#: the English one so a label cannot gain an answer in one language only —
#: `test_every_label_is_answered_in_both_languages` reds on the gap.
_ADVICE_RO = {
    PDF: ("un document PDF",
          "redenumește-l cu extensia .pdf și încarcă-l din nou"),
    XLSX: ("un registru Excel (.xlsx)",
           "redenumește-l cu extensia .xlsx și încarcă-l din nou — balanțele "
           "Excel se citesc direct"),
    XLSB: ("un registru Excel binar (.xlsb)",
           "deschide-l în Excel și folosește Fișier → Salvare ca → Registru "
           "de lucru Excel (.xlsx), apoi încarcă fișierul acela"),
    DOCX: ("un document Word (.docx)",
           "deschide-l și folosește Fișier → Salvare ca → PDF, sau încarcă "
           "balanța ca .xlsx sau .csv"),
    PPTX: ("o prezentare PowerPoint (.pptx)",
           "încarcă balanța de verificare propriu-zisă, ca PDF, .xlsx sau .csv"),
    PPT_OLE2: ("o prezentare PowerPoint mai veche (.ppt)",
               "încarcă balanța de verificare propriu-zisă, ca PDF, .xlsx sau .csv"),
    ODF: ("un fișier OpenDocument (LibreOffice)",
          "exportă-l ca PDF sau .xlsx și încarcă fișierul acela"),
    OOXML_UNKNOWN: ("un fișier Office pe care aplicația nu îl recunoaște",
                    "salvează balanța ca .xlsx sau PDF și încarcă fișierul acela"),
    XLS_OLE2: ("un fișier Microsoft Office mai vechi (de exemplu .xls)",
               "dacă este o balanță Excel, redenumește-l cu extensia .xls și "
               "încarcă-l din nou; altfel salvează-l ca PDF sau .xlsx"),
    DOC_OLE2: ("un document Word mai vechi (.doc)",
               "deschide-l și folosește Fișier → Salvare ca → PDF, sau încarcă "
               "balanța ca .xlsx sau .csv"),
    ZIP_UNKNOWN: ("o arhivă ZIP sau un fișier deteriorat, nu un document",
                  "încarcă fișierul balanței, nu o arhivă cu el; dacă fișierul "
                  "s-a tăiat pe drum, exportă-l sau descarcă-l din nou"),
    TEXT: ("un fișier text",
           "dacă este un export al balanței de verificare, redenumește-l cu "
           "extensia .csv; altfel încarcă PDF-ul sau fișierul Excel"),
    EMPTY: ("un fișier gol (0 octeți)",
            "exportă sau descarcă din nou balanța și încarcă fișierul complet"),
    UNKNOWN: ("un fișier pe care nu îl putem citi",
              "exportă din nou balanța din programul de contabilitate, ca PDF, "
              ".xlsx sau .csv"),
}


#: The extensions each label legitimately wears. Used only to tell a
#: MISMATCH ("named .pdf, actually Word") from an UNSUPPORTED FORMAT
#: ("a Word document, named .docx"). Without the distinction, a person
#: who uploads an honestly-named balanta.docx is told their file "is
#: named .docx but its contents are a Word document (.docx)" — a sentence
#: that contradicts itself and blames them for a naming error they did
#: not make. XLSX wears only .xlsx: a workbook is refused only off the
#: spreadsheet branch (a .xlsm, say), where "rename it to .xlsx" is the
#: fix, so the sentence must not also say "this app cannot read" it.
_NATURAL_EXTENSIONS = {
    PDF: {".pdf"},
    XLSX: {".xlsx"},
    XLSB: {".xlsb"},
    DOCX: {".docx", ".docm"},
    PPTX: {".pptx", ".ppt"},
    PPT_OLE2: {".ppt", ".pps"},
    ODF: {".ods", ".odt", ".odp"},
    XLS_OLE2: {".xls"},
    DOC_OLE2: {".doc", ".dot"},
    TEXT: {".txt", ".csv", ".tsv"},
}


def _is_romanian(language: Optional[str]) -> bool:
    """`documents.detected_language` carries the uploader's UI language
    (`/api/pipeline/run` writes `output_language` there before the run);
    anything but Romanian reads English, the engine's default."""
    return (language or "").strip().lower()[:2] == "ro"


def mismatch_message(claimed_extension: str, real_kind: str,
                     filename: Optional[str] = None,
                     language: Optional[str] = None) -> str:
    """One sentence of fact and one of instruction, for a file this engine
    will not read, in the reader's language (`language`, the document's
    `detected_language`: "ro" → Romanian, anything else → English). Kept
    here beside the labels so a new label cannot be added without an
    answer for the person reading it.

    Four shapes, because four different things go wrong: a file whose
    bytes contradict its name; a file that is exactly what it says it is
    and is still unreadable here; a file with NO extension, which
    contradicts nothing — telling that one "this app cannot read" a PDF or
    a workbook would be false, so it is told what its contents are and how
    to name it; and a file that arrived empty, whatever its name.
    """
    ro = _is_romanian(language)
    table = _ADVICE_RO if ro else _ADVICE
    described, action = table.get(real_kind, table[UNKNOWN])
    shown = f" {filename!r}" if filename else ""
    claimed = (claimed_extension or "").lower()
    unnamed = not claimed.startswith(".")
    honest = claimed in _NATURAL_EXTENSIONS.get(real_kind, frozenset())
    if real_kind == EMPTY:
        if ro:
            return (f"Fișierul{shown} este {described}: nu conține nimic de "
                    f"citit. Ca să rezolvi: {action}.")
        return (f"This file{shown} is {described}: there is nothing in it "
                f"to read. To fix it: {action}.")
    if ro:
        if unnamed:
            return (
                f"Fișierul{shown} nu are extensie, iar conținutul lui este "
                f"{described}. Ca să rezolvi: {action}."
            )
        if honest:
            return (
                f"Fișierul{shown} este {described}, iar aplicația nu poate "
                f"citi acest tip de fișier. Ca să rezolvi: {action}."
            )
        return (
            f"Fișierul{shown} are extensia {claimed_extension}, dar de fapt "
            f"este {described}, așa că nu îl putem deschide ca "
            f"{claimed_extension}. Ca să rezolvi: {action}."
        )
    if unnamed:
        return (
            f"This file{shown} has no file extension, and its contents are "
            f"{described}. To fix it: {action}."
        )
    if honest:
        return (
            f"This file{shown} is {described}, which this app cannot read. "
            f"To fix it: {action}."
        )
    return (
        f"This file{shown} is named {claimed_extension} but its contents are "
        f"{described}, so no reader can open it as {claimed_extension}. "
        f"To fix it: {action}."
    )


def upload_refusal(filename: Optional[str], mime: Optional[str],
                   file_bytes: bytes,
                   language: Optional[str] = None) -> Optional[tuple]:
    """THE VERDICT on an upload, for every caller that has its name, its
    declared MIME type and its bytes: None when a reader opens it, else
    `(real_label, sentence)` — the label `sniff_container` gives the bytes
    and the sentence `mismatch_message` writes, in the reader's language.

    One composition of the pieces above — `classify` → `sniff_container` →
    `refused_on` → `mismatch_message` — so `stage_extract`'s guards and the
    upload card's routes (`_uploads.format_mismatch`) cannot answer
    differently for the same file. Never raises.
    """
    kind = classify(filename, mime)
    real = sniff_container(file_bytes)
    if not refused_on(kind, real, file_bytes):
        return None
    return real, mismatch_message(
        claimed_extension(filename, kind), real,
        filename=filename or None, language=language,
    )
