"""Prices slot — honest keyless degradation (fundamentals-only mode).

THE CONTRACT (coordinate here, spine lane):

    price_block(symbol, market, ...) → one of
        dict     — a labeled, provenance-carrying price block
        None     — DESIGNED ABSENCE: keyless mode. The envelope simply
                   has NO price key; the serving layer renders its
                   honest "prices unavailable" state. This None is the
                   fundamentals-only contract, not an error.
        Refusal  — a live provider misbehaved (fail closed). Serving
                   treats it as absence too, but the refusal is
                   loggable and distinguishable from designed absence.

ABSENT != ZERO applies with full force: keyless mode never yields a
placeholder quote, a 0.0, or a promoted mock number. The MockProvider
in providers.py exists for dev surfaces; its output is barred from
this block by the ``live`` capability gate.

DELAY LABELING (PM4 hooks here): every served price carries
{as_of, delay_note}. The delay note comes from the market registry's
license_notes table below; ``is_stale(price, cadence)`` is the
freshness predicate PM4's stale test drives, with explicit budgets and
fail-closed semantics (missing/unparseable as_of, unknown cadence →
stale).

REGISTRY SCOPE: marquee markets (US, DE, GB, FR, IT, ES, AE) plus HU.
Romania is DELIBERATELY absent — BVB is the existing untouched
deterministic feed (public_ro, PM7); this slot must never claim the
home market. The registry here is the engine-side seed; if a spine
lane lands a fuller market registry, ``price_block`` and
``delay_note_for`` accept it via the ``registry`` parameter unchanged
(cross-lane merge point, flagged in the lane report).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Dict, Optional, Union

from engine.public_market._refusal import Refusal, refuse
from engine.public_market.providers import provider_from_env, provider_is_live

PRICES_SOURCE = "public_market.prices"

#: Freshness budgets per cadence. EOD gets 5 calendar days so a Friday
#: close survives the weekend plus a Monday holiday before flagging;
#: intraday budgets are deliberately tight — a "delayed" label with an
#: hours-old timestamp is a lie of freshness.
STALENESS_BUDGETS = {
    "eod": timedelta(days=5),
    "delayed_intraday": timedelta(minutes=90),
    "realtime": timedelta(minutes=15),
}  # type: Dict[str, timedelta]

#: Conservative note for any market the registry does not know: claim
#: nothing about cadence, point at verification.
DEFAULT_DELAY_NOTE = (
    "Delayed data · publication cadence unverified for this market — "
    "confirm freshness with the venue before acting"
)

_EOD_NOTE = "End-of-day close · published after market close, may lag up to 24h"
_LICENSED_EOD = (
    "Prices via licensed provider slot · end-of-day licence · "
    "no redistribution rights"
)

#: Engine-side market registry seed: cadence + delay_note + the
#: license_notes line the delay label is drawn from. Every entry is
#: keyless-honest: today the slot serves NO prices at all (see
#: price_block), so these notes describe what a keyed provider slot
#: is licensed to serve, not a live claim.
MARKET_REGISTRY = {
    "US": {"cadence": "eod", "delay_note": _EOD_NOTE, "license_notes": _LICENSED_EOD},
    "DE": {"cadence": "eod", "delay_note": _EOD_NOTE, "license_notes": _LICENSED_EOD},
    "GB": {"cadence": "eod", "delay_note": _EOD_NOTE, "license_notes": _LICENSED_EOD},
    "FR": {"cadence": "eod", "delay_note": _EOD_NOTE, "license_notes": _LICENSED_EOD},
    "IT": {"cadence": "eod", "delay_note": _EOD_NOTE, "license_notes": _LICENSED_EOD},
    "ES": {"cadence": "eod", "delay_note": _EOD_NOTE, "license_notes": _LICENSED_EOD},
    "AE": {"cadence": "eod", "delay_note": _EOD_NOTE, "license_notes": _LICENSED_EOD},
    "HU": {"cadence": "eod", "delay_note": _EOD_NOTE, "license_notes": _LICENSED_EOD},
    # "RO" intentionally not present — public_ro/BVB owns the home
    # market (PM7). Tested.
}  # type: Dict[str, Dict[str, str]]


def delay_note_for(market, registry=None):
    # type: (str, Optional[Dict[str, Dict[str, str]]]) -> str
    table = registry if registry is not None else MARKET_REGISTRY
    entry = table.get(market)
    if entry is None:
        return DEFAULT_DELAY_NOTE
    return entry["delay_note"]


def _cadence_for(market, registry=None):
    # type: (str, Optional[Dict[str, Dict[str, str]]]) -> str
    table = registry if registry is not None else MARKET_REGISTRY
    entry = table.get(market)
    if entry is None:
        return "eod"  # conservative default cadence for staleness math
    return entry["cadence"]


def _parse_when(stamp):
    # type: (str) -> datetime
    """ISO date or datetime → aware UTC datetime. Date-only stamps
    (EOD closes) are read as END of that day — a close dated today is
    fresh all day. 'Z' suffix accepted (3.9 fromisoformat can't)."""
    if not isinstance(stamp, str) or not stamp:
        raise ValueError("empty timestamp")
    normalized = stamp.replace("Z", "+00:00") if stamp.endswith("Z") else stamp
    moment = datetime.fromisoformat(normalized)
    if len(stamp) == 10:  # date-only: YYYY-MM-DD
        moment = moment + timedelta(days=1) - timedelta(seconds=1)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment


def is_stale(price, cadence, now=None):
    # type: (Dict[str, object], str, Optional[Union[str, datetime]]) -> bool
    """PM4's freshness predicate. FAIL CLOSED: anything that prevents
    an honest freshness verdict (missing as_of, unparseable stamp,
    unknown cadence) IS stale — a price we cannot date must never be
    served as fresh."""
    budget = STALENESS_BUDGETS.get(cadence)
    if budget is None:
        return True
    as_of = price.get("as_of") if isinstance(price, dict) else None
    try:
        as_of_moment = _parse_when(as_of)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return True
    if now is None:
        now_moment = datetime.now(timezone.utc)
    elif isinstance(now, datetime):
        now_moment = now if now.tzinfo is not None else now.replace(tzinfo=timezone.utc)
    else:
        now_moment = _parse_when(now)
    return (now_moment - as_of_moment) > budget


def label_quote(quote, market, registry=None, now=None):
    # type: (Dict[str, object], str, Optional[Dict[str, Dict[str, str]]], Optional[Union[str, datetime]]) -> Union[Dict[str, object], Refusal]
    """Attach the delay label a served price must carry. A quote
    without as_of cannot be labeled and is refused — an unlabeled
    price is exactly the freshness lie this slot exists to prevent."""
    as_of = quote.get("as_of")
    if not isinstance(as_of, str) or not as_of:
        return refuse(
            "price_missing_as_of",
            "quote has no as_of — cannot label freshness",
            PRICES_SOURCE,
        )
    cadence = _cadence_for(market, registry)
    labeled = dict(quote)
    labeled["market"] = market
    labeled["cadence"] = cadence
    labeled["delay_note"] = delay_note_for(market, registry)
    labeled["stale"] = is_stale(quote, cadence, now=now)
    return labeled


def price_block(symbol, market, env=None, provider=None, registry=None, now=None):
    # type: (str, str, Optional[Dict[str, str]], Optional[object], Optional[Dict[str, Dict[str, str]]], Optional[Union[str, datetime]]) -> Union[Dict[str, object], Refusal, None]
    """The envelope's price block for one listed company — or its
    honest absence.

    Keyless (no live provider): returns None. The caller OMITS the
    price key from the envelope entirely — never writes null-like
    placeholders — and serving shows "prices unavailable". This is
    fundamentals-only mode, the shipping default in zero-owner mode.
    """
    if provider is None:
        provider = provider_from_env(env)
    if not provider_is_live(provider):
        # Designed absence. Explicitly NOT a refusal: nothing failed,
        # the platform simply has no price licence today.
        return None
    quote = provider.eod_price(symbol)
    if isinstance(quote, Refusal):
        return quote
    if not isinstance(quote, dict):
        return refuse(
            "price_provider_shape",
            "live provider returned a non-dict quote",
            PRICES_SOURCE,
        )
    return label_quote(quote, market, registry=registry, now=now)
