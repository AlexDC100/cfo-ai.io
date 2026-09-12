"""Real served-shape envelopes for the comparatives gates, built from the
committed corpus through the offline reference path.

WHY NOT THE REGRESSION BASELINES. `regression_baselines/*.json` were
captured before the assembler emitted `other_operating_income` — the
term its EBITDA is built from — so a bridge that walks the assembler's
own identity cannot be verified against them. The corpus books are run
through `RomaniaPack.run_deterministic_tb` HERE, at test time, so every
envelope carries exactly what today's assembler emits, and a field the
assembler stops emitting reds the gate instead of being silently absent
from a stale fixture.

The pair is chosen by MEASUREMENT, not by name: the first corpus book the
pack classifies ANALYTIC and the first it classifies SYNTHETIC. If the
corpus ever loses one kind, the gates that need the pair skip with the
reason rather than pass over one book compared with itself.
"""
from __future__ import annotations

import copy
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from engine.country_packs.ro_romania.detail_level import (
    ANALYTIC,
    SYNTHETIC,
    SYNTHETIC_MAX_DIGITS,
    classify_detail_level,
)
from engine.country_packs.ro_romania.pack import RomaniaPack

REPO = Path(__file__).resolve().parents[2]
CORPUS = REPO / "corpus"

#: Real, anonymised, deterministic-lane xlsx books. Order is the pick order.
CANDIDATES = (
    "saga_10_col_carniprod",
    "saga_10_col",
    "saga_10_col_agras",
    "saga_10_col_retail",
    "saga_10_col_realestate",
    "saga_compact_6_col",
    "exact_zero",
    "rounding_004pct",
)

_CACHE: Dict[str, Dict[str, Any]] = {}


def envelope_for(case_id: str) -> Dict[str, Any]:
    """`{"statements": …, "lineItems": …}` for one corpus case, through the
    offline path — the same assembler the served path runs."""
    if case_id not in _CACHE:
        path = CORPUS / case_id / "input.xlsx"
        data = path.read_bytes()
        assembled = RomaniaPack().run_deterministic_tb(data, filename=path.name)[2]
        statements = dict(assembled["statements"])
        cv1 = assembled.get("assembled_canonical_v1") or {}
        statements["assembled_canonical_v1"] = cv1
        if isinstance(cv1, dict) and cv1.get("canonical_bs"):
            statements["canonical_bs"] = cv1["canonical_bs"]
        _CACHE[case_id] = {"statements": statements, "lineItems": list(assembled["lineItems"])}
    return copy.deepcopy(_CACHE[case_id])


def level_of(env: Dict[str, Any]) -> str:
    return classify_detail_level([li.get("ro_account_code") for li in env["lineItems"]]).level


def pick_pair() -> Tuple[Optional[Tuple[str, Dict[str, Any]]], Optional[Tuple[str, Dict[str, Any]]]]:
    """(analytic, synthetic) — each `(case_id, envelope)` or None."""
    analytic = synthetic = None
    for cid in CANDIDATES:
        if not (CORPUS / cid / "input.xlsx").is_file():
            continue
        env = envelope_for(cid)
        lvl = level_of(env)
        if analytic is None and lvl == ANALYTIC:
            analytic = (cid, env)
        elif synthetic is None and lvl == SYNTHETIC:
            synthetic = (cid, env)
        if analytic and synthetic:
            break
    return analytic, synthetic


def condense(envelope: Dict[str, Any], revenue_factor: float = 0.97) -> Dict[str, Any]:
    """The external condensed book derived from an analytic one: codes
    rolled to the synthetic boundary, the doubtful-receivable row folded
    into trade receivables, and — because a real prior is a different
    YEAR — net turnover moved with the P&L chain re-derived through the
    assembler's own identities so they still hold."""
    out = copy.deepcopy(envelope)
    for li in out["lineItems"]:
        code = str(li.get("ro_account_code") or "")
        if code.isdigit():
            li["ro_account_code"] = code[:SYNTHETIC_MAX_DIGITS]
        if (li.get("canonical_bucket") or li.get("bucket")) == "ar_doubtful":
            li["canonical_bucket"] = "ar"
            li["bucket"] = "ar"
    out["statements"]["assembled_bs"]["ar_doubtful_gross"] = 0.0
    pl = out["statements"]["assembled_pl"]
    pl["revenue"] = round(pl["revenue"] * revenue_factor, 2)
    pl["ebitda"] = round(pl["revenue"] + pl["other_operating_income"]
                         - pl["cogs"] - pl["opex_total"], 2)
    pl["ebit"] = round(pl["ebitda"] - pl["depreciation"], 2)
    pl["pretax"] = round(pl["ebit"] + pl["net_financial_result"], 2)
    pl["net_income_operational"] = round(pl["pretax"] - pl["tax"], 2)
    pl["net_income_statutory"] = round(
        pl["net_income_operational"] + (pl.get("capitalized_own_work_memo") or 0.0), 2)
    return out


def served_payload(env: Dict[str, Any], period_id: str, period_end: str) -> Dict[str, Any]:
    """The `/api/period/{id}` shape the route core reads."""
    return {
        "statements": env["statements"],
        "line_items": env["lineItems"],
        "metrics": [],
        "period": {"id": period_id, "period_end": period_end, "currency": "RON"},
    }
