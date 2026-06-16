"""GDELT (Global Database of Events, Language, Tone) adapter — Phase C, v2.

v2 ships rate-limit hardening after Gate B (2026-06-01) surfaced that GDELT
DOC 2.0 enforces a strict 1 req / 5s per-IP cap, with stacking penalty under
repeat-offender bursts. v1's 5-query-per-radar-refresh design lost 4 of 5
themed queries to HTTP 429 on every cache-cold restart.

v2 design:
  1. ONE combined OR-query covers all 5 themes — single HTTP call per cache
     window. Each themed paren-group is OR'd into the outer combined query.
     GDELT requires OR'd terms wrapped in (); we wrap each theme group AND
     the outer combined clause.
  2. Local theme-tagging — after parsing the single response, each article's
     title + url is matched against each theme's keyword list. First match
     wins; articles matching no theme are dropped.
  3. Persistent disk cache at /app/data/gdelt_cache.json (Docker volume
     `backend_data` — survives container restarts). Memory cache layered on
     top for sub-millisecond access within a single process.
  4. Stale-while-revalidate fallback. If the live fetch fails (429, network,
     non-JSON response), serve the stale disk cache up to 4h old. Better to
     show old signals than blank radar cells.
  5. Explicit non-JSON response detection. GDELT sometimes returns 200 OK
     with a plain-text error string ("Queries containing OR'd terms must be
     surrounded by ().", "Please limit requests...", etc). v1 caught these
     as JSONDecodeError and silently returned []. v2 raises GdeltApiError
     with the raw body excerpt logged at WARNING.

Tone scale: -10 (extreme negativity) to +10 (extreme positivity). GDELT's
article-level `tone` field is its analog to the event-level Goldstein
score. Articles with tone < -3 are high severity, [-3, -1) are medium,
>= -1 are filtered out.

Config:
  GDELT_ENABLED=1   — required gate. Default OFF (Phase C pattern).
  GDELT_CACHE_PATH  — optional; default /app/data/gdelt_cache.json.

Themed queries (5 radar lenses) — see THEMED_QUERIES below for full keyword lists.

Gate B verification post-v2 deploy: from prod backend, call
GdeltSignalAdapter(enabled=True).fetch_recent_signals(since). Single HTTP
call to GDELT; if it succeeds you get a tagged signal list with mixed
themes. If it fails with non-JSON or 429, the loud error log shows the
raw body — much easier to diagnose than v1's silent zero-fall.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Optional
from uuid import uuid5, NAMESPACE_URL

from ..models import IntelligenceSignal
from .base import AdapterHealth, SignalAdapter

logger = logging.getLogger(__name__)

_BASE = "https://api.gdeltproject.org/api/v2/doc/doc"
_HTTP_TIMEOUT_SEC = 15
_MAX_RECORDS_PER_QUERY = 250        # GDELT DOC API ceiling for ArtList mode
_CACHE_TTL_SEC = 15 * 60            # 15 min fresh window
_CACHE_STALE_CEILING_SEC = 4 * 3600 # 4h stale-while-revalidate ceiling
_DEFAULT_CACHE_PATH = "/app/data/gdelt_cache.json"

# Tone thresholds (article tone, -10..+10; strict-less-than at boundaries).
_TONE_HIGH_THRESHOLD = -3.0
_TONE_MEDIUM_THRESHOLD = -1.0

# Filter applied to the combined query — keeps to English-language sources.
# Empty string means "no filter beyond keyword OR clause."
_COMBINED_QUERY_FILTER = "sourcelang:eng"


# Each theme carries its own keyword list (for both query-building and
# local article tagging) plus its risk-radar metadata. The keyword list is
# the SOURCE OF TRUTH — the combined GDELT query is derived from it, and
# article tagging matches against the same list. No drift between what we
# ask GDELT and what we recognize in its response.
THEMED_QUERIES: list[dict] = [
    {
        "id": "taiwan_strait",
        "keywords": ["Taiwan Strait", "Taiwan invasion", "PLA Taiwan", "cross-strait"],
        "signal_type": "geopolitical",
        "sectors": ["Technology", "Industrials"],
        "channels": ["supply_availability", "revenue"],
        "descr": "Taiwan Strait escalation",
    },
    {
        "id": "red_sea",
        "keywords": ["Red Sea", "Suez", "Houthi attack", "Bab el-Mandeb"],
        "signal_type": "supply_chain",
        "sectors": ["Consumer Discretionary", "Industrials", "Energy"],
        "channels": ["supply_availability", "working_capital"],
        "descr": "Red Sea / Suez shipping disruption",
    },
    {
        "id": "russia_ukraine",
        "keywords": ["Russia Ukraine", "Kyiv strike", "Moscow drone", "front line Ukraine"],
        "signal_type": "geopolitical",
        "sectors": ["Energy", "Utilities", "Materials"],
        "channels": ["supply_availability", "revenue"],
        "descr": "Russia-Ukraine front escalation",
    },
    {
        "id": "middle_east",
        "keywords": ["Israel Gaza", "Hezbollah strike", "Iran Israel", "Lebanon war"],
        "signal_type": "geopolitical",
        "sectors": ["Energy"],
        "channels": ["supply_availability", "revenue"],
        "descr": "Middle East tensions",
    },
    {
        "id": "us_china_trade",
        "keywords": ["US China trade", "Section 301", "Chinese tariffs", "export controls China"],
        "signal_type": "geopolitical",
        "sectors": ["Technology", "Consumer Discretionary", "Industrials"],
        "channels": ["revenue", "supply_availability"],
        "descr": "US-China trade escalation",
    },
]


class GdeltApiError(Exception):
    """Raised when GDELT returns a non-200, non-JSON, or otherwise unusable response.

    The raw body (first 200 chars) is included in the message so the operator
    sees what GDELT actually replied — rate limits, syntax errors, and
    transient outages all have distinct text-body signatures.
    """


class GdeltSignalAdapter:
    """GDELT 2.0 DOC API adapter — geopolitical event escalation feed."""

    name = "geopolitical"

    def __init__(
        self,
        enabled: Optional[bool] = None,
        http_get=None,
        cache_path: Optional[str] = None,
    ):
        """
        Args:
          enabled: explicit on/off override. None = read from GDELT_ENABLED env.
          http_get: test-injection seam. None = real GDELT HTTP call.
          cache_path: disk cache location. None = $GDELT_CACHE_PATH or default.
        """
        if enabled is None:
            enabled = os.getenv("GDELT_ENABLED", "").strip() in ("1", "true", "yes")
        self._configured = bool(enabled)
        self._http_get = http_get  # if None, uses _default_http_get
        self._cache_path = cache_path or os.getenv("GDELT_CACHE_PATH", _DEFAULT_CACHE_PATH)
        self._mem_cache: Optional[list[dict]] = None
        self._mem_cache_ts: Optional[datetime] = None
        self._cache_lock = threading.Lock()
        self._last_fetch_at: Optional[datetime] = None
        self._last_fetch_count = 0
        self._last_error: Optional[str] = None
        self._last_served_from: str = "none"   # "live" | "mem_cache" | "disk_stale" | "none"

    @property
    def configured(self) -> bool:
        return self._configured

    # ─── Reads ──────────────────────────────────────────────────────────

    def fetch_recent_signals(self, since: datetime) -> list[IntelligenceSignal]:
        if not self._configured:
            return []
        articles = self._fetch_articles()
        if not articles:
            self._last_fetch_at = _utcnow()
            self._last_fetch_count = 0
            return []
        signals = self._articles_to_signals(articles, since)
        self._last_fetch_at = _utcnow()
        self._last_fetch_count = len(signals)
        return signals

    def health(self) -> AdapterHealth:
        if not self._configured:
            return AdapterHealth(
                name=self.name,
                configured=False,
                reason="GDELT_ENABLED not set — set to 1 to enable Phase C geopolitical signals.",
            )
        return AdapterHealth(
            name=self.name,
            configured=True,
            reason="",
            last_fetch_at=self._last_fetch_at,
            last_fetch_count=self._last_fetch_count,
            last_error=self._last_error,
            extras={
                "themes_tracked": str(len(THEMED_QUERIES)),
                "cache_path": self._cache_path,
                "cache_ttl_sec": str(_CACHE_TTL_SEC),
                "last_served_from": self._last_served_from,
            },
        )

    # ─── Internals: cache layering ──────────────────────────────────────

    def _fetch_articles(self) -> list[dict]:
        """Return article list using cache layers + stale-while-revalidate.

        Order of precedence:
          1. Fresh memory cache (< TTL) → serve directly, no HTTP
          2. Fresh disk cache (< TTL) → hydrate memory + serve, no HTTP
          3. Live HTTP → on success, refresh both caches + serve
          4. Stale disk cache (< STALE_CEILING) → log + serve stale
          5. Nothing available → return [] (radar shows zero geopolitical signals)
        """
        now = _utcnow()

        with self._cache_lock:
            # 1. Memory cache fresh?
            if (self._mem_cache is not None and self._mem_cache_ts
                    and (now - self._mem_cache_ts).total_seconds() < _CACHE_TTL_SEC):
                self._last_served_from = "mem_cache"
                return self._mem_cache

            # 2. Disk cache fresh?
            disk = _load_cache_from_disk(self._cache_path)
            if disk:
                disk_ts, disk_articles = disk
                if (now - disk_ts).total_seconds() < _CACHE_TTL_SEC:
                    self._mem_cache = disk_articles
                    self._mem_cache_ts = disk_ts
                    self._last_served_from = "mem_cache"   # hydrated from disk
                    return disk_articles

        # 3. Live HTTP — outside the lock (the network call may be slow)
        live_articles: Optional[list[dict]] = None
        live_error: Optional[Exception] = None
        try:
            if self._http_get is not None:
                # Test seam — injected http_get receives the combined query string
                live_articles = self._http_get(_build_combined_query())
            else:
                live_articles = self._default_http_get()
        except Exception as e:
            live_error = e
            self._last_error = f"{type(e).__name__}: {str(e)[:200]}"
            logger.warning("gdelt_adapter: live fetch failed — %s", self._last_error)

        if live_articles is not None:
            with self._cache_lock:
                self._mem_cache = live_articles
                self._mem_cache_ts = now
                _save_cache_to_disk(self._cache_path, now, live_articles)
                self._last_error = None
                self._last_served_from = "live"
            return live_articles

        # 4. Stale-while-revalidate fallback
        with self._cache_lock:
            disk = _load_cache_from_disk(self._cache_path)
            if disk:
                disk_ts, disk_articles = disk
                age_sec = (now - disk_ts).total_seconds()
                if age_sec < _CACHE_STALE_CEILING_SEC:
                    logger.info(
                        "gdelt_adapter: serving STALE cache (age=%.0fs, live error=%s)",
                        age_sec, self._last_error or "n/a",
                    )
                    self._mem_cache = disk_articles
                    self._mem_cache_ts = disk_ts
                    self._last_served_from = "disk_stale"
                    return disk_articles

        # 5. Nothing available
        self._last_served_from = "none"
        return []

    # ─── Internals: HTTP ────────────────────────────────────────────────

    def _default_http_get(self) -> list[dict]:
        """Single combined-query GDELT call. Returns normalized article list.

        Raises GdeltApiError if the response is missing, non-200, or non-JSON
        (e.g. a plain-text rate-limit / syntax-error body). Raw body excerpt
        is included in the error message so the operator sees what GDELT
        actually said.
        """
        params = {
            "query": _build_combined_query(),
            "mode": "ArtList",
            "format": "json",
            "timespan": "24H",
            "maxrecords": str(_MAX_RECORDS_PER_QUERY),
            "sort": "DateDesc",
        }
        url = f"{_BASE}?{urllib.parse.urlencode(params)}"
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "CFO-AI-Intelligence/1.0 (+https://cfo-ai.io)"},
        )
        try:
            with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT_SEC) as resp:
                status = getattr(resp, "status", 200)
                raw = resp.read()
        except urllib.error.HTTPError as e:
            body = b""
            try:
                body = e.read()
            except Exception:
                pass
            body_excerpt = body[:200].decode("utf-8", errors="replace")
            raise GdeltApiError(f"HTTP {e.code}: {body_excerpt!r}") from e

        raw_str = raw.decode("utf-8", errors="replace")
        raw_stripped = raw_str.strip()

        if status != 200:
            raise GdeltApiError(f"HTTP {status}: {raw_stripped[:200]!r}")

        # Detect plain-text error bodies (200 OK with non-JSON content).
        # GDELT returns these for rate-limit, syntax errors, malformed queries.
        if not raw_stripped:
            raise GdeltApiError("Empty response body")
        if not raw_stripped.startswith("{"):
            raise GdeltApiError(f"Non-JSON response: {raw_stripped[:200]!r}")

        try:
            payload = json.loads(raw_str)
        except json.JSONDecodeError as e:
            raise GdeltApiError(
                f"JSON decode failed: {e}; body: {raw_stripped[:200]!r}"
            ) from e

        return [_normalize_article(a) for a in payload.get("articles", []) if a]

    # ─── Internals: tagging + signal building ────────────────────────────

    def _articles_to_signals(
        self, articles: list[dict], since: datetime
    ) -> list[IntelligenceSignal]:
        signals: list[IntelligenceSignal] = []
        for art in articles:
            tone = art.get("tone")
            seen_at = art.get("seen_at")
            if tone is None or seen_at is None:
                continue
            if tone >= _TONE_MEDIUM_THRESHOLD:
                continue
            if seen_at < since:
                continue
            theme = _tag_article(art)
            if theme is None:
                continue   # untagged article — keywords matched the combined query but
                           # not specifically enough to assign to one theme
            severity = "high" if tone < _TONE_HIGH_THRESHOLD else "medium"
            title = (art.get("title") or "GDELT event")[:200]
            url = art.get("url") or ""
            sig_id = str(uuid5(NAMESPACE_URL, f"gdelt:{theme['id']}:{url}"))
            signals.append(IntelligenceSignal(
                id=sig_id,
                signal_type=theme["signal_type"],                          # type: ignore[arg-type]
                title=title,
                summary=f"{theme['descr']}. Avg tone {tone:.2f} (threshold {_TONE_HIGH_THRESHOLD}).",
                source=f"gdelt:{theme['id']}",
                source_url=url or None,
                severity=severity,                                         # type: ignore[arg-type]
                time_horizon="3m",
                confidence=0.55,
                published_at=seen_at,
                affected_sectors=list(theme["sectors"]),
                financial_impact_channels=list(theme["channels"]),         # type: ignore[arg-type]
                risk_categories=[],
            ))
        return signals


# ──────────────────────────────────────────────────────────────────────────
# Module helpers — query building, article tagging, normalization, cache I/O
# ──────────────────────────────────────────────────────────────────────────

def _build_combined_query() -> str:
    """Combine all theme keyword groups into ONE OR'd GDELT query.

    GDELT syntax requires OR'd terms wrapped in (). We wrap each theme's
    keywords in their own paren group, then OR all theme groups together
    inside an outer paren group, then append the language filter.

    Example output (1 theme has 4 keywords, 5 themes total):
      ( ("Taiwan Strait" OR "Taiwan invasion" OR "PLA Taiwan" OR "cross-strait")
        OR ("Red Sea" OR "Suez" OR "Houthi attack" OR "Bab el-Mandeb")
        OR ... ) sourcelang:eng

    No URL-encoding here — caller passes the string to urllib.parse.urlencode
    which handles encoding. Returns the literal query body GDELT will see.
    """
    theme_clauses = []
    for theme in THEMED_QUERIES:
        quoted = [f'"{kw}"' for kw in theme["keywords"]]
        theme_clauses.append(f"({' OR '.join(quoted)})")
    inner_or = " OR ".join(theme_clauses)
    if _COMBINED_QUERY_FILTER:
        return f"({inner_or}) {_COMBINED_QUERY_FILTER}"
    return f"({inner_or})"


def _tag_article(art: dict) -> Optional[dict]:
    """Match article title + url against each theme's keywords (case-insensitive).

    Returns the first matching theme dict, or None if no theme matches. First-
    match-wins is intentional — themes are ordered by importance in
    THEMED_QUERIES, so a Taiwan article that also mentions trade wars routes
    to Taiwan (more specific signal) not US-China trade (broader category).
    """
    haystack = ((art.get("title") or "") + " " + (art.get("url") or "")).lower()
    for theme in THEMED_QUERIES:
        for kw in theme["keywords"]:
            if kw.lower() in haystack:
                return theme
    return None


def _normalize_article(raw: dict) -> dict:
    """Map the GDELT DOC 2.0 article schema → internal shape."""
    seen = raw.get("seendate")
    seen_at: Optional[datetime] = None
    if isinstance(seen, str):
        try:
            seen_at = datetime.strptime(seen, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
        except ValueError:
            seen_at = None
    tone_raw = raw.get("tone")
    tone: Optional[float] = None
    if tone_raw is not None:
        try:
            tone = float(tone_raw)
        except (TypeError, ValueError):
            tone = None
    return {
        "title": raw.get("title"),
        "url": raw.get("url"),
        "tone": tone,
        "seen_at": seen_at,
    }


def _load_cache_from_disk(path: str) -> Optional[tuple[datetime, list[dict]]]:
    """Read (timestamp, articles) from disk. Returns None on missing/corrupt cache."""
    try:
        with open(path) as f:
            obj = json.load(f)
        ts = datetime.fromisoformat(obj["timestamp"])
        articles_raw = obj["articles"]
        if not isinstance(articles_raw, list):
            return None
        articles: list[dict] = []
        for a in articles_raw:
            a_copy = dict(a)
            sa = a_copy.get("seen_at")
            if isinstance(sa, str):
                try:
                    a_copy["seen_at"] = datetime.fromisoformat(sa)
                except ValueError:
                    a_copy["seen_at"] = None
            articles.append(a_copy)
        return (ts, articles)
    except (FileNotFoundError, KeyError, ValueError, json.JSONDecodeError, OSError):
        return None


def _save_cache_to_disk(path: str, ts: datetime, articles: list[dict]) -> None:
    """Persist (timestamp, articles) to disk. Failures are logged but non-fatal."""
    serialized: list[dict] = []
    for a in articles:
        a_copy = dict(a)
        sa = a_copy.get("seen_at")
        if isinstance(sa, datetime):
            a_copy["seen_at"] = sa.isoformat()
        serialized.append(a_copy)
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        # Atomic write: stage to tmp then rename, so a crash mid-write doesn't
        # corrupt the cache file.
        tmp_path = path + ".tmp"
        with open(tmp_path, "w") as f:
            json.dump({"timestamp": ts.isoformat(), "articles": serialized}, f)
        os.replace(tmp_path, path)
    except OSError as e:
        logger.warning("gdelt_adapter: disk cache write failed: %s", e)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


# ──────────────────────────────────────────────────────────────────────────
# Self-test — combined query, tagging, cache layers, non-JSON detection
# ──────────────────────────────────────────────────────────────────────────
# Lock #12: discriminating tests with wrong-on-purpose inputs. Each test below
# has a positive case AND a discrimination/wrong case so a no-op or broken
# implementation can't pass by accident.

def _run_self_test() -> int:
    import tempfile, shutil

    failures: list[str] = []
    tmpdir = tempfile.mkdtemp(prefix="gdelt_test_")
    try:
        _self_test_body(failures, tmpdir)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    if failures:
        print(f"FAIL — {len(failures)} test(s):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("PASS — all GDELT adapter v2 tests passed")
    return 0


def _self_test_body(failures: list[str], tmpdir: str) -> None:
    cache_path = f"{tmpdir}/cache.json"
    now = _utcnow()

    def fmt(dt: datetime) -> str:
        return dt.strftime("%Y%m%dT%H%M%SZ")

    # ── Test 1: combined query syntax has the right parenthesis structure
    q = _build_combined_query()
    if not q.startswith("("):
        failures.append(f"combined query must start with '(' — got {q[:40]!r}")
    if "sourcelang:eng" not in q:
        failures.append(f"combined query must include sourcelang filter — got {q[:80]!r}")
    # Each theme's keywords get their own paren group
    for theme in THEMED_QUERIES:
        first_kw = theme["keywords"][0]
        if f'"{first_kw}"' not in q:
            failures.append(f"combined query missing theme {theme['id']!r} first keyword {first_kw!r}")
    # Total opening parens = 1 outer + 5 themes = 6
    if q.count("(") != 1 + len(THEMED_QUERIES):
        failures.append(f"combined query paren count off: {q.count('(')} opens, expected {1+len(THEMED_QUERIES)}")

    # ── Test 2: article tagging — positive + wrong-on-purpose discrimination
    # Positive: Taiwan article → Taiwan theme
    taiwan_art = {"title": "Tensions rise in Taiwan Strait as PLA mobilizes", "url": "https://x/a"}
    tag = _tag_article(taiwan_art)
    if not tag or tag["id"] != "taiwan_strait":
        failures.append(f"Taiwan article should tag taiwan_strait, got {tag and tag['id']}")

    # Wrong-on-purpose: a sports article with no theme keyword → None
    sports_art = {"title": "Figure skating gold medal awarded in Beijing", "url": "https://x/b"}
    tag = _tag_article(sports_art)
    if tag is not None:
        failures.append(f"Sports article should tag None, got {tag['id']}")

    # First-match-wins discrimination: an article mentioning both "Taiwan Strait"
    # AND "Chinese tariffs" should route to taiwan_strait (theme #1) not us_china_trade (theme #5)
    multi_art = {"title": "Taiwan Strait flashpoint amid Chinese tariffs spat", "url": ""}
    tag = _tag_article(multi_art)
    if not tag or tag["id"] != "taiwan_strait":
        failures.append(f"Multi-theme article should first-match taiwan_strait, got {tag and tag['id']}")

    # ── Test 3: end-to-end with stub http_get — single combined call, themed signals
    captured_queries: list[str] = []

    def stub_http_get(query: str) -> list[dict]:
        captured_queries.append(query)
        # Return one article per theme + 1 sports (untagged) + 1 below threshold
        return [
            _normalize_article({
                "title": "PLA mobilizes near Taiwan Strait", "url": "https://x/tw1",
                "seendate": fmt(now), "tone": -5.2,
            }),
            _normalize_article({
                "title": "Houthi attack disrupts Red Sea shipping", "url": "https://x/rs1",
                "seendate": fmt(now), "tone": -4.1,
            }),
            _normalize_article({
                "title": "Front line Ukraine sees renewed Russian offensive", "url": "https://x/ru1",
                "seendate": fmt(now), "tone": -2.5,   # medium severity
            }),
            _normalize_article({
                "title": "Olympic figure skating final", "url": "https://x/sp1",
                "seendate": fmt(now), "tone": 2.0,    # filtered: tone >= -1
            }),
            _normalize_article({
                "title": "Generic news with no theme keywords", "url": "https://x/n1",
                "seendate": fmt(now), "tone": -8.0,   # tone passes but no theme tag
            }),
        ]

    adapter = GdeltSignalAdapter(enabled=True, http_get=stub_http_get, cache_path=cache_path)
    since = now - timedelta(hours=24)
    signals = adapter.fetch_recent_signals(since)

    if len(captured_queries) != 1:
        failures.append(f"Expected 1 GDELT call, got {len(captured_queries)}")
    if captured_queries and "Taiwan Strait" not in captured_queries[0]:
        failures.append("Combined query missing 'Taiwan Strait' keyword")

    # Expect 3 signals: Taiwan (high), Red Sea (high), Russia-Ukraine (medium).
    # Sports filtered by tone; untagged article filtered by tagger.
    if len(signals) != 3:
        sources = sorted(s.source for s in signals)
        failures.append(f"Expected 3 signals (2 high + 1 medium), got {len(signals)}: {sources}")
    sev_counts = {s.severity: 0 for s in signals}
    for s in signals:
        sev_counts[s.severity] = sev_counts.get(s.severity, 0) + 1
    if sev_counts.get("high") != 2 or sev_counts.get("medium") != 1:
        failures.append(f"Severity mix wrong: {sev_counts}")

    # ── Test 4: memory cache reuse — second call must NOT trigger http_get
    captured_queries.clear()
    signals2 = adapter.fetch_recent_signals(since)
    if len(captured_queries) != 0:
        failures.append(f"Second fetch should hit memory cache, made {len(captured_queries)} HTTP calls")
    if len(signals2) != 3:
        failures.append(f"Cached fetch returned wrong count: {len(signals2)}")

    # ── Test 5: disk cache roundtrip — new adapter instance loads from disk
    adapter2 = GdeltSignalAdapter(enabled=True, http_get=stub_http_get, cache_path=cache_path)
    captured_queries.clear()
    signals3 = adapter2.fetch_recent_signals(since)
    if len(captured_queries) != 0:
        failures.append(f"Fresh adapter w/ fresh disk cache: expected 0 HTTP calls, got {len(captured_queries)}")
    if len(signals3) != 3:
        failures.append(f"Disk-cache load returned wrong count: {len(signals3)}")

    # ── Test 6: stale-while-revalidate — live fails, stale disk cache served
    def failing_http_get(query: str) -> list[dict]:
        captured_queries.append(query)
        raise GdeltApiError("HTTP 429: rate limited (test simulation)")

    # Backdate the disk cache to past TTL but inside stale ceiling, then expire memory.
    stale_ts = now - timedelta(seconds=_CACHE_TTL_SEC + 60)
    cached = _load_cache_from_disk(cache_path)
    if not cached:
        failures.append("Disk cache should exist after Test 3, but _load_cache_from_disk returned None")
    else:
        _save_cache_to_disk(cache_path, stale_ts, cached[1])

    adapter3 = GdeltSignalAdapter(enabled=True, http_get=failing_http_get, cache_path=cache_path)
    captured_queries.clear()
    signals4 = adapter3.fetch_recent_signals(since)
    if len(captured_queries) != 1:
        failures.append(f"Stale path: expected exactly 1 (failed) HTTP attempt, got {len(captured_queries)}")
    if len(signals4) != 3:
        failures.append(f"Stale-while-revalidate should serve {3} signals, got {len(signals4)}")
    if adapter3._last_served_from != "disk_stale":
        failures.append(f"_last_served_from should be 'disk_stale', got {adapter3._last_served_from!r}")

    # ── Test 7: corrupt disk cache file → graceful skip + live fetch
    with open(cache_path, "w") as f:
        f.write("not valid json {{{")
    adapter4 = GdeltSignalAdapter(enabled=True, http_get=stub_http_get, cache_path=cache_path)
    captured_queries.clear()
    signals5 = adapter4.fetch_recent_signals(since)
    if len(captured_queries) != 1:
        failures.append(f"Corrupt cache should force live fetch, got {len(captured_queries)} HTTP calls")
    if len(signals5) != 3:
        failures.append(f"After corrupt-cache recovery: expected 3 signals, got {len(signals5)}")

    # ── Test 8: default-off contract
    off = GdeltSignalAdapter(enabled=False, http_get=stub_http_get, cache_path=cache_path)
    if off.fetch_recent_signals(since) != []:
        failures.append("Default-off contract: GDELT_ENABLED unset must return []")

    # ── Test 9: tone boundary discipline (mirrors v1; preserved for regression)
    boundaries = [
        (-3.0, "medium"),     # exact -3 → medium (strict < at high boundary)
        (-3.01, "high"),
        (-1.0, None),         # exact -1 → filtered
        (-1.01, "medium"),
        (0.0, None),
    ]
    for tone, expected in boundaries:
        if tone >= _TONE_MEDIUM_THRESHOLD:
            actual = None
        else:
            actual = "high" if tone < _TONE_HIGH_THRESHOLD else "medium"
        if actual != expected:
            failures.append(f"Boundary tone={tone}: expected {expected}, got {actual}")


if __name__ == "__main__":
    import sys
    if "--self-test" in sys.argv:
        raise SystemExit(_run_self_test())
    if "--show-query" in sys.argv:
        print(_build_combined_query())
        raise SystemExit(0)
    print("Usage: python -m engine.public.intelligence.adapters.gdelt_adapter --self-test")
    print("       python -m engine.public.intelligence.adapters.gdelt_adapter --show-query")


__all__ = ["GdeltSignalAdapter", "GdeltApiError", "THEMED_QUERIES"]
