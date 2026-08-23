"""Model-registry battery — src/engine/ai (models.yaml as config).

RED-FIRST wiring proofs (operator spec, AI decision engine): the
registry supplies the EXACT values the current call sites are pinned to
(the corpus goldens byte-freeze `extraction.model` /
`classification.model` = "claude-opus-4-7" and the per-stage prompt
versions, so the registry cutover MUST be value-identical), and the
existing call sites genuinely CONSUME the registry rather than local
literals:

  · engine.ai_lane.config — MODEL_ID + the three *_PROMPT_VERSION and
    *_MAX_TOKENS constants become registry reads (proven by fresh-
    loading the module against a sentinel models.yaml);
  · engine.ai_lane._client.call_strict_json — per-stage model
    resolution through the registry (proven with a sentinel registry +
    a fake client capturing kwargs), audit entries additively gain
    {role, model_id};
  · engine.api._reconcile — AI_MODEL / PROMPT_VERSION become registry
    reads with identical values (fresh-load proof again).

The pack-hash-derived classify prompt version (classify_<jur>@<hash>)
COMPOSES ON TOP of the registry's base version and stays exactly as it
was — locked here via the golden-frozen prompt_versions() map.

No network anywhere in this file. The probe script tests never see a
real key (KEY_MISSING path) or run against an injected fake `anthropic`
module (CREDITS_OK / CREDITS_ABSENT paths).
"""
from __future__ import annotations

import copy
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any, Dict, List, Optional

import pytest

REPO = Path(__file__).resolve().parents[2]
SRC = REPO / "src"

from engine.ai import registry  # noqa: E402

# ── The frozen value table (mirrors corpus goldens + current constants) ─

CURRENT_FLAGSHIP_LANE_MODEL = "claude-opus-4-7"
NEW_ADVISORY_MODEL = "claude-fable-5"

EXPECTED_VALUES = {
    "format_detect": {"model_id": CURRENT_FLAGSHIP_LANE_MODEL,
                      "prompt_version": "format_detect_v1", "max_tokens": 2000},
    "extract": {"model_id": CURRENT_FLAGSHIP_LANE_MODEL,
                "prompt_version": "extract_v1", "max_tokens": 16000},
    "classify": {"model_id": CURRENT_FLAGSHIP_LANE_MODEL,
                 "prompt_version": "classify_v1", "max_tokens": 16000},
    "reconcile_proposal": {"model_id": CURRENT_FLAGSHIP_LANE_MODEL,
                           "prompt_version": "reconcile_v1", "max_tokens": 1024},
    "ai_validator": {"model_id": NEW_ADVISORY_MODEL,
                     "prompt_version": "ai_validator_v1", "max_tokens": 4096},
    "narrative": {"model_id": CURRENT_FLAGSHIP_LANE_MODEL,
                  "prompt_version": "narrative_v1", "max_tokens": 4096},
}


def _sentinel_yaml(tmp_path: Path, overrides: Optional[Dict[str, Dict[str, Any]]] = None) -> Path:
    """A fully valid registry file whose model ids are sentinels, so a
    consumption test can prove a call site reads the REGISTRY and not a
    local literal."""
    roles: Dict[str, Dict[str, Any]] = {}
    for role, params in EXPECTED_VALUES.items():
        roles[role] = {
            "model_id": "sentinel-%s-model" % role.replace("_", "-"),
            "prompt_version": "sentinel_%s_pv" % role,
            "max_tokens": params["max_tokens"],
            "temperature": 0,
        }
    for role, extra in (overrides or {}).items():
        roles.setdefault(role, {}).update(extra)
    doc = {
        "schema": "ai_model_registry_v1",
        "defaults": {
            "temperature": 0,
            "breaker": {"max_calls_per_day": 200, "max_tokens_per_day": 2000000},
        },
        "roles": roles,
    }
    import yaml

    path = tmp_path / "models_sentinel.yaml"
    path.write_text(yaml.safe_dump(doc, sort_keys=True), encoding="utf-8")
    return path


@pytest.fixture()
def sentinel_registry(tmp_path, monkeypatch):
    """Point the registry at a sentinel models.yaml for the duration of
    a test; always restores the real cache afterwards."""
    path = _sentinel_yaml(tmp_path)
    monkeypatch.setenv("ENGINE_AI_MODELS_PATH", str(path))
    registry.clear_cache()
    yield path
    registry.clear_cache()


@pytest.fixture(autouse=True)
def _always_restore_registry_cache():
    yield
    registry.clear_cache()


def _fresh_load(module_file: Path, name: str) -> Any:
    """Execute a SECOND instance of an existing module under a test-only
    dotted name (the parent package resolves relative imports), so the
    globally imported instance is never disturbed."""
    spec = importlib.util.spec_from_file_location(name, str(module_file))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.modules.pop(name, None)
    return mod


# ── Registry basics ────────────────────────────────────────────────────


def test_registry_loads_all_six_roles_schema_validated():
    reg = registry.load_registry()
    for role in ("format_detect", "extract", "classify",
                 "reconcile_proposal", "ai_validator", "narrative"):
        params = reg[role]
        assert isinstance(params["model_id"], str) and params["model_id"]
        assert isinstance(params["prompt_version"], str) and params["prompt_version"]
        assert isinstance(params["max_tokens"], int) and params["max_tokens"] > 0
        assert params["temperature"] == 0
        breaker = params["breaker"]
        assert isinstance(breaker["max_calls_per_day"], int)
        assert isinstance(breaker["max_tokens_per_day"], int)
        assert breaker["max_calls_per_day"] >= 0
        assert breaker["max_tokens_per_day"] >= 0


def test_registry_supplies_exact_current_values():
    """THE value-freeze: the wired call sites must keep emitting the
    byte-identical strings the corpus goldens carry."""
    for role, expected in EXPECTED_VALUES.items():
        assert registry.model_for(role) == expected["model_id"], role
        params = registry.params_for(role)
        assert params["prompt_version"] == expected["prompt_version"], role
        assert params["max_tokens"] == expected["max_tokens"], role
        assert params["temperature"] == 0, role


def test_registry_unknown_role_fails_loud():
    with pytest.raises(registry.RegistryError):
        registry.model_for("no_such_role")


def test_registry_params_are_copies_not_aliases():
    a = registry.params_for("extract")
    a["model_id"] = "mutated"
    a["breaker"]["max_calls_per_day"] = -99
    b = registry.params_for("extract")
    assert b["model_id"] == CURRENT_FLAGSHIP_LANE_MODEL
    assert b["breaker"]["max_calls_per_day"] >= 0


def test_registry_missing_role_in_file_fails_loud(tmp_path, monkeypatch):
    import yaml

    doc = {
        "schema": "ai_model_registry_v1",
        "roles": {
            "extract": {"model_id": "m", "prompt_version": "p",
                        "max_tokens": 10, "temperature": 0},
        },
    }
    path = tmp_path / "broken.yaml"
    path.write_text(yaml.safe_dump(doc), encoding="utf-8")
    monkeypatch.setenv("ENGINE_AI_MODELS_PATH", str(path))
    registry.clear_cache()
    with pytest.raises(registry.RegistryError):
        registry.load_registry()


def test_registry_nonzero_temperature_fails_loud(tmp_path, monkeypatch):
    path = _sentinel_yaml(tmp_path, overrides={"extract": {"temperature": 0.7}})
    monkeypatch.setenv("ENGINE_AI_MODELS_PATH", str(path))
    registry.clear_cache()
    with pytest.raises(registry.RegistryError):
        registry.load_registry()


def test_registry_env_override_and_cache_clear(sentinel_registry):
    assert registry.model_for("extract") == "sentinel-extract-model"
    assert registry.params_for("reconcile_proposal")["prompt_version"] == (
        "sentinel_reconcile_proposal_pv"
    )


# ── Wiring proof: engine.ai_lane.config consumes the registry ──────────


def test_ai_lane_config_values_come_from_registry():
    from engine.ai_lane import config as lane_config

    assert lane_config.MODEL_ID == registry.model_for("extract")
    assert lane_config.MODEL_ID == CURRENT_FLAGSHIP_LANE_MODEL
    assert lane_config.FORMAT_DETECT_PROMPT_VERSION == (
        registry.params_for("format_detect")["prompt_version"]
    )
    assert lane_config.EXTRACT_PROMPT_VERSION == (
        registry.params_for("extract")["prompt_version"]
    )
    assert lane_config.CLASSIFY_PROMPT_VERSION == (
        registry.params_for("classify")["prompt_version"]
    )
    assert lane_config.FORMAT_DETECT_MAX_TOKENS == (
        registry.params_for("format_detect")["max_tokens"]
    )
    assert lane_config.EXTRACT_MAX_TOKENS == (
        registry.params_for("extract")["max_tokens"]
    )
    assert lane_config.CLASSIFY_MAX_TOKENS == (
        registry.params_for("classify")["max_tokens"]
    )


def test_ai_lane_config_consumes_registry_not_literals(sentinel_registry):
    """Fresh-load config.py against the sentinel registry: the constants
    must follow the registry, proving they are reads, not literals."""
    mod = _fresh_load(
        SRC / "engine" / "ai_lane" / "config.py",
        "engine.ai_lane.config_regtest",
    )
    assert mod.MODEL_ID == "sentinel-extract-model"
    assert mod.FORMAT_DETECT_PROMPT_VERSION == "sentinel_format_detect_pv"
    assert mod.EXTRACT_PROMPT_VERSION == "sentinel_extract_pv"
    assert mod.CLASSIFY_PROMPT_VERSION == "sentinel_classify_pv"


def test_prompt_versions_map_stays_golden_frozen():
    """The cache-key map recorded on every ai_audit — byte-frozen by the
    hu_ai_lane corpus golden. The classify entry derives from the pack
    content hash ON TOP of the registry base version; the exact v1 pack
    contents alias to the frozen 'classify_v1'."""
    from engine.ai_lane import config as lane_config

    assert lane_config.prompt_versions("HU") == {
        "parser_version": "ai_lane_v1",
        "format_detect": "format_detect_v1",
        "extract": "extract_v1",
        "classify": "classify_v1",
    }


# ── Wiring proof: _client resolves the per-stage model via registry ────


class _FakeMessages:
    def __init__(self, responses: List[str]):
        self._responses = list(responses)
        self.calls: List[Dict[str, Any]] = []

    def create(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        text = self._responses.pop(0)
        return SimpleNamespace(content=[SimpleNamespace(type="text", text=text)])


class _FakeClient:
    def __init__(self, responses: List[str]):
        self.messages = _FakeMessages(responses)


def test_client_resolves_model_per_stage_from_registry(sentinel_registry):
    from engine.ai_lane._client import call_strict_json

    client = _FakeClient(['{"ok": true}'])
    audit: List[Dict[str, Any]] = []
    data = call_strict_json(
        client,
        stage="format_detect",
        prompt_version="format_detect_v1",
        system="s",
        user_text="u",
        max_tokens=100,
        audit_stages=audit,
    )
    assert data == {"ok": True}
    assert client.messages.calls[0]["model"] == "sentinel-format-detect-model"
    # Audit entries additively persist {role, model_id, prompt_version}.
    assert audit[0]["role"] == "format_detect"
    assert audit[0]["model_id"] == "sentinel-format-detect-model"
    assert audit[0]["model"] == "sentinel-format-detect-model"
    assert audit[0]["prompt_version"] == "format_detect_v1"


def test_client_default_registry_keeps_current_model_for_all_lane_stages():
    """With the REAL registry, every lane stage still calls the ONE
    current model — the locked test_ai_lane invariant + corpus goldens
    stay byte-identical."""
    from engine.ai_lane import config as lane_config
    from engine.ai_lane._client import call_strict_json

    for stage in ("format_detect", "extract", "classify"):
        client = _FakeClient(['{"ok": true}'])
        call_strict_json(
            client, stage=stage, prompt_version="v", system="s",
            user_text="u", max_tokens=10,
        )
        assert client.messages.calls[0]["model"] == lane_config.MODEL_ID


# ── Wiring proof: _reconcile constants consume the registry ────────────


def test_reconcile_constants_come_from_registry():
    from engine.api import _reconcile

    assert _reconcile.AI_MODEL == registry.model_for("reconcile_proposal")
    assert _reconcile.AI_MODEL == CURRENT_FLAGSHIP_LANE_MODEL
    assert _reconcile.PROMPT_VERSION == (
        registry.params_for("reconcile_proposal")["prompt_version"]
    )
    assert _reconcile.PROMPT_VERSION == "reconcile_v1"


def test_reconcile_constants_consume_registry_not_literals(sentinel_registry):
    mod = _fresh_load(
        SRC / "engine" / "api" / "_reconcile.py",
        "engine.api._reconcile_regtest",
    )
    assert mod.AI_MODEL == "sentinel-reconcile-proposal-model"
    assert mod.PROMPT_VERSION == "sentinel_reconcile_proposal_pv"


# ── Deploy probe script (scripts/check_anthropic_probe.py) ─────────────

PROBE = REPO / "scripts" / "check_anthropic_probe.py"


def _load_probe() -> Any:
    return _fresh_load(PROBE, "check_anthropic_probe_regtest")


def test_probe_key_missing_exits_zero_and_reports():
    env = dict(os.environ)
    env.pop("ANTHROPIC_API_KEY", None)
    proc = subprocess.run(
        [sys.executable, str(PROBE)],
        capture_output=True, text=True, env=env, cwd=str(REPO),
    )
    assert proc.returncode == 0, proc.stderr
    assert "KEY_MISSING" in proc.stdout


def test_probe_credits_absent_is_a_loud_notice_not_a_gate(monkeypatch):
    """A key that authenticates but has no credits → CREDITS_ABSENT,
    exit 0, and the baseline run does NOT activate."""
    probe = _load_probe()

    class _Err(Exception):
        pass

    class _Messages:
        def create(self, **kwargs: Any) -> Any:
            raise _Err("Your credit balance is too low to access the API")

    class _Anthropic:
        def __init__(self, **kwargs: Any) -> None:
            self.messages = _Messages()

    fake = ModuleType("anthropic")
    fake.Anthropic = _Anthropic
    monkeypatch.setitem(sys.modules, "anthropic", fake)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-fake")
    activations: List[str] = []
    monkeypatch.setattr(probe, "_activate_baseline", lambda: activations.append("ran"))
    code = probe.main([])
    assert code == 0
    assert probe.LAST_VERDICT == "CREDITS_ABSENT"
    assert activations == []


def test_probe_credits_ok_self_activates_baseline_once(monkeypatch, tmp_path):
    probe = _load_probe()

    class _Messages:
        def create(self, **kwargs: Any) -> Any:
            return SimpleNamespace(
                content=[SimpleNamespace(type="text", text="ok")],
            )

    class _Anthropic:
        def __init__(self, **kwargs: Any) -> None:
            self.messages = _Messages()

    fake = ModuleType("anthropic")
    fake.Anthropic = _Anthropic
    monkeypatch.setitem(sys.modules, "anthropic", fake)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-fake")
    activations: List[str] = []
    monkeypatch.setattr(probe, "_activate_baseline", lambda: activations.append("ran"))
    # Baseline absent → self-activation fires.
    monkeypatch.setattr(probe, "_baseline_path", lambda: tmp_path / "baseline.json")
    code = probe.main([])
    assert code == 0
    assert probe.LAST_VERDICT == "CREDITS_OK"
    assert activations == ["ran"]
    # Baseline present → no second activation.
    (tmp_path / "baseline.json").write_text("{}", encoding="utf-8")
    activations[:] = []
    code = probe.main([])
    assert code == 0
    assert activations == []
