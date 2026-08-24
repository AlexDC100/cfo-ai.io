"""Run tracing — one trace per pipeline run, spans per stage (engine.obs).

HOW IT SUBSCRIBES (the zero-new-pipeline-lines contract): the pipeline
already calls ``engine.journal.hooks.on_*`` at every stage boundary
(RUN_STARTED → FRONTEND_DONE → PASS_DONE → RECONCILE → SNAPSHOT →
SERVED / FAILED). :func:`install` decorates those module-level hook
functions in place — the original hook runs first, byte-for-byte
unchanged, then the tracer derives a span from the same arguments. No
new seam exists in pipeline.py; the journal being ON or OFF is
irrelevant (the hooks are always called; only their journal half is
env-gated).

ACTIVATION — ``ENGINE_OBS_TRACE`` (default unset == fully inert):
    memory | 1 | true   in-process recorder only (ring buffer, no deps)
    console             + OpenTelemetry ConsoleSpanExporter (needs the
                          optional ``obs`` extra; degrades to memory)
    otlp                + OTLP/HTTP exporter (endpoint from
                          ``OTEL_EXPORTER_OTLP_ENDPOINT`` or
                          ``ENGINE_OBS_OTLP_ENDPOINT``, default
                          http://localhost:4318; degrades to memory)

OpenTelemetry is OPTIONAL (``pip install .[obs]``). Every import is
guarded; when the SDK is missing the memory recorder still works and a
one-time notice is logged. Zero external dependency to RUN — the
recorder is stdlib only.

SPAN MODEL (attributes mirror the journal event payloads):
    pipeline.run   root — run_id, file_hash, document_id, industry,
                   engine_version, ai.model.<role> ids
    stage.extract  front_end_id, ir_hash, cache_hit, detected_type
    stage.map      layer_hash, pack_hash
    stage.reconcile outcome, diagnosis_code, origin
    stage.persist  period_id, status, ai model (closes the root)
    serve.observe  independent span at the serve seam
    run.failed     error_type/message (closes the root, status=error)

Timing: wall-clock at hook invocation — stage span N runs from the
previous hook's timestamp to now, on the pipeline's own thread (the
production pipeline is thread-per-upload; state is thread-local exactly
like the journal's run context).

FAILURE POLICY: the wrapper NEVER raises and NEVER mutates arguments —
any tracing fault is logged and swallowed; hook return values pass
through untouched. When tracing is disabled the wrapper is two attribute
reads and a call — no hashing, no imports, no allocation.
"""
from __future__ import annotations

import functools
import logging
import os
import threading
import time
import uuid
from collections import deque
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger("engine.obs.tracing")

#: Activation env var (see module docstring). Unset == inert.
ENABLE_ENV = "ENGINE_OBS_TRACE"

#: OTLP endpoint override (ENGINE_OBS_OTLP_ENDPOINT wins, then the
#: standard OTEL_EXPORTER_OTLP_ENDPOINT, then the OTLP/HTTP default).
OTLP_ENDPOINT_ENV = "ENGINE_OBS_OTLP_ENDPOINT"

#: Ring-buffer size of the in-process recorder.
MAX_RECORDED_SPANS = 512

_MEMORY_MODES = ("memory", "1", "true", "yes", "on")
_EXPORT_MODES = ("console", "otlp")

_HOOK_NAMES = (
    "on_run_started",
    "on_frontend_done",
    "on_pass_done",
    "on_reconcile_outcome",
    "on_snapshot_persisted",
    "on_served",
    "on_run_failed",
)

_WRAP_MARK = "_engine_obs_wrapped"

_TLS = threading.local()
_LOCK = threading.Lock()
_SPANS: "deque[Dict[str, Any]]" = deque(maxlen=MAX_RECORDED_SPANS)
_INSTALLED = False
_ORIGINALS: Dict[str, Callable[..., Any]] = {}

# OTel bridge state (built lazily, once per process; never required).
_OTEL_TRACER: Optional[Any] = None
_OTEL_MODE: Optional[str] = None
_OTEL_NOTICE_LOGGED = False

#: Test seam — set True to force the "SDK unavailable" degrade path
#: even when opentelemetry is importable.
_otel_disabled_for_tests = False


def mode() -> str:
    """The active tracing mode ('' when disabled)."""
    return (os.environ.get(ENABLE_ENV) or "").strip().lower()


def enabled() -> bool:
    return mode() in _MEMORY_MODES + _EXPORT_MODES


def recent_spans() -> List[Dict[str, Any]]:
    """Finished spans from the in-process recorder (oldest first)."""
    with _LOCK:
        return list(_SPANS)


def reset_for_tests() -> None:
    """Drop recorded spans + any half-open run state (test seam)."""
    global _OTEL_TRACER, _OTEL_MODE, _OTEL_NOTICE_LOGGED
    with _LOCK:
        _SPANS.clear()
    _TLS.run = None
    _OTEL_TRACER = None
    _OTEL_MODE = None
    _OTEL_NOTICE_LOGGED = False


# ── OTel bridge (optional; every import guarded) ───────────────────────


def _otel_tracer() -> Optional[Any]:
    """A configured OTel tracer for the current export mode, or None
    (mode is memory-only, the SDK is not installed, or setup failed).
    Built once; a mode change after first use needs a process restart
    (documented, keeps this allocation-free on the hot path)."""
    global _OTEL_TRACER, _OTEL_MODE, _OTEL_NOTICE_LOGGED
    m = mode()
    if m not in _EXPORT_MODES:
        return None
    if _OTEL_MODE == m:
        return _OTEL_TRACER
    if _otel_disabled_for_tests:
        _OTEL_MODE, _OTEL_TRACER = m, None
        if not _OTEL_NOTICE_LOGGED:
            _OTEL_NOTICE_LOGGED = True
            logger.info("[obs.trace] OTel disabled for tests — memory recorder only")
        return None
    try:
        from opentelemetry import trace as _trace
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import SimpleSpanProcessor

        if m == "console":
            from opentelemetry.sdk.trace.export import ConsoleSpanExporter

            exporter = ConsoleSpanExporter()
        else:  # otlp
            from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
                OTLPSpanExporter,
            )

            endpoint = (
                os.environ.get(OTLP_ENDPOINT_ENV)
                or os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
                or "http://localhost:4318"
            )
            exporter = OTLPSpanExporter(
                endpoint=endpoint.rstrip("/") + "/v1/traces"
            )
        provider = TracerProvider(
            resource=Resource.create({"service.name": "scandia-engine"})
        )
        provider.add_span_processor(SimpleSpanProcessor(exporter))
        _OTEL_TRACER = provider.get_tracer("engine.obs.tracing")
        _OTEL_MODE = m
        logger.info("[obs.trace] OpenTelemetry export active (mode=%s)", m)
        return _OTEL_TRACER
    except Exception as exc:  # noqa: BLE001 — SDK absent or misconfigured
        _OTEL_TRACER, _OTEL_MODE = None, m
        if not _OTEL_NOTICE_LOGGED:
            _OTEL_NOTICE_LOGGED = True
            logger.info(
                "[obs.trace] OpenTelemetry unavailable (%s) — in-memory "
                "recorder only. Install the optional extra: pip install "
                "'.[obs]'",
                exc,
            )
        return None


# ── run state + span emission ──────────────────────────────────────────


def _run_state() -> Optional[Dict[str, Any]]:
    return getattr(_TLS, "run", None)


def _emit(
    name: str,
    start: float,
    end: float,
    attributes: Dict[str, Any],
    *,
    trace_id: str,
    parent_id: Optional[str],
    status: str = "ok",
    span_id: Optional[str] = None,
) -> Dict[str, Any]:
    span = {
        "trace_id": trace_id,
        # The root passes its pre-allocated id (children referenced it as
        # parent_id while the run was still open); stage spans mint one.
        "span_id": span_id or uuid.uuid4().hex[:16],
        "parent_id": parent_id,
        "name": name,
        "start": start,
        "end": end,
        "duration_ms": round((end - start) * 1000.0, 3),
        "status": status,
        "attributes": {k: v for k, v in attributes.items() if v is not None},
    }
    with _LOCK:
        _SPANS.append(span)
    tracer = _otel_tracer()
    if tracer is not None:
        try:
            from opentelemetry import trace as _trace

            state = _run_state()
            ctx = None
            if state is not None and state.get("otel_root") is not None:
                ctx = _trace.set_span_in_context(state["otel_root"])
            otel_span = tracer.start_span(
                name, context=ctx, start_time=int(start * 1e9)
            )
            for key, value in span["attributes"].items():
                otel_span.set_attribute(key, value)
            if status != "ok":
                from opentelemetry.trace import Status, StatusCode

                otel_span.set_status(Status(StatusCode.ERROR))
            otel_span.end(end_time=int(end * 1e9))
        except Exception:  # noqa: BLE001 — export is best-effort
            logger.debug("[obs.trace] OTel span emit failed", exc_info=True)
    return span


def _content_hash_of(obj: Any) -> Optional[str]:
    """Same digest the journal's object store would assign (canonical
    JSON bytes → sha256) — computed independently so spans carry
    ir/layer hashes even when the journal is disabled."""
    try:
        from engine.journal.events import content_hash

        digest, _lossy = content_hash(obj)
        return digest
    except Exception:  # noqa: BLE001
        return None


def _registry_model_attrs() -> Dict[str, Any]:
    try:
        from engine.ai import registry as _registry

        return {
            "ai.model.%s" % role: params.get("model_id")
            for role, params in _registry.load_registry().items()
        }
    except Exception:  # noqa: BLE001 — registry trouble never breaks a run
        return {}


def _journal_run_id() -> Optional[str]:
    try:
        from engine.journal import hooks as _hooks

        handle = _hooks.active_run()
        return getattr(handle, "run_id", None)
    except Exception:  # noqa: BLE001
        return None


def _begin_run(doc: Any, industry: Optional[str]) -> None:
    doc = doc if isinstance(doc, dict) else {}
    now = time.time()
    trace_id = _journal_run_id() or uuid.uuid4().hex
    state: Dict[str, Any] = {
        "trace_id": trace_id,
        "root_span_id": uuid.uuid4().hex[:16],
        "started": now,
        "last_ts": now,
        "otel_root": None,
        "root_attrs": {
            "run_id": trace_id,
            "file_hash": doc.get("content_hash"),
            "document_id": doc.get("id"),
            "original_filename": doc.get("original_filename"),
            "industry": industry,
        },
    }
    state["root_attrs"].update(_registry_model_attrs())
    tracer = _otel_tracer()
    if tracer is not None:
        try:
            root = tracer.start_span("pipeline.run", start_time=int(now * 1e9))
            for key, value in state["root_attrs"].items():
                if value is not None:
                    root.set_attribute(key, value)
            state["otel_root"] = root
        except Exception:  # noqa: BLE001
            logger.debug("[obs.trace] OTel root span failed", exc_info=True)
    _TLS.run = state


def _stage_span(name: str, attributes: Dict[str, Any]) -> None:
    state = _run_state()
    now = time.time()
    if state is None:
        # Out-of-band call (e.g. reanalyze path) — record a standalone span.
        _emit(name, now, now, attributes, trace_id=uuid.uuid4().hex, parent_id=None)
        return
    _emit(
        name,
        state["last_ts"],
        now,
        attributes,
        trace_id=state["trace_id"],
        parent_id=state["root_span_id"],
    )
    state["last_ts"] = now


def _end_run(status: str, attributes: Dict[str, Any]) -> None:
    state = _run_state()
    if state is None:
        return
    now = time.time()
    attrs = dict(state["root_attrs"])
    attrs.update(attributes)
    _emit(
        "pipeline.run",
        state["started"],
        now,
        attrs,
        trace_id=state["trace_id"],
        parent_id=None,
        status=status,
        span_id=state["root_span_id"],
    )
    root = state.get("otel_root")
    if root is not None:
        try:
            if status != "ok":
                from opentelemetry.trace import Status, StatusCode

                root.set_status(Status(StatusCode.ERROR))
            root.end(end_time=int(now * 1e9))
        except Exception:  # noqa: BLE001
            logger.debug("[obs.trace] OTel root end failed", exc_info=True)
    _TLS.run = None


# ── per-hook derivations (mirror engine.journal.hooks payloads) ────────


def _after_run_started(args: tuple, kwargs: dict) -> None:
    doc = args[0] if args else kwargs.get("doc")
    industry = args[1] if len(args) > 1 else kwargs.get("industry")
    _begin_run(doc, industry)


def _after_frontend_done(args: tuple, kwargs: dict) -> None:
    parsed = args[1] if len(args) > 1 else kwargs.get("parsed")
    parsed = parsed if isinstance(parsed, dict) else {}
    extraction = parsed.get("extraction")
    extraction = extraction if isinstance(extraction, dict) else {}
    ai_lane = parsed.get("ai_lane")
    ai_lane = ai_lane if isinstance(ai_lane, dict) else {}
    _stage_span(
        "stage.extract",
        {
            "front_end_id": (
                extraction.get("source_format")
                or parsed.get("detected_type")
                or "unknown"
            ),
            "detected_type": parsed.get("detected_type"),
            "extraction_method": extraction.get("method"),
            "ir_hash": _content_hash_of(parsed),
            "cache_hit": bool(ai_lane.get("cached")),
        },
    )


def _after_pass_done(args: tuple, kwargs: dict) -> None:
    assembled = args[1] if len(args) > 1 else kwargs.get("assembled")
    assembled = assembled if isinstance(assembled, dict) else {}
    canonical = assembled.get("assembled_canonical_v1")
    canonical = canonical if isinstance(canonical, dict) else {}
    pack_prov = canonical.get("pack_provenance")
    pack_prov = pack_prov if isinstance(pack_prov, dict) else {}
    _stage_span(
        "stage.map",
        {
            "layer_hash": _content_hash_of(assembled),
            "pack_hash": pack_prov.get("pack_hash"),
            "pack_id": pack_prov.get("pack_id"),
        },
    )


def _after_reconcile_outcome(args: tuple, kwargs: dict) -> None:
    period_id = args[1] if len(args) > 1 else kwargs.get("period_id")
    auto_result = args[3] if len(args) > 3 else kwargs.get("auto_result")
    auto_result = auto_result if isinstance(auto_result, dict) else {}
    _stage_span(
        "stage.reconcile",
        {
            "period_id": str(period_id) if period_id is not None else None,
            "outcome": auto_result.get("outcome"),
            "diagnosis_code": auto_result.get("diagnosis_code"),
            "origin": auto_result.get("origin"),
        },
    )


def _after_snapshot_persisted(args: tuple, kwargs: dict) -> None:
    period_id = args[1] if len(args) > 1 else kwargs.get("period_id")
    canonical = args[2] if len(args) > 2 else kwargs.get("canonical")
    canonical = canonical if isinstance(canonical, dict) else {}
    cbs = canonical.get("canonical_bs")
    cbs = cbs if isinstance(cbs, dict) else {}
    audit = canonical.get("ai_audit")
    audit = audit if isinstance(audit, dict) else {}
    _stage_span(
        "stage.persist",
        {
            "period_id": str(period_id) if period_id is not None else None,
            "status": cbs.get("status"),
            "ai_model": audit.get("model"),
        },
    )
    _end_run("ok", {"final_status": cbs.get("status")})


def _after_served(args: tuple, kwargs: dict) -> None:
    served_cbs = args[1] if len(args) > 1 else kwargs.get("served_cbs")
    served_cbs = served_cbs if isinstance(served_cbs, dict) else {}
    now = time.time()
    _emit(
        "serve.observe",
        now,
        now,
        {"envelope_version": served_cbs.get("envelope_version")},
        trace_id=uuid.uuid4().hex,
        parent_id=None,
    )


def _after_run_failed(args: tuple, kwargs: dict) -> None:
    document_id = args[0] if args else kwargs.get("document_id")
    exc = args[1] if len(args) > 1 else kwargs.get("exc")
    _end_run(
        "error",
        {
            "document_id": str(document_id) if document_id is not None else None,
            "error_type": type(exc).__name__ if exc is not None else None,
            "error_message": str(exc)[:500] if exc is not None else None,
        },
    )


_DERIVATIONS: Dict[str, Callable[[tuple, dict], None]] = {
    "on_run_started": _after_run_started,
    "on_frontend_done": _after_frontend_done,
    "on_pass_done": _after_pass_done,
    "on_reconcile_outcome": _after_reconcile_outcome,
    "on_snapshot_persisted": _after_snapshot_persisted,
    "on_served": _after_served,
    "on_run_failed": _after_run_failed,
}


# ── install / uninstall ────────────────────────────────────────────────


def _wrap(name: str, original: Callable[..., Any]) -> Callable[..., Any]:
    derive = _DERIVATIONS[name]

    @functools.wraps(original)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        result = original(*args, **kwargs)
        if enabled():
            try:
                derive(args, kwargs)
            except Exception:  # noqa: BLE001 — tracing never breaks a hook
                logger.debug("[obs.trace] %s derivation failed", name, exc_info=True)
        return result

    setattr(wrapper, _WRAP_MARK, True)
    setattr(wrapper, "__wrapped__", original)
    return wrapper


def install() -> bool:
    """Decorate the journal hook seams (idempotent). Returns True when
    the wrappers are in place. Safe to call at router build time — the
    wrapper is a no-op pass-through until ``ENGINE_OBS_TRACE`` is set."""
    global _INSTALLED
    with _LOCK:
        if _INSTALLED:
            return True
        try:
            from engine.journal import hooks as _hooks
        except Exception:  # noqa: BLE001 — never break the caller
            logger.exception("[obs.trace] install failed (journal hooks unimportable)")
            return False
        for name in _HOOK_NAMES:
            original = getattr(_hooks, name, None)
            if original is None or getattr(original, _WRAP_MARK, False):
                continue
            _ORIGINALS[name] = original
            setattr(_hooks, name, _wrap(name, original))
        _INSTALLED = True
        logger.debug("[obs.trace] journal-hook tracing seams installed")
        return True


def uninstall() -> None:
    """Restore the original hook functions (test seam)."""
    global _INSTALLED
    with _LOCK:
        if not _INSTALLED:
            return
        try:
            from engine.journal import hooks as _hooks

            for name, original in _ORIGINALS.items():
                setattr(_hooks, name, original)
        except Exception:  # noqa: BLE001
            logger.exception("[obs.trace] uninstall failed (non-fatal)")
        _ORIGINALS.clear()
        _INSTALLED = False
    _TLS.run = None
