"""DST harness — the REAL pipeline composition under injectable faults.

The composition driven here is the one ``scripts/corpus_replay.py``
replays and ``pipeline._run_pipeline_sync`` runs in production (financial
branch), stitched from the SAME code objects:

    RomaniaPack.parse_trial_balance[_csv]      (deterministic lanes)
    engine.ai_lane.run_ai_lane                 (HU lane, scripted client)
    pipeline._deterministic_tb_parsed          (parsed payload builder)
    journal hooks on_run_started / on_frontend_done / on_pass_done
    pipeline.stage_map                         (assemble)
    pipeline.stage_persist                     (fake-admin harness;
                                                auto-reconcile + journal
                                                snapshot fire INSIDE it,
                                                at their real seams)
    _reconcile.served_canonical_bs             (serve)
    engine.serving.FactsGateway                (facts)

Injection plumbing (all existing seams — no production file changes):
  · ``journal_env``      scoped ENGINE_JOURNAL_DIR + hooks cache reset;
                         optionally plants a clock-skewed ``Journal``
                         into the hooks cache (the ``clock`` kwarg is a
                         first-class ``Journal.__init__`` seam)
  · ``admin_seam``       patches ``pipeline._supabase.admin`` to yield
                         the harness admin (the corpus-replay /
                         test_reconciliation fake)
  · ``FaultableAdmin``   wraps the fake admin; raises on the Nth write
                         or on a caller predicate (DB error mid-persist,
                         serving-flip write failure)
  · ``ai_guard``         the ai-sentinel: ``_reconcile._ai_propose``
                         replaced by a recording raiser + the
                         ``anthropic`` module made unimportable
  · ``FaultyLaneClient`` the HU lane's injectable ``client_factory``
                         with per-stage fault modes (timeout, malformed
                         JSON with/without recovery, slow drip)
  · ``Patcher``          save/restore attribute patching for the
                         journal-instance store/append faults

Kill semantics: ``SimulatedKill`` raised at a stage boundary aborts the
run; the harness then simulates process death the way
tests/engine/test_crash_safety.py does — the thread-local run context
and the journal cache are dropped, and recovery goes through the REAL
``engine.journal.resume`` machinery.

Baselines are computed journal-OFF (the corpus discipline), so every
comparison in the fault scenarios simultaneously re-proves the hook
contract: journal on, off, or broken — the pipeline result is
byte-identical under the volatile-key normalization.
"""
from __future__ import annotations

import contextlib
import copy
import hashlib
import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from types import ModuleType
from typing import Any, Callable, Dict, Iterator, List, Optional, Tuple

import engine.country_packs.ro_romania  # noqa: F401 — registers RomaniaPack
import engine.ai_lane as _lane
from engine.api import _reconcile
from engine.api import pipeline as _pipeline
from engine.core.country_pack_registry import get_pack
from engine.journal import Journal, canonical_bytes, normalized_envelope, resume_run
from engine.journal import hooks as _hooks
from engine.serving import FactsGateway


def _find_repo_root() -> Path:
    here = Path(__file__).resolve().parent
    for candidate in [here, *here.parents][:6]:
        if (candidate / "pyproject.toml").is_file():
            return candidate
    return Path(__file__).resolve().parents[3]


REPO = _find_repo_root()
CORPUS = REPO / "corpus"

#: Stage boundaries in composition order. ``run_start`` is the arm point
#: BEFORE any hook has fired; ``persist_done`` fires after stage_persist
#: returned. A kill is meaningful at run_started / frontend_done /
#: pass_done (between two stages); arming a store/journal fault at any
#: point affects everything downstream of it.
ARM_POINTS = (
    "run_start",
    "run_started",
    "frontend_done",
    "pass_done",
    "persist_done",
)

#: The kill-able boundaries (between two stages, per the task contract).
BOUNDARIES = ("run_started", "frontend_done", "pass_done")


class SimulatedKill(RuntimeError):
    """Process death injected at a stage boundary (in-process
    simulation: the run stops, the thread-local context and journal
    cache are dropped — recovery must go through the journal)."""


class InvariantViolation(AssertionError):
    """A K-invariant did not hold under an injected fault."""


# ── Fixture registry ───────────────────────────────────────────────────


@dataclass(frozen=True)
class Fixture:
    """One corpus case the harness can drive. ``lane`` selects the
    composition; corpus case inputs are already-published (synthetic /
    anonymized) data, so quarantine artifacts may name them freely."""

    name: str
    lane: str  # "deterministic" | "hu_ai_lane"
    parser: str  # "xlsx" | "csv"

    @property
    def case_dir(self) -> Path:
        return CORPUS / self.name

    @property
    def input_path(self) -> Path:
        candidates = sorted(self.case_dir.glob("input.*"))
        if len(candidates) != 1:
            raise RuntimeError(
                "fixture %s: expected exactly one input.*, found %d"
                % (self.name, len(candidates))
            )
        return candidates[0]

    def read_bytes(self) -> bytes:
        return self.input_path.read_bytes()

    @property
    def size(self) -> int:
        return self.input_path.stat().st_size


#: The fixtures the DST profiles draw from. Deliberately the SMALL
#: corpus cases (each full composition ~0.1 s) — the three deterministic
#: deep-profile fixtures cover: a BALANCED close (csv), an auto-
#: reconciled receipt (rounding_004pct), and a receipt with a named
#: target account (unmapped_equals_delta). ``imbalance_03pct`` adds the
#: above-gate honest MINOR_DRIFT; ``hu_ai_lane`` is the one AI-lane
#: corpus case and carries the canned three-stage model responses.
FIXTURES: Dict[str, Fixture] = {
    f.name: f
    for f in (
        Fixture("csv", "deterministic", "csv"),
        Fixture("exact_zero", "deterministic", "xlsx"),
        Fixture("rounding_004pct", "deterministic", "xlsx"),
        Fixture("unmapped_equals_delta", "deterministic", "xlsx"),
        Fixture("imbalance_03pct", "deterministic", "xlsx"),
        Fixture("hu_ai_lane", "hu_ai_lane", "csv"),
    )
}

#: Deep-profile deterministic fixtures (task: 3 fixtures × every fault ×
#: every boundary). AI-client faults structurally need the AI-lane
#: fixture — documented in explorer.build_matrix.
DEEP_DETERMINISTIC = ("csv", "rounding_004pct", "unmapped_equals_delta")

#: Minimizer preference order — smallest input first.
def minimize_order() -> List[str]:
    names = [n for n, f in FIXTURES.items() if f.lane == "deterministic"]
    return sorted(names, key=lambda n: (FIXTURES[n].size, n))


# ── Save/restore patching (no pytest available inside src) ─────────────


class Patcher:
    """Tiny attribute patcher with guaranteed restore — the DST
    counterpart of pytest's monkeypatch for use inside the harness."""

    def __init__(self) -> None:
        self._saved: List[Tuple[Any, str, Any, bool]] = []

    def setattr(self, obj: Any, name: str, value: Any) -> None:
        had = name in getattr(obj, "__dict__", {})
        prior = getattr(obj, name, None)
        self._saved.append((obj, name, prior, had))
        setattr(obj, name, value)

    def undo(self) -> None:
        while self._saved:
            obj, name, prior, had = self._saved.pop()
            if had:
                setattr(obj, name, prior)
            else:
                try:
                    delattr(obj, name)
                except AttributeError:
                    setattr(obj, name, prior)

    def __enter__(self) -> "Patcher":
        return self

    def __exit__(self, *exc: Any) -> bool:
        self.undo()
        return False


# ── Fake Supabase admin (corpus_replay / test_reconciliation harness) ──


class FakeAdminClient:
    """In-memory stand-in for ``_supabase.admin()``'s client — the same
    surface the reconciliation / crash-safety suites and
    scripts/corpus_replay.py drive ``stage_persist`` with. NOTE: the
    fake's ``delete`` is a no-op (matching the suites), so
    ``inserted_line_items`` accumulates across re-runs — assertions
    about line items must use the period/envelope, not this list."""

    def __init__(self) -> None:
        self.period_rows: List[Dict[str, Any]] = []
        self.updates: List[Tuple[str, Dict[str, Any], Dict[str, Any]]] = []
        self.inserted_line_items: List[Dict[str, Any]] = []
        self._next_period = 1

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
            new["id"] = "period-%d" % self._next_period
            self._next_period += 1
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

    # harness accessors ------------------------------------------------

    def envelope(self) -> Optional[Dict[str, Any]]:
        if not self.period_rows:
            return None
        return self.period_rows[0].get("assembled_canonical_v1")


class FakeAdminCtx:
    """Context-manager wrapper for injectable admin factories (the
    ai-lane cache lookup uses ``with admin_factory() as client``)."""

    def __init__(self, client: Any) -> None:
        self._client = client

    def __enter__(self) -> Any:
        return self._client

    def __exit__(self, *args: Any) -> bool:
        return False


class SimulatedDbError(OSError):
    """The injected DB write failure."""


class FaultableAdmin:
    """Wraps ``FakeAdminClient`` with write-fault injection. Reads pass
    through untouched. A write (insert/update/delete) first increments
    the op counter, then raises ``SimulatedDbError`` when armed — BEFORE
    delegating, so the failed write leaves no partial row state
    (PostgREST single-statement semantics: a failed write is atomic)."""

    def __init__(self) -> None:
        self.inner = FakeAdminClient()
        self.write_ops = 0
        self.fail_on_write_n: Optional[int] = None  # 1-based
        self.fail_predicate: Optional[
            Callable[[str, str, Any], bool]
        ] = None
        self.armed = True
        self.faults_raised = 0

    # -- fault plumbing ------------------------------------------------

    def _maybe_fail(self, op: str, table: str, payload: Any) -> None:
        if not self.armed:
            return
        if self.fail_on_write_n is not None and self.write_ops == self.fail_on_write_n:
            self.faults_raised += 1
            raise SimulatedDbError(
                "simulated DB error on write #%d (%s %s)"
                % (self.write_ops, op, table)
            )
        if self.fail_predicate is not None and self.fail_predicate(op, table, payload):
            self.faults_raised += 1
            raise SimulatedDbError("simulated DB error (%s %s)" % (op, table))

    # -- the client surface --------------------------------------------

    def select(self, table: str, **kwargs: Any):
        return self.inner.select(table, **kwargs)

    def insert(self, table: str, rows: Any, returning: bool = True):
        self.write_ops += 1
        self._maybe_fail("insert", table, rows)
        return self.inner.insert(table, rows, returning=returning)

    def update(self, table: str, patch: Dict[str, Any], *,
               filters: Optional[Dict[str, Any]] = None) -> None:
        self.write_ops += 1
        self._maybe_fail("update", table, patch)
        return self.inner.update(table, patch, filters=filters)

    def delete(self, table: str, *, filters: Optional[Dict[str, Any]] = None) -> None:
        self.write_ops += 1
        self._maybe_fail("delete", table, filters)
        return self.inner.delete(table, filters=filters)

    # -- accessors -----------------------------------------------------

    @property
    def period_rows(self) -> List[Dict[str, Any]]:
        return self.inner.period_rows

    @property
    def updates(self) -> List[Tuple[str, Dict[str, Any], Dict[str, Any]]]:
        return self.inner.updates

    def envelope(self) -> Optional[Dict[str, Any]]:
        return self.inner.envelope()


def envelope_write_predicate(op: str, table: str, payload: Any) -> bool:
    """The serving-flip write: the single ``financial_periods`` update
    that carries ``assembled_canonical_v1``."""
    return (
        op == "update"
        and table == "financial_periods"
        and isinstance(payload, dict)
        and "assembled_canonical_v1" in payload
    )


@contextlib.contextmanager
def admin_seam(admin: Any) -> Iterator[Any]:
    """Patch ``pipeline._supabase.admin`` to yield ``admin`` — the same
    seam every stage_persist test drives."""

    @contextlib.contextmanager
    def _fake_admin() -> Iterator[Any]:
        yield admin

    prior = _pipeline._supabase.admin
    _pipeline._supabase.admin = _fake_admin
    try:
        yield admin
    finally:
        _pipeline._supabase.admin = prior


# ── Journal environment (test-scoped, never the repo data/ tree) ───────


@contextlib.contextmanager
def journal_env(
    root: Optional[Path],
    *,
    clock: Optional[Callable[[], Any]] = None,
) -> Iterator[Optional[Journal]]:
    """Scope ENGINE_JOURNAL_DIR to ``root`` (None = journal OFF) and
    reset the hooks cache on entry AND exit, so no DST run can leak a
    journal into another test or into the corpus/determinism gates.

    ``clock`` (when given) exercises ``Journal.__init__``'s injectable
    clock through the REAL hook path: the skewed instance is planted in
    the hooks cache under the exact root key ``journal_from_env`` will
    look up — the documented test seam next to ``hooks.reset_cache``.
    """
    prior = os.environ.get(_hooks.ENV_VAR)
    _hooks.reset_cache()
    journal: Optional[Journal] = None
    try:
        if root is None:
            os.environ.pop(_hooks.ENV_VAR, None)
        else:
            os.environ[_hooks.ENV_VAR] = str(root)
            journal = Journal(root, clock=clock) if clock else Journal(root)
            with _hooks._JOURNAL_CACHE_LOCK:
                _hooks._JOURNAL_CACHE[str(root)] = journal
        yield journal
    finally:
        if prior is None:
            os.environ.pop(_hooks.ENV_VAR, None)
        else:
            os.environ[_hooks.ENV_VAR] = prior
        _hooks.reset_cache()


def simulate_process_death() -> None:
    """What a SIGKILL leaves behind, in-process: no thread-local run
    context, no warm journal cache. (The files already on disk are the
    crash's survivors — exactly what resume works from.)"""
    _hooks.set_active_run(None)
    _hooks.reset_cache()


# ── AI containment + scripted lane clients ─────────────────────────────


class AiProposeRecorder:
    """Replaces ``_reconcile._ai_propose``: records every invocation and
    raises — the auto-reconcile stage maps that to an honest
    needs_review. On deterministic corpus fixtures the count MUST stay 0
    (the corpus meta pins ``expect_ai_never_consulted``)."""

    def __init__(self) -> None:
        self.calls = 0

    def __call__(self, cbs: Any) -> Dict[str, Any]:
        self.calls += 1
        raise RuntimeError("DST: AI proposal path is disabled")


@contextlib.contextmanager
def ai_guard() -> Iterator[AiProposeRecorder]:
    """The ai-sentinel (corpus_replay / property-suite pattern):
    ``sys.modules['anthropic'] = None`` so any real SDK import raises,
    ANTHROPIC_API_KEY stripped, ``_ai_propose`` replaced by a recording
    raiser. Restored on exit."""
    import sys

    recorder = AiProposeRecorder()
    had_module = "anthropic" in sys.modules
    prior_module = sys.modules.get("anthropic")
    prior_propose = _reconcile._ai_propose
    prior_key = os.environ.get("ANTHROPIC_API_KEY")
    sys.modules["anthropic"] = None  # type: ignore[assignment]
    _reconcile._ai_propose = recorder
    os.environ.pop("ANTHROPIC_API_KEY", None)
    try:
        yield recorder
    finally:
        _reconcile._ai_propose = prior_propose
        if had_module:
            sys.modules["anthropic"] = prior_module  # type: ignore[assignment]
        else:
            sys.modules.pop("anthropic", None)
        if prior_key is not None:
            os.environ["ANTHROPIC_API_KEY"] = prior_key


class ScriptedLaneClient:
    """AI-lane fake client (mirrors tests/engine/test_ai_lane.py and the
    corpus replay): scripted responses consumed in stage order
    format_detect → extract → classify."""

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
            return _text_response(text)


def _text_response(text: str) -> Any:
    from types import SimpleNamespace

    return SimpleNamespace(content=[SimpleNamespace(type="text", text=text)])


class FaultyLaneClient:
    """The HU lane's injectable ``client_factory`` with per-STAGE fault
    modes. Stage index advances only when a call returned parseable JSON
    (the lane retries malformed JSON once against the same stage), so a
    directive stays aimed at its stage across the retry.

    Modes per stage:
      "ok"                  canned response
      "timeout"             raise TimeoutError (transport errors are not
                            retried by the lane — immediate AiLaneError)
      "malformed"           return non-JSON garbage on EVERY attempt
                            (the lane's single retry also fails →
                            AiLaneError, run dead-letters)
      "malformed_once"      garbage on attempt 1, canned response on the
                            retry (run completes; the audit trail
                            records the extra attempt)
      "slow"                sleep ``delay_s`` then canned response
    """

    STAGES = ("format_detect", "extract", "classify")

    def __init__(
        self,
        responses: List[str],
        *,
        modes: Optional[Dict[int, str]] = None,
        delay_s: float = 0.0,
    ) -> None:
        self._responses = list(responses)
        self._modes = dict(modes or {})
        self._delay_s = delay_s
        self._stage_idx = 0
        self._attempts_this_stage = 0
        self.total_calls = 0
        self.messages = self._Messages(self)

    class _Messages:
        def __init__(self, outer: "FaultyLaneClient") -> None:
            self._outer = outer
            self.calls: List[Dict[str, Any]] = []

        def create(self, **kwargs: Any) -> Any:
            self.calls.append(kwargs)
            return self._outer._create()

    def _create(self) -> Any:
        self.total_calls += 1
        idx = self._stage_idx
        if idx >= len(self._responses):
            raise AssertionError("FaultyLaneClient called past the last stage")
        mode = self._modes.get(idx, "ok")
        self._attempts_this_stage += 1
        if mode == "timeout":
            raise TimeoutError(
                "simulated model timeout at stage %s" % self.STAGES[idx]
            )
        if mode == "malformed":
            return _text_response("{ this is NOT json — simulated garbage")
        if mode == "malformed_once" and self._attempts_this_stage == 1:
            return _text_response("{ this is NOT json — first attempt garbage")
        if mode == "slow" and self._delay_s > 0:
            time.sleep(self._delay_s)
        text = self._responses[idx]
        self._stage_idx += 1
        self._attempts_this_stage = 0
        return _text_response(text)


def hu_mock_responses(fixture: Fixture) -> List[str]:
    mock_path = fixture.case_dir / "mock_model_responses.json"
    mocks = json.loads(mock_path.read_text(encoding="utf-8"))
    return [mocks["format_detect"], mocks["extract"], mocks["classify"]]


# ── The composition runners ────────────────────────────────────────────


@dataclass
class DstRunResult:
    outcome: str  # "completed" | "killed" | "failed"
    doc: Dict[str, Any]
    file_hash: str
    period_id: Optional[str] = None
    error_type: Optional[str] = None
    error_message: Optional[str] = None
    served: Optional[Dict[str, Any]] = None
    facts: Optional[Dict[str, Any]] = None
    ai_propose_calls: int = 0
    boundaries_hit: List[str] = field(default_factory=list)


def doc_for(fixture: Fixture, content: bytes, *, doc_id: Optional[str] = None) -> Dict[str, Any]:
    return {
        "id": doc_id or ("doc-dst-%s" % fixture.name),
        "org_id": "org-dst",
        "original_filename": fixture.input_path.name,
        "content_hash": "sha256-%s" % hashlib.sha256(content).hexdigest(),
        "period_end_hint": "2025-12-31",
    }


def _gateway_facts(envelope: Dict[str, Any], currency: str) -> Optional[Dict[str, Any]]:
    gw = FactsGateway.from_envelope(envelope, currency=currency)
    if gw is None:
        return None
    return {
        "tier": gw.tier,
        "currency": currency,
        "equity_cents": gw.equity().amount_minor,
        "total_assets_cents": gw.total_assets().amount_minor,
        "net_result_cents": gw.net_result().amount_minor,
    }


BoundaryHook = Callable[[str], None]


def run_deterministic(
    fixture: Fixture,
    *,
    admin: Any,
    at_boundary: Optional[BoundaryHook] = None,
    doc_id: Optional[str] = None,
) -> DstRunResult:
    """One deterministic-lane run under the ACTIVE journal env. Faults
    arrive through ``at_boundary`` (raise ``SimulatedKill`` / install
    patches) and through the ``admin`` itself. Exception handling
    mirrors ``_run_pipeline_sync``: any stage exception → the blanket
    handler → ``on_run_failed`` (dead-letter); a SimulatedKill is a
    process death — no handler runs at all."""
    if fixture.lane != "deterministic":
        raise ValueError("run_deterministic on lane %r" % fixture.lane)
    pack = get_pack("RO")
    content = fixture.read_bytes()
    doc = doc_for(fixture, content, doc_id=doc_id)
    result = DstRunResult(outcome="completed", doc=doc, file_hash=doc["content_hash"])

    def _b(name: str) -> None:
        result.boundaries_hit.append(name)
        if at_boundary is not None:
            at_boundary(name)

    with ai_guard() as recorder:
        with admin_seam(admin):
            try:
                _b("run_start")
                _hooks.on_run_started(doc, industry=None)
                _b("run_started")
                if fixture.parser == "csv":
                    tb_rows = pack.parse_trial_balance_csv(
                        content, fixture.input_path.name
                    )
                else:
                    tb_rows = pack.parse_trial_balance(
                        content, fixture.input_path.name
                    )
                shaped = pack.accounts_to_assemble_shape(tb_rows)
                parsed = _pipeline._deterministic_tb_parsed(
                    doc, tb_rows, shaped,
                    pack.compute_statutory_net_profit_anchor(tb_rows),
                    pack.compute_source_imbalance(tb_rows),
                )
                _hooks.on_frontend_done(doc, parsed)
                _b("frontend_done")
                assembled = _pipeline.stage_map(doc, copy.deepcopy(parsed), None)
                _hooks.on_pass_done(doc, assembled)
                _b("pass_done")
                period_id = _pipeline.stage_persist(
                    doc, copy.deepcopy(parsed), assembled
                )
                result.period_id = period_id
                _b("persist_done")
                envelope = admin.envelope()
                if isinstance(envelope, dict):
                    result.served = _reconcile.served_canonical_bs(envelope)
                    result.facts = _gateway_facts(envelope, "RON")
                _hooks.set_active_run(None)  # run finished; clear context
            except SimulatedKill:
                result.outcome = "killed"
                simulate_process_death()
            except Exception as exc:  # noqa: BLE001 — the orchestrator's blanket handler
                result.outcome = "failed"
                result.error_type = type(exc).__name__
                result.error_message = str(exc)
                _hooks.on_run_failed(doc["id"], exc)
        result.ai_propose_calls = recorder.calls
    return result


def run_hu_lane(
    fixture: Fixture,
    *,
    admin: Any,
    client: Any,
    at_boundary: Optional[BoundaryHook] = None,
    doc_id: Optional[str] = None,
) -> DstRunResult:
    """One HU AI-lane run (scripted client — never a live call) under
    the active journal env, composed exactly like the orchestrator's
    ai-lane branch: resolver → run_ai_lane (client_factory seam) →
    on_frontend_done → assembled from the lane → on_pass_done →
    stage_persist."""
    if fixture.lane != "hu_ai_lane":
        raise ValueError("run_hu_lane on lane %r" % fixture.lane)
    content = fixture.read_bytes()
    doc = doc_for(fixture, content, doc_id=doc_id)
    result = DstRunResult(outcome="completed", doc=doc, file_hash=doc["content_hash"])
    cache_admin = FakeAdminClient()

    def _b(name: str) -> None:
        result.boundaries_hit.append(name)
        if at_boundary is not None:
            at_boundary(name)

    with ai_guard() as recorder:
        with admin_seam(admin):
            try:
                _b("run_start")
                resolution = _lane.resolve_jurisdiction(dict(doc), content)
                if resolution.get("jurisdiction") != "HU":
                    raise RuntimeError(
                        "HU fixture resolved %r" % (resolution,)
                    )
                _hooks.on_run_started(doc, industry=None)
                _b("run_started")
                parsed = _lane.run_ai_lane(
                    doc=dict(doc),
                    file_bytes=content,
                    kind=fixture.input_path.suffix.lstrip(".").lower() or "csv",
                    resolution=resolution,
                    client_factory=lambda: client,
                    admin_factory=lambda: FakeAdminCtx(cache_admin),
                )
                _hooks.on_frontend_done(doc, parsed)
                _b("frontend_done")
                assembled = (parsed.get("ai_lane") or {}).get("assembled") or {}
                _hooks.on_pass_done(doc, assembled)
                _b("pass_done")
                period_id = _pipeline.stage_persist(doc, parsed, assembled)
                result.period_id = period_id
                _b("persist_done")
                envelope = admin.envelope()
                if isinstance(envelope, dict):
                    result.served = _reconcile.served_canonical_bs(envelope)
                    result.facts = _gateway_facts(
                        envelope, str(parsed.get("currency") or "EUR")
                    )
                _hooks.set_active_run(None)
            except SimulatedKill:
                result.outcome = "killed"
                simulate_process_death()
            except Exception as exc:  # noqa: BLE001 — the orchestrator's blanket handler
                result.outcome = "failed"
                result.error_type = type(exc).__name__
                result.error_message = str(exc)
                _hooks.on_run_failed(doc["id"], exc)
        result.ai_propose_calls = recorder.calls
    return result


def run_fixture(
    fixture: Fixture,
    *,
    admin: Any,
    at_boundary: Optional[BoundaryHook] = None,
    doc_id: Optional[str] = None,
    client: Optional[Any] = None,
) -> DstRunResult:
    """Lane-dispatching runner (HU lane builds a fresh healthy scripted
    client when none is supplied)."""
    if fixture.lane == "hu_ai_lane":
        the_client = client or ScriptedLaneClient(hu_mock_responses(fixture))
        return run_hu_lane(
            fixture, admin=admin, client=the_client,
            at_boundary=at_boundary, doc_id=doc_id,
        )
    return run_deterministic(
        fixture, admin=admin, at_boundary=at_boundary, doc_id=doc_id
    )


def resume_latest(journal: Journal, file_hash: str, admin: Any) -> Dict[str, Any]:
    """Resume the LAST registered run of the chain through the REAL
    resume machinery, persisting into ``admin``."""
    runs = journal.registered_runs(file_hash)
    if not runs:
        raise RuntimeError("no registered runs for chain %s" % file_hash)
    run_id = str(runs[-1]["run_id"])
    with admin_seam(admin):
        return resume_run(journal, run_id)


# ── Normalization + baseline ───────────────────────────────────────────


def norm_bytes(envelope: Dict[str, Any]) -> bytes:
    """Volatile-normalized canonical bytes — what byte-identity means
    for envelopes (the corpus-replay discipline)."""
    data, _lossy = canonical_bytes(normalized_envelope(envelope))
    return data


def norm_without_audit(envelope: Dict[str, Any]) -> bytes:
    """Normalized bytes with ``ai_audit`` stripped — for the malformed-
    then-recovers AI fault, where the audit trail HONESTLY records the
    extra attempt and everything else must stay byte-identical."""
    clipped = copy.deepcopy(envelope)
    clipped.pop("ai_audit", None)
    return norm_bytes(clipped)


@dataclass(frozen=True)
class Baseline:
    fixture: str
    envelope: Dict[str, Any]
    norm: bytes
    served_status: Optional[str]
    needs_review: Optional[bool]
    facts: Optional[Dict[str, Any]]
    has_receipt: bool
    history_len: int
    audit_attempts: int


_BASELINES: Dict[str, Baseline] = {}


def baseline_for(fixture_name: str) -> Baseline:
    """The fault-free reference run, computed JOURNAL-OFF (the corpus
    discipline) and memoized per process. Every fault scenario compares
    against this, which also re-proves the hook contract (journal on /
    off / broken ⇒ identical pipeline result)."""
    cached = _BASELINES.get(fixture_name)
    if cached is not None:
        return cached
    fixture = FIXTURES[fixture_name]
    admin = FaultableAdmin()
    with journal_env(None):
        result = run_fixture(fixture, admin=admin)
    if result.outcome != "completed":
        raise RuntimeError(
            "baseline run for %s did not complete: %s %s"
            % (fixture_name, result.error_type, result.error_message)
        )
    envelope = admin.envelope()
    if not isinstance(envelope, dict):
        raise RuntimeError("baseline run for %s wrote no envelope" % fixture_name)
    audit = envelope.get("ai_audit") or {}
    stages = audit.get("stages") if isinstance(audit, dict) else None
    baseline = Baseline(
        fixture=fixture_name,
        envelope=copy.deepcopy(envelope),
        norm=norm_bytes(envelope),
        served_status=(result.served or {}).get("status"),
        needs_review=(result.served or {}).get("needs_review"),
        facts=result.facts,
        has_receipt=isinstance(envelope.get("reconciliation"), dict),
        history_len=len(envelope.get("reconciliation_history") or []),
        audit_attempts=len(stages or []),
    )
    _BASELINES[fixture_name] = baseline
    return baseline


# ── Small assertion helpers shared by scenarios and tests ──────────────


def check(condition: Any, message: str) -> None:
    if not condition:
        raise InvariantViolation(message)


def snapshot_events(journal: Journal, file_hash: str) -> List[Dict[str, Any]]:
    return journal.snapshots(file_hash)


def every_snapshot_object_present(journal: Journal, file_hash: str) -> bool:
    """K2's journal half: an event without its (verifiable) object is
    never allowed — the ordering rule's observable."""
    for event in journal.snapshots(file_hash):
        digest = (event.get("payload") or {}).get("content_hash")
        if not digest or not journal.store.has(str(digest)):
            return False
        try:
            journal.store.read_object(str(digest))
        except Exception:  # noqa: BLE001 — corrupt counts as absent
            return False
    return True
