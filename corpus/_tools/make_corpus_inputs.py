#!/usr/bin/env python3
"""GOLDEN CORPUS input builder — writes corpus/<case_id>/{input.*, meta.yaml,
mock_*.json} for every case. Idempotent and deterministic: synthetic inputs
are rebuilt byte-identically, real seed fixtures are copied (and anonymized
via scripts/anonymize_tb.py where meta says so), and meta.yaml files are
written only when missing (pass --force-meta to overwrite them).

Expected goldens are NOT written here — freeze them with:
    UPDATE_GOLDEN=1 .venv/bin/python scripts/corpus_replay.py

Case inventory (operator spec, PART A):
  Seed cases        saga_10_col (prod frozen — pre-anonymized fictional data),
                    saga_10_col_{agras,carniprod,retail,realestate} (real
                    10-col-family exports, scrambler-applied),
                    saga_compact_6_col / generic_4_col / csv (synthetic until
                    a real anonymized export is contributed),
                    pdf_positional (files/scandia_sibiu_tb_2019.pdf),
                    llm_fallback_scanned_pdf (mocked model response),
                    hu_ai_lane (HU CSV + mocked stage responses).
  Adversarial set   dup_totals_row, contra_sign_flip, unmapped_equals_delta,
                    rounding_004pct, imbalance_03pct, exact_zero — small
                    synthetic 10-col inputs, each with a faithful totals row
                    so extraction is honest (anchor MATCHED) and any imbalance
                    is the SOURCE's own (D1), exactly like the property suite.

Sibling tree note: corpus/quarantine/ belongs to the hypothesis property
suite (tests/engine/test_properties.py) — its failure artifacts live there;
this builder never touches it, and the replay runner ignores any directory
without a meta.yaml.
"""
from __future__ import annotations

import argparse
import io
import json
import sys
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

CORPUS = Path(__file__).resolve().parents[1]
REPO = CORPUS.parent
if str(REPO / "scripts") not in sys.path:
    sys.path.insert(0, str(REPO / "scripts"))

import anonymize_tb  # noqa: E402  (scripts/anonymize_tb.py)

FILES = REPO / "files"
SYNTH = (
    REPO / "src" / "engine" / "country_packs" / "ro_romania"
    / "fixtures" / "synthetic"
)
HU_FIXTURE = (
    REPO / "src" / "engine" / "country_packs" / "hu_hungary"
    / "fixtures" / "hu_szamlatukor_tb_2025.csv"
)

# ── Synthetic XLSX builders (same text-cell style as the Phase-5
# synthetic fixture generator; totals row sums ALL account rows) ───────

HDR_10COL: List[str] = [
    "Cont", "Denumire cont",
    "Solduri initiale Debit", "Solduri initiale Credit",
    "Rulaje Debit", "Rulaje Credit",
    "Sume totale Debit", "Sume totale Credit",
    "Solduri finale Debit", "Solduri finale Credit",
]
FIELDS_10 = ("si_d", "si_c", "r_d", "r_c", "st_d", "st_c", "sf_d", "sf_c")

HDR_6COL: List[str] = [
    "Cont", "Denumire cont",
    "Solduri initiale Debit", "Solduri initiale Credit",
    "Rulaje Debit", "Rulaje Credit",
    "Sume totale Debit", "Sume totale Credit",
]
FIELDS_6 = ("si_d", "si_c", "r_d", "r_c", "st_d", "st_c")


def _fmt(value: float) -> Optional[str]:
    return None if value == 0 else "{:,.2f}".format(value)


def _workbook(rows: Sequence[Tuple[str, str, Dict[str, float]]],
              header: List[str], fields: Sequence[str], title: str) -> bytes:
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.title = title
    ws.append(header)
    totals = [0.0] * len(fields)
    for code, name, cells in rows:
        vals = [float(cells.get(f, 0.0)) for f in fields]
        for i, v in enumerate(vals):
            totals[i] += v
        ws.append([code, name] + [_fmt(v) for v in vals])
    ws.append([None, "TOTAL"] + ["{:,.2f}".format(v) for v in totals])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


ADVERSARIAL_10COL: Dict[str, List[Tuple[str, str, Dict[str, float]]]] = {
    # Exact double-entry source → difference 0.00 BALANCED, no adjustment.
    "exact_zero": [
        ("5121", "Conturi la banci in lei", {"sf_d": 1000.00}),
        ("1012", "Capital subscris varsat", {"sf_c": 1000.00}),
    ],
    # 1.60 RON on a 4,000 RON sheet (0.04%) across 4 touched sections →
    # R1 rounding-cents auto-fix at persist; model client NEVER built.
    "rounding_004pct": [
        ("212", "Constructii", {"sf_d": 3000.00}),
        ("5121", "Conturi la banci in lei", {"sf_d": 1000.00}),
        ("1012", "Capital subscris varsat", {"sf_c": 2000.00}),
        ("401", "Furnizori", {"sf_c": 1998.40}),
    ],
    # Single UNMAPPED account (413 — the agras leak class) whose balance
    # equals the source gap to the cent → R2 names the account.
    "unmapped_equals_delta": [
        ("5121", "Conturi la banci in lei", {"sf_d": 1_000_000.00}),
        ("413", "Efecte de primit de la clienti", {"sf_d": 300.00}),
        ("1012", "Capital subscris varsat", {"sf_c": 1_000_000.00}),
    ],
    # Bifunctional 419 recorded on the WRONG side in the source: the
    # true books were 419 C 200 / 1012 C 999,800; the flip leaves the
    # file D=1,000,200 vs C=999,800 → difference +400 == 2×200 → R3.
    "contra_sign_flip": [
        ("5121", "Conturi la banci in lei", {"sf_d": 1_000_000.00}),
        ("419", "Clienti creditori (postat gresit pe debit)", {"sf_d": 200.00}),
        ("1012", "Capital subscris varsat", {"sf_c": 999_800.00}),
    ],
    # (371, 250.00) appears twice; removing one copy closes the 250.00
    # difference exactly → R_DUP (D5 flags the pair at build time).
    "dup_totals_row": [
        ("5121", "Conturi la banci in lei", {"sf_d": 500_000.00}),
        ("371", "Marfuri", {"sf_d": 250.00}),
        ("371", "Marfuri", {"sf_d": 250.00}),
        ("1012", "Capital subscris varsat", {"sf_c": 500_250.00}),
    ],
    # 0.3% drift — ABOVE the 0.1% auto-reconcile gate: honest
    # MINOR_DRIFT, no receipt, no needs_review, no offer.
    "imbalance_03pct": [
        ("5121", "Conturi la banci in lei", {"sf_d": 1_000_000.00}),
        ("1012", "Capital subscris varsat", {"sf_c": 997_000.00}),
    ],
}

# Layout-B compact export: 3 column pairs (SI / RL / Sume totale), no
# Solduri-finale block — closing balances synthesized from the identity.
COMPACT_6COL_ROWS: List[Tuple[str, str, Dict[str, float]]] = [
    ("1012", "Capital subscris varsat", {"si_c": 1000.00, "st_c": 1000.00}),
    ("5121", "Conturi la banci in lei", {"si_d": 700.00, "r_d": 500.00, "st_d": 1200.00}),
    ("371", "Marfuri", {"si_d": 300.00, "st_d": 300.00}),
    ("707", "Venituri din vanzarea marfurilor", {"r_c": 800.00, "st_c": 800.00}),
    ("607", "Cheltuieli privind marfurile", {"r_d": 300.00, "st_d": 300.00}),
]

# Image-only single-page PDF (no text operators) — the deterministic
# positional ingester finds zero rows, forcing the RO LLM fallback.
# Handcrafted static bytes so the input is deterministic forever.
SCANNED_PDF = b"""%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>
endobj
4 0 obj
<< /Length 47 >>
stream
0.9 g 50 50 495 742 re f 0 G 1 w 60 60 m S
endstream
endobj
xref
0 5
0000000000 65535 f
trailer
<< /Size 5 /Root 1 0 R >>
startxref
0
%%EOF
"""

# ── Mocked model responses (stored per case; replay injects them via
# the injectable-client seams — never a live API call) ─────────────────

LLM_FALLBACK_RESPONSE = json.dumps({
    "company_name": "Exemplu Industrie SRL",
    "period_label": "FY 2019",
    "period_end": "2019-12-31",
    "currency": "RON",
    "confidence": 0.6,
    "detected_type": "trial_balance",
    "accounts": [
        {"code": "212", "name": "Constructii", "amount": 80000.0},
        {"code": "371", "name": "Marfuri", "amount": 50000.0},
        {"code": "5121", "name": "Conturi la banci in lei", "amount": 20000.0},
        {"code": "1012", "name": "Capital subscris varsat", "amount": 100000.0},
        {"code": "117", "name": "Rezultatul reportat", "amount": 30000.0},
        {"code": "401", "name": "Furnizori", "amount": 20000.0},
    ],
    "warnings": ["scanned document; totals row unreadable"],
}, indent=2)

HU_FMT_JSON = json.dumps({
    "layout": {
        "columns": ["Számla", "Megnevezés", "Tartozik egyenleg", "Követel egyenleg"],
        "header_row": 1, "totals_row_index": 15,
    },
    "currency": "HUF", "scale": 1,
    "thousands_sep": " ", "decimal_sep": ",", "language": "hu",
})

_HU_ROWS = [
    {"code": "114", "label": "Szellemi termékek", "debit": 2500000.0, "credit": None, "balance": None},
    {"code": "123", "label": "Épületek", "debit": 12000000.0, "credit": None, "balance": None},
    {"code": "211", "label": "Anyagok", "debit": 3200000.0, "credit": None, "balance": None},
    {"code": "311", "label": "Belföldi vevők", "debit": 4750000.0, "credit": None, "balance": None},
    {"code": "384", "label": "Elszámolási betétszámla", "debit": 6400000.0, "credit": None, "balance": None},
    {"code": "381", "label": "Pénztár", "debit": 350000.0, "credit": None, "balance": None},
    {"code": "466", "label": "Előzetesen felszámított áfa", "debit": 400000.0, "credit": None, "balance": None},
    {"code": "411", "label": "Jegyzett tőke", "debit": None, "credit": 10000000.0, "balance": None},
    {"code": "413", "label": "Eredménytartalék", "debit": None, "credit": 5500000.0, "balance": None},
    {"code": "454", "label": "Belföldi szállítók", "debit": None, "credit": 3800000.0, "balance": None},
    {"code": "467", "label": "Fizetendő áfa", "debit": None, "credit": 900000.0, "balance": None},
    {"code": "522", "label": "Bérleti díjak", "debit": 500000.0, "credit": None, "balance": None},
    {"code": "811", "label": "Anyagjellegű ráfordítások", "debit": 7500000.0, "credit": None, "balance": None},
    {"code": "911", "label": "Belföldi értékesítés árbevétele", "debit": None, "credit": 17400000.0, "balance": None},
]
HU_EXTRACT_JSON = json.dumps({
    "rows": _HU_ROWS,
    "totals_row": {"debit": 37600000.0, "credit": 37600000.0},
})
# 466 deliberately below the 0.85 confidence gate → needs_review +
# Unclassified row (the confidence-gating behavior the case locks).
_HU_ASSIGNMENTS = [
    {"code": "114", "line_id": "intangibles_other", "confidence": 0.9, "rationale": "intellectual property"},
    {"code": "123", "line_id": "ppe_buildings", "confidence": 0.97, "rationale": "buildings"},
    {"code": "211", "line_id": "inventory_raw_materials", "confidence": 0.95, "rationale": "raw materials"},
    {"code": "311", "line_id": "ar_trade_gross", "confidence": 0.96, "rationale": "trade receivables"},
    {"code": "384", "line_id": "cash_operating", "confidence": 0.98, "rationale": "bank account"},
    {"code": "381", "line_id": "cash_operating", "confidence": 0.97, "rationale": "petty cash"},
    {"code": "466", "line_id": "ar_tax_recoverable", "confidence": 0.62, "rationale": "input VAT — uncertain"},
    {"code": "411", "line_id": "share_capital", "confidence": 0.99, "rationale": "registered capital"},
    {"code": "413", "line_id": "retained_earnings_prior_years", "confidence": 0.95, "rationale": "retained earnings"},
    {"code": "454", "line_id": "ap_trade", "confidence": 0.96, "rationale": "trade payables"},
    {"code": "467", "line_id": "ap_tax", "confidence": 0.93, "rationale": "output VAT payable"},
    {"code": "522", "line_id": "rent_operating_lease", "confidence": 0.9, "rationale": "rent expense"},
    {"code": "811", "line_id": "cogs_raw_materials", "confidence": 0.92, "rationale": "material expenses"},
    {"code": "911", "line_id": "revenue_products", "confidence": 0.94, "rationale": "sales revenue"},
]
HU_CLASSIFY_JSON = json.dumps({"assignments": _HU_ASSIGNMENTS})


# ── Case manifest ──────────────────────────────────────────────────────
# (case_id, input filename, input builder, meta dict). meta.yaml is
# emitted from the meta dict; the replay-driving keys (expected_parser,
# period_end, anonymized, expect_ai_never_consulted) are documented in
# corpus/README.md.


def _copy(src: Path):
    def _build() -> bytes:
        return src.read_bytes()
    return _build


def _anonymized(src: Path):
    def _build() -> bytes:
        return anonymize_tb.anonymize_bytes(src.read_bytes())
    return _build


CASES: List[Tuple[str, str, "object", Dict[str, object]]] = [
    (
        "saga_10_col", "input.xlsx",
        _copy(FILES / "prod_scandia_frozen_31.12.2025.xlsx"),
        {
            "jurisdiction": "RO", "expected_parser": "saga_10_col",
            "period": "FY2025 (31.12.2025)", "period_end": "2025-12-31",
            "anonymized": False, "expect_ai_never_consulted": True,
            "source_notes": (
                "files/prod_scandia_frozen_31.12.2025.xlsx — the frozen SAGA/"
                "ContSal 10-col production golden (blank-code totals row printed "
                "FIRST). Already anonymized fictional data upstream (calibration "
                "fixture), so the corpus scrambler was deliberately NOT applied."
            ),
        },
    ),
    (
        "saga_10_col_agras", "input.xlsx",
        _anonymized(FILES / "agras_tb_2025.xlsx"),
        {
            "jurisdiction": "RO", "expected_parser": "saga_10_col",
            "period": "FY2025 (12-25)", "period_end": "2025-12-31",
            "anonymized": True, "expect_ai_never_consulted": True,
            "source_notes": (
                "files/agras_tb_2025.xlsx — real 10-col-family export with "
                "trailing IFRS-mapping helper columns and no totals row. Labels/"
                "sheet name scrambled by scripts/anonymize_tb.py (seed = source "
                "content hash); codes and all numerics preserved to the cent."
            ),
        },
    ),
    (
        "saga_10_col_carniprod", "input.xlsx",
        _anonymized(FILES / "carniprod_tb_2025.xlsx"),
        {
            "jurisdiction": "RO", "expected_parser": "saga_10_col",
            "period": "FY2025 (12-25)", "period_end": "2025-12-31",
            "anonymized": True, "expect_ai_never_consulted": True,
            "source_notes": (
                "files/carniprod_tb_2025.xlsx — real 10-col-family export with "
                "multi-level analytic codes (5121.04.01, 7584.1.1.1, apostrophe-"
                "suffixed 701.00'). Labels scrambled by scripts/anonymize_tb.py; "
                "codes and all numerics preserved to the cent."
            ),
        },
    ),
    (
        "saga_10_col_retail", "input.xlsx",
        _anonymized(FILES / "scandia_retail_tb_2025.xlsx"),
        {
            "jurisdiction": "RO", "expected_parser": "saga_10_col",
            "period": "FY2025 (12-25)", "period_end": "2025-12-31",
            "anonymized": True, "expect_ai_never_consulted": True,
            "source_notes": (
                "files/scandia_retail_tb_2025.xlsx — real 10-col-family retail "
                "export (largest corpus case, 582 rows). Labels scrambled by "
                "scripts/anonymize_tb.py; codes and numerics preserved."
            ),
        },
    ),
    (
        "saga_10_col_realestate", "input.xlsx",
        _anonymized(FILES / "scandia_realestate_tb_2025.xlsx"),
        {
            "jurisdiction": "RO", "expected_parser": "saga_10_col",
            "period": "FY2025 (31.12.2025)", "period_end": "2025-12-31",
            "anonymized": True, "expect_ai_never_consulted": True,
            "source_notes": (
                "files/scandia_realestate_tb_2025.xlsx — real SAGA/ContSal "
                "10-col export (leading blank-code totals row, BLN_* headers). "
                "Labels scrambled by scripts/anonymize_tb.py; codes, numerics "
                "and the totals-row anchor preserved to the cent."
            ),
        },
    ),
    (
        "saga_compact_6_col", "input.xlsx",
        lambda: _workbook(COMPACT_6COL_ROWS, HDR_6COL, FIELDS_6, "TB_compact"),
        {
            "jurisdiction": "RO", "expected_parser": "saga_compact_6_col",
            "period": "FY2025", "period_end": "2025-12-31",
            "anonymized": False, "expect_ai_never_consulted": True,
            "source_notes": (
                "SYNTHETIC until a real anonymized export is contributed (the "
                "spec prefers real files — flagged as an open leftover). Layout-B "
                "compact: SI/RL/Sume-totale pairs only, closing balances "
                "synthesized from the si+rl identity; pre-closing 607/707 open."
            ),
        },
    ),
    (
        "generic_4_col", "input.xlsx",
        _copy(SYNTH / "synthetic_tb_generic_4col.xlsx"),
        {
            "jurisdiction": "RO", "expected_parser": "generic_4_col",
            "period": "FY2025", "period_end": "2025-12-31",
            "anonymized": False, "expect_ai_never_consulted": True,
            "source_notes": (
                "SYNTHETIC until a real anonymized export is contributed — copy "
                "of the Phase-5 fixture synthetic_tb_generic_4col.xlsx (cont/"
                "denumire + one bare Debit/Credit closing pair, TOTAL row)."
            ),
        },
    ),
    (
        "csv", "input.csv",
        _copy(SYNTH / "synthetic_tb_ro_locale.csv"),
        {
            "jurisdiction": "RO", "expected_parser": "csv",
            "period": "FY2025", "period_end": "2025-12-31",
            "anonymized": False, "expect_ai_never_consulted": True,
            "source_notes": (
                "SYNTHETIC until a real anonymized export is contributed — copy "
                "of the Phase-5 fixture synthetic_tb_ro_locale.csv (semicolon "
                "CSV, cp1250, RO number locale, TOTAL-labelled totals row). "
                "Dispatches through parse_trial_balance_csv; the detected "
                "source_format is saga_10_col (asserted in extraction.json)."
            ),
        },
    ),
    (
        "pdf_positional", "input.pdf",
        _copy(FILES / "scandia_sibiu_tb_2019.pdf"),
        {
            "jurisdiction": "RO", "expected_parser": "pdf_positional",
            "period": "FY2019 (31.12.2019)", "period_end": "2019-12-31",
            "anonymized": False, "expect_ai_never_consulted": True,
            "source_notes": (
                "files/scandia_sibiu_tb_2019.pdf — positional RAS PDF export "
                "(PyMuPDF geometry extraction). NOT anonymized: the scrambler "
                "does not rewrite PDF content streams (documented limitation); "
                "the file is the platform's long-standing PDF fixture. The case "
                "freezes an honest MATERIAL_IMBALANCE (0.99%, above the "
                "reconcile gate) with a D6 121-mismatch diagnosis."
            ),
        },
    ),
    (
        "llm_fallback_scanned_pdf", "input.pdf",
        lambda: SCANNED_PDF,
        {
            "jurisdiction": "RO", "expected_parser": "ro_llm_fallback",
            "period": "FY2019", "period_end": "2019-12-31",
            "anonymized": False, "expect_ai_never_consulted": False,
            "source_notes": (
                "SYNTHETIC image-only PDF (no text layer) — the deterministic "
                "positional ingester finds zero rows, so stage_extract falls "
                "back to the RO LLM extraction (financial_statements.parse_"
                "document). Replay injects mock_model_response.json through a "
                "scripted `anthropic` module (sys.modules seam) — never a live "
                "call. KNOWN CONTRACT GAP frozen honestly by this golden: the "
                "PDF fallback's parsed payload carries NO extraction stamp, so "
                "the envelope reads method=deterministic and can claim BALANCED "
                "— both violate CANONICAL_BS_V2 ('llm ⇒ never BALANCED'). An "
                "engine fix will flip this golden via UPDATE_GOLDEN with a note."
            ),
        },
    ),
    (
        "hu_ai_lane", "input.csv",
        _copy(HU_FIXTURE),
        {
            "jurisdiction": "HU", "expected_parser": "hu_ai_lane",
            "period": "FY2025", "period_end": "2025-12-31",
            "anonymized": False, "expect_ai_never_consulted": False,
            "source_notes": (
                "src/engine/country_packs/hu_hungary/fixtures/hu_szamlatukor_"
                "tb_2025.csv (synthetic HU fixture) through the full AI lane: "
                "deterministic resolver → format_detect → extract → classify → "
                "confidence gating (466 at 0.62 < 0.85 → needs_review + "
                "Unclassified row). Stage responses are mocked from "
                "mock_model_responses.json via the lane's injectable "
                "client_factory seam — never a live call."
            ),
        },
    ),
]

_ADVERSARIAL_META: Dict[str, Dict[str, object]] = {
    "exact_zero": {
        "period": "FY2025", "note":
            "balanced source → difference exactly 0.00, status BALANCED, "
            "auto-reconcile strict no-op, NO adjustment line anywhere.",
    },
    "rounding_004pct": {
        "period": "FY2025", "note":
            "0.04% rounding drift (1.60 RON / 4,000 RON, 4 sections) → R1 "
            "deterministic auto-fix at persist; the model client is NEVER "
            "constructed (ai-sentinel asserted by the replay).",
    },
    "unmapped_equals_delta": {
        "period": "FY2025", "note":
            "single unmapped account 413 == the 300.00 source gap to the cent "
            "→ R2 auto-fix naming the account; deterministic, no AI.",
    },
    "contra_sign_flip": {
        "period": "FY2025", "note":
            "bifunctional 419 recorded on the wrong side (2×200.00 == the "
            "400.00 difference) → R3 side-flip auto-fix; deterministic, no AI.",
    },
    "dup_totals_row": {
        "period": "FY2025", "note":
            "(371, 250.00) duplicated; removing one copy closes the 250.00 "
            "difference exactly → R_DUP auto-fix; deterministic, no AI.",
    },
    "imbalance_03pct": {
        "period": "FY2025", "note":
            "0.3% drift is ABOVE the 0.1% auto-reconcile gate → refused: "
            "honest MINOR_DRIFT, no receipt, no needs_review, no offer.",
    },
}

for _case_id, _rows in ADVERSARIAL_10COL.items():
    _extra = _ADVERSARIAL_META[_case_id]
    CASES.append((
        _case_id, "input.xlsx",
        (lambda rows: lambda: _workbook(rows, HDR_10COL, FIELDS_10, "TB_adversarial"))(_rows),
        {
            "jurisdiction": "RO", "expected_parser": "saga_10_col",
            "period": _extra["period"], "period_end": "2025-12-31",
            "anonymized": False, "expect_ai_never_consulted": True,
            "source_notes": "SYNTHETIC adversarial case. %s The file's own "
                            "totals row faithfully sums the account rows, so "
                            "extraction stays honest (anchor MATCHED) and any "
                            "gap is the SOURCE's own (D1)." % _extra["note"],
        },
    ))

MOCK_FILES: Dict[str, Dict[str, Dict[str, str]]] = {
    "llm_fallback_scanned_pdf": {
        "mock_model_response.json": {"parse_document": LLM_FALLBACK_RESPONSE},
    },
    "hu_ai_lane": {
        "mock_model_responses.json": {
            "format_detect": HU_FMT_JSON,
            "extract": HU_EXTRACT_JSON,
            "classify": HU_CLASSIFY_JSON,
        },
    },
}


def _yaml_quote(value: object) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    text = str(value)
    return '"%s"' % text.replace("\\", "\\\\").replace('"', '\\"')


def _meta_yaml(case_id: str, meta: Dict[str, object]) -> str:
    lines = [
        "# GOLDEN CORPUS case metadata — see corpus/README.md for the schema.",
        "case_id: %s" % _yaml_quote(case_id),
        "jurisdiction: %s" % _yaml_quote(meta["jurisdiction"]),
        "expected_parser: %s" % _yaml_quote(meta["expected_parser"]),
        "period: %s" % _yaml_quote(meta["period"]),
        "period_end: %s" % _yaml_quote(meta["period_end"]),
        "anonymized: %s" % _yaml_quote(meta["anonymized"]),
        "expect_ai_never_consulted: %s" % _yaml_quote(meta["expect_ai_never_consulted"]),
        "source_notes: %s" % _yaml_quote(meta["source_notes"]),
        "",
    ]
    return "\n".join(lines)


def build(force_meta: bool = False, force_inputs: bool = False) -> None:
    """Create missing case inputs/meta/mocks. Inputs are FROZEN once
    created (XLSX zip containers embed save timestamps, so a rebuild is
    never byte-identical — rewriting would silently invalidate every
    golden keyed to the input's content hash). --force-inputs rebuilds
    them anyway; refreeze the goldens afterwards."""
    for case_id, input_name, builder, meta in CASES:
        case_dir = CORPUS / case_id
        case_dir.mkdir(parents=True, exist_ok=True)
        (case_dir / "expected").mkdir(exist_ok=True)
        input_path = case_dir / input_name
        if force_inputs or not input_path.is_file():
            data = builder()
            input_path.write_bytes(data)
            print("wrote  %s (%d bytes)" % (input_path.relative_to(REPO), len(data)))
        else:
            print("kept   %s" % input_path.relative_to(REPO))
        meta_path = case_dir / "meta.yaml"
        if force_meta or not meta_path.is_file():
            meta_path.write_text(_meta_yaml(case_id, meta), encoding="utf-8")
            print("meta   %s" % meta_path.relative_to(REPO))
        for mock_name, payload in MOCK_FILES.get(case_id, {}).items():
            mock_path = case_dir / mock_name
            text = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
            if not mock_path.is_file() or mock_path.read_text(encoding="utf-8") != text:
                mock_path.write_text(text, encoding="utf-8")
                print("mock   %s" % mock_path.relative_to(REPO))


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--force-meta", action="store_true",
                        help="overwrite existing meta.yaml files")
    parser.add_argument("--force-inputs", action="store_true",
                        help="rebuild existing input files (invalidates the "
                             "goldens — refreeze with UPDATE_GOLDEN=1 after)")
    args = parser.parse_args(argv)
    build(force_meta=args.force_meta, force_inputs=args.force_inputs)
    return 0


if __name__ == "__main__":
    sys.exit(main())
