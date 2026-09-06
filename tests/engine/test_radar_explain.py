"""RADAR — AI EXPLANATION IN ITS LANE, gated. R5 / R6 / R7.

Every subject in this file comes out of the REAL chain over REAL,
anonymised corpus trial balances (TC-1): ``corpus/<case>/input.xlsx`` ->
the production parser -> the production assembler -> the production
detectors, captured by ``tests/engine/fixtures/radar/explain/capture.py`` and
rebuilt here from the captured statements. Nothing is hand-built.

WHAT IS GATED HERE

  R5 NO MODEL NUMERAL   a numeral the engine never computed is rejected
                        at parse, regenerated once, then the deterministic
                        template ships — AND the SERVED text is guarded
                        again, cache included. A poisoned cache record is
                        refused by the served guard with its own message.
  R6 DEGRADED           model dead (SDK absent, no key), model raising,
                        model answering garbage, lane breaker open: the
                        rows are complete, the explanation is an honest
                        ``absent`` marker with a readable reason, and not
                        one byte of model payload reaches the served shape.
                        The critical path is cache-only and the after-rows
                        path is lazy — proven with tripwires.
  R7 READ-ONLY          the lane receives a projection: a callable planted
                        at three seams (the Finding, the profile payload,
                        the ranked row) and an object whose ``__repr__`` /
                        ``__str__`` raise are never invoked through a whole
                        explain run. A model that answers with a changed
                        severity, rank and dismissal leaves the row
                        byte-identical; the output type cannot carry ranking
                        vocabulary (structural), ``attach`` refuses one that
                        grew it (runtime), and every other module of the
                        package is model-free (static).

NO LIVE CALLS. Every model call goes through a stub client. The live
exercise is env-gated (``RADAR_EXPLAIN_LIVE=1``) and CI never runs it.

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

import ast
import copy
import json
import os
import sys
import threading
from dataclasses import replace
from pathlib import Path
from typing import Any, Dict, List

import pytest
import yaml

from engine.ai import breaker
from engine.ai import finding_sharpen as FS
from engine.ai import registry
from engine.api import _finding as F
from engine.api.findings import s_engine
from engine.radar import explain as X

REPO = Path(__file__).resolve().parents[2]
#: The explain lane's OWN fixture dir. The serve lane captures into the
#: parent directory with its own script and its own shape; the two are
#: kept apart so neither capture can overwrite the other's files.
FIXTURES = REPO / "tests" / "engine" / "fixtures" / "radar" / "explain"
CASES = ("saga_10_col", "saga_10_col_agras", "saga_10_col_carniprod",
         "saga_10_col_realestate", "saga_10_col_retail")

#: The censuses below refuse to pass on an empty or shrunken set.
MIN_CASES = 5
MIN_SUBJECTS = 20

#: The 461 concentration finding — the case the whole contract was
#: designed around — as this lane identifies it.
CANARY_CASE = "saga_10_col_agras"
CANARY_FINDING = "concentration_related_party|461,451,452,455"


# ══ REAL ENGINE OUTPUT — the subjects ════════════════════════════════════


def _load(case_id: str) -> Dict[str, Any]:
    with open(str(FIXTURES / (case_id + ".json")), encoding="utf-8") as fh:
        return json.load(fh)


def _rebuild(case: Dict[str, Any]):
    return s_engine.run_single_period(
        case["statements"], period_id=case["period_id"],
        snapshot_id=case["snapshot_hash"][:23])


@pytest.fixture(scope="module")
def cases():
    out = {}  # type: Dict[str, Dict[str, Any]]
    for case_id in CASES:
        case = _load(case_id)
        result = _rebuild(case)
        subjects = X.subjects_from_result(
            result, org_id="org-" + case_id, period_id=case["period_id"],
            snapshot_hash=case["snapshot_hash"])
        out[case_id] = {"case": case, "result": result, "subjects": subjects}
    return out


@pytest.fixture(scope="module")
def all_subjects(cases):
    subjects = []  # type: List[X.ExplainSubject]
    for case_id in CASES:
        subjects.extend(cases[case_id]["subjects"])
    assert len(subjects) >= MIN_SUBJECTS, "the corpus stopped producing subjects"
    return tuple(subjects)


@pytest.fixture(scope="module")
def canary(cases):
    for subject in cases[CANARY_CASE]["subjects"]:
        if subject.finding_id == CANARY_FINDING:
            return subject
    raise AssertionError("the engine stopped producing the 461 finding")


@pytest.fixture(scope="module")
def canary_rows(cases):
    return cases[CANARY_CASE]["result"].surfaced()


@pytest.fixture(autouse=True)
def _isolated_state(tmp_path, monkeypatch):
    """Never touch the real breaker counters, the real AI journal or the
    real explanation cache."""
    monkeypatch.setenv(breaker.STATE_DIR_ENV, str(tmp_path / "spend"))
    monkeypatch.setenv(FS.JOURNAL_DIR_ENV, str(tmp_path / "journal"))
    monkeypatch.setenv(X.CACHE_DIR_ENV, str(tmp_path / "explain_cache"))
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
    """Shaped like the client ``call_strict_json`` drives. Dispatches on
    the system prompt so one object plays drafter or reviewer."""

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
        role = "review" if is_review else "draft"
        self.calls.append({"role": role, "user_text": user_text})
        script = self._review if is_review else self._draft
        if callable(script):
            payload = script(len([c for c in self.calls if c["role"] == role]),
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


def _view_of(user_text: str) -> Dict[str, Any]:
    """The read-only view the drafter was handed, parsed back."""
    body = user_text.split("FINDING VIEW (read-only):\n", 1)[1]
    body = body.split("\n\nDECOY COMPANY", 1)[0]
    body = body.split("\n\nYOUR PREVIOUS ANSWER WAS REFUSED", 1)[0]
    return json.loads(body)


def good_draft(view: Dict[str, Any], extra: Dict[str, Any] = None) -> Dict[str, Any]:
    """A contract-clean draft for ANY finding: anchored on the profile
    label, naming a subject code, citing one placeholder, no numerals."""
    anchor = view["finding"]["deterministic_why_here"]["anchors"][0]
    code = view["vocabulary"]["account_codes"][0]
    placeholders = view["vocabulary"]["money_placeholders"]
    cite = (" — the engine puts it at %s —" % placeholders[0]) if placeholders else ""
    en = {
        "rationale": (
            "For a %s the balance carried on %s%s is not a passive line: it "
            "is tied to how this company finances its working capital, so "
            "the lender reads it against the same covenant the profile's "
            "financing shape is measured on, and a delay there lands on the "
            "next drawdown rather than on a footnote." % (anchor, code, cite)),
        "steps": [
            {"imperative": "Pull the sub-ledger behind %s with counterparty "
                           "and settlement dates" % code,
             "artefact": "the account %s sub-ledger split by counterparty" % code,
             "provider": "the financial controller", "horizon": None},
            {"imperative": "Reconcile that sub-ledger to the general ledger "
                           "closing balance",
             "artefact": "the reconciliation with every difference named",
             "provider": "the chief accountant", "horizon": None},
        ],
    }
    ro = {
        "rationale": (
            "Pentru acest operator, soldul contului %s%s nu este o linie "
            "pasivă: este legat de felul în care compania își finanțează "
            "capitalul de lucru, iar banca îl citește față de același "
            "covenant pe care se măsoară forma de finanțare." % (code, cite)),
        "steps": [
            {"imperative": "Solicită fișa analitică a contului %s cu "
                           "contrapartide și scadențe" % code,
             "artefact": "fișa analitică a contului %s" % code,
             "provider": "controlorul financiar", "horizon": None},
        ],
    }
    out = {"en": en, "ro": ro}
    if extra:
        out.update(extra)
        out["en"] = dict(en, **extra)
    return out


def GOOD_DRAFT(n, user_text):
    return good_draft(_view_of(user_text))


HIGH_REVIEW = {"specificity": 0.86,
               "reads_identically_for_another_company": False,
               "generic_spans": [], "critique": ""}

LOW_REVIEW = {"specificity": 0.22,
              "reads_identically_for_another_company": True,
              "generic_spans": ["is not a passive line"],
              "critique": "Name what this company's own structure does."}


def _explain(subjects, draft=GOOD_DRAFT, review=HIGH_REVIEW, store=None, **kw):
    drafter = StubClient(draft=draft)
    reviewer = StubClient(review=review)
    store = store if store is not None else X.MemoryExplainStore()
    out = X.explain_rows(subjects, store=store,
                         client_factory=_factory(drafter),
                         reviewer_factory=_factory(reviewer), **kw)
    return out, drafter, reviewer, store


def _served_json(rows, explanations, subjects) -> str:
    return json.dumps(X.attach(rows, explanations, subjects),
                      ensure_ascii=False, sort_keys=True, default=str)


# ══ TC-1 / TC-6 — the fixtures ARE the real chain's output ═══════════════


def test_tc1_every_case_is_what_the_real_chain_produces(cases):
    """Per case (TC-6): the same surfaced ids, in the same order, with
    the same numeric fingerprints the capture recorded."""
    assert len(cases) >= MIN_CASES
    for case_id, bundle in cases.items():
        expect = bundle["case"]["expect"]
        got = [(s.finding_id, F._numeric_fingerprint(s.finding))
               for s in bundle["subjects"]]
        want = [(row["finding_id"], row["numeric_fingerprint"])
                for row in expect["surfaced"]]
        assert got == want, case_id
        assert len(bundle["subjects"]) == expect["surfaced_count"], case_id
        assert bundle["result"].profile.profile_id == bundle["case"]["profile_id"]
        assert len(bundle["result"].all_checks()) == expect["checks_count"]


def test_tc1_the_capture_script_agrees_with_the_committed_fixtures():
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "radar_explain_capture", str(FIXTURES / "capture.py"))
    capture = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(capture)
    for case_id in CASES:
        fresh = capture.run_chain(case_id)
        committed = _load(case_id)
        assert fresh["expect"] == committed["expect"], case_id
        assert fresh["snapshot_hash"] == committed["snapshot_hash"], case_id


# ══ R7 — READ-ONLY: three seams plus __repr__ ════════════════════════════


class Tripwire(object):
    def __init__(self, name):
        self.name = name
        self.calls = 0

    def __call__(self, *args, **kwargs):
        self.calls += 1
        raise AssertionError("the explain lane INVOKED a planted callable at "
                             "seam %r — the projection is data, never "
                             "behaviour" % self.name)


class ReprTripwire(object):
    """Not callable. Fires if the lane ever `repr`s, `str`s or formats
    an object it does not understand instead of naming its type."""

    def __init__(self, name):
        self.name = name
        self.calls = 0

    def __repr__(self):
        self.calls += 1
        raise AssertionError("the explain lane REPR'd a planted object at "
                             "seam %r" % self.name)

    __str__ = __repr__

    def __format__(self, spec):
        return self.__repr__()


class ProfileProxy(object):
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


def _plant_seams(subject, row_payload):
    tw_finding = Tripwire("finding.subject.accounts[0].bucket")
    tw_profile = Tripwire("profile.to_payload()['metrics']")
    tw_row = Tripwire("row['materiality']['planted']")
    tw_repr = ReprTripwire("row['score']['planted_repr']")
    accounts = subject.finding.subject.accounts
    planted_finding = replace(
        subject.finding,
        subject=replace(subject.finding.subject,
                        accounts=(replace(accounts[0], bucket=tw_finding),)
                                 + tuple(accounts[1:])))
    planted_profile = ProfileProxy(subject.profile, tw_profile)
    planted_row = copy.deepcopy(row_payload)
    planted_row["materiality"] = {"planted": tw_row, "share": 0.19}
    planted_row["score"] = {"planted_repr": tw_repr, "total": 0.5}
    planted = X.subject_for(
        planted_finding, planted_profile, planted_row,
        subject.org_id, subject.period_id, subject.snapshot_hash,
        gateway_facts={"total_assets": "present", "planted": Tripwire("gateway")})
    return planted, (tw_finding, tw_profile, tw_row, tw_repr)


def test_r7_a_callable_at_three_seams_and_a_repr_tripwire_never_fire(canary, canary_rows):
    row = [r for r in canary_rows if r["rule_key"] == canary.finding.rule_id][0]
    planted, tripwires = _plant_seams(canary, row)
    # the projection named them, without touching them
    assert planted.row["materiality"]["planted"] == FS.CALLABLE_WITHHELD
    assert planted.row["score"]["planted_repr"] == FS.OBJECT_WITHHELD % "ReprTripwire"
    assert planted.gateway_facts["planted"] == FS.CALLABLE_WITHHELD
    # ...and a WHOLE explain run — prompts, seam, guard, cache, attach —
    # never invokes any of them
    out, drafter, _r, store = _explain([planted])
    assert drafter.calls, "the drafting model was never called"
    assert out[0].status == X.STATUS_FRESH, out[0].reason
    attached = X.attach([row, planted.row], out, [planted])
    json.dumps(attached, sort_keys=True)
    for tw in tripwires:
        assert tw.calls == 0, "seam %r was invoked" % tw.name
    # the view the model saw carried the withheld markers, not behaviour
    view = _view_of(drafter.calls[0]["user_text"])
    assert view["finding"]["subject"]["accounts"][0]["bucket"] == FS.CALLABLE_WITHHELD
    assert view["company_profile"]["metrics"]["planted_tripwire"] == FS.CALLABLE_WITHHELD


def test_r7_the_projection_is_json_primitives_and_the_lane_never_writes_the_row(canary, canary_rows):
    row = [r for r in canary_rows if r["rule_key"] == canary.finding.rule_id][0]
    before = json.dumps(row, sort_keys=True)
    subject = X.subject_for(canary.finding, canary.profile, row,
                            "org", "p", "snap")
    assert json.loads(json.dumps(subject.row, sort_keys=True)) == subject.row
    out, _d, _r, _s = _explain([subject])
    attached = X.attach([row], out, [subject])
    assert json.dumps(row, sort_keys=True) == before, "attach mutated its input row"
    assert json.dumps(subject.row, sort_keys=True) == before, "the projection was written"
    stripped = dict(attached[0])
    stripped.pop("explanation")
    assert json.dumps(stripped, sort_keys=True) == before


def test_r7_plant_a_model_that_returns_a_changed_severity_the_row_is_unchanged(canary, canary_rows):
    """The model answers with severity/rank/dismissal keys at every
    level. They are dropped at projection; the row is byte-identical;
    the explanation payload carries none of them."""
    row = [r for r in canary_rows if r["rule_key"] == canary.finding.rule_id][0]
    assert row["severity"] != "critical"
    overreach = {"severity": "critical", "effective_severity": "critical",
                 "rank": 1, "dismissed": True, "surfaced": False,
                 "disposition": "all_checks", "cap": 0}

    def draft(n, user_text):
        return good_draft(_view_of(user_text), extra=overreach)

    before = json.dumps(row, sort_keys=True)
    out, drafter, _r, _s = _explain([canary], draft=draft)
    assert out[0].status == X.STATUS_FRESH, out[0].reason
    attached = X.attach([row], out, [canary])
    stripped = dict(attached[0])
    payload = stripped.pop("explanation")
    assert json.dumps(stripped, sort_keys=True) == before
    assert stripped["severity"] == row["severity"]
    X.assert_explanation_is_prose_only(payload)
    blob = json.dumps(payload, sort_keys=True)
    for key in overreach:
        assert '"%s"' % key not in blob, key
    # and the finding the lane drafted against still carries its own severity
    assert canary.finding.severity == row["severity"]


def test_r7_the_output_type_structurally_cannot_carry_ranking_vocabulary():
    names = set(X.explanation_field_names())
    assert names, "no output fields — the structural check is vacuous"
    assert names & X.RANKING_VOCABULARY == set()
    for word in ("severity", "rank", "disposition", "dismissed", "cap", "surfaced"):
        assert word in X.RANKING_VOCABULARY


def test_r7_attach_refuses_an_explanation_that_grew_a_ranking_key(canary, canary_rows):
    row = [r for r in canary_rows if r["rule_key"] == canary.finding.rule_id][0]
    out, _d, _r, _s = _explain([canary])
    grown = replace(out[0], review=({"language": "en", "severity": "critical"},))
    with pytest.raises(X.ExplanationOverreach) as exc:
        X.attach([row], [grown], [canary])
    assert "severity" in str(exc.value) and "does not rank" in str(exc.value)


def test_r7_attach_binds_an_explanation_to_the_row_it_was_drafted_for(canary, canary_rows):
    """A row whose ranking moved since the draft gets the honest marker,
    never someone else's prose."""
    row = [r for r in canary_rows if r["rule_key"] == canary.finding.rule_id][0]
    out, _d, _r, _s = _explain([canary])
    moved = dict(row, rank=3)
    resubject = X.subject_for(canary.finding, canary.profile, moved,
                              canary.org_id, canary.period_id, canary.snapshot_hash)
    assert resubject.row_fingerprint != canary.row_fingerprint
    attached = X.attach([moved], out, [resubject])
    assert attached[0]["explanation"]["status"] == X.STATUS_ABSENT
    assert attached[0]["explanation"]["kind"] == X.KIND_STALE_CACHE
    assert attached[0]["explanation"]["en"] is None
    # the same explanation on the row it was drafted for is served
    same = X.attach([row], out, [canary])
    assert same[0]["explanation"]["status"] == X.STATUS_FRESH


def test_r7_every_other_module_of_the_package_is_model_free(tmp_path):
    modules = X.model_free_modules()
    assert len(modules) >= 1, ("no model-free module to check — the "
                               "structural census is vacuous")
    assert X.critical_path_violations() == []
    X.assert_no_model_in_critical_path()
    source = modules[0].read_text(encoding="utf-8")
    # PLANT (a): a model import in a ranking/serving module
    planted = tmp_path / modules[0].name
    planted.write_text("from engine.ai import breaker  # PLANT\n" + source,
                       encoding="utf-8")
    violations = X.critical_path_violations([planted])
    assert any("imports engine.ai" in v for v in violations), violations
    with pytest.raises(X.CriticalPathViolation):
        X.assert_no_model_in_critical_path([planted])
    # PLANT (b): a client call
    planted.write_text(source + "\n\ndef _x(client):\n"
                       "    return client.messages.create(model='x')  # PLANT\n",
                       encoding="utf-8")
    assert any("messages.create" in v for v in X.critical_path_violations([planted]))
    # PLANT (c): reaching the explain lane from a model-free module
    planted.write_text("from . import explain  # PLANT\n" + source, encoding="utf-8")
    assert any("explain lane" in v for v in X.critical_path_violations([planted]))
    planted.write_text("from engine.radar import explain  # PLANT\n" + source,
                       encoding="utf-8")
    assert any("explain lane" in v for v in X.critical_path_violations([planted]))


# ══ R5 — NO MODEL NUMERAL IN A SERVED EXPLANATION ════════════════════════


def _numeral_draft(view: Dict[str, Any]) -> Dict[str, Any]:
    draft = good_draft(view)
    draft["en"]["rationale"] = draft["en"]["rationale"].replace(
        "is not a passive line", "has grown 47% since the prior year")
    return draft


def test_r5_a_model_numeral_is_refused_regenerated_once_then_deterministic(canary, canary_rows):
    out, drafter, reviewer, _s = _explain(
        [canary], draft=lambda n, t: _numeral_draft(_view_of(t)))
    assert len([c for c in drafter.calls if c["role"] == "draft"]) == 2, \
        "exactly one regeneration"
    assert "47" in drafter.calls[1]["user_text"], "the critique names the numeral"
    assert not reviewer.calls, "an unguarded draft never reaches the reviewer"
    expl = out[0]
    assert expl.status == X.STATUS_ABSENT
    assert expl.kind == X.KIND_ADVISORY_UNAVAILABLE
    assert expl.en is None and expl.ro is None
    assert "deterministic" in expl.reason.lower()
    # the row still carries the deterministic why-here and action list,
    # and NOTHING served carries the invented figure
    row = [r for r in canary_rows if r["rule_key"] == canary.finding.rule_id][0]
    blob = _served_json([row], out, [canary])
    assert "47%" not in blob and "grown 47" not in blob
    assert row["contract_elements"]["why_here"]["rationale"]


def test_r5_a_clean_regeneration_is_accepted_and_served(canary):
    def draft(n, user_text):
        view = _view_of(user_text)
        return _numeral_draft(view) if n == 1 else good_draft(view)

    out, drafter, _r, _s = _explain([canary], draft=draft)
    assert len([c for c in drafter.calls if c["role"] == "draft"]) == 2
    assert out[0].status == X.STATUS_FRESH
    assert out[0].en.attempts == 2
    assert X.served_numeral_violations(canary.finding, out[0].en) == ()
    assert "47" not in out[0].en.rationale


def test_r5_the_placeholder_is_resolved_to_the_engines_own_figure(canary):
    out, drafter, _r, _s = _explain([canary])
    view = _view_of(drafter.calls[0]["user_text"])
    cited = view["vocabulary"]["money_placeholders"][0]          # {{money:FACT}}
    fact = cited[len("{{money:"):-2]
    assert fact in canary.finding.facts_cited
    printed = F._format_value(canary.finding.facts_cited[fact], F.UNIT_MONEY,
                              canary.finding.currency)
    assert cited in drafter.calls[0]["user_text"], "the model saw the token, not the figure"
    assert printed not in drafter.calls[0]["user_text"], "a money figure reached the model"
    assert printed in out[0].en.rationale, (printed, out[0].en.rationale)
    assert "{{money:" not in out[0].en.rationale
    assert printed in out[0].ro.rationale


def test_r5_plant_a_poisoned_cache_record_the_served_guard_refuses_it(canary):
    """A cache record is data written earlier. One whose prose carries a
    model numeral is refused by the SERVED guard on the critical path
    (attach_cached: the honest marker, with the class named) and is a
    MISS on the after-rows path — redrafted, never served, and the
    poisoned record is replaced by the redraft."""
    out, _d, _r, store = _explain([canary])
    key = out[0].key
    record = store.get(key)
    record["en"]["rationale"] = record["en"]["rationale"].replace(
        "is not a passive line", "has grown 47% since the prior year")
    store.put(key, record)
    cached = X.attach_cached([canary], store=store)
    assert cached[0].status == X.STATUS_ABSENT
    assert cached[0].kind == X.KIND_NUMERAL_REFUSED
    assert cached[0].reason.startswith("Served explanation refused by the numeral guard")
    assert FS.CLASS_NUMERAL in cached[0].reason
    assert cached[0].en is None
    drafter = StubClient(draft=GOOD_DRAFT)
    again = X.explain_one(canary, store=store, client_factory=_factory(drafter),
                          reviewer_factory=_factory(StubClient(review=HIGH_REVIEW)))
    assert drafter.calls, "a refused record must be redrafted, not served"
    assert again.status == X.STATUS_FRESH
    assert "grown 47%" not in _prose_text(again.to_payload())
    assert "grown 47%" not in _prose_text(store.get(key)), "the poisoned record survived"
    assert X.attach_cached([canary], store=store)[0].status == X.STATUS_CACHED


def _prose_text(payload: Dict[str, Any]) -> str:
    """Every rationale and step field of a payload / record — the text a
    reader sees, without the hex keys a substring check would trip on."""
    parts = []  # type: List[str]
    for lang in ("en", "ro"):
        block = payload.get(lang)
        if not isinstance(block, dict):
            continue
        parts.append(str(block.get("rationale") or ""))
        for step in block.get("steps") or ():
            parts.extend(str(step.get(k) or "") for k in
                         ("imperative", "artefact", "provider", "horizon"))
    return "\n".join(parts)


def test_r5_a_numeral_in_a_cached_step_is_caught_too(canary):
    out, _d, _r, store = _explain([canary])
    record = store.get(out[0].key)
    record["en"]["steps"][0]["horizon"] = "within 30 days"
    store.put(out[0].key, record)
    cached = X.attach_cached([canary], store=store)
    assert cached[0].kind == X.KIND_NUMERAL_REFUSED


def test_r5_the_served_guard_names_every_class_in_its_reason(canary):
    """Ten classes of model-authored quantity, planted into a cache
    record one at a time on the 461 canary, each refused with its class
    named in the reader-facing reason — and no brace in that reason."""
    out, drafter, _r, store = _explain([canary])
    key = out[0].key
    clean = store.get(key)
    # the figure the draft actually resolved (good_draft cites the first
    # listed placeholder), re-derived from the fact rather than typed in
    cited = _view_of(drafter.calls[0]["user_text"])["vocabulary"]["money_placeholders"][0]
    fact = cited[len("{{money:"):-2]
    figure = "RON %s" % format(canary.finding.facts_cited[fact], ",.0f")
    assert figure in clean["en"]["rationale"], "the canary prose lost its resolved figure"
    plants = [
        (" It has grown forty-seven percent since last year.", FS.CLASS_NUMBER_WORD),
        (" Soldul este de trei ori mai mare.", FS.CLASS_NUMBER_WORD),
        (" The balance of %s euro is group money." % figure, FS.CLASS_CURRENCY),
        (" The balance in EUR: %s is group money." % figure, FS.CLASS_CURRENCY),
        (" The balance of %s lei is group money." % figure, FS.CLASS_CURRENCY),
        (" Roughly ½ of the book is group money.", FS.CLASS_UNICODE),
        (" XII months of settlement are outstanding.", FS.CLASS_ROMAN),
        (" It has grown 461% since last year.", FS.CLASS_CODE_AS_QUANTITY),
        (" Settlement runs past 461 days.", FS.CLASS_CODE_AS_QUANTITY),
        (" The haircut is {{money:intercompany_loans|Bare}}.", FS.CLASS_UNRESOLVED),
        (" The haircut is {{ money }}.", FS.CLASS_UNRESOLVED),
        (" It has grown 47% since last year.", FS.CLASS_NUMERAL),
    ]
    for injected, expected in plants:
        poisoned = json.loads(json.dumps(clean))
        poisoned["en"]["rationale"] = clean["en"]["rationale"] + injected
        store.put(key, poisoned)
        cached = X.attach_cached([canary], store=store)[0]
        assert cached.kind == X.KIND_NUMERAL_REFUSED, (injected, cached.kind, cached.reason)
        assert expected in cached.reason, (injected, cached.reason)
        assert "{" not in cached.reason and "}" not in cached.reason


def test_r5_a_sign_flip_through_abs_is_refused_on_both_paths(cases):
    """The critic's D1 on realestate: EBITDA is negative, the model writes
    `{{money:ebitda_statutory|abs}}`, `render_native` honours it and a
    reader is told "the shortfall is RON 29,038,838" with the sign gone.
    Refused at draft (the option), and refused on the served / cached
    text too (the templatizer lifts the magnitude back as `|abs`)."""
    bundle = cases["saga_10_col_realestate"]
    subject = [s for s in bundle["subjects"]
               if s.finding_id.startswith("valuation_ebitda_non_positive")][0]
    ebitda = float(subject.finding.facts_cited["ebitda_statutory"])
    assert ebitda < 0, "the fixture stopped carrying a negative EBITDA"

    def draft(n, user_text):
        d = good_draft(_view_of(user_text))
        d["en"]["rationale"] += " The shortfall is {{money:ebitda_statutory|abs}}."
        return d

    out, drafter, _r, store = _explain([subject], draft=draft)
    assert out[0].status == X.STATUS_ABSENT
    assert FS.CLASS_OPTION in out[0].reason and "abs" in out[0].reason
    assert len([c for c in drafter.calls if c["role"] == "draft"]) == 2
    # the served side: a record carrying the magnitude as prose
    good, _d, _r2, store = _explain([subject])
    record = store.get(good[0].key)
    record["en"]["rationale"] += " The shortfall is RON %s." % format(abs(ebitda), ",.0f")
    store.put(good[0].key, record)
    marker = X.attach_cached([subject], store=store)[0]
    assert marker.kind == X.KIND_NUMERAL_REFUSED
    assert FS.CLASS_OPTION in marker.reason
    # ...while the SIGNED figure, which is the engine's own, is served
    record["en"]["rationale"] = good[0].en.rationale + " The result is RON %s." % format(
        ebitda, ",.0f")
    store.put(good[0].key, record)
    assert X.attach_cached([subject], store=store)[0].status == X.STATUS_CACHED


def test_r5_a_romanian_number_word_never_reaches_the_served_shape(canary):
    """The critic's B3-B5: the Romanian half carrying `de trei ori` is
    refused at draft (Romanian is additive — its failure is stated
    absence) and the served payload carries neither the RO text nor the
    words."""
    def draft(n, user_text):
        d = good_draft(_view_of(user_text))
        d["ro"]["rationale"] += " Soldul este de trei ori mai mare decât anul trecut."
        return d

    out, _d, _r, _s = _explain([canary], draft=draft)
    assert out[0].status == X.STATUS_FRESH
    assert out[0].ro is None
    assert out[0].ro_absent_reason == FS.RO_ABSENT_REASON
    assert "trei ori" not in json.dumps(out[0].to_payload(), ensure_ascii=False)


def test_r5_the_served_guard_is_the_f9_guard(canary):
    """Same predicate as the drafting lane's — the two cannot drift."""
    prose = X.Prose(language="en", rationale="This balance grew 47% on 461.",
                    steps=(), source="advisory")
    violations = X.served_numeral_violations(canary.finding, prose)
    assert violations and any("47" in v for v in violations)
    with pytest.raises(FS.AdvisoryNumeralError):
        FS.assert_no_new_numerals(canary.finding, rationale=prose.rationale)
    clean = X.Prose(language="en", rationale="The balance on 461 is {{money:intercompany_loans}}.",
                    steps=(), source="advisory")
    assert X.served_numeral_violations(canary.finding, clean) == ()


def test_r5_no_served_explanation_carries_a_model_numeral_on_any_case(cases, all_subjects):
    """The census (TC-3 floor, TC-6 per case): every subject on every
    case is explained, and every served rationale and step passes the
    served guard."""
    served = 0
    for case_id, bundle in cases.items():
        out, _d, _r, _s = _explain(bundle["subjects"])
        assert len(out) == bundle["case"]["expect"]["surfaced_count"], case_id
        for subject, expl in zip(bundle["subjects"], out):
            assert expl.status == X.STATUS_FRESH, (case_id, subject.finding_id, expl.reason)
            assert X.served_numeral_violations(subject.finding, expl.en) == ()
            if expl.ro is not None:
                assert X.served_numeral_violations(subject.finding, expl.ro) == ()
            served += 1
        rows = bundle["result"].surfaced()
        attached = X.attach(rows, out, bundle["subjects"])
        assert [r["explanation"]["status"] for r in attached] == [X.STATUS_FRESH] * len(rows)
    assert served >= MIN_SUBJECTS, "the census shrank"
    print("GATE-WORK radar-explain units=%d label=served-explanations" % served)


# ══ B2 — THE CACHE PATH RUNS EVERY FRESH CHECK, ON READ ══════════════════
#
# A cache record with `review: []`, `specificity: null`, hedge prose and
# `source: "deterministic-looking"` was served as `cached`, source passed
# through verbatim — the self-review, the anchor / hedge / imperative
# checks and the source check were fresh-path only. Every check below is
# asserted ONE AT A TIME on EVERY subject of EVERY case (TC-6): plant the
# defect into an otherwise-earned record, the critical path serves the
# honest marker with the check's kind, the after-rows path redrafts.


def _cache_plants(record, subject):
    """(label, mutated record, expected kind). Each plant changes ONE
    thing about an earned record."""
    def mut(fn):
        copy_ = json.loads(json.dumps(record))
        fn(copy_)
        return copy_

    def en_rationale(text):
        return lambda r: r["en"].__setitem__("rationale", text)

    def en_append(text):
        return lambda r: r["en"].__setitem__("rationale", r["en"]["rationale"] + text)

    code = subject.finding.subject.codes()[0]
    anchor = subject.finding.why_here.anchors[0]
    plants = [
        ("numeral", en_append(" It has grown 47% since the prior year."), X.KIND_NUMERAL_REFUSED),
        ("number word", en_append(" It has grown threefold."), X.KIND_NUMERAL_REFUSED),
        ("currency label", en_append(" That is about EUR 2,000,000 lei."), X.KIND_NUMERAL_REFUSED),
        ("unicode numeral", en_append(" Roughly ½ of it is group money."), X.KIND_NUMERAL_REFUSED),
        ("roman numeral", en_append(" XII months of settlement remain."), X.KIND_NUMERAL_REFUSED),
        ("code as quantity", en_append(" It has grown %s%% in a year." % code), X.KIND_NUMERAL_REFUSED),
        ("unresolved placeholder", en_append(" The haircut is {{ money }}."), X.KIND_NUMERAL_REFUSED),
        ("hedge", en_append(" The board should keep an eye on it."), X.KIND_CONTRACT_REFUSED),
        ("no anchor", en_rationale("The balance on %s is group capital with no maturity." % code),
         X.KIND_CONTRACT_REFUSED),
        ("weak imperative", lambda r: r["en"]["steps"][0].__setitem__(
            "imperative", "Monitor the %s sub-ledger" % code), X.KIND_CONTRACT_REFUSED),
        ("review empty", lambda r: r.__setitem__("review", []), X.KIND_REVIEW_MISSING),
        ("specificity null", lambda r: r["en"].__setitem__("specificity", None), X.KIND_REVIEW_MISSING),
        ("review below floor", lambda r: (r["en"].__setitem__("specificity", 0.3),
                                          [row.__setitem__("specificity", 0.3) for row in r["review"]]),
         X.KIND_REVIEW_MISSING),
        ("review not accepted", lambda r: [row.__setitem__("accepted", False) for row in r["review"]],
         X.KIND_REVIEW_MISSING),
        ("reads identically", lambda r: [row.__setitem__("reads_identically", True) for row in r["review"]],
         X.KIND_REVIEW_MISSING),
        ("source foreign", lambda r: r["en"].__setitem__("source", "deterministic-looking"),
         X.KIND_REVIEW_MISSING),
        ("stale fingerprint", lambda r: r.__setitem__("numeric_fingerprint", "0" * 64), X.KIND_STALE_CACHE),
    ]
    out = []
    for label, fn, kind in plants:
        out.append((label, mut(fn), kind))
    assert anchor.lower() in record["en"]["rationale"].lower()
    return out


def test_b2_the_cache_path_runs_every_fresh_check_on_read_for_every_subject(cases, all_subjects):
    """TC-6: every check, every subject, every case — not one predicate."""
    checks = 0
    seen_kinds = set()
    for case_id, bundle in cases.items():
        for subject in bundle["subjects"]:
            out, _d, _r, store = _explain([subject])
            assert out[0].status == X.STATUS_FRESH, (case_id, subject.finding_id, out[0].reason)
            key = out[0].key
            clean = store.get(key)
            # the earned record HITS, and its source is re-derived
            hit = X.attach_cached([subject], store=store)[0]
            assert hit.status == X.STATUS_CACHED and hit.en.source == "advisory"
            prompt = X.prompt_version()
            for label, poisoned, kind in _cache_plants(clean, subject):
                store.put(key, poisoned)
                marker = X.attach_cached([subject], store=store)[0]
                assert marker.status == X.STATUS_ABSENT, (case_id, subject.finding_id, label)
                assert marker.kind == kind, (case_id, subject.finding_id, label, marker.kind,
                                             marker.reason)
                assert marker.en is None and marker.ro is None
                assert marker.reason.strip() and "{" not in marker.reason
                # ...and the read the after-rows path performs is a MISS of
                # the same kind (the redraft itself is exercised once per
                # subject below, inside the lane's daily cap)
                read = X._from_cache(store, key, subject, prompt, None)
                assert not read.hit and read.kind == kind, (label, read.kind)
                seen_kinds.add(kind)
                checks += 1
            # the after-rows path REDRAFTS a refused record and replaces it
            drafter = StubClient(draft=GOOD_DRAFT)
            again = X.explain_one(subject, store=store, client_factory=_factory(drafter),
                                  reviewer_factory=_factory(StubClient(review=HIGH_REVIEW)))
            assert drafter.calls, (subject.finding_id,
                                   "a refused record was served instead of redrafted")
            assert again.status == X.STATUS_FRESH, (subject.finding_id, again.reason)
            assert store.get(key)["en"] == clean["en"], subject.finding_id
            assert X.attach_cached([subject], store=store)[0].status == X.STATUS_CACHED
    assert len(all_subjects) >= MIN_SUBJECTS
    assert checks >= 17 * MIN_SUBJECTS, checks
    assert seen_kinds == {X.KIND_NUMERAL_REFUSED, X.KIND_CONTRACT_REFUSED,
                          X.KIND_REVIEW_MISSING, X.KIND_STALE_CACHE}
    print("GATE-WORK radar-explain-cache units=%d label=cache-checks" % checks)


def test_b2_a_record_is_refused_at_todays_floor_not_the_one_it_was_written_under(canary, monkeypatch):
    out, _d, _r, store = _explain([canary])
    assert X.attach_cached([canary], store=store)[0].status == X.STATUS_CACHED
    monkeypatch.setenv(FS.SPECIFICITY_FLOOR_ENV, "0.90")
    marker = X.attach_cached([canary], store=store)[0]
    assert marker.kind == X.KIND_REVIEW_MISSING


def test_b2_the_source_is_never_passed_through(canary):
    out, _d, _r, store = _explain([canary])
    record = store.get(out[0].key)
    assert record["en"]["source"] == "advisory"
    hit = X.attach_cached([canary], store=store)[0]
    assert hit.en.source == "advisory" and (hit.ro is None or hit.ro.source == "advisory")
    for foreign in ("deterministic-looking", "Advisory", "", "model"):
        record["en"]["source"] = foreign
        store.put(out[0].key, record)
        marker = X.attach_cached([canary], store=store)[0]
        assert marker.status == X.STATUS_ABSENT and marker.kind == X.KIND_REVIEW_MISSING, foreign
        assert foreign not in json.dumps(marker.to_payload()) or foreign == ""


# ══ A1 — THE PAYLOAD CONTRACT THE ROUTE WIRES ════════════════════════════


def test_the_payload_contract_is_stable(canary, canary_rows):
    """`Explanation.to_payload()` IS the seam. Its key sets are pinned
    here; the serve lane attaches exactly this under `row["explanation"]`
    and nothing else writes that key."""
    out, _d, _r, store = _explain([canary])
    fresh = out[0].to_payload()
    cached = X.attach_cached([canary], store=store)[0].to_payload()
    marker = X.absent("f", "k", X.KIND_NOT_YET, "Nothing yet.").to_payload()
    for payload in (fresh, cached, marker):
        assert set(payload) == X.EXPLANATION_PAYLOAD_KEYS, sorted(payload)
        assert payload["status"] in (X.STATUS_CACHED, X.STATUS_FRESH, X.STATUS_ABSENT)
        assert payload["kind"] in X.ABSENT_KINDS or payload["kind"] == ""
        for lang in ("en", "ro"):
            block = payload[lang]
            if block is None:
                continue
            assert set(block) == X.PROSE_PAYLOAD_KEYS, sorted(block)
            for step in block["steps"]:
                assert set(step) == X.STEP_PAYLOAD_KEYS, sorted(step)
        for row in payload["review"]:
            assert set(row) <= X.REVIEW_ROW_KEYS, sorted(row)
        X.assert_explanation_is_prose_only(payload)
    assert fresh["status"] == X.STATUS_FRESH and cached["status"] == X.STATUS_CACHED
    # the ONLY writer of row["explanation"] is `attach`, and it writes
    # exactly this payload
    row = [r for r in canary_rows if r["rule_key"] == canary.finding.rule_id][0]
    attached = X.attach([row], out, [canary])[0]
    assert set(attached) == set(row) | {"explanation"}
    assert attached["explanation"] == fresh
    assert X.KIND_NUMERAL_REFUSED in X.ABSENT_KINDS and X.KIND_REVIEW_MISSING in X.ABSENT_KINDS
    assert X.REFUSED_CACHE_KINDS <= X.ABSENT_KINDS


# ══ B4 — THE FIXTURES ARE THE SERVED OUTPUT, NOT THE ASSEMBLE PATH ═══════
#
# The explain fixtures were first captured on the assemble path while the
# serve lane moved to the served seam (`_rebuild_assembled_for_briefing`
# over the persisted line items with the persisted envelope on the row):
# `facts_cited` differed on 4 of 21 subjects — the 461 canary cited
# total_assets 39,272,501.03 where the served row carries 39,319,114.09 —
# so a live fingerprint could never hit a cache record against a served
# row. The capture now runs the SERVE LANE'S seam (its capture module,
# loaded by path — one implementation), and the tests below hold the two
# lanes' fixtures to each other subject by subject.

SERVE_FIXTURES = REPO / "tests" / "engine" / "fixtures" / "radar"


def _serve_fixture(case_id: str) -> Dict[str, Any]:
    with open(str(SERVE_FIXTURES / (case_id + ".json")), encoding="utf-8") as fh:
        return json.load(fh)


def test_b4_every_explain_fixture_was_captured_on_the_served_seam(cases):
    """The fixture says which seam it came from and what that seam
    served; the numbers the detectors judged are the served ones."""
    for case_id, bundle in cases.items():
        meta = bundle["case"]["_meta"]
        assert meta["seam"] == "served", (case_id, meta)
        assert "_rebuild_assembled_for_briefing" in meta["engine_path"], case_id
        bs = bundle["case"]["statements"]["assembled_bs"]
        assert bs["total_assets"] == meta["served_total_assets"], case_id
        assert meta["served_total_assets"] != meta["assemble_path_total_assets"] or \
            case_id != CANARY_CASE, "the canary stopped separating the two seams"


def test_b4_served_net_income_is_account_121_on_every_fixture(cases):
    """Radar must cite what every other surface cites: net income is the
    account-121 anchor, never the class-6/7 reconstruction. The capture
    refuses to write a fixture whose served net income is not the
    envelope's p121; this holds the committed files to the same rule."""
    for case_id, bundle in cases.items():
        meta = bundle["case"]["_meta"]
        pl = bundle["case"]["statements"]["assembled_pl"]
        assert meta["envelope_p121"] is not None, case_id
        assert abs(float(pl["net_income_statutory"]) - float(meta["envelope_p121"])) < 0.005, (
            case_id, pl["net_income_statutory"], meta["envelope_p121"])
        assert pl.get("net_income_anchor_source") == "envelope_p121_cross_check", (
            case_id, pl.get("net_income_anchor_source"))


def test_b4_facts_cited_per_subject_equal_the_serve_lanes_rows(cases):
    """Subject by subject: the facts this lane fingerprints are the facts
    the served row carries — first the single-period payloads (the
    Capsule's list), then the Radar rows a reader sees. A disagreement
    names the case, the subject and which lane's fixture is stale
    (measured by its own envelope's account 121)."""
    compared = 0
    for case_id, bundle in cases.items():
        serve = _serve_fixture(case_id)
        served_pl = serve["statements"]["assembled_pl"]
        cbs = (serve["envelope"].get("canonical_bs") or {})
        p121 = ((cbs.get("invariants") or {}).get("p121_cross_check") or {}).get("p121")
        serve_anchored = p121 is not None and abs(
            float(served_pl.get("net_income_statutory") or 0) - float(p121)) < 0.005
        by_id = {}  # type: Dict[str, Dict[str, Any]]
        for payload in serve["single_period"]["payloads"]:
            by_id[X._row_identity(payload)] = payload
        radar_by_id = {}  # type: Dict[str, Dict[str, Any]]
        for row in serve["radar"]["surfaced"] + serve["radar"]["info"]:
            radar_by_id[X._row_identity(row)] = row
        for subject in bundle["subjects"]:
            row = by_id.get(subject.finding_id)
            assert row is not None, (case_id, subject.finding_id, sorted(by_id))
            mine = dict((k, float(v)) for k, v in subject.finding.facts_cited.items())
            theirs = dict((k, float(v)) for k, v in row["facts_cited"].items())
            assert mine == theirs, (
                "%s / %s: facts_cited differ between the explain fixture and the "
                "serve fixture's single_period payload. The serve fixture's "
                "served net income %s the envelope's account 121 (%s) — %s"
                % (case_id, subject.finding_id,
                   "equals" if serve_anchored else "does NOT equal", p121,
                   "so the explain capture is off the served seam"
                   if serve_anchored else
                   "so tests/engine/fixtures/radar/capture.py predates the net-"
                   "income anchor wave (commit 06ee60f) and must be re-run by "
                   "the serve lane"))
            assert F._numeric_fingerprint(subject.finding) == F._numeric_fingerprint(
                subject.finding), "fingerprint is not stable"
            radar_row = radar_by_id.get(subject.finding_id)
            if radar_row is not None:
                assert dict((k, float(v)) for k, v in radar_row["facts_cited"].items()) == mine, (
                    case_id, subject.finding_id)
            compared += 1
    assert compared >= MIN_SUBJECTS, compared


# ══ R6 — DEGRADED: rows complete, explanation absent, zero raw payload ═══


RAW_MARKER = "RAW-MODEL-PAYLOAD-MARKER-7f3a"
DEAD_MARKER = "model is dead for this test"
_PAYLOAD_TOKENS = ("Traceback", "messages.create", "raw_response", RAW_MARKER, DEAD_MARKER)


def _dead_client_factory():
    raise RuntimeError(DEAD_MARKER)


@pytest.fixture()
def model_dead(monkeypatch):
    """The corpus-replay sentinel: ANY real SDK import raises, no key is
    set; the state dirs are already scratch."""
    monkeypatch.setitem(sys.modules, "anthropic", None)
    for key in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"):
        monkeypatch.delenv(key, raising=False)


def _assert_rows_complete(rows, attached, kind):
    assert len(attached) == len(rows) and rows, "rows went missing"
    for original, row in zip(rows, attached):
        assert row["surfaced"] is True
        assert row["contract_elements"]["why_here"]["rationale"].strip()
        assert row["contract_elements"]["action"]["steps"]
        assert row["title"] == original["title"] and row["body"] == original["body"]
        expl = row["explanation"]
        assert expl["status"] == X.STATUS_ABSENT
        assert expl["kind"] == kind
        assert expl["en"] is None and expl["ro"] is None
        assert expl["reason"].strip() and "{" not in expl["reason"]


def test_r6_model_dead_rows_complete_explanation_absent_zero_raw_payload(model_dead, cases):
    """Production factories, nothing mocked but the death itself."""
    for case_id, bundle in cases.items():
        subjects = bundle["subjects"]
        out = X.explain_rows(subjects, store=X.MemoryExplainStore())
        rows = bundle["result"].surfaced()
        attached = X.attach(rows, out, subjects)
        _assert_rows_complete(rows, attached, X.KIND_ADVISORY_UNAVAILABLE)
        blob = json.dumps(attached, ensure_ascii=False, sort_keys=True, default=str)
        for token in _PAYLOAD_TOKENS:
            assert token not in blob, (case_id, token)
        for expl in out:
            assert "unavailable" in expl.reason.lower()
            assert "deterministic" in expl.reason.lower()


def test_r6_a_model_that_raises_with_a_payload_never_reaches_the_served_shape(canary, canary_rows):
    drafter = StubClient(draft=RuntimeError(RAW_MARKER + " {\"secret\": 1}"))
    out = X.explain_rows([canary], store=X.MemoryExplainStore(),
                         client_factory=_factory(drafter),
                         reviewer_factory=_factory(StubClient(review=HIGH_REVIEW)))
    rows = [r for r in canary_rows if r["rule_key"] == canary.finding.rule_id]
    attached = X.attach(rows, out, [canary])
    _assert_rows_complete(rows, attached, X.KIND_ADVISORY_UNAVAILABLE)
    blob = json.dumps(attached, ensure_ascii=False, default=str)
    assert RAW_MARKER not in blob and "secret" not in blob


def test_r6_a_model_that_answers_garbage_never_reaches_the_served_shape(canary, canary_rows):
    drafter = StubClient(draft=RAW_MARKER + " this is not json {")
    out = X.explain_rows([canary], store=X.MemoryExplainStore(),
                         client_factory=_factory(drafter),
                         reviewer_factory=_factory(StubClient(review=HIGH_REVIEW)))
    rows = [r for r in canary_rows if r["rule_key"] == canary.finding.rule_id]
    attached = X.attach(rows, out, [canary])
    _assert_rows_complete(rows, attached, X.KIND_ADVISORY_UNAVAILABLE)
    assert RAW_MARKER not in json.dumps(attached, ensure_ascii=False, default=str)


def test_r6_a_rejected_draft_and_its_critique_stay_in_the_journal(canary, tmp_path):
    """The served shape strips the score rows to numbers and labels; the
    candidate text and the critique are journal-only."""
    out, _d, _r, _s = _explain(
        [canary], draft=lambda n, t: dict(good_draft(_view_of(t)),
                                          en=dict(good_draft(_view_of(t))["en"],
                                                  rationale="For a mid-size inventory-heavy "
                                                            "operator the 461 balance " + RAW_MARKER)),
        review=LOW_REVIEW)
    assert out[0].status == X.STATUS_ABSENT
    blob = json.dumps(out[0].to_payload(), ensure_ascii=False)
    assert RAW_MARKER not in blob
    assert "critique" not in blob and "candidate" not in blob and "generic_spans" not in blob
    journal = json.dumps(FS.journal_entries(tmp_path / "journal"), ensure_ascii=False)
    assert RAW_MARKER in journal, "the audit surface keeps the rejected draft"


def test_r6_breaker_open_on_the_lane_role_never_constructs_a_client(monkeypatch, tmp_path, canary):
    raw = yaml.safe_load((REPO / "src" / "engine" / "ai" / "models.yaml").read_text("utf-8"))
    raw["roles"][X.ROLE]["breaker"] = {"max_calls_per_day": 0, "max_tokens_per_day": 0}
    path = tmp_path / "models.yaml"
    path.write_text(yaml.safe_dump(raw, sort_keys=True), encoding="utf-8")
    monkeypatch.setenv(registry.PATH_ENV, str(path))
    registry.clear_cache()
    try:
        called = []

        def _factory_tripwire():
            called.append(1)
            raise AssertionError("a tripped breaker must never construct a client")

        out = X.explain_rows([canary], store=X.MemoryExplainStore(),
                             client_factory=_factory_tripwire,
                             reviewer_factory=_factory_tripwire)
        assert not called
        assert out[0].status == X.STATUS_ABSENT
        assert out[0].kind == X.KIND_BREAKER_OPEN
        assert X.ROLE in out[0].reason and "spend cap" in out[0].reason
        assert "{" not in out[0].reason
    finally:
        registry.clear_cache()


def test_r6_the_lane_counts_its_own_calls_against_its_own_role(canary, tmp_path):
    before = breaker.status_snapshot()["roles"].get(X.ROLE, {}).get("calls", 0)
    _explain([canary])
    after = breaker.status_snapshot()["roles"][X.ROLE]["calls"]
    assert after == before + 1
    # and the drafting roles counted theirs, inside the lane
    roles = breaker.status_snapshot()["roles"]
    assert roles[FS.ROLE_DRAFT]["calls"] >= 1 and roles[FS.ROLE_REVIEW]["calls"] >= 1


def test_r6_attach_cached_is_cache_only_and_never_reaches_the_model(monkeypatch, canary, canary_rows):
    """The one call the route may make before its rows go out."""
    def _sharpen_tripwire(*args, **kwargs):
        raise AssertionError("attach_cached reached the drafting lane")

    monkeypatch.setattr(FS, "sharpen_finding", _sharpen_tripwire)
    monkeypatch.setattr(breaker, "check", lambda *a, **k: (_ for _ in ()).throw(
        AssertionError("attach_cached consulted the breaker")))
    store = X.MemoryExplainStore()
    out = X.attach_cached([canary], store=store)
    assert out[0].status == X.STATUS_ABSENT
    assert out[0].kind == X.KIND_NOT_YET
    rows = [r for r in canary_rows if r["rule_key"] == canary.finding.rule_id]
    attached = X.attach(rows, out, [canary])
    _assert_rows_complete(rows, attached, X.KIND_NOT_YET)


def test_r6_explanations_are_lazy_rows_first_model_after(canary_rows, cases):
    subjects = cases[CANARY_CASE]["subjects"]
    drafter = StubClient(draft=GOOD_DRAFT)
    gen = X.explain_subjects(subjects, store=X.MemoryExplainStore(),
                             client_factory=_factory(drafter),
                             reviewer_factory=_factory(StubClient(review=HIGH_REVIEW)))
    # rows are attachable before the generator has done anything
    attached = X.attach(canary_rows, X.attach_cached(subjects, store=X.MemoryExplainStore()),
                        subjects)
    assert len(attached) == len(canary_rows)
    assert not drafter.calls, "creating the generator drafted something"
    first = next(gen)
    assert first.status == X.STATUS_FRESH
    assert len([c for c in drafter.calls if c["role"] == "draft"]) == 1
    rest = list(gen)
    assert len(rest) == len(subjects) - 1


def test_r6_background_explanation_fills_the_cache_and_never_raises(canary):
    store = X.MemoryExplainStore()
    done = threading.Event()
    seen = []

    def _on_done(out):
        seen.extend(out)
        done.set()

    thread = X.explain_in_background(
        [canary], on_done=_on_done, store=store,
        client_factory=_factory(StubClient(draft=GOOD_DRAFT)),
        reviewer_factory=_factory(StubClient(review=HIGH_REVIEW)))
    assert done.wait(20), "the background lane did not finish"
    thread.join(5)
    assert seen and seen[0].status == X.STATUS_FRESH
    cached = X.attach_cached([canary], store=store)
    assert cached[0].status == X.STATUS_CACHED
    # a lane that blows up in the background is logged, not raised
    boom = threading.Event()

    def _explode(*a, **k):
        raise RuntimeError(RAW_MARKER)

    thread = X.explain_in_background([canary], on_done=lambda out: boom.set(),
                                     store=store, client_factory=_explode,
                                     reviewer_factory=_explode)
    assert boom.wait(20)
    thread.join(5)


def test_r6_every_degraded_reason_is_a_sentence_never_a_payload(canary):
    for expl in (
        X.absent("f", "k", X.KIND_LANE_ERROR, "boom {json: 1}"),
        X.absent("f", "k", X.KIND_LANE_ERROR, "Traceback (most recent call last)"),
        X.absent("f", "k", X.KIND_LANE_ERROR, ""),
    ):
        assert "{" not in expl.reason and "Traceback" not in expl.reason
        assert expl.reason.endswith(".")
        assert expl.status == X.STATUS_ABSENT and expl.en is None


def test_r6_a_lane_bug_is_a_marker_not_an_outage(monkeypatch, canary):
    def _broken(*args, **kwargs):
        raise KeyError("planted lane bug " + RAW_MARKER)

    monkeypatch.setattr(FS, "sharpen_finding", _broken)
    out = X.explain_rows([canary], store=X.MemoryExplainStore())
    assert out[0].kind == X.KIND_LANE_ERROR
    assert "KeyError" in out[0].reason and RAW_MARKER not in out[0].reason


# ══ THE CACHE ════════════════════════════════════════════════════════════


def test_cache_key_moves_with_each_of_its_five_parts():
    base = X.cache_key("org", "period", "snap", "rule|461", "v1")
    assert base == X.cache_key("org", "period", "snap", "rule|461", "v1")
    assert X.cache_key("org2", "period", "snap", "rule|461", "v1") != base
    assert X.cache_key("org", "period2", "snap", "rule|461", "v1") != base
    assert X.cache_key("org", "period", "snap2", "rule|461", "v1") != base
    assert X.cache_key("org", "period", "snap", "rule|462", "v1") != base
    assert X.cache_key("org", "period", "snap", "rule|461", "v2") != base
    assert X.prompt_version().startswith("radar_explain_v1|")
    assert FS.DRAFT_PROMPT_VERSION in X.prompt_version()
    assert FS.REVIEW_PROMPT_VERSION in X.prompt_version()
    # the numeral law is the fourth part: a record cleared by an older,
    # weaker law is a miss
    assert X.prompt_version().endswith("|" + FS.NUMERAL_LAW_VERSION)
    assert FS.NUMERAL_LAW_VERSION == "numeral_law_v2"
    assert X.CACHE_VERSION == 2


def test_cache_hit_is_served_without_a_model_call(canary):
    out, drafter, _r, store = _explain([canary])
    assert out[0].status == X.STATUS_FRESH
    calls = len(drafter.calls)
    again, drafter2, _r2, _s2 = _explain([canary], store=store)
    assert again[0].status == X.STATUS_CACHED
    assert not drafter2.calls
    assert again[0].en == out[0].en and again[0].ro == out[0].ro
    assert calls == len(drafter.calls)
    # refresh bypasses the cache deliberately
    fresh, drafter3, _r3, _s3 = _explain([canary], store=store, refresh=True)
    assert fresh[0].status == X.STATUS_FRESH and drafter3.calls


def test_cache_record_whose_numbers_moved_is_a_miss(canary):
    """The figures resolved into cached prose belonged to OTHER numbers.
    The critical path says so (`stale_cache`); the after-rows path
    redrafts."""
    out, _d, _r, store = _explain([canary])
    record = store.get(out[0].key)
    record["numeric_fingerprint"] = "0" * 64
    store.put(out[0].key, record)
    cached = X.attach_cached([canary], store=store)
    assert cached[0].status == X.STATUS_ABSENT and cached[0].kind == X.KIND_STALE_CACHE
    assert cached[0].en is None and "{" not in cached[0].reason
    again, drafter, _r2, _s = _explain([canary], store=store)
    assert again[0].status == X.STATUS_FRESH and drafter.calls


def test_cache_record_from_another_prompt_version_is_a_miss(canary):
    out, _d, _r, store = _explain([canary])
    record = store.get(out[0].key)
    record["prompt_version"] = "radar_explain_v0|x|y"
    store.put(out[0].key, record)
    assert X.attach_cached([canary], store=store)[0].kind == X.KIND_NOT_YET


def test_only_an_earned_explanation_is_cached(canary):
    out, _d, _r, store = _explain([canary], review=LOW_REVIEW)
    assert out[0].status == X.STATUS_ABSENT
    assert store.rows == {}
    good, _d2, _r2, store2 = _explain([canary])
    assert list(store2.rows) == [good[0].key]


def test_file_store_round_trips_and_a_corrupt_record_is_a_miss(tmp_path, canary):
    store = X.FileExplainStore(tmp_path / "cache")
    out, _d, _r, _s = _explain([canary], store=store)
    assert out[0].status == X.STATUS_FRESH
    cached = X.attach_cached([canary], store=store)
    assert cached[0].status == X.STATUS_CACHED
    assert cached[0].en == out[0].en
    path = store._path(out[0].key)
    path.write_text("{not json", encoding="utf-8")
    assert X.attach_cached([canary], store=store)[0].kind == X.KIND_NOT_YET
    assert X.default_store()._dir == tmp_path / "explain_cache"


def test_the_cache_is_per_org_and_per_snapshot(canary):
    out, _d, _r, store = _explain([canary])
    other_org = replace(canary, org_id="org-other")
    assert X.attach_cached([other_org], store=store)[0].kind == X.KIND_NOT_YET
    other_snap = replace(canary, snapshot_hash="sha256-other")
    assert X.attach_cached([other_snap], store=store)[0].kind == X.KIND_NOT_YET
    assert X.attach_cached([canary], store=store)[0].status == X.STATUS_CACHED


# ══ THE ROLE, AND THE NO-NAME-BRANCHES RULE ══════════════════════════════


def test_the_lane_role_is_registered_with_explicit_caps_and_mirrors_the_drafting_model():
    raw = yaml.safe_load((REPO / "src" / "engine" / "ai" / "models.yaml").read_text("utf-8"))
    role = raw["roles"][X.ROLE]
    assert "breaker" in role, "radar_explain must not inherit the default caps"
    assert set(role["breaker"]) == {"max_calls_per_day", "max_tokens_per_day"}
    assert role["breaker"]["max_calls_per_day"] > 0
    assert role["temperature"] == 0
    params = registry.params_for(X.ROLE)
    assert params["breaker"] == role["breaker"]
    assert params["prompt_version"] == "radar_explain_v1"
    assert registry.model_for(X.ROLE) == registry.model_for(FS.ROLE_DRAFT), \
        "the row documents the model the lane actually drafts on"


def test_no_profile_or_company_name_branch_in_the_lane():
    from engine.api import _company_profile as CP

    profile_ids = set(p.id for p in CP.load_catalog().structural_profiles)
    names = {"carniprod", "scandia", "agras", "eei", "exemplu", "sibiu"}
    tree = ast.parse((REPO / "src" / "engine" / "radar" / "explain.py").read_text("utf-8"))
    offenders = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Compare):
            for side in [node.left] + list(node.comparators):
                if isinstance(side, ast.Constant) and isinstance(side.value, str):
                    low = side.value.lower()
                    if side.value in profile_ids or any(n in low for n in names):
                        offenders.append(side.value)
    assert not offenders, offenders


def test_the_same_inputs_and_the_same_model_answer_give_the_same_bytes(canary):
    a, _d, _r, _s = _explain([canary])
    b, _d2, _r2, _s2 = _explain([canary])
    assert json.dumps(a[0].to_payload(), sort_keys=True) == \
        json.dumps(b[0].to_payload(), sort_keys=True)


# ══ THE LIVE PATH — env-gated; CI stays fully mocked forever ═════════════


@pytest.mark.skipif(not os.environ.get("RADAR_EXPLAIN_LIVE"),
                    reason="live model calls; set RADAR_EXPLAIN_LIVE=1 to exercise")
def test_live_the_real_path_over_real_corpus_findings(cases, tmp_path):
    """At least five real findings from real corpus periods through the
    production factories. Prints the MEASURED specificity distribution."""
    # An explicit dir keeps the journal after the run — pytest prunes its
    # basetemps, and the measured distribution is the point of this test.
    journal_dir = Path(os.environ.get("RADAR_EXPLAIN_LIVE_JOURNAL")
                       or os.environ.get(FS.JOURNAL_DIR_ENV)
                       or (tmp_path / "journal"))
    picked = list(cases["saga_10_col_carniprod"]["subjects"]) + \
        list(cases["saga_10_col_agras"]["subjects"])
    assert len(picked) >= 5
    decoy = cases["saga_10_col_realestate"]["result"].profile
    store = X.MemoryExplainStore()
    out = X.explain_rows(picked, store=store, decoy_profile=decoy,
                         journal_dir=journal_dir)
    for subject, expl in zip(picked, out):
        print(json.dumps({"finding_id": subject.finding_id,
                          "explanation": expl.to_payload()},
                         indent=2, ensure_ascii=False))
        if expl.present:
            assert X.served_numeral_violations(subject.finding, expl.en) == ()
            if expl.ro is not None:
                assert X.served_numeral_violations(subject.finding, expl.ro) == ()
        assert "{" not in expl.reason
    dist = FS.score_distribution(journal_dir)
    print("MEASURED SPECIFICITY DISTRIBUTION:")
    print(json.dumps(dist, indent=2, ensure_ascii=False))
    statuses = [e.status for e in out]
    print("STATUSES:", statuses)
    assert dist["count"] >= 5, "fewer than five reviewed drafts"
