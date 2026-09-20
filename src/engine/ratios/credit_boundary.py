"""THE CREDIT SERVING BOUNDARY — one function, applied to the credit content
of every response at the moment it leaves the engine (owner, 2026-09-20:
"the credit range gate goes at the serving boundary so no fallback can
bypass it").

`enforce_credit_boundary(payload, surface=...)` is THE chokepoint. It reads
WHATEVER is about to be served — whichever path produced it: the switched
serve-time model, the unswitched persisted rows, a model-failure fallback, a
cache — and applies the pack-declared range law (R-RANGE, absolute):

    sub-scores and the composite   inside the pack range (`ranges.subscore`,
                                   `ranges.composite`)
    Altman X1, X4                  at or below their pack maxima
    Altman Z''                     at or below the bound derived from the
                                   SAME payload's X2 and X3 (no X2/X3 beside
                                   it -> unread -> not served)
    every figure                   a finite number

A figure that fails is WITHHELD with `{code: credit_out_of_range, inputs}`,
its dependents go with it (the component's sub-score, Z'' and its zone, the
composite and the letter - R-COMPOSITE, never renormalised), and it is
listed in `withdrawn` with the value it would have been served at. Nothing
downstream mints a zone or a letter from a withheld figure.

It finds credit content BY SHAPE, not by path, so a new key that carries a
credit envelope is gated without being registered here:

    envelope      a dict with `altman_components`   (assembled_metrics.credit)
    block         a dict with `altman.z` + `subscores`  (ratio_table.credit,
                  comparatives `ratios.credit.current|prior`)
    metric rows   a list of `{name, value}` rows carrying a credit-family
                  name   (metrics, credit_metrics_as_filed, prior_metrics,
                  the narrator's `metrics`)
    compare rows  `{key, current, prior}` for altman_z, credit_composite,
                  letter_grade and credit_subscore_*   (comparatives)

On GET /api/period the boundary also COMPOSES the `basis: as_filed`
envelope: the route hands it the persisted rows untouched and the whole law
(`credit_model.withhold_persisted`: range, the model's own domain, no
composite beside a refused component) is applied here and nowhere earlier.
Bypass this function and the route serves the persisted rows raw - which is
what tests/engine/test_credit_boundary.py plants and proves RED.

FAILS CLOSED. A pack that cannot be read, or any exception inside the
boundary, withholds the WHOLE credit family from the payload
(`credit_inputs_absent`): an unchecked figure is never served because the
check broke.

The per-path checks (`credit_block`, `withhold_persisted`,
`lawful_persisted_rows`) stay; this function is the authority and is what
the `credit-boundary` battery gate tests.
"""
from __future__ import annotations

import logging
import math
from typing import Any, Dict, List, Mapping, Optional, Tuple

from . import credit_model as CM
from .credit_pack import CREDIT_PACK_FILE, CreditPackError

logger = logging.getLogger(__name__)

#: Every surface that serves credit content. A route that serves credit
#: figures and is not named here is a defect (test_credit_boundary.py reads
#: the source tree for readers of the credit family outside this list).
SURFACES: Tuple[str, ...] = ("period", "comparatives", "narrate_payload")

#: Keys the walk never descends into: large, and never credit content.
_SKIP_KEYS = frozenset({"line_items", "prior_line_items", "statements", "prior_statements", "lineItems"})

_COMPONENTS = ("x1", "x2", "x3", "x4")
_SUBSCORE_NAMES = {name: key for key, name in CM.CREDIT_SUBSCORE_METRICS}
_FAMILY = frozenset(CM.CREDIT_FAMILY_METRICS) - {CM.CREDIT_MODEL_REVISION_METRIC}
_COMPARE_KEYS = frozenset({"altman_z", "credit_composite", "letter_grade"}
                          | {"credit_subscore_%s" % k for k, _n in CM.CREDIT_SUBSCORE_METRICS})


# ── the range law over one set of figures ────────────────────────────────────


def _is_figure(v: Any) -> bool:
    return v is not None


def _lawful_number(v: Any) -> Any:
    """`v` as the law reads it: a non-number where a figure belongs is not a
    figure that was read against a range, so it is read as NaN (which no
    range admits) rather than skipped as absent."""
    if v is None:
        return None
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return float("nan")
    return float(v)


def _json_value(v: Any) -> Any:
    """The withheld value as it may be printed in `withdrawn` (JSON has no
    NaN or infinity)."""
    if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v):
        return v
    return None


#: `breaches` key under which `range_law` reports a composite served beside
#: components that did not score (R-COMPOSITE held BY SHAPE): the value is
#: the comma-joined component keys.
BESIDE_UNSCORED = "composite_beside_unscored"


def _unscored_components(rows_by_name: Mapping[str, Any], checked: Mapping[str, Any],
                         refused: Optional[Mapping[str, Any]]) -> List[str]:
    """Components that did not score, read off the shape being served: a
    sub-score row that is PRESENT and null (as filed or as just withheld),
    or a component listed in the payload's own `refused_subscores`. An
    absent row says nothing (revision-1 rows carry no sub-score rows at
    all; `withhold_persisted` holds those to the law over the statements)."""
    out = [key for key, name in CM.CREDIT_SUBSCORE_METRICS
           if name in rows_by_name and checked.get(name) is None]
    for key in (refused or {}):
        if key in CM.CREDIT_COMPOSITE_WEIGHTS and key not in out:
            out.append(key)
    return [k for k in CM.CREDIT_COMPOSITE_WEIGHTS if k in out]


def range_law(rows_by_name: Mapping[str, Any], refused: Optional[Mapping[str, Any]] = None
              ) -> Tuple[Dict[str, Any], Dict[str, str], List[Dict[str, Any]]]:
    """`(checked, breaches, withdrawn)` for one set of credit figures keyed
    by their `calculated_metrics` names. `breaches` is `{component or
    "composite": the figure that left its range}`; `withdrawn` names every
    figure that was present and is withheld, with the value it carried.

    R-COMPOSITE IS HELD HERE TOO, BY SHAPE: a composite that is present
    beside a sub-score that is present-and-null, or beside a component the
    payload itself lists as refused (`refused`), is withheld with
    `credit_component_undefined` - whatever composed it (a renormalising
    model planted in compute_period_metrics let credit_composite 97.5 out in
    metrics[] past a boundary that read ranges only). `breaches` then
    carries `BESIDE_UNSCORED: "<component>,<component>"`."""
    given = {k: _lawful_number(v) for k, v in rows_by_name.items()}
    checked, bad = CM.withhold_out_of_range(given)
    bad = dict(bad)
    withdrawn: List[Dict[str, Any]] = []
    unscored = _unscored_components(rows_by_name, checked, refused)
    beside = bool(unscored) and rows_by_name.get("credit_composite") is not None \
        and checked.get("credit_composite") is not None
    if beside:
        checked["credit_composite"] = None
        bad[BESIDE_UNSCORED] = ",".join(unscored)
    if not bad:
        return dict(rows_by_name), {}, withdrawn
    for name in CM.CREDIT_FAMILY_METRICS:
        if name not in rows_by_name or rows_by_name[name] is None or checked.get(name) is not None:
            continue
        if name == "credit_composite" and beside:
            withdrawn.append({
                "figure": name, "value": _json_value(rows_by_name[name]),
                "as_served": repr(rows_by_name[name]),
                "code": CM.CREDIT_COMPONENT_UNDEFINED,
                "inputs": ["credit_model.%s" % k for k in unscored],
                "text": "withheld at the serving boundary: a composite was about to be served beside "
                        "component(s) that did not score (%s); the model's weights are never "
                        "redistributed (%s)" % (", ".join(unscored), CREDIT_PACK_FILE),
            })
            continue
        key = ("composite" if name == "credit_composite"
               else "altman" if name.startswith("altman_") else _SUBSCORE_NAMES.get(name))
        ranged = {k: v for k, v in bad.items() if k != BESIDE_UNSCORED}
        cause = ranged.get(key) or next(iter(ranged.values()))
        withdrawn.append({
            "figure": name, "value": _json_value(rows_by_name[name]),
            "as_served": repr(rows_by_name[name]),
            "code": CM.CREDIT_OUT_OF_RANGE, "inputs": [cause],
            "text": "withheld at the serving boundary: %s lies outside its declared range or is not a "
                    "finite number (%s)" % (cause, CREDIT_PACK_FILE),
        })
    out = dict(rows_by_name)
    for name in out:
        if name in CM.CREDIT_FAMILY_METRICS and name != CM.CREDIT_MODEL_REVISION_METRIC:
            out[name] = None if checked.get(name) is None else rows_by_name[name]
    return out, bad, withdrawn


def _refusals_for(bad: Mapping[str, str], refused: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    out = dict(refused or {})
    for key, figure in bad.items():
        if key == BESIDE_UNSCORED:
            for comp in figure.split(","):
                if comp and comp not in out:
                    out[comp] = CM.subscore_refusal(comp)
        elif key != "composite" and key not in out:
            out[key] = CM.subscore_refusal(key, CM.CREDIT_OUT_OF_RANGE, figure)
    return out


def _reason_for(bad: Mapping[str, str], refused: Mapping[str, Any]) -> Dict[str, Any]:
    if refused:
        return CM.composite_refusal(dict(refused))
    return CM.composite_out_of_range_refusal(None)


# ── shapes ───────────────────────────────────────────────────────────────────


def _envelope_rows(env: Mapping[str, Any]) -> Dict[str, Any]:
    comps = env.get("altman_components") if isinstance(env.get("altman_components"), Mapping) else {}
    subs = env.get("subscores") if isinstance(env.get("subscores"), Mapping) else {}
    rows: Dict[str, Any] = {"altman_z_score": env.get("altman_z_score"),
                            "credit_composite": env.get("composite_score")}
    for x in _COMPONENTS:
        rows["altman_%s" % x] = comps.get(x)
    for key, name in CM.CREDIT_SUBSCORE_METRICS:
        if key in subs:
            rows[name] = subs.get(key)
    return rows


def _listed_refusals(node: Mapping[str, Any]) -> Dict[str, Any]:
    r = node.get("refused_subscores")
    return dict(r) if isinstance(r, Mapping) else {}


def _check_envelope(env: Dict[str, Any]) -> List[Dict[str, Any]]:
    """`assembled_metrics.credit`. Returns what was withdrawn."""
    checked, bad, withdrawn = range_law(_envelope_rows(env), _listed_refusals(env))
    if bad:
        env["altman_z_score"] = checked["altman_z_score"]
        if isinstance(env.get("altman_components"), dict):
            for x in _COMPONENTS:
                env["altman_components"][x] = checked["altman_%s" % x]
        if isinstance(env.get("subscores"), dict):
            for key, name in CM.CREDIT_SUBSCORE_METRICS:
                if key in env["subscores"]:
                    env["subscores"][key] = checked[name]
        env["composite_score"] = None
        env["refused_subscores"] = _refusals_for(bad, _listed_refusals(env))
        env["reason"] = _reason_for(bad, env["refused_subscores"])
        env["withdrawn"] = list(env.get("withdrawn") or []) + withdrawn
    # dependents: no zone without a Z'', no letter without a composite
    if env.get("altman_z_score") is None and env.get("altman_zone") is not None:
        env["altman_zone"] = None
    if env.get("composite_score") is None and env.get("letter_grade") is not None:
        env["letter_grade"] = None
    if any(_is_figure(v) for v in _envelope_rows(env).values()) and not isinstance(env.get("ranges"), Mapping):
        # a figure is never served without the range it was read against
        comps = env.get("altman_components") or {}
        env["ranges"] = CM.credit_ranges(CM._num(comps.get("x2")), CM._num(comps.get("x3")))
    comps_now = env.get("altman_components") if isinstance(env.get("altman_components"), Mapping) else {}
    _check_as_filed(env.get("as_filed"), comps_now.get("x2"), comps_now.get("x3"))
    return withdrawn


def _block_rows(block: Mapping[str, Any]) -> Dict[str, Any]:
    alt = block.get("altman") if isinstance(block.get("altman"), Mapping) else {}
    subs = block.get("subscores") if isinstance(block.get("subscores"), Mapping) else {}
    rows: Dict[str, Any] = {"altman_z_score": alt.get("z"), "credit_composite": block.get("composite")}
    for x in _COMPONENTS:
        rows["altman_%s" % x] = alt.get(x)
    for key, name in CM.CREDIT_SUBSCORE_METRICS:
        if key in subs:
            rows[name] = subs.get(key)
    return rows


def _check_block(block: Dict[str, Any]) -> List[Dict[str, Any]]:
    """`ratio_table.credit` and the comparatives' `ratios.credit.*`."""
    checked, bad, withdrawn = range_law(_block_rows(block), _listed_refusals(block))
    alt = block.get("altman") if isinstance(block.get("altman"), dict) else None
    if bad:
        if alt is not None:
            alt["z"] = checked["altman_z_score"]
            for x in _COMPONENTS:
                alt[x] = checked["altman_%s" % x]
        if isinstance(block.get("subscores"), dict):
            for key, name in CM.CREDIT_SUBSCORE_METRICS:
                if key in block["subscores"]:
                    block["subscores"][key] = checked[name]
        block["composite"] = None
        block["refused_subscores"] = _refusals_for(bad, _listed_refusals(block))
        block["reason"] = _reason_for(bad, block["refused_subscores"])
        block["withdrawn"] = list(block.get("withdrawn") or []) + withdrawn
        if isinstance(block.get("declared_rungs"), dict):
            for key in bad:
                if key != BESIDE_UNSCORED:
                    block["declared_rungs"].pop(key, None)
    if alt is not None and alt.get("z") is None and alt.get("zone") is not None:
        alt["zone"] = None
    if block.get("composite") is None and block.get("letter") is not None:
        block["letter"] = None
    _check_as_filed(block.get("as_filed"), (alt or {}).get("x2"), (alt or {}).get("x3"))
    return withdrawn


def _check_as_filed(filed: Any, x2: Any = None, x3: Any = None) -> None:
    """The as-filed disclosure inside an envelope or a block: `{composite,
    altman_z, letter, withdrawn}`. The composite is read against its range.
    The filed Z'' is read against the bound derived from the X2 and X3 the
    SAME envelope or block serves (`x2`, `x3`) - the only components the
    boundary can see beside it; with none beside it the figure is unread
    and an unread figure is not served (a filed 1584.89 once passed here on
    a finiteness check alone)."""
    if not isinstance(filed, dict):
        return
    out: List[Dict[str, Any]] = []
    c = filed.get("composite")
    if c is not None and CM.score_out_of_range(_lawful_number(c), "composite"):
        out.append({"figure": "credit_composite", "value": _json_value(c), "code": CM.CREDIT_OUT_OF_RANGE,
                    "inputs": ["credit_composite"],
                    "text": "withheld at the serving boundary: the filed composite lies outside its declared range"})
        filed["composite"] = None
    z = filed.get("altman_z")
    if z is not None and CM.altman_out_of_range(None, CM._num(x2), CM._num(x3), None, _lawful_number(z)):
        out.append({"figure": "altman_z_score", "value": _json_value(z), "code": CM.CREDIT_OUT_OF_RANGE,
                    "inputs": ["altman_z_score"],
                    "text": "withheld at the serving boundary: the filed Z'' is not a finite number inside "
                            "the bound derived from the X2 and X3 served beside it (%s)" % CREDIT_PACK_FILE})
        filed["altman_z"] = None
    if filed.get("composite") is None and filed.get("letter") is not None:
        filed["letter"] = None
    if out:
        filed["withdrawn"] = list(filed.get("withdrawn") or []) + out


def _is_metric_rows(v: Any) -> bool:
    return isinstance(v, list) and any(
        isinstance(r, dict) and r.get("name") in _FAMILY and "value" in r for r in v)


def _check_metric_rows(rows: List[Any]) -> List[Dict[str, Any]]:
    """EVERY row of a name is read, not the last one: `calculated_metrics`
    has no unique (period_id, name) constraint, and a by-name dict let an
    exploded FIRST row out behind a lawful second. Layer i holds the i-th
    occurrence of each name (the last one where a name has fewer); a name
    withheld in any layer is withheld on every row that carries it."""
    occurrences: Dict[str, List[Any]] = {}
    for r in rows:
        if isinstance(r, dict) and isinstance(r.get("name"), str):
            occurrences.setdefault(r["name"], []).append(r.get("value"))
    depth = max([len(v) for v in occurrences.values()] or [0])
    named: Dict[str, Dict[str, Any]] = {}
    for i in range(depth):
        layer = {name: vals[min(i, len(vals) - 1)] for name, vals in occurrences.items()}
        _checked, bad, withdrawn = range_law(layer)
        if bad:
            for w in withdrawn:
                named.setdefault(w["figure"], w)
    if not named:
        return []
    for r in rows:
        if isinstance(r, dict) and r.get("name") in named and r.get("value") is not None:
            w = named[r["name"]]
            r["withheld"] = {"code": w["code"], "inputs": list(w["inputs"]), "value": _json_value(r["value"])}
            r["value"] = None
    return list(named.values())


def _is_compare_row(v: Any) -> bool:
    return (isinstance(v, dict) and v.get("key") in _COMPARE_KEYS
            and isinstance(v.get("current"), dict) and isinstance(v.get("prior"), dict))


def _compare_side_breach(key: str, side: Mapping[str, Any]) -> Optional[str]:
    """The figure of one comparatives side that fails the law, or None."""
    v = side.get("value")
    if v is None:
        return None
    if key == "altman_z":
        rows = {"altman_z_score": v}
        for op in side.get("operands") or []:
            if isinstance(op, Mapping) and op.get("name") in _COMPONENTS:
                rows["altman_%s" % op["name"]] = op.get("value")
        _c, bad, _w = range_law(rows)
        return bad.get("altman")
    which = "subscore" if key.startswith("credit_subscore_") else "composite"
    if CM.score_out_of_range(_lawful_number(v), which):
        return "credit_composite" if which == "composite" else key
    return None


#: A breach on the key (left) takes these rows of the SAME side with it.
_COMPARE_DEPENDENTS = {"altman_z": ("credit_subscore_altman",)}


def _check_compare_rows(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The comparatives' composite and sub-score rows - ALL of one
    document's credit compare rows together, whichever lists they sit in. A
    side that fails the law refuses; any breach takes that side's composite
    and letter with it, and an Altman breach takes that side's Altman
    sub-score too; the row's delta and movement are re-read over the
    refused side, so no movement is minted from a withheld figure."""
    from engine.comparatives import ratio_compare as RC  # lazy: RC imports credit_model

    withdrawn: List[Dict[str, Any]] = []
    broken: Dict[str, Dict[str, str]] = {}
    for row in rows:
        for which in ("current", "prior"):
            figure = _compare_side_breach(row["key"], row[which])
            if figure is not None:
                broken.setdefault(which, {})[row["key"]] = figure
    if not broken:
        return withdrawn
    for row in rows:
        touched = False
        for which, figures in broken.items():
            side = row[which]
            own = figures.get(row["key"])
            cause = own
            if cause is None and side.get("value") is not None:
                if row["key"] in ("credit_composite", "letter_grade"):
                    cause = next(iter(figures.values()))
                else:
                    cause = next((figures[k] for k, deps in _COMPARE_DEPENDENTS.items()
                                  if k in figures and row["key"] in deps), None)
            if cause is None:
                continue
            withdrawn.append({"figure": "%s.%s" % (row["key"], which), "value": _json_value(side.get("value")),
                              "as_served": repr(side.get("value")), "code": CM.CREDIT_OUT_OF_RANGE,
                              "inputs": [cause],
                              "text": "withheld at the serving boundary: %s lies outside its declared range "
                                      "(%s)" % (cause, CREDIT_PACK_FILE)})
            row[which] = {"value": None, "value_q": None, "band": None, "band_status": "refused",
                          "ladder": None, "ladder_floor": None, "operands": [],
                          "reason": {"code": CM.CREDIT_OUT_OF_RANGE, "inputs": [cause]}}
            touched = True
        if touched:
            row["delta"] = RC._delta(row["current"], row["prior"], row["display_unit"], row["higher_is_better"])
            row["movement"] = RC._not_comparable(RC._ungraded_code(row["current"], row["prior"])
                                                 or CM.CREDIT_OUT_OF_RANGE)
            row["finding_id"] = None
    return withdrawn


def _compare_rows_under(node: Mapping[str, Any]) -> List[Dict[str, Any]]:
    """Every credit compare row in the list-valued children of one dict
    (the comparatives' `ratios.composites` and `ratios.subscores` are
    siblings: a breach in one must reach the other)."""
    out: List[Dict[str, Any]] = []
    for k, v in node.items():
        if k not in _SKIP_KEYS and isinstance(v, list):
            out += [r for r in v if _is_compare_row(r)]
    return out


#: (a) An envelope is recognised by ANY key only an envelope carries, not
#: by `altman_components` alone: `{composite_score: 250, letter_grade: AAA,
#: altman_z_score: 1584.89}` once walked through unread.
_ENVELOPE_KEYS = ("altman_components", "composite_score", "altman_z_score", "letter_grade")


def _is_envelope(node: Mapping[str, Any]) -> bool:
    return any(k in node for k in _ENVELOPE_KEYS)


def _walk(node: Any, withdrawn: List[Dict[str, Any]], where: str) -> None:
    if isinstance(node, dict):
        if _is_envelope(node):
            withdrawn += [dict(w, where=where) for w in _check_envelope(node)]
        elif isinstance(node.get("altman"), dict) and "z" in node["altman"] and "subscores" in node:
            withdrawn += [dict(w, where=where) for w in _check_block(node)]
        compare = _compare_rows_under(node)
        if compare:
            withdrawn += [dict(w, where=where) for w in _check_compare_rows(compare)]
        for k, v in node.items():
            if k in _SKIP_KEYS:
                continue
            _walk(v, withdrawn, "%s.%s" % (where, k) if where else str(k))
    elif isinstance(node, list):
        if _is_metric_rows(node):
            withdrawn += [dict(w, where=where) for w in _check_metric_rows(node)]
        compare = [r for r in node if _is_compare_row(r)]
        if compare:
            # idempotent: a side already refused under its parent dict has no value left to breach
            withdrawn += [dict(w, where=where) for w in _check_compare_rows(compare)]
        for i, v in enumerate(node):
            if isinstance(v, (dict, list)) and not _is_compare_row(v):
                _walk(v, withdrawn, "%s[%d]" % (where, i))


# ── the unswitched period: the as-filed envelope is composed HERE ────────────


def as_filed_envelope(metric_rows: List[Mapping[str, Any]], statements: Mapping[str, Any]
                      ) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """`(envelope, checked_by_name)`: the `basis: as_filed` credit envelope
    of a period whose serve-time model did not run, read off the PERSISTED
    rows under the whole law (`credit_model.withhold_persisted`), and those
    rows' lawful values (what `metrics[]` may carry)."""
    filed = {m["name"]: m.get("value") for m in metric_rows
             if isinstance(m, Mapping) and isinstance(m.get("name"), str)}
    checked, refused, withdrawn = CM.withhold_persisted(filed, statements)

    def m(name: str) -> Any:
        return checked.get(name) if name in filed else None

    composite = m("credit_composite")
    env: Dict[str, Any] = {
        "altman_z_score": m("altman_z_score"),
        "altman_variant": "Z\"",
        "altman_components": {x: m("altman_%s" % x) for x in _COMPONENTS},
        "composite_score": composite,
        "letter_grade": None if composite is None else CM.composite_to_letter_grade(float(composite)),
        "letter_grade_bands": CM.letter_grade_bands(),
        "composite_weights": dict(CM.CREDIT_COMPOSITE_WEIGHTS),
        "refused_subscores": refused,
        "reason": CM.credit_reason(checked, refused, composite) if metric_rows else None,
        "ranges": CM.credit_ranges(CM._num(checked.get("altman_x2")), CM._num(checked.get("altman_x3"))),
        "withdrawn": withdrawn,
        "basis": "as_filed",
        "subscores": {key: m(name) for key, name in CM.CREDIT_SUBSCORE_METRICS},
    }
    return env, checked


def refused_envelope(why: str, basis: str = "as_filed") -> Dict[str, Any]:
    """The envelope of a period whose credit content cannot be checked: no
    figure, no zone, no letter, and the reason."""
    return {
        "altman_z_score": None, "altman_variant": "Z\"",
        "altman_components": {x: None for x in _COMPONENTS},
        "composite_score": None, "letter_grade": None, "letter_grade_bands": None,
        "composite_weights": dict(CM.CREDIT_COMPOSITE_WEIGHTS),
        "refused_subscores": {},
        "reason": {"code": CM.CREDIT_INPUTS_ABSENT, "inputs": [CREDIT_PACK_FILE],
                   "text": "No credit score: %s" % why},
        "ranges": None, "withdrawn": [], "basis": basis,
        "subscores": {key: None for key, _n in CM.CREDIT_SUBSCORE_METRICS},
    }


def _compose_unswitched_period(body: Dict[str, Any]) -> None:
    am = body.get("assembled_metrics")
    if not isinstance(am, dict):
        return
    env = am.get("credit")
    if not (isinstance(env, dict) and env.get("basis") == "as_filed" and "altman_components" not in env):
        return
    rows = body.get("metrics") if isinstance(body.get("metrics"), list) else []
    envelope, checked = as_filed_envelope(rows, body.get("statements") or {})
    am["credit"] = envelope
    for r in rows:
        if isinstance(r, dict) and r.get("name") in _FAMILY and r.get("value") != checked.get(r["name"]):
            r["value"] = checked.get(r["name"])


def _lawful_as_filed_rows(body: Dict[str, Any]) -> List[Dict[str, Any]]:
    """`credit_metrics_as_filed` on a switched period: the persisted rows
    the serve-time model replaced. They are EVIDENCE, and they are still
    rows in a served body - so they are held to the whole law over this
    period's statements, exactly as the unswitched envelope is (revision 1
    filed liquidity 0.0 on a book with no current liabilities: in range,
    and not a score). A row the law does not allow is served as a record:
    `value: None, withheld: {code, inputs, value}`."""
    rows = body.get("credit_metrics_as_filed")
    if not isinstance(rows, list) or not isinstance(body.get("statements"), Mapping):
        return []
    filed = {r["name"]: r.get("value") for r in rows if isinstance(r, dict) and isinstance(r.get("name"), str)}
    _checked, _refused, withdrawn = CM.withhold_persisted(filed, body["statements"])
    named = {w["figure"]: w for w in withdrawn}
    for r in rows:
        w = named.get(r.get("name")) if isinstance(r, dict) else None
        if w is not None:
            r["value"] = None
            r["withheld"] = {"code": w["code"], "inputs": [w["figure"]], "value": _json_value(w["value"]),
                             "text": w["text"]}
    return [dict(w, where="credit_metrics_as_filed") for w in withdrawn]


# ── fail closed ──────────────────────────────────────────────────────────────


def _withhold_everything(node: Any, why: str) -> None:
    """No check could run: every credit figure in the payload is withheld."""
    if isinstance(node, dict):
        if _is_envelope(node) or (node.get("basis") == "as_filed" and "composite_weights" not in node):
            basis = node.get("basis") or "as_filed"
            node.clear()
            node.update(refused_envelope(why, basis))
            return
        if isinstance(node.get("altman"), dict) and "z" in node["altman"] and "subscores" in node:
            for x in ("z",) + _COMPONENTS + ("zone",):
                node["altman"][x] = None
            node["subscores"] = {k: None for k in (node.get("subscores") or {})}
            node["composite"] = node["letter"] = node["as_filed"] = None
            node["declared_rungs"] = {}
            node["reason"] = refused_envelope(why)["reason"]
            return
        if _is_compare_row(node):
            for which in ("current", "prior"):
                node[which] = {"value": None, "value_q": None, "band": None, "band_status": "refused",
                               "ladder": None, "ladder_floor": None, "operands": [],
                               "reason": {"code": CM.CREDIT_INPUTS_ABSENT, "inputs": [CREDIT_PACK_FILE]}}
            node["delta"] = {"value": None, "unit": None, "pct_change": None, "favourable": None,
                             "reason_code": "both_refused"}
            node["movement"] = {"status": "not_comparable", "from": None, "to": None, "rungs_crossed": 0,
                                "rung_crossed": None, "distance_past_rung": None, "band_width": None,
                                "band_width_basis": None, "distance_fraction": None, "materiality": None,
                                "reason_code": "both_refused"}
            node["finding_id"] = None
            return
        for k, v in node.items():
            if k not in _SKIP_KEYS:
                _withhold_everything(v, why)
    elif isinstance(node, list):
        for r in node:
            if isinstance(r, dict) and r.get("name") in _FAMILY and "value" in r:
                r["value"] = None
            elif isinstance(r, (dict, list)):
                _withhold_everything(r, why)


# ── THE function ─────────────────────────────────────────────────────────────


def enforce_credit_boundary(payload: Any, *, surface: str) -> Any:
    """Apply the range law to the credit content of `payload`, IN PLACE,
    and return it. Call this on the object a route is about to return, and
    on nothing earlier. `surface` is one of `SURFACES`.

    A period body gains `credit_boundary: {surface, withdrawn}` only when
    the boundary withheld something the producing path had let through -
    on a healthy response it changes nothing."""
    if surface not in SURFACES:
        raise ValueError("unknown credit surface %r (known: %s)" % (surface, ", ".join(SURFACES)))
    withdrawn: List[Dict[str, Any]] = []
    try:
        if surface == "period" and isinstance(payload, dict):
            _compose_unswitched_period(payload)
            withdrawn += _lawful_as_filed_rows(payload)
        _walk(payload, withdrawn, "")
    except CreditPackError as exc:
        logger.error("[credit boundary] credit pack unusable on %s; the credit family is withheld: %s",
                     surface, exc)
        _withhold_everything(payload, "the credit model's pack cannot be read (%s)." % exc)
        return payload
    except Exception:  # noqa: BLE001 - fail CLOSED: an unchecked figure is never served
        logger.exception("[credit boundary] the range check failed on %s; the credit family is withheld", surface)
        _withhold_everything(payload, "the served credit figures could not be read against their ranges.")
        return payload
    if withdrawn and isinstance(payload, dict):
        logger.error("[credit boundary] %s: %d figure(s) withheld at the boundary: %s", surface, len(withdrawn),
                     ", ".join("%s@%s" % (w["figure"], w.get("where")) for w in withdrawn))
        payload["credit_boundary"] = {"surface": surface, "code": CM.CREDIT_OUT_OF_RANGE, "withdrawn": withdrawn}
    return payload


def enforce_metric_rows(rows: Any, statements: Mapping[str, Any], *, surface: str = "narrate_payload"
                        ) -> List[Dict[str, Any]]:
    """PERSISTED metric rows about to be handed to a consumer that is not
    the period envelope (the briefing narrator): the whole law over the
    rows (`lawful_persisted_rows`), then the boundary's range law over what
    that left. Returns new rows."""
    try:
        out = CM.lawful_persisted_rows(rows, statements)
    except Exception:  # noqa: BLE001 - fail closed
        logger.exception("[credit boundary] %s: the persisted rows could not be read under the law", surface)
        out = [dict(r) for r in (rows or []) if isinstance(r, dict)]
        _withhold_everything(out, "unreadable")
        return out
    box = {"metrics": out}
    enforce_credit_boundary(box, surface=surface)
    return box["metrics"]
