"""THE MARKER OF A STAGED RE-RUN — a leaf module (it imports nothing of the engine).

A Docs-panel "Re-run analysis" of a document that owns its month no longer
resets that month first (hand-over 2026-10-04, item 2: the reset deleted the
period and what it cascaded away — the last good briefing, the worked
recommendations — lived in process memory until the run had narrated; a
restart or a deploy in between lost them). The re-run persists under a period
row of its OWN, beside the month, and takes the month over only once it has
succeeded (`pipeline._finalize_same_month_takeover`, rerun mode).

That staged row must never be taken for a month by anything that reads
`financial_periods`:

  * it names NO source document (`source_document_id` NULL) — so the unique
    tuple (org, period_end, source_document_id) never collides with the
    month's own row, and nothing that looks a period up by its document
    finds it;
  * its envelope carries THIS marker under `assembled_canonical_v1`
    (`MARKER_KEY`) — the one column a period row has that holds free-form
    JSON, so no migration is needed and the marker is durable: a second
    process, after a restart, tells a staged row from a legacy source-less
    period by reading the row alone.

The marker: `{document_id, served_period_id, staged_at}` from the mint, and
from the takeover's COMMIT POINT on also `takeover_began_at`,
`keep_briefing_reason` (the reason the month's kept briefing is stale, or
null), `emptied` (the takeover tables the run stored nothing in) and `kept`
(the tables whose rows the month keeps: never touched by the apply). A row
WITHOUT `takeover_began_at` never touched the month and is dropped; a row
WITH it is applied — by the live takeover, or by whoever finds it after the
process died (`pipeline._apply_committed_staged_rerun`, the one applier).

THE MARKER IS BROWSER-WRITABLE: a member can insert or update
`financial_periods` rows of their own company, envelope included. What it
names (`served_period_id`, `document_id`) is therefore read back under the
COMPANY's filter before anything is written — that filter is the wall
between a forged marker and another company's month.

Both readers — the service-role engine and `_period_move` — import this file,
and the browser's own read of `financial_periods` (frontend/lib/orgPeriods.ts)
selects the same alias: change the key in both.
"""
from __future__ import annotations

from typing import Any, Dict, Optional

#: The envelope key the marker lives under.
MARKER_KEY = "staged_rerun"

#: The PostgREST select term that reads the marker alone (never the whole
#: envelope, which is ~100-200 KB): `staged_rerun` on the returned row.
MARKER_SELECT = "%s:assembled_canonical_v1->%s" % (MARKER_KEY, MARKER_KEY)


def marker_of(row: Any) -> Optional[Dict[str, Any]]:
    """The staged-re-run marker of a `financial_periods` row, or None.

    Read from the alias `MARKER_SELECT` puts on a light row, or from the
    row's own envelope. A row that NAMES a source document is never a staged
    row, whatever its envelope carries (the takeover strips the marker before
    the month takes the envelope; a marker that leaked there must not hide a
    served month) — so a caller that selects columns must select
    `source_document_id` too, or filter on `is.null`."""
    if not isinstance(row, dict) or row.get("source_document_id"):
        return None
    marker = row.get(MARKER_KEY)
    if not isinstance(marker, dict):
        envelope = row.get("assembled_canonical_v1")
        marker = envelope.get(MARKER_KEY) if isinstance(envelope, dict) else None
    return marker if isinstance(marker, dict) else None
