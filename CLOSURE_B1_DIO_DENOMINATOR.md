# Closure Report — B1: DIO / DPO Denominator Regression

**Status: GREEN — oracle match within 0.1d on DIO, TS typecheck clean, no other call sites need updating.**

## What changed

**File:** [scandi-desk-main/src/lib/financialReport.ts](scandi-desk-main/src/lib/financialReport.ts)
**Function:** `computeRatios` — efficiency section (lines 289-303 post-fix)

Replaced the narrow-COGS denominator (`is.costOfGoodsSold`) with total operating expense (`is.costOfGoodsSold + is.operatingExpenses + is.depreciationAmortization`) for DIO and DPO. DSO and CCC structure unchanged; CCC mechanically inherits the new DIO/DPO values.

Code shape (post-fix):

```ts
// DIO / DPO denominator: TOTAL operating expense (COGS + OpEx + D&A), not
// narrow COGS. Per the methodology calibration (reference/financial_analysis.py
// lines 543-548, 581): in a manufacturer, inventory absorbs all production
// costs — materials + labor + utilities + overhead — not just raw-material
// class-6 accounts (601/602/607). Industry convention uses total operating
// expense as the DIO/DPO denominator. Using narrow `is.costOfGoodsSold`
// here inflated Scandia's DIO from the correct ~53d to ~95d.
const totalOperatingExpense =
  is.costOfGoodsSold + is.operatingExpenses + is.depreciationAmortization;
const dso = safeDiv(bs.accountsReceivable, is.revenue) * days;
const dio = safeDiv(bs.inventory, totalOperatingExpense) * days;
const dpo = safeDiv(bs.accountsPayable, totalOperatingExpense) * days;
const ccc = dso + dio - dpo;
```

Gross-margin / EBITDA path at `financialReport.ts:164` (and the matching FE display at `FinancialStatements.tsx:2917` + export at `financialExports.ts:93`) **still uses narrow `costOfGoodsSold`** — that is correct per methodology Section 5: "Gross margin = (Turnover − Materials) / Turnover". Only the DIO/DPO denominator was wrong.

## Verification

### Oracle comparison (Scandia FY2025 trial balance)

Inputs (engine canonical, taken from `files/scandia_trial_balance_2025_downloaded.xlsx` parsed through the post-C2 pipeline):

| Field | Value (RON) |
|---|---|
| revenue | 413,727,560.16 |
| costOfGoodsSold (narrow: 601+602+607) | 212,035,114.77 |
| operatingExpenses (broad opex catchall) | 158,922,654.14 |
| depreciationAmortization (681x) | 13,649,644.51 |
| **totalOperatingExpense (sum)** | **384,607,413.42** |
| inventory | 55,375,236.55 |
| accountsReceivable | 42,578,040.60 |
| accountsPayable | 55,434,708.97 |

Results (TS `computeRatios` invoked directly with the inputs above):

| Ratio | Pre-fix (narrow) | **Post-fix (broad)** | Oracle (`reference/financial_analysis.py`) | Match? |
|---|---|---|---|---|
| **DIO** | 95.3d | **52.6d** | 52.5d | ✓ Δ 0.1d (0.2%) |
| **DPO** | 95.4d | **52.6d** | 45.3d | Δ 7.3d — *numerator-scope*, see below |
| **DSO** | 37.6d | 37.6d | 45.4d | Δ 7.8d — *numerator-scope*, see below |
| **CCC** | 37.5d | 37.5d | 52.6d | Δ — drops out of DSO+DPO scope |

The **DIO match is the headline criterion** — it's the visible number that drove the user's complaint ("95d on export vs 53d on board"). 52.6d ≈ 52.5d (Δ 0.1d). The small residual is from two small mapping gaps (engine `totalOperatingExpense` 384,607,413 vs oracle `total_op_expense` 384,579,980 — Δ 0.007% from minor class-6 catchall differences; and inventory rounding).

### Residual numerator-scope gaps (out of scope for B1)

- **DPO (Δ 7.3d):** engine `accountsPayable` aggregates 401+403+404+408 (per `_ro_coa.py:165-168`); oracle `trade_pay` uses 401 only (`reference/financial_analysis.py:384`). Methodology Section 5 says "Payables" without specifying which. The engine's broader scope is arguably more correct (matches the methodology Section 3 cheat sheet's "ST liability — trade payables" grouping which lists all of 401/403/404/405/408). Resolution: leave to a separate decision — not a denominator bug.
- **DSO (Δ 7.8d):** engine `accountsReceivable` is narrow (411+413+418+4118); oracle's `total_receivables` sums broader (411+413+418+409+44(D)+46(D)+471+425/4282+43(D)+451/452/455+461−49). This is **H4** from the diagnostic — receivables classification gap, already flagged as a separate strand. Not a B1 issue.
- **CCC:** mechanically inherits DSO and DPO; will close when those two are resolved.

### TypeScript typecheck

```
$ npx tsc --noEmit -p tsconfig.json
EXIT=0
```

Clean. No type errors introduced.

### Regression sweep — every `costOfGoodsSold` reference

Audited all 10 references in `scandi-desk-main/src/`. Categorised:

| File:line | Usage | Action |
|---|---|---|
| `financialReport.ts:41` | Type field declaration | unchanged |
| `financialReport.ts:164` | Gross profit calc (narrow COGS — correct per methodology) | unchanged |
| `financialReport.ts:298` | NEW broad denominator | fix |
| `financialReport.ts:1338` | HTML row display | unchanged |
| `financialValuation.ts:1047` | EBITDA calc `revenue − cogs − opex + otherIncome` | unchanged |
| `buildPlStatement.ts:370` | P&L statement layout (display) | unchanged |
| `financialExports.ts:93` | CSV/PDF export row | unchanged |
| `trialBalanceParser.ts:352` | Setter when constructing IncomeStatement | unchanged |
| `FinancialStatements.tsx:2917` | UI row display | unchanged |

Only the two ratio formulas at lines 291-292 were using `costOfGoodsSold` as a ratio denominator. No other ratio uses narrow COGS. No further changes needed.

### Existing tests

No tests in `scandi-desk-main/src/` exercise `computeRatios` or `financialReport`. The only tests in the workspace (`industryGroups.test.ts`, `copyHygiene.test.ts`) are unrelated. The verification path here is the unit-level oracle match above + TS typecheck.

### Browser preview consideration

The change is observable in the Comprehensive Report HTML output if you upload Scandia data through the UI. The fix is to a pure function (`computeRatios`), and the renderer/exporter downstream consume its output unchanged — the new DIO/DPO numbers propagate by construction. A browser-only check would require auth + upload + dataset selection and would only verify what the unit-level oracle check already establishes more rigorously. Skipping the browser drive-through.

## Regression check — what didn't move

- **Scandia gross profit / gross margin / EBITDA:** unchanged (still uses `costOfGoodsSold` correctly).
- **Scandia DSO:** unchanged at 37.6d (formula and numerator unchanged).
- **All other ratios** (liquidity, profitability, leverage, coverage, Altman Z, asset turnover): no code path touched.
- **C2 work:** untouched. Test harness still parses 6-col and 8-col fixtures identically.

## Blast radius — confirmed safe

- **Engine `_ro_coa.py`, `_trial_balance_parser.py`, `pipeline.py`:** not opened.
- **Bug A / period collision, pricing, period-industry, notification-header:** fenced, not opened.
- **Other consumers of `is.costOfGoodsSold`:** verified read-only display / gross-margin / EBITDA paths. All correct per methodology.

## What's still pending

- **H2** (acct 168 → P&L interestExpense) — awaiting your GREEN on this report.
- **C1** (EEI 2.16M op income omission) — authorized read-only fixture-run diagnostic, sequenced after H2.
- **H1.A.2** (statutory parser omits 104) — separate strand.
- **H4** (receivables classification presentation gap) — drives the residual DSO 7.8d / CCC delta against the oracle; separate decision.
- **DPO scope** (401-only vs 401+403+404+408) — separate methodology-implementation decision; leave as-is for now.

B1 closure complete. Awaiting your GREEN before starting H2.
