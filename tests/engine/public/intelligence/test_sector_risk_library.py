"""Coverage tests for the static sector risk library.

The library is the source of truth at Phase A — every ticker in the
universe must have a sector profile, every risk dimension must reference
valid financial-impact channels, and theme overlays must map to live
sectors. These tests catch drift between the universe and the library.
"""

from __future__ import annotations

import pytest

from engine.public.universe import DEFAULT_UNIVERSE
from engine.public.intelligence.sector_risk_library import (
    SECTOR_RISK_LIBRARY,
    THEME_RISK_LIBRARY,
    all_sectors,
    get_sector_profile,
    opportunities_for_company,
    risks_for_company,
    themes_for_ticker,
)
from engine.public.intelligence.models import (
    FinancialImpactChannel,
    Severity,
)


VALID_CHANNELS: set[str] = {
    "revenue", "gross_margin", "ebitda_margin", "capex",
    "working_capital", "inventory", "debt_cost", "fx",
    "valuation_multiple", "supply_availability",
}
VALID_SEVERITIES: set[str] = {"low", "medium", "high", "critical"}


def test_every_universe_sector_has_profile():
    """Every sector that appears in the universe MUST have a library entry."""
    universe_sectors = {sector for _, _, sector in DEFAULT_UNIVERSE}
    missing = universe_sectors - set(SECTOR_RISK_LIBRARY.keys())
    assert not missing, (
        f"Universe sectors missing from sector library: {missing}. "
        "Either add a SectorRiskProfile or remove the sector from the universe."
    )


def test_all_sectors_helper_matches_keys():
    assert set(all_sectors()) == set(SECTOR_RISK_LIBRARY.keys())


@pytest.mark.parametrize("sector", sorted(SECTOR_RISK_LIBRARY.keys()))
def test_sector_risks_have_valid_channels(sector):
    profile = SECTOR_RISK_LIBRARY[sector]
    for risk in profile.risks:
        for ch in risk.channels:
            assert ch in VALID_CHANNELS, (
                f"Sector {sector} risk {risk.key} has invalid channel {ch}"
            )
        assert risk.severity in VALID_SEVERITIES, (
            f"Sector {sector} risk {risk.key} has invalid severity {risk.severity}"
        )


@pytest.mark.parametrize("sector", sorted(SECTOR_RISK_LIBRARY.keys()))
def test_sector_opportunities_have_valid_channels(sector):
    profile = SECTOR_RISK_LIBRARY[sector]
    for opp in profile.opportunities:
        for ch in opp.channels:
            assert ch in VALID_CHANNELS, (
                f"Sector {sector} opp {opp.key} has invalid channel {ch}"
            )


@pytest.mark.parametrize("sector", sorted(SECTOR_RISK_LIBRARY.keys()))
def test_sector_geographic_exposure_sums_close_to_1(sector):
    """Geographic exposure is a partition — should sum to ~1.0."""
    profile = SECTOR_RISK_LIBRARY[sector]
    if not profile.default_geographic_exposure:
        # Empty is OK for sectors we haven't filled in yet.
        return
    total = sum(profile.default_geographic_exposure.values())
    assert 0.95 <= total <= 1.05, (
        f"Sector {sector} geographic exposure sums to {total:.3f}, "
        f"expected ~1.0"
    )


def test_themes_reference_live_sectors():
    """Every theme.affected_sectors must reference a sector that exists."""
    known = set(SECTOR_RISK_LIBRARY.keys())
    for key, theme in THEME_RISK_LIBRARY.items():
        for sec in theme.affected_sectors:
            assert sec in known, (
                f"Theme {key} references unknown sector {sec}"
            )


def test_get_sector_profile_returns_none_for_unknown():
    assert get_sector_profile("NotARealSector") is None


def test_risks_for_company_filters_by_industry():
    """Auto-only risk should filter out non-Automobile tickers."""
    auto_risks = risks_for_company("Consumer Discretionary", industry="Automobiles")
    other_risks = risks_for_company("Consumer Discretionary", industry="Retail")
    auto_keys = {r.key for r in auto_risks}
    other_keys = {r.key for r in other_risks}
    # ev_demand_softness is industry-gated to Automobiles only
    assert "ev_demand_softness" in auto_keys
    assert "ev_demand_softness" not in other_keys


def test_risks_for_company_filters_by_geography():
    """Middle-east-gated risks should disappear when geo doesn't match."""
    # No middle_east exposure → middle_east_conflict should not show.
    no_me = risks_for_company(
        "Energy",
        industry=None,
        geographic_exposure={"us": 0.7, "europe": 0.3},
    )
    no_me_keys = {r.key for r in no_me}
    assert "middle_east_conflict" not in no_me_keys

    # With middle_east exposure → middle_east_conflict applies.
    has_me = risks_for_company(
        "Energy",
        industry=None,
        geographic_exposure={"us": 0.5, "middle_east": 0.5},
    )
    has_me_keys = {r.key for r in has_me}
    assert "middle_east_conflict" in has_me_keys


def test_themes_for_ticker_picks_explicit_overrides():
    """NVDA should be tagged with the Taiwan + AI datacenter themes."""
    themes = themes_for_ticker("NVDA", "Semiconductors", industry=None)
    keys = {t.key for t in themes}
    assert "taiwan_geopolitical" in keys
    assert "ai_datacenter_buildout" in keys


def test_themes_for_ticker_respects_industry_filter():
    """EV slowdown theme is Automobiles-only; non-auto Consumer Disc tickers shouldn't get it."""
    auto_themes = themes_for_ticker("TSLA", "Consumer Discretionary", industry="Automobiles")
    retail_themes = themes_for_ticker("WMT", "Consumer Discretionary", industry="Retail")
    auto_keys = {t.key for t in auto_themes}
    retail_keys = {t.key for t in retail_themes}
    assert "ev_demand_slowdown" in auto_keys
    assert "ev_demand_slowdown" not in retail_keys


def test_opportunities_for_company_filters_by_industry():
    """Pharma-only opportunities should be hidden for non-Pharma healthcare."""
    pharma_opps = opportunities_for_company("Healthcare", industry="Pharma")
    other_opps = opportunities_for_company("Healthcare", industry=None)
    pharma_keys = {o.key for o in pharma_opps}
    other_keys = {o.key for o in other_opps}
    # glp1_growth is gated to Pharma
    assert "glp1_growth" in pharma_keys
    assert "glp1_growth" not in other_keys
