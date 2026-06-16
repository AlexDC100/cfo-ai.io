"""F4.2-PARITY gate — verifies that the YAML methodology's EBITDA
variants match the in-code EBITDA values from
`chart_of_accounts.assemble_statements()` within 1 RON tolerance.

Per F3.15 §3e parallel migration: legacy in-code EBITDA fields stay
byte-identical until the 2Q deprecation horizon (~Nov 2026). This gate
proves the methodology layer is a faithful reproduction — if it
diverges, the YAML has a bug, NOT the in-code values.

Acceptance (locked 2026-05-26 by F3.16-3b.6 ship-B —
[F3.16-3b6-FOLLOWUP-VARIANT-PARITY] Phase 3 deliverable):
  - For every fixture: methodology.ebitda.reported  ≈ in-code ebitda_statutory   (HARD ±1 RON)
  - For every fixture: methodology.ebitda.strict    ≈ in-code adjusted_ebitda    (HARD ±1 RON)  ← newly hardened
  - For every fixture: methodology.ebitda.cash      ≈ in-code ebitda_cash        (HARD ±1 RON)  ← newly hardened
  - methodology.ebitda.adjusted is unchanged (not yet computed in YAML;
    sub-ticket [F3.16-3b6-ADJUSTED-LATER]).

Exit 0 if PASSING (all 3 HARD variants within tolerance), 1 otherwise.

Run from container:
    docker exec cfo-ai-backend python3 /app/scripts/check_methodology_parity.py
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Dict, List, Tuple


def _find_repo_root() -> Path:
    here = Path(__file__).resolve().parent
    for c in [here, *here.parents][:6]:
        if (c / "pyproject.toml").is_file():
            return c
    return here.parent


REPO = _find_repo_root()
sys.path.insert(0, str(REPO / "src"))
sys.path.insert(0, str(REPO / "scripts"))


# ── F3.16 ADR DISCIPLINE: thresholds below are LOCKED ────────────────
# Threshold widening is explicitly FORBIDDEN on all three HARD-gated
# variants (`reported`, `strict`, `cash`). The F4.2-PARITY gate's whole
# purpose is to ensure the YAML methodology layer is a faithful
# reproduction of the in-code EBITDA values, not a separate set of
# numbers. Any divergence > 1 RON is a YAML or in-code bug; fix the
# offending side, do not widen the gate.
#
# Per-fixture exceptions are also FORBIDDEN. The discipline mirrors
# F-A3.1's locked thresholds (see docs/ADR-F3.16-closure.md §invariant
# (b)). If a new fixture genuinely needs different methodology
# behavior, ship a per-fixture methodology profile, not a per-fixture
# threshold.
#
# History (preserved for the next contributor who would otherwise
# re-discover this):
#   · Original 3b.6 plan predicted ±0.00 strict + cash post-edit
#     without empirical backing. ADR Lock #8 now forbids that
#     framework-only reasoning.
#   · Empirical pre-deploy probes (2026-05-26) revealed strict
#     16K-3.23M RON divergence (Retail's 7418.81 Rural Invest grant
#     was missed by the narrow 758-only in-code scan) and cash
#     100-1571 % divergence (YAML's 711 double-strip on inventory-
#     heavy fixtures).
#   · Phase 2 decision (2026-05-26): Candidate B for both —
#     strict's in-code scan widened to (74, 75, 77) prefixes;
#     strict's base shifted from operating_ebitda to ebitda_statutory;
#     YAML cash collapses to `reported − capitalized_own_work_memo`.
#     See docs/F3.16-3b6-variant-analysis.md §4-5 for the
#     decomposition and §8 for the operator decision lock.
#   · The `methodology.ebitda.adjusted` variant remains ungated;
#     YAML formula is `strict + ?operator_addbacks` with no
#     addbacks populated today, so it currently equals strict.
#     A follow-up [F3.16-3b6-ADJUSTED-LATER] will gate it when
#     addbacks land.
# ──────────────────────────────────────────────────────────────────────
TOLERANCE_RON = 1.0  # 1 RON acceptable rounding noise on every HARD variant


def _check_fixture(name: str, assembled: dict) -> Tuple[bool, str, Dict[str, float]]:
    """Compare in-code EBITDA fields to methodology.ebitda values.

    Gate behavior (locked 2026-05-26 by F3.16-3b.6-B — Phase 3 ship
    of [F3.16-3b6-FOLLOWUP-VARIANT-PARITY]):
      - reported: HARD ±1 RON
      - strict:   HARD ±1 RON  (post-Phase-2 decision Candidate B)
      - cash:     HARD ±1 RON  (post-Phase-2 decision Candidate B)
    """
    canonical = assembled.get("assembled_canonical_v1") or {}
    methodology = canonical.get("methodology") or {}
    yaml_ebitda = methodology.get("ebitda") or {}

    statements = assembled.get("statements") or {}
    pl = statements.get("assembled_pl") or {}
    incode_ebitda_statutory = float(pl.get("ebitda_statutory") or 0)
    incode_adjusted_ebitda = float(pl.get("adjusted_ebitda") or 0)
    incode_ebitda_cash = float(pl.get("ebitda_cash") or 0)

    if not yaml_ebitda:
        return False, "methodology.ebitda absent", {}

    yaml_reported = float(yaml_ebitda.get("reported") or 0)
    yaml_strict = float(yaml_ebitda.get("strict") or 0)
    yaml_cash = float(yaml_ebitda.get("cash") or 0)

    deltas: Dict[str, float] = {
        "reported_vs_in-code_statutory": yaml_reported - incode_ebitda_statutory,
        "strict_vs_in-code_adjusted": yaml_strict - incode_adjusted_ebitda,
        "cash_vs_in-code_cash": yaml_cash - incode_ebitda_cash,
    }

    # ── HARD checks — reported, strict, cash all locked to ±1 RON ───
    hard_fail = False
    msgs: List[str] = []
    if abs(deltas["reported_vs_in-code_statutory"]) > TOLERANCE_RON:
        hard_fail = True
        msgs.append(
            f"reported gap {deltas['reported_vs_in-code_statutory']:+,.2f} RON "
            f"(yaml {yaml_reported:,.2f} vs in-code statutory {incode_ebitda_statutory:,.2f})"
        )
    if abs(deltas["strict_vs_in-code_adjusted"]) > TOLERANCE_RON:
        hard_fail = True
        msgs.append(
            f"strict gap {deltas['strict_vs_in-code_adjusted']:+,.2f} RON "
            f"(yaml {yaml_strict:,.2f} vs in-code adjusted {incode_adjusted_ebitda:,.2f})"
        )
    if abs(deltas["cash_vs_in-code_cash"]) > TOLERANCE_RON:
        hard_fail = True
        msgs.append(
            f"cash gap {deltas['cash_vs_in-code_cash']:+,.2f} RON "
            f"(yaml {yaml_cash:,.2f} vs in-code cash {incode_ebitda_cash:,.2f})"
        )

    if hard_fail:
        return False, "; ".join(msgs), deltas
    return True, (
        f"OK (reported Δ {deltas['reported_vs_in-code_statutory']:+,.2f}, "
        f"strict Δ {deltas['strict_vs_in-code_adjusted']:+,.2f}, "
        f"cash Δ {deltas['cash_vs_in-code_cash']:+,.2f} RON)"
    ), deltas


def main() -> int:
    from measure_bs_drift import (
        _load_ro_coa, _normalize_for_assembler,
        load_eei, load_scandia, load_sibiu,
        load_frozen, load_realestate,
        load_agras, load_carniprod, load_retail,
    )
    ro_coa = _load_ro_coa()
    fn = ro_coa.assemble_statements

    fixtures: list = []
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
    print(
        f"F4.2-PARITY — methodology YAML EBITDA vs in-code "
        f"(HARD ±{TOLERANCE_RON:.0f} RON on reported + strict + cash)"
    )
    print("=" * 100)
    print(f"  {'fixture':<11s} {'verdict':<7s}  detail")
    print("-" * 100)
    for short, accts, fname in fixtures:
        try:
            result = fn(accts, company_name=fname, currency="RON", period_label="FY2025",
                        industry=None)
            ok, detail, _ = _check_fixture(short, result)
            verdict = "GREEN" if ok else "RED"
            if not ok:
                all_pass = False
            print(f"  {short:<11s} {verdict:<7s}  {detail}")
        except Exception as e:
            print(f"  {short:<11s} RED      exception {type(e).__name__}: {e}")
            all_pass = False
    print()
    print("Overall: " + ("GREEN — F4.2-PARITY passes; YAML methodology matches in-code EBITDA."
                          if all_pass else
                          "RED — F4.2-PARITY fails. Methodology bug; do not deploy."))
    return 0 if all_pass else 1


if __name__ == "__main__":
    sys.exit(main())
