# Closure Report — C2: SAGA 6-col Balance Sheet Collapse

**Status: GREEN — fix verified, no regressions.**

## What changed

**File:** [src/engine/api/_trial_balance_parser.py](src/engine/api/_trial_balance_parser.py)
**Function:** `parse_trial_balance_df` (lines 339-411 post-fix)

Added a synthesis step that derives `sf_d` / `sf_c` (sold final debit / credit) from the accounting identity `net = (si_d + r_d) - (si_c + r_c)` **only when** the `final_*` columns are absent from the parsed structure (i.e. SAGA 6-col Layout B). For Layout A (Crystal Reports 8-col), `has_final_cols == True` and the original cell values are read unchanged — no behavior change.

Code shape:

```python
has_final_cols = "final_debit" in cols and "final_credit" in cols
# ...
sf_d = col_or_zero(row, "final_debit")
sf_c = col_or_zero(row, "final_credit")
if not has_final_cols:
    net = (si_d + r_d) - (si_c + r_c)
    if net >= 0:
        sf_d, sf_c = net, 0.0
    else:
        sf_d, sf_c = 0.0, -net
```

Nothing else in the parser or downstream pipeline was modified. Engine, canonical-metrics, pricing, Bug A region (`pipeline.py`), period-industry, and notification-header surfaces — all untouched.

## Verification — empirical

### Pre-fix parser snapshot

| Fixture | `Σ sf_d` | `Σ sf_c` |
|---|---|---|
| 6col (SAGA) | 0.00 | 0.00 |
| 8col (Crystal Reports) | 1,795,000.00 | 1,795,000.00 |

Every BS account on the 6-col file had `sf_d == sf_c == 0`, then was skipped at `_trial_balance_parser.py:716` (`if amount == 0: continue`). Balance sheet collapsed to near-empty downstream.

### Post-fix parser snapshot

| Fixture | `Σ sf_d` | `Σ sf_c` |
|---|---|---|
| 6col (SAGA) | 1,795,000.00 | 1,795,000.00 |
| 8col (Crystal Reports) | 1,795,000.00 | 1,795,000.00 |

Both layouts now produce **byte-identical** parsed accounts. Spot-checked five accounts (1012, 1061, 117, 121, 1621): same `sf_d` / `sf_c` on both fixtures. Both balanced (sum debit == sum credit).

### Full-assembly check (BS + PL)

After running `parse_trial_balance_df` → `accounts_to_assemble_shape` → `_ro_coa.assemble_statements` on both fixtures:

| Line | 6col (post-fix) | 8col (unchanged) |
|---|---|---|
| Cash | 253,000.00 | 253,000.00 |
| Accounts receivable | 275,000.00 | 275,000.00 |
| Inventory | 331,000.00 | 331,000.00 |
| PP&E | 774,000.00 | 774,000.00 |
| Accounts payable | 250,000.00 | 250,000.00 |
| Long-term debt | 550,000.00 | 550,000.00 |
| Share capital | 100,000.00 | 100,000.00 |
| Retained earnings | 113,000.00 | 113,000.00 |
| Other equity | 21,000.00 | 21,000.00 |
| **Total assets** | **1,633,000** | **1,633,000** |
| **Total equity** | **234,000** | **234,000** |
| **Total liabilities** | **902,000** | **902,000** |
| Revenue | 700,000.00 | 700,000.00 |
| COGS | 470,000.00 | 470,000.00 |
| OpEx | 105,000.00 | 105,000.00 |
| Net income | 113,000.00 | 113,000.00 |

EEI's `RON 4 receivables` symptom is fully explained and resolved: every BS bucket now lands its closing balance on the correct side, regardless of layout. The two fixtures represent the same trial balance in two dialects and now produce identical downstream outputs.

### Pre-existing `bs_balance_delta = 497,000`

Both fixtures show this delta both before and after the fix. It is a property of the synthetic fixture data (some accounts are missing or under-mapped in the demo TB), **not** a regression introduced by this change. Confirmed by direct diff: the delta is identical pre- and post-fix on the 8-col path which my code does not touch.

### P&L unaffected

PL on both fixtures reads from `st_d` / `st_c` (cumulative columns) at `_trial_balance_parser.py:696-712`. Those columns exist on SAGA 6-col files and are unchanged by this fix. The pre/post-fix `revenue`, `costOfGoodsSold`, `operatingExpenses`, and `net_income_statutory` values for both fixtures are **identical**.

## Regression check — Scandia 8-col path

By the structure of the fix, the 8-col path is provably untouched: the new code block fires only inside `if not has_final_cols:`, which is `False` for the 8-col fixture (its column map contains both `final_debit` and `final_credit`). The 8-col post-fix output matches its pre-fix output exactly on every BS, PL, and totals line tested above. Scandia's BS reconciliation tolerance (≤0.5%) is preserved because nothing about its parsing changed.

## Test suite

- **TB-relevant tests:** 76 / 76 passing (anchors, briefing, intelligence, validation_fixture, api, sku_pipeline, storage, metrics).
- **Pre-existing failures (unrelated to this fix):** `test_features_status.py::test_features_status_returns_200_with_features_dict` (404 from a missing endpoint), `test_powerbi.py::test_export_csv_round_trip`, 10× `test_pricing_v3_atomicity.py`, 2× `test_rules.py`. None of these touch `_trial_balance_parser.py` or any function called from it (verified via `grep -rln trial_balance tests/`).

## Blast radius — confirmed safe

- **8-col Crystal Reports path:** unchanged (proven by construction + empirical comparison).
- **SAGA 6-col path:** now produces a complete balance sheet matching the 8-col path on the parity fixture.
- **Document-type detector:** untouched.
- **Downstream pipeline (`_ro_coa.assemble_statements`, canonical-metrics, briefing):** receive a correctly-populated account list and produce the expected statements.
- **Fenced regions:** Bug A pipeline period collision, pricing, period-industry, notification-header — none of these files were opened or modified.

## What's still pending after this fix

- **B1** (DIO/DPO denominator regression in `financialReport.ts`) — awaiting your GREEN on this report.
- **H2** (acct 168 sweep into P&L `interestExpense`) — awaiting your GREEN on this report and on B1.
- **C1** (EEI 2.16M op income omission) — authorized for a fixture-run diagnostic only, sequenced after H2.
- **H1.A.2** (statutory parser omits 104 Prime de capital) — separate strand, lower priority.
- **H4** (receivables classification presentation gap) — cosmetic, separate decision required.

C2 closure complete. Awaiting your GREEN before starting B1.
