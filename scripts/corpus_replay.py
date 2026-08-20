#!/usr/bin/env python3
"""GOLDEN CORPUS replay runner (docs/CANONICAL_BS_V2_CONTRACT.md battery).

For every case under corpus/<case_id>/ runs the FULL offline pipeline —
the same code objects the production stages compose, never a mirror:

  parse            per meta `expected_parser` (RomaniaPack.parse_trial_
                   balance / parse_trial_balance_csv), or the MOCKED
                   AI lane (engine.ai_lane.run_ai_lane with a scripted
                   client_factory), or the MOCKED RO LLM fallback
                   (financial_statements.parse_document behind a
                   scripted `anthropic` module injected in sys.modules)
  assemble         RomaniaPack.assemble_parsed_tb (deterministic lanes)
                   / pipeline.stage_map (RO LLM fallback) / the lane's
                   own build (hu_ai_lane)
  auto-reconcile   exercised at its REAL seam: pipeline.stage_persist
                   calls carry_forward_reconciliation +
                   auto_reconcile_envelope between the canonical build
                   and the single envelope write
  persist          pipeline.stage_persist against the fake-admin
                   harness (the test suite's in-memory Supabase stand-in)
  serve            engine.api._reconcile.served_canonical_bs on the
                   persisted envelope
  facts            engine.serving.FactsGateway (equity / total_assets /
                   net_result in integer cents)

then BYTE-compares each produced artifact against corpus/<case>/expected/
(json.dumps sort_keys) and exits non-zero with a per-field report (path,
expected, actual) on any diff. UPDATE_GOLDEN=1 regenerates expected/
instead (writing normalized artifacts).

Artifacts per case (all normalized — see VOLATILE_KEYS):
  extraction.json      canonical extraction: extraction block + source
                       anchor + extracted rows
  classification.json  the classification stage's output (shaped
                       accounts + unmapped/excluded telemetry for the
                       deterministic lanes; assignments/needs_review/
                       line items for the mocked lanes)
  statuses.json        persisted + served status, difference, receipt /
                       needs-review marker, presentation, offer flags
  served_envelope.json the FULL served canonical_bs (verbatim serve
                       payload)
  gateway_facts.json   FactsGateway equity / total_assets / net_result
                       as integer cents, plus tier + currency

NO LIVE API CALLS — hard-guaranteed per run, not per assertion:
  · `sys.modules["anthropic"] = None` for the whole case run, so ANY
    real SDK import raises ImportError (the ai-sentinel pattern from
    tests/engine/test_reconciliation.py); the RO-fallback case swaps in
    its SCRIPTED module only around its parse step.
  · `_reconcile._ai_propose` is replaced by a recording raiser; cases
    whose meta sets `expect_ai_never_consulted: true` FAIL if it (or a
    mocked model client) is ever invoked.
The Anthropic credit state can therefore never affect this gate.

VOLATILE-KEY NORMALIZER — the whitelist of exactly which keys are
timestamps stamped at run time and therefore replaced with the fixed
placeholder before compare/write; every other field is byte-compared:
  written_at    (envelope provenance — stage_persist)
  applied_at    (reconciliation receipt)
  attempted_at  (reconciliation_auto needs-review marker)
  archived_at / undone_at / suppressed_at  (receipt history / undo)
  at            (ai_audit per-stage timestamps)
  updated_at    (period-row echo, defensive)

Usage:
  .venv/bin/python scripts/corpus_replay.py [--case ID ...] [--corpus-root P]
  UPDATE_GOLDEN=1 .venv/bin/python scripts/corpus_replay.py

Exit codes: 0 all green (or all written), 1 any failure, 2 internal error.
"""
from __future__ import annotations

import argparse
import base64
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any, Callable, Dict, List, Optional, Tuple


def _find_repo_root() -> Path:
    here = Path(__file__).resolve().parent
    for candidate in [here, *here.parents][:6]:
        if (candidate / "pyproject.toml").is_file():
            return candidate
    return Path(__file__).resolve().parent.parent


REPO = _find_repo_root()
SRC = REPO / "src"
if SRC.is_dir() and str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))
if str(REPO / "scripts") not in sys.path:
    sys.path.insert(0, str(REPO / "scripts"))

import yaml  # noqa: E402  (declared project dependency)

import engine.country_packs.ro_romania  # noqa: E402,F401 — registers RomaniaPack
import engine.ai_lane as _lane  # noqa: E402
from engine.api import _reconcile  # noqa: E402
from engine.api import pipeline as _pipeline  # noqa: E402
from engine.core.country_pack_registry import get_pack  # noqa: E402
from engine.serving import FactsGateway  # noqa: E402

DEFAULT_CORPUS = REPO / "corpus"
PLACEHOLDER = "<volatile:stripped>"

#: The documented whitelist of volatile (run-time timestamp) keys.
VOLATILE_KEYS = frozenset({
    "written_at", "applied_at", "attempted_at", "archived_at",
    "undone_at", "suppressed_at", "at", "updated_at",
})

EXPECTED_ARTIFACTS = (
    "extraction.json",
    "classification.json",
    "statuses.json",
    "served_envelope.json",
    "gateway_facts.json",
)

DETERMINISTIC_PARSERS = ("saga_10_col", "saga_compact_6_col", "generic_4_col",
                         "csv", "pdf_positional")


# ── Normalizer + canonical JSON ────────────────────────────────────────


def normalize(obj: Any) -> Any:
    """Deep-copy `obj` with every VOLATILE_KEYS value replaced by the
    fixed placeholder. Only whitelisted keys are touched — everything
    else must byte-compare."""
    if isinstance(obj, dict):
        return {
            k: (PLACEHOLDER if k in VOLATILE_KEYS and not isinstance(v, (dict, list))
                else normalize(v))
            for k, v in obj.items()
        }
    if isinstance(obj, list):
        return [normalize(v) for v in obj]
    return obj


def canonical_json(obj: Any) -> str:
    return json.dumps(normalize(obj), sort_keys=True, ensure_ascii=False,
                      indent=2, allow_nan=False) + "\n"


def _diff_paths(expected: Any, actual: Any, path: str = "$",
                out: Optional[List[str]] = None, limit: int = 40) -> List[str]:
    """Recursive structural diff — up to `limit` differing JSON paths
    with both values, so a corpus break names the exact field."""
    if out is None:
        out = []
    if len(out) >= limit:
        return out
    if type(expected) is not type(actual):
        out.append("%s: expected %s, actual %s (%r vs %r)" % (
            path, type(expected).__name__, type(actual).__name__,
            expected, actual))
        return out
    if isinstance(expected, dict):
        for k in sorted(set(expected) | set(actual)):
            if k not in expected:
                out.append("%s.%s: unexpected key (actual %r)" % (path, k, actual[k]))
            elif k not in actual:
                out.append("%s.%s: missing key (expected %r)" % (path, k, expected[k]))
            else:
                _diff_paths(expected[k], actual[k], "%s.%s" % (path, k), out, limit)
            if len(out) >= limit:
                break
    elif isinstance(expected, list):
        if len(expected) != len(actual):
            out.append("%s: list length expected %d, actual %d"
                       % (path, len(expected), len(actual)))
        for i, (e, a) in enumerate(zip(expected, actual)):
            _diff_paths(e, a, "%s[%d]" % (path, i), out, limit)
            if len(out) >= limit:
                break
    elif expected != actual:
        out.append("%s: expected %r, actual %r" % (path, expected, actual))
    return out


# ── NO-LIVE-API guards (the ai-sentinel pattern, script form) ──────────


class AiProposeRecorder:
    """Replaces _reconcile._ai_propose: records every invocation, then
    raises — the deterministic auto-reconcile diagnosis treats that as
    'AI unavailable' (honest needs_review), and cases flagged
    `expect_ai_never_consulted` fail the replay if the count is ever
    nonzero."""

    def __init__(self) -> None:
        self.calls = 0

    def __call__(self, cbs: Any) -> Dict[str, Any]:
        self.calls += 1
        raise RuntimeError("corpus-replay: AI proposal path is disabled")


@contextlib.contextmanager
def no_live_api_guard():
    """sys.modules['anthropic'] = None (any real SDK import raises) +
    the _ai_propose recorder, restored on exit."""
    recorder = AiProposeRecorder()
    had_module = "anthropic" in sys.modules
    prior_module = sys.modules.get("anthropic")
    prior_propose = _reconcile._ai_propose
    sys.modules["anthropic"] = None  # type: ignore[assignment]
    _reconcile._ai_propose = recorder
    try:
        yield recorder
    finally:
        _reconcile._ai_propose = prior_propose
        if had_module:
            sys.modules["anthropic"] = prior_module  # type: ignore[assignment]
        else:
            sys.modules.pop("anthropic", None)


@contextlib.contextmanager
def scripted_anthropic_module(response_text: str):
    """The RO-fallback injectable-client seam: a fake `anthropic` module
    whose Anthropic().messages.create returns the canned response. The
    dummy ANTHROPIC_API_KEY satisfies the endpoint's config check; the
    scripted module guarantees the key is never used for anything."""
    calls: List[Dict[str, Any]] = []

    class _Messages:
        def create(self, **kwargs: Any) -> Any:
            calls.append(kwargs)
            return SimpleNamespace(
                content=[SimpleNamespace(type="text", text=response_text)],
                usage=SimpleNamespace(input_tokens=1000, output_tokens=400),
                model="corpus-mock-model",
            )

    class _Anthropic:
        def __init__(self, **_kwargs: Any) -> None:
            self.messages = _Messages()

    fake = ModuleType("anthropic")
    fake.Anthropic = _Anthropic  # type: ignore[attr-defined]
    prior_module = sys.modules.get("anthropic")
    prior_key = os.environ.get("ANTHROPIC_API_KEY")
    sys.modules["anthropic"] = fake
    os.environ["ANTHROPIC_API_KEY"] = "corpus-replay-mock"
    try:
        yield calls
    finally:
        sys.modules["anthropic"] = prior_module  # type: ignore[assignment]
        if prior_key is None:
            os.environ.pop("ANTHROPIC_API_KEY", None)
        else:
            os.environ["ANTHROPIC_API_KEY"] = prior_key


class ScriptedLaneClient:
    """AI-lane fake client (mirrors tests/engine/test_ai_lane.py):
    scripted responses consumed in stage order fmt → extract → classify."""

    def __init__(self, responses: List[str]) -> None:
        self.messages = self._Messages(responses)

    class _Messages:
        def __init__(self, responses: List[str]) -> None:
            self._responses = list(responses)
            self.calls: List[Dict[str, Any]] = []

        def create(self, **kwargs: Any) -> Any:
            self.calls.append(kwargs)
            if not self._responses:
                raise AssertionError("scripted lane client ran out of responses")
            text = self._responses.pop(0)
            return SimpleNamespace(content=[SimpleNamespace(type="text", text=text)])


# ── Fake Supabase admin (the stage_persist test harness) ───────────────


class FakeAdminClient:
    """In-memory stand-in for _supabase.admin()'s client — the same
    surface the reconciliation/ai-lane suites drive stage_persist with
    (select/insert/update/delete on financial_periods + documents +
    statement_line_items)."""

    def __init__(self) -> None:
        self.period_rows: List[Dict[str, Any]] = []
        self.updates: List[Tuple[str, Dict[str, Any], Dict[str, Any]]] = []
        self.inserted_line_items: List[Dict[str, Any]] = []

    def select(self, table: str, *, filters: Optional[Dict[str, Any]] = None,
               columns: str = "*", limit: Optional[int] = None,
               order: Optional[str] = None, single: bool = False):
        if table != "financial_periods":
            return []

        def _matches(row: Dict[str, Any]) -> bool:
            for key, value in (filters or {}).items():
                if not str(value).startswith("eq."):
                    return False
                if str(row.get(key)) != str(value)[3:]:
                    return False
            return True

        return [r for r in self.period_rows if _matches(r)]

    def insert(self, table: str, rows: Any, returning: bool = True):
        rows_list = rows if isinstance(rows, list) else [rows]
        if table == "financial_periods":
            new = dict(rows_list[0])
            new["id"] = "period-1"
            self.period_rows.append(new)
            return [new]
        if table == "statement_line_items":
            self.inserted_line_items.extend(rows_list)
        return rows_list if returning else []

    def update(self, table: str, patch: Dict[str, Any], *,
               filters: Optional[Dict[str, Any]] = None) -> None:
        self.updates.append((table, copy.deepcopy(patch), dict(filters or {})))
        if table == "financial_periods":
            for row in self.period_rows:
                if (filters or {}).get("id") == "eq.%s" % row.get("id"):
                    row.update(copy.deepcopy(patch))

    def delete(self, table: str, *, filters: Optional[Dict[str, Any]] = None) -> None:
        return None


class FakeAdminCtx:
    """Context-manager wrapper for injectable admin factories (the
    ai-lane cache lookup uses `with admin_factory() as client`)."""

    def __init__(self, client: FakeAdminClient) -> None:
        self._client = client

    def __enter__(self) -> FakeAdminClient:
        return self._client

    def __exit__(self, *args: Any) -> bool:
        return False


@contextlib.contextmanager
def fake_persist_seam():
    """Patch pipeline._supabase.admin to the fake for stage_persist."""
    fake = FakeAdminClient()

    @contextlib.contextmanager
    def _fake_admin():
        yield fake

    prior = _pipeline._supabase.admin
    _pipeline._supabase.admin = _fake_admin
    try:
        yield fake
    finally:
        _pipeline._supabase.admin = prior


def run_stage_persist(doc: Dict[str, Any], parsed: Dict[str, Any],
                      assembled: Dict[str, Any]) -> Dict[str, Any]:
    """The REAL pipeline.stage_persist against the fake admin; returns
    the persisted assembled_canonical_v1 envelope (the last write)."""
    with fake_persist_seam() as fake:
        period_id = _pipeline.stage_persist(doc, parsed, assembled)
        if period_id != "period-1":
            raise RuntimeError("stage_persist resolved unexpected period id %r" % period_id)
        envelope_writes = [
            patch["assembled_canonical_v1"]
            for table, patch, _f in fake.updates
            if table == "financial_periods" and "assembled_canonical_v1" in patch
        ]
    if not envelope_writes:
        raise RuntimeError("stage_persist wrote no canonical envelope")
    return envelope_writes[-1]


# ── Case execution ─────────────────────────────────────────────────────


class CaseFailure(Exception):
    pass


def _load_meta(case_dir: Path) -> Dict[str, Any]:
    meta_path = case_dir / "meta.yaml"
    if not meta_path.is_file():
        raise CaseFailure("meta.yaml missing")
    meta = yaml.safe_load(meta_path.read_text(encoding="utf-8"))
    if not isinstance(meta, dict):
        raise CaseFailure("meta.yaml did not parse to a mapping")
    for key in ("jurisdiction", "expected_parser", "period", "source_notes",
                "anonymized"):
        if key not in meta:
            raise CaseFailure("meta.yaml missing required key %r" % key)
    return meta


def _input_path(case_dir: Path) -> Path:
    candidates = sorted(case_dir.glob("input.*"))
    if len(candidates) != 1:
        raise CaseFailure(
            "expected exactly one input.<ext> file, found %d"
            % len(candidates)
        )
    return candidates[0]


def _doc_for(case_id: str, input_path: Path, content: bytes,
             meta: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": "doc-%s" % case_id,
        "org_id": "org-corpus",
        "original_filename": input_path.name,
        "content_hash": "sha256-%s" % hashlib.sha256(content).hexdigest(),
        "period_end_hint": str(meta.get("period_end") or "2025-12-31"),
    }


def _gateway_facts(envelope: Dict[str, Any], currency: str) -> Dict[str, Any]:
    gw = FactsGateway.from_envelope(envelope, currency=currency)
    if gw is None:
        raise CaseFailure("FactsGateway.from_envelope returned None")
    return {
        "tier": gw.tier,
        "currency": currency,
        "equity_cents": gw.equity().amount_minor,
        "total_assets_cents": gw.total_assets().amount_minor,
        "net_result_cents": gw.net_result().amount_minor,
    }


def _statuses(envelope: Dict[str, Any], served: Dict[str, Any]) -> Dict[str, Any]:
    cbs = envelope.get("canonical_bs") or {}
    return {
        "persisted_status": cbs.get("status"),
        "persisted_difference": cbs.get("difference"),
        "served_status": served.get("status"),
        "served_difference": served.get("difference"),
        "needs_review": served.get("needs_review"),
        "reconcile_offer": served.get("reconcile_offer"),
        "status_presentation": served.get("status_presentation"),
        "reconciliation": envelope.get("reconciliation"),
        "reconciliation_auto": envelope.get("reconciliation_auto"),
    }


def _run_deterministic(case_id: str, meta: Dict[str, Any], input_path: Path,
                       content: bytes) -> Tuple[Dict[str, Any], Dict[str, Any],
                                                Dict[str, Any], str]:
    """Deterministic lanes → (extraction, classification, envelope,
    currency). Composition mirrors stage_extract + stage_map through the
    pack's shared seam (assemble_parsed_tb) and the REAL stage_persist."""
    pack = get_pack("RO")
    expected_parser = str(meta["expected_parser"])
    if expected_parser == "csv":
        tb_rows = pack.parse_trial_balance_csv(content, input_path.name)
    else:
        tb_rows = pack.parse_trial_balance(content, input_path.name)
    extraction_block = dict(getattr(tb_rows, "extraction", {}) or {})
    if expected_parser not in ("csv",):
        got = extraction_block.get("source_format")
        if got != expected_parser:
            raise CaseFailure(
                "expected_parser %r but parser detected source_format %r"
                % (expected_parser, got)
            )
    _tb, shaped, assembled = pack.assemble_parsed_tb(
        tb_rows,
        company_name=input_path.stem,
        period_label="Imported period",
    )
    extraction = {
        "extraction": extraction_block,
        "source_anchor": dict(getattr(tb_rows, "source_anchor", {}) or {}),
        "rows": [dict(r) for r in tb_rows],
    }
    classification = {
        "method": "deterministic_coa_mapping",
        "accounts": [dict(a) for a in shaped],
        "unmapped": [dict(u) for u in (getattr(shaped, "unmapped", None) or [])],
        "excluded": [dict(e) for e in (getattr(shaped, "excluded", None) or [])],
    }
    doc = _doc_for(case_id, input_path, content, meta)
    parsed = _pipeline._deterministic_tb_parsed(
        doc, tb_rows, shaped,
        pack.compute_statutory_net_profit_anchor(tb_rows),
        pack.compute_source_imbalance(tb_rows),
    )
    envelope = run_stage_persist(doc, parsed, assembled)
    return extraction, classification, envelope, str(parsed.get("currency") or "RON")


def _run_ro_llm_fallback(case_id: str, meta: Dict[str, Any], input_path: Path,
                         content: bytes) -> Tuple[Dict[str, Any], Dict[str, Any],
                                                  Dict[str, Any], str]:
    """The RO LLM-extraction fallback for a scanned (no-text-layer) PDF:
    the deterministic positional ingester must fail first (as it does in
    stage_extract), the jurisdiction resolver must keep the document in
    the RO lane, then financial_statements.parse_document runs behind
    the scripted `anthropic` module and the result flows through the
    REAL stage_map + stage_persist."""
    pack = get_pack("RO")
    mock_path = input_path.parent / "mock_model_response.json"
    if not mock_path.is_file():
        raise CaseFailure("mock_model_response.json missing")
    response_text = json.loads(mock_path.read_text(encoding="utf-8"))["parse_document"]

    doc = _doc_for(case_id, input_path, content, meta)

    resolution = _lane.resolve_jurisdiction(dict(doc), content)
    if resolution.get("jurisdiction") != "RO":
        raise CaseFailure(
            "scanned PDF resolved %r — expected the RO lane" % resolution
        )

    deterministic_failed = False
    try:
        rows = pack.parse_trial_balance(content, input_path.name)
        deterministic_failed = not rows
    except Exception:  # noqa: BLE001 — ParseError is the expected shape
        deterministic_failed = True
    if not deterministic_failed:
        raise CaseFailure(
            "deterministic PDF ingester parsed the scanned input — the LLM "
            "fallback would never engage"
        )

    from engine.api.financial_statements import ParseRequest, build_router

    router = build_router()
    handler = next(
        (r.endpoint for r in router.routes
         if getattr(r, "name", None) == "parse_document"), None,
    )
    if handler is None:
        raise CaseFailure("financial_statements router missing parse_document")
    with scripted_anthropic_module(response_text) as calls:
        response = handler(ParseRequest(
            pdf_b64=base64.standard_b64encode(content).decode("ascii"),
            original_filename=input_path.name,
        ))
        parsed = response.model_dump() if hasattr(response, "model_dump") else dict(response)
        # PRODUCTION stamp — the SAME helper stage_extract's scanned-PDF
        # branch applies (pipeline._stamp_llm_extraction; integrity fix
        # 2026-08-21, red test tests/engine/test_llm_stamp.py). The replay
        # exercises the shared implementation, never a mirror.
        parsed = _pipeline._stamp_llm_extraction(parsed)
    if len(calls) != 1:
        raise CaseFailure("scripted model expected exactly 1 call, saw %d" % len(calls))

    extraction = {
        "extraction": parsed.get("extraction"),
        "source_anchor": parsed.get("source_anchor"),
        "rows": parsed.get("accounts"),
        "model": parsed.get("model"),
        "confidence": parsed.get("confidence"),
        "detected_type": parsed.get("detected_type"),
        "warnings": parsed.get("warnings"),
    }
    assembled = _pipeline.stage_map(doc, parsed, None)
    classification = {
        "method": "llm_fallback_accounts_via_coa_mapping",
        "accounts": [dict(a) for a in (parsed.get("accounts") or [])],
        "line_items": assembled.get("lineItems"),
        "unmapped": (assembled.get("assembled_canonical_v1") or {}).get("unmapped"),
    }
    envelope = run_stage_persist(doc, parsed, assembled)
    return extraction, classification, envelope, str(parsed.get("currency") or "RON")


def _run_hu_ai_lane(case_id: str, meta: Dict[str, Any], input_path: Path,
                    content: bytes) -> Tuple[Dict[str, Any], Dict[str, Any],
                                             Dict[str, Any], str]:
    """The HU AI lane, fully mocked: deterministic resolver → format
    detect → extract → classify → confidence gating, with the three
    stage responses scripted from the case dir through run_ai_lane's
    injectable client_factory; then the REAL stage_persist."""
    mock_path = input_path.parent / "mock_model_responses.json"
    if not mock_path.is_file():
        raise CaseFailure("mock_model_responses.json missing")
    mocks = json.loads(mock_path.read_text(encoding="utf-8"))
    for stage in ("format_detect", "extract", "classify"):
        if stage not in mocks:
            raise CaseFailure("mock_model_responses.json missing stage %r" % stage)

    doc = _doc_for(case_id, input_path, content, meta)
    resolution = _lane.resolve_jurisdiction(dict(doc), content)
    if resolution.get("jurisdiction") != "HU":
        raise CaseFailure("HU fixture resolved %r" % resolution)

    client = ScriptedLaneClient(
        [mocks["format_detect"], mocks["extract"], mocks["classify"]]
    )
    fake_cache_admin = FakeAdminClient()
    parsed = _lane.run_ai_lane(
        doc=dict(doc),
        file_bytes=content,
        kind=input_path.suffix.lstrip(".").lower() or "csv",
        resolution=resolution,
        client_factory=lambda: client,
        admin_factory=lambda: FakeAdminCtx(fake_cache_admin),
    )
    if len(client.messages.calls) != 3:
        raise CaseFailure(
            "scripted lane client expected exactly 3 calls (fmt/extract/"
            "classify), saw %d" % len(client.messages.calls)
        )
    assembled = parsed["ai_lane"]["assembled"]
    cbs = assembled["assembled_canonical_v1"]["canonical_bs"]
    extraction = {
        "resolution": dict(resolution),
        "extraction": cbs.get("extraction"),
        "source_anchor": cbs.get("source_anchor"),
        # The extract stage's own output rows (the canned response IS the
        # extraction), recorded verbatim for the golden.
        "rows": json.loads(mocks["extract"]).get("rows"),
    }
    classification = {
        "method": "llm_ai_lane",
        "classification": cbs.get("classification"),
        "jurisdiction": cbs.get("jurisdiction"),
        "line_items": assembled.get("lineItems"),
        "unmapped": cbs.get("unmapped"),
    }
    envelope = run_stage_persist(doc, parsed, assembled)
    return extraction, classification, envelope, str(parsed.get("currency") or "EUR")


def _missing_redaction_toolchain(content: bytes, anonymize_tb: Any) -> Optional[str]:
    """Name of the redaction dependency this input would need and that is
    not importable here, else None.

    PDF redaction needs `pikepdf` (a dev extra: it bundles qpdf and is
    deliberately not shipped in the runtime image). Tabular redaction
    needs nothing beyond what the engine already has. Returning a name
    means "this environment cannot re-derive the redaction", never
    "the redaction is wrong".
    """
    try:
        if anonymize_tb.detect_format(content) != "pdf":
            return None
    except Exception:  # noqa: BLE001 — format sniffing must not gate the run
        return None
    return None if importlib.util.find_spec("pikepdf") is not None else "pikepdf"


def _notice(message: str) -> None:
    """Non-blocking operator notice — visible on every run, never a
    failure. Used for capability gaps (a check that cannot run here)
    rather than for verification results, which fail loudly instead."""
    print("NOTICE  %s" % message)


def run_case(case_dir: Path, update: bool = False) -> List[str]:
    """Run one corpus case end-to-end. Returns [] on success or a list
    of failure lines (per-field diff report included)."""
    case_id = case_dir.name
    try:
        meta = _load_meta(case_dir)
        input_path = _input_path(case_dir)
        content = input_path.read_bytes()

        if bool(meta.get("anonymized")):
            import anonymize_tb
            # The anonymization re-derivation is a REPO-HYGIENE check (does
            # re-running the transform still hold the numeric invariants?),
            # not an engine-correctness check. It needs the redaction
            # toolchain — pikepdf for PDF cases — which is a dev extra and
            # is deliberately NOT shipped in the runtime image. Where the
            # toolchain is absent (the in-container replay / nightly prod
            # canary) skip THIS sub-check with a loud notice and keep every
            # engine artifact comparison strict; where it is present (local
            # + CI, which installs .[dev]) it runs and must pass. Only a
            # genuinely missing module skips — a real verification failure
            # still fails the case.
            # Probe the toolchain BEFORE running: pdf_scrambler catches its
            # own ImportError and reports it as a verification failure
            # string, so an exception handler here would never fire, and
            # string-matching the message would be fragile.
            missing = _missing_redaction_toolchain(content, anonymize_tb)
            if missing:
                _notice(
                    "anonymize --verify SKIPPED for %s: redaction toolchain "
                    "absent (%s). Engine artifact comparison still strict; "
                    "this check runs in CI, which installs the dev extras."
                    % (case_id, missing)
                )
                failures = []
            else:
                failures = anonymize_tb.verify_bytes(content)
            if failures:
                return ["[%s] anonymize --verify failed:" % case_id] + [
                    "    ✗ %s" % f for f in failures
                ]

        expected_parser = str(meta["expected_parser"])
        with no_live_api_guard() as recorder:
            if expected_parser in DETERMINISTIC_PARSERS:
                extraction, classification, envelope, currency = _run_deterministic(
                    case_id, meta, input_path, content
                )
            elif expected_parser == "ro_llm_fallback":
                extraction, classification, envelope, currency = _run_ro_llm_fallback(
                    case_id, meta, input_path, content
                )
            elif expected_parser == "hu_ai_lane":
                extraction, classification, envelope, currency = _run_hu_ai_lane(
                    case_id, meta, input_path, content
                )
            else:
                raise CaseFailure("unknown expected_parser %r" % expected_parser)

            served = _reconcile.served_canonical_bs(envelope)
            if not isinstance(served, dict):
                raise CaseFailure("served_canonical_bs returned no object")
            artifacts = {
                "extraction.json": extraction,
                "classification.json": classification,
                "statuses.json": _statuses(envelope, served),
                "served_envelope.json": served,
                "gateway_facts.json": _gateway_facts(envelope, currency),
            }
            if bool(meta.get("expect_ai_never_consulted")) and recorder.calls:
                raise CaseFailure(
                    "meta expects the model client NEVER constructed, but the "
                    "AI proposal path was invoked %d time(s)" % recorder.calls
                )
    except CaseFailure as exc:
        return ["[%s] %s" % (case_id, exc)]
    except Exception as exc:  # noqa: BLE001 — a crash is a case failure
        import traceback
        return ["[%s] crashed: %s: %s" % (case_id, type(exc).__name__, exc),
                "    " + traceback.format_exc().splitlines()[-2].strip()]

    expected_dir = case_dir / "expected"
    failures: List[str] = []
    if update:
        expected_dir.mkdir(exist_ok=True)
        for name in EXPECTED_ARTIFACTS:
            (expected_dir / name).write_text(canonical_json(artifacts[name]),
                                             encoding="utf-8")
        return []

    for name in EXPECTED_ARTIFACTS:
        expected_path = expected_dir / name
        if not expected_path.is_file():
            failures.append("[%s] expected/%s missing — freeze with "
                            "UPDATE_GOLDEN=1" % (case_id, name))
            continue
        actual_text = canonical_json(artifacts[name])
        expected_text = expected_path.read_text(encoding="utf-8")
        if actual_text != expected_text:
            failures.append("[%s] expected/%s DIFFERS:" % (case_id, name))
            try:
                expected_obj = json.loads(expected_text)
                for line in _diff_paths(expected_obj,
                                        json.loads(actual_text)):
                    failures.append("    ✗ %s" % line)
            except Exception:  # noqa: BLE001 — corrupt golden
                failures.append("    ✗ stored golden is not valid JSON")
    return failures


def discover_cases(corpus_root: Path) -> List[Path]:
    return sorted(
        p for p in corpus_root.iterdir()
        if p.is_dir() and not p.name.startswith("_") and (p / "meta.yaml").is_file()
    )


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--corpus-root", default=str(DEFAULT_CORPUS))
    parser.add_argument("--case", action="append", default=None,
                        help="run only this case id (repeatable)")
    args = parser.parse_args(argv)
    update = os.environ.get("UPDATE_GOLDEN") == "1"

    corpus_root = Path(args.corpus_root)
    if not corpus_root.is_dir():
        print("corpus root not found: %s" % corpus_root)
        return 2
    cases = discover_cases(corpus_root)
    if args.case:
        wanted = set(args.case)
        cases = [c for c in cases if c.name in wanted]
        missing = wanted - {c.name for c in cases}
        if missing:
            print("unknown case id(s): %s" % ", ".join(sorted(missing)))
            return 2
    if not cases:
        print("no cases discovered under %s" % corpus_root)
        return 2

    all_failures: List[str] = []
    for case_dir in cases:
        failures = run_case(case_dir, update=update)
        if failures:
            all_failures.extend(failures)
            print("FAIL   %s" % case_dir.name)
            for line in failures:
                print("  %s" % line)
        else:
            print("%s %s" % ("FROZEN" if update else "PASS  ", case_dir.name))

    print()
    if all_failures:
        print("CORPUS REPLAY: FAIL (%d failure line(s) across %d case(s) run)"
              % (len(all_failures), len(cases)))
        return 1
    print("CORPUS REPLAY: %s — %d case(s)"
          % ("GOLDENS WRITTEN" if update else "PASS", len(cases)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
