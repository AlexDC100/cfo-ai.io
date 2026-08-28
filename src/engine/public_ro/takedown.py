"""PS8 — takedown / annotation flow for the public RO company pages.

An affected company (or the operator on its behalf) can have its public
summary page removed or annotated. The PUBLIC contact path is the mailto
link rendered in every page footer (lane 3); THIS endpoint is the operator
action — a verified request is processed by the operator, who calls
POST /api/public/ro/takedown with the engine bearer token.

Auth is FAIL-CLOSED on ENGINE_API_TOKEN (503 when unset, 401 on a missing
or wrong Bearer), copying the destructive-cron idiom from
src/engine/api/_org.py:130-140 — a takedown mutates what the public sees,
so an unconfigured deployment must not be able to trigger it anonymously.

Audit-trail decision (documented per the wave brief): the journal event
vocabulary is a CLOSED frozenset — engine.journal.events.EVENT_TYPES
(events.py:52) and make_event raises ValueError on any unknown type
(events.py:163). Adding a TAKEDOWN_* event kind would be a chain-format
contract change, not a free addition. So the audit record is persisted in
the ``takedown_actions`` table, which is APPEND-ONLY: every action
(remove / annotate / restore) appends a new row with the full trail
(who verified, why, when); the current state of a CUI is the latest row.
Nothing here ever updates or deletes a takedown row.

Effect contract (consumed by sibling lanes):
  - pages (lane 3) call ``is_removed(cui)`` (via the store facade) and
    return HTTP 410 Gone for removed CUIs; ``annotation(cui)`` yields an
    active annotate state to render as a notice box.
  - sitemaps (lane 4) call ``removed_cuis()`` once per regeneration and
    exclude every member — a takedown therefore disappears from the
    sitemap within ONE regen call.

Storage: the shared public-data SQLite file data/public_ro.db (NEVER
engine.db — lock contention). Connections are opened here with
PRAGMA journal_mode=WAL and busy_timeout=5000 per the wave architecture
decision; ``PUBLIC_RO_DB_PATH`` overrides the location (tests use tmp dirs).
"""

from __future__ import annotations

import logging
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, FrozenSet, List, Optional

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

# Action vocabulary. "remove" pulls the page (410 + sitemap exclusion),
# "annotate" keeps it published with an operator notice, "restore" is the
# un-takedown path clearing either state (annotate -> restore, remove ->
# restore both land back at "published, no notice").
ACTIONS = ("remove", "annotate", "restore")

_ENV_DB_PATH = "PUBLIC_RO_DB_PATH"
_DEFAULT_DB = Path("data") / "public_ro.db"


def default_db_path() -> Path:
    """Resolve the public-data SQLite file (env override for tests)."""
    override = os.environ.get(_ENV_DB_PATH)
    return Path(override) if override else _DEFAULT_DB


def connect(db_path: Optional[Path] = None) -> sqlite3.Connection:
    """Open data/public_ro.db with the wave-mandated pragmas (WAL +
    busy_timeout=5000). Callers close the connection; rows come back as
    sqlite3.Row for dict-shaped access."""
    path = Path(db_path) if db_path is not None else default_db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    _ensure_schema(conn)
    return conn


def _ensure_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS takedown_actions (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            cui         INTEGER NOT NULL,
            action      TEXT    NOT NULL
                        CHECK (action IN ('remove', 'annotate', 'restore')),
            reason      TEXT    NOT NULL,
            verified_by TEXT    NOT NULL,
            created_at  TEXT    NOT NULL,
            note        TEXT
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_takedown_actions_cui ON takedown_actions (cui, id)"
    )
    conn.commit()


def _row_dict(row: sqlite3.Row) -> Dict[str, Any]:
    return {k: row[k] for k in row.keys()}


def record_action(
    cui: int,
    action: str,
    reason: str,
    verified_by: str,
    *,
    note: Optional[str] = None,
    db_path: Optional[Path] = None,
) -> Dict[str, Any]:
    """Append one audit row (never mutates prior rows). Returns the row."""
    if action not in ACTIONS:
        raise ValueError(
            "unknown takedown action %r (expected one of %s)"
            % (action, ", ".join(ACTIONS))
        )
    if not isinstance(cui, int) or cui <= 0:
        raise ValueError("cui must be a positive integer, got %r" % (cui,))
    if not reason.strip():
        raise ValueError("reason must be non-empty")
    if not verified_by.strip():
        raise ValueError("verified_by must be non-empty")
    created_at = datetime.now(timezone.utc).isoformat()
    conn = connect(db_path)
    try:
        cur = conn.execute(
            "INSERT INTO takedown_actions (cui, action, reason, verified_by,"
            " created_at, note) VALUES (?, ?, ?, ?, ?, ?)",
            (cui, action, reason.strip(), verified_by.strip(), created_at, note),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM takedown_actions WHERE id = ?", (cur.lastrowid,)
        ).fetchone()
        return _row_dict(row)
    finally:
        conn.close()


def current_state(
    cui: int, db_path: Optional[Path] = None
) -> Optional[Dict[str, Any]]:
    """Latest audit row for a CUI, or None. A latest row of action
    'restore' means no active takedown/annotation — returns None."""
    conn = connect(db_path)
    try:
        row = conn.execute(
            "SELECT * FROM takedown_actions WHERE cui = ? ORDER BY id DESC LIMIT 1",
            (cui,),
        ).fetchone()
    finally:
        conn.close()
    if row is None or row["action"] == "restore":
        return None
    return _row_dict(row)


def is_removed(cui: int, db_path: Optional[Path] = None) -> bool:
    """True when the CUI's page must serve 410 Gone (lane 3 contract)."""
    state = current_state(cui, db_path)
    return bool(state and state["action"] == "remove")


def annotation(
    cui: int, db_path: Optional[Path] = None
) -> Optional[Dict[str, Any]]:
    """Active annotate state (page stays published, renders a notice)."""
    state = current_state(cui, db_path)
    if state and state["action"] == "annotate":
        return state
    return None


def removed_cuis(db_path: Optional[Path] = None) -> FrozenSet[int]:
    """All CUIs whose latest action is 'remove' — the sitemap exclusion
    set. Lane 4 calls this ONCE per sitemap regeneration, so a takedown
    is absent from the very next regen call (PS8)."""
    conn = connect(db_path)
    try:
        rows = conn.execute(
            """
            SELECT t.cui, t.action FROM takedown_actions t
            JOIN (SELECT cui, MAX(id) AS max_id FROM takedown_actions GROUP BY cui) m
              ON t.cui = m.cui AND t.id = m.max_id
            WHERE t.action = 'remove'
            """
        ).fetchall()
    finally:
        conn.close()
    return frozenset(int(r["cui"]) for r in rows)


def audit_trail(cui: int, db_path: Optional[Path] = None) -> List[Dict[str, Any]]:
    """Full append-only trail for a CUI, oldest first."""
    conn = connect(db_path)
    try:
        rows = conn.execute(
            "SELECT * FROM takedown_actions WHERE cui = ? ORDER BY id ASC", (cui,)
        ).fetchall()
    finally:
        conn.close()
    return [_row_dict(r) for r in rows]


# ──────────────────────────────────────────────────────────────────────
# Operator endpoint
# ──────────────────────────────────────────────────────────────────────


class TakedownRequest(BaseModel):
    cui: int = Field(..., gt=0)
    action: str = Field(..., pattern="^(remove|annotate|restore)$")
    reason: str = Field(..., min_length=3, max_length=2000)
    verified_by: str = Field(..., min_length=2, max_length=200)
    note: Optional[str] = Field(None, max_length=2000)


def _require_operator_token(authorization: Optional[str]) -> None:
    """FAIL-CLOSED engine bearer gate (idiom: _org.py:130-140)."""
    token = os.environ.get("ENGINE_API_TOKEN")
    if not token:
        raise HTTPException(
            503,
            "ENGINE_API_TOKEN is not configured; refusing to process a"
            " takedown on an unconfigured deployment.",
        )
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Missing Bearer token.")
    if authorization.split(" ", 1)[1].strip() != token:
        raise HTTPException(401, "Invalid operator token.")


def build_takedown_router(db_path: Optional[Path] = None) -> APIRouter:
    """POST /api/public/ro/takedown — operator-only PS8 action.

    ``db_path`` is injectable for tests; None resolves via
    PUBLIC_RO_DB_PATH / data/public_ro.db at request time.
    """
    router = APIRouter(tags=["public-ro-compliance"])

    @router.post("/api/public/ro/takedown")
    def takedown(
        body: TakedownRequest,
        authorization: Optional[str] = Header(None),
    ) -> Dict[str, Any]:
        _require_operator_token(authorization)
        row = record_action(
            body.cui,
            body.action,
            body.reason,
            body.verified_by,
            note=body.note,
            db_path=db_path,
        )
        state = current_state(body.cui, db_path)
        logger.info(
            "[public-ro takedown] cui=%s action=%s verified_by=%s audit_id=%s",
            body.cui,
            body.action,
            body.verified_by,
            row["id"],
        )
        return {
            "ok": True,
            "audit_id": row["id"],
            "cui": body.cui,
            "action": body.action,
            "state": state["action"] if state else "published",
            "removed": is_removed(body.cui, db_path),
        }

    return router
