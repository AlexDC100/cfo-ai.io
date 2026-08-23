"""Per-role spend circuit breaker battery — engine.ai.breaker.

Locked properties (operator spec + docs/decisions/ADR-ai-spend-breaker.md):
  · caps are CONFIG (models.yaml `breaker` per role, defaults merged);
  · the counter is a FILE under the data/ dir convention — no new
    datastore; day rollover resets it;
  · cap 0 == role fully closed (kill switch + the forced-trip tests);
  · a trip (or missing credits) yields the honest "advisory
    unavailable" degraded state — SERVING PROCEEDS REGARDLESS:
      - the reconcile-AI path degrades to MINOR_DRIFT + needs_review
        (its existing calm marker), exercised through the REAL
        auto_reconcile_envelope with the breaker guard applied at the
        seam the coordinator's one-line wiring will use;
      - the advisory pass attaches `ai_review_degraded` (ai_review
        absent) and everything else stays byte-identical.
  · the guarded client factory trips BEFORE any client is constructed.

All mocked; no network; every test uses a tmp state dir + a sentinel
registry so the real data/ dir and models.yaml are never touched.
"""
from __future__ import annotations

import copy
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest
import yaml

from engine.ai import breaker, registry
from engine.api import _reconcile
from engine.country_packs.ro_romania import trial_balance_parser as tbp

REPO = Path(__file__).resolve().parents[2]


# ── Sentinel registry (small caps; every required role present) ────────


def _registry_yaml(tmp_path: Path,
                   breaker_overrides: Optional[Dict[str, Dict[str, int]]] = None) -> Path:
    roles: Dict[str, Dict[str, Any]] = {}
    for role, max_tokens in (
        ("format_detect", 2000), ("extract", 16000), ("classify", 16000),
        ("reconcile_proposal", 1024), ("ai_validator", 4096), ("narrative", 4096),
    ):
        roles[role] = {
            "model_id": "mock-%s" % role,
            "prompt_version": "%s_pv" % role,
            "max_tokens": max_tokens,
            "temperature": 0,
        }
        override = (breaker_overrides or {}).get(role)
        if override is not None:
            roles[role]["breaker"] = override
    doc = {
        "schema": "ai_model_registry_v1",
        "defaults": {
            "temperature": 0,
            "breaker": {"max_calls_per_day": 5, "max_tokens_per_day": 1000},
        },
        "roles": roles,
    }
    path = tmp_path / "models_breaker.yaml"
    path.write_text(yaml.safe_dump(doc, sort_keys=True), encoding="utf-8")
    return path


@pytest.fixture()
def small_caps(tmp_path, monkeypatch):
    """Sentinel registry (defaults 5 calls / 1000 tokens per day) + a tmp
    state dir. Restores the real registry cache afterwards."""
    path = _registry_yaml(tmp_path)
    monkeypatch.setenv("ENGINE_AI_MODELS_PATH", str(path))
    registry.clear_cache()
    state_dir = tmp_path / "data" / "ai_spend"
    monkeypatch.setenv(breaker.STATE_DIR_ENV, str(state_dir))
    yield state_dir
    registry.clear_cache()


def _closed_role(tmp_path, monkeypatch, role: str) -> Path:
    """Sentinel registry with the given role's caps forced to 0 (fully
    closed) + tmp state dir."""
    path = _registry_yaml(
        tmp_path,
        breaker_overrides={role: {"max_calls_per_day": 0, "max_tokens_per_day": 0}},
    )
    monkeypatch.setenv("ENGINE_AI_MODELS_PATH", str(path))
    registry.clear_cache()
    state_dir = tmp_path / "data" / "ai_spend"
    monkeypatch.setenv(breaker.STATE_DIR_ENV, str(state_dir))
    return state_dir


@pytest.fixture(autouse=True)
def _restore_registry_cache():
    yield
    registry.clear_cache()


# ── Counter mechanics ──────────────────────────────────────────────────


def test_caps_come_from_registry(small_caps):
    limits = registry.breaker_limits_for("ai_validator")
    assert limits == {"max_calls_per_day": 5, "max_tokens_per_day": 1000}


def test_check_allows_under_cap_then_trips_at_call_cap(small_caps):
    for _ in range(5):
        breaker.check("ai_validator")
        breaker.record("ai_validator", tokens=10)
    with pytest.raises(breaker.BreakerOpen) as exc:
        breaker.check("ai_validator")
    assert exc.value.role == "ai_validator"
    assert "max_calls_per_day" in exc.value.reason


def test_token_cap_trips(small_caps):
    breaker.check("extract")
    breaker.record("extract", tokens=1000)
    with pytest.raises(breaker.BreakerOpen) as exc:
        breaker.check("extract")
    assert "max_tokens_per_day" in exc.value.reason


def test_cap_zero_role_fully_closed(tmp_path, monkeypatch):
    _closed_role(tmp_path, monkeypatch, "ai_validator")
    with pytest.raises(breaker.BreakerOpen):
        breaker.check("ai_validator")


def test_roles_are_isolated(small_caps):
    for _ in range(5):
        breaker.record("classify", tokens=1)
    with pytest.raises(breaker.BreakerOpen):
        breaker.check("classify")
    breaker.check("extract")  # untouched role still open


def test_day_rollover_resets(small_caps):
    state_dir = small_caps
    for _ in range(5):
        breaker.record("ai_validator", tokens=1)
    with pytest.raises(breaker.BreakerOpen):
        breaker.check("ai_validator")
    # Rewrite the state file with yesterday's day key — the next check
    # resets the counters instead of honoring stale spend.
    state_file = state_dir / breaker.STATE_FILENAME
    state = json.loads(state_file.read_text(encoding="utf-8"))
    state["day"] = "2000-01-01"
    state_file.write_text(json.dumps(state), encoding="utf-8")
    breaker.check("ai_validator")


def test_state_file_lives_under_data_dir_convention(small_caps):
    state_dir = small_caps
    breaker.record("narrative", tokens=7)
    state_file = state_dir / breaker.STATE_FILENAME
    assert state_file.is_file()
    state = json.loads(state_file.read_text(encoding="utf-8"))
    assert state["roles"]["narrative"] == {"calls": 1, "tokens": 7}
    assert isinstance(state["day"], str) and len(state["day"]) == 10


def test_corrupt_state_file_resets_not_raises(small_caps):
    state_dir = small_caps
    state_dir.mkdir(parents=True, exist_ok=True)
    (state_dir / breaker.STATE_FILENAME).write_text("{not json", encoding="utf-8")
    breaker.check("ai_validator")
    breaker.record("ai_validator", tokens=1)
    state = json.loads(
        (state_dir / breaker.STATE_FILENAME).read_text(encoding="utf-8")
    )
    assert state["roles"]["ai_validator"]["calls"] == 1


def test_degraded_marker_shape(small_caps):
    marker = breaker.degraded_marker("ai_validator", "breaker_open")
    assert marker["available"] is False
    assert marker["role"] == "ai_validator"
    assert marker["reason"] == "breaker_open"
    assert marker["marker"] == "ai_advisory_unavailable"


def test_guarded_factory_trips_before_constructing_client(tmp_path, monkeypatch):
    _closed_role(tmp_path, monkeypatch, "ai_validator")
    constructed: List[int] = []

    def base_factory() -> Any:
        constructed.append(1)
        return object()

    factory = breaker.guarded_client_factory("ai_validator", base_factory=base_factory)
    with pytest.raises(breaker.BreakerOpen):
        factory()
    assert constructed == []


def test_guarded_factory_constructs_when_open(small_caps):
    token = object()
    factory = breaker.guarded_client_factory("ai_validator", base_factory=lambda: token)
    assert factory() is token


# ── Breaker trip: serving stays green (the operator-spec test) ─────────


def _row(code: str, **fields: float) -> Dict[str, float]:
    row = {"cont": code, "nume_cont": "Cont %s" % code,
           "si_d": 0.0, "si_c": 0.0, "r_d": 0.0, "r_c": 0.0,
           "st_d": 0.0, "st_c": 0.0, "sf_d": 0.0, "sf_c": 0.0}
    row.update(fields)
    return row


def _envelope_for(pack, rows: List[Dict]) -> Dict:
    tb = tbp.TrialBalanceParseResult(
        rows,
        extraction={
            "method": "deterministic",
            "parser_version": tbp.PARSER_VERSION,
            "source_format": "saga_10_col",
            "number_locale": "anglo",
            "sheet": "TB_breaker",
            "header_row_index": 0,
        },
        source_anchor=tbp.compute_source_anchor(
            rows, file_totals=None, pairs_present=None, totals_row_index=None,
        ),
    )
    pack.attach_closing_result(tb)
    _tb, _shaped, assembled = pack.assemble_parsed_tb(
        tb, company_name="Breaker TB", period_label="BRK",
    )
    envelope = assembled["assembled_canonical_v1"]
    envelope["provenance"] = {
        "source_document_id": "doc-brk",
        "original_filename": "balanta_breaker.xlsx",
        "content_hash": "sha256-breaker-A",
        "written_at": "2026-08-23T00:00:00+00:00",
    }
    return envelope


@pytest.fixture()
def inconclusive_env(pack):
    """Drift inside the 0.1% gate with NO single deterministic cause —
    forces the AI-proposal path (same shape as test_reconciliation's)."""
    return _envelope_for(pack, [
        _row("5121", sf_d=1_000_000.00),
        _row("413", sf_d=300.00),
        _row("4282", sf_d=200.00),
        _row("1012", sf_c=999_722.23),
    ])


def test_breaker_trip_reconcile_path_serving_stays_green(
        tmp_path, monkeypatch, inconclusive_env):
    """Cap forced to 0 for reconcile_proposal; the breaker guard applied
    at the _ai_propose seam (EXACTLY the one-line wiring the coordinator
    will add — engine.ai.breaker.check before the client is built). The
    REAL auto stage degrades to its calm needs_review marker; the served
    object stays an honest MINOR_DRIFT; serving never breaks."""
    _closed_role(tmp_path, monkeypatch, "reconcile_proposal")
    monkeypatch.setitem(sys.modules, "anthropic", None)  # live SDK sentinel

    real_propose = _reconcile._ai_propose

    def guarded_propose(cbs: Dict[str, Any]) -> Dict[str, Any]:
        breaker.check("reconcile_proposal")  # trips -> honest inconclusive
        return real_propose(cbs)

    monkeypatch.setattr(_reconcile, "_ai_propose", guarded_propose)

    before = json.dumps(inconclusive_env["canonical_bs"], sort_keys=True)
    out = _reconcile.auto_reconcile_envelope(inconclusive_env)
    assert out["outcome"] == "needs_review"
    assert "reconciliation" not in inconclusive_env
    # Source truth byte-identical; serving green with the degraded marker.
    assert json.dumps(inconclusive_env["canonical_bs"], sort_keys=True) == before
    served = _reconcile.served_canonical_bs(inconclusive_env)
    assert served["status"] == "MINOR_DRIFT"
    assert served["needs_review"] is True


def test_breaker_trip_advisory_pass_serving_stays_green(
        tmp_path, monkeypatch, inconclusive_env):
    """Cap forced to 0 for ai_validator; the advisory hook attaches the
    degraded marker (ai_review ABSENT), everything else byte-identical,
    and the serve path is untouched."""
    from engine.ai import advisory

    _closed_role(tmp_path, monkeypatch, "ai_validator")
    env = copy.deepcopy(inconclusive_env)
    served_before = json.dumps(
        _reconcile.served_canonical_bs(copy.deepcopy(env)), sort_keys=True
    )
    cbs_before = json.dumps(env["canonical_bs"], sort_keys=True)

    advisory.pipeline_hook(env, enabled=True)

    assert "ai_review" not in env
    degraded = env["ai_review_degraded"]
    assert degraded["available"] is False
    assert degraded["reason"] == "breaker_open"
    assert degraded["marker"] == "ai_advisory_unavailable"
    assert json.dumps(env["canonical_bs"], sort_keys=True) == cbs_before
    served_after = json.dumps(
        _reconcile.served_canonical_bs(env), sort_keys=True
    )
    assert served_after == served_before
