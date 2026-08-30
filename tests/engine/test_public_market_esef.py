"""ESEF adapter (filings.xbrl.org) — europe lane of the public_market
document class.

Fixture discipline: every external-format fixture under
``fixtures/public_market/esef/`` is REAL BYTES from the live service
(see the README there for URLs, dates, hashes and the one documented
truncation). Synthetic dicts appear ONLY in fail-closed negative tests
and are built inline so nobody can mistake them for wire shapes.

Contract under test (the europe lane's slice of PM law):
- deterministic feed carries every number; nothing here touches AI;
- ABSENT != ZERO — a metric the filing does not tag is *absent from
  the bundle*, never 0.0;
- fail closed — malformed documents and conflicting duplicate facts
  produce typed refusals / recorded inconsistencies, never a guess;
- provenance {source, accession, as_of, fetched_at} on every figure;
- the default HTTP path is polite: declared User-Agent, https only.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from engine.public_market import esef
from engine.public_market._refusal import Refusal

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "public_market" / "esef"

FETCHED_AT = "2026-08-29T21:00:00+00:00"  # deterministic stamp for pure parses


def _load(name):
    return (FIXTURES / name).read_bytes()


# ────────────────────────────────────────────────────────────────────
# Discovery: /api/filings JSON:API pages (real bytes)
# ────────────────────────────────────────────────────────────────────


def test_parse_filings_api_page_real_bytes():
    filings = esef.parse_filings_response(_load("filings_api_fr_page.json"))
    assert not isinstance(filings, Refusal)
    assert len(filings) == 2

    dupont = [f for f in filings if f.fxo_id == "969500YT2CGGAD8YNM04-2026-03-31-ESEF-FR-0"]
    assert len(dupont) == 1
    d = dupont[0]
    assert d.entity_identifier == "969500YT2CGGAD8YNM04"
    assert d.country == "FR"
    assert d.period_end == "2026-03-31"
    # relative wire paths are absolutized against the service base
    assert d.json_url == (
        "https://filings.xbrl.org/969500YT2CGGAD8YNM04/2026-03-31/ESEF/FR/0/"
        "969500YT2CGGAD8YNM04-2026-03-31-1-fr.json"
    )
    assert d.package_url is not None and d.package_url.startswith("https://filings.xbrl.org/")
    assert d.sha256 == "ad190f807fa274f79001546c283e58006cd38a314646a83446f036bd5bd5ba80"

    medincell = [f for f in filings if f is not d][0]
    assert medincell.error_count == 3  # validation errors ride along, honestly


def test_parse_filings_api_survives_null_package_url_and_foreign_programme():
    # Real bytes: UAIFRS rows with "package_url": null — the adapter
    # must not require ESEF-only shapes at the discovery layer.
    filings = esef.parse_filings_response(_load("filings_api_latest_page.json"))
    assert not isinstance(filings, Refusal)
    assert len(filings) == 2
    assert all(f.package_url is None for f in filings)
    assert filings[0].entity_identifier == "EDRPOU-24940089"


def test_parse_filings_response_refuses_non_json():
    out = esef.parse_filings_response(b"<html>not the api</html>")
    assert isinstance(out, Refusal)
    assert out.code == "esef_index_malformed"


def test_build_filings_query_url_shapes_the_jsonapi_query():
    url = esef.build_filings_query_url(country="FR", page_size=2)
    assert url.startswith("https://filings.xbrl.org/api/filings?")
    assert "page%5Bsize%5D=2" in url
    assert "-date_added" in url
    # JSON:API filter body: [{"name":"country","op":"eq","val":"FR"}]
    assert "country" in url and "FR" in url


# ────────────────────────────────────────────────────────────────────
# Fact extraction: xBRL-JSON → core figures (real bytes)
# ────────────────────────────────────────────────────────────────────


def _dupont_doc():
    return json.loads(_load("xbrl_json_st_dupont_2026_03_31_truncated.json"))


def _dupont_filing():
    filings = esef.parse_filings_response(_load("filings_api_fr_page.json"))
    return [f for f in filings if f.entity_identifier == "969500YT2CGGAD8YNM04"][0]


def test_extract_core_facts_st_dupont_real_filing():
    bundle = esef.extract_core_facts(
        _dupont_doc(), filing=_dupont_filing(), fetched_at=FETCHED_AT
    )
    assert not isinstance(bundle, Refusal)

    figures = bundle.figures
    assert set(figures) == {"revenue", "profit", "assets", "equity"}
    assert bundle.absent == ()

    assert figures["revenue"].value == 55810000.0
    assert figures["profit"].value == 2042000.0
    assert figures["assets"].value == 61878000.0
    assert figures["equity"].value == 29802000.0
    assert all(f.currency == "EUR" for f in figures.values())

    # revenue resolves through the candidate chain — this filing has no
    # undimensioned ifrs-full:Revenue, only RevenueFromContractsWithCustomers
    assert figures["revenue"].concept == "ifrs-full:RevenueFromContractsWithCustomers"

    # xBRL instant 2026-04-01T00:00:00 means "as of end of 2026-03-31"
    assert figures["assets"].as_of == "2026-03-31"
    assert figures["profit"].period_start == "2025-04-01"
    assert figures["profit"].as_of == "2026-03-31"


def test_every_figure_carries_full_provenance():
    bundle = esef.extract_core_facts(
        _dupont_doc(), filing=_dupont_filing(), fetched_at=FETCHED_AT
    )
    for figure in bundle.figures.values():
        prov = figure.provenance
        assert prov["source"] == "filings.xbrl.org"
        assert prov["accession"] == "969500YT2CGGAD8YNM04-2026-03-31-ESEF-FR-0"
        assert prov["as_of"] == figure.as_of
        assert prov["fetched_at"] == FETCHED_AT


def test_public_market_block_shape_and_status():
    bundle = esef.extract_core_facts(
        _dupont_doc(), filing=_dupont_filing(), fetched_at=FETCHED_AT
    )
    block = esef.to_public_market_block(bundle, filing=_dupont_filing())
    assert block["document_class"] == "public_market"
    assert block["status"] == "PUBLIC_MARKET"
    assert block["market"] == "FR"
    assert block["entity_identifier"] == "969500YT2CGGAD8YNM04"
    facts = block["statement_facts"]
    assert facts["equity"]["value"] == 29802000.0
    assert facts["equity"]["provenance"]["source"] == "filings.xbrl.org"
    # absence is a first-class, visible list — never a zero
    assert block["absent"] == []


# ────────────────────────────────────────────────────────────────────
# Fail-closed negatives (synthetic by design — labeled as such)
# ────────────────────────────────────────────────────────────────────


def _minimal_doc(facts):
    """Synthetic xBRL-JSON skeleton for negative tests ONLY."""
    return {
        "documentInfo": {"documentType": "https://xbrl.org/2021/xbrl-json"},
        "facts": facts,
    }


def _fact(concept, value, period, unit="iso4217:EUR", extra_dims=None):
    dims = {
        "concept": concept,
        "entity": "scheme:TESTLEI",
        "period": period,
        "unit": unit,
    }
    if extra_dims:
        dims.update(extra_dims)
    return {"value": value, "dimensions": dims}


def test_absent_metric_stays_absent_not_zero():
    doc = _minimal_doc(
        {
            "f1": _fact("ifrs-full:Assets", "100.0", "2026-01-01T00:00:00"),
        }
    )
    bundle = esef.extract_core_facts(doc, filing=None, fetched_at=FETCHED_AT)
    assert not isinstance(bundle, Refusal)
    assert "revenue" in bundle.absent
    assert "revenue" not in bundle.figures
    # and nothing invented a zero anywhere
    assert all(f.value != 0.0 for f in bundle.figures.values())


def test_conflicting_duplicates_fail_closed():
    # Same concept, same period, same unit, DIFFERENT values: the
    # statement and the notes disagree. Never pick one — record it.
    doc = _minimal_doc(
        {
            "f1": _fact("ifrs-full:Equity", "500.0", "2026-01-01T00:00:00"),
            "f2": _fact("ifrs-full:Equity", "600.0", "2026-01-01T00:00:00"),
        }
    )
    bundle = esef.extract_core_facts(doc, filing=None, fetched_at=FETCHED_AT)
    assert "equity" not in bundle.figures
    assert "equity" in bundle.inconsistent
    assert "equity" in bundle.absent


def test_agreeing_duplicates_are_fine():
    doc = _minimal_doc(
        {
            "f1": _fact("ifrs-full:Equity", "500.0", "2026-01-01T00:00:00"),
            "f2": _fact("ifrs-full:Equity", "500.0", "2026-01-01T00:00:00"),
        }
    )
    bundle = esef.extract_core_facts(doc, filing=None, fetched_at=FETCHED_AT)
    assert bundle.figures["equity"].value == 500.0


def test_dimensioned_facts_never_feed_consolidated_figures():
    # A segment-member fact is NOT the consolidated figure.
    doc = _minimal_doc(
        {
            "f1": _fact(
                "ifrs-full:Assets",
                "100.0",
                "2026-01-01T00:00:00",
                extra_dims={"ifrs-full:SegmentsAxis": "x:SegmentA"},
            ),
        }
    )
    bundle = esef.extract_core_facts(doc, filing=None, fetched_at=FETCHED_AT)
    assert "assets" in bundle.absent


def test_non_monetary_units_are_ignored():
    doc = _minimal_doc(
        {
            "f1": _fact("ifrs-full:Assets", "100.0", "2026-01-01T00:00:00", unit="xbrli:shares"),
        }
    )
    bundle = esef.extract_core_facts(doc, filing=None, fetched_at=FETCHED_AT)
    assert "assets" in bundle.absent


def test_latest_period_wins():
    doc = _minimal_doc(
        {
            "f1": _fact("ifrs-full:Assets", "100.0", "2025-01-01T00:00:00"),
            "f2": _fact("ifrs-full:Assets", "200.0", "2026-01-01T00:00:00"),
        }
    )
    bundle = esef.extract_core_facts(doc, filing=None, fetched_at=FETCHED_AT)
    assert bundle.figures["assets"].value == 200.0
    assert bundle.figures["assets"].as_of == "2025-12-31"


def test_malformed_document_is_a_typed_refusal():
    out = esef.extract_core_facts({"nope": True}, filing=None, fetched_at=FETCHED_AT)
    assert isinstance(out, Refusal)
    assert out.code == "esef_document_malformed"

    out2 = esef.extract_core_facts(
        {"documentInfo": {"documentType": "something-else"}, "facts": {}},
        filing=None,
        fetched_at=FETCHED_AT,
    )
    assert isinstance(out2, Refusal)
    assert out2.code == "esef_document_type_unsupported"


def test_derive_as_of_midnight_instant_is_prior_day():
    start, as_of = esef.derive_period("2026-04-01T00:00:00")
    assert start is None
    assert as_of == "2026-03-31"
    start, as_of = esef.derive_period("2025-04-01T00:00:00/2026-04-01T00:00:00")
    assert start == "2025-04-01"
    assert as_of == "2026-03-31"


# ────────────────────────────────────────────────────────────────────
# Politeness + honest coverage boundary
# ────────────────────────────────────────────────────────────────────


def test_default_fetch_carries_declared_user_agent(monkeypatch):
    captured = {}

    def fake_urlopen(request, timeout=None):
        captured["url"] = request.full_url
        captured["ua"] = request.get_header("User-agent")

        class _Resp(object):
            def read(self):
                return _load("filings_api_fr_page.json")

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        return _Resp()

    monkeypatch.setattr(esef, "_urlopen", fake_urlopen)
    monkeypatch.setattr(esef, "_MIN_REQUEST_INTERVAL_S", 0.0)
    filings = esef.discover_filings(country="FR", page_size=2)
    assert not isinstance(filings, Refusal)
    assert captured["url"].startswith("https://filings.xbrl.org/api/filings?")
    assert captured["ua"] == "cfo-ai.io engine (contact: ad.crestin@gmail.com)"


def test_non_https_urls_are_refused():
    out = esef.fetch_document("http://filings.xbrl.org/x.json")
    assert isinstance(out, Refusal)
    assert out.code == "esef_insecure_url"


def test_terms_and_coverage_gap_are_recorded():
    # The source's own terms line, verbatim, travels with the adapter.
    assert "no restrictions" in esef.TERMS_OF_USE_LINE
    # filings.xbrl.org documents that DE and IE filings are missing —
    # marquee Germany canNOT be served from this feed. Honest boundary.
    assert "DE" in esef.COVERAGE_GAPS
    assert "IE" in esef.COVERAGE_GAPS
