# -*- coding: utf-8 -*-
"""SPINE tests — the market registry, the pm1 envelope, the store, the
serving tier, the reconcile refusal and the router.

Two things this file is careful about, both learned the hard way in this
repo:

1. **No mirror store.** Every store test drives the REAL
   ``PublicMarketStore`` against a temp-file sqlite database. A ``FakeStore``
   double is exactly what hid twenty defects behind green tests in the
   public_ro wave — including two total outages.

2. **Real bytes.** The envelope tests are built from the committed REAL
   SEC companyfacts subset (Apple), run through the REAL ``edgar``
   adapter. A hand-written "public_market envelope" fixture would test
   this lane's imagination, not the document the adapter actually emits.

The N7-STYLE GUARD lives at the bottom: it token-scans
``src/engine/public_market/**.py`` for quoted market ids and
``market_id ==`` comparisons outside ``registry.py``, so the "market
knowledge lives in one place" rule is enforced by CI rather than by
memory.
"""

from __future__ import annotations

import ast
import json
import sys
from pathlib import Path

import pytest

# Bootstrap: make `engine` importable whether or not the repo conftest
# already put src/ on sys.path.
_SRC = Path(__file__).resolve().parents[2] / "src"
if (_SRC / "engine").exists() and str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from engine.public_market import edgar, model, registry, store  # noqa: E402
from engine.public_market import esef, prices  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "public_market"
FETCHED_AT = "2026-08-29T20:53:16Z"
APPLE_CIK10 = "0000320193"
APPLE_ACCN_FY2025 = "0000320193-25-000079"

PACKAGE_DIR = Path(registry.__file__).resolve().parent


# ── helpers ─────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _fresh_registry_cache():
    registry.reset_cache()
    yield
    registry.reset_cache()


@pytest.fixture()
def apple_raw_envelope():
    """The REAL adapter's envelope built from REAL SEC bytes."""
    doc = json.loads(
        (FIXTURES / "companyfacts_CIK0000320193_truncated.json").read_text(
            encoding="utf-8")
    )
    ir = edgar.build_summary_ir(doc, fetched_at=FETCHED_AT)
    return edgar.build_envelope(ir, ticker="AAPL")


@pytest.fixture()
def apple_pm1(apple_raw_envelope):
    return model.normalize_envelope(apple_raw_envelope, registry.get_market("us"))


@pytest.fixture()
def temp_store(tmp_path):
    """The REAL store on a temp database — never a double."""
    real = store.PublicMarketStore(tmp_path / "public_market.db")
    try:
        yield real
    finally:
        real.close()


# ── registry: the data ──────────────────────────────────────────────


def test_registry_holds_the_nine_declared_markets():
    ids = registry.market_ids()
    assert set(ids) == {"ro", "us", "de", "uk", "fr", "it", "es", "cn", "ae"}


def test_ordering_is_romania_then_marquee_then_alphabetical():
    """Romania is its own group and leads; then the declared marquee
    order US, DE, UK, FR, IT, ES, CN, AE."""
    assert registry.market_ids() == (
        "ro", "us", "de", "uk", "fr", "it", "es", "cn", "ae",
    )
    assert registry.home_market().market_id == "ro"
    assert [m.market_id for m in registry.marquee_markets()] == [
        "us", "de", "uk", "fr", "it", "es", "cn", "ae",
    ]


def test_home_market_is_its_own_group_not_marquee_position_zero():
    home = registry.home_market()
    assert home.group == registry.HOME_GROUP
    assert home.is_home is True
    assert home.is_marquee is False


def test_rest_group_sorts_alphabetically_by_display_name(tmp_path):
    """A market with no marquee_rank lands after the marquee, A→Z."""
    path = tmp_path / "markets.yaml"
    path.write_text(
        "schema: public_market_registry_v1\n"
        "markets:\n"
        + _yaml_entry("ro", "Romania", 0, "live", "public_ro", "annual_dataset")
        + _yaml_entry("zz", "Zanzibar", None, "awaiting_provider", "none", "none")
        + _yaml_entry("aa", "Andorra", None, "awaiting_provider", "none", "none")
        + _yaml_entry("us", "United States", 1, "live", "sec_edgar_companyfacts",
                      "on_filing"),
        encoding="utf-8",
    )
    ids = [m.market_id for m in registry.ordered_markets(path)]
    assert ids == ["ro", "us", "aa", "zz"]


def _yaml_entry(market_id, name, rank, status, fundamentals, cadence):
    return (
        "  - market_id: %s\n"
        "    display_name: %s\n"
        "    exchanges: [X]\n"
        "    currency: EUR\n"
        "    accounting_standard: IFRS\n"
        "    price_source: none\n"
        "    fundamentals_source: %s\n"
        "    refresh_cadence: %s\n"
        "    license_notes: n/a\n"
        "    marquee_rank: %s\n"
        "    status: %s\n"
        % (market_id, name, fundamentals, cadence,
           "null" if rank is None else rank, status)
    )


# ── registry: the honesty invariants ────────────────────────────────


def test_us_is_live_and_the_only_live_marquee_market():
    """EDGAR resolves a ticker end to end; nothing else does yet."""
    assert registry.get_market("us").status == registry.STATUS_LIVE
    live_marquee = [m.market_id for m in registry.marquee_markets() if m.is_live]
    assert live_marquee == ["us"]


def test_de_is_awaiting_provider_because_the_source_says_it_has_no_data():
    """filings.xbrl.org documents Germany as MISSING — so DE cannot claim
    fundamentals_only, which would imply figures exist somewhere."""
    assert "DE" in esef.COVERAGE_GAPS
    assert registry.get_market("de").status == registry.STATUS_AWAITING_PROVIDER
    assert registry.get_market("de").fundamentals_source == registry.SOURCE_NONE


def test_esef_markets_are_fundamentals_only_not_live():
    """The extractor works, but there is no ticker→filing resolution, so
    /company/{market}/{ticker} cannot be served. Claiming `live` would be
    a promise the code cannot keep."""
    for market_id in ("uk", "fr", "it", "es"):
        market = registry.get_market(market_id)
        assert market.status == registry.STATUS_FUNDAMENTALS_ONLY, market_id
        assert market.fundamentals_source == esef.SOURCE_NAME, market_id


def test_provider_markets_declare_no_feed():
    for market_id in ("cn", "ae"):
        market = registry.get_market(market_id)
        assert market.status == registry.STATUS_AWAITING_PROVIDER
        assert market.fundamentals_source == registry.SOURCE_NONE
        assert market.refresh_cadence == "none"


def test_license_notes_are_verbatim_from_the_adapters():
    """The registry copies each source's terms; a test locks the two
    copies together so an edit to one is caught rather than diverging."""
    assert registry.get_market("fr").license_notes == esef.TERMS_OF_USE_LINE
    assert registry.get_market("uk").license_notes == esef.TERMS_OF_USE_LINE
    for market_id in ("cn", "ae", "de"):
        assert registry.get_market(market_id).license_notes == \
            prices.MARKET_REGISTRY["US"]["license_notes"]
    us_notes = registry.get_market("us").license_notes
    assert "10 requests/second" in us_notes
    assert "declare your user agent" in us_notes


def test_fundamentals_sources_match_the_adapters_own_constants():
    assert registry.get_market("us").fundamentals_source == edgar.SOURCE
    assert registry.get_market("fr").fundamentals_source == esef.SOURCE_NAME


def test_market_for_source_refuses_to_guess_when_ambiguous():
    """One feed serving four markets must not silently pick one."""
    assert registry.market_for_source(edgar.SOURCE).market_id == "us"
    assert registry.market_for_source(esef.SOURCE_NAME) is None
    assert registry.market_for_source(None) is None
    assert registry.market_for_source("none") is None


def test_unknown_market_raises_rather_than_defaulting():
    with pytest.raises(registry.UnknownMarket):
        registry.get_market("xx")
    assert registry.find_market("xx") is None


# ── registry: validation fails loud ─────────────────────────────────


def _write(tmp_path, body):
    path = tmp_path / "markets.yaml"
    path.write_text(body, encoding="utf-8")
    return path


def test_status_live_without_a_feed_is_rejected(tmp_path):
    path = _write(
        tmp_path,
        "schema: public_market_registry_v1\nmarkets:\n"
        + _yaml_entry("ro", "Romania", 0, "live", "public_ro", "annual_dataset")
        + _yaml_entry("xx", "Nowhere", 1, "live", "none", "on_filing"),
    )
    with pytest.raises(registry.RegistryError) as excinfo:
        registry.load_markets(path)
    assert "cannot claim figures" in str(excinfo.value)


def test_awaiting_provider_that_names_a_feed_is_rejected(tmp_path):
    path = _write(
        tmp_path,
        "schema: public_market_registry_v1\nmarkets:\n"
        + _yaml_entry("ro", "Romania", 0, "live", "public_ro", "annual_dataset")
        + _yaml_entry("xx", "Nowhere", 1, "awaiting_provider", "some_feed", "none"),
    )
    with pytest.raises(registry.RegistryError):
        registry.load_markets(path)


def test_duplicate_marquee_rank_is_rejected(tmp_path):
    path = _write(
        tmp_path,
        "schema: public_market_registry_v1\nmarkets:\n"
        + _yaml_entry("ro", "Romania", 0, "live", "public_ro", "annual_dataset")
        + _yaml_entry("aa", "A", 1, "awaiting_provider", "none", "none")
        + _yaml_entry("bb", "B", 1, "awaiting_provider", "none", "none"),
    )
    with pytest.raises(registry.RegistryError) as excinfo:
        registry.load_markets(path)
    assert "marquee_rank" in str(excinfo.value)


def test_registry_without_a_home_market_is_rejected(tmp_path):
    path = _write(
        tmp_path,
        "schema: public_market_registry_v1\nmarkets:\n"
        + _yaml_entry("us", "United States", 1, "live",
                      "sec_edgar_companyfacts", "on_filing"),
    )
    with pytest.raises(registry.RegistryError) as excinfo:
        registry.load_markets(path)
    assert "home market" in str(excinfo.value)


def test_unknown_field_is_rejected(tmp_path):
    path = _write(
        tmp_path,
        "schema: public_market_registry_v1\nmarkets:\n"
        + _yaml_entry("ro", "Romania", 0, "live", "public_ro", "annual_dataset")
        + "    surprise: yes\n",
    )
    with pytest.raises(registry.RegistryError) as excinfo:
        registry.load_markets(path)
    assert "unknown field" in str(excinfo.value)


# ── model: the pm1 envelope over REAL adapter output ────────────────


def test_normalize_is_additive_over_the_real_edgar_envelope(apple_raw_envelope):
    """Every key the adapter wrote survives verbatim; the spine only
    ADDS. This is the contract that lets the adapter stay untouched."""
    pm1 = model.normalize_envelope(apple_raw_envelope, registry.get_market("us"))
    for key, value in apple_raw_envelope.items():
        if key in ("figures", "provenance", "status", "doc_class"):
            continue  # provenance gains a derived key; status/doc_class equal
        assert pm1[key] == value, key
    assert pm1["status"] == apple_raw_envelope["status"] == "PUBLIC_MARKET"
    assert pm1["doc_class"] == apple_raw_envelope["doc_class"] == "public_market"
    for name, figure in apple_raw_envelope["figures"].items():
        for fkey, fvalue in figure.items():
            if fkey == "provenance":
                continue
            assert pm1["figures"][name][fkey] == fvalue, (name, fkey)


def test_normalize_adds_only_the_spine_keys(apple_raw_envelope):
    pm1 = model.normalize_envelope(apple_raw_envelope, registry.get_market("us"))
    added = set(pm1) - set(apple_raw_envelope)
    assert added == {"version", "entity_id", "market_id", "market", "content_hash"}


def test_pm1_validates_and_carries_full_provenance(apple_pm1):
    assert model.validate_envelope(apple_pm1) == []
    view = model.figure_provenance(apple_pm1, "revenue")
    assert set(view) == set(model.PROVENANCE_KEYS)
    assert view["source"] == edgar.SOURCE
    assert view["accession_or_version"] == APPLE_ACCN_FY2025
    assert view["as_of"] and view["fetched_at"]


def test_figures_are_integer_minor_units_and_counts_stay_counts(apple_pm1):
    revenue = model.figure_minor(apple_pm1, "revenue")
    assert isinstance(revenue, int)
    assert revenue == 416161000000 * 100  # USD -> cents, exactly
    # A share COUNT must never come back through the money accessor.
    assert model.figure_minor(apple_pm1, "shares_outstanding") is None
    assert isinstance(model.figure_count(apple_pm1, "shares_outstanding"), int)


def test_absent_figure_is_none_never_zero(apple_pm1):
    assert "cash_and_equivalents" not in apple_pm1["figures"]
    assert model.figure_minor(apple_pm1, "cash_and_equivalents") is None
    assert model.figure(apple_pm1, "cash_and_equivalents") is None


def test_price_key_is_omitted_not_nulled_in_keyless_mode(apple_raw_envelope):
    """prices.price_block returns None with no key; the envelope must
    then have NO price key at all — a null would be a claim."""
    assert prices.price_block("AAPL", "US", env={}) is None
    pm1 = model.normalize_envelope(apple_raw_envelope, registry.get_market("us"),
                                   price=None)
    assert "price" not in pm1


def test_price_block_is_carried_when_present(apple_raw_envelope):
    block = {"price_minor": 21050, "currency": "USD", "as_of": "2026-08-28",
             "delay_note": "End-of-day close"}
    pm1 = model.normalize_envelope(apple_raw_envelope, registry.get_market("us"),
                                   price=block)
    assert pm1["price"] == block
    assert model.validate_envelope(pm1) == []


def test_content_hash_is_deterministic_and_ignores_cache_meta(apple_raw_envelope):
    first = model.normalize_envelope(apple_raw_envelope, registry.get_market("us"))
    second = model.normalize_envelope(apple_raw_envelope, registry.get_market("us"))
    assert first["content_hash"] == second["content_hash"]
    # meta is cache bookkeeping, not content: flipping it must not
    # produce a new document identity.
    mutated = dict(first)
    mutated["meta"] = {"cached": True, "cache_reason": None}
    assert model.content_hash(mutated) == model.content_hash(first)
    # ...but a real figure change MUST move the hash.
    changed = json.loads(json.dumps(first))
    changed["figures"]["revenue"]["value_minor"] += 1
    assert model.content_hash(changed) != model.content_hash(first)


def test_stamping_is_idempotent(apple_pm1):
    again = model.stamp_content_hash(apple_pm1)
    assert again["content_hash"] == apple_pm1["content_hash"]


def test_normalize_refuses_a_document_without_a_deterministic_key(apple_raw_envelope):
    stripped = json.loads(json.dumps(apple_raw_envelope))
    stripped["entity"].pop("cik")
    stripped["entity"].pop("cik_int", None)
    with pytest.raises(model.ModelError) as excinfo:
        model.normalize_envelope(stripped, registry.get_market("us"))
    assert "deterministic entity key" in str(excinfo.value)


def test_normalize_refuses_to_relabel_another_document_class(apple_raw_envelope):
    foreign = json.loads(json.dumps(apple_raw_envelope))
    foreign["status"] = "BALANCED"
    with pytest.raises(model.ModelError):
        model.normalize_envelope(foreign, registry.get_market("us"))


def test_entity_id_is_stable_across_runs_and_machines(apple_pm1):
    assert apple_pm1["entity_id"] == model.mint_entity_id("cik", APPLE_CIK10)
    assert apple_pm1["entity_id"] == model.mint_entity_id("cik", "320193")


def test_validator_catches_a_figure_with_no_provenance(apple_pm1):
    broken = json.loads(json.dumps(apple_pm1))
    broken["figures"]["revenue"].pop("provenance")
    problems = model.validate_envelope(broken)
    assert any("no provenance" in p for p in problems)


def test_validator_catches_a_tampered_content_hash(apple_pm1):
    broken = json.loads(json.dumps(apple_pm1))
    broken["figures"]["revenue"]["value_minor"] += 1
    problems = model.validate_envelope(broken)
    assert any("content_hash does not match" in p for p in problems)


# ── store: the REAL sqlite store, never a double ────────────────────


def test_store_roundtrip_through_the_documented_adapter_contract(
        temp_store, apple_raw_envelope):
    entity_id = temp_store.put(apple_raw_envelope)
    assert entity_id.startswith("pme-")
    # edgar._discover_store's documented interface: get(cik) -> envelope
    fetched = temp_store.get(APPLE_CIK10)
    assert fetched is not None
    assert fetched["entity_id"] == entity_id
    assert fetched["market_id"] == "us"
    # Zero-padding tolerance: the SEC writes the CIK both ways.
    assert temp_store.get("320193")["entity_id"] == entity_id


def test_store_resolves_the_market_from_the_registry_not_a_branch(
        temp_store, apple_raw_envelope):
    temp_store.put(apple_raw_envelope)
    assert temp_store.market_counts() == {"us": 1}
    assert temp_store.get_by_ticker("us", "aapl")["entity_id"] == \
        temp_store.get_by_ticker("us", "AAPL")["entity_id"]


def test_store_refuses_an_ambiguous_source_and_queues_it(temp_store,
                                                         apple_raw_envelope):
    """filings.xbrl.org feeds four markets: the store must be TOLD which
    one, never pick the first."""
    ambiguous = json.loads(json.dumps(apple_raw_envelope))
    ambiguous["provenance"]["source"] = esef.SOURCE_NAME
    with pytest.raises(store.StoreError):
        temp_store.put(ambiguous)
    queued = temp_store.review_queue()
    assert queued and queued[0]["reason"] == store.REASON_AMBIGUOUS_MARKET
    # With the market named explicitly it stores fine.
    assert temp_store.put(ambiguous, market_id="fr").startswith("pme-")


def test_store_is_idempotent_on_re_ingest(temp_store, apple_raw_envelope):
    entity_id = temp_store.put(apple_raw_envelope)
    temp_store.put(apple_raw_envelope)
    filings = temp_store.filings_for(entity_id)
    assert len(filings) == 1
    assert filings[0]["accession_or_version"] == APPLE_ACCN_FY2025


def test_store_refuses_to_silently_change_a_stored_accession(
        temp_store, apple_raw_envelope):
    """Same accession, different bytes = restatement or bug. A human
    decides; the served page keeps the numbers it already had."""
    temp_store.put(apple_raw_envelope)
    tampered = json.loads(json.dumps(apple_raw_envelope))
    tampered["figures"]["revenue"]["value_minor"] += 100
    with pytest.raises(store.StoreError):
        temp_store.put(tampered)
    reasons = [row["reason"] for row in temp_store.review_queue()]
    assert store.REASON_CONTENT_CHANGED in reasons


def test_store_writes_per_figure_provenance(temp_store, apple_raw_envelope):
    entity_id = temp_store.put(apple_raw_envelope)
    rows = {row["figure"]: row for row in temp_store.provenance_for(entity_id)}
    assert set(rows) == set(apple_raw_envelope["figures"])
    assert rows["revenue"]["source"] == edgar.SOURCE
    assert rows["revenue"]["accession_or_version"] == APPLE_ACCN_FY2025


def test_store_refuses_an_invalid_envelope_and_records_why(temp_store, apple_pm1):
    broken = json.loads(json.dumps(apple_pm1))
    broken["figures"]["revenue"].pop("provenance")
    with pytest.raises(store.StoreError):
        temp_store.put_filing(broken)
    reasons = [row["reason"] for row in temp_store.review_queue()]
    assert store.REASON_INVALID_ENVELOPE in reasons


def test_store_refuses_an_undated_or_float_price(temp_store, apple_raw_envelope):
    entity_id = temp_store.put(apple_raw_envelope)
    with pytest.raises(store.StoreError):
        temp_store.put_price(entity_id, {"price_minor": 1, "currency": "USD"})
    with pytest.raises(store.StoreError):
        temp_store.put_price(entity_id, {"price_minor": 210.5, "currency": "USD",
                                         "as_of": "2026-08-28"})
    assert temp_store.latest_price(entity_id) is None  # absence, not zero


def test_store_price_roundtrip(temp_store, apple_raw_envelope):
    entity_id = temp_store.put(apple_raw_envelope)
    temp_store.put_price(entity_id, {
        "price_minor": 21050, "currency": "USD", "as_of": "2026-08-28",
        "delay_note": "End-of-day close", "cadence": "eod", "stale": False,
    }, market_id="us")
    latest = temp_store.latest_price(entity_id)
    assert latest["price_minor"] == 21050
    assert latest["stale"] is False


def test_latest_filing_orders_by_as_of_not_insertion(temp_store, apple_raw_envelope):
    """Re-ingesting an OLD filing after a new one must not make the old
    one 'latest'."""
    new = temp_store.put(apple_raw_envelope)
    older = json.loads(json.dumps(apple_raw_envelope))
    older["provenance"]["as_of"] = "2019-09-28"
    older["provenance"]["accession"] = "0000320193-19-000119"
    older["provenance"]["dataset_version"] = "0000320193-19-000119"
    temp_store.put(older)
    assert len(temp_store.filings_for(new)) == 2
    assert temp_store.latest_filing(new)["provenance"]["as_of"] == "2025-09-27"


def test_env_overrides_the_database_path(tmp_path, monkeypatch):
    target = tmp_path / "elsewhere.db"
    monkeypatch.setenv(store.DB_ENV, str(target))
    assert store.default_db_path() == target


# ── serving tier ────────────────────────────────────────────────────


def test_gateway_resolves_a_pm1_envelope_to_the_market_tier(apple_pm1):
    from engine.serving import FactsGateway

    gateway = FactsGateway.from_envelope(apple_pm1)
    assert gateway is not None
    assert gateway.tier == FactsGateway.TIER_MARKET
    # The DOCUMENT's currency wins over the caller's display default.
    assert FactsGateway.from_envelope(apple_pm1, currency="RON")._currency == "USD"


def test_market_tier_serves_the_totals_the_feed_published(apple_pm1):
    from engine.serving import FactsGateway, MissingFactError

    gateway = FactsGateway.from_envelope(apple_pm1)
    assert gateway.total_assets().amount_minor == 359241000000 * 100
    assert gateway.equity().amount_minor == 73733000000 * 100
    assert gateway.net_result().amount_minor == 112010000000 * 100
    assert gateway.revenue().amount_minor == 416161000000 * 100
    # ...and refuses the ones it did NOT publish, rather than deriving
    # liabilities as assets − equity.
    with pytest.raises(MissingFactError):
        gateway.total_liabilities()
    with pytest.raises(MissingFactError):
        gateway.expenses()
    with pytest.raises(MissingFactError):
        gateway.working_capital()


def test_market_cap_is_exact_integer_arithmetic(apple_raw_envelope):
    from engine.serving import FactsGateway

    pm1 = model.normalize_envelope(
        apple_raw_envelope, registry.get_market("us"),
        price={"price_minor": 21050, "currency": "USD", "as_of": "2026-08-28",
               "delay_note": "End-of-day close"},
    )
    gateway = FactsGateway.from_envelope(pm1)
    shares = model.figure_count(pm1, "shares_outstanding")
    assert gateway.market_price().amount_minor == 21050
    assert gateway.market_cap().amount_minor == 21050 * shares


def test_price_absence_is_a_typed_refusal_not_a_zero(apple_pm1):
    from engine.serving import FactsGateway, MarketRefusal

    gateway = FactsGateway.from_envelope(apple_pm1)
    price = gateway.market_price()
    assert isinstance(price, MarketRefusal)
    assert price.code == "price_absent"
    # ...and it propagates: no price, no market cap, no P/E.
    assert isinstance(gateway.market_cap(), MarketRefusal)
    assert isinstance(gateway.pe(), MarketRefusal)


def test_enterprise_value_refuses_because_cash_is_absent(apple_raw_envelope):
    """EDGAR companyfacts carries no cash figure. Treating that absence
    as zero would overstate EV by the entire cash balance."""
    from engine.serving import FactsGateway, MarketRefusal

    pm1 = model.normalize_envelope(
        apple_raw_envelope, registry.get_market("us"),
        price={"price_minor": 21050, "currency": "USD", "as_of": "2026-08-28",
               "delay_note": "End-of-day close"},
    )
    gateway = FactsGateway.from_envelope(pm1)
    ev = gateway.enterprise_value()
    assert isinstance(ev, MarketRefusal)
    assert ev.code == "input_absent"
    assert "cash_and_equivalents" in ev.missing
    assert isinstance(gateway.ev_ebitda(), MarketRefusal)


def test_enterprise_value_computes_once_every_leg_is_present(apple_raw_envelope):
    from engine.serving import FactsGateway

    enriched = json.loads(json.dumps(apple_raw_envelope))
    enriched["figures"]["cash_and_equivalents"] = {
        "value_minor": 3000000000 * 100, "currency": "USD", "minor_unit": "cent",
        "fiscal": {"fy": 2025, "fp": "FY", "start": None, "end": "2025-09-27"},
        "provenance": {"source": edgar.SOURCE, "accession": APPLE_ACCN_FY2025,
                       "dataset_version": APPLE_ACCN_FY2025,
                       "as_of": "2025-09-27", "fetched_at": FETCHED_AT},
    }
    pm1 = model.normalize_envelope(
        enriched, registry.get_market("us"),
        price={"price_minor": 21050, "currency": "USD", "as_of": "2026-08-28",
               "delay_note": "End-of-day close"},
    )
    gateway = FactsGateway.from_envelope(pm1)
    cap = gateway.market_cap().amount_minor
    debt = model.figure_minor(pm1, "total_debt")
    assert gateway.enterprise_value().amount_minor == \
        cap + debt - 3000000000 * 100


def test_pe_is_an_exact_pair_and_refuses_a_loss(apple_raw_envelope):
    from engine.serving import FactsGateway, MarketRatio, MarketRefusal

    priced = model.normalize_envelope(
        apple_raw_envelope, registry.get_market("us"),
        price={"price_minor": 21050, "currency": "USD", "as_of": "2026-08-28",
               "delay_note": "End-of-day close"},
    )
    gateway = FactsGateway.from_envelope(priced)
    ratio = gateway.pe()
    assert isinstance(ratio, MarketRatio)
    assert ratio.denominator_minor == 112010000000 * 100
    assert ratio.to_float() == ratio.numerator_minor / float(ratio.denominator_minor)

    loss = json.loads(json.dumps(apple_raw_envelope))
    loss["figures"]["net_income"]["value_minor"] = -100
    loss_pm1 = model.normalize_envelope(
        loss, registry.get_market("us"),
        price={"price_minor": 21050, "currency": "USD", "as_of": "2026-08-28",
               "delay_note": "End-of-day close"},
    )
    refused = FactsGateway.from_envelope(loss_pm1).pe()
    assert isinstance(refused, MarketRefusal)
    assert refused.code == "non_positive_denominator"


def test_currency_mismatch_is_refused(apple_raw_envelope):
    from engine.serving import FactsGateway, MarketRefusal

    mixed = json.loads(json.dumps(apple_raw_envelope))
    mixed["figures"]["net_income"]["currency"] = "EUR"
    pm1 = model.normalize_envelope(
        mixed, registry.get_market("us"),
        price={"price_minor": 21050, "currency": "USD", "as_of": "2026-08-28",
               "delay_note": "End-of-day close"},
    )
    refused = FactsGateway.from_envelope(pm1).pe()
    assert isinstance(refused, MarketRefusal)
    assert refused.code == "currency_mismatch"


def test_market_refusals_carry_no_number(apple_pm1):
    from engine.serving import FactsGateway

    gateway = FactsGateway.from_envelope(apple_pm1)
    for refusal in gateway.market_refusals():
        for value in vars(refusal).values():
            assert not isinstance(value, (int, float)) or isinstance(value, bool)


def test_market_metrics_covers_every_metric_in_render_order(apple_pm1):
    from engine.serving import FactsGateway

    metrics = FactsGateway.from_envelope(apple_pm1).market_metrics()
    assert list(metrics) == ["price", "market_cap", "enterprise_value",
                            "pe", "ev_ebitda"]


def test_locked_ratios_stay_empty_on_the_market_tier(apple_pm1):
    from engine.serving import FactsGateway

    assert FactsGateway.from_envelope(apple_pm1).locked_ratios() == []


def test_market_accessors_refuse_on_every_other_tier():
    """A paywall/refusal card must never appear where the concept simply
    was never served."""
    from engine.serving import FactsGateway, MissingFactError

    legacy = {
        "methodology": {"totals": {"total_assets": 10.0, "total_liabilities": 4.0,
                                   "total_equity": 6.0}},
        "provenance": {"content_hash": "abc"},
    }
    gateway = FactsGateway.from_envelope(legacy)
    assert gateway.tier == FactsGateway.TIER_METHODOLOGY
    for accessor in ("market_price", "market_cap", "enterprise_value",
                     "pe", "ev_ebitda"):
        with pytest.raises(MissingFactError):
            getattr(gateway, accessor)()
    assert gateway.market_metrics() == {}


def test_presenter_is_pure_and_names_the_licence(apple_pm1):
    from engine.serving import present_public_market

    before = json.dumps(apple_pm1, sort_keys=True)
    presentation = present_public_market(apple_pm1)
    assert json.dumps(apple_pm1, sort_keys=True) == before  # never mutates
    assert presentation["status"] == "PUBLIC_MARKET"
    assert presentation["market_id"] == "us"
    assert presentation["currency"] == "USD"
    assert presentation["license_line"] == registry.get_market("us").license_notes
    # Keyless: the missing price is SAID, not left blank.
    assert "No licensed price feed" in presentation["price_line_en"]
    assert presentation["delay_note"] is None


def test_presenter_returns_none_for_a_foreign_document():
    from engine.serving import present_public_market

    assert present_public_market({"canonical_bs": {"totals": {}}}) is None
    assert present_public_market(None) is None


# ── reconcile: the sibling refusal ──────────────────────────────────


def test_reconcile_refuses_a_public_market_envelope(apple_pm1):
    from engine.api import _reconcile

    assert _reconcile.is_public_market_envelope(apple_pm1) is True
    with pytest.raises(_reconcile.ReconcileRejected) as excinfo:
        _reconcile.perform_reconcile(apple_pm1, user_id="u1")
    codes = [d["code"] for d in excinfo.value.payload["diagnosis"]]
    assert codes == ["PUBLIC_MARKET"]


def test_auto_reconcile_refuses_a_public_market_envelope(apple_pm1):
    from engine.api import _reconcile

    assert _reconcile.auto_reconcile_envelope(apple_pm1) == {
        "outcome": "public_market_refused"
    }


def test_reconcile_refusal_survives_an_attached_canonical_bs(apple_pm1):
    """Document class FIRST — the refusal must not evaporate the day a
    canonical_bs-shaped block is attached for convenience."""
    from engine.api import _reconcile

    dressed = json.loads(json.dumps(apple_pm1))
    dressed["canonical_bs"] = {
        "totals": {"assets": 1.0, "equity": 1.0, "liabilities": 0.0},
        "status": "MINOR_DRIFT", "difference": 0.01,
    }
    assert _reconcile.is_public_market_envelope(dressed) is True
    assert _reconcile.auto_reconcile_envelope(dressed)["outcome"] == \
        "public_market_refused"
    with pytest.raises(_reconcile.ReconcileRejected):
        _reconcile.perform_reconcile(dressed, user_id="u1")


def test_the_three_structural_probes_agree(apple_pm1):
    """model / serving / reconcile each keep their own literal copy of
    the pm1 probe (so neither package needs to import the others). This
    test is what stops the three copies from drifting."""
    from engine.api import _reconcile
    from engine.serving.facts import FactsGateway

    for candidate in (apple_pm1, {"doc_class": "public_market"}, {}, None,
                      {"doc_class": "public_market", "status": "PUBLIC_MARKET",
                       "figures": {}},
                      {"doc_class": "public_market", "status": "PUBLIC_MARKET",
                       "figures": []}):
        expected = model.is_public_market_envelope(candidate)
        assert _reconcile.is_public_market_envelope(candidate) is expected
        assert FactsGateway._is_market_envelope(candidate) is expected


def test_public_summary_refusal_is_untouched():
    """The PM guard is additive: the PS1 seam must behave exactly as it
    did before."""
    from engine.api import _reconcile

    summary = {"public_summary": {"indicators": {"I13": 1}}}
    assert _reconcile.auto_reconcile_envelope(summary) == {
        "outcome": "public_summary_refused"
    }


# ── router ──────────────────────────────────────────────────────────


@pytest.fixture()
def client(temp_store):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from engine.public_market.router import build_router

    app = FastAPI()
    app.include_router(build_router(store=temp_store))
    # follow_redirects=False on purpose: a route under test must be
    # judged by ITS status, not by whatever it redirects to.
    return TestClient(app, follow_redirects=False)


def test_markets_route_lists_the_registry_in_display_order(client):
    response = client.get("/api/public/markets")
    assert response.status_code == 200
    body = response.json()
    assert [m["market_id"] for m in body["markets"]] == [
        "ro", "us", "de", "uk", "fr", "it", "es", "cn", "ae",
    ]
    assert body["markets"][0]["group"] == "romania"
    assert body["counts"]["live"] == 2  # ro (public_ro) + us (EDGAR)
    assert all("entities_held" in m for m in body["markets"])


def test_markets_route_has_no_redirecting_twin(client):
    assert client.get("/api/public/markets/").status_code == 200


def test_company_route_serves_a_live_market(client, temp_store,
                                            apple_raw_envelope):
    temp_store.put(apple_raw_envelope)
    response = client.get("/api/public/markets/company/us/AAPL")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "PUBLIC_MARKET"
    assert body["envelope"]["entity_id"].startswith("pme-")
    assert body["presentation"]["license_line"]
    assert body["market"]["status"] == "live"


def test_company_route_404s_a_live_market_miss_without_fetching(client):
    """The serving route READS the store; it never calls SEC per page
    view. The refusal says so."""
    response = client.get("/api/public/markets/company/us/NOSUCHTICKER")
    assert response.status_code == 404
    assert response.json()["code"] == "NOT_CACHED"


def test_company_route_refuses_a_fundamentals_only_market(client):
    response = client.get("/api/public/markets/company/fr/DUPONT")
    assert response.status_code == 501
    body = response.json()
    assert body["code"] == "MARKET_NOT_ADDRESSABLE"
    assert esef.SOURCE_NAME in body["detail"]


def test_company_route_refuses_a_market_with_no_feed(client):
    response = client.get("/api/public/markets/company/cn/600519")
    assert response.status_code == 501
    assert response.json()["code"] == "MARKET_AWAITING_PROVIDER"


def test_company_route_refuses_the_home_market(client):
    """PM7: BVB is served by public_ro. Two document classes answering
    for one company is two numbers."""
    response = client.get("/api/public/markets/company/ro/TLV")
    assert response.status_code == 404
    assert response.json()["code"] == "HOME_MARKET_SERVED_ELSEWHERE"


def test_company_route_never_substitutes_a_default_market(client):
    response = client.get("/api/public/markets/company/xx/AAPL")
    assert response.status_code == 404
    body = response.json()
    assert body["code"] == "UNKNOWN_MARKET"
    assert "ro" in body["known_markets"]


def test_router_mounts_with_no_sibling_lanes_present():
    """try/except ImportError: a half-landed wave still mounts."""
    from engine.public_market.router import _attach_sub_routers
    from fastapi import APIRouter

    mounted = _attach_sub_routers(APIRouter())
    assert isinstance(mounted, list)  # zero or more; never an exception


def test_server_mounts_the_market_router():
    """The route must actually exist on the built app — a router that
    only mounts in a test harness is a router nobody serves."""
    from engine.api import server as server_module

    source = Path(server_module.__file__).read_text(encoding="utf-8")
    assert "engine.public_market.router" in source
    assert "build_router as _public_market_router" in source


# ── N7-STYLE GUARD: market ids live in registry.py, and nowhere else ─

#: MODULE-LEVEL CONSTANTS allowed to hold a string that happens to match
#: a market id, each with the REASON it is legitimate. Keyed by
#: (module file, constant name) so the exemption is as narrow as the
#: fact that earns it — allowlisting a whole FILE would let a future
#: `market_id == "us"` slip in beside a legitimate lookup table.
#: An entry without a written reason is not an entry.
MARKET_LITERAL_ALLOWLIST = {
    ("prices.py", "MARKET_REGISTRY"): (
        "ISO-3166 country codes keying the price cadence + delay-label table; "
        "predates the registry and prices.py's own docstring flags it as a "
        "cross-lane merge point (price_block accepts an injected registry "
        "unchanged, so the spine can supply this table later)"
    ),
    ("providers.py", "_SLOT_MARKETS"): (
        "the licensed PROVIDER's advertised coverage — a fact about the "
        "vendor's contract, not a claim about our registry"
    ),
    ("esef.py", "COVERAGE_GAPS"): (
        "country codes quoted from filings.xbrl.org's own 'Missing data' "
        "list; changing them would misquote the source"
    ),
    ("entity.py", "_NFKD_RESISTANT"): (
        "a transliteration table: 'ae' here is the expansion of the letter "
        "ligature 'ae', not a market id — an accidental collision between a "
        "Nordic orthography rule and an ISO country code"
    ),
}

#: Files exempt wholesale, with the reason.
MARKET_LITERAL_EXEMPT_FILES = {
    "registry.py": "the registry IS the authority — it validates and serves the ids",
}

#: The ids the guard hunts for, drawn from the registry itself so a new
#: market automatically comes under the guard.
_GUARDED_IDS = None


def _guarded_ids():
    global _GUARDED_IDS
    if _GUARDED_IDS is None:
        _GUARDED_IDS = frozenset(registry.market_ids())
    return _GUARDED_IDS


def _package_python_files():
    for path in sorted(PACKAGE_DIR.rglob("*.py")):
        yield path


def _docstring_nodes(tree):
    """Every string-literal node that is a docstring or a bare string
    expression (comments-in-disguise), so prose never trips the guard."""
    out = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) \
                and isinstance(node.value.value, str):
            out.add(id(node.value))
    return out


def _module_constant_owner(tree):
    """{id(string node) -> module-level constant name} so the guard can
    exempt one TABLE rather than a whole file."""
    owners = {}
    for node in tree.body:
        targets = []
        if isinstance(node, ast.Assign):
            targets = [t for t in node.targets if isinstance(t, ast.Name)]
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) \
                and node.value is not None:
            targets = [node.target]
        if not targets:
            continue
        name = targets[0].id
        value = node.value
        if value is None:
            continue
        for child in ast.walk(value):
            if isinstance(child, ast.Constant) and isinstance(child.value, str):
                owners[id(child)] = name
    return owners


def test_n7_guard_no_quoted_market_ids_outside_the_registry():
    """Market knowledge lives in markets.yaml, read through registry.py.
    A quoted market id anywhere else is the first vertebra of the
    if/elif ladder this wave exists to avoid."""
    ids = _guarded_ids()
    violations = []
    for path in _package_python_files():
        rel = str(path.relative_to(PACKAGE_DIR))
        if rel in MARKET_LITERAL_EXEMPT_FILES:
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        prose = _docstring_nodes(tree)
        owners = _module_constant_owner(tree)
        for node in ast.walk(tree):
            if not isinstance(node, ast.Constant) or not isinstance(node.value, str):
                continue
            if id(node) in prose:
                continue
            if node.value.strip().lower() not in ids:
                continue
            owner = owners.get(id(node))
            if owner is not None and (rel, owner) in MARKET_LITERAL_ALLOWLIST:
                continue
            violations.append("%s:%d quotes market id %r%s"
                              % (rel, node.lineno, node.value,
                                 "" if owner is None else " (in %s)" % owner))
    assert not violations, (
        "N7 violation — market ids belong in markets.yaml, reached through "
        "registry.py:\n" + "\n".join(violations)
    )


def test_n7_guard_no_market_id_comparisons_outside_the_registry():
    """`market_id == "us"` is the same ladder wearing a different hat."""
    violations = []
    for path in _package_python_files():
        rel = str(path.relative_to(PACKAGE_DIR))
        if rel in MARKET_LITERAL_EXEMPT_FILES:
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Compare):
                continue
            operands = [node.left] + list(node.comparators)
            names = []
            for operand in operands:
                if isinstance(operand, ast.Name):
                    names.append(operand.id)
                elif isinstance(operand, ast.Attribute):
                    names.append(operand.attr)
                elif isinstance(operand, ast.Subscript) and \
                        isinstance(operand.slice, ast.Constant):
                    names.append(str(operand.slice.value))
            # Only a comparison against a STRING is id branching. Testing
            # a resolved Market object for None is not — it is the
            # registry lookup failing, which is exactly what should
            # happen instead of a branch.
            has_string = any(
                isinstance(operand, ast.Constant) and isinstance(operand.value, str)
                for operand in operands
            )
            if has_string and any(n in ("market_id", "market") for n in names):
                violations.append("%s:%d compares market_id/market against a "
                                  "string literal" % (rel, node.lineno))
    assert not violations, (
        "N7 violation — branch on registry STATUS helpers "
        "(is_live / is_fundamentals_only / is_home), never on a market id:\n"
        + "\n".join(violations)
    )


def test_n7_guard_is_not_vacuous(tmp_path):
    """A guard that cannot fail is decoration. Feed it a poisoned file."""
    poisoned = tmp_path / "poisoned.py"
    poisoned.write_text('X = "us"\n', encoding="utf-8")
    tree = ast.parse(poisoned.read_text(encoding="utf-8"))
    prose = _docstring_nodes(tree)
    hits = [
        node for node in ast.walk(tree)
        if isinstance(node, ast.Constant) and isinstance(node.value, str)
        and id(node) not in prose and node.value in _guarded_ids()
    ]
    assert hits, "the market-id scan would not catch a real violation"


def test_allowlist_entries_all_carry_a_reason_and_still_exist():
    """A stale allowlist entry silently widens the guard, so each one has
    to still point at a real module-level constant, with a real reason."""
    for (filename, constant), reason in MARKET_LITERAL_ALLOWLIST.items():
        assert reason and len(reason) > 20, (filename, constant)
        path = PACKAGE_DIR / filename
        assert path.is_file(), filename
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=filename)
        assert constant in set(_module_constant_owner(tree).values()), (
            "%s no longer defines the allowlisted constant %s"
            % (filename, constant)
        )
    for filename, reason in MARKET_LITERAL_EXEMPT_FILES.items():
        assert reason and len(reason) > 20, filename
        assert (PACKAGE_DIR / filename).is_file(), filename


def test_package_init_stays_import_free():
    """__init__.py is deliberately empty of imports so pulling one
    adapter never drags in another lane's dependencies."""
    init = PACKAGE_DIR / "__init__.py"
    tree = ast.parse(init.read_text(encoding="utf-8"))
    imports = [n for n in ast.walk(tree)
               if isinstance(n, (ast.Import, ast.ImportFrom))]
    assert imports == []


def test_no_ai_import_anywhere_in_the_numeric_spine():
    """PM1: the deterministic feed carries every number. The spine files
    must contain no model client at all."""
    forbidden = ("anthropic", "openai")
    violations = []
    for name in ("registry.py", "model.py", "store.py", "router.py"):
        source = (PACKAGE_DIR / name).read_text(encoding="utf-8")
        tree = ast.parse(source, filename=name)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name.split(".")[0] in forbidden:
                        violations.append("%s imports %s" % (name, alias.name))
            elif isinstance(node, ast.ImportFrom):
                if (node.module or "").split(".")[0] in forbidden:
                    violations.append("%s imports from %s" % (name, node.module))
    assert not violations, "\n".join(violations)
