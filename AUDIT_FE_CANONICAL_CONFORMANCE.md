# Audit — Frontend Canonical Conformance

> **Read-only audit. NO code changes made.** Enumerates every FE site that recomputes EBITDA / net profit / ratios instead of consuming the engine's canonical output, then proposes a fix plan. Sequenced after the Altman variant decision ([DIAGNOSTIC_ALTMAN_CREDIT_VERDICT.md](DIAGNOSTIC_ALTMAN_CREDIT_VERDICT.md)) and aligned with the Phase 0 gate in [MULTI_JURISDICTION_ROADMAP.md](MULTI_JURISDICTION_ROADMAP.md).

---

## The two patterns in the codebase

### ✅ RIGHT — consume engine canonical

The engine emits per-period canonical views at:
- `assembled_pl` — `ebitda_statutory`, `ebitda_cash`, `operating_ebit`, `net_income_statutory`, `total_operating_revenue`, `capitalized_own_work_memo`, `pretax`, `depreciation`, `interest_expense`, …
- `assembled_bs` — `total_assets`, `total_liabilities`, `total_equity`, `total_debt`, `retained_earnings`, `current_year_pnl`, `share_capital`, `cash`, …
- `assembled_cf` — `cash_from_operating`, …
- `calculated_metrics` rows — `altman_z_score`, `altman_x1..x4`, `credit_composite`, `credit_subscore_*`, plus every ratio computed once at the engine.

The FE has a single helper that does the right thing: [`canonical(s)` in `financialValuation.ts:359-420`](scandi-desk-main/src/lib/financialValuation.ts#L359). It reads each canonical field if present, falls back to the legacy aggregated view only if absent. Two FE modules consistently use it:

| Module | What it consumes |
|---|---|
| [`canonicalMetrics.ts`](scandi-desk-main/src/lib/canonicalMetrics.ts) | Single dual-basis EBITDA / net profit object — bridges Reported → Core EBITDA via accounts 758 + 781 (no recompute, just sums two line-item amounts already shipped on the API). |
| [`runPiotroski` (financialValuation.ts:457)](scandi-desk-main/src/lib/financialValuation.ts#L457) | Calls `canonical(s)` for every check; uses `c.netIncomeStatutory`, `c.ebitStatutory`, `c.cfo`, etc. |

### ❌ WRONG — recompute from `s.incomeStatement.*` / `s.balanceSheet.*`

The recompute heart is [`deriveTotals(s)` in `financialReport.ts:160+`](scandi-desk-main/src/lib/financialReport.ts#L160):

```typescript
const ebitda = grossProfit - is.operatingExpenses + is.otherIncome;
const ebit = ebitda - is.depreciationAmortization;
const pbt = ebit + finIn - is.interestExpense - finEx;
const netIncome = pbt - is.taxExpense;
const totalEquity = bs.shareCapital + bs.retainedEarnings + bs.otherEquity;
const totalDebt = bs.shortTermDebt + bs.longTermDebt;
const workingCapital = totalCurrentAssets - totalCurrentLiabilities;
const netDebt = totalDebt - bs.cash;
// + totalAssets, totalLiabilities, totalCurrentAssets/Liabilities, etc.
```

This is the Altman-bug pattern, generalized: same statement → parallel arithmetic → results that may or may not match the engine. Every site below that imports `deriveTotals` carries the same risk.

---

## Full inventory of FE recomputing sites

### Tier 1 — User-visible surfaces (these are the live bug surface)

| # | Site | File:line | Recomputes | Surfaced where |
|---|---|---|---|---|
| 1 | `computeRatios(s)` | [`financialReport.ts:248-540` (approx)](scandi-desk-main/src/lib/financialReport.ts#L248) | Full ratio bundle: currentRatio, quickRatio, debt/equity, debt/EBITDA, interest coverage, DSCR, ROE, ROA, ROIC, asset turnover, DIO, DSO, DPO, CCC, Altman X1–X4 (re-derives X bands), Piotroski components | **Ratios tab on every period** ([FinancialStatements.tsx:346](scandi-desk-main/src/pages/cfo/FinancialStatements.tsx#L346)) and **Alerts page** ([Alerts.tsx:93](scandi-desk-main/src/pages/cfo/Alerts.tsx#L93)) |
| 2 | `altmanZScore(s)` | [`financialValuation.ts:690-752`](scandi-desk-main/src/lib/financialValuation.ts#L690) | Altman Z" or Z' based on industry-switch (the bug already catalogued in DIAGNOSTIC_ALTMAN_CREDIT_VERDICT.md) | **Statements page Risk/Ratios tab** via `computeCreditScore` ([FinancialStatements.tsx:3200](scandi-desk-main/src/pages/cfo/FinancialStatements.tsx#L3200)); **Exported standalone report** ([financialExports.ts:44](scandi-desk-main/src/lib/financialExports.ts#L44)) |
| 3 | `computeCreditScore(s)` | [`financialValuation.ts:775+`](scandi-desk-main/src/lib/financialValuation.ts#L775) | Composite credit score (40% Altman / 20% Piotroski / 15% leverage / 10% IC / 10% DSCR / 5% cash ratio) — different weights from engine's `credit_composite` | Statements page + Export. **Disagrees with Dashboard's `CreditScoreCard` (engine composite, weights 30/20/15/10/10/10/5)** |
| 4 | `runDcf(s)` | [`financialValuation.ts:160+`](scandi-desk-main/src/lib/financialValuation.ts#L160) | Calls `deriveTotals(s)` → uses FE-recomputed EBITDA/EBIT/netIncome as DCF inputs | Valuation tab (DCF section) |
| 5 | `runGraham(s)` | [`financialValuation.ts:309+`](scandi-desk-main/src/lib/financialValuation.ts#L309) | Calls `deriveTotals(s)`, then *partly* corrects by preferring `s.assembled_pl?.net_income_statutory` when present — defense-in-depth, half-migrated | Valuation tab (Graham number) |
| 6 | `computeCostOfCapital(s)` | [`financialValuation.ts:76+`](scandi-desk-main/src/lib/financialValuation.ts#L76) | Calls `deriveTotals(s)` for capital structure inputs | Valuation tab (WACC) |
| 7 | `deriveCashFlow(s)` | [`financialValuation.ts:32+`](scandi-desk-main/src/lib/financialValuation.ts#L32) | Calls `deriveTotals(s)` → builds CF view from legacy aggregates, not `assembled_cf` | Used by `runDcf` (transitive) |
| 8 | `periodFacts` ratios | [`periodFacts.ts:380-395`](scandi-desk-main/src/lib/periodFacts.ts#L380) | **Second independent ratio bundle**: current_ratio, quick_ratio, debt_to_equity, debt_to_assets, equity_ratio, debt_to_ebitda, roe, roa | Drives `RecommendationsView` deterministic rules ([recommendationRules.ts:528](scandi-desk-main/src/lib/recommendationRules.ts#L528)) — i.e. **what the user sees in the Recommendations cards and the Notes panel** |
| 9 | `periodFacts.plFacts.ebitda` | [`periodFacts.ts:201`](scandi-desk-main/src/lib/periodFacts.ts#L201) | Reads `pl.ebitda` from `buildPlStatement` — a THIRD EBITDA path (operating view, 722-included by the builder's "operating view" convention) | Same Recommendations + Notes surfaces |

### Tier 2 — Indirect recompute (cleaner, but still in the pipeline)

| # | Site | File:line | What it does | Risk |
|---|---|---|---|---|
| 10 | `buildPlStatement` | [`buildPlStatement.ts`](scandi-desk-main/src/lib/buildPlStatement.ts) | Aggregates line-items into a structured statement with its own EBITDA/EBIT/PBT/NetProfit derived inside the builder. Comment header: "OPERATING VIEW … This produces EBITDA = 2,149,571 for EEI Dec 2025 (matches reference target)." | Drives the P&L tab visual + feeds `periodFacts.plFacts.ebitda`. Confirmed correct *for EEI today*, but the math is a parallel implementation of what `assembled_pl.ebitda_statutory` already encodes. |
| 11 | `buildBsStatement` | [`buildBsStatement.ts`](scandi-desk-main/src/lib/buildBsStatement.ts) | Aggregates line-items into BS structure with internal totals + an explicit "current year net profit" line into equity. | Drives BS tab visual. Same risk class as buildPlStatement — parallel to `assembled_bs`. |
| 12 | `ComprehensiveReport.tsx:818-819` | [`ComprehensiveReport.tsx:818`](scandi-desk-main/src/pages/cfo/ComprehensiveReport.tsx#L818) | `const ebitda = pl.ebitda_statutory ?? pl.ebitda ?? metrics.ebitda ?? 0; const netDebt = (bs.total_debt ?? 0) - (bs.cash ?? 0)` | Fallback chain — picks `pl.ebitda_statutory` first (right), but if missing falls through to `pl.ebitda` (operating view) then `metrics.ebitda` (potentially yet another source). Three competing values on one page. |

### Tier 3 — Dead code (low priority but still imports the wrong pattern)

| # | Site | Note |
|---|---|---|
| 13 | `src/_removed/Profit.tsx` & `src/_removed/Cash.tsx` | Already deprecated (in `_removed/` folder). Each calls `deriveTotals` + `computeRatios`. Risk = if the folder is ever re-imported by mistake. Recommend deletion in the same sweep. |

---

## Where these recomputes diverge from engine canonical

Two concrete arithmetic differences proven from the source already:

1. **EBITDA basis**:
   - Engine `assembled_pl.ebitda_statutory` includes account 722 (capitalized own work) — for EEI this is +RON 2,164,080.
   - `deriveTotals.ebitda` uses `is.otherIncome` which depends on whether the engine has carved 722 into a separate field or left it inside `otherIncome`. The comment at financialReport.ts:172 acknowledges the dependency: *"the BE's /api/period rebuild now carves account 711 out of the otherIncome bucket"* — confirming the FE math is wired to a specific BE convention rather than to the canonical field directly.
   - `buildPlStatement` declares "OPERATING VIEW" and includes 722, 706, 767 in operating revenue — yet another convention.

2. **Net income basis**:
   - Engine `assembled_pl.net_income_statutory` = statutory ct-121 (includes 722).
   - `deriveTotals.netIncome` = operational (722-excluded) — comment at `financialValuation.ts:314` calls this out explicitly as a known divergence; Graham was patched to prefer the canonical first.

3. **Ratio bundles count**:
   - Engine emits `current_ratio`, `quick_ratio`, `debt_to_equity`, `debt_to_ebitda`, `interest_coverage`, `roa`, `roe`, `roic`, … into `calculated_metrics`.
   - `computeRatios` (financialReport.ts) computes its own bundle from `deriveTotals`.
   - `periodFacts.ratios` computes a third bundle from `deriveTotals` + bsFacts (slightly different inputs).
   - Three independent ratio surfaces; nothing enforces parity.

4. **Altman + composite** (already catalogued):
   - Engine: Z" always, composite 30/20/15/10/10/10/5.
   - FE: Z' or Z" by industry, composite 40/20/15/10/10/5 + Piotroski.

---

## Fix plan (the canonical conformance work)

Recommended sequence. Read-only here — these are proposed edits, not made.

### F1. Lock down the canonical contract on the engine side

Before editing the FE, audit `_ro_coa.py` + `pipeline.py` to confirm every value the FE needs is present on `assembled_pl` / `assembled_bs` / `assembled_cf` / `calculated_metrics`. Specifically — the FE re-derives these today, so the engine must guarantee they exist:

- `assembled_pl.ebitda_statutory`, `ebitda_cash`, `operating_ebit`, `net_income_statutory`, `pretax`, `total_operating_revenue`, `capitalized_own_work_memo` — confirmed present (consumed by `canonical(s)` already).
- `assembled_bs.total_assets`, `total_liabilities`, `total_equity`, `total_debt`, `total_current_assets`, `total_current_liabilities` — confirmed.
- `calculated_metrics` rows for every ratio computeRatios produces (current, quick, debt/equity, debt/EBITDA, IC, DSCR, ROE, ROA, ROIC, asset turnover, DIO, DSO, DPO, CCC) — needs verification. Some likely missing → either add to engine OR keep the FE compute IFF the FE compute reads canonical totals.
- **Engine must emit one definitive Altman**: per the variant audit, engine's always-Z" is methodologically correct for the Romanian SME market. Keep it. Persist `altman_z_score`, `altman_x1..x4`, `credit_composite`, `credit_subscore_*` (already does — confirmed at [pipeline.py:1227-1241](src/engine/api/pipeline.py#L1227)).

### F2. Delete the FE's industry-switch Altman path

Per the variant audit:
- Remove [`financialValuation.ts:680-688`](scandi-desk-main/src/lib/financialValuation.ts#L680) — the `_Z_DOUBLE_PRIME_INDUSTRIES` / `_Z_PRIME_INDUSTRIES` sets and `useDoublePrime` switch.
- Replace `altmanZScore(s)` body: read `s.assembled_metrics?.altman_z_score` / `altman_x1..x4` directly, return the same shape. No coefficient math on the FE.
- Delete the Z' (5-component) branch entirely.
- Update [`scripts/check_cross_view_consistency.py:342`](scripts/check_cross_view_consistency.py#L342): remove the `else "Z'"` branch — always expect Z".
- `CreditScoreCard.tsx` already reads engine `altman_z_score` — no change there.

### F3. Replace `deriveTotals` consumers in Tier 1 with canonical reads

Each Tier 1 site gets a small rewrite that consumes canonical and falls back ONLY to a deterministic error state (never to a parallel compute):

- **`computeRatios(s)`**: rewrite to read `calculated_metrics` directly. Each ratio either exists on the engine response (use it) or doesn't (omit the row + log). No FE arithmetic.
- **`computeCreditScore(s)`**: read engine's `credit_composite` + sub-scores. Delete the local sub-score arithmetic (40/20/15/10/10/5 weights). Engine composite becomes the only source.
- **`runDcf`**, **`runGraham`**, **`computeCostOfCapital`**, **`deriveCashFlow`**: replace `deriveTotals(s)` calls with `canonical(s)`. Inputs come from `assembled_*` canonical fields. The DCF/Graham model logic stays — only the inputs change.
- **`periodFacts` ratios + plFacts.ebitda**: read from engine `calculated_metrics` + `assembled_pl` directly. Delete the second/third ratio bundles. `RecommendationsView` and the deterministic rules in `recommendationRules.ts` then consume engine-canonical numbers — eliminates the risk that the Notes panel rules fire on FE-recomputed values that disagree with the Dashboard.

### F4. Tier 2 (builders) — leave as renderers, not computers

`buildPlStatement` / `buildBsStatement` produce visual structures for the P&L / BS tabs. Keep them as **renderers** (they're necessary for the per-account drill-down view) but route their TOTALS through canonical. Specifically:
- Builder line totals (each row's amount) — keep, sourced from `lineItems`.
- Builder subtotals (Revenue, EBITDA, EBIT, Net Income, totals on BS) — read from `assembled_pl` / `assembled_bs` instead of summing locally.

This preserves the drill-down UX (per-account rows) without owning the headline arithmetic.

### F5. Tier 2 (ComprehensiveReport fallback chain) — collapse

[ComprehensiveReport.tsx:818-819](scandi-desk-main/src/pages/cfo/ComprehensiveReport.tsx#L818): replace `pl.ebitda_statutory ?? pl.ebitda ?? metrics.ebitda ?? 0` with a single canonical read + explicit error state when missing. Same pattern for `netDebt` and the ROE / EquityRatio / NetDebt-to-EBITDA tiles at lines 444-451 (their inputs are already from the engine — verify each).

### F6. Delete `_removed/` dead code

Removes lingering imports of `deriveTotals` and `computeRatios` that would re-introduce the bug if anyone ever uncommented them.

### F7. Add a guardrail test

A single FE unit test on every Tier 1 surface: assert that `<the displayed EBITDA> === assembled_pl.ebitda_statutory` (and the equivalent for net profit, every ratio, the Altman score, the composite). If anything drifts, the test fails — no more silent recompute.

---

## Open questions (decisions, not code)

1. **`computeRatios` — does the engine emit every ratio it needs to?**
   - Engine confirmed to emit: `current_ratio`, `quick_ratio`, `debt_to_equity`, `debt_to_ebitda`, `interest_coverage`, `roa`, `roe`, `roic` (per [pipeline.py:1105-1117](src/engine/api/pipeline.py#L1105)).
   - `computeRatios` also computes: DSCR, DIO, DSO, DPO, CCC, asset turnover, gross margin, EBITDA margin, net margin, equity ratio, debt/assets, cash ratio.
   - Decision: extend engine to emit the missing rows (favored — keeps the engine as single source of truth), OR keep these specific ratios as FE compute IFF they only read canonical totals (e.g. EBITDA margin = `ebitda_statutory / total_operating_revenue` is safe because both inputs are canonical). Recommendation: extend the engine — same discipline as Altman.

2. **`buildPlStatement` "OPERATING VIEW" vs canonical "statutory view".**
   - The builder declares operating view (includes 722). Canonical has both `ebitda_statutory` (includes 722) and `ebitda_cash` (excludes 722). The two views agree on EEI by coincidence (722 + 628 wash) but generally don't.
   - Decision: make the builder render statutory by default (matches canonical), with a separate "cash view" toggle if needed. Keep one convention end-to-end.

3. **`periodFacts` is a separate facts contract for chat/AI consumption.**
   - Refactor target is bigger than just consuming canonical — `periodFacts` is also the contract that `facts_cited` validates against (the [linkifyAlertBody.tsx:110](scandi-desk-main/src/lib/linkifyAlertBody.tsx#L110) 0.5% tolerance check). Changing periodFacts inputs may shift facts_cited matches.
   - Decision: do the periodFacts migration in its own commit with an integration test on the linkified-alert rendering.

---

## Surface map — which user-facing thing is wrong today, and how

| User-visible surface | Reads from | Currently shows |
|---|---|---|
| Dashboard "Credit score" card | Engine canonical (`altman_z_score`, `credit_composite`) | Engine Z″ (correct variant per audit) |
| Statements page → Ratios tab | `computeRatios` (FE recompute) | FE ratios from `deriveTotals` |
| Statements page → Risk tab | `computeCreditScore` → `altmanZScore` (FE) | FE Z' (manufacturing) or Z" (other) — **disagrees with Dashboard for manufacturing** |
| Statements page → Valuation tab | `runDcf`, `runGraham`, `computeCostOfCapital` (FE) | All consume `deriveTotals` |
| P&L tab | `buildPlStatement` (operating view) | Per-account rows + builder-computed subtotals (parallel to canonical) |
| BS tab | `buildBsStatement` | Per-account rows + builder-computed subtotals |
| Dashboard "Comprehensive" view | `canonicalMetrics` (right pattern) + small fallback chain | Mostly canonical, edge-case fallbacks |
| Recommendations / Notes panel | `periodFacts` + `detectConditions` | Rules fired on FE-recomputed ratios — may not match engine alerts |
| Alerts page | `computeRatios` (FE) | Same FE ratios as Statements tab |
| Exported standalone report | `computeCreditScore` (FE composite) — different weights than Dashboard | Composite + grade may differ from Dashboard |
| Chat / Ask CFO AI workspace | `buildCanonicalMetrics` (right pattern) | Canonical EBITDA / net profit |

**Bottom line: 6 user-visible surfaces are wired to FE recomputes today.** Eliminating them is the canonical conformance work.

---

## What this audit does NOT do

- Does not change any code.
- Does not run Scandia / EEI through the pipeline to quantify the drift between FE recompute and engine canonical per surface. F7's guardrail test would catch this systematically; here it's flagged as the verification step.
- Does not decide open question 1 (extend engine vs keep some FE compute on canonical totals) — that's a small architecture call to make before F3 lands.
- Does not estimate the time to land F1–F7. The surface area is moderate (one heavy file: `financialValuation.ts`; one medium file: `financialReport.ts`; one targeted refactor: `periodFacts.ts`).

---

*Status: read-only audit complete. The Altman-variant FE bug ([DIAGNOSTIC_ALTMAN_CREDIT_VERDICT.md](DIAGNOSTIC_ALTMAN_CREDIT_VERDICT.md)) is one instance of a broader pattern: 9 Tier-1 + 3 Tier-2 FE sites recompute values the engine already canonicalized. The fix is the F1–F7 sequence above. No code changes until the open questions are resolved.*
