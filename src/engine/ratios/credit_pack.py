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
