"""The two-period ratio block (`engine.comparatives.ratio_compare`).

REAL BOOKS ONLY. The corpus pair is `_comparatives_fixtures.pick_pair()`
(the first analytic and the first synthetic deterministic corpus book, run
through today's assembler at test time); the serving gates read the REAL
GET /api/period body of the four corpus books and the Scandia FY2025
regression baseline (`_served_books`). Nothing here hand-builds a ratio.

WHAT EACH GATE REDS ON, AFTER THE REPAIR (TC-11):

  PRIOR COMPOSITE  a prior whose persisted `calculated_metrics` are `[]`
      serving no Altman Z'', no composite or no letter, or serving them
      from anything but its own served statements (the served prior must
      equal `compute_period_metrics` over the prior's statements). Also reds
      when a prior WITH rows is disclosed as as-filed-different although
      nothing differs.
  SECTOR PARITY  a sector-blocking signal on ONE side withholding a set of
      keys on either side that is not exactly `SECTOR_WITHHELD_KEYS` (the
      calibrated six plus their declared siblings, among keys with a
      value), or any key withheld with no blocking signal on either side.
  LOWER-IS-BETTER  a crossing whose status disagrees with the band ranks,
      whose served rung does not lie between the two values, whose
      distance past the rung is not |current - rung|, or whose delta
      colour is not the direction the row's `higher_is_better` gives; and
      the hand-checked dso crossing (100.5 days -> 25 days) serving any
      other rung, distance, width or fraction.
  PRINTED IDENTITY  printed prior + printed delta != printed current on any
      row, composite or sub-score of the corpus pair (letters: rank +
      notches), or the pair no longer carrying a `.x5` case (a row whose
      full-precision delta rounds differently) — without one the gate
      could not see a delta computed from full precision.
  CENSUS (TC-13)  the rows not being the table's CENSUS in order, the
      coverage counts not partitioning it, or a declared reason code in
      any served delta / movement / side that no tuple declares.
  SERVING  GET /api/period not serving `assembled_metrics.ratio_table`, its
      credit not being the serve-time model (basis `serve`), the served
      letter / zone disagreeing with the served ratio table, or — the
      precondition of the switch — any Altman zone or letter differing
      from the persisted rows on the five books.
  ONE CREDIT MODEL PER RESPONSE  on a served body whose persisted rows
      differ from the serve-time model (the Scandia baseline with its
      rows; the same with a stale composite planted), any figure a credit
      card reads — the `metrics` row first, the envelope only where the row
      is absent (financialValuation.ts mergeEngineEnvelope) — differing from
      the envelope, or the envelope letter not being the letter of the
      composite that card reads; the persisted rows not served verbatim
      under `credit_metrics_as_filed`; or the comparatives block, rebuilt
      from that body, no longer disclosing the stale composite as filed.

  MATERIALITY AND FLOORED WIDTHS (served pair: agras current, carniprod
      prior, both REAL GET /api/period bodies)  the hand-checked headroom,
      share and basis of one row per unit — current_ratio (x: current
      liabilities, scale 1), ebitda_margin (pct: revenue, scale 100), dso
      (days: revenue, scale 365, share over total assets) — or the DPO
      healthy -> watch crossing on the floored ladder (rung 45, distance
      18, width 15 ADJACENT, fraction 1.224) serving anything else.
  STAMPS  a period's comparatives side stamps differing from the
      ratio_table stamps its own get_period body serves (methodology
      version seeded on both rows so a dropped stamp is visible).
  PIOTROSKI OPERANDS  the comparatives current checks 1-4 differing, detail
      sentences included, from the same period's served
      `assembled_piotroski` checks 1-4, or the score not counting the nine
      checks it serves.

WHAT IT CANNOT SEE: whether any surface renders the block (B6/B7), and
period length (every served period is 365 days, so days deltas between a
partial and a full year are not modelled). The seven-element crossing
findings are held by test_comparatives_bands.py.
"""
from __future__ import annotations

import copy
import json
import types
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from typing import Any, Dict, List, Tuple

import pytest

from engine.api import _comparatives as C
from engine.api.findings.c_bands import build_band_findings
from engine.comparatives import ratio_compare as RC
from engine.country_packs.ro_romania.chart_of_accounts import _piotroski_checks
from engine.ratios import credit_model as CM
from engine.ratios import table as T

import _comparatives_fixtures as F
import _served_books as SB

_AN, _SY = F.pick_pair()
if _AN is None or _SY is None:
    pytest.skip("the corpus no longer carries both an analytic and a synthetic "
                "deterministic book", allow_module_level=True)


def _pair(prior_metrics=None, cur_signal=None, pri_signal=None):
    cur = F.served_payload(_AN[1], "p-cur", "2025-12-31", industry_signal=cur_signal)
    pri = F.served_payload(_SY[1], "p-pri", "2024-12-31", metrics=prior_metrics,
                           industry_signal=pri_signal)
    return cur, pri


def _scoring_pair(prior_metrics=None):
    """A pair whose PRIOR the credit model scores: the analytic book against
    its condensed form. The picked synthetic book (`saga_compact_6_col`)
    carries no liabilities, so since R-COMPOSITE its composite and letter
    refuse — correct, and useless to a gate about a prior's composite."""
    cur = F.served_payload(_AN[1], "p-cur", "2025-12-31")
    pri = F.served_payload(F.condense(_AN[1]), "p-pri", "2024-12-31", metrics=prior_metrics)
    return cur, pri


def _compare(cur, pri):
    return RC.compare_ratio_tables(cur, pri, current_label="2025", prior_label="2024",
                                   piotroski_checks=_piotroski_checks,
                                   band_findings=build_band_findings)


def _all_rows(out) -> List[Dict[str, Any]]:
    return out["rows"] + out["composites"] + out["subscores"]


# ── 1. the prior composite exists without persisted rows ───────────────────


def test_a_prior_with_no_persisted_metric_rows_still_carries_its_composite():
    cur, pri = _scoring_pair(prior_metrics=[])
    out = _compare(cur, pri)
    comps = {r["key"]: r for r in out["composites"]}
    expected = {r["name"]: r["value"] for r in CM.compute_period_metrics(copy.deepcopy(pri["statements"]))}
    assert expected.get("credit_composite") is not None, "the prior book no longer scores at all"
    z, comp, letter = comps["altman_z"]["prior"], comps["credit_composite"]["prior"], comps["letter_grade"]["prior"]
    assert z["value"] == expected["altman_z_score"], (
        "prior Altman Z'' %r is not its own served statements' %r (persisted rows: [])"
        % (z["value"], expected["altman_z_score"]))
    assert comp["value"] == expected["credit_composite"], (comp, expected["credit_composite"])
    assert letter["value_q"] == CM.composite_to_letter_grade(expected["credit_composite"]), letter
    prior_credit = out["credit"]["prior"]
    assert prior_credit["as_filed"] is None and prior_credit["as_filed_differs"] is False
    assert out["stamps"]["prior"]["metrics_basis"] == "serve"
    # every metric-only census key is computed for the prior from its own
    # statements: refused only where the model itself serves no value
    pri_refused = out["coverage"]["prior_refused"]
    metric_only = [k for k, how in T.PRECEDENCE.items() if how == "metric_only"]
    computed = 0
    for key in metric_only:
        if expected.get(key) is None:
            assert pri_refused.get(key) == "engine_metric_absent", (key, pri_refused.get(key))
        else:
            assert key not in pri_refused, (key, pri_refused[key])
            computed += 1
    assert computed >= 4, computed


def test_a_prior_whose_rows_agree_discloses_no_as_filed_difference():
    cur, pri = _pair()
    out = _compare(cur, pri)
    assert out["credit"]["prior"]["as_filed_differs"] is False
    assert out["credit"]["current"]["as_filed_differs"] is False


def test_stale_persisted_rows_are_disclosed_as_filed():
    cur, pri = _scoring_pair()
    stale = [dict(r) for r in pri["metrics"]]
    for r in stale:
        if r["name"] == "credit_composite":
            r["value"] = round(r["value"] + 12.0, 1)
        if r["name"] == CM.CREDIT_MODEL_REVISION_METRIC:
            r["name"] = "revision_row_dropped"
    pri["metrics"] = stale
    out = _compare(cur, pri)
    credit = out["credit"]["prior"]
    assert credit["as_filed_differs"] is True and credit["as_filed"] is not None, credit
    assert credit["as_filed"]["credit_model_revision"] == "unknown"
    assert credit["composite"] != credit["as_filed"]["composite"]


# ── 2. sector withholding: both sides, the declared set ────────────────────


def _withheld(side_rows: List[Dict[str, Any]], side: str) -> set:
    return {r["key"] for r in side_rows
            if r[side]["value_q"] is not None and r[side]["band_status"] == "ungraded_sector"}


@pytest.mark.parametrize("planted_on", ["prior", "current"])
def test_a_blocking_signal_on_one_side_withholds_the_same_declared_set_on_both(planted_on):
    kw = {"cur_signal": F.BLOCKING_INDUSTRY_SIGNAL} if planted_on == "current" \
        else {"pri_signal": F.BLOCKING_INDUSTRY_SIGNAL}
    out = _compare(*_pair(**kw))
    rows = out["rows"]
    for side in ("current", "prior"):
        with_value = {r["key"] for r in rows if r[side]["value_q"] is not None}
        expected = set(T.SECTOR_WITHHELD_KEYS) & with_value
        assert len(expected) >= 6, "non-vacuity: only %s carry a value" % sorted(expected)
        got = _withheld(rows, side)
        assert got == expected, (
            "signal planted on %s: %s side withholds %s, declared %s"
            % (planted_on, side, sorted(got), sorted(expected)))
    assert out["stamps"]["sector_withheld_by"] == [planted_on]
    for r in rows:
        if r["key"] in T.SECTOR_WITHHELD_KEYS and r["current"]["value_q"] is not None \
                and r["prior"]["value_q"] is not None:
            assert r["movement"]["status"] == "not_comparable" \
                and r["movement"]["reason_code"] == "sector_unconfirmed", r


def test_no_signal_withholds_nothing():
    out = _compare(*_pair())
    assert not _withheld(out["rows"], "current") and not _withheld(out["rows"], "prior")
    assert out["stamps"]["sector_withheld_by"] == []


# ── 3. a lower-is-better crossing classifies correctly ─────────────────────


def test_every_crossing_on_the_pair_agrees_with_its_ranks_rung_and_direction():
    out = _compare(*_pair())
    lower_seen = higher_seen = 0
    for r in out["rows"]:
        mv = r["movement"]
        if not mv["status"].startswith("crossed"):
            continue
        cur, pri = Decimal(repr(r["current"]["value"])), Decimal(repr(r["prior"]["value"]))
        up = T.BAND_RANK[mv["to"]] > T.BAND_RANK[mv["from"]]
        assert mv["status"] == ("crossed_up" if up else "crossed_down"), (r["key"], mv)
        assert mv["rungs_crossed"] == T.BAND_RANK[mv["to"]] - T.BAND_RANK[mv["from"]]
        rung = Decimal(mv["rung_crossed"]["value"])
        assert min(cur, pri) <= rung <= max(cur, pri), (
            "%s: rung %s is not between prior %s and current %s" % (r["key"], rung, pri, cur))
        digits = T.DISPLAY_DIGITS[r["display_unit"]]
        want = abs(cur - rung).quantize(Decimal(1).scaleb(-digits), rounding=ROUND_HALF_UP)
        assert Decimal(mv["distance_past_rung"]) == want, (r["key"], mv["distance_past_rung"], want)
        # moving UP the ladder is an improvement whichever way the number went
        better = (cur > pri) == r["higher_is_better"]
        assert better == up, "%s (higher_is_better=%s) %s -> %s classified %s" % (
            r["key"], r["higher_is_better"], pri, cur, mv["status"])
        assert r["delta"]["favourable"] == ("improved" if up else "deteriorated"), (r["key"], r["delta"])
        if r["higher_is_better"]:
            higher_seen += 1
        else:
            lower_seen += 1
    assert lower_seen >= 3 and higher_seen >= 3, (lower_seen, higher_seen)


def test_the_hand_checked_dso_crossing():
    """dso ladder strong 30 / healthy 60 / watch 100, lower is better.
    100.5 days (critical) -> 25 days (strong): the last rung passed is
    strong 30; 5 days past it; strong is open-ended so its width is the
    adjacent healthy band, 30 days; fraction 5/30."""
    ladder = {"strong": "30", "healthy": "60", "watch": "100"}
    cross = RC._crossing("strong", "critical", 25.0, ladder, "critical", 0)
    assert cross["rung_crossed"] == {"name": "strong", "value": "30"}
    assert cross["distance_past_rung"] == "5"
    assert (cross["band_width"], cross["band_width_basis"]) == ("30", "adjacent")
    assert cross["distance_fraction"] == "0.167"
    down = RC._crossing("critical", "strong", 101.0, ladder, "critical", 0)
    assert down["rung_crossed"] == {"name": "watch", "value": "100"}
    assert (down["distance_past_rung"], down["band_width"], down["band_width_basis"]) == ("1", "40", "adjacent")


# ── 4. printed prior + printed delta == printed current ────────────────────


def _q(d: Decimal, digits: int) -> Decimal:
    return d.quantize(Decimal(1).scaleb(-digits), rounding=ROUND_HALF_UP)


def test_printed_prior_plus_printed_delta_is_printed_current_on_every_row():
    out = _compare(*_pair())
    ranks = RC._letter_ranks()
    checked = x5 = 0
    breaks = []
    for r in _all_rows(out):
        c, p, d = r["current"], r["prior"], r["delta"]
        if c["value_q"] is None or p["value_q"] is None:
            assert d["value"] is None and d["reason_code"] in RC.DELTA_REASON_CODES, (r["key"], d)
            continue
        if r["display_unit"] == "grade":
            ok = ranks[p["value_q"]] + int(d["value"]) == ranks[c["value_q"]]
        else:
            ok = Decimal(p["value_q"]) + Decimal(d["value"]) == Decimal(c["value_q"])
            digits = T.DISPLAY_DIGITS[r["display_unit"]]
            full = _q(Decimal(repr(c["value"])) - Decimal(repr(p["value"])), digits)
            if full != Decimal(c["value_q"]) - Decimal(p["value_q"]):
                x5 += 1
        if not ok:
            breaks.append("%s: printed %s + %s != %s" % (r["key"], p["value_q"], d["value"], c["value_q"]))
        checked += 1
    assert not breaks, "the document does not tie to itself:\n  " + "\n  ".join(breaks)
    assert checked >= 25, checked
    assert x5 >= 1, "the corpus pair no longer carries a .x5 case; the gate cannot see a full-precision delta"


# ── 5. census coverage (TC-13) and declared codes ──────────────────────────


def test_the_rows_are_the_census_and_coverage_partitions_it(capsys):
    out = _compare(*_pair())
    keys = [r["key"] for r in out["rows"]]
    assert keys == list(T.CENSUS)
    cov = out["coverage"]
    assert cov["census"] == list(T.CENSUS) and cov["census_count"] == len(T.CENSUS)
    both = {r["key"] for r in out["rows"] if r["current"]["value_q"] is not None and r["prior"]["value_q"] is not None}
    assert cov["both_sides_census"] == len(both)
    assert both | set(cov["current_refused"]) | set(cov["prior_refused"]) == set(T.CENSUS)
    # both_sides counts every MOVABLE entry (census rows plus the declared
    # composites) valued on both sides — the count the movement lists
    # partition (test_comparatives_bands.py holds the identity).
    movable = out["rows"] + [r for r in out["composites"] if r["key"] in cov["movable_composites"]]
    assert cov["movable_composites"] == list(RC.MOVABLE_COMPOSITES)
    assert cov["both_sides"] == sum(1 for r in movable if r["current"]["value_q"] is not None
                                    and r["prior"]["value_q"] is not None)
    declared = set(T.REASON_CODES) | set(RC.DELTA_REASON_CODES) | set(RC.MOVEMENT_REASON_CODES) \
        | set(RC.COMPOSITE_REASON_CODES)
    served = set()
    for r in _all_rows(out):
        for code in (r["delta"]["reason_code"], r["movement"]["reason_code"],
                     (r["current"]["reason"] or {}).get("code"), (r["prior"]["reason"] or {}).get("code")):
            if code is not None:
                served.add(code)
    served.add(out["piotroski"]["reason_code"])
    assert served <= declared, "undeclared reason codes served: %s" % sorted(served - declared)
    with capsys.disabled():
        print("\n[ratio_compare census] %d keys; both sides %d; current refused %s; prior refused %s"
              % (cov["census_count"], cov["both_sides"], sorted(cov["current_refused"]),
                 sorted(cov["prior_refused"])))


def test_the_block_is_deterministic_json_and_rides_the_route_core():
    cur, pri = _pair()
    a = C.compare_payloads(cur, pri, current_row={"id": "p-cur", "period_end": "2025-12-31"},
                           prior_row={"id": "p-pri", "period_end": "2024-12-31"})
    b = C.compare_payloads(copy.deepcopy(cur), copy.deepcopy(pri),
                           current_row={"id": "p-cur", "period_end": "2025-12-31"},
                           prior_row={"id": "p-pri", "period_end": "2024-12-31"})
    ja = json.dumps(a["ratios"], sort_keys=True, allow_nan=False)
    assert ja == json.dumps(b["ratios"], sort_keys=True, allow_nan=False)
    ratios = a["ratios"]
    assert ratios["stamps"]["comparable_model"] is True
    assert ratios["stamps"]["effective_dating"] == {"basis": "restated_under_current_revision",
                                                    "is_convention": True}
    assert ratios["band_movements"]["rank_basis"]["bases"] == RC.MATERIALITY_BASES
    assert ratios["band_movements"]["rank_basis"]["materiality_floor"] is None


def test_band_movements_are_ranked_by_the_served_basis():
    out = _compare(*_pair())
    movable = {r["key"]: r for r in out["rows"] + out["composites"]}
    for bucket in ("improved", "deteriorated"):
        listed = out["band_movements"][bucket]
        assert listed == [r["key"] for r in sorted((movable[k] for k in listed), key=RC._rank_key)]
    assert not ({"credit_composite"} | {r["key"] for r in out["subscores"]}) & \
        set(out["band_movements"]["improved"] + out["band_movements"]["deteriorated"])


def test_piotroski_current_side_evaluates_the_year_over_year_checks_and_is_not_a_movement():
    out = _compare(*_pair())
    pio = out["piotroski"]
    assert pio["excluded_from_band_movements"] is True and pio["prior_capped"] is True
    yoy = [c for c in pio["current"]["checks"][4:]]
    assert [c["key"] for c in yoy] == ["roa_improving", "debt_declining", "no_share_issuance",
                                      "margin_improving", "asset_turnover_improving"]
    assert sum(1 for c in yoy if c["result"] != "uncertain") >= 3, yoy
    assert pio["prior"]["has_prior_period"] is False and pio["prior"]["score"] <= 4
    assert "piotroski" not in out["band_movements"]["improved"] + out["band_movements"]["deteriorated"]


def test_the_year_over_year_checks_read_both_periods_and_refuse_a_missing_operand():
    """_piotroski_checks with a prior: each of checks 5-9 compares the two
    periods as its label says; equality is not an improvement except for
    share capital (not higher passes); an absent operand is uncertain."""
    cur_bag = {"revenue": 200.0, "long_term_debt": 50.0, "share_capital": 10.0, "operating_ebit": 20.0}
    pri_bag = {"net_income_statutory": 5.0, "total_assets": 100.0, "revenue": 150.0,
               "long_term_debt": 50.0, "share_capital": 10.0, "operating_ebit": 15.0}
    out = _piotroski_checks(net_income_statutory=8.0, total_assets=100.0, cash_from_operating=9.0,
                            prior=pri_bag, currency="RON", current=cur_bag)
    by = {c["key"]: c["result"] for c in out["checks"]}
    assert by["roa_improving"] == "pass"            # 8% > 5%
    assert by["debt_declining"] == "fail"           # 50 is not lower than 50
    assert by["no_share_issuance"] == "pass"        # 10 not higher than 10
    assert by["margin_improving"] == "fail"         # 10% is not higher than 10%
    assert by["asset_turnover_improving"] == "pass"  # 2.0x > 1.5x
    assert out["has_prior_period"] is True and out["disclosure"] is None
    assert out["score"] == sum(1 for c in out["checks"] if c["result"] == "pass")
    missing = _piotroski_checks(net_income_statutory=8.0, total_assets=100.0, cash_from_operating=9.0,
                                prior={"total_assets": 100.0}, currency="RON", current={})
    assert all(c["result"] == "uncertain" for c in missing["checks"][4:]), missing["checks"][4:]
    capped = _piotroski_checks(net_income_statutory=8.0, total_assets=100.0, cash_from_operating=9.0,
                               prior=None, currency="RON")
    assert capped["score"] <= 4 and capped["has_prior_period"] is False


def test_the_table_takes_its_currency_from_the_served_statements_and_absent_stays_absent():
    """No RON default: a statements block with no currency stamps None and
    computes the same figures (the gateway reads amounts, never labels)."""
    cur, _pri = _pair()
    served = T.build_ratio_table(cur, serve_time_metrics=True)
    assert served["stamps"]["currency"] == cur["statements"]["currency"]
    bare = copy.deepcopy(cur)
    bare["statements"].pop("currency", None)
    absent = T.build_ratio_table(bare, serve_time_metrics=True)
    assert absent["stamps"]["currency"] is None, absent["stamps"]
    assert [r["value_q"] for r in absent["rows"]] == [r["value_q"] for r in served["rows"]]


# ── 6. serving: GET /api/period ────────────────────────────────────────────


def _zone_letter_of_rows(rows) -> Tuple[Any, Any]:
    m = {r["name"]: r["value"] for r in rows}
    comp = m.get("credit_composite")
    return CM.altman_zone(m.get("altman_z_score")), (None if comp is None else CM.composite_to_letter_grade(comp))


@pytest.mark.parametrize("name", SB.ALL_BOOKS)
def test_get_period_serves_the_ratio_table_and_the_serve_time_credit(name):
    body = SB.served_body(name)
    am = body["assembled_metrics"]
    table = am.get("ratio_table")
    assert isinstance(table, dict), "%s: GET /api/period serves no ratio_table" % name
    assert [r["key"] for r in table["rows"]] == list(T.CENSUS)
    assert table["stamps"]["metrics_basis"] == "serve"
    assert table["stamps"]["credit_model_revision"] == CM.CREDIT_MODEL_REVISION
    assert table["stamps"]["currency"] == body["statements"]["currency"]
    credit = am["credit"]
    assert credit["basis"] == "serve", credit
    assert credit["composite_score"] == table["credit"]["composite"]
    assert credit["letter_grade"] == table["credit"]["letter"]
    assert credit["altman_z_score"] == table["credit"]["altman"]["z"]
    assert credit["composite_weights"] == CM.CREDIT_COMPOSITE_WEIGHTS
    persisted_env = SB.book(name).period.get("assembled_canonical_v1") or {}
    assert table["stamps"]["pack_provenance"] == persisted_env.get("pack_provenance"), (
        "%s: pack_provenance is not the persisted envelope's" % name)


@pytest.mark.parametrize("name", SB.ALL_BOOKS)
def test_the_switch_precondition_no_zone_or_letter_moves_against_the_persisted_rows(name):
    """Measured before switching get_period's credit to the serve-time
    model: the persisted rows (`stage_compute` over the write-path
    statements) and the served composite agree on the Altman zone and the
    letter on every book."""
    bk = SB.book(name)
    pa = bk.persist_assembled
    persisted = CM.compute_period_metrics(copy.deepcopy(pa["statements"]), pa.get("source_data_quality"))
    served = SB.served_body(name)["assembled_metrics"]["credit"]
    p_zone, p_letter = _zone_letter_of_rows(persisted)
    assert (served["altman_zone"], served["letter_grade"]) == (p_zone, p_letter), (
        "%s: served zone/letter %s/%s vs persisted %s/%s (Z'' %s vs %s, composite %s vs %s)"
        % (name, served["altman_zone"], served["letter_grade"], p_zone, p_letter,
           served["altman_z_score"], {r["name"]: r["value"] for r in persisted}.get("altman_z_score"),
           served["composite_score"], {r["name"]: r["value"] for r in persisted}.get("credit_composite")))


def test_the_scandia_baseline_discloses_its_as_filed_composite():
    bk = SB.book(SB.SCANDIA)
    persisted = CM.compute_period_metrics(copy.deepcopy(bk.persist_assembled["statements"]))
    body = SB.routed_body(bk, metrics=persisted)
    credit = body["assembled_metrics"]["credit"]
    assert credit["as_filed_differs"] is True, credit
    assert credit["as_filed"]["letter"] == credit["letter_grade"] == "A"
    assert credit["as_filed"]["composite"] != credit["composite_score"]


# ── 7. one credit model per response ───────────────────────────────────────


def _card_reads(body: Dict[str, Any]) -> Dict[str, Any]:
    """What a credit card reads off a served body: the `metrics` row when
    one is served, else the envelope (financialValuation.ts
    `mergeEngineEnvelope` / `altmanFromEngine`, the one precedence every FE
    credit reader goes through)."""
    rows = {r["name"]: r["value"] for r in body["metrics"]}
    env = body["assembled_metrics"]["credit"]

    def pick(metric, from_env):
        v = rows.get(metric)
        return v if v is not None else from_env

    comps = env.get("altman_components") or {}
    subs = env.get("subscores") or {}
    return {
        "composite": pick("credit_composite", env.get("composite_score")),
        "altman_z": pick("altman_z_score", env.get("altman_z_score")),
        **{x: pick("altman_%s" % x, comps.get(x)) for x in ("x1", "x2", "x3", "x4")},
        **{"sub_" + k: pick(name, subs.get(k)) for k, name in CM.CREDIT_SUBSCORE_METRICS},
    }


def _envelope_figures(body: Dict[str, Any]) -> Dict[str, Any]:
    env = body["assembled_metrics"]["credit"]
    comps = env.get("altman_components") or {}
    subs = env.get("subscores") or {}
    return {
        "composite": env.get("composite_score"),
        "altman_z": env.get("altman_z_score"),
        **{x: comps.get(x) for x in ("x1", "x2", "x3", "x4")},
        **{"sub_" + k: subs.get(k) for k, _name in CM.CREDIT_SUBSCORE_METRICS},
    }


def _scandia_with_rows(stale_composite=None):
    bk = SB.book(SB.SCANDIA)
    persisted = CM.compute_period_metrics(copy.deepcopy(bk.persist_assembled["statements"]))
    if stale_composite is not None:
        for r in persisted:
            if r["name"] == "credit_composite":
                r["value"] = stale_composite
    return persisted, SB.routed_body(bk, metrics=persisted)


@pytest.mark.parametrize("stale", [None, 69.9])
def test_a_credit_card_reads_one_model_from_the_served_body(stale):
    persisted, body = _scandia_with_rows(stale)
    env = body["assembled_metrics"]["credit"]
    assert env["basis"] == "serve", env
    read, served = _card_reads(body), _envelope_figures(body)
    mixed = {k: (read[k], served[k]) for k in read if read[k] != served[k]}
    assert not mixed, (
        "scandia_baseline (persisted composite %s): the card reads %s from the metrics rows "
        "while the envelope serves the serve-time model" % (stale, mixed))
    assert read["composite"] is not None
    assert env["letter_grade"] == CM.composite_to_letter_grade(read["composite"]), (
        "the card prints composite %s beside letter %s" % (read["composite"], env["letter_grade"]))
    family = set(CM.SERVE_REPLACED_METRICS)
    want_filed = [{"name": r["name"], "value": r["value"], "unit": r["unit"], "direction": r.get("direction")}
                  for r in persisted if r["name"] in family]
    assert body["credit_metrics_as_filed"] == want_filed
    # every other row is the persisted row, untouched and in order
    assert [r for r in body["metrics"] if r["name"] not in family] == [
        {"name": r["name"], "value": r["value"], "unit": r["unit"], "direction": r.get("direction")}
        for r in persisted if r["name"] not in family]
    if stale is not None:
        assert env["as_filed_differs"] is True and env["as_filed"]["composite"] == stale
        assert env["as_filed"]["letter"] == "BBB" and env["letter_grade"] == "A"


def test_the_comparatives_rebuild_still_discloses_the_as_filed_composite():
    _persisted, body = _scandia_with_rows(69.9)
    prior = SB.served_body("agras")
    out = C.compare_payloads(body, prior,
                             current_row={"id": body["period"]["id"], "period_end": "2025-12-31"},
                             prior_row={"id": "p-pri", "period_end": "2024-12-31"})
    credit = out["ratios"]["credit"]["current"]
    assert credit["as_filed_differs"] is True, credit
    assert credit["as_filed"]["composite"] == 69.9 and credit["as_filed"]["letter"] == "BBB"
    assert credit["composite"] == body["assembled_metrics"]["credit"]["composite_score"]


def test_the_serve_time_rows_replace_in_place_drop_absent_and_append_nothing():
    persisted = [{"name": "current_ratio", "value": 1.5, "unit": "ratio", "direction": "higher"},
                 {"name": "credit_composite", "value": 69.9, "unit": "score", "direction": "higher"},
                 {"name": "altman_x4", "value": 3.0, "unit": "ratio", "direction": "higher"}]
    serve = [{"name": "credit_composite", "value": 71.9, "unit": "score", "direction": "higher"},
             {"name": "altman_z_score", "value": 3.11, "unit": "ratio", "direction": "higher"},
             {"name": "roe", "value": 0.2, "unit": "pct", "direction": "higher"}]
    served, filed = CM.serve_credit_rows(persisted, serve)
    assert served == [persisted[0], dict(persisted[1], value=71.9)]
    assert CM.serve_credit_rows([], serve) == ([], [])
    assert filed == persisted[1:]


# ── 8. materiality, floored widths, stamps, Piotroski operands (real pair) ──


def _real_pair_ratios(cur_body=None, pri_body=None):
    cur = cur_body if cur_body is not None else SB.served_body("agras")
    pri = pri_body if pri_body is not None else SB.served_body("carniprod")
    return C.compare_payloads(cur, pri,
                              current_row={"id": cur["period"]["id"], "period_end": "2025-12-31"},
                              prior_row={"id": pri["period"]["id"], "period_end": "2024-12-31"})["ratios"]


#: Hand-checked on the served agras (current) / carniprod (prior) pair.
#:   current_ratio  2.1033878684 - 2 = 0.1033878684; x 13,012,976.77 current
#:                  liabilities / 1 = 1,345,383.93; / 39,319,114.09 total
#:                  assets = 0.0342
#:   ebitda_margin  15.53 - 15 = 0.53 pp; x 118,576,819.64 revenue / 100 =
#:                  628,457.14; / revenue = 0.0053
#:   dso            30 - 26.2056742611 = 3.7943257389 days; x 118,576,819.64
#:                  revenue / 365 = 1,232,655.01; / total assets = 0.0314
HAND_MATERIALITY = {
    "current_ratio": ("0.10", {"basis_key": "total_assets", "basis_value": "39319114.09",
                               "headroom_money": "1345383.93", "share": "0.0342"}),
    "ebitda_margin": ("0.5", {"basis_key": "revenue", "basis_value": "118576819.64",
                              "headroom_money": "628457.14", "share": "0.0053"}),
    "dso": ("4", {"basis_key": "total_assets", "basis_value": "39319114.09",
                  "headroom_money": "1232655.01", "share": "0.0314"}),
}


def test_materiality_is_the_hand_checked_figure_for_each_unit_on_the_real_pair():
    rows = {r["key"]: r for r in _real_pair_ratios()["rows"]}
    for key, (distance, materiality) in HAND_MATERIALITY.items():
        mv = rows[key]["movement"]
        assert mv["status"] in ("crossed_up", "crossed_down"), (key, mv)
        assert mv["distance_past_rung"] == distance, (key, mv["distance_past_rung"])
        assert mv["materiality"] == materiality, (
            "%s (%s): served materiality %s, hand-checked %s"
            % (key, rows[key]["display_unit"], mv["materiality"], materiality))


def test_the_dpo_crossing_on_its_floored_ladder_is_the_hand_checked_one():
    """dpo 51 -> 27 days: healthy -> watch past rung 45. Its watch band is the
    FLOOR (below watch 30 stays watch), so watch 30 bounds nothing: the
    watch band has no closed width and the fraction divides by the adjacent
    healthy band, 60 - 45 = 15. 45 - 26.6422 = 18.3578; / 15 = 1.224."""
    row = {r["key"]: r for r in _real_pair_ratios()["rows"]}["dpo"]
    assert row["current"]["ladder_floor"] == "watch" and row["prior"]["ladder_floor"] == "watch"
    mv = row["movement"]
    assert (mv["from"], mv["to"], mv["status"], mv["rungs_crossed"]) == ("healthy", "watch", "crossed_down", -1), mv
    assert mv["rung_crossed"] == {"name": "healthy", "value": "45"}
    assert (mv["distance_past_rung"], mv["band_width"], mv["band_width_basis"], mv["distance_fraction"]) == (
        "18", "15", "adjacent", "1.224"), mv


def test_each_sides_stamps_are_its_own_get_period_ratio_table_stamps():
    bodies = {}
    for name, version in (("agras", "ro_ras_2025_v1"), ("carniprod", "ro_ras_2024_v0")):
        bk = SB.book(name)
        seeded = types.SimpleNamespace(period=dict(bk.period, methodology_version=version),
                                       line_items=bk.line_items, org=bk.org, period_id=bk.period_id)
        bodies[name] = SB.routed_body(seeded)
        assert bodies[name]["assembled_metrics"]["ratio_table"]["stamps"]["methodology_version"] == version
    out = _real_pair_ratios(bodies["agras"], bodies["carniprod"])
    for side, name in (("current", "agras"), ("prior", "carniprod")):
        assert out["stamps"][side] == bodies[name]["assembled_metrics"]["ratio_table"]["stamps"], (
            side, out["stamps"][side], bodies[name]["assembled_metrics"]["ratio_table"]["stamps"])
    assert "methodology_version" in out["stamps"]["differences"]


def test_the_current_piotroski_checks_1_to_4_are_the_served_blocks_verbatim():
    cur = SB.served_body("agras")
    pio = _real_pair_ratios(cur)["piotroski"]
    served = cur["statements"]["assembled_piotroski"]["checks"][:4]
    assert pio["current"]["checks"][:4] == served, (pio["current"]["checks"][:4], served)
    assert pio["current_checks_1_4_source"] == "served_assembled_piotroski"
    assert pio["current"]["score"] == sum(1 for c in pio["current"]["checks"] if c["result"] == "pass")
    assert len(pio["current"]["checks"]) == 9
