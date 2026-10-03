"""FX rates endpoint — backend proxy to BNR (Banca Națională a României).

Why a backend proxy:
  - bnr.ro doesn't send CORS headers, so direct browser fetch fails
  - We can cache server-side once + serve many users from one upstream call
  - We can swap data sources (BNR → ECB → fallback) without touching the FE

Endpoint: GET /api/fx-rates
Response shape:
  {
    "base": "EUR",                             # rates are X units per 1 EUR
    "rates": { "RON": 5.3447, "EUR": 1.0, "USD": 1.1248 },
    "source": "BNR" | "fallback",
    "as_of": "2026-10-02",                      # date the upstream published these
    "fetched_at": "2026-10-03T06:32:11+00:00",  # when we last refreshed cache
    "stale": false                               # true = NOT a current BNR rate
  }

`stale` is true whenever the answer is not a BNR file accepted inside the
24 h window: the bundled fallback, or the last accepted file after a refetch
failed. A reader of this endpoint must never present a stale payload as
current.

WHO READS THIS (2026-10-03). The browser's display-currency rates come from
the Supabase Edge Function `fx-rates` (supabase/functions/fx-rates), not from
here; since the same date `frontend/lib/rates.ts` asks this endpoint as well
whenever the function's answer is stale and uses the fresher of the two. The
engine itself converts with it in the EUR/USD briefing regeneration, and
`/api/health` reports it (`checks.fx_rates`).

Cache: process-local dict, 24h TTL. Single-tenant VPS so no need for Redis.
"""
from __future__ import annotations

import datetime as _dt
import logging
import re
import threading
import time
import urllib.request
import xml.etree.ElementTree as ET
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


# ── Bundled fallback rates (BNR's file of 2026-10-02) ──
# Used when BNR is unreachable AND no accepted fetch is cached. Always served
# with `stale: true`. THREE LIVE COPIES, kept equal: this one,
# supabase/functions/fx-rates/bnr.ts (FALLBACK_RATES / FALLBACK_AS_OF) and
# frontend/lib/rates.ts (FALLBACK_RATES / FALLBACK_PAYLOAD). Update all three
# when they drift more than 5% from BNR's rate — the gate fx-feed holds this
# copy within 5% of the committed feed file, and fx-browser holds the other
# two equal to it.
_FALLBACK_RATES: Dict[str, float] = {
    "EUR": 1.00,               # base
    "RON": 5.3447,             # 1 EUR = 5.3447 RON
    "USD": 5.3447 / 4.7519,    # 1 EUR = 1.12475 USD (BNR: 1 USD = 4.7519 RON)
}
_FALLBACK_AS_OF = "2026-10-02"

# WHERE THE FEED LIVES. Until 2026 it was https://www.bnr.ro/nbrfxrates.xml
# with the default namespace http://www.bnr.ro/xsd. BNR moved it: measured
# 2026-10-03, the old address answers a redirect to an HTML page (200,
# text/html once followed) and the feed is at https://curs.bnr.ro/ with the
# namespace https://www.bnr.ro/xsd. Nothing failed loudly — the HTML did not
# parse and the answer fell back, marked `stale: true`.
#
# TWO FACTS, measured on production 2026-10-03, and they are not the same:
#   · THIS endpoint served the bundled fallback — 4.97 RON per EUR as of
#     2026-05-01 while BNR published 5.3447 (7.5% high on EUR amounts). That
#     reached GET /api/fx-rates, /api/health and the EUR/USD briefing
#     regeneration ONLY.
#   · What a READER saw in the browser came from the Edge Function, which
#     asked the same dead address and served its last cached row, marked
#     stale: 5.2489 RON per EUR as of 2026-08-05 — for two months. EUR
#     amounts 1.8% too high (5.3447 / 5.2489), USD amounts 4.5% too high
#     (4.548 RON per USD served against 4.7519).
#
# Every address is a candidate: a 200 that is not the feed is a failure, not
# an answer, and so is a feed whose Cube date is missing, unparseable, in the
# future or more than `_MAX_AGE_DAYS` old. Among the addresses that answer an
# acceptable feed the NEWEST Cube date wins (the first listed on a tie); an
# address that answers today's file ends the search, because nothing newer
# can exist.
# Gate: fx-feed (tests/engine/test_fx_bnr_feed.py, on the feed's real bytes).
_BNR_URLS = (
    "https://curs.bnr.ro/nbrfxrates.xml",
    "https://www.bnr.ro/nbrfxrates.xml",
)
_BNR_URL = _BNR_URLS[0]

# A parsed rate outside these bounds is refused (the fallback, marked stale,
# is served instead): a feed that changes its quoting convention — a
# multiplier, an inverted pair — must not become a silently wrong amount.
# RON per 1 EUR has been between 4.4 and 5.4 since 2015; USD per 1 EUR
# between 0.95 and 1.25.
_PLAUSIBLE_RON_PER_EUR = (3.0, 10.0)
_PLAUSIBLE_USD_PER_EUR = (0.5, 2.0)

_TTL_SECONDS = 24 * 3600   # daily refresh
_TIMEOUT_SECONDS = 8       # don't block the request handler on BNR

# FRESHNESS. BNR publishes once per business day; the longest gap between two
# files is a holiday bridge of five or six days. A Cube older than ten days
# is an address that keeps answering a file that stopped updating — the
# likeliest next failure after a move — and is refused like a web page.
_MAX_AGE_DAYS = 10

# THE BODY. The feed is under 2 KB. Anything over 64 KB is not the feed, and
# a body that declares a DOCTYPE or an ENTITY is refused before it reaches
# the XML parser (entity expansion: 637 bytes became 30 MB on expat 2.2.8).
_MAX_BODY_BYTES = 64 * 1024
_DECLARATION = re.compile(r"<!\s*(?:DOCTYPE|ENTITY)", re.IGNORECASE)
_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# A FAILURE IS CACHED TOO. `GET /api/fx-rates` is anonymous and so is
# `/api/health` (which reads this module). Before 2026-09-05 only the
# SUCCESS path was memoised: with bnr.ro unreachable, every anonymous hit
# opened a fresh connection and blocked a worker for the full
# `_TIMEOUT_SECONDS`, so N anonymous requests were N outbound fetches and
# 8N worker-seconds — a self-inflicted amplifier that fires exactly when
# the upstream is already unwell.
#
# 300 s, not the 24 h success TTL: a success is good for a day because
# BNR publishes once a day, but a failure is a transient we want to leave
# behind quickly. Five minutes bounds the retry rate at 12/hour no matter
# how much traffic arrives, and delays recovery by at most one window.
# `force_refresh=True` ignores it, so the cooldown can never make the manual
# retry a no-op — and `GET /api/fx-rates?refresh=true` passes it ONLY for a
# caller holding the operator bearer (pipeline.py): an anonymous
# `?refresh=true` is answered exactly like the plain route.
_FAILURE_COOLDOWN_SECONDS = 300

_CACHE_LOCK = threading.Lock()
_CACHE: Dict[str, Any] = {
    "payload": None,
    "fetched_at": 0.0,
    "failed_at": 0.0,
}


def reset_fx_cache() -> None:
    """Drop both memos — the payload and the failure cooldown. Tests only."""
    with _CACHE_LOCK:
        _CACHE["payload"] = None
        _CACHE["fetched_at"] = 0.0
        _CACHE["failed_at"] = 0.0


def _now() -> float:
    """Epoch seconds. The two memos read the clock here; tests replace it."""
    return time.time()


def _today_ro() -> _dt.date:
    """The latest calendar date it can be in Romania right now (UTC+3, the
    summer offset — no tz database needed). The freshness rule reads the
    clock here and nowhere else; tests replace it."""
    return (_dt.datetime.now(_dt.timezone.utc) + _dt.timedelta(hours=3)).date()


def _local(tag: Any) -> str:
    """An element's local name, whatever namespace it is written in."""
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def _cube_date(cube: ET.Element) -> Optional[str]:
    """The Cube's date as YYYY-MM-DD, or None when missing or not a date."""
    raw = (cube.get("date") or "").strip()
    if not _ISO_DATE.match(raw):
        return None
    try:
        _dt.date.fromisoformat(raw)
    except ValueError:
        return None
    return raw


def _parse_bnr_xml(xml_bytes: bytes) -> Dict[str, Any]:
    """Parse BNR's nbrfxrates.xml format.

    Document shape:
      <DataSet xmlns="https://www.bnr.ro/xsd" ...>
        <Header><PublishingDate>2026-10-02</PublishingDate></Header>
        <Body>
          <Subject>Reference rates</Subject>
          <OrigCurrency>RON</OrigCurrency>
          <Cube date="2026-10-02">
            <Rate currency="EUR">5.3447</Rate>
            <Rate currency="USD">4.7519</Rate>
            ...
          </Cube>
        </Body>
      </DataSet>

    BNR publishes "1 EUR = X RON" style (RON is the origin/quote currency).
    We invert to our normalised "X units per 1 EUR" base.

    Raises on anything that is not the feed: a body over 64 KB, one that is
    not UTF-8, one that declares a DOCTYPE or an ENTITY, a document with no
    Body / dated Cube / EUR / USD, a rate outside the plausible range. The
    clock is NOT read here — ``_require_fresh`` judges the date.
    """
    if len(xml_bytes) > _MAX_BODY_BYTES:
        raise ValueError("BNR body is %d bytes (over %d) — not the feed"
                         % (len(xml_bytes), _MAX_BODY_BYTES))
    # Decoded here and handed to the parser as text, so the encoding the
    # parser reads is the one the DOCTYPE/ENTITY scan read (a declared
    # single-byte codec cannot hide a declaration from the scan).
    text = xml_bytes.decode("utf-8-sig")
    if _DECLARATION.search(text):
        raise ValueError("BNR body declares a DOCTYPE or an ENTITY — not the feed")
    root = ET.fromstring(text)

    # Elements are matched by LOCAL name: the default namespace was
    # http://www.bnr.ro/xsd until 2026, is https://www.bnr.ro/xsd since the
    # feed moved, and the file's own schemaLocation already says curs.bnr.ro.
    body = next((el for el in root if _local(el.tag) == "Body"), None)
    if body is None:
        raise ValueError("BNR XML missing Body")
    cubes = [el for el in body if _local(el.tag) == "Cube"]
    if not cubes:
        raise ValueError("BNR XML missing Cube")
    dated = [(d, c) for d, c in ((_cube_date(c), c) for c in cubes) if d]
    if not dated:
        raise ValueError("BNR XML carries no Cube with a date (YYYY-MM-DD)")
    # More than one Cube (the ten-day file): the newest date is the rate.
    as_of, cube = max(dated, key=lambda pair: pair[0])

    # Per-currency rates: how many RON one unit of <currency> equals.
    bnr_rates: Dict[str, float] = {}
    for rate_el in cube:
        if _local(rate_el.tag) != "Rate":
            continue
        cur = rate_el.get("currency")
        if not cur:
            continue
        try:
            v = float((rate_el.text or "").strip())
        except (TypeError, ValueError):
            continue
        # BNR sometimes publishes "100 HUF = X RON" via a multiplier attr;
        # divide by multiplier when present (HUF, JPY, KRW typical).
        mult_attr = rate_el.get("multiplier")
        if mult_attr:
            try:
                v = v / float(mult_attr)
            except (TypeError, ValueError):
                pass
        bnr_rates[cur] = v

    if "EUR" not in bnr_rates:
        raise ValueError("BNR XML missing EUR rate")
    if "USD" not in bnr_rates:
        raise ValueError("BNR XML missing USD rate")

    # Normalise to "X units per 1 EUR" (EUR-based) so the FE has a single
    # consistent base. RON = bnr_rates["EUR"]; USD = bnr_rates["EUR"] / bnr_rates["USD"].
    one_eur_in_ron = bnr_rates["EUR"]
    one_usd_in_ron = bnr_rates["USD"]
    if one_usd_in_ron <= 0:
        raise ValueError("BNR XML carries a non-positive USD rate")
    rates_eur_base: Dict[str, float] = {
        "EUR": 1.0,
        "RON": one_eur_in_ron,
        "USD": one_eur_in_ron / one_usd_in_ron,
    }
    for _cur, (_lo, _hi) in (("RON", _PLAUSIBLE_RON_PER_EUR), ("USD", _PLAUSIBLE_USD_PER_EUR)):
        if not (_lo < rates_eur_base[_cur] < _hi):
            raise ValueError(
                "BNR rate outside the plausible range: %s per 1 EUR = %r (expected %s..%s)"
                % (_cur, rates_eur_base[_cur], _lo, _hi))
    return {
        "base": "EUR",
        "rates": rates_eur_base,
        "source": "BNR",
        "as_of": as_of,
    }


def _require_fresh(as_of: str, today: _dt.date) -> None:
    """Raise unless ``as_of`` is a date not after ``today`` and at most
    ``_MAX_AGE_DAYS`` before it."""
    published = _dt.date.fromisoformat(as_of)
    if published > today:
        raise ValueError("BNR Cube is dated %s, after today (%s)" % (as_of, today.isoformat()))
    age = (today - published).days
    if age > _MAX_AGE_DAYS:
        raise ValueError("BNR Cube is dated %s — %d days old (limit %d): the address "
                         "answers a file that stopped updating" % (as_of, age, _MAX_AGE_DAYS))


def _read_address(url: str) -> Dict[str, Any]:
    """One address: fetch (bounded), parse. Raises on any failure."""
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "cfo-ai/1.0 (+https://cfo-ai.io)"},
    )
    with urllib.request.urlopen(req, timeout=_TIMEOUT_SECONDS) as resp:
        if resp.status != 200:
            raise RuntimeError(f"BNR HTTP {resp.status}")
        body = resp.read(_MAX_BODY_BYTES + 1)
    return _parse_bnr_xml(body)


def _fetch_bnr_rates() -> Dict[str, Any]:
    """Network-fetch + parse BNR. Raises on any failure (caller handles
    fallback to cached or bundled).

    Every address is asked in order; one that does not answer an acceptable
    feed is a failure and the next is tried. Among those that do, the newest
    Cube date wins (the first listed on a tie). An address that answers
    TODAY's file ends the search — nothing newer can exist."""
    today = _today_ro()
    best: Optional[Dict[str, Any]] = None
    problems = []
    for url in _BNR_URLS:
        try:
            got = _read_address(url)
            _require_fresh(got["as_of"], today)
        except Exception as exc:  # noqa: BLE001 — the next address is the handler
            problems.append("%s: %s" % (url, exc))
            continue
        if best is None or got["as_of"] > best["as_of"]:
            best = got
        if best["as_of"] >= today.isoformat():
            break
    if best is None:
        raise RuntimeError("; ".join(problems))
    return best


def get_fx_rates(force_refresh: bool = False) -> Dict[str, Any]:
    """Return the current FX rates payload.

    Cache strategy:
      - 24h TTL on the accepted BNR fetch — served with stale=False
      - If the refetch fails AND an accepted payload is cached (however old),
        return it with stale=True
      - If nothing is cached at all, return the bundled fallback with stale=True
      - A failure is memoised for `_FAILURE_COOLDOWN_SECONDS`

    Always returns a valid payload; never raises. `stale=True` means "this is
    not a current BNR rate" — every reader must carry it through.
    """
    now = _now()
    with _CACHE_LOCK:
        cached = _CACHE.get("payload")
        cached_at = _CACHE.get("fetched_at") or 0
        if (
            not force_refresh
            and cached is not None
            and (now - cached_at) < _TTL_SECONDS
        ):
            return {**cached, "fetched_at": _iso_from_epoch(cached_at), "stale": False}

    # Either cache miss or TTL elapsed; try BNR — unless a recent attempt
    # already failed and we are inside the cooldown, in which case the
    # answer is the same one it would produce and costs nothing.
    with _CACHE_LOCK:
        failed_at = _CACHE.get("failed_at") or 0.0
    in_cooldown = (not force_refresh) and (now - failed_at) < _FAILURE_COOLDOWN_SECONDS

    if not in_cooldown:
        try:
            fresh = _fetch_bnr_rates()
            with _CACHE_LOCK:
                _CACHE["payload"] = fresh
                _CACHE["fetched_at"] = now
                _CACHE["failed_at"] = 0.0
            return {**fresh, "fetched_at": _iso_from_epoch(now), "stale": False}
        except Exception as e:  # noqa: BLE001
            with _CACHE_LOCK:
                _CACHE["failed_at"] = now
            logger.warning("[fx_rates] BNR fetch failed (%s); falling back "
                           "and not retrying for %ss", e, _FAILURE_COOLDOWN_SECONDS)

    # BNR failed. Return last-known cache if we have one (marked stale).
    with _CACHE_LOCK:
        cached = _CACHE.get("payload")
        cached_at = _CACHE.get("fetched_at") or 0
    if cached is not None:
        return {**cached, "fetched_at": _iso_from_epoch(cached_at), "stale": True}

    # Nothing cached either. Bundled fallback.
    return {
        "base": "EUR",
        "rates": dict(_FALLBACK_RATES),
        "source": "fallback",
        "as_of": _FALLBACK_AS_OF,
        "fetched_at": _iso_from_epoch(now),
        "stale": True,
    }


def _iso_from_epoch(epoch: float) -> str:
    return _dt.datetime.fromtimestamp(epoch, tz=_dt.timezone.utc).isoformat(timespec="seconds")
