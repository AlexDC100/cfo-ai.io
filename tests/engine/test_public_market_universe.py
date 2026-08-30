# -*- coding: utf-8 -*-
"""UNIVERSE + SEARCH + the EDGAR wiring that makes a US company real.

Three things this file is careful about:

1. **No mirror store.** Every store assertion drives the REAL
   ``PublicMarketStore`` on a temp sqlite file. A ``FakeStore`` double is
   what hid twenty defects (including two total outages) in the
   public_ro wave.

2. **No network.** The end-to-end EDGAR proof runs the REAL adapter —
   real ``resolve_cik``, real ``fetch_companyfacts``, real envelope
   build, real store write, real HTTP router — over the COMMITTED SEC
   bytes through an injected transport. Everything is exercised except
   the socket.

3. **The shipped seeds are under test, not a hand-written imitation.**
   The files in ``src/engine/public_market/seeds/`` are real published
   data; asserting against an idealized copy would test this lane's
   imagination. Where a test needs a specific shape (a home-market seed
   with members, an unmintable member) it builds a throwaway seeds
   directory and says so.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

# Bootstrap: make `engine` importable whether or not the repo conftest
# already put src/ on sys.path.
_SRC = Path(__file__).resolve().parents[2] / "src"
if (_SRC / "engine").exists() and str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from engine.public_market import (  # noqa: E402
    edgar, model, registry, search, store, universe,
)

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "public_market"
FETCHED_AT = "2026-08-29T20:53:16Z"
APPLE_CIK10 = "0000320193"
APPLE_ACCN_FY2025 = "0000320193-25-000079"
#: Real Apple FY2025 10-K figures, from the committed bytes, in MINOR
#: units (pm1 stores money as integer cents — `figure_minor` returns
#: 41,616,100,000,000 for $416.161bn, and a test written in major units
#: passes only by accident). If these move, the adapter changed — not
#: the test.
APPLE_FY2025_REVENUE_MINOR = 416_161_000_000 * 100
APPLE_FY2025_ASSETS_MINOR = 359_241_000_000 * 100

SHIPPED_SEEDS = Path(universe.__file__).resolve().parent / universe.SEEDS_DIRNAME


# ── fixtures ────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _fresh_caches():
    registry.reset_cache()
    search.reset_index()
    yield
    registry.reset_cache()
    search.reset_index()


@pytest.fixture()
def temp_store(tmp_path):
    """The REAL store on a temp database — never a double."""
    real = store.PublicMarketStore(tmp_path / "public_market.db")
    try:
        yield real
    finally:
        real.close()


def _fixture_bytes(name):
    return (FIXTURES / name).read_bytes()


class RecordingTransport(object):
    """transport(url, headers) -> (status, body); records every call so a
    test can assert that a code path did NOT reach the feed."""

    def __init__(self, routes):
        self.routes = dict(routes)
        self.calls = []

    def __call__(self, url, headers):
        self.calls.append(url)
        if url not in self.routes:
            return (404, b"not in fixture routes")
        return self.routes[url]


def _sec_routes():
    return {
        edgar.TICKERS_URL: (200, _fixture_bytes("company_tickers_truncated.json")),
        edgar.COMPANYFACTS_URL_TMPL.format(cik=APPLE_CIK10): (
            200, _fixture_bytes("companyfacts_CIK0000320193_truncated.json")),
    }


def _offline_client(routes=None):
    """A REAL EdgarClient whose only fake part is the socket."""
    clock = {"now": 0.0}

    def sleeper(seconds):
        clock["now"] += seconds

    transport = RecordingTransport(_sec_routes() if routes is None else routes)
    client = edgar.EdgarClient(
        transport=transport,
        sleeper=sleeper,
        token_bucket=edgar.TokenBucket(clock=lambda: clock["now"],
                                       sleeper=sleeper),
    )
    return client, transport


def _write_seed(directory, market_id, members, **overrides):
    """A throwaway seed file. Used ONLY where a test needs a shape the
    shipped data does not have."""
    document = {
        "schema": universe.SEED_SCHEMA,
        "market_id": market_id,
        "as_of": "2026-08-30",
        "source": {
            "name": "test fixture",
            "url": "https://example.invalid/seed",
            "dataset_version": "test-1",
            "retrieved_at": "2026-08-30T00:00:00Z",
        },
        "license_note": "test fixture — not a real licence",
        "coverage_note": "a throwaway seed built by a test",
        "member_count": len(members),
        "members": members,
    }
    document.update(overrides)
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / ("%s.json" % market_id)
    target.write_text(json.dumps(document, indent=2), encoding="utf-8")
    return target


# ── the SHIPPED seed files ──────────────────────────────────────────


def test_every_shipped_seed_validates():
    """The files that ship are the files under test."""
    paths = universe.seed_paths(SHIPPED_SEEDS)
    assert paths, "no seed files ship — the universe would be empty"
    for path in paths:
        raw = json.loads(path.read_text(encoding="utf-8"))
        assert universe.validate_seed(raw, origin=path.name) == []


def test_every_registry_market_has_a_universe_file():
    """A market with no seed is a market nobody can even NAME a company
    in — and, worse, an unexplained blank on the search surface. Every
    market therefore carries a file, even if it carries no members."""
    seeded = set(universe.member_counts(SHIPPED_SEEDS))
    assert seeded == set(registry.market_ids())


def test_seeds_are_returned_in_registry_display_order():
    """Romania first (its own group), then the declared marquee order."""
    ordered = [seed.market_id for seed in universe.load_seeds(SHIPPED_SEEDS)]
    assert ordered == list(registry.market_ids())
    assert ordered[0] == registry.home_market().market_id


def test_a_seed_file_names_its_source_its_version_and_its_licence():
    for seed in universe.load_seeds(SHIPPED_SEEDS):
        for key in universe.REQUIRED_SOURCE_KEYS:
            assert seed.source.get(key), (seed.market_id, key)
        assert seed.license_note.strip()
        assert seed.coverage_note.strip()


def test_seeds_carry_identity_only_and_never_a_figure():
    """PM law: deterministic feeds carry every number. A membership list
    is not a feed, so a seed that carried a value would be a figure with
    a Wikipedia table for provenance."""
    allowed = {"name", "ticker", "tickers"} | set(universe._key_kinds())
    for seed in universe.load_seeds(SHIPPED_SEEDS):
        raw = json.loads(Path(seed.path).read_text(encoding="utf-8"))
        for member in raw["members"]:
            assert set(member) <= allowed, (seed.market_id, sorted(member))


def test_us_seed_is_cik_keyed_and_every_member_mints():
    us = universe.seed_for(registry.market_for_source(edgar.SOURCE).market_id,
                           SHIPPED_SEEDS)
    assert us is not None and us.member_count > 400
    for member in us.members:
        assert member.cik, member.name
        assert member.entity_id(), member.name


def test_a_multi_class_issuer_is_one_member_not_two():
    """Alphabet files under ONE CIK with TWO listed share classes. Two
    members would mint one entity id twice and double-count the market —
    the real S&P 500 file refuses to validate if you try."""
    us = universe.seed_for(registry.market_for_source(edgar.SOURCE).market_id,
                           SHIPPED_SEEDS)
    multi = [m for m in us.members if len(m.tickers) > 1]
    assert multi, "expected at least one dual-share-class issuer"
    for member in multi:
        assert len(set(m.cik for m in us.members if m.cik == member.cik)) == 1
        assert member.has_ticker(member.tickers[1])


def test_european_seeds_are_lei_keyed_because_the_feed_has_no_ticker():
    """Which is exactly why those markets are `fundamentals_only`: the
    figures exist, the ticker lookup does not."""
    for market in registry.markets_by_status(registry.STATUS_FUNDAMENTALS_ONLY):
        seed = universe.seed_for(market.market_id, SHIPPED_SEEDS)
        assert seed is not None and seed.member_count > 0, market.market_id
        assert all(m.lei for m in seed.members), market.market_id
        assert not any(m.tickers for m in seed.members), market.market_id


def test_a_market_with_no_feed_ships_an_empty_seed_with_a_written_reason():
    """An empty seed is a DECLARED gap. A fabricated one is a lie with a
    schema."""
    for market in registry.markets_by_status(registry.STATUS_AWAITING_PROVIDER):
        seed = universe.seed_for(market.market_id, SHIPPED_SEEDS)
        assert seed is not None, market.market_id
        assert seed.is_empty, market.market_id
        assert len(seed.coverage_note) > 80, market.market_id


def test_the_home_market_seed_is_empty_pm7():
    home = registry.home_market()
    seed = universe.seed_for(home.market_id, SHIPPED_SEEDS)
    assert seed is not None and seed.is_empty
    assert "public_ro" in seed.coverage_note or home.fundamentals_source \
        in seed.coverage_note


# ── seed validation is not decoration ───────────────────────────────


@pytest.mark.parametrize("mutate,expected", [
    (lambda d: d.pop("license_note"), "license_note"),
    (lambda d: d.update({"schema": "public_market_seed_v0"}), "schema"),
    (lambda d: d.update({"market_id": "atlantis"}), "not in the registry"),
    (lambda d: d.update({"as_of": "August 2026"}), "as_of"),
    (lambda d: d["source"].pop("dataset_version"), "dataset_version"),
    (lambda d: d.update({"member_count": 99}), "member_count"),
    (lambda d: d["members"].append({"ticker": "X"}), "has no name"),
])
def test_validate_seed_catches_the_ways_a_seed_goes_wrong(mutate, expected):
    document = {
        "schema": universe.SEED_SCHEMA,
        "market_id": registry.market_for_source(edgar.SOURCE).market_id,
        "as_of": "2026-08-30",
        "source": {"name": "n", "url": "u", "dataset_version": "v",
                   "retrieved_at": "2026-08-30T00:00:00Z"},
        "license_note": "l",
        "coverage_note": "c",
        "member_count": 1,
        "members": [{"name": "Apple Inc.", "ticker": "AAPL", "cik": "320193"}],
    }
    assert universe.validate_seed(document) == []  # non-vacuous baseline
    mutate(document)
    problems = universe.validate_seed(document)
    assert problems and any(expected in p for p in problems), problems


def test_two_members_that_mint_the_same_id_are_refused():
    """One issuer, two rows is a double count wearing a disguise."""
    market_id = registry.market_for_source(edgar.SOURCE).market_id
    document = {
        "schema": universe.SEED_SCHEMA,
        "market_id": market_id,
        "as_of": "2026-08-30",
        "source": {"name": "n", "url": "u", "dataset_version": "v",
                   "retrieved_at": "2026-08-30T00:00:00Z"},
        "license_note": "l",
        "coverage_note": "c",
        "member_count": 2,
        "members": [
            {"name": "Alphabet Inc. (Class A)", "ticker": "GOOGL", "cik": "1652044"},
            {"name": "Alphabet Inc. (Class C)", "ticker": "GOOG", "cik": "1652044"},
        ],
    }
    problems = universe.validate_seed(document)
    assert any("same entity_id" in p for p in problems), problems


def test_ticker_and_tickers_are_mutually_exclusive():
    document = {
        "schema": universe.SEED_SCHEMA,
        "market_id": registry.market_for_source(edgar.SOURCE).market_id,
        "as_of": "2026-08-30",
        "source": {"name": "n", "url": "u", "dataset_version": "v",
                   "retrieved_at": "2026-08-30T00:00:00Z"},
        "license_note": "l", "coverage_note": "c", "member_count": 1,
        "members": [{"name": "X", "ticker": "A", "tickers": ["B"],
                     "cik": "320193"}],
    }
    assert any("exactly one field" in p
               for p in universe.validate_seed(document))


def test_a_bad_checksum_key_is_treated_as_absent_not_trusted():
    """A wrong id is worse than no id."""
    member = universe.Member(name="Nowhere SA", isin="XX0000000000")
    assert member.key() == ("isin", "XX0000000000")
    assert member.entity_id() is None


def test_two_seed_files_cannot_claim_one_market(tmp_path):
    seeds = tmp_path / "seeds"
    market_id = registry.market_for_source(edgar.SOURCE).market_id
    _write_seed(seeds, market_id, [])
    # A second file whose FILENAME differs but whose market_id collides:
    # the field is the authority, not the name on disk.
    (seeds / "duplicate.json").write_text(
        (seeds / ("%s.json" % market_id)).read_text(encoding="utf-8"),
        encoding="utf-8")
    with pytest.raises(universe.SeedError) as excinfo:
        universe.load_seeds(seeds)
    assert "one market, one universe file" in str(excinfo.value)


# ── loading into the real store ─────────────────────────────────────


def test_loading_a_seed_writes_identity_and_no_document(temp_store, tmp_path):
    market_id = registry.market_for_source(edgar.SOURCE).market_id
    seeds = tmp_path / "seeds"
    _write_seed(seeds, market_id,
                [{"name": "Apple Inc.", "ticker": "AAPL", "cik": "320193"}])
    report = universe.load_into_store(universe.seed_for(market_id, seeds),
                                      temp_store)
    assert (report.seen, report.upserted, report.queued) == (1, 1, 0)

    row = temp_store.find_entity_by_ticker(market_id, "AAPL")
    assert row["name"] == "Apple Inc."
    assert row["currency"] == registry.get_market(market_id).currency
    # Identity only: knowing a company is not holding its numbers.
    assert temp_store.get_by_entity_id(row["entity_id"]) is None
    assert temp_store.get_by_ticker(market_id, "AAPL") is None


def test_loading_is_idempotent(temp_store, tmp_path):
    market_id = registry.market_for_source(edgar.SOURCE).market_id
    seeds = tmp_path / "seeds"
    _write_seed(seeds, market_id,
                [{"name": "Apple Inc.", "ticker": "AAPL", "cik": "320193"}])
    seed = universe.seed_for(market_id, seeds)
    universe.load_into_store(seed, temp_store)
    universe.load_into_store(seed, temp_store)
    assert temp_store.entity_count(market_id) == 1


def test_an_unmintable_member_is_queued_never_name_minted(temp_store, tmp_path):
    market_id = registry.market_for_source(edgar.SOURCE).market_id
    seeds = tmp_path / "seeds"
    _write_seed(seeds, market_id, [{"name": "Keyless Holdings", "ticker": "KEY"}])
    report = universe.load_into_store(universe.seed_for(market_id, seeds),
                                      temp_store)
    assert (report.upserted, report.queued) == (0, 1)
    assert report.queued_names == ("Keyless Holdings",)
    assert temp_store.entity_count(market_id) == 0
    queue = temp_store.review_queue(reason=universe.REASON_UNMINTABLE_MEMBER)
    assert queue and "Keyless Holdings" in queue[0]["detail"]


def test_one_company_claimed_by_two_markets_keeps_the_first_claim(temp_store,
                                                                  tmp_path):
    """REAL and common: TotalEnergies, Santander, IAG and Natixis each
    file ESEF in two countries. One LEI is one company; letting the last
    loaded seed win would make a company's market depend on load order
    — and would relabel its currency with it."""
    fundamentals_only = registry.markets_by_status(
        registry.STATUS_FUNDAMENTALS_ONLY)
    first, second = fundamentals_only[0], fundamentals_only[1]
    lei = "529900S21EQ1BO4ESM68"  # TotalEnergies SE, a real LEI
    seeds = tmp_path / "seeds"
    _write_seed(seeds, first.market_id, [{"name": "TotalEnergies SE", "lei": lei}])
    _write_seed(seeds, second.market_id, [{"name": "TotalEnergies SE", "lei": lei}])

    reports = universe.load_all_into_store(temp_store, seeds)
    by_market = dict((r.market_id, r) for r in reports)
    ordered = [m.market_id for m in registry.ordered_markets()
               if m.market_id in by_market]
    holder, claimant = ordered[0], ordered[1]

    assert by_market[holder].market_conflicts == ()
    assert by_market[claimant].market_conflicts == ("TotalEnergies SE",)

    entity_id = model.mint_entity_id("lei", lei)
    row = temp_store.get_entity(entity_id)
    assert row["market_id"] == holder
    assert row["currency"] == registry.get_market(holder).currency
    assert temp_store.market_counts().get(claimant, 0) == 0

    queue = temp_store.review_queue(reason=universe.REASON_MARKET_CLAIM_CONFLICT)
    assert queue and queue[0]["payload"]["held_by"] == holder


def test_the_home_market_refuses_members_pm7(temp_store, tmp_path):
    """Enforced by code, not only by an empty file."""
    home = registry.home_market()
    seeds = tmp_path / "seeds"
    _write_seed(seeds, home.market_id,
                [{"name": "Banca Transilvania", "isin": "ROTLVAACNOR1"}])
    with pytest.raises(universe.SeedError) as excinfo:
        universe.load_into_store(universe.seed_for(home.market_id, seeds),
                                 temp_store)
    assert home.fundamentals_source in str(excinfo.value)
    assert temp_store.entity_count(home.market_id) == 0


def test_an_empty_home_market_seed_loads_as_a_no_op(temp_store, tmp_path):
    home = registry.home_market()
    seeds = tmp_path / "seeds"
    _write_seed(seeds, home.market_id, [])
    report = universe.load_into_store(universe.seed_for(home.market_id, seeds),
                                      temp_store)
    assert (report.seen, report.upserted) == (0, 0)


def test_the_shipped_universe_loads_into_a_real_store(temp_store):
    """The whole shipped catalogue, through the real store, once."""
    reports = universe.load_all_into_store(temp_store, SHIPPED_SEEDS)
    assert reports
    for report in reports:
        assert report.upserted + report.queued == report.seen
    counts = temp_store.market_counts()
    assert counts[registry.market_for_source(edgar.SOURCE).market_id] > 400
    assert registry.home_market().market_id not in counts  # PM7


# ── search ──────────────────────────────────────────────────────────


@pytest.fixture()
def loaded(temp_store):
    """The shipped universe in a real store, with the search index
    pointed at the shipped seeds."""
    universe.load_all_into_store(temp_store, SHIPPED_SEEDS)
    search.reset_index()
    return temp_store


def _flat(body):
    return [hit for group in body["groups"] for hit in group["hits"]]


def test_search_finds_a_company_by_ticker(loaded):
    body = search.search("AAPL", store=loaded, seeds_path=SHIPPED_SEEDS)
    hits = _flat(body)
    assert hits and hits[0]["name"].startswith("Apple")
    assert hits[0]["match"] == search.MATCH_TICKER


def test_every_share_class_finds_the_same_issuer(loaded):
    """Regression: indexing only a member's FIRST ticker made GOOGL
    unsearchable while GOOG worked."""
    first = _flat(search.search("GOOG", store=loaded, seeds_path=SHIPPED_SEEDS))
    second = _flat(search.search("GOOGL", store=loaded, seeds_path=SHIPPED_SEEDS))
    assert first and second
    assert first[0]["entity_id"] == second[0]["entity_id"]
    assert set(first[0]["tickers"]) == {"GOOG", "GOOGL"}


def test_search_finds_a_company_by_name_ignoring_legal_form(loaded):
    for query in ("Apple Inc.", "apple", "APPLE INC"):
        hits = _flat(search.search(query, store=loaded, seeds_path=SHIPPED_SEEDS))
        assert any(h["name"].startswith("Apple") for h in hits), query


def test_search_finds_a_company_by_deterministic_identifier(loaded):
    by_cik = _flat(search.search("320193", store=loaded, seeds_path=SHIPPED_SEEDS))
    assert by_cik and by_cik[0]["match"] == search.MATCH_KEY
    by_lei = _flat(search.search("529900S21EQ1BO4ESM68", store=loaded,
                                 seeds_path=SHIPPED_SEEDS))
    assert by_lei and by_lei[0]["match"] == search.MATCH_KEY


def test_results_are_grouped_by_market_in_registry_order(loaded):
    body = search.search("a", store=loaded, seeds_path=SHIPPED_SEEDS)
    order = [group["market"]["market_id"] for group in body["groups"]]
    expected = [m for m in registry.market_ids() if m in order]
    assert order == expected


def test_coverage_explains_every_market_including_the_empty_ones(loaded):
    body = search.search("zzzz-nothing-matches", store=loaded,
                         seeds_path=SHIPPED_SEEDS)
    assert body["total_hits"] == 0
    covered = dict((row["market_id"], row) for row in body["coverage"])
    assert set(covered) == set(registry.market_ids())
    for market in registry.markets_by_status(registry.STATUS_AWAITING_PROVIDER):
        row = covered[market.market_id]
        # Zero results is ambiguous unless the answer says whether we
        # looked. An empty market says why it is empty.
        assert row["searched_members"] == 0
        assert row["note"]
        assert row["addressable"] is False


def test_a_hit_is_not_held_until_a_document_lands(loaded):
    hits = _flat(search.search("AAPL", store=loaded, seeds_path=SHIPPED_SEEDS))
    assert hits[0]["held"] is False
    assert "address_ticker" not in hits[0]


def test_search_never_reaches_the_feed(loaded, monkeypatch):
    """A search box that can fetch is a fair-access hazard. If any code
    path below tried, this transport would record the call."""
    client, transport = _offline_client()
    monkeypatch.setattr(edgar, "EdgarClient", lambda *a, **k: client)
    search.search("SOMETHINGUNKNOWN", store=loaded, seeds_path=SHIPPED_SEEDS)
    assert transport.calls == []


def test_search_is_deterministic(loaded):
    first = search.search("ban", store=loaded, seeds_path=SHIPPED_SEEDS)
    second = search.search("ban", store=loaded, seeds_path=SHIPPED_SEEDS)
    assert json.dumps(first, sort_keys=True) == json.dumps(second, sort_keys=True)


def test_search_respects_the_per_market_limit(loaded):
    body = search.search("a", store=loaded, limit_per_market=3,
                         seeds_path=SHIPPED_SEEDS)
    for group in body["groups"]:
        assert group["hit_count"] <= 3
        assert group["truncated"] is (group["hit_count"] == 3)


def test_an_empty_query_matches_nothing_rather_than_everything(loaded):
    body = search.search("   ", store=loaded, seeds_path=SHIPPED_SEEDS)
    assert body["total_hits"] == 0
    assert body["groups"] == []


# ── EDGAR wired end to end (DOD2) ───────────────────────────────────


def test_resolve_on_demand_walks_ticker_to_cik_to_figures(temp_store):
    """The REAL adapter over the COMMITTED SEC bytes: ticker →
    company_tickers.json → CIK → companyfacts → envelope → store."""
    client, transport = _offline_client()
    outcome = search.resolve_on_demand("aapl", store=temp_store, client=client)

    assert outcome.ok and outcome.cached
    assert outcome.market_id == registry.market_for_source(edgar.SOURCE).market_id
    assert outcome.entity_id == model.mint_entity_id("cik", APPLE_CIK10)
    assert transport.calls == [
        edgar.TICKERS_URL,
        edgar.COMPANYFACTS_URL_TMPL.format(cik=APPLE_CIK10),
    ]

    stored = temp_store.get_by_ticker(outcome.market_id, "AAPL")
    assert stored is not None
    assert model.figure_minor(stored, "revenue") == APPLE_FY2025_REVENUE_MINOR
    assert model.figure_minor(stored, "total_assets") == APPLE_FY2025_ASSETS_MINOR
    assert model.figure_currency(stored, "revenue") == "USD"
    assert model.figure_provenance(stored, "revenue")["accession_or_version"] \
        == APPLE_ACCN_FY2025


def test_a_resolved_company_is_findable_immediately(temp_store, tmp_path):
    """A newly resolved company must not wait for the next seed
    regeneration to become searchable — the store is searched too."""
    empty_seeds = tmp_path / "no-seeds"
    empty_seeds.mkdir()
    client, _ = _offline_client()
    before = _flat(search.search("AAPL", store=temp_store,
                                 seeds_path=empty_seeds))
    assert before == []  # nothing seeded, nothing stored

    search.resolve_on_demand("AAPL", store=temp_store, client=client)
    after = _flat(search.search("AAPL", store=temp_store,
                                seeds_path=empty_seeds))
    assert after and after[0]["held"] is True
    assert after[0]["origin"] == "store"
    assert after[0]["address_ticker"] == "AAPL"


def test_an_unknown_ticker_is_a_typed_refusal_not_an_empty_result(temp_store):
    client, _ = _offline_client()
    outcome = search.resolve_on_demand("ZZZZ", store=temp_store, client=client)
    assert not outcome.ok
    assert outcome.code == search.CODE_TICKER_UNKNOWN
    assert outcome.envelope is None


def test_free_text_is_never_resolved(temp_store):
    client, transport = _offline_client()
    outcome = search.resolve_on_demand("apple computer company",
                                       store=temp_store, client=client)
    assert outcome.code == search.CODE_NOT_TICKER_SHAPED
    assert transport.calls == []


def test_the_resolvable_market_is_found_through_the_registry():
    """Not by naming a market id here — by asking which market the EDGAR
    feed serves."""
    market = search.resolvable_market()
    assert market is not None and market.is_live and not market.is_home
    assert market.fundamentals_source == edgar.SOURCE


# ── the HTTP surface ────────────────────────────────────────────────


@pytest.fixture()
def client(temp_store):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from engine.public_market.router import build_router

    app = FastAPI()
    app.include_router(build_router(store=temp_store))
    return TestClient(app, follow_redirects=False)


def test_the_aggregate_router_mounts_search():
    from fastapi import APIRouter

    from engine.public_market.router import _attach_sub_routers

    mounted = _attach_sub_routers(APIRouter())
    assert "engine.public_market.search:build_search_router" in mounted


def test_search_route_returns_grouped_results(client, temp_store):
    universe.load_all_into_store(temp_store, SHIPPED_SEEDS)
    search.reset_index()
    response = client.get("/api/public/markets/search", params={"q": "AAPL"})
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["total_hits"] >= 1
    assert body["groups"][0]["market"]["market_id"] == \
        registry.market_for_source(edgar.SOURCE).market_id


def test_search_route_refuses_an_empty_query(client):
    response = client.get("/api/public/markets/search", params={"q": "  "})
    assert response.status_code == 400
    assert response.json()["code"] == search.CODE_EMPTY_QUERY


def test_search_route_refuses_an_overlong_query(client):
    response = client.get("/api/public/markets/search",
                          params={"q": "x" * (search.MAX_QUERY_LEN + 1)})
    assert response.status_code == 400
    assert response.json()["code"] == search.CODE_QUERY_TOO_LONG


def test_universe_route_publishes_provenance_without_member_rows(client):
    response = client.get("/api/public/markets/universe")
    assert response.status_code == 200
    body = response.json()
    assert body["schema"] == universe.SEED_SCHEMA
    assert len(body["seeds"]) == len(registry.market_ids())
    for entry in body["seeds"]:
        assert "members" not in entry
        assert entry["source"]["url"] and entry["license_note"]


def test_web_resolution_is_off_unless_switched_on(client, monkeypatch):
    monkeypatch.delenv(search.ONDEMAND_ENV, raising=False)
    response = client.get("/api/public/markets/search",
                          params={"q": "ZZZZ", "resolve": "true"})
    body = response.json()["resolution"]
    assert body["attempted"] is False
    assert body["code"] == search.CODE_ONDEMAND_DISABLED
    assert search.ONDEMAND_ENV in body["detail"]


def test_web_resolution_does_not_refetch_what_is_already_known(client,
                                                               temp_store,
                                                               monkeypatch):
    monkeypatch.setenv(search.ONDEMAND_ENV, "1")
    universe.load_all_into_store(temp_store, SHIPPED_SEEDS)
    search.reset_index()
    response = client.get("/api/public/markets/search",
                          params={"q": "AAPL", "resolve": "true"})
    body = response.json()["resolution"]
    assert body["attempted"] is False
    assert body["code"] == "ALREADY_KNOWN"


def test_company_route_serves_real_figures_after_a_resolve(client, temp_store):
    """DOD2, end to end and over HTTP: a US company with REAL numbers is
    retrievable through the router, and every number names its filing."""
    edgar_client, _ = _offline_client()
    outcome = search.resolve_on_demand("AAPL", store=temp_store,
                                       client=edgar_client)
    assert outcome.ok

    response = client.get("/api/public/markets/company/us/AAPL")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == model.PUBLIC_MARKET_STATUS
    envelope = body["envelope"]
    assert envelope["version"] == model.PUBLIC_MARKET_VERSION
    assert envelope["entity_id"] == outcome.entity_id
    assert envelope["market"]["currency"] == "USD"
    assert model.figure_minor(envelope, "revenue") == APPLE_FY2025_REVENUE_MINOR
    assert model.figure_minor(envelope, "total_assets") == APPLE_FY2025_ASSETS_MINOR
    provenance = model.figure_provenance(envelope, "revenue")
    assert provenance["source"] == edgar.SOURCE
    assert provenance["accession_or_version"] == APPLE_ACCN_FY2025
    assert body["presentation"]["license_line"]


def test_the_company_route_still_refuses_a_seeded_but_unheld_company(client,
                                                                     temp_store):
    """Seeding is identity. Until a filing lands, the honest answer is
    NOT_CACHED — not an empty document, and not a zero."""
    universe.load_all_into_store(temp_store, SHIPPED_SEEDS)
    response = client.get("/api/public/markets/company/us/MMM")
    assert response.status_code == 404
    assert response.json()["code"] == "NOT_CACHED"


def test_a_store_refusal_is_reported_not_swallowed(temp_store):
    """The envelope is valid even when the cache write is refused — but
    the SERVING route only ever reads the cache, so "resolved but not
    cached" must be visible, not inferred from a boolean.

    This is not hypothetical. Re-resolving an UNCHANGED filing hits it
    today: ``model.content_hash`` covers ``provenance.fetched_at`` (a
    wall clock), so the second ingest of identical SEC bytes arrives
    with a different hash under the same accession, and the store's
    change-detection guard correctly refuses what is in fact an
    unchanged document. Reported cross-lane; surfaced here rather than
    hidden behind ``cached: false``.
    """
    client, _ = _offline_client()
    first = search.resolve_on_demand("AAPL", store=temp_store, client=client,
                                     now_fn=lambda: "2026-08-30T09:00:00Z")
    assert first.ok and first.cached and first.cache_reason is None

    # Same SEC bytes, one minute later. Nothing about the filing changed.
    second = search.resolve_on_demand("AAPL", store=temp_store, client=client,
                                      now_fn=lambda: "2026-08-30T09:01:00Z")
    assert second.ok, "the document is still valid — only the cache write failed"
    assert second.cached is False
    assert second.cache_reason and "store_error" in second.cache_reason
    assert "cache_reason" in second.to_dict()
    # The previously cached document is still served, untouched.
    assert temp_store.get_by_ticker(second.market_id, "AAPL") is not None
