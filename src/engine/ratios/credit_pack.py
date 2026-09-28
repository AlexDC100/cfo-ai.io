"""Loads `packs/credit/model.yaml` — the credit model's pack data.

The ONE module that opens the credit pack, so `engine.ratios.credit_model`
stays pure (no file, no client, no clock): it imports the declarations from
here. Pure data in, a frozen dict out; a malformed or missing pack RAISES at
first use rather than degrading to a built-in default, because a threshold
with no stated source is exactly what the pack exists to prevent (TC-10).

Revision 2 of the credit model reads four blocks:
  · `altman_x4.liabilities_materiality` (R-D4): the share of total assets
    total liabilities must reach for X4 to be defined;
  · `declared_rungs` (R-D1, R-D2, R-D3): the scores the model STATES for a
    state its formula cannot express, each with its label and source;
  · `profitability.roe_undefined` (R-D2): the disclosed net-margin-only
    variant used when book equity is not positive;
  · `ranges` (R-RANGE): the bounds every served score is checked against,
    the X4 bound derived from the materiality share.

Revision 5 (owner ruling R1, 2026-09-28) adds `stock_build_regime`: the
trigger shares, the regime's weight table, the cash basis, the X3 label, the
cash refusals and rungs, and the finding (`_stock_build_regime`).
"""

from __future__ import annotations

import functools
import os
from decimal import Decimal
from pathlib import Path
from typing import Any, Dict

import yaml

#: packs/credit — resolved from this file so a source checkout and the
#: backend image (/app/packs, the Dockerfile COPYs packs/) agree.
#: ``CREDIT_PACKS_DIR`` overrides for tests that plant a threshold.
DEFAULT_CREDIT_PACKS_DIR = Path(__file__).resolve().parents[3] / "packs" / "credit"
CREDIT_PACK_NAME = "model.yaml"
CREDIT_PACK_FILE = "packs/credit/%s" % CREDIT_PACK_NAME

#: The declared rungs revision 2 reads: (component, rung name, expected sign).
DECLARED_RUNG_KEYS = (
    ("coverage", "no_interest_bearing_debt"),
    ("dscr", "no_interest_bearing_debt"),
    ("leverage", "ebitda_not_positive"),
    ("equity", "equity_ratio_not_positive"),
)


class CreditPackError(RuntimeError):
    """packs/credit/model.yaml is unusable. Raised, never defaulted."""


def credit_pack_path() -> Path:
    override = os.environ.get("CREDIT_PACKS_DIR")
    return (Path(override) if override else DEFAULT_CREDIT_PACKS_DIR) / CREDIT_PACK_NAME


def _text(block: Dict[str, Any], key: str, where: str) -> str:
    v = block.get(key)
    if not isinstance(v, str) or not v.strip():
        raise CreditPackError("%s.%s: a non-empty string is required" % (where, key))
    return v.strip()


def _bounded_score(block: Dict[str, Any], key: str, where: str) -> Any:
    """A rung score in [0, 100], in the YAML's own number type: an integer
    rung stays an integer, so the row the model emits for it is byte-equal
    to the revision-1 row (95, not 95.0)."""
    v = block.get(key)
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not (0 <= float(v) <= 100):
        raise CreditPackError("%s.%s: a score in [0, 100] is required, got %r" % (where, key, v))
    return v


@functools.lru_cache(maxsize=8)
def _load(path: str) -> Dict[str, Any]:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            raw = yaml.safe_load(fh)
    except OSError as exc:
        raise CreditPackError("credit pack %s cannot be read: %s" % (path, exc))
    if not isinstance(raw, dict):
        raise CreditPackError("%s: not a mapping" % path)

    # ── materiality (R-D4) ────────────────────────────────────────────────
    where = "%s altman_x4.liabilities_materiality" % path
    try:
        block = raw["altman_x4"]["liabilities_materiality"]
        share = Decimal(str(block["share"]))
        basis = str(block["basis"])
        source = str(block["source"]).strip()
    except (TypeError, KeyError, ArithmeticError) as exc:
        raise CreditPackError("%s: malformed (%r)" % (where, exc))
    if not (Decimal("0") < share < Decimal("1")) or basis != "total_assets" or not source:
        raise CreditPackError("%s: share must be in (0, 1) of total_assets with a source" % where)
    materiality = {"share": share, "basis": basis, "source": source, "file": CREDIT_PACK_FILE}

    # ── declared rungs (R-D1, R-D2, R-D3) — required: a pack that carries
    #    only the materiality is malformed, never "the rungs default" ──
    rungs: Dict[str, Dict[str, Any]] = {}
    raw_rungs = raw.get("declared_rungs")
    if not isinstance(raw_rungs, dict):
        raise CreditPackError("%s declared_rungs: a mapping is required" % path)
    for component, name in DECLARED_RUNG_KEYS:
        where = "%s declared_rungs.%s.%s" % (path, component, name)
        block = (raw_rungs.get(component) or {}).get(name)
        if not isinstance(block, dict):
            raise CreditPackError("%s: missing" % where)
        rungs[component] = {
            "rung": name,
            "score": _bounded_score(block, "score", where),
            "when": _text(block, "when", where),
            "label": _text(block, "label", where),
            "source": _text(block, "source", where),
            "file": CREDIT_PACK_FILE,
        }

    # ── profitability with ROE undefined (R-D2) ───────────────────────────
    raw_prof = (raw.get("profitability") or {}).get("roe_undefined") if isinstance(raw.get("profitability"), dict) else None
    where = "%s profitability.roe_undefined" % path
    if not isinstance(raw_prof, dict):
        raise CreditPackError("%s: a mapping is required" % where)
    prof = {"formula": _text(raw_prof, "formula", where), "label": _text(raw_prof, "label", where),
            "source": _text(raw_prof, "source", where), "file": CREDIT_PACK_FILE}

    # ── ranges (R-RANGE) ──────────────────────────────────────────────────
    ranges: Dict[str, Dict[str, Any]] = {}
    raw_ranges = raw.get("ranges")
    if not isinstance(raw_ranges, dict):
        raise CreditPackError("%s ranges: a mapping is required" % path)
    for key in ("subscore", "composite"):
        where = "%s ranges.%s" % (path, key)
        block = raw_ranges.get(key)
        if not isinstance(block, dict):
            raise CreditPackError("%s: missing" % where)
        lo, hi = block.get("min"), block.get("max")
        if not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in (lo, hi)) or lo >= hi:
            raise CreditPackError("%s: min < max required" % where)
        ranges[key] = {"min": float(lo), "max": float(hi), "source": _text(block, "source", where),
                       "file": CREDIT_PACK_FILE}
    where = "%s ranges.altman_x1" % path
    block = raw_ranges.get("altman_x1")
    if not isinstance(block, dict) or not isinstance(block.get("max"), (int, float)):
        raise CreditPackError("%s: max required" % where)
    ranges["altman_x1"] = {"max": float(block["max"]), "source": _text(block, "source", where),
                           "file": CREDIT_PACK_FILE}
    where = "%s ranges.altman_x4" % path
    block = raw_ranges.get("altman_x4")
    if not isinstance(block, dict):
        raise CreditPackError("%s: missing" % where)
    ranges["altman_x4"] = {
        # DERIVED from the materiality share, never a second literal.
        "max": float(Decimal(1) / share), "max_is": _text(block, "max_is", where),
        "source": _text(block, "source", where), "file": CREDIT_PACK_FILE}
    where = "%s ranges.altman_z" % path
    block = raw_ranges.get("altman_z")
    if not isinstance(block, dict):
        raise CreditPackError("%s: missing" % where)
    ranges["altman_z"] = {"bound_is": _text(block, "bound_is", where),
                          "source": _text(block, "source", where), "file": CREDIT_PACK_FILE}

    return {
        # materiality, flat, as revision 2's first cut read it
        "share": share, "basis": basis, "source": source, "file": CREDIT_PACK_FILE,
        "materiality": materiality,
        "declared_rungs": rungs,
        "profitability_roe_undefined": prof,
        "ranges": ranges,
        "stock_build_regime": _stock_build_regime(raw.get("stock_build_regime"), path),
    }


#: The seven components a regime's weight table must name — the model's own
#: keys, in its order (a table naming fewer is a renormalisation in
#: disguise, which R-COMPOSITE forbids).
REGIME_WEIGHT_KEYS = ("altman", "profitability", "leverage", "coverage", "dscr", "liquidity", "equity")

#: The trigger's two shares, by name, with the basis each is read against.
STOCK_BUILD_TRIGGERS = (("net_711_to_turnover", "net_turnover"),
                        ("net_711_to_operating_expense", "total_operating_expense"))

#: The regime's two refusal codes, in the order the model tests them.
STOCK_BUILD_REFUSAL_CODES = ("cash_from_operations_approximated", "cash_from_operations_refused")

#: The components the regime computes on cash (every other one keeps its
#: revision-4 expression; Altman keeps its own with X3 stripped).
STOCK_BUILD_CASH_COMPONENTS = ("leverage", "coverage", "dscr")

#: The served figures the finding carries, in its order.
STOCK_BUILD_FINDING_FIGURES = ("net_711", "net_turnover", "ebitda", "ebitda_before_stock_variation",
                               "cash_from_operations")

_SEVERITIES = ("critical", "high", "medium", "low", "info")


def _bilingual(block: Any, where: str) -> Dict[str, str]:
    if not isinstance(block, dict):
        raise CreditPackError("%s: a {ro, en} mapping is required" % where)
    return {"ro": _text(block, "ro", where), "en": _text(block, "en", where)}


def _share(v: Any, where: str) -> Decimal:
    try:
        d = Decimal(str(v))
    except (TypeError, ArithmeticError):
        raise CreditPackError("%s: a decimal share is required, got %r" % (where, v))
    if not d.is_finite() or d <= 0:
        raise CreditPackError("%s: a positive share is required, got %r" % (where, v))
    return d


def _stock_build_regime(raw: Any, path: str) -> Dict[str, Any]:
    """The stock-build regime (owner ruling R1, 2026-09-28): its trigger
    shares, its weight table, its cash basis, its X3 label, its refusal and
    rung wording and its finding — every one REQUIRED (a pack without the
    block is malformed; the regime never falls back to a built-in)."""
    where = "%s stock_build_regime" % path
    if not isinstance(raw, dict):
        raise CreditPackError("%s: a mapping is required" % where)
    code = _text(raw, "code", where)
    trig_raw = raw.get("trigger")
    if not isinstance(trig_raw, dict):
        raise CreditPackError("%s.trigger: a mapping is required" % where)
    trigger: Dict[str, Any] = {}
    for name, basis in STOCK_BUILD_TRIGGERS:
        w = "%s.trigger.%s" % (where, name)
        block = trig_raw.get(name)
        if not isinstance(block, dict):
            raise CreditPackError("%s: missing" % w)
        if block.get("basis") != basis:
            raise CreditPackError("%s.basis: %r is required" % (w, basis))
        trigger[name] = {"at_least": _share(block.get("at_least"), w + ".at_least"),
                         "basis": basis, "label": _bilingual(block.get("label"), w + ".label")}
    trigger_source = _text(trig_raw, "source", where + ".trigger")

    w_raw = raw.get("weights")
    if not isinstance(w_raw, dict) or set(w_raw) != set(REGIME_WEIGHT_KEYS):
        raise CreditPackError("%s.weights: exactly the seven components %s are required"
                              % (where, ", ".join(REGIME_WEIGHT_KEYS)))
    weights: Dict[str, float] = {}
    for k in REGIME_WEIGHT_KEYS:
        v = w_raw[k]
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not (0 <= float(v) <= 1):
            raise CreditPackError("%s.weights.%s: a weight in [0, 1] is required, got %r" % (where, k, v))
        weights[k] = float(v)
    if abs(sum(Decimal(repr(v)) for v in weights.values()) - Decimal(1)) > Decimal("1e-9"):
        raise CreditPackError("%s.weights: the seven weights must sum to 1 (never renormalised)" % where)

    cash_raw = raw.get("cash_basis")
    if not isinstance(cash_raw, dict) or cash_raw.get("figure") != "assembled_cf.cash_from_operating":
        raise CreditPackError("%s.cash_basis.figure: assembled_cf.cash_from_operating is required" % where)
    x3_raw = raw.get("altman_x3")
    if not isinstance(x3_raw, dict):
        raise CreditPackError("%s.altman_x3: a mapping is required" % where)

    names_raw = raw.get("component_names")
    if not isinstance(names_raw, dict):
        raise CreditPackError("%s.component_names: a mapping is required" % where)
    component_names = {k: _bilingual(names_raw.get(k), "%s.component_names.%s" % (where, k))
                       for k in STOCK_BUILD_CASH_COMPONENTS}
    bases_raw = raw.get("component_bases")
    if not isinstance(bases_raw, dict):
        raise CreditPackError("%s.component_bases: a mapping is required" % where)
    component_bases = {k: _bilingual(bases_raw.get(k), "%s.component_bases.%s" % (where, k))
                       for k in STOCK_BUILD_CASH_COMPONENTS}
    ref_raw = raw.get("refusals")
    if not isinstance(ref_raw, dict):
        raise CreditPackError("%s.refusals: a mapping is required" % where)
    refusals = {c: _bilingual(ref_raw.get(c), "%s.refusals.%s" % (where, c)) for c in STOCK_BUILD_REFUSAL_CODES}
    for c, text in refusals.items():
        for lang in ("ro", "en"):
            if "{component}" not in text[lang]:
                raise CreditPackError("%s.refusals.%s.%s: the sentence must name {component}" % (where, c, lang))

    status_raw = raw.get("cash_status")
    if not isinstance(status_raw, dict):
        raise CreditPackError("%s.cash_status: a mapping is required" % where)
    cash_status = {c: _bilingual(status_raw.get(c), "%s.cash_status.%s" % (where, c))
                   for c in STOCK_BUILD_REFUSAL_CODES}

    rung_raw = raw.get("declared_rungs")
    if not isinstance(rung_raw, dict):
        raise CreditPackError("%s.declared_rungs: a mapping is required" % where)
    w = "%s.declared_rungs.cash_from_operations_not_positive" % where
    b = rung_raw.get("cash_from_operations_not_positive")
    if not isinstance(b, dict):
        raise CreditPackError("%s: missing" % w)
    cfo_rung = {"rung": "cash_from_operations_not_positive", "score": _bounded_score(b, "score", w),
                "when": _text(b, "when", w), "label": _text(b, "label", w),
                "source": _text(b, "source", w), "file": CREDIT_PACK_FILE}
    w = "%s.declared_rungs.no_interest_bearing_debt" % where
    b = rung_raw.get("no_interest_bearing_debt")
    if not isinstance(b, dict):
        raise CreditPackError("%s: missing" % w)
    no_debt = {}
    for comp in ("coverage", "dscr"):
        no_debt[comp] = {"rung": "no_interest_bearing_debt",
                         "score": _bounded_score(b, "%s_score" % comp, w),
                         "when": _text(b, "when", w), "label": _text(b, "label", w),
                         "source": _text(b, "source", w), "file": CREDIT_PACK_FILE}

    f_raw = raw.get("finding")
    w = "%s.finding" % where
    if not isinstance(f_raw, dict):
        raise CreditPackError("%s: a mapping is required" % w)
    severity = _text(f_raw, "severity", w)
    if severity not in _SEVERITIES:
        raise CreditPackError("%s.severity: one of %s is required" % (w, ", ".join(_SEVERITIES)))
    fig_raw = f_raw.get("figures")
    if not isinstance(fig_raw, dict) or list(fig_raw) != list(STOCK_BUILD_FINDING_FIGURES):
        raise CreditPackError("%s.figures: exactly %s, in that order, are required"
                              % (w, ", ".join(STOCK_BUILD_FINDING_FIGURES)))
    finding = {"code": _text(f_raw, "code", w), "severity": severity,
               "text": _bilingual(f_raw.get("text"), w + ".text"),
               "figure_labels": dict((k, _bilingual(fig_raw[k], "%s.figures.%s" % (w, k)))
                                     for k in STOCK_BUILD_FINDING_FIGURES),
               "source": _text(f_raw, "source", w), "file": CREDIT_PACK_FILE}

    return {
        "code": code,
        "label": _bilingual(raw.get("label"), where + ".label"),
        "trigger": trigger,
        "trigger_source": trigger_source,
        "weights": weights,
        "weights_why": _bilingual(raw.get("weights_why"), where + ".weights_why"),
        "cash_basis": {"figure": cash_raw["figure"],
                       "label": _bilingual(cash_raw.get("label"), where + ".cash_basis.label")},
        "altman_x3_label": _bilingual(x3_raw.get("label"), where + ".altman_x3.label"),
        "component_names": component_names,
        "component_bases": component_bases,
        "refusals": refusals,
        "cash_status": cash_status,
        "rung_cfo_not_positive": cfo_rung,
        "rung_no_interest_bearing_debt": no_debt,
        "finding": finding,
        "file": CREDIT_PACK_FILE,
    }


def credit_pack() -> Dict[str, Any]:
    """The credit pack's declarations: `{share, basis, source, file}` (the
    Altman X4 materiality, flat) plus `materiality`, `declared_rungs`,
    `profitability_roe_undefined` and `ranges`."""
    return _load(str(credit_pack_path()))


def x4_materiality_share() -> Decimal:
    return credit_pack()["share"]


def share_percent(share: Decimal) -> str:
    """0.01 -> "1%", 0.000001 -> "0.0001%": the pack's share, as written."""
    pct = (share * 100).normalize()
    return "%s%%" % format(pct, "f")
