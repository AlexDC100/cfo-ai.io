"""F3.8 one-shot baseline re-capture for the 7 fixtures whose engine
output changed under the F3.8 systematic RAS coverage pass (25 new
catchall MappingRules).

EEI is NOT re-captured — F3.1-PARITY confirmed byte-identical post-F3.8.

This script is a one-shot tied to the F3.8 ceremony. Do not invoke
casually — re-baselining is gated by the ceremony rules in
BASELINE_HISTORY.md. Archives were already made (pre-F3.8 copies under
`archive/<fixture>_pre_f3.8.json`) before this script runs.

Usage:
    .venv/bin/python3 scripts/_f3_8_recapture.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "src"))
sys.path.insert(0, str(REPO / "scripts"))

from measure_bs_drift import (  # noqa: E402
    _load_ro_coa, _normalize_for_assembler,
    load_scandia, load_sibiu, load_frozen, load_realestate,
    load_agras, load_carniprod, load_retail,
    _PER_FIXTURE_THRESHOLD,
)


BASELINE_DIR = REPO / "src/engine/country_packs/ro_romania/fixtures/regression_baselines"

# (slug, loader, source_file_basename, industry_target_tag)
FIXTURES = [
    ("scandia_fy2025",            load_scandia,    "scandia_trial_balance_2025_downloaded.xlsx", "food_manufacturing"),
    ("sibiu_dec_2019",            load_sibiu,      "scandia_sibiu_tb_2019.pdf",                  "food_manufacturing"),
    ("scandia_frozen_fy2025",     load_frozen,     "scandia_frozen_tb_2025.xlsx",                "food_manufacturing"),
    ("scandia_realestate_fy2025", load_realestate, "scandia_realestate_tb_2025.xlsx",            "real_estate_developer"),
    ("agras_fy2025",              load_agras,      "agras_tb_2025.xlsx",                          "food_manufacturing"),
    ("carniprod_fy2025",          load_carniprod,  "carniprod_tb_2025.xlsx",                      "food_manufacturing"),
    ("scandia_retail_fy2025",     load_retail,     "scandia_retail_tb_2025.xlsx",                 "retail_grocery"),
]


def _round(obj):
    """Match capture_assembled_baseline._round for float precision parity
    (4 decimal places; required so F3.1-PARITY's 1e-4 tolerance is preserved)."""
    if isinstance(obj, float):
        return round(obj, 4)
    if isinstance(obj, dict):
        return {k: _round(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_round(x) for x in obj]
    return obj


def main() -> None:
    ro_coa = _load_ro_coa()
    fn = ro_coa.assemble_statements

    # Scandia is in the F3.1-PARITY gate (check_assembled_parity.py reads
    # the full `assembled` dict — statements + lineItems + unmapped + ignored).
    # The other 6 fixtures are F-A3.1-only; the prior convention captured
    # just `statements`. Honor that distinction: full dict for Scandia,
    # trimmed dict for the rest. Either way, all 7 baselines get the
    # richer _meta block with F3.8 ceremony fields.
    PARITY_GATE_FIXTURES = {"scandia_fy2025"}

    for slug, loader, source_file, industry in FIXTURES:
        print(f"=== {slug} ===")
        loaded = loader()
        # Loaders now return either (accts, name) or (accts, name, source_quality)
        # depending on F3.9 evolution; tolerate both for back-compat.
        accts, name = loaded[0], loaded[1]
        # Match capture_assembled_baseline.py's period_label so re-captures
        # stay drop-in compatible with check_assembled_parity.py.
        period_label = "2025-12-31" if slug in PARITY_GATE_FIXTURES else "FY2025"
        result = fn(accts, company_name=name, currency="RON", period_label=period_label)
        statements = (result or {}).get("statements") or {}
        bs_canonical = statements.get("assembled_bs") or {}

        total_assets = float(bs_canonical.get("total_assets") or 0)
        bs_balance_delta = float(bs_canonical.get("bs_balance_delta") or 0)
        drift_pct = round(abs(bs_balance_delta) / total_assets * 100, 4) if total_assets > 0 else 0.0

        threshold = _PER_FIXTURE_THRESHOLD.get(_short_name(slug), 0.5)
        verdict = "GREEN" if drift_pct <= threshold else "RED"

        if slug in PARITY_GATE_FIXTURES:
            assembled_block = _round(result)
        else:
            assembled_block = {"statements": _round(statements)}

        out_path = BASELINE_DIR / f"{slug}.json"
        wrapped = {
            "_meta": {
                "fixture": slug,
                "company": name,
                "captured_from": "F3.8 — systematic RAS coverage pass re-capture",
                "engine_module": getattr(ro_coa, "__file__", "?"),
                "engine_version": "post-F3.8 (25 catchall MappingRules added across classes 1/2/5/6/7 per OMFP 1802; "
                                  "preserves F3.7d locked-truth + F-A3.1 GREEN on 8-fixture registry)",
                "account_count": len(accts),
                "source_file": source_file,
                "industry_target": industry,
                "bs_drift_pct": drift_pct,
                "fa31_verdict": verdict,
            },
            "assembled": assembled_block,
        }
        out_path.write_text(json.dumps(wrapped, indent=2, ensure_ascii=False))
        size = len(out_path.read_text())
        full_note = " [PARITY-GATE: full dict]" if slug in PARITY_GATE_FIXTURES else ""
        print(f"  WROTE {out_path.name} ({size:,} bytes) — {len(accts)} accts, drift {drift_pct:.4f}%, {verdict} (≤{threshold:.1f}%){full_note}")
        print()


def _short_name(slug: str) -> str:
    """Map fixture slug to _PER_FIXTURE_THRESHOLD key."""
    table = {
        "eei_dec_2025": "EEI",
        "scandia_fy2025": "Scandia",
        "sibiu_dec_2019": "Sibiu",
        "scandia_frozen_fy2025": "Frozen",
        "scandia_realestate_fy2025": "RealEstate",
        "agras_fy2025": "Agras",
        "carniprod_fy2025": "Carniprod",
        "scandia_retail_fy2025": "Retail",
    }
    return table.get(slug, slug)


if __name__ == "__main__":
    main()
