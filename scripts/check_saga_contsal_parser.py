"""F3.9c-PARSER gate.

Verifies that the trial_balance_parser handles the SAGA / ContSal XLSX
dialect — the file format used by Scandia Frozen FY2025 and Scandia
RealEstate FY2025. Distinguishing markers:

  - Header row uses BLN_CONT / BLN_DENUMIRE (underscore-prefixed, not
    the canonical 'Cont' / 'Nume Cont')
  - 10 columns total: BLN_CONT, BLN_DENUMIRE, SI DEBIT, SI CREDIT,
    RL DEBIT, RL CREDIT, RC DEBIT, RC CREDIT, SF DEBIT, SF CREDIT
  - Row immediately after the header is a GENERAL totals row with
    null BLN_CONT and populated number columns (skipped by the
    existing `_is_totals_row` heuristic)

Acceptance:
  - Both fixtures parse without raising ParseError
  - Account count >= 50 (real Romanian SME TBs have many sub-accounts)
  - Account 121 statutory anchor matches toolkit HTML expected:
      Scandia Frozen FY2025:     402,869.16 RON (sf_c, net profit)
      Scandia RealEstate FY2025: 801,604.14 RON (sf_d, net LOSS)

Per the F3.2-locked discipline, non-triviality is verified
externally: reverting the regex fix should make this gate fail
(documented in the F3.9c closure report).

Exit 0 — GREEN. Exit 1 — any assertion fails.
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


def _assert(cond: bool, msg: str, fails: list) -> None:
    print(f"  {'GREEN' if cond else 'RED  '}  {msg}")
    if not cond:
        fails.append(msg)


def _load_fixture(name: str) -> bytes:
    for p in [
        REPO / f"src/engine/country_packs/ro_romania/fixtures/saga_contsal_samples/{name}",
        Path(f"/app/src/engine/country_packs/ro_romania/fixtures/saga_contsal_samples/{name}"),
        Path(f"/host_repo/src/engine/country_packs/ro_romania/fixtures/saga_contsal_samples/{name}"),
    ]:
        if p.is_file():
            return p.read_bytes()
    raise FileNotFoundError(f"Fixture {name} not found")


def main() -> None:
    fails: list = []
    print("F3.9c-PARSER gate — SAGA / ContSal XLSX dialect\n")

    from engine.country_packs.ro_romania import trial_balance_parser as tbp
    import engine.country_packs.ro_romania  # noqa: F401 — register pack
    from engine.core.country_pack_registry import get_pack
    pack = get_pack("RO")

    fixtures = [
        ("scandia_frozen_2025.xlsx", "Scandia Frozen", 402869.16, "sf_c"),
        ("scandia_realestate_2025.xlsx", "Scandia RealEstate", 801604.14, "sf_d"),
    ]

    for filename, label, expected_anchor, anchor_side in fixtures:
        print(f"\n{label} ({filename}):")
        content = _load_fixture(filename)
        try:
            rows = tbp.parse_trial_balance_file(content, filename)
        except Exception as e:
            _assert(False, f"parse_trial_balance_file did not raise (got {type(e).__name__}: {str(e)[:120]})", fails)
            continue
        _assert(rows is not None and len(rows) >= 50,
                f"account count >= 50 (got {len(rows) if rows else 0})", fails)

        anchor = tbp.compute_statutory_net_profit_anchor(rows)
        # For Frozen, sf_c=402,869 is positive net profit → anchor = sf_c - sf_d > 0
        # For RealEstate, sf_d=801,604 is loss → anchor = sf_c - sf_d < 0 (negative anchor)
        # The compute_statutory_net_profit_anchor function returns sf_c - sf_d.
        # We compare absolute value to the expected magnitude.
        expected_signed = expected_anchor if anchor_side == "sf_c" else -expected_anchor
        _assert(
            abs(anchor - expected_signed) < 1.0,
            f"account 121 anchor == {expected_signed:+,.2f} RON "
            f"(got {anchor:+,.2f}; toolkit-expected magnitude {expected_anchor:,.2f} on {anchor_side})",
            fails,
        )

        # Verify pack dispatch path produces the same rows
        via_pack = pack.parse_trial_balance(content, filename)
        _assert(
            len(via_pack) == len(rows),
            f"pack.parse_trial_balance dispatches XLSX cleanly "
            f"(got {len(via_pack)} rows, expected {len(rows)})",
            fails,
        )

        # Sanity-check shape: every row has expected keys
        if rows:
            r0 = rows[0]
            expected_keys = {"cont", "nume_cont", "si_d", "si_c", "r_d", "r_c", "st_d", "st_c", "sf_d", "sf_c"}
            actual_keys = set(r0.keys())
            _assert(
                expected_keys.issubset(actual_keys),
                f"first row has all expected keys (missing: {expected_keys - actual_keys})",
                fails,
            )

    print()
    if fails:
        print(f"Overall: RED — {len(fails)} F3.9c-PARSER assertion(s) failed.")
        sys.exit(1)
    print("Overall: GREEN — F3.9c-PARSER gate passes.")
    sys.exit(0)


if __name__ == "__main__":
    main()
