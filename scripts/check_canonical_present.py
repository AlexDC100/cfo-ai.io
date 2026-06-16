"""F4.1-CANONICAL gate — verifies that every RO fixture produces a
well-formed `assembled_canonical_v1` envelope when run through the
engine. Checks:

  1. `assembled_canonical_v1` key present in the engine result
  2. `schema_version` matches canonical_v1.0.0
  3. `leaves` dict is non-empty
  4. `aggregates` dict is non-empty
  5. `unmapped` count is 0 (or within per-fixture tolerance)
  6. `round_trip_check.passed` is True

Exit 0 if all fixtures pass, exit 1 if any fail. Prints a one-line
verdict per fixture. CI-friendly.

Run from container:
    docker exec cfo-ai-backend python3 /app/scripts/check_canonical_present.py
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Optional, Tuple


def _find_repo_root() -> Path:
    here = Path(__file__).resolve().parent
    for c in [here, *here.parents][:6]:
        if (c / "pyproject.toml").is_file():
            return c
    return here.parent


REPO = _find_repo_root()
sys.path.insert(0, str(REPO / "src"))
sys.path.insert(0, str(REPO / "scripts"))

# Per-fixture unmapped tolerance. 0 by default — every account should
# resolve via the RO pack adapter's 200+ prefix rules. Carniprod and
# Sibiu have known source-data quirks; allow a small tolerance.
_UNMAPPED_TOLERANCE = {
    "EEI": 0, "Scandia": 0, "Frozen": 0, "RealEstate": 0,
    "Agras": 0, "Carniprod": 5, "Retail": 0, "Sibiu": 5,
}

EXPECTED_SCHEMA = "canonical_v1.0.0"


def _check_fixture(name: str, assembled: dict) -> Tuple[bool, str]:
    canonical = assembled.get("assembled_canonical_v1")
    if not isinstance(canonical, dict):
        return False, "MISSING assembled_canonical_v1"
    sv = canonical.get("schema_version")
    if sv != EXPECTED_SCHEMA:
        return False, f"WRONG schema_version: {sv} (expected {EXPECTED_SCHEMA})"
    leaves = canonical.get("leaves") or {}
    if not isinstance(leaves, dict) or not leaves:
        return False, "EMPTY leaves dict"
    aggregates = canonical.get("aggregates") or {}
    if not isinstance(aggregates, dict) or not aggregates:
        return False, "EMPTY aggregates dict"
    unmapped = canonical.get("unmapped") or []
    tol = _UNMAPPED_TOLERANCE.get(name, 0)
    if len(unmapped) > tol:
        u_preview = ", ".join(f"{u.get('code')}({u.get('reason','?')})" for u in unmapped[:3])
        return False, f"{len(unmapped)} unmapped > tolerance {tol}: {u_preview}"
    rt = canonical.get("round_trip_check") or {}
    if not rt.get("passed"):
        return False, f"round_trip_check.passed = False"
    return True, f"OK ({len(leaves)} leaves, {len(aggregates)} aggregates, {len(unmapped)} unmapped)"


def main() -> int:
    # Reuse fixture loaders from measure_bs_drift.py
    from measure_bs_drift import (
        _load_ro_coa, _normalize_for_assembler,
        load_eei, load_scandia, load_sibiu,
        load_frozen, load_realestate,
        load_agras, load_carniprod, load_retail,
    )
    ro_coa = _load_ro_coa()
    fn = ro_coa.assemble_statements

    fixtures: list = []
    # EEI takes a normalization step
    try:
        accts, name, _ = load_eei()
        normalized = _normalize_for_assembler(accts, ro_coa)
        fixtures.append(("EEI", normalized, name))
    except Exception as e:
        print(f"FAIL EEI load: {e}")
        return 1
    for short, loader in [
        ("Scandia", load_scandia), ("Sibiu", load_sibiu),
        ("Frozen", load_frozen), ("RealEstate", load_realestate),
        ("Agras", load_agras), ("Carniprod", load_carniprod),
        ("Retail", load_retail),
    ]:
        try:
            accts, name, _ = loader()
            fixtures.append((short, accts, name))
        except Exception as e:
            print(f"FAIL {short} load: {e}")
            return 1

    all_pass = True
    print("F4.1-CANONICAL — assembled_canonical_v1 presence + structure gate")
    print("=" * 70)
    for short, accts, name in fixtures:
        try:
            result = fn(accts, company_name=name, currency="RON", period_label="FY2025")
            ok, detail = _check_fixture(short, result)
            status = "GREEN" if ok else "RED"
            print(f"  {short:<11s} {status}  {detail}")
            if not ok:
                all_pass = False
        except Exception as e:
            print(f"  {short:<11s} RED  exception: {type(e).__name__}: {e}")
            all_pass = False
    print()
    print("Overall: " + ("GREEN — F4.1-CANONICAL passes on all RO fixtures."
                          if all_pass else
                          "RED — F4.1-CANONICAL fails. Do not deploy."))
    return 0 if all_pass else 1


if __name__ == "__main__":
    sys.exit(main())
