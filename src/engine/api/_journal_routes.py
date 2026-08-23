"""Run-journal read-only API — GET /api/period/{id}/asof?t=<iso>.

Mounted by ``pipeline.build_router`` exactly like the reconcile routes
(``register_routes(router, require_jwt=...)`` — ``require_jwt`` is
injected so this module never imports back into pipeline.py; the period
is resolved through the CALLER's per-user client so RLS enforces
membership).

RESPONSE SHAPE (the FE "View as of…" entry point — a LATER wave, not
built here — consumes exactly this; documented in
``engine/journal/__init__.py`` as the shared contract):

    200 {
      "period_id": "...",
      "as_of": "<requested t>",
      "snapshot": { snapshot_id, content_hash, normalized_hash, origin,
                    period_id, recorded_at, run_id },
      "assembled_canonical_v1": { ...exact persisted envelope of that
                                  era, verbatim from the journal's
                                  content-addressed store... }
    }
    404  period not visible to the caller, OR no journal coverage at
         that moment (pre-journal periods have none — honest absence,
         never reconstructed)
    422  unparseable ``t``
    503  snapshot object referenced by the chain is unavailable
         (storage fault — the chain says what was live; the bytes
         cannot currently be produced)

The journal root comes from ``ENGINE_JOURNAL_DIR``; with the journal
disabled every period honestly has no coverage (404).
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Dict, Optional

from fastapi import Header, HTTPException

from engine.journal import hooks as _journal_hooks

from . import _supabase

logger = logging.getLogger("engine.api.journal_routes")

_NO_COVERAGE_DETAIL = (
    "No journal coverage for this period at that moment. Periods analyzed "
    "before the run journal was enabled have no as-of history."
)


def register_routes(router: Any, *, require_jwt: Any) -> None:
    @router.get("/api/period/{period_id}/asof")
    def period_asof(
        period_id: str,
        t: str,
        authorization: Optional[str] = Header(None),
    ) -> Dict[str, Any]:
        jwt = require_jwt(authorization)
        # RLS visibility: the CALLER must be able to see the period.
        with _supabase.per_user(jwt) as client:
            rows = client.select(
                "financial_periods",
                filters={"id": "eq.%s" % period_id},
                single=True,
            )
        if not rows:
            raise HTTPException(404, "Period not found.")
        period = rows[0]

        try:
            parsed_t = str(t)
            probe = parsed_t[:-1] + "+00:00" if parsed_t.endswith("Z") else parsed_t
            datetime.fromisoformat(probe)
        except (TypeError, ValueError):
            raise HTTPException(
                422, "Query parameter t must be an ISO-8601 timestamp."
            )

        journal = _journal_hooks.journal_from_env()
        if journal is None:
            raise HTTPException(404, _NO_COVERAGE_DETAIL)

        result = journal.asof(period_id, t)
        if result is None:
            # The period id may predate the period-index lines; fall back
            # to the chain keyed by the period's source file hash (the
            # envelope's provenance stamp), when one is persisted.
            envelope = period.get("assembled_canonical_v1")
            provenance = (
                envelope.get("provenance") if isinstance(envelope, dict) else None
            )
            file_hash = (provenance or {}).get("content_hash")
            if file_hash:
                result = journal.asof(str(file_hash), t)
        if result is None:
            raise HTTPException(404, _NO_COVERAGE_DETAIL)
        if result.get("error"):
            raise HTTPException(503, str(result["error"]))

        return {
            "period_id": period_id,
            "as_of": t,
            "snapshot": result.get("snapshot"),
            "assembled_canonical_v1": result.get("assembled_canonical_v1"),
        }
