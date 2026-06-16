"""F3.2 — Canonical-model conformance gate.

Runs `validate_canonical_envelope(...)` against both Romanian fixtures'
`assemble_statements()` output. Also runs a negative-test: a synthetic
envelope with a required field removed must FAIL validation.

Exit codes:
  0 — both fixtures conform AND negative test fails as expected
  1 — any fixture fails validation, or negative test passes (bug)

Run inside the engine container with the repo mounted at /host_repo:
  docker run --rm -v /opt/cfo-ai:/host_repo:ro cfo-ai-backend \\
    python3 /host_repo/scripts/check_canonical_model.py
"""
from __future__ import annotations

import copy
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

from capture_assembled_baseline import (  # noqa: E402
    _capture, _load_ro_coa, _normalize_for_assembler, load_eei, load_scandia,
)
from engine.core.canonical_model import (  # noqa: E402
    validate_canonical_envelope,
)


def _negative_test(envelope) -> bool:
    """Remove a required field; validator MUST flag it. Returns True
    when the negative test correctly detects the violation."""
    broken = copy.deepcopy(envelope)
    # Remove a required field: assembled_bs.total_assets
    try:
        del broken["statements"]["assembled_bs"]["total_assets"]
    except (KeyError, TypeError):
        print("    NEGATIVE TEST setup failed — couldn't remove total_assets")
        return False
    report = validate_canonical_envelope(broken)
    has_target_error = any(
        "assembled_bs" in e and "total_assets" in e for e in report.errors
    )
    if report.ok or not has_target_error:
        print("    NEGATIVE TEST FAILED — validator did NOT catch the missing field:")
        print(f"      ok={report.ok}, errors={report.errors[:3]}")
        return False
    return True


def main() -> None:
    ro_coa = _load_ro_coa()
    if ro_coa is None:
        print("FAIL: _ro_coa not importable")
        sys.exit(2)

    print(f"REPO root: {REPO}\n")

    overall_green = True
    targets = []
    try:
        eei_raw, eei_name = load_eei()
        eei_accts = _normalize_for_assembler(eei_raw, ro_coa)
        targets.append(("eei_dec_2025", eei_name, eei_accts))
    except Exception as e:
        print(f"  EEI loader FAILED: {type(e).__name__}: {e}")
        overall_green = False

    try:
        scandia_accts, scandia_name = load_scandia()
        targets.append(("scandia_fy2025", scandia_name, scandia_accts))
    except Exception as e:
        print(f"  Scandia loader FAILED: {type(e).__name__}: {e}")
        overall_green = False

    envelope_for_negative_test = None
    for slug, name, accts in targets:
        envelope = _capture(name, accts, ro_coa)
        report = validate_canonical_envelope(envelope)
        if report.ok:
            print(f"  GREEN  {slug:<20}  validates against CanonicalFinancialModel")
        else:
            print(f"  RED    {slug:<20}  {len(report.errors)} violations:")
            for e in report.errors[:10]:
                print(f"           {e}")
            overall_green = False
        if envelope_for_negative_test is None:
            envelope_for_negative_test = envelope

    print()
    if envelope_for_negative_test is None:
        print("Negative test: SKIPPED (no fixture envelope available).")
        overall_green = False
    else:
        if _negative_test(envelope_for_negative_test):
            print("  GREEN  negative test    — validator caught removed total_assets")
        else:
            overall_green = False

    print()
    if overall_green:
        print("Overall: GREEN — F3.2 canonical model conformance passes.")
        sys.exit(0)
    else:
        print("Overall: RED — F3.2 canonical model gate FAILS.")
        sys.exit(1)


if __name__ == "__main__":
    main()
