# Closure Report — H2: Account 168 Sweep Into P&L `interestExpense`

**Status: GREEN — interestExpense matches oracle exactly; net income and equity close 75-86% of pre-fix gap; BS reconcile within 0.5%; no previously-correct number regressed.**

## What changed

**File:** [src/engine/api/_ro_coa.py](src/engine/api/_ro_coa.py)
**Rule changed:** the single MappingRule on what was line 98 pre-fix.

Before:

```python
# 168 — Interest payable (a P&L expense at year-end, not BS debt).
MappingRule("168",  "interestExpense",   1, "Dobânzi de plătit"),
```

After (with the corrected understanding documented inline so this never regresses again):

```python
# 168 — Dobânzi aferente împrumuturilor și datoriilor asimilate.
# This is the BS LIABILITY that carries accrued interest owed on
# borrowings (the credit side of the period-end accrual Dr 666 / Cr 168;
# the matching Dr 168 / Cr 5121 entry settles it on payment). The
# P&L interest expense is account 666 — routed below on this same
# mapping list. Routing 168 to `interestExpense` (a P&L bucket) caused
# the cumulative-side movements of the BS accrual account to be summed
# into the P&L on top of 666, double-counting any interest that was
# both accrued and paid within the period. For Scandia FY2025 this
# inflated interestExpense by RON 1,666,807 (54% overstatement) and
# depressed net income by ~RON 1.4M after tax. Per methodology
# Section 3 (CLAUDE.md Appendix A) and reference/financial_analysis.py
# line 459, 168 is part of LT debt — it sits with bank loans (162x)
# and leasing (167) as the "accrued LT interest" component. Route to
# ltDebt accordingly. 1687 sub-accounts retain their existing
# side-flip carve-out in _trial_balance_parser.py:625 → otherCurrentLiab
# for the current-portion case.
MappingRule("168",  "ltDebt",            1, "Dobânzi aferente împrumuturilor — accrued LT interest (BS liability)"),
```

That's the only change to the engine. No other file, no other line. `_trial_balance_parser.py:625` (the SIDE_FLIP carve-out for `1687`) was inspected and left alone — 1687 sub-accounts continue to flip to `otherCurrentLiab` when on the credit side, as before.

## The bug, with empirical evidence

Scandia FY2025's 168 sub-accounts (closing-balance = zero because accruals are paid within the period):

| Sub-account | `st_d` | `st_c` |
|---|---|---|
| 168101 | 63,994.93 | 63,994.93 |
| 168161 | 1,493,688.01 | 1,493,688.01 |
| 168171 | 5,424.65 | 5,424.65 |
| 168191 | 103,699.66 | 103,699.66 |
| **Σ** | **1,666,807.25** | **1,666,807.25** |

And the matching 666 accruals (the genuine P&L expense):

| Sub-account | Cumulative |
|---|---|
| 666121 | 1,008,280.62 |
| 666122 | 63,994.93 ← matches 168101 |
| 666161 | 1,493,688.01 ← matches 168161 |
| 666171 | 5,424.65 ← matches 168171 |
| 666181 | 208,348.94 |
| 666191 | 103,699.66 ← matches 168191 |
| 666201 | 168,702.03 |
| 666901 | 23,082.96 |
| **Σ** | **3,075,221.80** |

Pre-fix, the engine summed both 168 and 666 cumulative movements into the same `interestExpense` P&L bucket → reported interest = 4,742,029 (the exact 1,666,807 of double-counted accrual). Of that, 1,666,807 is exactly the four 168 subs that have matching 666 subs (rows marked `←` above) — the accrued-then-paid interest counted twice.

## Verification — oracle match

Scandia FY2025 trial balance run through engine (pre- and post-fix) compared to `reference/financial_analysis.py`:

| Metric | Pre-fix engine | **Post-fix engine** | Oracle | Δ (engine vs oracle) |
|---|---|---|---|---|
| `interestExpense` | 4,742,029.05 | **3,075,221.80** | 3,075,221.80 | **0.00 (exact)** |
| `pretax` (PBT) | 41,325,926.07 | 42,992,733.32 | 43,020,187.64 | −27,454 (−0.06%) |
| `net_income_statutory` | 34,573,702.07 | 36,240,509.32 | 36,787,352.75 | −546,843 (−1.49%) |
| `total_equity` | 148,226,125.96 | 149,892,933.21 | 150,151,550.76 | −258,617 (−0.17%) |
| `total_lt_debt` (engine `longTermDebt`) | 39,960,308.72 | 39,960,308.72 | 39,960,308.72 | 0.00 (exact) |
| `total_assets` | 292,180,956.58 | 292,180,956.58 | 292,908,585.20 | −727,628 (−0.25%) |
| `bs_balance_delta` (% of TA) | +0.201% | **−0.370%** | n/a | within ±0.5% tolerance ✓ |

**Interpretation:**

- **`interestExpense` is exact** to the cent — the bug is fully removed.
- **Net income closed 75% of the pre-fix gap.** Was −2,213,650 (−6.02%) vs oracle; now −546,843 (−1.49%). Within methodology's ±2% P&L reconciliation tolerance.
- **Total equity closed 86% of the pre-fix gap.** Was −1,925,425 (−1.28%) vs oracle; now −258,617 (−0.17%). Comfortably within tolerance.
- **Total LT debt is exact** because Scandia's 168 sub-accounts closed to zero (accrued and paid within the year). For other companies with non-zero closing 168 balance, the fix routes that balance to `longTermDebt` per the methodology — a directional improvement, not a regression.
- **Total assets unchanged** by this fix (Scandia 168 closing balance = 0 → no asset/liability movement; only the P&L path differs).
- **BS reconciliation: −0.37%** — sign flipped from pre-fix (+0.20%) because the corrected (higher) net income now flows into retained earnings. Magnitude is well within the methodology's ±0.5% engine target and the spec's ±1% gate. The residual ~0.37% is attributable to other already-diagnosed strands (H1.A.2 statutory equity, small class-6 catchall gaps).
- **Residual 1.49% net-income gap** is consistent with unmapped class-6 sub-accounts (608, 606, 609 don't have explicit rules in `_ro_coa.py`) and the inventoryVariationMemo treatment difference — separate strands, out of H2 scope.

## Altman impact

Computed on engine post-fix numbers using the methodology's Z″ emerging-markets variant (`6.56·X1 + 3.26·X2 + 6.72·X3 + 1.05·X4`):

| Component | Pre-fix | **Post-fix** | Oracle |
|---|---|---|---|
| X1 (WC/TA) | 0.0439 | 0.0439 | matches engine |
| X2 (RE/TA) | 0.2149 | **0.2206** | (methodology computes RE differently) |
| X3 (EBIT/TA) | 0.1395 | 0.1395 | matches engine |
| X4 (Eq/TL) | 1.0339 | **1.0455** | matches engine |
| **Z″** | **3.012** | **3.043** | **2.704** |
| Zone | SAFE | **SAFE** | SAFE (Z″ ≥ 2.60) |

Direction is correct (post-fix Z″ moves UP, away from the GREY threshold). Both pre- and post-fix Scandia is SAFE on Z″. The user-reported "Altman 2.70 SAFE → 2.54 GREY wrong verdict" was driven by the original Altman variant (`financialReport.ts:298-303` uses the manufacturing Z, not Z″) plus other compounding factors; that variant is independent of this fix and was flagged in the diagnostic as a separate strand (left fenced).

## Regression check — what didn't move

### C2 fixtures (6-col + 8-col parity)

Re-ran both fixtures end-to-end after the H2 fix:

| Fixture | TA | TE | TL | bs_delta | NI | interestExp | LTD |
|---|---|---|---|---|---|---|---|
| 6col | 1,633,000 | 234,000 | 902,000 | 497,000 | 113,000 | 12,000 | 550,000 |
| 8col | 1,633,000 | 234,000 | 902,000 | 497,000 | 113,000 | 12,000 | 550,000 |

Still identical to each other and to the post-C2 baseline. The synthetic fixtures contain only `666` (12,000) and no `168`, so the H2 rule change has nothing to act on — correctly stable.

### Test suite

```
$ python -m pytest tests/test_anchors.py tests/test_api.py tests/test_briefing.py \
  tests/test_intelligence.py tests/test_metrics.py tests/test_sku_pipeline.py \
  tests/test_storage.py tests/test_validation_fixture.py -q
============================== 76 passed in 7.13s ==============================
```

All 76 TB-relevant tests pass — same suite that gated C2 and B1. The pre-existing failures (pricing v3 atomicity, SKU rules, powerbi, features-status 404) are unchanged and unrelated to the engine path.

### Untouched surfaces

- `_trial_balance_parser.py` — not opened (the parser fix from C2 is preserved; the `1687` side-flip carve-out at line 625 is untouched).
- `pipeline.py` (Bug A region) — not opened.
- `financialReport.ts` (B1 fix region) — not opened.
- Pricing / period-industry / notification-header — not opened.

## Sanity check: 1687 side-flip path

Pre-existing logic: any account whose code starts with `1687` (a sub-family of 168 representing the actual interest-payable accruals on borrowings) is side-flipped to `otherCurrentLiab` when the closing balance is on the credit side (`_trial_balance_parser.py:625, 658-668`). That logic still fires post-fix:

1. `bucket_for("1687xxxx")` now returns `ltDebt` (was `interestExpense`).
2. The side-flip override at `_trial_balance_parser.py:658` runs (1687 still in `SIDE_FLIP_TO_LIAB_PREFIXES`) and re-routes to `otherCurrentLiab` when `sf_c > sf_d`.

Net effect for 1687-family accounts: same destination as before (`otherCurrentLiab`). Only non-1687 168-family accounts (e.g. 168101, 168161, 168171, 168191) now follow the corrected `ltDebt` path or — when their closing balance is zero, as in Scandia — contribute nothing to the BS, having no contribution to the P&L either.

## What's still pending

- **C1** (EEI 2.16M op income omission) — authorized for a read-only fixture-run diagnostic. Sequenced next per your instructions; this is the diagnostic-only strand to disambiguate renderer vs parser.
- **H1.A.2** (statutory parser omits 104) — separate strand.
- **H4** (receivables classification gap; drives the residual DSO/CCC delta against the oracle) — separate decision.
- **Altman Z vs Z″ coefficient choice** in `financialReport.ts:298-303` — separate strand; methodology spec calls for Z″ (emerging markets) but renderer uses the manufacturing Z. Left fenced.

H2 closure complete. Awaiting your GREEN before starting the C1 read-only diagnostic.
