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
    # EMPTY, not UNKNOWN: "we cannot name this" is the wrong sentence for a
    # file that arrived with nothing in it, and the fix is different.
    assert ut.sniff_container(b"") == ut.EMPTY
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


def test_a_zip_containing_the_text_pdf_is_not_a_pdf():
    """The PDF header is SEARCHED FOR in a window, so a container that
    merely CARRIES that text early — an embedded PDF, an entry name in the
    archive directory — was classified as a PDF and waved through the
    guard. The offset-0 container signature has to win.

    Reds if `looks_like_pdf` is moved back above the zip/OLE2 checks. The
    window assertion comes first so the trap cannot silently disarm if
    zipfile ever lays the entry out differently.
    """
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("[Content_Types].xml", "<Types/>")
        zf.writestr("word/embedded/%PDF-decoy.bin", "%PDF-1.7 not really")
        zf.writestr("word/document.xml", "<document/>")
    blob = buf.getvalue()
    assert ut.PDF_MAGIC in blob[:ut.PDF_MAGIC_WINDOW], (
        "fixture no longer carries the decoy inside the window — this test "
        "would pass for the wrong reason"
    )
    assert ut.sniff_container(blob) == ut.DOCX


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
    # DERIVED from the module's own label constants, not hand-listed. The
    # first version listed them by hand and added "a_label_added_later" to
    # stand for future labels — but `_ADVICE.get(kind, _ADVICE[UNKNOWN])`
    # substitutes the UNKNOWN text for anything it does not know, so that
    # entry passed on every possible input while reading as if it proved
    # coverage. It also silently omitted PDF and DOC_OLE2, the latter
    # having had no entry at all. Measured then: adding an RTF label kept
    # 20/20 green while telling a user with a valid RTF that their file is
    # "not a readable document".
    labels = sorted({
        v for k, v in vars(ut).items()
        if k.isupper() and isinstance(v, str) and not k.startswith("_")
        and k not in ("PDF_MAGIC",)
    })
    assert len(labels) >= 9, f"label constants not discovered: {labels}"
    missing = [x for x in labels if x not in ut._ADVICE]
    assert missing == [], (
        f"labels with no _ADVICE entry, so mismatch_message would describe "
        f"them with the UNKNOWN text: {missing}"
    )
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

    def _run(content: bytes, filename: str, language: Any = None, mime: Any = None):
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
        if language is not None:
            # What /api/pipeline/run writes before the run: the UI language.
            doc["detected_language"] = language
        if mime is not None:
            doc["mime_type"] = mime
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


def test_an_excel_balance_named_pdf_is_READ_not_refused(pdf_upload):
    """THIS TEST REPLACES ONE THAT PINNED A DEFECT.

    Its earlier form asserted that an .xlsx named .pdf is refused. That
    was the guard being wrong, not the book: `pack.parse_trial_balance`
    dispatches on magic bytes, so the .pdf branch's own next reader parses
    Excel — measured on the held Carniprod canary, 367 accounts with the
    account-121 anchor. Refusing it deleted a working, free, anchored
    upload and told the user "no reader can open it as .pdf" while the
    reader forty lines below did exactly that.

    Per TC-11, a test that goes red when that is repaired would teach the
    next engineer to restore the regression, so it asserts the repair.
    """
    p = CORPUS / "saga_10_col_carniprod" / "input.xlsx"
    if not p.is_file():
        pytest.skip("corpus saga_10_col_carniprod/input.xlsx not present")
    parsed = pdf_upload(p.read_bytes(), "balanta_carniprod_2025.pdf")
    assert parsed.get("detected_type") == "trial_balance"
    assert len(parsed.get("accounts") or []) > 100
    assert parsed.get("statutory_net_profit_anchor") is not None
    assert pdf_upload.calls["claude_lane"] == 0  # type: ignore[attr-defined]


def test_a_balance_pdf_named_xls_is_READ_not_refused(sheet_upload):
    """The mirror image: a RAS balance PDF stored as .xls is read — by the
    .pdf branch's readers, which is where PDF bytes go under every name
    (`_upload_type.reads_as_pdf`), so the read IS the one the same bytes
    get named .pdf. The first version of this guard listed PDF in the
    spreadsheet refusal set and killed the upload; the second let the
    spreadsheet branch's own fast-path read it, which skipped the strict
    reader (the strict-layout laws further down)."""
    p = CORPUS / "pdf_positional" / "input.pdf"
    if not p.is_file():
        pytest.skip("corpus pdf_positional/input.pdf not present")
    parsed = sheet_upload(p.read_bytes(), "balanta_de_verificare_2025.xls")
    assert parsed.get("detected_type") == "trial_balance"
    assert parsed.get("accounts")
    assert parsed == sheet_upload(p.read_bytes(), "balanta_de_verificare_2025.pdf")
    assert sheet_upload.calls["claude_lane"] == 0  # type: ignore[attr-defined]


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


def test_a_pdf_named_csv_is_read_as_the_pdf_it_is(sheet_upload):
    """THIS TEST REPLACES ONE THAT PINNED THE OLD RULING ("a PDF named .csv
    is told to rename it"). Coordinator ruling 2026-10-02 — one upload
    policy, read by real type: PDF bytes go through the .pdf branch's
    readers on EVERY branch, so the person is not sent away to rename a
    file the engine can read. Reds if PDF returns to the text branches'
    refusal set, or if the read differs from the .pdf-named one."""
    p = CORPUS / "pdf_positional" / "input.pdf"
    if not p.is_file():
        pytest.skip("corpus pdf_positional/input.pdf not present")
    parsed = sheet_upload(p.read_bytes(), "balanta.csv")
    assert parsed.get("detected_type") == "trial_balance" and parsed.get("accounts")
    assert parsed == sheet_upload(p.read_bytes(), "balanta.pdf")
    assert sheet_upload.calls["claude_lane"] == 0  # type: ignore[attr-defined]


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
    ran = 0
    for rel, name in (("saga_10_col/input.xlsx", "balanta.xlsx"),
                      ("csv/input.csv", "balanta.csv")):
        p = CORPUS / rel
        if not p.is_file():
            continue
        ran += 1
        parsed = sheet_upload(p.read_bytes(), name)
        assert parsed.get("detected_type") == "trial_balance", rel
        assert parsed.get("accounts"), rel
    # `continue` alone made this test PASS, not skip, when neither book was
    # present — a green positive control that asserted nothing, and the
    # sole red for two guard inversions. Silence is not success.
    if not ran:
        pytest.fail(
            "neither corpus book was found, so this positive control "
            "verified nothing — it must not report green"
        )
    assert sheet_upload.calls["claude_lane"] == 0  # type: ignore[attr-defined]


@pytest.mark.parametrize("name", ["balanta.xlsx", "balanta.xls"])
def test_the_spreadsheet_branch_refuses_by_name_what_none_of_its_readers_opens(sheet_upload, name):
    """THIS TEST REPLACES ONE THAT PINNED A DEFECT. Its earlier form
    ("text and unnameable bytes keep today's behaviour") asserted that a
    CSV named .xlsx and a cut-off archive are NOT refused, on the premise
    that "they can still succeed downstream". Measured 2026-10-02 they
    cannot: `parse_trial_balance` and `_xlsx_to_text` both raise on them
    and the AI lane's renderer is openpyxl only. The run ended "RuntimeError:
    Unrecognized spreadsheet format … try Save As → Excel Workbook (.xlsx)"
    — English whatever the interface, class name included, and the wrong
    fix for a CSV — after constructing a model client.

    Reds on: text, unnameable bytes or a zip with no Open XML manifest
    reaching a reader or a model client on the spreadsheet branch; the
    refusal not naming the file, the real type and the fix; a Romanian
    reader told it in English."""
    cases = {
        "a UTF-8 csv": (b"Cont;Denumire;Debit;Credit\n100;Capital;;80\n", "text file", "rename it to .csv"),
        "a cp1250 csv": ("Cont;Denumire\n101;Capital subscris v\u0103rsat;\u021bar\u0103\n".encode("cp1250", "replace")
                         + "121;Rezultat \u00een curs\n".encode("cp1250"), "text file", "rename it to .csv"),
        "an HTML export": (b"<html><table><tr><td>Cont</td><td>101</td></tr></table></html>",
                           "text file", "rename it to .csv"),
        "a UTF-16 csv": ("Cont;Denumire\n101;Capital\n".encode("utf-16"),
                         "not a readable document", "re-export the balance"),
        "a cut-off archive": (b"PK\x03\x04" + b"\x00" * 20, "ZIP archive or a damaged file", "export or download it again"),
        "a zip of a workbook": (_zip_of({"balanta.xlsx": _real_xlsx()}), "ZIP archive", "not an archive of it"),
    }
    for label, (content, described, fix) in cases.items():
        msg = _refused(sheet_upload, content, name)
        assert repr(name) in msg and described in msg and fix in msg, (label, msg)
        assert "RuntimeError" not in msg and "Save As" not in msg, (label, msg)
        ro = _refused(sheet_upload, content, name, "ro")
        assert "Ca să rezolvi:" in ro and "To fix it" not in ro, (label, ro)
    # Refused BEFORE the fallback: the earlier behaviour constructed a model
    # client on every one of these.
    assert sheet_upload.calls["claude_lane"] == 0  # type: ignore[attr-defined]


def test_legacy_code_page_text_is_text_not_unnameable():
    """A cp1250 / ISO-8859-2 export is not valid UTF-8 the moment it carries
    a diacritic, and a UTF-8 file can be cut mid-character by the sniffer's
    2,048-byte window — both were "not a readable document". They are text:
    the sentence a person gets must say "rename it to .csv". A binary blob
    (control bytes) and a UTF-16 file (NULs) stay unnameable."""
    cp1250 = "Cont;Denumire\n101;Capital v\u0103rsat\n".encode("cp1250")
    with pytest.raises(UnicodeDecodeError):
        cp1250.decode("utf-8")
    assert ut.sniff_container(cp1250) == ut.TEXT
    cut = ("a" * 2047 + "\u0103").encode("utf-8")  # the window ends inside the character
    with pytest.raises(UnicodeDecodeError):
        cut[:2048].decode("utf-8")
    assert ut.sniff_container(cut) == ut.TEXT
    assert ut.sniff_container(b"\x01\x02\xff\xfe" * 16) == ut.UNKNOWN
    assert ut.sniff_container("Cont;Denumire\n".encode("utf-16")) == ut.UNKNOWN
    assert ut.sniff_container(_png()) == ut.UNKNOWN
    # NARROW: high bytes that are not letters are not text. A bare PNG or
    # JPEG signature has no NUL and no control byte, and must stay
    # unnameable — on an image branch "a text file" would REFUSE it (the
    # first form of this rule called a 4-byte PNG stub text, and a stored
    # scan stopped reaching the image lane).
    assert ut.sniff_container(b"\x89PNG") == ut.UNKNOWN
    assert ut.sniff_container(b"\xff\xd8\xff\xe0JFIF and more bytes") == ut.UNKNOWN
    assert ut.sniff_container(b"cont;denumire\n101;\x81\x8d\x8f\n") == ut.UNKNOWN  # undefined in cp1250
    assert not ut.refused_on("image_png", ut.sniff_container(b"\x89PNG"), b"\x89PNG")
    committed = CORPUS / "csv" / "input.csv"
    if committed.is_file():
        assert ut.sniff_container(committed.read_bytes()) == ut.TEXT


def test_the_guard_still_runs_when_the_first_download_fails(monkeypatch):
    """The .pdf branch's bytes come from the public-records download,
    which is inside a try that logs and continues. When it failed, the
    guard was skipped — and the Claude lane below fetches its OWN copy and
    pays, so one flaky storage read reproduced the whole incident on a
    file that was never a PDF. The guard now fetches once for itself.

    Reds if that refetch is removed.
    """
    import contextlib
    import types
    from engine.api import financial_statements as FS
    from engine.api import pipeline as P
    from engine.api.pipeline import UploadedFileTypeMismatchError

    monkeypatch.setenv("ANTHROPIC_API_KEY", "must-never-be-used")
    content = _ooxml("word")
    attempts = {"n": 0}

    class _Admin:
        def signed_url(self, *a: Any, **k: Any) -> str:
            return "https://not-fetched.invalid/upload"

        def update(self, *a: Any, **k: Any) -> None:
            return None

    @contextlib.contextmanager
    def _admin():
        yield _Admin()

    class _Resp:
        def __init__(self, c: bytes) -> None:
            self.content = c

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
            attempts["n"] += 1
            if attempts["n"] == 1:
                raise RuntimeError("storage read failed (simulated flake)")
            return _Resp(content)

    monkeypatch.setattr(P, "_supabase", types.SimpleNamespace(admin=_admin))
    monkeypatch.setattr(P, "httpx", types.SimpleNamespace(Client=_Client))

    def _paid(*a: Any, **k: Any):
        raise AssertionError("reached the Claude lane after a failed first fetch")

    monkeypatch.setattr(FS, "build_router", _paid)
    try:
        import anthropic as _anthropic
        monkeypatch.setattr(_anthropic, "Anthropic", _paid)
    except ImportError:
        pass

    doc = {
        "id": "upload-type-refetch",
        "org_id": "00000000-0000-0000-0000-000000000000",
        "storage_path": "test/balanta_de_verificare_07.2025.pdf",
        "original_filename": "balanta_de_verificare_07.2025.pdf",
        "uploaded_by": None,
    }
    with pytest.raises(UploadedFileTypeMismatchError) as e:
        P.stage_extract(doc)
    assert "Word" in str(e.value)
    assert attempts["n"] >= 2, "the guard did not fetch after the first failure"


def test_an_honestly_named_word_file_is_not_accused_of_lying():
    """A genuine balanta.docx is unreadable here, but the person did not
    misname anything. The mismatch sentence applied to it read "is named
    .docx but its contents are a Word document (.docx)" — self-
    contradictory, and it blamed them for an error they did not make."""
    honest = ut.mismatch_message(".docx", ut.DOCX, filename="balanta.docx")
    assert "but its contents are" not in honest
    assert "cannot read" in honest
    assert "Save as" in honest or "save as" in honest

    # ...while a real mismatch still says so.
    renamed = ut.mismatch_message(".pdf", ut.DOCX, filename="balanta.pdf")
    assert "is named .pdf but its contents are" in renamed


def test_the_honest_and_mismatched_forms_both_carry_an_action():
    for claimed, kind in ((".docx", ut.DOCX), (".ods", ut.ODF), (".pdf", ut.DOCX),
                          (".csv", ut.PDF), (".xlsx", ut.PPTX)):
        msg = ut.mismatch_message(claimed, kind, filename="f" + claimed)
        assert "To fix it:" in msg
        assert "credit" not in msg.lower() and "claude" not in msg.lower()


# ── release r-rulings2 (2026-10-01): the natural form and the stored sentence ──

def test_an_honestly_named_docx_is_refused_through_the_real_branch(sheet_upload):
    """THE 2026-09-23 INCIDENT FILE IN ITS NATURAL FORM, end to end: a Word
    document uploaded as ``balanta.docx`` is classified ``unknown`` and used
    to reach the paid fallback. Through the REAL stage_extract it is refused
    with the unsupported-format sentence — never the self-contradicting
    "named .docx but its contents are a Word document" — before any reader
    or model call. The message-only test above never drove this branch.

    Reds if the guard covers only the renamed kinds (pdf / xlsx / csv), or
    if the honest form falls back to the mismatch sentence.
    """
    from engine.api import pipeline as P
    from engine.api.pipeline import UploadedFileTypeMismatchError

    doc = {"original_filename": "balanta.docx",
           "mime_type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}
    assert P._classify_file(doc) == "unknown"
    with pytest.raises(UploadedFileTypeMismatchError) as e:
        sheet_upload(_ooxml("word"), "balanta.docx")
    msg = str(e.value)
    assert "Word document" in msg and "which this app cannot read" in msg, msg
    assert "but its contents are" not in msg and "is named .docx" not in msg, msg
    assert "balanta.docx" in msg and "To fix it:" in msg, msg
    assert sheet_upload.calls["claude_lane"] == 0  # type: ignore[attr-defined]


def test_the_failure_handler_stores_the_sentence_without_a_class_name(monkeypatch):
    """`documents.error` is what the upload card prints. The release's
    failure handler (in `_run_pipeline_stages`) already stored a
    `PlainRefusal` as its own sentence; the type refusal joins it through
    `UserFacingUploadError`. Driven through the REAL `_run_pipeline_sync`
    (the daemon thread's terminal) with stage_extract raising, over an
    in-memory documents table.

    Reds if the handler prefixes the class name onto the sentence written
    for the uploader ("UploadedFileTypeMismatchError: This file …") — the
    review finding this marker exists for — or stops naming the class of an
    unexpected exception, where the class IS the diagnosis.
    """
    import contextlib
    import types
    from engine.api import pipeline as P

    sentence = "This file 'balanta.pdf' is named .pdf but its contents are a Word document (.docx)."
    raised = {
        "type": P.UploadedFileTypeMismatchError(sentence),
        "plain": P.PlainRefusal("The file's own CUI is not this company's."),
        "other": RuntimeError("compute failed"),
    }
    stored: Dict[str, Any] = {}
    doc = {"id": "handler-probe", "org_id": "00000000-0000-0000-0000-000000000000",
           "storage_path": "test/balanta.pdf", "original_filename": "balanta.pdf",
           "mime_type": "application/pdf", "uploaded_by": None, "status": "queued",
           "scope": "financial"}

    class _Admin:
        def select(self, table: str, *a: Any, **k: Any) -> Any:
            return [dict(doc)] if table == "documents" else []

        def update(self, table: str, values: Dict[str, Any], *a: Any, **k: Any) -> Any:
            if table == "documents":
                stored.update(values)
            return [dict(doc, **values)]

        def __getattr__(self, name: str) -> Any:
            return lambda *a, **k: []

    @contextlib.contextmanager
    def _admin():
        yield _Admin()

    monkeypatch.setattr(P, "_supabase", types.SimpleNamespace(admin=_admin, per_user=_admin))
    monkeypatch.setattr(P, "_admin_set_status",
                        lambda _id, status, error=None, **k: stored.update(status=status, error=error))
    monkeypatch.setattr(P, "_rollback_period_of_failed_run", lambda *a, **k: None)
    seen = {}
    for key, exc in raised.items():
        stored.clear()

        def _extract(_doc: Any, _exc: BaseException = exc) -> Any:
            raise _exc

        monkeypatch.setattr(P, "stage_extract", _extract)
        P._run_pipeline_sync(doc["id"])
        assert stored.get("status") == "failed", (key, stored)
        seen[key] = stored.get("error")
    assert seen["type"] == sentence, seen
    assert seen["plain"] == "The file's own CUI is not this company's.", seen
    assert seen["other"] == "RuntimeError: compute failed", seen



# ── release r-rulings2 review (2026-10-01): what the guard still let through ──
#
# Four findings, each reproduced on the release head before the repair:
#   · a legacy Word .doc passed the guard under EVERY name — every OLE2 file
#     was called XLS_OLE2, which no branch refuses — and as balanta.pdf it
#     reached the Claude PDF lane and came back with the 2026-09-23
#     incident's sentence word for word;
#   · files no reader on their branch can open (text, an empty file, a PNG,
#     a zip of a PDF, a truncated docx on the .pdf branch; an Excel book on
#     the csv / text / image / unknown branches) still went to the model —
#     119 of 247 runs of the review's matrix, 45 after (all of them text or
#     unnameable bytes on a text branch, and real PDFs on the PDF lane);
#   · the ODF `mimetype` bound read the DECLARED size, which an archive can
#     lie about (+201 MB peak for a 199 KB upload);
#   · the refusal was English only (§26: the reader's language).
#
# WHAT THESE RED ON, after the repair (TC-11): a legacy Word or PowerPoint
# file reaching any reader or the model on any branch, under any name; a real
# .xls (a `Workbook` / `Book` stream at the root) refused on the spreadsheet
# branch; an empty file reaching anything; a workbook, a PDF, an OLE2 file or
# an archive reaching a TEXT reader; text or unnameable bytes without `%PDF-`
# reaching the PDF readers; a non-PDF reaching the Claude PDF lane after the
# positional reader declined it; a real PDF (header past the sniff window
# included) refused; the `mimetype` read inflating a stream that lies about
# its size; a Romanian reader told the refusal in English, an English reader
# in Romanian, or a label with an answer in one language only; a file with no
# extension told "this app cannot read" a PDF.

import struct  # noqa: E402

FIXTURES = REPO / "tests" / "engine" / "fixtures" / "upload_type"

#: A REAL Word 97-2004 document (macOS `textutil -convert doc`, two lines of
#: neutral text). Its OLE2 directory holds `1Table` and `WordDocument` and no
#: `Workbook` — the shape of the file the review uploaded.
WORD97 = FIXTURES / "word97_textutil.doc"

_ENDOFCHAIN, _FREESECT, _FATSECT, _NOSTREAM = 0xFFFFFFFE, 0xFFFFFFFF, 0xFFFFFFFD, 0xFFFFFFFF


def _cfb(streams: Dict[str, bytes]) -> bytes:
    """A minimal valid OLE2 compound file (CFB v3) holding `streams` at the
    ROOT of its directory — the part `_ole2_flavour` reads. Each stream is
    padded past 4096 bytes so none lives in the mini stream; read back by the
    same `xlrd.compdoc` the guard uses (the round-trip is asserted below)."""
    S = 512
    names = list(streams)
    datas = [streams[n] + b"\x00" * max(0, 4096 - len(streams[n])) for n in names]
    dir_secs = ((1 + len(names)) * 128 + S - 1) // S
    fat = [_FATSECT]
    first_dir = len(fat)
    for i in range(dir_secs):
        fat.append(first_dir + i + 1 if i < dir_secs - 1 else _ENDOFCHAIN)
    starts = []
    for d in datas:
        nsec = (len(d) + S - 1) // S
        starts.append(len(fat))
        for i in range(nsec):
            fat.append(len(fat) + 1 if i < nsec - 1 else _ENDOFCHAIN)
    assert len(fat) <= 128
    fat += [_FREESECT] * (128 - len(fat))

    def entry(name: str, etype: int, right: int, child: int, start: int, size: int) -> bytes:
        raw = name.encode("utf-16-le") + b"\x00\x00"
        e = raw.ljust(64, b"\x00")
        e += struct.pack("<HBBIII", len(raw), etype, 1, _NOSTREAM, right, child)
        e += b"\x00" * 36 + struct.pack("<IQ", start, size)
        return e

    ents = [entry("Root Entry", 5, _NOSTREAM, 1 if names else _NOSTREAM, _ENDOFCHAIN, 0)]
    for i, d in enumerate(datas):
        right = i + 2 if i + 1 < len(names) else _NOSTREAM
        ents.append(entry(names[i], 2, right, _NOSTREAM, starts[i], len(d)))
    dir_bytes = b"".join(ents)
    blank = b"\x00" * 64 + struct.pack("<HBBIII", 0, 0, 0, _NOSTREAM, _NOSTREAM, _NOSTREAM) + b"\x00" * 48
    dir_bytes += blank * ((dir_secs * S - len(dir_bytes)) // 128)
    hdr = b"\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1" + b"\x00" * 16
    hdr += struct.pack("<HHHHH", 0x3E, 3, 0xFFFE, 9, 6) + b"\x00" * 6
    hdr += struct.pack("<IIIIIIIII", 0, 1, first_dir, 0, 4096, _ENDOFCHAIN, 0, _ENDOFCHAIN, 0)
    hdr += struct.pack("<I", 0) + struct.pack("<I", _FREESECT) * 108
    body = struct.pack("<128I", *fat) + dir_bytes
    for d in datas:
        body += d.ljust(((len(d) + S - 1) // S) * S, b"\x00")
    return hdr + body


def _zip_of(entries: Dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for n, d in entries.items():
            zf.writestr(n, d)
    return buf.getvalue()


def _png() -> bytes:
    import zlib

    def chunk(t: bytes, d: bytes) -> bytes:
        return (struct.pack(">I", len(d)) + t + d
                + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"\x00\xff\xff\xff")) + chunk(b"IEND", b""))


def _corpus(rel: str) -> bytes:
    p = CORPUS / rel
    if not p.is_file():
        pytest.skip(f"corpus {rel} not present")
    return p.read_bytes()


@pytest.fixture
def readers(monkeypatch):
    """Counts every call into the two deterministic trial-balance readers —
    so "refused before any reader" is measured, not inferred."""
    from engine.api import pipeline as P

    seen: Dict[str, int] = {"parse_trial_balance": 0, "parse_trial_balance_csv": 0}
    pack_cls = type(P._ro_pack())
    for attr in list(seen):
        orig = getattr(pack_cls, attr)

        def _counted(*a: Any, _orig: Any = orig, _attr: str = attr, **k: Any) -> Any:
            seen[_attr] += 1
            return _orig(*a, **k)

        monkeypatch.setattr(pack_cls, attr, _counted)
    return seen


def _refused(run: Any, content: bytes, name: str, language: Any = None) -> str:
    from engine.api.pipeline import UploadedFileTypeMismatchError

    with pytest.raises(UploadedFileTypeMismatchError) as e:
        run(content, name, language)
    return str(e.value)


# ── OLE2 told apart by its directory ───────────────────────────────

def test_the_cfb_builder_round_trips_through_the_reader_the_guard_uses():
    """Non-vacuity for every synthetic OLE2 below: xlrd's own compound-file
    reader lists the streams this builder wrote, at the root."""
    from xlrd import compdoc

    cd = compdoc.CompDoc(_cfb({"WordDocument": b"w" * 600, "1Table": b"t"}), logfile=io.StringIO())
    assert sorted(cd.dirlist[c].name for c in cd.dirlist[0].children) == ["1Table", "WordDocument"]


@pytest.mark.parametrize("streams,expected", [
    ({"WordDocument": b"\xec\xa5" + b"w" * 600, "1Table": b"t" * 100}, ut.DOC_OLE2),
    ({"PowerPoint Document": b"p" * 600, "Current User": b"c" * 50}, ut.PPT_OLE2),
    ({"Workbook": b"\x09\x08" + b"x" * 600}, ut.XLS_OLE2),        # BIFF8
    ({"Book": b"\x09\x08" + b"x" * 600}, ut.XLS_OLE2),            # BIFF5
    # A workbook stream WINS: whatever else sits at the root, xlrd reads it.
    ({"WordDocument": b"w" * 600, "Workbook": b"x" * 600}, ut.XLS_OLE2),
    # Nothing it can name stays XLS_OLE2 — never refused on the sheet branch.
    ({"Something": b"s" * 600}, ut.XLS_OLE2),
])
def test_ole2_containers_are_named_by_their_root_streams(streams, expected):
    assert ut.sniff_container(_cfb(streams)) == expected


def test_a_real_word97_document_is_a_legacy_word_document():
    """The real file, not the builder: the shape the review uploaded."""
    assert ut.sniff_container(WORD97.read_bytes()) == ut.DOC_OLE2


def test_an_unreadable_ole2_directory_stays_xls():
    """CONSERVATIVE: a directory the reader cannot walk is never called
    Word — a real .xls must not be refused because its header was odd."""
    assert ut.sniff_container(b"\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1" + b"\xff" * 2048) == ut.XLS_OLE2


@pytest.mark.parametrize("name", [
    "balanta_de_verificare_07.2025.pdf",   # the incident's name, the .pdf branch
    "balanta.doc",                          # its own name — `unknown`
    "balanta.xls",                          # the spreadsheet branch
    "balanta.csv",
    "balanta.txt",
    "balanta",
])
def test_a_legacy_word_doc_is_refused_under_every_name_before_any_reader(pdf_upload, readers, name):
    """THE FINDING, end to end through the real stage_extract: a legacy Word
    file under any name is refused by name — before either deterministic
    reader and before the model. On the release head this reached the
    Claude PDF lane as balanta.pdf and a paid text call under every other
    name."""
    msg = _refused(pdf_upload, WORD97.read_bytes(), name)
    assert "legacy Word document (.doc)" in msg, msg
    assert "Save as" in msg and "To fix it:" in msg, msg
    assert "credit" not in msg.lower() and "claude" not in msg.lower(), msg
    assert readers == {"parse_trial_balance": 0, "parse_trial_balance_csv": 0}, readers
    assert pdf_upload.calls["claude_lane"] == 0  # type: ignore[attr-defined]


@pytest.mark.parametrize("name", ["balanta.ppt", "balanta.pdf", "balanta.xls"])
def test_a_legacy_powerpoint_is_refused_under_every_name(pdf_upload, readers, name):
    """FINANCIAL_UPLOAD_ACCEPT advertises .ppt; a legacy PowerPoint is OLE2
    too and reached a paid garbage-text call under its own name."""
    msg = _refused(pdf_upload, _cfb({"PowerPoint Document": b"p" * 600}), name)
    assert "PowerPoint" in msg and "(.ppt)" in msg, msg
    assert readers == {"parse_trial_balance": 0, "parse_trial_balance_csv": 0}, readers
    assert pdf_upload.calls["claude_lane"] == 0  # type: ignore[attr-defined]


def test_an_xls_is_never_refused_on_the_spreadsheet_branch(sheet_upload):
    """POSITIVE CONTROL for the narrowing: an OLE2 workbook named .xls goes to
    its reader (xlrd) — it is not refused by type, whatever happens next (this
    synthetic workbook carries no BIFF records, so it falls through to the
    fallback exactly as before)."""
    from engine.api.pipeline import UploadedFileTypeMismatchError

    content = _cfb({"Workbook": b"\x09\x08" + b"x" * 600})
    assert ut.refused_on("xlsx", ut.sniff_container(content), content) is False
    try:
        sheet_upload(content, "balanta.xls")
    except UploadedFileTypeMismatchError as e:
        pytest.fail(f"an OLE2 workbook named .xls was refused by type: {e}")
    except Exception:  # noqa: BLE001 — xlrd refusing junk, or the fallback tripwire
        pass


# ── per-branch: what no reader on THIS branch can open ─────────────

def test_the_pdf_branch_refuses_what_none_of_its_readers_opens(pdf_upload, readers):
    """The .pdf branch's readers: the text-line reader and Claude (PDF
    only), and the positional reader (`%PDF`, a zip with an Open XML
    manifest, OLE2). Each of these reached `parse_trial_balance`, failed,
    and went to the Claude PDF lane on the release head."""
    docx = _ooxml("word")
    cases = {
        "plain text": b"Balanta de verificare\nCont 101 Capital 1000\n",
        "a UTF-16 csv": "Cont;Denumire;Debit\n101;Capital;1000\n".encode("utf-16"),
        "an empty file": b"",
        "a PNG": _png(),
        "a zip of a PDF": _zip_of({"balanta.pdf": _corpus("pdf_positional/input.pdf")}),
        "a zip of a workbook": _zip_of({"balanta.xlsx": _real_xlsx()}),
        "a truncated docx": docx[: len(docx) // 2],
    }
    for label, content in cases.items():
        msg = _refused(pdf_upload, content, "balanta.pdf")
        assert "'balanta.pdf'" in msg and "To fix it:" in msg, (label, msg)
    assert readers == {"parse_trial_balance": 0, "parse_trial_balance_csv": 0}, readers
    assert pdf_upload.calls["claude_lane"] == 0  # type: ignore[attr-defined]


def test_the_pdf_branch_still_reads_a_pdf_whose_header_sits_past_the_window(pdf_upload):
    """POSITIVE CONTROL: a real PDF with 2,000 leading junk bytes sniffs
    `unknown` (its header is past the 1,024-byte window) — pdfminer and the
    model both tolerate it, so the guard must not refuse it: it reaches the
    readers and, here, the Claude lane tripwire."""
    from engine.api.pipeline import UploadedFileTypeMismatchError

    content = b"J" * 2000 + _corpus("pdf_positional/input.pdf")
    # Not PDF by the sniffer (text or unnameable, by what the window holds):
    assert ut.sniff_container(content) in (ut.TEXT, ut.UNKNOWN)
    assert ut.reads_as_pdf("pdf", ut.sniff_container(content), content)
    with pytest.raises(AssertionError, match="Claude lane"):
        try:
            pdf_upload(content, "balanta.pdf")
        except UploadedFileTypeMismatchError as e:
            pytest.fail(f"a real PDF with leading junk was refused: {e}")


def test_a_workbook_the_positional_reader_declines_never_reaches_the_claude_pdf_lane(pdf_upload, readers):
    """The type guard lets a workbook through on the .pdf branch — the
    positional reader opens workbooks by their bytes (the Carniprod law
    above). A workbook that is NOT a trial balance is declined there, and
    the release head then sent it to Anthropic as `application/pdf`. It is
    refused instead, with the fix: take the workbook's own name."""
    msg = _refused(pdf_upload, _real_xlsx(), "rezultate.pdf")
    assert "Excel workbook" in msg and "rename it to .xlsx" in msg, msg
    assert readers["parse_trial_balance"] >= 1, "the positional reader must still get its turn"
    assert pdf_upload.calls["claude_lane"] == 0  # type: ignore[attr-defined]
    # ...and an unrecognised Open XML zip and a junk OLE2 workbook the same way.
    for content in (_zip_of({"[Content_Types].xml": b"<Types/>", "workbook.xml": b"<w/>"}),
                    _cfb({"Workbook": b"\x09\x08" + b"x" * 600})):
        _refused(pdf_upload, content, "balanta.pdf")
    assert pdf_upload.calls["claude_lane"] == 0  # type: ignore[attr-defined]


@pytest.mark.parametrize("name", ["balanta.csv", "balanta.txt", "balanta.png", "balanta.zip",
                                  "balanta.xlsm", "balanta"])
def test_a_workbook_on_a_text_branch_is_told_to_take_its_own_name(sheet_upload, readers, name):
    """The csv / text / image / unknown branches read text (or an image):
    the release head sent the Excel book named balanta.csv to the model as
    172,681 characters of zip bytes, and named .png as `image/png`.
    "Rename it to .xlsx" also rescues a .xlsm, classified `unknown`."""
    xlsx = _corpus("saga_10_col/input.xlsx")
    msg = _refused(sheet_upload, xlsx, name)
    assert "Excel workbook" in msg and "rename it to .xlsx" in msg, msg
    if name == "balanta":
        assert "has no file extension" in msg and "cannot read" not in msg, msg
    assert readers["parse_trial_balance"] == 0, readers
    assert sheet_upload.calls["claude_lane"] == 0  # type: ignore[attr-defined]


@pytest.mark.parametrize("content_key", ["zip", "ole2"])
@pytest.mark.parametrize("name", ["balanta.csv", "balanta.txt", "balanta.png", "balanta"])
def test_no_container_reaches_a_text_reader(sheet_upload, name, content_key):
    """A workbook or an archive on a text branch is refused. (A PDF is not
    in this set since 2026-10-02: it is READ, by the .pdf branch's readers —
    `test_pdf_bytes_are_read_by_the_pdf_readers_under_every_name`.)"""
    content = {
        "zip": lambda: _zip_of({"balanta.pdf": b"%PDF-1.4 inside an archive"}),
        "ole2": lambda: _cfb({"Workbook": b"\x09\x08" + b"x" * 600}),
    }[content_key]()
    _refused(sheet_upload, content, name)
    assert sheet_upload.calls["claude_lane"] == 0  # type: ignore[attr-defined]


@pytest.mark.parametrize("name", ["balanta.pdf", "balanta.xlsx", "balanta.xls", "balanta.csv",
                                  "balanta.txt", "balanta.png", "balanta.doc", "balanta"])
def test_an_empty_file_reaches_nothing_under_any_name(pdf_upload, readers, name):
    msg = _refused(pdf_upload, b"", name)
    assert "empty file (0 bytes)" in msg and "nothing in it to read" in msg, msg
    assert "but its contents are" not in msg, msg
    assert readers == {"parse_trial_balance": 0, "parse_trial_balance_csv": 0}, readers
    assert pdf_upload.calls["claude_lane"] == 0  # type: ignore[attr-defined]


def test_text_branches_keep_text_and_unnameable_bytes(sheet_upload):
    """POSITIVE CONTROL for the widening: a real CSV is read; text named
    .txt, a UTF-16 CSV and a PNG under its own name are NOT refused by type
    (they reach their text / image readers as before — here, the tripwire)."""
    from engine.api.pipeline import UploadedFileTypeMismatchError

    parsed = sheet_upload(_corpus("csv/input.csv"), "balanta.csv")
    assert parsed.get("detected_type") == "trial_balance" and parsed.get("accounts")
    for content, name in ((b"Cont;Denumire;Debit;Credit\n101;Capital;;80\n", "balanta.txt"),
                          ("Cont;Denumire\n101;Capital\n".encode("utf-16"), "balanta.csv"),
                          (_png(), "balanta.png")):
        try:
            sheet_upload(content, name)
        except UploadedFileTypeMismatchError as e:
            pytest.fail(f"{name} was refused by type: {e}")
        except AssertionError as e:
            if "paid path" not in str(e) and "Claude lane" not in str(e):
                raise
        except Exception:  # noqa: BLE001 — today's behaviour, unchanged
            pass


# ── the ODF `mimetype` bound is a bound on what is READ ─────────────

def _lying_zip(mb: int, name: str = "mimetype") -> bytes:
    """A zip whose entry DECLARES 39 bytes (local and central headers) but
    whose deflated stream inflates to `mb` MB."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(name, b"\x00" * (mb << 20))
    data = bytearray(buf.getvalue())
    assert data[:4] == b"PK\x03\x04"
    struct.pack_into("<I", data, 22, 39)
    cd = data.rfind(b"PK\x01\x02")
    struct.pack_into("<I", data, cd + 24, 39)
    return bytes(data)


def test_a_mimetype_entry_that_lies_about_its_size_is_not_inflated():
    """`zf.read()` inflates the WHOLE stream in one call before truncating
    to the declared size: measured +201 MB peak for a 199 KB upload on the
    release head, on every upload under any name, before any reader. The
    bound is now on what is read. Measured with tracemalloc (the head:
    67 MB peak for this 47 KB file; the repair: 0.2 MB)."""
    import tracemalloc

    blob = _lying_zip(32)
    assert len(blob) < 64 * 1024, "the bomb must stay small for this to mean anything"
    tracemalloc.start()
    try:
        label = ut.sniff_container(blob)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert label == ut.ZIP_UNKNOWN
    assert peak < 8 * 1024 * 1024, f"sniffing a {len(blob)} B upload allocated {peak / 1e6:.0f} MB"


def test_a_real_opendocument_is_still_named_after_the_bounded_read():
    assert ut.sniff_container(_odf()) == ut.ODF


# ── the sentence in the reader's language (§26) ────────────────────

def _all_labels() -> list:
    return sorted({
        v for k, v in vars(ut).items()
        if k.isupper() and isinstance(v, str) and not k.startswith("_")
        and k not in ("PDF_MAGIC",)
    })


def test_every_label_is_answered_in_both_languages():
    labels = _all_labels()
    assert len(labels) >= 14, labels
    assert [x for x in labels if x not in ut._ADVICE] == []
    assert [x for x in labels if x not in ut._ADVICE_RO] == []
    assert set(ut._ADVICE) == set(ut._ADVICE_RO)


@pytest.mark.parametrize("claimed,name", [(".pdf", "balanta.pdf"), (".doc", "balanta.doc"),
                                          ("", "balanta")])
def test_a_romanian_reader_gets_every_refusal_in_romanian(claimed, name):
    """Every label, every shape: Romanian sentence and instruction, the
    file's own name, correct diacritics (comma-below ș / ț, never the
    cedilla forms), and no English left in it."""
    for label in _all_labels():
        msg = ut.mismatch_message(claimed, label, filename=name, language="ro")
        assert msg.startswith("Fișierul"), (label, msg)
        assert "Ca să rezolvi:" in msg and repr(name) in msg, (label, msg)
        for english in ("This file", "To fix it", "upload", "rename", "named", "which this app"):
            assert english not in msg, (label, english, msg)
        assert "ş" not in msg and "ţ" not in msg, (label, "cedilla", msg)
        low = msg.lower()
        for forbidden in ("credit", "claude", "anthropic", "api"):
            assert forbidden not in low, (label, forbidden, msg)


def test_the_language_is_the_readers_and_english_stays_the_default():
    for lang in (None, "", "en", "en-US", "de", "fr"):
        assert ut.mismatch_message(".pdf", ut.DOCX, "b.pdf", language=lang).startswith("This file")
    for lang in ("ro", "RO", "ro-RO"):
        assert ut.mismatch_message(".pdf", ut.DOCX, "b.pdf", language=lang).startswith("Fișierul")


def test_the_romanian_shapes_say_what_the_english_ones_say():
    mismatch = ut.mismatch_message(".pdf", ut.DOCX, "balanta.pdf", language="ro")
    assert "are extensia .pdf, dar de fapt este un document Word (.docx)" in mismatch, mismatch
    assert "Salvare ca" in mismatch, mismatch
    honest = ut.mismatch_message(".docx", ut.DOCX, "balanta.docx", language="ro")
    assert "nu poate citi" in honest and "are extensia" not in honest, honest
    unnamed = ut.mismatch_message("", ut.PDF, "balanta", language="ro")
    assert "nu are extensie" in unnamed and "nu poate citi" not in unnamed, unnamed
    empty = ut.mismatch_message(".xlsx", ut.EMPTY, "balanta.xlsx", language="ro")
    assert "fișier gol (0 octeți)" in empty and "are extensia" not in empty, empty


def test_a_file_with_no_extension_is_not_told_the_app_cannot_read_it():
    for label in (ut.PDF, ut.XLSX, ut.TEXT):
        msg = ut.mismatch_message("", label, filename="balanta")
        assert "has no file extension" in msg and "cannot read" not in msg, (label, msg)
        assert "is named" not in msg and "that type" not in msg, (label, msg)


@pytest.mark.parametrize("name", ["balanta_de_verificare_07.2025.pdf", "balanta.xlsx", "balanta.docx"])
def test_the_real_branch_answers_in_the_language_the_run_carries(pdf_upload, name):
    """/api/pipeline/run writes the UI language into
    `documents.detected_language` before the run; the refusal is read from
    there — Romanian for a Romanian reader, English otherwise."""
    content = _ooxml("word")
    ro = _refused(pdf_upload, content, name, "ro")
    assert ro.startswith("Fișierul") and "document Word (.docx)" in ro and "This file" not in ro, ro
    en = _refused(pdf_upload, content, name, "en")
    assert en.startswith("This file") and "Word document (.docx)" in en, en
    assert _refused(pdf_upload, content, name).startswith("This file")
    assert pdf_upload.calls["claude_lane"] == 0  # type: ignore[attr-defined]


# ════════════════════════════════════════════════════════════════════
# ONE UPLOAD POLICY, READ BY REAL TYPE (coordinator ruling 2026-10-02)
# ════════════════════════════════════════════════════════════════════
#
# The owner's expectation, verbatim: "Carniprod canary as balanta.pdf is
# read; a balance PDF as .xls is read; a Word file refused both ways".
#
# WHAT THE REVIEW FOUND ON THE RELEASE HEAD (eeafcadb), all reproduced:
#   · HIGH — a five-pair balanta PDF named .xls / .xlsx was served with ONE
#     account (121), MATERIAL_IMBALANCE; the credit-first variant with the
#     account-121 anchor at −12,345.67 (a profit served as a loss); the
#     off-by-a-cent one partially. Named .pdf the first is read whole and
#     the other two are refused for good. The strict reader ran on the .pdf
#     branch only.
#   · the upload card's routes carried their OWN table and refused the two
#     files the pipeline reads (the canary as .pdf, a balance PDF as .xls).
#   · the upload picker offered .ppt / .pptx, which every branch refuses.
#
# WHAT THESE RED ON, after the repair (TC-11): PDF bytes read by anything
# but the .pdf branch's readers under any name — a read that differs from
# the .pdf-named one by a byte, or a different refusal; a workbook named
# .pdf reading differently from the same bytes named .xlsx; the routes'
# verdict or sentence differing from the pipeline guard's for any (name,
# bytes) pair, in either language; the picker offering an extension whose
# own file type no reader opens.

_XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
_NAMES = [
    ("balanta.pdf", "application/pdf"),
    ("balanta.xlsx", _XLSX_MIME),
    ("balanta.xls", "application/vnd.ms-excel"),
    ("balanta.csv", "text/csv"),
    ("balanta.txt", "text/plain"),
    ("balanta.png", "image/png"),
    ("balanta.jpg", "image/jpeg"),
    ("balanta.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    ("balanta.doc", "application/msword"),
    ("balanta.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
    ("balanta", "application/octet-stream"),
]


def _canonical(parsed: Dict[str, Any]) -> str:
    import json
    return json.dumps(parsed, sort_keys=True, default=str, ensure_ascii=False)


def _outcome(run: Any, content: bytes, name: str, mime: str) -> Any:
    """("read", canonical payload) or ("refused", exception class, sentence).
    The fixture's own tripwires (a model client, the Claude lane) are
    AssertionErrors and are an outcome too — they must match as well."""
    try:
        return ("read", _canonical(run(content, name, None, mime)))
    except Exception as e:  # noqa: BLE001
        return ("refused", type(e).__name__, str(e))


@pytest.fixture
def strict_books(monkeypatch):
    """The synthetic balanta PDFs of test_pdf_balanta_stage_extract (PyMuPDF,
    an invented company, invented figures): the three five-pair books of
    the HIGH finding, the four-pair one and the eight-figure one."""
    pytest.importorskip("fitz")
    import test_pdf_balanta_stage_extract as PB

    PB._on_parser(monkeypatch, "tb_parser_v6")
    return {
        "five_pair": PB._pdf_bytes(PB._synthetic_five_pair_lines()),
        "five_pair_credit_first": PB._pdf_bytes(PB._tampered(PB._credit_first)),
        "five_pair_off_by_a_cent": PB._pdf_bytes(PB._tampered(PB._off_by_a_cent)),
        "four_pair": PB.FOUR.pdf(),
        "eight_figure": PB._pdf_bytes(PB._synthetic_balanta_lines()),
    }


@pytest.mark.parametrize("name,mime", [n for n in _NAMES if n[0] != "balanta.pdf"])
def test_pdf_bytes_are_read_by_the_pdf_readers_under_every_name(pdf_upload, strict_books, name, mime):
    """D1(a): a balance PDF under ANY other name yields the extraction the
    same bytes yield named .pdf — byte-identical — or the identical
    refusal. Five books × every name the classifier tells apart."""
    for label, content in strict_books.items():
        as_pdf = _outcome(pdf_upload, content, "balanta.pdf", "application/pdf")
        other = _outcome(pdf_upload, content, name, mime)
        assert other == as_pdf, (label, name, other[:2], as_pdf[:2])
    assert pdf_upload.calls["claude_lane"] == 0  # type: ignore[attr-defined]


@pytest.mark.parametrize("name,mime", [("balanta.xls", "application/vnd.ms-excel"),
                                       ("balanta.xlsx", _XLSX_MIME)])
def test_the_five_pair_books_of_the_high_finding_under_a_spreadsheet_name(pdf_upload, strict_books, name, mime):
    """THE HIGH FINDING, stated outright rather than only as an equality
    (an equality of two wrong reads would pass the law above): the whole
    book is read by the strict reader — never the positional one, never one
    account — and the two tampered books are REFUSED, finally, with the
    strict reader's own refusal. The credit-first book was served with its
    net profit sign-flipped."""
    from decimal import Decimal
    from engine.api.pipeline import BalantaPdfRefusedError

    parsed = pdf_upload(strict_books["five_pair"], name, None, mime)
    ext = parsed.get("extraction") or {}
    assert ext.get("source_format") == "saga_10_col", ext      # the strict reader's hand-over
    assert ext.get("source_format") != "pdf_positional"
    assert len(parsed.get("accounts") or []) > 1, "a partial balance: one account"
    assert Decimal(str(parsed["statutory_net_profit_anchor"])).quantize(Decimal("0.01")) == Decimal("12345.67")
    for tampered in ("five_pair_credit_first", "five_pair_off_by_a_cent"):
        with pytest.raises(BalantaPdfRefusedError) as e:
            pdf_upload(strict_books[tampered], name, None, mime)
        assert "five column pairs" in str(e.value), str(e.value)
    assert pdf_upload.calls["claude_lane"] == 0  # type: ignore[attr-defined]


@pytest.mark.parametrize("rel", ["saga_10_col_carniprod/input.xlsx", "saga_10_col/input.xlsx"])
def test_a_workbook_named_pdf_reads_as_the_same_bytes_named_xlsx(pdf_upload, rel):
    """D1(b): workbook bytes on the .pdf branch are read as the workbook —
    the same payload the same bytes yield under their own .xlsx name."""
    content = _corpus(rel)
    as_xlsx = _outcome(pdf_upload, content, "balanta.xlsx", _XLSX_MIME)
    as_pdf = _outcome(pdf_upload, content, "balanta.pdf", "application/pdf")
    assert as_xlsx[0] == "read", as_xlsx[:2]
    assert as_pdf == as_xlsx
    assert pdf_upload.calls["claude_lane"] == 0  # type: ignore[attr-defined]


def test_the_pdf_rule_on_the_text_branches_needs_the_file_to_end_like_a_pdf():
    """A displaced `%PDF-` header is a PDF on the .pdf and spreadsheet
    branches (no other reader there opens such bytes); on the text branches
    only when the file also ends `%%EOF` — a CSV that mentions "%PDF-" in a
    cell stays a CSV."""
    csv_mentioning = b"Cont;Denumire\n" + b"x" * 1100 + b"\n101;export %PDF-1.4 vechi\n"
    assert ut.sniff_container(csv_mentioning) == ut.TEXT
    for kind in ("csv", "text", "unknown", "image_png"):
        assert not ut.reads_as_pdf(kind, ut.TEXT, csv_mentioning), kind
    displaced = b"J" * 2000 + b"%PDF-1.4\n1 0 obj\nendobj\ntrailer\n%%EOF\n"
    real = ut.sniff_container(displaced)
    assert real in (ut.TEXT, ut.UNKNOWN)
    for kind in ("pdf", "xlsx", "csv", "text", "unknown", "image_png", "image_jpeg"):
        assert ut.reads_as_pdf(kind, real, displaced), kind
        assert not ut.refused_on(kind, real, displaced), kind


# ── the upload card's routes read the SAME verdict ─────────────────

def _policy_bodies() -> Dict[str, bytes]:
    return {
        "a workbook": _corpus("saga_10_col/input.xlsx"),
        "a balance PDF": _corpus("pdf_positional/input.pdf"),
        "a PDF behind 2,000 junk bytes": b"J" * 2000 + _corpus("pdf_positional/input.pdf"),
        "a Word document": _ooxml("word"),
        "a PowerPoint file": _ooxml("ppt"),
        "an OpenDocument file": _odf(),
        "a binary workbook": _zip_of({"[Content_Types].xml": b"<Types/>", "xl/workbook.bin": b"\x00"}),
        "an unrecognised Office zip": _zip_of({"[Content_Types].xml": b"<Types/>", "workbook.xml": b"<w/>"}),
        "a legacy Word document": WORD97.read_bytes(),
        "a legacy PowerPoint": _cfb({"PowerPoint Document": b"p" * 600}),
        "a legacy workbook container": _cfb({"Workbook": b"\x09\x08" + b"x" * 600}),
        "a zip archive": _zip_of({"balanta.pdf": b"%PDF-1.4 inside an archive"}),
        "a cut-off archive": b"PK\x03\x04" + b"\x00" * 20,
        "a csv": b"Cont;Denumire;Debit;Credit\n101;Capital;;80\n",
        "a cp1250 csv": "Cont;Denumire\n101;Capital vărsat\n".encode("cp1250"),
        "a UTF-16 csv": "Cont;Denumire\n101;Capital\n".encode("utf-16"),
        "a PNG": _png(),
        "an empty file": b"",
    }


class _PastTheGuard(BaseException):
    """A reader or lane was reached: the type guard let the file through.
    BaseException — stage_extract wraps its readers in `except Exception`,
    and this must not be swallowed there."""


@pytest.fixture
def reached(monkeypatch):
    """Stops stage_extract at the FIRST reader or lane it hands a document
    to — "refused by the GUARD" means the refusal came with none of them
    reached (the .pdf branch has one later refusal, after its readers
    declined a workbook; that one is not the guard's and the routes cannot
    know it). Stopping there, rather than counting and reading on, is what
    keeps a 198-pair matrix affordable: what a reader then makes of the file
    is the other laws' subject."""
    from engine.api import pipeline as P

    seen: Dict[str, int] = {"n": 0}

    def wrap(owner: Any, attr: str) -> None:
        def _stop(*a: Any, **k: Any) -> Any:
            seen["n"] += 1
            raise _PastTheGuard(attr)

        monkeypatch.setattr(owner, attr, _stop)

    pack_cls = type(P._ro_pack())
    wrap(pack_cls, "parse_trial_balance")
    wrap(pack_cls, "parse_trial_balance_csv")
    wrap(P._pdf_balanta_text, "read_balanta_text_verdict")
    wrap(P, "_maybe_route_ai_lane")
    wrap(P, "_xlsx_to_text")
    return seen


def _guard_verdict(run: Any, reached: Dict[str, int], content: bytes, name: str, mime: str,
                   language: Any = None) -> Any:
    """None when stage_extract's type guard let the file through (whatever
    happened to it afterwards), else the guard's sentence."""
    from engine.api.pipeline import UploadedFileTypeMismatchError

    before = (reached["n"], run.calls["claude_lane"])
    try:
        run(content, name, language, mime)
    except UploadedFileTypeMismatchError as e:
        if (reached["n"], run.calls["claude_lane"]) == before:
            return str(e)
    except BaseException:  # noqa: BLE001 — read on, declined, or a tripwire: not the guard
        pass
    return None


def test_one_upload_policy_the_routes_verdict_is_the_pipeline_guards(pdf_upload, reached):
    """D1(d) — THE LAW. Over the matrix of (claimed name, real bytes), what
    the upload card's routes answer (`_uploads.format_mismatch`, called by
    /api/uploads/identify and /commit) IS what stage_extract's guard does:
    read where it reads, refused where it refuses, the same sentence — in
    English and in Romanian. Driven through the REAL stage_extract, not
    through `refused_on` (comparing the policy with itself proves nothing).

    Plant-proven (docs/engine_book/gates.md, upload-real-type): the routes'
    old table restored for one pair reds this."""
    from engine.api import _uploads

    bodies = _policy_bodies()
    refused = read = 0
    for label, content in bodies.items():
        for name, mime in _NAMES:
            guard = _guard_verdict(pdf_upload, reached, content, name, mime)
            route = _uploads.format_mismatch(name, content, mime)
            assert (route is None) == (guard is None), (
                f"{label} named {name}: the routes "
                f"{'READ' if route is None else 'REFUSE'} it, the pipeline guard "
                f"{'READS' if guard is None else 'REFUSES'} it")
            if guard is None:
                read += 1
                continue
            refused += 1
            assert route[1] == guard, (label, name, route[1], guard)
            assert route[0] == ut.sniff_container(content), (label, name, route)
            ro_guard = _guard_verdict(pdf_upload, reached, content, name, mime, "ro")
            ro_route = _uploads.format_mismatch(name, content, mime, "ro")
            assert ro_route is not None and ro_route[1] == ro_guard, (label, name, ro_route, ro_guard)
            assert "Ca să rezolvi:" in ro_route[1] and "To fix it" not in ro_route[1], ro_route[1]
    # Non-vacuity: the matrix exercises both answers, many times.
    assert refused >= 60 and read >= 40, (refused, read)


def test_the_owners_three_files_at_the_routes_and_in_the_pipeline(pdf_upload):
    """The owner's sentence, at both layers: the canary workbook as
    balanta.pdf is read; a balance PDF as .xls is read; a Word file is
    refused both ways (named .pdf, and under its own name)."""
    from engine.api import _uploads
    from engine.api.pipeline import UploadedFileTypeMismatchError

    canary = _corpus("saga_10_col_carniprod/input.xlsx")
    pdf = _corpus("pdf_positional/input.pdf")
    docx = _ooxml("word")
    assert _uploads.format_mismatch("balanta.pdf", canary, "application/pdf") is None
    assert pdf_upload(canary, "balanta.pdf", None, "application/pdf").get("accounts")
    assert _uploads.format_mismatch("balanta.xls", pdf, "application/vnd.ms-excel") is None
    assert pdf_upload(pdf, "balanta.xls", None, "application/vnd.ms-excel").get("accounts")
    for name, mime, must in (("balanta.pdf", "application/pdf", "is named .pdf but its contents are"),
                             ("balanta.docx", _NAMES[7][1], "which this app cannot read")):
        hit = _uploads.format_mismatch(name, docx, mime)
        assert hit is not None and hit[0] == ut.DOCX and must in hit[1], (name, hit)
        with pytest.raises(UploadedFileTypeMismatchError) as e:
            pdf_upload(docx, name, None, mime)
        assert str(e.value) == hit[1]
    assert pdf_upload.calls["claude_lane"] == 0  # type: ignore[attr-defined]


def test_the_classifier_is_the_one_the_pipeline_runs():
    """`pipeline._classify_file` is `_upload_type.classify` — the routes
    classify by the same rule the pipeline does."""
    from engine.api import pipeline as P

    by_mime_alone = [("upload", "application/pdf"), ("upload", _XLSX_MIME), ("upload", "text/csv"),
                     ("upload", "image/png"), ("upload", "image/jpeg"), ("upload", "text/plain")]
    for name, mime in _NAMES + by_mime_alone + [
            ("Balanta.PDF", ""), ("balanta.xlsm", "application/vnd.ms-excel.sheet.macroEnabled.12"),
            ("raport.csv", "application/vnd.ms-excel"), ("scan.jpeg", ""), ("note.txt", "")]:
        doc = {"original_filename": name, "mime_type": mime}
        assert P._classify_file(doc) == ut.classify(name, mime), (name, mime)
    # The MIME type alone picks a branch when the name says nothing.
    assert [ut.classify(n, m) for n, m in by_mime_alone] == [
        "pdf", "xlsx", "csv", "image_png", "image_jpeg", "text"]
    assert ut.classify("balanta.xls", "application/vnd.ms-excel") == "xlsx"
    assert ut.classify("raport.csv", "application/vnd.ms-excel") == "csv"
    assert ut.classify(None, None) == "unknown"


# ── the picker offers nothing the engine refuses by name ────────────

def _offered_extensions() -> list:
    import re as _re

    src = (REPO / "frontend" / "lib" / "uploadAccept.ts").read_text(encoding="utf-8")
    block = _re.search(r"FINANCIAL_UPLOAD_EXTENSIONS\s*=\s*\[(.*?)\]", src, _re.S)
    assert block, "FINANCIAL_UPLOAD_EXTENSIONS not found in frontend/lib/uploadAccept.ts"
    return _re.findall(r'"(\.[a-z0-9]+)"', block.group(1))


def test_the_upload_picker_offers_no_type_the_engine_refuses_by_name():
    """D1(e). `frontend/lib/uploadAccept.ts` is what every financial upload
    input and drop zone offers. An extension whose OWN file type reaches no
    reader (`REACHES_NO_READER` — a PowerPoint file under .pptx or .ppt, a
    Word document, a binary workbook, OpenDocument) is an invitation to a
    refusal. On the release head it offered .pptx and .ppt."""
    import re as _re

    offered = _offered_extensions()
    assert {".pdf", ".xlsx", ".xls", ".csv"} <= set(offered), offered
    for ext in offered:
        dead = sorted(label for label, exts in ut._NATURAL_EXTENSIONS.items()
                      if ext in exts and label in ut.REACHES_NO_READER)
        assert dead == [], f"the picker offers {ext}, which is {dead} — refused on every branch"
    src = (REPO / "frontend" / "lib" / "uploadAccept.ts").read_text(encoding="utf-8")
    accept = _re.search(r"FINANCIAL_UPLOAD_ACCEPT\s*=\s*\n?\s*\"([^\"]*)\"", src)
    assert accept, "FINANCIAL_UPLOAD_ACCEPT not found"
    tokens = [t.strip() for t in accept.group(1).split(",") if t.strip()]
    assert not [t for t in tokens if "powerpoint" in t or "presentation" in t or t in (".ppt", ".pptx")], tokens
    assert sorted(t for t in tokens if t.startswith(".")) == sorted(offered), (tokens, offered)
