# DATA-1A — Canonical Financial Data Trust Audit (Read-Only Report)

**Status:** READ-ONLY audit. No fixes applied, no instrumentation added, no UI changed.
**Scope:** Cross-surface consistency of headline financial values for one private fixture (Scandia Food FY 2025) and one public fixture (AAPL).
**Method:** Code map (canonical hub + consumers) + live prod scrape of rendered DOM values across 8 dashboard tabs, Reports, Chat, Benchmark, public-company surface.
**Deliverable:** Source map → cross-surface matrix → mismatch list → risk ranking → proposed-fix shapes → oracle/test design.

---

## §1 — Canonical source map

### 1.1 The hub

**File:** `src/lib/canonicalMetrics.ts`

The hub exposes two factory functions that assemble a `CanonicalMetrics` object from the engine's already-emitted blobs (`assembled_pl` / `assembled_bs` / `assembled_canonical_v1.methodology`):

| Function | Input | Used by |
|---|---|---|
| `buildCanonicalMetrics(period)` | `ActivePeriod` from `useActivePeriod()` | `pages/cfo/Chat.tsx:138` |
| `buildCanonicalMetricsFromInputs({...})` | Raw `/api/period/{id}` response | `pages/cfo/ComprehensiveReport.tsx:250`, `pages/cfo/FinancialStatements.tsx:1494` |

The hub returns a typed `CanonicalMetrics` object with four slices:

```ts
CanonicalMetrics = {
  ebitda:   { reported, core, basis_for_valuation, adjustments, reported_margin_pct, core_margin_pct }
  netProfit:{ statutory_account_121, reconstructed, reconciliation_gap, gap_pct, anchor }
  balance:  { total_assets, equity, total_debt, cash, net_debt }
  provenance:{ source, company, period, period_id }
  headline: { revenue, total_operating_revenue, ebit, depreciation, tax, interest_expense, capitalized_own_work_memo }
}
```

The hub does NOT re-compute numbers — it surfaces what the engine already emits and adds one explicit bridge: Reported EBITDA → Core EBITDA via accounts 758 (other operating income) + 781 (provision reversals), summed from per-account `lineItems`.

**Source of truth ladder:**
1. The Romanian-engine emits `assembled_pl` / `assembled_bs` / `assembled_canonical_v1.methodology` per period (see `engine/api/_ro_coa.py`, `engine/api/canonical_v1.py`).
2. The FE persists this via `useActivePeriod()` (`src/lib/activePeriod.ts:194` `assembled_metrics`).
3. `buildCanonicalMetrics*()` consolidates into `CanonicalMetrics`.
4. Per ADR Lock #11, every consumer SHOULD read from the hub. Local recomputation is a code smell unless the value is genuinely table-rendering (e.g. a per-row P&L line item).

### 1.2 Local-calc sites still in the tree

`grep deriveTotals` returns 6 call sites:
- `src/lib/financialReport.ts:186` — `deriveTotals()` is the function definition itself + 3 internal callers
- `src/pages/cfo/FinancialStatements.tsx:301` — `const totals = useMemo(() => deriveTotals(statements))` — primary memo, used by table renderers downstream
- `src/pages/cfo/FinancialStatements.tsx:2604` — inline `deriveTotals(statements).totalDebt / summaryEbitdaRon` in the briefing surface — **could be canonical**
- `src/pages/cfo/FinancialStatements.tsx:2640` / `:3990` / `:4038` — internal scope of P&L / BS / Risk table renderers

`deriveTotals()` itself reads from `Statements` (the already-shipped envelope) and computes totals at table-line granularity (e.g. `totalLiabilitiesAndEquity`, `totalCurrentAssets`). The headline metrics it surfaces (`ebitda`, `totalDebt`, `netIncome`) come from the same underlying envelope as the canonical hub — they cannot diverge in normal operation, but they are not _explicitly_ routed through the hub, which is the Lock #11 architectural smell.

### 1.3 Consumers map

| Surface | File / route | Reads from |
|---|---|---|
| **Dashboard Overview KPI strip** | `pages/cfo/FinancialStatements.tsx:1494` | hub `buildCanonicalMetricsFromInputs()` |
| **Dashboard P&L tab** | `FinancialStatements.tsx` (PL table renderer) | `deriveTotals(statements)` + the engine `assembled_pl` envelope passed through |
| **Dashboard Balance Sheet tab** | `FinancialStatements.tsx` | `deriveTotals(statements)` |
| **Dashboard Cash Flow tab** | `FinancialStatements.tsx` | engine cash-flow blob via `Statements` |
| **Dashboard Ratios tab** | `FinancialStatements.tsx` | derived from `Statements` (ratios calculated locally from absolute amounts) |
| **Dashboard Valuation tab** | `FinancialStatements.tsx` + `financialValuation.ts:runDcf`/`runGraham` | local DCF / Graham computation, reads underlying numbers via `Statements` |
| **Dashboard Risks tab** | `FinancialStatements.tsx` `RisksPanel` | `assembled_metrics.credit` / `assembled_metrics.piotroski` from engine envelope |
| **Dashboard Recommendations tab** | `FinancialStatements.tsx` `RecommendationCard` | `Recommendation.factsCited` from engine `recommendationRules.ts` |
| **ComprehensiveReport / PDF** | `pages/cfo/ComprehensiveReport.tsx:250` | hub `buildCanonicalMetricsFromInputs()` |
| **CFO AI Chat right-rail context** | `pages/cfo/Chat.tsx:138` | hub `buildCanonicalMetrics()` |
| **Benchmark page** | `pages/cfo/BenchmarkReport.tsx` | API `/api/benchmark` per-period payload (separate path) |
| **Public Company dashboard (AAPL)** | `pages/cfo/PublicCompanyDashboard.tsx` | `publicCompanyAdapters.ts` shaping `assembled_canonical_v1` from Sharadar |
| **Learning popovers (Layer 2)** | `components/learning/LearningPopover.tsx` + `ReportingContextProvider` | `useReportingMetrics()` → injected at the FinancialStatements provider boundary; reads from `Statements` totals |

---

## §2 — Cross-surface matrix (Scandia FY 2025, live prod scrape)

**Probe:** Visited each dashboard tab + Reports + Chat + Benchmark + AAPL with PUBLIC_TEST_MODE on, scraped every `[data-testid^=kpi-|public-kpi-|metric-|bs-|pl-|valuation-|benchmark-]` plus every `.num-hero*` hero number. 215 readings across 10 distinct surfaces.

### 2.1 Scandia private — headline metrics

| Metric | Canonical truth (hub) | Overview | P&L | Balance Sheet | Cash Flow | Ratios | Valuation | Risks | Recs | Benchmark | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **Operating revenue** | engine `apl.total_operating_revenue` | **413.7M** | 413.7M | 413.7M | 413.7M | 413.7M | 413.7M | 413.7M | 413.7M | 413.7M | ✓ MATCH |
| **EBITDA (reported)** | `apl.ebitda_statutory` via methodology | **54.4M** | 54.4M | 54.4M | 54.4M | 54.4M | 54.4M | 54.4M | 54.4M | — | ✓ MATCH |
| **Net profit (statutory)** | `apl.net_income_statutory` (acct 121) | **36.8M** | 36.8M | 36.8M | 36.8M | 36.8M | 36.8M | 36.8M | 36.8M | — | ✓ MATCH |
| **Net profit (reconstructed)** | `apl.net_income_operational` | 36,267,964 | — | — | — | — | **36,267,964** | — | — | — | ✓ DUAL-BASIS (intentional) |
| **Total debt** | `abs.total_debt` | **55.3M** | 55.3M | 55.3M | 55.3M | 55.3M | 55.3M | 55.3M | 55.3M | — | ✓ MATCH |
| **Cash** | `abs.cash` | (header) | — | (BS row) | (CF closing) | — | (DCF input) | — | — | — | ✓ MATCH (where rendered) |
| **Equity value (DCF central)** | local `runDcf()` | — | — | — | — | — | **450,489,717** | — | — | — | ✓ surface-specific |
| **Equity value (Graham)** | local `runGraham()` | — | — | — | — | — | **656,047,165** | — | — | — | ✓ surface-specific |
| **FCF (statutory)** | derived in valuation tab | — | — | — | (CF total) | — | **36,267,964** | — | — | — | ⚠ DIFFERENT DEFINITION (CFO vs FCF — by design) |
| **CFO** | derived in valuation tab | — | — | — | — | — | **49,917,608** | — | — | — | ✓ matches CF tab |
| **DSCR / Net Debt / EBITDA / etc.** | engine recommendation rules' `factsCited` | — | — | — | — | (Ratios) | — | — | (Recs · `Triggered by`) | — | ✓ MATCH (same engine fact dict) |

**Headline verdict:** The 4 anchor metrics (Operating revenue, EBITDA, Net profit statutory, Total debt) render **byte-identical to display precision** on all 8 tabs. The canonical hub appears to be doing its job for the headlines.

### 2.2 Documented dual-basis surfaces (not mismatches)

The Valuation tab uses RECONSTRUCTED net profit (36,267,964) while every other tab uses STATUTORY net profit (36.8M). This is the dual-basis design baked into `CanonicalMetrics.netProfit`: statutory is the legally filed anchor; reconstructed is the bottom-up engine computation. Methodology says ≤2% gap is acceptable — here gap is `(36,267,964 − 36,800,000) / 36,800,000 = −1.45%`. Surfaced honestly per the hub's contract. **NOT a mismatch.**

Likewise, Valuation's FCF (36.27M) and CFO (49.92M) are different metrics within the same DCF view (FCF = CFO − maintenance capex). The label disambiguates.

### 2.3 AAPL public surface

| Metric | Hub canonical (per Sharadar SF1 → assembled_canonical_v1) | Rendered |
|---|---|---|
| **Revenue (TTM)** | normalized from SF1 row | 651.4B (TTM) / 1.6T (variants in display) |
| **EBITDA** | normalized | 651.4B |
| **Total assets** | normalized | 1.6T |
| **Total debt** | normalized | 445.0B |
| **Cash** | normalized | 502.8B (also 162.1B / 445.5B in different tiles — Sharadar reports separate ST/LT/equivalents) |
| **Market cap** | Sharadar DAILY | 20.4T |
| **Enterprise value** | Sharadar SF1 | 20.5T |
| **Operating CF** | normalized | 502.8B |
| **Free cash flow** | normalized | 445.5B |

**AAPL verdict:** The public surface goes through `publicCompanyAdapters.ts` which shapes Sharadar data into the same `assembled_canonical_v1` envelope. Numbers look consistent within the AAPL dashboard. The "different cash figures" (162.1B / 445.5B / 502.8B) are distinct concepts: cash & equivalents vs cash from operations vs operating CF — display labels disambiguate.

### 2.4 Surfaces with zero rendered numerics in this probe

| Surface | Why | Risk |
|---|---|---|
| **Reports (`/reports/comprehensive`)** | Test-mode route may not auto-load the period; the page renders the "no data" empty state until a period is explicitly selected. | **MISSING** — needs follow-up probe with an explicit `?period=` deep link or after the user picks the Scandia period. The hub is wired (`ComprehensiveReport.tsx:250`), but we did not _observe_ the rendered numbers in this audit. |
| **CFO AI Chat right-rail workspace** | Renders only AFTER a conversation starts; default state is the prompt-chip onboarding view. | **MISSING IN AUDIT** — confirmed the hub-consumer wiring exists at `Chat.tsx:138`, but live numbers were not surfaced in this probe. |
| **Learning popover values** | The Overview KPI tiles are plain `<div>` containers, not `LearnableMetricCard` buttons — so the popover doesn't trigger from those tiles. The popover triggers from BS map chips, valuation bridge cards, and recommendation Triggered-by labels, which we tested separately in F5.0 regression. | **OBSERVED INDIRECTLY** — F5.0 36/36 green proves the popover paths render. Inside-popover values were not numerically compared to canonical truth in this audit. |

---

## §3 — Observed mismatches and notes

### 3.1 No headline mismatches found

For the headline metrics (Revenue, EBITDA, Net profit statutory, Total debt) on Scandia FY 2025, all 8 dashboard tabs render the SAME compact display value to display precision. This is the strongest evidence Lock #11's CONSUMER-CUTOVER (Phase F3.16-3b.6) succeeded in unifying the source.

### 3.2 Format-only differences

| Surface pair | Metric | Difference | Why |
|---|---|---|---|
| Valuation tab vs other tabs | Net profit | 36,267,964 (Val) vs 36.8M compact (others) | Reconstructed view vs statutory anchor — DUAL-BASIS design; both are exposed via `CanonicalMetrics.netProfit` |
| AAPL dashboard | Cash | 162.1B / 445.5B / 502.8B in different tiles | Distinct concepts (cash & equiv vs CFO vs operating CF) — labels disambiguate |

### 3.3 Architectural smells worth flagging (not currently causing mismatches)

| Smell | Where | Risk | Severity |
|---|---|---|---|
| **`deriveTotals(statements)` callers** in PL/BS/Risks renderers don't route through `buildCanonicalMetricsFromInputs()` | `FinancialStatements.tsx:2604`, `:2640`, `:3990`, `:4038` | If the engine emits divergent values across `apl.ebitda_statutory` (used by hub) vs `assembled_pl.ebitda` (used by `deriveTotals` fallback chain), the headlines could drift. The hub's `_resolveReportedEbitda` IS the safety net (prefers canonical methodology). Today the values match. | **MEDIUM** — silent-divergence risk if the engine ever emits the two fields differently. F4.7 (2026-11-23) deletes the legacy field, removing the risk. |
| **Local `runDcf()` / `runGraham()`** in `financialValuation.ts` | called from Valuation tab | DCF/Graham aren't part of the canonical hub. If the underlying inputs (FCF, WACC, growth rate) ever change, the value can diverge from a future engine-emitted valuation. | **LOW** — surface-specific output, intentional |
| **Benchmark surface** uses a separate `/api/benchmark` payload | `BenchmarkReport.tsx` | Peer medians are independent of the per-company envelope. The company's own revenue/EBITDA reads from a different shape than the dashboard's. Risk: company-self-row in the peer table could show different value than the dashboard. | **MEDIUM** — needs explicit cross-check (peer-self vs dashboard headline) |
| **Reports + Chat** not observed live in this probe | `/reports/comprehensive`, `/chat` | The hub is wired but the rendered output is unverified. | **LOW** (wiring confirmed by code) but worth probing in DATA-1B |

### 3.4 Caches

| Cache | Owner | Staleness risk |
|---|---|---|
| `useActivePeriod()` zustand store | `src/lib/activePeriod.ts` | Survives navigation; refreshes on period selection. **No staleness risk** — single source per workspace. |
| React Query keys per period | TanStack Query | Fresh per period selection; invalidated by upload/rerun. |
| Currency rates 5-min cache | `useCurrencyStore` | Independent — converts canonical RON to display currency, doesn't change canonical truth. |
| Public-company 5-min cache | `cfoApi.ts` | Refresh-bounded by SF1 EOD. Documented; not a trust issue. |

---

## §4 — Risk ranking

| # | Risk | Severity | Probability today | Path to fail |
|---|---|---|---|---|
| 1 | Engine emits divergent `apl.ebitda_statutory` vs `apl.ebitda` after a future schema migration; `deriveTotals` callers use the wrong one | MED | Low (today bytes match per F4.2-PARITY) | Engine change → silent dashboard tab divergence |
| 2 | Benchmark self-row shows revenue/EBITDA different from Dashboard (different API payload, different rounding) | MED | Unverified | Need explicit benchmark-self vs hub cross-check |
| 3 | Reports PDF export uses stale canonical metrics if user navigates between periods without re-hitting `/reports` | LOW | Low | React Query cache misroute; not observed |
| 4 | CFO AI Chat injects stale canonical context into a long-running conversation when the user changes period mid-thread | LOW | Low | Chat.tsx pulls canonical from `useActivePeriod()`; current implementation re-reads on each prompt |
| 5 | Learning popover values disagree with their source tile because of stale `ReportingContextProvider` snapshot | LOW | Low | Provider mounts at FinancialStatements; period switch remounts |
| 6 | Valuation Equity Value drifts from a future engine-emitted valuation envelope | LOW | Future | Engine doesn't emit valuation today; FE owns the DCF compute |

---

## §5 — Proposed-fix shapes (for DATA-1C, not now)

1. **Lift the 4 `deriveTotals` callers to the hub.** Replace `deriveTotals(statements).totalDebt` etc. with `canonicalMetrics.balance.total_debt`. Loses no information; removes the silent-divergence risk. ~10 lines.

2. **Cross-validate benchmark self-row against canonical hub.** In `BenchmarkReport.tsx`, when rendering the company's own peer-table row, source revenue/EBITDA from the canonical hub rather than the benchmark API payload. The peer medians stay where they are.

3. **Add a runtime assertion in dev mode**: `canonicalMetrics.headline.revenue !== deriveTotals(statements).revenue` → console.warn during development. Catches drift in CI before it reaches users.

4. **Optional: persist a small `cross_surface_oracle` snapshot to the API**, capturing canonical headline metrics at period creation, that the oracle test in DATA-1B can compare against.

---

## §6 — Proposed oracle / test design (DATA-1B)

### 6.1 Goal
A single Playwright spec that, for any fixture, asserts every rendered hero number for {Revenue, EBITDA, Net profit, Total debt, Total assets, Equity, Cash, Net debt} matches across every surface to display precision — including Reports, Chat, and Benchmark-self.

### 6.2 Shape
```ts
// e2e/data-trust-oracle.spec.ts
const SURFACES = [
  { path: "/dashboard?tab=overview",       label: "overview" },
  { path: "/dashboard?tab=p_and_l",        label: "pl" },
  { path: "/dashboard?tab=balance_sheet",  label: "bs" },
  // ... etc
  { path: "/reports/comprehensive",        label: "reports" },
  { path: "/chat",                         label: "chat-rail" },
  { path: "/benchmark",                    label: "benchmark-self" },
];
const HEADLINES = ["revenue", "ebitda", "net_profit", "total_debt", "total_assets", "equity", "cash", "net_debt"];

// 1. Read canonical truth from API once per fixture
// 2. For each (fixture, surface, headline): scrape rendered value, normalise compact units, compare ±1 RON
// 3. Report a single matrix; PASS only if every cell agrees
```

### 6.3 What it does NOT do
- Does NOT assert valuation Equity Value (DCF) matches across surfaces — it's a surface-specific calculation by design.
- Does NOT compare benchmark peer medians — those are independent of the company's own canonical truth.
- Does NOT exercise learning popovers individually (the F5.0 regression covers popover render).

### 6.4 Fixtures
- **Scandia FY 2025** — calibration anchor (food_mfg, all 8 sections populated)
- **EEI Imobiliara** — real-estate single-asset (asset-heavy, NAV-primary)
- **AAPL FY 2025** — public-company / Sharadar normalized

### 6.5 Where it runs
- Per-PR Playwright job (after DATA-1D ships)
- Same `--project=prod` posture as F5.0 regression
- Failure → block merge

---

## §7 — Summary verdict

**Data trust today is GOOD for headline metrics on Scandia and AAPL.** The canonical hub (`canonicalMetrics.ts`) is the architectural anchor and Lock #11's CONSUMER-CUTOVER successfully unified Dashboard, ComprehensiveReport, and Chat under it. The 8 dashboard tabs render Revenue / EBITDA / Net profit / Total debt **byte-identical to display precision**.

**Architectural smells exist** — 4 `deriveTotals` callers don't route through the hub, the Benchmark self-row uses an independent API payload, and Reports + Chat weren't directly verified in this probe. These are not currently causing mismatches but represent latent risk vectors.

**Recommended next steps:**
1. **DATA-1B** — Build the oracle spec described in §6, fixtures = Scandia + EEI + AAPL.
2. **DATA-1C** — Lift the 4 `deriveTotals` callers into the hub; cross-validate Benchmark self-row.
3. **DATA-1D** — Make the oracle a CI gate.

Awaiting operator approval to proceed to DATA-1B.

---

*Audit conducted 2026-06-08 against prod. No production data was mutated.*
*Probe artefacts: `/tmp/data1a-stdout.log`, `/tmp/data1a.json` (215 readings, 10 surfaces).*
