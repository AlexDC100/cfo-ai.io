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
  EVERY FINDING  on all 20 ordered pairs of the five served books (Scandia
      included), for every finding row, surfaced or demoted: a printed prior
      or current figure (`_format_value` of the evidence figure) differing
      from the served `value_q` in the row's unit (the letter: the composite
      score), or absent from a surfaced body; the threshold limit, back in
      display units, differing from `movement.rung_crossed.value`; a
      severity other than the landing rule; an impact present where the
      composer served no materiality (or absent where it did); the impact's
      baseline / adjusted not being the at-rung / held numerator
      (rung x |served denominator| / unit scale, days on the served period
      length) to float precision, not cited under `band_numerator_at_rung` /
      `band_numerator_held`, or |delta| more than half a cent from the served
      `headroom_money`; the findings, the improved or the deteriorated list
      out of the printed rank order (spelled here from `rank_basis.order`).
  COMPOSITE SOURCE  an altman_z or letter_grade finding citing the band
      table instead of a credit-model constant that resolves to the served
      rung value, a basis sentence not naming that ladder, or the letter's
      figures not labelled as the credit composite; a census ratio not citing
      `<bands source>#<key>.<rung>` with the table sha in its basis.
  PROSE  on all 20 pairs: a why-here rationale not opening in a capital, an
      audience followed by a verb (no form agrees with one reader and two),
      the capitalised label embedded mid-sentence, a surfaced title with a
      doubled word ("30 days days sales outstanding"), or the why-here not
      opening its own sentence in the body.
  SUBJECT CODES  with carniprod as the current period (against each other
      book), any finding naming a served code `is_ledger_code` rejects
      (`701.00'`), any finding demoting on "is not a ledger code", or a
      revenue-bucket crossing not surfacing; selection keeping a nameless
      line instead of taking the next account.
  CONTRA  (ruling Q5) on all 20 pairs: any finding naming a 28x / 29x / 39x
      / 49x account (measured before: 22 findings named 491 or 2813.01), or
      a subject whose numerator and denominator accounts are not the largest
      SIGNED balances among the eligible served lines of their buckets
      (measured before: carniprod's credit findings named 117.1, a negative
      retained-earnings line, ahead of 4111.01); the planted bucket ranking
      a provision or a debit-side line first.
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
      dropped); the PLANTED demotion (the top surfaced crossing with its
      subject line items removed, every movement list otherwise unchanged)
      missing from the findings or not demoted on `subject`; a demoted row
      not carrying its missing elements and its check summary. The gate no
      longer depends on a natural demotion (every one today is an impact-only
      demotion on altman_z / letter_grade / ccc, held for the owner).
  DETERMINISM  two compositions over the same bodies serialising to
      different bytes.
  CAVEAT  (ruling Q4) on all 20 pairs: any finding's confidence caveat or
      body saying "no prior period was supplied" (a prior WAS supplied);
      a finding whose profile carries the approximated-cash-flow caveat not
      naming what is approximated (`c_bands.TWO_PERIOD_CAVEATS`); the pack's
      own single-period caveat text changing (the lane edits a copy).

WHAT IT CANNOT SEE: whether a surface renders the findings (B6/B7); the
CAEN (the comparatives route passes none, so the profile is inferred from
the account mix — the same inference the single-period lane makes without
one); period length (every served period is 365 days).
"""
from __future__ import annotations

import copy
import json
import math
import re
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


# ── 1a. every finding on every real pair carries the served row's numbers ──

#: Every ordered pair of the five served books (the four corpus books and the
#: Scandia baseline), both orders.
PAIRS = [(c, p) for c in SB.ALL_BOOKS for p in SB.ALL_BOOKS if c != p]

#: What `_finding._format_value` appends per served display unit.
_PRINTED_SUFFIX = {"x": "\u00d7", "z": "\u00d7", "pct": "%", "days": " days"}


def _landing_severity(mv: Dict[str, Any]) -> str:
    """The landing rule, as specified: any rung up is low; landing in
    critical or crossing two or more rungs down is high; one rung down is
    medium."""
    if mv["rungs_crossed"] > 0:
        return "low"
    if mv["to"] == "critical" or mv["rungs_crossed"] <= -2:
        return "high"
    return "medium"


def _printed_rank_key(row: Dict[str, Any]) -> Tuple[Any, ...]:
    """`band_movements.rank_basis.order`, spelled from the served fields
    here rather than imported, so the composer's own sort key is under test."""
    mv = row["movement"]
    frac = mv["distance_fraction"]
    share = (mv["materiality"] or {}).get("share")
    return (-abs(mv["rungs_crossed"]),
            frac is None, -Decimal(frac) if frac is not None else Decimal(0),
            share is None, -Decimal(share) if share is not None else Decimal(0),
            row["key"])


def _served_period_days(body: Dict[str, Any]) -> Decimal:
    v = (body["statements"].get("supplementary") or {}).get("periodDays")
    ok = isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0
    return Decimal(repr(float(v))) if ok else Decimal(365)


@pytest.mark.parametrize("cur_name,pri_name", PAIRS)
def test_every_finding_carries_the_served_rows_figures_rung_headroom_severity_and_rank(cur_name, pri_name):
    cur_body, pri_body = SB.served_body(cur_name), SB.served_body(pri_name)
    out = _compose(cur_body, pri_body, cur_name, pri_name)
    bm = out["band_movements"]
    assert bm["rank_basis"]["order"] == list(RC.RANK_ORDER)
    movable = {r["key"]: r for r in out["rows"] + out["composites"]}
    findings = bm["findings"]

    for bucket in ("improved", "deteriorated"):
        rows = [movable[k] for k in bm[bucket]]
        assert bm[bucket] == [r["key"] for r in sorted(rows, key=_printed_rank_key)], bucket
    crossed = [movable[k] for k in bm["improved"] + bm["deteriorated"]]
    assert [f["ratio_key"] for f in findings] == [r["key"] for r in sorted(crossed, key=_printed_rank_key)], (
        "findings are not in the printed rank order")

    denominators = T.ratio_denominators(cur_body, serve_time_metrics=True)
    scale_of = {"x": Decimal(1), "pct": Decimal(100), "days": _served_period_days(cur_body)}
    currency = findings[0]["source_currency"] if findings else "RON"
    for f in findings:
        key = f["ratio_key"]
        r, mv, unit = movable[key], movable[key]["movement"], movable[key]["display_unit"]
        el = f["contract_elements"]
        where = "%s|%s %s" % (cur_name, pri_name, key)

        # the printed prior and current figures are the served value_q
        figures = {fg["fact"]: fg for fg in el["evidence"]["figures"]}
        for side in ("prior", "current"):
            fg = figures["%s__%s" % (key, side)]
            printed = F._format_value(fg["value"], fg["unit"], currency)
            if unit == "grade":
                # the letter is graded on the composite; the figure is that score
                expected = T.quantize_display(r[side]["value"], "score")
            else:
                expected = r[side]["value_q"] + _PRINTED_SUFFIX[unit]
            assert printed == expected, (where, side, printed, expected)
            if f["surfaced"]:
                assert "%s \u2014 %s" % (fg["label"], printed) in f["body"], (where, side)

        # the limit, back in display units, is the rung the composer crossed
        thr, rung = el["threshold"], mv["rung_crossed"]
        back = Decimal(repr(thr["limit"])) * (Decimal(100) if unit == "pct" else Decimal(1))
        assert back == Decimal(rung["value"]) and thr["parameter"] == rung["name"], (where, thr, rung)
        assert F._format_value(thr["observed"], thr["unit"], currency) == \
            F._format_value(figures["%s__current" % key]["value"], thr["unit"], currency), where

        assert f["severity"] == _landing_severity(mv), (where, f["severity"], mv)

        # headroom money: the at-rung and held numerators on the served denominator
        imp = el["impact"]
        if mv["materiality"] is None:
            assert imp is None, (where, imp)
            continue
        assert imp is not None and imp["kind"] == "headroom" and imp["unit"] == F.UNIT_MONEY, where
        den = abs(Decimal(denominators[key]["value"]))
        at_rung = Decimal(rung["value"]) * den / scale_of[unit]
        held = Decimal(r["current"]["value"]) * den / scale_of[unit]
        assert (imp["baseline_fact"], imp["adjusted_fact"]) == (CB.MONEY_AT_RUNG, CB.MONEY_HELD), where
        # to float precision: both sides are the one exact Decimal, floated
        assert math.isclose(imp["baseline"], float(at_rung), rel_tol=1e-12, abs_tol=1e-6) and \
            math.isclose(imp["adjusted"], float(held), rel_tol=1e-12, abs_tol=1e-6), (
                where, imp["baseline"], imp["adjusted"], at_rung, held)
        assert f["facts_cited"][CB.MONEY_AT_RUNG] == imp["baseline"], where
        assert f["facts_cited"][CB.MONEY_HELD] == imp["adjusted"], where
        # headroom_money is the composer's 2dp ROUND_HALF_UP of the exact
        # distance; the float delta may sit a binary hair either side of a
        # half cent, so the bound is the half cent itself
        served = Decimal(mv["materiality"]["headroom_money"])
        assert abs(Decimal(repr(abs(imp["delta"]))) - served) <= Decimal("0.005000001"), (
            where, imp["delta"], mv["materiality"])


@pytest.mark.parametrize("cur_name,pri_name", [("agras", "carniprod"), ("retail", "realestate")])
def test_a_composite_crossing_cites_the_credit_model_and_a_ratio_the_band_table(cur_name, pri_name):
    """The Altman zones and the letter ladder are credit-model constants, not
    rows of the pack's band table: the threshold source must resolve, in
    `engine.ratios.credit_model`, to the rung's served value; the basis must
    name that ladder; the letter's figures must say they are the composite."""
    from engine.ratios import credit_model as CM

    out = _compose(SB.served_body(cur_name), SB.served_body(pri_name), cur_name, pri_name)
    movable = {r["key"]: r for r in out["rows"] + out["composites"]}
    bands = out["stamps"]["current"]["bands"]
    seen = set()
    for f in out["band_movements"]["findings"]:
        key = f["ratio_key"]
        rung = movable[key]["movement"]["rung_crossed"]
        el = f["contract_elements"]
        source, basis = el["threshold"]["source"], el["evidence"]["comparison_basis"]["description"]
        if key == "altman_z":
            prefix, _, constant = source.partition("#")
            assert prefix == "credit_model" and Decimal(repr(getattr(CM, constant))) == Decimal(rung["value"]), source
            assert "Altman Z'' zones" in basis and bands["source"] not in basis, basis
        elif key == "letter_grade":
            ladder = {grade: floor for floor, grade in CM.CREDIT_LETTER_LADDER}
            assert source == "credit_model#CREDIT_LETTER_LADDER.%s" % rung["name"], source
            assert Decimal(str(ladder[rung["name"]])) == Decimal(rung["value"]), (source, rung)
            assert "letter ladder" in basis and bands["source"] not in basis, basis
            assert all(fg["label"].startswith("credit composite in ")
                       for fg in el["evidence"]["figures"]), el["evidence"]["figures"]
        else:
            assert source == "%s#%s.%s" % (bands["source"], key, rung["name"]), source
            assert bands["table_sha256"][:12] in basis, basis
            continue
        seen.add(key)
    assert seen, "non-vacuity: %s|%s crosses no composite" % (cur_name, pri_name)


#: A verb straight after a financing audience cannot agree with both a single
#: reader ("the shareholder") and a pair ("... and the statutory auditor").
_AUDIENCE_VERB = re.compile(r"(auditor|lender|shareholder|committee|treasury) "
                            r"(reads|sizes|underwrites|tests|takes|grades|read|size|underwrite|test|take|grade)\b")


@pytest.mark.parametrize("cur_name,pri_name", PAIRS)
def test_band_finding_prose_starts_sentences_in_capitals_and_never_doubles_a_unit(cur_name, pri_name):
    out = _compose(SB.served_body(cur_name), SB.served_body(pri_name), cur_name, pri_name)
    for f in out["band_movements"]["findings"]:
        key, label = f["ratio_key"], CB.LABELS[f["ratio_key"]]
        where = "%s|%s %s" % (cur_name, pri_name, key)
        why = f["contract_elements"]["why_here"]["rationale"]
        assert why[:1].isupper(), (where, why)
        assert not _AUDIENCE_VERB.search(why), (where, why)
        capitalised = label[:1].upper() + label[1:]
        if capitalised != label:
            assert (capitalised + " on ") not in why and (" %s " % capitalised) not in why, (where, why)
        if not f["surfaced"]:
            continue
        assert not re.search(r"\b(\w+) \1\b", f["title"]), (where, f["title"])
        # the why-here paragraph opens its own sentence in the body
        assert (". " + why.rstrip(".") + ". ") in f["body"], (where, f["body"])


# ── 1b. a served code the contract rejects is never the subject ────────────


@pytest.mark.parametrize("pri_name", ["agras", "realestate", "retail", SB.SCANDIA])
def test_a_served_code_the_contract_rejects_is_never_named_and_the_crossing_surfaces(pri_name):
    """carniprod serves line items whose codes carry a stray quote
    (`701.00'`, `6028.10'`, `6410.10'`). Ranked by balance, `701.00'` is its
    second revenue line, so every revenue-denominated crossing with carniprod
    as the current period used to demote on formatting alone."""
    body = SB.served_body("carniprod")
    malformed = {str(li.get("ro_account_code")) for li in body["line_items"]
                 if not F.is_ledger_code(str(li.get("ro_account_code") or ""))}
    assert "701.00'" in malformed, sorted(malformed)
    out = _compose(body, SB.served_body(pri_name), "carniprod", pri_name)
    findings = out["band_movements"]["findings"]
    revenue = [f for f in findings if "revenue" in sum(CB.SUBJECT_BUCKETS[f["ratio_key"]], ())]
    assert revenue, "non-vacuity: carniprod|%s carries no revenue-bucket crossing" % pri_name
    for f in findings:
        codes = [a["code"] for a in f["contract_elements"]["subject"]["accounts"]]
        assert not set(codes) & malformed, (f["ratio_key"], codes)
        assert not any("is not a ledger code" in r for r in f["demotion_reasons"]), (
            f["ratio_key"], f["demotion_reasons"])
    for f in revenue:
        assert f["surfaced"], (f["ratio_key"], f["demotion_reasons"])


def test_subject_selection_skips_a_nameless_line_and_takes_the_next_account():
    """The name half of the same filter: validate() also rejects an account
    with no name, so selection passes over it to the next balance."""
    items = [
        {"bucket": "revenue", "ro_account_code": "701", "ro_account_name": "  ", "amount": 900.0},
        {"bucket": "revenue", "ro_account_code": "704'", "ro_account_name": "Servicii", "amount": 800.0},
        {"bucket": "revenue", "ro_account_code": "707", "ro_account_name": "Marfuri", "amount": 700.0},
    ]
    assert [a.code for a in CB._accounts(items, ("revenue",), 1, ())] == ["707"]


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


def _without_subject_lines(body: Dict[str, Any], key: str) -> Dict[str, Any]:
    """`body` with every served line item in `key`'s subject buckets removed —
    the ratio still computes (it reads the canonical totals), its finding
    can name no account."""
    numerator, denominator = CB.SUBJECT_BUCKETS[key]
    drop = set(numerator) | set(denominator)
    out = copy.deepcopy(body)
    out["line_items"] = [li for li in out["line_items"] if li.get("bucket") not in drop]
    return out


@pytest.mark.parametrize("cur_name,pri_name", [("agras", "carniprod"), ("retail", "realestate")])
def test_the_movement_lists_partition_both_sides_and_demoted_crossings_stay_listed(cur_name, pri_name):
    natural = _compose(SB.served_body(cur_name), SB.served_body(pri_name), cur_name, pri_name)
    surfaced = [f["ratio_key"] for f in natural["band_movements"]["findings"] if f["surfaced"]]
    assert surfaced, "non-vacuity: %s|%s surfaces no crossing to demote" % (cur_name, pri_name)
    # PLANT A DEMOTION rather than lean on a natural one (which rulings may
    # remove): the top surfaced crossing loses its subject lines.
    planted_key = surfaced[0]
    cur_body = _without_subject_lines(SB.served_body(cur_name), planted_key)
    out = _compose(cur_body, SB.served_body(pri_name), cur_name, pri_name)
    bm, cov = out["band_movements"], out["coverage"]
    for bucket in ("improved", "deteriorated", "unchanged", "not_comparable", "refused"):
        assert bm[bucket] == natural["band_movements"][bucket], (
            "removing line items moved the %s list: the plant must touch the subject only" % bucket)

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
    by_key = {f["ratio_key"]: f for f in bm["findings"]}
    assert planted_key in by_key, "the planted demotion %s was dropped from the findings" % planted_key
    planted = by_key[planted_key]
    assert not planted["surfaced"] and "subject" in planted["missing_elements"], (
        planted_key, planted["missing_elements"])
    for f in bm["findings"]:
        if not f["surfaced"]:
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


# ── 6. the two-period caveat names what is approximated (ruling Q4) ───────


def test_a_two_period_finding_never_says_no_prior_period_was_supplied():
    from engine.api import _company_profile as CP

    pack_text = CP.load_catalog().caveat_text(CP.CAVEAT_APPROX_CF)
    assert "no prior" in pack_text, "the single-period pack caveat changed: %r" % pack_text
    two_period = CB.TWO_PERIOD_CAVEATS[CP.CAVEAT_APPROX_CF]
    carried = 0
    for cur_name, pri_name in PAIRS:
        out = _compose(SB.served_body(cur_name), SB.served_body(pri_name), cur_name, pri_name)
        for f in out["band_movements"]["findings"]:
            where = "%s|%s %s" % (cur_name, pri_name, f["ratio_key"])
            caveat = f["contract_elements"]["confidence"]["caveat"] or ""
            assert "no prior period" not in caveat and "no prior period" not in (f.get("body") or ""), (where, caveat)
            if two_period.rstrip(".") in caveat:
                carried += 1
    assert carried >= 20, "non-vacuity: only %d findings carry the approximated cash-flow caveat" % carried


# ── 1c. contra accounts are never the subject; rank is by signed amount (Q5) ──


def _eligible(line_items, buckets, taken):
    out = []
    for li in line_items:
        code = str(li.get("ro_account_code") or "")
        amount = li.get("amount")
        if li.get("bucket") not in buckets or not code or code in taken:
            continue
        if isinstance(amount, bool) or not isinstance(amount, (int, float)):
            continue
        if not F.is_ledger_code(code) or not str(li.get("ro_account_name") or "").strip():
            continue
        if code[:2] in ("28", "29", "39", "49"):
            continue
        out.append((-float(amount), code))
    return [c for _a, c in sorted(out)]


def test_no_finding_names_a_contra_account_and_subjects_rank_by_signed_amount():
    checked = 0
    for cur_name, pri_name in PAIRS:
        body = SB.served_body(cur_name)
        out = _compose(body, SB.served_body(pri_name), cur_name, pri_name)
        for f in out["band_movements"]["findings"]:
            key = f["ratio_key"]
            codes = [a["code"] for a in f["contract_elements"]["subject"]["accounts"]]
            where = "%s|%s %s" % (cur_name, pri_name, key)
            assert not [c for c in codes if c[:2] in ("28", "29", "39", "49")], (where, codes)
            numerator, denominator = CB.SUBJECT_BUCKETS[key]
            want = []
            for c in _eligible(body["line_items"], set(numerator), ()):
                if c not in want:
                    want.append(c)
                if len(want) == CB.SUBJECT_NUMERATOR_ACCOUNTS:
                    break
            den = _eligible(body["line_items"], set(denominator), want)[:CB.SUBJECT_DENOMINATOR_ACCOUNTS]
            assert codes == want + den, (where, codes, want + den)
            checked += 1
    assert checked >= 300, "non-vacuity: %d findings checked" % checked


def test_a_provision_or_an_opposite_side_line_never_outranks_the_bucket():
    """Planted, because on the real pairs signed ranking alone already keeps
    every contra line out of the top slots (measured: removing the exclusion
    leaves the census above green) — the exclusion is only visible where a
    bucket has fewer natural-side lines than the subject takes."""
    contra = [
        {"bucket": "ar", "ro_account_code": "4111", "ro_account_name": "Clienti", "amount": 100.0},
        {"bucket": "ar", "ro_account_code": "491", "ro_account_name": "Ajustari clienti", "amount": -900.0},
        {"bucket": "ppe", "ro_account_code": "2131", "ro_account_name": "Echipamente", "amount": 700.0},
        {"bucket": "ppe", "ro_account_code": "2813", "ro_account_name": "Amortizare", "amount": -5000.0},
        {"bucket": "inventory", "ro_account_code": "397", "ro_account_name": "Ajustari marfuri", "amount": -60.0},
        {"bucket": "ppe", "ro_account_code": "2911", "ro_account_name": "Ajustari terenuri", "amount": -10.0},
    ]
    assert [a.code for a in CB._accounts(contra, ("ar", "ppe", "inventory"), 4, ())] == ["2131", "4111"]
    opposite = [
        {"bucket": "ar", "ro_account_code": "4118", "ro_account_name": "Clienti incerti", "amount": -800.0},
        {"bucket": "ar", "ro_account_code": "4111", "ro_account_name": "Clienti", "amount": 100.0},
        {"bucket": "ar", "ro_account_code": "4112", "ro_account_name": "Clienti interni", "amount": 50.0},
    ]
    assert [a.code for a in CB._accounts(opposite, ("ar",), 2, ())] == ["4111", "4112"]
