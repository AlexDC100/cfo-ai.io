"""Company exposure resolution — sector model + manual override paths."""

from __future__ import annotations

from datetime import datetime, timezone

from engine.public.intelligence.company_exposure_service import (
    SECTOR_MODEL_CONFIDENCE,
    build_company_exposure_profile,
    build_universe_exposure_profiles,
)
from engine.public.intelligence.models import (
    CompanyExposureProfile,
    OpportunityRef,
    RiskRef,
)
from engine.public.universe import DEFAULT_UNIVERSE, INDUSTRY


def test_sector_model_path_returns_sector_source():
    p = build_company_exposure_profile(
        ticker="NVDA",
        company_name="NVIDIA Corp",
        sector="Semiconductors",
        industry=None,
    )
    assert p.source == "sector_model"
    assert p.confidence == SECTOR_MODEL_CONFIDENCE
    assert p.ticker == "NVDA"
    assert p.sector == "Semiconductors"


def test_unknown_sector_returns_empty_zero_confidence_profile():
    """Per design plan §25.5: unknown sectors get empty fallback at conf=0
    so the FE knows we have nothing real to say."""
    p = build_company_exposure_profile(
        ticker="ZZZ",
        company_name="Made Up Co",
        sector="NotARealSector",
        industry=None,
    )
    assert p.source == "sector_model"
    assert p.confidence == 0.0
    assert p.geographic_exposure == {}
    assert p.main_risks == []
    assert p.main_opportunities == []


def test_manual_override_short_circuits():
    """A passed-in manual_overrides MUST be returned as-is — never overlaid
    by the sector model."""
    manual = CompanyExposureProfile(
        ticker="NVDA",
        company_name="NVIDIA Corp",
        sector="Semiconductors",
        industry=None,
        geographic_exposure={"japan": 1.0},   # nonsense, intentionally
        supply_chain_exposure={"unique_dep": 0.99},
        financial_sensitivity={"unique_sens": 0.88},
        main_risks=[
            RiskRef(
                key="manual_risk",
                label="Operator-uploaded risk",
                severity="high",
                channels=["revenue"],
                explanation="Test override",
            ),
        ],
        main_opportunities=[],
        confidence=0.95,
        source="manual",
        last_updated=datetime.now(timezone.utc),
    )
    p = build_company_exposure_profile(
        ticker="NVDA",
        company_name="NVIDIA Corp",
        sector="Semiconductors",
        industry=None,
        manual_overrides=manual,
    )
    assert p is manual
    assert p.source == "manual"
    assert p.geographic_exposure == {"japan": 1.0}


def test_nvda_picks_up_taiwan_and_ai_themes():
    """NVDA in the Semiconductors sector should surface both the sector's
    Taiwan-concentration risk AND the cross-sector Taiwan geopolitical
    theme + AI datacenter opportunity."""
    p = build_company_exposure_profile(
        ticker="NVDA",
        company_name="NVIDIA Corp",
        sector="Semiconductors",
        industry=None,
    )
    risk_keys = {r.key for r in p.main_risks}
    opp_keys = {o.key for o in p.main_opportunities}
    assert "taiwan_concentration" in risk_keys, (
        f"NVDA missing Taiwan concentration risk; got: {risk_keys}"
    )
    assert "taiwan_geopolitical" in risk_keys, (
        f"NVDA missing Taiwan geopolitical theme; got: {risk_keys}"
    )
    assert "ai_capex_beneficiary" in opp_keys, (
        f"NVDA missing AI capex opportunity; got: {opp_keys}"
    )
    assert "ai_datacenter_buildout" in opp_keys, (
        f"NVDA missing AI datacenter theme; got: {opp_keys}"
    )


def test_main_risks_ordered_by_severity():
    """The resolution puts critical first, then high, then medium, low."""
    p = build_company_exposure_profile(
        ticker="NVDA",
        company_name="NVIDIA Corp",
        sector="Semiconductors",
        industry=None,
    )
    rank = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    severities = [rank[r.severity] for r in p.main_risks]
    assert severities == sorted(severities), (
        f"main_risks should be ordered by severity; got: "
        f"{[r.severity for r in p.main_risks]}"
    )


def test_build_universe_exposure_profiles_covers_all_tickers():
    """The bulk builder should produce a profile for every ticker in
    DEFAULT_UNIVERSE — even sectors with leaner library coverage."""
    profiles = build_universe_exposure_profiles(
        DEFAULT_UNIVERSE,
        industry_lookup=dict(INDUSTRY),
    )
    universe_tickers = {t for t, _, _ in DEFAULT_UNIVERSE}
    assert set(profiles.keys()) == universe_tickers
    for ticker, prof in profiles.items():
        assert prof.ticker == ticker
        assert prof.source == "sector_model"


def test_industry_lookup_threaded_through():
    """An auto-only risk like ev_demand_softness should land on Tesla
    (industry=Automobiles) but NOT on Costco (Consumer Defensive)."""
    profiles = build_universe_exposure_profiles(
        DEFAULT_UNIVERSE,
        industry_lookup=dict(INDUSTRY),
    )
    if "TSLA" in profiles:
        tsla = profiles["TSLA"]
        keys = {r.key for r in tsla.main_risks}
        assert "ev_demand_softness" in keys, (
            f"TSLA should have ev_demand_softness; got {keys}"
        )
