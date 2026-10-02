"""Usage gate service — atomic reserve / commit / release for documents + chat.

WHY THIS EXISTS (gaps C + D from the refined spec)
==================================================
The Pricing V2 path (`_plan_state.check_doc_quota` + `record_doc_consumed`)
was non-atomic: a read-then-write through PostgREST. Two concurrent
uploads near the quota boundary could both pass the check, both
increment the counter, and both run analysis — one of them free of
charge. That's a money leak.

The refined spec requires:
  · Gap C — atomic check-and-consume. Two concurrent requests at the
    boundary must serialize so exactly one wins.
  · Gap D — quota is consumed / extra-doc is billed only on
    SUCCESSFUL completion of analysis. Failed runs (parse error,
    pipeline exception, unrecognized format) release the reservation
    with no bill.

This module is the new path. It calls the V3 atomic RPCs
(`reserve_user_upload`, `commit_user_upload`, `release_user_upload`,
and the chat trio) defined in
`supabase/schema_phase_pricing_v3_atomic.sql`. The legacy
`_plan_state` helpers stay on disk for read-only state reads; the
write path migrates here.

CALL SHAPES
===========
DOCUMENTS:
    reserve_document(user_id) -> ReserveDecision
        ALLOWED          → caller may enqueue the pipeline immediately
        EXTRA_REQUIRED   → over base cap; caller must surface confirm
                           dialog. NO reservation made. After user
                           confirms, caller re-invokes via
                           `confirm_extra_document(user_id, document_id)`.
        BLOCKED          → no extras allowed (trial/intro). NO reservation.

    confirm_extra_document(user_id, document_id) -> ReserveDecision
        Caller has shown the confirm dialog FOR `document_id` and got
        explicit consent. Reserves above the base cap, marks the
        reservation as billable and GRANTS it to that document.

    claim_extra_grant(user_id, document_id) -> ReserveDecision | None
        That document's own /api/pipeline/run takes its grant, once.
        `reserve_document` never spends a confirmed extra.

    commit_document(user_id, was_extra) -> None
        Pipeline reported analysis success. Reservation → consumed.
        If was_extra=True, also bumps extra_docs_billed_period.

    release_document(user_id, was_extra) -> None
        Pipeline reported failure. Reservation evaporates; no bill.

CHAT (same shape):
    reserve_chat(user_id) -> ChatReserveDecision
    commit_chat(user_id) -> None
    release_chat(user_id) -> None

ENFORCEMENT IS GATED on `enforcement_enabled()` (shared with
`_usage_limits` + `_plan_state`). Off by default — deploying this
code does not block any existing user; flip the env to enforce.
"""

from __future__ import annotations

import json
import logging
import threading
import time
import dataclasses
from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Any, Dict, Literal, Optional, Union

from . import _org, _plan_state, _pricing_config, _quota_ledger, _supabase, _unmetered


logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────
# Shared kill-switch — mirrors `_plan_state.enforcement_enabled`.
# ──────────────────────────────────────────────────────────────────────

def enforcement_enabled() -> bool:
    return _plan_state.enforcement_enabled()


def enforced_for(user_id: Optional[str]) -> bool:
    """The kill-switch as ONE user sees it: the global switch, minus the
    operator exemption (USAGE_UNMETERED_USER_IDS, see `_unmetered`).

    Every reserve / confirm / commit / release below asks THIS, never the
    global switch directly — all of them, so a reservation can never be made
    on one side of a run and skipped on the other.
    """
    if _unmetered.is_unmetered(user_id):
        return False
    return enforcement_enabled()


# ──────────────────────────────────────────────────────────────────────
# Result shapes
# ──────────────────────────────────────────────────────────────────────

DocReserveKind = Literal["allowed", "extra_required", "blocked", "disabled"]


@dataclass(frozen=True)
class DocReserveDecision:
    kind: DocReserveKind
    plan_key: str
    used: int
    reserved: int
    cap: int
    extra_doc_eur: Optional[float]
    message: str
    # When kind == "allowed" with `was_extra=True`, the caller should
    # remember this so the eventual commit/release call passes the same
    # flag (which controls subscriptions.extra_docs_billed_period).
    was_extra: bool = False
    # The user_usage month bucket the reservation was made in — where its
    # commit / release must land (a run reserved on 30 Sep and settled on
    # 1 Oct releases September's reservation). "" = the current month.
    month: str = ""
    # A typed reason for a `blocked` decision the route answers by code
    # (`reservation_outstanding`); "" = the route's default code.
    code: str = ""
    # The quota-ledger `reservation_id` this decision ALREADY holds — a
    # confirmed extra's (recorded by the confirm), or an adopted orphan's.
    # The run that takes it registers that row as its own instead of
    # recording a second reservation, which the ledger now refuses
    # (`_quota_ledger.record_reservation` → `Outstanding`, P2-B).
    reservation_id: str = ""


NonRoReserveKind = Literal["allowed", "refused", "blocked", "disabled"]

# The typed refusal contract (2026-08 tiers): the FE matches
# `non_ro_not_included` and renders an upgrade-to-Multi-Country prompt.
# This dict is the UNIT's decision (`NonRoReserveDecision.refusal`); what
# the pipeline STORES is `stored_nonro_refusal` below — the code alone.
NON_RO_REFUSAL: Dict[str, str] = {
    "error": "non_ro_not_included",
    "upgrade_to": "multi",
}

# ── What a non-RO refusal STORES (owner ruling 2026-10-02) ────────────
#
# `documents.error` is a SHARED row: every member of the workspace reads it
# (`documents member select`), and a firm viewer does too. It used to carry
# `plan_key` and a sentence naming a plan ("…aren't included in the RO Solo
# plan", "…included in the Multi-Country plan this month") — one PERSON's
# billing fact published to their colleagues. It now carries a neutral
# code and nothing else; each viewer's browser renders the sentence from
# the code, in that viewer's language (frontend/lib/uploadRefusals.ts).
NONRO_NOT_INCLUDED = "non_ro_not_included"
NONRO_QUOTA_EXHAUSTED = "nonro_quota_exhausted"
METERING_UNAVAILABLE = "metering_unavailable"

#: The ONLY codes a non-RO refusal may store.
STORED_NONRO_CODES = (NONRO_NOT_INCLUDED, NONRO_QUOTA_EXHAUSTED, METERING_UNAVAILABLE)


def stored_nonro_refusal(code: str) -> str:
    """The exact text a non-RO refusal raises with — and so the exact text
    after `NonRoNotIncludedError: ` in `documents.error`: `{"error":
    "<code>"}`. No `plan_key`, no `message`, no `upgrade_to`; an unknown
    code is a programming error, never stored."""
    if code not in STORED_NONRO_CODES:
        raise ValueError("not a storable non-RO refusal code: %r" % (code,))
    return json.dumps({"error": code}, ensure_ascii=False)


class NonRoNotIncludedError(RuntimeError):
    """Raised by the pipeline's non-RO gate hook when a non-Romanian
    document is refused: the plan does not include them, the monthly
    non-RO allowance is used, or the meter could not be reached. The
    message is `stored_nonro_refusal(<code>)` — a neutral code that lands
    in `documents.error` (via the pipeline's generic failure handler), so
    the FE can match it and render the sentence per viewer."""


@dataclass(frozen=True)
class NonRoReserveDecision:
    kind: NonRoReserveKind
    plan_key: str
    used: int
    cap: int
    extra_nonro_doc_eur: Optional[float]
    # True when the reservation landed ABOVE included_nonro_docs — the
    # terminal commit then bills one unit on the non-RO overage meter.
    was_extra: bool
    # The typed refusal (kind == "refused"), else None: the payload dict
    # (`NON_RO_REFUSAL`) for an entitlement refusal, or the bare code
    # string `"metering_unavailable"` when the meter could not be reached
    # (tests pin the string on the unit). Read it through
    # `nonro_refusal_code`, never with `dict(...)` — `dict("metering_…")`
    # raises ValueError, and that text is what `documents.error` stored.
    refusal: Optional[Union[Dict[str, str], str]]
    # For the CALLER's own HTTP response only. It names the reserver's plan:
    # never store it on a shared row.
    message: str


ChatReserveKind = Literal[
    "allowed", "daily_cap_reached", "monthly_cap_reached", "disabled"
]


@dataclass(frozen=True)
class ChatReserveDecision:
    kind: ChatReserveKind
    plan_key: str
    daily_used: int
    daily_cap: Optional[int]
    monthly_used: int
    monthly_cap: Optional[int]
    message: str


# ──────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────

def _today() -> date:
    return datetime.now(timezone.utc).date()


def _month_bucket(d: Optional[date] = None) -> str:
    return (d or _today()).strftime("%Y-%m")


def _rpc(name: str, payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Invoke a Postgres RPC via the existing PostgREST admin client.

    Returns the parsed JSON body, or None on transport / decode failure.
    The atomic RPCs in V3 all return a single jsonb object (not a list).
    """
    try:
        with _supabase.admin() as client:
            r = client._client.post(  # type: ignore[attr-defined]
                f"{client.url}/rest/v1/rpc/{name}",
                json=payload,
                headers=client._headers,  # type: ignore[attr-defined]
            )
            if r.status_code >= 400:
                logger.warning(
                    "[usage-gate] RPC %s failed: %s %s",
                    name, r.status_code, r.text[:300],
                )
                return None
            try:
                body = r.json()
            except Exception:  # noqa: BLE001
                return None
            # PostgREST wraps a single-row return as a single object —
            # most of the time. When it returns a list, take the first
            # element (defensive).
            if isinstance(body, list):
                return body[0] if body else None
            if isinstance(body, dict):
                return body
            return None
    except Exception:  # noqa: BLE001
        logger.exception("[usage-gate] RPC %s exception", name)
        return None


# ──────────────────────────────────────────────────────────────────────
# Documents — reserve / commit / release
# ──────────────────────────────────────────────────────────────────────

def reserve_document(user_id: str) -> DocReserveDecision:
    """Atomic check-and-reserve for ONE document slot.

    The actual atomicity is in the Postgres RPC `reserve_user_upload`:
    its UPDATE ... WHERE uploads+reserved < cap is one transactional
    statement, so two concurrent calls cannot both pass at the boundary.
    """
    if not enforced_for(user_id):
        return DocReserveDecision(
            kind="disabled", plan_key="trial", used=0, reserved=0, cap=0,
            extra_doc_eur=None, message="",
        )

    state = _plan_state.get_plan_state(user_id)
    plan = state.plan
    allow_extra = plan.extra_doc_eur is not None
    month = _month_bucket()

    # NO "pending extra" shortcut (removed 2026-09-21, verifier P-B). This
    # used to answer `allowed, was_extra=True` to ANY caller while
    # `extra_docs_pending > 0`, decrementing nothing — pending only fell at
    # the terminal — so ONE confirmed extra paid for every over-cap run
    # until it committed: a second over-cap upload ran with no dialog, and
    # recover-stuck ran (and billed) a document whose €-dialog the user had
    # DISMISSED. A confirmed extra is now a GRANT for the one document it
    # was confirmed for (`confirm_extra_document(user, document_id=…)`),
    # handed out only by `claim_extra_grant(user, that document)` — which
    # only /api/pipeline/run calls. Everything else asks the meter below.
    _expire_extra_grants()

    body = _rpc("reserve_user_upload", {
        "p_user_id":     user_id,
        "p_month":       month,
        "p_base_cap":    plan.included_docs,
        "p_allow_extra": allow_extra,
    }) or {}

    kind = body.get("kind", "blocked")

    if kind == "allowed":
        return DocReserveDecision(
            kind="allowed",
            plan_key=plan.key,
            used=int(body.get("used") or 0),
            reserved=int(body.get("reserved") or 0),
            cap=plan.included_docs,
            extra_doc_eur=plan.extra_doc_eur,
            message="",
            was_extra=False,
            month=month,
        )

    if kind == "extra_required":
        msg = (
            f"You've used {body.get('used', 0)} of {plan.included_docs} "
            f"documents on the {plan.display_name} plan. This extra "
            f"analysis costs €{plan.extra_doc_eur:.2f}. Confirm to proceed."
        )
        return DocReserveDecision(
            kind="extra_required",
            plan_key=plan.key,
            used=int(body.get("used") or 0),
            reserved=int(body.get("reserved") or 0),
            cap=plan.included_docs,
            extra_doc_eur=plan.extra_doc_eur,
            message=msg,
        )

    # blocked (or unknown — treat as blocked closed-failure)
    msg = (
        f"You've used all {plan.included_docs} document"
        f"{'s' if plan.included_docs != 1 else ''} on the "
        f"{plan.display_name} plan. Upgrade to keep going."
    )
    return DocReserveDecision(
        kind="blocked",
        plan_key=plan.key,
        used=int(body.get("used") or 0),
        reserved=int(body.get("reserved") or 0),
        cap=plan.included_docs,
        extra_doc_eur=None,
        message=msg,
    )


# ──────────────────────────────────────────────────────────────────────
# Confirmed extras — one GRANT per document (2026-09-21, verifier P-B)
# ──────────────────────────────────────────────────────────────────────
#
# The €-dialog is a consent for ONE document. `confirm_extra_document`
# reserves the billable slot (`reserve_user_upload_extra`, which also bumps
# `extra_docs_pending`) AND records a grant keyed by that document id; the
# document's own /api/pipeline/run takes it (`claim_extra_grant`) and runs
# as the paid extra. Nothing else can: recover-stuck, the SKU watchdog and
# the firm landing call `reserve_document`, which no longer reads
# `extra_docs_pending` at all, so a dismissed dialog stays dismissed.
#
# In-process, like the reservation ledger (pipeline._QUOTA_RUNS) and the
# in-flight registry (_doc_dedupe): the engine is one process and the grant
# lives seconds (the browser posts /run right after the confirm). A grant
# nobody claims within EXTRA_GRANT_TTL_S — the tab closed, the upload turned
# out to be a duplicate — gives its reservation back (`release_user_upload`,
# was_extra) instead of lingering. The grant's reservation is ALSO written
# to the document's row of the quota ledger (verifier lens S, 2026-09-21):
# a restart used to lose it with reserved+1 and extra_docs_pending+1 left
# behind. Now the document's own /run adopts it after a restart
# (`pipeline._meter_first_analysis`), and a grant nobody adopts is released
# by the ledger's sweep once its owner stops heartbeating.

EXTRA_GRANT_TTL_S = 30 * 60


@dataclass
class _ExtraGrant:
    user_id: str
    granted_at: float
    decision: "DocReserveDecision"


_EXTRA_GRANTS: Dict[str, _ExtraGrant] = {}
#: user id → (document id, when) of the last 402 /run answered — the
#: document a confirm from an older browser bundle (no document_id) is for.
_LAST_EXTRA_REQUIRED: Dict[str, "tuple[str, float]"] = {}
_GRANTS_LOCK = threading.Lock()
_CONFIRM_LOCK = threading.Lock()


def _now_mono() -> float:
    return time.monotonic()


def _expire_extra_grants() -> None:
    """Release the reservation of every grant nobody claimed in time."""
    cutoff = _now_mono() - EXTRA_GRANT_TTL_S
    with _GRANTS_LOCK:
        stale = [(doc, g) for doc, g in _EXTRA_GRANTS.items() if g.granted_at < cutoff]
        for doc, _g in stale:
            _EXTRA_GRANTS.pop(doc, None)
        for user, (doc, at) in list(_LAST_EXTRA_REQUIRED.items()):
            if at < cutoff:
                _LAST_EXTRA_REQUIRED.pop(user, None)
    for doc, g in stale:
        logger.info("[usage-gate] extra-document grant for %s expired unclaimed — "
                    "reservation released, nothing billed", doc)
        _quota_ledger.mark_settling(doc, reservation_id=g.decision.reservation_id or None)  # the mark before the move
        release_document(g.user_id, was_extra=True, month=g.decision.month or None)
        _quota_ledger.record_release(doc)


def note_extra_required(user_id: str, document_id: str) -> None:
    """/api/pipeline/run answered 402 for `document_id`: the dialog the user
    now sees is about THIS document."""
    with _GRANTS_LOCK:
        _LAST_EXTRA_REQUIRED[str(user_id)] = (str(document_id), _now_mono())


def last_extra_required(user_id: str) -> Optional[str]:
    """The document of the user's last 402, while it is recent."""
    with _GRANTS_LOCK:
        got = _LAST_EXTRA_REQUIRED.get(str(user_id))
    if not got or got[1] < _now_mono() - EXTRA_GRANT_TTL_S:
        return None
    return got[0]


def has_extra_grant(document_id: str) -> bool:
    with _GRANTS_LOCK:
        return str(document_id) in _EXTRA_GRANTS


def granted_document_ids() -> "list[str]":
    """The documents holding a grant in THIS process (their reservations
    heartbeat with the process — `_quota_ledger.heartbeat`)."""
    with _GRANTS_LOCK:
        return list(_EXTRA_GRANTS.keys())


def claim_extra_grant(user_id: str, document_id: str) -> Optional[DocReserveDecision]:
    """The confirmed extra for `document_id`, taken exactly once, by the
    user who confirmed it — an `allowed, was_extra=True` decision whose
    reservation `confirm_extra_document` already made. None when there is
    none (the caller then asks the meter as usual)."""
    if not enforced_for(user_id):
        return None
    _expire_extra_grants()
    with _GRANTS_LOCK:
        grant = _EXTRA_GRANTS.get(str(document_id))
        if grant is None or grant.user_id != str(user_id):
            return None
        _EXTRA_GRANTS.pop(str(document_id), None)
        _LAST_EXTRA_REQUIRED.pop(str(user_id), None)
    return grant.decision


def cancel_extra_grant(document_id: str) -> None:
    """The document will not run as a first analysis (a duplicate, already
    analysed, deleted): give its confirmed slot back now, unbilled."""
    with _GRANTS_LOCK:
        grant = _EXTRA_GRANTS.pop(str(document_id), None)
    if grant is not None:
        _quota_ledger.mark_settling(str(document_id),
                                    reservation_id=grant.decision.reservation_id or None)  # the mark before the move
        release_document(grant.user_id, was_extra=True, month=grant.decision.month or None)
        _quota_ledger.record_release(str(document_id))


def confirm_extra_document(user_id: str, document_id: Optional[str] = None) -> DocReserveDecision:
    """User has seen the extra-doc confirm dialog FOR `document_id` and
    clicked Confirm. Reserve a slot above the base cap, mark it billable,
    and grant it to that one document.

    This is a SEPARATE RPC (`reserve_user_upload_extra`) — not a flag
    on `reserve_user_upload` — because the original reserve call
    returned `extra_required` deliberately WITHOUT reserving. The
    explicit two-step keeps the "user confirmed" intent visible in
    server logs.

    Idempotent per document: a second confirm for a document that already
    holds a grant (a double click) reserves nothing more. A confirm that
    names no document reserves nothing — a slot claimable by no run would
    only leak — and an unreachable meter refuses rather than granting a
    slot it never reserved.

    ACROSS A RESTART (P2-B, 2026-09-26). The grant lived only in memory; a
    confirm re-posted after a restart (the retry of a lost response, a
    second click after the deploy) found none and reserved AGAIN —
    `reserve_user_upload_extra` twice for one confirmation, and the ledger
    record overwrote the outstanding row so the first slot leaked for the
    month. Now an outstanding `was_extra` reservation of the same user is
    ADOPTED (`_quota_ledger.adopt`) and re-granted; any other outstanding
    reservation of the document (the user's own plain run a restart
    orphaned — its re-run adopts it, no extra needed — or another member's)
    refuses `blocked` / `reservation_outstanding` without touching the
    meter; and a record refused as `Outstanding` after the RPC gives the
    slot just reserved straight back.
    """
    if not enforced_for(user_id):
        return DocReserveDecision(
            kind="disabled", plan_key="trial", used=0, reserved=0, cap=0,
            extra_doc_eur=None, message="", was_extra=True,
        )
    doc = str(document_id or "").strip()
    if not doc:
        return DocReserveDecision(
            kind="blocked", plan_key="", used=0, reserved=0, cap=0,
            extra_doc_eur=None,
            message="An extra document must be confirmed for the document it is for.",
        )

    _expire_extra_grants()
    with _CONFIRM_LOCK:
        with _GRANTS_LOCK:
            existing = _EXTRA_GRANTS.get(doc)
        if existing is not None:
            if existing.user_id == str(user_id):
                return existing.decision
            return DocReserveDecision(
                kind="blocked", plan_key=existing.decision.plan_key, used=0, reserved=0,
                cap=existing.decision.cap, extra_doc_eur=None,
                message="Another member already confirmed this document's extra analysis.",
            )

        state = _plan_state.get_plan_state(user_id)
        plan = state.plan
        if plan.extra_doc_eur is None:
            # Defence in depth — caller should never hit this path on
            # trial/intro, but if they do, refuse.
            return DocReserveDecision(
                kind="blocked", plan_key=plan.key, used=0, reserved=0,
                cap=plan.included_docs, extra_doc_eur=None,
                message="This plan doesn't allow extra documents.",
            )

        month = _month_bucket()
        held = _quota_ledger.outstanding(doc)
        if held is not None:
            mine = str(held.get("user_id") or "") == str(user_id)
            if mine and held.get("was_extra") and not _quota_ledger.is_settling(held):
                adopted = _quota_ledger.adopt(doc, user_id=str(user_id), take_extra=True)
                if adopted is not None:
                    decision = DocReserveDecision(
                        kind="allowed", plan_key=plan.key, used=state.docs_used_this_period,
                        reserved=0, cap=plan.included_docs, extra_doc_eur=plan.extra_doc_eur,
                        message="", was_extra=True, month=str(adopted.get("month") or month),
                        reservation_id=str(adopted.get("reservation_id") or ""),
                    )
                    with _GRANTS_LOCK:
                        _EXTRA_GRANTS[doc] = _ExtraGrant(user_id=str(user_id), granted_at=_now_mono(),
                                                         decision=decision)
                    logger.info(
                        "[usage-gate] user=%s re-confirmed document %s: adopted the extra reservation "
                        "a restart orphaned — nothing reserved a second time", user_id, doc)
                    return decision
                held = _quota_ledger.outstanding(doc)  # the sweep gave it back first: reserve as usual
            if held is not None:
                return DocReserveDecision(
                    kind="blocked", plan_key=plan.key, used=state.docs_used_this_period, reserved=0,
                    cap=plan.included_docs, extra_doc_eur=None, code="reservation_outstanding",
                    message=("An analysis of this document is already reserved — start it again; "
                             "no extra analysis is needed." if mine else
                             "Another member's analysis of this document is still reserved. "
                             "Try again in a few minutes."),
                )

        body = _rpc("reserve_user_upload_extra", {
            "p_user_id": user_id,
            "p_month":   month,
        })
        if body is None:
            logger.error(
                "[usage-gate][billing] reserve_user_upload_extra UNAVAILABLE — the "
                "extra document is refused rather than granted without a "
                "reservation. user=%s document=%s", user_id, doc,
            )
            return DocReserveDecision(
                kind="blocked", plan_key=plan.key, used=0, reserved=0,
                cap=plan.included_docs, extra_doc_eur=None,
                message=("We could not record this extra document, so it was not "
                         "started. Nothing has been charged."),
            )

        decision = DocReserveDecision(
            kind="allowed",
            plan_key=plan.key,
            used=int(body.get("used") or 0),
            reserved=int(body.get("reserved") or 0),
            cap=plan.included_docs,
            extra_doc_eur=plan.extra_doc_eur,
            message="",
            was_extra=True,
            month=month,
        )
        # Durable too: a restart must neither lose the user's confirmation
        # nor leave its reservation (and extra_docs_pending) behind. The
        # record comes BEFORE the grant: a row another reservation took
        # between the look above and this write (a colleague's run in
        # another container) is never overwritten — the slot reserved a
        # moment ago goes straight back, and no grant is left behind.
        rid = _quota_ledger.record_reservation(doc, user_id=str(user_id), was_extra=True, month=month)
        if isinstance(rid, _quota_ledger.Outstanding):
            release_document(user_id, was_extra=True, month=month)
            logger.warning(
                "[usage-gate] user=%s confirmed document %s while its row holds an outstanding "
                "reservation of user %s — the extra slot just reserved was released, nothing granted",
                user_id, doc, rid.user_id)
            return DocReserveDecision(
                kind="blocked", plan_key=plan.key, used=int(body.get("used") or 0), reserved=0,
                cap=plan.included_docs, extra_doc_eur=None, code="reservation_outstanding",
                message=("An analysis of this document is already reserved. Reload the page and "
                         "start it again."),
            )
        if isinstance(rid, str) and rid:
            decision = dataclasses.replace(decision, reservation_id=rid)
        with _GRANTS_LOCK:
            _EXTRA_GRANTS[doc] = _ExtraGrant(user_id=str(user_id), granted_at=_now_mono(),
                                             decision=decision)
        return decision


def commit_document(user_id: str, *, was_extra: bool, month: Optional[str] = None) -> None:
    """Pipeline reported analysis SUCCESS. Convert reservation →
    consumed (and, if `was_extra`, bump the billed-extras tally so the
    next renewal invoice sees this charge — gap D: bill only on success).
    Idempotency: floors prevent underflow; calling twice is a no-op
    after the first call. `month` = the month the reservation was made in
    (default: now)."""
    if not enforced_for(user_id):
        return
    _rpc("commit_user_upload", {
        "p_user_id":   user_id,
        "p_month":     month or _month_bucket(),
        "p_was_extra": was_extra,
    })


def release_document(user_id: str, *, was_extra: bool, month: Optional[str] = None) -> None:
    """Pipeline reported analysis FAILURE. Drop the reservation; no
    quota consumed, no charge (gap D). `month` = the month the reservation
    was made in (default: now).
    """
    if not enforced_for(user_id):
        return
    _rpc("release_user_upload", {
        "p_user_id":   user_id,
        "p_month":     month or _month_bucket(),
        "p_was_extra": was_extra,
    })


# ──────────────────────────────────────────────────────────────────────
# Non-RO documents — reserve / commit / release (2026-08 tiers)
# ──────────────────────────────────────────────────────────────────────

def _nonro_not_included(state: Any) -> NonRoReserveDecision:
    plan = state.plan
    return NonRoReserveDecision(
        kind="refused",
        plan_key=plan.key,
        used=state.nonro_used_this_period,
        cap=0,
        extra_nonro_doc_eur=None,
        was_extra=False,
        refusal=dict(NON_RO_REFUSAL),
        message=(
            "Non-Romanian documents aren't included in the "
            f"{plan.display_name} plan. Upgrade to Multi-Country to "
            "analyze documents from other jurisdictions."
        ),
    )


def nonro_refusal_code(decision: NonRoReserveDecision) -> str:
    """The neutral code of a refused / blocked non-RO decision — the one
    reader of `NonRoReserveDecision.refusal`, which is a dict for the
    entitlement refusal and a bare string for an unreachable meter. Never
    the decision's `plan_key` or `message` (the reserver's own plan)."""
    refusal = decision.refusal
    if isinstance(refusal, str):
        code = refusal
    elif isinstance(refusal, dict):
        code = str(refusal.get("error") or "")
    else:
        code = ""
    if code in STORED_NONRO_CODES:
        return code
    return NONRO_NOT_INCLUDED if decision.kind == "refused" else NONRO_QUOTA_EXHAUSTED


def workspace_nonro_refusal(org_id: Optional[str]) -> Optional[str]:
    """The non-RO ENTITLEMENT of a WORKSPACE — no RPC, no reservation, no
    count: None when the workspace may analyse non-Romanian documents, else
    the neutral code that refuses it.

    For a run that holds no document slot (a retry, the ai-lane
    force-reextract, a period-move re-run, an operator script): it
    re-analyses a document already counted, so it reserves and counts
    nothing (verifier P-E, 2026-09-21) — but the plan still gates it.

    WHOSE PLAN (owner ruling 2026-10-02): the workspace's, never whoever
    `documents.uploaded_by` names. Billing is per user and no workspace
    carries a plan row, so the workspace's plan is its OWNER's — the user
    who created it under their own plan's caps (`_org.workspace_owner_ids`,
    resolved from the document's own `org_id` under the service role).

    · any owner operator-exempt (`enforced_for` false)      → entitled
    · any owner whose plan `allows_non_ro`                  → entitled
    · owners, none entitled                                 → non_ro_not_included
    · NO owner row, or no `org_id` on the document          → non_ro_not_included
      (FAIL CLOSED — a run nobody can be named as paying for is not free)
    · the owner lookup itself failed                        → metering_unavailable
      (we could not check; `get_plan_state` degrades its own read failures
      to the trial plan, which refuses as well)

    Never reads `documents.uploaded_by`; never returns a plan name.
    """
    if not enforcement_enabled():
        return None
    org = str(org_id or "").strip()
    if not org:
        logger.error("[usage-gate] non-RO re-run refused: the document names no workspace")
        return NONRO_NOT_INCLUDED
    try:
        owners = _org.workspace_owner_ids(org)
    except Exception:  # noqa: BLE001 — unreadable is refused, never waved through
        logger.exception("[usage-gate] non-RO re-run refused: the owner of workspace %s "
                         "could not be read", org)
        return METERING_UNAVAILABLE
    if not owners:
        logger.error("[usage-gate] non-RO re-run refused: workspace %s has no owner row", org)
        return NONRO_NOT_INCLUDED
    for owner in owners:
        if not enforced_for(owner):
            return None
        if _plan_state.get_plan_state(owner).plan.allows_non_ro:
            return None
    return NONRO_NOT_INCLUDED


def reserve_nonro_document(user_id: str) -> NonRoReserveDecision:
    """Gate + atomic reserve for ONE non-Romanian document.

    · Plan without `allows_non_ro` (trial/intro/solo/pro) → the TYPED
      refusal — no RPC touched, no state mutated. The caller (pipeline
      gate hook) surfaces it so the FE renders an upgrade prompt.
    · multi (and pro_legacy via the multi entitlement map) → atomic
      reserve against `included_nonro_docs`; above the cap the
      reservation still lands but `was_extra=True` so the terminal
      commit meters one unit at `extra_nonro_doc_eur`.
    · RPC missing/unreachable (migration not applied yet) → REFUSED,
      `refusal="metering_unavailable"` (fail closed since 2026-09-10 — it
      used to degrade open; see the branch below). The pipeline stores
      that code through `nonro_refusal_code`.

    NOTE: this reserve happens mid-pipeline (the jurisdiction is only
    known after the resolver runs), IN ADDITION to the generic document
    reservation made at /api/pipeline/run. The generic slot covers the
    doc count; this one covers the non-RO dimension.
    """
    if not enforced_for(user_id):
        return NonRoReserveDecision(
            kind="disabled", plan_key="trial", used=0, cap=0,
            extra_nonro_doc_eur=None, was_extra=False, refusal=None,
            message="",
        )

    state = _plan_state.get_plan_state(user_id)
    plan = state.plan

    if not plan.allows_non_ro:
        return _nonro_not_included(state)

    body = _rpc("reserve_user_nonro_upload", {
        "p_user_id":     user_id,
        "p_month":       _month_bucket(),
        "p_base_cap":    plan.included_nonro_docs,
        "p_allow_extra": plan.extra_nonro_doc_eur is not None,
    })
    if body is None:
        # FAIL CLOSED. This is a BILLING path with a LIVE Stripe key.
        #
        # Until 2026-09-10 this degraded OPEN: it logged a warning naming
        # the exact missing migration and then returned `allowed`, so the
        # document would have been analysed and never metered. MEASURED in
        # production on that date: USAGE_LIMITS_ENABLED=true, all three
        # `*_user_nonro_upload` RPCs absent, all three meter columns absent.
        #
        # CORRECTION (2026-09-12). The first report said "27 non-RO documents
        # unmetered over 113 days". That counted `documents.detected_country
        # = 'BE'` — a stamp written by the coa_registries heuristic in
        # _detect.py, NOT by the jurisdiction resolver that routes into this
        # gate. Every one of those rows is a Romanian Scandia balanță (lang
        # 'ro') that the heuristic mis-stamped `be_pcmn` because its
        # `^[0-9]{6}$` code pattern matches analytic 6-digit RO codes and the
        # RO registry's `^[1-7][0-9]{2,4}$` does not. They ran the RO path
        # and were metered as RO documents. This branch was never reached
        # for them, and the container log carries no degrade-open line.
        # The fail-closed rule stands on its own; the window does not.
        #
        # A meter that cannot record is not a meter. The choice at this
        # seam is "refuse the work" or "do the work for free forever, and
        # only find out by auditing" — and the second is not a choice a
        # gate gets to make on its own. Refusing is loud, reversible in
        # one migration, and tells the user something true.
        #
        # The refusal is TYPED so the FE can render it: the generic
        # failure handler persists `documents.error`, the generic release
        # path frees the doc-slot reservation, and `metering_unavailable`
        # is matched the same way `non_ro_not_included` is. It is a bare
        # STRING here (tests pin it); `nonro_refusal_code` is its reader —
        # until 2026-10-02 the pipeline did `dict(decision.refusal)` and
        # stored the resulting ValueError text instead of the code.
        logger.error(
            "[usage-gate][billing] reserve_user_nonro_upload UNAVAILABLE — "
            "refusing the document rather than analysing it unmetered. "
            "Apply supabase/schema_phase_plan_caps.sql and reload the "
            "PostgREST schema cache. user=%s plan=%s", user_id, plan.key,
        )
        return NonRoReserveDecision(
            kind="refused", plan_key=plan.key,
            used=state.nonro_used_this_period,
            cap=plan.included_nonro_docs,
            extra_nonro_doc_eur=plan.extra_nonro_doc_eur,
            was_extra=False, refusal="metering_unavailable",
            message=(
                "We could not record usage for this document, so it was not "
                "analysed. Nothing has been charged. This is a configuration "
                "fault on our side, not a limit on your plan — support has "
                "been alerted."
            ),
        )

    kind = body.get("kind", "blocked")
    if kind == "allowed":
        return NonRoReserveDecision(
            kind="allowed",
            plan_key=plan.key,
            used=int(body.get("used") or 0),
            cap=plan.included_nonro_docs,
            extra_nonro_doc_eur=plan.extra_nonro_doc_eur,
            was_extra=bool(body.get("extra")),
            refusal=None,
            message="",
        )

    return NonRoReserveDecision(
        kind="blocked",
        plan_key=plan.key,
        used=int(body.get("used") or 0),
        cap=plan.included_nonro_docs,
        extra_nonro_doc_eur=None,
        was_extra=False,
        refusal=None,
        message=(
            f"You've used all {plan.included_nonro_docs} non-Romanian "
            f"documents included in the {plan.display_name} plan this month."
        ),
    )


def commit_nonro_document(user_id: str, *, was_extra: bool, month: Optional[str] = None) -> None:
    """Analysis of a non-RO doc SUCCEEDED — reservation → consumed; when
    `was_extra`, the billed-extras tally bumps too (the Stripe metered
    usage record is the caller's job, mirroring commit_document)."""
    if not enforced_for(user_id):
        return
    _rpc("commit_user_nonro_upload", {
        "p_user_id":   user_id,
        "p_month":     month or _month_bucket(),
        "p_was_extra": was_extra,
    })


def release_nonro_document(user_id: str, *, was_extra: bool, month: Optional[str] = None) -> None:
    """Analysis of a non-RO doc FAILED — drop the reservation, no bill."""
    if not enforced_for(user_id):
        return
    _rpc("release_user_nonro_upload", {
        "p_user_id":   user_id,
        "p_month":     month or _month_bucket(),
        "p_was_extra": was_extra,
    })


# ──────────────────────────────────────────────────────────────────────
# Chat — reserve / commit / release
# ──────────────────────────────────────────────────────────────────────

def reserve_chat(user_id: str) -> ChatReserveDecision:
    """Atomic check-and-reserve for one Ask-CFO-AI message.

    The RPC `reserve_user_chat` locks both the monthly and daily rows
    (FOR UPDATE) before deciding, so concurrent calls serialize on the
    lock — gap C atomicity holds across the two-counter dual-cap check.
    """
    if not enforced_for(user_id):
        return ChatReserveDecision(
            kind="disabled", plan_key="trial",
            daily_used=0, daily_cap=None,
            monthly_used=0, monthly_cap=None,
            message="",
        )

    state = _plan_state.get_plan_state(user_id)
    plan = state.plan

    body = _rpc("reserve_user_chat", {
        "p_user_id":     user_id,
        "p_month":       _month_bucket(),
        "p_day":         _today().isoformat(),
        "p_daily_cap":   plan.chat.daily,
        "p_monthly_cap": plan.chat.monthly,
    }) or {}

    kind = body.get("kind", "monthly_cap_reached")

    if kind == "allowed":
        return ChatReserveDecision(
            kind="allowed",
            plan_key=plan.key,
            daily_used=int(body.get("daily_used") or 0),
            daily_cap=plan.chat.daily,
            monthly_used=int(body.get("monthly_used") or 0),
            monthly_cap=plan.chat.monthly,
            message="",
        )

    if kind == "daily_cap_reached":
        return ChatReserveDecision(
            kind="daily_cap_reached",
            plan_key=plan.key,
            daily_used=int(body.get("daily_used") or 0),
            daily_cap=plan.chat.daily,
            monthly_used=int(body.get("monthly_used") or 0),
            monthly_cap=plan.chat.monthly,
            message=(
                f"Daily Ask CFO AI limit reached for the {plan.display_name} "
                f"plan ({plan.chat.daily} messages / day). Resets at midnight UTC."
            ),
        )

    return ChatReserveDecision(
        kind="monthly_cap_reached",
        plan_key=plan.key,
        daily_used=int(body.get("daily_used") or 0),
        daily_cap=plan.chat.daily,
        monthly_used=int(body.get("monthly_used") or 0),
        monthly_cap=plan.chat.monthly,
        message=(
            f"Monthly Ask CFO AI limit reached for the {plan.display_name} "
            f"plan ({plan.chat.monthly} messages / month). Resets at the "
            f"start of your next billing period."
        ),
    )


def commit_chat(user_id: str) -> None:
    """Opus call returned a complete response. Convert reservation →
    consumed in both the daily and monthly counters."""
    if not enforced_for(user_id):
        return
    _rpc("commit_user_chat", {
        "p_user_id": user_id,
        "p_month":   _month_bucket(),
        "p_day":     _today().isoformat(),
    })


def release_chat(user_id: str) -> None:
    """Opus call errored before producing a complete response (gap D,
    optional principle applied to chat). Drop the reservation; nothing
    counted against the user."""
    if not enforced_for(user_id):
        return
    _rpc("release_user_chat", {
        "p_user_id": user_id,
        "p_month":   _month_bucket(),
        "p_day":     _today().isoformat(),
    })
