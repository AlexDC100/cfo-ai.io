"""THREE DEFECTS THAT WOULD HAVE SHIPPED, STATED AS LAW.

All three were found by READING the seven findings a real book produces,
not by a failing test. That is the point of reading output: each was
green, each was plausible, and each was wrong in a way a reader would
have believed.

  1. THE SAME EXPOSURE, TWICE. Agras surfaced RON 7,692,202.74 of
     related-party balances at rank 3 (`ro_related_party_exposure`, the
     detector lane) AND at rank 4 (`concentration_related_party`, the
     engine lane) — adjacent, under two names. The ranker groups on
     `root_cause`, and the two lanes spell the same accounts
     differently: the engine names the SYNTHETICS it scans
     (`461+451+452+455`), the detector the ANALYTICS that carry the
     balance (`4511.01+461.016+461.07`). Two of a reader's seven slots
     spent saying one thing.

  2. A TEMPLATE TOKEN IN THE PROSE. `ro_asset_age` rendered "the
     remaining net book value carries not computed charge periods of
     life". The detector's own sentence branches correctly when there is
     no depreciation charge to divide by; the PACK's `why` template
     interpolates `{life}` unconditionally, and the absent form of that
     token was the words "not computed".

  3. EVERY AGGREGATE DOUBLED. All five of `Group`'s accessors summed
     `self.rows`, which on a spine-built book carries a synthetic AND its
     analytics. `assetage` reported RON 22,011,353.08 of net book value
     where the served balance sheet carries RON 11,005,676.54. The 70.5%
     share it fired on looked right the whole time — a ratio of two
     doubled numbers is the same ratio — so this file asserts ABSOLUTE
     values against the served statement, never a share.

WHAT THIS REDS ON (TC-11)
  · two surfaced findings citing the same subject money on overlapping
    synthetic accounts;
  · any placeholder-shaped token reaching a surfaced finding's prose;
  · any published money figure differing from the served figure it
    reconciles to, by any amount;
  · the merge key ceasing to normalize analytic codes to synthetics.
WHAT IT CANNOT SEE
  · a duplicate whose two lanes cite DIFFERENT money for the same
    exposure. Nothing in the payload could join those.

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from engine.api import _company_profile as CP
from engine.consensus import selfcheck as SC
from engine.frontends.saga10 import Saga10FrontEnd
from engine.radar import detectors as D
from engine.radar import serve as RS
from engine.radar import series as S
from engine.radar.detectors import from_series as FS
from engine.serving import FactsGateway

REPO = Path(__file__).resolve().parents[2]
PACKS = str(REPO / "packs")
BOOKS = ("agras", "carniprod", "retail", "realestate")
_CACHE = {}


def _capture(name):
    return json.loads((REPO / "tests" / "engine" / "fixtures" / "radar"
                       / ("saga_10_col_%s.json" % name)).read_text(encoding="utf-8"))


def _served(name):
    """One Radar payload with the detector lane ON, over a real book."""
    if name in _CACHE:
        return _CACHE[name]
    fx = _capture(name)
    digest = fx["envelope"]["provenance"]["content_hash"]
    target = RS.PeriodInput(
        period_id="p-%s" % name, label="FY2025", period_end=fx["period_end"],
        period_start=fx["period_start"], ordinal=0, currency=fx["currency"],
        statements=fx["statements"], envelope=fx["envelope"],
        snapshot_id=digest, source_document_id="doc-%s" % name,
        content_key=digest, line_items=fx["line_items"],
        cui=S.WORKSPACE_IDENTITY_PREFIX + "org-%s" % name, caen="1013")
    _CACHE[name] = RS.serve_period(RS.RadarRequest(
        org_id="org-%s" % name, target=target, detectors_enabled=True,
        detector_jurisdiction="ro", detector_pack_root=PACKS))
    return _CACHE[name]


# ── 1. one exposure is one finding ───────────────────────────────────────


@pytest.mark.parametrize("name", BOOKS)
def test_every_served_root_cause_is_synthetics_only(name):
    """RED ON: `root_cause_of` ceasing to normalize.

    `dedupe_across_lanes` calls `synthetics_of` directly, so the DEDUPE
    survives a regression here — measured: reverting `root_cause_of`
    left the duplicate gate green. But `root_cause` is also the DISMISSAL
    SCOPE and the PERSISTENCE key, and a dismissal recorded against
    `461.016` would stop covering `461` the next period. This asserts the
    key itself, not the behaviour that happens to be defended twice.
    """
    for row in _served(name)["surfaced"]:
        for code in str(row.get("root_cause") or "").split("+"):
            if not code:
                continue
            assert "." not in code, (
                "%s keys on the analytic %r; the engine lane spells the same "
                "account %r and a dismissal on one would not cover the other"
                % (row["id"], code, RS.synthetic_of(code)))
            assert len(code) <= RS.SYNTHETIC_WIDTH, (
                "%s keys on %r, deeper than a synthetic" % (row["id"], code))


def test_a_detector_with_no_charge_to_divide_by_renders_a_whole_sentence():
    """THE ABSENT BRANCH, driven deliberately.

    None of the four corpus books reaches it any more — after the
    leaves repair every one of them states a depreciation charge, so
    `life` is a number and the `{life}` plant could not fire. The branch
    is still there and still one edit from a reader, so it is exercised
    here on a book built to have no charge under 681.

    RED ON: the absent branch handing a template a phrase where a number
    belongs.
    """
    from dataclasses import replace as _replace
    from engine.radar.detectors import book as B

    fx = _capture("agras")
    doc, _n = Saga10FrontEnd().parse(
        (REPO / "corpus" / "saga_10_col_agras" / "input.xlsx").read_bytes())
    spine = S.build_from_ledger_rows(
        S.EntityKey.of("ws", "RO123"),
        [S.LedgerPeriodInput(
            period_id="p0", fiscal_end="2025-12-31", ordinal=0,
            currency=str(doc.header.currency), cui="RO123",
            rows=S.rows_from_ledger_doc(doc), snapshot_key="k",
            cumulative_semantics=SC.CUMULATIVE_WITH_OPENING)])
    series = FS.book_series_from_spine(spine)
    book = series.books[0]
    # Strip the depreciation charge, and nothing else.
    stripped = B.PeriodBook(
        period_id=book.period_id, label=book.label, ordinal=book.ordinal,
        currency=book.currency, year=book.year, month=book.month,
        basis=B.BasisTotals(
            total_assets=(fx["statements"].get("assembled_bs") or {}).get("total_assets"),
            revenue=(fx["statements"].get("assembled_pl") or {}).get("revenue"),
            source="engine-assembled"),
        days_covered=31,
        rows=tuple(_replace(r, period_debit=None, period_credit=None)
                   if r.code.startswith("681") else r for r in book.rows))
    run = D.run_detectors(
        D.load_pack("ro", PACKS), B.BookSeries.of([stripped]),
        CP.build_company_profile(fx["statements"], period_id="p0"))
    rows = [r for r in run.results if r.detector_id == "ro_asset_age" and r.fired]
    assert rows, "the asset-age family did not fire on the charge-free book"
    tokens = rows[0].tokens or {}
    assert "life" not in tokens, (
        "the absent branch handed the template a bare {life} again")
    assert tokens.get("life_clause") == "", (
        "with no charge to divide by, the life clause must be EMPTY — not "
        "a phrase standing in for a number: %r" % tokens.get("life_clause"))


def test_the_merge_key_normalizes_analytic_codes_to_synthetics():
    """RED ON: the two lanes keying on different spellings of one account.

    A dismissal scoped to `461` must also cover a detector finding on
    `461.016` — that is what a reader means by "I have dealt with the 461
    balance"."""
    for code, want in (("4511.01", "451"), ("461.016", "461"),
                       ("4111.01", "411"), ("2131.01", "213"),
                       ("213", "213"), ("461", "461"), ("21", "21")):
        assert RS.synthetic_of(code) == want, code


@pytest.mark.parametrize("name", BOOKS)
def test_no_two_surfaced_findings_state_the_same_exposure(name):
    """THE SHIP-BLOCKER. RED ON: two surfaced rows citing the same subject
    money on overlapping synthetic accounts."""
    payload = _served(name)
    seen = []
    for row in payload["surfaced"]:
        synths = set(str(row.get("root_cause") or "").split("+")) - {""}
        money = set()
        for fact, value in (row.get("facts_cited") or {}).items():
            units = row.get("fact_units") or {}
            if units.get(fact) != "money" or fact in RS.CONTEXT_FACTS:
                continue
            if isinstance(value, (int, float)) and abs(value) > 0:
                money.add(round(float(value), 2))
        for other_id, other_synths, other_money in seen:
            overlap = synths & other_synths
            same = money & other_money
            assert not (overlap and same), (
                "%s and %s both state %s on %s — one exposure is one "
                "finding, and two of the reader's seven slots are spent "
                "saying it twice"
                % (row["id"], other_id,
                   ", ".join("{:,.2f}".format(v) for v in sorted(same)),
                   "+".join(sorted(overlap))))
        seen.append((row["id"], synths, money))
    assert seen, "no finding surfaced at all; the gate is vacuous"


def test_a_merged_duplicate_leaves_a_check_row_naming_what_absorbed_it():
    """RED ON: a duplicate vanishing silently. Suppression a reader
    cannot see is indistinguishable from a finding that never fired."""
    payload = _served("agras")
    merged = [c for c in payload["checks"] if c.get("merged_into")]
    assert merged, "agras carries the known duplicate; nothing recorded it"
    for check in merged:
        assert check.get("rule_id")
        assert "one exposure is one finding" in (check.get("note") or "")


def test_the_dedupe_does_not_merge_two_findings_that_share_only_context():
    """THE FALSE MERGE, measured. The first form of this compared EVERY
    cited money figure and merged `fx_exposure` into
    `liquidity_cash_tight`: both cite total cash of RON 1,168,047.04 —
    one as the balance whose cover is thin, the other as the denominator
    a foreign-currency share is taken of. Neither is ABOUT total cash.

    RED ON: company totals counting as a subject figure again."""
    ids = [r["id"].split("|")[1] for r in _served("agras")["surfaced"]]
    assert "liquidity_cash_tight" in ids
    assert "fx_exposure" in ids, (
        "the FX finding was absorbed by the liquidity one; they share a "
        "denominator, not a subject")
    assert "total_cash" in RS.CONTEXT_FACTS and "cur_liab" in RS.CONTEXT_FACTS


# ── 2. no placeholder reaches a reader ───────────────────────────────────

#: UNAMBIGUOUS leak shapes only. An earlier draft of this list also held
#: "undefined", "none" and "not computed" — and red on real books, on
#: correct prose: "multiples are undefined for a mid-size inventory-heavy
#: operator at non-positive EBITDA" is a sentence the engine means, and
#: "remaining book life is not computed" is a CAVEAT that is exactly
#: right. A gate that bans the English words a careful writer needs gets
#: deleted by the next person, and deserves to be.
#:
#: So the lexical half catches only what no writer types on purpose, and
#: the STRUCTURAL half below catches the real defect at its source.
LEAK_SHAPES = ("{", "}", "%s", "%d", "%r", "[object", "nan%", "e+0", "e-0")


@pytest.mark.parametrize("name", BOOKS)
def test_no_surfaced_finding_renders_an_unrendered_token(name):
    """RED ON: a template token, a printf placeholder or a raw object
    repr reaching the reader."""
    for row in _served(name)["surfaced"]:
        elements = row.get("contract_elements") or {}
        prose = [("body", row.get("body") or ""),
                 ("title", row.get("title") or ""),
                 ("why_here", (elements.get("why_here") or {}).get("rationale") or "")]
        for step in ((elements.get("action") or {}).get("steps") or []):
            prose.append(("action", "%s %s" % (step.get("imperative") or "",
                                               step.get("artefact") or "")))
        for where, text in prose:
            for token in LEAK_SHAPES:
                assert token not in text, (
                    "%s %s contains %r — an unrendered token reached the "
                    "reader:\n  %s" % (row["id"], where, token, text[:200]))
            assert not re.search(r"\bNone\b", text), (
                "%s %s contains a Python None repr:\n  %s"
                % (row["id"], where, text[:200]))


#: What a detector emits when it HAS no value. Any of these reaching a
#: `tokens` map is a template about to interpolate a phrase where a
#: number belongs — which is exactly what "carries not computed charge
#: periods of life" was.
ABSENT_FORMS = frozenset([
    "not computed", "not available", "not measurable", "unknown",
    "none", "null", "nan", "undefined", "n/a", "-", "—", "",
])


@pytest.mark.parametrize("name", BOOKS)
def test_no_detector_hands_a_template_an_absent_form_as_a_value(name):
    """THE STRUCTURAL HALF, and the real antibody.

    `ro_asset_age` set `tokens["life"] = "not computed"` when there was
    no depreciation charge, and the pack's `why` interpolated it
    unconditionally: "the remaining net book value carries not computed
    charge periods of life". The prose was grammatical nonsense and no
    lexical scan could tell it from a sentence that means those words.

    A token is a VALUE. When there is no value, the fix is a clause that
    can be empty — `{life_clause}` — not a phrase standing in for a
    number. RED ON: any token whose value is an absent-form.

    A token whose NAME ends in `_clause` is exempt: an empty clause is
    the correct representation of "this sentence has no such part".
    """
    fx = _capture(name)
    doc, _notes = Saga10FrontEnd().parse(
        (REPO / "corpus" / ("saga_10_col_%s" % name) / "input.xlsx").read_bytes())
    spine = S.build_from_ledger_rows(
        S.EntityKey.of("ws", "RO123"),
        [S.LedgerPeriodInput(
            period_id="p0", fiscal_end="2025-12-31", ordinal=0,
            currency=str(doc.header.currency), cui="RO123",
            rows=S.rows_from_ledger_doc(doc), snapshot_key="k",
            cumulative_semantics=SC.CUMULATIVE_WITH_OPENING)])
    bs = fx["statements"].get("assembled_bs") or {}
    pl = fx["statements"].get("assembled_pl") or {}
    series = FS.book_series_from_spine(
        spine,
        basis_by_period={"p0": D.BasisTotals(
            total_assets=bs.get("total_assets"), revenue=pl.get("revenue"),
            source="engine-assembled")},
        days_by_period={"p0": 31})
    run = D.run_detectors(D.load_pack("ro", PACKS), series,
                          CP.build_company_profile(fx["statements"], period_id="p0"))
    checked = 0
    for result in run.results:
        for token, value in (result.tokens or {}).items():
            if token.endswith("_clause"):
                continue
            assert str(value).strip().lower() not in ABSENT_FORMS, (
                "%s hands the template %r as the value of {%s} — a token is "
                "a value, and a phrase standing in for a number renders as "
                "grammatical nonsense. Use an empty `_clause` token."
                % (result.detector_id, value, token))
            checked += 1
    # Realestate fires nothing, so it emits no token — correct for that
    # book, and not a reason to loosen the others. The non-vacuity claim
    # is made once, below, on a book that does fire.
    if name == "agras":
        assert checked > 0, "agras emits tokens; the gate has gone vacuous"


def test_the_absent_life_case_renders_a_whole_sentence():
    """RED ON: the `{life}` token coming back."""
    payload = _served("agras")
    rows = [r for r in payload["surfaced"] if "asset_age" in r["id"]]
    assert rows, "agras surfaces the asset-age finding"
    rationale = ((rows[0].get("contract_elements") or {}).get("why_here")
                 or {}).get("rationale") or ""
    assert rationale.strip().endswith("."), rationale
    assert "  " not in rationale, "a collapsed token left a double space"


# ── 3. the absolute figure, not the ratio ────────────────────────────────


def _served_rows(name):
    fx = _capture(name)
    gw = FactsGateway.from_envelope(fx["envelope"], currency=fx["currency"])
    canonical = gw.served_canonical_bs
    return {str(r.get("id")): float(r.get("amount") or 0)
            for r in (canonical or {}).get("rows", [])}


@pytest.mark.parametrize("name", BOOKS)
def test_every_published_money_figure_equals_the_served_figure(name):
    """THE DOUBLING GATE, asserted on ABSOLUTE values.

    `assetage` reported twice the net book value for weeks and the share
    it fired on was correct throughout, because a ratio of two doubled
    numbers is the same ratio. Only the money gave it away.

    RED ON: any published figure differing from the served statement by
    any amount — not by a percentage.
    """
    fx = _capture(name)
    doc, _notes = Saga10FrontEnd().parse(
        (REPO / "corpus" / ("saga_10_col_%s" % name) / "input.xlsx").read_bytes())
    spine = S.build_from_ledger_rows(
        S.EntityKey.of("ws", "RO123"),
        [S.LedgerPeriodInput(
            period_id="p0", fiscal_end="2025-12-31", ordinal=0,
            currency=str(doc.header.currency), cui="RO123",
            rows=S.rows_from_ledger_doc(doc), snapshot_key="k",
            cumulative_semantics=SC.CUMULATIVE_WITH_OPENING)])
    bs = fx["statements"].get("assembled_bs") or {}
    pl = fx["statements"].get("assembled_pl") or {}
    series = FS.book_series_from_spine(
        spine,
        basis_by_period={"p0": D.BasisTotals(
            total_assets=bs.get("total_assets"), revenue=pl.get("revenue"),
            source="engine-assembled")},
        days_by_period={"p0": 31})
    run = D.run_detectors(D.load_pack("ro", PACKS), series,
                          CP.build_company_profile(fx["statements"], period_id="p0"))

    rows = _served_rows(name)
    ppe_net = sum(rows.get(k, 0.0) for k in (
        "ppe_land", "ppe_buildings", "ppe_machinery_equipment",
        "ppe_furniture_office", "accumulated_depreciation_ppe"))
    expected = {
        "interco_balance": abs(rows.get("ar_intercompany", 0.0)),
        "net_book_value": abs(ppe_net),
    }

    checked = 0
    for result in run.results:
        if not result.fired:
            continue
        for figure in result.figures:
            want = expected.get(figure.fact)
            if want is None or want == 0.0:
                continue
            got = abs(float(figure.value))
            assert abs(got - want) < 0.02, (
                "%s on %s publishes %s where the served statement carries "
                "%s (%.4fx) — a share computed from this would look right "
                "and the money would not"
                % (figure.fact, name, "{:,.2f}".format(got),
                   "{:,.2f}".format(want), got / want if want else 0))
            checked += 1
    if name == "agras":
        assert checked >= 2, "agras publishes both figures; gate went quiet"


def test_a_group_aggregate_sums_leaves_not_rows():
    """RED ON: the doubling coming back at its source. All five of
    `Group`'s accessors go through `_leaf_sum`; a spine-built book always
    carries a synthetic AND its analytics."""
    from engine.radar.detectors import book as B

    rows = (
        B.AccountRow(code="213", name="parent", atom_id="a",
                     closing_debit=300.0, closing_credit=0.0),
        B.AccountRow(code="2131.01", name="child", atom_id="b",
                     closing_debit=200.0, closing_credit=0.0),
        B.AccountRow(code="2133.01", name="child", atom_id="c",
                     closing_debit=100.0, closing_credit=0.0),
    )
    group = B.Group(prefixes=("21",), rows=rows)
    assert group.closing() == 300.0, (
        "the parent restates its children; summing all three gives 600 and "
        "every share computed from it still looks right")
    assert len(group.leaves()) == 2
