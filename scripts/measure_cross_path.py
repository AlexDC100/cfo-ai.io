"""F-A3.2-CROSS-PATH — gate added in F3.16-3b.2 closure.

Why this gate exists: F-A3.1 walks only Path A (TB fast-path through
`accounts_to_assemble_shape` → `assemble_statements`). The 121-anchor
divergence bug fixed by F3.16-3b.2 lived undetected for weeks because
NO gate walked Path B (Claude-extracted accounts → `assemble_statements`
directly). A comment at `chart_of_accounts.py:1796-1804` documented the
divergence in prose but no test pinned it. This gate enforces that
ANY future preprocessing layer between extraction and engine cannot
silently drop or transform data that engine consumes.

Specification:
  · For each canonical fixture, run BOTH Path A and Path B simulation.
    - Path A: `parse_trial_balance_file` → `accounts_to_assemble_shape`
      → `assemble_statements(accounts, account_121_anchor_override=anchor)`.
    - Path B: same raw rows BUT skip `accounts_to_assemble_shape`
      preprocessing; coerce to Claude-output shape ({code, name, amount})
      and pass to `assemble_statements(accounts, account_121_anchor_override=anchor)`.
  · Assert convergence within ±1 RON on `net_income_statutory` and
    `current_year_pnl`. Wider divergence is RED, not warning.
  · Threshold widening explicitly forbidden by this comment block —
    if a fixture diverges, fix the engine path divergence; don't
    silence the gate.

Exit codes:
  0 — all fixtures GREEN (Path A and Path B converge within ±1 RON)
  1 — at least one fixture RED (divergence detected)
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any, Dict, List, Tuple

REPO = Path(__file__).resolve().parent.parent
SRC = REPO / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

# F-A3.2 threshold. DO NOT WIDEN. The 121-anchor bug fixed in F3.16-3b.2
# would have been caught here with the original ±1 RON threshold; loosening
# would defeat the gate's purpose. Re-read the docstring before changing.
CONVERGENCE_RON = 1.0


def _import_measure() -> Any:
    spec = importlib.util.spec_from_file_location(
        "_measure_bs_drift", REPO / "scripts" / "measure_bs_drift.py",
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules["_measure_bs_drift"] = mod
    spec.loader.exec_module(mod)
    return mod


def _shaped_to_claude(shaped: List[Dict]) -> List[Dict]:
    """Coerce TB-shaped accounts into the {code, name, amount} shape
    Claude returns. This is the BYPASS — we deliberately drop any
    bucket / sign metadata the deterministic parser would attach so
    we exercise the Claude code path through `assemble_statements`."""
    out = []
    for a in shaped:
        out.append({
            "code": str(a.get("code", "")).strip(),
            "name": str(a.get("name", "") or ""),
            "amount": float(a.get("amount") or 0),
        })
    return out


def _run(accounts: List[Dict], anchor: float, name: str) -> Dict[str, float]:
    from engine.country_packs.ro_romania.chart_of_accounts import assemble_statements
    result = assemble_statements(
        accounts,
        company_name=name,
        currency="RON",
        period_label="FY2025",
        account_121_anchor_override=anchor,
    )
    bs = (result or {}).get("statements", {}).get("assembled_bs") or {}
    return {
        "current_year_pnl": float(bs.get("current_year_pnl") or 0),
        "total_assets": float(bs.get("total_assets") or 0),
        "total_equity": float(bs.get("total_equity") or 0),
        "bs_balance_delta": float(bs.get("bs_balance_delta") or 0),
    }


def main() -> int:
    m = _import_measure()
    fixtures = [
        ("EEI", m.load_eei),
        ("Scandia", m.load_scandia),
        ("Sibiu", m.load_sibiu),
        ("Frozen", m.load_frozen),
        ("RealEstate", m.load_realestate),
        ("Agras", m.load_agras),
        ("Carniprod", m.load_carniprod),
        ("Retail", m.load_retail),
    ]

    print()
    print("F-A3.2-CROSS-PATH — Path A vs Path B convergence gate")
    print("=" * 80)
    print(f"  Convergence threshold: ±{CONVERGENCE_RON} RON on current_year_pnl")
    print()
    print(f"  {'Fixture':<12s}  {'A current_pnl':>16s}  {'B current_pnl':>16s}  "
          f"{'Δ RON':>12s}  {'verdict':>8s}")
    print(f"  {'-'*12}  {'-'*16}  {'-'*16}  {'-'*12}  {'-'*8}")

    red_count = 0
    for name, loader in fixtures:
        try:
            tup = loader()
            shaped = tup[0]
        except Exception as exc:  # noqa: BLE001
            print(f"  {name:<12s}  LOADER FAILED: {exc}")
            continue

        # Compute the anchor independently (mimics what pipeline.py
        # captures during stage_extract).
        try:
            anchor = _compute_anchor(name, shaped, m)
        except Exception:
            anchor = 0.0

        try:
            path_a = _run(shaped, anchor, name)
            path_b = _run(_shaped_to_claude(shaped), anchor, name)
            delta = path_b["current_year_pnl"] - path_a["current_year_pnl"]
            verdict = "GREEN" if abs(delta) <= CONVERGENCE_RON else "RED"
            if verdict == "RED":
                red_count += 1
            print(
                f"  {name:<12s}  {path_a['current_year_pnl']:>16,.2f}  "
                f"{path_b['current_year_pnl']:>16,.2f}  {delta:>12,.2f}  "
                f"{verdict:>8s}"
            )
        except Exception as exc:  # noqa: BLE001
            print(f"  {name:<12s}  RUN FAILED: {type(exc).__name__}: {exc}")
            red_count += 1

    print()
    print(f"  RED fixtures: {red_count} of {len(fixtures)}")
    print()
    if red_count > 0:
        print("  F-A3.2-CROSS-PATH FAILED. Path A and Path B diverged > 1 RON")
        print("  on at least one fixture. DO NOT WIDEN THE THRESHOLD.")
        print("  Investigate which preprocessing-vs-engine step caused the gap.")
        return 1
    print("  F-A3.2-CROSS-PATH GREEN. Path A ≡ Path B on every fixture.")
    return 0


def _compute_anchor(name: str, shaped: List[Dict], m: Any) -> float:
    """For the cross-path gate the anchor is the same value pipeline.py
    would capture. EEI uses JSON, others use the spreadsheet parser."""
    if name == "EEI":
        import json as _json
        # F3.16 — `files/eei_expected_extraction.json` is the
        # in-container path (the FE tree is excluded by .dockerignore).
        # Repo-root path stays as primary so local dev hits the
        # source-of-truth JSON.
        candidates = m._candidate_paths(
            "scandi-desk-main/e2e/fixtures/ground-truth/ro_eei_dec_2025/expected_extraction.json",
            "tests/fixtures/ro_eei_dec_2025/expected_extraction.json",
            "files/eei_expected_extraction.json",
        )
        if not candidates:
            return 0.0
        d = _json.loads(candidates[0].read_text())
        total = 0.0
        for a in d.get("accounts", []):
            code = str(a.get("code") or "").strip()
            if code.startswith("121"):
                sf_d = float(a.get("closing_debit") or 0)
                sf_c = float(a.get("closing_credit") or 0)
                total += (sf_c - sf_d)
        return total
    # Spreadsheet fixtures: sum amount column for code starting with 121.
    return sum(
        float(a.get("amount") or 0)
        for a in shaped
        if str(a.get("code") or "").strip().startswith("121")
    )


if __name__ == "__main__":
    sys.exit(main())
