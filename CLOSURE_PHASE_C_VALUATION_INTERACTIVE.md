# Closure Report — Phase C: Valuation Interactive Numbers + PL Row Instrumentation

**Status: GREEN — Valuation formula numbers are now clickable; PL rows carry traceable targets; resolver + linkifier extended with PL keys; one small UX-label fix bundled. TS clean. 15/15 assertions PASS on EEI data.**

## What changed

| File | Lines | Role |
|---|---|---|
| [src/pages/cfo/BenchmarkReport.tsx](scandi-desk-main/src/pages/cfo/BenchmarkReport.tsx) | 1 | **Bonus label fix** per user request: header eyebrow changed from "Benchmark vs industrie" → "Industry benchmark · your company". One-line surgical edit. |
| [src/lib/plStructure.ts](scandi-desk-main/src/lib/plStructure.ts) | +12 | Added optional `bucket?: string` to `PLLine` and `subtotalBucket?: string` to `PLSection` — mirrors the BS-side additions from Phase B. |
| [src/lib/buildPlStatement.ts](scandi-desk-main/src/lib/buildPlStatement.ts) | +4 | Populated buckets on 3 key PL surfaces: `OPERATING REVENUE` subtotal → `revenue`, D&A line → `depreciationAmortization`, `EBIT` subtotal → `ebit`, "Net profit — operational" subtotal → `netIncomeOperational`. |
| [src/components/cfo/PLStatementView.tsx](scandi-desk-main/src/components/cfo/PLStatementView.tsx) | +15 | (a) Calls `useHighlightFromUrl()` so incoming `?highlight=<bucket>` URLs scroll + pulse the matching row. (b) Hardcoded `data-traceable-target="ebitda"` on the boxed EBITDA row so the Valuation page's Core EBITDA link lands there. (c) Emits `data-traceable-target` on `PLLineView` items with a `bucket` and on `PLSectionView` subtotals with a `subtotalBucket`. |
| [src/lib/ratioKnowledge.ts](scandi-desk-main/src/lib/ratioKnowledge.ts) | +9 | Extended `FormulaValueKey` union with PL keys: `revenue`, `costOfGoodsSold`, `operatingExpenses`, `depreciationAmortization`, `ebitda`, `ebit`, `interestExpense`, `netIncome`. |
| [src/lib/resolveFormulaInput.ts](scandi-desk-main/src/lib/resolveFormulaInput.ts) | +10 | Added the 8 new `case` branches in the exhaustive switch — pulls live values from `incomeStatement` and `deriveTotals(statements)`. Adding a new key without a case is now a TS error (exhaustiveness check intact). |
| [src/lib/linkifyAlertBody.tsx](scandi-desk-main/src/lib/linkifyAlertBody.tsx) | +11 | Extended `FACT_TO_SOURCE` with 10 PL fact-name mappings: `revenue`, `operating_revenue`, `ebitda`, `statutory_ebitda`, `core_ebitda`, `ebit`, `net_income`, `net_profit`, `depreciation`, `interest_expense`. Engine alerts citing these names now render clickable RON figures in the Notes panel. |
| [src/components/cfo/EbitdaMultiplePrimaryCard.tsx](scandi-desk-main/src/components/cfo/EbitdaMultiplePrimaryCard.tsx) | +12 | Wrapped Core EBITDA and Net debt in `<TraceableNumber>` inside the equity-equation formula line. Multiple stays the slider (not traceable); Equity is computed (no source row). Inline comment explains the linking choices. |

## What the user sees

### Before — Valuation formula line (pre-Phase-C)

```
Equity = Core EBITDA (RON 42,769,791) × Multiple (7.00×) − Net debt (RON 49,714,854) = RON 249,673,685
```

All inert text. Reader has no way to ask "where does the 42.77M Core EBITDA come from?".

### After — Phase C

```
Equity = Core EBITDA (RON {42,769,791}) × Multiple (7.00×) − Net debt (RON {49,714,854}) = RON 249,673,685
                          ↑ click → P&L, EBITDA row             ↑ click → BS, LT bank loans
```

(`{n}` = clickable TraceableNumber.)

Clicking Core EBITDA's `42,769,791`:
1. Updates URL: `?tab=pl&highlight=ebitda` (preserves `period=` param)
2. Dashboard switches to the P&L tab
3. `useHighlightFromUrl()` finds `[data-traceable-target="ebitda"]` (the boxed EBITDA row)
4. Smooth-scrolls it to viewport center
5. Pulses amber for 1500ms
6. URL is stripped of `?highlight=` so refresh doesn't re-pulse

Clicking Net debt's `49,714,854` does the same — URL becomes `?tab=balance_sheet&highlight=longTermDebt`, BS opens, LT bank loans row pulses. The hint tooltip clarifies "Net debt = total debt − cash. Click jumps to LT bank loans (largest debt component)."

### Notes & Recommendations panel — incidental upgrade

Phase C's `FACT_TO_SOURCE` extension means alert bodies that cite EBITDA / revenue / net profit now produce clickable RON figures. Example (Debt/EBITDA covenant alert):

Before Phase Notes-Redesign: `Bank debt RON 14,083,316 divided by statutory EBITDA RON 2,127,404 = 6.62×`
After Phase Notes-Redesign + Phase B (BS only): `Bank debt {14,083,316} divided by statutory EBITDA RON 2,127,404 = 6.62×`
**After Phase C (PL added):** `Bank debt {14,083,316} divided by statutory EBITDA {2,127,404} = 6.62×` — both clickable.

## Verification

### TypeScript

```
$ npx tsc --noEmit -p tsconfig.json
EXIT=0
```

Clean. The resolver's exhaustive switch still compiles (no orphan keys).

### Unit verification — 15/15 PASS

Ran the resolver + linkifier on synthetic EEI-shaped statements (matching the deployed engine output for the company that prompted this work):

```
=== Phase C — new PL resolver keys on EEI ===
  ✓ revenue                    = 2,727,103.68
  ✓ costOfGoodsSold            = 0
  ✓ operatingExpenses          = 2,763,779.81
  ✓ depreciationAmortization   = 355,606.50
  ✓ interestExpense            = 716,741.02
  ✓ ebitda                     = −36,676.13   (revenue − cogs − opex; matches deriveTotals)
  ✓ ebit                       = −392,282.63
  ✓ netIncome                  = −738,834.25  (operational view per deriveTotals)

=== Phase C — linkifier picks up PL fact names ===
  ✓ Debt/EBITDA body now links BOTH values (BS + PL)
  ✓ Revenue + EBITDA in same body, both linked
  ✓ FACT_TO_SOURCE has revenue → pl/revenue
  ✓ FACT_TO_SOURCE has ebitda → pl/ebitda
  ✓ FACT_TO_SOURCE has statutory_ebitda → ebitda
  ✓ FACT_TO_SOURCE has core_ebitda → ebitda
  ✓ FACT_TO_SOURCE has net_income → pl
```

### Browser drive-through — deferred to deploy

Same situation as every prior phase. Deployed bundle is pre-Phase-C. The full end-to-end click → URL update → scroll → pulse loop is testable in `npm run dev` locally or once a fresh deploy ships. The unit verification + the Phase A foundation tests + the Phase B BS-side verification mean every machinery piece is independently validated; the remaining step is a single live load.

## Constraints honored

- ✅ **Engine numbers frozen** — no `src/engine/` file opened. C2/B1/H2/C1 fixes from `7cab09e` intact.
- ✅ **No fifth phase introduced** — Phase C as defined, plus the bonus label fix the user explicitly requested.
- ✅ **D-quick dedup preserved** — `dedupeNotes.ts` untouched.
- ✅ **Phase A foundation preserved** — `TraceableNumber.tsx` / `useHighlightFromUrl.ts` / `traceableSource.ts` / `traceablePulse.css` used as drop-in dependencies, not modified.
- ✅ **Phase B BS wiring preserved** — `bsStructure.ts` / `buildBsStatement.ts` / `BSStatementView.tsx` not touched. Phase B's 5 ratios still render their inline interactive formulas.
- ✅ **Phase Notes-Redesign preserved** — `StatementNotes.tsx` / `dedupeNotes.ts` not touched. The redesigned cards just got smarter because Phase C added PL fact mappings to `linkifyAlertBody.tsx`.
- ✅ **Bug A region / pricing / period-industry / notification-header** — all fenced, not opened.

## What's deferred (intentional, documented)

### PL-dependent ratios still use plain-text formula

The ratios whose formulas reference PL inputs (`gross_margin`, `ebitda_margin`, `net_margin`, `roa`, `roe`, `debt_to_ebitda`, `interest_coverage`, `dscr`, `dso`, `dio`, `dpo`, `ccc`, `asset_turnover`, `altman_z`) now have all the wiring they need — PL row targets, resolver keys, and the formulaParts AST mechanism from Phase B. Only the `formulaParts` arrays in `ratioKnowledge.ts` haven't been authored for these ratios yet.

This is a ~30-line append per ratio: define `formulaParts: [...]` with a few `kind: "value"` parts pointing at the new `revenue` / `ebitda` / `netIncome` / etc. keys. Pure data entry, no new logic. Naturally bundled with Phase D-backend or shipped as a single "Phase B.1" follow-up. I'm not authoring those today to keep Phase C tight.

### Net debt traceable target

`Net debt` is a derived value (`totalDebt − cash`) not stored as a single BS row. The Valuation card links Net debt to the LT bank loans row (the largest debt component) with a hint that explains the broader scope. If we ever want a true "Net debt" anchor on the BS, the cleanest move is to add a derived subtotal row at the bottom of the LIABILITIES section with `subtotalBucket: "netDebt"`. Not done today; the LT bank loans link is the practical landing point for now.

## What's next

- **Phase D-backend.** Backend dedup-on-insert root-cause fix for alerts (upsert on `(period_id, alert_key)` instead of insert-new-row-on-every-rerun). Final phase per the original plan.

Phase C closure complete. Awaiting your GREEN before starting Phase D-backend.
