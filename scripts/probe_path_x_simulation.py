"""F3.16-3b.2 — Path X pre-deploy simulation.

Runs every fixture in measure_bs_drift.py's set TWICE through
assemble_statements:
  1. Without `account_121_anchor_override` (current production behavior;
     Path A preprocessing drops the 121 row so the override never fires)
  2. With `account_121_anchor_override = compute_statutory_net_profit_anchor(raw_rows)`
     (what pipeline.py will pass once Path X ships)

For each fixture, prints pre/post drift in RON and as a percentage of
total_assets so we can lock the Carniprod prediction and produce the
would-be-shift report BEFORE deploying.

This runs LOCALLY and DOES NOT touch the VPS. The kwarg has been added
to assemble_statements but not yet deployed. Reuses measure_bs_drift's
loaders so we get the exact same source-data shape the F-A3.1 gate uses.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

REPO = Path(__file__).resolve().parent.parent
SRC = REPO / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))


def _import_measure() -> Any:
    """Import scripts/measure_bs_drift.py so we can reuse its loaders."""
    spec = importlib.util.spec_from_file_location(
        "_measure_bs_drift", REPO / "scripts" / "measure_bs_drift.py",
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules["_measure_bs_drift"] = mod
    spec.loader.exec_module(mod)
    return mod


def _compute_anchor_for_raw(name: str, m: Any) -> Optional[float]:
    """Re-run the loader to grab the RAW rows so we can compute the 121
    anchor. EEI's JSON loader doesn't expose raw rows, so we extract
    sf_d/sf_c from the JSON manually for that one. Others get the raw
    rows back via parse_trial_balance_file.

    Returns the anchor as a float (sf_c - sf_d summed over 121x codes).
    """
    if name == "EEI":
        import json as _json
        candidates = m._candidate_paths(
            "scandi-desk-main/e2e/fixtures/ground-truth/ro_eei_dec_2025/expected_extraction.json",
            "tests/fixtures/ro_eei_dec_2025/expected_extraction.json",
        )
        if not candidates:
            return None
        d = _json.loads(candidates[0].read_text())
        total = 0.0
        for a in d.get("accounts", []):
            code = str(a.get("code") or "").strip()
            if code.startswith("121"):
                sf_d = float(a.get("closing_debit") or 0)
                sf_c = float(a.get("closing_credit") or 0)
                total += (sf_c - sf_d)
        return total

    # Map to the XLSX/PDF path used by each loader
    paths = {
        "Scandia":    ["files/scandia_trial_balance_2025_downloaded.xlsx",
                       "tests/fixtures/scandia_trial_balance_2025.xlsx"],
        "Sibiu":      ["files/scandia_sibiu_tb_2019.pdf"],
        "Frozen":     ["files/scandia_frozen_tb_2025.xlsx"],
        "RealEstate": ["files/scandia_realestate_tb_2025.xlsx"],
        "Agras":      ["files/agras_tb_2025.xlsx"],
        "Carniprod":  ["files/carniprod_tb_2025.xlsx"],
        "Retail":     ["files/scandia_retail_tb_2025.xlsx"],
    }
    rels = paths.get(name)
    if rels is None:
        return None
    candidates = m._candidate_paths(*rels)
    if not candidates:
        return None
    p = candidates[0]
    tbp = m._load_trial_balance_parser()
    if tbp is None:
        return None
    try:
        raw_rows = tbp.parse_trial_balance_file(p.read_bytes(), p.name)
    except Exception:
        return None
    return tbp.compute_statutory_net_profit_anchor(raw_rows)


def _run_one(name: str, accounts: List[Dict], anchor: Optional[float]) -> Tuple[float, float, float, float]:
    """Run assemble_statements; return (drift_pct, drift_ron, total_assets, net_income_statutory)."""
    from engine.country_packs.ro_romania.chart_of_accounts import assemble_statements
    kwargs: Dict[str, Any] = {
        "company_name": name,
        "currency": "RON",
        "period_label": "FY2025",
    }
    if anchor is not None:
        kwargs["account_121_anchor_override"] = anchor
    result = assemble_statements(accounts, **kwargs)
    bs = (result or {}).get("statements", {}).get("assembled_bs") or {}
    ta = float(bs.get("total_assets") or 0)
    delta = float(bs.get("bs_balance_delta") or 0)
    pct = (abs(delta) / ta * 100) if ta > 0 else float("inf")
    nis = float((result or {}).get("pnl_reconstruction", {}).get("net_income_statutory") or
                bs.get("current_year_pnl") or 0)
    return pct, delta, ta, nis


FIXTURES = ["EEI", "Scandia", "Sibiu", "Frozen", "RealEstate", "Agras", "Carniprod", "Retail"]


def main() -> int:
    m = _import_measure()
    loader_map = {
        "EEI": m.load_eei,
        "Scandia": m.load_scandia,
        "Sibiu": m.load_sibiu,
        "Frozen": m.load_frozen,
        "RealEstate": m.load_realestate,
        "Agras": m.load_agras,
        "Carniprod": m.load_carniprod,
        "Retail": m.load_retail,
    }

    print()
    print("F3.16-3b.2 — Path X would-be-shift simulation (LOCAL, NOT DEPLOYED)")
    print("=" * 110)
    print()
    print(
        f"  {'Fixture':<11s}  {'Pre %':>8s}  {'Pre RON':>16s}  "
        f"{'Post %':>8s}  {'Post RON':>16s}  {'Δ RON':>16s}  "
        f"{'121 anchor':>16s}  {'NIS post':>16s}  {'Shift?':>8s}"
    )
    print("  " + "-" * 11 + "  " + "-" * 8 + "  " + "-" * 16 + "  "
          + "-" * 8 + "  " + "-" * 16 + "  " + "-" * 16 + "  "
          + "-" * 16 + "  " + "-" * 16 + "  " + "-" * 8)

    significant_count = 0
    significant_ron = 0.0
    rows_for_report: List[Dict[str, Any]] = []

    for name in FIXTURES:
        loader = loader_map.get(name)
        if loader is None:
            continue
        try:
            tup = loader()
            accounts = tup[0]
        except Exception as exc:  # noqa: BLE001
            print(f"  {name:<11s}  LOADER FAILED: {exc}")
            continue

        try:
            anchor = _compute_anchor_for_raw(name, m)
            pre_pct, pre_ron, pre_ta, pre_nis = _run_one(name, accounts, None)
            if anchor is None:
                # Skip the post-Path-X row if we can't compute an anchor.
                post_pct, post_ron, post_nis = pre_pct, pre_ron, pre_nis
                delta_ron = 0.0
                anchor_str = "N/A"
            else:
                post_pct, post_ron, _, post_nis = _run_one(name, accounts, anchor)
                delta_ron = post_ron - pre_ron
                anchor_str = f"{anchor:,.0f}"

            crosses_05 = (pre_pct > 0.5) != (post_pct > 0.5)
            significant = abs(delta_ron) > 100_000 or crosses_05
            if significant:
                significant_count += 1
                significant_ron += abs(delta_ron)
            flag = "  YES" if significant else "   no"

            print(
                f"  {name:<11s}  {pre_pct:>7.3f}%  {pre_ron:>16,.0f}  "
                f"{post_pct:>7.3f}%  {post_ron:>16,.0f}  {delta_ron:>16,.0f}  "
                f"{anchor_str:>16s}  {post_nis:>16,.0f}  {flag:>8s}"
            )
            rows_for_report.append({
                "name": name, "pre_pct": pre_pct, "pre_ron": pre_ron,
                "post_pct": post_pct, "post_ron": post_ron, "delta_ron": delta_ron,
                "anchor": anchor, "significant": significant,
            })
        except Exception as exc:  # noqa: BLE001
            print(f"  {name:<11s}  RUN FAILED: {type(exc).__name__}: {exc}")
            import traceback as _tb
            _tb.print_exc()

    print()
    print(f"  Significant shifts: {significant_count} of {len(FIXTURES)}")
    print(f"  Total |Δ RON|: {significant_ron:,.0f}")
    print()

    # Lock the Carniprod prediction explicitly so the post-deploy
    # check has a verbatim number to validate against.
    carni = next((r for r in rows_for_report if r["name"] == "Carniprod"), None)
    if carni:
        print("─ Carniprod prediction lock " + "─" * 70)
        print(f"  Pre-Path-X drift:  {carni['pre_pct']:.4f}% ({carni['pre_ron']:,.0f} RON)")
        print(f"  Post-Path-X drift: {carni['post_pct']:.4f}% ({carni['post_ron']:,.0f} RON)")
        print(f"  Δ:                 {carni['delta_ron']:,.0f} RON")
        if carni['anchor'] is not None:
            print(f"  121 anchor used:   {carni['anchor']:,.0f} RON")
        print(f"  Post-deploy gate:  if actual drift ≠ {carni['post_pct']:.4f}% ± 0.05%,")
        print(f"                     the trace is invalidated and we STOP.")
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
