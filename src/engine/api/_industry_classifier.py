"""Industry-classification helper — auto-suggests a CAEN code from
a period's cost structure.

The suggestion is a HINT, not a decision. The UI shows it during
the IndustryConfirmModal flow and the user owns the final choice.
No LLM calls — patterns are stable structural ratios that don't
need probabilistic interpretation.

Conservative on ambiguity: when two rules match, confidence drops
to 0.4 so the UI emphasizes the dropdown rather than the suggestion.
"""

from __future__ import annotations

from typing import Callable, Dict, List, Optional, Tuple


def _pct(num: float, den: float) -> float:
    if den is None or den <= 0:
        return 0.0
    return num / den


# Each rule: (caen_code, human-readable label, predicate over canonical metrics).
# The predicate reads from a flat dict keyed by `calculated_metrics.name` —
# same names both the TB pipeline and statutory pipeline write.
SUGGESTION_RULES: List[Tuple[str, str, Callable[[Dict[str, float]], bool]]] = [
    # CRE detection — multi-signal. The original rule REQUIRED D&A > 15%
    # of revenue, which fails for Romanian CRE companies that use the
    # revaluation reserve (account 105) for property uplifts. Their
    # historical-cost depreciation through 681 stays modest — EEI sits at
    # ~7% D&A despite being unambiguously real-estate. The fix: keep the
    # zero-COGS pre-filter (real estate has no raw materials), then OR
    # three independent markers so any company hitting any of them
    # qualifies:
    #   A. Historical-cost CRE         (D&A > 15% of revenue)
    #   B. Passive-income operator     (personnel < 10% of revenue)
    #   C. Outsourced property mgmt    (external services > 20% of revenue)
    ("6820", "Real estate / property rental",
     lambda m: (
         _pct(m.get("cogs", 0) or 0, m.get("total_operating_revenue", 1) or m.get("revenue", 1)) < 0.05
         and (
             _pct(m.get("depreciation_amortization", 0) or 0, m.get("total_operating_revenue", 1) or m.get("revenue", 1)) > 0.15
             or _pct(m.get("opex_personnel", 0) or 0, m.get("total_operating_revenue", 1) or m.get("revenue", 1)) < 0.10
             or _pct(m.get("opex_external_services", 0) or 0, m.get("total_operating_revenue", 1) or m.get("revenue", 1)) > 0.20
         )
     )),

    ("1012", "Poultry meat processing",
     lambda m: (
         0.35 < _pct(m.get("cogs", 0) or 0, m.get("total_operating_revenue", 1) or m.get("revenue", 1)) < 0.55
         and 0.08 < _pct(m.get("opex_personnel", 0) or 0, m.get("total_operating_revenue", 1) or m.get("revenue", 1)) < 0.20
         and _pct(m.get("opex_energy", 0) or 0, m.get("total_operating_revenue", 1) or m.get("revenue", 1)) > 0.03
     )),

    ("1013", "Meat products manufacturing",
     lambda m: (
         _pct(m.get("cogs", 0) or 0, m.get("total_operating_revenue", 1) or m.get("revenue", 1)) > 0.45
         and _pct(m.get("opex_personnel", 0) or 0, m.get("total_operating_revenue", 1) or m.get("revenue", 1)) > 0.08
     )),

    ("4711", "Food retail (grocery)",
     lambda m: (
         _pct(m.get("cogs", 0) or 0, m.get("total_operating_revenue", 1) or m.get("revenue", 1)) > 0.65
         and _pct(m.get("opex_personnel", 0) or 0, m.get("total_operating_revenue", 1) or m.get("revenue", 1)) < 0.15
         and _pct(m.get("depreciation_amortization", 0) or 0, m.get("total_operating_revenue", 1) or m.get("revenue", 1)) < 0.05
     )),

    ("6201", "IT services / software development",
     lambda m: (
         _pct(m.get("cogs", 0) or 0, m.get("total_operating_revenue", 1) or m.get("revenue", 1)) < 0.20
         and _pct(m.get("opex_personnel", 0) or 0, m.get("total_operating_revenue", 1) or m.get("revenue", 1)) > 0.40
     )),

    ("5610", "Restaurant",
     lambda m: (
         0.25 < _pct(m.get("cogs", 0) or 0, m.get("total_operating_revenue", 1) or m.get("revenue", 1)) < 0.40
         and _pct(m.get("opex_personnel", 0) or 0, m.get("total_operating_revenue", 1) or m.get("revenue", 1)) > 0.25
         and _pct(m.get("opex_rent", 0) or 0, m.get("total_operating_revenue", 1) or m.get("revenue", 1)) > 0.05
     )),

    ("4120", "Construction (buildings)",
     lambda m: (
         _pct(m.get("cogs", 0) or 0, m.get("total_operating_revenue", 1) or m.get("revenue", 1)) > 0.55
         and _pct(m.get("opex_external_services", 0) or 0, m.get("total_operating_revenue", 1) or m.get("revenue", 1)) > 0.05
     )),
]


def suggest_caen_code(metrics: Dict[str, float]) -> Tuple[Optional[str], Optional[str], float]:
    """Return (caen_code, human-readable label, confidence_0_to_1).
    Returns (None, None, 0.0) when no rule fires or revenue is missing."""
    revenue = (metrics.get("total_operating_revenue") or 0) or (metrics.get("revenue") or 0)
    if revenue <= 0:
        return None, None, 0.0

    matches: List[Tuple[str, str]] = []
    for caen, label, condition in SUGGESTION_RULES:
        try:
            if condition(metrics):
                matches.append((caen, label))
        except (TypeError, ZeroDivisionError, KeyError):
            continue

    if not matches:
        return None, None, 0.0

    # Single match → moderate confidence (0.7). Multiple → ambiguous (0.4).
    # We return the first match either way; the UI surfaces the confidence
    # so a 0.4 result reads as "we're guessing — pick from the dropdown".
    caen, label = matches[0]
    confidence = 0.7 if len(matches) == 1 else 0.4
    return caen, label, confidence


# ─── Self-test ──────────────────────────────────────────────────────────────
# Run with: python -m engine.api._industry_classifier
#
# Anchored on two real customer files: EEI (CRE, revaluation-heavy, low
# historical D&A) and Scandia (food / meat manufacturer). The CRE rule
# regression fix is verified by EEI hitting 6820 on Marker B + Marker C
# even though D&A is only ~7% of revenue.

if __name__ == "__main__":
    eei = {
        # EEI Imobiliara — actual extracted Dec 2025 metrics
        "total_operating_revenue": 4_911_000,
        "cogs": 0,
        "opex_personnel": 125_808,
        "opex_external_services": 2_172_788,
        "depreciation_amortization": 355_606,
    }
    scandia = {
        # Scandia Food SRL — FY2025 reference values
        "total_operating_revenue": 413_727_560,
        "cogs": 166_897_303,   # 601 + 602
        "opex_personnel": 78_674_529,
        "opex_external_services": 30_000_000,
        "opex_energy": 13_542_383,
        "depreciation_amortization": 13_649_645,
    }

    caen, label, conf = suggest_caen_code(eei)
    assert caen == "6820", f"EEI should be 6820, got {caen}"
    print(f"✓ EEI     → {caen} ({label}) confidence {conf}")

    caen, label, conf = suggest_caen_code(scandia)
    assert caen in ("1012", "1013"), f"Scandia should be 1012 or 1013, got {caen}"
    print(f"✓ Scandia → {caen} ({label}) confidence {conf}")

    # Edge case: empty metrics returns (None, None, 0.0)
    caen, label, conf = suggest_caen_code({})
    assert caen is None, f"Empty metrics should return None, got {caen}"
    print(f"✓ Empty   → None confidence {conf}")

    print("\nAll classifier self-tests passed.")
