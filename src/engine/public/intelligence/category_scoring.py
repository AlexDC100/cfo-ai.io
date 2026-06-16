"""Category scoring — derive the 8 Risk Radar categories from existing
sector profiles + themes.

Step 1 of the Risk Radar rework (2026-06-01).

THE PROBLEM THIS SOLVES
-----------------------
`routes.py` `/risk-radar` previously computed `affected_tickers` per
category by filtering the universe to companies whose sector matched any
risk-relevant sector, then sorting the result alphabetically and taking
the first 12. With a 200-ticker universe and overlapping sector sets,
this produced the same alphabetically-first 12 tickers (AAPL ABBV ABNB
ACN ADBE ADI …) across Supply Chain, Consumer Demand, Technology, etc.

The user's complaint was correct in spirit: clicking different cards
surfaced the same companies because alphabetical sort overwhelms any
real category-specific exposure signal.

THE FIX
-------
Compute a per-(ticker, category) exposure score from the existing
SectorRiskProfile + ThemeRiskOverlay data. Rank by score descending, not
alphabetically. Same input data, just used properly.

DESIGN PRINCIPLE — Lock #11 (avoid parallel data structures)
------------------------------------------------------------
The first draft of this feature would have added a flat
`SECTOR_CATEGORY_EXPOSURE = {sector: {category: 0.0–1.0}}` matrix to
`sector_risk_library.py`. That would have been a second source of truth
competing with the existing rich profile model — guaranteed drift the
first time someone tuned one without the other.

Instead, every category score is DERIVED at call time from:
  - the sector's `default_financial_sensitivity` dict (the operator's
    "rates_credit / fx / energy / consumer_demand" categories map 1-1
    here),
  - the sector's `default_supply_chain_exposure` dict (curated allowlist
    of physical-supply axes for the "supply_chain" category;
    `regulation` for the "regulation" category),
  - the sector's `default_geographic_exposure` dict (region weights to
    high-tension areas for the "geopolitical" category),
  - matched `ThemeRiskOverlay`s via `themes_for_ticker` (theme bonuses
    bump the relevant categories — taiwan_geopolitical → geopolitical,
    ai_datacenter_buildout → technology, etc.),
  - sector identity (Technology / Semiconductors get a baseline tech
    score; Energy / Utilities get a small energy boost).

Per-ticker bvb_overrides.py (separate file, Phase 2 of this rework) can
inject ticker-specific adjustments on top.

DISCRIMINATING TESTS — Lock #12 (wrong-on-purpose validation)
-------------------------------------------------------------
The 8 derived scores PER SECTOR are validated by two intra-sector
discriminating tests:

  Consumer Defensive: HIGH cluster (consumer_demand, supply_chain, fx,
                      energy) should each be ≥ LOW cluster
                      (geopolitical, technology, rates_credit) + 0.10.

  Semiconductors: HIGH cluster (geopolitical, supply_chain, technology)
                  should each be ≥ LOW cluster (rates_credit,
                  regulation, fx) + 0.10.

Both tests must pass before this module is wired into routes.py. If a
naive scoring (e.g. flat 0.5 per category) produced these scores, the
tests would not discriminate — so passing them proves the derivation
exercises the underlying profile structure correctly.

Run discriminating tests:

    python -m engine.public.intelligence.category_scoring --self-test
"""

from __future__ import annotations

from typing import Optional

from .sector_risk_library import (
    SECTOR_RISK_LIBRARY,
    SectorRiskProfile,
    ThemeRiskOverlay,
    themes_for_ticker,
)


# ── The 8 Risk Radar categories ─────────────────────────────────────────
# Mirrors routes.py /risk-radar handler. Adding a category here without
# also adding it there (or vice versa) breaks the radar — both must move
# in lockstep.

CATEGORIES: tuple[str, ...] = (
    "geopolitical",
    "supply_chain",
    "energy",
    "rates_credit",
    "fx",
    "regulation",
    "technology",
    "consumer_demand",
)


# ── Theme → category boost map ──────────────────────────────────────────
# Which themes bump which categories. A theme can boost multiple
# categories (red_sea_shipping is both a geopolitical AND supply_chain
# signal). Polarity of the theme (risk vs opportunity) is intentionally
# IGNORED here — exposure to AI capex IS exposure to the technology
# category, whether the net polarity is positive (NVDA tailwind) or
# negative (multiple compression on rates). The radar shows risk SCORES,
# but the affected_tickers ranking captures total exposure.

_THEME_CATEGORY_BOOSTS: dict[str, set[str]] = {
    "taiwan_geopolitical":         {"geopolitical", "supply_chain"},
    "oil_price_shock":             {"geopolitical", "energy"},
    "red_sea_shipping":            {"geopolitical", "supply_chain"},
    "high_rates_persistence":      {"rates_credit"},
    "consumer_slowdown_global":    {"consumer_demand"},
    "ev_demand_slowdown":          {"consumer_demand"},
    "ai_datacenter_buildout":      {"technology"},
    "datacenter_power_constraint": {"technology", "energy"},
    "glp1_secular":                set(),  # opportunity-only — no risk-category boost
    "defense_spending_uplift":     set(),  # opportunity-only — no risk-category boost
}

# Per-match theme bonus. Multiple matches stack but each contribution is
# capped via min(0.30, …) — themes are signal, not the whole picture.
_THEME_BONUS_PER_MATCH: float = 0.15
_THEME_BONUS_MAX_TOTAL: float = 0.30


# ── Curated axis allowlists ─────────────────────────────────────────────
# These prevent the "Technology is supply-chain-exposed because
# cloud_infrastructure=0.80" problem. cloud_infrastructure is a
# tech-category axis, not a supply-chain-category axis.

# Physical supply axes — what we mean by "supply chain risk":
# semiconductor dependency, metals, shipping, agri/food commodities.
# `regulation` and `energy` get their own categories. `labor` is
# universal and would create flat ratings; intentionally excluded.
# `cloud_infrastructure` is technology-category.
_SUPPLY_CHAIN_AXES = frozenset({
    "semiconductors", "metals", "shipping", "food_commodities",
})

# Geographies that contribute to the geopolitical category. Other
# regions (us, europe, korea) are stable / low-tension and don't bump
# the geopolitical score.
_RISKY_GEOGRAPHIES = ("taiwan", "china", "middle_east", "russia")

# Geographic risk concentration multiplier. Raw geographic-exposure
# weights are share-of-revenue (taiwan=0.35 means 35% of revenue from
# Taiwan). Even a 35% concentration in a critical-tension region is
# materially geopolitical risk — a linear pass-through under-weights
# what a CFO actually means by "Taiwan-exposed." Multiplier of 1.5
# brings the Semiconductors profile (taiwan=0.35) up to 0.525 raw,
# which after theme bonus crosses the materially-higher-than-fx (0.55)
# threshold the discriminating test enforces.
#
# Validated via _run_self_test() — the Semiconductors HIGH/LOW gap is
# the discriminating signal. Raising the multiplier above 1.5 would
# start to inflate moderate-exposure sectors (Materials china=0.25,
# Energy middle_east=0.20) past their natural rank.
_GEOGRAPHIC_RISK_MULTIPLIER = 1.5

# Sectors that get a baseline tech-category score from their sector
# identity alone (in addition to any theme matches).
_TECH_BASELINE_SECTORS = frozenset({"Technology", "Semiconductors"})
_TECH_SECTOR_BASELINE = 0.75

# Cloud-infrastructure exposure also feeds the technology category at
# half-weight (so a sector with cloud_infrastructure=0.80 contributes
# 0.40 to its technology score).
_CLOUD_TO_TECH_WEIGHT = 0.50

# Sectors that get a small extra boost on the energy category (their
# entire business model orbits energy prices).
_ENERGY_HOME_SECTORS = frozenset({"Energy", "Utilities"})
_ENERGY_HOME_BOOST = 0.10


# ── Score derivation ────────────────────────────────────────────────────

def derive_category_scores(
    *,
    profile: SectorRiskProfile,
    themes_applied: list[ThemeRiskOverlay],
    geographic_exposure: Optional[dict[str, float]] = None,
    category_overrides: Optional[dict[str, float]] = None,
) -> dict[str, float]:
    """Derive 8 Risk Radar category exposures from the sector profile +
    matched themes.

    Returns a dict keyed by category in `CATEGORIES`, with values in
    `[0.0, 1.0]` rounded to 3 decimals. The score is "how exposed is
    this sector/ticker to this risk axis," not "how bad is it" —
    severity is captured separately by `risk_scoring_engine`.

    `geographic_exposure` overrides the sector's default. Use it for
    BVB tickers where the per-ticker override (~100% Romania for
    Hidroelectrica) materially changes the geopolitical score.

    `category_overrides` is a GENERIC, exchange-agnostic per-category
    overlay applied at the END of derivation. The caller (currently
    `company_exposure_service`) is responsible for sourcing the
    override map (e.g. from `bvb_overrides.get_bvb_overrides(ticker).
    category_exposures`). This function knows nothing about BVB or any
    other exchange — it just trusts the caller's overrides as the
    final word for the categories present. Adding a future exchange
    (Warsaw, Athens) means adding a new `<xxx>_overrides.py` data
    file and a service-layer dispatch; this function never changes.
    Only categories explicitly in the override map are replaced;
    unmentioned categories retain their derived value.
    """
    fin = profile.default_financial_sensitivity
    sup = profile.default_supply_chain_exposure
    geo = geographic_exposure or profile.default_geographic_exposure

    # Aggregate theme bonuses per category. Each matched theme contributes
    # `_THEME_BONUS_PER_MATCH` to the categories it boosts, capped at
    # `_THEME_BONUS_MAX_TOTAL` per category so a flood of themes can't
    # overwhelm the sector signal.
    theme_keys = {t.key for t in themes_applied}
    theme_bonus: dict[str, float] = {cat: 0.0 for cat in CATEGORIES}
    for tk in theme_keys:
        for boosted_cat in _THEME_CATEGORY_BOOSTS.get(tk, ()):
            theme_bonus[boosted_cat] += _THEME_BONUS_PER_MATCH
    for cat in theme_bonus:
        theme_bonus[cat] = min(theme_bonus[cat], _THEME_BONUS_MAX_TOTAL)

    # ── Per-category derivation ──

    # rates_credit ← interest_rate sensitivity + high_rates theme
    rates_credit = fin.get("interest_rates", 0.0) + theme_bonus["rates_credit"]

    # energy ← energy_prices sensitivity + sector-home boost + theme
    energy_home_boost = _ENERGY_HOME_BOOST if profile.sector in _ENERGY_HOME_SECTORS else 0.0
    energy = (
        fin.get("energy_prices", 0.0)
        + energy_home_boost
        + theme_bonus["energy"]
    )

    # consumer_demand ← consumer_demand sensitivity + consumer-themes
    consumer_demand = fin.get("consumer_demand", 0.0) + theme_bonus["consumer_demand"]

    # fx ← fx sensitivity (no theme overlay — fx is largely a sector property)
    fx = fin.get("fx", 0.0)

    # regulation ← regulation supply-axis (no theme overlay — regulation
    # is largely a sector property; theme additions would need a separate
    # regulation theme map)
    regulation = sup.get("regulation", 0.0)

    # supply_chain ← max over curated physical-supply axes + supply-themes
    physical_axes_present = [v for k, v in sup.items() if k in _SUPPLY_CHAIN_AXES]
    supply_max = max(physical_axes_present, default=0.0)
    supply_chain = supply_max + theme_bonus["supply_chain"]

    # technology ← sector-identity baseline + cloud-infra contribution + themes
    tech_baseline = _TECH_SECTOR_BASELINE if profile.sector in _TECH_BASELINE_SECTORS else 0.0
    cloud_contrib = sup.get("cloud_infrastructure", 0.0) * _CLOUD_TO_TECH_WEIGHT
    technology = tech_baseline + cloud_contrib + theme_bonus["technology"]

    # geopolitical ← max geographic exposure to risky regions, amplified
    # by _GEOGRAPHIC_RISK_MULTIPLIER, plus theme bonuses
    geo_max = max((geo.get(r, 0.0) for r in _RISKY_GEOGRAPHIES), default=0.0)
    geopolitical = geo_max * _GEOGRAPHIC_RISK_MULTIPLIER + theme_bonus["geopolitical"]

    # Cap all scores at 1.0 and round.
    raw = {
        "rates_credit":    rates_credit,
        "energy":          energy,
        "consumer_demand": consumer_demand,
        "fx":              fx,
        "regulation":      regulation,
        "supply_chain":    supply_chain,
        "technology":      technology,
        "geopolitical":    geopolitical,
    }
    scores = {cat: round(min(1.0, max(0.0, v)), 3) for cat, v in raw.items()}

    # Generic per-category overlay applied at the very end. Caller-
    # supplied override wins absolutely for the categories it mentions;
    # unmentioned categories keep their derived value. Out-of-range
    # values and unknown category keys are silently dropped — the
    # validator in `bvb_overrides._validate_overrides` enforces the
    # 0-1 range + valid keys at the data layer, so any garbage that
    # reaches this point is a caller bug, not user data.
    if category_overrides:
        for cat, override_val in category_overrides.items():
            if cat in CATEGORIES and isinstance(override_val, (int, float)):
                clamped = round(min(1.0, max(0.0, float(override_val))), 3)
                scores[cat] = clamped

    return scores


def derive_category_scores_for_sector(
    sector: str,
    *,
    ticker: Optional[str] = None,
    industry: Optional[str] = None,
    geographic_exposure: Optional[dict[str, float]] = None,
    category_overrides: Optional[dict[str, float]] = None,
) -> dict[str, float]:
    """Convenience wrapper — looks up the sector profile and matched
    themes, then calls `derive_category_scores`.

    `ticker` is needed for explicit_tickers theme matches (e.g. EQIX
    being explicitly tagged for ai_datacenter_buildout even though it's
    a Real Estate sector). Pass `ticker=""` to get sector-only scores
    (no per-ticker theme overrides).

    `category_overrides` threads through to derive_category_scores for
    parity — the service layer is the canonical caller, but tests + ad-
    hoc inspection benefit from the same shape here.
    """
    profile = SECTOR_RISK_LIBRARY.get(sector)
    if profile is None:
        return {cat: 0.0 for cat in CATEGORIES}
    themes_applied = themes_for_ticker(ticker or "", sector, industry)
    return derive_category_scores(
        profile=profile,
        themes_applied=themes_applied,
        geographic_exposure=geographic_exposure,
        category_overrides=category_overrides,
    )


# ── Discriminating self-test (Lock #12) ─────────────────────────────────

def _run_self_test() -> int:
    """Two discriminating tests on the derived scores. Returns 0 on
    success, 1 on failure. Run as
    `python -m engine.public.intelligence.category_scoring --self-test`.

    The tests verify that the derivation distinguishes high-exposure
    categories from low-exposure ones INTRA-SECTOR — a naive flat scorer
    (e.g. every category gets 0.5) would fail both. Per Lock #12, a
    discriminating test is one that FAILS under the wrong implementation.
    """
    MIN_GAP = 0.10  # HIGH cluster must beat LOW cluster by at least this much

    failures: list[str] = []

    def _check(label: str, scores: dict[str, float],
               high: list[str], low: list[str]) -> None:
        print(f"\n── {label} ──")
        for cat in CATEGORIES:
            cluster = "HIGH" if cat in high else ("LOW" if cat in low else "    ")
            print(f"  {cat:<16} {scores[cat]:.3f}  [{cluster}]")

        # Every HIGH must beat every LOW by >= MIN_GAP.
        min_high = min(scores[c] for c in high)
        max_low = max(scores[c] for c in low)
        gap = min_high - max_low
        verdict = "PASS" if gap >= MIN_GAP else "FAIL"
        print(f"  → min(HIGH)={min_high:.3f}  max(LOW)={max_low:.3f}  "
              f"gap={gap:+.3f}  {verdict}")
        if gap < MIN_GAP:
            failures.append(
                f"{label}: HIGH-LOW gap {gap:.3f} < {MIN_GAP} "
                f"(min HIGH {min_high:.3f} <= max LOW {max_low:.3f} + {MIN_GAP})"
            )

    # ── Test 1 — Consumer Defensive ──
    # Expected: consumer_demand + supply_chain + fx + energy are
    # the HIGH cluster (food cos are food-commodity / FX / consumer
    # exposed). geopolitical + technology + rates_credit are LOW
    # (food cos aren't tech, aren't high-debt, aren't Taiwan-exposed).
    scores_cd = derive_category_scores_for_sector(
        "Consumer Defensive", ticker="KO",
    )
    _check(
        "Consumer Defensive (KO)",
        scores_cd,
        high=["consumer_demand", "supply_chain", "fx", "energy"],
        low=["geopolitical", "technology", "rates_credit"],
    )

    # ── Test 2 — Semiconductors ──
    # Expected: geopolitical + supply_chain + technology are the
    # HIGH cluster (Taiwan exposure, semis supply concentration, AI
    # capex). rates_credit + regulation + fx are LOWER.
    scores_semi = derive_category_scores_for_sector(
        "Semiconductors", ticker="NVDA",
    )
    _check(
        "Semiconductors (NVDA)",
        scores_semi,
        high=["geopolitical", "supply_chain", "technology"],
        low=["rates_credit", "regulation", "fx"],
    )

    # ── Test 3 — cross-sector discrimination ──
    # The same category should rank sectors plausibly: rates_credit
    # should be highest for Real Estate, Utilities, Financials and
    # lowest for Semiconductors / Materials.
    print("\n── Cross-sector check: rates_credit ranking ──")
    rates_by_sector = []
    for sector in SECTOR_RISK_LIBRARY:
        s = derive_category_scores_for_sector(sector, ticker="")
        rates_by_sector.append((sector, s["rates_credit"]))
    rates_by_sector.sort(key=lambda x: x[1], reverse=True)
    for sector, score in rates_by_sector:
        print(f"  {sector:<24} {score:.3f}")
    top3 = {s for s, _ in rates_by_sector[:3]}
    expected_top3 = {"Real Estate", "Utilities", "Financials"}
    overlap = top3 & expected_top3
    print(f"  top-3 = {top3}  expected ⊇ {expected_top3}  overlap={len(overlap)}/3")
    if len(overlap) < 2:
        failures.append(
            f"Cross-sector rates_credit ranking: top-3 = {sorted(top3)}, "
            f"expected to include ≥2 of {sorted(expected_top3)}"
        )

    # ── Test 4 — generic category_overrides semantics ──
    # Mimics how `company_exposure_service` will call the function: pass
    # a category_overrides map (e.g. from bvb_overrides for TLV) and
    # verify the override wins. This is the discriminating gate against
    # the override being silently dropped during refactors.
    print("\n── Override semantics: category_overrides applied ──")
    override_map = {"rates_credit": 0.92, "regulation": 0.70, "fx": 0.65}
    scores_override = derive_category_scores_for_sector(
        "Financials", ticker="",
        category_overrides=override_map,
    )
    # Each overridden category must equal the override exactly. Untouched
    # categories must equal the un-overridden value (verified by computing
    # without the override).
    scores_base = derive_category_scores_for_sector("Financials", ticker="")
    for cat, expected in override_map.items():
        if abs(scores_override[cat] - expected) > 1e-6:
            failures.append(
                f"category_overrides[{cat!r}]={expected} did not propagate; "
                f"got {scores_override[cat]}"
            )
            print(f"  {cat:<16} {scores_override[cat]:.3f}  [FAIL — expected {expected}]")
        else:
            print(f"  {cat:<16} {scores_override[cat]:.3f}  [override applied ✓]")
    untouched = [c for c in CATEGORIES if c not in override_map]
    for cat in untouched:
        if scores_override[cat] != scores_base[cat]:
            failures.append(
                f"category {cat!r} unexpectedly changed when not in override "
                f"({scores_base[cat]} → {scores_override[cat]})"
            )

    print("\n" + ("=" * 60))
    if failures:
        print(f"FAIL — {len(failures)} discriminating test(s) failed:")
        for f in failures:
            print(f"  • {f}")
        return 1
    print("PASS — all discriminating tests passed")
    return 0


if __name__ == "__main__":
    import sys
    if "--self-test" in sys.argv:
        raise SystemExit(_run_self_test())
    print("Usage: python -m engine.public.intelligence.category_scoring --self-test")


__all__ = [
    "CATEGORIES",
    "derive_category_scores",
    "derive_category_scores_for_sector",
]
