# -*- coding: utf-8 -*-
"""The public_market UNIVERSE — which companies exist, per market.

A *seed* is a versioned DATA file in ``seeds/``: one JSON document per
market, carrying the market's known members as IDENTITY only —
ticker, legal name, and whatever deterministic keys (ISIN / LEI / CIK)
the source published. **A seed never carries a figure.** Every number
this document class serves comes from a deterministic feed through the
adapters (EDGAR, ESEF); the universe only says "this company exists,
and here is the key you can look it up by".

WHY IDENTITY AND FIGURES ARE SEPARATED
--------------------------------------
Membership lists and financial feeds age at different rates and come
from different licences. Fusing them into one file would mean either
re-fetching 500 companies' fundamentals to refresh a membership change,
or serving a figure whose provenance is a membership list. Keeping the
seed identity-only means a seed can be regenerated daily from a cheap
source while every figure keeps pointing at the filing it came from.

WHAT A SEED IS NOT
------------------
* **Not a coverage claim.** A member in a seed means "we know this
  company is in this market", never "we hold its numbers". Loading a
  seed writes ``entities`` rows and nothing else; the company route
  keeps answering ``NOT_CACHED`` until a real filing lands. An empty
  ``members`` list is a legitimate, deliberate state (a market with no
  feed and no honestly-sourceable list) — it is written down as such
  rather than filled with plausible names.
* **Not a place to invent a key.** A member with no ISIN, LEI or CIK
  cannot be minted into an ``entity_id`` (the entity lane's law: names
  never link). Such a member is QUEUED for review, never given an id
  derived from its name, and never silently dropped.

PM7
---
The home market is served by ``public_ro`` and this package must never
hold a Romanian entity. :func:`load_into_store` refuses a home-market
seed that carries members — structurally, via ``Market.is_home``, never
by comparing a market id.

Python 3.9: no ``match``, no ``X | Y`` unions.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from engine.public_market import model as _model
from engine.public_market import registry as _registry

#: Seed schema tag. Bumping it is a breaking change to every seed file.
SEED_SCHEMA = "public_market_seed_v1"

#: Directory holding the seed files, beside this module.
SEEDS_DIRNAME = "seeds"

#: Override for tests / alternate deployments.
PATH_ENV = "PUBLIC_MARKET_SEEDS_PATH"

#: Required top-level keys on every seed document.
REQUIRED_SEED_KEYS = (
    "schema", "market_id", "as_of", "source", "license_note",
    "coverage_note", "members",
)

#: Required keys inside ``source`` — a seed whose provenance cannot be
#: named is a seed nobody can audit, so it is refused at load.
REQUIRED_SOURCE_KEYS = ("name", "url", "dataset_version", "retrieved_at")

#: The deterministic key kinds a member may carry, in the entity lane's
#: own precedence order. Resolved from the entity lane at call time so
#: adding a fourth kind there needs no edit here.
_KEY_KINDS_CACHE: Optional[Tuple[str, ...]] = None

#: review_queue reason for a member we cannot mint an id for. Mirrors
#: the store's own constant name; imported lazily so this module stays
#: importable without a database.
REASON_UNMINTABLE_MEMBER = "no_deterministic_key"

#: review_queue reason for one company that two markets' universes both
#: claim. REAL and common: TotalEnergies, Banco Santander, IAG, Natixis
#: and Crédit Agricole CIB all appear in more than one country's ESEF
#: filing set, correctly — one LEI, one company, filed in two
#: jurisdictions. The entity id is right; the MARKET is the ambiguity,
#: and letting the last loaded seed win would make a company's market
#: depend on load order. First claim stands, second is queued.
REASON_MARKET_CLAIM_CONFLICT = "entity_claimed_by_two_markets"

_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class SeedError(ValueError):
    """A seed that cannot be loaded without guessing."""


def _key_kinds() -> Tuple[str, ...]:
    global _KEY_KINDS_CACHE
    if _KEY_KINDS_CACHE is None:
        from engine.public_market import entity as _entity

        _KEY_KINDS_CACHE = tuple(_entity.DETERMINISTIC_KEY_PRECEDENCE)
    return _KEY_KINDS_CACHE


# ── value types ─────────────────────────────────────────────────────


@dataclass(frozen=True)
class Member:
    """One ISSUER as the seed's source described it. Identity only.

    ``tickers`` is a tuple because one issuer can carry several listed
    share classes (Alphabet's GOOGL/GOOG, Fox's FOXA/FOX, News Corp's
    NWSA/NWS all share ONE SEC CIK). Modelling those as two members
    would mint one entity id twice and double-count the market; the
    entity is the issuer, the tickers are its listings. Real S&P 500
    data refuses to load under the one-ticker-one-member assumption,
    which is how this was found.
    """

    name: str
    tickers: Tuple[str, ...] = ()
    isin: Optional[str] = None
    lei: Optional[str] = None
    cik: Optional[str] = None

    @property
    def ticker(self) -> Optional[str]:
        """The canonical listing — the first, and the tuple is written
        sorted, so the choice is deterministic rather than
        source-order-dependent."""
        return self.tickers[0] if self.tickers else None

    def has_ticker(self, symbol: Any) -> bool:
        wanted = str(symbol or "").strip().upper()
        return bool(wanted) and wanted in self.tickers

    def key(self) -> Optional[Tuple[str, str]]:
        """``(kind, value)`` of the best deterministic key this member
        carries, by the entity lane's precedence — or None.

        None is the honest answer for a member the source described only
        by name: the caller queues it for review. Minting an id from a
        name would link two same-named companies into one entity."""
        for kind in _key_kinds():
            value = getattr(self, kind, None)
            if value in (None, ""):
                continue
            return (kind, str(value))
        return None

    def entity_id(self) -> Optional[str]:
        """The minted entity id, or None when no key normalizes.

        A key that FAILS its own checksum (a mistyped ISIN, a
        non-numeric CIK) is treated as absent rather than trusted —
        the entity lane raises, and a wrong id is worse than no id."""
        pair = self.key()
        if pair is None:
            return None
        kind, value = pair
        try:
            return _model.mint_entity_id(kind, value)
        except Exception:  # noqa: BLE001 — a malformed key is not an id
            return None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"name": self.name}
        if len(self.tickers) == 1:
            out["ticker"] = self.tickers[0]
        elif self.tickers:
            out["tickers"] = list(self.tickers)
        for field in _key_kinds():
            value = getattr(self, field, None)
            if value:
                out[field] = value
        return out


@dataclass(frozen=True)
class Seed:
    """One market's universe file, as loaded and validated."""

    market_id: str
    as_of: str
    source: Dict[str, Any]
    license_note: str
    coverage_note: str
    members: Tuple[Member, ...]
    path: Optional[str] = None

    @property
    def member_count(self) -> int:
        return len(self.members)

    @property
    def is_empty(self) -> bool:
        """An empty seed is a DECLARED gap, not a failure. The file
        exists so the gap is visible and dated."""
        return not self.members

    def to_dict(self) -> Dict[str, Any]:
        return {
            "schema": SEED_SCHEMA,
            "market_id": self.market_id,
            "as_of": self.as_of,
            "source": dict(self.source),
            "license_note": self.license_note,
            "coverage_note": self.coverage_note,
            "member_count": self.member_count,
            "members": [m.to_dict() for m in self.members],
        }

    def summary(self) -> Dict[str, Any]:
        """The catalogue view — everything except the member list, for
        surfaces that show provenance without shipping 500 rows."""
        out = self.to_dict()
        out.pop("members", None)
        return out


# ── file resolution ─────────────────────────────────────────────────


def seeds_dir(path: Optional[Any] = None) -> Path:
    if path is not None:
        return Path(path)
    env = os.environ.get(PATH_ENV)
    if env:
        return Path(env)
    return Path(__file__).resolve().parent / SEEDS_DIRNAME


def seed_paths(path: Optional[Any] = None) -> List[Path]:
    """Every seed file, sorted by filename for determinism.

    The FILENAME is a convenience, never an authority: the market a seed
    belongs to is read from its ``market_id`` field. A file named for
    one market and stamped for another is a load error, not a silent
    reassignment."""
    directory = seeds_dir(path)
    if not directory.is_dir():
        return []
    return sorted(directory.glob("*.json"))


# ── validation + load ───────────────────────────────────────────────


def validate_seed(raw: Any, origin: str = "<memory>") -> List[str]:
    """Every contract violation in one seed document, as human lines.

    Returns rather than raises: an operator fixing a seed wants the
    whole list, not the first problem."""
    problems: List[str] = []
    if not isinstance(raw, dict):
        return ["%s: seed is not a JSON object" % origin]

    for key in REQUIRED_SEED_KEYS:
        if key not in raw:
            problems.append("%s: missing required key %r" % (origin, key))
    if raw.get("schema") != SEED_SCHEMA:
        problems.append("%s: schema must be %r (got %r)"
                        % (origin, SEED_SCHEMA, raw.get("schema")))

    market_id = raw.get("market_id")
    if not isinstance(market_id, str) or not market_id:
        problems.append("%s: market_id must be a non-empty string" % origin)
    elif _registry.find_market(market_id) is None:
        problems.append("%s: market_id %r is not in the registry"
                        % (origin, market_id))

    as_of = raw.get("as_of")
    if not isinstance(as_of, str) or not _ISO_DATE_RE.match(as_of or ""):
        problems.append("%s: as_of must be an ISO date (YYYY-MM-DD), got %r"
                        % (origin, as_of))

    source = raw.get("source")
    if not isinstance(source, dict):
        problems.append("%s: source must be an object" % origin)
    else:
        for key in REQUIRED_SOURCE_KEYS:
            if not source.get(key):
                problems.append("%s: source is missing %r — a seed whose "
                                "provenance cannot be named cannot be "
                                "audited" % (origin, key))

    for key in ("license_note", "coverage_note"):
        value = raw.get(key)
        if not isinstance(value, str) or not value.strip():
            problems.append("%s: %s must be a non-empty string" % (origin, key))

    members = raw.get("members")
    if not isinstance(members, list):
        problems.append("%s: members must be a list (an empty list is a "
                        "legitimate declared gap)" % origin)
        return problems

    declared = raw.get("member_count")
    if declared is not None and declared != len(members):
        problems.append("%s: member_count %r disagrees with %d members — a "
                        "stale count hides a truncated file"
                        % (origin, declared, len(members)))

    seen_keys: Dict[str, int] = {}
    for index, item in enumerate(members):
        label = "%s: member[%d]" % (origin, index)
        if not isinstance(item, dict):
            problems.append("%s is not an object" % label)
            continue
        name = item.get("name")
        if not isinstance(name, str) or not name.strip():
            problems.append("%s has no name" % label)
        for kind in _key_kinds():
            value = item.get(kind)
            if value is not None and (not isinstance(value, str) or not value.strip()):
                problems.append("%s: %s must be a non-empty string when present"
                                % (label, kind))
        if "ticker" in item and "tickers" in item:
            problems.append("%s carries both 'ticker' and 'tickers' — one "
                            "issuer's listings live in exactly one field"
                            % label)
        listings = item.get("tickers")
        if listings is not None and not isinstance(listings, list):
            problems.append("%s: tickers must be a list of share-class "
                            "symbols" % label)
        member = _member_from(item)
        if len(set(member.tickers)) != len(member.tickers):
            problems.append("%s lists the same ticker twice" % label)
        entity_id = member.entity_id()
        if entity_id is not None:
            previous = seen_keys.get(entity_id)
            if previous is not None:
                problems.append(
                    "%s mints the same entity_id as member[%d] — two rows for "
                    "one company would double-count the market"
                    % (label, previous)
                )
            else:
                seen_keys[entity_id] = index

    return problems


def _member_from(item: Dict[str, Any]) -> Member:
    def _clean(key: str) -> Optional[str]:
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
        return None

    listings: List[str] = []
    single = _clean("ticker")
    if single:
        listings.append(single.upper())
    raw_list = item.get("tickers")
    if isinstance(raw_list, list):
        for value in raw_list:
            if isinstance(value, str) and value.strip():
                listings.append(value.strip().upper())

    return Member(
        name=str(item.get("name") or "").strip(),
        tickers=tuple(listings),
        isin=_clean("isin"),
        lei=_clean("lei"),
        cik=_clean("cik"),
    )


def seed_from_dict(raw: Dict[str, Any], origin: str = "<memory>") -> Seed:
    """Validated seed, or :class:`SeedError` naming every problem."""
    problems = validate_seed(raw, origin)
    if problems:
        raise SeedError("; ".join(problems))
    members = tuple(_member_from(item) for item in raw["members"])
    return Seed(
        market_id=str(raw["market_id"]),
        as_of=str(raw["as_of"]),
        source=dict(raw["source"]),
        license_note=str(raw["license_note"]),
        coverage_note=str(raw["coverage_note"]),
        members=members,
        path=None if origin == "<memory>" else origin,
    )


def load_seed(path: Any) -> Seed:
    target = Path(path)
    try:
        raw = json.loads(target.read_text(encoding="utf-8"))
    except OSError as exc:
        raise SeedError("cannot read seed %s: %s" % (target, exc))
    except ValueError as exc:
        raise SeedError("seed %s is not valid JSON: %s" % (target, exc))
    return seed_from_dict(raw, origin=str(target))


def load_seeds(path: Optional[Any] = None) -> List[Seed]:
    """Every seed, in REGISTRY display order (Romania, then marquee,
    then A→Z) — not filesystem order, so any surface that iterates seeds
    renders the marquee in the declared order for free.

    A market with no seed file is simply absent from the list; a seed
    file for an unknown market is a load error (raised by
    :func:`validate_seed`), because silently ignoring it would let a
    typo'd market id look like "no data" forever."""
    by_market: Dict[str, Seed] = {}
    for candidate in seed_paths(path):
        seed = load_seed(candidate)
        if seed.market_id in by_market:
            raise SeedError(
                "two seed files claim market %r (%s and %s) — one market, one "
                "universe file"
                % (seed.market_id, by_market[seed.market_id].path, seed.path)
            )
        by_market[seed.market_id] = seed
    ordered = []
    for market in _registry.ordered_markets():
        found = by_market.get(market.market_id)
        if found is not None:
            ordered.append(found)
    return ordered


def seed_for(market_id: Any, path: Optional[Any] = None) -> Optional[Seed]:
    wanted = str(market_id or "").strip().lower()
    for seed in load_seeds(path):
        if seed.market_id == wanted:
            return seed
    return None


def catalogue(path: Optional[Any] = None) -> Dict[str, Any]:
    """Provenance-only view of every seed — what we claim to know about
    each market's universe, and where that claim came from."""
    seeds = load_seeds(path)
    return {
        "schema": SEED_SCHEMA,
        "seeds": [seed.summary() for seed in seeds],
        "total_members": sum(seed.member_count for seed in seeds),
    }


# ── loading into the spine store ────────────────────────────────────


@dataclass(frozen=True)
class LoadReport:
    """What one seed actually did to the store. Every member is
    accounted for: ``upserted + queued == seen``."""

    market_id: str
    seen: int
    upserted: int
    queued: int
    queued_names: Tuple[str, ...] = ()
    #: Members whose entity is already claimed by ANOTHER market. They
    #: still count as upserted (identity is refreshed) but their market
    #: assignment was left alone and a review entry was written.
    market_conflicts: Tuple[str, ...] = ()

    def to_dict(self) -> Dict[str, Any]:
        return {
            "market_id": self.market_id,
            "seen": self.seen,
            "upserted": self.upserted,
            "queued": self.queued,
            "queued_names": list(self.queued_names),
            "market_conflicts": list(self.market_conflicts),
        }


def load_into_store(seed: Seed, store: Any, *,
                    queue_unmintable: bool = True) -> LoadReport:
    """Upsert one seed's members as ``entities`` rows.

    IDENTITY ONLY — no filing, no price, no figure is written here. A
    seeded entity is a company we can NAME, not one whose numbers we
    hold; the company route keeps refusing with ``NOT_CACHED`` until an
    adapter lands a real document for it.

    Members with no usable deterministic key are queued for review and
    counted, never dropped and never given a name-derived id.
    """
    market = _registry.get_market(seed.market_id)
    if market.is_home and seed.members:
        # PM7, enforced structurally. The home market is served by its
        # own pipeline; one company answered by two document classes is
        # two sources of truth and, eventually, two different numbers.
        raise SeedError(
            "refusing to load %d members into the home market (%s): it is "
            "served by %s, and public_market must never hold one of its "
            "entities" % (len(seed.members), market.display_name,
                          market.fundamentals_source)
        )

    source_name = str(seed.source.get("name") or "") or None
    upserted = 0
    queued = 0
    queued_names: List[str] = []
    conflicts: List[str] = []
    for member in seed.members:
        entity_id = member.entity_id()
        if entity_id is None:
            queued += 1
            queued_names.append(member.name)
            if queue_unmintable:
                store.queue_review(
                    REASON_UNMINTABLE_MEMBER,
                    detail="seed member %r carries no usable ISIN/LEI/CIK; an "
                           "id minted from its name would link two companies"
                           % member.name,
                    market_id=seed.market_id,
                    source=source_name,
                    payload=member.to_dict(),
                )
            continue

        # Is this company already claimed by a different market? Passing
        # market_id=None then makes the store's COALESCE keep the FIRST
        # claim, so identity still accretes (name, LEI, currency) while
        # the market assignment stops depending on load order.
        claimed_by = _existing_market(store, entity_id)
        assign_market: Optional[str] = seed.market_id
        if claimed_by is not None and claimed_by != seed.market_id:
            assign_market = None
            conflicts.append(member.name)
            store.queue_review(
                REASON_MARKET_CLAIM_CONFLICT,
                detail="%r is already held for market %r; the %r universe "
                       "claims it too. One company, one primary market: the "
                       "first claim stands and this one is queued rather "
                       "than overwriting it."
                       % (member.name, claimed_by, seed.market_id),
                market_id=seed.market_id,
                entity_id=entity_id,
                source=source_name,
                payload={"held_by": claimed_by, "claimed_by": seed.market_id,
                         "member": member.to_dict()},
            )

        store.upsert_entity(
            entity_id,
            market_id=assign_market,
            ticker=member.ticker,
            name=member.name,
            cik=member.cik,
            isin=member.isin,
            lei=member.lei,
            # Currency follows the market that HOLDS the entity, never
            # the one merely claiming it — a EUR figure relabelled GBP
            # by a load order is exactly the silent lie this guards.
            currency=market.currency if assign_market else None,
            source=source_name,
        )
        upserted += 1

    return LoadReport(
        market_id=seed.market_id,
        seen=len(seed.members),
        upserted=upserted,
        queued=queued,
        queued_names=tuple(queued_names),
        market_conflicts=tuple(conflicts),
    )


def _existing_market(store: Any, entity_id: str) -> Optional[str]:
    """The market a store already holds this entity under, or None."""
    try:
        row = store.get_entity(entity_id)
    except Exception:  # noqa: BLE001 — a probe failure is not a claim
        return None
    if not row:
        return None
    held = row.get("market_id")
    return str(held) if held else None


def load_all_into_store(store: Any, path: Optional[Any] = None,
                        *, queue_unmintable: bool = True) -> List[LoadReport]:
    """Load every seed, in registry order. Home-market seeds are only
    refused when they carry members — an empty one is the documented
    PM7 statement and loads as a no-op."""
    reports = []
    for seed in load_seeds(path):
        reports.append(load_into_store(seed, store,
                                       queue_unmintable=queue_unmintable))
    return reports


# ── lookups over the loaded universe (no store required) ────────────


def member_counts(path: Optional[Any] = None) -> Dict[str, int]:
    return dict((seed.market_id, seed.member_count) for seed in load_seeds(path))
