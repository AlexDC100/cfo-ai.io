"""The insight engine, measured on the four committed real books.

THE DEFECT THIS LANE EXISTS FOR. The correctness pass made the report
TRUE — the P&L foots, the bridge to account 121 is a labelled row, every
ratio prints its formula. It did not make the report NOTICE. On the live
Agras book a reader was left to spot for themselves that 70.4% of gross
PP&E is already written off with about four years of book life left, that
the current ratio of 2.11 is 1.51 once intercompany receivables come out,
that the bridge to account 121 is 46.6% of the profit the P&L
reconstructed, and that account 413 carries 46,613.06 RON that no
statement line explains.

WHAT THIS GATE REDS ON, after the repair (TC-11):
  · any of the eight detectors failing to fire on the agras book;
  · a per-component figure moving without its expectation moving with it
    (TC-6 — the assertions are per measure, not "asset_age fired");
  · an insight printing a figure that is not one of its own measures, or
    a measure whose value contradicts the facts it says it consumed;
  · a claim whose percentage disagrees with its own severity chip —
    the R1 defect, and the one this suite caught during construction:
    the earnings-quality claim said 0.1% while its severity said 10.2%
    on the realestate book, because the two picked different bases;
  · an insight losing the ACCOUNT CODES behind its figures, or naming an
    account whose balance does not reproduce from the book;
  · a detector that cannot run going silent instead of landing in
    `not_fired` with a stated reason (ABSENT != ZERO).

WHAT IT CANNOT SEE (TC-11): whether the DETECTOR SET is the right eight —
the list came from the coordinator, not from the data. It cannot see the
severity CALIBRATION being right in an absolute sense (that the agras
asset base "should" be high rather than medium); it pins that the ladder
in the pack is the ladder applied, not that the ladder is wise. It does
not run the HTTP route, and it says nothing about what the report
RENDERS — that is `frontend/lib/__tests__/insightsExport.test.ts`.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

REPO = Path(__file__).resolve().parents[2]
FIRM = REPO / "tests" / "engine" / "fixtures" / "firm"
sys.path.insert(0, str(REPO / "src"))

from engine.insights import build_insights, load_pack  # noqa: E402

BOOKS = ("agras", "carniprod", "realestate", "retail")

#: Every detector the pack declares. Named here so a detector silently
#: dropped from the pack reds instead of shrinking the report.
EXPECTED_DETECTORS = (
    "asset_age",
    "earnings_quality",
    "financial_position",
    "liquidity_quality",
    "reconstruction_gap",
    "related_party_exposure",
    "trade_float",
    "unclassified_balances",
)


def _book(name: str) -> Dict[str, Any]:
    return json.loads((FIRM / ("saga_10_col_%s.json" % name)).read_text())


def _block(name: str) -> Dict[str, Any]:
    return build_insights(_book(name))


def _by_id(block: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    return {i["id"]: i for i in block["insights"]}


def _measure(insight: Dict[str, Any], key: str) -> Optional[float]:
    for m in insight["measures"]:
        if m["key"] == key:
            return m["value"]
    raise AssertionError(
        "insight %r carries no measure %r; it carries: %s"
        % (insight["id"], key, ", ".join(m["key"] for m in insight["measures"]))
    )


def _approx(value: Optional[float], expected: float, tol: float = 0.005) -> None:
    assert value is not None, "expected %s, got an ABSENT measure" % expected
    assert abs(value - expected) <= tol, "expected %s, measured %s" % (
        expected,
        value,
    )


# ── the pack itself ───────────────────────────────────────────────────


def test_the_pack_declares_exactly_the_eight_detectors_that_are_implemented():
    pack = load_pack()
    assert tuple(sorted(d.id for d in pack.detectors)) == EXPECTED_DETECTORS


def test_every_pack_detector_states_the_basis_it_scales_against():
    """R4: a ladder with no stated basis is an absolute threshold wearing
    a percentage sign."""
    for spec in load_pack().detectors:
        assert spec.basis, "%s declares no basis" % spec.id
        assert spec.basis_label, "%s declares no basis label" % spec.id
        assert len(spec.basis_why.split()) >= 12, (
            "%s's basis_why is too short to be a reason a reader can weigh: %r"
            % (spec.id, spec.basis_why)
        )


# ── every detector fires on the owner's book ──────────────────────────


def test_all_eight_detectors_fire_on_the_agras_book():
    block = _block("agras")
    fired = tuple(sorted(i["id"] for i in block["insights"]))
    assert fired == EXPECTED_DETECTORS, (
        "agras is the owner's live book and every detector has evidence on "
        "it; not_fired carried: %s" % block["not_fired"]
    )


@pytest.mark.parametrize("book", BOOKS)
def test_every_declared_detector_either_fires_or_states_its_gap(book: str):
    """ABSENT != ZERO. A detector never simply goes missing."""
    block = _block(book)
    accounted = set(i["id"] for i in block["insights"])
    accounted |= set(n["id"] for n in block["not_fired"])
    assert accounted == set(EXPECTED_DETECTORS)
    for entry in block["not_fired"]:
        assert len(entry["reason"].split()) >= 8, (
            "%s on %s went quiet with a reason too thin to act on: %r"
            % (entry["id"], book, entry["reason"])
        )


def test_the_retail_book_states_why_unclassified_balances_did_not_fire():
    block = _block("retail")
    reasons = {n["id"]: n["reason"] for n in block["not_fired"]}
    assert "unclassified_balances" in reasons
    assert "matched a classification rule" in reasons["unclassified_balances"]


# ── TC-6: per-component expectations, on the owner's numbers ──────────


def test_asset_age_reproduces_the_owners_measurement_on_agras():
    """The owner measured 70.4% depreciated and ~4 years of book life."""
    insight = _by_id(_block("agras"))["asset_age"]
    _approx(_measure(insight, "depreciated_share"), 0.704407, 1e-5)
    _approx(_measure(insight, "gross_ppe"), 37400897.02, 0.01)
    _approx(_measure(insight, "accumulated_depreciation"), 26345447.48, 0.01)
    _approx(_measure(insight, "net_book_value"), 11728539.67, 0.01)
    _approx(_measure(insight, "annual_da"), 2955346.39, 0.01)
    _approx(_measure(insight, "remaining_book_life"), 3.968, 0.01)
    _approx(_measure(insight, "intangible_amortised_share"), 0.873028, 1e-5)
    assert insight["severity"]["level"] == "high"


def test_liquidity_quality_reproduces_the_owners_two_eleven_to_one_five_one():
    insight = _by_id(_block("agras"))["liquidity_quality"]
    _approx(_measure(insight, "current_ratio"), 2.1114, 1e-3)
    _approx(_measure(insight, "current_ratio_trade_only"), 1.5118, 1e-3)
    _approx(_measure(insight, "non_trade"), 7803433.57, 0.01)
    # The disagreement the detector exists to surface: a "strong" current
    # ratio beside a cash ratio under a tenth.
    _approx(_measure(insight, "cash_ratio"), 0.0898, 1e-3)


def test_related_party_exposure_names_the_accounts_and_haircuts_the_ratios():
    insight = _by_id(_block("agras"))["related_party_exposure"]
    _approx(_measure(insight, "related_party"), 7692202.74, 0.01)
    _approx(_measure(insight, "share_of_assets"), 0.19587, 1e-4)
    _approx(_measure(insight, "share_of_equity"), 0.32152, 1e-4)
    _approx(_measure(insight, "equity_ratio"), 0.60918, 1e-4)
    _approx(_measure(insight, "equity_ratio_haircut"), 0.513988, 1e-5)
    codes = [a["code"] for a in insight["accounts"]]
    assert "4511.01" in codes, codes
    # The balances must reproduce the figure the claim printed.
    assert abs(sum(a["amount"] for a in insight["accounts"]) - 7692202.74) < 0.01


def test_reconstruction_gap_is_a_headline_on_agras_not_a_footnote():
    """~47% of the reconstructed profit, per the coordinator's read."""
    insight = _by_id(_block("agras"))["reconstruction_gap"]
    _approx(_measure(insight, "step"), -6572426.01, 0.01)
    _approx(_measure(insight, "reconstructed"), 14106102.03, 0.01)
    _approx(_measure(insight, "statutory"), 7533676.02, 0.01)
    _approx(_measure(insight, "graded_share"), 0.465928, 1e-5)
    assert insight["severity"]["level"] == "high"
    # The evidence names account 121 itself, even though the served line
    # items EXCLUDE it as the profit control account: the canonical row
    # names exactly one account, so the row's amount is that account's
    # balance. A finding about 121 that could not name 121 would be
    # traceable to nothing.
    assert [a["code"] for a in insight["accounts"]] == ["121"]
    _approx(insight["accounts"][0]["amount"], 7533676.02, 0.01)
    # It reconciles: reconstructed + step == statutory, to the cent.
    assert abs(
        _measure(insight, "reconstructed")
        + _measure(insight, "step")
        - _measure(insight, "statutory")
    ) < 0.01


def test_trade_float_prices_the_cycle_in_currency_and_in_days():
    insight = _by_id(_block("agras"))["trade_float"]
    _approx(_measure(insight, "dso"), 26.205674, 1e-4)
    _approx(_measure(insight, "dpo"), 37.175931, 1e-4)
    _approx(_measure(insight, "float_days"), -10.970257, 1e-4)
    _approx(_measure(insight, "float"), 1327011.19, 0.01)


def test_financial_position_flags_the_book_that_earns_more_than_it_pays():
    """Retail earns RON 5.45M of affiliate dividends against an operating
    EBITDA of RON 220k — the case the lane asked to be flagged."""
    insight = _by_id(_block("retail"))["financial_position"]
    _approx(_measure(insight, "financial_income"), 5511010.41, 0.01)
    _approx(_measure(insight, "financial_expense"), 3092377.62, 0.01)
    _approx(_measure(insight, "net_financial"), 2418632.79, 0.01)
    assert insight["severity"]["level"] == "critical"
    assert insight["claim"].startswith(
        "This book earns more on financial assets than it pays on debt"
    ), insight["claim"]

    # And the opposite book gets the opposite sentence, not a sign flip.
    other = _by_id(_block("realestate"))["financial_position"]
    assert other["claim"].startswith("Financing costs the book more"), other["claim"]


def test_earnings_quality_separates_trading_margin_from_the_rest():
    insight = _by_id(_block("retail"))["earnings_quality"]
    _approx(_measure(insight, "non_trading"), 726868.64, 0.01)
    _approx(_measure(insight, "ebitda"), 220162.84, 0.01)
    _approx(_measure(insight, "graded_share"), 3.30147, 1e-4)
    _approx(_measure(insight, "cash_proxy"), 4682050.27, 0.01)
    assert insight["severity"]["level"] == "critical"


def test_unclassified_balances_surfaces_account_413_on_agras():
    """46,613.06 RON in account 413 that the report never mentioned."""
    insight = _by_id(_block("agras"))["unclassified_balances"]
    _approx(_measure(insight, "unclassified"), 46613.06, 0.01)
    _approx(_measure(insight, "account_count"), 1.0, 0.0)
    codes = [a["code"] for a in insight["accounts"]]
    assert codes == ["413"], codes
    _approx(insight["accounts"][0]["amount"], 46613.06, 0.01)
    assert "413" in insight["claim"] or "46,613.06" in insight["claim"]


# ── R1: one concept, one value ────────────────────────────────────────


@pytest.mark.parametrize("book", BOOKS)
def test_a_claims_graded_share_is_the_share_its_severity_was_graded_on(book: str):
    """The defect this caught during construction: on the realestate book
    the earnings-quality claim printed 0.1% (share of a NEGATIVE EBITDA)
    while its own severity chip printed 10.2% (share of revenue, the
    fallback basis). Two numbers for one idea, inside one card."""
    for insight in _block(book)["insights"]:
        keys = [m["key"] for m in insight["measures"]]
        if "graded_share" not in keys:
            continue
        share = _measure(insight, "graded_share")
        materiality = insight["severity"]["materiality"]
        assert share is not None and materiality is not None, insight["id"]
        assert abs(abs(share) - materiality) < 1e-6, (
            "%s on %s prints %r in its claim and %r on its severity chip"
            % (insight["id"], book, share, materiality)
        )


@pytest.mark.parametrize("book", BOOKS)
def test_a_graded_base_measure_is_the_basis_value_the_severity_used(book: str):
    for insight in _block(book)["insights"]:
        keys = [m["key"] for m in insight["measures"]]
        if "graded_base" not in keys:
            continue
        base = _measure(insight, "graded_base")
        assert base is not None
        assert abs(base - insight["severity"]["basis_value"]) < 0.01, insight["id"]


# ── traceability ──────────────────────────────────────────────────────


@pytest.mark.parametrize("book", BOOKS)
def test_every_insight_carries_its_accounts_its_formula_and_its_facts(book: str):
    book_payload = _book(book)
    line_items = {
        li["ro_account_code"]: li for li in book_payload["line_items"]
    }
    for insight in _block(book)["insights"]:
        assert insight["formula"], insight["id"]
        assert insight["facts"], insight["id"]
        assert insight["measures"], insight["id"]
        for account in insight["accounts"]:
            source = line_items.get(account["code"])
            if source is None:
                # An account the served line items do not carry is legal
                # only when the ENVELOPE still vouches for its balance:
                # either it is an `unmapped` entry (account 413 — the
                # whole point of that finding), or it is the sole account
                # behind a canonical row, so the row's amount IS its
                # balance (account 121, EXCLUDED from the line items as
                # the profit control account). Anything else would be a
                # code with a figure attached that nothing supports.
                assert _vouched_by_envelope(book_payload, account), (
                    "%s names account %s with a balance of %s, and neither "
                    "the line items, the unmapped list nor a single-account "
                    "canonical row supports it"
                    % (insight["id"], account["code"], account["amount"])
                )
                continue
            assert abs(account["amount"] - source["amount"]) < 0.01, (
                "%s prints %s for account %s; the book says %s"
                % (insight["id"], account["amount"], account["code"],
                   source["amount"])
            )


@pytest.mark.parametrize("book", BOOKS)
def test_no_insight_prints_a_figure_that_is_not_one_of_its_own_measures(book: str):
    """Every numeral in the rendered claim has to be a measure. A claim
    is a template substituted from the measure table, so this is a
    structural property — the gate reds if anyone ever hand-writes a
    figure into a pack sentence."""
    import re

    numeral = re.compile(r"\d[\d,]*(?:\.\d+)?")
    for insight in _block(book)["insights"]:
        printed = set(numeral.findall(insight["claim"]))
        allowed = set()
        for m in insight["measures"]:
            allowed |= set(numeral.findall(_render(m, _block(book)["currency"])))
        # Account codes are identifiers, not quantities — both the ones
        # the insight lists and the ones the PACK's own sentence names
        # ("statutory profit in account 121"). The template is authored
        # data, so a numeral already in it is not a computed figure; a
        # numeral that appears only AFTER substitution has to be a
        # measure, which is what this gate is for.
        allowed |= set(a["code"] for a in insight["accounts"])
        allowed |= set(numeral.findall(insight["claim_template"]))
        for token in printed:
            assert token in allowed, (
                "%s on %s prints %r, which is not one of its measures"
                % (insight["id"], book, token)
            )


def _vouched_by_envelope(payload: Dict[str, Any],
                         account: Dict[str, Any]) -> bool:
    canonical = payload.get("envelope", {}).get("canonical_bs", {}) or {}
    for entry in canonical.get("unmapped") or []:
        if str(entry.get("code")) == account["code"]:
            amount = float(entry.get("sf_d") or 0.0) - float(
                entry.get("sf_c") or 0.0)
            return abs(amount - account["amount"]) < 0.01
    for row in canonical.get("rows") or []:
        leaves = [str(x) for x in (row.get("leaf_ids") or [])]
        if leaves == [account["code"]]:
            return abs(float(row["amount"]) - account["amount"]) < 0.01
    return False


def _render(measure: Dict[str, Any], currency: str) -> str:
    from engine.insights.measures import Measure, format_measure

    return format_measure(
        Measure(measure["key"], measure["label"], measure["value"],
                measure["unit"], measure.get("noun", "")),
        currency,
    )


@pytest.mark.parametrize("book", BOOKS)
def test_a_serialized_measure_renders_the_same_string_the_claim_printed(book: str):
    """The cross-surface defect, gated.

    `as_dict` is what reaches the frontend; the frontend re-renders it.
    If serialisation rounds harder than rendering resolves, the screen
    prints a different string from the one the engine put in its own
    claim. Measured while building this package: the realestate
    unclassified share is 6e-10, the engine's claim printed "<0.0001%",
    and the serialized measure rounded to 0.0, which renders "0.0%" —
    one concept, two values, one on each surface."""
    block = _block(book)
    currency = block["currency"]
    # The claim string must be reproducible from the SERIALIZED measures
    # alone — which is exactly what the frontend reader does.
    for insight in block["insights"]:
        rebuilt = _rebuild_claim(insight, currency)
        assert rebuilt == insight["claim"], (
            "%s on %s: the engine printed\n  %s\nbut its serialized "
            "measures rebuild to\n  %s" % (insight["id"], book,
                                            insight["claim"], rebuilt)
        )


def _rebuild_claim(insight: Dict[str, Any], currency: str) -> str:
    import re

    index = {m["key"]: m for m in insight["measures"]}

    def _sub(match):
        return _render(index[match.group(2)], currency)

    return re.sub(r"\{(measure|money):([A-Za-z_][A-Za-z0-9_]*)\}",
                  _sub, insight["claim_template"])


# ── ranking ───────────────────────────────────────────────────────────


@pytest.mark.parametrize("book", BOOKS)
def test_the_ranking_is_severity_first_and_states_its_own_tie_break(book: str):
    block = _block(book)
    from engine.insights.packdata import LEVEL_ORDER

    previous = None
    for insight in block["insights"]:
        key = (
            LEVEL_ORDER[insight["severity"]["level"]],
            1 if insight["severity"]["materiality"] is None else 0,
            -(insight["severity"]["materiality"] or 0.0),
            insight["id"],
        )
        if previous is not None:
            assert previous <= key, "%s is out of rank order on %s" % (
                insight["id"], book,
            )
        previous = key
        assert "tie" in insight["rank_basis"].lower(), insight["rank_basis"]


@pytest.mark.parametrize("book", BOOKS)
def test_at_most_five_insights_reach_the_executive_summary(book: str):
    block = _block(book)
    assert len(block["summary_ids"]) <= 5
    assert block["summary_ids"] == [
        i["id"] for i in block["insights"][: len(block["summary_ids"])]
    ]


# ── the ladder renders from the data the verdict used (TC-10) ─────────


@pytest.mark.parametrize("book", BOOKS)
def test_every_severity_carries_the_ladder_it_was_read_against(book: str):
    for insight in _block(book)["insights"]:
        severity = insight["severity"]
        bands = severity["bands"]
        assert bands, insight["id"]
        assert bands[-1]["at_least"] is None, insight["id"]
        levels = [b["level"] for b in bands]
        assert severity["level"] in levels, insight["id"]
        if severity["materiality"] is None:
            continue
        # The printed verdict is the one the printed ladder produces.
        expected = "info"
        for band in bands:
            if band["at_least"] is None or severity["materiality"] >= band["at_least"]:
                expected = band["level"]
                break
        assert severity["level"] == expected, (
            "%s on %s says %s but its own ladder says %s at materiality %s"
            % (insight["id"], book, severity["level"], expected,
               severity["materiality"])
        )
