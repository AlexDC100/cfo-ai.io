# Public Company AI Intelligence

Macro-to-micro risk reasoning layer for the public-company surfaces. Sits
alongside the trial-balance engine and the Sharadar adapter; never imports
from either. Produces per-ticker risk + opportunity scores, exposure
profiles, macro signal aggregation, and a Claude Opus narrative ("AI Market
Read") that interprets — never produces — the deterministic score.

## Source-of-truth ladder

Every `CompanyExposureProfile` carries a `source` label saying which
resolution layer produced it, and a confidence value the FE renders as a
badge. Layers are tried in strict order; the first one to return a profile
wins. No blending across layers — honest labeling beats clever averaging.

| Order | `source` | Confidence | When it fires |
|-------|----------|------------|---------------|
| 1 | `manual` | **0.95** | Operator override exists for this ticker |
| 2 | `filings` | **0.85** | `SEC_EDGAR_ENABLED=1` and Claude extracted the Risk Factors section from the latest 10-K |
| 3 | `ai_inferred` | **0.70** | Reserved enum slot — Claude-only inference without a filing. Not yet implemented |
| 4 | `sector_model` | **0.55** | Always available — the in-repo `sector_risk_library.py` (12 sectors × 10 themes) |
| 5 | empty | 0.00 | Unknown sector — last-resort fallback |

The numeric risk + opportunity scores are computed **deterministically**
from the profile + financial snapshot + matched signals
(`risk_scoring_engine.py`, `opportunity_scoring_engine.py`). The LLM in
`ai_market_read.py` reads the score as input and writes the narrative; it
never produces or overrides the number. Reproducibility of scores is
non-negotiable — see `test_no_llm_in_score_path` +
`test_determinism_same_inputs_same_output`.

## Deeper docs

- `docs/public-company-intelligence-ladder.md` — full ladder + file map +
  caching design + freshness loop.
- `docs/ADR-public-intelligence-locks.md` — five architectural Locks
  (process-local labeling, LLM never produces score, source labels never
  lie, graceful degradation per provider, refresh loops not multiplying
  load).
- `docs/public-intelligence-activation-runbook.md` — step-by-step
  activation runbook including the warm-cache hit-rate verification.
- `docs/PUBLIC-COMPANY-AI-INTELLIGENCE-PLAN.md` — original 25-section
  design brief.

## Activation summary

Disabled-by-default. Set `SEC_EDGAR_ENABLED=1` + `ANTHROPIC_API_KEY` to
turn on the filings layer; without those, the engine degrades cleanly to
sector-model-only with `feed_status: "sector_model_only"` on
`/api/public/intelligence/health`. Each Phase B+C adapter
(`NEWS_API_KEY`, `RSS_FEED_URLS`, `FRED_API_KEY`, `EIA_API_KEY`,
`GDELT_ENABLED`) is independently optional — missing env = adapter
reports `configured=false` honestly and the route's `feed_status`
reflects reality.

---

## Radar category derivation (added 2026-06-01)

Risk Radar exposes 8 user-facing risk categories on the `/risk-radar`
endpoint: `geopolitical`, `supply_chain`, `energy`, `rates_credit`,
`fx`, `regulation`, `technology`, `consumer_demand`. The user clicks a
card and expects the affected-companies list to reflect real exposure
to that specific risk axis — not an alphabetical slice of overlapping
sector sets.

These 8 categories are NOT a parallel data structure. They are
**derived at call time** from the rich `SectorRiskProfile` + matched
`ThemeRiskOverlay` data already in `sector_risk_library.py`. The
derivation lives in `category_scoring.py::derive_category_scores`.
There is one source of truth (the sector library); the radar score is
a view over it.

### Two functions, two consumers — don't conflate

| Function | Returns | Consumer | Question it answers |
|---|---|---|---|
| `risk_scoring_engine.compute_risk_score(profile, financials, signals)` | `PublicCompanyRiskScore` (one composite + 7 internal categories) | `/companies/{ticker}/risk-score` page | "How risky is X overall?" |
| `company_exposure_service.score_categories_for_ticker(ticker, sector, …)` | `dict[str, float]` (8 radar categories, 0.0-1.0 each) | `/risk-radar` affected_tickers ranking | "Where does X sit on the radar?" |

Both derive from the same `SectorRiskProfile` + themes + geo. No drift
possible — single source of truth, two views. Conflating them (using
`compute_risk_score` for radar ranking) regenerates the alphabetical-
bias bug in a new disguise: every category card ranks by the same
composite score, so every card surfaces roughly the same top-12.
The 7 internal categories in `PublicCompanyRiskScore` are not the same
as the 8 radar categories — they overlap on `supply_chain` and
`geopolitical` but not the rest (no `energy`, no `rates_credit`, no
`fx`, no `technology`, no `consumer_demand`; has `macro`/`valuation`/
`operational` which the radar doesn't surface).

### Why derive, not duplicate

The first draft of this feature added a flat
`SECTOR_CATEGORY_EXPOSURE = {sector: {category: 0.0–1.0}}` matrix to
the sector library. Per Lock #11 (audit for shared hub before
per-surface plumbing), a parallel matrix would have:

1. Duplicated information already encoded in
   `default_financial_sensitivity` + `default_supply_chain_exposure` +
   `default_geographic_exposure` + theme overlays.
2. Drifted the first time someone tuned one without the other.
3. Required tests to keep both in sync forever.

The derivation has no drift surface because it's computed every call.

### Mapping from sector profile fields to radar categories

| Category | Primary input | Theme bonuses |
|---|---|---|
| `rates_credit` | `default_financial_sensitivity.interest_rates` | `high_rates_persistence` |
| `energy` | `default_financial_sensitivity.energy_prices` + `+0.10` for Energy/Utilities home sectors | `oil_price_shock`, `datacenter_power_constraint` |
| `consumer_demand` | `default_financial_sensitivity.consumer_demand` | `consumer_slowdown_global`, `ev_demand_slowdown` |
| `fx` | `default_financial_sensitivity.fx` | none — fx is a sector property, not a theme |
| `regulation` | `default_supply_chain_exposure.regulation` | none — regulation is a sector property |
| `supply_chain` | MAX of `default_supply_chain_exposure` curated physical axes (`semiconductors`, `metals`, `shipping`, `food_commodities`); excludes `regulation`, `energy`, `cloud_infrastructure`, `labor` | `taiwan_geopolitical`, `red_sea_shipping` |
| `technology` | `0.75` baseline for Technology/Semiconductors sectors + `default_supply_chain_exposure.cloud_infrastructure × 0.50` | `ai_datacenter_buildout`, `datacenter_power_constraint` |
| `geopolitical` | MAX of geographic exposure to risky regions (`taiwan`, `china`, `middle_east`, `russia`) **× 1.5** (see below) | `taiwan_geopolitical`, `oil_price_shock`, `red_sea_shipping` |

Theme bonus is `+0.15` per matched theme, capped at `+0.30` total per
category, so a flood of themes can't overwhelm the sector signal.

### Why supply_chain uses MAX of a curated allowlist (not avg, not all axes)

Two reasons:

1. **MAX vs average:** A company with one tall axis (semiconductor
   dependency at 0.95) IS supply-chain critical even if other axes are
   low. Averaging dilutes that — Semiconductors' supply_chain came out
   to 0.44 under averaging vs 0.95 under MAX. The CFO mental model of
   "supply chain risk" is "what's your single biggest dependency,"
   not "what's your average across categories you only sort-of depend
   on."

2. **Curated allowlist:** `default_supply_chain_exposure` contains
   `cloud_infrastructure` and `labor` axes that don't belong in the
   supply-chain category (cloud is technology, labor is universal and
   would create flat ratings everywhere). The allowlist (`semis`,
   `metals`, `shipping`, `food_commodities`) is what the user means by
   "supply chain risk." This avoided Technology ranking high in
   supply_chain due to a `cloud_infrastructure: 0.80` field that's
   already in the technology category.

### The geographic risk multiplier (1.5×)

`_GEOGRAPHIC_RISK_MULTIPLIER = 1.5` in `category_scoring.py`. This is
NOT a magic constant.

A linear `max(geo)` under-weights what "Taiwan exposure" actually
means at the CFO level. Semiconductors has `taiwan: 0.35` (35% of
revenue from Taiwan) — under linear pass-through that produces
geopolitical=0.35, which loses to Semis' fx=0.55 in the
discriminating test ("Semis should rank HIGH in geopolitical, LOWER
in fx"). That's wrong: 35% revenue concentration in a critical-tension
region is materially more geopolitical risk than 0.35 suggests.

Taiwan exposure isn't a linear weight, it's a categorical "your
supply chain breaks if this region breaks" risk. The 1.5× multiplier
brings the Semis profile up to 0.525 raw, which after theme bonus
(taiwan_geopolitical matched) crosses the discriminating threshold.

**Do not tune this constant back to 1.0** thinking it's arbitrary.
The Lock #12 discriminating test (`_run_self_test` in
category_scoring.py) fires if you do: the Semiconductors HIGH-LOW gap
collapses from +0.125 to -0.05.

Raising the multiplier above 1.5 would start to over-inflate
moderate-exposure sectors (Materials china=0.25 → 0.375, Energy
middle_east=0.20 → 0.30). Validated empirically on the 12-sector
library; widen only if a sector legitimately needs higher geopolitical
ranking and theme bonuses can't reach it.

---

## Per-sector diversity cap on radar rankings (added 2026-06-01)

Honest scoring produces sector-uniform top-12 in categories where one
sector legitimately dominates (Utilities = 1.0 in rates_credit because
every Utility shares `default_financial_sensitivity.interest_rates`).
A radar card surfacing only Utilities (rates_credit) or only
Semiconductors (supply_chain) fails the underlying user need:
situational awareness across sectors. The cap forces top-12 to draw
from ≥3 sectors.

  Where: `routes.py _MAX_TICKERS_PER_SECTOR_PER_CATEGORY = 4`

**Counterintuitive empirical finding** (don't tighten without re-running
Gate A): cap=3 produced *worse* overlap than cap=4 (8/28 pairs over
threshold vs 5/28). Mechanism — tighter cap forces MORE sectors into
each top-12 list; when two categories share top sectors (real
correlation), each shared sector contributes the cap value to overlap.
Three shared sectors at cap=3 = 9/12 (75%); same three at cap=4 = also
~9/12, but cap=4 fits more total signal so fewer sectors are shared
overall. The cap mechanism is at its empirical ceiling at this data
resolution. The deeper fix — per-ticker financial variation that breaks
within-sector score ties — lands when SEC filings extraction is wired.

## Documented structural correlations

At sector-default-only scoring resolution, 4 of 28 category pairs
overlap above the 50% Gate A threshold. These are HONEST CFO-level
correlations, not bugs:

| Pair | Overlap | Shared dominant sectors |
|---|---|---|
| energy × fx | 83% | Consumer Defensive + Energy (globally exposed input costs AND multi-currency revenue) |
| geopolitical × supply_chain | 67% | Semiconductors (Taiwan concentration + semi-supply fragility) |
| rates_credit × regulation | 67% | Utilities + Financials (heavily regulated AND long-duration debt) |
| supply_chain × energy | 58% | Materials + Consumer Defensive (energy-intensive AND commodity-supply) |

Surfaced via `diversity_status: "structural_correlation"` +
`structural_correlations` array in the radar response. FE renders these
as inline footnotes inside the affected_tickers list, not as card-level
badges — specificity ("Shares 8 of 12 with Regulation — both driven by
Utilities + Financials") beats hedging ("closely related").

**Lock #8 worked example — predicted-vs-observed discrepancy** is the
discriminator. The first pass at this list predicted 2 correlated pairs
ahead of Gate A; the data showed 4. The 2 surprises (rates_credit ×
regulation, supply_chain × energy) matched the SAME pattern — dominant-
sector convergence on real correlations, not wiring bugs. Treating the
surprises as bugs because they weren't predicted would have been Lock
#8 in reverse: letting prediction define reality. The pattern (ALL 4
over-threshold pairs are structurally explainable, ZERO are random) is
itself the strongest evidence the model is well-characterized at this
resolution. A future failing pair like `technology × consumer_demand`
WOULD be a wiring bug — the data shouldn't produce uncorrelated
overlaps at this magnitude.

The 50% Gate A threshold is the honest floor for sector-default-only
scoring. When SEC filings extraction is wired and within-sector
variation breaks the structural ties, this threshold tightens (back
toward the original 33% / ≤4-of-12 design target).

## BVB overrides (added 2026-06-01)

Romanian-listed companies on the BVB universe (Phase 1, see
`src/engine/public/bvb_seed.py`) use the same 12 sector names as the
NASDAQ universe (Financials, Energy, Utilities, etc.) but have
country-specific exposure shapes that don't match sector defaults:

- Romanian banks have **higher rates sensitivity** than US average
  (smaller, less-liquid market amplifies NIM compression risk).
- Romanian energy companies have **higher regulation exposure** (state
  price caps + Russian-gas alternative narrative).
- Romanian healthcare has **higher regulation exposure** (gov pricing).
- Romanian consumer companies have **higher FX exposure** (smaller,
  more volatile RON).
- Hidroelectrica has **100% Romania geographic exposure**, not the
  Utilities sector default of `{us: 0.85, rest_of_world: 0.15}`.

`bvb_overrides.py` is a per-ticker data table layered on top of sector
defaults via `company_exposure_service.py::build_company_exposure_profile`.
Each entry can carry:

- `category_exposures` — per-category 0-1 floats that overwrite the
  derived score for specific categories (e.g. TLV rates_credit=0.92)
- `geographic_exposure` — region weights that overwrite the sector
  default (the Hidroelectrica fix: `{romania: 1.0}`)
- `notes` — free-text explaining why this override exists, so the
  next engineer doesn't tune it away thinking it's stale

The merge order in `build_company_exposure_profile`:

1. Sector default (`SECTOR_RISK_LIBRARY[sector]`)
2. BVB ticker override (if present) — replaces matching fields, leaves
   others untouched
3. (Future) filings extraction (if `SEC_EDGAR_ENABLED=1` and the
   ticker has filings — currently US-only)

When an override fires, `company_exposure_service` logs at INFO level
exactly once per `(ticker, field)` combination per process lifetime.
This lets the operator audit production logs to confirm the overrides
they expected to fire actually fired.

---

## Sparse-row handling — what happens when a BVB ticker has no financials

The BVB Phase 1 seed covers 20 BET-index tickers; 7 have full FY2024
financial fields (TLV, SNP, SNG, H2O, CFH, M, SFG), the other 13 are
**ticker + name + sector only** until the operator fills them via the
admin xlsx upload (see `scripts/seed_bvb_companies.py --xlsx ...`).

The `compute_risk_score` engine accepts a `financials: dict` and uses
`.get()` with mid-pack defaults (`50`) when fields are missing. If
sparse BVB rows flowed through this scorer unmodified, they would:

- Rank mid-pack in every category
- Look "moderately exposed to everything" — false signal
- Displace legitimately high-exposure companies from the top-12

The radar's `affected_tickers` ranking therefore **filters out
tickers with no financials before sorting by score**. Specifically:
the routes.py `/risk-radar` handler skips any (ticker, category) pair
where `financials` is missing or empty before computing the per-pair
score. The 13 sparse BVB tickers don't appear in affected lists; they
remain in the universe table for individual lookup.

When the operator fills financials via the xlsx loader, those tickers
**automatically join the rankings**. No code change needed. The
radar's view of Romania expands the day each ticker's financials
land.

Trade-off acknowledged: Romania is partially-represented in the radar
until all 20 BET tickers have financials. The alternative (default-mid
50) would look fuller but ship false data. Per the source-of-truth
ladder above, honest labeling beats clever averaging — same principle.

---

## Lock invariants this code preserves

| Lock | What it protects | Where it's enforced |
|---|---|---|
| Lock #8 | Plan-doc predictions need empirical verification before declaring done | `category_scoring._run_self_test` runs two discriminating-cluster tests before routes.py wiring; tunable constants documented inline with the empirical signal they target |
| Lock #11 | No parallel data structures for shared hub | The 8 radar categories are derived, not duplicated — `category_scoring.py` has no `SECTOR_CATEGORY_EXPOSURE` matrix |
| Lock #12 | Discriminating tests with wrong-on-purpose inputs | `_run_self_test` includes a Consumer-Defensive test AND a Semiconductors test — the second is the one that would fail under a naive `max(geo)` formulation, which is exactly what catches geographic-risk under-weighting before it ships |

Test homes:
- `category_scoring.py` — `_run_self_test` (Lock #12 cluster test + cross-sector rates_credit ranking sentinel)
- `tests/intelligence/test_risk_scoring_engine.py` — `test_determinism_same_inputs_same_output`, `test_no_llm_in_score_path`
- `tests/intelligence/test_company_exposure_service.py` — BVB overrides merge order + once-per-process logging
- `tests/intelligence/test_routes.py` — radar response shape + per-category top-12 ranking discrimination (no two categories share >40% of top-12 tickers, the Gate A check codified)

If you change a tunable in `category_scoring.py` or
`sector_risk_library.py`, expect at least one of these tests to fire.
That's the design, not a bug.
