"""Numeral-rejection guard battery — engine.ai.numerals (U6 family).

THE INVARIANT: *AI carries narrative; it never authors digits.*

Model output destined for narrative must reference facts BY ID. Every
numeral in accepted narrative is a resolved placeholder whose value AND
currency come from one typed fact, atomically. A bare numeral — one the
model wrote itself — is rejected at parse, logged, and the deterministic
template fallback is served instead.

U-family:
  U6.1  a placeholder-only narrative resolves; every digit on screen
        traces to a fact id.
  U6.2  THE PLANTED NUMERAL — mocked model output carrying a literal
        figure is REJECTED and the deterministic fallback is served.
  U6.3  an unresolved placeholder (unknown fact id) is rejected — the
        brace is never served raw.
  U6.4  ABSENT != ZERO — a placeholder naming a fact whose value is
        absent is rejected, never rendered as 0.
  U6.5  echo allowlist — a literal token is only permitted when the
        CALLER declares it; the model cannot smuggle one in.
  U6.6  money is atomic — value and currency come from ONE fact, so a
        narrative can never pair fact A's amount with fact B's label
        (the 461 mixed-currency class of defect, at the source).
  U6.7  two currencies in one narrative is a rejection, not a warning.
  U6.8  modes — off / observe / enforce. observe is byte-identical.
  U6.9  the guard never raises, whatever the model returns.
  U6.10 the narrate-seam adapter: mocked model payload in, guarded
        payload + report out; digits rejected per field.

No network anywhere in this file.
"""
from __future__ import annotations

import pytest

from engine.ai import numerals as N


# ── Fixtures: typed facts, the only legal source of a digit ────────────

def _facts():
    return {
        "intercompany_loans": N.MoneyFact(7692202.74, "RON"),
        "total_assets": N.MoneyFact(39194178.46, "RON"),
        "total_assets_eur": N.MoneyFact(7467122.25, "EUR"),
        "loan_share_pct": N.RatioFact(0.19625, "ratio"),
        "absent_ebitda": N.MoneyFact(None, "RON"),
    }


_FALLBACK = "Intercompany exposure was reviewed against total assets."


# ── U6.1 ───────────────────────────────────────────────────────────────

def test_u6_1_placeholder_only_narrative_is_accepted():
    text = ("The company holds {intercompany_loans} in intercompany loans, "
            "{loan_share_pct} of total assets {total_assets}.")
    r = N.guard(text, _facts(), fallback=_FALLBACK, mode="enforce")
    assert r.accepted is True
    assert r.fallback_used is False
    assert set(r.resolved) == {"intercompany_loans", "loan_share_pct", "total_assets"}
    # Every digit traces to a fact.
    assert "7,692,202.74" in r.text
    assert "39,194,178.46" in r.text
    assert "19.6%" in r.text
    assert "{" not in r.text and "}" not in r.text


# ── U6.2 — THE PLANTED NUMERAL ─────────────────────────────────────────

def test_u6_2_planted_numeral_in_mocked_model_output_is_rejected_with_fallback():
    # Exactly what a model returns when it decides to do the arithmetic.
    mocked_model_output = (
        "The company holds RON 7,692,203 in intercompany loans — 19.6% of "
        "total assets 7.467.122,25 EUR."
    )
    r = N.guard(mocked_model_output, _facts(), fallback=_FALLBACK, mode="enforce")
    assert r.accepted is False
    assert r.fallback_used is True
    assert r.text == _FALLBACK
    codes = {rej.code for rej in r.rejections}
    assert N.CODE_BARE_NUMERAL in codes
    # The planted figures are named in the rejection, for the log.
    joined = " ".join(rej.excerpt for rej in r.rejections)
    assert "7,692,203" in joined


def test_u6_2b_a_single_stray_digit_is_enough_to_reject():
    text = "Intercompany loans reached {intercompany_loans}, up 4 points."
    r = N.guard(text, _facts(), fallback=_FALLBACK, mode="enforce")
    assert r.accepted is False
    assert r.text == _FALLBACK
    assert any(rej.code == N.CODE_BARE_NUMERAL for rej in r.rejections)


# ── U6.3 ───────────────────────────────────────────────────────────────

def test_u6_3_unresolved_placeholder_is_rejected_and_never_served_raw():
    text = "Loans of {intercompany_loans} against {made_up_fact}."
    r = N.guard(text, _facts(), fallback=_FALLBACK, mode="enforce")
    assert r.accepted is False
    assert r.text == _FALLBACK
    assert any(rej.code == N.CODE_UNRESOLVED for rej in r.rejections)
    assert "{made_up_fact}" not in r.text


# ── U6.4 — ABSENT != ZERO ──────────────────────────────────────────────

def test_u6_4_absent_fact_is_rejected_never_rendered_as_zero():
    text = "EBITDA came in at {absent_ebitda}."
    r = N.guard(text, _facts(), fallback=_FALLBACK, mode="enforce")
    assert r.accepted is False
    assert r.text == _FALLBACK
    assert any(rej.code == N.CODE_ABSENT for rej in r.rejections)
    assert "0" not in r.text


# ── U6.5 — echo allowlist ──────────────────────────────────────────────

def test_u6_5_literal_token_needs_caller_declaration():
    text = "In {period_label} loans stood at {intercompany_loans}."
    facts = _facts()
    facts["period_label"] = N.LabelFact("FY2025")
    r = N.guard(text, facts, fallback=_FALLBACK, mode="enforce")
    assert r.accepted is True
    assert "FY2025" in r.text

    # The same token typed by the MODEL, not echoed from a fact, is refused.
    r2 = N.guard("In FY2025 loans stood at {intercompany_loans}.", facts,
                 fallback=_FALLBACK, mode="enforce")
    assert r2.accepted is False
    assert r2.text == _FALLBACK


# ── U6.6 — money is atomic (the 461 defect, at the source) ─────────────

def test_u6_6_value_and_currency_come_from_one_fact_atomically():
    r = N.guard("Loans {intercompany_loans}.", _facts(), fallback=_FALLBACK,
                mode="enforce")
    assert r.accepted is True
    # One fact -> one inseparable rendering.
    assert "RON 7,692,202.74" in r.text
    # There is no way to ask for the amount without its label.
    with pytest.raises(TypeError):
        N.MoneyFact(7692202.74)  # type: ignore[call-arg]


def test_u6_6b_currency_label_cannot_be_borrowed_from_prose():
    # The model writes the label itself next to a resolved amount.
    text = "Loans {intercompany_loans} EUR."
    r = N.guard(text, _facts(), fallback=_FALLBACK, mode="enforce")
    assert r.accepted is False
    assert any(rej.code == N.CODE_LOOSE_CURRENCY for rej in r.rejections)


# ── U6.7 — two currencies in one claim ─────────────────────────────────

def test_u6_7_two_currencies_in_one_narrative_is_a_rejection():
    text = "Loans {intercompany_loans} against total assets {total_assets_eur}."
    r = N.guard(text, _facts(), fallback=_FALLBACK, mode="enforce")
    assert r.accepted is False
    assert r.text == _FALLBACK
    assert any(rej.code == N.CODE_MIXED_CURRENCY for rej in r.rejections)


def test_u6_7b_same_currency_pair_is_fine():
    text = "Loans {intercompany_loans} against total assets {total_assets}."
    r = N.guard(text, _facts(), fallback=_FALLBACK, mode="enforce")
    assert r.accepted is True


# ── U6.8 — modes ───────────────────────────────────────────────────────

def test_u6_8_observe_mode_is_byte_identical_and_still_reports():
    raw = "EBITDA was 54,443,834 RON."
    r = N.guard(raw, _facts(), fallback=_FALLBACK, mode="observe")
    assert r.text == raw               # byte-identical passthrough
    assert r.fallback_used is False
    assert r.accepted is False         # the verdict is still honest
    assert r.rejections                # and still reported


def test_u6_8b_off_mode_reports_nothing_and_passes_through():
    raw = "EBITDA was 54,443,834 RON."
    r = N.guard(raw, _facts(), fallback=_FALLBACK, mode="off")
    assert r.text == raw
    assert r.accepted is True
    assert r.rejections == ()


def test_u6_8c_mode_comes_from_env_when_unset(monkeypatch):
    monkeypatch.delenv(N.MODE_ENV, raising=False)
    assert N.active_mode() == N.MODE_OBSERVE      # default: detect, never alter
    monkeypatch.setenv(N.MODE_ENV, "enforce")
    assert N.active_mode() == N.MODE_ENFORCE
    monkeypatch.setenv(N.MODE_ENV, "nonsense")
    assert N.active_mode() == N.MODE_OBSERVE      # unknown -> safest useful


# ── U6.9 — never raises ────────────────────────────────────────────────

@pytest.mark.parametrize("garbage", [None, 123, {"a": 1}, ["x"], b"bytes", ""])
def test_u6_9_guard_never_raises_on_any_model_output(garbage):
    r = N.guard(garbage, _facts(), fallback=_FALLBACK, mode="enforce")
    assert isinstance(r, N.GuardResult)
    assert isinstance(r.text, str)


def test_u6_9b_broken_facts_do_not_raise():
    r = N.guard("Loans {intercompany_loans}.", {"intercompany_loans": object()},
                fallback=_FALLBACK, mode="enforce")
    assert r.accepted is False
    assert r.text == _FALLBACK


# ── U6.10 — the narrate seam ───────────────────────────────────────────

def test_u6_10_narrate_seam_guards_briefing_and_recommendations():
    # Precisely the dict `json.loads(model_text)` produces at the seam.
    mocked = {
        "briefing": "Revenue reached RON 413,727,560 with EBITDA of 13.2%.",
        "recommendations": [
            {"title": "Build liquidity buffer",
             "rationale": "Cash ratio of 0.04x leaves 8 days of cover.",
             "actions": ["Target RON 4,200,000 minimum cash"],
             "estimated_ron_impact": 4200000},
            {"title": "Review intercompany exposure",
             "rationale": "Loans sit above the concentration threshold.",
             "actions": ["Pull the counterparty schedule"],
             "estimated_ron_impact": None},
        ],
    }
    guarded, report = N.guard_narrate_result(mocked, _facts(), mode="enforce")

    # Structure preserved — the seam never drops fields.
    assert set(guarded) == set(mocked)
    assert len(guarded["recommendations"]) == 2

    # The digit-bearing prose is replaced by the deterministic template.
    assert "413,727,560" not in guarded["briefing"]
    assert "0.04x" not in guarded["recommendations"][0]["rationale"]
    # The clean one survives untouched.
    assert guarded["recommendations"][1]["rationale"] == \
        mocked["recommendations"][1]["rationale"]

    # A machine-readable report, for the log and the envelope.
    assert report["mode"] == "enforce"
    assert report["fields_checked"] >= 6
    assert report["fields_rejected"] >= 3
    assert "briefing" in report["rejected_fields"]

    # estimated_ron_impact is a NUMBER, not narrative — untouched.
    assert guarded["recommendations"][0]["estimated_ron_impact"] == 4200000


def test_u6_11_facts_from_briefing_types_money_and_ratios_apart():
    """The briefing block, typed. The classification mirrors
    `pipeline._convert_briefing_facts` — the engine's existing authority
    on which briefing fields carry a currency."""
    facts = N.facts_from_briefing(
        {
            "total_assets": 39194178.46,
            "intercompany_loans": 7692202.74,
            "company": "not a number",
            "ratios": {
                "ebitda_margin_pct": 13.2,
                "debt_to_ebitda": 8.53,
                "net_debt": 16368595.0,
                "debt_to_equity": None,
            },
        },
        "RON",
    )
    assert facts["total_assets"] == N.MoneyFact(39194178.46, "RON")
    assert "company" not in facts                      # not a figure
    assert facts["ratios.ebitda_margin_pct"].render() == "13.2%"
    assert facts["ratios.debt_to_ebitda"].render() == "8.53×"
    # net_debt is money and gets the currency; the multiples do not.
    assert isinstance(facts["ratios.net_debt"], N.MoneyFact)
    assert facts["ratios.net_debt"].currency == "RON"
    # A missing ratio is ABSENT, not zero.
    assert facts["ratios.debt_to_equity"].is_absent() is True


def test_u6_11b_display_currency_travels_with_every_amount():
    """briefing_facts is FX-converted before it reaches here, so the
    display code is the right label — and it is attached to the value at
    the same moment, from the same source. This is the structural reason
    a briefing cannot repeat the 461 pairing."""
    facts = N.facts_from_briefing({"total_assets": 7467122.25}, "EUR")
    r = N.guard("Total assets {total_assets}.", facts, fallback=_FALLBACK,
                mode="enforce")
    assert r.accepted is True
    assert r.text == "Total assets EUR 7,467,122.25."
    assert r.currencies == ("EUR",)


def test_u6_11d_flattened_ratio_keys_are_addressable_by_a_prompt():
    facts = N.facts_from_briefing(
        {"total_debt": 18150000.0,
         "ratios": {"debt_to_ebitda": 8.53, "net_debt": 16368595.0}},
        "RON",
    )
    r = N.guard("Debt {total_debt} is {ratios.debt_to_ebitda} EBITDA; net "
                "debt {ratios.net_debt}.", facts, fallback=_FALLBACK,
                mode="enforce")
    assert r.accepted is True
    assert "8.53×" in r.text
    assert "RON 16,368,595.00" in r.text


@pytest.mark.parametrize("bad", [None, [], "x", 42])
def test_u6_11c_facts_from_briefing_never_raises(bad):
    assert N.facts_from_briefing(bad, "RON") == {}


def test_u6_10b_seam_in_observe_mode_returns_the_payload_byte_identical():
    mocked = {"briefing": "Revenue reached RON 413,727,560.",
              "recommendations": [], "alerts": []}
    guarded, report = N.guard_narrate_result(mocked, _facts(), mode="observe")
    assert guarded == mocked
    assert report["fields_rejected"] == 1     # honest verdict, no mutation


def test_u6_10c_seam_never_raises_on_a_malformed_payload():
    for bad in (None, [], "text", {"briefing": 42, "recommendations": "nope"}):
        guarded, report = N.guard_narrate_result(bad, _facts(), mode="enforce")
        assert isinstance(report, dict)
