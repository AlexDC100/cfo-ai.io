"""Sector risk library — the macro-knowledge layer of the AI Intelligence engine.

A static Python data module versioned in git. Editable as we learn — every
change here is a code change that flows through review + tests.

Indexed by the 12 sector names that appear in src/engine/public/universe.py
(Communication, Consumer Defensive, Consumer Discretionary, Energy, Financials,
Healthcare, Industrials, Materials, Real Estate, Semiconductors, Technology,
Utilities). Every sector in the universe MUST have a profile here — the
sector library is what makes Phase A work without any external news feed.

The brief's 6 "worked" sectors (Semiconductors, Cloud/Datacenter/AI [a theme,
not a sector — see THEME_RISK_LIBRARY below], Automotive [→ Consumer
Discretionary], Food [→ Consumer Defensive], Energy, Banks [→ Financials])
get deeper-than-default coverage. The other 6 (Communication, Healthcare,
Industrials, Materials, Real Estate, Technology, Utilities) get leaner
defaults we expand as use cases prove out.

Cross-cutting THEMES (AI datacenters, Red Sea, Taiwan, EV slowdown, etc.)
are stored in THEME_RISK_LIBRARY — these overlay on top of sector exposure
to capture cross-sector phenomena.

A ticker's effective exposure = sector_profile ∪ industry_overlay ∪ theme_overlay.
Resolution lives in company_exposure_service.py.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from .models import FinancialImpactChannel, Polarity, Severity


@dataclass(frozen=True)
class RiskDimension:
    """One named risk a sector is exposed to (e.g. 'Taiwan concentration')."""
    key: str
    label: str
    severity: Severity
    channels: list[FinancialImpactChannel]
    # Optional refinement: only applies to specific industry sub-tags within
    # the sector. Empty list = applies to whole sector.
    applies_to_industries: list[str] = field(default_factory=list)
    # Optional refinement: only applies when the ticker has exposure to one
    # of these geographies. Used by company_exposure_service to scope risk
    # to companies that are actually exposed.
    requires_geography: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class OpportunityDimension:
    """Symmetric to RiskDimension — a structural tailwind for the sector."""
    key: str
    label: str
    strength: Severity   # "high" = strong tailwind
    channels: list[FinancialImpactChannel]
    applies_to_industries: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class SectorRiskProfile:
    """One sector's complete exposure picture: risks + opportunities + defaults.

    `default_geographic_exposure` is the sector's typical geographic
    distribution when we don't have company-specific data (used by
    company_exposure_service for sector_model fallback). Sums ≈ 1.0.

    `default_supply_chain_exposure` and `default_financial_sensitivity` are
    independent 0–1 dimensions — a sector can be highly exposed on many
    axes simultaneously.
    """
    sector: str
    risks: list[RiskDimension]
    opportunities: list[OpportunityDimension] = field(default_factory=list)
    default_geographic_exposure: dict[str, float] = field(default_factory=dict)
    default_supply_chain_exposure: dict[str, float] = field(default_factory=dict)
    default_financial_sensitivity: dict[str, float] = field(default_factory=dict)


@dataclass(frozen=True)
class ThemeRiskOverlay:
    """A cross-sector risk theme (AI datacenter, Taiwan, Red Sea, EV slowdown).

    Themes overlay onto sector profiles. A ticker is exposed to a theme if it
    matches one of `affected_sectors` AND one of `affected_industries_or_all`.
    """
    key: str
    label: str
    polarity: Polarity                # "risk" or "opportunity"
    severity_or_strength: Severity
    channels: list[FinancialImpactChannel]
    affected_sectors: list[str]
    affected_industries_or_all: list[str] = field(default_factory=list)  # empty = whole sector
    # Optional ticker overrides — for tickers the theme touches even if they
    # don't match the sector/industry filter (e.g. EQIX is Real Estate but
    # is a major AI-datacenter beneficiary).
    explicit_tickers: list[str] = field(default_factory=list)


# ═════════════════════════════════════════════════════════════════════════
# THE 12 SECTOR PROFILES
# ═════════════════════════════════════════════════════════════════════════

# Workhorse channels used repeatedly — declared once for legibility below.
_C = {
    "rev":        "revenue",
    "gm":         "gross_margin",
    "ebitda":     "ebitda_margin",
    "capex":      "capex",
    "wc":         "working_capital",
    "inv":        "inventory",
    "debt":       "debt_cost",
    "fx":         "fx",
    "mult":       "valuation_multiple",
    "supply":     "supply_availability",
}


SECTOR_RISK_LIBRARY: dict[str, SectorRiskProfile] = {

    # ─── Semiconductors ──────────────────────────────────────────────────
    "Semiconductors": SectorRiskProfile(
        sector="Semiconductors",
        risks=[
            RiskDimension(
                key="taiwan_concentration",
                label="Taiwan manufacturing concentration",
                severity="critical",
                channels=[_C["supply"], _C["ebitda"], _C["inv"]],
            ),
            RiskDimension(
                key="export_controls",
                label="US/China export controls",
                severity="high",
                channels=[_C["rev"], _C["supply"]],
            ),
            RiskDimension(
                key="china_demand",
                label="China demand softness",
                severity="high",
                channels=[_C["rev"], _C["ebitda"]],
            ),
            RiskDimension(
                key="capex_cycle",
                label="Capex cycle volatility",
                severity="medium",
                channels=[_C["capex"], _C["mult"]],
            ),
            RiskDimension(
                key="advanced_packaging",
                label="Advanced-packaging bottleneck",
                severity="medium",
                channels=[_C["supply"]],
            ),
            RiskDimension(
                key="power_availability",
                label="Fab power & water constraints",
                severity="medium",
                channels=[_C["capex"], _C["supply"]],
            ),
        ],
        opportunities=[
            OpportunityDimension(
                key="ai_capex_beneficiary",
                label="AI infrastructure capex tailwind",
                strength="high",
                channels=[_C["rev"], _C["ebitda"]],
            ),
            OpportunityDimension(
                key="onshoring_subsidies",
                label="CHIPS Act / EU subsidies",
                strength="medium",
                channels=[_C["capex"]],
            ),
        ],
        default_geographic_exposure={
            "us": 0.30, "taiwan": 0.35, "china": 0.15, "korea": 0.10,
            "europe": 0.05, "rest_of_world": 0.05,
        },
        default_supply_chain_exposure={
            "semiconductors": 0.95, "energy": 0.40, "metals": 0.30,
            "labor": 0.30, "regulation": 0.50, "cloud_infrastructure": 0.20,
        },
        default_financial_sensitivity={
            "interest_rates": 0.40, "fx": 0.55, "energy_prices": 0.45,
            "commodity_prices": 0.50, "consumer_demand": 0.50,
            "capex_cycle": 0.85,
        },
    ),

    # ─── Technology (software + hyperscalers + IT services) ──────────────
    "Technology": SectorRiskProfile(
        sector="Technology",
        risks=[
            RiskDimension(
                key="enterprise_it_slowdown",
                label="Enterprise IT spending slowdown",
                severity="high",
                channels=[_C["rev"]],
            ),
            RiskDimension(
                key="ai_capex_overrun",
                label="AI capex overrun vs monetization",
                severity="high",
                channels=[_C["capex"], _C["ebitda"], _C["mult"]],
            ),
            RiskDimension(
                key="datacenter_power",
                label="Datacenter power & cooling constraints",
                severity="high",
                channels=[_C["capex"], _C["supply"]],
                applies_to_industries=["Software"],
            ),
            RiskDimension(
                key="regulation_antitrust",
                label="Antitrust + DSA/DMA regulation",
                severity="medium",
                channels=[_C["rev"], _C["mult"]],
            ),
            RiskDimension(
                key="rate_sensitivity",
                label="High-multiple compression on rates",
                severity="medium",
                channels=[_C["mult"]],
            ),
            RiskDimension(
                key="open_source_ai",
                label="Open-source model commoditization",
                severity="medium",
                channels=[_C["gm"], _C["mult"]],
            ),
        ],
        opportunities=[
            OpportunityDimension(
                key="ai_revenue",
                label="AI revenue inflection",
                strength="high",
                channels=[_C["rev"], _C["ebitda"]],
            ),
            OpportunityDimension(
                key="cloud_migration",
                label="Cloud migration continued",
                strength="medium",
                channels=[_C["rev"]],
            ),
        ],
        default_geographic_exposure={
            "us": 0.60, "europe": 0.20, "china": 0.05, "rest_of_world": 0.15,
        },
        default_supply_chain_exposure={
            "semiconductors": 0.50, "cloud_infrastructure": 0.80,
            "labor": 0.70, "energy": 0.40, "regulation": 0.60,
        },
        default_financial_sensitivity={
            "interest_rates": 0.70, "fx": 0.50, "energy_prices": 0.20,
            "consumer_demand": 0.30, "capex_cycle": 0.60,
        },
    ),

    # ─── Communication (telcos + media + social) ─────────────────────────
    "Communication": SectorRiskProfile(
        sector="Communication",
        risks=[
            RiskDimension(
                key="ad_market_cyclicality",
                label="Advertising market cyclicality",
                severity="high",
                channels=[_C["rev"], _C["ebitda"]],
            ),
            RiskDimension(
                key="streaming_saturation",
                label="Streaming subscriber saturation",
                severity="medium",
                channels=[_C["rev"], _C["mult"]],
            ),
            RiskDimension(
                key="ai_content_disruption",
                label="Generative AI content disruption",
                severity="medium",
                channels=[_C["rev"], _C["mult"]],
            ),
            RiskDimension(
                key="regulation_content",
                label="Content moderation + DSA enforcement",
                severity="medium",
                channels=[_C["debt"], _C["mult"]],
            ),
            RiskDimension(
                key="capex_5g_fiber",
                label="5G/fiber capex burden (telcos)",
                severity="medium",
                channels=[_C["capex"], _C["debt"]],
            ),
        ],
        opportunities=[
            OpportunityDimension(
                key="ai_ad_uplift",
                label="AI-driven ad targeting uplift",
                strength="medium",
                channels=[_C["rev"], _C["ebitda"]],
            ),
        ],
        default_geographic_exposure={"us": 0.55, "europe": 0.25, "rest_of_world": 0.20},
        default_supply_chain_exposure={
            "labor": 0.50, "cloud_infrastructure": 0.50, "regulation": 0.60,
        },
        default_financial_sensitivity={
            "interest_rates": 0.50, "fx": 0.40, "consumer_demand": 0.65,
        },
    ),

    # ─── Consumer Discretionary (autos + retail + travel + apparel) ──────
    "Consumer Discretionary": SectorRiskProfile(
        sector="Consumer Discretionary",
        risks=[
            RiskDimension(
                key="consumer_slowdown",
                label="Consumer spending slowdown",
                severity="high",
                channels=[_C["rev"], _C["ebitda"]],
            ),
            RiskDimension(
                key="ev_demand_softness",
                label="EV demand softness vs prior expectations",
                severity="high",
                channels=[_C["rev"], _C["inv"]],
                applies_to_industries=["Automobiles"],
            ),
            RiskDimension(
                key="china_competition_autos",
                label="China EV competition (BYD etc.)",
                severity="high",
                channels=[_C["rev"], _C["gm"]],
                applies_to_industries=["Automobiles"],
            ),
            RiskDimension(
                key="battery_minerals",
                label="Battery mineral cost volatility",
                severity="medium",
                channels=[_C["gm"], _C["inv"]],
                applies_to_industries=["Automobiles"],
            ),
            RiskDimension(
                key="tariffs",
                label="Tariff + trade-war exposure",
                severity="medium",
                channels=[_C["rev"], _C["gm"]],
            ),
            RiskDimension(
                key="financing_rates",
                label="Consumer financing rates",
                severity="medium",
                channels=[_C["rev"]],
                applies_to_industries=["Automobiles"],
            ),
            RiskDimension(
                key="ecommerce_amazon_pressure",
                label="Amazon / e-comm margin pressure",
                severity="medium",
                channels=[_C["gm"], _C["ebitda"]],
                applies_to_industries=["Retail"],
            ),
        ],
        opportunities=[
            OpportunityDimension(
                key="premiumization",
                label="Premium / luxury pricing power",
                strength="medium",
                channels=[_C["gm"]],
            ),
        ],
        default_geographic_exposure={
            "us": 0.50, "europe": 0.20, "china": 0.15, "rest_of_world": 0.15,
        },
        default_supply_chain_exposure={
            "semiconductors": 0.60, "metals": 0.55, "shipping": 0.55,
            "energy": 0.40, "labor": 0.55,
        },
        default_financial_sensitivity={
            "interest_rates": 0.70, "fx": 0.45, "energy_prices": 0.40,
            "commodity_prices": 0.55, "consumer_demand": 0.90,
        },
    ),

    # ─── Consumer Defensive (food + staples + retail staples) ────────────
    "Consumer Defensive": SectorRiskProfile(
        sector="Consumer Defensive",
        risks=[
            RiskDimension(
                key="raw_material_inflation",
                label="Raw material inflation (agri/dairy/oils)",
                severity="high",
                channels=[_C["gm"], _C["ebitda"]],
            ),
            RiskDimension(
                key="retailer_pressure",
                label="Big-retailer pricing pressure",
                severity="high",
                channels=[_C["gm"], _C["ebitda"]],
            ),
            RiskDimension(
                key="private_label_competition",
                label="Private-label market share loss",
                severity="medium",
                channels=[_C["rev"], _C["gm"]],
            ),
            RiskDimension(
                key="energy_prices",
                label="Energy + packaging cost spike",
                severity="medium",
                channels=[_C["gm"]],
            ),
            RiskDimension(
                key="emerging_markets_fx",
                label="Emerging-markets FX translation",
                severity="medium",
                channels=[_C["fx"], _C["rev"]],
            ),
            RiskDimension(
                key="logistics_cost",
                label="Logistics / freight cost",
                severity="medium",
                channels=[_C["gm"]],
            ),
            RiskDimension(
                key="weight_loss_drugs",
                label="GLP-1 demand impact on packaged food",
                severity="medium",
                channels=[_C["rev"], _C["mult"]],
            ),
        ],
        opportunities=[
            OpportunityDimension(
                key="pricing_power_brand",
                label="Brand pricing power persists",
                strength="medium",
                channels=[_C["gm"]],
            ),
            OpportunityDimension(
                key="emerging_market_growth",
                label="EM volume growth",
                strength="medium",
                channels=[_C["rev"]],
            ),
        ],
        default_geographic_exposure={
            "us": 0.45, "europe": 0.20, "emerging_markets": 0.25,
            "rest_of_world": 0.10,
        },
        default_supply_chain_exposure={
            "food_commodities": 0.85, "energy": 0.55, "shipping": 0.55,
            "labor": 0.50, "regulation": 0.40,
        },
        default_financial_sensitivity={
            "interest_rates": 0.35, "fx": 0.65, "energy_prices": 0.60,
            "commodity_prices": 0.80, "consumer_demand": 0.45,
        },
    ),

    # ─── Healthcare (pharma + biotech + medtech + insurers) ──────────────
    "Healthcare": SectorRiskProfile(
        sector="Healthcare",
        risks=[
            RiskDimension(
                key="drug_pricing_reform",
                label="Drug-pricing reform (IRA / EU)",
                severity="high",
                channels=[_C["rev"], _C["gm"]],
                applies_to_industries=["Pharma"],
            ),
            RiskDimension(
                key="patent_cliff",
                label="Patent-cliff exposure",
                severity="high",
                channels=[_C["rev"], _C["mult"]],
                applies_to_industries=["Pharma"],
            ),
            RiskDimension(
                key="clinical_trial_failure",
                label="Clinical-trial failure risk",
                severity="medium",
                channels=[_C["mult"]],
                applies_to_industries=["Pharma"],
            ),
            RiskDimension(
                key="medical_loss_ratio",
                label="Medical-loss-ratio inflation (insurers)",
                severity="medium",
                channels=[_C["ebitda"]],
            ),
            RiskDimension(
                key="fx_em",
                label="EM FX translation",
                severity="low",
                channels=[_C["fx"]],
            ),
        ],
        opportunities=[
            OpportunityDimension(
                key="glp1_growth",
                label="GLP-1 / obesity-drug revenue ramp",
                strength="high",
                channels=[_C["rev"], _C["ebitda"]],
                applies_to_industries=["Pharma"],
            ),
            OpportunityDimension(
                key="aging_demographics",
                label="Aging-demographics secular tailwind",
                strength="medium",
                channels=[_C["rev"]],
            ),
        ],
        default_geographic_exposure={
            "us": 0.55, "europe": 0.20, "emerging_markets": 0.15,
            "rest_of_world": 0.10,
        },
        default_supply_chain_exposure={
            "labor": 0.55, "regulation": 0.80, "shipping": 0.30,
        },
        default_financial_sensitivity={
            "interest_rates": 0.40, "fx": 0.50, "consumer_demand": 0.25,
        },
    ),

    # ─── Financials (banks + brokers + insurance) ────────────────────────
    "Financials": SectorRiskProfile(
        sector="Financials",
        risks=[
            RiskDimension(
                key="rate_curve_inversion",
                label="Rate curve / NIM compression",
                severity="high",
                channels=[_C["rev"], _C["ebitda"]],
            ),
            RiskDimension(
                key="credit_losses",
                label="Credit-loss provisioning cycle",
                severity="high",
                channels=[_C["ebitda"]],
            ),
            RiskDimension(
                key="commercial_real_estate",
                label="Commercial real-estate exposure",
                severity="high",
                channels=[_C["ebitda"], _C["mult"]],
            ),
            RiskDimension(
                key="deposit_competition",
                label="Deposit cost / runoff",
                severity="medium",
                channels=[_C["ebitda"]],
            ),
            RiskDimension(
                key="basel_capital",
                label="Basel III/IV capital requirements",
                severity="medium",
                channels=[_C["mult"], _C["debt"]],
            ),
            RiskDimension(
                key="fintech_disintermediation",
                label="Fintech disintermediation of fees",
                severity="medium",
                channels=[_C["rev"]],
            ),
        ],
        opportunities=[
            OpportunityDimension(
                key="trading_volume_spike",
                label="Volatility-driven trading revenue",
                strength="medium",
                channels=[_C["rev"]],
            ),
            OpportunityDimension(
                key="ib_dealmaking_revival",
                label="M&A / IB dealmaking revival",
                strength="medium",
                channels=[_C["rev"]],
            ),
        ],
        default_geographic_exposure={
            "us": 0.70, "europe": 0.15, "asia": 0.10, "rest_of_world": 0.05,
        },
        default_supply_chain_exposure={
            "regulation": 0.90, "labor": 0.50, "cloud_infrastructure": 0.35,
        },
        default_financial_sensitivity={
            "interest_rates": 0.95, "fx": 0.45, "consumer_demand": 0.55,
        },
    ),

    # ─── Industrials (aerospace + machinery + transports) ────────────────
    "Industrials": SectorRiskProfile(
        sector="Industrials",
        risks=[
            RiskDimension(
                key="global_pmi_slowdown",
                label="Global PMI / capex slowdown",
                severity="high",
                channels=[_C["rev"], _C["ebitda"]],
            ),
            RiskDimension(
                key="supply_chain_volatility",
                label="Supply-chain volatility",
                severity="medium",
                channels=[_C["gm"], _C["inv"], _C["supply"]],
            ),
            RiskDimension(
                key="commodity_pass_through_lag",
                label="Commodity pass-through lag",
                severity="medium",
                channels=[_C["gm"]],
            ),
            RiskDimension(
                key="aerospace_certification",
                label="Aerospace certification delays",
                severity="medium",
                channels=[_C["rev"], _C["capex"]],
                applies_to_industries=["Aerospace"],
            ),
            RiskDimension(
                key="labor_shortage",
                label="Skilled-labor shortage",
                severity="medium",
                channels=[_C["ebitda"]],
            ),
        ],
        opportunities=[
            OpportunityDimension(
                key="defense_spending",
                label="Defense spending expansion",
                strength="high",
                channels=[_C["rev"], _C["ebitda"]],
                applies_to_industries=["Aerospace"],
            ),
            OpportunityDimension(
                key="grid_investment",
                label="Grid modernization beneficiary",
                strength="high",
                channels=[_C["rev"]],
            ),
            OpportunityDimension(
                key="onshoring_capex",
                label="Onshoring / reshoring capex",
                strength="medium",
                channels=[_C["rev"]],
            ),
        ],
        default_geographic_exposure={
            "us": 0.50, "europe": 0.25, "china": 0.10, "rest_of_world": 0.15,
        },
        default_supply_chain_exposure={
            "metals": 0.70, "energy": 0.55, "shipping": 0.55,
            "semiconductors": 0.45, "labor": 0.60,
        },
        default_financial_sensitivity={
            "interest_rates": 0.65, "fx": 0.55, "energy_prices": 0.55,
            "commodity_prices": 0.60, "capex_cycle": 0.80,
        },
    ),

    # ─── Energy (integrated oils + services + E&P) ───────────────────────
    "Energy": SectorRiskProfile(
        sector="Energy",
        risks=[
            RiskDimension(
                key="oil_price_volatility",
                label="Oil price volatility (OPEC+ / demand)",
                severity="critical",
                channels=[_C["rev"], _C["ebitda"]],
            ),
            RiskDimension(
                key="middle_east_conflict",
                label="Middle East conflict premium",
                severity="high",
                channels=[_C["supply"], _C["rev"]],
                requires_geography=["middle_east"],
            ),
            RiskDimension(
                key="energy_transition",
                label="Energy-transition demand destruction",
                severity="high",
                channels=[_C["mult"], _C["rev"]],
            ),
            RiskDimension(
                key="capex_discipline_risk",
                label="Capex-discipline reversal",
                severity="medium",
                channels=[_C["capex"], _C["ebitda"]],
            ),
            RiskDimension(
                key="regulation_emissions",
                label="Emissions regulation / methane fees",
                severity="medium",
                channels=[_C["ebitda"], _C["capex"]],
            ),
        ],
        opportunities=[
            OpportunityDimension(
                key="ai_power_demand",
                label="AI datacenter power demand",
                strength="medium",
                channels=[_C["rev"]],
            ),
            OpportunityDimension(
                key="opec_supply_discipline",
                label="OPEC+ supply discipline",
                strength="medium",
                channels=[_C["ebitda"]],
            ),
        ],
        default_geographic_exposure={
            "us": 0.50, "middle_east": 0.20, "europe": 0.10,
            "rest_of_world": 0.20,
        },
        default_supply_chain_exposure={
            "energy": 0.95, "metals": 0.40, "shipping": 0.60,
            "regulation": 0.75,
        },
        default_financial_sensitivity={
            "interest_rates": 0.55, "fx": 0.60, "energy_prices": 0.95,
            "commodity_prices": 0.90, "capex_cycle": 0.75,
        },
    ),

    # ─── Utilities (electric + water + gas) ──────────────────────────────
    "Utilities": SectorRiskProfile(
        sector="Utilities",
        risks=[
            RiskDimension(
                key="rate_case_lag",
                label="Regulatory rate-case lag",
                severity="medium",
                channels=[_C["rev"], _C["ebitda"]],
            ),
            RiskDimension(
                key="grid_capex_burden",
                label="Grid capex + balance-sheet stress",
                severity="medium",
                channels=[_C["capex"], _C["debt"]],
            ),
            RiskDimension(
                key="climate_physical",
                label="Climate physical risk (wildfire/flood)",
                severity="medium",
                channels=[_C["ebitda"], _C["debt"]],
            ),
            RiskDimension(
                key="rate_sensitivity",
                label="Long-duration valuation rate sensitivity",
                severity="high",
                channels=[_C["mult"]],
            ),
        ],
        opportunities=[
            OpportunityDimension(
                key="ai_datacenter_demand",
                label="AI datacenter electricity demand",
                strength="high",
                channels=[_C["rev"]],
            ),
            OpportunityDimension(
                key="electrification_secular",
                label="Electrification secular trend",
                strength="medium",
                channels=[_C["rev"]],
            ),
        ],
        default_geographic_exposure={"us": 0.85, "rest_of_world": 0.15},
        default_supply_chain_exposure={
            "energy": 0.80, "regulation": 0.95, "metals": 0.40,
            "labor": 0.45,
        },
        default_financial_sensitivity={
            "interest_rates": 0.85, "energy_prices": 0.45,
            "commodity_prices": 0.55,
        },
    ),

    # ─── Real Estate (REITs + commercial + data centers) ─────────────────
    "Real Estate": SectorRiskProfile(
        sector="Real Estate",
        risks=[
            RiskDimension(
                key="office_obsolescence",
                label="Office obsolescence (WFH)",
                severity="high",
                channels=[_C["rev"], _C["mult"]],
            ),
            RiskDimension(
                key="rate_sensitivity",
                label="Long-duration cap-rate sensitivity",
                severity="high",
                channels=[_C["mult"]],
            ),
            RiskDimension(
                key="refinancing_wall",
                label="Refinancing wall on high rates",
                severity="high",
                channels=[_C["debt"], _C["mult"]],
            ),
            RiskDimension(
                key="retail_oversupply",
                label="Retail real-estate oversupply",
                severity="medium",
                channels=[_C["rev"]],
            ),
        ],
        opportunities=[
            OpportunityDimension(
                key="datacenter_reit",
                label="Datacenter REIT AI tailwind",
                strength="high",
                channels=[_C["rev"], _C["ebitda"]],
            ),
            OpportunityDimension(
                key="housing_undersupply",
                label="Housing undersupply (residential REIT)",
                strength="medium",
                channels=[_C["rev"]],
            ),
        ],
        default_geographic_exposure={"us": 0.80, "europe": 0.10, "rest_of_world": 0.10},
        default_supply_chain_exposure={
            "regulation": 0.65, "energy": 0.40, "labor": 0.30,
        },
        default_financial_sensitivity={
            "interest_rates": 0.90, "energy_prices": 0.35,
            "consumer_demand": 0.45,
        },
    ),

    # ─── Materials (chemicals + mining + paper + agri-chem) ──────────────
    "Materials": SectorRiskProfile(
        sector="Materials",
        risks=[
            RiskDimension(
                key="china_demand_metals",
                label="China demand for metals",
                severity="high",
                channels=[_C["rev"], _C["ebitda"]],
            ),
            RiskDimension(
                key="commodity_cycle",
                label="Commodity-price cycle",
                severity="high",
                channels=[_C["rev"], _C["ebitda"]],
            ),
            RiskDimension(
                key="energy_costs",
                label="Energy-intensive production costs",
                severity="medium",
                channels=[_C["gm"]],
            ),
            RiskDimension(
                key="regulation_emissions",
                label="Emissions / circular-economy rules",
                severity="medium",
                channels=[_C["capex"], _C["ebitda"]],
            ),
        ],
        opportunities=[
            OpportunityDimension(
                key="ev_battery_minerals",
                label="EV battery mineral demand",
                strength="medium",
                channels=[_C["rev"]],
            ),
            OpportunityDimension(
                key="ai_copper_demand",
                label="AI/grid copper demand",
                strength="high",
                channels=[_C["rev"]],
            ),
        ],
        default_geographic_exposure={
            "us": 0.30, "china": 0.25, "europe": 0.20, "rest_of_world": 0.25,
        },
        default_supply_chain_exposure={
            "metals": 0.95, "energy": 0.85, "shipping": 0.65,
            "regulation": 0.55,
        },
        default_financial_sensitivity={
            "interest_rates": 0.55, "fx": 0.60, "energy_prices": 0.80,
            "commodity_prices": 0.95, "capex_cycle": 0.70,
        },
    ),
}


# ═════════════════════════════════════════════════════════════════════════
# CROSS-SECTOR THEMES — overlay on top of sector profiles
# ═════════════════════════════════════════════════════════════════════════

THEME_RISK_LIBRARY: dict[str, ThemeRiskOverlay] = {

    "ai_datacenter_buildout": ThemeRiskOverlay(
        key="ai_datacenter_buildout",
        label="AI datacenter capex super-cycle",
        polarity="opportunity",
        severity_or_strength="high",
        channels=[_C["rev"], _C["ebitda"]],
        affected_sectors=["Semiconductors", "Technology", "Utilities", "Industrials", "Materials"],
        explicit_tickers=["NVDA","AMD","AVGO","TSM","MSFT","GOOGL","AMZN","META",
                          "VRT","ETN","EQIX","DLR","NEE","SO","DUK"],
    ),

    "taiwan_geopolitical": ThemeRiskOverlay(
        key="taiwan_geopolitical",
        label="Taiwan geopolitical tension",
        polarity="risk",
        severity_or_strength="critical",
        channels=[_C["supply"], _C["ebitda"], _C["mult"]],
        affected_sectors=["Semiconductors", "Technology", "Consumer Discretionary"],
        explicit_tickers=["NVDA","TSM","AMD","AAPL","AVGO","QCOM","ASML"],
    ),

    "red_sea_shipping": ThemeRiskOverlay(
        key="red_sea_shipping",
        label="Red Sea / Suez shipping disruption",
        polarity="risk",
        severity_or_strength="high",
        channels=[_C["gm"], _C["wc"], _C["inv"]],
        affected_sectors=["Industrials", "Consumer Discretionary", "Consumer Defensive", "Energy", "Materials"],
    ),

    "ev_demand_slowdown": ThemeRiskOverlay(
        key="ev_demand_slowdown",
        label="EV demand slowdown / China competition",
        polarity="risk",
        severity_or_strength="high",
        channels=[_C["rev"], _C["inv"], _C["gm"]],
        affected_sectors=["Consumer Discretionary"],
        affected_industries_or_all=["Automobiles"],
    ),

    "oil_price_shock": ThemeRiskOverlay(
        key="oil_price_shock",
        label="Oil price shock (Middle East / OPEC)",
        polarity="risk",
        severity_or_strength="high",
        channels=[_C["gm"], _C["ebitda"]],
        affected_sectors=["Consumer Discretionary", "Consumer Defensive", "Industrials", "Materials"],
    ),

    "high_rates_persistence": ThemeRiskOverlay(
        key="high_rates_persistence",
        label="Persistent high interest rates",
        polarity="risk",
        severity_or_strength="high",
        channels=[_C["debt"], _C["mult"]],
        affected_sectors=["Real Estate", "Utilities", "Technology", "Consumer Discretionary"],
    ),

    "defense_spending_uplift": ThemeRiskOverlay(
        key="defense_spending_uplift",
        label="Global defense spending uplift",
        polarity="opportunity",
        severity_or_strength="high",
        channels=[_C["rev"], _C["ebitda"]],
        affected_sectors=["Industrials"],
        affected_industries_or_all=["Aerospace"],
        explicit_tickers=["LMT","RTX","NOC","GD","BA","LDOS","HII"],
    ),

    "glp1_secular": ThemeRiskOverlay(
        key="glp1_secular",
        label="GLP-1 obesity-drug secular growth",
        polarity="opportunity",
        severity_or_strength="high",
        channels=[_C["rev"], _C["ebitda"]],
        affected_sectors=["Healthcare"],
        affected_industries_or_all=["Pharma"],
        explicit_tickers=["LLY","NVO"],
    ),

    "datacenter_power_constraint": ThemeRiskOverlay(
        key="datacenter_power_constraint",
        label="Datacenter power & grid bottleneck",
        polarity="risk",
        severity_or_strength="high",
        channels=[_C["capex"], _C["supply"]],
        affected_sectors=["Technology", "Utilities"],
    ),

    "consumer_slowdown_global": ThemeRiskOverlay(
        key="consumer_slowdown_global",
        label="Global consumer spending slowdown",
        polarity="risk",
        severity_or_strength="medium",
        channels=[_C["rev"], _C["ebitda"]],
        affected_sectors=["Consumer Discretionary", "Consumer Defensive", "Communication"],
    ),
}


# ═════════════════════════════════════════════════════════════════════════
# Helpers
# ═════════════════════════════════════════════════════════════════════════

def all_sectors() -> list[str]:
    """Every sector key in the library. Used by tests + radar aggregation."""
    return sorted(SECTOR_RISK_LIBRARY.keys())


def get_sector_profile(sector: str) -> Optional[SectorRiskProfile]:
    """Sector lookup. Returns None for unknown sectors (caller decides default)."""
    return SECTOR_RISK_LIBRARY.get(sector)


def themes_for_ticker(
    ticker: str,
    sector: str,
    industry: Optional[str],
) -> list[ThemeRiskOverlay]:
    """Find every cross-sector theme that applies to this ticker.

    Resolution: a theme applies if
      (a) ticker is in `explicit_tickers`, OR
      (b) sector is in `affected_sectors` AND
          (`affected_industries_or_all` is empty OR industry matches one).
    """
    result: list[ThemeRiskOverlay] = []
    for theme in THEME_RISK_LIBRARY.values():
        if ticker in theme.explicit_tickers:
            result.append(theme)
            continue
        if sector not in theme.affected_sectors:
            continue
        if theme.affected_industries_or_all and industry not in theme.affected_industries_or_all:
            continue
        result.append(theme)
    return result


def risks_for_company(
    sector: str,
    industry: Optional[str],
    geographic_exposure: Optional[dict[str, float]] = None,
) -> list[RiskDimension]:
    """Filter a sector's risks to the ones that apply to a specific company.

    A risk applies when:
      · applies_to_industries is empty OR includes this industry
      · requires_geography is empty OR the company has non-trivial exposure
        (>5%) to one of the listed geographies

    Phase A uses sector-default geographic exposure if the caller doesn't
    pass one — see company_exposure_service.py for how the geographic map
    is resolved per ticker.
    """
    profile = SECTOR_RISK_LIBRARY.get(sector)
    if profile is None:
        return []

    geo = geographic_exposure or profile.default_geographic_exposure

    filtered: list[RiskDimension] = []
    for risk in profile.risks:
        if risk.applies_to_industries and industry not in risk.applies_to_industries:
            continue
        if risk.requires_geography:
            if not any(geo.get(g, 0) > 0.05 for g in risk.requires_geography):
                continue
        filtered.append(risk)
    return filtered


def opportunities_for_company(
    sector: str,
    industry: Optional[str],
) -> list[OpportunityDimension]:
    """Symmetric to risks_for_company — sector-level opportunities filtered."""
    profile = SECTOR_RISK_LIBRARY.get(sector)
    if profile is None:
        return []
    return [
        opp for opp in profile.opportunities
        if not opp.applies_to_industries or industry in opp.applies_to_industries
    ]
