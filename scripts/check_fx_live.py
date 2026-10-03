#!/usr/bin/env python3
"""check_fx_live — is THIS engine reading BNR's reference-rate feed right now?

A read-only post-deploy check. Run it inside the new backend after the switch
(CLAUDE.md §14):

    docker exec cfo-ai-backend python3 /app/scripts/check_fx_live.py

WHY IT EXISTS. On 2026-10-03 production was found serving the bundled
fallback rate from ``GET /api/fx-rates`` — BNR had moved the feed, the old
address answered a web page, the fallback was served marked stale, and
``/api/health`` said ``fx_rates: ok``. No deploy gate asked the one question
that would have shown it: what does the engine serve when it asks BNR now?

WHAT IT DOES. Calls the engine's own ``get_fx_rates(force_refresh=True)`` —
one GET per BNR address (``engine.api.fx_rates._BNR_URLS``) and nothing else.
It writes nothing: no file, no database row, no cache outside this process.

EXIT 0 only when ALL hold; otherwise 1, naming what failed:
  · ``source`` is ``BNR``           (not the bundled fallback)
  · ``stale`` is false              (the feed answered on this call)
  · ``as_of`` is a date at most ``MAX_AGE_DAYS`` (10) days before today and
    not after it                    (the address is not answering a frozen file)

It prints the figures either way, so the operator reads the rate that is
being served and its date, not only a verdict.

What it cannot see: the Supabase Edge Function ``fx-rates`` (the browser's
first source — probe it with the command in docs/engine_book/gates.md,
"fx-browser"), and what a browser holding an old cached payload shows.
Gate: fx-feed (tests/engine/test_fx_bnr_feed.py drives ``main`` over a wired
feed: healthy 0; dead, stale, frozen, future-dated 1).
"""

from __future__ import annotations

import datetime as _dt
import sys
from pathlib import Path
from typing import List, Optional

MAX_AGE_DAYS = 10


def _import_engine():
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "pyproject.toml").exists() and (parent / "src").is_dir():
            sys.path.insert(0, str(parent / "src"))
            break
    from engine.api import fx_rates  # noqa: WPS433 — after the path is set

    return fx_rates


def judge(payload: dict, today: _dt.date) -> List[str]:
    """Every reason this payload is not a current BNR rate. Empty = pass."""
    problems: List[str] = []
    source = payload.get("source")
    if source != "BNR":
        problems.append("source is %r, not 'BNR' — the feed did not answer and "
                        "the bundled fallback is being served" % (source,))
    if payload.get("stale") is not False:
        problems.append("stale is %r — the answer is not a rate accepted on this call"
                        % (payload.get("stale"),))
    as_of = payload.get("as_of")
    try:
        published = _dt.date.fromisoformat(str(as_of))
    except ValueError:
        problems.append("as_of is %r — not a date" % (as_of,))
        return problems
    if published > today:
        problems.append("as_of %s is after today (%s)" % (as_of, today.isoformat()))
    elif (today - published).days > MAX_AGE_DAYS:
        problems.append("as_of %s is %d days old (limit %d) — the address answers "
                        "a file that stopped updating"
                        % (as_of, (today - published).days, MAX_AGE_DAYS))
    return problems


def main(argv: Optional[List[str]] = None) -> int:
    fx_rates = _import_engine()
    payload = fx_rates.get_fx_rates(force_refresh=True)
    today = fx_rates._today_ro()
    rates = payload.get("rates") or {}
    ron, usd = rates.get("RON"), rates.get("USD")
    print("check_fx_live: addresses asked, in order: %s" % ", ".join(fx_rates._BNR_URLS))
    print("  source      %s" % payload.get("source"))
    print("  stale       %s" % payload.get("stale"))
    print("  as_of       %s   (today in Romania: %s)" % (payload.get("as_of"), today.isoformat()))
    print("  fetched_at  %s" % payload.get("fetched_at"))
    print("  RON per EUR %s" % ron)
    print("  USD per EUR %s" % usd)
    if isinstance(ron, (int, float)) and isinstance(usd, (int, float)) and usd:
        print("  RON per USD %.4f" % (ron / usd))
    problems = judge(payload, today)
    if problems:
        print("FX-LIVE RED — the engine is NOT serving a current BNR rate:")
        for p in problems:
            print("  - %s" % p)
        return 1
    print("FX-LIVE GREEN — BNR's file of %s, read on this call" % payload.get("as_of"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
