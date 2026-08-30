# -*- coding: utf-8 -*-
"""The market registry — load + validate ``markets.yaml``, and be the ONE
place in ``engine.public_market`` that knows a market id.

Why a registry at all
---------------------
A ``if market_id == "us": ... elif market_id == "de": ...`` ladder is how
a nine-market wave becomes unshippable: every new market edits every
module, and the day one branch is forgotten the surface silently serves
the wrong currency / the wrong licence line / a figure for a market that
has no feed. So market knowledge lives in DATA (markets.yaml), is read
through this module, and the N7-style guard in
``tests/engine/test_public_market_spine.py`` fails the build on any
quoted market id or ``market_id ==`` comparison anywhere else in the
package.

Ordering law (PM)
-----------------
Romania is its OWN group and comes first. Then the marquee, in the
declared order US, DE, UK, FR, IT, ES, CN, AE (``marquee_rank``). Then
everything else A→Z by display name. ``ordered_markets()`` is the one
implementation; no caller re-sorts.

Fail loud
---------
A malformed or missing registry raises :class:`RegistryError`. There is
deliberately no "sensible default market" fallback: a guessed market id
would attach the wrong currency and the wrong licence to a real number.

Python 3.9: no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

import os
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import yaml

#: Registry file schema tag (bump on shape changes, with a migration note).
SCHEMA = "public_market_registry_v1"

#: Env override for the registry file (ops + tests).
PATH_ENV = "PUBLIC_MARKET_MARKETS_PATH"

#: The closed status vocabulary. See markets.yaml's header for what each
#: one PROMISES — the promise is the point, not the label.
STATUS_LIVE = "live"
STATUS_FUNDAMENTALS_ONLY = "fundamentals_only"
STATUS_AWAITING_PROVIDER = "awaiting_provider"
STATUSES = (STATUS_LIVE, STATUS_FUNDAMENTALS_ONLY, STATUS_AWAITING_PROVIDER)

#: Closed vocabulary for how often the FUNDAMENTALS side refreshes.
#: ``none`` is honest for a market with no feed — not "unknown".
REFRESH_CADENCES = ("on_filing", "annual_dataset", "none")

#: Sentinel used by ``fundamentals_source`` / ``price_source`` for "there
#: is no source". A string, not null, so the field is never ambiguous
#: between "absent from the file" and "declared to have none".
SOURCE_NONE = "none"

#: The single home-market group. Romania is not a marquee entry with
#: rank 0 by accident — it is a separate group that always leads, and
#: ``ordered_markets`` keeps it that way even if the marquee is re-ranked.
HOME_GROUP = "romania"
MARQUEE_GROUP = "marquee"
REST_GROUP = "rest"

_REQUIRED_FIELDS = (
    "market_id",
    "display_name",
    "exchanges",
    "currency",
    "accounting_standard",
    "price_source",
    "fundamentals_source",
    "refresh_cadence",
    "license_notes",
    "marquee_rank",
    "status",
)

#: Optional per-entry field: the honest paragraph about what this market
#: can and cannot do today. Optional because a future entry may have
#: nothing to qualify; present on every entry shipped so far.
_OPTIONAL_FIELDS = ("coverage_note",)


class RegistryError(RuntimeError):
    """markets.yaml is missing, unreadable, or fails validation."""


class UnknownMarket(KeyError):
    """A market id that is not in the registry. Never resolved to a
    default — an unknown market has no currency and no licence, and
    inventing either is how a wrong number gets a confident label."""


@dataclass(frozen=True)
class Market:
    """One registry row. Frozen: callers read, never patch."""

    market_id: str
    display_name: str
    exchanges: Tuple[str, ...]
    currency: str
    accounting_standard: str
    price_source: str
    fundamentals_source: str
    refresh_cadence: str
    license_notes: str
    marquee_rank: Optional[int]
    status: str
    coverage_note: Optional[str] = None

    # ── status helpers (the only sanctioned way to branch) ──────────

    @property
    def is_home(self) -> bool:
        """True for the home market — its own group, always first."""
        return self.marquee_rank == 0

    @property
    def is_marquee(self) -> bool:
        return self.marquee_rank is not None and self.marquee_rank > 0

    @property
    def is_live(self) -> bool:
        """A ticker goes in and a deterministic figure comes out."""
        return self.status == STATUS_LIVE

    @property
    def is_fundamentals_only(self) -> bool:
        """Figures exist in a feed; the market is not addressable by
        ticker yet. The company route refuses, naming the gap."""
        return self.status == STATUS_FUNDAMENTALS_ONLY

    @property
    def is_awaiting_provider(self) -> bool:
        """No feed at all. The card exists so the gap is visible."""
        return self.status == STATUS_AWAITING_PROVIDER

    @property
    def has_fundamentals_source(self) -> bool:
        return self.fundamentals_source != SOURCE_NONE

    @property
    def group(self) -> str:
        if self.is_home:
            return HOME_GROUP
        if self.is_marquee:
            return MARQUEE_GROUP
        return REST_GROUP

    def to_dict(self) -> Dict[str, Any]:
        """Serialization view — the exact shape the API and the FE read.
        Sorted-key stable by construction (dict literal order is the
        declared field order; JSON serializers sort where it matters)."""
        return {
            "market_id": self.market_id,
            "display_name": self.display_name,
            "exchanges": list(self.exchanges),
            "currency": self.currency,
            "accounting_standard": self.accounting_standard,
            "price_source": self.price_source,
            "fundamentals_source": self.fundamentals_source,
            "refresh_cadence": self.refresh_cadence,
            "license_notes": self.license_notes,
            "marquee_rank": self.marquee_rank,
            "status": self.status,
            "coverage_note": self.coverage_note,
            "group": self.group,
        }


# ── file resolution + cache ─────────────────────────────────────────

_LOCK = threading.Lock()
_CACHE: Dict[str, Tuple[Market, ...]] = {}


def default_path() -> Path:
    """The packaged registry file (next to this module)."""
    return Path(__file__).resolve().with_name("markets.yaml")


def _resolve_path(path: Optional[Any] = None) -> Path:
    if path is not None:
        return Path(path)
    env = os.environ.get(PATH_ENV)
    if env:
        return Path(env)
    return default_path()


def reset_cache() -> None:
    """Drop the parsed-registry cache (tests / ops after an edit)."""
    with _LOCK:
        _CACHE.clear()


# ── validation ──────────────────────────────────────────────────────


def _fail(path: Path, message: str) -> None:
    raise RegistryError("market registry %s: %s" % (path, message))


def _require_str(path: Path, market_id: str, row: Dict[str, Any], key: str) -> str:
    value = row.get(key)
    if not isinstance(value, str) or not value.strip():
        _fail(path, "market %r needs a non-empty string %r (got %r)"
              % (market_id, key, value))
    return value.strip()


def _validate_row(path: Path, row: Any, seen_ids: Dict[str, int],
                  seen_ranks: Dict[int, str], index: int) -> Market:
    if not isinstance(row, dict):
        _fail(path, "markets[%d] must be a mapping, got %s"
              % (index, type(row).__name__))
    unknown = set(row) - set(_REQUIRED_FIELDS) - set(_OPTIONAL_FIELDS)
    if unknown:
        _fail(path, "markets[%d] has unknown field(s): %s"
              % (index, ", ".join(sorted(unknown))))
    missing = [f for f in _REQUIRED_FIELDS if f not in row]
    if missing:
        _fail(path, "markets[%d] is missing field(s): %s"
              % (index, ", ".join(missing)))

    market_id = row.get("market_id")
    if not isinstance(market_id, str) or not market_id.strip():
        _fail(path, "markets[%d] needs a non-empty string market_id" % index)
    market_id = market_id.strip()
    if market_id != market_id.lower():
        _fail(path, "market %r must be lower-case (ids are URL path segments)"
              % market_id)
    if market_id in seen_ids:
        _fail(path, "duplicate market_id %r (also at markets[%d])"
              % (market_id, seen_ids[market_id]))
    seen_ids[market_id] = index

    display_name = _require_str(path, market_id, row, "display_name")
    currency = _require_str(path, market_id, row, "currency")
    if currency != currency.upper() or len(currency) != 3:
        _fail(path, "market %r currency must be a 3-letter ISO 4217 code "
                    "(got %r)" % (market_id, currency))
    accounting_standard = _require_str(path, market_id, row, "accounting_standard")
    price_source = _require_str(path, market_id, row, "price_source")
    fundamentals_source = _require_str(path, market_id, row, "fundamentals_source")
    license_notes = " ".join(
        _require_str(path, market_id, row, "license_notes").split()
    )

    exchanges = row.get("exchanges")
    if not isinstance(exchanges, list) or not exchanges:
        _fail(path, "market %r needs a non-empty exchanges list" % market_id)
    for item in exchanges:
        if not isinstance(item, str) or not item.strip():
            _fail(path, "market %r has a non-string exchange entry %r"
                  % (market_id, item))

    refresh_cadence = _require_str(path, market_id, row, "refresh_cadence")
    if refresh_cadence not in REFRESH_CADENCES:
        _fail(path, "market %r refresh_cadence %r not in %s"
              % (market_id, refresh_cadence, list(REFRESH_CADENCES)))

    status = _require_str(path, market_id, row, "status")
    if status not in STATUSES:
        _fail(path, "market %r status %r not in %s"
              % (market_id, status, list(STATUSES)))

    # THE HONESTY INVARIANT, enforced at load: a market cannot claim to
    # produce figures without naming the feed that produces them. This is
    # the one rule that stops "live" from becoming decoration.
    if status in (STATUS_LIVE, STATUS_FUNDAMENTALS_ONLY) \
            and fundamentals_source == SOURCE_NONE:
        _fail(path, "market %r claims status %r with fundamentals_source "
                    "'none' — a market with no feed cannot claim figures"
              % (market_id, status))
    if status == STATUS_AWAITING_PROVIDER and fundamentals_source != SOURCE_NONE:
        _fail(path, "market %r is awaiting_provider but names a "
                    "fundamentals_source %r — say which it is"
              % (market_id, fundamentals_source))
    if status == STATUS_AWAITING_PROVIDER and refresh_cadence != "none":
        _fail(path, "market %r is awaiting_provider but declares a refresh "
                    "cadence %r — nothing refreshes" % (market_id, refresh_cadence))

    rank = row.get("marquee_rank")
    if rank is not None:
        if isinstance(rank, bool) or not isinstance(rank, int) or rank < 0:
            _fail(path, "market %r marquee_rank must be null or an int >= 0 "
                        "(got %r)" % (market_id, rank))
        if rank in seen_ranks:
            _fail(path, "market %r reuses marquee_rank %d (held by %r)"
                  % (market_id, rank, seen_ranks[rank]))
        seen_ranks[rank] = market_id

    coverage_note = row.get("coverage_note")
    if coverage_note is not None:
        if not isinstance(coverage_note, str) or not coverage_note.strip():
            _fail(path, "market %r coverage_note must be a non-empty string "
                        "when present" % market_id)
        coverage_note = " ".join(coverage_note.split())

    return Market(
        market_id=market_id,
        display_name=display_name,
        exchanges=tuple(e.strip() for e in exchanges),
        currency=currency,
        accounting_standard=accounting_standard,
        price_source=price_source,
        fundamentals_source=fundamentals_source,
        refresh_cadence=refresh_cadence,
        license_notes=license_notes,
        marquee_rank=rank,
        status=status,
        coverage_note=coverage_note,
    )


def _validate(path: Path, raw: Any) -> Tuple[Market, ...]:
    if not isinstance(raw, dict):
        _fail(path, "top level must be a mapping")
    if raw.get("schema") != SCHEMA:
        _fail(path, "schema must be %r (got %r)" % (SCHEMA, raw.get("schema")))
    rows = raw.get("markets")
    if not isinstance(rows, list) or not rows:
        _fail(path, "'markets' must be a non-empty list")
    seen_ids: Dict[str, int] = {}
    seen_ranks: Dict[int, str] = {}
    markets = [
        _validate_row(path, row, seen_ids, seen_ranks, index)
        for index, row in enumerate(rows)
    ]
    homes = [m for m in markets if m.is_home]
    if len(homes) != 1:
        _fail(path, "exactly one market must carry marquee_rank 0 (the home "
                    "market, its own group); found %d" % len(homes))
    return tuple(markets)


# ── loading ─────────────────────────────────────────────────────────


def load_markets(path: Optional[Any] = None) -> Tuple[Market, ...]:
    """Parsed + validated registry rows, in FILE order (not display
    order — use :func:`ordered_markets` for that). Cached per resolved
    path; :func:`reset_cache` drops it."""
    resolved = _resolve_path(path)
    key = str(resolved)
    cached = _CACHE.get(key)
    if cached is not None:
        return cached
    with _LOCK:
        cached = _CACHE.get(key)
        if cached is not None:
            return cached
        try:
            text = resolved.read_text(encoding="utf-8")
        except OSError as exc:
            raise RegistryError("market registry %s unreadable: %s" % (resolved, exc))
        try:
            raw = yaml.safe_load(text)
        except yaml.YAMLError as exc:
            raise RegistryError("market registry %s is not valid YAML: %s"
                                % (resolved, exc))
        markets = _validate(resolved, raw)
        _CACHE[key] = markets
        return markets


# ── accessors ───────────────────────────────────────────────────────


def _order_key(market: Market) -> Tuple[int, int, str]:
    """Romania first (its own group), then the marquee by declared rank,
    then everything else A→Z by display name."""
    if market.is_home:
        return (0, 0, market.display_name)
    if market.is_marquee:
        return (1, market.marquee_rank or 0, market.display_name)
    return (2, 0, market.display_name)


def ordered_markets(path: Optional[Any] = None) -> List[Market]:
    """THE display order. One implementation; callers never re-sort."""
    return sorted(load_markets(path), key=_order_key)


def market_ids(path: Optional[Any] = None) -> Tuple[str, ...]:
    """Every known market id, in display order."""
    return tuple(m.market_id for m in ordered_markets(path))


def get_market(market_id: Any, path: Optional[Any] = None) -> Market:
    """Look one market up. Raises :class:`UnknownMarket` — never guesses."""
    key = str(market_id or "").strip().lower()
    for market in load_markets(path):
        if market.market_id == key:
            return market
    raise UnknownMarket(
        "unknown market %r (known: %s)" % (market_id, ", ".join(market_ids(path)))
    )


def find_market(market_id: Any, path: Optional[Any] = None) -> Optional[Market]:
    """:func:`get_market` that returns None instead of raising — for call
    sites that render a 404 rather than a 500."""
    try:
        return get_market(market_id, path)
    except UnknownMarket:
        return None


def status_of(market_id: Any, path: Optional[Any] = None) -> str:
    return get_market(market_id, path).status


def markets_by_status(status: str, path: Optional[Any] = None) -> List[Market]:
    if status not in STATUSES:
        raise RegistryError("unknown status %r (known: %s)"
                            % (status, ", ".join(STATUSES)))
    return [m for m in ordered_markets(path) if m.status == status]


def home_market(path: Optional[Any] = None) -> Market:
    """The one market whose group is its own — validated at load."""
    for market in load_markets(path):
        if market.is_home:
            return market
    raise RegistryError("registry has no home market")  # pragma: no cover


def marquee_markets(path: Optional[Any] = None) -> List[Market]:
    """The marquee, in declared rank order (home market excluded — it is
    a separate group, not marquee position zero)."""
    return [m for m in ordered_markets(path) if m.is_marquee]


def market_for_source(source: Any, path: Optional[Any] = None) -> Optional[Market]:
    """Reverse lookup: which market does this ``fundamentals_source``
    belong to?

    Returns the Market only when the answer is UNAMBIGUOUS. One source
    that feeds several markets (filings.xbrl.org feeds UK/FR/IT/ES)
    returns None — the caller must be told which market it is holding,
    never have one picked for it. This exists so no other module needs a
    ``if source == ...: market_id = ...`` table of its own.
    """
    key = str(source or "").strip()
    if not key or key == SOURCE_NONE:
        return None
    matches = [m for m in load_markets(path) if m.fundamentals_source == key]
    if len(matches) == 1:
        return matches[0]
    return None


def registry_payload(path: Optional[Any] = None) -> Dict[str, Any]:
    """The API body for ``GET /api/public/markets`` — the registry with
    status, in display order, plus the group boundaries the FE renders
    (Romania first, then marquee, then the rest)."""
    markets = ordered_markets(path)
    return {
        "schema": SCHEMA,
        "groups": [HOME_GROUP, MARQUEE_GROUP, REST_GROUP],
        "statuses": list(STATUSES),
        "markets": [m.to_dict() for m in markets],
        "counts": {
            status: len([m for m in markets if m.status == status])
            for status in STATUSES
        },
    }
