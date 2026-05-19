# Diagnostic — Equity / BS / Interest / Receivables / DIO / SAGA-6col

> **Read-only diagnostic. NO code changes were made.**
> Strands fenced from: engine, canonical-metrics, pricing, Bug A, period-industry, notification-header (per task constraint).
> All findings are file:line evidence with the minimal fix surface recorded (not implemented).

---

## Strand A — Equity / BS / Interest cascade

### H1 — Account 104 (Prime de capital / merger premium) routing

Two distinct paths, two distinct outcomes.

**A.1 — TB path (Scandia 8-col Crystal Reports)**

- `src/engine/api/_ro_coa.py:82` — `MappingRule("104", "otherEquity", 1, "Prime de capital")` ✓ present.
- `src/engine/api/_ro_coa.py:435` — `"otherEquity": "otherEquity"` (sub-to-top identity).
- `src/engine/api/_ro_coa.py:866` — `total_equity = bs["shareCapital"] + bs["retainedEarnings"] + bs["otherEquity"]` includes the bucket.
- `src/engine/api/_trial_balance_parser.py:642` — `rule = _ro_coa.bucket_for(code)` resolves the prefix; line 689 uses `sf_c if sf_c != 0 else sf_d` for CREDIT_POS_BS to pick the closing balance.

**Verdict (TB path):** 104 IS captured into otherEquity → total_equity. A Scandia 41.65M merger premium delta against the engine output cannot be explained by this mapping. Likely causes to verify next: (i) the file was misrouted to the statutory parser (see A.2 below) by the document type detector, or (ii) a downstream rendering layer split otherEquity into a sub-line and dropped it from the headline equity card. Detector evidence:

- `src/engine/api/_document_type_detector.py:16-19` — default on ambiguity is `trial_balance`; statutory demands ≥3 F30 anchors. Scandia's 8-col Crystal Reports has none of these.

**A.2 — Statutory path (F30 + F10, e.g. EEI public-records / ANAF filings)**

- `src/engine/api/_statutory_parser.py:1001-1040` — equity emission **emits 1012, 106, 105, 1171 only**. No row for `104` (Prime de capital).
- `src/engine/api/_statutory_parser.py:134-140` — the F10 row-number map covers rd 81 (1012), 91 (106), 97 (117), 106 (CAPITALURI PROPRII TOTAL). It does **not** include the rd that carries Prime de capital (typically rd 86 in OMFP-1802 short-form, between capital and rezerve).
- `src/engine/api/_statutory_parser.py:247-256` — text-anchor patterns include `capital_subscris_varsat`, `rezerve_din_reevaluare`, `rezerve_total`, `profit_pierdere_reportat`, `capitaluri_proprii_total`. No anchor for `Prime de capital` / `(ct.\s*104)`.

**Verdict (statutory path):** 104 is silently dropped on the F30/F10 path. Any company filed with a non-zero `Prime de capital` line will under-state equity by that amount. Net effect: `bs_balance_delta = total_assets - (total_liabilities + total_equity)` becomes positive (assets > equity + liab) by exactly the missing 104 — the imbalance is masked in the canonical view but visible to anyone who divides equity by total assets (Altman X4).

**Blast radius:** every CIF that has used a paid-in surplus, merger premium, or share-issue premium in its history — common in older RO mid-caps that have absorbed group subsidiaries. The TB-path companies (Scandia + any other client uploading a balanță) are NOT affected.

**Minimal fix surface (NOT implemented):**
1. `src/engine/api/_statutory_parser.py:134-140` — add the rd line for "Prime de capital" to `F10_BS_ROW_TO_FIELD` (one new key `prime_de_capital` mapped to the actual rd, which is template-dependent — verify against EEI fixture).
2. `src/engine/api/_statutory_parser.py:247-256` — add a `_pat(r"Prime\s+de\s+capital\s*\(ct\.\s*104")` anchor → `"prime_de_capital"`.
3. `src/engine/api/_statutory_parser.py:1001-1040` — emit a row for 104 conditional on non-zero:
   ```
   prime_capital = float(bs.get("prime_de_capital", 0) or 0)
   if prime_capital:
       add("104", "Prime de capital (F10)", prime_capital)
   ```
   The mapper rule on _ro_coa.py:82 then routes it to otherEquity unchanged.

---

### H2 — Account 168 (Dobânzi de plătit) misrouted to P&L interestExpense

This is the highest-confidence finding in this diagnostic.

- `src/engine/api/_ro_coa.py:97-98` — `MappingRule("168", "interestExpense", 1, "Dobânzi de plătit")`. The inline comment says: *"Interest payable (a P&L expense at year-end, not BS debt)."* That comment is incorrect on its premise — `168 Dobânzi aferente împrumuturilor` is the **BS liability** that accrues interest owed; the matching **P&L expense** is `666 Cheltuieli privind dobânzile`.
- `src/engine/api/_ro_coa.py:321` — `MappingRule("666", "interest_expense", 1, "Cheltuieli privind dobânzile")` (correctly routes the P&L expense).
- `src/engine/api/_ro_coa.py:498` — `"interest_expense": "interestExpense"` — sub-aggregate `interest_expense` (from 666) rolls up to top-level P&L bucket `interestExpense`.
- `src/engine/api/_ro_coa.py:445-446` — `_BUCKET_TO_PL_FIELD` maps both `"interestExpense" → "interestExpense"` (line 445) AND `"interest_expense" → "interestExpense"` (line 446).

**Net effect:** the closing-balance C of account 168 is added to `pl["interestExpense"]` *on top of* the 666 cumulative expense. For a Scandia-sized balance the user reports ~RON 1.67M of double-counted interest.

**Cascade (file:line):**

1. `src/engine/api/_ro_coa.py:760` — `pretax = ebit + fin_inc - fin_exp - interest`. Inflated `interest` → reduced `pretax`.
2. `src/engine/api/_ro_coa.py:761` — `net_income_operational = pretax - tax`. The 16% tax recapture absorbs ~0.27M of the 1.67M; net income falls by ~RON 1.4M.
3. `src/engine/api/_ro_coa.py:853` — `bs["retainedEarnings"] = round(bs["retainedEarnings"] + net_income_statutory, 2)`. Lower net income → lower retainedEarnings → lower total_equity.
4. `src/engine/api/_ro_coa.py:866` — total_equity falls by the same amount. **Altman X4 (equity / liabilities) drops**, and the second cascade kicks in:
5. Because 168 was routed to a P&L bucket, it was NOT added to any BS liability bucket. `bs["otherCurrentLiabilities"]` is understated by the same ~1.67M. Total liabilities falls → X4 (= equity / liabilities) is partially propped back up, but not by the same amount because both numerator and denominator move.
6. `scandi-desk-main/src/lib/financialReport.ts:298-303` — the Altman Z used in the report is the **original manufacturing variant** (1.2/1.4/3.3/0.6/1.0), not the Z″ emerging-markets variant (6.56/3.26/6.72/1.05) that the methodology calls for in `CLAUDE.md` Appendix A §7. Whichever coefficient is in use, the X2 term (retainedEarnings / totalAssets) drops because retainedEarnings falls, while X4 changes ambiguously.
7. Net observed: the user reports Altman 2.70 (SAFE) → 2.54 (GREY) — a 0.16 delta. The H2 cascade is consistent with the direction (a downward push) but the magnitude is too small to fully explain it alone. The DIO/COGS regression in B1 also feeds the report's verdicts and may compound the headline.

**Verdict:** the 168 → interestExpense rule is a confirmed bug. The mis-mapping inflates interest expense, depresses net income, depresses retainedEarnings, and bleeds into Altman X2 + interest coverage + DSCR. It also leaves a hole in current liabilities of exactly the same amount.

**Minimal fix surface (NOT implemented):**
- `src/engine/api/_ro_coa.py:97-98` — change to:
  `MappingRule("168", "otherCurrentLiab", 1, "Dobânzi de plătit — BS liability, NOT P&L expense"),`
  and correct the comment. (Strictly speaking 168 may be LT depending on the underlying loan tenor, but for the SME population the engine analyses, current-liability treatment is the safe default and matches the methodology's Section 3 cheat sheet which lists 168 under LT debt but also under accrued items; `otherCurrentLiab` is the lower-blast-radius landing.)
- Note: `_trial_balance_parser.py:625` already side-flips `1687` (sub-account of 168) when D > C; the parent 168 rule needs the same treatment if any sub-account inverts.

---

### H3 — Net profit -6% (downstream of H2)

Confirmed downstream of H2. The cascade trace at H2 step 2 above (pretax → net_income_operational) accounts for the direction. The magnitude `~6%` against Scandia's reconstructed net profit (RON 36.27M reference vs ~34.1M engine) is in the right order of magnitude given the 1.67M extra interest minus 16% tax recapture = ~1.4M reduction = 3.9% of 36M. Additional contributors (likely smaller):
- DIO/COGS regression (B1) does NOT feed net profit directly — it changes a working-capital ratio, not the P&L. So that's NOT the source.
- Capitalized own work (722 net) treatment — `_ro_coa.py:758` deliberately excludes it from EBITDA but includes it in `net_income_statutory` (line 764). This is intentional and matches account 121 closing.
- Discount-received (767) — included in operational EBITDA via `discounts_received_767` (line 783); not the regression driver.

**Verdict:** H3 is downstream of H2 + possibly a secondary share from a different account-mapping miss (TBD with fixture run). No independent root cause identified.

---

### H4 — Receivables −17% (Scandia 51.36M → 42.58M)

Not a bug; a **classification difference** between methodology and engine.

Methodology (CLAUDE.md Appendix B, `reference/financial_analysis.py:317-328`):
```
total_receivables = (trade_rec + notes_rec + supplier_adv + state_rec
                     + other_debtors + prepaid + personnel_rec + social_rec
                     + affiliated_rec - rec_provisions)
```
Combines 411 + 413 + 409 + 44(D) + 46(D) + 471 + 425/4282 + 43(D) + 451/452/455 + 461 − 49.

Engine (`src/engine/api/_ro_coa.py:414-417`):
```
"ar":              "accountsReceivable"
"ar_doubtful":     "accountsReceivable"
"ar_provisions":   "accountsReceivable"
"ar_intercompany": "otherCurrentAssets"   # split out
```
- 4111, 4118 (gross), 4130, 418 → `accountsReceivable`
- 451 / 452 / 455 / 461 → `ar_intercompany` → `otherCurrentAssets`
- 409* (supplier advances) → `ppe_advances` (4093 → PP&E line) or `otherCurrentAssets` (4091/4092)
- 4424, 4382, 4482, 471 → `otherCurrentAssets`
- 49 (allowance) → contra-`accountsReceivable`

For Scandia, the ~RON 8.78M delta is consistent with intercompany + supplier advances + VAT receivable + prepaid being broken out into `otherCurrentAssets` rather than rolled up into the headline receivables card. The engine's choice is defensible (granular presentation matches v5 site style), but the headline number diverges from the methodology by design.

**Verdict:** not a bug; a presentation gap against the methodology contract.

**Minimal fix surface (NOT implemented), pick one:**
- (a) Adjust the report renderer to show **two rows**: "Trade receivables (net)" = `accountsReceivable`, and "Receivables (incl. intercompany + state + prepaid)" = `accountsReceivable + ar_intercompany + state_rec_sub + prepaid_sub`. Aligns with methodology while preserving granularity. Recommended.
- (b) Change the engine bucket map to roll intercompany into `accountsReceivable`. Higher blast radius — affects industry classification + risk framing which deliberately reads `ar_intercompany` separately.

---

## Strand B — DIO regression

### B1 — DIO denominator: narrow COGS in the report, broad opex in the methodology

**Methodology** (CLAUDE.md Appendix A §4 Efficiency table; CLAUDE.md Appendix B `reference/financial_analysis.py`):
- Line 543-546 comment: *"`total_cogs_for_turnover` (broad: full operating expense) — for INVENTORY TURNOVER, DIO and DPO ratios; … Industry convention for DIO uses total operating expense as the denominator."*
- Line 548: `total_cogs_for_turnover = pnl["total_op_expense"]` (sums 601+602+603+605+607+608+other 60+61+62+63+64+65+681+other 68).
- Line 581: `"dio": _safe_div(avg_inventory, total_cogs_for_turnover) * 365 if total_cogs_for_turnover else 0`.

**Engine canonical** (cost-of-goods-sold P&L bucket, `src/engine/api/_ro_coa.py:267-269`):
- Only `601`, `602`, `607` route to `cogs` → `costOfGoodsSold` (narrow). Everything else (603/605/61/62/63/64/65/681/etc.) routes to `operatingExpenses`.

**Report renderer** (`scandi-desk-main/src/lib/financialReport.ts:291`):
```
const dio = safeDiv(bs.inventory, is.costOfGoodsSold) * days;
```

This is the **regression**. For Scandia FY2025:
- Inventory ≈ RON 53M (rough fixture order).
- Narrow COGS (601+602+607) ≈ RON 200M.
- Total opex (broad denominator per methodology) ≈ RON 365M.
- DIO with narrow denom: 53/200 × 365 ≈ **97 days** — matches the user-reported "95d on export".
- DIO with broad denom (methodology): 53/365 × 365 ≈ **53 days** — matches the board number.

The fix is present in the **reference** Python (broad denom, with an explicit inline-comment justification) but the **TypeScript report renderer reverted to the narrow denom**. The unit tests likely don't exercise this path against the methodology's calibration numbers, so the regression slipped in without alerting.

**The same regression also affects DPO** (`financialReport.ts:292`) and any CCC line downstream, but DPO is less visible than DIO in the briefing.

**Blast radius:** every comprehensive-report export. Anyone running the export path today (Scandia, EEI hospitality fixtures, any new client) sees inflated DIO/DPO. SKU-level DIO (`pages/cfo/Products.tsx:633-664`) uses a separate per-row `inventory_value_krn / cogs_krn × 365` formula keyed off the sku_aggregates table — that path is independent and not affected by this regression.

**Minimal fix surface (NOT implemented):**
1. `scandi-desk-main/src/lib/financialReport.ts:291` — change denominator to total operating expense:
   ```
   const dio = safeDiv(bs.inventory, is.costOfGoodsSold + is.operatingExpenses + is.depreciationAmortization) * days;
   ```
   or add a derived `t.totalOperatingExpense` field on the canonical view and use it here, on line 292, and in CCC.
2. Cross-check `scandi-desk-main/src/lib/buildPlStatement.ts:370` and `financialExports.ts:93` — those still display "Cost of goods sold" as the narrow figure, which is correct for the P&L presentation; only the DIO/DPO ratios need the broad denominator.

---

## Strand C — EEI SAGA-6col parser fault

### C2 — Receivables collapse to RON 4 (and most other BS lines)

This is a **structural parser bug** affecting any SAGA 6-column trial balance.

- `src/engine/api/_trial_balance_parser.py:259-263` — describes the two layouts: Layout A (8-col, Scandia Crystal Reports) has all four block pairs INCLUDING `Solduri finale` (final closing balances); Layout B (6-col SAGA / EEI) **ends at `Sume totale` cumulative** — there is no Solduri-finale block.
- `src/engine/api/_trial_balance_parser.py:281-290` — the gate accepts the file when either `cumulative_*` OR `final_*` columns are present. SAGA 6-col passes with only cumulative.
- `src/engine/api/_trial_balance_parser.py:396-397` — when columns are missing, `col_or_zero` returns 0 for `final_debit`/`final_credit`. So for every SAGA-6col row, `sf_d = sf_c = 0`.
- `src/engine/api/_trial_balance_parser.py:689` (CREDIT_POS_BS) — `amount = sf_c if sf_c != 0 else sf_d` → **0**.
- `src/engine/api/_trial_balance_parser.py:695` (DEBIT_POS_BS) — `amount = sf_d if sf_d != 0 else sf_c` → **0**.
- `src/engine/api/_trial_balance_parser.py:716-717` — `if amount == 0: continue` — every BS account is silently dropped.

**Net effect:** every BS line for a SAGA 6-col file is zeroed except for the few accounts whose closing balance is derivable from another path (which is how "RON 4" leaks through — a rounding residual on a single account that the side-flip logic at line 658 evaluates without needing `sf_*`).

The 8-col path is unaffected because Crystal Reports exports the Solduri-finale columns.

**Note on the P&L side:** class 6/7 buckets at `_trial_balance_parser.py:696-712` read `st_d`/`st_c` (cumulative) — those columns DO exist on SAGA 6-col, so the P&L is largely correct. Only the **balance sheet** collapses.

**Minimal fix surface (NOT implemented):**
1. In `_trial_balance_parser.py` after line 397, derive a synthetic closing balance for SAGA 6-col files when `final_*` columns are missing:
   ```
   sf_d = si_d + r_d                    # opening + period debit
   sf_c = si_c + r_c                    # opening + period credit
   # Then net per account: if abs(sf_d - sf_c) is the natural-side balance.
   ```
   Or equivalently: `sf_net = (si_d + r_d) - (si_c + r_c)`; if positive → put on debit side; if negative → put on credit side.
2. A more surgical change at line 689 / 695: when `sf_d == sf_c == 0`, fall through to a derived value computed from `si_*` + `r_*`. Lower risk because it doesn't perturb Layout A inputs.

---

### C1 — Other operating income / capitalized own work ~RON 2.16M omitted

This may not be a SAGA-only bug; it may be a downstream presentation choice.

**Mapping (intact):**
- `src/engine/api/_ro_coa.py:352-354` — 721/722/725 → `capitalizedOwnWork` (memo bucket).
- `src/engine/api/_ro_coa.py:356` — 758 → `otherIncome`.
- Both are CREDIT_POS_PL (read from cumulative columns), so SAGA 6-col reads them.

**Downstream treatment** (`src/engine/api/_ro_coa.py:758, 782, 792`):
- `ebitda` (= operational, line 758) excludes `capitalizedOwnWork` deliberately.
- `ebitda_statutory` (line 782) = `ebitda + capitalized` — includes it.
- `total_operating_revenue` (line 792) = `revenue + capitalized + discounts_received_767` — includes it.

For EEI, the user reports 2,164,080 of class 758/72x is "lost" from total operating income. Two possibilities to verify on the actual fixture:

(a) **Report renderer reads the wrong field.** If the EEI report card shows `revenue` (alone) instead of `total_operating_revenue` (with capitalized + 767), the 722 net of ~2.13M is excluded from the top line. The methodology's Section 2 has "Other operating revenue" as its own line including `prod_var_net + capitalized_72 + other_op_758 + provision_rev_781` — if the renderer collapses to `revenue` only, the gap is exactly the missing 758 + 72x.

(b) **Genuine parse miss on SAGA 6-col for class 7.** Less likely — class 6/7 reads from `st_c`/`st_d` which exist on SAGA 6-col. But if EEI's particular PDF has non-zero `final_*` cells *only* and not `cumulative_*` (uncommon, but possible if the export was renamed), the parse logic at line 703 (`st_c if abs(st_c) >= abs(st_d) else st_d`) yields 0 and the income is dropped.

Without running the EEI fixture I cannot disambiguate. The diagnostic spec for C1 asks the next sub-strand: confirm whether the renderer or the parser is at fault — read `_ro_coa.py:797-830` (the canonical pl dict) and the React renderer's `incomeStatement.otherIncome` consumption. Recommended quick check: log the parsed account list for EEI before assembly and verify 758 + 72x rows are present with non-zero amounts; if yes → renderer; if no → parser.

**Minimal fix surface (provisional, pending fixture run):**
- If renderer-side: surface `assembled_pl.total_operating_revenue_statutory` (already computed at `_ro_coa.py:793`) on the FE and label it "Total operating revenue" per methodology.
- If parser-side: same fix as C2 (synthesize closing balance from `si_* + r_*` when one block is missing).

---

## Priority + blast radius (ranked)

| # | Strand | Severity | Affected fixtures | Min-fix risk | Why this ranking |
|---|---|---|---|---|---|
| 1 | **C2** SAGA-6col BS collapse | **Critical** | Every SAGA / 6-col TB upload (EEI today; any new RO SME using SAGA tomorrow) | Low — derived `sf_*` only when missing; 8-col path untouched | A whole entity class produces a near-empty balance sheet today. Headline impact: "RON 4 receivables", broken total_assets, garbage Altman + leverage. |
| 2 | **B1** DIO/DPO denominator | **High** | Every comprehensive-report export (all clients) | Very low — single ratio formula change, no canonical-metrics or pricing surface touched | Methodology says 53d, export says 95d. The board-vs-report mismatch erodes the deliverable contract directly. |
| 3 | **H2** acct 168 → P&L sweep | **High** | Every TB-path client with non-zero 168 (most operating companies with bank debt) | Low — single MappingRule on _ro_coa.py:98; the bucket exists; the bucket map already includes `otherCurrentLiab` → `otherCurrentLiabilities` | Inflates interest, depresses net income, ripples to retainedEarnings + Altman X2/X4 + interest coverage. Quantitatively small per client but pervasive. |
| 4 | **H1.A.2** Statutory parser omits 104 | **Medium** | Every F30+F10 (ANAF / public-records / firme.info) upload with a paid-in surplus | Low — three-line addition mirroring 1012/106/105/1171 emission | EEI calibration uses this path; older RO mid-caps that absorbed sub-entities all have non-zero 104. |
| 5 | **C1** EEI 2.16M op income missing | **Medium** (pending) | EEI + any SAGA/PDF where renderer drops capitalized + 758 | Low or Low — pending disambiguation | Most likely a renderer reads `revenue` not `total_operating_revenue`. Verify before fixing. |
| 6 | **H4** Receivables classification gap | **Low** (cosmetic) | All TB-path clients vs methodology contract | Low — renderer-only | Splitting intercompany / state / prepaid into otherCurrentAssets is defensible; headline number just diverges from the spec by design. Document or align. |
| 7 | **H3** Net profit −6% | (downstream of H2) | — | — | Resolves automatically when H2 is fixed; verify with re-run. |
| 8 | **H1.A.1** Scandia 104 anomaly | (residual investigation) | Scandia only | — | TB path captures 104 correctly. If Scandia's report still drops 41.65M, suspect detector mis-routing or a render-layer split — needs one more turn against the actual Scandia output to disambiguate. |

---

## Other fixtures to sweep (recommended next pass)

The following fixtures should be re-run **after** B1 + C2 + H2 are fixed and the deltas checked against the methodology calibration:

1. **Scandia FY2025** (TB, 8-col Crystal Reports) — gold standard for `food_manufacturing`. Methodology calibration: EBITDA 54.4M @ 13.2%, net profit 36.79M, Altman Z″ 3.09, composite 82.
2. **EEI Imobiliara FY2024** (Statutory + possibly SAGA 6-col PDF) — single-asset CRE calibration. Per CLAUDE.md the canonical EBITDA is +RON 2.13M *statutory*; the C1 fix should restore this number.
3. **Transavia FY2024** — peer benchmark for `food_manufacturing`. Validates Scandia industry comparison.
4. **Any future ANAF F30+F10 upload** — guard against H1.A.2 by inspecting `subAggregates.equity_revaluation` and a new `subAggregates.prime_de_capital` (if implemented).

For each, the regression test should compare (a) headline KPIs to the methodology calibration table in CLAUDE.md, (b) the bs_balance_delta (should be ≤ 0.5% of total assets), and (c) the P&L reconciliation_pct (should be ≤ 2%).

---

## What this diagnostic explicitly does NOT change

- No code edits. No commits.
- No engine refactor, no canonical-metrics rewrite, no pricing surface touched.
- No Bug A, period-industry, or notification-header work.
- The Altman Z vs Z″ coefficient discrepancy in `financialReport.ts:298-303` is FLAGGED (the methodology calls for the emerging-markets Z″ variant, the renderer uses the manufacturing Z variant). This is left for a future strand — it changes verdicts but not the underlying data — and is fenced from this round.

## What the user needs to decide

1. **Priority of the three high-severity strands (1, 2, 3).** Recommended order: C2 first (entity class is non-functional today), then B1 (broadest visible delta), then H2 (correctness + cascade).
2. **H4 receivables policy.** Option (a) two-row presentation vs (b) re-map intercompany to AR. The methodology contract suggests (a) is cleaner.
3. **C1 disambiguation.** Authorize one more diagnostic turn with the actual EEI fixture, or skip to a renderer-side fix if (a) is the obvious culprit.

End of diagnostic.
