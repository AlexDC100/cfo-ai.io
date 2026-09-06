"""Token-bucket rate limiting for the public RO HTML routes.

Contract (consumed by lane 3's page routes):

    from engine.public_ro import ratelimit
    resp = ratelimit.check(request)
    if resp is not None:
        return resp          # a 429 Response with Retry-After
    ... render the page ...

Design points (wave architecture decisions):

  - Generous defaults: 60 requests/min browsing budget per client, burst
    equal to one minute's budget. Env-tunable via PUBLIC_RO_RATE_PER_MIN
    and PUBLIC_RO_RATE_BURST (read when the default limiter is built).
  - Known crawler user agents are EXEMPT by UA substring match
    (googlebot / bingbot / yandex / duckduckbot). This is string matching
    only — reverse-DNS verification of crawler IPs (the way Google
    documents distinguishing real Googlebot from spoofers) is noted as
    FUTURE WORK for this wave; a spoofed crawler UA currently bypasses
    the limiter, which is acceptable for a politeness limiter guarding
    cheap cached HTML.
  - Privacy: buckets are keyed by a DAILY-SALTED hash of the client IP —
    no raw IP is ever stored (wave personal-data rule). The salt rotates
    with the UTC date, so a key cannot be correlated across days.
  - IN-PROCESS ONLY: state is a plain dict guarded by a Lock. This is
    correct for the current single cfo-ai-backend container;
    HORIZONTAL-SCALE CAVEAT: with N replicas each holds its own buckets,
    so the effective limit becomes N× the configured rate — moving to a
    shared store (or sticky routing) is required before scaling out.
  - Bounded memory: at most _MAX_KEYS buckets are retained; the stalest
    half is evicted when the cap is hit.
"""

from __future__ import annotations

import hashlib
import math
import os
import secrets
import threading
import time
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Optional, Tuple

from fastapi.responses import PlainTextResponse

# UA substrings (lowercase) exempted from rate limiting. DNS verification
# of the caller is future work — see module docstring.
CRAWLER_UA_SUBSTRINGS = ("googlebot", "bingbot", "yandex", "duckduckbot")

_ENV_PER_MIN = "PUBLIC_RO_RATE_PER_MIN"
_ENV_BURST = "PUBLIC_RO_RATE_BURST"
_DEFAULT_PER_MIN = 60

_MAX_KEYS = 50_000

# Per-process secret for the daily IP-hash salt (no raw IPs stored).
_PROCESS_SECRET = secrets.token_hex(16)


def _client_ip(request: Any) -> str:
    """The LAST X-Forwarded-For hop, else the socket peer.

    Rightmost, not leftmost. Caddy fronts this backend with a bare
    ``reverse_proxy`` (no ``trusted_proxies``), which APPENDS the real peer
    to whatever the caller already put in the header — so index 0 is always
    attacker-written and only the final entry was added by our proxy.
    Reading from the left let one caller mint a fresh bucket per request by
    rotating the header, i.e. the shield was bypassable by anyone who
    noticed. ``funnel._client_ip`` was fixed this way (D2); this module was
    never back-ported, and CLAUDE.md §21 described the fixed behaviour as
    though it applied here. Gate: the hop tests in
    tests/engine/test_public_compliance.py.

    Correct for EXACTLY ONE trusted hop, which is what runs today: DNS
    points straight at the VPS (cfo-ai.io -> 187.124.0.37) and responses
    carry ``via: 1.1 Caddy`` and nothing else, verified 2026-09-04. A CDN in
    front would INVERT this — the last hop would be the CDN edge, every
    visitor would collapse into one bucket, and the limiter would throttle
    the world instead of an abuser. If one is ever added, index from the
    right by the number of trusted hops.

    Duck-typed so tests can pass a stub.
    """
    try:
        xff = request.headers.get("x-forwarded-for")
    except Exception:
        xff = None
    if xff:
        hops = [h.strip() for h in xff.split(",") if h.strip()]
        if hops:
            return hops[-1]
    client = getattr(request, "client", None)
    host = getattr(client, "host", None)
    return host or "unknown"


def _user_agent(request: Any) -> str:
    try:
        return (request.headers.get("user-agent") or "").lower()
    except Exception:
        return ""


def hash_ip(ip: str, *, day: Optional[str] = None) -> str:
    """Daily-salted, truncated SHA-256 of the client IP. The raw IP never
    enters the bucket table; the salt rotates with the UTC date."""
    if day is None:
        day = datetime.now(timezone.utc).date().isoformat()
    digest = hashlib.sha256(
        ("%s|%s|%s" % (_PROCESS_SECRET, day, ip)).encode("utf-8")
    ).hexdigest()
    return digest[:16]


def is_exempt_crawler(user_agent: str) -> bool:
    ua = (user_agent or "").lower()
    return any(marker in ua for marker in CRAWLER_UA_SUBSTRINGS)


class TokenBucketLimiter:
    """Classic token bucket per hashed-IP key.

    ``clock`` is injectable (monotonic seconds) so tests can drive time
    deterministically.
    """

    def __init__(
        self,
        rate_per_min: float = _DEFAULT_PER_MIN,
        burst: Optional[float] = None,
        *,
        clock: Callable[[], float] = time.monotonic,
        max_keys: int = _MAX_KEYS,
    ) -> None:
        if rate_per_min <= 0:
            raise ValueError("rate_per_min must be > 0")
        self.rate_per_sec = rate_per_min / 60.0
        self.burst = float(burst if burst is not None else rate_per_min)
        if self.burst < 1:
            raise ValueError("burst must be >= 1")
        self._clock = clock
        self._max_keys = max_keys
        self._lock = threading.Lock()
        # key -> (tokens, last_refill_ts)
        self._buckets: Dict[str, Tuple[float, float]] = {}

    def allow(self, key: str) -> Tuple[bool, float]:
        """Consume one token for ``key``. Returns (allowed, retry_after_s)."""
        now = self._clock()
        with self._lock:
            tokens, last = self._buckets.get(key, (self.burst, now))
            tokens = min(self.burst, tokens + (now - last) * self.rate_per_sec)
            if tokens >= 1.0:
                self._buckets[key] = (tokens - 1.0, now)
                self._maybe_evict()
                return True, 0.0
            retry_after = (1.0 - tokens) / self.rate_per_sec
            self._buckets[key] = (tokens, now)
            self._maybe_evict()
            return False, retry_after

    def _maybe_evict(self) -> None:
        # Called under self._lock. Bound memory by dropping the stalest half.
        if len(self._buckets) <= self._max_keys:
            return
        by_age = sorted(self._buckets.items(), key=lambda kv: kv[1][1])
        for key, _ in by_age[: len(by_age) // 2]:
            del self._buckets[key]

    def check(self, request: Any) -> Optional[PlainTextResponse]:
        """None when the request may proceed; a 429 response otherwise.
        Crawler UAs are exempt (string match — DNS verify is future work)."""
        if is_exempt_crawler(_user_agent(request)):
            return None
        key = hash_ip(_client_ip(request))
        allowed, retry_after = self.allow(key)
        if allowed:
            return None
        return PlainTextResponse(
            "Too many requests. Please slow down and retry shortly.\n",
            status_code=429,
            headers={"Retry-After": str(max(1, math.ceil(retry_after)))},
        )


_default_limiter: Optional[TokenBucketLimiter] = None
_default_lock = threading.Lock()


def _build_default() -> TokenBucketLimiter:
    per_min = float(os.environ.get(_ENV_PER_MIN, _DEFAULT_PER_MIN))
    burst_env = os.environ.get(_ENV_BURST)
    burst = float(burst_env) if burst_env else None
    return TokenBucketLimiter(per_min, burst)


def get_limiter() -> TokenBucketLimiter:
    """Process-wide default limiter (lazy; env read once at build)."""
    global _default_limiter
    with _default_lock:
        if _default_limiter is None:
            _default_limiter = _build_default()
        return _default_limiter


def reset_limiter() -> None:
    """Drop the default limiter (tests / env re-read)."""
    global _default_limiter
    with _default_lock:
        _default_limiter = None


def check(request: Any) -> Optional[PlainTextResponse]:
    """Module-level contract entry point for lane 3's HTML routes."""
    return get_limiter().check(request)
