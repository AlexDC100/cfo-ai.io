"""Funnel honesty — the public-surface event sink, cohorts and rollup
(Lane 5, public-data acquisition engine).

What lives here
---------------
  * ``build_funnel_router()`` — POST /api/public/ro/event, the one write
    endpoint the public pages' beacon hits. Fire-and-forget semantics:
    the route ALWAYS answers 204, whether the event was stored, capped,
    or dropped as malformed — an abuse probe learns nothing.
  * ``BEACON_SNIPPET`` — the tiny inline, dependency-free JS the lane-3
    page templates embed verbatim (contract:
    ``engine.public_ro.funnel.BEACON_SNIPPET``). It is the ONLY
    JavaScript on the public pages.
  * Cohort logic (PS4): ``cohort_for_user`` / ``compute_paid_funnel`` —
    a user is ``public_only`` iff they carry funnel/signup attribution
    but have ZERO uploads across all months. COMPUTED server-side from
    attribution + usage, never stored as a mutable flag.
  * ``compute_funnel_rollup`` + ``write_funnel_record`` — the honest
    metrics file behind the /ops funnel panel
    (``data/obs/funnel_last.json``; ``scripts/public_funnel.py`` is the
    operator CLI that writes it).

Privacy (the anti-pattern this module exists to NOT repeat)
-----------------------------------------------------------
``session_log`` (src/engine/storage/postgres.py:148) stores whole IPs.
Here the raw IP is NEVER stored anywhere: events carry
``ip_hash = sha256(daily_salt + ip)[:16]`` where the salt is a random
32-hex value minted per UTC day (persisted in the same SQLite file so
the hourly abuse cap survives restarts) — hashes cannot be correlated
across days and a truncated 16-hex digest is not reversible. The user
agent is reduced to a three-way class (``crawler|browser|other``); the
raw UA string is never stored either.

Storage
-------
Events land in the ``funnel_events`` table of ``data/public_ro.db`` —
the wave's SEPARATE SQLite spine (never engine.db, never Supabase).
Connections are opened here with ``PRAGMA journal_mode=WAL`` and
``busy_timeout=5000`` per the wave storage contract. When lane 1's
``engine.public_ro.store`` module exposes ``db_path()`` we defer to it
so both lanes agree on the file; env ``PUBLIC_RO_DB_PATH`` overrides
for tests. That store ALSO declares ``funnel_events`` (schema-only, in a
slightly different shape), and only the first CREATE in a given file has
any effect — so ``connect()`` reconciles the table it finds to the
columns this module writes instead of assuming its own DDL ran.

No AI anywhere in this module (wave rule: zero anthropic imports).
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Tuple

logger = logging.getLogger("engine.public_ro.funnel")

# ──────────────────────────────────────────────────────────────────────
# Event vocabulary (closed — unknown kinds are dropped, silently)
# ──────────────────────────────────────────────────────────────────────

EVENT_KINDS = (
    "page_view",
    "search",
    "report_open",
    "locked_ratio_tap",
    "cta_click",
    "teardown_export",
)

# Per-ip_hash hourly abuse cap; overrun events are DROPPED SILENTLY
# (the route still answers 204 so the cap is not an oracle).
DEFAULT_HOURLY_CAP = 120
_ENV_HOURLY_CAP = "PUBLIC_FUNNEL_HOURLY_CAP"

_ENV_DB_PATH = "PUBLIC_RO_DB_PATH"

_CUI_RE = re.compile(r"^[0-9]{2,10}$")
_UTM_KEY_RE = re.compile(r"^utm_[a-z0-9_]{1,24}$")

# UA classing — string matching only. NOTE (wave decision): no reverse-
# DNS verification of crawler IPs this wave; a spoofed crawler UA is
# classed as a crawler. Acceptable for aggregate funnel counts.
_CRAWLER_UA_SUBSTRINGS = (
    "googlebot", "bingbot", "yandex", "duckduckbot", "baiduspider",
    "applebot", "ahrefsbot", "semrushbot", "petalbot", "gptbot",
    "claudebot", "slurp", "crawler", "spider", "bot/",
)
_BROWSER_UA_SUBSTRINGS = ("mozilla", "chrome", "safari", "firefox", "edg", "opera")


# ──────────────────────────────────────────────────────────────────────
# The beacon (exported constant — lane 3 templates import this verbatim)
# ──────────────────────────────────────────────────────────────────────
# Design: zero dependencies, fetch keepalive, every failure swallowed
# (.catch(()=>{}) + try/catch) — the public page must render identically
# with the sink down, blocked, or absent. Relative URL so it works both
# on the clean cfo-ai.io paths and under the /api/public/ro/* mirror
# host. Exposes window.__cfoPubEvent(kind, extra) for the page's own
# locked_ratio_tap / cta_click handlers, and fires one page_view
# (with utm_* passthrough) on load.

BEACON_SNIPPET = (
    "<script>(function(){try{"
    "var send=function(k,d){try{var b={kind:k,path:location.pathname.slice(0,300)};"
    "if(d){for(var K in d){if(Object.prototype.hasOwnProperty.call(d,K))b[K]=d[K];}}"
    "fetch('/api/public/ro/event',{method:'POST',"
    "headers:{'Content-Type':'application/json'},"
    "body:JSON.stringify(b),keepalive:true}).catch(function(){});}catch(e){}};"
    "window.__cfoPubEvent=send;"
    "var u={},n=0,sp=new URLSearchParams(location.search);"
    "sp.forEach(function(v,k){if(k.indexOf('utm_')===0&&n<8){u[k]=String(v).slice(0,120);n++;}});"
    "send('page_view',n?{utm:u}:null);"
    "}catch(e){}})();</script>"
)


# ──────────────────────────────────────────────────────────────────────
# Storage plumbing
# ──────────────────────────────────────────────────────────────────────

# Two modules CREATE funnel_events in the same file: this one and lane
# 1's ``store.PublicRoStore`` ("schema-only here — lanes 5/6 own their
# write paths", store.py:14). Whichever opens the file first wins and
# every later CREATE TABLE IF NOT EXISTS is a silent no-op, so the shape
# this module finds is NOT guaranteed to be the shape below — the store's
# has no ``day`` column. Nullable columns (rather than the NOT NULL the
# writer always satisfies anyway) are deliberate: ALTER TABLE cannot add
# a NOT NULL column without a default, so this is the one shape both the
# fresh-create and the migration path can produce. _reconcile_columns()
# is what makes the difference survivable; see connect().
_FUNNEL_DDL = (
    """
    CREATE TABLE IF NOT EXISTS funnel_events (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        ts       TEXT NOT NULL,          -- ISO-8601 UTC
        day      TEXT,                   -- YYYY-MM-DD (UTC)
        kind     TEXT NOT NULL,
        cui      TEXT,
        path     TEXT,
        utm      TEXT,                   -- JSON object of utm_* params or NULL
        ip_hash  TEXT,                   -- sha256(daily_salt + ip)[:16]; raw IP NEVER stored
        ua_class TEXT                    -- crawler | browser | other
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS funnel_salt (
        day  TEXT PRIMARY KEY,           -- YYYY-MM-DD (UTC)
        salt TEXT NOT NULL               -- random 32-hex, minted on first event of the day
    )
    """,
)

# Indexes are created AFTER _reconcile_columns() — the day index is
# exactly what used to raise "no such column: day" on a store-created
# file, killing every event in the process.
_FUNNEL_INDEXES = (
    "CREATE INDEX IF NOT EXISTS idx_funnel_events_day  ON funnel_events(day)",
    "CREATE INDEX IF NOT EXISTS idx_funnel_events_kind ON funnel_events(kind)",
    "CREATE INDEX IF NOT EXISTS idx_funnel_events_iph  ON funnel_events(ip_hash, ts)",
)

#: Every column record_event() writes. connect() guarantees all of them
#: exist whichever module created the table.
_EVENT_COLUMNS = ("ts", "day", "kind", "cui", "path", "utm", "ip_hash", "ua_class")


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def db_path() -> Path:
    """The shared public-RO SQLite file. Order: env override → lane 1's
    ``store.db_path()`` contract (so both lanes agree) → the wave
    default ``<repo>/data/public_ro.db``."""
    env = os.environ.get(_ENV_DB_PATH)
    if env:
        return Path(env)
    try:  # lane 1 contract (concurrent lane — may not have landed yet)
        from engine.public_ro import store as _store  # type: ignore

        for name in ("db_path", "default_db_path"):
            fn = getattr(_store, name, None)
            if callable(fn):
                return Path(fn())
    except Exception:  # noqa: BLE001 — contract module absent; use default
        pass
    return _repo_root() / "data" / "public_ro.db"


def _reconcile_columns(conn: sqlite3.Connection) -> None:
    """Add any write column the found table is missing.

    The store's funnel_events has no ``day``; ours does. Without this the
    day index raised ``no such column: day`` on every connect() and
    record_event() swallowed it — the route still answered 204, so the
    sink reported success while storing nothing. Adding the column is
    preferred over dropping it from the writer because a file created by
    the older funnel DDL has ``day NOT NULL`` and would then reject every
    insert; after this both origins converge on one shape.
    """
    have = {row[1] for row in conn.execute("PRAGMA table_info(funnel_events)")}
    for column in _EVENT_COLUMNS:
        if column in have:
            continue
        try:
            # Identifiers cannot be bound; these come from _EVENT_COLUMNS.
            conn.execute("ALTER TABLE funnel_events ADD COLUMN %s TEXT" % column)
        except sqlite3.OperationalError:
            # Another process won the race and added it first.
            logger.debug("[public_ro.funnel] column %s already added", column)
    if "day" not in have:
        # Pre-existing rows carry ts but no day; derive rather than leave
        # them NULL so the day index and any day query see whole history.
        conn.execute(
            "UPDATE funnel_events SET day = substr(ts, 1, 10) WHERE day IS NULL"
        )


def connect(path: Optional[Any] = None) -> sqlite3.Connection:
    """Open the public-RO DB with the wave PRAGMAs (WAL + busy_timeout
    5000) and make sure the funnel tables exist AND carry every column
    this module writes (the file is shared with lane 1's store)."""
    target = Path(path) if path is not None else db_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(target))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    for stmt in _FUNNEL_DDL:
        conn.execute(stmt)
    _reconcile_columns(conn)
    for stmt in _FUNNEL_INDEXES:
        conn.execute(stmt)
    conn.commit()
    return conn


def _daily_salt(conn: sqlite3.Connection, day: str) -> str:
    """Random per-UTC-day salt, minted on first use and persisted so the
    hourly cap keeps working across restarts. Old days' salts are pruned
    (keep 2 days for the midnight boundary) — once a salt is gone, that
    day's hashes can never be re-derived from IPs."""
    row = conn.execute(
        "SELECT salt FROM funnel_salt WHERE day = ?", (day,)
    ).fetchone()
    if row:
        return str(row[0])
    salt = secrets.token_hex(16)
    conn.execute(
        "INSERT OR IGNORE INTO funnel_salt(day, salt) VALUES (?, ?)", (day, salt)
    )
    conn.execute(
        "DELETE FROM funnel_salt WHERE day < ?",
        ((datetime.strptime(day, "%Y-%m-%d") - timedelta(days=1)).strftime("%Y-%m-%d"),),
    )
    conn.commit()
    row = conn.execute(
        "SELECT salt FROM funnel_salt WHERE day = ?", (day,)
    ).fetchone()
    return str(row[0])


def hash_ip(ip: str, salt: str) -> str:
    """``sha256(daily_salt + ip)`` truncated to 16 hex chars. Truncation
    is deliberate: 64 bits is plenty for hourly-cap bucketing and
    same-day distinct counts, and far too little to serve as a stable
    long-term identifier."""
    return hashlib.sha256((salt + ip).encode("utf-8")).hexdigest()[:16]


def classify_ua(user_agent: str) -> str:
    ua = (user_agent or "").lower()
    if not ua:
        return "other"
    if any(s in ua for s in _CRAWLER_UA_SUBSTRINGS):
        return "crawler"
    if any(s in ua for s in _BROWSER_UA_SUBSTRINGS):
        return "browser"
    return "other"


def _hourly_cap() -> int:
    try:
        return max(1, int(os.environ.get(_ENV_HOURLY_CAP, DEFAULT_HOURLY_CAP)))
    except ValueError:
        return DEFAULT_HOURLY_CAP


def _sanitize_utm(utm: Any) -> Optional[str]:
    if not isinstance(utm, Mapping):
        return None
    clean: Dict[str, str] = {}
    for key, value in utm.items():
        if len(clean) >= 8:
            break
        if isinstance(key, str) and _UTM_KEY_RE.match(key) and isinstance(value, str):
            clean[key] = value[:120]
    return json.dumps(clean, sort_keys=True, ensure_ascii=False) if clean else None


#: Set once the sink has failed in this process (see record_event).
_SINK_FAILURE_SEEN = False


def record_event(
    *,
    kind: str,
    ip: str,
    user_agent: str = "",
    cui: Optional[str] = None,
    path: Optional[str] = None,
    utm: Optional[Mapping[str, str]] = None,
    now: Optional[datetime] = None,
    db: Optional[Any] = None,
) -> bool:
    """Validate + store one funnel event. Returns True when stored,
    False when dropped (unknown kind, malformed fields, hourly cap).
    Never raises — the sink must not become a 500 source for public
    pages."""
    try:
        if kind not in EVENT_KINDS:
            return False
        moment = now or datetime.now(timezone.utc)
        day = moment.strftime("%Y-%m-%d")
        ts = moment.isoformat()
        clean_cui = cui if isinstance(cui, str) and _CUI_RE.match(cui) else None
        clean_path = path[:300] if isinstance(path, str) and path else None
        utm_json = _sanitize_utm(utm)

        conn = connect(db)
        try:
            salt = _daily_salt(conn, day)
            iph = hash_ip(ip or "", salt)
            # Hourly abuse cap per ip_hash — drop silently on overrun.
            hour_ago = (moment - timedelta(hours=1)).isoformat()
            (count,) = conn.execute(
                "SELECT COUNT(*) FROM funnel_events WHERE ip_hash = ? AND ts >= ?",
                (iph, hour_ago),
            ).fetchone()
            if int(count) >= _hourly_cap():
                return False
            conn.execute(
                "INSERT INTO funnel_events(ts, day, kind, cui, path, utm, ip_hash, ua_class)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (ts, day, kind, clean_cui, clean_path, utm_json, iph,
                 classify_ua(user_agent)),
            )
            conn.commit()
            return True
        finally:
            conn.close()
    except Exception:  # noqa: BLE001 — silent to the CALLER, not to the operator
        # The route answers 204 either way (no abuse oracle), so a broken
        # sink is invisible from outside. The first failure per process is
        # therefore a WARNING: a whole-schema outage once ran for weeks
        # behind a debug-level log and a green 204.
        global _SINK_FAILURE_SEEN
        if _SINK_FAILURE_SEEN:
            logger.debug("[public_ro.funnel] event dropped on error", exc_info=True)
        else:
            _SINK_FAILURE_SEEN = True
            logger.warning(
                "[public_ro.funnel] event sink failing — events are being "
                "dropped; further drops log at debug",
                exc_info=True,
            )
        return False


# ──────────────────────────────────────────────────────────────────────
# Event-sink router (POST /api/public/ro/event)
# ──────────────────────────────────────────────────────────────────────

def _client_ip(request: Any) -> str:
    """The LAST X-Forwarded-For hop, else the socket peer.

    Rightmost, not leftmost: Caddy fronts this backend with a bare
    ``reverse_proxy`` (no ``trusted_proxies``), which APPENDS the real
    peer to whatever the caller already put in the header. So index 0 is
    always attacker-written and only the final entry was added by our
    proxy. This value keys the hourly abuse cap — reading it from the
    left let one caller mint a fresh cap bucket per request by rotating
    the header, and with it rewrite every /ops funnel number.

    Correct for EXACTLY ONE trusted hop, which is what runs today: DNS
    points straight at the VPS and responses carry `via: 1.1 Caddy` and
    nothing else. A CDN in front would invert this — the last hop would
    be the CDN edge, every visitor would collapse into a single cap
    bucket, and the cap would throttle the world instead of an abuser.
    If one is ever added, index from the right by the number of trusted
    hops; do not go back to hops[0].
    """
    try:
        fwd = request.headers.get("x-forwarded-for") or ""
        hops = [hop.strip() for hop in fwd.split(",") if hop.strip()]
        if hops:
            return hops[-1]
        client = getattr(request, "client", None)
        return getattr(client, "host", "") or ""
    except Exception:  # noqa: BLE001
        return ""


# NOTE: the request model and fastapi imports live at MODULE scope on
# purpose — this file uses `from __future__ import annotations`, so a
# model defined inside the factory closure would be invisible when
# FastAPI resolves the endpoint's (string) annotations against module
# globals, silently demoting the body to query params.
from fastapi import APIRouter, Request, Response  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402


class FunnelEventIn(BaseModel):
    kind: str = Field(..., min_length=1, max_length=32)
    cui: Optional[str] = Field(None, max_length=16)
    path: Optional[str] = Field(None, max_length=600)
    utm: Optional[Dict[str, str]] = None


def build_funnel_router() -> Any:
    """The public event sink. Absolute paths — the lane-3 aggregate
    router includes this WITHOUT a prefix (routes are already reachable
    under /api/public/ro/*, the existing Caddy matcher)."""
    router = APIRouter()

    @router.post(
        "/api/public/ro/event", status_code=204, response_class=Response
    )
    def ingest_event(payload: FunnelEventIn, request: Request) -> None:
        """Always 204 — stored, capped and malformed events are
        indistinguishable to the caller (no abuse oracle)."""
        record_event(
            kind=payload.kind,
            ip=_client_ip(request),
            user_agent=request.headers.get("user-agent", ""),
            cui=payload.cui,
            path=payload.path,
            utm=payload.utm,
        )

    return router


# ──────────────────────────────────────────────────────────────────────
# Cohorts (PS4) — computed, never stored as a mutable flag
# ──────────────────────────────────────────────────────────────────────

def total_uploads(usage_rows: Iterable[Mapping[str, Any]]) -> int:
    """Sum ``user_usage.uploads`` across every month row for one user."""
    total = 0
    for row in usage_rows or []:
        try:
            total += int(row.get("uploads") or 0)
        except (TypeError, ValueError):
            continue
    return total


def cohort_for_user(
    *,
    first_touch: Optional[Mapping[str, Any]],
    usage_rows: Iterable[Mapping[str, Any]],
) -> str:
    """PS4 cohort function. ``public_only`` iff the user has funnel/
    signup attribution (a ``first_touch`` record) AND zero uploads
    across all months. The FIRST upload migrates them to ``activated``
    — the cohort flips because the inputs changed, while the
    attribution record itself is immutable and preserved. Users with no
    attribution are ``unattributed`` regardless of usage (we never
    reconstruct an attribution that was not captured)."""
    if not first_touch:
        return "unattributed"
    return "activated" if total_uploads(usage_rows) > 0 else "public_only"


def compute_paid_funnel(
    subscription_rows: Iterable[Mapping[str, Any]],
    usage_by_user: Mapping[str, Iterable[Mapping[str, Any]]],
) -> List[Dict[str, Any]]:
    """The paid-product funnel, shaped like GET /api/admin/usage rows
    (src/engine/api/_billing.py:1498) but with the PS4 honesty rule
    applied: a subscription row alone (every signup gets a trial row via
    handle_new_user) does NOT put a user in the paid funnel — only
    actual product usage does (``user_usage.uploads > 0`` in any month).
    A ``public_only`` cohort user therefore NEVER appears here."""
    out: List[Dict[str, Any]] = []
    for row in subscription_rows or []:
        uid = row.get("user_id")
        if not uid:
            continue
        uploads = total_uploads(usage_by_user.get(uid, []))
        if uploads <= 0:
            continue  # visitor / public_only — not in the paid funnel
        out.append(
            {
                "user_id": uid,
                "tier": row.get("tier") or row.get("plan") or "trial",
                "status": row.get("status"),
                "uploads_total": uploads,
            }
        )
    return out


# ──────────────────────────────────────────────────────────────────────
# Rollup — data/obs/funnel_last.json (the /ops funnel panel's source)
# ──────────────────────────────────────────────────────────────────────

FUNNEL_RECORD_SCHEMA = "public_funnel_v1"


def read_event_counts(
    *, db: Optional[Any] = None, window_days: int = 30,
    now: Optional[datetime] = None,
) -> Dict[str, Any]:
    """Aggregate the funnel_events table over the trailing window.
    Returns per-kind counts plus browser-only page views (crawler
    traffic is real but is not a conversion denominator)."""
    moment = now or datetime.now(timezone.utc)
    since = (moment - timedelta(days=max(1, int(window_days)))).isoformat()
    counts = {kind: 0 for kind in EVENT_KINDS}
    traffic_browser = 0
    conn = connect(db)
    try:
        for kind, ua_class, n in conn.execute(
            "SELECT kind, ua_class, COUNT(*) FROM funnel_events"
            " WHERE ts >= ? GROUP BY kind, ua_class",
            (since,),
        ):
            if kind in counts:
                counts[kind] += int(n)
                if kind == "page_view" and ua_class == "browser":
                    traffic_browser += int(n)
    finally:
        conn.close()
    return {
        "window_days": int(window_days),
        "counts": counts,
        "traffic_browser": traffic_browser,
    }


def _rate(numerator: Optional[int], denominator: Optional[int]) -> Optional[float]:
    """Honest None on an unknown numerator or a zero/unknown denominator
    — absence is never reconstructed as a measurement (wave rule)."""
    if numerator is None or not denominator:
        return None
    return float(numerator) / float(denominator)


def compute_funnel_rollup(
    *,
    event_counts: Mapping[str, Any],
    signups_attributed: Optional[int],
    uploads_attributed: Optional[int],
    generated_at: Optional[str] = None,
) -> Dict[str, Any]:
    """Assemble the funnel record. ``signups_attributed`` /
    ``uploads_attributed`` are None when Supabase was unreachable (the
    CLI degrades honestly); every dependent rate is then None too."""
    counts = dict(event_counts.get("counts") or {})
    traffic = int(counts.get("page_view", 0))
    traffic_browser = int(event_counts.get("traffic_browser") or 0)
    return {
        "schema": FUNNEL_RECORD_SCHEMA,
        "generated_at": generated_at
        or datetime.now(timezone.utc).isoformat(),
        "window_days": event_counts.get("window_days"),
        "traffic": traffic,
        "traffic_browser": traffic_browser,
        "searches": int(counts.get("search", 0)),
        "report_opens": int(counts.get("report_open", 0)),
        "locked_ratio_taps": int(counts.get("locked_ratio_tap", 0)),
        "cta_clicks": int(counts.get("cta_click", 0)),
        "teardown_exports": int(counts.get("teardown_export", 0)),
        "signups_attributed": signups_attributed,
        "uploads_attributed": uploads_attributed,
        # browser page views are the honest public denominator
        "public_to_signup_rate": _rate(signups_attributed, traffic_browser),
        "signup_to_upload_rate": _rate(uploads_attributed, signups_attributed),
    }


def write_funnel_record(record: Mapping[str, Any], path: Optional[Any] = None) -> Path:
    """Atomic write of data/obs/funnel_last.json (tmp + os.replace),
    same convention as the battery/template records the /ops panel
    already reads."""
    from engine.obs.sentinels import obs_dir

    target = Path(path) if path is not None else obs_dir() / "funnel_last.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(target.name + ".tmp")
    tmp.write_text(
        json.dumps(record, sort_keys=True, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    os.replace(str(tmp), str(target))
    return target


#: user_ids per user_usage request. The in.() list rides in the query
#: string, so it is chunked rather than sent whole for a large cohort.
_USAGE_CHUNK = 100
#: Row ceiling per chunk (a user holds one user_usage row per month).
#: Hitting it exactly means the page may be truncated, and a truncated
#: count is unknown — see the None return below.
_USAGE_ROWS_PER_USER = 60


def _in_list(values: Iterable[str]) -> str:
    """PostgREST ``in.("a","b")``. Values are quoted so a stray comma in
    an id cannot split one term into two."""
    return "in.(%s)" % ",".join(
        '"%s"' % str(v).replace("\\", "").replace('"', "") for v in values
    )


def fetch_attributed_counts(
    *, window_days: int, now: Optional[datetime] = None
) -> Tuple[Optional[int], Optional[int]]:
    """Best-effort Supabase read over the SAME trailing window the event
    rollup uses: (signups attributed in-window, of those, how many have
    ever uploaded).

    ``window_days`` is required, not defaulted: pairing an all-time
    numerator with a windowed denominator is what made the /ops panel
    print conversion rates above 100%, and a default is exactly how that
    pairing goes unnoticed at a call site.

    Either half is None when its read failed — an unknown count must
    stay unknown; a fabricated 0 reads as a measured "nobody", which is
    a different and much worse claim.
    """
    moment = now or datetime.now(timezone.utc)
    since = (moment - timedelta(days=max(1, int(window_days)))).isoformat()

    try:
        from engine.api import _supabase

        with _supabase.admin() as client:
            # profiles.first_touch is written by the signup trigger, so
            # created_at IS the attribution moment for this cohort.
            profiles = client.select(
                "profiles",
                columns="id",
                filters={
                    "first_touch": "not.is.null",
                    "created_at": "gte.%s" % since,
                },
                limit=10000,
            ) or []
            attributed = sorted({str(p.get("id")) for p in profiles if p.get("id")})
            if not attributed:
                # A measured zero: nobody was attributed in the window,
                # so nobody attributed uploaded either.
                return 0, 0
            uploaders = _fetch_uploaders(client, attributed)
    except Exception:  # noqa: BLE001 — honest None, never a fabricated 0
        logger.debug("[public_ro.funnel] attribution fetch unavailable", exc_info=True)
        return None, None
    return len(attributed), uploaders


def _fetch_uploaders(client: Any, attributed: List[str]) -> Optional[int]:
    """How many of ``attributed`` have any upload, counted server-side.

    The unfiltered read this replaces pulled user_usage whole under a row
    limit; user_usage is one row per user PER MONTH, so unattributed
    users consumed the page and attributed uploaders fell off the end —
    the panel then reported 0 uploads against a cohort that had all
    uploaded. Returns None if a chunk failed or came back at its ceiling
    (possibly truncated): a maybe-short count is not a count.
    """
    uploaders = 0
    for start in range(0, len(attributed), _USAGE_CHUNK):
        chunk = attributed[start:start + _USAGE_CHUNK]
        cap = len(chunk) * _USAGE_ROWS_PER_USER
        try:
            rows = client.select(
                "user_usage",
                columns="user_id,uploads",
                filters={"user_id": _in_list(chunk), "uploads": "gt.0"},
                limit=cap,
            ) or []
        except Exception:  # noqa: BLE001
            logger.debug("[public_ro.funnel] usage chunk unavailable", exc_info=True)
            return None
        if len(rows) >= cap:
            logger.debug("[public_ro.funnel] usage chunk hit its row ceiling")
            return None
        uploaders += len({str(r.get("user_id")) for r in rows if r.get("user_id")})
    return uploaders
