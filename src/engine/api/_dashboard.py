"""F6.0.4 (2026-06-20) — Per-user configurable dashboard config endpoint.

GET  /api/dashboard/config  -> {"cards": [...]}   (empty if none / table missing)
PUT  /api/dashboard/config  body {"cards": [...]} -> {"cards": [...]}

Persists the user's metric-card layout (see the FE store
src/stores/dashboard.tsx). The FE is localStorage-primary and treats this
endpoint as a progressive enhancement, so EVERY failure mode here returns
a benign result that lets the FE keep working device-locally:

  * No table yet (migration not run / F3.25 Bug #4 PostgREST cache stale):
    GET returns {"cards": []} (200), PUT returns 503. The FE reads the
    200-empty as "nothing remote" and stays on localStorage; a failed PUT
    keeps syncSource = "device".

DEPLOY (operator, after schema_phase_dashboard_config.sql is applied +
the Supabase Dashboard "Reload schema cache" click per F3.24 / §14):
  1. Register this router in src/engine/api/server.py:
        from ._dashboard import build_router as create_dashboard_router
        ...
        app.include_router(create_dashboard_router())
  2. rsync src to /opt/cfo-ai/src (host source first — §14), then
        docker compose build backend && docker compose up -d backend
  3. Probe: curl -H "Authorization: Bearer <jwt>" \
        https://cfo-ai.io/api/dashboard/config  -> {"cards": []}

Until then the route simply isn't mounted; the FE GET 404s and falls back
to localStorage with zero user-facing breakage.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Header, HTTPException

from . import _supabase
from ._billing import _require_jwt, _user_id_from_jwt

_TABLE = "dashboard_configs"


def _safe_select_cards(user_id: str) -> List[Dict[str, Any]]:
    """Read the user's saved cards. Returns [] on ANY failure (table
    missing, PostgREST cache stale, transient error) so the FE degrades
    to localStorage instead of erroring."""
    try:
        with _supabase.admin() as client:
            rows = client.select(
                _TABLE,
                filters={"user_id": f"eq.{user_id}"},
                single=True,
            )
    except Exception:
        return []
    if not rows:
        return []
    cards = rows[0].get("cards")
    return cards if isinstance(cards, list) else []


def build_router() -> APIRouter:
    router = APIRouter()

    @router.get("/api/dashboard/config")
    def get_dashboard_config(
        authorization: Optional[str] = Header(None),
    ) -> Dict[str, Any]:
        jwt = _require_jwt(authorization)
        user_id = _user_id_from_jwt(jwt)
        return {"cards": _safe_select_cards(user_id)}

    @router.put("/api/dashboard/config")
    def put_dashboard_config(
        payload: Dict[str, Any],
        authorization: Optional[str] = Header(None),
    ) -> Dict[str, Any]:
        jwt = _require_jwt(authorization)
        user_id = _user_id_from_jwt(jwt)

        cards = payload.get("cards")
        if not isinstance(cards, list):
            raise HTTPException(400, "Body must include a `cards` array.")
        # Hard cap mirrors the FE MAX_DASHBOARD_CARDS — never persist an
        # unbounded payload even if a client bypasses the UI.
        if len(cards) > 20:
            raise HTTPException(400, "Too many cards (max 20).")

        try:
            with _supabase.admin() as client:
                client.upsert(
                    _TABLE,
                    {"user_id": user_id, "cards": cards},
                    on_conflict="user_id",
                    returning=False,
                )
        except Exception as exc:  # noqa: BLE001 — surface as 503 for FE fallback
            # Table missing / PostgREST cache stale / transient. The FE
            # treats a non-200 as "couldn't sync" and keeps localStorage.
            raise HTTPException(
                503, f"Dashboard config store unavailable: {exc}"
            ) from exc

        return {"cards": cards}

    return router
