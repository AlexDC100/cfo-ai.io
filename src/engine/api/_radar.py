"""RADAR — the served route.

    GET  /api/radar/{period_id}                       the period's findings:
                                                      ranked, materiality-
                                                      gated, capped, with
                                                      dismissals applied and
                                                      cached explanations
                                                      attached
    GET  /api/radar/{period_id}/dismissals            the dismissals in force
                                                      for the workspace
    POST /api/radar/{period_id}/dismiss               dismiss one (rule,
                                                      subject) WITH a reason
    POST /api/radar/{period_id}/dismissals/{id}/revoke  revoke one (never
                                                      delete)

Every figure the route serves is computed by ``engine.radar.serve`` from
the deterministic findings engine over the period's rebuilt statements
and its persisted envelope. This module LOADS and PERSISTS; it holds no
arithmetic, no detector, no ranking and no model. The Capsule's
``list_findings`` tool runs the same engine over the same rebuilt
statements, which is what gate R1 asserts byte for byte — THROUGH THE
TWO LOADERS: this module's own and the Capsule's context builder.

TENANCY. The workspace is resolved through ``_org.resolve_org`` (the
``X-Org-Id`` header, membership-validated) and every read and write goes
through the caller's OWN Supabase client, so RLS is the authority: a
period outside the caller's workspaces is a 404 here because PostgREST
never returned it. Dismissals are inserted by the caller too, stamped
with their user id; ``radar_dismissals``' policy decides, never this
module.

INCREMENTAL. Periods are listed LIGHT first — ids, dates, the envelope's
content hash, the account-121 anchor as one scalar — which is all the
cache key needs. Envelopes and line items are pulled only on a miss, for
the target and its history, and the envelope is put back ON THE ROW
before the statements are rebuilt: the rebuild seam reads
``period["assembled_canonical_v1"]`` for the persisted reconciliation
and the anchor, and a light row handed to it without the envelope
served the raw assemble-path totals under the served name
(SERVE_GATES.md, A2). Opening an unchanged period never recomputes
(gate R5-incremental).

DISMISSALS ARE ANCHORED ON A PERIOD, NEVER ON A POSITION. A stored
dismissal carries the id AND the period end of the period it was made
on; its reach (``periods``) is counted from that period's ordinal ON
THE SPINE AS IT IS NOW. A period uploaded earlier on the spine moves
every ordinal and moves nothing about which periods the dismissal
covers (SERVE_GATES.md, A4). A dismissal whose period is gone and that
carries no period end cannot be anchored; it is NOT applied and the
payload says so — an absent dismissal shows MORE, never less.

THE EXPLANATION LANE (``engine.radar.explain``) is wired here and only
here, per its published contract: cached explanations are attached to
the surfaced rows BEFORE the payload returns (cache-only, no model
reachable), and the rows still unexplained are drafted AFTER the rows
have gone out, in a daemon thread. The rows never wait for a model:
dead, slow or hostile, the payload returns with an honest
``explanation.status == "absent"`` marker on each row.

THE F9 NUMERAL GUARD (``engine.api._finding_advisory``) is installed at
mount. It was importable and never imported by anything under ``src/``
(SERVE_GATES.md, B6); mounting this router is the one act that makes
``_finding.apply_advisory_narrative`` the guarded seam on the served
path.

THE ONE CLOCK READ is the dismissal's ``dismissed_at`` stamp — the
audit "when". It is injectable (``clock``) so a test can pin it, and it
never reaches the engine: the served rows depend on the dismissal SET,
not on when it was recorded.

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from pydantic import BaseModel, Field

from engine.radar import cap as CAP
from engine.radar import explain as X
from engine.radar import serve as RS

from . import _finding_rank as R

logger = logging.getLogger(__name__)

TABLE_PERIODS = "financial_periods"
TABLE_LINE_ITEMS = "statement_line_items"
TABLE_DISMISSALS = "radar_dismissals"

#: Light period columns — everything the cache key needs and nothing
#: heavier. Every plain name is a column ``financial_periods`` carries
#: (supabase/schema.sql + the alter-table migrations) — there is NO
#: ``period_label`` column and NO ``caen_code`` column (phase 7 put CAEN
#: on ``organizations``); a projection naming either is a 400 from
#: PostgREST. The first version of this projection named ``caen_code``
#: and would have failed every production listing; the projection-
#: faithful test double is what caught it. The label is the period end
#: (see :func:`period_label_of`); ``caen`` is read off the row when a
#: column exists and is None otherwise — the Capsule's context builder
#: reads the same absent key. The JSON-path aliases:
#: ``snapshot_hash`` is the content hash the FactsGateway stamps on
#: every fact; ``has_envelope`` marks an envelope; ``p121`` is the
#: account-121 closing balance the pack recorded at write time
#: (``canonical_bs.invariants.p121_cross_check.p121``) — the ONE scalar
#: the rebuild seam needs to anchor statutory net income without the
#: whole JSONB column (design_review/engine/NET_INCOME_ANCHOR.md §6).
#: PostgREST renders a ``->>`` extraction as text; the seam coerces.
LIGHT_PERIOD_COLUMNS = (
    "id,org_id,period_start,period_end,currency,source_document_id,updated_at,"
    "p121:assembled_canonical_v1->canonical_bs->invariants->p121_cross_check->>p121,"
    "snapshot_hash:assembled_canonical_v1->provenance->>content_hash,"
    "has_envelope:assembled_canonical_v1->>schema_version"
)
LINE_ITEM_COLUMNS = "statement,bucket,ro_account_code,ro_account_name,amount"
ENVELOPE_COLUMNS = "id,assembled_canonical_v1"

#: Prior periods loaded on a miss, nearest first.
HISTORY_DEPTH = RS.DEFAULT_HISTORY_DEPTH

#: Process-level cache. A deploy restarts it; nothing is served stale
#: because the key changes with every envelope write and every dismissal.
_CACHE = RS.RadarCache(max_entries=2048)


def cache() -> RS.RadarCache:
    return _CACHE


class DismissBody(BaseModel):
    """POST /api/radar/{period_id}/dismiss. Module-scoped on purpose: a
    Pydantic model nested inside the route factory is a forward ref
    FastAPI cannot resolve (the documented /openapi.json 500)."""

    rule_id: str
    #: The finding's ``root_cause`` (its ledger accounts), or ``*`` for
    #: every subject of the rule in this workspace.
    subject: str = Field(default=R.SCOPE_ANY)
    reason: str
    #: How many periods the dismissal holds, counting the target. None =
    #: open-ended, which is allowed but recorded as such.
    periods: Optional[int] = None


class RadarLoadError(Exception):
    """A loader could not produce what the route needs. Carries the
    HTTP status the route should answer with."""

    def __init__(self, status: int, detail: str) -> None:
        Exception.__init__(self, detail)
        self.status = int(status)
        self.detail = detail


# ── Pure shaping (unit-tested without a database) ─────────────────────────


def order_periods(rows: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The workspace's spine: ascending by period end, ties by id, so the
    ordinal every dismissal is scoped by is stable across requests."""
    return sorted(rows, key=lambda r: (str(r.get("period_end") or ""),
                                       str(r.get("id") or "")))


def content_key_of(row: Dict[str, Any]) -> Optional[str]:
    """What identifies the period's data on a LIGHT row: the envelope's
    content hash when PostgREST aliased it, else (a fake or an older
    row) the envelope's own provenance, else ``updated_at``."""
    value = row.get("snapshot_hash")
    if value:
        return str(value)
    envelope = row.get("assembled_canonical_v1")
    if isinstance(envelope, dict):
        provenance = envelope.get("provenance") or {}
        if isinstance(provenance, dict) and provenance.get("content_hash"):
            return str(provenance["content_hash"])
    stamp = row.get("updated_at")
    return str(stamp) if stamp else None


def content_hash_of(row: Dict[str, Any]) -> Optional[str]:
    """The envelope's content hash and nothing else — the id the gateway
    stamps on every fact. ``updated_at`` is never a substitute."""
    value = row.get("snapshot_hash")
    if value:
        return str(value)
    envelope = row.get("assembled_canonical_v1")
    if isinstance(envelope, dict):
        provenance = envelope.get("provenance") or {}
        if isinstance(provenance, dict) and provenance.get("content_hash"):
            return str(provenance["content_hash"])
    return None


def period_label_of(row: Dict[str, Any]) -> str:
    """``financial_periods`` carries no label column (supabase/schema.sql),
    so the period end IS the label on every surface — the Capsule's
    ``row.get("period_label")`` never resolves either. A label column
    added later is picked up here first."""
    return str(row.get("period_label") or row.get("period_end") or row.get("id") or "")


def light_input(row: Dict[str, Any], ordinal: int) -> RS.PeriodInput:
    return RS.PeriodInput(
        period_id=str(row.get("id") or ""),
        label=period_label_of(row),
        period_end=str(row.get("period_end") or ""),
        period_start=(str(row.get("period_start")) if row.get("period_start") else None),
        ordinal=int(ordinal),
        currency=str(row.get("currency") or "RON").upper(),
        snapshot_id=content_hash_of(row),
        source_document_id=(str(row.get("source_document_id") or "") or None),
        caen=(str(row.get("caen_code")) if row.get("caen_code") else None),
        content_key=content_key_of(row),
    )


def anchor_ordinal(dismissal_row: Dict[str, Any],
                   spine: Sequence[Dict[str, Any]]) -> Optional[int]:
    """The ordinal, on the spine AS IT IS NOW, of the period a stored
    dismissal was made on. By id when the period is still there; else
    by period end — the position the period WOULD occupy, so a deleted
    period anchors where it stood; None when neither is known."""
    period_id = str(dismissal_row.get("period_id") or "")
    if period_id:
        for ordinal, row in enumerate(spine):
            if str(row.get("id") or "") == period_id:
                return ordinal
    period_end = str(dismissal_row.get("from_period_end") or "")
    if period_end:
        return len([r for r in spine
                    if (str(r.get("period_end") or ""), str(r.get("id") or ""))
                    < (period_end, period_id)])
    return None


def dismissal_from_row(row: Dict[str, Any],
                       spine: Sequence[Dict[str, Any]] = ()) -> Optional[R.Dismissal]:
    """A stored dismissal as the engine's scoped object, its reach
    anchored on the spine handed over. None when it cannot be anchored
    — the caller records a notice and applies nothing."""
    periods = _opt_int(row.get("periods"))
    ordinal = anchor_ordinal(row, spine) if spine else None
    if periods is not None and ordinal is None:
        return None
    return R.Dismissal.from_payload({
        "rule_id": row.get("rule_id"),
        "scope_key": row.get("scope_key") or R.SCOPE_ANY,
        "reason": row.get("reason"),
        "dismissed_by": row.get("dismissed_by"),
        "dismissed_at": row.get("dismissed_at"),
        "from_period_ordinal": ordinal,
        "periods": periods,
    })


def resolve_dismissals(rows: Sequence[Dict[str, Any]],
                       spine: Sequence[Dict[str, Any]],
                       notices: List[str]) -> Tuple[R.Dismissal, ...]:
    out = []  # type: List[R.Dismissal]
    for row in rows:
        dismissal = dismissal_from_row(row, spine)
        if dismissal is None:
            notices.append(
                "dismissal %s of %s could not be anchored: its period %s is no "
                "longer on the spine and it carries no period end — not applied"
                % (row.get("id"), row.get("rule_id"), row.get("period_id")))
            continue
        out.append(dismissal)
    return tuple(out)


def _opt_int(value: Any) -> Optional[int]:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def validate_dismiss(body: DismissBody) -> Tuple[str, str, str, Optional[int]]:
    """The three refusals a dismissal can earn before it touches storage:
    no rule, no reason, a non-positive span. Returned clean."""
    rule_id = (body.rule_id or "").strip()
    if not rule_id:
        raise RadarLoadError(422, "A dismissal names the rule it dismisses.")
    reason = (body.reason or "").strip()
    if not reason:
        raise RadarLoadError(422, "A dismissal carries a reason; an empty one "
                                  "is not a decision.")
    subject = (body.subject or "").strip() or R.SCOPE_ANY
    periods = body.periods
    if periods is not None and int(periods) < 1:
        raise RadarLoadError(422, "periods must be a positive integer, or absent "
                                  "for an open-ended dismissal.")
    return rule_id, subject, reason, (int(periods) if periods is not None else None)


# ── Loaders (thin over the caller's client) ────────────────────────────────


def list_light_periods(client: Any, org_id: str) -> List[Dict[str, Any]]:
    rows = client.select(TABLE_PERIODS, filters={"org_id": "eq.%s" % org_id},
                         columns=LIGHT_PERIOD_COLUMNS, order="period_end.asc") or []
    return order_periods(rows)


def load_dismissals(client: Any, org_id: str,
                    notices: List[str]) -> List[Dict[str, Any]]:
    """The dismissals in force. A missing table (migration not applied)
    is a NOTICE on the payload and an empty set — reads fail OPEN because
    an absent dismissal shows MORE, never less."""
    try:
        return client.select(
            TABLE_DISMISSALS,
            filters={"org_id": "eq.%s" % org_id, "revoked_at": "is.null"},
            order="dismissed_at.asc") or []
    except Exception as exc:  # noqa: BLE001
        notices.append("%s: not readable (%s) — no dismissal applied"
                       % (TABLE_DISMISSALS, exc))
        return []


def load_envelope(client: Any, period_id: str) -> Optional[Dict[str, Any]]:
    rows = client.select(TABLE_PERIODS, filters={"id": "eq.%s" % period_id},
                         columns=ENVELOPE_COLUMNS, limit=1) or []
    if not rows:
        return None
    envelope = rows[0].get("assembled_canonical_v1")
    return envelope if isinstance(envelope, dict) else None


def full_row(light_row: Dict[str, Any],
             envelope: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """The row the rebuild seam reads: the light row WITH the persisted
    envelope on it under the column name the seam looks up. This is the
    row the Capsule's context builder hands the same seam."""
    row = dict(light_row)
    if envelope is not None:
        row["assembled_canonical_v1"] = envelope
    return row


def load_statements(client: Any, row: Dict[str, Any],
                    envelope: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    """The period's statements, rebuilt from its persisted line items the
    way /api/period and the Capsule rebuild them — the same seam, over
    the same row shape (the envelope ON the row), so the detectors see
    the same numbers on every surface."""
    line_items = client.select(
        TABLE_LINE_ITEMS, filters={"period_id": "eq.%s" % row.get("id")},
        columns=LINE_ITEM_COLUMNS) or []
    if not line_items:
        return None
    from .pipeline import _rebuild_assembled_for_briefing  # lazy: heavy module
    try:
        return _rebuild_assembled_for_briefing(
            line_items, full_row(row, envelope), None).get("statements")
    except Exception:  # noqa: BLE001
        logger.exception("[radar] statements rebuild failed for %s", row.get("id"))
        return None


def heavy_input(client: Any, light: RS.PeriodInput,
                row: Dict[str, Any]) -> RS.PeriodInput:
    """Envelope first, then the statements rebuilt WITH it on the row."""
    envelope = load_envelope(client, light.period_id)
    return replace(light, statements=load_statements(client, row, envelope),
                   envelope=envelope)


# ── The composition ───────────────────────────────────────────────────────


def build_request(client: Any, org_id: str, period_id: str,
                  notices: List[str], depth: int = HISTORY_DEPTH
                  ) -> Tuple[RS.RadarRequest, Dict[str, Any], List[Dict[str, Any]]]:
    """The LIGHT request (cache key material only), the target row, and
    the ordered spine rows."""
    spine = list_light_periods(client, org_id)
    target_row = None  # type: Optional[Dict[str, Any]]
    target_ordinal = -1
    for ordinal, row in enumerate(spine):
        if str(row.get("id")) == str(period_id):
            target_row, target_ordinal = row, ordinal
            break
    if target_row is None:
        raise RadarLoadError(404, "Period %s is not in this workspace." % period_id)
    dismissals = resolve_dismissals(load_dismissals(client, org_id, notices),
                                    spine, notices)
    target = light_input(target_row, target_ordinal)
    history = tuple(light_input(row, ordinal) for ordinal, row in enumerate(spine)
                    if ordinal < target_ordinal)
    request = RS.RadarRequest(org_id=org_id, target=target, history=history,
                              dismissals=dismissals, history_depth=int(depth))
    return request, target_row, spine


# ── The explanation lane, wired ──────────────────────────────────────────


@dataclass(frozen=True)
class ExplainWiring:
    """How the route reaches the explanation lane. Production is the
    default instance: the lane's own file store, the registry-built
    clients, the lane's own state and journal dirs. A test hands in a
    memory store and stub clients; nothing else changes."""

    enabled: bool = True
    background: bool = True
    store: Any = None
    client_factory: Optional[Callable[[], Any]] = None
    reviewer_factory: Optional[Callable[[], Any]] = None
    state_dir: Optional[Any] = None
    journal_dir: Optional[Any] = None
    on_done: Optional[Callable[[List[Any]], None]] = None


_IN_FLIGHT_LOCK = threading.Lock()
#: Explain cache keys being drafted right now, so two opens of the same
#: period do not draft the same explanation twice.
_IN_FLIGHT = set()  # type: set


class _RankedView(object):
    """What ``explain.subjects_from_ranked`` reads: ``.surfaced``."""

    def __init__(self, surfaced: Sequence[Any]) -> None:
        self.surfaced = tuple(surfaced)


def attach_explanations(payload: Dict[str, Any], served: RS.Served,
                        org_id: str, wiring: ExplainWiring) -> Dict[str, Any]:
    """Cache-only, before the rows go out; the draft after. Returns the
    payload with ``explanation`` on every surfaced row and an
    ``explanations`` summary beside the rows. The model is not reachable
    from anything called before the return."""
    summary = {"source": "engine.radar.explain", "critical_path": "cache-only",
               "attached": 0, "cached": 0, "fresh": 0, "absent": 0,
               "pending": 0, "drafting_in_background": False, "enabled": bool(wiring.enabled)}
    if not wiring.enabled or not payload.get("available") or not served.surfaced:
        payload[RS.EXPLANATIONS_KEY] = summary
        return payload
    try:
        subjects = X.subjects_from_ranked(
            _RankedView(served.surfaced), served.profile, org_id,
            str(payload.get("period_id") or ""), served.snapshot_hash,
            gateway=served.gateway)
        explanations = X.attach_cached(subjects, store=wiring.store,
                                       journal_dir=wiring.journal_dir)
        payload["surfaced"] = X.attach(payload["surfaced"], explanations, subjects)
    except Exception:  # noqa: BLE001 — the lane must never take rows down
        logger.exception("[radar] explanation attach failed; rows served without")
        payload[RS.EXPLANATIONS_KEY] = dict(summary, error="attach_failed")
        return payload
    pending = []  # type: List[Any]
    for subject, expl in zip(subjects, explanations):
        summary["attached"] += 1
        if expl.status == X.STATUS_CACHED:
            summary["cached"] += 1
        elif expl.status == X.STATUS_FRESH:
            summary["fresh"] += 1
        else:
            summary["absent"] += 1
            if expl.kind == X.KIND_NOT_YET:
                pending.append(subject)
    summary["pending"] = len(pending)
    if pending and wiring.background:
        summary["drafting_in_background"] = _draft_in_background(pending, wiring)
    payload[RS.EXPLANATIONS_KEY] = summary
    return payload


def _draft_in_background(subjects: Sequence[Any], wiring: ExplainWiring) -> bool:
    """Start the after-rows draft for the subjects not already in flight.
    Returns whether a thread was started."""
    try:
        prompt = X.prompt_version()
    except Exception:  # noqa: BLE001 — a broken registry: nothing to draft
        return False
    keyed = [(X.key_for(s, prompt), s) for s in subjects]
    with _IN_FLIGHT_LOCK:
        fresh = [(k, s) for k, s in keyed if k not in _IN_FLIGHT]
        for key, _s in fresh:
            _IN_FLIGHT.add(key)
    if not fresh:
        return False
    keys = [k for k, _s in fresh]

    def _release(out: List[Any]) -> None:
        with _IN_FLIGHT_LOCK:
            for key in keys:
                _IN_FLIGHT.discard(key)
        if wiring.on_done is not None:
            wiring.on_done(out)

    X.explain_in_background(
        [s for _k, s in fresh], on_done=_release,
        store=wiring.store, client_factory=wiring.client_factory,
        reviewer_factory=wiring.reviewer_factory, state_dir=wiring.state_dir,
        journal_dir=wiring.journal_dir)
    return True


def serve_for(client: Any, org_id: str, period_id: str,
              radar_cache: Optional[RS.RadarCache] = None,
              depth: int = HISTORY_DEPTH,
              explain: Optional[ExplainWiring] = None) -> Dict[str, Any]:
    """Serve one period for one workspace through the cache. The heavy
    loads (envelope + line items for the target and its history) run
    inside the builder, so a hit performs none of them. Explanations
    are attached from cache on the way out and drafted after."""
    store = radar_cache if radar_cache is not None else _CACHE
    wiring = explain if explain is not None else ExplainWiring()
    notices = []  # type: List[str]
    request, target_row, spine = build_request(client, org_id, period_id, notices, depth)
    rows_by_id = dict((str(r.get("id")), r) for r in spine)

    def _builder() -> RS.Served:
        target = heavy_input(client, request.target, target_row)
        prior = []  # type: List[RS.PeriodInput]
        for light in request.prior_periods():
            prior.append(heavy_input(client, light, rows_by_id[light.period_id]))
        full = replace(request, target=target, history=tuple(prior))
        return RS.compose(full)

    key = RS.cache_key(request)
    payload, served = store.get_or_build_with(key, _builder)
    payload = attach_explanations(payload, served, org_id, wiring)
    payload["cache"] = {"key": key, "hits": store.hits, "misses": store.misses}
    payload["notices"] = list(notices)
    return payload


def record_dismissal(client: Any, org_id: str, period_id: str, user_id: str,
                     body: DismissBody, clock: Callable[[], str]) -> Dict[str, Any]:
    """Persist one dismissal for the workspace, anchored on the target
    period (its id AND its period end), stamped with who and when. The
    ordinal at the time is recorded as information only; the reach is
    re-anchored on the spine at every serve. Fails LOUDLY when the table
    is absent or RLS refuses — a dismissal that silently did not persist
    would reappear next open and read as a bug."""
    rule_id, subject, reason, periods = validate_dismiss(body)
    spine = list_light_periods(client, org_id)
    target = None  # type: Optional[Dict[str, Any]]
    ordinal = None  # type: Optional[int]
    for index, row in enumerate(spine):
        if str(row.get("id")) == str(period_id):
            target, ordinal = row, index
            break
    if target is None or ordinal is None:
        raise RadarLoadError(404, "Period %s is not in this workspace." % period_id)
    row = {
        "org_id": org_id, "period_id": period_id,
        "from_period_end": str(target.get("period_end") or "") or None,
        "rule_id": rule_id, "scope_key": subject, "reason": reason,
        "dismissed_by": user_id, "dismissed_at": clock(),
        "from_period_ordinal": int(ordinal), "periods": periods,
    }
    try:
        inserted = client.insert(TABLE_DISMISSALS, row)
    except Exception as exc:  # noqa: BLE001 — RLS refusal or table absent
        raise RadarLoadError(
            403, "Dismissal refused: %s. If the table is missing, apply "
                 "supabase/schema_phase_radar.sql and reload the schema cache." % exc)
    return inserted[0] if inserted else row


def revoke_dismissal(client: Any, org_id: str, dismissal_id: str,
                     user_id: str, clock: Callable[[], str]) -> None:
    rows = client.select(TABLE_DISMISSALS,
                         filters={"id": "eq.%s" % dismissal_id,
                                  "org_id": "eq.%s" % org_id}, limit=1) or []
    if not rows:
        raise RadarLoadError(404, "Dismissal %s is not in this workspace." % dismissal_id)
    if rows[0].get("revoked_at"):
        return
    try:
        client.update(TABLE_DISMISSALS,
                      {"revoked_at": clock(), "revoked_by": user_id},
                      filters={"id": "eq.%s" % dismissal_id,
                               "org_id": "eq.%s" % org_id})
    except Exception as exc:  # noqa: BLE001
        raise RadarLoadError(403, "Revocation refused: %s" % exc)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── HTTP surface ─────────────────────────────────────────────────────────


def build_router(clock: Callable[[], str] = utc_now_iso,
                 explain: Optional[ExplainWiring] = None):  # pragma: no cover — wiring
    from fastapi import APIRouter, Header, HTTPException

    from . import _org, _supabase
    # Installs the F9 numeral guard onto `_finding.apply_advisory_narrative`
    # once, at mount: every advisory rewrite on the served path — the
    # explanation lane's included — goes through the guarded seam. Gate:
    # tests/engine/test_radar_route.py (the guard is active in a fresh
    # interpreter that mounts this router and nothing else).
    from . import _finding_advisory  # noqa: F401

    router = APIRouter(prefix="/api/radar", tags=["radar"])
    wiring = explain if explain is not None else ExplainWiring()

    def _require_jwt(authorization: Optional[str]) -> str:
        if not authorization or not authorization.lower().startswith("bearer "):
            raise HTTPException(401, "Missing bearer token.")
        return authorization.split(" ", 1)[1].strip()

    def _guard(fn: Callable[[], Dict[str, Any]]) -> Dict[str, Any]:
        try:
            return fn()
        except RadarLoadError as exc:
            raise HTTPException(exc.status, exc.detail)

    @router.get("/{period_id}")
    def get_radar(period_id: str,
                  authorization: Optional[str] = Header(None),
                  x_org_id: Optional[str] = Header(None)) -> Dict[str, Any]:
        jwt = _require_jwt(authorization)
        _user_id, org_id = _org.resolve_org(jwt, x_org_id)

        def _run() -> Dict[str, Any]:
            with _supabase.per_user(jwt) as client:
                return serve_for(client, org_id, period_id, _CACHE, explain=wiring)
        return _guard(_run)

    @router.get("/{period_id}/dismissals")
    def list_dismissals(period_id: str,
                        authorization: Optional[str] = Header(None),
                        x_org_id: Optional[str] = Header(None)) -> Dict[str, Any]:
        jwt = _require_jwt(authorization)
        _user_id, org_id = _org.resolve_org(jwt, x_org_id)
        notices = []  # type: List[str]
        with _supabase.per_user(jwt) as client:
            rows = load_dismissals(client, org_id, notices)
        return {"period_id": period_id, "org_id": org_id,
                "dismissals": rows, "notices": notices}

    @router.post("/{period_id}/dismiss")
    def dismiss(period_id: str, body: DismissBody,
                authorization: Optional[str] = Header(None),
                x_org_id: Optional[str] = Header(None)) -> Dict[str, Any]:
        jwt = _require_jwt(authorization)
        user_id, org_id = _org.resolve_org(jwt, x_org_id)

        def _run() -> Dict[str, Any]:
            with _supabase.per_user(jwt) as client:
                row = record_dismissal(client, org_id, period_id, user_id, body, clock)
                radar = serve_for(client, org_id, period_id, _CACHE, explain=wiring)
            return {"dismissal": row, "radar": radar,
                    "note": ("a finding whose group is graded Critical stays "
                             "surfaced, flagged, with this reason beside it")}
        return _guard(_run)

    @router.post("/{period_id}/dismissals/{dismissal_id}/revoke")
    def revoke(period_id: str, dismissal_id: str,
               authorization: Optional[str] = Header(None),
               x_org_id: Optional[str] = Header(None)) -> Dict[str, Any]:
        jwt = _require_jwt(authorization)
        user_id, org_id = _org.resolve_org(jwt, x_org_id)

        def _run() -> Dict[str, Any]:
            with _supabase.per_user(jwt) as client:
                revoke_dismissal(client, org_id, dismissal_id, user_id, clock)
                radar = serve_for(client, org_id, period_id, _CACHE, explain=wiring)
            return {"revoked": dismissal_id, "radar": radar}
        return _guard(_run)

    return router


__all__ = [
    "DismissBody", "ENVELOPE_COLUMNS", "ExplainWiring", "HISTORY_DEPTH",
    "LIGHT_PERIOD_COLUMNS", "LINE_ITEM_COLUMNS", "RadarLoadError",
    "TABLE_DISMISSALS", "TABLE_LINE_ITEMS", "TABLE_PERIODS", "anchor_ordinal",
    "attach_explanations", "build_request", "build_router", "cache",
    "content_hash_of", "content_key_of", "dismissal_from_row", "full_row",
    "heavy_input", "light_input", "list_light_periods", "load_dismissals",
    "load_envelope", "load_statements", "order_periods", "period_label_of",
    "record_dismissal", "resolve_dismissals", "revoke_dismissal", "serve_for",
    "utc_now_iso", "validate_dismiss",
]
