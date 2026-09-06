"""FX rates endpoint — backend proxy to BNR (Banca Națională a României).

Why a backend proxy:
  - bnr.ro doesn't send CORS headers, so direct browser fetch fails
  - We can cache server-side once + serve many users from one upstream call
  - We can swap data sources (BNR → ECB → fallback) without touching the FE

Endpoint: GET /api/fx-rates
Response shape:
  {
    "base": "EUR",                             # rates are X units per 1 EUR
    "rates": { "RON": 4.97, "EUR": 1.0, "USD": 1.08 },
    "source": "BNR" | "fallback",
    "as_of": "2026-05-23",                      # date the upstream published these
    "fetched_at": "2026-05-23T15:32:11Z",       # when we last refreshed cache
    "stale": false                               # true if served from fallback
  }

Cache: process-local dict, 24h TTL. Single-tenant VPS so no need for Redis.
"""
from __future__ import annotations

import datetime as _dt
import logging
import threading
import urllib.request
import xml.etree.ElementTree as ET
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


# ── Bundled fallback rates (last-known good as of 2026-05) ──
# Used when BNR is unreachable AND no cached fetch is available. Bundled
# directly so the app NEVER renders garbage. Update when these drift
# materially from market reality (>5%).
_FALLBACK_RATES: Dict[str, float] = {
    "EUR": 1.00,    # base
    "RON": 4.97,    # 1 EUR ≈ 4.97 RON (matches lib/currency.ts FX_RON_TO_EUR)
    "USD": 1.08,    # 1 EUR ≈ 1.08 USD
}
_FALLBACK_AS_OF = "2026-05-01"

_BNR_URL = "https://www.bnr.ro/nbrfxrates.xml"
_TTL_SECONDS = 24 * 3600   # daily refresh
_TIMEOUT_SECONDS = 8       # don't block the request handler on BNR

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
# `force_refresh=True` (the operator's `?refresh=true`) ignores it, so
# the cooldown can never make the manual retry a no-op.
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


def _parse_bnr_xml(xml_bytes: bytes) -> Dict[str, Any]:
    """Parse BNR's nbrfxrates.xml format.

    Document shape:
      <DataSet>
        <Header><PublishingDate>2026-05-22</PublishingDate></Header>
        <Body>
          <Subject>Reference rates for major currencies</Subject>
          <OrigCurrency>RON</OrigCurrency>
          <Cube date="2026-05-22">
            <Rate currency="EUR">4.9712</Rate>
            <Rate currency="USD">4.5876</Rate>
            ...
          </Cube>
        </Body>
      </DataSet>

    BNR publishes "1 EUR = X RON" style (RON is the origin/quote currency).
    We invert to our normalised "X units per 1 EUR" base.
    """
    # BNR XML uses a default namespace; strip it for simpler XPath.
    ns_re = b'xmlns="http://www.bnr.ro/xsd"'
    cleaned = xml_bytes.replace(ns_re, b"")
    root = ET.fromstring(cleaned)

    body = root.find("Body")
    if body is None:
        raise ValueError("BNR XML missing Body")
    cube = body.find("Cube")
    if cube is None:
        raise ValueError("BNR XML missing Cube")

    as_of = cube.get("date") or _FALLBACK_AS_OF
    # Per-currency rates: how many RON one unit of <currency> equals.
    bnr_rates: Dict[str, float] = {}
    for rate_el in cube.findall("Rate"):
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
    rates_eur_base: Dict[str, float] = {
        "EUR": 1.0,
        "RON": one_eur_in_ron,
        "USD": one_eur_in_ron / one_usd_in_ron,
    }
    return {
        "base": "EUR",
        "rates": rates_eur_base,
        "source": "BNR",
        "as_of": as_of,
    }


def _fetch_bnr_rates() -> Dict[str, Any]:
    """Network-fetch + parse BNR. Raises on any failure (caller handles
    fallback to cached or bundled)."""
    req = urllib.request.Request(
        _BNR_URL,
        headers={"User-Agent": "cfo-ai/1.0 (+https://cfo-ai.io)"},
    )
    with urllib.request.urlopen(req, timeout=_TIMEOUT_SECONDS) as resp:
        if resp.status != 200:
            raise RuntimeError(f"BNR HTTP {resp.status}")
        body = resp.read()
    return _parse_bnr_xml(body)


def get_fx_rates(force_refresh: bool = False) -> Dict[str, Any]:
    """Return the current FX rates payload.

    Cache strategy:
      - 24h TTL on the cached BNR fetch
      - If BNR fetch fails AND we have ANY cached payload (even stale), return cached + stale=False
      - If no cache exists at all, return bundled fallback with stale=True

    Always returns a valid payload; never raises. The `stale=True` flag
    is the FE's signal to render a "rates from <date>" indicator.
    """
    import time
    now = time.time()
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
