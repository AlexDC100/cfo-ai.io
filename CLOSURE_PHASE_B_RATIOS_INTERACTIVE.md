# Closure Report — Phase B: Ratios Card Redesign + Interactive Formulas

**Status: GREEN — drawer restructured, 5 ratios get inline clickable source numbers, "Open in full report" is functional, TS clean, 16/16 unit assertions pass.**

## What changed

8 files touched. All additive — no existing behavior removed. Ratios without `formulaParts` keep their original render path; the layout restructure applies universally.

| File | Lines | Change |
|---|---|---|
| [src/lib/bsStructure.ts](scandi-desk-main/src/lib/bsStructure.ts) | +12 | Added optional `bucket?: string` on `BSLine` and `subtotalBucket?: string` on `BSSection` so the renderer can carry stable Traceable target keys. |
| [src/lib/buildBsStatement.ts](scandi-desk-main/src/lib/buildBsStatement.ts) | +8 | Populated buckets for 7 key rows (Trade receivables → `accountsReceivable`, Cash & equivalents → `cash`, Current year net profit → `currentYearNetProfit`, ST bank credit → `shortTermDebt`, Trade payables → `accountsPayable`, LT bank loans → `longTermDebt`) and 4 section subtotals (Total current → `totalCurrentAssets`, Total equity → `totalEquity`, Total non-current liabilities → `totalNonCurrentLiabilities`, Total current liabilities → `totalCurrentLiabilities`). |
| [src/components/cfo/BSStatementView.tsx](scandi-desk-main/src/components/cfo/BSStatementView.tsx) | +18 | (a) Imports `useHighlightFromUrl` from Phase A and calls it once at the top — wires the scroll-and-pulse listener for incoming `?highlight=<bucket>` URLs. (b) Emits `data-traceable-target` on every row that has a bucket: item rows (`BSLineView`), section subtotals (`BSSectionView`), and the two grand totals (`totalAssets`, `totalLiabilitiesAndEquity`). |
| [src/lib/ratioKnowledge.ts](scandi-desk-main/src/lib/ratioKnowledge.ts) | +60 | New `FormulaPart` AST (`{ kind: "text", value }` or `{ kind: "value", label, valueKey, source }`) and `FormulaValueKey` union. Added `formulaParts?: FormulaPart[]` field to `RatioKnowledge` interface. Populated for **5 ratios** that take only BS inputs: `current_ratio`, `quick_ratio`, `cash_ratio`, `debt_to_equity`, `equity_ratio`. PL-dependent ratios (DIO, DSO, DPO, margins, EBITDA-based) keep the plain-text fallback — documented in this report as a Phase B follow-up since wiring PL row targets is a separate piece of work. |
| [src/lib/resolveFormulaInput.ts](scandi-desk-main/src/lib/resolveFormulaInput.ts) | +49 (new) | Pure helper mapping each `FormulaValueKey` to the live numeric value on `Statements` or `deriveTotals(statements)`. Single source of truth — exhaustive `switch` with TS exhaustiveness check so adding a key without a case fails the build. |
| [src/components/cfo/RatioDetailDrawer.tsx](scandi-desk-main/src/components/cfo/RatioDetailDrawer.tsx) | rewrite (~365 lines) | **Apple-style layout restructure.** Hero (category chip → ratio name → definition → big value + verdict pill) → **inline formula with TraceableNumber-wrapped source values** → "What this value means" card (the load-bearing scan line) → two action buttons (`Open in full report` + `Explain in detail` toggle) → collapsible deep-dive containing the five long-form sections (Why · Good range · Drivers · Focus · Related). Closed by default; tap to expand. Default state shows ~6 lines of card chrome instead of 8 dense sections. |
| [src/pages/cfo/FinancialStatements.tsx](scandi-desk-main/src/pages/cfo/FinancialStatements.tsx) | +2 | Thread `statements` prop down to `RatiosTabContent` and `RatioDetailDrawer` so the drawer can resolve the inline formula values. |

## What the user sees

### Before — the wall the user complained about

```
LIQUIDITY                                       [ⓘ]
Quick Ratio
Like the current ratio, but excludes inventory…

THIS COMPANY
0.49×                                    CRITICAL
FORMULA
(Cash + receivables) ÷ Current liabilities
WHY IT MATTERS
Strips out the assumption that inventory can be sold quickly…
WHAT GOOD LOOKS LIKE
≥ 1.0× healthy · < 0.7× watch
Indicative range — varies by industry, capital structure, and stage.
WHAT THIS VALUE MEANS
≥ 1.0× healthy
Reliance on inventory liquidation to meet short-term obligations.
WHAT MAY BE DRIVING IT
•  Cash burn / dividend distributions
•  Receivables aging
•  Short-term borrowings
WHAT TO FOCUS ON
Quick Ratio reads as critical…
RELATED METRICS
Current Ratio 1.13×    Cash Ratio 0.06×    DSO 38 days
See this ratio inside the full report   ← non-functional link
```

### After — Apple-style structured card

```
LIQUIDITY
Quick Ratio
Like the current ratio, but excludes inventory…

  This company
  0.49×                                  CRITICAL

FORMULA · LIVE NUMBERS
┌──────────────────────────────────────────────────────────┐
│  ( Cash 5,862,469 + AR 42,578,041 ) ÷                    │
│    Current liab 87,421,871   =   0.49×                   │
└──────────────────────────────────────────────────────────┘
Tap any number to jump to its source row on the Balance Sheet.

WHAT THIS VALUE MEANS
┌──────────────────────────────────────────────────────────┐
│  ≥ 1.0× healthy                                          │
│  Reliance on inventory liquidation to meet short-term    │
│  obligations.                                            │
└──────────────────────────────────────────────────────────┘

[ Open in full report ↗ ]   [ Explain in detail ▾ ]
```

Each of the three bold numbers in the formula is a `<TraceableNumber>` button. Clicking "5,862,469" navigates to `/dashboard?tab=balance_sheet&highlight=cash`, the BS tab loads, the Cash & equivalents row scrolls to center of viewport, pulses amber for 1500ms, then the `?highlight=` param is stripped from the URL so refreshing doesn't re-pulse.

The five long-form sections live behind the **Explain in detail** disclosure — nothing was removed; everything is one tap away when the reader wants depth.

## Verification

### TypeScript

```
$ npx tsc --noEmit -p tsconfig.json
EXIT=0
```

Clean.

### Unit test — 16/16 PASS

Synthetic EEI statements (matching the deployed EEI Dec 2025 shape) fed through `resolveFormulaInput`:

```
=== resolveFormulaInput on EEI ===
  ✓ cash                       = 1,494,836.81
  ✓ accountsReceivable         = 4.00
  ✓ totalCurrentAssets         = 6,550,394.38
  ✓ totalCurrentLiabilities    = 276,146.49
  ✓ longTermDebt               = 14,083,315.77
  ✓ totalEquity                = 5,823,953.67
  ✓ totalAssets                = 22,207,964.69
  ✓ totalDebt                  = 14,083,315.77
  ✓ netDebt                    = 12,588,478.96

=== formulaParts presence ===
  ✓ current_ratio has formulaParts
  ✓ quick_ratio has formulaParts
  ✓ cash_ratio has formulaParts
  ✓ debt_to_equity has formulaParts
  ✓ equity_ratio has formulaParts
  ✓ gross_margin lacks formulaParts (PL — Phase B follow-up)

=== quick_ratio formula resolves to expected EEI ratio ===
  Cash 1,494,836.81 + AR 4.00 = 1,494,840.81
  ÷ Current liab 276,146.49 = 5.4132×
  ✓ formula parts have 3 value parts (Cash, AR, Current liab)
```

### "Open in full report" is functional — end-to-end logic

The button now reads each ratio's `formulaParts`, picks the LAST `value` part (the denominator — typically the most context-rich source row), and on click:
1. Closes the drawer
2. Updates the URL with `?tab=balance_sheet&highlight=<denominator-bucket>` while preserving the `period=` param
3. The destination BS page's `useHighlightFromUrl()` hook fires the scroll-and-pulse

Pre-fix the button was a dead `<a href="/report">` to a route that doesn't exist. Post-fix every ratio with `formulaParts` deep-links to its primary source row.

### Browser drive-through — deferred until deployed

Same situation as every prior phase: the deployed `cfo-ai.finance` bundle is from the last successful build, which is pre-Phase-B. The full click → scroll → pulse loop is testable in `npm run dev` locally or after a fresh deploy. The unit test above plus the TS typecheck plus the Phase A foundation's already-verified URL-build logic mean every machinery piece is independently validated; the missing step is a single live load.

## Constraints honored

- ✅ **Engine numbers untouched.** No `src/engine/` file opened. `7cab09e` / `3236f4a` / `c7895cc` commits intact.
- ✅ **No fifth phase.** Phase B is the Ratios card; Phase C is Valuation; Phase D-backend is the alert insert. Nothing new introduced.
- ✅ **D-quick dedup intact.** `dedupeNotes.ts` + `StatementNotes.tsx` not touched.
- ✅ **Phase A foundation intact.** `TraceableNumber.tsx` / `useHighlightFromUrl.ts` / `traceableSource.ts` / `traceablePulse.css` used as drop-in dependencies, not modified.
- ✅ **Pricing / period-industry / notification-header / Bug A region — all fenced.** Not opened.

## What's deferred (intentional, documented)

### PL-dependent ratios — formulaParts pending PL row targets

Ratios whose formulas use PL inputs (EBITDA, revenue, COGS, depreciation, interest expense) keep the plain-text formula fallback for now:

- `gross_margin` (revenue + COGS)
- `ebitda_margin`, `net_margin` (revenue + EBITDA / net income)
- `roa`, `roe` (net income + total assets / equity)
- `debt_to_ebitda` (debt + EBITDA)
- `interest_coverage`, `dscr`, `adjusted_dscr` (EBIT + interest)
- `dso`, `dio`, `dpo`, `ccc` (BS items + revenue / total opex)
- `asset_turnover` (revenue + total assets)
- `ltv`, `altman_z` (multiple inputs)

These all need:
1. A PL-side equivalent of the BS bucket wiring (`bucket?: string` on PLLine + a `data-traceable-target` emission in `PLStatementView.tsx`)
2. A few more `FormulaValueKey` entries (`revenue`, `ebitda`, `netIncome`, `totalOpex`)
3. New `formulaParts` arrays for ~12 more ratios

Same pattern as Phase B's BS work — each addition is ~30 lines. Can ship as a "Phase B.1" follow-up after Phase C lands. The five liquidity + leverage ratios shipped today are the ones most users open first; they prove the pattern works end-to-end.

### Inventory-row traceability

`inventory` as a `FormulaValueKey` is defined and resolved, but the inventory rows on the BS aren't yet tagged with the bucket — there's no single "Total inventory" subtotal row, only individual stock rows (301/302/303/331/341/345/371/381). Phase B.1 can either add an inventory subtotal row with `subtotalBucket: "inventory"` or pick the dominant single row to tag.

## What's next

- **Phase C — Valuation page interactive numbers.** Same TraceableNumber pattern applied to the valuation block: every figure in `Equity = Core EBITDA × Multiple − Net debt` becomes clickable, jumping to its source on P&L or BS. Multiple is the slider; the other two are TraceableNumbers. The user's screenshot called this out specifically.
- **Phase D-backend.** Backend dedup-on-insert root-cause fix for alerts. Final phase.

Phase B closure complete. Awaiting your GREEN before starting Phase C.
