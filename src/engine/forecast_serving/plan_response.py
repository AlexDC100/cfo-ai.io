"""fp1.2 — the one served form of a Plan (plan_contract_v2 section 3).

``build_response`` turns a Plan into the wire body: the always-served root,
then the blocks the request wanted. Nothing here projects, and this package
imports NO producer module (scripts/check_forecast_boundary.mjs): the Plan's
periods are read as duck-typed objects, and everything else the producer
knows (the registry, each driver's pedigree, the removal runs and inert
nudges of 1.1, the conventions, the pack values) arrives as the plain
``inputs`` of ``engine.forecast.levers.serving_inputs(plan)``, which the
route passes in.

No float appears anywhere in the body (3.12): money is integer minor units,
ratios and indices integer micros, days integer micro-days, request decimals
their canonical strings. ``clause_violations`` checks the bytes that leave.

Python 3.9 - no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

import hashlib
import json
import os
from fractions import Fraction
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from . import contract
from .blocks import (ACCEPTED_WANT_KEYS, BLOCK_FIELD_CONSUMERS, DEFAULT_WANT,
                     DRIVER_ECHO_FIELDS)
from .blocks.drivers import _text as exact_text
from .blocks.drivers import build_client, build_drivers
from .blocks.figures import Attribution, build_figures, monthly_years
from .blocks.series import build_series
from .blocks.strip import build_strip
from .blocks.summary import build_summary

__all__ = ["PLAN_CONTRACT_VERSION", "body_hash", "build_response",
           "canonical_request", "clause_violations", "lever_set_hash",
           "pack_hash", "PlanResponseError"]

PLAN_CONTRACT_VERSION = contract.PLAN_CONTRACT_VERSION
_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
#: 3.1: what pack_hash covers.
PACK_ROOTS = ("packs/forecast", "packs/scenarios")
PACK_FILES = ("packs/serving/change_kind.yaml",)


class PlanResponseError(ValueError):
    """The body broke its own contract. A producer defect: never served."""

    def __init__(self, violations: List[Tuple[str, str]]) -> None:
        self.violations = list(violations)
        ValueError.__init__(self, "; ".join("%s: %s" % v for v in violations))


def _sha(payload: Any) -> str:
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"),
                     ensure_ascii=False).encode("utf-8")
    return "sha256:" + hashlib.sha256(raw).hexdigest()


_PACK_HASH = {}  # type: Dict[str, str]


def pack_hash(repo: Optional[str] = None) -> str:
    root = repo or _REPO
    cached = _PACK_HASH.get(root)
    if cached is not None:
        return cached
    paths = []  # type: List[str]
    for folder in PACK_ROOTS:
        full = os.path.join(root, folder)
        if os.path.isdir(full):
            for base, _dirs, files in os.walk(full):
                paths.extend(os.path.join(base, f) for f in files)
    paths.extend(os.path.join(root, f) for f in PACK_FILES
                 if os.path.isfile(os.path.join(root, f)))
    digest = hashlib.sha256()
    for path in sorted(paths):
        digest.update(os.path.relpath(path, root).replace(os.sep, "/").encode("utf-8"))
        digest.update(b"\0")
        with open(path, "rb") as fh:
            digest.update(hashlib.sha256(fh.read()).hexdigest().encode("ascii"))
        digest.update(b"\n")
    _PACK_HASH[root] = "sha256:" + digest.hexdigest()
    return _PACK_HASH[root]


# ── 2.10: the canonical request ───────────────────────────────────────────

def _canon(value: Optional[Fraction]) -> Optional[str]:
    return None if value is None else exact_text(Fraction(value))


def canonical_request(request: Any) -> Dict[str, Any]:
    """Every default filled, want and case_id removed, decimals in their
    exact normal form, lists in their stated order (2.10)."""
    return {
        "horizon": {"total_years": request.total_years,
                    "monthly_months": request.monthly_months},
        "case": request.case,
        "overrides": dict((key, {"values": [_canon(v) for v in values]})
                          for key, values in sorted(request.overrides)),
        "shocks": [{"id": s.id, "driver_key": s.driver_key, "op": s.op,
                    "value": _canon(s.value), "start_month": s.start_month,
                    "ramp_months": s.ramp_months, "end_month": s.end_month,
                    "source": s.source, "group_id": s.group_id}
                   for s in sorted(request.shocks, key=lambda s: s.id)],
        "behaviour_overrides": [
            {"pool": b.pool, "fixed_share": _canon(b.fixed_share),
             "volume_elasticity": (None if b.volume_elasticity is None
                                   else str(b.volume_elasticity))}
            for b in sorted(request.behaviour_overrides, key=lambda b: b.pool)],
        "accept_proposals": list(request.accept_proposals),
        "debt_schedule": [
            dict([("year", r.year)] + [(n, _canon(getattr(r, n))) for n in
                                       ("st_draw", "st_repay", "lt_draw", "lt_repay")])
            for r in sorted(request.debt_schedule, key=lambda r: r.year)],
        "spread": request.spread,
        "compare_case_ids": list(request.compare_case_ids),
        "tornado_metric": request.tornado_metric,
        "breakeven_from": request.breakeven_from,
    }


def lever_set_hash(request: Any) -> str:
    body = canonical_request(request)
    for key in ("compare_case_ids", "tornado_metric", "breakeven_from"):
        body.pop(key, None)
    return _sha(body)


def body_hash(body: Mapping[str, Any]) -> str:
    return _sha(dict((k, v) for k, v in body.items()
                     if k not in ("body_hash", "recompute_ms")))


# ── the body ──────────────────────────────────────────────────────────────

def _sentences(notes: Sequence[Any]) -> List[Dict[str, str]]:
    out = []  # type: List[Dict[str, str]]
    for note in notes:
        if isinstance(note, dict):
            out.append({"code": str(note.get("code")), "text": str(note.get("text"))})
        else:
            text = str(note)
            head = text.split(":", 1)[0].strip().replace(" ", "_")
            out.append({"code": "note.%s" % head if len(head) < 48 else "note",
                        "text": text})
    return out


def _conventions(inputs: Mapping[str, Any]) -> Dict[str, Dict[str, str]]:
    return dict((cid, {"id": cid, "sentence": sentence})
                for cid, sentence in inputs["conventions"])


def _debt_echo(plan: Any, inputs: Mapping[str, Any]) -> List[Dict[str, Any]]:
    pack = inputs["pack"]
    timeline = plan.projection.timeline
    out = []  # type: List[Dict[str, Any]]
    for row in sorted(plan.request.debt_schedule, key=lambda r: r.year):
        year = [p for p in timeline if p.year_offset == row.year]
        first, last = year[0].label, year[-1].label

        def minor(value):
            whole = Fraction(value) * 100
            return whole.numerator // whole.denominator

        out.append({
            "year": row.year,
            "period_label_draws": first if pack["debt_draws"] == "first_period" else last,
            "period_label_repayments": (first if pack["debt_repayments"] == "first_period"
                                        else last),
            "timing_rule": "packs/forecast/levers.yaml#debt_timing",
            "st_draw_minor": minor(row.st_draw), "st_repay_minor": minor(row.st_repay),
            "lt_draw_minor": minor(row.lt_draw), "lt_repay_minor": minor(row.lt_repay),
            "lever_id": "debt:%d" % row.year})
    return out


def build_response(plan: Any, inputs: Mapping[str, Any], anchor: Mapping[str, Any],
                   history: Mapping[str, Any], want: Optional[Sequence[str]],
                   period_id: str, anchor_updated_at: Optional[str] = None
                   ) -> Dict[str, Any]:
    """The fp1.2 body of one Plan, body_hash stamped, recompute_ms absent
    (the route measures it and it sits outside the hash, 1.2). ``inputs`` is
    ``engine.forecast.levers.serving_inputs(plan)``."""
    serving = inputs["pack"]
    wanted = tuple(DEFAULT_WANT if want is None else want)
    unknown = [k for k in wanted if k not in ACCEPTED_WANT_KEYS]
    if unknown:
        raise PlanResponseError([("want_key_unknown", ", ".join(unknown))])

    projection = plan.projection
    inert = dict(inputs["inert"])
    # 12: a driver whose own value is served as a number (the cash floor on
    # the chart) moves that number whenever it moves
    if "series" in wanted:
        for key, fields in BLOCK_FIELD_CONSUMERS.items():
            if any(f in DRIVER_ECHO_FIELDS for f in fields):
                inert[key] = False
    inputs = dict(inputs, inert=inert)
    removals = inputs["removals"]
    static_levers = {}  # type: Dict[str, List[str]]
    for lever_id, _run, keys in removals:
        for key in keys:
            static_levers.setdefault(key, []).append(lever_id)
    line_assumptions = dict(plan.line_assumptions)
    attribution = Attribution(line_assumptions, inert, projection.periods,
                              plan.base.periods, removals, static_levers,
                              inputs["totals"], plan_run=projection)

    timeline = projection.timeline
    years = monthly_years(timeline)
    served_labels = [p.label for p in projection.periods]
    formulas = dict(serving["lines"])
    aggregate_formulas = serving["formulas"]
    refusal = projection.shortfall
    partial = (dict(refusal.sentence) if refusal is not None
               else dict(serving["not_fully_served"]))

    period_end = str(anchor.get("period_end") or "")
    flow_months = None  # type: Optional[int]
    notes = list(plan.notes) + list(history.get("notes") or [])
    try:
        if int(period_end[5:7]) == serving["fiscal_year_end_month"]:
            flow_months = 12
    except ValueError:
        pass
    if flow_months is None:
        notes.append(dict(serving["flow_span_not_stated"]))

    balance = [{"period": p.label, "difference_minor": p.checks["balance_delta_cents"]}
               for p in projection.periods]
    for _n, fy, months in years:
        if all(m.label in served_labels for m in months):
            last = [p for p in projection.periods if p.label == months[-1].label][0]
            balance.append({"period": fy,
                            "difference_minor": last.checks["balance_delta_cents"]})

    pins_history = [[period_id, anchor_updated_at]] + [
        [h.get("period_id"), h.get("updated_at")] for h in history.get("held_rows") or []]
    body = {
        "kind": contract.KIND,
        "contract": PLAN_CONTRACT_VERSION,
        "currency": anchor.get("currency") or "RON",
        "base_period": {
            "label": anchor.get("period_label") or period_end,
            "period_id": period_id, "period_end": period_end,
            "flow_months": flow_months,
            "snapshot_id": projection.opening.snapshot_id,
            "company_name": anchor.get("company_name")},
        "horizon": {
            "labels": [p.label for p in timeline],
            "labels_annual": [fy for _n, fy, _m in years],
            "year_of": dict([(p.label, p.year_offset) for p in timeline]
                            + [(fy, n) for n, fy, _m in years]),
            "served_through": served_labels[-1] if served_labels else None},
        "driver_order": list(plan.driver_order),
        "drivers": build_drivers(plan.request, inputs, line_assumptions),
        "conventions": _conventions(inputs),
        "history": {"held": list(history.get("held") or []),
                    "eligible": list(history.get("eligible") or []),
                    "excluded": list(history.get("excluded") or [])},
        "pins": {"engine_version": inputs["engine_version"], "pack_hash": pack_hash(),
                 "macro_snapshot_id": None,
                 # the committed sector dataset's content digest, when this
                 # plan's growth stood on (or was offered) a sector figure
                 "sector_snapshot_id": inputs.get("sector_snapshot_id"),
                 "history_hash": _sha(pins_history)},
        "lever_set_hash": lever_set_hash(plan.request),
        "pins_changed": [],
        # 6.5 (B6RV2-5 repair): the refusal block is the engine's OWN
        # ``ShortfallRefusal.as_dict()``, not a second hand-composed copy of
        # it. The hand-composed one dropped ``cash_before_funding_minor`` —
        # a figure the engine computes, holds and defends in that class's
        # docstring — so the cash curve had a hole at exactly the period the
        # plan runs out. One authority for the shape, so it cannot drift.
        "refusal": (None if refusal is None else refusal.as_dict()),
        "debt_schedule": _debt_echo(plan, inputs),
        "balance_check": balance,
        "unbalanced_periods": [b["period"] for b in balance if b["difference_minor"] != 0],
        "notes": _sentences(notes),
        "client": build_client(inputs),
    }  # type: Dict[str, Any]

    min_cash = inputs["min_cash_minor"]
    summary = None
    if "figures" in wanted:
        body["figures"] = build_figures(serving["lines"], projection, attribution,
                                        aggregate_formulas, serving["not_fully_served"])
    if "series" in wanted:
        body["series"] = build_series(
            projection, attribution, min_cash,
            [] if inert.get("min_cash") else ["min_cash"], partial,
            min_cash != inputs["min_cash_base_minor"])
    if "summary" in wanted or "strip" in wanted:
        summary = build_summary(plan, attribution, formulas,
                                inputs["revolver_rate_basis"])
    if "summary" in wanted:
        body["summary"] = summary
    if "strip" in wanted:
        body["strip"] = build_strip(plan, summary, attribution, formulas,
                                    serving["not_served"],
                                    aggregate_formulas["cumulative_fcf"])

    violations = clause_violations(body)
    if violations:
        raise PlanResponseError(violations)
    body["body_hash"] = body_hash(body)
    return body


# ── the clauses (3.1, 3.3, 3.6, 3.12) ─────────────────────────────────────

def _floats_in(node: Any, path: str = "$") -> List[str]:
    if isinstance(node, float):
        return [path]
    if isinstance(node, dict):
        return [hit for k, v in node.items() for hit in _floats_in(v, "%s.%s" % (path, k))]
    if isinstance(node, (list, tuple)):
        return [hit for i, v in enumerate(node) for hit in _floats_in(v, "%s[%d]" % (path, i))]
    return []


def clause_violations(body: Any) -> List[Tuple[str, str]]:
    out = []  # type: List[Tuple[str, str]]
    if not isinstance(body, dict):
        return [("kind_not_projection", "body is not an object")]
    if body.get("kind") != contract.KIND:
        out.append(("kind_not_projection", repr(body.get("kind"))))
    if body.get("contract") != PLAN_CONTRACT_VERSION:
        out.append(("contract_version_unknown", repr(body.get("contract"))))
    if not isinstance(body.get("currency"), str) or not body["currency"].strip():
        out.append(("currency_missing", repr(body.get("currency"))))
    base = body.get("base_period")
    if not isinstance(base, dict) or not str(base.get("label") or "").strip():
        out.append(("base_period_missing", "base_period.label"))
    horizon = body.get("horizon")
    labels = horizon.get("labels") if isinstance(horizon, dict) else None
    if not isinstance(labels, list) or not labels:
        out.append(("horizon_missing_or_empty", repr(labels)))
        labels = []
    known = set(labels) | set((horizon or {}).get("labels_annual") or [])
    for container in contract.ACTUAL_FIGURE_CONTAINERS:
        if container in body:
            out.append(("actual_figure_container_in_projection", container))
    drivers = body.get("drivers") if isinstance(body.get("drivers"), dict) else {}
    conventions = body.get("conventions") if isinstance(body.get("conventions"), dict) else {}
    for key, driver in sorted(drivers.items()):
        basis = driver.get("basis") or {}
        tier = basis.get("tier")
        evidence = [n for n in ("book", "sector", "macro", "convention")
                    if basis.get(n) is not None]
        if tier in ("book", "sector", "macro", "convention"):
            if evidence != [tier]:
                out.append(("basis_evidence_does_not_match_tier",
                            "%s: tier %s carries %s" % (key, tier, evidence or "none")))
        elif tier == "user":
            if evidence or basis.get("original") is None or not basis.get("source"):
                out.append(("basis_user_without_original", key))
        elif tier == "absent":
            if evidence or any(v is not None for v in driver.get("values") or []) \
                    or not basis.get("fallback_steps"):
                out.append(("basis_absent_with_a_value", key))
        else:
            out.append(("basis_tier_unknown", "%s: %r" % (key, tier)))
    seen = set()  # type: set
    for index, figure in enumerate(body.get("figures") or []):
        where = "figures[%d] %s %s" % (index, figure.get("line"), figure.get("period"))
        if figure.get("period") not in known:
            out.append(("figure_period_outside_horizon", where))
        pair = (figure.get("line"), figure.get("period"))
        if pair in seen:
            out.append(("figure_declared_twice", where))
        seen.add(pair)
        if "refused" in figure:
            continue
        amount = figure.get("amount_minor")
        if not isinstance(amount, int) or isinstance(amount, bool):
            out.append(("figure_amount_not_integer_minor", where))
        if not str(figure.get("formula") or "").strip():
            out.append(("figure_without_formula", where))
        ids = figure.get("driver_ids") or []
        if not ids:
            out.append(("figure_names_no_driver", where))
        for i in ids:
            if i not in drivers and i not in conventions:
                out.append(("figure_names_unknown_driver", "%s: %s" % (where, i)))
    for path in _floats_in(body):
        out.append(("float_in_body", path))
    return out
