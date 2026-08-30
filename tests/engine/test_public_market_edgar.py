"""Tests for the SEC EDGAR public_market adapter (src/engine/public_market/edgar.py).

Fixture policy: REAL BYTES. companyfacts_CIK0000320193_truncated.json and
company_tickers_truncated.json are untouched subsets of live SEC responses
(fetch + truncation documented in tests/engine/fixtures/public_market/README.md).
Synthetic facts appear ONLY in pure-logic tests (dedupe ordering, refusal paths)
where the shape is exercised but no external format is being "parsed for real".

No test in this file touches the network: every HTTP path goes through an
injected fake transport.
"""

import copy
import json
import sys
from pathlib import Path

import pytest

# Bootstrap: make `engine` importable whether or not the repo conftest already
# put src/ on sys.path (keeps the file runnable standalone and in the mirror).
_SRC = Path(__file__).resolve().parents[2] / "src"
if (_SRC / "engine").exists() and str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from engine.public_market import edgar, edgar_concepts  # noqa: E402
from engine.public_market.edgar import (  # noqa: E402
    COMPANYFACTS_URL_TMPL,
    TICKERS_URL,
    USER_AGENT,
    EdgarAdapter,
    EdgarClient,
    EdgarFormatError,
    EdgarHTTPError,
    EdgarRateLimitedError,
    EdgarTickerUnknown,
    EdgarTransportError,
    TokenBucket,
    build_summary_ir,
    build_envelope,
    fetch_companyfacts,
    resolve_cik,
)

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "public_market"
FETCHED_AT = "2026-08-29T20:53:16Z"

APPLE_CIK10 = "0000320193"
APPLE_ACCN_FY2025 = "0000320193-25-000079"
FY2025_END = "2025-09-27"


def load_fixture(name):
    with open(FIXTURES / name, "rb") as f:
        return f.read()


def load_facts_doc():
    return json.loads(load_fixture("companyfacts_CIK0000320193_truncated.json"))


class FakeTransport(object):
    """transport(url, headers) -> (status, body_bytes); records every call."""

    def __init__(self, routes):
        self.routes = routes
        self.calls = []

    def __call__(self, url, headers):
        self.calls.append((url, dict(headers)))
        handler = self.routes[url]
        if callable(handler):
            return handler()
        return handler


def make_client(routes, **kw):
    transport = FakeTransport(routes)
    sleeps = []
    clock = {"now": 0.0}

    def sleeper(s):
        sleeps.append(s)
        clock["now"] += s

    kw.setdefault("token_bucket", TokenBucket(clock=lambda: clock["now"], sleeper=sleeper))
    client = EdgarClient(transport=transport, sleeper=sleeper, **kw)
    return client, transport, sleeps


def default_routes():
    return {
        TICKERS_URL: (200, load_fixture("company_tickers_truncated.json")),
        COMPANYFACTS_URL_TMPL.format(cik=APPLE_CIK10): (
            200,
            load_fixture("companyfacts_CIK0000320193_truncated.json"),
        ),
    }


# ---------------------------------------------------------------------------
# Ticker -> CIK resolution
# ---------------------------------------------------------------------------


def test_ticker_resolution_case_insensitive_and_zero_padded():
    client, transport, _ = make_client(default_routes())
    assert resolve_cik("aapl", client) == APPLE_CIK10
    assert resolve_cik("AAPL", client) == APPLE_CIK10
    # polite UA declared on every request
    for _url, headers in transport.calls:
        assert headers.get("User-Agent") == USER_AGENT


def test_unknown_ticker_is_typed_error_not_empty():
    client, _, _ = make_client(default_routes())
    with pytest.raises(EdgarTickerUnknown) as ei:
        resolve_cik("ZZZZNOPE", client)
    assert ei.value.code == "TICKER_UNKNOWN"


# ---------------------------------------------------------------------------
# Concept selection on REAL bytes
# ---------------------------------------------------------------------------


def test_revenue_chain_is_period_anchored_not_first_present():
    """Apple tags BOTH `Revenues` (stale: last annual end 2018-09-29) and
    `RevenueFromContractWithCustomerExcludingAssessedTax` (current). A naive
    first-present chain walk would return a 2018 number. The chain must anchor
    on the freshest annual period available across the whole chain."""
    ir = build_summary_ir(load_facts_doc(), fetched_at=FETCHED_AT)
    fig = ir["figures"]["revenue"]
    prov = fig["provenance"]
    assert prov["concept"] == "RevenueFromContractWithCustomerExcludingAssessedTax"
    assert prov["accession"] == APPLE_ACCN_FY2025
    assert prov["dataset_version"] == APPLE_ACCN_FY2025
    assert fig["fiscal"]["end"] == FY2025_END
    assert fig["fiscal"]["fp"] == "FY"
    # USD -> integer cents
    assert fig["value_minor"] == 416_161_000_000 * 100
    assert fig["currency"] == "USD"


def test_fy_span_guard_rejects_quarterly_facts_tagged_fp_fy():
    """REAL trap from the Apple bytes: old 10-K filings carry quarterly spans
    (e.g. 2018-04-01..2018-06-30) tagged fp='FY'. Annual duration selection
    must require a ~1-year span, not trust fp alone."""
    doc = load_facts_doc()
    facts = doc["facts"]["us-gaap"]["Revenues"]["units"]["USD"]
    cands = edgar_concepts.annual_duration_candidates(facts)
    for f in cands:
        assert 330 <= edgar_concepts.span_days(f["start"], f["end"]) <= 400
    # the quarterly fp=FY facts exist in the raw list but not in candidates
    assert any(edgar_concepts.span_days(f["start"], f["end"]) < 200 for f in facts)


def test_balance_sheet_figures_fy2025():
    ir = build_summary_ir(load_facts_doc(), fetched_at=FETCHED_AT)
    figs = ir["figures"]
    assert figs["total_assets"]["value_minor"] == 359_241_000_000 * 100
    assert figs["equity"]["value_minor"] == 73_733_000_000 * 100
    assert figs["net_income"]["value_minor"] == 112_010_000_000 * 100
    for key in ("total_assets", "equity", "net_income"):
        assert figs[key]["provenance"]["accession"] == APPLE_ACCN_FY2025
        assert figs[key]["fiscal"]["end"] == FY2025_END


def test_total_debt_composite_short_anchor_plus_addons():
    """Apple does not tag DebtCurrent. Short side = LongTermDebtCurrent (anchor)
    + CommercialPaper (optional add-on, present at the same instant). Long side
    = LongTermDebtNoncurrent. Both sides required; components carried with
    their own provenance."""
    ir = build_summary_ir(load_facts_doc(), fetched_at=FETCHED_AT)
    fig = ir["figures"]["total_debt"]
    short = 12_350_000_000 + 7_979_000_000
    long = 78_328_000_000
    assert fig["value_minor"] == (short + long) * 100
    concepts = sorted(c["concept"] for c in fig["components"])
    assert concepts == [
        "CommercialPaper",
        "LongTermDebtCurrent",
        "LongTermDebtNoncurrent",
    ]
    for comp in fig["components"]:
        assert comp["end"] == FY2025_END
        assert comp["accession"] == APPLE_ACCN_FY2025
    # LongTermDebt (total incl. current portion) must never be a component:
    # summing it with LongTermDebtCurrent would double-count.
    assert "LongTermDebt" not in concepts


def test_shares_outstanding_from_dei_is_count_not_minor_units():
    ir = build_summary_ir(load_facts_doc(), fetched_at=FETCHED_AT)
    fig = ir["figures"]["shares_outstanding"]
    assert fig["value"] == 14_594_180_000
    assert fig["unit"] == "shares"
    assert "value_minor" not in fig
    # dei cover-page value: as_of is the cover date, not fiscal period end
    assert fig["provenance"]["as_of"] == "2026-07-17"
    assert fig["provenance"]["taxonomy"] == "dei"
    assert fig["fiscal"]["fp"] == "Q3"
    assert fig["fiscal"]["fy"] == 2026


# ---------------------------------------------------------------------------
# ABSENT != ZERO and typed refusals (synthetic mutations of the real doc)
# ---------------------------------------------------------------------------


def test_absent_concept_is_missing_figure_plus_refusal_never_zero():
    doc = copy.deepcopy(load_facts_doc())
    del doc["facts"]["us-gaap"]["NetIncomeLoss"]  # ProfitLoss absent for Apple too
    ir = build_summary_ir(doc, fetched_at=FETCHED_AT)
    assert "net_income" not in ir["figures"]
    refusal = [r for r in ir["refusals"] if r["figure"] == "net_income"]
    assert len(refusal) == 1
    assert refusal[0]["code"] == "CONCEPT_ABSENT"


def test_total_debt_refuses_when_short_side_missing():
    doc = copy.deepcopy(load_facts_doc())
    del doc["facts"]["us-gaap"]["LongTermDebtCurrent"]  # anchor gone, no DebtCurrent
    ir = build_summary_ir(doc, fetched_at=FETCHED_AT)
    assert "total_debt" not in ir["figures"]
    refusal = [r for r in ir["refusals"] if r["figure"] == "total_debt"]
    assert len(refusal) == 1
    assert refusal[0]["code"] == "DEBT_COMPONENT_MISSING"
    assert "short" in refusal[0]["detail"]


def test_total_debt_prefers_fresh_composite_over_stale_umbrella():
    """A filer that tagged DebtCurrent years ago and then stopped must not pin
    the short side to the stale umbrella: the fresher composite anchor wins."""
    doc = copy.deepcopy(load_facts_doc())
    doc["facts"]["us-gaap"]["DebtCurrent"] = {
        "label": "Debt, Current",
        "description": "synthetic stale umbrella",
        "units": {"USD": [{
            "end": "2023-09-30", "val": 11_105_000_000, "fy": 2023, "fp": "FY",
            "form": "10-K", "accn": "0000320193-23-000106", "filed": "2023-11-03",
        }]},
    }
    ir = build_summary_ir(doc, fetched_at=FETCHED_AT)
    fig = ir["figures"]["total_debt"]
    concepts = sorted(c["concept"] for c in fig["components"])
    assert "DebtCurrent" not in concepts
    assert fig["fiscal"]["end"] == FY2025_END


def test_total_debt_refuses_on_period_mismatch():
    doc = copy.deepcopy(load_facts_doc())
    gaap = doc["facts"]["us-gaap"]
    # push the long side's freshest annual instant a year ahead of the short side
    for f in gaap["LongTermDebtNoncurrent"]["units"]["USD"]:
        if f["end"] == FY2025_END and f.get("fp") == "FY":
            f2 = dict(f)
            f2["end"] = "2026-09-26"
            f2["fy"] = 2026
            gaap["LongTermDebtNoncurrent"]["units"]["USD"].append(f2)
    ir = build_summary_ir(doc, fetched_at=FETCHED_AT)
    assert "total_debt" not in ir["figures"]
    refusal = [r for r in ir["refusals"] if r["figure"] == "total_debt"]
    assert refusal and refusal[0]["code"] == "DEBT_PERIOD_MISMATCH"


def test_non_integral_minor_units_is_typed_refusal():
    doc = copy.deepcopy(load_facts_doc())
    for f in doc["facts"]["us-gaap"]["Assets"]["units"]["USD"]:
        if f["end"] == FY2025_END and f.get("fp") == "FY":
            f["val"] = 359241000000.0015  # cannot be represented in integer cents
    ir = build_summary_ir(doc, fetched_at=FETCHED_AT)
    assert "total_assets" not in ir["figures"]
    refusal = [r for r in ir["refusals"] if r["figure"] == "total_assets"]
    assert refusal and refusal[0]["code"] == "NON_INTEGRAL_MINOR_UNITS"


def test_usd_to_minor_units():
    assert edgar_concepts.usd_to_minor(416161000000) == 41616100000000
    assert edgar_concepts.usd_to_minor(1.25) == 125
    with pytest.raises(EdgarFormatError):
        edgar_concepts.usd_to_minor(1.005)  # sub-cent: refuse, never round


def test_latest_filed_wins_on_duplicate_periods():
    # Synthetic (pure ordering logic): the same annual period reported by the
    # original 10-K and restated in a later filing — latest `filed` must win.
    older = {
        "start": "2023-10-01", "end": "2024-09-28", "val": 100, "fy": 2024,
        "fp": "FY", "form": "10-K", "accn": "0000320193-24-000100",
        "filed": "2024-11-01",
    }
    newer = dict(older)
    newer.update({"val": 105, "accn": "0000320193-25-000079", "filed": "2025-10-31", "fy": 2025})
    cands = edgar_concepts.annual_duration_candidates([older, newer])
    best = edgar_concepts.best_at_end(cands, "2024-09-28")
    assert best["accn"] == "0000320193-25-000079"
    assert best["val"] == 105


# ---------------------------------------------------------------------------
# Envelope shape and invariants
# ---------------------------------------------------------------------------


def test_envelope_shape_and_public_market_invariants():
    ir = build_summary_ir(load_facts_doc(), fetched_at=FETCHED_AT)
    env = build_envelope(ir, ticker="AAPL")
    assert env["doc_class"] == "public_market"
    assert env["status"] == "PUBLIC_MARKET"
    assert env["entity"]["cik"] == APPLE_CIK10
    assert env["entity"]["name"] == "Apple Inc."
    assert env["entity"]["ticker"] == "AAPL"
    # figures are a closed set: distractor concepts in the fixture
    # (Liabilities, OperatingIncomeLoss, ...) must never leak through
    allowed = {
        "revenue", "net_income", "total_assets", "equity",
        "total_debt", "shares_outstanding",
    }
    assert set(env["figures"].keys()) <= allowed
    # provenance on EVERY figure (the PM invariant)
    for name, fig in env["figures"].items():
        prov = fig["provenance"]
        for key in ("source", "accession", "dataset_version", "as_of", "fetched_at"):
            assert prov.get(key), (name, key)
        assert prov["source"] == "sec_edgar_companyfacts"
    # segments: honestly unavailable in companyfacts, not silently missing
    assert env["segments"]["status"] == "UNAVAILABLE"
    assert env["provenance"]["fetched_at"] == FETCHED_AT
    assert env["provenance"]["user_agent"] == USER_AGENT


def test_envelope_fiscal_anchor_fy_vs_q():
    ir = build_summary_ir(load_facts_doc(), fetched_at=FETCHED_AT)
    env = build_envelope(ir, ticker="AAPL")
    assert env["fiscal_anchor"]["latest_annual_end"] == FY2025_END
    assert env["fiscal_anchor"]["latest_fy"] == 2025
    # every monetary figure in the annual summary is FY-tagged
    for name, fig in env["figures"].items():
        if name == "shares_outstanding":
            continue
        assert fig["fiscal"]["fp"] == "FY", name


# ---------------------------------------------------------------------------
# Polite client: token bucket, backoff, honest failure
# ---------------------------------------------------------------------------


def test_token_bucket_budget_10_per_second():
    sleeps = []
    clock = {"now": 0.0}

    def sleeper(s):
        sleeps.append(s)
        clock["now"] += s

    tb = TokenBucket(rate_per_sec=10, capacity=10,
                     clock=lambda: clock["now"], sleeper=sleeper)
    for _ in range(10):
        tb.acquire()
    assert sleeps == []  # burst up to capacity is free
    tb.acquire()  # 11th within the same instant must wait ~1/10 s
    assert len(sleeps) == 1
    assert sleeps[0] == pytest.approx(0.1, abs=1e-6)


def test_backoff_retries_429_then_succeeds():
    attempts = {"n": 0}

    def flaky():
        attempts["n"] += 1
        if attempts["n"] < 3:
            return (429, b"slow down")
        return (200, b'{"ok": true}')

    client, _, sleeps = make_client({"https://x/j": flaky}, backoff_base=0.5)
    assert client.get_json("https://x/j") == {"ok": True}
    assert attempts["n"] == 3
    # exponential: base, base*2 (token-bucket waits are 0 in this window)
    assert [s for s in sleeps if s > 0] == [0.5, 1.0]


def test_backoff_exhaustion_is_typed_rate_limit_error():
    client, transport, _ = make_client({"https://x/j": (429, b"")}, max_attempts=4)
    with pytest.raises(EdgarRateLimitedError) as ei:
        client.get_json("https://x/j")
    assert ei.value.code == "RATE_LIMIT_EXHAUSTED"
    assert len(transport.calls) == 4


def test_client_5xx_retries_then_typed_http_error():
    client, transport, _ = make_client({"https://x/j": (503, b"")}, max_attempts=3)
    with pytest.raises(EdgarHTTPError) as ei:
        client.get_json("https://x/j")
    assert ei.value.status == 503
    assert len(transport.calls) == 3


def test_client_404_fails_immediately_no_retry():
    client, transport, _ = make_client({"https://x/j": (404, b"nope")})
    with pytest.raises(EdgarHTTPError) as ei:
        client.get_json("https://x/j")
    assert ei.value.status == 404
    assert len(transport.calls) == 1


def test_client_garbage_body_is_format_error_not_silent_empty():
    client, _, _ = make_client({"https://x/j": (200, b"<html>not json</html>")})
    with pytest.raises(EdgarFormatError):
        client.get_json("https://x/j")


def test_transport_failure_is_typed():
    def boom():
        raise OSError("connection reset")

    client, _, _ = make_client({"https://x/j": boom}, max_attempts=2)
    with pytest.raises(EdgarTransportError):
        client.get_json("https://x/j")


# ---------------------------------------------------------------------------
# Journaled ingestion + DLQ (minimal in-module jsonl journal)
# ---------------------------------------------------------------------------


def test_adapter_resolve_journals_success(tmp_path):
    client, _, _ = make_client(default_routes())
    adapter = EdgarAdapter(client=client, journal_dir=str(tmp_path))
    env = adapter.resolve("AAPL")
    assert env["entity"]["cik"] == APPLE_CIK10
    lines = [json.loads(l) for l in (tmp_path / "journal.jsonl").read_text().splitlines()]
    events = [l["event"] for l in lines]
    assert events == ["ingest_start", "ingest_ok"]
    assert lines[1]["dataset_version"] == APPLE_ACCN_FY2025
    assert not (tmp_path / "dlq.jsonl").exists()


def test_adapter_failure_hits_dlq_and_reraises(tmp_path):
    def boom():
        raise OSError("network down")

    routes = default_routes()
    routes[COMPANYFACTS_URL_TMPL.format(cik=APPLE_CIK10)] = boom
    client, _, _ = make_client(routes, max_attempts=2)
    adapter = EdgarAdapter(client=client, journal_dir=str(tmp_path))
    with pytest.raises(EdgarTransportError):
        adapter.resolve("AAPL")
    journal = [json.loads(l) for l in (tmp_path / "journal.jsonl").read_text().splitlines()]
    assert [l["event"] for l in journal] == ["ingest_start", "ingest_fail"]
    dlq = [json.loads(l) for l in (tmp_path / "dlq.jsonl").read_text().splitlines()]
    assert len(dlq) == 1
    assert dlq[0]["error_code"] == "TRANSPORT"
    assert dlq[0]["ticker"] == "AAPL"


def test_journal_is_append_only(tmp_path):
    client, _, _ = make_client(default_routes())
    adapter = EdgarAdapter(client=client, journal_dir=str(tmp_path))
    adapter.resolve("AAPL")
    first = (tmp_path / "journal.jsonl").read_text()
    client2, _, _ = make_client(default_routes())
    adapter2 = EdgarAdapter(client=client2, journal_dir=str(tmp_path))
    adapter2.resolve("AAPL")
    second = (tmp_path / "journal.jsonl").read_text()
    assert second.startswith(first)  # prior records never rewritten
    assert len(second.splitlines()) == 2 * len(first.splitlines())


# ---------------------------------------------------------------------------
# Spine store integration
# ---------------------------------------------------------------------------


def test_adapter_caches_into_injected_store(tmp_path):
    class FakeStore(object):
        def __init__(self):
            self.puts = []

        def put(self, envelope):
            self.puts.append(envelope)

    store = FakeStore()
    client, _, _ = make_client(default_routes())
    adapter = EdgarAdapter(client=client, journal_dir=str(tmp_path), store=store)
    env = adapter.resolve("AAPL")
    assert len(store.puts) == 1
    assert store.puts[0]["entity"]["cik"] == APPLE_CIK10
    assert env["meta"]["cached"] is True


def test_adapter_without_store_is_honest_about_not_caching(monkeypatch):
    """The store-unavailable branch, still exercised after the spine landed.

    UPDATED BY THE SPINE LANE (the store now EXISTS, so discovery
    succeeds and the bare `EdgarAdapter(client=client)` of the original
    version legitimately reports cached=True — see
    test_adapter_discovers_real_spine_store below, which was written to
    self-activate on exactly this event).

    The branch this test guards has NOT gone away: a partially
    provisioned deployment (no data/ volume mounted, a read-only fs, the
    spine package absent from a slim image) still lands here, and the
    adapter must say `store_unavailable` rather than pretend it cached.
    So the unavailability is now made explicit instead of being an
    accident of the spine not existing yet.
    """
    monkeypatch.setattr(edgar, "_discover_store", lambda: None)
    client, _, _ = make_client(default_routes())
    adapter = EdgarAdapter(client=client)  # no store injected, none discoverable
    env = adapter.resolve("AAPL")
    assert env["meta"]["cached"] is False
    assert env["meta"]["cache_reason"] == "store_unavailable"


def _spine_store_present():
    try:
        from engine.public_market import store  # noqa: F401
        return True
    except Exception:
        return False


@pytest.mark.skipif(
    not _spine_store_present(),
    reason=(
        "LOUD NOTE: the spine lane's store (engine.public_market.store) is not "
        "on disk yet. This lane coded against the documented interface "
        "get_store().put(envelope) / get(cik); this test self-activates the "
        "moment the spine lane lands. Until then EdgarAdapter honestly reports "
        "meta.cached=False with cache_reason='store_unavailable'."
    ),
)
def test_adapter_discovers_real_spine_store(tmp_path):
    from engine.public_market import store as spine_store

    client, _, _ = make_client(default_routes())
    adapter = EdgarAdapter(client=client, journal_dir=str(tmp_path))
    env = adapter.resolve("AAPL")
    assert env["meta"]["cached"] is True
    real = spine_store.get_store().get(APPLE_CIK10)
    assert real is not None


# ---------------------------------------------------------------------------
# End-to-end offline resolve on real bytes
# ---------------------------------------------------------------------------


def test_full_resolve_flow_offline():
    client, transport, _ = make_client(default_routes())
    env = fetch_and_build(client)
    assert env["figures"]["revenue"]["value_minor"] == 41_616_100_000_000
    assert env["figures"]["total_debt"]["value_minor"] == 9_865_700_000_000
    # both requests carried the declared UA
    for _url, headers in transport.calls:
        assert headers["User-Agent"] == USER_AGENT


def fetch_and_build(client):
    cik = resolve_cik("AAPL", client)
    doc = fetch_companyfacts(cik, client)
    ir = build_summary_ir(doc, fetched_at=FETCHED_AT)
    return build_envelope(ir, ticker="AAPL")
