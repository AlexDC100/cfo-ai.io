"""PERIOD MOVE — the correction path (Part D, gate W4).

WHY THIS EXISTS
---------------
Part B stopped new uploads from being misfiled. It could not fix the rows
already in the database: the 2026-08-30 production audit found a 2025
Carniprod trial balance filed under 2017-12, and a 2025-12 period holding
two different companies' files. This module is the only way a human can
correct those, and the frontend menu item ("Move to another period…") is
its one entry point.

WHAT A MOVE ACTUALLY IS
-----------------------
`period_end` IS the period's identity — it keys `financial_periods`, the
snapshot the header labels, YoY alignment and the benchmark's fiscal
match. So a move is not a label edit. The document's analysis has to
LEAVE one period and LAND in another, and both ends have to be left
describing documents that are actually attached to them.

Landing is delegated, not reimplemented: the move writes the human's
confirmation into `documents.period_end_hint` and re-runs the pipeline.
`stage_persist` then resolves the period exactly as it always has (hint
first — see `resolve_period_end_for_persist`), adopts or creates the
destination row, and rewrites its line items. There is deliberately no
second, parallel "file a document into a period" implementation here;
one authority, reused.

THE HINT, USED CORRECTLY
------------------------
`documents.period_end_hint` means "a human confirmed that THIS document
belongs to THIS month". The bug this whole effort exists to end was the
frontend filling that channel with the DROP TARGET's date — a number
read off the UI, never off the document. A move is the one place the
channel is legitimately written: the user is looking at this document and
stating its month. So this module writes the hint, and writes ONLY a date
the caller explicitly supplied. There is no default, no fallback to
today, and no fallback to whichever period happens to be open — a move
request without a target is a 422, not a guess.

W4 — NO ORPHANED SNAPSHOT MAY BE SERVED AFTERWARDS
--------------------------------------------------
An orphaned snapshot is a period still serving an analysis that no live
attached document backs. It is not hypothetical: on 2026-08-13 a period
served a DELETED document's numbers under a newer document's name, which
is why `stage_persist` stamps `provenance.source_document_id` onto every
envelope. `find_orphaned_snapshots` is the predicate over that stamp, and
every move runs it over its own work before returning — the result ships
in the response as `orphaned_after`, so the invariant is observable in
production and not merely asserted in a test.

The three ways a move could orphan something, and what this module does:

  · the emptied period keeps its envelope        → delete the period and
    (nothing left attached at all)                 its derivatives
  · the period's envelope was built from the     → wipe the derivatives,
    departing document but siblings remain         re-point the source to
                                                   a sibling and re-run it
  · the envelope belongs to a document that      → touch nothing. Correct
    stays                                          data is never rewritten

The middle case leaves the period momentarily EMPTY rather than showing
the mover's numbers under a sibling's name. Honest absence beats a
confident wrong answer; ABSENT != ZERO applies to periods too.

Python 3.9 — no `match`, no `X | Y` unions.
"""

from __future__ import annotations

import calendar
import logging
import re
from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set

from . import _staged_rerun

logger = logging.getLogger("engine.period_move")

#: What happens to the period the document is LEAVING.
SOURCE_ACTIONS = ("none", "deleted", "rebuilt", "kept")

#: Derivatives of a period, in delete order. Explicit per-table rather
#: than relying on the FK cascade — the same reasoning as
#: `pipeline.delete_period`: a cascade that is silently missing on one
#: table leaves rows nothing will ever read and nothing will ever clean.
#: `user_valuation_assumptions` is the user's own INPUT, not a derived
#: artifact, so it is dropped only when the period itself ceases to exist.
_DERIVED_TABLES = ("statement_line_items", "calculated_metrics", "briefings", "valuations")
_USER_INPUT_TABLES = ("user_valuation_assumptions",)

_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_ISO_MONTH = re.compile(r"^\d{4}-\d{2}$")


class MoveRefused(ValueError):
    """A move that must not happen, with a code the UI can branch on.

    Refusal is a first-class outcome here. The alternative — accepting an
    unparseable or implausible date and letting the pipeline "sort it
    out" — is exactly how the 2050-12-31 rows were minted.
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class MovePlan:
    """The decision, made before anything is written. Pure and printable
    so the refusal/actions are reviewable without a database."""

    moved: bool
    target_period_end: str
    source_period_id: Optional[str]
    source_period_end: Optional[str]
    source_action: str
    rebuild_document_id: Optional[str]


# ── target validation ─────────────────────────────────────────────────


def normalize_target_period_end(value: Any) -> str:
    """The caller's confirmed month → a canonical ISO period end.

    Accepts `YYYY-MM-DD` and the bare `YYYY-MM` the month picker
    produces (resolved to that month's last day — the trial-balance
    convention the rest of the engine uses). Everything else is refused.

    There is NO fallback branch in this function on purpose: no target,
    no move. A correction tool that can invent a date is not a correction
    tool, and every implausible period in production got there because
    some path invented one.
    """
    if not isinstance(value, str) or not value.strip():
        raise MoveRefused(
            "invalid_period_end",
            "A period end is required, as YYYY-MM-DD or YYYY-MM.",
        )
    raw = value.strip()

    if _ISO_MONTH.match(raw):
        try:
            year, month = int(raw[:4]), int(raw[5:7])
            last = calendar.monthrange(year, month)[1]
        except (ValueError, calendar.IllegalMonthError):
            raise MoveRefused("invalid_period_end", "%r is not a real month." % raw)
        iso = "%04d-%02d-%02d" % (year, month, last)
    elif _ISO_DATE.match(raw):
        try:
            iso = date.fromisoformat(raw).isoformat()
        except ValueError:
            raise MoveRefused("invalid_period_end", "%r is not a real date." % raw)
    else:
        raise MoveRefused(
            "invalid_period_end",
            "%r is not an ISO date. Expected YYYY-MM-DD or YYYY-MM." % raw,
        )

    # The engine's own clamp, reused — month-end convention and sanity
    # bounds keep living in one place (same discipline as _period_detect).
    from .pipeline import _sane_period_end  # noqa: WPS433 — deliberate lazy import

    if _sane_period_end(iso) is None:
        raise MoveRefused(
            "implausible_period_end",
            "%s is outside the plausible reporting window (2000-2035)." % iso,
        )
    return iso


# ── reading the truth off a period row ────────────────────────────────


def envelope_source_document_id(period: Optional[Dict[str, Any]]) -> Optional[str]:
    """The document the period's persisted analysis was BUILT FROM, per
    the provenance stamp `stage_persist` writes. `None` when the period
    carries no envelope — which is absence, not a mismatch."""
    if not isinstance(period, dict):
        return None
    envelope = period.get("assembled_canonical_v1")
    if not isinstance(envelope, dict):
        return None
    provenance = envelope.get("provenance")
    if not isinstance(provenance, dict):
        return None
    value = provenance.get("source_document_id")
    return str(value) if value else None


def analysis_belongs_to(period: Optional[Dict[str, Any]], document_id: str) -> bool:
    """True when this document is what the period is currently serving —
    either by the envelope's provenance stamp or by the period row's own
    `source_document_id` pointer. Both are checked because a period can
    carry the pointer before an envelope has ever been written."""
    if not isinstance(period, dict):
        return False
    if envelope_source_document_id(period) == document_id:
        return True
    pointer = period.get("source_document_id")
    return bool(pointer) and str(pointer) == document_id


def pick_rebuild_document(
    candidates: Sequence[Dict[str, Any]],
) -> Optional[str]:
    """Which remaining document should become the period's analysis
    source. Deterministic: an analyzed document beats an unanalyzed one,
    newer beats older, and the id breaks any remaining tie so two runs
    can never disagree."""
    live = [d for d in candidates if d.get("deleted_at") is None and d.get("scope") != "sku"]
    if not live:
        return None

    def stamp(doc: Dict[str, Any]) -> str:
        return str(doc.get("updated_at") or doc.get("created_at") or "")

    def analyzed(doc: Dict[str, Any]) -> int:
        return 0 if (doc.get("status") or "").lower() == "analyzed" else 1

    # Stable sorts, least significant key first — the plain way to mix
    # ascending and descending orders without inventing an inverted string
    # key. Order: analyzed before unanalyzed, newer before older, id last
    # so two runs on the same rows can never disagree.
    ordered = sorted(live, key=lambda d: str(d.get("id") or ""))
    ordered = sorted(ordered, key=stamp, reverse=True)
    ordered = sorted(ordered, key=analyzed)
    return str(ordered[0].get("id"))


# ── the plan (pure) ───────────────────────────────────────────────────


def plan_move(
    *,
    document: Dict[str, Any],
    from_period: Optional[Dict[str, Any]],
    siblings: Sequence[Dict[str, Any]],
    target_period_end: str
) -> MovePlan:
    """Decide the move without touching anything.

    Keyword-only and clock-free by design: everything the decision needs
    is a row that was read, and the decision can therefore be reviewed,
    logged and tested on its own — the write path below only executes it.
    """
    document_id = str(document.get("id") or "")

    if not isinstance(from_period, dict):
        # A document with no period (mid-pipeline, or detached by an
        # earlier failure). Nothing to invalidate; the re-run files it.
        return MovePlan(
            moved=True,
            target_period_end=target_period_end,
            source_period_id=None,
            source_period_end=None,
            source_action="none",
            rebuild_document_id=None,
        )

    source_period_id = str(from_period.get("id") or "") or None
    source_period_end = str(from_period.get("period_end") or "")[:10] or None

    if source_period_end == target_period_end:
        # Already where the user says it belongs. Doing the work anyway
        # would wipe and rebuild a correct period for no reason.
        return MovePlan(
            moved=False,
            target_period_end=target_period_end,
            source_period_id=source_period_id,
            source_period_end=source_period_end,
            source_action="none",
            rebuild_document_id=None,
        )

    remaining = [
        d
        for d in (siblings or [])
        if str(d.get("id") or "") != document_id and d.get("deleted_at") is None
    ]

    if not remaining:
        # Nobody LIVE stays attached. The period goes only when what it
        # holds is the mover's own analysis, or nothing at all (a container
        # that names no source and carries no envelope). An analysis that is
        # ANOTHER document's stays — its document can be in "Recently
        # deleted", restorable for 30 days, and this branch used to hard-
        # delete the month it would be restored to (measured 2026-10-04:
        # the month's own file in the bin, a restored superseded copy moved
        # away, the month's line items, metrics, briefing and valuations
        # gone). `find_orphaned_snapshots` reports such a period as having
        # no live document, which is true; it is the restore's to serve.
        empty_container = (not from_period.get("source_document_id")
                           and not isinstance(from_period.get("assembled_canonical_v1"), dict))
        if analysis_belongs_to(from_period, document_id) or empty_container:
            action, rebuild = "deleted", None
        else:
            action, rebuild = "kept", None
    elif analysis_belongs_to(from_period, document_id):
        action, rebuild = "rebuilt", pick_rebuild_document(remaining)
    else:
        # The analysis left behind belongs to a document that is staying.
        # It is still true, so it is not touched.
        action, rebuild = "kept", None

    return MovePlan(
        moved=True,
        target_period_end=target_period_end,
        source_period_id=source_period_id,
        source_period_end=source_period_end,
        source_action=action,
        rebuild_document_id=rebuild,
    )


# ── W4 — the orphan predicate ─────────────────────────────────────────


def find_orphaned_snapshots(
    client: Any,
    *,
    org_id: str,
    audit_period_ids: Iterable[str] = ()
) -> List[Dict[str, Any]]:
    """Every period in this org that is serving an analysis no live
    attached document backs. Empty is the invariant.

    `audit_period_ids` names periods that may no longer have a row — a
    caller that just deleted one asks about it explicitly. The derivative
    tables are never swept unscoped: they carry no `org_id`, so an
    unfiltered read would cross tenants and would grow with the whole
    database.
    """
    periods = client.select(
        "financial_periods", filters={"org_id": "eq.%s" % org_id}
    )
    # A re-run's STAGED row (`_staged_rerun`) is not a period serving
    # anything: it carries an envelope and line items and no document is
    # attached to it, by design, until its run takes the month over or its
    # row is dropped. Reported here it would read as "a period nobody backs".
    periods = [p for p in (periods or []) if _staged_rerun.marker_of(p) is None]
    live_docs = client.select(
        "documents",
        filters={"org_id": "eq.%s" % org_id, "deleted_at": "is.null"},
    )

    attached: Dict[str, List[str]] = {}
    live_ids = set()
    for doc in live_docs:
        doc_id = str(doc.get("id") or "")
        live_ids.add(doc_id)
        period_id = doc.get("period_id")
        if period_id:
            attached.setdefault(str(period_id), []).append(doc_id)

    findings: List[Dict[str, Any]] = []
    known_period_ids = {str(p.get("id") or "") for p in periods}

    # A period carrying an envelope is decidable from what we already
    # read. Only the ones WITHOUT an envelope need a derivative probe to
    # tell "empty container" from "still serving line items", so the
    # probe runs over that (normally tiny) set in ONE query per table
    # rather than two queries per period.
    probe_ids = {
        str(p.get("id") or "")
        for p in periods
        if not isinstance(p.get("assembled_canonical_v1"), dict)
    }
    probe_ids.update(
        pid for pid in {str(p) for p in audit_period_ids if p} if pid
    )
    with_derivatives = _periods_with_derivatives(client, probe_ids)

    for period in periods:
        period_id = str(period.get("id") or "")
        attached_ids = attached.get(period_id, [])
        has_envelope = isinstance(period.get("assembled_canonical_v1"), dict)
        if not has_envelope and period_id not in with_derivatives:
            # An empty container is an invitation to attach, not a
            # defect. ABSENT != ZERO.
            continue

        provenance = envelope_source_document_id(period)
        if provenance and provenance in live_ids and provenance not in attached_ids:
            reason = "envelope_from_detached_document"
        elif not attached_ids:
            reason = "period_has_no_live_documents"
        elif provenance and provenance not in attached_ids:
            reason = "envelope_from_detached_document"
        else:
            continue

        findings.append(
            {
                "period_id": period_id,
                "period_end": period.get("period_end"),
                "reason": reason,
                "envelope_source_document_id": provenance,
                "attached_document_ids": attached_ids,
            }
        )

    for period_id in {str(p) for p in audit_period_ids if p}:
        if period_id in known_period_ids:
            continue
        if period_id in with_derivatives:
            findings.append(
                {
                    "period_id": period_id,
                    "period_end": None,
                    "reason": "derivatives_without_period",
                }
            )

    return findings


def _periods_with_derivatives(client: Any, period_ids: Iterable[str]) -> Set[str]:
    """Which of `period_ids` still have derived rows. One query per
    table, always filtered by period: these tables carry no `org_id`, so
    an unfiltered read would cross tenants and would grow with the whole
    database."""
    wanted = sorted({str(p) for p in period_ids if p})
    found: Set[str] = set()
    if not wanted:
        return found
    joined = ",".join(wanted)
    for table in ("statement_line_items", "calculated_metrics"):
        rows = client.select(
            table,
            filters={"period_id": "in.(%s)" % joined},
            columns="period_id",
        )
        for row in rows or []:
            period_id = row.get("period_id")
            if period_id:
                found.add(str(period_id))
    return found


# ── the write path ────────────────────────────────────────────────────


def move_document_to_period(
    client: Any,
    *,
    document: Dict[str, Any],
    target_period_end: str,
    now: str
) -> Dict[str, Any]:
    """Re-file `document` under `target_period_end`.

    Writes the human's confirmation and invalidates whatever the
    departure orphaned; the caller re-runs the pipeline, which is what
    actually rebuilds both ends. Returns the record the route surfaces
    and the run journal stores.
    """
    target = normalize_target_period_end(target_period_end)
    document_id = str(document.get("id") or "")
    org_id = str(document.get("org_id") or "")
    if not document_id or not org_id:
        raise MoveRefused("invalid_document", "Document is missing id or org.")
    _refuse_deleted(document)

    # THE PERIOD THE DOCUMENT LEAVES IS THE ONE THE ENGINE SAYS IS ITS OWN —
    # `financial_periods.source_document_id`, the pointer `stage_persist`
    # writes — and only a document that is the source of no period is read
    # by its pin (`documents.period_id`, which a browser can write). Read by
    # the pin alone, a document that owned December and was pinned to
    # another document's November moved "from November" (nothing of it
    # touched, correctly), kept its December, and its re-run filed it under
    # the new month: two periods for one document (re-verification
    # 2026-10-10, measured). The pin's period is never touched here when it
    # is not the document's.
    from_period = _own_period_by_pointer(client, document_id, org_id)
    if from_period is None:
        from_period = _period_row(client, document.get("period_id"), org_id=org_id)
        if from_period is None and document.get("period_id"):
            # A pin that names NOTHING of this company — and the same answer
            # as a pin that names another company's period (`_period_row`):
            # one code, one sentence. (Under production's foreign key a pin
            # always exists, so this is the foreign pin's answer in effect.)
            raise MoveRefused(PERIOD_MISSING, PERIOD_MISSING_MESSAGE)
    siblings = _live_siblings(client, from_period, document_id)
    plan = plan_move(
        document=document,
        from_period=from_period,
        siblings=siblings,
        target_period_end=target,
    )

    if not plan.moved:
        return _record(plan, document_id=document_id, destination_period_id=None,
                       orphaned=[], filename=document.get("original_filename"))

    # Read without a limit: the newest row of the month may be a re-run's
    # STAGED row (`_staged_rerun`), which is never a destination — the record
    # would name a period that is about to stop existing.
    destination = [
        p for p in (client.select(
            "financial_periods",
            filters={"org_id": "eq.%s" % org_id, "period_end": "eq.%s" % target},
            order="updated_at.desc",
        ) or [])
        if _staged_rerun.marker_of(p) is None
    ]
    destination_period_id = str(destination[0]["id"]) if destination else None

    # 1. The confirmation, and the detach. Detaching first means that
    #    between now and the re-run nothing claims the document — an
    #    in-flight reader sees it as unfiled, which is true, rather than
    #    still counted under the period it is leaving.
    client.update(
        "documents",
        {"period_end_hint": target, "period_id": None},
        filters={"id": "eq.%s" % document_id},
    )

    # 2. Whatever the departure orphaned.
    if plan.source_action == "deleted" and plan.source_period_id:
        for table in _DERIVED_TABLES + _USER_INPUT_TABLES:
            _safe_delete(client, table, plan.source_period_id)
        # The company is named in the filter as well as on the row
        # `_period_row` checked: under the service role the filter IS the
        # access control, at every delete of a period.
        client.delete(
            "financial_periods",
            filters={"id": "eq.%s" % plan.source_period_id, "org_id": "eq.%s" % org_id},
        )
    elif plan.source_action == "rebuilt" and plan.source_period_id:
        for table in _DERIVED_TABLES:
            _safe_delete(client, table, plan.source_period_id)
        client.update(
            "financial_periods",
            {
                "assembled_canonical_v1": None,
                "source_document_id": plan.rebuild_document_id,
                "updated_at": now,
            },
            filters={"id": "eq.%s" % plan.source_period_id},
        )

    orphaned = find_orphaned_snapshots(
        client,
        org_id=org_id,
        audit_period_ids=[plan.source_period_id] if plan.source_period_id else [],
    )
    if orphaned:
        # W4 is checked in production, not only in the suite. Surfacing
        # beats silently succeeding: the response carries it and the
        # operator log names it.
        logger.error(
            "[period_move] W4 VIOLATED after moving document %s to %s: %s",
            document_id,
            target,
            orphaned,
        )

    return _record(
        plan,
        document_id=document_id,
        destination_period_id=destination_period_id,
        orphaned=orphaned,
        filename=document.get("original_filename"),
    )


def make_document_active(
    client: Any, *, document: Dict[str, Any], now: str
) -> Dict[str, Any]:
    """Promote an attachment to its period's ANALYSIS SOURCE.

    A period has exactly one: `financial_periods.source_document_id`,
    which is what `stage_persist` writes and what the envelope's
    provenance stamp records. Everything else attached to the period is
    an attachment. Promoting wipes the period's derived analysis and
    re-points the source; the caller re-runs the promoted document, which
    rebuilds the period through the ordinary pipeline.

    NEVER OVER ANOTHER ANALYSED DOCUMENT'S ANALYSIS: the wipe comes before
    the re-run has produced anything, so there it is refused before the
    first write (`_refuse_over_another_documents_analysis`). AND NEVER A
    PERIOD OTHER THAN THE ONE THE ENGINE SAYS IS THE DOCUMENT'S: where the
    pointer names a period, the pin must agree with it (below).
    """
    document_id = str(document.get("id") or "")
    org_id = str(document.get("org_id") or "")
    period_id = document.get("period_id")
    _refuse_deleted(document)
    if not period_id:
        raise MoveRefused(
            "not_in_a_period",
            "This file is not attached to a period yet, so it cannot be its "
            "analysis source.",
        )
    period = _period_row(client, period_id, org_id=org_id)
    if period is None:
        raise MoveRefused(PERIOD_MISSING, PERIOD_MISSING_MESSAGE)

    # THE PERIOD THE DOCUMENT IS PROMOTED IN IS THE ONE THE ENGINE SAYS IS
    # ITS OWN — `financial_periods.source_document_id`, the pointer
    # `stage_persist` writes — wherever the engine names one; the pin
    # (`documents.period_id`, which a browser can write) is a hint that must
    # agree with it. Read by the pin alone, a document that owned December
    # and was pinned to a source-less container of the same month had the
    # CONTAINER re-pointed at it, and its correction re-run — finding the
    # document's month by the pointer, which then named two rows — left two
    # periods naming one document (round-2 confirmer, 2026-10-10, measured
    # through this handler; with the document's own stamp on the container
    # the answer was "already the source", which was not true either).
    # Refused before the first write, with the one answer a pin that names
    # nothing gets (`PERIOD_MISSING`, as the move answers a dangling pin);
    # the real reason goes to the operator log. A document that is the source
    # of NOTHING is still read by its pin, as before.
    own = _own_period_by_pointer(client, document_id, org_id)
    if own is not None and str(own.get("id")) != str(period_id):
        logger.warning(
            "[period_move] REFUSED make-active: document %s is pinned to period %s "
            "while the engine names period %s as its own",
            document_id, period_id, own.get("id"),
        )
        raise MoveRefused(PERIOD_MISSING, PERIOD_MISSING_MESSAGE)

    if analysis_belongs_to(period, document_id):
        return {
            "changed": False,
            "document_id": document_id,
            "period_id": str(period_id),
            "period_end": period.get("period_end"),
            "requeue_document_id": None,
            "orphaned_after": [],
        }

    _refuse_over_another_documents_analysis(client, period, document_id, org_id)

    for table in _DERIVED_TABLES:
        _safe_delete(client, table, str(period_id))
    client.update(
        "financial_periods",
        {
            "assembled_canonical_v1": None,
            "source_document_id": document_id,
            "updated_at": now,
        },
        filters={"id": "eq.%s" % period_id},
    )
    orphaned = find_orphaned_snapshots(client, org_id=org_id) if org_id else []
    return {
        "changed": True,
        "document_id": document_id,
        "period_id": str(period_id),
        "period_end": period.get("period_end"),
        "requeue_document_id": document_id,
        "orphaned_after": orphaned,
    }


# ── small helpers ─────────────────────────────────────────────────────


def _refuse_deleted(document: Dict[str, Any]) -> None:
    """A DELETED document is neither moved nor promoted — refused before the
    first write.

    Both corrections end in a re-run of the document, and every analysis
    entry refuses a deleted one (`_doc_dedupe.enter_analysis`: DELETED /
    DUPLICATE). So the correction did its destructive half — make-active
    wiped the period's line items, metrics, briefing and valuations and
    re-pointed it at the deleted file; move-period detached the file and
    deleted or rebuilt the period it left — and the half that rebuilds
    never ran (measured 2026-10-04 on a superseded, archived upload still
    pinned to its month: the month was emptied for good)."""
    if document.get("deleted_at"):
        raise MoveRefused("document_deleted", "This file was deleted. Restore it first.")


#: `make-active` refused: the period holds the analysis of ANOTHER document
#: that is analysed. The Workspace prints its own sentence for this code
#: (frontend/components/cfo/workspace/periodFilingStrings.json).
MONTH_HAS_ANOTHER_ANALYSIS = "month_has_another_analysis"

#: The pinned period cannot be acted on: it does not exist — or it is not
#: this company's, which is answered with the SAME code and sentence (one
#: answer, on purpose: `_period_row`) — or it is not the period the engine
#: says is the document's (`make_document_active`, the move's dangling pin).
#: The Workspace prints its own sentence for the code.
PERIOD_MISSING = "period_missing"
PERIOD_MISSING_MESSAGE = "The file's period no longer exists."


def _refuse_over_another_documents_analysis(
    client: Any, period: Dict[str, Any], document_id: str, org_id: str
) -> None:
    """`make-active` never destroys the analysis of ANOTHER analysed document.

    THE DEFECT (review 2026-10-05, measured end to end; the same on 7ca386ec).
    Promoting wipes the period's line items, metrics, briefing and
    valuations and re-points its source BEFORE the promoted document's
    re-run has produced anything to put in their place. On a month that
    holds another document's analysis — a superseded upload restored from
    "Recently deleted", a file a Workspace merge attached, each of them a
    live attachment with "Make source" enabled — that is: the newer file's
    statements gone at the click; then, with the narration refused, its last
    good briefing gone for good and its recommendations left on the older
    file's statements; or, the re-run failing, an EMPTY month with a failed
    document over it. It is the retry route's item 1 through the other
    door, at exactly the state that route's refusal leaves the reader in.

    THE SAFE BEHAVIOUR, UNTIL THE DURABLE ONE IS BUILT: refuse — nothing is
    written, the month is served as it was — and say what does work:
    uploading the file again stages beside the month and replaces it only
    once its own analysis has succeeded (G4), keeping the briefing when the
    narration fails. The durable form is that same mechanism for a
    promotion: run the promoted document STAGED beside the month and
    re-point `source_document_id` only in the takeover; it needs the staged
    re-run's ownership looks (mint, T0, resume) to accept a promotion, and a
    reader that says a promotion is under way.

    Refused only for what would be destroyed: the document the period names
    (its pointer, else its envelope's provenance stamp) must exist in THIS
    company and be `analyzed` — live, or in "Recently deleted" (restorable
    for 30 days, and `plan_move` keeps such a period for the same reason).
    A period whose own document failed, is gone, or that names nobody is
    promoted as before: there is no good analysis under it to lose."""
    holder = str(period.get("source_document_id") or "") or (envelope_source_document_id(period) or "")
    if not holder or holder == document_id:
        return
    rows = client.select(
        "documents",
        filters={"id": "eq.%s" % holder, "org_id": "eq.%s" % org_id},
    )
    rows = [r for r in (rows or []) if str(r.get("org_id") or "") == str(org_id)]
    if rows and str(rows[0].get("status") or "").lower() == "analyzed":
        raise MoveRefused(
            MONTH_HAS_ANOTHER_ANALYSIS,
            "This month already has an analysis from another file, so this file was "
            "not made its source and nothing was changed. To use this file for the "
            "month, upload it again.",
        )


def _own_period_by_pointer(client: Any, document_id: str, org_id: str) -> Optional[Dict[str, Any]]:
    """The period whose analysis IS this document's, by the pointer the
    engine wrote — read under the company (under the service role the
    filter is the access control) and re-checked; a re-run's STAGED row
    (`_staged_rerun`, which names no source) is never one. The newest when
    legacy rows left more than one; None when the document is the source of
    nothing."""
    caller = str(org_id or "").strip()
    document_id = str(document_id or "").strip()
    if not caller or not document_id:
        return None
    rows = client.select(
        "financial_periods",
        filters={"org_id": "eq.%s" % caller, "source_document_id": "eq.%s" % document_id},
        order="updated_at.desc",
    ) or []
    own = [r for r in rows
           if str(r.get("org_id") or "").strip() == caller
           and str(r.get("source_document_id") or "") == document_id
           and _staged_rerun.marker_of(r) is None]
    return dict(own[0]) if own else None


def _period_row(client: Any, period_id: Any, *, org_id: str) -> Optional[Dict[str, Any]]:
    """Fetch a period BY ID under the service role, refusing one that
    belongs to another tenant.

    WHY THE TENANT IS A REQUIRED ARGUMENT (P0, 2026-09-09).
    `documents.period_id` is written by the BROWSER — `documents` RLS is
    `is_member_of(org_id)` with no column restriction, and
    frontend/lib/supabase.ts inserts the row including `period_id`. Its
    foreign key to `financial_periods(id)` is EXISTENCE-only; nothing
    constrains it to the same organization.

    `client` here is the SERVICE ROLE, so this select bypasses RLS: the
    filter IS the access control. The write wall
    (`_verify_user_may_write_document`) validates membership in the
    DOCUMENT's org and never looks at `period_id`. So a row filed in your
    own workspace, carrying another workspace's period id, walked
    straight through it — and `make_document_active` then hard-deleted
    that period's statement_line_items, calculated_metrics, briefings and
    valuations, nulled its assembled_canonical_v1 and re-pointed its
    source_document_id at the attacker's file.

    This is the same defect as the storage-path bypass fixed the same day
    (see `_supabase.assert_tenant_path`): a browser-written column
    consumed by raw value in a service-role operation, behind a wall that
    checks a different object. A firm viewer holding only a read cell has
    every client period id by design, so the adversary is the one the
    write wall was written for.
    """
    if not period_id:
        return None
    rows = client.select(
        "financial_periods", filters={"id": "eq.%s" % period_id}, single=True
    )
    row = rows[0] if rows else None
    if row is None:
        return None
    owner = str(row.get("org_id") or "").strip()
    caller = str(org_id or "").strip()
    if not caller or owner != caller:
        # ONE ANSWER for "that period is another company's" and "that period
        # does not exist" (`PERIOD_MISSING`, the code and the sentence the
        # callers raise for a pin that names nothing): the refusal must not
        # tell a caller holding a UUID that it is some other tenant's. The
        # real reason goes to the operator log alone (re-verification
        # 2026-10-10; until then the code was `period_not_in_workspace`,
        # "That period belongs to a different workspace.").
        logger.error(
            "[security] REFUSED cross-tenant period access: period=%r "
            "period_org=%r caller_org=%r", period_id, owner, caller,
        )
        raise MoveRefused(PERIOD_MISSING, PERIOD_MISSING_MESSAGE)
    return row


def _live_siblings(
    client: Any, from_period: Optional[Dict[str, Any]], document_id: str
) -> List[Dict[str, Any]]:
    if not isinstance(from_period, dict):
        return []
    # THE TENANT IS IN THE FILTER (tenancy hotfix 2026-10-02). `client` is
    # the service role and `documents.period_id` is browser-writable: a
    # member of another workspace can point a row of THEIR org at this
    # period. Read by `period_id` alone, that row came back as a sibling,
    # was picked as the rebuild document (analysed, newest) and the period
    # every member of THIS workspace reads was wiped and re-pointed at it.
    # `from_period` was tenant-checked by `_period_row` against the moved
    # document's org, so its `org_id` is the authorized one.
    org_id = from_period.get("org_id")
    rows = client.select(
        "documents",
        filters={
            "period_id": "eq.%s" % from_period.get("id"),
            "org_id": "eq.%s" % org_id,
            "deleted_at": "is.null",
        },
    )
    return [r for r in rows
            if str(r.get("id") or "") != document_id and str(r.get("org_id")) == str(org_id)]


def _safe_delete(client: Any, table: str, period_id: str) -> None:
    try:
        client.delete(table, filters={"period_id": "eq.%s" % period_id})
    except Exception:  # noqa: BLE001 — a missing optional table must not
        # abort a correction the user asked for; the orphan audit below
        # reports anything that actually survived.
        logger.exception("[period_move] delete failed on %s for period %s", table, period_id)


def _record(
    plan: MovePlan,
    *,
    document_id: str,
    destination_period_id: Optional[str],
    orphaned: List[Dict[str, Any]],
    filename: Optional[str]
) -> Dict[str, Any]:
    return {
        "ok": True,
        "moved": plan.moved,
        "document_id": document_id,
        "original_filename": filename,
        "period_end_hint": plan.target_period_end if plan.moved else None,
        "from": {
            "period_id": plan.source_period_id,
            "period_end": plan.source_period_end,
            "action": plan.source_action,
        },
        "to": {
            "period_end": plan.target_period_end,
            # Not invented: the destination row is reported only when it
            # already exists. `stage_persist` creates it on the re-run.
            "period_id": destination_period_id,
        },
        "rebuild_document_id": plan.rebuild_document_id,
        "orphaned_after": orphaned,
    }


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── routes ────────────────────────────────────────────────────────────
#
# Dependencies are INJECTED rather than imported from `pipeline`, matching
# `_reconcile.register_routes` / `_journal_routes.register_routes`. It
# keeps the import graph one-directional and lets the suite drive the
# real handlers against a store double without monkeypatching module
# globals.

try:  # pragma: no cover - import shape only
    from pydantic import BaseModel
except ImportError:  # pragma: no cover
    BaseModel = object  # type: ignore


class MovePeriodRequest(BaseModel):  # type: ignore[misc,valid-type]
    """POST body for `/api/documents/{id}/move-period`.

    `extra="forbid"` is the same guard `/api/period/detect` carries, for
    the same reason: an unknown field is a 422, never a silently-ignored
    one. The move's date must be the one the human confirmed, and the
    body must not be able to carry a second candidate (the open period,
    the drop target) alongside it.

    Declared at MODULE level — a Pydantic model defined inside a router
    factory cannot have its annotations resolved by FastAPI, which
    degrades the body into a query parameter and 500s `/openapi.json`
    (CLAUDE.md §16).
    """

    model_config = {"extra": "forbid"}

    period_end: str


def register_routes(
    router: Any,
    *,
    require_jwt: Any,
    verify_owns: Any,
    set_status: Any,
    enqueue: Any,
    admin_client: Any,
    rerun: Any = None,
    is_running: Any = None
) -> None:
    """Mount the correction path onto `router`.

    require_jwt(authorization) -> jwt
    verify_owns(jwt, document_id) -> document row (raises 404/403)
    set_status(document_id, status, **kw) -> None
    enqueue(document_id) -> None
    admin_client() -> context-managed service-role client
    rerun(jwt, document_id, started_at) -> None — optional: the host's
        re-run entry. The engine passes `pipeline._correction_rerun`, which
        re-runs an analysed document exactly as below (unmetered) and meters
        a document that holds no analysis yet like its first analysis — a
        move is how a failed, undated upload gets its month. May raise the
        meter's 402 / 429 (the move itself has already been written).
        Absent → set_status + enqueue.
    is_running(document_id) -> bool — optional: True while the document's
        run is in flight (`_doc_dedupe.in_flight`). A move / make-active of
        such a document is refused 409 `analysis_in_progress` BEFORE
        anything is re-filed: the run in flight read the document's month
        when it started, so its analysis would land in the month the user
        is correcting away from — and the correction's own re-run cannot
        start while that run holds the document (verifier lens S, S11).
    """
    from fastapi import Header, HTTPException  # local: keeps this module
    # importable (and unit-testable) without FastAPI installed.

    def _refuse(exc: MoveRefused) -> "HTTPException":
        return HTTPException(400, {"code": exc.code, "message": exc.message})

    def _refuse_while_running(document_id: str) -> None:
        if is_running is not None and is_running(document_id):
            raise HTTPException(409, {
                "code": "analysis_in_progress",
                "message": ("This file is still being analysed. Try again when the "
                            "analysis has finished."),
            })

    def _requeue(jwt: str, document_id: str, started_at: str) -> None:
        # Deliberately NOT routed through /api/pipeline/run: a correction
        # of an analysed document is not a new document and must not
        # consume the user's upload quota or be billed as an extra. Same
        # reasoning as /api/pipeline/retry. A document that holds NO
        # analysis yet (a failed, undated upload given its month here) is
        # its first analysis: the host's `rerun` meters it (2026-09-21).
        if rerun is not None:
            rerun(jwt, document_id, started_at)
            return
        set_status(document_id, "queued", pipeline_started_at=started_at)
        enqueue(document_id)

    def _requeue_all(jwt: str, document_ids: Sequence[Any], started_at: str) -> None:
        """Re-run every document the correction touched — the rebuild of
        the period left behind included — even when the meter refuses one
        of them; the first refusal is raised after all were asked."""
        refused: Optional[Exception] = None
        for doc_id in document_ids:
            if not doc_id:
                continue
            try:
                _requeue(jwt, str(doc_id), started_at)
            except HTTPException as exc:
                refused = refused or exc
        if refused is not None:
            raise refused

    @router.post("/api/documents/{document_id}/move-period")
    def move_document_period(
        document_id: str,
        req: MovePeriodRequest,
        authorization: Optional[str] = Header(None),
    ) -> Dict[str, Any]:
        """Re-file one document under a month the user confirmed for it.

        The response carries `orphaned_after` — W4's own verdict on the
        work just done. It should always be empty; if it is not, the UI
        has a fact worth showing rather than a silent success.
        """
        jwt = require_jwt(authorization)
        document = verify_owns(jwt, document_id)
        _refuse_while_running(document_id)
        now = _now_iso()
        try:
            with admin_client() as client:
                record = move_document_to_period(
                    client,
                    document=document,
                    target_period_end=req.period_end,
                    now=now,
                )
        except MoveRefused as exc:
            raise _refuse(exc)

        if record["moved"]:
            try:
                _requeue_all(jwt, [document_id, record["rebuild_document_id"]], now)
            finally:
                _record_move_in_journal(document, record)
        return record

    @router.post("/api/documents/{document_id}/make-active")
    def make_document_active_route(
        document_id: str,
        authorization: Optional[str] = Header(None),
    ) -> Dict[str, Any]:
        """Make this document the ANALYSIS SOURCE of its period. One per
        period; the others stay attached as attachments."""
        jwt = require_jwt(authorization)
        document = verify_owns(jwt, document_id)
        _refuse_while_running(document_id)
        now = _now_iso()
        try:
            with admin_client() as client:
                record = make_document_active(client, document=document, now=now)
        except MoveRefused as exc:
            raise _refuse(exc)

        if record["changed"] and record["requeue_document_id"]:
            _requeue_all(jwt, [record["requeue_document_id"]], now)
        return record


def _record_move_in_journal(document: Dict[str, Any], record: Dict[str, Any]) -> None:
    """Never raises, never blocks the correction — the journal is an
    observer, exactly as it is at every pipeline seam."""
    try:
        from engine.journal import hooks as journal_hooks

        journal_hooks.on_period_moved(document, record)
    except Exception:  # noqa: BLE001
        logger.exception("[period_move] journal hook failed (non-fatal)")
