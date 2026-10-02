#!/usr/bin/env python3
"""Everything a published file can carry a word in — for the two label scans.

`public-sample` S5 read cell values and three document properties of the
workbooks under public/sample, top-level files only. A client label written
into a workbook's `subject` / `keywords`, into the PDF's /Author, or into a
file in a subdirectory passed it (2026-10-02); and `bundle-labels` read text
suffixes only, so two spreadsheets under dist/templates that named a client
were "0 hits".

`parts(path)` yields (part name, text) for every place a word can sit:

  · a ZIP container (.xlsx, .xlsm, .docx, .pptx, .zip): the archive comment,
    every member's NAME, and every member's bytes, decompressed — the sheets,
    the shared strings, `docProps/core.xml` and `docProps/app.xml` (title,
    subject, creator, keywords, company, last-modified-by), custom
    properties, comments, defined names;
  · a PDF: the text layer page by page, the info dictionary (/Author,
    /Title, /Subject, /Keywords, /Creator, /Producer …), the XMP packet, and
    the file's own bytes with the compressed stream bodies cut out (object
    dictionaries, names, annotations written in the clear);
  · anything else: its raw bytes.

Bytes are decoded as Latin-1 (every byte survives) and, where the content
holds NUL bytes (UTF-16 strings, as PDF metadata often is), once more with
the NULs removed.

WHAT IS NOT READ, and why: the compressed bodies of a ZIP or a PDF as
compressed bytes — a three-letter label appears in any megabyte of
compressed data by chance; they are read DEcompressed instead. Pixels of an
image. A word split across two XML runs (`<t>ab</t><t>c</t>`).

Python 3.9 — no ``match``, no ``X | Y``.
"""
from __future__ import annotations

import io
import re
import zipfile
from pathlib import Path
from typing import Iterator, List, Tuple

ZIP_SUFFIXES = (".xlsx", ".xlsm", ".xltx", ".docx", ".pptx", ".zip", ".ods", ".odt")
_STREAM = re.compile(rb"stream\r?\n.*?endstream", re.S)


def _text(data: bytes) -> str:
    text = data.decode("latin-1")
    if b"\x00" in data:
        text += "\n" + data.replace(b"\x00", b"").decode("latin-1")
    return text


def _zip_parts(name: str, data: bytes) -> Iterator[Tuple[str, str]]:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        yield "%s!<names>" % name, "\n".join(
            [archive.comment.decode("latin-1")] + [info.filename for info in archive.infolist()]
            + [info.comment.decode("latin-1") for info in archive.infolist()])
        for info in archive.infolist():
            if info.is_dir():
                continue
            member = archive.read(info)
            if info.filename.lower().endswith(ZIP_SUFFIXES) and zipfile.is_zipfile(io.BytesIO(member)):
                for part in _zip_parts("%s!%s" % (name, info.filename), member):
                    yield part
            else:
                yield "%s!%s" % (name, info.filename), _text(member)


def _pdf_parts(name: str, data: bytes) -> Iterator[Tuple[str, str]]:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    for number, page in enumerate(reader.pages, 1):
        yield "%s!page-%d" % (name, number), page.extract_text() or ""
    info = reader.metadata or {}
    yield "%s!info" % name, "\n".join("%s=%s" % (key, value) for key, value in info.items())
    xmp = ""
    try:
        root = reader.trailer["/Root"]
        packet = root.get("/Metadata") if hasattr(root, "get") else None
        if packet is not None:
            xmp = _text(packet.get_object().get_data())
    except Exception:  # a PDF without a readable XMP packet has none to scan
        xmp = ""
    yield "%s!xmp" % name, xmp
    yield "%s!objects" % name, _text(_STREAM.sub(b"stream\nendstream", data))


def parts(path: Path, name: str = "") -> List[Tuple[str, str]]:
    """Every (part, text) of one published file."""
    label = name or path.name
    data = path.read_bytes()
    suffix = path.suffix.lower()
    if suffix in ZIP_SUFFIXES and zipfile.is_zipfile(io.BytesIO(data)):
        return list(_zip_parts(label, data))
    if suffix == ".pdf":
        return list(_pdf_parts(label, data))
    return [(label, _text(data))]


def files_under(*roots: Path) -> List[Path]:
    """Every file under the given directories, recursively, sorted."""
    out: List[Path] = []
    for root in roots:
        out += sorted(p for p in root.rglob("*") if p.is_file() and p.name != ".DS_Store")
    return out
