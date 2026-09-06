"""AI SHARPENING — under test, on REAL ENGINE OUTPUT.

Every Finding in this file comes out of the real single-period engine run
over a committed regression snapshot, and the facts-gateway reads come out
of a real ``FactsGateway`` built from a committed corpus envelope. Nothing
is hand-built. That is now a project rule and it is not a style
preference: three defects last wave surfaced ONLY when a fixture stopped
being a hand-assembled object and started being what the engine actually
returns.

WHAT IS GATED HERE

  S1 READ-ONLY      a callable planted at three seams — inside the
                    Finding, inside the company profile payload, inside
                    the facts-gateway reads — is never invoked. The view
                    is data; there is no mutation API in scope.
  S2 NO MONEY DIGIT the language channel carries placeholders, never
                    figures. The capsule law, applied to this lane.
  S3 NUMERALS       a model-emitted numeral that is not a resolved
                    ``{{money:FACT}}`` placeholder (or a subject account
                    code) is rejected at parse, logged, and the
                    deterministic template is used. Planted three ways:
                    a bare percentage, the 461 adjacency, a loose
                    currency word.
  S4 THE SEAM       every accepted result went through
                    ``_finding.apply_advisory_narrative``: the numeric
                    fingerprint is identical, severity/rule/facts are
                    identical, and a DEMOTED finding is never sharpened.
  S5 ANTI-GENERIC   a low specificity score buys ONE regeneration and
                    then falls back to the deterministic template; every
                    score reaches the AI journal and the distribution is
                    reportable.
  S6 THREE STATES   live-shaped, credits absent, breaker open — all three
                    degrade calmly to the deterministic template with a
                    human-readable reason and never a raw payload.
  S7 ROMANIAN       additive, independently gated, and ABSENT rather than
                    guessed when it cannot be earned.
  S8 F9             the bare-numeral guard the findings gate lane is
                    waiting on, exercised with the gate's own plant text.

NO LIVE CALLS. Every model call in this file goes through a stub client.
The live exercise is a separate, env-gated test (``SHARPEN_LIVE=1``) that
CI never runs — the project rule is that CI stays fully mocked forever.

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

import json
import os
from dataclasses import replace
from pathlib import Path

import pytest

from engine.ai import breaker
from engine.ai import finding_sharpen as FS
from engine.ai import registry
from engine.api import _finding as F
from engine.api.findings import s_engine
from engine.serving import FactsGateway

REPO = Path(__file__).resolve().parents[2]
FIXTURES = (REPO / "src" / "engine" / "country_packs" / "ro_romania"
            / "fixtures" / "regression_baselines")
CORPUS = REPO / "corpus"

#: The fixture whose 461 note this whole contract was designed around,
#: and a structurally different company to use as the reviewer's decoy.
SUBJECT_FIXTURE = "agras_fy2025"
DECOY_FIXTURE = "eei_dec_2025"


# ══ REAL ENGINE OUTPUT — the fixtures ════════════════════════════════════


def _statements(name):
    with open(str(FIXTURES / (name + ".json")), encoding="utf-8") as fh:
        return json.load(fh)["assembled"]["statements"]


def _run(name):
    return s_engine.run_single_period(
        _statements(name), period_id="p-" + name, snapshot_id="snap-" + name)


@pytest.fixture(scope="module")
def subject_result():
    return _run(SUBJECT_FIXTURE)


@pytest.fixture(scope="module")
def decoy_result():
    return _run(DECOY_FIXTURE)


@pytest.fixture(scope="module")
def finding(subject_result):
    """The real 461 concentration finding, straight out of the engine."""
    for f in subject_result.finding_set.surfaced:
        if f.rule_id == "concentration_related_party":
            return f
    raise AssertionError("the engine stopped producing the 461 finding")


@pytest.fixture(scope="module")
def profile(subject_result):
    return subject_result.profile


@pytest.fixture(scope="module")
def gateway():
    """A REAL FactsGateway over a REAL corpus envelope — the same
    `assembled_canonical_v1` shape production serves."""
    served = json.loads(
        (CORPUS / "saga_10_col_agras" / "expected" / "served_envelope.json")
        .read_text(encoding="utf-8"))
    gw = FactsGateway.from_envelope({"canonical_bs": served})
    assert gw is not None, "the corpus envelope stopped building a gateway"
    return gw


@pytest.fixture(autouse=True)
def _isolated_state(tmp_path, monkeypatch):
    """Never touch the real breaker counters or the real AI journal."""
    monkeypatch.setenv(breaker.STATE_DIR_ENV, str(tmp_path / "spend"))
    monkeypatch.setenv(FS.JOURNAL_DIR_ENV, str(tmp_path / "journal"))
    monkeypatch.delenv(FS.SPECIFICITY_FLOOR_ENV, raising=False)
    yield


# ══ STUB MODEL CLIENTS ═══════════════════════════════════════════════════


class _Block(object):
    def __init__(self, text):
        self.type = "text"
        self.text = text


class _Resp(object):
    def __init__(self, text):
        self.content = [_Block(text)]


class StubClient(object):
    """A model client shaped exactly like the one `call_strict_json`
    drives. Dispatches on the system prompt so one object can play both
    the drafting role and the reviewing role."""

    def __init__(self, draft=None, review=None):
        self._draft = draft
        self._review = review
        self.calls = []

    @property
    def messages(self):
        return self

    def create(self, **kwargs):
        system = kwargs.get("system") or []
        system_text = " ".join(b.get("text", "") for b in system)
        user_text = kwargs["messages"][0]["content"][0]["text"]
        is_review = "ADVERSARIAL REVIEWER" in system_text
        self.calls.append({"role": "review" if is_review else "draft",
                           "model": kwargs.get("model"),
                           "user_text": user_text})
        script = self._review if is_review else self._draft
        if callable(script):
            payload = script(len([c for c in self.calls
                                  if c["role"] == ("review" if is_review
                                                   else "draft")]),
                             user_text)
        else:
            payload = script
        if isinstance(payload, Exception):
            raise payload
        if isinstance(payload, str):
            return _Resp(payload)
        return _Resp(json.dumps(payload, ensure_ascii=False))


def _factory(client):
    return lambda: client


GOOD_EN = {
    "rationale": (
        "For a mid-size inventory-heavy operator the balance carried on 461 "
        "is not a customer receivable at all: it is {{money:intercompany_loans}} "
        "of working capital parked with the same affiliated entities that "
        "supply and offtake the stock on 451, 452 and 455, so the company "
        "cannot call it back on a date it controls and the lender haircuts "
        "it in full when the gearing covenant is measured."),
    "steps": [
        {"imperative": "Pull the 461 counterparty ledger with contractual "
                       "settlement dates",
         "artefact": "the 461 sub-ledger split by related entity",
         "provider": "the group financial controller",
         "horizon": "before the next covenant certificate"},
        {"imperative": "Recompute the current ratio with the 461 balance "
                       "excluded",
         "artefact": "a restated covenant pack",
         "provider": "the treasury team",
         "horizon": None},
    ],
}

GOOD_RO = {
    "rationale": (
        "Pentru un operator cu stocuri mari finanțat din interiorul grupului, "
        "soldul de pe 461 nu este o creanță comercială: sunt "
        "{{money:intercompany_loans}} de capital plasate la entitățile "
        "afiliate din 451, 452 și 455, fără scadență contractuală pe fața "
        "balanței, iar creditorul le deduce integral la măsurarea "
        "covenantului."),
    "steps": [
        {"imperative": "Solicită fișa analitică a contului 461 pe fiecare "
                       "parte afiliată",
         "artefact": "situația soldurilor 461 pe contrapartidă, cu scadențe",
         "provider": "controlorul financiar al grupului",
         "horizon": "înainte de următorul certificat de covenant"},
        {"imperative": "Recalculează rata curentă fără soldul de pe 461",
         "artefact": "recalculul covenantului",
         "provider": "trezoreria grupului",
         "horizon": None},
    ],
}

GOOD_DRAFT = {"en": GOOD_EN, "ro": GOOD_RO}
HIGH_REVIEW = {"specificity": 0.86,
               "reads_identically_for_another_company": False,
               "generic_spans": [], "critique": ""}
LOW_REVIEW = {"specificity": 0.21,
              "reads_identically_for_another_company": True,
              "generic_spans": ["related-party balances carry risk"],
              "critique": "Name what this company's own structure does with "
                          "the balance."}


def _sharpen(finding, profile, draft=GOOD_DRAFT, review=HIGH_REVIEW, **kw):
    drafter = StubClient(draft=draft)
    reviewer = StubClient(review=review)
    result = FS.sharpen_finding(
        finding, profile,
        client_factory=_factory(drafter),
        reviewer_factory=_factory(reviewer),
        **kw)
    return result, drafter, reviewer


# ══ S1 — THE READ-ONLY GUARANTEE, PROVEN AT THREE SEAMS ══════════════════


class Tripwire(object):
    """A callable planted on the input view. If the sharpening lane ever
    treats its input as behaviour instead of data, this fires."""

    def __init__(self, name):
        self.name = name
        self.calls = 0

    def __call__(self, *args, **kwargs):
        self.calls += 1
        raise AssertionError(
            "the sharpening lane INVOKED a planted callable at seam %r — the "
            "view must be data, never behaviour" % self.name)


class ProfileProxy(object):
    """A real CompanyProfile with a tripwire planted inside the payload it
    hands out. Delegates everything else, so this is the real profile."""

    def __init__(self, real, tripwire):
        self._real = real
        self._tripwire = tripwire

    def to_payload(self):
        payload = self._real.to_payload()
        payload["metrics"] = dict(payload["metrics"])
        payload["metrics"]["planted_tripwire"] = self._tripwire
        return payload

    def __getattr__(self, name):
        return getattr(self._real, name)


def _plant_three_seams(finding, profile):
    tw_finding = Tripwire("finding.subject.accounts[0].bucket")
    tw_profile = Tripwire("profile.to_payload()['metrics']")
    tw_gateway = Tripwire("gateway_facts['planted']")
    accounts = finding.subject.accounts
    planted_finding = replace(
        finding,
        subject=replace(finding.subject,
                        accounts=(replace(accounts[0], bucket=tw_finding),)
                                 + tuple(accounts[1:])))
    planted_profile = ProfileProxy(profile, tw_profile)
    planted_facts = {"total_assets": "present", "planted": tw_gateway}
    return (planted_finding, planted_profile, planted_facts,
            (tw_finding, tw_profile, tw_gateway))


def test_s1_a_callable_planted_at_three_seams_is_never_invoked(finding, profile):
    planted_f, planted_p, planted_facts, tripwires = _plant_three_seams(
        finding, profile)
    view = FS.build_view(planted_f, planted_p, gateway_facts=planted_facts)
    blob = view.as_json()
    for tw in tripwires:
        assert tw.calls == 0, "seam %r was invoked" % tw.name
    # ...and each one was PROJECTED as a withheld marker rather than
    # silently dropped, so the refusal is visible.
    assert blob.count(FS.CALLABLE_WITHHELD) >= 3, blob[:2000]
    assert view.payload["finding"]["subject"]["accounts"][0]["bucket"] \
        == FS.CALLABLE_WITHHELD
    assert view.payload["company_profile"]["metrics"]["planted_tripwire"] \
        == FS.CALLABLE_WITHHELD
    assert view.payload["facts_gateway"]["planted"] == FS.CALLABLE_WITHHELD


def test_s1_the_seams_stay_unfired_through_a_whole_sharpen_run(finding, profile):
    """Not just the projector — the WHOLE lane, prompts and all."""
    planted_f, planted_p, planted_facts, tripwires = _plant_three_seams(
        finding, profile)
    result, drafter, reviewer = _sharpen(
        planted_f, planted_p, gateway_facts=planted_facts)
    assert drafter.calls, "the drafting model was never called"
    for tw in tripwires:
        assert tw.calls == 0, "seam %r was invoked during sharpening" % tw.name
    assert result.finding.narrative_source == "advisory"


def test_s1_the_view_is_json_primitives_only(finding, profile, gateway):
    view = FS.build_view(finding, profile, gateway=gateway)
    # Round-trips with the strict encoder: no engine object survived.
    assert json.loads(json.dumps(view.payload, sort_keys=True)) == view.payload


def test_s1_only_whitelisted_gateway_accessors_are_touched(finding, profile):
    class TripwireGateway(object):
        def __init__(self):
            self.tw = Tripwire("gateway.mutate")

        def __getattr__(self, name):
            if name in FS.GATEWAY_ACCESSORS:
                raise AttributeError(name)
            return self.tw

    gw = TripwireGateway()
    FS.build_view(finding, profile, gateway=gw)
    assert gw.tw.calls == 0


# ══ S2 — NO MONEY DIGIT REACHES THE LANGUAGE CHANNEL ═════════════════════


def test_s2_no_money_figure_appears_anywhere_in_the_view(finding, profile,
                                                         gateway):
    view = FS.build_view(finding, profile, gateway=gateway)
    blob = view.as_json()
    money_names = FS._money_fact_names(finding.facts_cited)
    assert money_names, "the fixture stopped citing money facts"
    for name in money_names:
        assert "{{money:%s}}" % name in blob, (
            "the model was not given the placeholder for %r" % name)
    assert FS.MONEY_WITHHELD in blob
    # The gateway reads are presence, not cents.
    for state in view.payload["facts_gateway"].values():
        assert state in ("present", "absent", "unknown"), state


def test_s2_the_money_ban_holds_for_every_finding_on_every_fixture(
        subject_result, decoy_result):
    """The leak this gate first caught was in ONE element of ONE finding
    (`comparison_basis.basis_value`). One example proves nothing, so this
    walks every surfaced finding both fixtures produce."""
    checked = 0
    for result in (subject_result, decoy_result):
        for f in result.finding_set.surfaced:
            blob = FS.build_view(f, result.profile).as_json()
            for name in FS._money_fact_names(f.facts_cited):
                value = float(f.facts_cited[name])
                for rendering in (format(value, ",.0f"), format(value, ",.2f"),
                                  format(value, ".2f"), repr(value),
                                  str(int(round(value)))):
                    assert rendering not in blob, (
                        "%s: money fact %r leaked into the language channel "
                        "as %r" % (f.rule_id, name, rendering))
                checked += 1
    assert checked >= 10, checked


# ══ S3 — NUMERALS ARE RESOLVED PLACEHOLDERS ONLY ═════════════════════════


def test_s3_the_guard_accepts_placeholders_and_subject_account_codes(finding):
    text = ("The balance on 461 is {{money:intercompany_loans}} lent inside "
            "the group and shown against 451.")
    assert FS.numeral_violations(
        text, FS.allowed_ledger_codes(finding),
        FS._money_fact_names(finding.facts_cited)) == ()


@pytest.mark.parametrize("bad,marker", [
    ("This balance has grown 47% since the prior year.", "47"),
    ("Settle the balance within 30 days.", "30"),
    ("The 2024 comparative shows the same shape.", "2024"),
])
def test_s3_a_bare_model_numeral_is_a_violation(finding, bad, marker):
    violations = FS.numeral_violations(
        bad, FS.allowed_ledger_codes(finding),
        FS._money_fact_names(finding.facts_cited))
    assert violations, bad
    assert any(marker in v for v in violations), violations


def test_s3_the_461_adjacency_is_a_violation(finding):
    """The exact 461 collision: a bare number immediately before a money
    placeholder makes `templatize` bind the currency label to the wrong
    figure — one claim, two currencies."""
    violations = FS.numeral_violations(
        "The position on 461 {{money:intercompany_loans}} is group capital.",
        FS.allowed_ledger_codes(finding),
        FS._money_fact_names(finding.facts_cited))
    assert any("bind to the wrong figure" in v for v in violations), violations


def test_s3_a_loose_currency_word_is_a_violation(finding):
    violations = FS.numeral_violations(
        "The company owes RON {{money:intercompany_loans}} to the group.",
        FS.allowed_ledger_codes(finding),
        FS._money_fact_names(finding.facts_cited))
    assert any("currency label" in v for v in violations), violations


def test_s3_the_code_whitelist_is_the_engines_own_ledger_references(
        subject_result, decoy_result):
    """Measured, not guessed: on the first live run four of thirteen
    findings burned their one regeneration citing a code the
    DETERMINISTIC prose had already printed (the affiliate detector's own
    action step names 261/263 while its subject is 761/762/763)."""
    affiliate = None
    for f in decoy_result.finding_set.surfaced:
        if f.rule_id == "affiliate_income_dependency":
            affiliate = f
    assert affiliate is not None
    codes = FS.allowed_ledger_codes(affiliate)
    for code in affiliate.subject.codes():
        assert code in codes
    engine_prose = affiliate.why_here.rationale + " " + " ".join(
        "%s %s %s" % (s_.imperative, s_.artefact, s_.provider)
        for s_ in affiliate.action.steps)
    for code in codes:
        assert code in engine_prose or code in affiliate.subject.codes() \
            or code in affiliate.evidence.provenance.line_refs, code
    # A YEAR is a quantity wearing an account's clothes, and never lands
    # on the whitelist however often the prose mentions one.
    for f in list(subject_result.finding_set.surfaced) + \
            list(decoy_result.finding_set.surfaced):
        for code in FS.allowed_ledger_codes(f):
            assert not (len(code) == 4 and code.startswith(("19", "20"))
                        and code not in f.subject.codes()), code


def test_s3_an_unknown_placeholder_name_is_a_violation(finding):
    violations = FS.numeral_violations(
        "Exposure of {{money:not_a_cited_fact}} sits inside the group.",
        FS.allowed_ledger_codes(finding),
        FS._money_fact_names(finding.facts_cited))
    assert any("does not cite" in v for v in violations), violations


def test_s3_plant_a_model_that_emits_a_raw_figure(finding, profile):
    """THE PLANT. The model writes a percentage the engine never computed;
    the lane rejects it at parse, logs it, regenerates once, and — when
    the second answer repeats the offence — ships the deterministic
    template."""
    bad_en = dict(GOOD_EN)
    bad_en["rationale"] = (
        "For a mid-size inventory-heavy operator the balance on 461 has "
        "grown 47% since the prior year and now dominates the book.")
    result, drafter, reviewer = _sharpen(
        finding, profile, draft={"en": bad_en, "ro": GOOD_RO})

    assert result.degraded is True
    assert result.finding.narrative_source == "deterministic"
    assert result.finding is finding, "the deterministic finding must be intact"
    assert result.en.rationale == finding.why_here.rationale
    assert result.en.steps == tuple(finding.action.steps)
    # ONE regeneration was attempted, then the fallback.
    assert len([c for c in drafter.calls if c["role"] == "draft"]) == 2
    assert not reviewer.calls, "a refused draft must never reach the reviewer"
    # The reason names the numeral, and is a sentence — not a payload.
    assert "47" in result.reason
    assert "grown 47% since the prior year" not in result.reason
    assert "numeral" in result.reason.lower()
    # ...and the refusal is in the journal, which IS the audit surface.
    events = [e for e in FS.journal_entries()
              if e.get("event") == "numeral_refusal"]
    assert events, "the refusal was never journalled"
    assert any("47" in json.dumps(e.get("violations")) for e in events)


def test_s3_the_placeholder_is_resolved_to_the_engines_own_figure(finding,
                                                                  profile):
    result, _, _ = _sharpen(finding, profile)
    assert result.degraded is False
    rendered = result.finding.render()
    native = "RON %s" % format(finding.facts_cited["intercompany_loans"], ",.0f")
    assert native in rendered.body, rendered.body
    # ...and it round-trips straight back into a typed placeholder, so the
    # display layer still converts it.
    assert "{{money:intercompany_loans}}" in rendered.body_template


# ══ S3 — THE NUMERAL LAW: ten classes, both languages ════════════════════
#
# Every plant below is a model-authored QUANTITY the numerals critic
# showed shipping `status=fresh` through the real explain path on the
# real agras 461 finding. Each is refused through the guard's own
# message, which names the class.


def _law(finding, text):
    return FS.numeral_violations(
        text, FS.allowed_ledger_codes(finding),
        FS._money_fact_names(finding.facts_cited),
        allowed_words=FS.allowed_number_words(finding))


PH = "{{money:intercompany_loans}}"

LAW_PLANTS = [
    # (id, text, expected class)
    ("ro-de-trei-ori", "soldul este de trei ori mai mare decât anul trecut.", FS.CLASS_NUMBER_WORD),
    ("ro-treizeci-de-zile", "scadența depășește treizeci de zile.", FS.CLASS_NUMBER_WORD),
    ("ro-doua-milioane", "aproape două milioane rămân nerecuperate.", FS.CLASS_NUMBER_WORD),
    ("en-forty-seven-percent", "It has grown forty-seven percent since last year.", FS.CLASS_NUMBER_WORD),
    ("en-doubled", "It doubled over the period.", FS.CLASS_NUMBER_WORD),
    ("en-a-third", "now a third of the book is group money.", FS.CLASS_NUMBER_WORD),
    ("en-half", "half of the book is group money.", FS.CLASS_NUMBER_WORD),
    ("en-tripled", "the balance tripled.", FS.CLASS_NUMBER_WORD),
    ("en-twelve-years", "settlement runs inside twelve years.", FS.CLASS_NUMBER_WORD),
    ("en-one-year", "one year of settlement is outstanding.", FS.CLASS_NUMBER_WORD),
    ("en-a-quarter-of", "a quarter of the book is group money.", FS.CLASS_NUMBER_WORD),
    ("ro-de-zece-ori", "este de zece ori mai mare.", FS.CLASS_NUMBER_WORD),
    ("cur-lei-after", "the balance of %s lei is group money." % PH, FS.CLASS_CURRENCY),
    ("cur-euro-after", "the balance of %s euro is group money." % PH, FS.CLASS_CURRENCY),
    ("cur-EURO-after", "the balance of %s EURO is group money." % PH, FS.CLASS_CURRENCY),
    ("cur-symbol-after", "the balance of %s € is group money." % PH, FS.CLASS_CURRENCY),
    ("cur-lei-before", "the balance of lei %s is group money." % PH, FS.CLASS_CURRENCY),
    ("cur-EUR-dash-before", "the balance of EUR-%s is group money." % PH, FS.CLASS_CURRENCY),
    ("cur-in-EUR-colon", "the balance in EUR: %s is group money." % PH, FS.CLASS_CURRENCY),
    ("cur-Lei-cased", "the balance of %s Lei is group money." % PH, FS.CLASS_CURRENCY),
    ("cur-ron-lower", "the balance of %s ron is group money." % PH, FS.CLASS_CURRENCY),
    ("cur-RON-before", "the company owes RON %s to the group." % PH, FS.CLASS_CURRENCY),
    ("cur-ro-lei", "soldul de %s lei este bani de grup." % PH, FS.CLASS_CURRENCY),
    ("cur-ro-euro", "soldul de %s euro este bani de grup." % PH, FS.CLASS_CURRENCY),
    ("opt-abs", "the haircut is {{money:intercompany_loans|abs}}.", FS.CLASS_OPTION),
    ("opt-neg", "the haircut is {{money:intercompany_loans|neg}}.", FS.CLASS_OPTION),
    ("opt-d4", "the haircut is {{money:intercompany_loans|d4}}.", FS.CLASS_OPTION),
    ("opt-bare", "the haircut is {{money:intercompany_loans|bare}}.", FS.CLASS_OPTION),
    ("opt-suffix-d2", "the haircut is {{money:intercompany_loans|suffix|d2}}.", FS.CLASS_OPTION),
    ("opt-k", "the haircut is {{money:intercompany_loans|k}}.", FS.CLASS_OPTION),
    ("opt-unknown", "the haircut is {{money:intercompany_loans|percent}}.", FS.CLASS_OPTION),
    ("unresolved-Bare", "the haircut is {{money:intercompany_loans|Bare}}.", FS.CLASS_UNRESOLVED),
    ("unresolved-BARE", "the haircut is {{money:intercompany_loans|BARE}}.", FS.CLASS_UNRESOLVED),
    ("unresolved-trailing-space", "the haircut is {{money:intercompany_loans|bare }}.", FS.CLASS_UNRESOLVED),
    ("unresolved-spaces", "the haircut is {{ money }}.", FS.CLASS_UNRESOLVED),
    ("unresolved-stray-brace", "the haircut is } group money.", FS.CLASS_UNRESOLVED),
    ("uncited", "the haircut is {{money:revenue}}.", FS.CLASS_UNCITED),
    ("code-percent", "it has grown 461% since last year.", FS.CLASS_CODE_AS_QUANTITY),
    ("code-x", "it is 461x the prior balance.", FS.CLASS_CODE_AS_QUANTITY),
    ("code-times-sign", "it is 461 × the prior balance.", FS.CLASS_CODE_AS_QUANTITY),
    ("code-days", "settlement runs past 461 days.", FS.CLASS_CODE_AS_QUANTITY),
    ("code-ro-ori", "este de 461 ori mai mare.", FS.CLASS_CODE_AS_QUANTITY),
    ("code-ro-zile", "scadența depășește 461 de zile.", FS.CLASS_CODE_AS_QUANTITY),
    ("code-years", "for 461 years the group has funded it.", FS.CLASS_CODE_AS_QUANTITY),
    ("code-ro-ani", "de 461 ani grupul o finanțează.", FS.CLASS_CODE_AS_QUANTITY),
    ("code-since", "since 455 the group has funded it.", FS.CLASS_CODE_AS_QUANTITY),
    ("code-grown", "the balance has grown 461 in a year.", FS.CLASS_CODE_AS_QUANTITY),
    ("uni-superscript-2", "the exposure is ² the covenant headroom.", FS.CLASS_UNICODE),
    ("uni-half", "roughly ½ of the book is group money.", FS.CLASS_UNICODE),
    ("uni-circled-7", "about ⑦ of the book is group money.", FS.CLASS_UNICODE),
    ("uni-superscript-47", "it has grown ⁴⁷ percent.", FS.CLASS_UNICODE),
    ("uni-arabic-indic", "it has grown ٤٧ percent.", FS.CLASS_UNICODE),
    ("uni-fullwidth", "it has grown ４７ percent.", FS.CLASS_UNICODE),
    ("uni-roman-char", "Ⅻ months of settlement are outstanding.", FS.CLASS_UNICODE),
    ("roman-XII", "XII months of settlement are outstanding.", FS.CLASS_ROMAN),
    ("roman-IV", "the IV quarter is when it settles.", FS.CLASS_ROMAN),
    ("roman-XL", "XL months of settlement are outstanding.", FS.CLASS_ROMAN),
    ("ascii-percent", "This balance has grown 47% since the prior year.", FS.CLASS_NUMERAL),
    ("ascii-year", "The 2024 comparative shows the same shape.", FS.CLASS_NUMERAL),
    ("ascii-uncited-code", "unlike the trade receivables on 4111 this is group money.", FS.CLASS_NUMERAL),
    ("adjacency-461", "The position on 461 %s is group capital." % PH, FS.CLASS_ADJACENCY),
]


@pytest.mark.parametrize("plant_id,text,expected", LAW_PLANTS,
                         ids=[p[0] for p in LAW_PLANTS])
def test_s3_the_numeral_law_refuses_every_class_by_name(finding, plant_id, text, expected):
    violations = _law(finding, text)
    assert violations, (plant_id, text)
    classes = FS.violation_classes(violations)
    assert expected in classes, (plant_id, classes, violations)
    for v in violations:
        assert FS.violation_class(v) != "unclassified", v


LAW_ALLOWED = [
    ("engine-code", "The balance on 461 is %s lent to 451." % PH),
    ("third-party", "a third-party balance sits beside it on 461."),
    ("double-check", "Double-check the 461 reconciliation against the sub-ledger."),
    ("currency-away-from-figure", "a company reporting in RON carries the 461 position at the closing rate."),
    ("account-name-lei", "the account Conturi la bănci în lei is the offset for 461."),
    ("one-of", "one of the affiliates behind 461 is the offtaker."),
    ("second-lien", "a second lien over the 461 balance would not survive."),
    ("first-drawdown", "the first drawdown lands on 461."),
    ("this-quarter", "within this quarter the 461 sub-ledger is pulled."),
    ("under-461", "amounts booked under 461 are group money."),
    ("over-461-451", "spread over 461, 451 and 452."),
    ("ro-de-pe-461", "soldul de pe 461 este %s." % PH),
    ("ro-contului-461-de-la", "Solicită fișa contului 461 de la controlorul financiar."),
    # MEASURED LIVE (run 2): the Romanian half of the 461 finding was
    # refused on "alături de 451" — "alongside 451". "de" alone is not a
    # comparator; a Romanian count carries its unit after the token.
    ("ro-alaturi-de-451", "soldul de %s din contul 461, alături de 451, 452 și 455, nu este o creanță." % PH),
    ("ro-fata-de-461", "expunerea față de 461 este acoperită de grup."),
    ("ro-imm", "un IMM cu sold pe 461."),
    ("grade-ccc", "a CCC grade would follow from 461."),
    ("abbrev-md-cd", "the MD and the CD both signed the 461 confirmation."),
    ("sentence-final-code", "the group funds the balance on 461."),
]


@pytest.mark.parametrize("plant_id,text", LAW_ALLOWED, ids=[p[0] for p in LAW_ALLOWED])
def test_s3_the_numeral_law_leaves_ordinary_prose_alone(finding, plant_id, text):
    assert _law(finding, text) == (), (plant_id, _law(finding, text))


def test_s3_number_words_the_engine_itself_wrote_are_allowed_and_only_those(
        subject_result, decoy_result):
    """MEASURED, not guessed: the engine's own action steps say "inside
    twelve months", "the next two quarters", "one month of operating
    cost", "the ten largest supplier accounts". A rewrite echoing them
    is allowed — in English and in the Romanian peer form — and a word
    the engine did not write for THAT finding is refused."""
    seen = 0
    for result in (subject_result, decoy_result):
        for f in result.finding_set.surfaced:
            allowed = FS.allowed_number_words(f)
            prose = " ".join(FS._engine_prose(f))
            words = set(FS._WORD_RX.findall(FS._strip_diacritics(prose)))
            for entry in allowed:
                head = entry.split(" ")[0]
                # every whitelisted word is the engine's own, or the
                # Romanian peer of one that is
                peers = [en for en, ros in FS._EN_TO_RO_NUMBER_WORDS.items()
                         if head in ros]
                assert head in words or any(p in words for p in peers), \
                    (f.rule_id, entry)
            seen += 1
            for entry in allowed:
                if " " in entry:
                    assert _law(f, "the engine wrote %s here on %s."
                                % (entry, f.subject.codes()[0])) == (), (f.rule_id, entry)
    assert seen >= 8
    # the liquidity finding writes "one month" and "the ten largest"
    liquidity = [f for f in subject_result.finding_set.surfaced
                 if f.rule_id == "liquidity_cash_tight"]
    assert liquidity, "the engine stopped producing the liquidity finding"
    allowed = FS.allowed_number_words(liquidity[0])
    assert "ten" in allowed and "zece" in allowed
    assert "one month" in allowed and "una luna" in allowed
    assert _law(liquidity[0], "the ten largest supplier accounts on 401.") == ()
    assert _law(liquidity[0], "cele zece cele mai mari solduri de pe 401.") == ()
    # Romanian "de" before an allowed word is a preposition, not a count
    assert _law(liquidity[0], "o listă de zece conturi de furnizori pe 401.") == ()
    assert _law(liquidity[0], "one month of operating cost on 401.") == ()
    # ...and the same word beside a DIFFERENT unit is a quantity the
    # engine never wrote
    assert FS.violation_classes(_law(liquidity[0], "one year of cost on 401.")) == (
        FS.CLASS_NUMBER_WORD,)
    assert FS.violation_classes(_law(liquidity[0], "grown ten percent on 401.")) == (
        FS.CLASS_NUMBER_WORD,)
    # a finding whose engine prose never says "ten" refuses it
    fx = [f for f in subject_result.finding_set.surfaced if f.rule_id == "fx_exposure"]
    assert fx and "ten" not in FS.allowed_number_words(fx[0])
    assert FS.CLASS_NUMBER_WORD in FS.violation_classes(
        _law(fx[0], "the ten largest positions on 5124."))
    # MEASURED LIVE (run 1, 2026-09-05): the input-cost finding's own step
    # is "Hedge the next two quarters of input volume"; a rewrite echoing
    # it was refused on "quarters … of" as a fraction, twice, and burned
    # its regeneration. The unit word of an allowed bigram is judged as
    # part of the bigram, never alone.
    ic = [f for f in subject_result.finding_set.surfaced if f.rule_id == "input_cost_exposure"]
    assert ic, "the engine stopped producing the input-cost finding"
    assert "two quarters" in FS.allowed_number_words(ic[0])
    assert _law(ic[0], "Hedge the next two quarters of input volume behind 601.") == ()
    assert _law(ic[0], "Acoperă următoarele două trimestre de volum pe 601.") == ()
    # ...while a DIFFERENT count, and a bare fraction, are still refused
    assert FS.CLASS_NUMBER_WORD in FS.violation_classes(
        _law(ic[0], "Hedge the next three quarters of input volume behind 601."))
    assert FS.CLASS_NUMBER_WORD in FS.violation_classes(
        _law(ic[0], "a quarter of input volume behind 601."))


def test_s3_the_placeholder_regex_is_the_resolvers(finding):
    """The guard accepts EXACTLY what `_ratio_units.render_native`
    resolves — the strict side. The loose regex this replaced stripped
    `{{money:x|Bare}}` as a placeholder while the resolver skipped it, so
    the literal braces shipped."""
    from engine.api import _ratio_units as RU

    assert FS._PLACEHOLDER_RX.pattern == RU._PLACEHOLDER_RX.pattern
    resolved = RU.render_native("x {{money:intercompany_loans|Bare}} y",
                                dict(finding.facts_cited), finding.currency)
    assert "{{money:intercompany_loans|Bare}}" in resolved, \
        "the resolver started resolving a mixed-case option; re-measure the law"
    assert FS.CLASS_UNRESOLVED in FS.violation_classes(_law(finding, resolved))


def test_s3_the_option_whitelist_is_measured_on_the_deterministic_prose(
        subject_result, decoy_result):
    """The deterministic prose writes `{{money:FACT}}` and nothing else —
    title template, body template, templatized why-here and steps, every
    surfaced finding of both fixtures. So the whitelist is empty, and
    stays empty until the engine itself starts writing an option."""
    used = set()
    checked = 0
    for result in (subject_result, decoy_result):
        for f in result.finding_set.surfaced:
            rendered = f.render()
            texts = [rendered.title_template, rendered.body_template]
            texts += [FS._attributable(t, f) for t in FS._engine_prose(f)]
            for text in texts:
                for m in FS._PLACEHOLDER_RX.finditer(text):
                    for opt in [o for o in m.group("opts").split("|") if o]:
                        used.add(opt)
                    checked += 1
    assert checked >= 10, "no placeholder in the deterministic prose — measure again"
    assert used == set(FS.PLACEHOLDER_OPTIONS_ALLOWED) == set(), used


def test_s3_a_romanian_number_word_is_refused_and_named(finding, profile):
    """The critic's B3-B5 plants, on the real path: the Romanian half
    carrying `de trei ori` is not served, and the journal names the class."""
    bad = dict(GOOD_RO)
    bad["rationale"] = GOOD_RO["rationale"] + " Soldul este de trei ori mai mare."
    result, _, _ = _sharpen(finding, profile, draft={"en": GOOD_EN, "ro": bad})
    assert result.degraded is False
    assert result.ro is None
    events = [e for e in FS.journal_entries()
              if e.get("event") == "numeral_refusal" and e.get("language") == "ro"]
    assert events, "the Romanian refusal was never journalled"
    assert any(FS.CLASS_NUMBER_WORD in v for v in events[-1]["violations"])


def test_s3_the_refusal_reason_names_the_class_and_carries_no_brace(finding, profile):
    bad_en = dict(GOOD_EN)
    bad_en["rationale"] = GOOD_EN["rationale"].replace(
        "{{money:intercompany_loans}}", "{{money:intercompany_loans|abs}}")
    result, drafter, _ = _sharpen(finding, profile, draft={"en": bad_en, "ro": GOOD_RO})
    assert result.degraded is True
    assert FS.CLASS_OPTION in result.reason
    assert "{" not in result.reason and "}" not in result.reason
    assert "abs" in result.reason
    # the critique the model got for its one regeneration names the class too
    second = [c for c in drafter.calls if c["role"] == "draft"][1]["user_text"]
    assert FS.CLASS_OPTION in second


# ══ S9 — THE SERVED CHECKS, RE-RUNNABLE ON ALREADY-RESOLVED PROSE ════════


def _resolved_dicts(finding):
    en = {"rationale": FS._resolve(GOOD_EN["rationale"], finding),
          "steps": [dict(s, lang="en") for s in GOOD_EN["steps"]]}
    ro = {"rationale": FS._resolve(GOOD_RO["rationale"], finding),
          "steps": [dict(s, lang="ro") for s in GOOD_RO["steps"]]}
    return en, ro


def test_s9_the_contract_recheck_passes_a_clean_narrative(finding):
    en, ro = _resolved_dicts(finding)
    assert FS.narrative_contract_problems(finding, en, ro) == ((), ())


@pytest.mark.parametrize("mutate,label", [
    (lambda en: dict(en, rationale=en["rationale"] + " The board should keep an eye on it."), "hedge"),
    (lambda en: dict(en, rationale="The balance on 461 is group capital with no maturity."), "anchor"),
    (lambda en: dict(en, steps=[dict(en["steps"][0], imperative="Monitor the 461 sub-ledger")]), "imperative"),
    (lambda en: dict(en, rationale=""), "rationale"),
], ids=["hedge", "anchor", "imperative", "empty"])
def test_s9_the_contract_recheck_refuses_what_the_fresh_path_refuses(finding, mutate, label):
    en, ro = _resolved_dicts(finding)
    en_problems, ro_problems = FS.narrative_contract_problems(finding, mutate(en), ro)
    assert en_problems, label
    assert ro_problems == ()


def test_s9_the_contract_recheck_judges_romanian_in_its_own_language(finding):
    en, ro = _resolved_dicts(finding)
    hedged = dict(ro, rationale=ro["rationale"] + " Soldul ar trebui monitorizat.")
    assert FS.narrative_contract_problems(finding, en, hedged)[1]
    weak = dict(ro, steps=[dict(ro["steps"][0], imperative="Monitorizează soldul de pe 461")])
    assert FS.narrative_contract_problems(finding, en, weak)[1]
    no_code = dict(ro, rationale="Soldurile cu părțile afiliate sunt capital imobilizat.")
    assert FS.narrative_contract_problems(finding, en, no_code)[1]


def test_s9_the_review_recheck_demands_an_accepted_row_at_todays_floor(monkeypatch):
    good = [{"language": "en", "specificity": 0.86, "reads_identically": False,
             "accepted": True}]
    assert FS.review_problems(good, 0.86, None, ro_present=False) == ()
    assert FS.review_problems([], 0.86, None, ro_present=False)
    assert FS.review_problems(good, None, None, ro_present=False)
    assert FS.review_problems(good, 0.86, None, ro_present=True)       # RO served, unreviewed
    assert FS.review_problems([dict(good[0], accepted=False)], 0.86, None, ro_present=False)
    assert FS.review_problems([dict(good[0], reads_identically=True)], 0.86, None, ro_present=False)
    assert FS.review_problems([dict(good[0], specificity=0.5)], 0.5, None, ro_present=False)
    # today's floor, not the floor the record was written under
    monkeypatch.setenv(FS.SPECIFICITY_FLOOR_ENV, "0.90")
    assert FS.review_problems(good, 0.86, None, ro_present=False)


# ══ S4 — EVERY RESULT WENT THROUGH THE SEAM ══════════════════════════════


def test_s4_the_numeric_fingerprint_is_unchanged(finding, profile):
    result, _, _ = _sharpen(finding, profile)
    assert result.finding is not finding
    assert F._numeric_fingerprint(result.finding) == F._numeric_fingerprint(finding)
    assert result.finding.facts_cited == finding.facts_cited
    assert result.finding.severity == finding.severity
    assert result.finding.rule_id == finding.rule_id
    assert result.finding.profile_id == finding.profile_id
    assert result.finding.threshold == finding.threshold
    assert result.finding.impact == finding.impact
    assert result.finding.evidence == finding.evidence
    assert result.finding.verdict().surfaced
    assert result.finding.narrative_source == "advisory"
    # ...and the text actually moved.
    assert result.finding.why_here.rationale != finding.why_here.rationale
    assert result.finding.action.steps != finding.action.steps


def test_s4_the_model_cannot_rank_suppress_or_relabel(finding, profile):
    """A model that returns severity / surfaced / rank / dismissed keys
    has them dropped at projection — they never reach a Finding, because
    the only constructor this lane uses takes prose parameters."""
    forged = {"en": dict(GOOD_EN), "ro": dict(GOOD_RO)}
    forged["en"]["severity"] = "critical"
    forged["en"]["surfaced"] = False
    forged["en"]["rank"] = 1
    forged["en"]["dismissed"] = True
    forged["en"]["facts_cited"] = {"intercompany_loans": 1.0}
    result, _, _ = _sharpen(finding, profile, draft=forged)
    assert result.degraded is False
    assert result.finding.severity == finding.severity
    assert result.finding.facts_cited == finding.facts_cited
    assert result.finding.verdict().surfaced is True


def test_s4_a_demoted_finding_is_never_sharpened(finding, profile):
    """The model cannot rescue an incomplete finding. It is not asked."""
    demoted = replace(finding, confidence=None)
    assert not demoted.verdict().surfaced
    drafter = StubClient(draft=GOOD_DRAFT)
    reviewer = StubClient(review=HIGH_REVIEW)
    result = FS.sharpen_finding(demoted, profile,
                                client_factory=_factory(drafter),
                                reviewer_factory=_factory(reviewer))
    assert result.degraded is True
    assert result.finding is demoted
    assert not drafter.calls and not reviewer.calls
    assert "demoted" in result.reason


def test_s4_a_rewrite_that_breaks_the_contract_is_refused(finding, profile):
    """Banned boilerplate written back into the rationale demotes the
    candidate; the lane regenerates once and then falls back. It never
    launders a hedge into a shipped finding."""
    hedged = dict(GOOD_EN)
    hedged["rationale"] = ("For a mid-size inventory-heavy operator the "
                           "balance on 461 should be monitored.")
    result, drafter, _ = _sharpen(finding, profile,
                                  draft={"en": hedged, "ro": GOOD_RO})
    assert result.degraded is True
    assert result.finding.narrative_source == "deterministic"
    assert "contract" in result.reason.lower()
    assert len([c for c in drafter.calls if c["role"] == "draft"]) == 2


# ══ S5 — THE ADVERSARIAL SELF-REVIEW ═════════════════════════════════════


def test_s5_a_generic_draft_buys_one_regeneration_then_falls_back(finding,
                                                                  profile):
    result, drafter, reviewer = _sharpen(finding, profile, review=LOW_REVIEW)
    assert result.degraded is True
    assert result.finding.narrative_source == "deterministic"
    assert len([c for c in drafter.calls if c["role"] == "draft"]) == 2, \
        "exactly ONE regeneration"
    assert len([c for c in reviewer.calls if c["role"] == "review"]) == 2
    assert "specificity" in result.reason
    assert "0.21" in result.reason and "0.60" in result.reason


def test_s5_the_regeneration_carries_the_critique(finding, profile):
    reviewer = StubClient(review=LOW_REVIEW)
    drafter = StubClient(draft=GOOD_DRAFT)
    FS.sharpen_finding(finding, profile, client_factory=_factory(drafter),
                       reviewer_factory=_factory(reviewer))
    second = [c for c in drafter.calls if c["role"] == "draft"][1]
    assert "REFUSED" in second["user_text"]
    assert LOW_REVIEW["critique"] in second["user_text"]
    assert LOW_REVIEW["generic_spans"][0] in second["user_text"]


def test_s5_a_second_pass_that_clears_the_floor_is_accepted(finding, profile):
    def review_script(n, _user_text):
        return LOW_REVIEW if n == 1 else HIGH_REVIEW

    drafter = StubClient(draft=GOOD_DRAFT)
    reviewer = StubClient(review=review_script)
    result = FS.sharpen_finding(finding, profile,
                                client_factory=_factory(drafter),
                                reviewer_factory=_factory(reviewer))
    assert result.degraded is False
    assert result.en.attempts == 2
    assert result.en.specificity == pytest.approx(0.86)


def test_s5_every_score_reaches_the_journal_and_the_distribution(finding,
                                                                 profile,
                                                                 decoy_result):
    def review_script(n, _user_text):
        return LOW_REVIEW if n == 1 else HIGH_REVIEW

    for _ in range(2):
        FS.sharpen_finding(finding, profile,
                           client_factory=_factory(StubClient(draft=GOOD_DRAFT)),
                           reviewer_factory=_factory(
                               StubClient(review=review_script)),
                           decoy_profile=decoy_result.profile)
    dist = FS.score_distribution()
    assert dist["count"] >= 4, dist
    assert dist["min"] == pytest.approx(0.21)
    assert dist["max"] == pytest.approx(0.86)
    assert dist["floor"] == pytest.approx(0.60)
    assert dist["outcomes"].get("regenerated", 0) >= 2
    assert dist["outcomes"].get("accepted", 0) >= 2
    assert "concentration_related_party" in dist["by_rule"]
    rows = [e for e in FS.journal_entries()
            if e.get("event") == "specificity_score"]
    assert rows
    for row in rows:
        assert row["review_model"] == registry.model_for(FS.ROLE_REVIEW)
        assert row["draft_model"] == registry.model_for(FS.ROLE_DRAFT)
        assert row["language"] in FS.LANGUAGES
        assert row["view_fingerprint"]


def test_s5_the_reviewer_sees_the_decoy_company(finding, profile, decoy_result):
    reviewer = StubClient(review=HIGH_REVIEW)
    FS.sharpen_finding(finding, profile,
                       client_factory=_factory(StubClient(draft=GOOD_DRAFT)),
                       reviewer_factory=_factory(reviewer),
                       decoy_profile=decoy_result.profile)
    review_call = [c for c in reviewer.calls if c["role"] == "review"][0]
    assert "decoy_company_profile" in review_call["user_text"]
    assert decoy_result.profile.profile_id in review_call["user_text"]
    assert decoy_result.profile.profile_id != profile.profile_id


def test_s5_the_floor_is_an_ops_dial(finding, profile, monkeypatch):
    monkeypatch.setenv(FS.SPECIFICITY_FLOOR_ENV, "0.10")
    result, _, _ = _sharpen(finding, profile, review=dict(
        LOW_REVIEW, reads_identically_for_another_company=False))
    assert result.degraded is False
    assert result.en.specificity == pytest.approx(0.21)


def test_s5_reads_identically_fails_regardless_of_the_score(finding, profile):
    result, _, _ = _sharpen(finding, profile, review={
        "specificity": 0.99, "reads_identically_for_another_company": True,
        "generic_spans": [], "critique": "swap-safe"})
    assert result.degraded is True
    assert "specificity" in result.reason


# ══ S6 — THE THREE STATES ════════════════════════════════════════════════


def test_s6_credits_absent_degrades_calmly(finding, profile, monkeypatch):
    """No key on the backend: the production factory fails honestly and
    the lane says so in a sentence."""
    for key in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"):
        monkeypatch.delenv(key, raising=False)
    result = FS.sharpen_finding(finding, profile)   # production factories
    assert result.degraded is True
    assert result.finding is finding
    assert result.finding.verdict().surfaced, "still fully useful"
    assert result.finding.narrative_source == "deterministic"
    assert result.ro is None
    assert "unavailable" in result.reason.lower()
    assert "deterministic" in result.reason.lower()
    assert "Traceback" not in result.reason and "{" not in result.reason


def test_s6_breaker_open_degrades_calmly(finding, profile, tmp_path,
                                         monkeypatch):
    """Cap the drafting role at zero — the ops kill switch — and the lane
    never even constructs a client."""
    sentinel = tmp_path / "models.yaml"
    raw = (REPO / "src" / "engine" / "ai" / "models.yaml").read_text(
        encoding="utf-8")
    sentinel.write_text(
        raw.replace("      max_calls_per_day: 300\n"
                    "      max_tokens_per_day: 3000000",
                    "      max_calls_per_day: 0\n"
                    "      max_tokens_per_day: 0"),
        encoding="utf-8")
    monkeypatch.setenv(registry.PATH_ENV, str(sentinel))
    registry.clear_cache()
    try:
        assert registry.breaker_limits_for(FS.ROLE_DRAFT)["max_calls_per_day"] == 0
        drafter = StubClient(draft=GOOD_DRAFT)
        result = FS.sharpen_finding(
            finding, profile, client_factory=_factory(drafter),
            reviewer_factory=_factory(StubClient(review=HIGH_REVIEW)))
        assert result.degraded is True
        assert not drafter.calls, "the breaker must trip BEFORE the client"
        assert result.finding.verdict().surfaced
        assert result.finding.narrative_source == "deterministic"
        assert "spend cap" in result.reason
        assert FS.ROLE_DRAFT in result.reason
        assert "{" not in result.reason
    finally:
        registry.clear_cache()


def test_s6_the_reviewer_being_down_never_ships_ungated_prose(finding, profile):
    """The anti-generic net is not optional. If the reviewer cannot run,
    the draft does not ship."""
    def boom():
        raise RuntimeError("no reviewer")

    drafter = StubClient(draft=GOOD_DRAFT)
    result = FS.sharpen_finding(finding, profile,
                                client_factory=_factory(drafter),
                                reviewer_factory=boom)
    assert result.degraded is True
    assert result.finding.narrative_source == "deterministic"
    assert "ungated" in result.reason
    assert not drafter.calls


def test_s6_a_malformed_model_answer_degrades_calmly(finding, profile):
    result, _, _ = _sharpen(finding, profile, draft="this is not json")
    assert result.degraded is True
    assert result.finding.verdict().surfaced
    assert "this is not json" not in result.reason
    assert "deterministic" in result.reason.lower()


def test_s6_the_breaker_counts_the_spend(finding, profile):
    _sharpen(finding, profile)
    snapshot = breaker.status_snapshot()
    assert snapshot["roles"][FS.ROLE_DRAFT]["calls"] >= 1
    assert snapshot["roles"][FS.ROLE_REVIEW]["calls"] >= 1
    # Tokens are ESTIMATED, not zero — a token cap that never moves is not
    # a cap (see `_estimated_tokens`).
    assert snapshot["roles"][FS.ROLE_DRAFT]["tokens"] > 0


def test_s6_fully_useful_with_ai_absent_across_every_surfaced_finding(
        subject_result, decoy_result, monkeypatch):
    for key in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"):
        monkeypatch.delenv(key, raising=False)
    total = 0
    for result in (subject_result, decoy_result):
        for sharpened in FS.sharpen_result(result):
            assert sharpened.degraded is True
            assert sharpened.finding.verdict().surfaced
            assert sharpened.finding.narrative_source == "deterministic"
            assert sharpened.en.rationale
            assert sharpened.en.steps
            assert sharpened.ro is None
            total += 1
    assert total >= 8, total


# ══ S7 — ROMANIAN ════════════════════════════════════════════════════════


def test_s7_romanian_is_produced_and_fingerprinted(finding, profile):
    result, _, _ = _sharpen(finding, profile)
    assert result.ro is not None
    assert result.ro.language == "ro"
    assert "461" in result.ro.rationale
    assert result.ro.steps
    assert result.ro.steps[0].imperative.startswith("Solicit")
    # It went through the SAME seam, so the numerics are pinned there too.
    assert F._numeric_fingerprint(result.ro_finding) == \
        F._numeric_fingerprint(finding)
    # ...and the placeholder resolved to the engine's own figure.
    native = "RON %s" % format(finding.facts_cited["intercompany_loans"], ",.0f")
    assert native in result.ro.rationale


def test_s7_a_romanian_hedge_is_refused(finding, profile):
    hedged = dict(GOOD_RO)
    hedged["rationale"] = ("Soldul de pe 461 ar trebui monitorizat de "
                           "conducere în perioada următoare.")
    result, _, _ = _sharpen(finding, profile,
                            draft={"en": GOOD_EN, "ro": hedged})
    assert result.degraded is False, "the English half is unaffected"
    assert result.ro is None
    assert FS.RO_ABSENT_REASON in result.reason
    problems = [e for e in FS.journal_entries()
                if e.get("event") == "ro_gate_refusal"]
    assert problems and any("hedge" in json.dumps(p["problems"])
                            for p in problems)


def test_s7_a_romanian_step_with_a_weak_verb_is_refused(finding, profile):
    weak = dict(GOOD_RO)
    weak["steps"] = [{"imperative": "Monitorizează soldul de pe 461",
                      "artefact": "situația soldurilor",
                      "provider": "controlorul financiar",
                      "horizon": None}]
    result, _, _ = _sharpen(finding, profile,
                            draft={"en": GOOD_EN, "ro": weak})
    assert result.ro is None
    assert result.degraded is False


def test_s7_a_romanian_rationale_naming_no_account_is_refused(finding, profile):
    vague = dict(GOOD_RO)
    vague["rationale"] = ("Soldurile cu părțile afiliate reprezintă capital "
                          "imobilizat în interiorul grupului.")
    result, _, _ = _sharpen(finding, profile,
                            draft={"en": GOOD_EN, "ro": vague})
    assert result.ro is None


def test_s7_a_romanian_numeral_is_refused(finding, profile):
    bad = dict(GOOD_RO)
    bad["rationale"] = ("Soldul de pe 461 a crescut cu 47% față de anul "
                        "precedent.")
    result, _, _ = _sharpen(finding, profile,
                            draft={"en": GOOD_EN, "ro": bad})
    assert result.ro is None
    assert result.degraded is False


def test_s7_romanian_is_graded_by_the_same_adversarial_reviewer(finding,
                                                                profile):
    def review_script(n, user_text):
        # The RO draft is reviewed second; fail it and only it.
        return HIGH_REVIEW if n == 1 else LOW_REVIEW

    drafter = StubClient(draft=GOOD_DRAFT)
    reviewer = StubClient(review=review_script)
    result = FS.sharpen_finding(finding, profile,
                                client_factory=_factory(drafter),
                                reviewer_factory=_factory(reviewer))
    assert result.degraded is False
    assert result.ro is None, "a generic Romanian half is dropped, not shipped"
    assert FS.RO_ABSENT_REASON in result.reason
    ro_scores = [e for e in FS.journal_entries()
                 if e.get("event") == "specificity_score"
                 and e.get("language") == "ro"]
    assert ro_scores and ro_scores[-1]["accepted"] is False


def test_s7_absent_romanian_is_stated_not_guessed(finding, profile):
    result, _, _ = _sharpen(finding, profile,
                            draft={"en": GOOD_EN})   # no RO block at all
    assert result.degraded is False
    assert result.ro is None
    assert result.ro_finding is None
    assert FS.RO_ABSENT_REASON in result.reason


# ══ S8 — THE F9 GUARD ════════════════════════════════════════════════════


def test_s8_assert_no_new_numerals_raises_on_the_f9_plant(finding):
    invented = ("For a mid-size inventory-heavy operator this balance has "
                "grown 47% since the prior year.")
    with pytest.raises(FS.AdvisoryNumeralError) as exc:
        FS.assert_no_new_numerals(finding, rationale=invented)
    assert any("47" in v for v in exc.value.violations)
    # ...and a clean rewrite is untouched.
    FS.assert_no_new_numerals(
        finding,
        rationale=("For a mid-size inventory-heavy operator the balance on "
                   "461 is group capital with no contractual maturity."))


def test_s8_the_guarded_seam_demotes_the_f9_plant(finding):
    """The shape the findings gate lane expects: a bare model numeral does
    not surface. Same plant text as
    `test_f9_no_model_numeral_survives_into_the_prose`.

    ORDER-INDEPENDENT: the unguarded seam is read through
    `FS.unguarded_seam()` — the function `_finding` itself defines — and
    the guard is installed EXPLICITLY for the assertion and restored
    after. Reading `F.apply_advisory_narrative` for the "unguarded" half
    would test whichever function the most recent import left there
    (`engine.api._finding_advisory` installs the twin as a side effect),
    which is what made this test red in the full run and green alone.
    """
    invented = ("For a mid-size inventory-heavy operator this balance has "
                "grown 47% since the prior year.")
    raw = FS.unguarded_seam()
    assert raw is not FS.apply_advisory_narrative
    assert raw(finding, rationale=invented).verdict().surfaced, \
        "the UNGUARDED seam still ships it — that is the hole F9 names"
    before = F.apply_advisory_narrative
    try:
        FS.install_guard(F)
        assert F.apply_advisory_narrative is FS.apply_advisory_narrative
        planted = F.apply_advisory_narrative(finding, rationale=invented)
    finally:
        F.apply_advisory_narrative = before
    assert not planted.verdict().surfaced
    assert planted.narrative_source == "advisory"
    assert F._numeric_fingerprint(planted) == F._numeric_fingerprint(finding)
    # ...and the twin itself, called directly, demotes the same plant.
    assert not FS.apply_advisory_narrative(finding, rationale=invented).verdict().surfaced


def test_s8_the_guarded_seam_passes_a_clean_rewrite_through(finding):
    clean = ("For a mid-size inventory-heavy operator the balance on 461 is "
             "group capital of {{money:intercompany_loans}} with no "
             "contractual maturity on the face of the books.")
    resolved = FS._resolve(clean, finding)
    out = FS.apply_advisory_narrative(
        finding, rationale=resolved,
        action_steps=tuple(finding.action.steps))
    assert out.verdict().surfaced
    assert out.narrative_source == "advisory"
    assert F._numeric_fingerprint(out) == F._numeric_fingerprint(finding)


def test_s8_a_numeral_in_an_action_step_is_caught_too(finding):
    step = F.ActionStep(imperative="Pull the 461 sub-ledger",
                        artefact="aging schedule",
                        provider="the controller",
                        horizon="within 30 days")
    with pytest.raises(FS.AdvisoryNumeralError):
        FS.assert_no_new_numerals(finding, action_steps=(step,))


def test_s8_install_guard_is_the_one_line_the_f9_lane_needs(finding):
    """The wiring recipe, pre-verified here so the gate lane's shim is a
    copy-paste rather than an experiment.

    `install_guard` captures the original BEFORE overwriting, which is the
    whole reason it exists: assigning the twin onto
    `_finding.apply_advisory_narrative` directly and then letting this
    module bind its seam lazily would be an infinite recursion, not an
    error. It is also idempotent, so importing the shim twice is safe.
    """
    original = F.apply_advisory_narrative
    invented = ("For a mid-size inventory-heavy operator this balance has "
                "grown 47% since the prior year.")
    try:
        FS.install_guard(F)
        FS.install_guard(F)          # idempotent
        assert F.apply_advisory_narrative is FS.apply_advisory_narrative
        # The gate's own assertion, run against the installed guard.
        planted = F.apply_advisory_narrative(finding, rationale=invented)
        assert not planted.verdict().surfaced
        # ...and a clean rewrite still works through the installed twin,
        # which is what proves the seam did not bind to itself.
        clean = F.apply_advisory_narrative(
            finding,
            rationale=("For a mid-size inventory-heavy operator the balance "
                       "on 461 is group capital with no maturity."))
        assert clean.verdict().surfaced
        assert F._numeric_fingerprint(clean) == F._numeric_fingerprint(finding)
    finally:
        F.apply_advisory_narrative = original
    assert F.apply_advisory_narrative is original


def test_s8_binding_the_twin_without_capturing_the_original_is_refused(finding):
    """The trap `install_guard` exists to close, made loud."""
    original = F.apply_advisory_narrative
    raw = FS._MODULES.pop("__raw_apply__", None)
    try:
        F.apply_advisory_narrative = FS.apply_advisory_narrative
        with pytest.raises(RuntimeError) as exc:
            FS._F()
        assert "install_guard" in str(exc.value)
    finally:
        F.apply_advisory_narrative = original
        if raw is not None:
            FS._MODULES["__raw_apply__"] = raw
        else:
            FS._MODULES.pop("__raw_apply__", None)
            FS._F()


# ══ DETERMINISM ══════════════════════════════════════════════════════════


def test_the_same_inputs_and_the_same_model_answer_give_the_same_bytes(
        finding, profile, gateway):
    a, _, _ = _sharpen(finding, profile, gateway=gateway)
    b, _, _ = _sharpen(finding, profile, gateway=gateway)
    assert a.finding.render().body == b.finding.render().body
    assert a.finding.render().body_template == b.finding.render().body_template
    assert a.view_fingerprint == b.view_fingerprint
    assert a.ro.rationale == b.ro.rationale
    assert json.dumps(a.en.to_payload(), sort_keys=True) == \
        json.dumps(b.en.to_payload(), sort_keys=True)


def test_the_view_fingerprint_moves_with_the_company(finding, profile,
                                                     decoy_result):
    other = None
    for f in decoy_result.finding_set.surfaced:
        if f.rule_id == "affiliate_income_dependency":
            other = f
    assert other is not None
    mine = FS.build_view(finding, profile).fingerprint()
    theirs = FS.build_view(other, decoy_result.profile).fingerprint()
    assert mine != theirs


# ══ THE LIVE PATH — env-gated; CI stays fully mocked forever ═════════════


@pytest.mark.skipif(not os.environ.get("SHARPEN_LIVE"),
                    reason="live model call; set SHARPEN_LIVE=1 to exercise it")
def test_live_the_real_path_produces_real_text(finding, profile, gateway,
                                               decoy_result):
    result = FS.sharpen_finding(finding, profile, gateway=gateway,
                                decoy_profile=decoy_result.profile)
    print(json.dumps(result.to_payload(), indent=2, ensure_ascii=False))
    print(json.dumps(FS.score_distribution(), indent=2))
    assert result.finding.verdict().surfaced
    assert F._numeric_fingerprint(result.finding) == \
        F._numeric_fingerprint(finding)
