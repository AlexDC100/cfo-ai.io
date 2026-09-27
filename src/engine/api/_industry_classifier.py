"""Industry-classification helper — auto-suggests a CAEN code from
a period's cost structure.

The suggestion is a HINT, not a decision. The UI shows it during
the IndustryConfirmModal flow and the user owns the final choice.
No LLM calls — patterns are stable structural ratios that don't
need probabilistic interpretation.

Conservative on ambiguity: when two rules match, confidence drops
to ``AMBIGUOUS_MATCH_CONFIDENCE`` so the UI emphasizes the dropdown
rather than the suggestion.

Refuses on absent inputs. A rule is evaluated only over MEASURED cost
lines: an absent cost line is not a zero cost line. The previous
``m.get("cogs", 0) or 0`` read a period with no cost keys as a business
with no cost of goods and no payroll, which is exactly the real-estate
signature — measured 2026-09-15, a Scandia-shaped (food manufacturer)
calculated_metrics row set without cost keys was suggested CAEN 6820 at
0.7 and resolved to real_estate_commercial_rental at 0.63.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple


# Every cost line a rule reads, with the name a reader sees in a refusal.
# All rules are evaluated over the same set, so a suggestion is either
# decided over every rule or not made at all: skipping only the rules
# whose inputs are missing would let a "single match" (confidence 0.7)
# stand where an unevaluated rule might also have matched (0.4).
COST_STRUCTURE_INPUTS: Dict[str, str] = {
    "cogs": "cost of goods",
    "opex_personnel": "personnel",
    "depreciation_amortization": "D&A",
    "opex_external_services": "external services",
    "opex_energy": "energy",
    "opex_rent": "rent",
}

SINGLE_MATCH_CONFIDENCE = 0.7
AMBIGUOUS_MATCH_CONFIDENCE = 0.4

COST_STRUCTURE_UNAVAILABLE = "cost_structure_classification_unavailable"


# Each rule: (caen_code, human-readable label, predicate over SHARES of
# NET TURNOVER — ``s[key] = metrics[key] / revenue`` for every key in
# COST_STRUCTURE_INPUTS, all measured). ``revenue`` is cifra de afaceri netă
# (class 70 − 709). Owner ruling 2026-09-26: every margin and share divides
# by turnover, never by total operating revenue, which also carries own work
# capitalised (72x) and other operating income — on EEI 4.91M against a
# turnover of 2.73M, so every share was understated by 44 %.
SUGGESTION_RULES: List[Tuple[str, str, Callable[[Dict[str, float]], bool]]] = [
    # CRE detection — multi-signal. The original rule REQUIRED D&A > 15%
    # of revenue, which fails for Romanian CRE companies that use the
    # revaluation reserve (account 105) for property uplifts. Their
    # historical-cost depreciation through 681 stays modest — EEI sits at
    # ~7% D&A despite being unambiguously real-estate. The fix: keep the
    # zero-COGS pre-filter (real estate has no raw materials), then OR
    # three independent markers so any company hitting any of them
    # qualifies:
    #   A. Historical-cost CRE         (D&A share of revenue)
    #   B. Passive-income operator     (personnel share of revenue)
    #   C. Outsourced property mgmt    (external services share of revenue)
    ("6820", "Real estate / property rental",
     lambda s: (
         s["cogs"] < 0.05
         and (
             s["depreciation_amortization"] > 0.15
             or s["opex_personnel"] < 0.10
             or s["opex_external_services"] > 0.20
         )
     )),

    ("1012", "Poultry meat processing",
     lambda s: (
         0.35 < s["cogs"] < 0.55
         and 0.08 < s["opex_personnel"] < 0.20
         and s["opex_energy"] > 0.03
     )),

    ("1013", "Meat products manufacturing",
     lambda s: (
         s["cogs"] > 0.45
         and s["opex_personnel"] > 0.08
     )),

    ("4711", "Food retail (grocery)",
     lambda s: (
         s["cogs"] > 0.65
         and s["opex_personnel"] < 0.15
         and s["depreciation_amortization"] < 0.05
     )),

    ("6201", "IT services / software development",
     lambda s: (
         s["cogs"] < 0.20
         and s["opex_personnel"] > 0.40
     )),

    ("5610", "Restaurant",
     lambda s: (
         0.25 < s["cogs"] < 0.40
         and s["opex_personnel"] > 0.25
         and s["opex_rent"] > 0.05
     )),

    ("4120", "Construction (buildings)",
     lambda s: (
         s["cogs"] > 0.55
         and s["opex_external_services"] > 0.05
     )),
]


@dataclass(frozen=True)
class CostStructureClassification:
    """Result of classifying a period's cost structure.

    Exactly one of ``caen`` / ``refusal`` explains the outcome: a CAEN when
    a rule matched; a refusal when the inputs could not be read; both None
    when every rule was evaluated and none matched.
    """
    caen: Optional[str]
    label: Optional[str]
    confidence: float
    refusal: Optional[Dict[str, Any]] = None


def _measured(value: Any) -> Optional[float]:
    if value is None or isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value):
        return None
    return float(value)


def _join(names: List[str]) -> str:
    if len(names) <= 1:
        return "".join(names)
    return ", ".join(names[:-1]) + " and " + names[-1]


def _refuse(inputs: List[str], why: str) -> CostStructureClassification:
    return CostStructureClassification(
        caen=None, label=None, confidence=0.0,
        refusal={
            "code": COST_STRUCTURE_UNAVAILABLE,
            "component": "cost_structure",
            "inputs": inputs,
            "text": f"Cost-structure classification unavailable: {why}.",
        },
    )


def classify_cost_structure(metrics: Dict[str, Any]) -> CostStructureClassification:
    """Evaluate every rule over measured cost shares of NET TURNOVER, or
    refuse with the reason. ``total_operating_revenue`` is never the
    denominator (owner ruling 2026-09-26), not even as a fallback: a period
    whose metrics carry no turnover refuses."""
    revenue = _measured(metrics.get("revenue"))
    if revenue is None:
        return _refuse(["revenue"],
                       "net turnover (cifra de afaceri) is not in this period's metrics")
    if revenue <= 0:
        return _refuse(["revenue"], "net turnover (cifra de afaceri) is not positive")

    missing = [k for k in COST_STRUCTURE_INPUTS if _measured(metrics.get(k)) is None]
    if missing:
        names = [COST_STRUCTURE_INPUTS[k] for k in missing]
        verb = "is" if len(missing) == 1 else "are"
        return _refuse(missing, f"{_join(names)} {verb} not in this period's metrics")

    shares = {k: float(metrics[k]) / revenue for k in COST_STRUCTURE_INPUTS}
    matches = [(caen, label) for caen, label, rule in SUGGESTION_RULES if rule(shares)]
    if not matches:
        return CostStructureClassification(caen=None, label=None, confidence=0.0)

    # Single match → moderate confidence. Multiple → ambiguous. We return
    # the first match either way; the UI surfaces the confidence so an
    # ambiguous result reads as "we're guessing — pick from the dropdown".
    caen, label = matches[0]
    confidence = SINGLE_MATCH_CONFIDENCE if len(matches) == 1 else AMBIGUOUS_MATCH_CONFIDENCE
    return CostStructureClassification(caen=caen, label=label, confidence=confidence)


def suggest_caen_code(metrics: Dict[str, float]) -> Tuple[Optional[str], Optional[str], float]:
    """Return (caen_code, human-readable label, confidence_0_to_1).

    Returns (None, None, 0.0) when no rule fires OR when the classification
    refuses (revenue or a cost line not measured). Callers that must say
    WHY read ``classify_cost_structure`` instead.
    """
    result = classify_cost_structure(metrics)
    return result.caen, result.label, result.confidence


def cost_structure_metrics(
    metric_rows: Iterable[Dict[str, Any]],
    line_items: Iterable[Dict[str, Any]],
) -> Dict[str, float]:
    """Flatten a period's calculated_metrics rows and PL line items into the
    dict the classifier reads.

    calculated_metrics carries revenue and totals but no cost lines (the
    persist-time writer, credit_model.compute_period_metrics, emits no
    cogs / opex_* / D&A names), so the cost lines come from the PL line
    items: bucket sums for COGS and D&A, account-prefix sums for the opex
    breakdown. This is the ONE flattening both readers use —
    ``_industry_detection.detect_industry_for_period`` and
    ``_benchmarks._load_period_signals`` (which kept its own copy until
    2026-09-19 and pre-filled the cost lines with 0). A period WITHOUT PL
    line items leaves the cost lines ABSENT, so the classifier refuses; with
    line items present, a bucket with no rows is a true empty sum.
    """
    from ._benchmark_engine import (
        OPEX_ENERGY_PREFIXES,
        OPEX_EXTERNAL_SERVICES_PREFIXES,
        OPEX_PERSONNEL_PREFIXES,
        OPEX_RENT_PREFIXES,
        _sum_line_items_by_prefix,
    )

    flat: Dict[str, float] = {}
    for r in metric_rows:
        name = r.get("name")
        val = r.get("value")
        if name and val is not None:
            try:
                flat[name] = float(val)
            except (TypeError, ValueError):
                pass

    pl_items = [li for li in line_items if li.get("statement") == "PL"]
    if not pl_items:
        return flat

    bucket_sums: Dict[str, float] = {}
    for li in pl_items:
        b = (li.get("bucket") or "").strip()
        amount = _measured(li.get("amount"))
        if amount is None:
            continue
        bucket_sums[b] = bucket_sums.get(b, 0.0) + amount
    # The denominator is net turnover (the served `revenue` metric); from
    # the line items only when no metric row carries it — the revenue
    # bucket alone, never plus 72x / other operating income (owner ruling
    # 2026-09-26).
    if "revenue" in bucket_sums and "revenue" not in flat:
        flat["revenue"] = bucket_sums["revenue"]
    # PL line items present: a bucket with no rows sums to a true zero.
    flat.setdefault("cogs", bucket_sums.get("cogs", 0.0))
    flat.setdefault("depreciation_amortization", bucket_sums.get("depreciation", 0.0))
    flat["opex_personnel"] = _sum_line_items_by_prefix(pl_items, OPEX_PERSONNEL_PREFIXES)
    flat["opex_energy"] = _sum_line_items_by_prefix(pl_items, OPEX_ENERGY_PREFIXES)
    flat["opex_rent"] = _sum_line_items_by_prefix(pl_items, OPEX_RENT_PREFIXES)
    flat["opex_external_services"] = _sum_line_items_by_prefix(
        pl_items, OPEX_EXTERNAL_SERVICES_PREFIXES)
    return flat


# ─── Self-test ──────────────────────────────────────────────────────────────
# Run with: python -m engine.api._industry_classifier
#
# Anchored on two real customer files: EEI (CRE, revaluation-heavy, low
# historical D&A) and Scandia (food / meat manufacturer). The CRE rule
# regression fix is verified by EEI hitting 6820 on Marker B + Marker C
# even though D&A is only ~7% of revenue. The pytest home of these checks
# is tests/engine/test_industry_classifier_absent_inputs.py.

if __name__ == "__main__":
    eei = {
        # EEI Imobiliara — actual extracted Dec 2025 metrics
        # net turnover (706); total operating revenue with 722 was 4,911,000
        "revenue": 2_727_104,
        "cogs": 0,
        "opex_personnel": 125_808,
        "opex_external_services": 2_172_788,
        "depreciation_amortization": 355_606,
        "opex_energy": 0,
        "opex_rent": 0,
    }
    scandia = {
        # Scandia Food SRL — FY2025 reference values
        "revenue": 413_727_560,
        "cogs": 166_897_303,   # 601 + 602
        "opex_personnel": 78_674_529,
        "opex_external_services": 30_000_000,
        "opex_energy": 13_542_383,
        "depreciation_amortization": 13_649_645,
        "opex_rent": 0,
    }

    caen, label, conf = suggest_caen_code(eei)
    assert caen == "6820", f"EEI should be 6820, got {caen}"
    print(f"✓ EEI     → {caen} ({label}) confidence {conf}")

    caen, label, conf = suggest_caen_code(scandia)
    assert caen in ("1012", "1013"), f"Scandia should be 1012 or 1013, got {caen}"
    print(f"✓ Scandia → {caen} ({label}) confidence {conf}")

    r = classify_cost_structure({"revenue": 413_727_560})
    assert r.caen is None and r.refusal is not None, r
    print(f"✓ No cost lines → refused: {r.refusal['text']}")

    print("\nAll classifier self-tests passed.")
