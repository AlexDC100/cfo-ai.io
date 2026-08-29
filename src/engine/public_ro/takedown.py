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
    return HTTP 410 Gone for removed CUIs — WIRED (pages/router.py
    ``_taken_down``).
  - sitemaps (lane 4) call ``removed_cuis()`` once per regeneration and
    exclude every member. That regeneration is no longer left to an
    operator remembering to run scripts/public_seo.py: ``apply_action``
    triggers it inline (``refresh_public_sitemaps``), because a removal
    that only reaches the page while the sitemap keeps offering the URL
    to crawlers is not "honored immediately".
  - ``annotation(cui)`` yields an active annotate state to render as a
    notice box — NOT WIRED YET. It has no consumer in src/, so an
    'annotate' currently changes no served byte. Until the page lane
    lands ``ANNOTATION_RENDERER`` (below), the endpoint reports
    ``public_effect: "not-rendered"`` and this action MUST NOT be
    described to a requester as a completed change to their page.

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

#: Row fields an active annotation may put on a PUBLIC page. `reason` and
#: `verified_by` are deliberately excluded: they are the private half of
#: the audit trail (who asked, and on what claim). Rendering `verified_by`
#: would publish a real person's identity on the very page this flow
#: exists to protect, and `reason` is operator justification written for
#: the trail, not copy written for readers of a company page.
PUBLIC_NOTICE_FIELDS = ("cui", "note", "created_at")

#: What the endpoint reports actually happens to the public page.
PUBLIC_EFFECT_REMOVED = "410-gone"
PUBLIC_EFFECT_PUBLISHED = "published"
PUBLIC_EFFECT_RENDERED = "rendered"
PUBLIC_EFFECT_NOT_RENDERED = "not-rendered"

#: The renderer the page lane must expose once it draws the annotate
#: notice box: (module, attribute). Named HERE rather than there so this
#: module can tell an operator the truth about whether their 'annotate'
#: had any public effect — engine.public_ro.pages.templates belongs to
#: another lane, and a probe is the only honest signal available across
#: that boundary.
ANNOTATION_RENDERER = ("engine.public_ro.pages.templates",
                       "render_annotation_notice")

#: seo.generate_sitemaps writes this index beside the shards. Its presence
#: is the only signal that a generation has ever run on this host: with no
#: generated sitemap there is nothing serving the removed URL, and
#: regenerating from a takedown would PUBLISH a sitemap the operator never
#: asked for.
_SITEMAP_INDEX_NAME = "sitemap.xml"

#: Invalidation entry points accepted on engine.public_ro.seo, in
#: preference order. That module is another lane's; if it grows a named
#: public invalidator this picks it up instead of reaching for the private
#: cache handle below.
_SEO_INVALIDATORS = ("invalidate_cache", "invalidate_sitemap_cache",
                     "invalidate")


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
    """THE page-layer predicate for the 'annotate' action.

    None means "render the page normally". Otherwise the audit row comes
    back with one extra key, ``public_notice`` — the ONLY part of it a
    page may render (PUBLIC_NOTICE_FIELDS); everything else on the row is
    private audit data.

    The page layer's whole integration is:

        ann = takedown.annotation(cui)
        if ann is not None:
            <render the notice box from ann["public_notice"]>

    ``public_notice["note"]`` is Optional and stays None when the
    operator recorded no note: the box then renders its standing label
    with no operator text. It never degrades to an empty string, and the
    page never invents a sentence about the company to fill it.
    """
    state = current_state(cui, db_path)
    if not state or state["action"] != "annotate":
        return None
    state["public_notice"] = {k: state.get(k) for k in PUBLIC_NOTICE_FIELDS}
    return state


def page_layer_renders_annotations() -> bool:
    """True only when the page layer actually draws the notice box.

    An 'annotate' with no renderer wired is a no-op on every served byte,
    so the endpoint must not report it as a public change: an operator
    would close a dispute believing the page changed while it keeps
    presenting the disputed figures exactly as before.
    """
    mod_name, attr = ANNOTATION_RENDERER
    try:
        import importlib

        mod = importlib.import_module(mod_name)
    except Exception:  # noqa: BLE001 — a page lane mid-edit means "no"
        return False
    return callable(getattr(mod, attr, None))


def state_version(cui: int, db_path: Optional[Path] = None) -> int:
    """Id of the CUI's latest audit row; 0 when it has none.

    Exists for the page cache key. That key is
    (cui, year, dataset_version, lang, percentiles_epoch) — an operator
    annotating or restoring a CUI changes NONE of those, so without this
    component a notice can never reach an already-cached page. Monotonic
    because the table is append-only.
    """
    conn = connect(db_path)
    try:
        row = conn.execute(
            "SELECT MAX(id) AS v FROM takedown_actions WHERE cui = ?", (cui,)
        ).fetchone()
    finally:
        conn.close()
    return int(row["v"]) if row and row["v"] is not None else 0


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
# Honoring an action on the public surfaces
# ──────────────────────────────────────────────────────────────────────


def _invalidate_seo_cache(seo: Any) -> None:
    """Drop seo's served-file cache after a regeneration.

    seo._cached_file is an lru_cache keyed on (path, mtime_ns, size), so
    it USUALLY misses on its own after an atomic replace. Usually is not
    good enough on the path that stops serving a removed company: the
    shard bytes are deterministic gzip, so a regen that drops a single
    URL can land on the same size, and a filesystem whose mtime
    resolution is coarser than two back-to-back regens can repeat
    mtime_ns. The cache is therefore cleared explicitly rather than
    trusted to miss.

    Raises when seo offers no invalidation surface at all — a silent
    return would leave the stale shard being served with every visible
    signal saying the takedown succeeded.
    """
    for name in _SEO_INVALIDATORS:
        fn = getattr(seo, name, None)
        if callable(fn):
            fn()
            return
    clear = getattr(getattr(seo, "_cached_file", None), "cache_clear", None)
    if callable(clear):
        clear()
        return
    raise RuntimeError(
        "engine.public_ro.seo exposes no invalidation surface (%s) and no"
        " _cached_file.cache_clear; a regenerated sitemap would keep being"
        " served from the stale in-process cache"
        % ", ".join(_SEO_INVALIDATORS)
    )


def refresh_public_sitemaps(trigger: str = "takedown") -> Dict[str, Any]:
    """Regenerate the sitemap shards and drop seo's served-file cache.

    BEST-EFFORT BY DESIGN, NEVER SILENT. The 410 is the load-bearing half
    of a takedown: a sitemap job that cannot run here (no store on this
    host, read-only shard dir, a regression in another lane) must not
    turn a verified removal into a 500 and lose the removal with it. So
    every failure is caught — and then logged at ERROR *and* returned to
    the operator in the response body, because a takedown whose sitemap
    half failed quietly keeps feeding the removed URL to crawlers while
    every visible signal says it was honored.

    Returns ``{"status": "ok"|"skipped"|"failed", "reason": str|None,
    "total_urls": int|None}``. ``total_urls`` stays None unless a
    regeneration actually produced a manifest (absent != zero).

    Known cross-module constraint: seo.regenerate() re-reads the removal
    set through ``removed_cuis()`` with no db_path, i.e. from
    PUBLIC_RO_DB_PATH. A router built with an explicit db_path pointing
    somewhere else would regenerate against the wrong database; plumbing
    a db_path through seo.regenerate is that lane's change to make.
    """
    try:
        from engine.public_ro import seo
    except Exception as exc:  # noqa: BLE001 — seo is optional at import time
        logger.error("[public-ro takedown] sitemap module unavailable: %s",
                     exc, exc_info=True)
        return {"status": "failed",
                "reason": "engine.public_ro.seo unavailable: %s" % exc,
                "total_urls": None}
    try:
        out_dir = seo.sitemap_dir()
        if not (out_dir / _SITEMAP_INDEX_NAME).is_file():
            return {"status": "skipped",
                    "reason": "no sitemap has been generated on this host",
                    "total_urls": None}
        manifest = seo.regenerate(trigger=trigger)
        _invalidate_seo_cache(seo)
    except Exception as exc:  # noqa: BLE001 — see BEST-EFFORT above
        logger.error(
            "[public-ro takedown] SITEMAP NOT REFRESHED (%s): the removed"
            " URL is still being served to crawlers; run"
            " scripts/public_seo.py sitemaps by hand",
            exc, exc_info=True,
        )
        return {"status": "failed",
                "reason": str(exc) or exc.__class__.__name__,
                "total_urls": None}
    return {"status": "ok", "reason": None,
            "total_urls": manifest.get("total_urls")}


def _public_effect(state: Optional[Dict[str, Any]],
                   cui: int) -> Dict[str, Optional[str]]:
    """What the operator's action actually did to the served page."""
    name = state["action"] if state else "published"
    if name == "remove":
        return {"public_effect": PUBLIC_EFFECT_REMOVED,
                "public_effect_detail": None}
    if name != "annotate":
        return {"public_effect": PUBLIC_EFFECT_PUBLISHED,
                "public_effect_detail": None}
    if page_layer_renders_annotations():
        return {"public_effect": PUBLIC_EFFECT_RENDERED,
                "public_effect_detail": None}
    detail = (
        "Recorded in the audit trail only. No page-layer renderer is wired"
        " (%s.%s is missing), so the public page is byte-identical and still"
        " presents the disputed figures. Do not report this to the requester"
        " as a completed change." % ANNOTATION_RENDERER
    )
    logger.warning("[public-ro takedown] cui=%s action=annotate: %s",
                   cui, detail)
    return {"public_effect": PUBLIC_EFFECT_NOT_RENDERED,
            "public_effect_detail": detail}


def apply_action(
    cui: int,
    action: str,
    reason: str,
    verified_by: str,
    *,
    note: Optional[str] = None,
    db_path: Optional[Path] = None,
) -> Dict[str, Any]:
    """Record the action AND honor it on the public surfaces.

    The single authority for "an operator changed a CUI's public state":
    the HTTP endpoint is a thin auth wrapper over this, and any future
    CLI or cron caller must come through here too. ``record_action``
    remains the audit-append primitive and honors nothing on its own —
    that split is what keeps the honoring from being forgettable.

    The sitemap is refreshed for EVERY action, not only 'remove': an
    annotate or a restore over a prior removal puts the URL back, so
    narrowing this to one action would reintroduce the same class of
    stale-sitemap bug from the other direction.
    """
    row = record_action(cui, action, reason, verified_by, note=note,
                        db_path=db_path)
    state = current_state(cui, db_path)
    result = {
        "ok": True,
        "audit_id": row["id"],
        "cui": cui,
        "action": action,
        "state": state["action"] if state else "published",
        "removed": bool(state and state["action"] == "remove"),
        "state_version": row["id"],
        "sitemap_refresh": refresh_public_sitemaps(),
    }
    result.update(_public_effect(state, cui))
    return result


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
        result = apply_action(
            body.cui,
            body.action,
            body.reason,
            body.verified_by,
            note=body.note,
            db_path=db_path,
        )
        logger.info(
            "[public-ro takedown] cui=%s action=%s verified_by=%s audit_id=%s"
            " effect=%s sitemap=%s",
            body.cui,
            body.action,
            body.verified_by,
            result["audit_id"],
            result["public_effect"],
            result["sitemap_refresh"]["status"],
        )
        return result

    return router
