"""BVB ticker-level exposure overrides.

Romanian-listed companies inherit sector defaults from
`sector_risk_library.py` (Financials, Energy, Utilities, etc. — same 12
sector names as the NASDAQ universe). For most exposure axes the
sector default is accurate. For a handful of axes, Romanian context
materially shifts the profile:

  · Romanian banks: higher rates_credit sensitivity (smaller, less-liquid
    market amplifies NIM compression risk).
  · Romanian energy/utility companies: higher regulation exposure (state
    price caps + state intervention) and higher geopolitical exposure
    (Russian-gas alternative narrative; Black Sea dependencies).
  · Romanian healthcare: higher regulation exposure (gov pricing).
  · Romanian consumer companies: higher FX exposure (smaller, more
    volatile RON; export-driven cohorts especially).
  · Hidroelectrica: ~100% Romanian geographic exposure, not the
    Utilities sector default of {us: 0.85, rest_of_world: 0.15}.

This file holds those overrides as PURE DATA. No code, no logic. The
merge happens in `company_exposure_service.py::build_company_exposure_profile`,
which calls `get_bvb_overrides(ticker)` and applies the returned
fields on top of the sector default.

Structure per entry:

    {
        "category_exposures": {category_key: float},   # optional
        "geographic_exposure": {region: float},        # optional
        "notes": "free-text explanation for the next engineer",
    }

`category_exposures` keys must be one of the 8 Risk Radar categories
(see CATEGORIES in `category_scoring.py`). Values are 0.0-1.0.

`geographic_exposure` keys are region strings used by
`sector_risk_library.SectorRiskProfile.default_geographic_exposure`
(`us`, `taiwan`, `china`, `middle_east`, `russia`, `europe`,
`emerging_markets`, `rest_of_world`, plus the BVB-introduced `romania`,
`eu`). Sum should be ~1.0 but is not enforced (some sectors have raw
sums that don't quite hit 1.0 either — geographic disclosures vary).

The `notes` field is the most important field for long-term hygiene.
Every override entry MUST have a one-sentence notes string explaining
the Romanian-context reason for the override. Without it, the next
engineer sees a number and either (a) tunes it away thinking it's stale
or (b) preserves it forever without knowing why. Notes are the
difference.

Phase 2 of the BVB workstream — added 2026-06-01. See
`intelligence/README.md` "BVB overrides" section for the design rationale.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)


# ── Ticker → override entries ───────────────────────────────────────────
# Tickers MUST match the storage key used in `bvb_seed.bvb_universe()`.
# In particular, the Electrica ticker is stored as "EL.BVB" to avoid
# colliding with NASDAQ's Estée Lauder; the override here uses the same
# namespaced form. Display strips the suffix downstream.

_BVB_OVERRIDES: dict[str, dict[str, Any]] = {

    # ── Financials / Banks ────────────────────────────────────────────
    "TLV": {
        "category_exposures": {
            # Higher than the Financials sector default (interest_rates=0.95
            # already; we keep it but tighten the radar score because RO
            # bank NIMs are more rate-sensitive than US average).
            "rates_credit": 0.92,
            "regulation":   0.70,
            "fx":           0.65,
        },
        "notes": (
            "Banca Transilvania — largest RO bank by deposits. NIM "
            "compression in a smaller market makes rates exposure tighter "
            "than US bank average. EU banking regulation + BNR oversight "
            "elevate regulation. FX (RON/EUR) elevates fx beyond US peers."
        ),
    },
    "BRD": {
        "category_exposures": {
            "rates_credit": 0.92,
            "regulation":   0.70,
            "fx":           0.65,
        },
        "notes": (
            "BRD-Groupe Société Générale — same NIM/regulation/FX argument "
            "as TLV. Subsidiary of a French parent so adds parent-bank "
            "regulatory exposure on top of BNR."
        ),
    },

    # ── Energy / Utilities ────────────────────────────────────────────
    "SNP": {
        "category_exposures": {
            # Energy sector default geopolitical=0.95 raw from middle_east
            # is correct for global E&P, but SNP specifically has Russian
            # gas alternative narrative + Black Sea (Neptun Deep)
            # development — keep it high, layer on regulation.
            "energy":       0.95,
            "regulation":   0.85,
            "geopolitical": 0.70,
        },
        "notes": (
            "OMV Petrom — RO state-influenced O&G. Government can impose "
            "windfall taxes / price caps (regulation 0.85). Neptun Deep "
            "development sits in a contested Black Sea zone (geopolitical "
            "0.70). Energy 0.95 retained from sector default."
        ),
    },
    "SNG": {
        "category_exposures": {
            "energy":       0.95,
            "regulation":   0.85,
            "geopolitical": 0.70,
        },
        "notes": (
            "Romgaz — largest RO natural-gas producer. Direct beneficiary "
            "of Russian-gas-alternative narrative (geopolitical 0.70 from "
            "Black Sea + EU dependency shift). State-set pricing → "
            "regulation 0.85."
        ),
    },
    "TGN": {
        "category_exposures": {
            "regulation":   0.85,
            "rates_credit": 0.55,
            "energy":       0.60,
        },
        "notes": (
            "Transgaz — national natural gas grid operator. Tariff-regulated "
            "monopoly. Rates exposure higher than typical Energy (long-duration "
            "infrastructure debt service)."
        ),
    },
    "PE": {
        "category_exposures": {
            "regulation":   0.80,
            "energy":       0.85,
            "fx":           0.65,
        },
        "notes": (
            "Premier Energy — vertically-integrated Moldovan gas + RO "
            "electricity. Cross-border exposure adds fx beyond pure-RO peers."
        ),
    },

    # ── Utilities ─────────────────────────────────────────────────────
    "H2O": {
        # The Hidroelectrica fix — sector default has us=0.85 which is
        # nonsense for a Romanian hydropower operator. Override geo to
        # actual home market.
        "geographic_exposure": {
            "romania": 0.95,
            "eu":      0.05,
        },
        "category_exposures": {
            "energy":          0.95,
            "regulation":      0.85,
            "consumer_demand": 0.45,
        },
        "notes": (
            "Hidroelectrica — ~100% RO hydropower. Geographic override is the "
            "key fix: sector default {us:0.85, row:0.15} would have ranked "
            "H2O low on RO-specific Geopolitical signals when it should be "
            "central to any RO macro view. Regulation 0.85 reflects RO state "
            "ownership stake + electricity-price-cap policy."
        ),
    },
    "SNN": {
        "category_exposures": {
            "energy":      0.95,
            "regulation":  0.85,
            "geopolitical": 0.55,
        },
        "notes": (
            "Nuclearelectrica — Cernavodă nuclear plant operator. State "
            "ownership; reactor extension + new build (Units 3+4) tied to "
            "US/Canada technology partners → moderate geopolitical exposure."
        ),
    },
    "EL.BVB": {
        "category_exposures": {
            "regulation":   0.85,
            "rates_credit": 0.65,
            "energy":       0.55,
        },
        "notes": (
            "Electrica — RO electricity distribution + supply. Tariff "
            "regulation dominant. Stored as 'EL.BVB' (namespaced to avoid "
            "NASDAQ Estée Lauder collision). Display strips the suffix."
        ),
    },
    "TEL": {
        "category_exposures": {
            "regulation":   0.85,
            "rates_credit": 0.55,
            "energy":       0.60,
        },
        "notes": (
            "Transelectrica — RO national HV transmission grid. Tariff-"
            "regulated monopoly, same shape as TGN."
        ),
    },

    # ── Healthcare / Pharma ───────────────────────────────────────────
    "M": {
        "category_exposures": {
            "regulation":      0.80,
            "consumer_demand": 0.55,
            "rates_credit":    0.45,
        },
        "notes": (
            "Med Life — RO private medical services. RO healthcare price "
            "regulation + national insurance reimbursement dominates."
        ),
    },
    "ATB": {
        "category_exposures": {
            "regulation":   0.85,
            "fx":           0.55,
            "supply_chain": 0.55,
        },
        "notes": (
            "Antibiotice Iași — RO pharma manufacturer. EU pharma regulation "
            "+ active ingredient import (fx + supply chain)."
        ),
    },

    # ── Consumer Defensive ────────────────────────────────────────────
    "CFH": {
        # The Scandia peer. Sector default for Consumer Defensive is mostly
        # right; just bump fx slightly (RO meat processors source feed +
        # packaging in EUR/USD).
        "category_exposures": {
            "consumer_demand": 0.70,
            "fx":              0.70,
            "supply_chain":    0.85,
        },
        "notes": (
            "Cris-Tim Family Holding — RO meat processor, Scandia Food's "
            "direct listed peer. Feed cost (EUR) + packaging (USD) → fx 0.70. "
            "Food commodity exposure → supply_chain 0.85 retained from "
            "sector default. Consumer demand domestic + EU export."
        ),
    },
    "AQ": {
        "category_exposures": {
            "consumer_demand": 0.65,
            "fx":              0.60,
            "supply_chain":    0.65,
        },
        "notes": (
            "Aquila Part Prod Com — RO FMCG distribution. Inflation pass-"
            "through is key consumer-demand signal. Import FX moderate."
        ),
    },

    # ── Consumer Discretionary ────────────────────────────────────────
    "SFG": {
        "category_exposures": {
            "consumer_demand": 0.85,
            "rates_credit":    0.55,
            "supply_chain":    0.50,
        },
        "notes": (
            "Sphera Franchise Group — KFC + Pizza Hut + Taco Bell across "
            "RO/IT/MD. Restaurant traffic ⇒ consumer_demand 0.85, beats "
            "sector default for franchise-leveraged operator."
        ),
    },

    # ── Industrials ───────────────────────────────────────────────────
    "TTS": {
        "category_exposures": {
            "consumer_demand": 0.55,
            "energy":          0.65,
            "geopolitical":    0.60,
        },
        "notes": (
            "Transport Trade Services — Danube barge logistics. Black Sea / "
            "Ukraine grain corridor exposure → geopolitical 0.60. Fuel cost "
            "is a meaningful operating line → energy 0.65."
        ),
    },

    # ── Real Estate ───────────────────────────────────────────────────
    "ONE": {
        "category_exposures": {
            "rates_credit": 0.85,
            "regulation":   0.55,
        },
        "notes": (
            "One United Properties — RO premium real estate developer. "
            "Mortgage-rate-sensitive + project debt → rates 0.85."
        ),
    },

    # ── Materials ─────────────────────────────────────────────────────
    "TRP": {
        "category_exposures": {
            "energy":       0.75,
            "fx":           0.60,
            "supply_chain": 0.70,
        },
        "notes": (
            "Teraplast — RO PVC pipes + insulation + steel. Energy-intensive "
            "production. PVC feedstock import (fx + supply chain)."
        ),
    },

    # ── Financials / Investment Fund ──────────────────────────────────
    "FP": {
        "category_exposures": {
            "rates_credit": 0.75,
            "fx":           0.50,
        },
        "notes": (
            "Fondul Proprietatea — RO closed-end fund. NAV is largely held "
            "stakes in BVB Energy/Utility names (H2O, SNP etc.) so its "
            "exposure profile is partially inherited; treat its risk as "
            "rate-sensitive NAV discount."
        ),
    },

    # ── Communication / Telecom ───────────────────────────────────────
    "DIGI": {
        "category_exposures": {
            "regulation":   0.70,
            "rates_credit": 0.55,
            "fx":           0.65,
        },
        "notes": (
            "Digi Communications — RO/HU/ES/IT telco. Multi-jurisdiction "
            "regulation. Heavy capex → rates moderate. Multi-currency."
        ),
    },
}


# ── Public accessors ────────────────────────────────────────────────────

def get_bvb_overrides(ticker: str) -> Optional[dict[str, Any]]:
    """Return the override entry for a BVB ticker, or None if no override.

    Callers (currently `company_exposure_service.build_company_exposure_profile`)
    should treat None as "use sector defaults unchanged."
    """
    return _BVB_OVERRIDES.get(ticker)


def all_bvb_override_tickers() -> list[str]:
    """Sorted list of every ticker that has an override entry. Used by
    tests + audit logging to confirm the override surface stays
    aligned with the BVB seed."""
    return sorted(_BVB_OVERRIDES.keys())


# ── Sanity ──────────────────────────────────────────────────────────────

def _validate_overrides() -> None:
    """Catch obvious authoring mistakes at import time:
      · every entry has a non-empty `notes` string (the Lock-#11 hygiene
        requirement)
      · `category_exposures` keys are valid radar categories
      · `category_exposures` values are in [0, 1]
      · `geographic_exposure` values sum to roughly 1.0
    """
    # Lazy import — category_scoring imports sector_risk_library which is
    # a heavier graph. We only need the CATEGORIES tuple, which is small.
    from .category_scoring import CATEGORIES
    valid_categories = set(CATEGORIES)

    for ticker, entry in _BVB_OVERRIDES.items():
        notes = entry.get("notes")
        if not notes or not isinstance(notes, str) or len(notes.strip()) < 20:
            raise ValueError(
                f"BVB override for {ticker!r} missing or too-short notes "
                f"(found {notes!r}). Every override MUST explain why."
            )
        cat_ex = entry.get("category_exposures") or {}
        for k, v in cat_ex.items():
            if k not in valid_categories:
                raise ValueError(
                    f"BVB override for {ticker!r}: unknown category "
                    f"{k!r}. Valid: {sorted(valid_categories)}"
                )
            if not isinstance(v, (int, float)) or not (0.0 <= v <= 1.0):
                raise ValueError(
                    f"BVB override for {ticker!r}: category {k!r} value "
                    f"{v!r} out of range [0, 1]."
                )
        geo = entry.get("geographic_exposure") or {}
        if geo:
            s = sum(geo.values())
            if not (0.85 <= s <= 1.15):
                raise ValueError(
                    f"BVB override for {ticker!r}: geographic_exposure "
                    f"sums to {s:.3f}, expected ~1.0. Review the weights."
                )


_validate_overrides()


# ── Startup observability ───────────────────────────────────────────────
# One-time INFO log at module-import time (= app startup), listing every
# ticker that has overrides loaded and which categories they cover. Lets
# the operator see at a glance in docker logs which overrides are in
# effect without grepping the source. Fires once per process, not per
# request — module-level execution runs exactly once per Python import
# graph. The per-override-fire INFO log lives in
# company_exposure_service.py (deduplicated via _logged set).

def _log_loaded_overrides() -> None:
    if not _BVB_OVERRIDES:
        return
    lines = [f"[bvb_overrides] loaded {len(_BVB_OVERRIDES)} ticker overrides:"]
    for ticker in sorted(_BVB_OVERRIDES.keys()):
        entry = _BVB_OVERRIDES[ticker]
        cats = entry.get("category_exposures") or {}
        geo = entry.get("geographic_exposure") or {}
        parts: list[str] = []
        if cats:
            parts.append(
                ", ".join(f"{k}={v}" for k, v in sorted(cats.items()))
            )
        if geo:
            parts.append(
                "geo=" + ", ".join(f"{k}={v}" for k, v in sorted(geo.items()))
            )
        lines.append(f"  {ticker}: {' · '.join(parts) if parts else '(notes only)'}")
    logger.info("\n".join(lines))


_log_loaded_overrides()


__all__ = [
    "get_bvb_overrides",
    "all_bvb_override_tickers",
]
