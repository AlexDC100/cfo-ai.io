"""AI structural interpreter battery — engine.interp (Part A).

Locked properties:
  · E1: a StructuralMap carries coordinates/indices/enums/strings ONLY —
    the validator rejects value-bearing numerics at EVERY nesting level
    (fuzz), floats everywhere, and unknown keys anywhere.
  · E2: the cache is deterministic — same key ⇒ byte-identical map JSON,
    and a hit makes ZERO client calls.
  · Two framings = two registry roles with DIFFERENT prompts.
  · Registry guard: an unconfigured role fails LOUD before any model
    call (no silent fallback to the lane default model).
  · Breaker wiring: guarded_client_factory pattern; BreakerOpen degrades
    to the typed InterpUnavailable before any client is constructed.
  · Real-file smoke: prompts built from the two real workbooks, with
    SCRIPTED clients returning the hand-verified fixture maps
    (tests/engine/fixtures/structmaps/ — see its README).

All model interaction is scripted; no network, no anthropic import.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List

import pytest
import yaml

from engine.ai import breaker, registry
from engine.interp import (
    FileCacheStore,
    InterpError,
    InterpUnavailable,
    MemoryCacheStore,
    StructMapError,
    StructuralMap,
    cache_key,
    interpret_with_cache,
    run_structural_interpretation,
)

REPO = Path(__file__).resolve().parents[2]
FIXDIR = REPO / "tests" / "engine" / "fixtures" / "structmaps"
SIBIU_XLSX = REPO / "files" / "scandia_sibiu_tb_2019.xlsx"
AGRAS_XLSX = REPO / "files" / "agras_tb_2025.xlsx"

SIBIU_MAP = json.loads((FIXDIR / "scandia_sibiu_tb_2019.json").read_text("utf-8"))
AGRAS_MAP = json.loads((FIXDIR / "agras_tb_2025.json").read_text("utf-8"))

TINY_CSV = b"code,name,debit,credit\n101,Capital,0,2500\n"


# ── Scripted Anthropic client (the ai_lane test idiom) ─────────────────


class _FakeMessages:
    def __init__(self, responses: List[Any]):
        self._responses = list(responses)
        self.calls: List[Dict[str, Any]] = []

    def create(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        if not self._responses:
            raise AssertionError("fake client ran out of scripted responses")
        r = self._responses.pop(0)
        if isinstance(r, Exception):
            raise r
        return SimpleNamespace(content=[SimpleNamespace(type="text", text=r)])


class _FakeClient:
    def __init__(self, responses: List[Any]):
        self.messages = _FakeMessages(responses)


# ── Sentinel registry ──────────────────────────────────────────────────


def _sentinel_registry(tmp_path: Path, *, include_interp: bool = True,
                       interp_breaker: Any = None) -> Path:
    roles: Dict[str, Dict[str, Any]] = {}
    for role, mt in (
        ("format_detect", 2000), ("extract", 16000), ("classify", 16000),
        ("reconcile_proposal", 1024), ("ai_validator", 4096), ("narrative", 4096),
    ):
        roles[role] = {"model_id": "mock-%s" % role,
                       "prompt_version": "%s_pv" % role,
                       "max_tokens": mt, "temperature": 0}
    if include_interp:
        for role, pv in (("structural_interpreter_a", "smap1-a@test"),
                         ("structural_interpreter_b", "smap1-b@test")):
            roles[role] = {"model_id": "mock-interp", "prompt_version": pv,
                           "max_tokens": 16000, "temperature": 0}
            if interp_breaker is not None:
                roles[role]["breaker"] = dict(interp_breaker)
    doc = {
        "schema": "ai_model_registry_v1",
        "defaults": {"temperature": 0,
                     "breaker": {"max_calls_per_day": 100,
                                 "max_tokens_per_day": 1_000_000}},
        "roles": roles,
    }
    path = tmp_path / "models.yaml"
    path.write_text(yaml.safe_dump(doc), encoding="utf-8")
    return path


@pytest.fixture
def registry_override(monkeypatch, tmp_path):
    """Point the registry at a sentinel file; cache cleared both sides."""
    def _use(path: Path) -> None:
        registry.clear_cache()
        monkeypatch.setenv(registry.PATH_ENV, str(path))
    yield _use
    registry.clear_cache()


# ── E1 fuzz: numeric-value rejection at every level ────────────────────


def test_e1_valid_fixture_maps_parse():
    for raw in (SIBIU_MAP, AGRAS_MAP):
        smap = StructuralMap.from_json_dict(copy.deepcopy(raw))
        assert smap.header_row_index == 0
        assert smap.map_hash == raw["map_hash"]


def test_e1_whitelisted_indices_accepted():
    raw = copy.deepcopy(SIBIU_MAP)
    raw["totals_row_indexes"] = [12]
    raw["subtotal_row_indexes"] = [3, 7]
    raw["repeated_header_rows"] = [40]
    raw["scale"] = 1000
    smap = StructuralMap.from_json_dict(raw)
    assert smap.totals_row_indexes == (12,)
    assert smap.scale == 1000


def test_e1_fuzz_injected_numeric_keys_rejected_at_every_dict_level():
    """Systematic fuzz: a value-bearing numeric key smuggled into ANY
    dict of the payload (top level, each column, analytic_structure,
    number_locale) must be rejected."""

    def _dict_sites(node: Any, path=()):  # yield (path, dict) for every dict
        if isinstance(node, dict):
            yield path, node
            for k, v in node.items():
                yield from _dict_sites(v, path + (k,))
        elif isinstance(node, list):
            for i, v in enumerate(node):
                yield from _dict_sites(v, path + (i,))

    baseline = copy.deepcopy(AGRAS_MAP)
    sites = list(_dict_sites(baseline))
    assert len(sites) >= 4  # top + columns[*] + analytic + locale
    for payload in (4242, 12.5, {"sf_d": 851012.45}, [1549139, 17]):
        for path, _ in sites:
            raw = copy.deepcopy(AGRAS_MAP)
            node = raw
            for p in path:
                node = node[p]
            node["smuggled_value"] = copy.deepcopy(payload)
            with pytest.raises(StructMapError):
                StructuralMap.from_json_dict(raw)


@pytest.mark.parametrize("mutate", [
    # numeric where a string belongs
    lambda r: r.__setitem__("currency", 12345),
    lambda r: r.__setitem__("sheet", 4.2),
    lambda r: r["anomaly_notes"].append(2500),
    lambda r: r["number_locale"].__setitem__("decimal_sep", 0.5),
    lambda r: r["columns"][0].__setitem__("semantic", 601),
    # floats even at whitelisted numeric paths
    lambda r: r.__setitem__("header_row_index", 0.0),
    lambda r: r.__setitem__("scale", 2.5),
    lambda r: r["columns"][0].__setitem__("index", 1.0),
    lambda r: r["analytic_structure"].__setitem__("synthetic_digits", 4.0),
    lambda r: r.__setitem__("totals_row_indexes", [1.5]),
    # booleans (no boolean field exists in smap1)
    lambda r: r["columns"][0].__setitem__("index", True),
    lambda r: r.__setitem__("header_row_index", False),
    # unknown keys, even non-numeric
    lambda r: r.__setitem__("totals", {"debit": "1000"}),
    lambda r: r["number_locale"].__setitem__("amount", 1),
])
def test_e1_handpicked_violations_rejected(mutate):
    raw = copy.deepcopy(SIBIU_MAP)
    mutate(raw)
    with pytest.raises(StructMapError):
        StructuralMap.from_json_dict(raw)


def test_e1_semantic_vocabulary_closed_and_code_col_consistent():
    raw = copy.deepcopy(SIBIU_MAP)
    raw["columns"][2]["semantic"] = "sold_initial_debit"  # not in vocabulary
    with pytest.raises(StructMapError):
        StructuralMap.from_json_dict(raw)
    raw = copy.deepcopy(SIBIU_MAP)
    raw["account_code_col"] = 3  # disagrees with the account_code column
    with pytest.raises(StructMapError):
        StructuralMap.from_json_dict(raw)
    raw = copy.deepcopy(SIBIU_MAP)
    raw["columns"][1]["semantic"] = "account_code"  # two code columns
    with pytest.raises(StructMapError):
        StructuralMap.from_json_dict(raw)


def test_roundtrip_canonical_text_and_hash_stability():
    smap = StructuralMap.from_json_dict(copy.deepcopy(AGRAS_MAP))
    text = smap.to_json_text()
    again = StructuralMap.from_json_text(text)
    assert again == smap
    assert again.to_json_text() == text
    assert again.map_hash == smap.map_hash
    # the hash excludes itself: text carries it, hash input does not
    assert json.loads(text)["map_hash"] == smap.map_hash


# ── E2: cache determinism ──────────────────────────────────────────────


def test_e2_cache_second_run_byte_identical_and_zero_client_calls():
    store = MemoryCacheStore()
    client = _FakeClient([json.dumps(SIBIU_MAP)])  # exactly ONE scripted reply
    kwargs = dict(jurisdiction="RO", framing="a", store=store, client=client)

    smap1, meta1 = interpret_with_cache(TINY_CSV, "tiny.csv", **kwargs)
    assert meta1["cached"] is False
    assert len(client.messages.calls) == 1
    stored_text_1 = store.data[meta1["cache_key"]]
    assert stored_text_1 == smap1.to_json_text()

    # Second run: same bytes ⇒ hit ⇒ ZERO further client calls (the one
    # scripted response is spent — any call would explode the fake).
    smap2, meta2 = interpret_with_cache(TINY_CSV, "tiny.csv", **kwargs)
    assert meta2["cached"] is True
    assert meta2["cache_key"] == meta1["cache_key"]
    assert len(client.messages.calls) == 1
    assert store.data[meta1["cache_key"]] == stored_text_1  # byte-identical
    assert smap2.to_json_text() == smap1.to_json_text()
    assert smap2 == smap1


def test_e2_cache_key_varies_by_content_role_prompt_and_model():
    base = dict(role="structural_interpreter_a",
                prompt_version="smap1-a@1", model_id="m1")
    k = cache_key(b"bytes", **base)
    assert k != cache_key(b"other bytes", **base)
    assert k != cache_key(b"bytes", **{**base, "role": "structural_interpreter_b"})
    assert k != cache_key(b"bytes", **{**base, "prompt_version": "smap1-a@2"})
    assert k != cache_key(b"bytes", **{**base, "model_id": "m2"})
    assert k == cache_key(b"bytes", **base)  # deterministic


def test_file_cache_store_roundtrip_first_write_wins(tmp_path):
    store = FileCacheStore(tmp_path / "interp_cache")
    key = cache_key(b"x", role="structural_interpreter_a",
                    prompt_version="p", model_id="m")
    assert store.get(key) is None
    store.put(key, '{"a":1}')
    assert store.get(key) == '{"a":1}'
    store.put(key, '{"a":2}')  # immutable per key
    assert store.get(key) == '{"a":1}'
    with pytest.raises(ValueError):
        store.get("../../etc/passwd")


# ── Two framings, two roles, two prompts ───────────────────────────────


def test_two_framings_call_two_roles_with_different_prompts():
    client = _FakeClient([json.dumps(SIBIU_MAP), json.dumps(SIBIU_MAP)])
    _, audit_a = run_structural_interpretation(
        TINY_CSV, "tiny.csv", jurisdiction="HU", framing="a", client=client)
    _, audit_b = run_structural_interpretation(
        TINY_CSV, "tiny.csv", jurisdiction="HU", framing="b", client=client)

    assert audit_a["role"] == "structural_interpreter_a"
    assert audit_b["role"] == "structural_interpreter_b"
    assert audit_a["stages"][0]["role"] == "structural_interpreter_a"
    assert audit_b["stages"][0]["role"] == "structural_interpreter_b"
    assert audit_a["prompt_version"] != audit_b["prompt_version"]

    call_a, call_b = client.messages.calls
    sys_a = call_a["system"][0]["text"]
    sys_b = call_b["system"][0]["text"]
    assert sys_a != sys_b
    assert "COLUMN-SEMANTICS-FIRST" in sys_a
    assert "ROW-TOPOLOGY-FIRST" in sys_b
    # models resolve per-role through the registry
    assert call_a["model"] == registry.model_for("structural_interpreter_a")
    assert call_b["model"] == registry.model_for("structural_interpreter_b")


def test_unknown_framing_is_loud():
    with pytest.raises(InterpError):
        run_structural_interpretation(
            TINY_CSV, "tiny.csv", jurisdiction="RO", framing="c",
            client=_FakeClient([]))


# ── Registry guard: no silent fallback ─────────────────────────────────


def test_registry_guard_missing_role_fails_loud_before_any_call(
        registry_override, tmp_path):
    registry_override(_sentinel_registry(tmp_path, include_interp=False))
    client = _FakeClient([json.dumps(SIBIU_MAP)])
    with pytest.raises(InterpError) as ei:
        run_structural_interpretation(
            TINY_CSV, "tiny.csv", jurisdiction="RO", framing="a", client=client)
    assert "structural_interpreter_a" in str(ei.value)
    # NOT the _client silent-fallback path: zero model calls were made.
    assert client.messages.calls == []


def test_registry_guard_applies_to_cache_path_too(registry_override, tmp_path):
    registry_override(_sentinel_registry(tmp_path, include_interp=False))
    store = MemoryCacheStore()
    with pytest.raises(InterpError):
        interpret_with_cache(
            TINY_CSV, "tiny.csv", jurisdiction="RO", framing="b",
            store=store, client=_FakeClient([]))
    assert store.data == {}


# ── Breaker wiring ─────────────────────────────────────────────────────


def test_breaker_open_degrades_to_typed_unavailable(
        registry_override, tmp_path):
    registry_override(_sentinel_registry(
        tmp_path, include_interp=True,
        interp_breaker={"max_calls_per_day": 0, "max_tokens_per_day": 0}))
    base_calls = {"n": 0}

    def base_factory() -> Any:
        base_calls["n"] += 1
        return _FakeClient([json.dumps(SIBIU_MAP)])

    factory = breaker.guarded_client_factory(
        "structural_interpreter_a", base_factory=base_factory,
        state_dir=tmp_path / "spend")
    with pytest.raises(InterpUnavailable) as ei:
        run_structural_interpretation(
            TINY_CSV, "tiny.csv", jurisdiction="RO", framing="a",
            client_factory=factory)
    assert ei.value.role == "structural_interpreter_a"
    assert ei.value.reason.startswith("breaker_open")
    # tripped BEFORE any client was constructed
    assert base_calls["n"] == 0


# ── E1 at the parse seam: reject, retry once, then typed error ─────────


def _value_bearing_map() -> Dict[str, Any]:
    raw = copy.deepcopy(SIBIU_MAP)
    raw["totals"] = {"debit": 63478148.44}  # a smuggled cell value
    return raw


def test_model_map_with_cell_values_rejected_retried_then_fails():
    client = _FakeClient([
        json.dumps(_value_bearing_map()),
        json.dumps(_value_bearing_map()),
    ])
    with pytest.raises(InterpError) as ei:
        run_structural_interpretation(
            TINY_CSV, "tiny.csv", jurisdiction="RO", framing="a", client=client)
    assert "twice" in str(ei.value)
    assert len(client.messages.calls) == 2
    retry_user_text = client.messages.calls[1]["messages"][0]["content"][0]["text"]
    assert "REJECTED" in retry_user_text
    assert "never include any monetary amount" in retry_user_text.lower()


def test_model_map_rejected_once_then_valid_succeeds():
    client = _FakeClient([
        json.dumps(_value_bearing_map()),
        json.dumps(SIBIU_MAP),
    ])
    smap, audit = run_structural_interpretation(
        TINY_CSV, "tiny.csv", jurisdiction="RO", framing="a", client=client)
    assert audit["attempts"] == 2
    assert smap.map_hash == SIBIU_MAP["map_hash"]


# ── Real-file smoke: prompts from the real workbooks + fixture maps ────


def test_real_file_smoke_sibiu_framing_a():
    client = _FakeClient([json.dumps(SIBIU_MAP)])
    smap, audit = run_structural_interpretation(
        SIBIU_XLSX.read_bytes(), SIBIU_XLSX.name,
        jurisdiction="RO", framing="a", client=client)

    # the hand-verified map came through the full parse+validate path
    assert smap == StructuralMap.from_json_dict(copy.deepcopy(SIBIU_MAP))
    assert smap.header_row_index == 0
    assert smap.semantic_of(1) == "account_name"
    assert smap.columns_for("total_with_opening_debit") == (6,)
    assert smap.columns_for("total_with_opening_credit") == (7,)
    assert smap.columns_for("movement_cumulative_debit") == ()
    assert smap.analytic_structure.separator is None
    assert smap.analytic_structure.synthetic_digits == 4
    assert smap.totals_row_indexes == ()

    # the prompt payload rendered the real workbook with 0-based
    # workbook row indexes (blank rows kept, coordinates trustworthy)
    user_text = client.messages.calls[0]["messages"][0]["content"][0]["text"]
    assert "=== Sheet: Sheet1 ===" in user_text
    assert "r0\tCont\tDenumire" in user_text
    assert "\nr249\t" in user_text  # last data row, 0-based
    assert audit["role"] == "structural_interpreter_a"
    assert audit["map_hash"] == SIBIU_MAP["map_hash"]


def test_real_file_smoke_agras_framing_b():
    client = _FakeClient([json.dumps(AGRAS_MAP)])
    smap, audit = run_structural_interpretation(
        AGRAS_XLSX.read_bytes(), AGRAS_XLSX.name,
        jurisdiction="RO", framing="b", client=client)

    assert smap == StructuralMap.from_json_dict(copy.deepcopy(AGRAS_MAP))
    # the mission's two-enums distinction: same physical position (6/7)
    # is movements-only cumulative here, opening-inclusive total on sibiu
    assert smap.columns_for("movement_cumulative_debit") == (6,)
    assert smap.columns_for("movement_cumulative_credit") == (7,)
    assert smap.columns_for("total_with_opening_debit") == ()
    assert smap.columns_for("marker") == (10,)
    assert smap.columns_for("hint_classification") == (11, 15, 16, 17)
    assert smap.analytic_structure.separator == "."
    assert smap.totals_row_indexes == ()  # agras has NO totals row

    user_text = client.messages.calls[0]["messages"][0]["content"][0]["text"]
    assert "=== Sheet: Agras Food Factory ===" in user_text
    assert "\nr643\t" in user_text  # trailing junk rows kept, indexed
    assert audit["role"] == "structural_interpreter_b"
    assert audit["map_hash"] == AGRAS_MAP["map_hash"]
