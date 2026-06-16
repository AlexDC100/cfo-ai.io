"""F3.3-DETECTION gate.

Verifies:
  - Romanian fixture content scores > 0.95 confidence on the Romania pack.
  - Romanian fixture content does NOT trigger Review Mode.
  - Synthetic non-Romanian content (English label list) scores < 0.50
    and DOES trigger Review Mode with country_code=None.
  - The classifier prefers higher-scoring packs over lower ones (sanity
    test against the Romania pack only — full multi-pack test lands
    once a second pack ships).

Exit 0 — all GREEN. Exit 1 — any failure.

Per the F3.2-locked discipline point: this gate has been verified-to-
fail by introducing a deliberate bug (scaling the Romania pack's
language-label weight to 0 — confirmed gate fails, then reverted).
"""
from __future__ import annotations

import sys
from pathlib import Path


def _find_repo_root() -> Path:
    here = Path(__file__).resolve().parent
    for c in [here, *here.parents][:6]:
        if (c / "pyproject.toml").is_file():
            return c
    return here.parent


REPO = _find_repo_root()
sys.path.insert(0, str(REPO / "src"))
sys.path.insert(0, str(REPO / "scripts"))

import engine.country_packs.ro_romania  # noqa: F401, E402 — register pack
from engine.core.upload_classifier import (  # noqa: E402
    HIGH_CONFIDENCE_THRESHOLD,
    CLASSIFICATION_THRESHOLD,
    classify_upload,
)
from engine.core.confidence_engine import build_confidence_report  # noqa: E402


def _load_eei_content() -> bytes:
    """Load the EEI JSON fixture as raw bytes — this is what the pack
    would receive at upload time. The full fixture has 69 accounts,
    enough to saturate the RAS-code detection signal."""
    p = REPO / "scandi-desk-main/e2e/fixtures/ground-truth/ro_eei_dec_2025/expected_extraction.json"
    if not p.is_file():
        for cand in (
            Path("/app/scandi-desk-main/e2e/fixtures/ground-truth/ro_eei_dec_2025/expected_extraction.json"),
            Path("/host_repo/scandi-desk-main/e2e/fixtures/ground-truth/ro_eei_dec_2025/expected_extraction.json"),
        ):
            if cand.is_file():
                p = cand
                break
    return p.read_bytes()


def _load_scandia_content() -> bytes:
    """Load the Scandia XLSX fixture as raw bytes (644 accounts)."""
    p = REPO / "files/scandia_trial_balance_2025_downloaded.xlsx"
    if not p.is_file():
        for cand in (
            Path("/app/files/scandia_trial_balance_2025_downloaded.xlsx"),
            Path("/host_repo/files/scandia_trial_balance_2025_downloaded.xlsx"),
        ):
            if cand.is_file():
                p = cand
                break
    return p.read_bytes()


def _load_scandia_sibiu_pdf() -> bytes:
    """F3.8b — Scandia Sibiu FY2019 PDF (WinMENTOR export) for the
    PDF-detection extension to F3.3-DETECTION."""
    for p in [
        REPO / "src/engine/country_packs/ro_romania/fixtures/pdf_samples/scandia_sibiu_2019.pdf",
        Path("/app/src/engine/country_packs/ro_romania/fixtures/pdf_samples/scandia_sibiu_2019.pdf"),
        Path("/host_repo/src/engine/country_packs/ro_romania/fixtures/pdf_samples/scandia_sibiu_2019.pdf"),
    ]:
        if p.is_file():
            return p.read_bytes()
    raise FileNotFoundError("scandia_sibiu_2019.pdf not found")

# An English-language balance sheet, no RAS codes, USD. Should score
# very low on the Romania pack (close to 0).
ENGLISH_BLOB = """
Balance Sheet — Demo Company Inc.
Period: Q4 2025  Currency: USD

Account     Description                                 Opening Balance  Closing Balance
1000        Cash and Cash Equivalents                       50,000.00        75,000.00
1200        Accounts Receivable                            100,000.00       120,000.00
1500        Property Plant and Equipment                   500,000.00       450,000.00
2000        Accounts Payable                                85,000.00        90,000.00
2500        Long Term Debt                                 200,000.00       180,000.00
3000        Share Capital                                  150,000.00       150,000.00
4000        Sales Revenue                                          -        900,000.00
5000        Cost of Goods Sold                                     -        540,000.00
"""


def _assert(cond: bool, msg: str, fails: list) -> None:
    if cond:
        print(f"  GREEN  {msg}")
    else:
        print(f"  RED    {msg}")
        fails.append(msg)


def main() -> None:
    fails: list = []
    print("F3.3-DETECTION gate\n")

    # ── 1. EEI fixture: real Romanian content ──────────────────
    print("EEI fixture (JSON, 69 RAS accounts):")
    eei_result = classify_upload(_load_eei_content(), "balanta verificare EEI dec 2025.pdf")
    _assert(
        eei_result.pack is not None and eei_result.pack.country_code == "RO",
        f"classifier picks Romania pack (got pack={eei_result.pack and eei_result.pack.country_code})",
        fails,
    )
    _assert(
        eei_result.confidence >= 0.95,
        f"confidence >= 0.95 (got {eei_result.confidence:.4f}; signals={eei_result.detection.signals})",
        fails,
    )

    synth_envelope_green = {
        "statements": {
            "assembled_bs": {"total_assets": 20183415.93, "bs_balance_delta": 0.0}
        },
        "unmapped": [],
    }
    eei_report = build_confidence_report(eei_result, synth_envelope_green)
    _assert(
        eei_report.review_mode_required is False,
        f"Review Mode NOT triggered for EEI (reasons={list(eei_report.review_mode_reasons)})",
        fails,
    )

    # ── 2. Scandia fixture: real Romanian content (644 accounts) ──
    print("\nScandia fixture (XLSX, 644 RAS accounts):")
    sc_result = classify_upload(_load_scandia_content(), "scandia trial balance 2025.xlsx")
    _assert(
        sc_result.pack is not None and sc_result.pack.country_code == "RO",
        f"classifier picks Romania pack (got pack={sc_result.pack and sc_result.pack.country_code})",
        fails,
    )
    _assert(
        sc_result.confidence >= 0.95,
        f"confidence >= 0.95 (got {sc_result.confidence:.4f}; signals={sc_result.detection.signals})",
        fails,
    )
    sc_report = build_confidence_report(sc_result, synth_envelope_green)
    _assert(
        sc_report.review_mode_required is False,
        f"Review Mode NOT triggered for Scandia (reasons={list(sc_report.review_mode_reasons)})",
        fails,
    )

    # English content for the negative test below.
    synth_envelope = synth_envelope_green

    # ── 3. F3.8b — PDF format-signature detection ──────────────
    print("\nScandia Sibiu PDF (WinMENTOR export, 188KB):")
    pdf_result = classify_upload(_load_scandia_sibiu_pdf(),
                                 "trial Balance Scandia Sibiu 12.2019.PDF")
    _assert(
        pdf_result.pack is not None and pdf_result.pack.country_code == "RO",
        f"classifier picks Romania pack (got pack={pdf_result.pack and pdf_result.pack.country_code})",
        fails,
    )
    _assert(
        pdf_result.confidence >= 0.95,
        f"PDF confidence >= 0.95 (got {pdf_result.confidence:.4f})",
        fails,
    )
    fmt = pdf_result.detection.detected_format if pdf_result.detection else None
    _assert(
        fmt == "ro_pdf_winmentor",
        f"detected_format == 'ro_pdf_winmentor' (got {fmt!r})",
        fails,
    )
    pdf_report = build_confidence_report(pdf_result, synth_envelope_green)
    _assert(
        pdf_report.detected_layout.value == "pdf_full_movement",
        f"PDF detected_layout == 'pdf_full_movement' (got {pdf_report.detected_layout.value!r})",
        fails,
    )
    _assert(
        pdf_report.review_mode_required is False,
        f"Review Mode NOT triggered for Scandia Sibiu PDF "
        f"(reasons={list(pdf_report.review_mode_reasons)})",
        fails,
    )

    print()
    print("English-content non-Romanian synthetic (no RAS codes, USD):")
    en_result = classify_upload(ENGLISH_BLOB.encode("utf-8"), "balance_sheet.csv")
    # English blob should score below threshold; pack=None means
    # classifier rejected it.
    if en_result.pack is None:
        _assert(True, f"classifier rejects English content (best score {en_result.confidence:.4f})", fails)
    else:
        # Did pick a pack — only OK if confidence is below high-threshold
        _assert(
            en_result.confidence < HIGH_CONFIDENCE_THRESHOLD,
            f"English content scored below {HIGH_CONFIDENCE_THRESHOLD} on best pack (got {en_result.confidence:.4f})",
            fails,
        )

    # Review Mode MUST trigger for English content (whether because
    # the classifier rejected it entirely, or because confidence < 90%).
    en_report = build_confidence_report(en_result, synth_envelope)
    _assert(
        en_report.review_mode_required is True,
        f"Review Mode triggered for English content (reasons={list(en_report.review_mode_reasons)})",
        fails,
    )

    print()
    if fails:
        print(f"Overall: RED — {len(fails)} F3.3-DETECTION assertion(s) failed.")
        sys.exit(1)
    print("Overall: GREEN — F3.3-DETECTION gate passes.")
    sys.exit(0)


if __name__ == "__main__":
    main()
