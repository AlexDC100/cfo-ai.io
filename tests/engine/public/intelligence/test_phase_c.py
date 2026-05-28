"""Phase C — filings extractor + EIA commodity adapter tests.

No live HTTP, no Anthropic SDK required. The SEC EDGAR network calls are
mocked at urllib level; the LLM is injected via a MockClient. EIA tests
follow the same pattern as the Phase B FRED tests.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from unittest.mock import patch, MagicMock

import pytest

from engine.public.intelligence.adapters.commodity_signal_adapter import (
    CommoditySignalAdapter,
    SERIES_CONFIG as COMMODITY_SERIES,
    _severity_from_delta,
)
from engine.public.intelligence.filings_extractor import (
    FILINGS_CONFIDENCE,
    _build_profile,
    _extract_risk_factors_section,
    _parse_filings_envelope,
    _reset_cik_cache,
    _validate_channels,
    _validate_exposure_map,
    _validate_severity,
    try_filings_derived_profile,
)


# ─────────────────────────────────────────────────────────────────────────
# EIA commodity adapter
# ─────────────────────────────────────────────────────────────────────────

def test_commodity_unconfigured_without_env_var():
    saved = os.environ.pop("EIA_API_KEY", None)
    try:
        a = CommoditySignalAdapter()
        assert a.configured is False
        assert "EIA_API_KEY" in a.health().reason
        assert a.fetch_recent_signals(datetime.utcnow()) == []
    finally:
        if saved is not None:
            os.environ["EIA_API_KEY"] = saved


def test_commodity_configured_with_env():
    a = CommoditySignalAdapter(api_key="test_key")
    assert a.configured is True
    assert a.health().configured is True


def test_commodity_emits_signal_on_material_oil_move():
    """A +$10 move on WTI > $7.50 threshold → emits a signal."""
    fake_payload = {
        "response": {
            "data": [
                {"period": "2026-05-27", "value": 85.00},
                {"period": "2026-05-26", "value": 75.00},   # +$10 move
            ],
        },
    }
    a = CommoditySignalAdapter(api_key="test_key")
    with patch("urllib.request.urlopen") as mock_open:
        mock_open.return_value.__enter__.return_value.read.return_value = json.dumps(fake_payload).encode()
        signals = a.fetch_recent_signals(datetime(2026, 5, 1, tzinfo=timezone.utc))
    # All 5 series same fake payload — all cross their respective thresholds:
    # WTI/Brent ($7.50 thresholds vs $10 move) → high severity
    # Nat Gas ($0.50 threshold, $10 move = 20x) → critical
    # Gasoline ($0.20 threshold, $10 move = 50x) → critical
    # Diesel ($0.25 threshold, $10 move = 40x) → critical
    assert len(signals) == len(COMMODITY_SERIES)
    # Verify metadata
    s = signals[0]
    assert s.source.startswith("eia:")
    assert s.confidence == 0.85
    assert s.signal_type == "commodity"
    assert len(s.affected_sectors) > 0


def test_commodity_filters_subthreshold_moves():
    """Small move under all 5 series thresholds → no signals."""
    fake_payload = {
        "response": {
            "data": [
                {"period": "2026-05-27", "value": 75.10},
                {"period": "2026-05-26", "value": 75.00},   # +$0.10 < all thresholds
            ],
        },
    }
    a = CommoditySignalAdapter(api_key="test_key")
    with patch("urllib.request.urlopen") as mock_open:
        mock_open.return_value.__enter__.return_value.read.return_value = json.dumps(fake_payload).encode()
        signals = a.fetch_recent_signals(datetime(2026, 5, 1, tzinfo=timezone.utc))
    assert signals == []


def test_commodity_severity_scaling():
    assert _severity_from_delta(8.0, 7.5) == "medium"     # 1.07x
    assert _severity_from_delta(15.0, 7.5) == "high"      # 2.0x
    assert _severity_from_delta(27.0, 7.5) == "critical"  # 3.6x


# ─────────────────────────────────────────────────────────────────────────
# Filings extractor — entry point + integration
# ─────────────────────────────────────────────────────────────────────────

def test_filings_disabled_without_env():
    """SEC_EDGAR_ENABLED unset → returns None (caller falls back to sector)."""
    saved_edgar = os.environ.pop("SEC_EDGAR_ENABLED", None)
    saved_anth = os.environ.pop("ANTHROPIC_API_KEY", None)
    try:
        result = try_filings_derived_profile(
            ticker="NVDA",
            company_name="NVIDIA Corp",
            sector="Semiconductors",
            industry=None,
        )
        assert result is None
    finally:
        if saved_edgar is not None:
            os.environ["SEC_EDGAR_ENABLED"] = saved_edgar
        if saved_anth is not None:
            os.environ["ANTHROPIC_API_KEY"] = saved_anth


def test_filings_disabled_when_anth_key_missing():
    """SEC_EDGAR_ENABLED set but no ANTHROPIC_API_KEY → returns None."""
    saved_anth = os.environ.pop("ANTHROPIC_API_KEY", None)
    os.environ["SEC_EDGAR_ENABLED"] = "1"
    try:
        result = try_filings_derived_profile(
            ticker="NVDA",
            company_name="NVIDIA Corp",
            sector="Semiconductors",
            industry=None,
        )
        assert result is None
    finally:
        os.environ.pop("SEC_EDGAR_ENABLED", None)
        if saved_anth is not None:
            os.environ["ANTHROPIC_API_KEY"] = saved_anth


def test_filings_returns_none_when_ticker_not_in_cik_map():
    """Unknown ticker (no CIK) → returns None."""
    _reset_cik_cache()
    os.environ["SEC_EDGAR_ENABLED"] = "1"
    os.environ["ANTHROPIC_API_KEY"] = "test_key"
    try:
        with patch("urllib.request.urlopen") as mock_open:
            # CIK map fetch returns empty payload
            mock_open.return_value.__enter__.return_value.read.return_value = b"{}"
            result = try_filings_derived_profile(
                ticker="NOSUCH",
                company_name="Made Up Co",
                sector="Semiconductors",
                industry=None,
            )
        assert result is None
    finally:
        os.environ.pop("SEC_EDGAR_ENABLED", None)
        os.environ.pop("ANTHROPIC_API_KEY", None)
        _reset_cik_cache()


# ─────────────────────────────────────────────────────────────────────────
# Risk Factors section extractor
# ─────────────────────────────────────────────────────────────────────────

def test_extract_risk_factors_carves_between_item_1a_and_item_1b():
    html = (
        "<html><body>"
        "Item 1. Business — irrelevant intro about the company."
        "<h2>Item 1A. Risk Factors</h2>"
        "Some material risks affect our company including supply chain disruption."
        "<h2>Item 1B. Unresolved Staff Comments</h2>"
        "None to disclose."
        "</body></html>"
    )
    section = _extract_risk_factors_section(html)
    assert section is not None
    assert "material risks" in section
    assert "supply chain" in section
    # Should NOT include the Item 1B body
    assert "Unresolved Staff Comments" not in section


def test_extract_risk_factors_carves_between_item_1a_and_item_2():
    """Some 10-Ks skip Item 1B and go straight to Item 2 Properties."""
    html = (
        "Item 1A. Risk Factors. "
        "Our business faces concentration risk in Taiwan. "
        "Item 2. Properties. We own offices in California."
    )
    section = _extract_risk_factors_section(html)
    assert section is not None
    assert "concentration risk in Taiwan" in section
    assert "California" not in section


def test_extract_risk_factors_returns_none_when_section_missing():
    """A document without Item 1A heading → None."""
    html = "<html>This is not a 10-K. No Item 1A here.</html>"
    assert _extract_risk_factors_section(html) is None


def test_extract_risk_factors_truncates_at_max():
    """Sections > 60K chars get truncated."""
    huge = "Item 1A. Risk Factors. " + ("Risk text. " * 10000)
    section = _extract_risk_factors_section(huge)
    assert section is not None
    assert len(section) <= 60_000


# ─────────────────────────────────────────────────────────────────────────
# LLM envelope parsing
# ─────────────────────────────────────────────────────────────────────────

def test_parse_filings_envelope_basic():
    raw = json.dumps({
        "geographic_exposure": {"us": 0.5, "china": 0.3},
        "main_risks": [],
    })
    parsed = _parse_filings_envelope(raw)
    assert parsed is not None
    assert parsed["geographic_exposure"]["us"] == 0.5


def test_parse_filings_envelope_with_code_fence():
    raw = '```json\n{"geographic_exposure": {"us": 0.5}}\n```'
    parsed = _parse_filings_envelope(raw)
    assert parsed is not None


def test_parse_filings_envelope_malformed_returns_none():
    assert _parse_filings_envelope("just prose") is None
    assert _parse_filings_envelope("") is None


# ─────────────────────────────────────────────────────────────────────────
# Profile builder + validators
# ─────────────────────────────────────────────────────────────────────────

def test_build_profile_from_full_extraction():
    extracted = {
        "geographic_exposure": {"us": 0.45, "china": 0.30, "europe": 0.25},
        "supply_chain_exposure": {"semiconductors": 0.9, "energy": 0.4},
        "financial_sensitivity": {"interest_rates": 0.5},
        "main_risks": [
            {
                "key": "taiwan_concentration",
                "label": "Taiwan manufacturing concentration",
                "severity": "critical",
                "channels": ["supply_availability", "ebitda_margin"],
                "explanation": "Filing discloses TSMC dependency.",
            },
        ],
        "main_opportunities": [
            {
                "key": "ai_capex",
                "label": "AI capex tailwind",
                "severity": "high",
                "channels": ["revenue"],
                "explanation": "Demand from hyperscalers.",
            },
        ],
    }
    profile = _build_profile(
        ticker="NVDA",
        company_name="NVIDIA Corp",
        sector="Semiconductors",
        industry=None,
        extracted=extracted,
        filing_date="2026-02-21",
    )
    assert profile.source == "filings"
    assert profile.confidence == FILINGS_CONFIDENCE
    assert profile.geographic_exposure["us"] == 0.45
    assert len(profile.main_risks) == 1
    assert profile.main_risks[0].key == "taiwan_concentration"
    assert profile.main_risks[0].severity == "critical"
    assert len(profile.main_opportunities) == 1


def test_build_profile_tolerates_partial_extraction():
    """When the LLM only finds some dimensions, missing ones → empty dicts."""
    extracted = {
        "main_risks": [
            {"key": "x", "label": "X risk", "severity": "high", "channels": []}
        ],
        # No exposure maps at all
    }
    profile = _build_profile(
        ticker="X",
        company_name="X Co",
        sector="Semiconductors",
        industry=None,
        extracted=extracted,
        filing_date=None,
    )
    assert profile.geographic_exposure == {}
    assert profile.supply_chain_exposure == {}
    assert profile.financial_sensitivity == {}
    assert len(profile.main_risks) == 1


def test_validators_drop_hallucinated_values():
    """Validators reject channel names + severities outside the enum."""
    assert _validate_severity("medium") == "medium"
    assert _validate_severity("EXTREME") == "medium"     # invalid → default
    assert _validate_severity(None) == "medium"
    assert _validate_channels(["revenue", "fake_channel"]) == ["revenue"]
    assert _validate_channels("not a list") == []
    assert _validate_exposure_map({"us": 0.5, "bad": "text"}) == {"us": 0.5}
    assert _validate_exposure_map({"us": 99.0}) == {}   # out of [0, 1.5] range
    assert _validate_exposure_map(None) == {}


# ─────────────────────────────────────────────────────────────────────────
# End-to-end: mocked EDGAR + injected client
# ─────────────────────────────────────────────────────────────────────────

class _MockFilingsClient:
    """Returns a canned JSON envelope, captures the prompt for assertions."""
    model_id = "mock"
    def __init__(self, response: str):
        self._response = response
        self.calls = []
    def complete(self, system, user):
        self.calls.append({"system": system, "user": user})
        return self._response


def test_end_to_end_with_mocked_edgar_and_client():
    """Happy path with all network calls mocked + injected client."""
    _reset_cik_cache()
    os.environ["SEC_EDGAR_ENABLED"] = "1"
    os.environ["ANTHROPIC_API_KEY"] = "test_key"

    cik_map_payload = json.dumps({
        "0": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."}
    }).encode()
    submissions_payload = json.dumps({
        "filings": {
            "recent": {
                "form": ["10-K"],
                "accessionNumber": ["0000320193-23-000106"],
                "filingDate": ["2023-11-03"],
            },
        },
    }).encode()
    index_payload = json.dumps({
        "directory": {
            "item": [
                {"type": "10-K", "name": "aapl-20230930.htm"}
            ],
        },
    }).encode()
    risk_factors_html = (
        b"<html>Lots of front matter."
        b"<h2>Item 1A. Risk Factors</h2>"
        b"Apple depends on its Taiwan supplier TSMC and faces geopolitical risk."
        b"<h2>Item 1B. Unresolved Staff Comments</h2></html>"
    )
    extraction_response = json.dumps({
        "geographic_exposure": {"us": 0.45, "china": 0.25, "europe": 0.30},
        "supply_chain_exposure": {"semiconductors": 0.9},
        "financial_sensitivity": {"interest_rates": 0.4},
        "main_risks": [{
            "key": "taiwan",
            "label": "Taiwan supplier concentration",
            "severity": "critical",
            "channels": ["supply_availability"],
            "explanation": "TSMC dependency disclosed in filing.",
        }],
        "main_opportunities": [],
    })

    mock_client = _MockFilingsClient(response=extraction_response)
    # Each urlopen call gets a different payload — sequence them.
    fetch_seq = [cik_map_payload, submissions_payload, index_payload, risk_factors_html]
    fetch_iter = iter(fetch_seq)

    def fake_urlopen(req, *args, **kwargs):
        ctx = MagicMock()
        ctx.__enter__.return_value.read.return_value = next(fetch_iter)
        return ctx

    try:
        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            profile = try_filings_derived_profile(
                ticker="AAPL",
                company_name="Apple Inc.",
                sector="Technology",
                industry=None,
                client=mock_client,
            )

        assert profile is not None
        assert profile.source == "filings"
        assert profile.confidence == FILINGS_CONFIDENCE
        assert profile.geographic_exposure == {"us": 0.45, "china": 0.25, "europe": 0.30}
        assert len(profile.main_risks) == 1
        assert profile.main_risks[0].key == "taiwan"
        # Prompt was sent + carried company identifying info
        assert len(mock_client.calls) == 1
        assert "AAPL" in mock_client.calls[0]["user"]
        assert "Taiwan" in mock_client.calls[0]["user"]
    finally:
        os.environ.pop("SEC_EDGAR_ENABLED", None)
        os.environ.pop("ANTHROPIC_API_KEY", None)
        _reset_cik_cache()
