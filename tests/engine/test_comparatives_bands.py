"""Band crossings as seven-element findings (`engine.api.findings.c_bands`).

REAL BOOKS ONLY. Every pair is two REAL GET /api/period bodies
(`_served_books`: the corpus books through the production write path and
the real router), composed by the real route core
`_comparatives.compare_payloads`. The one planted crossing edits a served
canonical total on one side and nothing else.

WHAT EACH GATE REDS ON, AFTER THE REPAIR (TC-11):

  SURFACES  the planted current_ratio crossing (prior 1.30 watch -> current
      carniprod 1.84 healthy, across the 1.5 rung) not surfacing, its
      `Finding.validate()` returning ANY missing element, its threshold not
      naming rung healthy at 1.5 with a comparator that holds, its evidence
      not citing the prior and the current value under comparison basis
      `prior_period`, its provenance not naming BOTH period ids and BOTH
      snapshot ids (and the snapshot reader disagreeing with
      `_radar.content_hash_of`), its impact not being headroom money whose
      |delta| is the composer's served `materiality.headroom_money`, or
      `ratio_compare` calling into c_bands other than exactly once.
  NO CROSSING, NO FINDING  any finding row whose ratio did not cross (same
      band, not comparable, refused), a finding set that is not exactly
      improved + deteriorated, or a company compared with itself producing
      a finding (its unchanged list must be non-empty).
  DIRECTION  on both orders of the real agras / carniprod pair: a
      lower-is-better crossing listed improved while its value rose (or
      deteriorated while it fell), a finding whose direction or threshold
      comparator disagrees with its list, or fewer than one lower-is-better
      crossing in each direction across the two orders.
  PARTITION  improved + deteriorated + unchanged + not_comparable !=
      coverage.both_sides; a movable entry valued on one side only missing
      from `refused`; a crossing without its finding row (a demoted row
      dropped); the pair no longer carrying a DEMOTED row (without one the
      gate could not see a dropped demotion); a demoted row not carrying its
      missing elements and its check summary.
  DETERMINISM  two compositions over the same bodies serialising to
      different bytes.

WHAT IT CANNOT SEE: whether a surface renders the findings (B6/B7); the
CAEN (the comparatives route passes none, so the profile is inferred from
the account mix — the same inference the single-period lane makes without
one); period length (every served period is 365 days).
"""
from __future__ import annotations

import copy
import json
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Dict, List, Tuple

import pytest

from engine.api import _comparatives as C
from engine.api import _finding as F
from engine.api._radar import content_hash_of
from engine.api.findings import c_bands as CB
from engine.comparatives import ratio_compare as RC
from engine.ratios import table as T

import _served_books as SB


def _rows(name: str, period_id: str) -> Dict[str, Any]:
    return dict(SB.book(name).period, id=period_id)


def _compose(cur_body, pri_body, cur_name, pri_name, monkeypatch=None, calls=None):
    if monkeypatch is not None:
        real = CB.build_band_findings

        def recorder(crossed, **kw):
            calls.append((copy.deepcopy(crossed), dict(kw)))
            return real(crossed, **kw)

        monkeypatch.setattr(C, "build_band_findings", recorder)
    return C.compare_payloads(cur_body, pri_body,
                              current_row=_rows(cur_name, "p-%s-cur" % cur_name),
                              prior_row=_rows(pri_name, "p-%s-pri" % pri_name))["ratios"]


def _planted_prior() -> Dict[str, Any]:
    """agras as the prior, its served current liabilities raised so its
    current ratio is 1.30 (watch). Nothing else is touched."""
    body = copy.deepcopy(SB.served_body("agras"))
    totals = body["statements"]["canonical_bs"]["totals"]
    totals["current_liabilities"] = round(totals["current_assets"] / 1.3, 2)
    return body


# ── 1. the planted crossing surfaces, complete ─────────────────────────────


def test_a_planted_current_ratio_crossing_across_the_1_5_rung_surfaces_with_all_seven(monkeypatch):
    calls: List[Tuple[Any, Any]] = []
    cur = SB.served_body("carniprod")
    pri = _planted_prior()
    out = _compose(cur, pri, "carniprod", "agras", monkeypatch, calls)
    assert len(calls) == 1, "ratio_compare called into c_bands %d times, not once" % len(calls)

    row = {r["key"]: r for r in out["rows"]}["current_ratio"]
    mv = row["movement"]
    assert (row["prior"]["band"], row["current"]["band"], mv["status"]) == ("watch", "healthy", "crossed_up"), mv
    assert mv["rung_crossed"] == {"name": "healthy", "value": "1.5"}, mv
    assert "current_ratio" in out["band_movements"]["improved"]

    crossed, kw = calls[0]
    objects = dict((r["key"], f) for r, f in CB.band_finding_objects(crossed, **kw))
    finding = objects["current_ratio"]
    assert finding.validate() == [], "the planted crossing demotes: %s" % [m.render() for m in finding.validate()]

    served = {f["ratio_key"]: f for f in out["band_movements"]["findings"]}["current_ratio"]
    assert served["surfaced"] is True and served["missing_elements"] == []
    assert row["finding_id"] == served["finding_id"] == "band_current_ratio:watch->healthy"
    assert served["direction"] == "improved" and served["severity"] == "low"

    t = finding.threshold
    assert (t.rule_id, t.parameter, t.limit, t.comparator) == ("band_current_ratio", "healthy", 1.5, ">=")
    assert t.holds() and t.observed == row["current"]["value"]
    ev = finding.evidence
    assert ev.comparison_basis.kind == "prior_period"
    assert [fg.value for fg in ev.figures] == [row["prior"]["value"], row["current"]["value"]]
    cur_row, pri_row = _rows("carniprod", "p-carniprod-cur"), _rows("agras", "p-agras-pri")
    p = ev.provenance
    assert (p.period_id, p.prior_period_id) == ("p-carniprod-cur", "p-agras-pri"), p
    assert p.snapshot_id and p.prior_snapshot_id and p.snapshot_id != p.prior_snapshot_id, p
    assert (p.snapshot_id, p.prior_snapshot_id) == (content_hash_of(cur_row), content_hash_of(pri_row))
    assert (C.snapshot_id_of(cur_row), C.snapshot_id_of(pri_row)) == (content_hash_of(cur_row),
                                                                     content_hash_of(pri_row))
    assert "vs period p-agras-pri, snapshot %s" % p.prior_snapshot_id in served["body"]

    imp = finding.impact
    assert imp.kind == "headroom" and imp.unit == F.UNIT_MONEY
    assert (imp.baseline_fact, imp.adjusted_fact) == (CB.MONEY_AT_RUNG, CB.MONEY_HELD)
    headroom = Decimal(repr(abs(imp.delta))).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    assert format(headroom, "f") == mv["materiality"]["headroom_money"], (imp.delta, mv["materiality"])
    assert all(step.lead_verb() in F.IMPERATIVE_VERBS for step in finding.action.steps)
    assert served["so_what"]["placeholders"]["rung_value"] == "1.5"


# ── 2. no crossing, no finding ─────────────────────────────────────────────


@pytest.mark.parametrize("cur_name,pri_name", [("agras", "carniprod"), ("carniprod", "agras")])
def test_a_ratio_that_did_not_cross_produces_no_finding(cur_name, pri_name):
    out = _compose(SB.served_body(cur_name), SB.served_body(pri_name), cur_name, pri_name)
    bm = out["band_movements"]
    finding_keys = [f["ratio_key"] for f in bm["findings"]]
    assert sorted(finding_keys) == sorted(bm["improved"] + bm["deteriorated"])
    assert len(finding_keys) == len(set(finding_keys))
    quiet = {e["key"] for e in bm["unchanged"]} | {e["key"] for e in bm["not_comparable"]} \
        | {e["key"] for e in bm["refused"]}
    assert quiet and not quiet & set(finding_keys), sorted(quiet & set(finding_keys))
    for r in out["rows"] + out["composites"]:
        if not r["movement"]["status"].startswith("crossed"):
            assert r["finding_id"] is None, r["key"]


def test_a_company_compared_with_itself_produces_no_finding():
    body = SB.served_body("agras")
    out = _compose(body, copy.deepcopy(body), "agras", "agras")
    bm = out["band_movements"]
    assert bm["findings"] == [] and bm["improved"] == [] and bm["deteriorated"] == []
    assert len(bm["unchanged"]) >= 15, bm["unchanged"]


# ── 3. lower-is-better crossings classify by direction ─────────────────────


def test_a_lower_is_better_crossing_is_classified_by_direction():
    seen = {"improved": 0, "deteriorated": 0}
    for cur_name, pri_name in (("agras", "carniprod"), ("carniprod", "agras")):
        out = _compose(SB.served_body(cur_name), SB.served_body(pri_name), cur_name, pri_name)
        movable = {r["key"]: r for r in out["rows"] + out["composites"]}
        findings = {f["ratio_key"]: f for f in out["band_movements"]["findings"]}
        for bucket in ("improved", "deteriorated"):
            for key in out["band_movements"][bucket]:
                r, f = movable[key], findings[key]
                assert f["direction"] == bucket, (key, f["direction"], bucket)
                comparator = f["contract_elements"]["threshold"]["comparator"]
                if r["higher_is_better"] or r["display_unit"] == "grade":
                    assert comparator == (">=" if bucket == "improved" else "<"), (key, comparator)
                    continue
                cur_v, pri_v = r["current"]["value"], r["prior"]["value"]
                fell = cur_v < pri_v
                assert fell == (bucket == "improved"), (
                    "%s (lower is better) %s -> %s listed %s" % (key, pri_v, cur_v, bucket))
                assert comparator == ("<=" if bucket == "improved" else ">"), (key, comparator)
                seen[bucket] += 1
    assert seen["improved"] >= 1 and seen["deteriorated"] >= 1, seen


# ── 4. the partition identity; demoted rows stay listed ────────────────────


@pytest.mark.parametrize("cur_name,pri_name", [("agras", "carniprod"), ("retail", "realestate")])
def test_the_movement_lists_partition_both_sides_and_demoted_crossings_stay_listed(cur_name, pri_name):
    out = _compose(SB.served_body(cur_name), SB.served_body(pri_name), cur_name, pri_name)
    bm, cov = out["band_movements"], out["coverage"]
    movable = out["rows"] + [r for r in out["composites"] if r["key"] in RC.MOVABLE_COMPOSITES]
    assert cov["movable_composites"] == list(RC.MOVABLE_COMPOSITES)
    parts = len(bm["improved"]) + len(bm["deteriorated"]) + len(bm["unchanged"]) + len(bm["not_comparable"])
    assert parts == cov["both_sides"], (
        "improved %d + deteriorated %d + unchanged %d + not_comparable %d != both_sides %d"
        % (len(bm["improved"]), len(bm["deteriorated"]), len(bm["unchanged"]),
           len(bm["not_comparable"]), cov["both_sides"]))
    one_sided = {r["key"] for r in movable
                 if r["current"]["value_q"] is None or r["prior"]["value_q"] is None}
    assert {e["key"] for e in bm["refused"]} == one_sided
    assert cov["both_sides"] + len(one_sided) == len(movable)
    assert len(bm["findings"]) == len(bm["improved"]) + len(bm["deteriorated"]), (
        "%d finding rows for %d crossings — a crossing lost its row"
        % (len(bm["findings"]), len(bm["improved"]) + len(bm["deteriorated"])))
    demoted = [f for f in bm["findings"] if not f["surfaced"]]
    assert demoted, "non-vacuity: the pair carries no demoted crossing, so a dropped demotion is invisible"
    for f in demoted:
        assert f["missing_elements"] and f["check_summary"]["rule_id"] == f["rule_key"], f
        assert f["ratio_key"] in bm["improved"] + bm["deteriorated"]
    assert [f["rank"] for f in bm["findings"]] == list(range(1, len(bm["findings"]) + 1))


def test_the_subject_table_covers_every_movable_key():
    keys = list(T.CENSUS) + ["altman_z", "letter_grade"]
    cov = CB.subject_coverage(keys)
    assert cov["missing"] == [] and "current_ratio" in cov["covered"], cov
    out = _compose(SB.served_body("agras"), SB.served_body("carniprod"), "agras", "carniprod")
    groups = {r["group"] for r in out["rows"] + out["composites"]}
    assert len(groups) >= 6 and groups <= set(CB.GROUP_POLICY), sorted(groups - set(CB.GROUP_POLICY))


# ── 5. determinism ─────────────────────────────────────────────────────────


def test_band_findings_are_deterministic_json():
    a = _compose(SB.served_body("agras"), SB.served_body("carniprod"), "agras", "carniprod")
    b = _compose(copy.deepcopy(SB.served_body("agras")), copy.deepcopy(SB.served_body("carniprod")),
                 "agras", "carniprod")
    ja = json.dumps(a["band_movements"], sort_keys=True, allow_nan=False)
    assert ja == json.dumps(b["band_movements"], sort_keys=True, allow_nan=False)
