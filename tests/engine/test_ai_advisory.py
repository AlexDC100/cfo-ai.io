"""Advisory-pass battery — engine.ai.advisory (V1-V7 invariants).

THE TWO HARD RULES (operator spec) proven here, ALL MOCKED:
  R1  the deterministic validator stays the ONLY gate — the AI
      validation pass can never block serving, mutate IR/layers, or
      change a machine status;
  R2  its output is ADDITIVE — an `ai_review` layer at the ENVELOPE
      ROOT (the pack_provenance placement discipline) + additive
      envelope fields only.

V-family:
  V1  status invariance — for EVERY corpus envelope, machine status
      with the pass ON (mocked) == OFF; the full served payload is
      byte-identical.
  V2  byte-invariance — gateway facts identical ON/OFF.
  V3  failure isolation — model timeout / API error / credits-out →
      ai_review ABSENT + the degraded flag; everything else
      byte-identical.
  V4  the needs_review escalation accepts atom/account IDS ONLY —
      passing a value raises TypeError by signature.
  V5  findings cannot flip status — a forged 'flag' finding claiming
      BALANCED->MATERIAL leaves the served status unchanged (and the
      forged keys are stripped by the whitelist projection).
  V6  reconcile quarantine — the reconcile flow never constructs the
      ai_validator role's client (sentinel), even while its OWN AI
      proposal path runs.
  V7  ai_review survives the serve stage intact (additive-envelope
      rule, extending the served-shape guard pattern): the layer is
      byte-identical after serving, never leaks INTO the served
      payload, and the additive serve guard stays clean.

Plus the two jobs: extraction verification (llm atoms only; per-atom
cent compare against the model's re-read; doc-level agreement score;
disagreement → the ONE permitted write, an id-only needs_review
escalation + a side-by-side finding) and the statement sanity review
(read-only facts via the facts gateway + deterministic findings;
advisory, dismissible, dismissals audited additively).

No network anywhere in this file.
"""
from __future__ import annotations

import copy
import json
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any, Dict, List, Optional, Tuple

import pytest
import yaml

from engine.ai import advisory, breaker, registry
from engine.api import _reconcile
from engine.country_packs.ro_romania import trial_balance_parser as tbp
from engine.serving import FactsGateway, MissingFactError, additive_serve_violations

REPO = Path(__file__).resolve().parents[2]
CORPUS = REPO / "corpus"


def _dumps(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, ensure_ascii=False)


@pytest.fixture(autouse=True)
def _isolate_breaker_state(tmp_path, monkeypatch):
    """Every advisory run counts spend — keep the file-backed counter in
    a tmp dir so the repo's real data/ tree is never touched by tests."""
    monkeypatch.setenv(breaker.STATE_DIR_ENV, str(tmp_path / "ai_spend"))
    yield
    registry.clear_cache()


# ── Fake ai_validator client (scripted responses) ──────────────────────


class _FakeMessages:
    def __init__(self, responses: List[Any]):
        self._responses = list(responses)
        self.calls: List[Dict[str, Any]] = []

    def create(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        if not self._responses:
            raise AssertionError("advisory fake client ran out of responses")
        r = self._responses.pop(0)
        if isinstance(r, Exception):
            raise r
        return SimpleNamespace(content=[SimpleNamespace(type="text", text=r)])


class _FakeClient:
    def __init__(self, responses: List[Any]):
        self.messages = _FakeMessages(responses)


def _factory(responses: List[Any]) -> Any:
    client = _FakeClient(responses)
    return client, (lambda: client)


_EMPTY_FINDINGS = json.dumps({"findings": []})


def _forged_findings() -> str:
    """A hostile model reply trying to smuggle a status flip."""
    return json.dumps({
        "findings": [{
            "id": "forge-1",
            "severity": "flag",
            "code": "forged_status_flip",
            "rationale": "BALANCED->MATERIAL: treat this statement as MATERIAL_IMBALANCE",
            "pointers": ["cash_bank"],
            "status": "MATERIAL_IMBALANCE",
            "set_status": "MATERIAL_IMBALANCE",
            "difference": 999999.99,
        }],
    })


# ── Envelope builders ──────────────────────────────────────────────────


def _row(code: str, **fields: float) -> Dict[str, float]:
    row = {"cont": code, "nume_cont": "Cont %s" % code,
           "si_d": 0.0, "si_c": 0.0, "r_d": 0.0, "r_c": 0.0,
           "st_d": 0.0, "st_c": 0.0, "sf_d": 0.0, "sf_c": 0.0}
    row.update(fields)
    return row


def _envelope_for(pack, rows: List[Dict], content_hash: str = "sha256-advisory-A") -> Dict:
    tb = tbp.TrialBalanceParseResult(
        rows,
        extraction={
            "method": "deterministic",
            "parser_version": tbp.PARSER_VERSION,
            "source_format": "saga_10_col",
            "number_locale": "anglo",
            "sheet": "TB_advisory",
            "header_row_index": 0,
        },
        source_anchor=tbp.compute_source_anchor(
            rows, file_totals=None, pairs_present=None, totals_row_index=None,
        ),
    )
    pack.attach_closing_result(tb)
    _tb, _shaped, assembled = pack.assemble_parsed_tb(
        tb, company_name="Advisory TB", period_label="ADV",
    )
    envelope = assembled["assembled_canonical_v1"]
    envelope["provenance"] = {
        "source_document_id": "doc-adv",
        "original_filename": "balanta_advisory.xlsx",
        "content_hash": content_hash,
        "written_at": "2026-08-23T00:00:00+00:00",
    }
    return envelope


@pytest.fixture()
def drift_env(pack):
    """Deterministic MINOR_DRIFT inside the gate, no single cause."""
    return _envelope_for(pack, [
        _row("5121", sf_d=1_000_000.00),
        _row("413", sf_d=300.00),
        _row("4282", sf_d=200.00),
        _row("1012", sf_c=999_722.23),
    ])


@pytest.fixture()
def balanced_env(pack):
    return _envelope_for(pack, [
        _row("5121", sf_d=1000.00),
        _row("1012", sf_c=1000.00),
    ])


def _llm_envelope() -> Dict[str, Any]:
    """A hand-pinned LLM-extraction envelope with three atoms whose
    engine readings are controlled to the cent."""
    cbs = {
        "schema": "bs_v2",
        "mapping_version": "hu_actc2000_pack_v1",
        "extraction": {
            "method": "llm",
            "parser_version": "ai_lane_v1",
            "source_format": "llm_hu",
            "number_locale": "ro",
            "model": "claude-opus-4-7",
        },
        "source_anchor": {"totals_row_found": False, "pairs": {},
                          "anchor_status": "NO_ANCHOR", "source_balanced": None},
        "rows": [
            {"id": "ppe_machinery", "section": "non_current_assets",
             "label": "Machinery", "account_codes": ["131"],
             "amount": 5000.00, "leaf_ids": ["131"]},
            {"id": "cash_bank", "section": "current_assets",
             "label": "Bank", "account_codes": ["384"],
             "amount": 1200.50, "leaf_ids": ["384"]},
            {"id": "share_capital", "section": "equity",
             "label": "Share capital", "account_codes": ["411"],
             "amount": 6200.49, "leaf_ids": ["411"]},
        ],
        "sections": [
            {"id": "non_current_assets", "subtotal": 5000.00},
            {"id": "current_assets", "subtotal": 1200.50},
            {"id": "equity", "subtotal": 6200.49},
        ],
        "totals": {"assets": 6200.50, "equity": 6200.49, "liabilities": 0.0,
                   "equity_plus_liabilities": 6200.49,
                   "current_assets": 1200.50, "current_liabilities": 0.0},
        "difference": 0.01,
        "status": "MINOR_DRIFT",
        "diagnosis": [],
        "unmapped": [],
        "excluded": [],
        "invariants": {"result_basis": "reconstruction"},
        "jurisdiction": {"resolved": "HU", "source": "auto",
                         "pack_version": "ai_lane_v1"},
    }
    return {
        "schema_version": "test",
        "canonical_bs": cbs,
        "provenance": {
            "source_document_id": "doc-llm",
            "original_filename": "hu_tb.csv",
            "content_hash": "sha256-llm-A",
            "written_at": "2026-08-23T00:00:00+00:00",
        },
    }


def _provenance_for(case_id: str) -> Dict[str, Any]:
    return {
        "source_document_id": "doc-%s" % case_id,
        "original_filename": "%s.xlsx" % case_id,
        "content_hash": "sha256-corpus-%s" % case_id,
        "written_at": "2026-08-23T00:00:00+00:00",
    }


def _corpus_envelopes() -> Tuple[List[Any], List[Any]]:
    """Split the corpus by served-envelope SHAPE.

    Trial-balance cases freeze a canonical_bs payload (it always carries
    a ``status``), so this suite wraps it in a pipeline envelope. The
    public-summary case freezes a different envelope kind entirely — no
    canonical_bs, no status, no cents. Wrapping THAT as canonical_bs
    would build a nonsense envelope and make served_canonical_bs return
    None; it is returned unwrapped instead and asserted against the
    stronger public-engine invariant (whole-envelope byte identity, AI
    never consulted) in test_v1_non_bs_envelopes_untouched_by_advisory.
    """
    bs_cases: List[Any] = []
    other_cases: List[Any] = []
    for case_dir in sorted(CORPUS.iterdir()):
        expected = case_dir / "expected" / "served_envelope.json"
        if not expected.is_file():
            continue
        payload = json.loads(expected.read_text(encoding="utf-8"))
        if isinstance(payload, dict) and "status" in payload:
            bs_cases.append((case_dir.name, {
                "canonical_bs": payload,
                "provenance": _provenance_for(case_dir.name),
            }))
        else:
            other_cases.append((case_dir.name, payload))
    return bs_cases, other_cases


CORPUS_ENVELOPES, NON_BS_ENVELOPES = _corpus_envelopes()


def _gateway_fact_bytes(envelope: Dict[str, Any]) -> str:
    """Every gateway fact (or its typed failure) as one canonical string."""
    gw = FactsGateway.from_envelope(copy.deepcopy(envelope))
    if gw is None:
        return "<no-gateway>"
    out: Dict[str, Any] = {"tier": gw.tier}
    for name in ("total_assets", "total_liabilities", "equity",
                 "equity_plus_liabilities", "current_assets",
                 "current_liabilities", "working_capital", "difference",
                 "net_result", "revenue", "expenses", "ebitda"):
        try:
            fact = getattr(gw, name)()
            out[name] = fact.amount_minor
        except MissingFactError:
            out[name] = "<missing>"
        except Exception as e:  # noqa: BLE001 — captured symmetrically ON/OFF
            out[name] = "<%s>" % type(e).__name__
    return _dumps(out)


# ── V1 + V2: status / facts invariance over the whole corpus ───────────


def test_corpus_envelopes_discovered():
    """18 frozen served envelopes: 17 canonical_bs payloads plus the
    public-summary envelope, which has a different shape. Both branches
    are asserted below — neither can grow silently."""
    assert len(CORPUS_ENVELOPES) == 17
    assert [c for c, _ in NON_BS_ENVELOPES] == ["public_summary_ro"]


@pytest.mark.parametrize("case_id,envelope", CORPUS_ENVELOPES,
                         ids=[c[0] for c in CORPUS_ENVELOPES])
def test_v1_status_invariance_on_off(case_id, envelope):
    env_off = copy.deepcopy(envelope)
    env_on = copy.deepcopy(envelope)
    served_off = _reconcile.served_canonical_bs(env_off)

    _client, factory = _factory([_forged_findings()])
    advisory.pipeline_hook(env_on, enabled=True, client_factory=factory)
    assert "ai_review" in env_on
    served_on = _reconcile.served_canonical_bs(env_on)

    assert served_off is not None and served_on is not None
    assert served_on["status"] == served_off["status"]
    assert _dumps(served_on) == _dumps(served_off)
    # The persisted deterministic truth is untouched.
    assert _dumps(env_on["canonical_bs"]) == _dumps(envelope["canonical_bs"])


@pytest.mark.parametrize("case_id,envelope", NON_BS_ENVELOPES,
                         ids=[c[0] for c in NON_BS_ENVELOPES])
def test_v1_non_bs_envelopes_untouched_by_advisory(case_id, envelope):
    """Envelopes with no canonical_bs — today the public-summary kind —
    must come out of the advisory hook BYTE-IDENTICAL, with the AI
    client never even constructed.

    This is stronger than the canonical_bs invariance above (which only
    pins the served surface) and it is the public engine's load-bearing
    property: a public company page is built from open filing data and
    must carry nothing an AI produced, advisory content included. A
    client_factory that raises on construction turns 'the hook decided
    to look at this envelope' into a hard failure rather than a silent
    behavior change.
    """
    def _exploding_factory(*_a, **_kw):
        raise AssertionError(
            "advisory constructed an AI client for a non-canonical_bs "
            "envelope (%s) — public surfaces must never carry AI output"
            % case_id)

    env_on = copy.deepcopy(envelope)
    before = _dumps(envelope)
    advisory.pipeline_hook(env_on, enabled=True,
                           client_factory=_exploding_factory)
    assert "ai_review" not in env_on
    assert _dumps(env_on) == before


@pytest.mark.parametrize("case_id,envelope", CORPUS_ENVELOPES,
                         ids=[c[0] for c in CORPUS_ENVELOPES])
def test_v2_gateway_facts_byte_identical_on_off(case_id, envelope):
    env_on = copy.deepcopy(envelope)
    facts_off = _gateway_fact_bytes(envelope)
    _client, factory = _factory([_forged_findings()])
    advisory.pipeline_hook(env_on, enabled=True, client_factory=factory)
    assert _gateway_fact_bytes(env_on) == facts_off


# ── V3: failure isolation ──────────────────────────────────────────────


def _assert_degraded_only(env_before: Dict[str, Any], env_after: Dict[str, Any],
                          reason: str) -> None:
    assert "ai_review" not in env_after
    degraded = env_after[advisory.DEGRADED_KEY]
    assert degraded["available"] is False
    assert degraded["marker"] == breaker.DEGRADED_MARKER
    assert degraded["reason"] == reason
    stripped = {k: v for k, v in env_after.items() if k != advisory.DEGRADED_KEY}
    assert _dumps(stripped) == _dumps(env_before)


def test_v3_client_construction_failure_degrades(drift_env):
    env = copy.deepcopy(drift_env)

    def exploding_factory() -> Any:
        raise RuntimeError("no credits / no key")

    advisory.pipeline_hook(env, enabled=True, client_factory=exploding_factory)
    _assert_degraded_only(drift_env, env, "client_unavailable")
    # Serving still green.
    assert _reconcile.served_canonical_bs(env)["status"] == "MINOR_DRIFT"


def test_v3_model_timeout_degrades(drift_env):
    env = copy.deepcopy(drift_env)
    _client, factory = _factory([TimeoutError("deadline")])
    advisory.pipeline_hook(env, enabled=True, client_factory=factory)
    _assert_degraded_only(drift_env, env, "model_error")


def test_v3_twice_malformed_json_degrades(drift_env):
    env = copy.deepcopy(drift_env)
    _client, factory = _factory(["not json", "still not json"])
    advisory.pipeline_hook(env, enabled=True, client_factory=factory)
    _assert_degraded_only(drift_env, env, "model_error")


# ── V4: the escalation accepts ids only ────────────────────────────────


def test_v4_escalation_accepts_ids_only():
    ledger = advisory.EscalationLedger()
    ledger.raise_needs_review("4111")
    assert ledger.ids == ["4111"]
    with pytest.raises(TypeError):
        ledger.raise_needs_review("4111", 123.45)  # a value → signature TypeError
    with pytest.raises(TypeError):
        ledger.raise_needs_review("4111", value=123.45)
    with pytest.raises(TypeError):
        ledger.raise_needs_review(123.45)  # a bare value is not an id
    with pytest.raises(TypeError):
        ledger.raise_needs_review({"id": "4111", "amount": 1.0})
    assert ledger.ids == ["4111"]


# ── V5: findings cannot flip status ────────────────────────────────────


def test_v5_forged_flag_finding_cannot_flip_status(drift_env):
    env = copy.deepcopy(drift_env)
    served_before = _reconcile.served_canonical_bs(copy.deepcopy(env))
    _client, factory = _factory([_forged_findings()])
    advisory.pipeline_hook(env, enabled=True, client_factory=factory)

    served_after = _reconcile.served_canonical_bs(env)
    assert served_after["status"] == served_before["status"] == "MINOR_DRIFT"
    assert _dumps(served_after) == _dumps(served_before)
    # The forged mutation keys were stripped by the whitelist projection;
    # the finding itself survives as inert advisory data.
    findings = env["ai_review"]["findings"]
    assert len(findings) == 1
    assert findings[0]["severity"] == "flag"
    assert "status" not in findings[0]
    assert "set_status" not in findings[0]
    assert "difference" not in findings[0]


# ── V6: reconcile quarantine ───────────────────────────────────────────


def test_v6_reconcile_flow_never_constructs_ai_validator_client(
        drift_env, monkeypatch):
    sentinel_calls: List[int] = []

    def sentinel_factory() -> Any:
        sentinel_calls.append(1)
        raise AssertionError(
            "the reconcile flow must never construct the ai_validator client"
        )

    monkeypatch.setattr(advisory, "_default_client_factory", sentinel_factory)

    # Scripted `anthropic` module so _ai_propose runs its REAL code path.
    proposal = json.dumps({
        "target_account": "413",
        "amount_cents": -27777,
        "rationale": "scripted",
    })
    created: List[int] = []

    class _Msg:
        def create(self, **kwargs: Any) -> Any:
            created.append(1)
            return SimpleNamespace(
                content=[SimpleNamespace(type="text", text=proposal)],
                stop_reason="end_turn",
            )

    class _Anthropic:
        def __init__(self, **kwargs: Any) -> None:
            self.messages = _Msg()

    fake = ModuleType("anthropic")
    fake.Anthropic = _Anthropic
    monkeypatch.setitem(sys.modules, "anthropic", fake)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-quarantine")

    _reconcile.auto_reconcile_envelope(drift_env)
    assert created, "the reconcile proposal path did not run — test is vacuous"
    assert sentinel_calls == []


# ── V7: ai_review survives the serve stage intact ──────────────────────


def test_v7_ai_review_survives_serve_intact(drift_env):
    env = copy.deepcopy(drift_env)
    _client, factory = _factory([_EMPTY_FINDINGS])
    advisory.pipeline_hook(env, enabled=True, client_factory=factory)
    layer_before = _dumps(env["ai_review"])

    served = _reconcile.served_canonical_bs(env)
    assert _dumps(env["ai_review"]) == layer_before  # serve mutated nothing
    assert "ai_review" not in served                 # root layer never leaks in
    # Additive serve guard clean — the served object only ADDS keys.
    assert additive_serve_violations(env["canonical_bs"], served) == []
    # A stage_persist-style whole-envelope write carries root keys as-is.
    persisted = json.loads(_dumps(env))
    assert persisted["ai_review"] == json.loads(layer_before)


# ── Job 1: extraction verification (llm atoms only) ────────────────────


def test_job1_agreement_and_escalation_on_disagreement():
    env = _llm_envelope()
    cbs_before = _dumps(env["canonical_bs"])
    job1 = json.dumps({"atoms": [
        {"id": "ppe_machinery", "amount": 5000.00},   # agrees to the cent
        {"id": "cash_bank", "amount": 1300.50},       # disagrees by 100.00
        {"id": "share_capital", "amount": 6200.49},   # agrees
    ]})
    client, factory = _factory([job1, _EMPTY_FINDINGS])
    review = advisory.run_ai_review(
        env, client_factory=factory, source_text="HU TB source text 131;384;411",
    )
    ev = review["extraction_verification"]
    assert ev["ran"] is True
    assert ev["atoms_checked"] == 3
    assert ev["atoms_agreed"] == 2
    assert ev["agreement_score"] == pytest.approx(2 / 3)
    assert len(ev["disagreements"]) == 1
    d = ev["disagreements"][0]
    assert d["atom_id"] == "cash_bank"
    assert d["engine_reading"] == 1200.50
    assert d["ai_reading"] == 1300.50
    # The ONE permitted write: an id-only escalation.
    assert review["needs_review_escalations"] == ["cash_bank"]
    # A side-by-side finding rides along.
    codes = [f["code"] for f in review["findings"]]
    assert "extraction_disagreement" in codes
    # The deterministic truth is untouched.
    assert _dumps(env["canonical_bs"]) == cbs_before
    # The verification prompt withholds the engine's own readings.
    job1_payload = client.messages.calls[0]["messages"][0]["content"][0]["text"]
    assert "1200.5" not in job1_payload
    assert "cash_bank" in job1_payload
    assert "HU TB source text" in job1_payload


def test_job1_skipped_for_deterministic_extraction(drift_env):
    env = copy.deepcopy(drift_env)
    client, factory = _factory([_EMPTY_FINDINGS])
    review = advisory.run_ai_review(env, client_factory=factory,
                                    source_text="irrelevant")
    assert review["extraction_verification"]["ran"] is False
    assert review["extraction_verification"]["reason"] == "not_llm_extraction"
    assert len(client.messages.calls) == 1  # only the sanity review ran


def test_job1_skipped_without_source_text():
    env = _llm_envelope()
    client, factory = _factory([_EMPTY_FINDINGS])
    review = advisory.run_ai_review(env, client_factory=factory)
    assert review["extraction_verification"]["ran"] is False
    assert review["extraction_verification"]["reason"] == "source_text_unavailable"
    assert len(client.messages.calls) == 1


# ── Job 2: statement sanity review ─────────────────────────────────────


def test_job2_findings_sanitized_and_projected(drift_env):
    env = copy.deepcopy(drift_env)
    reply = json.dumps({"findings": [
        {"severity": "warn", "code": "ratio_outlier",
         "rationale": "receivables outsized", "pointers": ["cash_bank", 7]},
        {"severity": "catastrophic", "code": "bad", "rationale": "invalid severity"},
        "not-a-dict",
        {"severity": "info", "rationale": "no code is fine"},
    ]})
    _client, factory = _factory([reply])
    review = advisory.run_ai_review(env, client_factory=factory)
    findings = review["findings"]
    assert [f["severity"] for f in findings] == ["warn", "info"]
    assert findings[0]["pointers"] == ["cash_bank", "7"]  # pointers coerced to str
    assert review["dropped_findings"] == 2
    for f in findings:
        assert set(f.keys()) <= {"id", "severity", "code", "rationale", "pointers"}


def test_job2_payload_is_gateway_facts_plus_deterministic_findings(pack):
    env = _envelope_for(pack, [
        _row("5121", sf_d=1_000_000.00),
        _row("413", sf_d=300.00),
        _row("4282", sf_d=200.00),
        _row("1012", sf_c=999_722.23),
    ])
    prior = _envelope_for(pack, [
        _row("5121", sf_d=900_000.00),
        _row("1012", sf_c=900_000.00),
    ], content_hash="sha256-advisory-PRIOR")
    client, factory = _factory([_EMPTY_FINDINGS])
    advisory.run_ai_review(env, client_factory=factory, prior_envelope=prior)
    payload = client.messages.calls[0]["messages"][0]["content"][0]["text"]
    data = json.loads(payload.split("INPUT:\n", 1)[1])
    gw = FactsGateway.from_envelope(copy.deepcopy(env))
    assert data["facts"]["total_assets_minor"] == gw.total_assets().amount_minor
    assert data["facts"]["equity_minor"] == gw.equity().amount_minor
    assert data["deterministic_findings"] == (env["canonical_bs"].get("diagnosis") or [])
    assert data["prior_facts"]["total_assets_minor"] == 90_000_000
    assert data["status"] == "MINOR_DRIFT"


# ── Audit + dismissal + hook plumbing ──────────────────────────────────


def test_audit_entries_persist_role_model_prompt(drift_env):
    env = copy.deepcopy(drift_env)
    _client, factory = _factory([_EMPTY_FINDINGS])
    advisory.pipeline_hook(env, enabled=True, client_factory=factory)
    review = env["ai_review"]
    assert review["role"] == "ai_validator"
    assert review["model"] == registry.model_for("ai_validator") == "claude-fable-5"
    assert review["prompt_version"] == (
        registry.params_for("ai_validator")["prompt_version"]
    )
    stages = review["audit"]["stages"]
    assert stages, "advisory audit must persist raw responses"
    for s in stages:
        assert s["role"] == "ai_validator"
        assert s["model_id"] == "claude-fable-5"
        assert s["prompt_version"] == review["prompt_version"]
        assert "raw_response" in s


def test_dismissal_is_audited_and_additive(drift_env):
    env = copy.deepcopy(drift_env)
    reply = json.dumps({"findings": [
        {"id": "f-1", "severity": "warn", "code": "x", "rationale": "r"},
    ]})
    _client, factory = _factory([reply])
    advisory.pipeline_hook(env, enabled=True, client_factory=factory)
    served_before = _dumps(_reconcile.served_canonical_bs(copy.deepcopy(env)))

    entry = advisory.dismiss_finding(env, "f-1", dismissed_by="user:alex",
                                     reason="known seasonal effect")
    assert entry["finding_id"] == "f-1"
    assert env["ai_review"]["dismissals"] == [entry]
    assert entry["dismissed_by"] == "user:alex"
    assert entry["at"]
    # The finding itself stays (audit trail), and serving is unchanged.
    assert [f["id"] for f in env["ai_review"]["findings"]] == ["f-1"]
    assert _dumps(_reconcile.served_canonical_bs(env)) == served_before


def test_hook_disabled_by_default_no_marker(drift_env, monkeypatch):
    monkeypatch.delenv(advisory.ENABLE_ENV, raising=False)
    env = copy.deepcopy(drift_env)
    advisory.pipeline_hook(env)  # enabled unset -> env gate -> default OFF
    assert "ai_review" not in env
    assert advisory.DEGRADED_KEY not in env
    assert _dumps(env) == _dumps(drift_env)


def test_hook_env_gate_turns_it_on(drift_env, monkeypatch):
    monkeypatch.setenv(advisory.ENABLE_ENV, "1")
    env = copy.deepcopy(drift_env)
    _client, factory = _factory([_EMPTY_FINDINGS])
    advisory.pipeline_hook(env, client_factory=factory)
    assert "ai_review" in env


def test_hook_for_pipeline_returns_the_hook():
    assert advisory.hook_for_pipeline() is advisory.pipeline_hook


def test_hook_never_raises_even_on_garbage_envelopes():
    advisory.pipeline_hook(None, enabled=True)          # not a dict
    advisory.pipeline_hook({}, enabled=True)            # no canonical_bs
    env = {"canonical_bs": "not-a-dict"}
    advisory.pipeline_hook(env, enabled=True)
    # A broken breaker/registry path must not leak either.
    advisory.pipeline_hook({"canonical_bs": {}}, enabled=True,
                           client_factory=lambda: (_ for _ in ()).throw(RuntimeError("x")))
