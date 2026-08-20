"""AI-lane HTTP routes — mounted onto the pipeline router exactly like
the reconcile routes (`engine.api._reconcile.register_routes` pattern):
`require_jwt` is injected from pipeline.py so this module never imports
back into it at import time, and the period is first resolved through
the CALLER's per-user client so RLS enforces workspace membership.

POST /api/period/{period_id}/reextract
  Body (optional): {"jurisdiction": "RO" | "HU" | "INTL"} — the user's
  explicit override from the BS jurisdiction badge (FE:
  cfoApi.reextractPeriod). The route:
    1. persists the override onto documents.jurisdiction_hint when that
       column exists (graceful no-op when the migration hasn't been
       applied — mirroring the FE upload path's degradation), so the
       resolver's user-choice rung honors it on the next scan;
    2. sets the force_reextract marker on the period's persisted
       envelope — the ai-lane cache (content_hash + prompt versions)
       is bypassed once and the flag clears naturally because
       stage_persist replaces the whole envelope;
    3. triggers the pipeline re-run for the period's source document
       (best-effort; the flag alone already guarantees the next scan
       re-extracts).
  On non-AI (deterministic) periods the envelope flag is inert — the
  deterministic lane never reads it — but a jurisdiction override still
  lands on the document and can route it INTO the AI lane on re-scan.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, Optional, Tuple

from fastapi import Body, Header, HTTPException

# Import from the package constant so route + cache can never disagree.
from . import FORCE_REEXTRACT_ENVELOPE_KEY

logger = logging.getLogger("engine.api")

def _allowed_jurisdictions() -> Tuple[str, ...]:
    """The jurisdictions this route accepts as an explicit override.

    DATA-DRIVEN (N7): every jurisdiction with a discoverable data pack,
    plus the home jurisdiction and the generic international pack's wire
    code — resolved at REQUEST time through the resolver that will
    actually consume the value, so the route can never drift from what
    the resolver admits. A newly deployed pack is selectable without an
    engine edit; nothing here enumerates jurisdictions by name."""
    from .jurisdiction_resolver import (
        GENERIC_PACK_JURISDICTION,
        selectable_jurisdictions,
    )

    return tuple(sorted(
        set(selectable_jurisdictions()) | {GENERIC_PACK_JURISDICTION}
    ))


def register_routes(router: Any, *, require_jwt: Any) -> None:

    @router.post("/api/period/{period_id}/reextract")
    def reextract_period(
        period_id: str,
        authorization: Optional[str] = Header(None),
        payload: Optional[Dict[str, Any]] = Body(default=None),
    ) -> Dict[str, Any]:
        """Flag the period's document for forced AI-lane re-extraction
        (cache bypass), optionally under an explicit jurisdiction, and
        kick off the re-scan. Auth + RLS visibility first; writes via
        the admin client (same split as the reconcile routes)."""
        jwt = require_jwt(authorization)
        jurisdiction: Optional[str] = None
        if isinstance(payload, dict) and payload.get("jurisdiction"):
            jurisdiction = str(payload["jurisdiction"]).strip().upper()
            allowed = _allowed_jurisdictions()
            if jurisdiction not in allowed:
                raise HTTPException(
                    422,
                    "jurisdiction must be one of %s" % list(allowed),
                )

        # Lazy import — engine.api boots the FastAPI app; only route
        # registration (already inside engine.api) ever runs this.
        from engine.api import _supabase

        with _supabase.per_user(jwt) as client:
            visible = client.select(
                "financial_periods",
                filters={"id": "eq.%s" % period_id},
                single=True,
            )
            if not visible:
                raise HTTPException(404, "Period not found.")

        document_id: Optional[str] = None
        with _supabase.admin() as admin_client:
            rows = admin_client.select(
                "financial_periods",
                filters={"id": "eq.%s" % period_id},
                single=True,
            )
            period = rows[0] if rows else None
            envelope = (period or {}).get("assembled_canonical_v1")
            if not isinstance(envelope, dict):
                raise HTTPException(
                    409,
                    detail={
                        "status": "no_envelope",
                        "detail": "period has no assembled_canonical_v1 to flag",
                    },
                )
            document_id = (period or {}).get("source_document_id")

            # 1. Persist the explicit jurisdiction choice on the document
            #    row. Graceful when the jurisdiction_hint column hasn't
            #    been migrated yet — the flag below still forces the
            #    re-extraction, only the override is lost (logged).
            if jurisdiction and document_id:
                try:
                    admin_client.update(
                        "documents",
                        {"jurisdiction_hint": jurisdiction},
                        filters={"id": "eq.%s" % document_id},
                    )
                except Exception:  # noqa: BLE001 — column may not exist yet
                    logger.warning(
                        "[ai_lane] could not persist jurisdiction_hint=%s on "
                        "document %s (column not migrated?) — proceeding with "
                        "the force flag only",
                        jurisdiction, document_id,
                    )

            # 2. Force flag on the envelope (the ai-lane cache key holder).
            envelope[FORCE_REEXTRACT_ENVELOPE_KEY] = True
            admin_client.update(
                "financial_periods",
                {"assembled_canonical_v1": envelope},
                filters={"id": "eq.%s" % period_id},
            )

        # 3. Kick the pipeline for the source document (best-effort —
        #    the persisted flag already guarantees the next scan
        #    re-extracts even if this enqueue fails). Lazy import to
        #    avoid an import cycle (pipeline mounts this module).
        triggered = False
        if document_id:
            try:
                from engine.api import pipeline as _pipeline
                _pipeline._enqueue(str(document_id))
                triggered = True
            except Exception:  # noqa: BLE001
                logger.exception(
                    "[ai_lane] reextract enqueue failed for document %s "
                    "(flag persisted — next scan re-extracts)",
                    document_id,
                )

        logger.info(
            "[ai_lane] force_reextract flagged on period %s "
            "(jurisdiction=%s, document=%s, triggered=%s)",
            period_id, jurisdiction, document_id, triggered,
        )
        return {
            "status": "reextract_scheduled",
            "ok": True,
            "period_id": period_id,
            "document_id": document_id,
            "jurisdiction": jurisdiction,
            "triggered": triggered,
        }
