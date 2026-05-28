# Public Company AI Intelligence — Design Plan

> **Status:** Awaiting approval before any code. Per the brief's §25 ("Do not code until I approve").
> **Date:** 2026-05-27
> **Scope:** Macro → sector → company → financial-impact risk intelligence on top of the existing 200-ticker Public Companies surface. Stays its own section. No changes to trial-balance engine, private analysis, Benchmark, Reports, CFO Chat, FX, or pricing.

---

## §25.1 — Current Public Companies structure audit

**Routes / pages**
- `/public-companies` → `src/pages/cfo/PublicCompanyIntelligence.tsx` — main hub. Auth-optional (renders AppShell when signed in, PublicShell anonymous).
- `/dashboard/public/search` → `PublicCompanySearchPage.tsx` — ticker search.
- `/dashboard/public/:ticker` → `PublicCompanyDashboard.tsx` — per-company dashboard. **Tabs not yet wired** ("Open full analysis" toast still says "Coming soon"; task #234 deferred).

**Hub layout (top → bottom)**
1. Header + `PublicCompanyStatusBanner` (live / no-entitlement / no-key)
2. `CompanySearchPanel` (ticker quick-lookup)
3. Layer 1: `MarketsOverview` (movers + 5 themes + 12 sectors + 6 featured comparisons) — magazine layout
4. Layer 2 (when drilled): `PublicCompaniesUniverseTable` — 200-row table, sector chips, sort, search, native-currency toggle
5. `BenchmarkingPanel` — peer-table builder
6. `AIInvestmentInterpretation` — **placeholder panel, no LLM call yet**
7. `StockDetailDrawer` (side-over on row click) — price + delta + 8-range chart + full `StockMetricGrid`. **No tabs.** "Open full analysis" + "Add as peer" are stubbed; "Ask CFO AI" works.

**Stubbed surfaces** (`docs/auth-email-verification-handoff.md`-style "operator-side" inventory):
- `AIInvestmentInterpretation` shows preview cards but doesn't call Claude. Tells the user it "activates once Sharadar key is configured + entitled" — misleading; the real gap is no orchestrator behind it.
- `/dashboard/public/:ticker` route exists but tab fan-out is deferred.
- "Add as peer" CTA returns a Coming Soon toast.

---

## §25.2 — Existing public-company data model

**Canonical FE type** — `src/lib/publicCompanyUniverse.ts::PublicCompanyFinancialSnapshot` (35 fields):

| Block | Fields |
|---|---|
| Identity | ticker, companyName, exchange, sector, industry, country, currency, mode (`demo`/`live`), source (`nasdaq`/`demo`), confidence, latestPeriod, latestPeriodEnd, lastUpdated, missingFields |
| Market | price, priceChangePct, marketCap, enterpriseValue |
| P&L | revenue, revenueGrowth, grossProfit, grossMargin, ebitda, ebitdaMargin, operatingIncome, netIncome, netMargin |
| Balance sheet | cash, grossDebt, netDebt, equity |
| Cash flow | operatingCashFlow, capex, freeCashFlow |
| Ratios | peRatio, evToEbitda, evToSales, fcfYield, dividendYield, roe, roa, roic, netDebtToEbitda, debtToEquity, currentRatio |

**Backend persistence** — `supabase/schema_phase_nasdaq_public_companies.sql`:
- `public_companies` (ticker, name, sector, industry, exchange, country, currency, ISIN, is_active, last_synced_at)
- `public_company_periods` (FK → public_companies, dimension, fiscal_period_end, **assembled_canonical_v1 JSONB**, source_payload, synced_at)
- `public_company_quotes` (FK, as_of, market_cap, EV, multiples, dividend_yield)
- `nasdaq_responses` (raw SF1/DAILY cache)
- `benchmark_peers` (org-scoped — only one with RLS)

**Universe** — `src/engine/public/universe.py::DEFAULT_UNIVERSE` — 202 tickers × 12 sectors, with optional industry sub-tags (Software, Payments/Fintech, Aerospace, Pharma, Retail, etc.).

**Sectors (12, normalized from Sharadar)**: Technology, Semiconductors, Communication, Consumer Discretionary, Consumer Defensive, Healthcare, Financials, Industrials, Energy, Utilities, Real Estate, Materials.

**Endpoints (11)** — all under `/api/public/*`. Health, search, company envelope, sync, universe, sectors, universe-search, status, price-history, refresh, compare.

**Existing AI surface** — only CFO Chat (cfo_ai.py:1175 `_format_public_company_context`). The system prompt receives a `LlmPublicCompanyContext` block when the user is viewing a ticker page. Strict "use the figures below, never invent" anti-hallucination instruction. **No separate Claude call for risk/exposure/interpretation exists today.**

---

## §25.3 — Proposed Risk Intelligence architecture

The brief says "`/backend/public-companies/intelligence/`". This codebase is Python FastAPI under `src/engine/`, so the actual location is **`src/engine/public/intelligence/`** — same parent dir as the existing Sharadar adapter, kept separate from `src/engine/api/` (trial-balance pipeline) and `src/engine/country_packs/ro_romania/` (RO engine). The trial-balance engine is untouched.

**New backend tree**:

```
src/engine/public/intelligence/
  __init__.py
  sector_risk_library.py        # static sector → risk-dimension table (Python data)
  company_exposure_service.py   # ticker → CompanyExposureProfile (sector-derived + override)
  risk_scoring_engine.py        # deterministic 0–100 score (no LLM in critical path)
  opportunity_scoring_engine.py # symmetric opportunity score
  macro_signal_service.py       # IntelligenceSignal store + query
  signal_orchestrator.py        # ties signals → affected companies via sector exposure
  ai_market_read.py             # Claude Opus interpretation layer (LLM, optional)
  intelligence_cache.py         # short-TTL cache for hot risk-radar/macro-signals queries

src/engine/public/intelligence/adapters/   # signal-feed plug-ins (provider-agnostic)
  __init__.py
  base.py                        # SignalAdapter protocol
  manual_signal_adapter.py       # operator uploads / pastes signals — works without external provider
  rss_signal_adapter.py          # stub for RSS; gated by env
  news_signal_adapter.py         # stub for news API; gated by env
  commodity_signal_adapter.py    # stub for commodity feed; gated by env
  rates_signal_adapter.py        # stub for rates/FX feed; gated by env

src/engine/public/intelligence/routes.py   # new FastAPI router, mounted under /api/public/intelligence/*
```

**Critical engineering boundaries**:
- ZERO imports from `src/engine/api/_ro_coa.py` or `src/engine/country_packs/` or the trial-balance pipeline.
- The new module reads `assembled_canonical_v1` envelopes from `public_company_periods` (already canonical-schema persisted — this is the integration seam).
- LLM is **interpretation only** — `risk_scoring_engine.py` computes the numeric score deterministically. Per the brief §10: "Do not let AI produce the numeric score alone. AI can interpret and explain."
- All signal adapters implement the same `SignalAdapter` Protocol. When the env var for a provider isn't set, the adapter returns `{configured: false}` and the route exposes feature-status, not fake data. Per the brief §6 and §21: "If a provider is not configured: show 'Signal source not configured.' Do not make dead buttons."

---

## §25.4 — Proposed sector risk library (data)

Static Python dict (versioned in git, editable as we learn). Each sector → list of `RiskDimension`s, each with default severity + financial-impact channels. Example shape:

```python
SECTOR_RISK_LIBRARY = {
  "Semiconductors": SectorRiskProfile(
    risks=[
      RiskDimension("taiwan_concentration", severity="critical",
        channels=["supply_availability", "ebitda_margin", "inventory"],
        affected_tickers=["NVDA","TSM","AMD","INTC","AVGO","QCOM","MU","AMAT","LRCX","ASML"]),
      RiskDimension("export_controls",       severity="high",     channels=["revenue", "supply_availability"]),
      RiskDimension("china_demand",          severity="high",     channels=["revenue", "ebitda_margin"]),
      RiskDimension("ai_capex_cycle",        severity="medium",   channels=["revenue", "capex"],  polarity="opportunity"),
      RiskDimension("advanced_packaging",    severity="medium",   channels=["supply_availability"]),
      RiskDimension("power_availability",    severity="medium",   channels=["capex", "supply_availability"]),
    ],
    opportunities=[...],
    geographic_concentration={"taiwan": 0.6, "us": 0.3, "korea": 0.1, ...},
  ),
  "Cloud / Datacenter / AI infrastructure": SectorRiskProfile(...),
  "Automotive": SectorRiskProfile(...),
  "Food / Consumer staples": SectorRiskProfile(...),
  "Energy": SectorRiskProfile(...),
  "Banks / Financials": SectorRiskProfile(...),
  # ... + the 6 other sectors from the universe (Industrials, Utilities, Healthcare, Real Estate, Communication, Materials)
}
```

**Initial library covers the 12 sectors already in the universe** so every existing ticker has a sector-derived exposure profile out of the box. The brief's six worked examples (Semis, Cloud, Auto, Food, Energy, Banks) are populated to the depth shown in §9 of the brief; the other six get a leaner default profile we expand as needed.

**Tickers-per-risk mapping** is derived from the universe + industry sub-tags so we don't double-maintain ticker lists. (E.g. "AI capex cycle" auto-maps to tickers in Semiconductors with industry=GPU/AI accelerator + Cloud tickers with industry=Hyperscaler.)

---

## §25.5 — Proposed company exposure model

```python
@dataclass(frozen=True)
class CompanyExposureProfile:
    ticker: str
    company_name: str
    sector: str
    industry: Optional[str]

    geographic_exposure: dict[str, float]   # {us: 0.4, china: 0.2, ...} — sums ≈ 1.0
    supply_chain_exposure: dict[str, float] # {semiconductors: 0.8, energy: 0.3, ...} — independent dimensions
    financial_sensitivity: dict[str, float] # {interest_rates: 0.6, fx: 0.4, ...} — 0–1 sensitivity

    risk_score: int                # 0–100, deterministic, from risk_scoring_engine
    opportunity_score: int         # 0–100

    main_risks: list[RiskRef]      # ordered by impact
    main_opportunities: list[OpportunityRef]

    confidence: float              # 0–1
    source: Literal["filings", "sector_model", "ai_inferred", "manual"]
    last_updated: datetime
```

**Resolution order** (cheapest first):
1. **Manual override** — operator uploads via `manual_signal_adapter`. Source = `manual`.
2. **Filings-derived** (Phase 2) — extract from latest 10-K/10-Q risk factors via Claude. Source = `filings`. Stub-only at Phase 1.
3. **Sector model** — derived from `SECTOR_RISK_LIBRARY[company.sector]` + industry-sub-tag overlay. Source = `sector_model`. **This is what 100% of companies use at MVP.**
4. **AI-inferred** (Phase 2) — Claude proposes refinements that an operator approves. Source = `ai_inferred`. Phase 1 stub-only.

**Always label the source in the UI.** Per brief §8: "Do not present inferred exposure as verified fact."

---

## §25.6 — Proposed UI changes

**`/public-companies` becomes a tabbed workspace.** The current hub layout (Markets Overview → Universe table → Benchmarking → AI Interp) keeps its order but moves under tabs so a user can navigate to Risk Radar / Macro Signals without scrolling past everything.

Tab order (matches brief §2):

| Tab | Backed by | Phase | Notes |
|---|---|---|---|
| Overview | MarketsOverview + key risk-radar cards (preview) | A | Adds 3 small risk-radar tiles at top of the existing MarketsOverview |
| Market Universe | existing PublicCompaniesUniverseTable + new risk columns | A | +AI Risk, Main Risk, Opportunity columns; sortable; click-through to drawer |
| Risk Radar | new — 8 risk-category cards | A | Geopolitical / Supply Chain / Energy / Rates & Credit / FX / Regulation / Technology / Consumer demand |
| Supply Chain | new — per-company exposure bars | A (sector) / B (company-specific) | Source label = `sector_model` at MVP |
| Macro Signals | new — signal feed | A (sector-model state) / B (live feed) | Shows "Live signal feed not connected — sector exposure models active" when no live adapter |
| Peer Groups | existing BenchmarkingPanel | A | unchanged |
| AI Market Read | replaces AIInvestmentInterpretation | A | actually calls Claude Opus; cites signals; labels confidence |

**StockDetailDrawer gains internal tabs** (currently flat — section §17 of brief):

`Overview | Financials | Stock Chart | Risk Radar | Supply Chain | Macro Signals | Valuation | Benchmark | Reports | Ask CFO AI`

We don't ship all 10 in Phase A. Phase A drawer tabs: **Overview | Chart | Risk | Supply Chain | Ask CFO AI** (5). The rest get added in Phase B (Financials/Valuation/Benchmark/Reports) once the `/dashboard/public/:ticker` route is properly wired (task #234).

**Universe table column additions** (per brief §13):
- "AI Risk" badge (Low green / Medium yellow / High orange / Critical red)
- "Main Risk" — short label, derived from `CompanyExposureProfile.main_risks[0]`
- "Opportunity" — 0–100 with light-green chip
- "Source" badge — `sector_model` / `manual` / `filings` so users see provenance

**i18n** — all new strings live in `auth.*` / `intelligence.*` namespaces in `en/ro/fr.json`. We do not invent new locales.

---

## §25.7 — Proposed data-source strategy

**Three-tier signal model**:

| Tier | What | Source | Always-on? |
|---|---|---|---|
| Tier 0 | Sector exposure | `SECTOR_RISK_LIBRARY` (in-repo Python) | Yes |
| Tier 1 | Company financial signals | computed from `assembled_canonical_v1` (existing Sharadar SF1 data) — high leverage, margin compression, capex spike, FCF deterioration | Yes |
| Tier 2 | Macro signals (manual) | operator pastes / uploads into `intelligence_signals` table via `manual_signal_adapter` | Yes, but starts empty |
| Tier 3 | Macro signals (live feed) | RSS / news API / commodity feed / rates feed via the adapter Protocol | Off until provider env var is set; UI shows "Live signal feed not connected" |

Tiers 0+1+2 deliver real intelligence with **zero external provider dependency**. The brief explicitly demands this in §6 and §21. We do not block MVP on operator-side feed setup.

**Adapter contract** (per `SignalAdapter` Protocol):

```python
class SignalAdapter(Protocol):
    name: str
    configured: bool                                    # False when env missing
    def fetch_recent_signals(self, since: datetime) -> list[IntelligenceSignal]: ...
    def health(self) -> AdapterHealth: ...               # status + reason
```

When `configured == False`, the route surfaces `{adapter: "rss", configured: false, reason: "RSS_FEED_URL not set"}`. The Macro Signals tab renders an EmptyState with a specific action (link to docs/handoff explaining the env var to set).

---

## §25.8 — What works WITHOUT a live signal provider (Phase A complete)

This is the MVP. **Everything below ships from sector library + financial signals from existing Sharadar data:**

1. **Risk Radar** — 8 category cards populated from sector library aggregation across the 200-ticker universe.
2. **Universe table** with AI Risk / Main Risk / Opportunity columns + Source badge.
3. **Supply Chain tab** — per-company exposure bars labeled `sector_model`.
4. **AI Market Read** — Claude Opus interpretation of available data (financial snapshot + sector risk profile + financial-derived risk flags). Cites no live news, says so explicitly.
5. **CFO Chat enrichment** — extends existing `LlmPublicCompanyContext` to also carry the risk-score + main risks. The chat already grounds responses; we just give it more material.
6. **Drawer Risk tab** — overall score + 7 category sub-scores + top 3 risks + top 3 opportunities + financial-impact channels.

**The brief's headline use-cases ("Which semiconductor companies are most exposed to Taiwan risk?") all work in Phase A** because Taiwan exposure is encoded in the sector library. The answers cite "sector exposure model" as the source, not "live news."

---

## §25.9 — What needs future provider integration (Phase B/C)

Not blockers for MVP. Each provider integration is one adapter file + one env var + an operator-side handoff:

| Capability | Provider option | Env | Adapter file | Phase |
|---|---|---|---|---|
| Real-time news signals | NewsAPI / Bloomberg RSS / Reuters | `NEWS_API_KEY` | `news_signal_adapter.py` | B |
| Geopolitical risk feed | GDELT / ICRG (manual annotation viable Phase A) | `GDELT_ENABLED` | `geopolitical_adapter.py` | B |
| Commodity prices | EIA / FRED | `EIA_API_KEY` | `commodity_signal_adapter.py` | B |
| Interest rate / FX signals | FRED + ECB | `FRED_API_KEY` | `rates_signal_adapter.py` | B |
| 10-K/10-Q risk-factor extraction | SEC EDGAR + Claude | `SEC_EDGAR_ENABLED` + Claude API key (already configured) | extends company_exposure_service | C |
| Shipping / logistics signals | Container freight indices / Suez/Red-Sea status | manual at Phase A; provider TBD | `logistics_adapter.py` | C |

Phase A ships with all adapter stubs returning `configured: false`. Phase B adds providers one at a time without disturbing the MVP.

---

## §25.10 — Test plan

**Unit tests** (Python pytest, alongside `src/engine/public/`):

| File | Validates |
|---|---|
| `tests/intelligence/test_sector_risk_library.py` | Every sector in universe has a profile; risk dimensions reference valid financial-impact channels; ticker affiliations resolve to live tickers |
| `tests/intelligence/test_company_exposure_service.py` | Sector-model resolution path; manual override beats sector model; missing-sector fallback; source label is always set |
| `tests/intelligence/test_risk_scoring_engine.py` | Score is deterministic (same inputs → same output across 100 runs); high-leverage flag triggers; high-sector-risk flag triggers; weights sum to 1.0; AI-only path is forbidden (assertion in test) |
| `tests/intelligence/test_opportunity_scoring_engine.py` | Symmetric to risk scoring; AI capex beneficiary flag; pricing power flag |
| `tests/intelligence/test_macro_signal_service.py` | Manual signal insert → query → linked-tickers derivation; no provider configured → returns `configured: false` |
| `tests/intelligence/test_ai_market_read.py` | Claude call mocked; cited signal IDs all exist; no factual claims about live news when adapters are unconfigured; output schema validation |
| `tests/intelligence/test_routes.py` | All 9 new endpoints return 200 with expected envelope; feature flag reflects adapter status |

**E2E (Playwright)** — `tests/e2e/public-company-ai-intelligence-flow.spec.ts` per brief §23 flow:

1. Open `/public-companies`
2. Click Risk Radar tab → see 8 risk-category cards
3. Click Semiconductors card → drill to filtered universe (NVDA/TSM/AMD visible with "Supply Chain — Taiwan" main-risk label)
4. Click NVDA row → drawer opens with Risk tab populated (overall score, category scores, top 3 risks include "Taiwan concentration")
5. Click "Ask CFO AI" → chat opens with NVDA context including risk-score
6. Send: "What are Nvidia's biggest future risks?"
7. Assert response references "Taiwan", "supply chain", and cites the sector exposure model (NOT live news)
8. Navigate to Macro Signals tab → assert EmptyState ("Live signal feed not connected") because no adapter is configured in test env

**Synthetic-input harness** (per Lock #12 in `ADR-F3.16-closure.md`): when implementing risk scoring, ship a "wrong-on-purpose" test fixture (e.g. a company with EBITDA margin 0% but sector=Semiconductors) that must score >70 risk — proves the engine isn't just rubber-stamping good financials.

---

## Phased rollout

| Phase | Scope | Effort estimate |
|---|---|---|
| **A — MVP** (this approval) | Backend: sector library + exposure service + risk scoring + 9 endpoints + stub adapters. DB: 8 new tables. FE: tabbed PublicCompanyIntelligence + Risk Radar + Supply Chain + Macro Signals + AI Market Read + drawer Risk tab + 3 new table columns. i18n: en/ro/fr keys. Tests: full unit + E2E. | ~5–8 sessions |
| **B — Live feeds** | RSS + news + commodity adapters. 10-K risk extraction. Wires Macro Signals tab to actual content. | ~3–4 sessions |
| **C — Filings-derived exposure** | SEC EDGAR + Claude extraction → per-company filings-derived exposure (replaces sector_model where available). | ~2–3 sessions |
| **D — Full drawer tabs** | Financials / Valuation / Benchmark / Reports tabs in drawer; wires `/dashboard/public/:ticker` properly (subsumes task #234). | ~2 sessions |

**This proposal is scoped to Phase A only.** I will not start B/C/D without separate approval.

---

## Engineering invariants (Locks #1-#12 still apply)

- §14 deploy protocol — every BE change goes host-first, rebuilt via `docker compose build backend`, no `docker cp` shortcuts.
- F-A3.1 / F-A3.2 / F-A3.3 gates run on every deploy. Trial-balance engine cannot regress — Carniprod 7.3939% canary holds.
- Synthetic harness with discriminating inputs (Lock #12) — risk scoring tests use wrong-on-purpose inputs.
- Provider-agnostic adapters (Lock #11 spirit — shared hub) — never hardcode a provider; always go through the `SignalAdapter` Protocol.
- No fake live news (brief §18) — when adapter is unconfigured the UI says so explicitly.

---

## Awaiting approval

Per §25, no code yet. Two questions before I start Phase A:

1. **Confirm the location**: `src/engine/public/intelligence/` (matches this codebase's convention) rather than the literal `/backend/public-companies/intelligence/` from the brief — same logical placement, different on-disk path.
2. **Confirm phased delivery**: ship Phase A first (full MVP, sector-model-driven, no external providers needed) — then evaluate provider integrations for Phase B based on actual signal quality observed.

If both are yes, I start with the sector risk library + risk scoring engine + DB migration. If you want a different sequencing within Phase A, say which surface to ship first (my recommendation: backend foundation → Risk Radar tab → Universe columns → AI Market Read → drawer Risk tab → tests).
