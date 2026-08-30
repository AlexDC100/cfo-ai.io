"""Advisory unit-sanity validator battery — engine.ai.unit_sanity (S family).

ADVISORY ROLE, HARD LIMITS: it FLAGS, it never rewrites, it never blocks
serving, and it needs no model — so it runs identically with credits
ABSENT. Its availability is TYPED, never a silent bool.

Two checks, both read the claim as a READER would:
  (a) two distinct currency symbols/codes inside ONE sentence;
  (b) a stated percentage implausible against its stated operands.

The calibration case is the live 461 note:
    "holds RON 7,692,203 — 19.6% of total assets 7.467.122,25 EUR"
  → (a) fires: RON and EUR in one claim.
  → (b) fires: 7,692,203 / 7,467,122.25 = 103%, not 19.6%.
The CORRECTED note (both operands native RON) must stay silent — the
19.6% is right and native-native. A validator that flags it is worse
than no validator.

No network anywhere in this file.
"""
from __future__ import annotations

import pytest

from engine.ai import unit_sanity as U


# The live defect, verbatim.
_BROKEN_461 = ("Intercompany exposure: the company holds RON 7,692,203 — "
               "19.6% of total assets 7.467.122,25 EUR.")
# The same claim, native-native. This one is CORRECT.
_FIXED_461 = ("Intercompany exposure: the company holds RON 7,692,203 — "
              "19.6% of total assets RON 39,194,178.")


# ── S1 — mixed currency in one sentence ────────────────────────────────

def test_s1_mixed_currency_codes_in_one_sentence_is_flagged():
    report = U.check(_BROKEN_461)
    codes = {f.code for f in report.findings}
    assert U.CODE_MIXED_CURRENCY in codes
    f = [x for x in report.findings if x.code == U.CODE_MIXED_CURRENCY][0]
    assert set(f.currencies) == {"RON", "EUR"}
    assert f.severity in U.SEVERITIES


def test_s1b_symbol_and_code_count_as_distinct_currencies():
    report = U.check("Holds RON 7,692,203 of total assets 7.467.122,25 €.")
    assert any(f.code == U.CODE_MIXED_CURRENCY for f in report.findings)


def test_s1c_one_currency_across_two_sentences_is_not_a_mix():
    text = "Assets are RON 39,194,178. The EUR translation is a display view."
    report = U.check(text)
    assert not any(f.code == U.CODE_MIXED_CURRENCY for f in report.findings)


# ── S2 — the corrected claim must stay silent ──────────────────────────

def test_s2_native_native_correct_ratio_produces_no_findings():
    report = U.check(_FIXED_461)
    assert report.findings == ()


@pytest.mark.parametrize("text", [
    "Cash of RON 1,781,405 covers 4.5% of total assets RON 39,194,178.",
    "Equity RON 150,151,551 is 51.2% of total assets RON 293,050,085.",
    "EBITDA RON 54,443,834 is 13.2% of turnover RON 413,727,560.",
])
def test_s2b_known_good_claims_stay_silent(text):
    assert U.check(text).findings == ()


# ── S3 — implausible percentage against stated operands ────────────────

def test_s3_implausible_percentage_is_flagged():
    report = U.check(_BROKEN_461)
    pct = [f for f in report.findings if f.code == U.CODE_IMPLAUSIBLE_PCT]
    assert pct, "103%% stated as 19.6%% must be flagged"
    assert pct[0].stated_pct == pytest.approx(19.6, abs=0.01)
    assert pct[0].computed_pct == pytest.approx(103.01, abs=0.5)


def test_s3b_a_ratio_off_by_a_rounding_hair_is_not_flagged():
    # 19.63% stated as 19.6% — correct to one decimal.
    text = "Loans RON 7,692,203 are 19.6% of total assets RON 39,194,178."
    assert U.check(text).findings == ()


def test_s3c_percentage_with_no_two_operands_is_left_alone():
    # Nothing to check against — silence, not a guess.
    assert U.check("Margin improved to 13.2% this period.").findings == ()


# ── S4 / S5 — number parsing is honest about ambiguity ─────────────────

def test_s4_ro_locale_numbers_are_parsed():
    assert U.parse_number("7.467.122,25") == pytest.approx(7467122.25)
    assert U.parse_number("39.194.178") == pytest.approx(39194178.0)


def test_s4b_en_locale_numbers_are_parsed():
    assert U.parse_number("7,692,202.74") == pytest.approx(7692202.74)
    assert U.parse_number("39,194,178") == pytest.approx(39194178.0)


def test_s5_ambiguous_number_returns_none_never_a_guess():
    # "1,234" is 1234 (en) or 1.234 (ro). ABSENT != ZERO, and != a guess.
    assert U.parse_number("1,234") is None
    assert U.parse_number("1.234") is None
    assert U.parse_number("not a number") is None


def test_s5b_ambiguity_suppresses_the_ratio_check_rather_than_guessing():
    text = "Loans RON 1,234 are 50.0% of total assets RON 5,678."
    assert not any(f.code == U.CODE_IMPLAUSIBLE_PCT for f in U.check(text).findings)


# ── S6 — runs with credits ABSENT; availability is TYPED ───────────────

def test_s6_availability_is_typed_and_does_not_depend_on_credits(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    a = U.availability()
    assert isinstance(a, U.Availability)
    assert a.available is True
    assert a.reason == "deterministic"
    assert a.uses_model is False


def test_s6b_validator_still_flags_with_no_key_and_a_poisoned_client(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    def _explode():  # any attempt to build a client would blow up
        raise RuntimeError("no credits")

    monkeypatch.setattr("engine.ai.advisory._default_client_factory", _explode,
                        raising=False)
    report = U.check(_BROKEN_461)
    assert report.findings
    assert report.availability.available is True


def test_s6c_module_imports_no_anthropic_client():
    import inspect

    src = inspect.getsource(U)
    assert "anthropic" not in src.lower().replace("no anthropic", "")


# ── S7 — flags only, NEVER rewrites ────────────────────────────────────

def test_s7_input_text_is_returned_unmodified():
    report = U.check(_BROKEN_461)
    assert report.text == _BROKEN_461
    # There is no rewrite surface at all.
    assert not hasattr(U, "fix")
    assert not hasattr(U, "rewrite")


def test_s7b_findings_are_advisory_severity_only():
    for f in U.check(_BROKEN_461).findings:
        assert f.severity in U.SEVERITIES
        assert f.blocking is False


# ── S8 — never raises, never blocks ────────────────────────────────────

@pytest.mark.parametrize("garbage", [None, 42, b"x", ["a"], {"k": "v"}, ""])
def test_s8_check_never_raises(garbage):
    report = U.check(garbage)
    assert isinstance(report, U.SanityReport)
    assert report.findings == () or all(f.blocking is False for f in report.findings)


def test_s9_zero_false_positives_across_the_real_engine_rule_corpus():
    """The engine's own alert bodies, rendered from real production values.

    Every one of these is a CORRECT, rule-authored, native-RON claim. A
    finding here is a false positive — and a false flag on a correct
    claim is worse than no validator, because it trains the operator to
    ignore the channel. These templates are transcribed from
    `pipeline.py::stage_validate`; they include the shapes that make a
    naive checker misfire: account codes ("Account 461", "on 628"), a law
    article ("Art. 153^24"), a leverage multiple ("8.53×"), and three
    money figures in one sentence.
    """
    intercompany, total_assets = 7692202.74, 39194178.46
    pct = intercompany / total_assets
    total_equity = 19194178.46
    revaluation = 12000000.0
    share_pct = revaluation / total_equity * 100
    ebitda_statutory, ebitda_operational = 2127404.0, -36676.0
    cfo, capex = 1781405.0, 2164080.0

    rows = [
        {"title": "Balance sheet does not balance — drift RON 1,234",
         "body": f"Total assets RON {total_assets:,.0f} vs liabilities + equity "
                 f"RON {total_assets - 1234:,.0f} differ by RON 1,234 (0.0% of "
                 f"assets). Pipeline integrity issue."},
        {"title": "Debt/EBITDA at 8.53× exceeds 12.0× critical threshold",
         "body": f"Bank debt RON 18,150,000 divided by statutory EBITDA RON "
                 f"{ebitda_statutory:,.0f} = 8.53×, above the 12.0× critical "
                 f"threshold typical for this industry."},
        {"title": "Equity below half of registered share capital",
         "body": "Under Romanian Company Law Art. 153^24, when equity falls "
                 "below half of registered share capital the administrator "
                 "must convene the general meeting."},
        {"title": f"Capitalized own-work RON {capex:,.0f} = 62% of rental revenue",
         "body": f"Account 722 carries RON {capex:,.0f} of capitalized own-work, "
                 f"mirrored by a roughly equal cost on 628 — net P&L effect is "
                 f"approximately zero. Statutory EBITDA RON "
                 f"{ebitda_statutory:,.0f} (with 722) vs operational view RON "
                 f"{ebitda_operational:,.0f} (without)."},
        {"title": f"Revaluation reserves are {share_pct:.0f}% of equity",
         "body": f"Account 105 of RON {revaluation:,.0f} represents "
                 f"{share_pct:.0f}% of total equity RON {total_equity:,.0f}. "
                 f"This is a non-cash accounting reserve."},
        {"title": f"Intercompany receivable RON {intercompany:,.0f} = "
                  f"{pct*100:.1f}% of total assets",
         "body": f"Account 461 (Debitori diverși) holds RON {intercompany:,.0f} "
                 f"due from related parties — {pct*100:.1f}% of total assets RON "
                 f"{total_assets:,.0f}. Recoverability should be confirmed."},
        {"title": "RON 4,500,000 dividends declared but not paid in cash",
         "body": "Account 457 carries RON 4,500,000 liability. Dividends were "
                 "debited to retained earnings but no cash distribution occurred."},
        {"title": "Free cash flow RON -382,675 — one-time CIP capex",
         "body": f"Operating cash flow RON {cfo:,.0f} minus capex RON "
                 f"{capex:,.0f} (RON {capex:,.0f} into account 231 Construction "
                 f"in Progress) produces negative FCF this period."},
    ]
    assert U.check_alerts(rows) == ()


def test_s10_the_defect_row_exactly_as_it_rendered_is_caught_twice():
    """The live 461 note as a EUR-display user actually saw it. Both
    checks must fire: two currencies in one claim, and a percentage that
    its own stated operands contradict."""
    row = [{
        "title": "Intercompany receivable RON 7,692,203 = 19.6% of total assets",
        "body": "Account 461 (Debitori diverși) holds RON 7,692,203 due from "
                "related parties — 19.6% of total assets 7.467.122,25 €. "
                "Recoverability and intent on settlement should be confirmed.",
    }]
    codes = {f.code for f in U.check_alerts(row)}
    assert codes == {U.CODE_MIXED_CURRENCY, U.CODE_IMPLAUSIBLE_PCT}


def test_s8b_check_alerts_scans_a_batch_and_never_raises():
    alerts = [
        {"title": "Intercompany concentration", "body": _BROKEN_461},
        {"title": "Fine", "body": _FIXED_461},
        None,
        {"title": None, "body": None},
    ]
    findings = U.check_alerts(alerts)
    assert any(f.code == U.CODE_MIXED_CURRENCY for f in findings)
    # Findings carry the row they came from, so an operator can locate it.
    assert any(f.pointer == "0:body" for f in findings)
