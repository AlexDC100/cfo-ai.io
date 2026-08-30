"""RATIO LAW + TYPED PLACEHOLDERS — the structural gates (Part B).

Run standalone:

    .venv/bin/python -m pytest tests/engine/test_ratio_units.py -q

THE DEFECT THIS FILE MAKES UNREPEATABLE (2026-08-30, live, severity-max)
-----------------------------------------------------------------------
The Critical-461 note rendered

    "holds RON 7,692,203 — 19.6% of total assets 7.467.122,25 €"

a native RON figure beside a display-converted EUR figure in ONE claim.
The 19.6% itself was CORRECT and native-native (7,692,202.74 /
39,194,178.46). The harm was the rendering boundary: the note is authored
as a plain string in the source currency, and only *some* of its numbers
later pass through a converting renderer.

Two structural answers are gated here.

G1..G6  THE RATIO LAW. A ratio is computed from operands of identical
        currency AND identical scale, or it is not computed at all. The
        helper raises a typed refusal; it NEVER coerces, and it never
        divides across a unit boundary. ABSENT != ZERO: a zero or absent
        denominator is an undefined ratio, not 0.0.

G7..G13 TYPED PLACEHOLDERS. A narrative body stops carrying formatted
        digits and starts carrying a reference to a FACT
        ("{{money:total_assets}}"), resolved at render time through the
        same money path the rest of the UI uses. The engine — the only
        layer that knows which facts are money — marks them; no consumer
        has to guess from magnitude any more.

G13 is the load-bearing one: rendering a template back through the
NATIVE resolver must reproduce the original body BYTE-FOR-BYTE. That is
what makes the stored plain-text fallback and the template incapable of
disagreeing.
"""

import pytest

from engine.api import _ratio_units as ru


# ── Fixtures: production values, verbatim (period 11b8e759) ───────────────

R7_BODY = (
    "Account 461 (Debitori diverși) holds RON 7,692,203 due from "
    "related parties — 19.6% of total assets RON 39,194,178. "
    "Recoverability and intent on settlement should be confirmed. Lenders "
    "typically haircut related-party receivables during covenant measurement."
)
R7_FACTS = {
    "intercompany_loans": 7692202.74,
    "total_assets": 39194178.46,
    "pct_of_assets": 0.19625880786990732,
}

# fcf_negative_development_phase — the live sign trap. `capex_real` and
# `capitalized_construction` are stored NEGATIVE; the body prints abs().
R9_TITLE = "Free cash flow RON -382,675 — one-time CIP capex"
R9_BODY = (
    "Operating cash flow RON 1,781,405 minus capex RON 2,164,080 "
    "(RON 2,164,080 into account 231 Construction in Progress) "
    "produces negative FCF this period. Development-phase drag, not ongoing burn — "
    "stabilized FCF should be positive once CIP delivers."
)
R9_FACTS = {
    "cash_from_operating": 1781404.53,
    "capex_real": -2164079.83,
    "capitalized_construction": -2164079.83,
    "free_cash_flow": -382675.3,
}


# ══ G1..G6 — THE RATIO LAW ═══════════════════════════════════════════════


def test_g1_matched_operands_return_the_native_quotient_bit_identical():
    """Same currency, same scale → the plain quotient, to the last bit.

    Pins the 461 ratio: any change that alters 19.6% is a regression.
    """
    num = ru.money(R7_FACTS["intercompany_loans"], "RON")
    den = ru.money(R7_FACTS["total_assets"], "RON")
    got = ru.ratio(num, den)
    assert got == R7_FACTS["intercompany_loans"] / R7_FACTS["total_assets"]
    assert got == R7_FACTS["pct_of_assets"]
    assert round(got * 100, 1) == 19.6


def test_g2_currency_mismatch_raises_and_never_coerces():
    """A RON numerator over a EUR denominator is not a ratio. It is a bug."""
    num = ru.money(7692202.74, "RON", name="intercompany_loans")
    den = ru.money(7467122.25, "EUR", name="total_assets")
    with pytest.raises(ru.UnitMismatchError) as exc:
        ru.ratio(num, den)
    msg = str(exc.value)
    assert "RON" in msg and "EUR" in msg
    # The refusal names both operands so the caller can see WHAT collided.
    assert exc.value.numerator is num and exc.value.denominator is den


def test_g3_scale_mismatch_raises_even_when_the_currency_matches():
    """kRON over RON is 1000x wrong and silent. The column
    `expected_cash_impact_kron` is fed both today."""
    num = ru.money(210.0, "RON", scale=1000)   # kRON
    den = ru.money(39194178.46, "RON")          # RON
    with pytest.raises(ru.UnitMismatchError) as exc:
        ru.ratio(num, den)
    assert "scale" in str(exc.value).lower()


def test_g4_unit_mismatch_raises_money_over_days_is_not_a_ratio():
    with pytest.raises(ru.UnitMismatchError):
        ru.ratio(ru.money(1_000_000, "RON"), ru.days(45))


def test_g5_absent_or_zero_denominator_is_undefined_not_zero():
    """ABSENT != ZERO. A zero denominator must not silently produce 0.0."""
    with pytest.raises(ru.UndefinedRatioError):
        ru.ratio(ru.money(1_000_000, "RON"), ru.money(0.0, "RON"))
    # The explicit opt-in returns None — still never 0.0, still never
    # a coerced unit.
    assert ru.safe_ratio(ru.money(1_000_000, "RON"), ru.money(0.0, "RON")) is None
    with pytest.raises(ru.UnitMismatchError):
        ru.safe_ratio(ru.money(1.0, "RON"), ru.money(1.0, "EUR"))


def test_g6_dimensionless_operands_are_allowed_when_they_agree():
    """Ratios of ratios (a coverage multiple over a threshold) are legal
    when both sides are dimensionless; money never enters."""
    assert ru.ratio(ru.ratio_q(8.5), ru.ratio_q(4.0)) == 8.5 / 4.0
    with pytest.raises(ru.UnitMismatchError):
        ru.ratio(ru.ratio_q(8.5), ru.money(4.0, "RON"))


# ══ G7..G13 — TYPED PLACEHOLDERS ═════════════════════════════════════════


def test_g7_units_are_declared_not_guessed():
    """Every fact the 17 deterministic rules emit resolves to a unit.
    An unknown name refuses — it never defaults to money."""
    u = ru.units_for(R7_FACTS)
    assert u["intercompany_loans"] == ru.UNIT_MONEY
    assert u["total_assets"] == ru.UNIT_MONEY
    assert u["pct_of_assets"] == ru.UNIT_PERCENT
    # The two guesses live in production today — both wrong.
    assert ru.unit_for_fact("debt_to_ebitda") == ru.UNIT_RATIO   # not money
    assert ru.unit_for_fact("threshold") == ru.UNIT_RATIO        # not money
    assert ru.unit_for_fact("materials_pct") == ru.UNIT_PERCENT
    assert ru.unit_for_fact("some_fact_nobody_declared") == ru.UNIT_UNKNOWN


def test_g8_templatize_replaces_every_cited_money_figure_and_its_label():
    tpl = ru.templatize(R7_BODY, R7_FACTS, "RON")
    assert "{{money:intercompany_loans}}" in tpl
    assert "{{money:total_assets}}" in tpl
    # No formatted money digits and no currency word survive in the
    # template — that stale label is exactly how the mix appeared.
    assert "7,692,203" not in tpl
    assert "39,194,178" not in tpl
    assert "RON" not in tpl


def test_g9_percentages_are_left_alone_they_are_dimensionless():
    tpl = ru.templatize(R7_BODY, R7_FACTS, "RON")
    assert "19.6%" in tpl


def test_g10_the_sign_trap_is_closed_negative_facts_templatize():
    """The live regression: the linkify regex never consumed a leading
    '-', so every negative money fact stayed RON beside converted
    siblings. Engine-side templatizing sees the sign."""
    tpl = ru.templatize(R9_TITLE, R9_FACTS, "RON")
    assert tpl == "Free cash flow {{money:free_cash_flow}} — one-time CIP capex"


def test_g11_abs_printed_facts_keep_their_printed_sign():
    """R9's body prints abs(capex) while the fact stores it negative.
    The placeholder must record that, or the sentence flips meaning."""
    tpl = ru.templatize(R9_BODY, R9_FACTS, "RON")
    assert "minus capex {{money:capex_real|abs}}" in tpl
    assert "2,164,080" not in tpl
    assert "{{money:cash_from_operating}}" in tpl


def test_g12_an_uncited_number_is_never_claimed_as_money():
    """We cannot assert an unmatched number is money; guessing a currency
    onto it is the same class of error as the one being fixed."""
    body = "Under Romanian Company Law Art. 153^24 the administrator must act within 60 days."
    assert ru.templatize(body, {"total_equity": -12345.0}, "RON") == body


def test_g13_native_render_round_trips_the_original_body_byte_for_byte():
    """THE LOAD-BEARING GATE. The stored plain-text body is the fallback
    for rows that predate templates; if the template could render
    differently from the text it was derived from, the two surfaces would
    disagree the moment one of them was used. They cannot."""
    for text, facts in (
        (R7_BODY, R7_FACTS),
        (R9_BODY, R9_FACTS),
        (R9_TITLE, R9_FACTS),
    ):
        tpl = ru.templatize(text, facts, "RON")
        assert ru.render_native(tpl, facts, "RON") == text


def test_g14_render_native_refuses_a_fact_it_was_not_given():
    """A template whose fact is missing must not print a hole or a zero."""
    tpl = ru.templatize(R7_BODY, R7_FACTS, "RON")
    with pytest.raises(ru.MissingFactError):
        ru.render_native(tpl, {"total_assets": 39194178.46}, "RON")


def test_g15_templatize_is_deterministic_and_idempotent():
    once = ru.templatize(R7_BODY, R7_FACTS, "RON")
    assert ru.templatize(R7_BODY, R7_FACTS, "RON") == once
    # Running it over an already-templatized string changes nothing.
    assert ru.templatize(once, R7_FACTS, "RON") == once


# ══ G16 — THE GATE THAT KEEPS THE CLASS CLOSED ═══════════════════════════


def _cited_fact_names_in_stage_validate():
    """Every key of every `facts` dict literal passed to `_add(...)` inside
    `stage_validate`, read statically off the source with `ast` (no
    pipeline run, no DB)."""
    import ast
    import pathlib

    src = pathlib.Path(__file__).resolve().parents[2] / "src" / "engine" / "api" / "pipeline.py"
    tree = ast.parse(src.read_text(encoding="utf-8"))
    fn = None
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == "stage_validate":
            fn = node
            break
    assert fn is not None, "stage_validate not found — did the rule home move?"

    names = set()
    calls = 0
    for node in ast.walk(fn):
        if not isinstance(node, ast.Call):
            continue
        target = node.func
        if not (isinstance(target, ast.Name) and target.id == "_add"):
            continue
        calls += 1
        facts_arg = node.args[5] if len(node.args) > 5 else None
        if facts_arg is None:
            for kw in node.keywords:
                if kw.arg == "facts":
                    facts_arg = kw.value
        assert isinstance(facts_arg, ast.Dict), "rule {0}: facts must be a dict literal".format(calls)
        for key in facts_arg.keys:
            assert isinstance(key, ast.Constant) and isinstance(key.value, str)
            names.add(key.value)
    return names, calls


def test_g16_every_cited_fact_declares_its_unit():
    """A new rule that cites an undeclared fact fails HERE, not in
    production. Undeclared means UNIT_UNKNOWN, which means the figure is
    never templatized — it keeps its hard-coded source label next to
    converted siblings, which is the 461 defect exactly."""
    names, calls = _cited_fact_names_in_stage_validate()
    assert calls >= 15, "expected the full deterministic rule set, saw {0}".format(calls)
    undeclared = sorted(n for n in names if ru.unit_for_fact(n) == ru.UNIT_UNKNOWN)
    assert not undeclared, (
        "these cited facts have no declared unit — add them to "
        "_MONEY_FACTS / _RATIO_FACTS / _PERCENT_FACTS in _ratio_units.py: "
        + ", ".join(undeclared)
    )


# ══ G17..G20 — stage_validate, end to end, on the real 461 numbers ════════


def _assembled(bs_extra=None, pl_extra=None, cf_extra=None, currency="RON"):
    """Minimal `assembled` in the shape stage_validate reads. No DB, no
    network — the rule engine is pure over these dicts."""
    bs = {
        "total_assets": 39194178.46,
        "total_liabilities": 20000000.0,
        "total_equity": 19194178.46,
        "cash": 500000.0,
        "intercompany_loans": 7692202.74,
        "total_debt": 0.0,
        "share_capital": 0.0,
        "revaluation_reserves": 0.0,
        "bs_balance_delta": 0.0,
    }
    bs.update(bs_extra or {})
    pl = {"revenue": 5000000.0, "ebitda_statutory": 900000.0,
          "ebitda_operational": 900000.0, "capitalized_own_work_memo": 0.0}
    pl.update(pl_extra or {})
    cf = {"cash_from_operating": 0.0, "capex_real": 0.0,
          "free_cash_flow": 0.0, "capitalized_construction": 0.0}
    cf.update(cf_extra or {})
    return {
        "statements": {
            "currency": currency,
            "balanceSheet": {}, "incomeStatement": {},
            "assembled_bs": bs, "assembled_pl": pl, "assembled_cf": cf,
            "subAggregates": {},
        }
    }


def _rule(alerts, rule_key):
    for a in alerts:
        if a.get("rule_key") == rule_key:
            return a
    raise AssertionError("rule {0} did not fire: {1}".format(
        rule_key, [a.get("rule_key") for a in alerts]))


def test_g17_the_461_alert_ships_typed_placeholders_for_both_figures():
    """The reported defect, end to end. Both money figures in the claim
    are placeholders; neither the digits nor the RON label survive in the
    template, so the renderer cannot put one through conversion and leave
    the other behind."""
    from engine.api import pipeline

    alerts = pipeline.stage_validate({}, _assembled(), "period-test")
    a = _rule(alerts, "concentration_intercompany_loan")

    # The TITLE is the surface the containment fix could not reach — it is
    # rendered raw beside a linkified body, which is why all 5 live
    # intercompany rows were still two-currency after c05eab2.
    assert a["title_template"] == (
        "Intercompany receivable {{money:intercompany_loans}} = 19.6% of total assets"
    )
    for key in ("title_template", "body_template"):
        tpl = a[key]
        assert "{{money:intercompany_loans}}" in tpl
        assert "RON" not in tpl
        assert "7,692,203" not in tpl and "39,194,178" not in tpl
    # Both operands of the claim are placeholders in the body — the exact
    # sentence that shipped one native and one converted figure.
    assert "{{money:total_assets}}" in a["body_template"]

    # The ratio is untouched, native, and still in the prose.
    assert "19.6%" in a["body_template"]
    assert abs(a["facts_cited"]["pct_of_assets"] * 100 - 19.63) < 0.01

    # Units are declared, not guessed.
    assert a["fact_units"]["intercompany_loans"] == ru.UNIT_MONEY
    assert a["fact_units"]["pct_of_assets"] == ru.UNIT_PERCENT
    assert a["source_currency"] == "RON"


def test_g18_every_fired_alert_round_trips_to_its_own_plain_text():
    """The fallback contract, on live-shaped data: whatever the engine
    stores as `body` is EXACTLY what its template renders natively. A row
    written before templates and a row written after cannot disagree."""
    from engine.api import pipeline

    scenarios = [
        _assembled(),                                                    # R7
        _assembled(bs_extra={"total_assets": 0.0, "cash": 2_000_000.0,
                             "total_liabilities": 900_000.0,
                             "total_equity": 100_000.0,
                             "share_capital": 5_000_000.0}),             # R2/R4
        _assembled(pl_extra={"capitalized_own_work_memo": 3_000_000.0,
                             "ebitda_statutory": 2127404.0,
                             "ebitda_operational": -36676.13}),          # R5
        _assembled(cf_extra={"cash_from_operating": 1781404.53,
                             "capex_real": -2164079.83,
                             "free_cash_flow": -382675.3,
                             "capitalized_construction": -2164079.83}),  # R9
        _assembled(bs_extra={"total_debt": 14083316.0},
                   pl_extra={"ebitda_statutory": 2127404.0}),            # R3
    ]
    fired = 0
    for assembled in scenarios:
        for a in pipeline.stage_validate({}, assembled, "period-test"):
            if "body_template" not in a:
                continue
            fired += 1
            assert ru.render_native(a["body_template"], a["facts_cited"], "RON") == a["body"]
            assert ru.render_native(a["title_template"], a["facts_cited"], "RON") == a["title"]
    assert fired >= 6, "expected several rules to fire across the scenarios"


def test_g19_the_live_sign_trap_rows_are_now_convertible():
    """The two bodies confirmed two-currency in production. Every money
    token in them — negatives and abs()-printed alike — is a placeholder."""
    from engine.api import pipeline

    alerts = pipeline.stage_validate({}, _assembled(cf_extra={
        "cash_from_operating": 1781404.53, "capex_real": -2164079.83,
        "free_cash_flow": -382675.3, "capitalized_construction": -2164079.83,
    }), "period-test")
    fcf = _rule(alerts, "fcf_negative_development_phase")
    assert "RON" not in fcf["title_template"] and "RON" not in fcf["body_template"]
    assert "{{money:free_cash_flow}}" in fcf["title_template"]
    assert "|abs}}" in fcf["body_template"]

    alerts = pipeline.stage_validate({}, _assembled(pl_extra={
        "capitalized_own_work_memo": 3_000_000.0,
        "ebitda_statutory": 2127404.0, "ebitda_operational": -36676.13,
    }), "period-test")
    eq = _rule(alerts, "earnings_quality_capitalized_own_work")
    assert "RON" not in eq["body_template"]
    assert "{{money:ebitda_operational}}" in eq["body_template"]


def test_g20_a_ratio_fact_is_never_marked_as_money():
    """`debt_to_ebitda: 8.5` and `threshold: 12.0` are multiples. The
    production facts expander currency-formats every fact with |v| > 1,
    which renders 8.5x as a currency amount; declared units end that."""
    from engine.api import pipeline

    alerts = pipeline.stage_validate(
        {}, _assembled(bs_extra={"total_debt": 14083316.0},
                       pl_extra={"ebitda_statutory": 2127404.0}), "period-test")
    a = _rule(alerts, "leverage_debt_to_ebitda_high")
    assert a["fact_units"]["debt_to_ebitda"] == ru.UNIT_RATIO
    assert a["fact_units"]["threshold"] == ru.UNIT_RATIO
    assert a["fact_units"]["bank_debt_total"] == ru.UNIT_MONEY
    # ...and the multiple stays literal in the prose — it is dimensionless.
    assert "6.62×" in a["body_template"] or "6.62" in a["body_template"]


def test_g21_a_broken_extract_skips_the_rule_it_does_not_raise():
    """The ratio law refuses an undefined denominator — correct for a
    caller that can act on it, wrong for the ONE ratio stage_validate
    computes unconditionally. A non-finite total from a broken extract
    must skip the imbalance rule the way it always did, not take down the
    validate stage of a live upload."""
    from engine.api import pipeline

    nan = float("nan")
    alerts = pipeline.stage_validate({}, _assembled(bs_extra={
        "total_assets": nan, "total_liabilities": nan, "bs_balance_delta": nan,
    }), "period-test")
    assert not any(a["rule_key"] == "data_quality_bs_imbalance" for a in alerts)
