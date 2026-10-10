""""CE CONTEAZĂ ACUM" — the attention/1 document, composed from served sources.

The command bar's empty state (owner spec 2026-09-26, design C1): the three
most material items for THIS company and period, each one line with its
served number and the receiver that opens its evidence, then two or three
actions chosen by the company's state. One authority: the engine ranks, the
browser prints.

WHAT IT READS — AND NOTHING ELSE
  * the served period body (`GET /api/period/{id}`): period facts, the
    account-121 anchor status, `statements.insights` (the deterministic
    findings; their model-authored `narrative` is never read), and — through
    `sources` only — EBITDA, inventory days and the credit envelope's regime
    (`assembled_metrics.credit.regime`, served verbatim as `credit_regime`);
  * the served comparatives document (`GET /api/period/{id}/comparatives`)
    with the same company's previous period of the same length;
  * the served sector-benchmark document
    (`GET /api/period/{id}/sector-benchmark`).
  `recommendations[]`, `briefing`, `alerts[]` and any narrated text are
  EXCLUDED, by construction: no function here takes them. The gate
  `attention-served-only` plants model text in every one of them and reds
  if a byte of it reaches the document.

WHAT IT NEVER DOES
  * compute a figure a reader sees: every item carries the served object it
    was read from (the comparatives column, the sector row, the ratio
    compare row, the insight measure) verbatim; the only arithmetic here is
    the RANKING terms (a share of the statement base, a distance past a
    quartile), and each is served beside the item as `materiality`;
  * fill a slot with a filler: fewer material items -> fewer items, and
    every empty slot says why in `unfilled`;
  * rank a verdict-less reclassification (Other equity, other current
    assets) as "the biggest movement" — the movement and improvement slots
    read only the pack's statutory results;
  * let the composite letter stand in for a movement: it is eligible only
    as a band crossing, with the rung it crossed and the finding stating it;
  * call stock slow or fast on the filed basis or on a year-end snapshot;
  * judge a movement the comparatives document serves no verdict for. The
    document says which way time runs (`direction`): when the comparison
    period closes LATER than the one on screen, or the order of the two
    closes cannot be read, no statement line is "improved" or
    "deteriorated", no ratio-band candidate is read, and the improvement
    slot stays empty with that reason. The movement slot still ranks by
    size — a size is not a verdict. (Until 2026-10-04 the ratio side read
    the document's withheld lists and the statement side judged every
    delta itself: on an earlier period compared with a later one, a
    turnover that FELL over time was the period's "improvement".)

Pure over its inputs: no clock, no I/O beyond the pack read, no model.
Python 3.9 — no `match`, no `X | Y`.
"""
from __future__ import annotations

import copy
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from engine.comparatives.analysis import MATERIALITY_FLOOR, line_verdict
from engine.comparatives.columns import MOVEMENT_STATUSES
from engine.comparatives.lines import ZERO_FLOOR

from . import sources as S
from .pack import load_pack

__all__ = ["SCHEMA", "EXCLUDED_SOURCES", "DIRECTION_UNREADABLE", "verdicts_withheld_of", "compose_attention"]

SCHEMA = "attention/1"

#: The served fields this document never reads, named on the document so a
#: reader (and the gate) can see the boundary it keeps.
EXCLUDED_SOURCES = (
    "recommendations",
    "briefing",
    "alerts",
    "statements.insights[].narrative",
    "statements.insights[].claim",
)

def _num(value: Any) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    value = float(value)
    if value != value or value in (float("inf"), float("-inf")):
        return None
    return value


def _r6(value: float) -> float:
    out = round(value, 6)
    return 0.0 if out == 0 else out


def _reason(code: str, *inputs: Any) -> Dict[str, Any]:
    return {"code": code, "inputs": [i for i in inputs if i is not None]}


# ── candidates: statutory results (comparatives columns) ───────────────


def _prior_payload_view(comparatives: Mapping[str, Any]) -> Dict[str, Any]:
    """The prior period's served statements, as the comparatives document
    carries them verbatim (`prior_statements`), in the shape `sources`
    reads."""
    st = comparatives.get("prior_statements")
    return {"statements": st if isinstance(st, Mapping) else {}}


#: The reason an attention document gives for serving no verdict when the
#: comparatives document carries no readable `direction` at all.
DIRECTION_UNREADABLE = "period_order_unknown"


def verdicts_withheld_of(comparatives: Optional[Mapping[str, Any]]) -> Optional[str]:
    """Why this comparatives document serves no improved / deteriorated
    verdict — its own `direction.reason` — or None when it serves them
    (`direction.verdicts_served is True`). The ENGINE read the two closes
    (`engine.comparatives.analysis.time_direction`); nothing is re-derived
    from the dates here. A document that does not say which way time runs
    is not believed to run forwards."""
    direction = comparatives.get("direction") if isinstance(comparatives, Mapping) else None
    if isinstance(direction, Mapping) and direction.get("verdicts_served") is True:
        return None
    reason = direction.get("reason") if isinstance(direction, Mapping) else None
    return reason if isinstance(reason, str) and reason else DIRECTION_UNREADABLE


def _statement_candidates(pack: Mapping[str, Any], current_payload: Mapping[str, Any],
                          comparatives: Mapping[str, Any]) -> List[Dict[str, Any]]:
    columns = {c.get("key"): c for c in comparatives.get("columns") or []
               if isinstance(c, Mapping)}
    withheld = verdicts_withheld_of(comparatives)
    bases = (comparatives.get("movers") or {}).get("bases") or {}
    prior_view = _prior_payload_view(comparatives)
    anchor_ok = set(pack["anchor_statuses"])
    out = []
    for line in pack["statement_lines"]:
        key = line["key"]
        cand = {"family": "statement_line", "key": key, "identity": line["identity"],
                "line": line, "eligible": False, "reason": None}
        out.append(cand)
        col = columns.get(key)
        if col is None:
            cand["reason"] = _reason("column_absent", key)
            continue
        cand["column"] = col
        if col.get("status") not in MOVEMENT_STATUSES or _num(col.get("delta")) is None:
            cand["reason"] = _reason("no_movement", col.get("status"))
            continue
        if key == "pl.ebitda":
            for side, view in (("current", current_payload), ("prior", prior_view)):
                served = S.served_ebitda(view)
                if served["refusal"] is not None:
                    cand["reason"] = dict(served["refusal"], side=side)
                    break
            if cand["reason"] is not None:
                continue
        if line["requires_anchor"]:
            cur_a = S.anchor_status(current_payload)
            pri_a = S.anchor_status(prior_view)
            cand["anchor"] = {"current": cur_a, "prior": pri_a}
            if cur_a not in anchor_ok or pri_a not in anchor_ok:
                cand["reason"] = _reason("net_result_not_account_121", cur_a, pri_a)
                continue
        statement = "PL" if key.startswith("pl.") else "BS"
        base_key, base_value = (list(bases.get(statement) or []) + [None, None])[:2]
        base_value = _num(base_value)
        if base_value is None or abs(base_value) < ZERO_FLOOR:
            cand["reason"] = _reason("no_statement_base", base_key)
            continue
        share = _r6(abs(float(col["delta"])) / abs(base_value))
        cand["materiality"] = {
            "measure": pack["materiality"]["statement_line"][statement]["measure"],
            "basis": base_key, "basis_value": base_value, "share": share,
            "floor": MATERIALITY_FLOOR,
        }
        # The adjective is a statement about time: none under a comparison
        # the document serves no verdict for.
        cand["verdict"] = None if withheld is not None else line_verdict(key, float(col["delta"]))
        if share < MATERIALITY_FLOOR:
            cand["reason"] = _reason("below_materiality_floor", share, MATERIALITY_FLOOR)
            continue
        cand["eligible"] = True
    return out


def _by_share(cands: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Materiality share descending, then key ascending — two hosts, one order."""
    return sorted((c for c in cands if c["eligible"]),
                  key=lambda c: (-c["materiality"]["share"], c["key"]))


# ── candidates: the sector (worst ratio vs sector) ─────────────────────


def _sector_state(sector: Optional[Mapping[str, Any]]) -> Tuple[bool, Optional[Dict[str, Any]]]:
    if not isinstance(sector, Mapping):
        return False, _reason("sector_benchmark_absent")
    if sector.get("status") != "ok":
        reason = sector.get("reason") if isinstance(sector.get("reason"), Mapping) else None
        return False, dict(reason) if reason else _reason("sector_benchmark_refused")
    if sector.get("sector_disputed"):
        return False, _reason("sector_disputed", "industry_signal.block_sector_content")
    return True, None


def _sector_candidates(pack: Mapping[str, Any], sector: Optional[Mapping[str, Any]]
                       ) -> List[Dict[str, Any]]:
    ok, _why = _sector_state(sector)
    if not ok:
        return []
    spec = pack["sector"]
    out = []
    for row in sector.get("rows") or []:
        if not isinstance(row, Mapping):
            continue
        key = row.get("key")
        cand = {"family": "sector_row", "key": key, "identity": spec["identities"].get(key),
                "row": row, "eligible": False, "reason": None}
        out.append(cand)
        if cand["identity"] is None:
            cand["reason"] = _reason("no_declared_identity", key)
            continue
        if row.get("status") != "sourced":
            cand["reason"] = _reason("row_not_sourced", row.get("status"))
            continue
        if row.get("vs_sector") != spec["eligible_vs_sector"]:
            cand["reason"] = _reason("not_worse_than_sector", row.get("vs_sector"))
            continue
        value = _num((row.get("company") or {}).get("value"))
        fig = row.get("sector") or {}
        p25, p75 = _num(fig.get("p25")), _num(fig.get("p75"))
        distance = None
        if value is not None and p25 is not None and p75 is not None and p75 - p25 > 0:
            if row.get("position") == "below_p25":
                distance = _r6((p25 - value) / (p75 - p25))
            elif row.get("position") == "above_p75":
                distance = _r6((value - p75) / (p75 - p25))
        cand["materiality"] = {"measure": pack["materiality"]["sector_row"]["measure"],
                               "distance": distance}
        cand["eligible"] = True
    return out


def _by_distance(cands: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Distance past the worse quartile descending (no distance last), then key."""
    def key(c):
        d = c["materiality"]["distance"]
        return (0 if d is not None else 1, -(d or 0.0), c["key"])
    return sorted((c for c in cands if c["eligible"]), key=key)


# ── candidates: ratio band crossings (served rank order) ───────────────


def _ratio_candidates(pack: Mapping[str, Any], current_payload: Mapping[str, Any],
                      comparatives: Mapping[str, Any]) -> List[Dict[str, Any]]:
    ratios = comparatives.get("ratios") if isinstance(comparatives.get("ratios"), Mapping) else {}
    rows = {}
    for r in list(ratios.get("rows") or []) + list(ratios.get("composites") or []):
        if isinstance(r, Mapping) and r.get("key"):
            rows[r["key"]] = r
    improved = list(((ratios.get("band_movements") or {}).get("improved")) or [])
    spec = pack["ratio_band"]
    policy = S.inventory_days(current_payload)["claim_policy"]
    out = []
    for rank, key in enumerate(improved, start=1):
        row = rows.get(key)
        cand = {"family": "ratio_band", "key": key,
                "identity": spec["identities"].get(key, "ratio:%s" % key),
                "served_rank": rank, "eligible": False, "reason": None}
        out.append(cand)
        if row is None:
            cand["reason"] = _reason("row_absent", key)
            continue
        cand["row"] = row
        mv = row.get("movement") or {}
        if mv.get("status") != "crossed_up":
            cand["reason"] = _reason("not_a_crossing", mv.get("status"))
            continue
        if key not in spec["subjects"]:
            cand["reason"] = _reason("no_declared_subject", key)
            continue
        if key in spec["inventory_days_keys"] and not policy.get("may_call_slow"):
            cand["reason"] = _reason("inventory_days_claim_not_allowed", policy.get("reason"))
            continue
        if key == spec["composite_letter"]:
            score = rows.get(spec["composite_score"])
            if not mv.get("rung_crossed") or not row.get("finding_id") or score is None:
                cand["reason"] = _reason("letter_without_its_reason", key)
                continue
            cand["because"] = {"composite_row": score, "rung_crossed": mv.get("rung_crossed"),
                               "finding_id": row.get("finding_id")}
        cand["materiality"] = {"measure": pack["materiality"]["ratio_band"]["measure"],
                               "served_rank": rank,
                               "rank_basis": (ratios.get("band_movements") or {}).get("rank_basis")}
        cand["eligible"] = True
    return out


# ── candidates: the period's own findings (single period) ──────────────


def _insight_candidates(pack: Mapping[str, Any], current_payload: Mapping[str, Any]
                        ) -> Tuple[List[Dict[str, Any]], Optional[Dict[str, Any]]]:
    block = S.insights_block(current_payload)
    if block is None:
        return [], _reason("insights_absent", "statements.insights")
    spec = pack["insights"]
    levels = set(spec["material_levels"])
    excluded = spec.get("excluded") or {}
    ordered = sorted((i for i in block["insights"] if isinstance(i, Mapping)),
                     key=lambda i: (i.get("rank") if isinstance(i.get("rank"), int) else 10 ** 6,
                                    str(i.get("id") or "")))
    out = []
    for ins in ordered:
        det = ins.get("id")
        desc = spec["detectors"].get(det)
        cand = {"family": "insight", "key": det,
                "identity": desc["identity"] if desc else "insight:%s" % det,
                "served_rank": ins.get("rank"), "eligible": False, "reason": None}
        out.append(cand)
        if det in excluded:
            cand["reason"] = _reason("excluded_%s" % excluded[det], det)
            continue
        if desc is None:
            cand["reason"] = _reason("no_declared_detector", det)
            continue
        sev = ins.get("severity") if isinstance(ins.get("severity"), Mapping) else {}
        if sev.get("level") not in levels:
            cand["reason"] = _reason("below_material_level", sev.get("level"))
            continue
        headline = next((m for m in ins.get("measures") or []
                         if isinstance(m, Mapping) and m.get("key") == desc["headline"]), None)
        if headline is None or _num(headline.get("value")) is None:
            cand["reason"] = _reason("headline_measure_absent", desc["headline"])
            continue
        cand.update(insight=ins, desc=desc, headline=headline, eligible=True)
        cand["materiality"] = {"measure": pack["materiality"]["insight"]["measure"],
                               "served_rank": ins.get("rank"),
                               "level": sev.get("level"),
                               "share": sev.get("materiality"),
                               "basis": sev.get("basis")}
    return out, None


# ── items ───────────────────────────────────────────────────────────────


def _statement_item(slot: str, cand: Mapping[str, Any], comparatives: Mapping[str, Any],
                    prior: Mapping[str, Any]) -> Dict[str, Any]:
    line = cand["line"]
    item = {
        "slot": slot, "family": "statement_line", "key": cand["key"],
        "identity": cand["identity"], "subject": dict(line["subject"]),
        "basis_label": None,
        "figure": {"kind": "comparatives_column", "column": copy.deepcopy(cand["column"]),
                   "current_label": (comparatives.get("current") or {}).get("label"),
                   "prior_label": (comparatives.get("prior") or {}).get("label")},
        "verdict": cand.get("verdict"),
        "materiality": copy.deepcopy(cand["materiality"]),
        "source": {"document": "comparatives", "path": "columns[key=%s]" % cand["key"]},
        "evidence": {"kind": "statement", "tab": line["tab"], "line": cand["key"],
                     "prior_period_id": prior.get("period_id")},
    }
    if "anchor" in cand:
        item["anchor"] = dict(cand["anchor"])
    return item


def _sector_item(slot: str, cand: Mapping[str, Any], pack: Mapping[str, Any],
                 sector: Mapping[str, Any]) -> Dict[str, Any]:
    spec = pack["sector"]
    key = cand["key"]
    position_only = key in spec["position_only"]
    item = {
        "slot": slot, "family": "sector_row", "key": key, "identity": cand["identity"],
        "subject": dict(spec["subjects"][key]),
        "basis_label": copy.deepcopy((spec.get("basis_labels") or {}).get(key)),
        "figure": {"kind": "sector_row", "row": copy.deepcopy(cand["row"]),
                   "min_peers": sector.get("min_peers")},
        # A position against the sector is always printed; the WORD "worse"
        # only where the row is not position-only.
        "verdict": None if position_only else cand["row"].get("vs_sector"),
        "materiality": copy.deepcopy(cand["materiality"]),
        "source": {"document": "sector_benchmark", "path": "rows[key=%s]" % key},
        "evidence": {"kind": "benchmark_row", "route": "/benchmark", "row": key},
    }
    if position_only:
        item["claim_policy"] = {"may_call_slow": False, "verdict_word": False,
                                "reason": "filed_basis_position_only"}
    return item


#: Ratio rows whose figure is the served inventory-days block on its SERVED
#: basis (the average where the book carries the opening): the item carries
#: that basis's label. The cycle adds the period-end term instead, so it
#: carries none rather than the average's words.
_INVENTORY_BASIS_KEYS = ("dio", "inventory_turnover")


def _ratio_item(slot: str, cand: Mapping[str, Any], pack: Mapping[str, Any],
                current_payload: Mapping[str, Any]) -> Dict[str, Any]:
    key = cand["key"]
    basis_label = None
    if key in _INVENTORY_BASIS_KEYS:
        # The served block's basis LABEL — never its code (merge contract
        # 2026-09-28), read through the one adapter.
        basis_label = S.inventory_days(current_payload)["basis_label"]
    item = {
        "slot": slot, "family": "ratio_band", "key": key, "identity": cand["identity"],
        "subject": dict(pack["ratio_band"]["subjects"][key]),
        "basis_label": copy.deepcopy(basis_label),
        "figure": {"kind": "ratio_compare_row", "row": copy.deepcopy(cand["row"])},
        "verdict": "improved",
        "materiality": copy.deepcopy(cand["materiality"]),
        "source": {"document": "comparatives",
                   "path": "ratios.%s[key=%s]" % (
                       "composites" if key == pack["ratio_band"]["composite_letter"] else "rows", key)},
        "evidence": {"kind": "ratio", "tab": "ratios", "ratio": key},
    }
    if "because" in cand:
        item["because"] = {
            "composite_row": copy.deepcopy(cand["because"]["composite_row"]),
            "rung_crossed": copy.deepcopy(cand["because"]["rung_crossed"]),
            "finding_id": cand["because"]["finding_id"],
            "source": {"document": "comparatives",
                       "path": "ratios.composites[key=%s]" % pack["ratio_band"]["composite_score"]},
        }
    return item


def _same_figure(kind: str, shown: Optional[float], measure: Optional[float]) -> bool:
    if shown is None or measure is None:
        return False
    tol = ZERO_FLOOR if kind == "statement" else 1e-9 * max(1.0, abs(measure))
    return abs(shown - measure) <= tol


def _insight_item(slot: str, cand: Mapping[str, Any], currency: Optional[str],
                  payload: Mapping[str, Any]) -> Dict[str, Any]:
    ins = cand["insight"]
    desc = cand["desc"]
    accounts = sorted(
        ((str(a.get("code")), abs(_num(a.get("amount")) or 0.0))
         for a in ins.get("accounts") or [] if isinstance(a, Mapping) and a.get("code")),
        key=lambda x: (-x[1], x[0]))
    codes = []
    for code, _amt in accounts:
        if code not in codes:
            codes.append(code)
    evidence = dict(desc["evidence"])
    # THE RECEIVER HEADS WITH THE ITEM'S OWN NUMBER. A statement line or a
    # ratio row opens under ITS served figure; when that is not this
    # finding's headline measure (earnings_quality's 758 + 781 against the
    # 758 line alone; a trade-only current ratio against the headline one)
    # the reader clicks one number and lands on another. Such an item opens
    # the accounts the finding cites instead, under the finding's own
    # measure (`finding` + `measure`: the account view prints it from
    # statements.insights, the same served object this item carries).
    # `because` says which receiver was declined and the number it heads with.
    if evidence["kind"] in ("statement", "ratio"):
        shown = S.receiver_headline(payload, evidence)
        if not _same_figure(evidence["kind"], shown, _num(cand["headline"].get("value"))):
            evidence = {"kind": "account",
                        "because": {"code": "receiver_heads_with_another_figure",
                                    "receiver": dict(evidence), "receiver_headline": shown}}
    if evidence["kind"] == "account":
        evidence["account"] = codes[0] if codes else None
        evidence["finding"] = ins.get("id")
        evidence["measure"] = desc["headline"]
    evidence["accounts"] = codes
    sev = ins.get("severity") or {}
    return {
        "slot": slot, "family": "insight", "key": ins.get("id"), "identity": cand["identity"],
        "subject": dict(desc["subject"]),
        "basis_label": None,
        "figure": {"kind": "insight_measure", "measure": copy.deepcopy(cand["headline"]),
                   "currency": currency},
        "verdict": None,
        "severity": {"level": sev.get("level"), "basis": sev.get("basis"),
                     "basis_label": sev.get("basis_label"), "materiality": sev.get("materiality"),
                     "bands": copy.deepcopy(sev.get("bands"))},
        "materiality": copy.deepcopy(cand["materiality"]),
        "source": {"document": "period", "path": "statements.insights.insights[id=%s].measures[key=%s]"
                   % (ins.get("id"), desc["headline"])},
        "evidence": evidence,
    }


# ── the considered lists (rank terms written as data) ──────────────────


def _considered(cands: Sequence[Mapping[str, Any]]) -> List[Dict[str, Any]]:
    out = []
    for c in cands:
        out.append({"family": c["family"], "key": c["key"], "identity": c.get("identity"),
                    "eligible": c["eligible"], "reason": copy.deepcopy(c.get("reason")),
                    "materiality": copy.deepcopy(c.get("materiality"))})
    return out


# ── actions ─────────────────────────────────────────────────────────────


def _actions(pack: Mapping[str, Any], facts: Mapping[str, Any], prior: Mapping[str, Any],
             mode: str, sector_reason: Optional[Mapping[str, Any]]) -> List[Dict[str, Any]]:
    labels = pack["actions"]
    out = []
    # A comparison is offered when one is being shown, or when the reader
    # switched it off and the same-length prior exists (turning it back on).
    if prior.get("status") == "found" and mode == "with_prior":
        compare_to, compare_end = prior.get("period_id"), prior.get("period_end")
    elif prior.get("status") == "off" and prior.get("available_period_id"):
        compare_to, compare_end = prior.get("available_period_id"), prior.get("available_period_end")
    else:
        compare_to, compare_end = None, None
    if compare_to:
        one_year = compare_end == S.year_back(facts.get("period_end"))
        key = "compare_prior" if one_year else "compare_previous_period"
        out.append({"key": key, "label": dict(labels[key]["label"]),
                    "target": {"kind": "compare", "period_id": facts.get("id"),
                               "prior_period_id": compare_to}})
    else:
        out.append({"key": "add_prior_year", "label": dict(labels["add_prior_year"]["label"]),
                    "target": {"kind": "upload", "org_id": facts.get("org_id"),
                               "period_end": S.year_back(facts.get("period_end"))}})
    # Ruling R4 (owner, 2026-09-28): "Exportă raportul pentru bancă" is the
    # CFO Report PDF — the dashboard's export tab, whose PDF card posts the
    # report to the renderer (/api/report/pdf) — and never the Forecast page,
    # whatever the Forecast feature's status. The Forecast cockpit's own bank
    # export is reachable from the Forecast page only.
    out.append({"key": "bank_export", "label": dict(labels["bank_export"]["label"]),
                "target": {"kind": "report_pdf", "route": "/dashboard", "tab": "export",
                           "period_id": facts.get("id")}})
    if isinstance(sector_reason, Mapping) and sector_reason.get("code") == "caen_absent":
        out.append({"key": "set_industry", "label": dict(labels["set_industry"]["label"]),
                    "target": {"kind": "route", "route": "/benchmark",
                               "period_id": facts.get("id")}})
    return out


# ── THE composer ────────────────────────────────────────────────────────


def compose_attention(current_payload: Mapping[str, Any], *,
                      prior: Mapping[str, Any],
                      comparatives: Optional[Mapping[str, Any]] = None,
                      comparatives_reason: Optional[Mapping[str, Any]] = None,
                      sector: Optional[Mapping[str, Any]] = None,
                      pack: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
    """The attention/1 document.

    `prior` is the route's answer to "which period is the comparison"
    (`engine.api._attention.resolve_prior`): {rule, requested, status
    (found | absent | off), period_id, period_start, period_end, reason,
    available_period_id, available_period_end}. `comparatives` is the served
    comparatives document for that pair (None when there is no pair or it
    was refused, with `comparatives_reason`). `sector` is the served
    sector-benchmark document. No action reads a feature's status (ruling
    R4, 2026-09-28): the bank report is the CFO Report PDF whether or not the
    Forecast feature is on."""
    pack = pack or load_pack()
    facts = S.period_facts(current_payload)
    prior = dict(prior or {})
    usable_cmp = isinstance(comparatives, Mapping) and isinstance(comparatives.get("columns"), list)
    mode = "with_prior" if usable_cmp else "single_period"

    # WHICH WAY TIME RUNS, as the comparatives document says it. Withheld:
    # no statement line carries a verdict, no ratio-band candidate is read
    # (its item says "improved"), and the improvement slot has no pool.
    withheld = verdicts_withheld_of(comparatives) if usable_cmp else None
    statement = _statement_candidates(pack, current_payload, comparatives) if usable_cmp else []
    ratio = (_ratio_candidates(pack, current_payload, comparatives)
             if usable_cmp and withheld is None else [])
    sector_ok, sector_reason = _sector_state(sector)
    sector_cands = _sector_candidates(pack, sector)
    insight_cands, insights_reason = ((_insight_candidates(pack, current_payload))
                                      if mode == "single_period" else ([], None))

    used_identities = set()  # type: set
    items = []  # type: List[Dict[str, Any]]
    unfilled = []  # type: List[Dict[str, Any]]
    deduped = []  # type: List[Dict[str, Any]]

    def take(pool: Sequence[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        for cand in pool:
            if cand.get("_taken"):
                continue
            if cand["identity"] in used_identities:
                deduped.append({"family": cand["family"], "key": cand["key"],
                                "identity": cand["identity"],
                                "reason": "identity_already_shown"})
                cand["_taken"] = True
                continue
            cand["_taken"] = True
            used_identities.add(cand["identity"])
            return cand
        return None

    movement_pool = _by_share(statement)
    improved_statement_pool = [c for c in _by_share(statement) if c.get("verdict") == "improved"]
    ratio_pool = [c for c in ratio if c["eligible"]]
    sector_pool = _by_distance(sector_cands)
    finding_pool = [c for c in insight_cands if c["eligible"]]

    for slot in pack["slots"][mode]:
        if len(items) >= pack["max_items"]:
            break
        cand = None
        why = None
        if slot == "movement":
            cand = take(movement_pool)
            why = None if cand else _reason("no_material_statutory_movement",
                                            "floor=%s" % MATERIALITY_FLOOR)
            if cand:
                items.append(_statement_item(slot, cand, comparatives, prior))
        elif slot == "worst_vs_sector":
            cand = take(sector_pool)
            if cand:
                items.append(_sector_item(slot, cand, pack, sector))
            else:
                why = sector_reason if not sector_ok else _reason("no_ratio_worse_than_sector")
        elif slot == "improvement" and withheld is not None:
            # Nothing is an improvement under a comparison that serves no
            # verdict: the slot is empty and says why.
            why = _reason("verdicts_withheld", withheld)
        elif slot == "improvement":
            for family in pack["improvement_family_order"]:
                pool = improved_statement_pool if family == "statement_line" else ratio_pool
                cand = take(pool)
                if cand:
                    items.append(_statement_item(slot, cand, comparatives, prior)
                                 if family == "statement_line"
                                 else _ratio_item(slot, cand, pack, current_payload))
                    break
            if not cand:
                why = _reason("no_improvement")
        elif slot == "finding":
            cand = take(finding_pool)
            if cand:
                items.append(_insight_item(slot, cand, (S.insights_block(current_payload)
                                                        or {}).get("currency"), current_payload))
            else:
                why = insights_reason or _reason("no_material_finding")
        if cand is None:
            unfilled.append({"slot": slot, "reason": why})

    for rank, item in enumerate(items, start=1):
        item["rank"] = rank

    caveats = []
    if any(i["family"] == "ratio_band" for i in items):
        caveats.append({"key": "restated_comparatives",
                        "text": dict(pack["caveats"]["restated_comparatives"])})
    if mode == "single_period":
        key = "comparison_off" if prior.get("status") == "off" else "single_period"
        caveats.append({"key": key, "text": dict(pack["caveats"][key])})

    cmp_source = {
        "status": "served" if usable_cmp else ("refused" if comparatives_reason else "absent"),
        "prior_period_id": prior.get("period_id") if usable_cmp else None,
        "reason": copy.deepcopy(comparatives_reason) if not usable_cmp else None,
    }
    ins_block = S.insights_block(current_payload)
    return {
        "schema": SCHEMA,
        "period": facts,
        "mode": mode,
        "prior": prior,
        # The credit model's regime for this period (revision 5, owner
        # ruling R1), the served envelope's block verbatim — the command bar
        # prints it ONCE, with its finding. None under the standard model.
        "credit_regime": S.credit_regime(current_payload),
        "items": items,
        "unfilled": unfilled,
        "deduped": deduped,
        "actions": _actions(pack, facts, prior, mode, sector_reason if not sector_ok else None),
        "caveats": caveats,
        "sources": {
            "comparatives": cmp_source,
            "sector_benchmark": {
                "status": "ok" if sector_ok else "refused",
                "reason": copy.deepcopy(sector_reason),
                "caen": (sector or {}).get("caen") if isinstance(sector, Mapping) else None,
                "caen_source": (sector or {}).get("caen_source") if isinstance(sector, Mapping) else None,
                "year": (sector or {}).get("year") if isinstance(sector, Mapping) else None,
                "source": (sector or {}).get("source") if isinstance(sector, Mapping) else None,
            },
            "insights": {
                "status": "served" if ins_block is not None else "absent",
                "schema_version": (ins_block or {}).get("schema_version"),
                "read": mode == "single_period",
            },
            "excluded": list(EXCLUDED_SOURCES),
        },
        "considered": {
            "statement_lines": _considered(statement),
            "sector_rows": _considered(sector_cands),
            "ratio_bands": _considered(ratio),
            "insights": _considered(insight_cands),
        },
        "rules": {
            "slots": copy.deepcopy(pack["slots"]),
            "max_items": pack["max_items"],
            "statement_lines": [l["key"] for l in pack["statement_lines"]],
            "materiality": copy.deepcopy(pack["materiality"]),
            "statement_line_floor": MATERIALITY_FLOOR,
            "improvement_family_order": list(pack["improvement_family_order"]),
            "anchor_statuses": list(pack["anchor_statuses"]),
            "insight_material_levels": list(pack["insights"]["material_levels"]),
            "insights_excluded": copy.deepcopy(pack["insights"].get("excluded") or {}),
            "sector_identities": copy.deepcopy(pack["sector"]["identities"]),
            "sector_position_only": list(pack["sector"]["position_only"]),
            "ratio_inventory_days_keys": list(pack["ratio_band"]["inventory_days_keys"]),
            "inventory_days_claim_policy": copy.deepcopy(
                S.inventory_days(current_payload)["claim_policy"]),
        },
    }
