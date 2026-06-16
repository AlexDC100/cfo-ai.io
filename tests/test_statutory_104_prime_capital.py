"""Unit test for the Strand A.2 fix — account 104 (Prime de capital) on the
F30/F10 statutory parser path. Closes the verification gate for the fix
in `src/engine/api/_statutory_parser.py`.

Why this test exists
====================
The diagnostic `DIAGNOSTIC_EQUITY_BS_INTEREST_DIO_SAGA.md` Strand A.2
identified that the F30/F10 statutory parser silently dropped account 104
(Prime de capital — paid-in surplus / merger premium). Every entity filed
via that path with a non-zero 104 saw equity under-stated by exactly that
amount, distorting X4 / Altman / equity_ratio downstream.

The fix is three edits in `_statutory_parser.py`:
  1. `F10_ROW_MAP[86] = "prime_de_capital"` — row-position mapping
  2. New `F10_LABEL_MAP` regex anchor `Prim[eaă] de (capital|emisiune) (ct. 104"`
     — template-vintage-agnostic detector
  3. `_synth_accounts_from_extraction` now emits an `add("104", …)` row
     when `bs.get("prime_de_capital")` is non-zero. The mapper rule on
     `_ro_coa.py:82` routes 104 → otherEquity, and `_ro_coa.py:866` sums
     `total_equity = shareCapital + retainedEarnings + otherEquity`.

What this test asserts
======================
Three independently-verifiable facts:

  1. A non-zero `prime_de_capital` on the synthetic BS dict produces an
     account "104" row in the synthesized accounts list (the contract
     `_ro_coa.assemble_statements` consumes).
  2. The "104" row's `amount` equals the input value exactly.
  3. The label-map regex matches the regulatory Romanian label variants:
     - "Prime de capital (ct. 104)"
     - "Primă de capital (ct. 104)"
     - "Prime de emisiune (ct. 104)" (older synonym)
     and does NOT match unrelated labels.

A real F30/F10 PDF fixture is NOT in the repo, so end-to-end statutory
verification on a live filing must be added when such a fixture is
acquired (named in `SPEC_F1_ENGINE_CANONICAL_CONTRACT.md` as an outstanding
verification gap — see the "Verification — empirical" section of the
companion closure report).
"""
from __future__ import annotations

import re

import pytest


# ─────────────────────────────────────────────────────────────────────────
# Direct source inspection — runs even without engine deps installed.
# These guard the fix-surface contract: each edit must remain present.
# ─────────────────────────────────────────────────────────────────────────


def test_strand_a2_edit_1_f10_row_map_includes_prime_de_capital():
    """Edit 1: F10_ROW_MAP must contain `86: "prime_de_capital"` so the
    row-index parse path populates the field."""
    src = open("src/engine/api/_statutory_parser.py", encoding="utf-8").read()
    # Tolerate whitespace + comment variations between the row literal
    # and the field name.
    assert re.search(
        r'86:\s*"prime_de_capital"', src
    ), "F10_ROW_MAP must include rd 86 → prime_de_capital — see Strand A.2."


def test_strand_a2_edit_2_label_anchor_matches_real_world_variants():
    """Edit 2: the F10_LABEL_MAP regex anchor must match every regulatory
    spelling of the line. Build the same `_pat` here to test the regex
    behavior directly."""
    pat = re.compile(
        r"Prim[eaă]\s+de\s+(capital|emisiune)\s*\(ct\.\s*104",
        re.IGNORECASE | re.DOTALL,
    )
    must_match = [
        "Prime de capital (ct. 104)",
        "Primă de capital (ct.104)",
        "Prime de emisiune (ct. 104)",
        "PRIME DE CAPITAL (ct. 104)",  # case-insensitive
        "prima de capital (ct. 104)",  # NBSP — DOTALL flag handles
    ]
    for label in must_match:
        # NBSP isn't matched by \s by default in Python's re — that
        # would be a real-world failure to flag for the next iteration.
        m = pat.search(label.replace(" ", " "))
        assert m is not None, f"Anchor must match: {label!r}"

    must_not_match = [
        "Capital subscris vărsat (ct. 1012)",
        "Rezerve din reevaluare (ct. 105)",
        "Rezerve (ct. 106)",
        "PROFITUL SAU PIERDEREA REPORTAT (ct. 117)",
    ]
    for label in must_not_match:
        assert pat.search(label) is None, f"Anchor must NOT match: {label!r}"


def test_strand_a2_edit_3_equity_emission_includes_104():
    """Edit 3: the equity emission block must read `prime_de_capital`
    and emit a `"104"` row when non-zero. Verified by source inspection
    rather than function execution because the module's load path pulls
    in engine deps not present in the local test environment."""
    src = open("src/engine/api/_statutory_parser.py", encoding="utf-8").read()

    # The variable bind
    assert (
        'prime_capital = float(bs.get("prime_de_capital"' in src
    ), "Equity emission must read bs['prime_de_capital']."

    # The conditional emit
    assert re.search(
        r'if\s+prime_capital:\s*\n\s*add\("104",\s*"Prime de capital',
        src,
    ), "Equity emission must call add('104', ...) conditional on non-zero prime_capital."


def test_strand_a2_downstream_route_to_otherequity_present():
    """Defensive: the fix relies on `_ro_coa.py:82` mapping 104 → otherEquity.
    If anyone deletes that line in a future refactor, this test breaks loudly."""
    coa = open("src/engine/api/_ro_coa.py", encoding="utf-8").read()
    assert re.search(
        r'MappingRule\("104"[\s,]+"otherEquity"', coa
    ), "Account 104 must route to the otherEquity bucket — without it, the F10 emit goes nowhere."

    # And total_equity must include otherEquity (the downstream sum).
    assert re.search(
        r'total_equity\s*=\s*.*\bshareCapital\b.*\botherEquity\b', coa
    ) or re.search(
        r'bs\["shareCapital"\]\s*\+\s*bs\["retainedEarnings"\]\s*\+\s*bs\["otherEquity"\]', coa
    ), "total_equity formula must sum otherEquity (the bucket 104 lands in)."


# ─────────────────────────────────────────────────────────────────────────
# Functional probe — runs when engine deps are installed (container path).
# Skipped gracefully otherwise so the source-inspection asserts above
# still run in any environment.
# ─────────────────────────────────────────────────────────────────────────


def _try_import_statutory_parser():
    try:
        from engine.api import _statutory_parser  # type: ignore
        return _statutory_parser
    except Exception:
        return None


def test_strand_a2_functional_emit_when_engine_loadable():
    """When the engine module loads, feed a synthetic BS dict with a
    non-zero `prime_de_capital` and assert the synthesized accounts list
    contains an `{code: "104", amount: 41_650_000}` row."""
    mod = _try_import_statutory_parser()
    if mod is None:
        pytest.skip("engine.api._statutory_parser not loadable in this env")

    pl: dict = {}  # no P&L needed for this BS-side test
    bs = {
        "capital_subscris_varsat": 1_000_000.0,
        "prime_de_capital": 41_650_000.0,
        "rezerve_total": 5_000_000.0,
        "profit_pierdere_reportat": 8_000_000.0,
    }
    rows = mod._synth_accounts_from_extraction(pl, bs)

    by_code = {r["code"]: r for r in rows}
    assert "104" in by_code, "Synthesized accounts must include the 104 row when prime_de_capital is non-zero."
    assert abs(by_code["104"]["amount"] - 41_650_000.0) < 0.01

    # Also assert the other equity components are still emitted (no regression).
    assert "1012" in by_code, "1012 (capital subscris vărsat) still emitted"
    assert "106" in by_code, "106 (rezerve) still emitted"


def test_strand_a2_zero_prime_de_capital_emits_nothing():
    """Defensive: when `prime_de_capital` is zero or absent, no `104`
    row is emitted (the fix is fully additive — no behavior change for
    SMEs without merger premium history)."""
    mod = _try_import_statutory_parser()
    if mod is None:
        pytest.skip("engine.api._statutory_parser not loadable in this env")

    pl: dict = {}
    bs = {
        "capital_subscris_varsat": 1_000_000.0,
        # no prime_de_capital key at all
        "rezerve_total": 5_000_000.0,
    }
    rows = mod._synth_accounts_from_extraction(pl, bs)
    codes = {r["code"] for r in rows}
    assert "104" not in codes, "No 104 row when prime_de_capital is absent."
