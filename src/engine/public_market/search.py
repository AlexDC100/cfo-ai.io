# -*- coding: utf-8 -*-
"""Cross-market SEARCH for the public_market document class.

One box, every market: a name, a ticker, an ISIN, a LEI or a CIK goes
in, and matching companies come back GROUPED BY MARKET in the registry's
display order — Romania first (as its own group), then the declared
marquee order, then the rest.

WHAT IS SEARCHED, AND WHAT THAT MEANS
-------------------------------------
The corpus is the UNIVERSE (``universe.py``'s seed files) plus whatever
the spine store already holds. Both are IDENTITY. A hit therefore means
"this company exists in this market and here is how to address it" — it
does **not** mean we hold its numbers. Every hit says which of the two
it is via ``held``:

    held: true   a pm1 document is cached; the company route serves it
    held: false  we know the company, we hold no document for it yet

Conflating those two is how a search box turns into a promise the
serving layer cannot keep. A market's own status rides along in the
group header, so a hit inside a ``fundamentals_only`` market reads as
"figures exist, ticker lookup does not" rather than as a dead link.

COVERAGE IS PART OF THE ANSWER
------------------------------
Zero results is ambiguous — it can mean "no such company" or "we never
looked there". Every response therefore carries a ``coverage`` block
naming, per market, how many members were actually searched and why a
market contributed nothing. An empty universe is a DECLARED gap with a
written reason, never a silent one.

ON-DEMAND RESOLUTION
--------------------
An unknown ticker in the one ticker-addressable market can be resolved
live (ticker → CIK → companyfacts → pm1 → store), which is what makes a
company retrievable from the company route afterwards. That path is
**off by default on the web surface** (``PUBLIC_MARKET_ONDEMAND_RESOLVE``):
a public search box that can trigger an outbound SEC request per
keystroke is a fair-access violation waiting for traffic, and the
serving-side law is that a web request reads the store. Operators call
:func:`resolve_on_demand` directly — through ``scripts/public_market_seed.py
resolve`` — to warm the cache deliberately, rate-limited and journaled.
When the gate IS on, the response says so per resolution, so nobody has
to guess whether an answer came from cache or from the feed.

Python 3.9: no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

from fastapi.responses import JSONResponse  # module scope: the handlers' return annotation must resolve for /openapi.json

import logging
import os
import re
import threading
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

from engine.public_market import registry as _registry
from engine.public_market import universe as _universe

logger = logging.getLogger("engine.public_market.search")

#: Route prefix — fully qualified, per the aggregate router's contract.
PREFIX = "/api/public/markets"

#: Env gate for live resolution on the WEB surface. Absent/0 == off.
ONDEMAND_ENV = "PUBLIC_MARKET_ONDEMAND_RESOLVE"

#: Query bounds. A long query is a paste accident, not a search.
MAX_QUERY_LEN = 128
MIN_QUERY_LEN = 1
DEFAULT_LIMIT_PER_MARKET = 10
MAX_LIMIT_PER_MARKET = 50

#: Match kinds, ranked. Lower rank wins; the kind travels in the
#: response so a surface can explain WHY a row matched.
MATCH_KEY = "identifier_exact"
MATCH_TICKER = "ticker_exact"
MATCH_NAME = "name_exact"
MATCH_TICKER_PREFIX = "ticker_prefix"
MATCH_NAME_PREFIX = "name_prefix"
MATCH_NAME_CONTAINS = "name_contains"

_RANKS = {
    MATCH_KEY: 0,
    MATCH_TICKER: 1,
    MATCH_NAME: 2,
    MATCH_TICKER_PREFIX: 3,
    MATCH_NAME_PREFIX: 4,
    MATCH_NAME_CONTAINS: 5,
}

#: A plausible exchange ticker. Deliberately narrow: on-demand
#: resolution must never fire on a free-text name query.
_TICKER_RE = re.compile(r"^[A-Z][A-Z0-9.\-]{0,9}$")

SEARCH_CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=3600"
ERROR_CACHE_CONTROL = "public, max-age=300"

CODE_EMPTY_QUERY = "EMPTY_QUERY"
CODE_QUERY_TOO_LONG = "QUERY_TOO_LONG"
CODE_ONDEMAND_DISABLED = "ONDEMAND_DISABLED"
CODE_NOT_TICKER_SHAPED = "NOT_TICKER_SHAPED"
CODE_NO_RESOLVABLE_MARKET = "NO_RESOLVABLE_MARKET"
CODE_TICKER_UNKNOWN = "TICKER_UNKNOWN"


# ── the searchable index (built once, per seed generation) ──────────


@dataclass(frozen=True)
class IndexEntry:
    """One searchable identity. Immutable; the index is rebuilt, never
    patched, so a stale row cannot survive a seed change."""

    market_id: str
    name: str
    normalized_name: str
    #: EVERY listed share class of this issuer. Alphabet is one company
    #: with two tickers; indexing only the first makes GOOGL
    #: unsearchable, which is precisely what happened before this was a
    #: tuple.
    tickers: Tuple[str, ...] = ()
    isin: Optional[str] = None
    lei: Optional[str] = None
    cik: Optional[str] = None
    entity_id: Optional[str] = None
    origin: str = "seed"

    @property
    def ticker(self) -> Optional[str]:
        return self.tickers[0] if self.tickers else None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"name": self.name, "market_id": self.market_id}
        if self.tickers:
            out["ticker"] = self.tickers[0]
            if len(self.tickers) > 1:
                out["tickers"] = list(self.tickers)
        for key in ("isin", "lei", "cik", "entity_id"):
            value = getattr(self, key)
            if value:
                out[key] = value
        out["origin"] = self.origin
        return out


@dataclass(frozen=True)
class MarketIndex:
    """One market's searchable rows plus the provenance of the file they
    came from (the ``coverage`` block reads it).

    Matching is a linear scan over ``entries``. That is deliberate at
    this size — the largest shipped universe is in the hundreds and the
    whole catalogue is under two thousand rows, so a per-request scan
    costs less than the dictionaries it would take to avoid it. If a
    universe ever reaches five figures, add the exact-match dictionaries
    then, with a measurement rather than a guess."""

    market_id: str
    entries: Tuple[IndexEntry, ...]
    seed_as_of: Optional[str] = None
    seed_source: Optional[str] = None
    coverage_note: Optional[str] = None


_INDEX_LOCK = threading.Lock()
_INDEX_CACHE: Optional[Dict[str, MarketIndex]] = None


def reset_index() -> None:
    """Drop the cached index (tests, and after re-seeding)."""
    global _INDEX_CACHE
    with _INDEX_LOCK:
        _INDEX_CACHE = None


def _normalized_name(value: str) -> str:
    from engine.public_market import entity as _entity

    try:
        return _entity.normalize_name(value)
    except Exception:  # noqa: BLE001 — an unnormalizable name is not fatal
        return (value or "").strip().casefold()


def build_index(seeds_path: Optional[Any] = None) -> Dict[str, MarketIndex]:
    """{market_id: MarketIndex} from the seed files. Pure — no store, no
    network, no clock."""
    out: Dict[str, MarketIndex] = {}
    for seed in _universe.load_seeds(seeds_path):
        entries: List[IndexEntry] = []
        for member in seed.members:
            entry = IndexEntry(
                market_id=seed.market_id,
                name=member.name,
                normalized_name=_normalized_name(member.name),
                tickers=member.tickers,
                isin=member.isin,
                lei=member.lei,
                cik=member.cik,
                entity_id=member.entity_id(),
                origin="seed",
            )
            entries.append(entry)
        out[seed.market_id] = MarketIndex(
            market_id=seed.market_id,
            entries=tuple(entries),
            seed_as_of=seed.as_of,
            seed_source=str(seed.source.get("name") or "") or None,
            coverage_note=seed.coverage_note,
        )
    return out


def get_index(seeds_path: Optional[Any] = None) -> Dict[str, MarketIndex]:
    """Process-cached index. An explicit ``seeds_path`` always rebuilds:
    a test pointing at its own seeds must never read the real ones."""
    global _INDEX_CACHE
    if seeds_path is not None:
        return build_index(seeds_path)
    if _INDEX_CACHE is not None:
        return _INDEX_CACHE
    with _INDEX_LOCK:
        if _INDEX_CACHE is None:
            _INDEX_CACHE = build_index(None)
        return _INDEX_CACHE


# ── query normalization ─────────────────────────────────────────────


@dataclass(frozen=True)
class Query:
    raw: str
    upper: str
    normalized_name: str

    @property
    def is_ticker_shaped(self) -> bool:
        return bool(_TICKER_RE.match(self.upper))


def parse_query(value: Any) -> Query:
    raw = (value or "")
    if not isinstance(raw, str):
        raw = str(raw)
    raw = raw.strip()
    return Query(raw=raw, upper=raw.upper(), normalized_name=_normalized_name(raw))


# ── matching ────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Hit:
    entry: IndexEntry
    match: str
    held: bool = False
    #: The ticker the COMPANY ROUTE will actually answer for this
    #: entity, read from the stored document — not guessed from the
    #: seed. A multi-class issuer is stored under whichever class was
    #: resolved, so linking to the seed's first ticker would 404 half
    #: the time while this row claimed ``held: true``.
    address_ticker: Optional[str] = None

    @property
    def rank(self) -> int:
        return _RANKS.get(self.match, 99)

    def to_dict(self) -> Dict[str, Any]:
        out = self.entry.to_dict()
        out["match"] = self.match
        # `held` is the honest half of every row: identity known is not
        # the same claim as figures held.
        out["held"] = self.held
        if self.address_ticker:
            out["address_ticker"] = self.address_ticker
        return out


def _match_kind(entry: IndexEntry, query: Query) -> Optional[str]:
    upper = query.upper
    if upper and upper in (
        (entry.isin or "").upper(),
        (entry.lei or "").upper(),
        (entry.cik or "").upper(),
    ):
        return MATCH_KEY
    tickers = tuple(t.upper() for t in entry.tickers)
    if upper and upper in tickers:
        return MATCH_TICKER
    normalized = query.normalized_name
    if normalized and entry.normalized_name == normalized:
        return MATCH_NAME
    if upper and len(upper) >= 2 and any(t.startswith(upper) for t in tickers):
        return MATCH_TICKER_PREFIX
    if normalized and len(normalized) >= 2:
        if entry.normalized_name.startswith(normalized):
            return MATCH_NAME_PREFIX
        if normalized in entry.normalized_name:
            return MATCH_NAME_CONTAINS
    return None


def _market_hits(index: MarketIndex, query: Query, limit: int) -> List[Hit]:
    hits: List[Hit] = []
    for entry in index.entries:
        kind = _match_kind(entry, query)
        if kind is None:
            continue
        hits.append(Hit(entry=entry, match=kind))
    # Deterministic order: best match kind, then name, then ticker — so
    # the same query always returns the same page.
    hits.sort(key=lambda h: (h.rank, h.entry.normalized_name,
                             h.entry.ticker or "", h.entry.name))
    return hits[:limit]


# ── store augmentation ──────────────────────────────────────────────


def _store_entry(row: Dict[str, Any]) -> IndexEntry:
    name = str(row.get("name") or row.get("ticker") or row.get("entity_id") or "")
    symbol = row.get("ticker")
    return IndexEntry(
        market_id=str(row.get("market_id") or ""),
        name=name,
        normalized_name=_normalized_name(name),
        # The store keeps ONE ticker column per entity, so a store-only
        # row knows the class it was resolved under and no other.
        tickers=(str(symbol).upper(),) if symbol else (),
        isin=row.get("isin"),
        lei=row.get("lei"),
        cik=row.get("cik"),
        entity_id=row.get("entity_id"),
        origin="store",
    )


def _augment_from_store(market: "_registry.Market", query: Query,
                        hits: List[Hit], store: Any) -> List[Hit]:
    """Add a company the STORE knows but no seed lists.

    That is the normal fate of an on-demand resolution: it lands in the
    store, and it must be findable immediately without waiting for the
    next seed regeneration."""
    if store is None:
        return hits
    known = set(h.entry.entity_id for h in hits if h.entry.entity_id)
    found: List[Tuple[str, Dict[str, Any]]] = []
    if query.is_ticker_shaped:
        try:
            row = store.find_entity_by_ticker(market.market_id, query.upper)
        except Exception:  # noqa: BLE001 — a store fault is not a 500
            logger.warning("store ticker probe failed", exc_info=True)
            row = None
        if row:
            found.append((MATCH_TICKER, row))
    if query.upper.isdigit():
        try:
            row = store.find_entity_by_cik(query.upper)
        except Exception:  # noqa: BLE001
            logger.warning("store cik probe failed", exc_info=True)
            row = None
        if row and str(row.get("market_id") or "") == market.market_id:
            found.append((MATCH_KEY, row))
    for kind, row in found:
        entity_id = row.get("entity_id")
        if entity_id in known:
            continue
        known.add(entity_id)
        hits.append(Hit(entry=_store_entry(row), match=kind))
    hits.sort(key=lambda h: (h.rank, h.entry.normalized_name,
                             h.entry.ticker or "", h.entry.name))
    return hits


def _mark_held(hits: List[Hit], store: Any) -> List[Hit]:
    """Set ``held`` per hit — one store read each, AFTER truncation, so
    a broad query never turns into hundreds of queries."""
    if store is None:
        return hits
    out: List[Hit] = []
    for hit in hits:
        held = False
        address_ticker = None
        entity_id = hit.entry.entity_id
        if entity_id:
            document = None
            try:
                document = store.get_by_entity_id(entity_id)
            except Exception:  # noqa: BLE001
                logger.warning("store document probe failed", exc_info=True)
            held = document is not None
            if held:
                entity_block = document.get("entity") or {}
                symbol = entity_block.get("ticker")
                if isinstance(symbol, str) and symbol:
                    address_ticker = symbol.upper()
        out.append(Hit(entry=hit.entry, match=hit.match, held=held,
                       address_ticker=address_ticker))
    return out


# ── the search entry point ──────────────────────────────────────────


def search(query: Any, store: Any = None,
           limit_per_market: int = DEFAULT_LIMIT_PER_MARKET,
           seeds_path: Optional[Any] = None) -> Dict[str, Any]:
    """Search every market's universe. Pure with respect to the feed —
    this function NEVER fetches; :func:`resolve_on_demand` is the only
    outbound path and the caller invokes it explicitly."""
    parsed = parse_query(query)
    limit = max(1, min(int(limit_per_market or DEFAULT_LIMIT_PER_MARKET),
                       MAX_LIMIT_PER_MARKET))
    index = get_index(seeds_path)

    groups: List[Dict[str, Any]] = []
    coverage: List[Dict[str, Any]] = []
    total = 0
    for market in _registry.ordered_markets():
        market_index = index.get(market.market_id)
        searched = 0 if market_index is None else len(market_index.entries)
        hits: List[Hit] = []
        if market_index is not None and parsed.raw:
            hits = _market_hits(market_index, parsed, limit)
        if parsed.raw:
            hits = _augment_from_store(market, parsed, hits, store)[:limit]
            hits = _mark_held(hits, store)

        entry: Dict[str, Any] = {
            "market_id": market.market_id,
            "status": market.status,
            "searched_members": searched,
            "addressable": market.is_live and not market.is_home,
        }
        if market_index is None:
            entry["note"] = (
                "no universe file for this market — nothing was searched here, "
                "which is not the same as 'no such company'"
            )
        elif searched == 0:
            entry["note"] = market_index.coverage_note
        if market_index is not None:
            entry["as_of"] = market_index.seed_as_of
            entry["source"] = market_index.seed_source
        coverage.append(entry)

        if not hits:
            continue
        total += len(hits)
        groups.append({
            "market": market.to_dict(),
            "hit_count": len(hits),
            "truncated": len(hits) >= limit,
            "hits": [hit.to_dict() for hit in hits],
        })

    return {
        "status": "ok",
        "query": parsed.raw,
        "normalized_name": parsed.normalized_name,
        "ticker_shaped": parsed.is_ticker_shaped,
        "limit_per_market": limit,
        "total_hits": total,
        "groups": groups,
        "coverage": coverage,
    }


# ── on-demand resolution (the one outbound path) ────────────────────


@dataclass(frozen=True)
class ResolveOutcome:
    """A resolution attempt, always answered — never an exception.

    ``envelope`` is None for every refusal; ``code`` then names the
    reason in the adapter's own vocabulary so a refusal is never
    mistaken for "this company has no figures"."""

    ticker: str
    envelope: Optional[Dict[str, Any]] = None
    entity_id: Optional[str] = None
    market_id: Optional[str] = None
    cached: bool = False
    #: Why the document was NOT cached, verbatim from the adapter. The
    #: envelope is still valid when this is set — caching is best-effort
    #: — but an operator warming the cache needs to see a silent
    #: store refusal, not infer it from a boolean.
    cache_reason: Optional[str] = None
    code: Optional[str] = None
    detail: Optional[str] = None

    @property
    def ok(self) -> bool:
        return self.envelope is not None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "ticker": self.ticker,
            "resolved": self.ok,
            "market_id": self.market_id,
            "cached": self.cached,
        }
        if self.cache_reason:
            out["cache_reason"] = self.cache_reason
        if self.entity_id:
            out["entity_id"] = self.entity_id
        if not self.ok:
            out["code"] = self.code
            out["detail"] = self.detail
        return out


def ondemand_enabled() -> bool:
    """Whether the WEB surface may resolve live. Off unless explicitly
    switched on — see the module docstring."""
    return str(os.environ.get(ONDEMAND_ENV, "")).strip().lower() in (
        "1", "true", "yes", "on")


def resolvable_market() -> Optional["_registry.Market"]:
    """The market whose fundamentals feed the EDGAR adapter serves,
    resolved through the registry's REVERSE source lookup — never by
    naming a market id here."""
    from engine.public_market import edgar as _edgar

    market = _registry.market_for_source(_edgar.SOURCE)
    if market is None or not market.is_live or market.is_home:
        return None
    return market


def resolve_on_demand(ticker: Any, store: Any = None, client: Any = None,
                      journal_dir: Optional[str] = None,
                      now_fn: Optional[Any] = None) -> ResolveOutcome:
    """ticker → CIK → companyfacts → pm1 envelope → store.

    The whole point of this function is that afterwards
    ``GET /api/public/markets/company/<market>/<TICKER>`` serves a real
    document with real per-figure accessions, from the store, without
    the serving route ever touching the network.

    Refusals are typed and returned; nothing here raises, and nothing
    here writes a figure the feed did not carry."""
    from engine.public_market import edgar as _edgar

    symbol = str(ticker or "").strip().upper()
    if not symbol:
        return ResolveOutcome(ticker="", code=CODE_EMPTY_QUERY,
                              detail="no ticker supplied")
    if not _TICKER_RE.match(symbol):
        return ResolveOutcome(
            ticker=symbol, code=CODE_NOT_TICKER_SHAPED,
            detail="%r is not shaped like an exchange ticker; resolution is "
                   "not attempted on free text" % symbol,
        )
    market = resolvable_market()
    if market is None:
        return ResolveOutcome(
            ticker=symbol, code=CODE_NO_RESOLVABLE_MARKET,
            detail="no live market in the registry is served by the %s feed"
                   % _edgar.SOURCE,
        )

    # ``now_fn`` is injectable so a caller can pin the ingest clock. It
    # is not decoration: ``fetched_at`` travels into the envelope and
    # into its content hash, so a test that cannot pin it cannot make
    # the re-ingest path deterministic.
    adapter = _edgar.EdgarAdapter(client=client, journal_dir=journal_dir,
                                  store=store, now_fn=now_fn)
    try:
        envelope = adapter.resolve(symbol)
    except _edgar.EdgarTickerUnknown as exc:
        return ResolveOutcome(ticker=symbol, market_id=market.market_id,
                              code=CODE_TICKER_UNKNOWN, detail=str(exc))
    except _edgar.EdgarError as exc:
        return ResolveOutcome(ticker=symbol, market_id=market.market_id,
                              code=getattr(exc, "code", "EDGAR_ERROR"),
                              detail=str(exc))

    meta = envelope.get("meta") or {}
    entity_id = None
    if store is not None:
        try:
            from engine.public_market import model as _model

            entity_id = _model.entity_id_from_envelope(envelope)
        except Exception:  # noqa: BLE001 — an id is a nicety here
            entity_id = None
    reset_index()  # a newly known company must be findable at once
    return ResolveOutcome(
        ticker=symbol,
        envelope=envelope,
        entity_id=entity_id,
        market_id=market.market_id,
        cached=bool(meta.get("cached")),
        cache_reason=meta.get("cache_reason") or None,
    )


# ── router ──────────────────────────────────────────────────────────


def build_search_router(store: Any = None) -> "Any":
    """Sibling sub-router: fully-qualified paths, zero-arg factory.

    ``store`` is injectable for tests; in production the aggregate
    router's own lazy default store is used."""
    from fastapi import APIRouter, Query as _FastQuery
    from fastapi.responses import JSONResponse

    router = APIRouter(tags=["public-market"])

    def _store() -> Optional[Any]:
        if store is not None:
            return store
        from engine.public_market import router as _router

        return _router._resolve_store()

    def _refuse(status_code: int, code: str, detail: str,
                extra: Optional[Dict[str, Any]] = None) -> JSONResponse:
        body: Dict[str, Any] = {"status": "refused", "code": code,
                                "detail": detail}
        if extra:
            body.update(extra)
        return JSONResponse(body, status_code=status_code,
                            headers={"Cache-Control": ERROR_CACHE_CONTROL})

    @router.get(PREFIX + "/search")
    def search_markets(  # noqa: D401 - route
        q: str = _FastQuery("", description="name, ticker, ISIN, LEI or CIK"),
        limit: int = _FastQuery(DEFAULT_LIMIT_PER_MARKET, ge=1,
                                le=MAX_LIMIT_PER_MARKET),
        resolve: bool = _FastQuery(
            False, description="attempt live resolution of an unknown "
                               "ticker (requires the server-side gate)"),
    ) -> JSONResponse:
        """Search every market's universe, grouped in registry order."""
        parsed = parse_query(q)
        if len(parsed.raw) < MIN_QUERY_LEN:
            return _refuse(400, CODE_EMPTY_QUERY,
                           "supply a query: a company name, a ticker, an "
                           "ISIN, a LEI or a CIK")
        if len(parsed.raw) > MAX_QUERY_LEN:
            return _refuse(400, CODE_QUERY_TOO_LONG,
                           "query longer than %d characters" % MAX_QUERY_LEN)

        current = _store()
        body = search(parsed.raw, store=current, limit_per_market=limit)

        if resolve:
            body["resolution"] = _maybe_resolve(parsed, body, current)
        return JSONResponse(body,
                            headers={"Cache-Control": SEARCH_CACHE_CONTROL})

    @router.get(PREFIX + "/universe")
    def market_universe() -> JSONResponse:  # noqa: D401 - route
        """The seed catalogue: what universe each market has, dated, with
        its source and licence. Provenance only — no member rows."""
        return JSONResponse(_universe.catalogue(),
                            headers={"Cache-Control": SEARCH_CACHE_CONTROL})

    return router


def _maybe_resolve(parsed: Query, body: Dict[str, Any],
                   store: Any) -> Dict[str, Any]:
    """The web surface's guarded wrapper around :func:`resolve_on_demand`.

    Refuses — visibly, with a code — rather than silently doing nothing,
    so an operator reading a response can tell "the gate is off" from
    "the ticker does not exist"."""
    if not parsed.is_ticker_shaped:
        return {"attempted": False, "code": CODE_NOT_TICKER_SHAPED,
                "detail": "resolution is only attempted for a ticker-shaped "
                          "query"}
    if body.get("total_hits"):
        # Already known. Re-fetching what we hold would spend a
        # fair-access budget to learn nothing.
        return {"attempted": False, "code": "ALREADY_KNOWN",
                "detail": "the query already matches a known company"}
    if not ondemand_enabled():
        return {
            "attempted": False,
            "code": CODE_ONDEMAND_DISABLED,
            "detail": "live resolution is disabled on this surface (%s is "
                      "not set): a public search box that can trigger an "
                      "outbound feed request per keystroke is a fair-access "
                      "hazard. An operator warms the cache instead."
                      % ONDEMAND_ENV,
        }
    outcome = resolve_on_demand(parsed.upper, store=store)
    result = outcome.to_dict()
    result["attempted"] = True
    return result
