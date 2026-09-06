"""Two controls for the public POST surface: a rate-limit SHIELD and an
operator WALL. Which one a route gets is a decision, not a default —
``tests/engine/test_public_post_surface.py`` holds the classification.

SHIELDED (``guard``) — three routes, each of which answered 200 to an
unbounded anonymous POST before it was shielded:

    POST /api/public/companies/{ticker}/refresh   (engine.public.routes)
    POST /api/public/companies/{ticker}/sync      (engine.public.routes)
    POST /api/public/intelligence/refresh-signals (engine.public.intelligence.routes)

WALLED (``require_operator``) — two routes that describe themselves as
operator surfaces and have no caller in this repo outside an ops runbook:

    POST /api/public/intelligence/signals/manual
    POST /api/public/intelligence/refresh-filings-cache

Why the shielded three matter
------------------------------
``/refresh`` and ``/refresh-signals`` fetch nothing themselves and return
no company data. They INVALIDATE caches, so the *next* read is cold
against upstream. ``/sync`` is stronger: it performs the upstream pull
ITSELF (``pipeline.sync_company`` -> ``get_company_envelope`` per
dimension) and spends the adapter's metered daily budget on every call.
The US market is served through SEC EDGAR, whose terms this repo quotes
in ``src/engine/public_market/markets.yaml``: "Current max request rate:
10 requests/second" and "Please declare your user agent". A loop on any
of the three drives the VPS's cold-read rate up until the provider blocks
the host, which takes the whole US market down. That is an availability
risk, not a disclosure risk, and it is the one being closed here.

All three are LIVE public surfaces — ``/refresh`` and ``/sync`` are behind
the user-clicked refresh button on ``PublicCompanyDashboard.tsx`` — so
they get a limit, not a wall. See ``require_operator`` for the routes
where that trade runs the other way.

The shield is IMPORTED, not re-implemented
-------------------------------------------
The token bucket, the daily-salted IP hash and the bounded-memory
eviction all come from ``engine.public_ro.ratelimit`` — the RO
storefront's shield. This module adds no bucket logic of its own; it
supplies a budget, a key, and a bearer bypass.

HOP SEMANTICS — one reader, three modules. This shield keys buckets on
the LAST X-Forwarded-For hop, the only one our own Caddy appended.
``ratelimit._client_ip`` used to read ``hops[0]``, the caller-written
hop, so this module carried a private rightmost copy and a docstring
recording the divergence. That defect was repaired at source on
2026-09-04 (commit f9955d9) — the RO storefront's own shield was
bypassable the same way — so the copy is gone and this delegates.
``test_the_shield_and_the_limiter_read_the_same_hop`` pins that the
shield, the limiter and the funnel agree, so they cannot drift again.

``ratelimit.py`` is deliberately NOT edited here. It is out of this
module's ownership, and its leftmost keying is PINNED by a test this
module does not own — ``tests/engine/test_public_compliance.py::
TestRateLimit::test_xff_preferred_over_socket_peer`` asserts that two
requests differing only in their leftmost hop get SEPARATE buckets, which
is exactly what rightmost keying collapses. So this module keys on the
rightmost hop itself, mirroring ``funnel._client_ip`` semantics, and
``test_public_refresh_shield.py`` asserts the two agree so they cannot
drift apart silently.

Correct for EXACTLY ONE trusted hop, which is what runs today (DNS points
straight at the VPS; responses carry ``via: 1.1 Caddy`` and nothing else).
A CDN in front would invert it — every visitor would collapse into the
edge's bucket. If one is added, index from the right by the number of
trusted hops; do not go back to hops[0].

Budget — derived, not guessed
------------------------------
Busting a cache more often than that cache's own TTL cannot produce
fresher data; it only converts warm reads into cold upstream fan-out. The
TTLs these two routes invalidate, read from the modules that own them:

    universe_service.LIVE_TTL_SECONDS   300 s   (/refresh)
    universe_service._BVB_QUOTES_TTL_S  300 s   (/refresh)
    price_history 1D / 5D / 1M          300 / 900 / 3600 s  (/refresh)
    intelligence RADAR_TTL_SEC          300 s   (/refresh-signals)
    intelligence SCORE_TTL_SEC          180 s   (/refresh-signals)
    intelligence EXPOSURE_TTL_SEC       600 s   (/refresh-signals)
    intelligence SIGNALS_TTL_SEC         60 s   (shortest of any busted)

The shortest TTL any of them invalidates is 60 s, so ONE bust per minute
per client is already the ceiling of usefulness. ``/sync`` has no TTL of
its own — it pulls on demand — but it sits behind the same human-clicked
button, so the same ceiling applies. The budget is set to 5/min — 5x that
ceiling — so a human clicking "refresh", an FE retry and a double-submit
all still succeed, while a loop is stopped. Burst equals the per-minute
rate (one minute's budget), matching the RO storefront's shape.

Env-tunable, named to mirror ``PUBLIC_RO_RATE_PER_MIN`` / ``_BURST``.

ONE BUDGET ACROSS ALL SHIELDED ROUTES, on purpose: a caller's bucket is
keyed by client only, not by (client, route). The resource being protected
— cold upstream reads — is shared between them, so a per-route budget
would simply let a loop alternate between routes for triple the fan-out.
``/sync`` joining the same bucket is the whole point: it is the strongest
amplifier of the three, so it must not get its own separate allowance.

RESIDUAL, measured and NOT closed by this module: one cold universe read
fans out over 203 tickers (``universe.universe_meta()``). The budget bounds
the BUST rate, not that amplification — 5 busts/min still implies a large
cold fan-out. Bounding the fan-out belongs at the provider read path, not
at this route, and is flagged rather than silently claimed as fixed.

ABSENT != ZERO for the token, and the asymmetry is DELIBERATE
--------------------------------------------------------------
``tests/engine/test_cron_auth.py`` requires the four scheduler routes to
FAIL CLOSED (503) when ``ENGINE_API_TOKEN`` is unset. The SHIELDED routes
do the OPPOSITE on purpose: with the token unset the bearer path is simply
unavailable and the anonymous rate-limited path still works. Refusing there
would take down a working public surface to protect a cache; refusing on a
cron prevents mass e-mail and data deletion. Same env var, opposite
default, because the cost of a false refusal is not the same.

``require_operator`` below sits on the OTHER side of that line and fails
closed exactly like the crons — see its own docstring for the per-route
justification. One module holds both because both read the same env var
and parse the same header; a second copy of that parsing is precisely the
mirror-drift hazard CLAUDE.md §14 warns about.

For a SHIELDED route a WRONG bearer is not an error — it is treated as
anonymous and falls through to the limiter. There is no credential to leak
by guessing, and answering 401 would turn this into an oracle for token
probing. A WALLED route has no anonymous path to fall through to, so there
it must answer 401.

Crawler UAs are NOT exempt here, unlike the RO storefront's HTML routes.
``ratelimit.is_exempt_crawler`` is a bare UA substring match; on a POST
cache-bust it would be a one-header bypass of the whole shield. Cheap
cached HTML can afford that trade; a cold-read amplifier cannot.
"""

from __future__ import annotations

import logging
import math
import os
import secrets
import threading
from typing import Any, Optional

from fastapi import HTTPException
from fastapi.responses import JSONResponse

from engine.public_ro.ratelimit import TokenBucketLimiter, hash_ip, _client_ip as ratelimit_client_ip

logger = logging.getLogger(__name__)

# Env knobs, mirroring PUBLIC_RO_RATE_PER_MIN / PUBLIC_RO_RATE_BURST.
_ENV_PER_MIN = "PUBLIC_REFRESH_RATE_PER_MIN"
_ENV_BURST = "PUBLIC_REFRESH_RATE_BURST"

# 5/min = 5x the 60 s shortest busted TTL (SIGNALS_TTL_SEC). See the
# module docstring for the full TTL table this is derived from.
DEFAULT_REFRESH_PER_MIN = 5

_ENV_TOKEN = "ENGINE_API_TOKEN"

_limiter: Optional[TokenBucketLimiter] = None
_limiter_lock = threading.Lock()


def _client_ip_rightmost(request: Any) -> str:
    """The LAST X-Forwarded-For hop, else the socket peer.

    Delegates to ``engine.public_ro.ratelimit._client_ip``. This used to be a
    private copy, because that helper read ``hops[0]`` — the caller-written
    hop — and keying a shield on it makes the shield bypassable by rotating a
    header. That defect was repaired at source on 2026-09-04 (the RO
    storefront's own HTML routes were bypassable the same way), so the copy
    became the mirror-drift hazard CLAUDE.md §14 warns about and is gone.
    ``test_the_shield_and_the_limiter_read_the_same_hop`` pins the agreement.
    """
    return ratelimit_client_ip(request)

def _build_limiter() -> TokenBucketLimiter:
    try:
        per_min = float(os.environ.get(_ENV_PER_MIN, DEFAULT_REFRESH_PER_MIN))
    except (TypeError, ValueError):
        per_min = float(DEFAULT_REFRESH_PER_MIN)
    burst_env = os.environ.get(_ENV_BURST)
    burst = None
    if burst_env:
        try:
            burst = float(burst_env)
        except (TypeError, ValueError):
            burst = None
    if per_min <= 0:
        per_min = float(DEFAULT_REFRESH_PER_MIN)
    # TokenBucketLimiter raises on burst < 1, and it raises at REQUEST time
    # inside get_limiter() — so a burst of 0 or 0.5 turned every shielded
    # route into a hard 500 while a non-numeric value was caught. Clamp
    # instead: a misconfigured budget must never take a working public
    # surface down.
    if burst is not None and burst < 1:
        logger.warning(
            "[refresh-shield] %s=%r is below 1; using the default burst",
            _ENV_BURST, burst_env)
        burst = None
    # ...and the DERIVED burst. TokenBucketLimiter defaults burst to the rate
    # and then raises on burst < 1, at REQUEST time, so a per-minute rate
    # anywhere in (0, 1) took every shielded route to a hard 500 — and 0.5 is
    # exactly what an operator writes to mean "one bust every two minutes".
    # An earlier fix clamped the explicit burst and left this one; the test
    # fixtures always set BURST explicitly, so no test exercised the default
    # path. Clamping here means a misconfigured budget throttles, never 500s.
    if burst is None and per_min < 1:
        logger.warning(
            "[refresh-shield] %s=%r is below 1; the derived burst is clamped "
            "to 1 so the route throttles rather than failing", _ENV_PER_MIN, per_min)
        burst = 1.0
    return TokenBucketLimiter(per_min, burst)


def get_limiter() -> TokenBucketLimiter:
    """Process-wide limiter for the cache-bust routes (lazy; env read once).

    Deliberately its OWN bucket table, not ``ratelimit.get_limiter()``: the
    storefront's 60/min browsing budget is 12x this one, and sharing a table
    would let cheap HTML reads spend the refresh budget.
    """
    global _limiter
    with _limiter_lock:
        if _limiter is None:
            _limiter = _build_limiter()
        return _limiter


def reset_limiter() -> None:
    """Drop the limiter (tests / env re-read)."""
    global _limiter
    with _limiter_lock:
        _limiter = None


def _bearer_of(request: Any) -> str:
    try:
        raw = request.headers.get("authorization") or ""
    except Exception:  # noqa: BLE001
        return ""
    parts = raw.split(None, 1)
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1].strip()
    return ""


def has_operator_bearer(request: Any) -> bool:
    """True iff the caller presented the configured ENGINE_API_TOKEN.

    ABSENT != ZERO: with the token unset this returns False (the bearer path
    is unavailable) rather than raising — the anonymous limited path still
    serves. See the module docstring for why this is the opposite of
    test_cron_auth.py's fail-closed contract.
    """
    expected = os.environ.get(_ENV_TOKEN) or ""
    if not expected:
        return False
    presented = _bearer_of(request)
    if not presented:
        return False
    return secrets.compare_digest(presented, expected)


def require_operator(request: Any, *, route: str) -> None:
    """FAIL-CLOSED operator gate. Returns None or raises; never rate-limits.

    Idiom copied from ``engine.api._org.py``'s purge cron and
    ``engine.public_ro.takedown._require_operator_token``:

        token unset      -> 503 (the deployment cannot authenticate anyone)
        no bearer        -> 401
        wrong bearer     -> 401

    WHY these routes fail closed while ``guard``'s do not
    ------------------------------------------------------
    ``tests/engine/test_cron_auth.py`` states the rule this follows: for a
    route where running unauthenticated is worse than not running at all,
    an unconfigured deployment must refuse. Both walled routes qualify, for
    different reasons:

    ``/intelligence/signals/manual`` WRITES. Measured 2026-09-04 against the
    real ``create_app()``: an anonymous POST with a valid payload returned
    200 and created a macro signal, which the product then serves to users
    through risk-radar, macro-signals and every per-ticker risk score. That
    is content injection, not a cache bust. A rate limit is the wrong
    control for it — a limit still admits one injected signal per window,
    and one is enough, because the damage is durable rather than
    proportional to the call rate.

    ``/intelligence/refresh-filings-cache`` performs the SEC EDGAR request
    itself, synchronously, inside the request handler
    (``filings_refresh.run_refresh`` -> ``_fetch_recent_10k_filings`` ->
    ``urllib.request.urlopen``). A limit would still permit 5 EDGAR hits per
    minute per client, and the budget is per-client — so the ceiling across
    many clients is unbounded, against a host-wide published limit of 10
    req/s whose breach blocks the whole US market.

    The cost of a FALSE REFUSAL is small and was measured, not assumed:
    neither route has a caller in ``frontend/``, ``e2e/``, ``scripts/`` or
    ``deploy/``. The only documented caller is a cron line in
    ``docs/public-intelligence-activation-runbook.md`` — which must now send
    the bearer. That runbook is NOT edited here (out of this lane); it is
    reported as a required operator follow-up, because a wall that silently
    401s a configured cron is a worse failure than the one being fixed.
    """
    expected = os.environ.get(_ENV_TOKEN) or ""
    if not expected:
        raise HTTPException(
            503,
            "ENGINE_API_TOKEN is not configured; refusing to serve the "
            "operator-only route %s on an unconfigured deployment." % route,
        )
    presented = _bearer_of(request)
    if not presented:
        raise HTTPException(401, "Missing Bearer token.")
    if not secrets.compare_digest(presented, expected):
        raise HTTPException(401, "Invalid operator token.")


def guard(request: Any, *, route: str) -> Optional[JSONResponse]:
    """None when the refresh may proceed; a 429 JSONResponse otherwise.

    A valid operator bearer skips the limiter entirely, so an operator can
    always force a refresh. Everything else — including a WRONG bearer —
    spends one token from the caller's bucket.
    """
    if has_operator_bearer(request):
        return None
    key = hash_ip(_client_ip_rightmost(request))
    allowed, retry_after = get_limiter().allow(key)
    if allowed:
        return None
    seconds = max(1, int(math.ceil(retry_after)))
    logger.info("[refresh-shield] 429 on %s (retry_after=%ss)", route, seconds)
    return JSONResponse(
        status_code=429,
        headers={"Retry-After": str(seconds)},
        content={
            "error": {
                "code": "public_refresh_rate_limited",
                "message": (
                    "Refresh NOT performed — too many cache-refresh requests "
                    "from this client. No cache was cleared by this call. "
                    "Retry in %s second(s)." % seconds
                ),
                "details": {
                    "route": route,
                    "retry_after_seconds": seconds,
                    "limit_per_min": get_limiter().rate_per_sec * 60.0,
                    "refreshed": [],
                },
            }
        },
    )


__all__ = [
    "DEFAULT_REFRESH_PER_MIN",
    "get_limiter",
    "guard",
    "has_operator_bearer",
    "require_operator",
    "reset_limiter",
]
