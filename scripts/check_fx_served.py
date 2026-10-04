#!/usr/bin/env python3
"""check_fx_served — what exchange rate is the SERVING process answering?

A read-only post-deploy check, REQUIRED after every backend switch
(CLAUDE.md §14). It reads a RUNNING engine over HTTP:

    # inside the new backend (the engine listens on :8000 there)
    docker exec cfo-ai-backend python3 /app/scripts/check_fx_served.py

    # the same reading through the public origin (Caddy), from anywhere
    python3 scripts/check_fx_served.py https://<the public origin>

The one argument is the engine's base URL; the default is
``http://localhost:8000``.

HOW IT DIFFERS FROM ``check_fx_live.py`` — they answer two questions and a
deploy needs both:

  · ``check_fx_live.py`` IMPORTS the engine and calls
    ``get_fx_rates(force_refresh=True)`` in ITS OWN process. It proves the
    code that was shipped and the container's egress to BNR, on that call.
    It does not read, and does not warm, the memo of the process that
    answers requests — it is green while the serving process, which failed
    its own fetch a minute earlier, is still inside its five-minute failure
    cooldown answering the bundled fallback.
  · ``check_fx_served.py`` (this file) imports nothing of the engine and
    asks the serving process itself: ``GET /api/fx-rates``, exactly what a
    browser is handed. It cannot say WHY a rate is not current (no egress?
    cooldown? a frozen file?) — that is the other check's job.

WHY IT EXISTS (review of fix/fx-bnr-feed, 2026-10-03). Whether the VPS can
read ``curs.bnr.ro`` was not known before the first deploy of the new
address: every reading had been taken from a laptop, and the previous engine
only ever asked ``www.bnr.ro``. And the deploy lane's last line could not
show it: it prints ``health ok True LIVE`` on a healthy deploy AND while the
engine serves the bundled fallback or a last-known rate (measured, both
outage shapes: HTTP 200, ``ok: true`` — a BNR outage is deliberately a
warning on ``/api/health``, gates.md "fx-feed", decision D4e).

WHAT IT DOES. Two GETs to the base URL given, nothing else; no query string
(``?refresh=true`` is the operator bearer's and is not used), no write:

  1. ``GET <base>/api/fx-rates`` — the payload. On a cold process this
     request is also what makes the engine ask BNR, so it is given 30 s.
  2. ``GET <base>/api/health`` — printed as ONE line that carries what the
     lane's line lacks: ``checks.fx_rates`` ok / source / stale / as_of.
     Informational: the verdict is the payload of step 1.

EXIT 0 only when the served payload is a current BNR rate — the three
conditions of ``check_fx_live.judge`` (ONE definition): ``source`` is
``BNR``, ``stale`` is false, ``as_of`` is at most 10 days before today and
not after it. Otherwise 1. (2: the argument is not a base URL.)

FX-SERVED RED IS NOT A ROLLBACK. It means the ENGINE is not handing readers
a current rate. A browser on this release then shows the newest-dated stale
figure it can get, MARKED STALE (frontend/lib/rates.ts) — never one
presented as current — and keeps asking, once per five minutes while the tab
is visible, until a source answers a current rate. The previous build is no
better at reaching BNR (it read a dead address), so rolling back restores
nothing. Run ``check_fx_live.py`` inside the container next: GREEN there
means the container reaches BNR and the serving process is inside its
five-minute failure cooldown (run this check again after it); RED there
names what the container cannot read.

Gate: fx-feed (tests/engine/test_fx_bnr_feed.py drives ``main`` against the
REAL app behind a loopback socket: healthy 0; the fallback, a last-known
rate, a frozen file, a non-JSON answer, an unreachable base 1 — and the
health line of each outage differs from the healthy one).
"""

from __future__ import annotations

import datetime as _dt
import importlib.util
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

DEFAULT_BASE_URL = "http://localhost:8000"
TIMEOUT_SECONDS = 30
_MAX_BODY_BYTES = 256 * 1024

NOT_A_ROLLBACK = (
    "  THIS IS NOT A ROLLBACK. The engine is not handing readers a current rate: a browser on\n"
    "  this release shows the newest-dated stale figure it can get, MARKED STALE, and asks again\n"
    "  once per five minutes while its tab is visible. The previous build read a dead address —\n"
    "  rolling back restores nothing.\n"
    "  NEXT: docker exec cfo-ai-backend python3 /app/scripts/check_fx_live.py\n"
    "    GREEN there: the container reaches BNR; the serving process is inside its five-minute\n"
    "    failure cooldown — run this check again after it.\n"
    "    RED there: it names what the container cannot read (egress to curs.bnr.ro)."
)

#: Printed instead when the route did not answer a payload at all: nothing
#: was read, so this check says nothing about the rate — and a paragraph
#: about rollbacks would be advice on a question nobody asked.
NO_ANSWER = (
    "  NOTHING WAS READ: GET /api/fx-rates did not answer a payload, so this check says nothing\n"
    "  about the exchange rate. What failed is the engine or the ingress in front of it — read\n"
    "  the boot probe and GET /api/health first (CLAUDE.md section 14, steps 3 and 6)."
)


def _judge():
    """``judge`` of check_fx_live.py — ONE definition of 'a current BNR rate'."""
    path = Path(__file__).resolve().with_name("check_fx_live.py")
    spec = importlib.util.spec_from_file_location("check_fx_live", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod.judge


def _today_ro() -> _dt.date:
    """The latest calendar date it can be in Romania right now (UTC+3) — the
    engine's own rule (engine.api.fx_rates._today_ro), restated because this
    script imports nothing of the engine. Tests replace it."""
    return (_dt.datetime.now(_dt.timezone.utc) + _dt.timedelta(hours=3)).date()


def _get(url: str) -> Tuple[Optional[int], Any]:
    """One GET. (status, parsed JSON) — a 4xx/5xx body is still read, because
    ``/api/health`` answers 503 WITH its checks. (None, reason) when nothing
    answered; (status, reason) when the body is not JSON."""
    req = urllib.request.Request(url, headers={"Accept": "application/json",
                                               "User-Agent": "cfo-ai-check-fx-served/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
            status, raw = resp.status, resp.read(_MAX_BODY_BYTES)
    except urllib.error.HTTPError as exc:
        status, raw = exc.code, exc.read(_MAX_BODY_BYTES)
    except Exception as exc:  # noqa: BLE001 — unreachable is a reading, not a crash
        return None, "%s: %s" % (type(exc).__name__, str(exc)[:160])
    try:
        return status, json.loads(raw.decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        return status, "not JSON (%s)" % type(exc).__name__


def health_line(status: Optional[int], body: Any) -> str:
    """The lane's health line, with what it lacked. ``health ok True LIVE`` is
    kept as its first words so the two can be compared by eye."""
    if not isinstance(body, dict):
        return "health UNREADABLE (HTTP %s: %s)" % (status, body)
    fx = (body.get("checks") or {}).get("fx_rates")
    if not isinstance(fx, dict):
        fx_part = "fx_rates ABSENT from checks"
    else:
        fx_part = "fx_rates ok %s source %s stale %s as_of %s" % (
            fx.get("ok"), fx.get("source"), fx.get("stale"), fx.get("as_of"))
    cached = " (memo, %ss old)" % body.get("cache_age_s") if body.get("cached") else ""
    return "health ok %s %s | HTTP %s | %s%s" % (body.get("ok"), body.get("mode"), status, fx_part, cached)


def main(argv: Optional[List[str]] = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) > 1:
        print("check_fx_served: one argument at most — the engine's base URL (default %s)" % DEFAULT_BASE_URL)
        return 2
    base = (args[0] if args else DEFAULT_BASE_URL).rstrip("/")
    if not base.startswith(("https://", "http://")) or "?" in base or "#" in base:
        print("check_fx_served: the base URL must start with https:// or http:// and carry no "
              "query — got %r" % base)
        return 2
    judge = _judge()
    today = _today_ro()

    print("check_fx_served: %s   (today in Romania: %s)" % (base, today.isoformat()))
    fx_status, payload = _get(base + "/api/fx-rates")
    problems: List[str] = []
    if fx_status != 200 or not isinstance(payload, dict):
        print("  GET /api/fx-rates  HTTP %s  %s" % (fx_status, payload if not isinstance(payload, dict) else ""))
        problems.append("GET /api/fx-rates did not answer a payload (HTTP %s)" % fx_status)
    else:
        rates: Dict[str, Any] = payload.get("rates") if isinstance(payload.get("rates"), dict) else {}
        ron, usd = rates.get("RON"), rates.get("USD")
        numbers = all(isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0 for v in (ron, usd))
        per_usd = ("%.4f" % (ron / usd)) if numbers else "?"
        print("  GET /api/fx-rates  source %s  stale %s  as_of %s  RON per EUR %s  RON per USD %s  fetched_at %s"
              % (payload.get("source"), payload.get("stale"), payload.get("as_of"), ron, per_usd,
                 payload.get("fetched_at")))
        problems.extend(judge(payload, today))
        if not numbers:
            problems.append("the payload carries no usable RON / USD rate: %r" % (payload.get("rates"),))

    health_status, health = _get(base + "/api/health")
    print("  GET /api/health    %s" % health_line(health_status, health))

    if problems:
        answered = fx_status == 200 and isinstance(payload, dict)
        if answered:
            print("FX-SERVED RED — the serving process is NOT answering a current BNR rate:")
        else:
            print("FX-SERVED RED — the serving process did not answer GET /api/fx-rates:")
        for p in problems:
            print("  - %s" % p)
        # The rollback paragraph is about a payload that was read and judged
        # not current. With no payload there is nothing it could be about.
        print(NOT_A_ROLLBACK if answered else NO_ANSWER)
        return 1
    print("FX-SERVED GREEN — the serving process answers BNR's file of %s" % payload.get("as_of"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
