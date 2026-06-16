# Diagnostic — Altman Z" / Credit Verdict Divergence

> **Read-only diagnostic. NO code changes were made.**
> Fills the Phase 0 coverage gap identified in the multi-jurisdiction roadmap (§0): "wrong Altman/credit verdict — investment-grade company shown as borderline grey-zone." No existing diagnostic owns this specific finding; this document records the mechanism, file:line evidence, blast radius, and minimal fix surface for sequencing after the other Phase 0 closures.
> Strands fenced from: engine compute math (other than the divergence itself), parser, canonical-metrics module, Bug A/B regions, period-industry, notification-header, pricing.

---

## Headline verdict

**Two Altman implementations live in the codebase. They produce different scores AND different verdict zones from identical inputs. The user sees the engine's number on the Dashboard credit card and the frontend's number on the Statements page — for manufacturing companies these are not the same and can disagree on safe-vs-grey.**

There is no diagnostic file owning this. The roadmap §0 names it the highest-stakes Phase-0 error, but the code has been carrying the divergence since at least commit `7cab09e` (the C1/B1/H2/C2 foundation pass). Closing it requires picking ONE implementation as canonical and routing every consumer through it.

---

## The two implementations

### Engine — [src/engine/api/pipeline.py:1128-1148](src/engine/api/pipeline.py#L1128)

```python
altman_z = None
…
if total_assets > 0:
    x1 = (current_assets - current_liab) / total_assets
    x2 = bs["retainedEarnings"] / total_assets        # ← see note below
    x3 = operating_profit / total_assets              # ← OPERATIONAL EBIT (722-excluded)
    total_liab_safe = max(current_liab + non_current_liab, 1)
    x4 = total_equity / total_liab_safe
    altman_z = 6.56 * x1 + 3.26 * x2 + 6.72 * x3 + 1.05 * x4   # ← Z" (always, no variant)

    if altman_z >= 2.60:   altman_subscore = …      # ← Z" thresholds
    elif altman_z >= 1.10: altman_subscore = …
    else:                  altman_subscore = …
```

`bs["retainedEarnings"]` is set at [_ro_coa.py:869](src/engine/api/_ro_coa.py#L869):
```python
bs["retainedEarnings"] = round(bs["retainedEarnings"] + net_income_statutory, 2)
```
i.e. account 117 carry-forward **plus** current-year statutory net income (account 121). This matches the FE's `retainedEarningsPlusCurrent`, so X2 is consistent between the two sites — that one is fine.

The engine **always** uses the Z" formula and Z" thresholds, regardless of industry.

### FE — [scandi-desk-main/src/lib/financialValuation.ts:690-752](scandi-desk-main/src/lib/financialValuation.ts#L690)

```typescript
export function altmanZScore(s: Statements): AltmanResult {
  const industry = (s.industry ?? "").toLowerCase();
  const useDoublePrime =
    !industry || _Z_DOUBLE_PRIME_INDUSTRIES.has(industry) || !_Z_PRIME_INDUSTRIES.has(industry);

  const x1 = safeDiv(c.workingCapital, c.totalAssets);
  const x2 = safeDiv(c.retainedEarningsPlusCurrent, c.totalAssets);
  const x3 = safeDiv(c.ebitStatutory, c.totalAssets);   // ← STATUTORY EBIT (722-included)
  const x4 = safeDiv(c.totalEquity, c.totalLiabilities);
  const x5 = safeDiv(c.revenue, c.totalAssets);

  if (useDoublePrime) {
    // Z" — 4-component, coefficients (6.56, 3.26, 6.72, 1.05), zones 2.60/1.10
  } else {
    // Z' — 5-component, coefficients (0.717, 0.847, 3.107, 0.42, 0.998), zones 2.90/1.23
  }
}
```

`_Z_PRIME_INDUSTRIES` is the manufacturing/retail/FMCG bucket; everything else falls into `useDoublePrime` (the default). The FE picks variant **by industry**.

Consumed at [FinancialStatements.tsx:3200](scandi-desk-main/src/pages/cfo/FinancialStatements.tsx#L3200) via `computeCreditScore(statements)`, and again on the standalone exported report via [financialExports.ts:44](scandi-desk-main/src/lib/financialExports.ts#L44).

---

## Three discrete divergences

### Divergence 1 — Formula variant (Z' vs Z") for manufacturing

| Industry | Engine output | FE output |
|---|---|---|
| `packaged_canned_meat_prepared_foods` (Scandia) | Z" with (6.56, 3.26, 6.72, 1.05) | **Z' with (0.717, 0.847, 3.107, 0.42, 0.998)** |
| `manufacturing`, `fmcg_food`, `retail`, `wholesale_distribution`, `e_commerce`, `fmcg_beverage` | Z" | **Z'** |
| `real_estate_*`, `services`, `saas`, `transport_logistics`, `consulting` | Z" | Z" (match) |

Even at **identical X1–X4 inputs**, Z' and Z" give different scores because the coefficients are different orders of magnitude (Z' has coefficients ~0.4–3.1, Z" has ~1–7) AND different zone thresholds (Z': 2.90/1.23, Z": 2.60/1.10). The same balance sheet can read "grey-zone" under Z" and "safe" under Z'.

Scandia's CLAUDE.md calibration cites "Altman Z″ 3.09 (safe zone)". That's the engine number under Z". Under Z' (which the FE applies for manufacturing) the score is computed against different coefficients and a 2.90 safe threshold — a number that may agree or disagree with the engine's verdict, but **the user sees both numbers on different surfaces with no warning that they are derived from different formulas**.

The cross-view consistency script confirms the FE variant logic is the intended one — [scripts/check_cross_view_consistency.py:342](scripts/check_cross_view_consistency.py#L342):
```python
altman_variant_expected = 'Z"' if industry_key.startswith("real_estate") else "Z'"
```
The check expects Z' for non-real-estate (i.e. manufacturing should be Z'). The engine produces Z". The check is wrong about engine output, or the engine is wrong about the variant — pick one.

### Divergence 2 — X3 EBIT basis (operational vs statutory)

| Site | X3 numerator | EEI delta | Scandia delta |
|---|---|---|---|
| [pipeline.py:1134](src/engine/api/pipeline.py#L1134) | `operating_profit` = operational EBIT, **excludes account 722** | — | — |
| [financialValuation.ts:701](scandi-desk-main/src/lib/financialValuation.ts#L701) | `c.ebitStatutory` = statutory EBIT, **includes account 722** | EEI 722 = RON 2,164,080 | Scandia 758 = ~RON 520k |

For EEI (commercial real estate, total assets ~RON 21M per the C1 diagnostic fixture):
- ΔX3 = 2,164,080 / 21,000,000 ≈ 0.103
- ΔZ" = 6.72 × 0.103 ≈ **+0.69 to the FE Z" vs the engine Z"** on the same period

That's the difference between borderline "grey" (2.0) and "safe" (2.7) on a single line. For an asset-heavy real-estate vehicle this is THE error class the roadmap names.

### Divergence 3 — Composite weights and weighting structure

| Component | Engine weight (pipeline.py:1206-1214) | FE weight (financialValuation.ts:754-…) |
|---|---|---|
| Altman | **0.30** | **0.40** |
| Profitability | 0.20 | (not a separate bucket) |
| Leverage (Net Debt/EBITDA) | 0.15 | 0.15 |
| Interest coverage | 0.10 | 0.10 |
| DSCR | 0.10 | 0.10 |
| Liquidity | 0.10 | 0.05 (cash ratio only per the comment header at line 756) |
| Equity ratio | 0.05 | — |
| Piotroski | — | **0.20** |

These are two genuinely different composite formulas. Even if Altman were identical, the composite letter grade would differ. The Dashboard renders the engine composite via [CreditScoreCard.tsx:71-79](scandi-desk-main/src/components/cfo/CreditScoreCard.tsx#L71); the Statements page and the standalone export render the FE composite via `computeCreditScore`.

---

## Where the user sees each implementation

| Surface | Reads from | File:line |
|---|---|---|
| Dashboard credit-score card | Engine `calculated_metrics` (`altman_z_score`, `credit_composite`) | [CreditScoreCard.tsx:71-79](scandi-desk-main/src/components/cfo/CreditScoreCard.tsx#L71) |
| Financial Statements page (Ratios/Risk tab) | FE `computeCreditScore(statements)` | [FinancialStatements.tsx:3200](scandi-desk-main/src/pages/cfo/FinancialStatements.tsx#L3200) |
| Exported standalone report | FE `computeCreditScore` | [financialExports.ts:44](scandi-desk-main/src/lib/financialExports.ts#L44) |

So: **a board reader who switches from Dashboard to Statements can see two different credit grades on the same period.** This is precisely the "wrong board-level conclusion" failure the Phase 0 gate is designed to eliminate.

---

## Dependency on the other open Phase-0 items

Even if the two implementations are reconciled (pick one canonical), Altman remains wrong if any input is wrong. The dependency chain:

| Altman input | Depends on | Existing diagnostic | Status |
|---|---|---|---|
| `total_assets` | BS builder | [DIAGNOSTIC_EQUITY_BS_INTEREST_DIO_SAGA.md](DIAGNOSTIC_EQUITY_BS_INTEREST_DIO_SAGA.md) (Strand A: 104 leak) | OPEN (statutory path) |
| `total_equity` (X4 numerator) | BS equity buckets (104, 117, 121) | Same diagnostic | OPEN |
| `total_liab` (X4 denominator) | BS liabilities + 168 routing | [CLOSURE_H2_ACCT_168_INTEREST.md](CLOSURE_H2_ACCT_168_INTEREST.md) | GREEN (168 fixed) |
| `retainedEarnings + current_NP` (X2 numerator) | bs["retainedEarnings"] + net_income_statutory | Net-profit consistency work; engine adds current NP at _ro_coa.py:869 | GREEN at engine, **not audited on every FE surface** |
| `operating_profit` / `ebitStatutory` (X3) | EBIT — operational vs statutory | [CLOSURE_C1_EEI_722_RENDERER.md](CLOSURE_C1_EEI_722_RENDERER.md) | GREEN at renderer; **engine still uses operational** for Altman — see Divergence 2 |
| `working_capital` (X1) | current_assets, current_liab | — | **No diagnostic owns the receivables aggregation directly** — Strand B of equity diagnostic covers DIO denominator but not X1 |
| `revenue` (X5 for Z') | net_turnover | Canonical-metrics work | GREEN at canonical |

**The 104 statutory-path leak (Strand A.2 of the equity diagnostic) directly understates total_equity → X4 wrong → Z' or Z" wrong → composite wrong → letter grade wrong → credit verdict wrong.** That single fix moves Altman on every entity that has a non-zero merger premium and is parsed via the F30/F10 path. For EEI specifically the 104 column is in the source TB; quantifying the exact ΔZ" requires running both fixtures through the pipeline post-fix, which is out of scope for this read-only diagnostic.

---

## Blast radius

- **Every period analyzed** sees engine Z" on the Dashboard. For manufacturing/retail/FMCG industries this is the wrong variant per the FE's industry-aware logic and the cross-view check script's expectation.
- **Every period viewed on the Statements page** sees FE Altman (variant by industry, statutory EBIT). For EEI this number differs from the Dashboard by +0.69 in Z just from the 722 inclusion — enough to flip a verdict zone.
- **Every exported report** uses the FE composite (Altman 40% × Z'-or-Z" + Piotroski 20%). The Dashboard composite uses Altman 30% × Z" + profitability 20%. Different numerical scores on the same period.
- **Customer-facing trust signal: broken by design** — there is no single "credit verdict" in this product today, there are two.

For Scandia (calibration company): engine reports Z" 3.09 / composite ~82 / grade A− per CLAUDE.md. Under the FE's Z' (manufacturing variant) the score, zone, and composite differ by amounts that the diagnostic cannot estimate without running both calculations against the live fixture — but the divergence is structurally non-zero because the formulas are not equivalent transforms of each other.

For EEI: engine Z" with operational EBIT; FE Z" with statutory EBIT — same variant but ΔZ" ≈ +0.69 from 722 alone. Plus the 104 statutory-path leak compounds X4 on both sites equally (since both share the same `total_equity` upstream).

---

## Minimal fix surface (NOT implemented)

This is the sequencing for closing the gap. Each item is a discrete change; together they take Altman off the Phase 0 open list.

**F1. Pick one canonical implementation.** Recommend the FE's `altmanZScore` in [financialValuation.ts](scandi-desk-main/src/lib/financialValuation.ts), because:
- It already handles the Z' vs Z" variant choice correctly per industry
- It uses statutory EBIT consistently with the canonical-metrics work
- The cross-view check script's expectation matches it
- Delete the engine Altman block at [pipeline.py:1128-1245](src/engine/api/pipeline.py#L1128) and stop persisting `altman_z_score` / `altman_x*` / `credit_subscore_*` to `calculated_metrics`. Route `CreditScoreCard.tsx` through the canonical-metrics module + `altmanZScore()` instead.

**F2. After F1, eliminate the composite-weight divergence.** Pick one composite formula (engine's 30/20/15/10/10/10/5 OR FE's 40/20/15/10/10/5). Recommend FE's because Piotroski is included and Altman has higher weight. Engine's `composite_credit` + `credit_subscore_*` metric rows become unused — delete them too.

**F3. After F1+F2, audit the X1 working-capital inputs.** The equity diagnostic's Strand B covers DIO denominator (receivables aggregation); confirm that the SAME corrected receivables figure feeds Altman X1's `current_assets` term. If a separate aggregation site exists for X1, route it through the canonical receivables value.

**F4. After F1–F3, gate the BS-balance Phase-0 fix.** The Strand A.2 fix (104 on statutory path) lands `total_equity` and `total_liabilities` correctly, which propagates to X4 automatically.

**F5. Verification (gate the closure on real fixtures).** Run Scandia + EEI end-to-end. Print Z, zone, composite, grade. Compare against an external oracle (the reference implementation at `reference/financial_analysis.py:650` is one — but note its `build_credit_score` matches the engine, not the FE, so the oracle itself needs picking). Acceptance: Z within ±0.05 of the chosen oracle, zone correct on both, composite within ±2 points, letter grade match.

**F6. Then update CLAUDE.md.** The calibration line "Altman Z″ 3.09 (safe zone)" assumes the engine's Z". If F1 picks Z' for manufacturing, the calibration needs re-running and re-recording.

---

## Open items (data / decisions, not code)

1. **Which variant is correct for Scandia?** The roadmap says "investment-grade company shown as borderline grey-zone" — that implies a known correct verdict against which the engine's output is being compared. The reference (`reference/financial_analysis.py:650`) uses Z" universally; CLAUDE.md cites Z" 3.09 safe. Decision needed: is the manufacturing variant Z' (per the FE's industry-aware logic and the cross-view check) or Z" (per the engine and reference)? Both are defensible academically; this product needs one.

2. **Is the 104 leak material enough alone to flip Scandia's zone?** Order-of-magnitude estimate using CLAUDE.md numbers (total_equity 150.15M, liabilities ~142.9M, hypothetical 41.65M understatement): ΔX4 ≈ 41.65/142.9 = 0.291; ΔZ" ≈ 1.05 × 0.291 = 0.306. From 3.09 → ~2.78. Still in safe zone (above 2.60), not in grey. So the 104 leak alone does not produce the verdict flip the roadmap describes. The verdict flip must come from a combination of (a) variant choice (Z' vs Z") and (b) one or more of the other Phase-0 input errors. Need to run the actual fixture post-fix to confirm which combination produces the documented flip.

3. **What ZScore does the user actually see today on Scandia's Dashboard live?** Quick check post-deploy: open the credit card and read `altman_z_score`. If it's NOT 3.09 (per calibration), one of the inputs is already drifting on the live deployment too — and the Phase 0 gap is bigger than this diagnostic estimates.

---

## What this diagnostic does NOT do

- Does not fix anything. Read-only by design.
- Does not run a fresh end-to-end on Scandia/EEI. The order-of-magnitude estimates above are computed from documented inputs (CLAUDE.md calibration + the C1 fixture's 722 value), not from re-executing the pipeline. F5 in the fix surface owns that re-run.
- Does not resolve open item 1 (Z' vs Z" for manufacturing). That's a methodology decision, not a code finding.

---

*Status: diagnostic complete. The Altman / credit-verdict gap is now catalogued with file:line evidence and a sequenced fix surface. Closes the coverage hole in the Phase 0 gate listed in `MULTI_JURISDICTION_ROADMAP.md` §0. No fix begins until the F1–F6 sequence is approved and the variant decision (open item 1) is made.*
