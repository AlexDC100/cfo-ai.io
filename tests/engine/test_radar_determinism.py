"""R4 — DETERMINISM. Same snapshot, same bytes: rows, ids, order,
severities, cap decisions — ten runs, AI mocked on and off, the SDK
importable or blocked, the history handed over in any order.

A findings surface that moves between two opens with nothing changed
teaches the reader to distrust it; one that moves because a model was
reachable teaches them the model decides. Neither is allowed. The
deterministic payload is complete without the explanation lane, and the
explanation lane — the REAL one, `engine.radar.explain`, through the
REAL seam a route uses — can add prose and nothing else, so the payload
with prose attached STRIPS BACK to the deterministic bytes.

Subjects are the committed captures (real engine output, TC-1), and the
committed `radar` golden inside each capture is what a run today must
reproduce byte for byte.

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

import copy
import importlib
import json
import sys
from pathlib import Path

import pytest

from engine.ai import breaker
from engine.ai import finding_sharpen as FS
from engine.api import _finding_rank as R
from engine.radar import explain as X
from engine.radar import serve as RS
from tests.engine.test_radar_explain import HIGH_REVIEW, GOOD_DRAFT, StubClient, _factory

REPO = Path(__file__).resolve().parents[2]
FIXTURES = REPO / "tests" / "engine" / "fixtures" / "radar"

CASES = (
    "saga_10_col_carniprod",
    "saga_10_col_agras",
    "saga_10_col_retail",
    "saga_10_col_realestate",
    "saga_10_col",
    "imbalance_03pct",
)

RUNS = 10


def fixture(case):
    with open(str(FIXTURES / (case + ".json")), encoding="utf-8") as fh:
        return json.load(fh)


def target_of(case, fx, ordinal=0, period_id=None):
    """The target as the route hands it over: the content hash as the
    snapshot id, the source document under its own name."""
    hash_ = fx["envelope"]["provenance"]["content_hash"]
    return RS.PeriodInput(
        period_id=period_id or "p-%s" % case, label="FY%s" % fx["period_end"][:4],
        period_end=fx["period_end"], period_start=fx["period_start"],
        ordinal=ordinal, currency=fx["currency"], statements=fx["statements"],
        envelope=fx["envelope"], snapshot_id=hash_, source_document_id="doc-%s" % case,
        content_key=hash_, caen=None)


@pytest.fixture(autouse=True)
def _isolated_ai_state(tmp_path, monkeypatch):
    """Never touch the real breaker counters, the real AI journal or the
    real explanation cache."""
    monkeypatch.setenv(breaker.STATE_DIR_ENV, str(tmp_path / "spend"))
    monkeypatch.setenv(FS.JOURNAL_DIR_ENV, str(tmp_path / "journal"))
    monkeypatch.setenv(X.CACHE_DIR_ENV, str(tmp_path / "explain_cache"))
    monkeypatch.delenv(FS.SPECIFICITY_FLOOR_ENV, raising=False)
    yield


def request_for(case, fx=None, **kwargs):
    fx = fx or fixture(case)
    return RS.RadarRequest(org_id="org-%s" % case, target=target_of(case, fx), **kwargs)


def shape(payload):
    """The parts a reader's attention depends on: ids, order, severity,
    rank, disposition, cap decision."""
    return {
        "surfaced": [(r["id"], r["rank"], r["severity"], r["effective_severity"],
                      r["disposition"], r["dismissed"], r["group_severity"])
                     for r in payload["surfaced"]],
        "info": [r["id"] for r in payload["info"]],
        "demoted": [(r["id"], r["demotion_reason"]) for r in payload["demoted"]],
        "cap": payload["cap_policy"],
        "counts": payload["counts"],
    }


class _BlockAI(object):
    """Import hook: any AI SDK import raises. The engine must not need one."""

    BLOCKED = ("anthropic", "openai")

    def find_spec(self, name, path=None, target=None):
        if name.split(".")[0] in self.BLOCKED:
            raise ImportError("blocked by the R4 gate: %s" % name)
        return None


# ══ R4 ═══════════════════════════════════════════════════════════════════


@pytest.mark.parametrize("case", CASES)
def test_r4_ten_runs_are_byte_identical_and_match_the_committed_golden(case):
    fx = fixture(case)
    req = request_for(case, fx)
    runs = set(RS.canonical_bytes(RS.serve_period(req)) for _ in range(RUNS))
    assert len(runs) == 1, "R4 DETERMINISM VIOLATED — %d distinct payloads in %d runs" % (
        len(runs), RUNS)
    golden = RS.canonical_bytes(fx["radar"])
    assert runs.pop() == golden, (
        "R4 DETERMINISM VIOLATED — today's payload differs from the committed capture "
        "for %s (re-run tests/engine/fixtures/radar/capture.py --check)" % case)


@pytest.mark.parametrize("case", CASES)
def test_r4_identical_with_ai_reachable_and_with_ai_blocked(case, monkeypatch):
    """A credential PRESENT must change nothing; the SDK ABSENT must
    change nothing. Both directions, same bytes."""
    req = request_for(case)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    baseline = RS.canonical_bytes(RS.serve_period(req))

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test-not-a-real-key")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-not-a-real-key")
    monkeypatch.setenv("AI_ADVISORY_ENABLED", "1")
    assert RS.canonical_bytes(RS.serve_period(req)) == baseline, "a credential moved the rows"

    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    hook = _BlockAI()
    sys.meta_path.insert(0, hook)
    try:
        for module in [m for m in list(sys.modules) if m.split(".")[0] in _BlockAI.BLOCKED]:
            sys.modules.pop(module, None)
        with pytest.raises(ImportError):
            importlib.import_module("anthropic")
        assert RS.canonical_bytes(RS.serve_period(req)) == baseline, "the lane needs an AI SDK"
    finally:
        sys.meta_path.remove(hook)


def _explained(served, org_id="org-x"):
    """The route's own composition: subjects projected from the served
    rows, drafted through the REAL lane by a stub model, attached
    through the REAL seam. Returns (explained payload, explanations)."""
    subjects = X.subjects_from_ranked(
        type("V", (), {"surfaced": served.surfaced})(), served.profile, org_id,
        served.payload["period_id"], served.snapshot_hash, gateway=served.gateway)
    store = X.MemoryExplainStore()
    explanations = X.explain_rows(
        subjects, store=store, client_factory=_factory(StubClient(draft=GOOD_DRAFT)),
        reviewer_factory=_factory(StubClient(review=HIGH_REVIEW)))
    on = copy.deepcopy(served.payload)
    on["surfaced"] = X.attach(on["surfaced"], explanations, subjects)
    on[RS.EXPLANATIONS_KEY] = {"attached": len(explanations)}
    return on, explanations, subjects, store


def test_r4_the_real_explain_lane_attaches_prose_only_and_strips_back_to_the_same_bytes():
    """AI ON is the real lane over a stub model that answers every row.
    The explained payload has the same ids, order, severities, group
    severities and cap decision, every surfaced row carries the lane's
    own `Explanation.to_payload()` shape, and stripping the prose yields
    the deterministic bytes. The mock shape the old serve-side seam
    accepted (`why_here_prose`) no longer exists anywhere."""
    case = "saga_10_col_agras"
    req = request_for(case)
    served = RS.compose(req)
    off = served.payload
    on, explanations, subjects, store = _explained(served)
    assert explanations and all(e.status == X.STATUS_FRESH for e in explanations), [
        (e.status, e.kind, e.reason) for e in explanations]
    assert all("explanation" in r for r in on["surfaced"])
    for row in on["surfaced"]:
        expl = row["explanation"]
        assert set(expl) == set(X.Explanation(
            finding_id="", key="", status="", kind="", reason="", prompt_version="",
            row_fingerprint="").to_payload())
        assert expl["status"] == X.STATUS_FRESH and expl["en"]["rationale"].strip()
        X.assert_explanation_is_prose_only(expl)
    assert shape(on) == shape(off)
    assert RS.canonical_bytes(RS.strip_explanations(on)) == RS.canonical_bytes(off)
    # ten explained runs are as stable as ten plain ones: the cache
    # answers the same bytes every time.
    runs = set()
    for _ in range(RUNS):
        again = copy.deepcopy(RS.compose(req).payload)
        again["surfaced"] = X.attach(
            again["surfaced"], X.attach_cached(subjects, store=store), subjects)
        runs.add(RS.canonical_bytes(again))
    assert len(runs) == 1
    assert all(r["explanation"]["status"] == X.STATUS_CACHED
               for r in json.loads(runs.pop())["surfaced"])


def test_r4_the_one_explanation_seam_refuses_ranking_vocabulary():
    """`explain.attach` is the ONE writer of `row["explanation"]`, and it
    refuses a payload that grew a ranking key at any depth."""
    case = "saga_10_col_agras"
    served = RS.compose(request_for(case))
    on, explanations, subjects, _store = _explained(served)
    hostile = X.Explanation(**dict(
        (f, getattr(explanations[0], f)) for f in explanations[0].__dataclass_fields__))
    poisoned = hostile.to_payload()
    poisoned["severity"] = "info"
    with pytest.raises(X.ExplanationOverreach):
        X.assert_explanation_is_prose_only(poisoned)
    assert X.RANKING_VOCABULARY & set(X.explanation_field_names()) == set()
    # A refused attachment leaves the deterministic payload untouched.
    assert "explanation" not in served.payload["surfaced"][0]


def test_r4_ordering_is_total_history_and_dismissal_order_do_not_matter():
    case = "saga_10_col_agras"
    fx = fixture(case)
    target = target_of(case, fx, ordinal=3)
    prior = [target_of(case, fx, ordinal=i, period_id="p-%d" % i) for i in range(3)]
    dismissals = (
        R.Dismissal(rule_id="fx_exposure", scope_key=R.SCOPE_ANY, reason="a",
                    dismissed_by="u", dismissed_at="2026-01-01T00:00:00+00:00"),
        R.Dismissal(rule_id="input_cost_exposure", scope_key=R.SCOPE_ANY, reason="b",
                    dismissed_by="u", dismissed_at="2026-02-01T00:00:00+00:00"),
    )
    forward = RS.RadarRequest(org_id="org-x", target=target, history=tuple(prior),
                              dismissals=dismissals)
    backward = RS.RadarRequest(org_id="org-x", target=target,
                               history=tuple(reversed(prior)),
                               dismissals=tuple(reversed(dismissals)))
    a = RS.canonical_bytes(RS.serve_period(forward))
    b = RS.canonical_bytes(RS.serve_period(backward))
    assert a == b, "R4 — input order changed the bytes"
    assert RS.cache_key(forward) == RS.cache_key(backward)
    payload = RS.serve_period(forward)
    assert payload["lanes"][RS.LANE_MULTI]["ran"] is True
    assert payload["history"]["periods_with_statements"] == 4
    assert all(r["persistence"] == 4 for r in payload["surfaced"]
               if r["lane"] == RS.LANE_SINGLE), "persistence did not walk the spine"


def test_r4_plant_one_moved_input_changes_the_output():
    """PLANT R4. Perturb a single balance and the bytes must move. A
    determinism gate that cannot see a real change is measuring nothing."""
    case = "saga_10_col_agras"
    fx = fixture(case)
    baseline = RS.canonical_bytes(RS.serve_period(request_for(case, fx)))
    moved = copy.deepcopy(fx)
    bs = moved["statements"]["assembled_bs"]
    bs["cash"] = float(bs["cash"]) * 4 + 1000000.0
    assert RS.canonical_bytes(RS.serve_period(request_for(case, moved))) != baseline


def test_r4_the_cache_key_is_a_function_of_inputs_alone():
    case = "saga_10_col_agras"
    fx = fixture(case)
    keys = set(RS.cache_key(request_for(case, fx)) for _ in range(RUNS))
    assert len(keys) == 1
    assert len(keys.pop()) == 64
