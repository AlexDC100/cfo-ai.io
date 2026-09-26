"""An upload whose bytes contradict its name is refused by name, not by Claude.

THE INCIDENT (2026-09-23). A prospect uploaded
`balanta_de_verificare_07.2025.pdf`, which was a Word document renamed —
PK zip header, no `%PDF-` anywhere. Nothing in stage_extract's PDF branch
read the bytes, so the positional ingester failed, the text-line reader
failed, and the document reached `financial_statements.parse_document`,
where Anthropic answered 400 "your credit balance is too low". The user
was told our billing was broken when their file had never been a PDF, and
the request was spent to learn what a four-byte header already said.

WHAT THESE RED ON, with the defect repaired (TC-11):
  · a non-PDF reaching any reader or any model call on the .pdf path
  · the refusal naming the wrong type, or naming none
  · the refusal message failing to say what the person should do
  · a REAL pdf being refused (the positive control — a guard that
    refuses everything would pass every test above)
  · zip flavours collapsing into one label, which is what
    `_detect_spreadsheet_format` does and why it cannot answer this
"""
from __future__ import annotations

import io
import sys
import zipfile
from pathlib import Path
from typing import Any, Dict

import pytest

REPO = Path(__file__).resolve().parents[2]
SRC = REPO / "src"
if SRC.is_dir() and str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from engine.api import _upload_type as ut  # noqa: E402

CORPUS = REPO / "corpus"


# ── building the real containers, not mocks of them ─────────────────

def _ooxml(payload_dir: str) -> bytes:
    """A minimal but genuine OOXML zip: the folder name is what tells
    xlsx, docx and pptx apart, so that is what varies."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("[Content_Types].xml", "<Types/>")
        zf.writestr("_rels/.rels", "<Relationships/>")
        zf.writestr(f"{payload_dir}/document.xml", "<document/>")
    return buf.getvalue()


def _odf() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("mimetype", "application/vnd.oasis.opendocument.spreadsheet")
        zf.writestr("content.xml", "<office/>")
    return buf.getvalue()


def _real_xlsx() -> bytes:
    from openpyxl import Workbook
    wb = Workbook()
    wb.active["A1"] = "Cont"
    b = io.BytesIO()
    wb.save(b)
    return b.getvalue()


# ── the sniffer ────────────────────────────────────────────────────

@pytest.mark.parametrize("payload,expected", [
    ("xl", ut.XLSX),
    ("word", ut.DOCX),
    ("ppt", ut.PPTX),
])
def test_zip_flavours_are_told_apart(payload, expected):
    """The incident file was a docx. `_detect_spreadsheet_format` calls
    every PK zip "xlsx", which would have sent it to openpyxl — a
    different wrong answer, not a right one."""
    assert ut.sniff_container(_ooxml(payload)) == expected


def test_a_real_openpyxl_workbook_is_xlsx():
    assert ut.sniff_container(_real_xlsx()) == ut.XLSX


def test_opendocument_is_named():
    assert ut.sniff_container(_odf()) == ut.ODF


def test_legacy_ole2_is_not_a_pdf():
    assert ut.sniff_container(b"\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1" + b"\x00" * 64) == ut.XLS_OLE2


def test_a_truncated_zip_is_still_reported_as_a_zip():
    """An unreadable archive must not raise out of a pure sniffer."""
    assert ut.sniff_container(b"PK\x03\x04" + b"\x00" * 20) == ut.ZIP_UNKNOWN


def test_text_and_empty_and_binary():
    assert ut.sniff_container(b"Cont;Denumire;Debit;Credit\n") == ut.TEXT
    assert ut.sniff_container(b"") == ut.UNKNOWN
    assert ut.sniff_container(b"\x00\xff\xfe\x01" * 8) == ut.UNKNOWN


def test_nul_padded_binary_is_not_called_a_text_file():
    """`b"\x00" * n` decodes as valid UTF-8, so a decode-only heuristic
    labels a binary blob "a text file" — and that label is what the
    refusal message tells the person their file is."""
    assert ut.sniff_container(b"\x00" * 4096) == ut.UNKNOWN
    assert "text file" not in ut.mismatch_message(".pdf", ut.sniff_container(b"\x00" * 4096))


def test_a_real_pdf_is_a_pdf():
    """POSITIVE CONTROL, on a committed real book rather than a header
    fragment — the corpus PDF that production reads today."""
    p = CORPUS / "pdf_positional" / "input.pdf"
    if not p.is_file():
        pytest.skip("corpus pdf_positional/input.pdf not present")
    assert ut.sniff_container(p.read_bytes()) == ut.PDF


def test_a_pdf_header_after_leading_junk_is_still_a_pdf():
    """Some writers emit bytes before `%PDF-`; refusing those would be a
    new failure for files that open everywhere else."""
    assert ut.sniff_container(b"\n\n" + ut.PDF_MAGIC + b"1.4\n%%EOF") == ut.PDF
    # ...but not arbitrarily deep, or the check means nothing.
    assert ut.sniff_container(b"\x00" * 5000 + ut.PDF_MAGIC) != ut.PDF


# ── the message a person reads ─────────────────────────────────────

def test_every_label_has_an_action_and_never_blames_our_billing():
    """The old failure text said "Claude extraction failed: your credit
    balance is too low" for a file that was never a PDF. No message here
    may mention credit, billing or Claude, and each must say what to do."""
    labels = [ut.XLSX, ut.DOCX, ut.PPTX, ut.ODF, ut.XLS_OLE2,
              ut.ZIP_UNKNOWN, ut.TEXT, ut.UNKNOWN, "a_label_added_later"]
    for label in labels:
        msg = ut.mismatch_message(".pdf", label, filename="balanta.pdf")
        assert "To fix it:" in msg, label
        assert "'balanta.pdf'" in msg, label
        low = msg.lower()
        for forbidden in ("credit", "balance is too low", "claude", "anthropic", "api"):
            assert forbidden not in low, f"{label}: message mentions {forbidden!r}"


def test_the_word_case_names_word():
    msg = ut.mismatch_message(".pdf", ut.DOCX, filename="balanta_de_verificare_07.2025.pdf")
    assert "Word" in msg and ".docx" in msg
    assert "Save as" in msg or "save as" in msg


# ── the pipeline seam: nothing downstream is reached ───────────────

@pytest.fixture
def pdf_upload(monkeypatch):
    """Drive the REAL stage_extract PDF branch over local bytes.

    Two I/O seams are stubbed (the signed URL and the download). The
    Claude lane is stubbed at its own entry point — `financial_statements
    .build_router`, which stage_extract imports at call time — so
    "did this document reach the paid path?" is answered by a recorder
    rather than by inference. An earlier version of this fixture guarded
    `__import__("anthropic")` instead; the plant run showed that guard
    never fires, because the Claude lane downloads the file over the
    network BEFORE it constructs a model client. It was asserting nothing.
    """
    import contextlib
    import types
    from engine.api import financial_statements as FS
    from engine.api import pipeline as P

    monkeypatch.setenv("ANTHROPIC_API_KEY", "must-never-be-used")
    monkeypatch.setenv("CFO_AI_SKIP_BOOT_VERIFY", "1")

    calls: Dict[str, int] = {"claude_lane": 0}

    def _claude_lane_entered(*a: Any, **k: Any):
        calls["claude_lane"] += 1
        raise AssertionError(
            "stage_extract reached the Claude lane (financial_statements."
            "build_router) — in production this downloads the upload again "
            "and calls Anthropic"
        )

    monkeypatch.setattr(FS, "build_router", _claude_lane_entered)

    # The xlsx/csv fallback does NOT go through financial_statements — it
    # constructs `anthropic.Anthropic` directly (pipeline.py ~1567). An
    # earlier version of this suite stubbed only the seam above, and the
    # positive-control test made a REAL request to Anthropic (a 401 on
    # the fake key). Block the SDK itself so no test here can reach the
    # network or spend anything, whatever path it takes.
    try:
        import anthropic as _anthropic

        def _no_client(*a: Any, **k: Any):
            calls["claude_lane"] += 1
            raise AssertionError(
                "stage_extract constructed an Anthropic client — this upload "
                "reached the paid path"
            )

        monkeypatch.setattr(_anthropic, "Anthropic", _no_client)
    except ImportError:  # SDK absent is the same guarantee
        pass

    def _run(content: bytes, filename: str):
        class _Admin:
            def signed_url(self, *a: Any, **k: Any) -> str:
                return "https://not-fetched.invalid/upload"

            def update(self, *a: Any, **k: Any) -> None:
                return None

        @contextlib.contextmanager
        def _admin():
            yield _Admin()

        class _Resp:
            content = b""

            def raise_for_status(self) -> None:
                return None

        class _Client:
            def __init__(self, *a: Any, **k: Any) -> None:
                pass

            def __enter__(self):
                return self

            def __exit__(self, *a: Any) -> bool:
                return False

            def get(self, url: str) -> _Resp:
                r = _Resp()
                r.content = content
                return r

        monkeypatch.setattr(P, "_supabase", types.SimpleNamespace(admin=_admin))
        monkeypatch.setattr(P, "httpx", types.SimpleNamespace(Client=_Client))

        doc = {
            "id": "upload-type-probe",
            "org_id": "00000000-0000-0000-0000-000000000000",
            "storage_path": "test/" + filename,
            "original_filename": filename,
            "uploaded_by": None,
        }
        return P.stage_extract(doc)

    _run.calls = calls  # type: ignore[attr-defined]
    return _run


def test_a_docx_named_pdf_is_refused_before_the_paid_path(pdf_upload):
    """The incident, end to end through the real branch. The refusal must
    arrive INSTEAD of the Claude lane, not after it: with the guard
    disabled this same test fails with "reached the Claude lane"."""
    from engine.api.pipeline import UploadedFileTypeMismatchError

    with pytest.raises(UploadedFileTypeMismatchError) as e:
        pdf_upload(_ooxml("word"), "balanta_de_verificare_07.2025.pdf")
    msg = str(e.value)
    assert "Word" in msg
    assert "balanta_de_verificare_07.2025.pdf" in msg
    assert "credit" not in msg.lower()
    assert pdf_upload.calls["claude_lane"] == 0  # type: ignore[attr-defined]


def test_an_xlsx_named_pdf_is_told_to_be_renamed(pdf_upload):
    from engine.api.pipeline import UploadedFileTypeMismatchError

    with pytest.raises(UploadedFileTypeMismatchError) as e:
        pdf_upload(_real_xlsx(), "balanta.pdf")
    assert ".xlsx" in str(e.value)


def test_a_real_corpus_pdf_still_parses_through_the_same_branch(pdf_upload):
    """POSITIVE CONTROL at the seam. The refusal sits ahead of both
    deterministic readers, so if it were wrong it would take production's
    working PDF path with it."""
    p = CORPUS / "pdf_positional" / "input.pdf"
    if not p.is_file():
        pytest.skip("corpus pdf_positional/input.pdf not present")
    parsed = pdf_upload(p.read_bytes(), "input.pdf")
    assert parsed.get("detected_type") == "trial_balance"
    assert parsed.get("accounts"), "the real PDF produced no accounts"
    assert pdf_upload.calls["claude_lane"] == 0  # type: ignore[attr-defined]


# ── the same fault on the spreadsheet path ─────────────────────────

@pytest.fixture
def sheet_upload(pdf_upload):
    """The xlsx/csv branch of the same real stage_extract, reusing the
    pdf_upload fixture's stubs (identical seams; only the filename
    extension decides which branch runs)."""
    return pdf_upload


def test_a_docx_named_xlsx_is_refused_before_the_paid_path(sheet_upload):
    """`_detect_spreadsheet_format` calls every PK zip "xlsx", so this
    file used to reach openpyxl, raise, and fall through to Claude."""
    from engine.api.pipeline import UploadedFileTypeMismatchError

    with pytest.raises(UploadedFileTypeMismatchError) as e:
        sheet_upload(_ooxml("word"), "balanta.xlsx")
    assert "Word" in str(e.value)
    assert sheet_upload.calls["claude_lane"] == 0  # type: ignore[attr-defined]


def test_a_pdf_named_csv_is_told_to_rename_it_not_that_it_is_unreadable(sheet_upload):
    """A real PDF is not "not a readable document" — the refusal must name
    it as a PDF and ask for the right extension."""
    from engine.api.pipeline import UploadedFileTypeMismatchError

    p = CORPUS / "pdf_positional" / "input.pdf"
    if not p.is_file():
        pytest.skip("corpus pdf_positional/input.pdf not present")
    with pytest.raises(UploadedFileTypeMismatchError) as e:
        sheet_upload(p.read_bytes(), "balanta.csv")
    msg = str(e.value)
    assert "PDF" in msg and "rename it to .pdf" in msg
    assert "not a readable document" not in msg


def test_real_corpus_books_still_parse_through_the_guarded_path(sheet_upload):
    """POSITIVE CONTROL on the busiest path in production, on REAL books
    rather than a one-cell workbook.

    A trivial workbook is the wrong control here: it is not a trial
    balance, so it legitimately falls through to the Claude fallback
    today, and asserting otherwise tested my fixture rather than the
    guard (it made a real 401 request to Anthropic before the SDK was
    blocked). A real corpus book parses deterministically, so this
    asserts the guard lets the actual product path through untouched.
    """
    for rel, name in (("saga_10_col/input.xlsx", "balanta.xlsx"),
                      ("csv/input.csv", "balanta.csv")):
        p = CORPUS / rel
        if not p.is_file():
            continue
        parsed = sheet_upload(p.read_bytes(), name)
        assert parsed.get("detected_type") == "trial_balance", rel
        assert parsed.get("accounts"), rel
    assert sheet_upload.calls["claude_lane"] == 0  # type: ignore[attr-defined]


def test_text_and_unnameable_bytes_keep_todays_behaviour(sheet_upload):
    """The guard is deliberately narrow: a CSV mistakenly named .xlsx, or
    bytes we cannot name, must NOT be refused here — they can still
    succeed downstream, and refusing them would remove working uploads.
    Reds if someone widens the tuple to UNKNOWN/TEXT/ZIP_UNKNOWN."""
    from engine.api.pipeline import UploadedFileTypeMismatchError

    for content, name in ((b"Cont;Denumire;Debit;Credit\n100;Capital;;80\n", "balanta.xlsx"),
                          (b"PK\x03\x04" + b"\x00" * 20, "balanta.xlsx")):
        try:
            sheet_upload(content, name)
        except UploadedFileTypeMismatchError as e:  # pragma: no cover
            pytest.fail(f"{name} with {content[:8]!r} was refused as a type mismatch: {e}")
        except Exception:
            pass  # any other outcome is today's behaviour, unchanged
