"""THE FIRM COCKPIT — attention routes.

    GET  /api/firm/attention                  the board: one row per client,
                                              N reasons, ranked by top item
                                              then nearest deadline
    GET  /api/firm/attention/kinds            the declared kinds, the ladder,
                                              the covenant schema, absences
    GET  /api/firm/attention/suppressions     the suppressions in force
    POST /api/firm/attention/suppress         suppress one (client, kind,
                                              scope) WITH a reason

Every figure the board serves is computed by ``engine.firm`` from
persisted envelopes read through the FactsGateway. This module only
LOADS the client book and hands it over; it holds no arithmetic and no
detector. The ONE clock read in the whole feature is here — ``as_of``
defaults to today and may be pinned with ``?as_of=YYYY-MM-DD``, which is
also how the frontend replays a board.

TENANCY. Reads go through the caller's OWN Supabase client, so RLS
scopes the book: the workspaces they are a member of, plus — once
``supabase/schema_phase_firm.sql`` is applied — every client workspace
attached to a firm they can ``read`` (``can_read_client_org``). There is
no service-role read here; a caller sees exactly the organizations
PostgREST returns them. Suppressions are inserted by the caller too, so
``firm_attention_suppressions``' policy (member, or a firm role whose
``suppress`` cell is true) is the authority, never this module.

THE ERA PIN (D3). A suppression or covenant row carries ``firm_id`` — the
firm serving the client when it was written (the migration's BEFORE
INSERT trigger stamps it; no caller can set it). A row is in force only
while that firm still serves the client (``organizations.firm_id``) or
when it is the client's own (``firm_id`` null): a client that moves from
firm A to firm B carries A's decisions — with A's accountant's uuid —
onto no board and into no list of B's. The read policies pin the same
way (``firm_id is null or firm_id = firm_of_org(org_id)``), and
``current_era_rows`` pins here, so either wall alone holds.

INCREMENTAL (FC9). Periods are listed LIGHT first — ids, timestamps, the
envelope's content hash and whether one exists — which is all the cache
key needs. Envelopes and statements are pulled only for clients whose
key missed the process-level cache, through lazy providers the facts
stage calls on a miss. Opening the board never reloads an unchanged
client.

PAGED (A2, D9). PostgREST caps EVERY response at the deployment's
``db-max-rows`` (Supabase's default: 1000) — silently: no error, no
marker, the rows past the cap are simply not in the body. The client
this module reads through sends no Range header and never loops, so an
unbounded list read here lost rows past 1000 — clients vanished from
the board, periods from clients — and the PostgREST double could not
see it because it did not cap. ``engine.api._paging.select_all`` is the
ONE way this module reads a list: an explicit offset walk over a TOTAL
order that stops ONLY on an EMPTY page (never on a short one — the cap
is the deployment's knob, not this module's belief), ``in.()`` filters
chunked. The double caps at a size the test chooses
(tests/engine/firm_postgrest_double.py: 37 / 500 / 1000) so a walk that
assumes the cap is a red, not a quiet board. tests/engine/
test_firm_route.py carries the census: no bare ``.select(`` of a list
outside the walk, in this module or any ``_firm*`` sibling.

NO WIDENING ON FAILURE (D10). The ``organizations`` read filters
archived workspaces out; the ONE reason to re-read without that filter
is a schema that predates the column (PostgREST 42703 on the FIRST
page). Any other failure — a transient 503 on page 2 — keeps the rows
already read, admits no archived client, and states on the payload how
many clients were read and why the walk stopped.

THE DEAD REGISTRY (D6). The board computes nothing from the AI model
registry (C9), but the AI-assisted features around it do; ``registry_
notice`` probes it once per request and the payload carries ONE notice
naming the registry's own error when it cannot resolve. The app itself
no longer dies at import under a dead registry (engine.api.pipeline and
engine.ai_lane.config read it at first use).

Python 3.9 — no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

import logging
import re
from datetime import date
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from engine.firm import attention as FA
from engine.firm.facts import AttentionCache
from engine.firm.model import ClientRecord, CovenantRecord, PeriodRecord
from engine.firm.suppress import Suppression, SuppressionIndex

from pydantic import BaseModel, Field

from . import _finding_rank as R
# CAEN's one authority. `_org` imports only `_jwt` and `_supabase`,
# so there is no cycle back to this module.
from . import _org
from ._paging import (IN_CHUNK, MAX_PAGES, PAGE_ROWS, PageWalkError, chunked, in_filter,
                      select_all)

logger = logging.getLogger(__name__)


class SuppressBody(BaseModel):
    """POST /api/firm/attention/suppress. Module-scoped on purpose: a
    Pydantic model nested inside the route factory is a forward ref
    FastAPI cannot resolve (the documented /openapi.json 500), and it
    then reads the body as a query parameter."""

    client_id: str
    kind: str
    scope_key: str = Field(default=R.SCOPE_ANY)
    reason: str
    periods: Optional[int] = None
    from_period_ordinal: Optional[int] = None

#: Process-level cache: keyed on (client, snapshot key), survives across
#: requests. A deploy restarts it; nothing is served stale because the
#: key changes with every envelope write (financial_periods.updated_at).
_CACHE = AttentionCache(max_entries=8192)

#: Periods read per client, newest first. Persistence needs three,
#: the cadence lookback six; twelve leaves room for a quarterly client.
PERIODS_PER_CLIENT = 12

#: Light period columns — everything the cache key needs and nothing
#: heavier. The two JSON-path aliases are what make the first pass cheap:
#: the content hash the FactsGateway stamps on every Fact, and a
#: non-null marker iff an envelope exists at all.
# NO CAEN HERE, and the explanation lives ABOVE the tuple rather than
# inside it: a comment between the string fragments is indistinguishable
# from a column name to the text scan that guards this
# (tests/engine/test_caen_one_authority.py), and it reds on its own
# explanation. The same shape as a Python comment inside a frozenset that
# a mirror test read as a member.
#
# `caen_code` is not a column on `financial_periods` — phase 7 put CAEN on
# `organizations`. Unlike the two `select=*` readers that failed silently,
# an EXPLICIT projection naming it is a PostgREST 400 `42703`, which
# `classify_read_error` grades `bad_column` and `get_board` turns into a
# 500 — the WHOLE attention board for every caller, not a degraded field,
# the moment FIRM_COCKPIT_ENABLED flips. It is read from the org row
# instead, which this board already holds.
LIGHT_PERIOD_COLUMNS = (
    "id,org_id,period_start,period_end,currency,source_document_id,updated_at,"
    "snapshot_hash:assembled_canonical_v1->provenance->>content_hash,"
    "has_envelope:assembled_canonical_v1->>schema_version,"
    "jurisdiction:assembled_canonical_v1->pack_provenance->>jurisdiction"
)

TABLE_SUPPRESSIONS = "firm_attention_suppressions"
TABLE_COVENANTS = "firm_covenants"
TABLE_CADENCE = "firm_client_cadence"

#: The column each optional table keys its client on. Two of the three
#: carry ``org_id``; the cadence table (Part C's, schema_phase_firm_
#: requests.sql) is keyed ``client_org_id uuid primary key`` and has NO
#: ``org_id`` — the first cut selected it by ``org_id``, PostgREST 400'd
#: (42703), the 400 was swallowed as "table not applied" and every
#: quarterly client was graded against the pack's MONTHLY default (C4).
#: tests/engine/test_firm_route.py reads these names out of the
#: migrations, so a rename on either side fails loudly.
CLIENT_COLUMN = {
    TABLE_SUPPRESSIONS: "org_id",
    TABLE_COVENANTS: "org_id",
    TABLE_CADENCE: "client_org_id",
}

#: ``PAGE_ROWS`` / ``MAX_PAGES`` / ``IN_CHUNK`` live in ``engine.api._paging``
#: (imported above, re-exported here for the tests) — the page walk is
#: shared by every ``_firm*`` sibling (``_firm.client_org_ids``, the crons,
#: the brief, the import), so it cannot be this module's private helper.
#: ``PAGE_ROWS`` is the page size ASKED for, never the cap assumed: the
#: walk stops on an EMPTY page (D9).

#: The TOTAL order every list is paged in — PostgREST pages an unordered
#: scan in heap order, and heap order moves between pages. Each carries a
#: unique tiebreaker LAST (the cadence table's PK is its client key: one
#: row per client, no tiebreaker needed). The line-item order also fixes
#: the summation order of ``pipeline._rebuild_assembled_for_briefing``,
#: which heap order left unspecified.
ORG_ORDER = "name.asc,id.asc"
PERIOD_ORDER = "period_end.desc,id.asc"
LINE_ITEM_ORDER = "id.asc"
PAGE_ORDER = {
    TABLE_SUPPRESSIONS: "org_id.asc,id.asc",
    TABLE_COVENANTS: "org_id.asc,id.asc",
    TABLE_CADENCE: "client_org_id.asc",
}

#: PostgREST / Postgres error codes, by what they MEAN for a read.
#: A missing TABLE is a migration not yet applied — stated on the payload.
#: A missing COLUMN is this module asking for a name the table does not
#: declare — a code defect, raised, never reported as a migration gap.
MISSING_TABLE_CODES = ("42P01", "PGRST205")
BAD_COLUMN_CODES = ("42703", "PGRST204")
_MISSING_TABLE_RX = re.compile(r"relation .* does not exist|Could not find the table", re.I)
_BAD_COLUMN_RX = re.compile(r"column .* does not exist|Could not find the .* column", re.I)


class TableReadDefect(RuntimeError):
    """The route asked a table for a column it does not declare."""


class StatementsRebuildUnavailable(RuntimeError):
    """The statements rebuild could not run for a period. The rebuild is
    ``engine.api.pipeline._rebuild_assembled_for_briefing``. Raised — not
    swallowed into ``None`` — so the facts stage records the period's
    profile and findings as absent WITH this reason, and the board carries
    one notice naming it (A1). The served money facts do not pass through
    here and stay intact. (pipeline's import graph once read the model
    registry AT IMPORT and a dead registry made this raise for every
    period; since D6 the registry is read at first AI use, so a dead
    registry is a NOTICE from ``registry_notice`` and this rebuild runs.)"""


def cache() -> AttentionCache:
    return _CACHE


def registry_notice() -> Optional[str]:
    """ONE notice when the AI model registry (engine/ai/models.yaml) cannot
    resolve — its own error text, which names the file and, when a role
    is the problem, the role. The board computes nothing from the
    registry (C9: no AI module on the compute path); this probe is how
    the board SAYS that the AI-assisted features around it (the brief,
    the reconcile proposal, finding sharpening) are unavailable, instead
    of the operator learning it from the first failed call. None when
    the registry resolves. Lazy import on purpose: engine.ai is loaded
    here, on the route, never by ``engine.firm``."""
    try:
        from engine.ai import registry as _registry
        _registry.load_registry()
    except Exception as exc:  # noqa: BLE001 — RegistryError, or an unreadable file
        return ("AI model registry unavailable: %s: %s — AI-assisted features (the brief, "
                "reconcile proposals, finding sharpening) are unavailable until it resolves; "
                "every figure on this board is deterministic and unaffected"
                % (type(exc).__name__, exc))
    return None


# ── Pure shaping (unit-tested without a database) ─────────────────────────


#: The quoted ``in.()`` filter — kept under its old name for the tests.
_in_filter = in_filter


def classify_read_error(exc: BaseException) -> Tuple[str, str]:
    """``("missing_table" | "bad_column" | "other", detail)`` for a failed
    PostgREST read. Reads the JSON error body when the exception carries a
    response (``httpx.HTTPStatusError``: ``{code, message, details,
    hint}``), else the exception text. A :class:`PageWalkError` is
    classified by its CAUSE. Pure."""
    if isinstance(exc, PageWalkError):
        exc = exc.cause
    status = None  # type: Optional[int]
    body = None  # type: Optional[Dict[str, Any]]
    text = str(exc)
    response = getattr(exc, "response", None)
    if response is not None:
        status = getattr(response, "status_code", None)
        try:
            parsed = response.json()
        except Exception:  # noqa: BLE001 — not JSON
            parsed = None
        if isinstance(parsed, dict):
            body = parsed
        else:
            text = str(getattr(response, "text", "") or text)
    code = str((body or {}).get("code") or "")
    message = str((body or {}).get("message") or text)
    detail = ("HTTP %s %s: %s" % (status, code, message)).strip() if status else message
    if code in MISSING_TABLE_CODES or _MISSING_TABLE_RX.search(message):
        return "missing_table", detail
    if code in BAD_COLUMN_CODES or _BAD_COLUMN_RX.search(message):
        return "bad_column", detail
    return "other", detail


def read_optional_table(client: Any, table: str, org_ids: Sequence[str],
                        notices: List[str], columns: str = "*") -> List[Dict[str, Any]]:
    """Rows of a table another migration owns, for these clients, keyed on
    the column the MIGRATION declares (``CLIENT_COLUMN``). An unapplied
    table is a NOTICE on the payload — never a 500, never a silent empty.
    A column the table does not declare is a defect in THIS module and
    RAISES: reporting it as "not applied" is how the cadence rows were
    lost (C4)."""
    if not org_ids:
        return []
    key = CLIENT_COLUMN[table]
    try:
        rows = []  # type: List[Dict[str, Any]]
        for chunk in chunked(org_ids):
            rows.extend(select_all(client, table, order=PAGE_ORDER[table],
                                   filters={key: _in_filter(chunk)}, columns=columns,
                                   notices=notices))
        return rows
    except Exception as exc:  # noqa: BLE001
        kind, detail = classify_read_error(exc)
        if kind == "bad_column":
            raise TableReadDefect(
                "%s: the route asked for a column the table does not declare — a "
                "code defect in engine.api._firm_attention, NOT an unapplied "
                "migration (%s)" % (table, detail))
        if kind == "missing_table":
            notices.append("%s: not applied (%s) — treated as empty" % (table, detail))
        else:
            notices.append("%s: not readable (%s) — treated as empty" % (table, detail))
        return []


def _read_organizations(client: Any, notices: List[str]) -> List[Dict[str, Any]]:
    """The caller's live (unarchived) organizations, every page. The ONE
    widening this read ever does: a schema that predates ``archived_at``
    answers 42703 on the FIRST page, and only then is the filter dropped
    (nothing was read yet, nothing archived can exist). Any other failure
    — a 503 on page 2 — keeps exactly the rows that answered, admits no
    archived client, and says so (D10: the old catch-all re-read WITHOUT
    the filter and put 200 archived clients on the board, notices []). A
    failing UNFILTERED re-read is a code defect, raised."""
    try:
        return select_all(client, "organizations", order=ORG_ORDER,
                          filters={"archived_at": "is.null"}, notices=notices)
    except PageWalkError as exc:
        kind, detail = classify_read_error(exc)
        if kind == "bad_column" and exc.pages_read == 0:
            notices.append("organizations: no archived_at column (%s) — pre-archive schema, "
                           "read without the archive filter" % detail)
            try:
                return select_all(client, "organizations", order=ORG_ORDER, notices=notices)
            except PageWalkError as inner:
                raise TableReadDefect(
                    "organizations: the unfiltered re-read failed too — a code defect in "
                    "engine.api._firm_attention, not a schema gap (%s)"
                    % classify_read_error(inner)[1])
        rows = list(exc.rows_read)
        notices.append(
            "organizations: the read failed on page %d after %d client(s) (%s) — the board "
            "is INCOMPLETE: %d client(s) read, none past that point, and no archived client "
            "admitted" % (exc.pages_read + 1, len(rows), detail, len(rows)))
        return rows


def group_periods(rows: Sequence[Dict[str, Any]], per_client: int = PERIODS_PER_CLIENT
                  ) -> Dict[str, List[Dict[str, Any]]]:
    """Light period rows -> {org_id: newest `per_client` rows}."""
    by_org = {}  # type: Dict[str, List[Dict[str, Any]]]
    for row in rows:
        by_org.setdefault(str(row.get("org_id") or ""), []).append(row)
    out = {}  # type: Dict[str, List[Dict[str, Any]]]
    for org_id, org_rows in by_org.items():
        org_rows.sort(key=lambda r: (str(r.get("period_end") or ""), str(r.get("id") or "")),
                      reverse=True)
        out[org_id] = org_rows[:per_client]
    return out


def covenant_from_row(row: Dict[str, Any]) -> CovenantRecord:
    return CovenantRecord(
        covenant_id=str(row.get("covenant_id") or row.get("id") or ""),
        label=str(row.get("label") or ""),
        metric=str(row.get("metric") or ""),
        comparator=str(row.get("comparator") or ">="),
        limit=float(row.get("limit_value") or 0.0),
        unit=str(row.get("unit") or "money"),
        headroom_warn_share=float(row.get("headroom_warn_share") or 0.10),
        test_date=(str(row.get("test_date"))[:10] if row.get("test_date") else None),
        source=str(row.get("source") or ""))


def suppression_from_row(row: Dict[str, Any]) -> Suppression:
    return Suppression.from_payload({
        "client_id": str(row.get("org_id") or ""),
        "rule_id": str(row.get("kind") or ""),
        "scope_key": str(row.get("scope_key") or R.SCOPE_ANY),
        "reason": str(row.get("reason") or ""),
        "dismissed_by": str(row.get("dismissed_by") or ""),
        "dismissed_at": str(row.get("dismissed_at") or ""),
        "from_period_ordinal": row.get("from_period_ordinal"),
        "periods": row.get("periods"),
    })


def current_era_rows(rows: Sequence[Dict[str, Any]], firm_by_org: Dict[str, Any],
                     table: str) -> List[Dict[str, Any]]:
    """THE ERA PIN, the route's half (D3). A suppression or covenant row
    carries ``firm_id`` — the firm that served the client when it was
    written (stamped by the migration's BEFORE INSERT trigger). A row is
    in force only while that firm is the one serving the client NOW
    (``organizations.firm_id``), or when it is the client's own (``firm_id``
    null). This is the SAME predicate the ``<table> read`` policies apply
    (``firm_id is null or firm_id = firm_of_org(org_id)``), so either
    wall alone leaves a previous firm's decisions — with its accountant's
    uuid — nowhere the new firm can read them, and off every board of the
    client. A row whose client is not in ``firm_by_org`` at all (an
    organization the caller cannot read) is dropped too. Pure:
    ``firm_by_org`` is ``{org_id: firm_id-or-None}`` from the organizations
    rows already read."""
    key = CLIENT_COLUMN[table]
    kept = []  # type: List[Dict[str, Any]]
    for row in rows:
        org_id = str(row.get(key) or "")
        if org_id not in firm_by_org:
            continue
        era = row.get("firm_id")
        current = firm_by_org.get(org_id)
        if era is None or (current is not None and str(era) == str(current)):
            kept.append(row)
    return kept


def build_client_records(orgs: Sequence[Dict[str, Any]],
                         periods_by_org: Dict[str, List[Dict[str, Any]]],
                         cadence_by_org: Dict[str, Dict[str, Any]],
                         covenants_by_org: Dict[str, List[Dict[str, Any]]],
                         envelope_loader: Callable[[str], Optional[Dict[str, Any]]],
                         statements_loader: Callable[[Dict[str, Any]], Optional[Dict[str, Any]]],
                         jurisdiction_of: Callable[[Dict[str, Any]], str]
                         ) -> Tuple[ClientRecord, ...]:
    """Light rows -> ClientRecords with LAZY heavy loaders. Pure: the two
    loaders are closures the caller supplies, so this shape is testable
    with no database behind it. A client's jurisdiction is the org's
    declared one, else the one the engine stamped on its latest envelope
    (``pack_provenance.jurisdiction``), else absent (no calendar)."""
    records = []  # type: List[ClientRecord]
    for org in orgs:
        org_id = str(org.get("id") or "")
        if not org_id:
            continue
        periods = []  # type: List[PeriodRecord]
        for row in periods_by_org.get(org_id, ()):
            period_id = str(row.get("id") or "")
            attached = row.get("has_envelope") is not None
            periods.append(PeriodRecord(
                period_id=period_id,
                period_end=str(row.get("period_end") or "")[:10],
                currency=str(row.get("currency") or org.get("default_currency") or "RON"),
                period_start=(str(row.get("period_start"))[:10]
                              if row.get("period_start") else None),
                source_document_id=(str(row.get("source_document_id"))
                                    if row.get("source_document_id") else None),
                updated_at=str(row.get("updated_at") or ""),
                envelope=None,
                envelope_provider=(lambda pid=period_id: envelope_loader(pid)),
                statements_provider=(lambda r=dict(row): statements_loader(r)),
                snapshot_hash=(str(row.get("snapshot_hash"))
                               if row.get("snapshot_hash") else None),
                attached=attached,
                # From the ORG row, which this board already holds — it
                # reads `organizations` with `select=*` for every client,
                # so a per-client round trip would re-fetch a value in hand.
                caen=_org.caen_of_org_row(org),
                label=str(row.get("period_end") or "")[:10]))
        jurisdiction = jurisdiction_of(org)
        if not jurisdiction:
            for row in periods_by_org.get(org_id, ()):
                if row.get("jurisdiction"):
                    jurisdiction = str(row["jurisdiction"])
                    break
        records.append(ClientRecord(
            client_id=org_id,
            client_name=str(org.get("name") or org_id),
            jurisdiction=jurisdiction,
            periods=tuple(periods),
            cadence_row=cadence_by_org.get(org_id),
            covenants=tuple(covenant_from_row(r) for r in covenants_by_org.get(org_id, ()))))
    return tuple(records)


# ── Router ───────────────────────────────────────────────────────────────


def build_router():
    from fastapi import APIRouter, Header, HTTPException, Query

    from . import _org, _supabase

    router = APIRouter(prefix="/api/firm/attention", tags=["firm-attention"])

    def _require_jwt(authorization: Optional[str]) -> str:
        if not authorization or not authorization.lower().startswith("bearer "):
            raise HTTPException(401, "Missing bearer token.")
        return authorization.split(" ", 1)[1].strip()

    def _as_of(value: Optional[str]) -> date:
        if not value:
            return date.today()          # the ONE clock read of the feature
        try:
            return date.fromisoformat(str(value)[:10])
        except (TypeError, ValueError):
            raise HTTPException(422, "as_of must be an ISO date (YYYY-MM-DD).")

    def _jurisdiction_of(org: Dict[str, Any]) -> str:
        """The org's declared jurisdiction when the row carries one.
        Empty otherwise — build_client_records then takes the
        jurisdiction the ENGINE stamped on the latest envelope
        (pack_provenance.jurisdiction), which is data, not a guess.
        Opaque here — the calendar resolves it by NAME."""
        value = org.get("jurisdiction") or org.get("country_code")
        return str(value) if value else ""

    def _load_book(jwt: str, only_client: Optional[str]) -> Tuple[Tuple[ClientRecord, ...],
                                                                  SuppressionIndex, List[str]]:
        notices = []  # type: List[str]
        with _supabase.per_user(jwt) as client:
            orgs = _read_organizations(client, notices)
            if only_client:
                orgs = [o for o in orgs if str(o.get("id")) == only_client]
            org_ids = [str(o.get("id")) for o in orgs if o.get("id")]
            light = []  # type: List[Dict[str, Any]]
            unread = []  # type: List[str]
            causes = []  # type: List[str]
            for chunk in chunked(org_ids):
                try:
                    light.extend(select_all(client, "financial_periods", order=PERIOD_ORDER,
                                            filters={"org_id": _in_filter(chunk)},
                                            columns=LIGHT_PERIOD_COLUMNS, notices=notices))
                except PageWalkError as exc:
                    # These clients' period lists did not answer. Keeping
                    # them on the board with NO periods would grade every
                    # one of them MISSING_FILE from a read that never
                    # happened — absent is not zero. They are left off,
                    # named by count, with the cause (D10's law, one read
                    # down).
                    kind, detail = classify_read_error(exc)
                    if kind == "bad_column":
                        raise TableReadDefect(
                            "financial_periods: the route asked for a column the table does "
                            "not declare — a code defect in engine.api._firm_attention (%s)"
                            % detail)
                    unread.extend(chunk)
                    causes.append(detail)
            if unread:
                gone = set(unread)
                notices.append(
                    "financial_periods: the read failed for %d client(s) (%s) — they are NOT "
                    "on this board; %d of %d clients are"
                    % (len(unread), "; ".join(sorted(set(causes))), len(org_ids) - len(unread),
                       len(org_ids)))
                orgs = [o for o in orgs if str(o.get("id")) not in gone]
                org_ids = [i for i in org_ids if i not in gone]
            periods_by_org = group_periods(light)
            cadence_rows = read_optional_table(client, TABLE_CADENCE, org_ids, notices)
            covenant_rows = read_optional_table(client, TABLE_COVENANTS, org_ids, notices)
            suppression_rows = read_optional_table(client, TABLE_SUPPRESSIONS, org_ids,
                                                   notices)

        # THE ERA PIN (D3): a previous firm's suppressions and covenants are
        # not in force on this board, whatever RLS returned (either wall alone).
        firm_by_org = dict((str(o.get("id")), o.get("firm_id")) for o in orgs)
        covenant_rows = current_era_rows(covenant_rows, firm_by_org, TABLE_COVENANTS)
        suppression_rows = current_era_rows(suppression_rows, firm_by_org, TABLE_SUPPRESSIONS)
        cadence_by_org = dict((str(r.get(CLIENT_COLUMN[TABLE_CADENCE])), r)
                              for r in cadence_rows)
        covenants_by_org = {}  # type: Dict[str, List[Dict[str, Any]]]
        for r in covenant_rows:
            covenants_by_org.setdefault(str(r.get(CLIENT_COLUMN[TABLE_COVENANTS])), []).append(r)
        suppressions = [suppression_from_row(r) for r in suppression_rows
                        if not r.get("revoked_at")]

        def _envelope(period_id: str) -> Optional[Dict[str, Any]]:
            with _supabase.per_user(jwt) as c:
                rows = c.select("financial_periods", filters={"id": "eq.%s" % period_id},
                                columns="id,assembled_canonical_v1", limit=1) or []
            env = rows[0].get("assembled_canonical_v1") if rows else None
            return env if isinstance(env, dict) else None

        def _statements(row: Dict[str, Any]) -> Optional[Dict[str, Any]]:
            period_id = str(row.get("id") or "")
            with _supabase.per_user(jwt) as c:
                full = c.select("financial_periods", filters={"id": "eq.%s" % period_id},
                                limit=1) or []
                # A period's line items are a list read too: a book with
                # more rows than the cap would rebuild from a TRUNCATED
                # statement — silently wrong figures, not a missing client.
                line_items = select_all(c, "statement_line_items", order=LINE_ITEM_ORDER,
                                        filters={"period_id": "eq.%s" % period_id},
                                        columns="statement,bucket,ro_account_code,"
                                                "ro_account_name,amount")
            if not full:
                return None
            try:
                from .pipeline import _rebuild_assembled_for_briefing
                rebuilt = _rebuild_assembled_for_briefing(line_items, full[0], None)
            except Exception as exc:  # noqa: BLE001 — stated, never swallowed
                reason = "%s: %s" % (type(exc).__name__, exc)
                logger.exception("[firm] statements rebuild failed for %s", period_id)
                notice = ("statements rebuild unavailable (engine.api.pipeline): %s — the "
                          "profile and CRITICAL_FINDING are absent for every period it "
                          "failed on; served facts are unaffected" % reason)
                if notice not in notices:
                    notices.append(notice)
                raise StatementsRebuildUnavailable(reason)
            statements = rebuilt.get("statements") if isinstance(rebuilt, dict) else None
            return statements if isinstance(statements, dict) else None

        records = build_client_records(orgs, periods_by_org, cadence_by_org,
                                       covenants_by_org, _envelope, _statements,
                                       _jurisdiction_of)
        return records, SuppressionIndex(suppressions), notices

    @router.get("")
    def get_board(authorization: Optional[str] = Header(None),
                  as_of: Optional[str] = Query(None),
                  client_id: Optional[str] = Query(None)) -> Dict[str, Any]:
        jwt = _require_jwt(authorization)
        _org.resolve_user_id(jwt)
        try:
            records, suppressions, notices = _load_book(jwt, client_id)
        except TableReadDefect as exc:
            raise HTTPException(500, str(exc))
        report = FA.compute_firm_attention(records, as_of=_as_of(as_of),
                                           cache=_CACHE, suppressions=suppressions)
        payload = report.to_payload()
        registry = registry_notice()
        if registry is not None:
            notices.append(registry)
        payload["notices"] = notices
        payload["suppressions_rejected"] = suppressions.rejected()
        return payload

    @router.get("/kinds")
    def get_kinds(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        _require_jwt(authorization)
        pack = FA.load_attention_pack()
        payload = pack.to_payload()
        payload["kind_specs"] = dict(
            (k, {"order": pack.kind(k).order,
                 "base_severity": pack.kind(k).base_severity,
                 "materiality_basis": pack.kind(k).materiality_basis,
                 "escalates_on": pack.kind(k).escalates_on,
                 "enabled": pack.kind(k).enabled,
                 "absent_reason": pack.kind(k).absent_reason or None,
                 "thresholds": pack.kind(k).thresholds_default,
                 "extra": pack.kind(k).extra})
            for k in pack.kind_ids())
        payload["severity"] = {
            "ladder": list(pack.severity.ladder),
            "materiality_steps": dict(pack.severity.materiality_steps),
            "deadline_bands": [b.__dict__ for b in pack.severity.deadline_bands],
            "age_bands": [b.__dict__ for b in pack.severity.age_bands],
        }
        return payload

    @router.get("/suppressions")
    def list_suppressions(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        jwt = _require_jwt(authorization)
        # IDENTITY, like every sibling (W4): a bearer that is not a JWT
        # this backend can read is 401 here, before any read — the
        # `startswith("bearer ")` shape test above is not an identity.
        _org.resolve_user_id(jwt)
        notices = []  # type: List[str]
        with _supabase.per_user(jwt) as client:
            try:
                # Every page (D8): 1,001 suppressions were 1,000 with no
                # notice through a bare select. ``id.asc`` is the
                # tiebreaker that makes ``dismissed_at.desc`` a total order.
                rows = select_all(client, TABLE_SUPPRESSIONS, order="dismissed_at.desc,id.asc",
                                  notices=notices)
            except Exception as exc:  # noqa: BLE001
                notices.append("%s: not readable (%s)"
                               % (TABLE_SUPPRESSIONS, classify_read_error(exc)[1]))
                rows = []
            # THE ERA PIN (D3), the route's half: only the rows of the firm
            # serving each client now (or the client's own) are listed —
            # a row of a client the caller cannot read at all is not.
            if rows:
                orgs = select_all(client, "organizations", order=ORG_ORDER,
                                  columns="id,firm_id", notices=notices)
                rows = current_era_rows(rows, dict((str(o.get("id")), o.get("firm_id"))
                                                   for o in orgs), TABLE_SUPPRESSIONS)
        return {"suppressions": rows, "notices": notices}

    @router.post("/suppress")
    def suppress(body: SuppressBody,
                 authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
        jwt = _require_jwt(authorization)
        user_id = _org.resolve_user_id(jwt)
        reason = (body.reason or "").strip()
        if not reason:
            raise HTTPException(422, "A suppression carries a reason; an empty one is "
                                     "not a decision.")
        pack = FA.load_attention_pack()
        if body.kind not in pack.kind_ids():
            raise HTTPException(422, "Unknown attention kind %r." % body.kind)
        row = {
            "org_id": body.client_id, "kind": body.kind,
            "scope_key": body.scope_key or R.SCOPE_ANY, "reason": reason,
            "dismissed_by": user_id,
            "periods": body.periods, "from_period_ordinal": body.from_period_ordinal,
        }
        with _supabase.per_user(jwt) as client:
            try:
                inserted = client.insert(TABLE_SUPPRESSIONS, row)
            except Exception as exc:  # noqa: BLE001 — RLS refusal or table absent
                raise HTTPException(403, "Suppression refused: %s" % exc)
        return {"suppression": (inserted[0] if inserted else row),
                "note": ("a critical item stays on the board, flagged, with this "
                         "reason beside it")}

    return router


__all__ = [
    "BAD_COLUMN_CODES", "CLIENT_COLUMN", "IN_CHUNK", "LIGHT_PERIOD_COLUMNS",
    "LINE_ITEM_ORDER", "MAX_PAGES", "MISSING_TABLE_CODES", "ORG_ORDER", "PAGE_ORDER",
    "PAGE_ROWS", "PERIOD_ORDER", "PERIODS_PER_CLIENT", "PageWalkError",
    "StatementsRebuildUnavailable", "TABLE_CADENCE", "TABLE_COVENANTS",
    "TABLE_SUPPRESSIONS", "TableReadDefect", "build_client_records", "build_router", "cache",
    "chunked", "classify_read_error", "covenant_from_row", "current_era_rows", "group_periods",
    "in_filter", "read_optional_table", "registry_notice", "select_all", "suppression_from_row",
]
