"""THE PAGE WALK — every list read of the Firm Cockpit goes through here.

PostgREST caps EVERY response at the deployment's ``db-max-rows``
(Supabase's default 1000; CLAUDE.md §14 tells operators to TOGGLE that
knob as the schema-cache escalation) — silently: no error, no marker,
the rows past the cap are simply not in the body. A list read that does
not page loses rows past the cap; a page walk that stops on ``len(page)
< page_rows`` loses them the day the cap is LOWER than the page size it
asks for (critic D9, 2026-09-05: with the cap at 500, a 1,200-client
firm was 500 clients on the board, one page, no notice — and the gate
could not see it because it pinned ``MAX_ROWS == PAGE_ROWS == 1000``).

CAP-INDEPENDENT, by construction: :func:`select_all` stops ONLY on an
EMPTY page. It never reads the cap, never assumes it, never learns it.
The price is exactly one extra light request per non-empty list (the
empty page after the last one); a list with no rows costs one request.

Why the empty page and not ``Content-Range``: without ``Prefer:
count=exact`` PostgREST answers ``Content-Range: 0-N/*`` — the range's
END is not stated, so a short page is exactly as ambiguous on the header
as in the body (cap, or end of list?). ``count=exact`` would state it,
at the price of a ``COUNT(*)`` under RLS on every page of every list of
every board, a cost nobody has measured on the live project; ``planned``
/ ``estimated`` counts are estimates and cannot end a walk. The empty
page depends on nothing the deployment can change, and costs one light
request. ``_supabase.SupabaseClient.select`` is therefore UNCHANGED.

``offset`` rides the query string exactly as ``limit`` already does: a
reserved PostgREST keyword that ``_supabase.SupabaseClient.select``
forwards verbatim out of ``filters`` (``params.update(filters)``), so the
walk runs against the real client unchanged — and every double must read
``offset`` / ``limit`` inside ``filters`` as paging, never as columns
(tests/engine/firm_postgrest_double.py, firm_fakes.py and the tenancy
double all do).

A failure MID-WALK is a :class:`PageWalkError` carrying the rows read so
far, the pages read and the cause — the CALLER decides whether a partial
read is a stated, incomplete result (the board) or a refusal (a wall).
Nothing here widens a filter on failure (critic D10).

Stdlib only. Python 3.9 — no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Sequence

logger = logging.getLogger(__name__)

#: The page size ASKED for. The deployment serves ``min(PAGE_ROWS,
#: db-max-rows)`` rows per page; the walk does not care which.
PAGE_ROWS = 1000
#: A page walk that never ends is a defect, not a big book: it stops,
#: and states on the payload that the read is incomplete. Never silent.
MAX_PAGES = 1000
#: ``in.()`` filters are chunked: 100 quoted uuids is ~4.5 KB of query
#: string (url-encoded); one filter over a 1,200-client firm would be
#: ~55 KB, past the request-line limit of any HTTP front. Chunking is
#: the conservative shape — no upstream limit is pinned by it.
IN_CHUNK = 100


class PageWalkError(RuntimeError):
    """A page read raised mid-walk. ``rows_read`` is every row of the pages
    that DID answer (never a partial page), ``pages_read`` how many,
    ``cause`` the exception the client raised."""

    def __init__(self, table: str, rows_read: List[Dict[str, Any]], pages_read: int,
                 cause: BaseException) -> None:
        self.table = table
        self.rows_read = rows_read
        self.pages_read = pages_read
        self.cause = cause
        RuntimeError.__init__(
            self, "%s: the page walk failed on page %d after %d row(s): %s: %s"
            % (table, pages_read + 1, len(rows_read), type(cause).__name__, cause))


def in_filter(ids: Sequence[str]) -> str:
    """The quoted PostgREST ``in.()`` filter for ``ids``."""
    return "in.(%s)" % ",".join('"%s"' % str(i).replace('"', "") for i in ids)


def chunked(ids: Sequence[str], size: int = IN_CHUNK) -> List[List[str]]:
    """``ids`` in runs of at most ``size`` — one ``in.()`` filter each."""
    flat = [str(i) for i in ids]
    return [flat[i:i + size] for i in range(0, len(flat), size)]


def select_all(client: Any, table: str, *, order: str,
               filters: Optional[Dict[str, str]] = None, columns: str = "*",
               page_rows: int = PAGE_ROWS,
               notices: Optional[List[str]] = None) -> List[Dict[str, Any]]:
    """EVERY row of a PostgREST read, page by page, past whatever cap the
    deployment runs. ``order`` is REQUIRED and must be a total order (a
    unique tiebreaker last) — an unordered page walk is heap order, which
    moves between pages. The walk stops on the first EMPTY page and on
    nothing else; ``MAX_PAGES`` non-empty pages is a stated, incomplete
    read. A page that raises is a :class:`PageWalkError` carrying the rows
    so far."""
    if not order:
        raise ValueError("select_all(%s): a page walk needs a total order" % table)
    if int(page_rows) < 1:
        raise ValueError("select_all(%s): page_rows must be >= 1" % table)
    rows = []  # type: List[Dict[str, Any]]
    offset = 0
    pages = 0
    while pages < MAX_PAGES:
        params = dict(filters or {})
        if offset:
            params["offset"] = str(offset)
        try:
            page = client.select(table, filters=params, columns=columns, order=order,
                                 limit=page_rows) or []
        except Exception as exc:  # noqa: BLE001 — the caller decides what a partial read is
            raise PageWalkError(table, rows, pages, exc)
        pages += 1
        if not page:
            return rows
        rows.extend(page)
        offset += len(page)
    logger.error("[paging] %s: page walk stopped after %d pages (%d rows) — INCOMPLETE",
                 table, MAX_PAGES, len(rows))
    if notices is not None:
        notices.append("%s: the page walk stopped after %d pages (%d rows) — the read "
                       "is INCOMPLETE" % (table, MAX_PAGES, len(rows)))
    return rows


__all__ = ["IN_CHUNK", "MAX_PAGES", "PAGE_ROWS", "PageWalkError", "chunked", "in_filter",
           "select_all"]
