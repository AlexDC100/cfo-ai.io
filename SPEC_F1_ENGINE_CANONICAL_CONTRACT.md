# Spec F1 — Extended Engine Canonical Contract

> **Read-only specification. NO code changes. NO implementation.**
> Deliverable for F1 ("lock the contract") in [AUDIT_FE_CANONICAL_CONFORMANCE.md](AUDIT_FE_CANONICAL_CONFORMANCE.md). Resolves open question 1 in favor of **extend the engine to emit every value the FE displays** — and answers open questions 2 (statutory/canonical end-to-end) and 3 (periodFacts becomes a reader) by implication.
> Outcome of this doc: a single review surface listing every field the engine must add to `assembled_*` / `calculated_metrics`, with the per-field source-account derivation, so the 9 Tier-1 FE recompute sites can become pure renderers in F3.
> Variant decision already made (engine always-Z″ is correct for Romanian SME market — see [DIAGNOSTIC_ALTMAN_CREDIT_VERDICT.md](DIAGNOSTIC_ALTMAN_CREDIT_VERDICT.md) + variant audit). Composite weight decision: keep the engine's 30/20/15/10/10/10/5 (the FE's 40/20/15/10/10/5 is the one being retired).

---

## 0. Scope rules

1. **Every number the user sees originates on the engine.** The FE adds no arithmetic — only formatting, labels, sort order, conditional styling, and verdict-band lookup against an engine-emitted threshold.
2. **One field, one source.** No fallback chains. If a field is null, the FE renders an explicit "—" or "not available" state — never falls through to a recompute.
3. **Statutory view is canonical.** Every EBITDA / net-profit / margin / ratio is calculated against the statutory (account-121-anchored) view. The "cash view" (722-excluded) is exposed as a parallel field where the bridge is needed (valuation), never as the default.
4. **Variant locked.** Altman is Z″ (1995 EM) for every entity in the Romanian SME book. Composite credit weights are 30/20/15/10/10/10/5.
5. **Source-account derivation must be explicit per field.** Every new field below lists the RAS accounts and the canonical buckets it sums from. No "engine-internal computation" placeholders.

---

## 1. Envelopes on the `/api/period/{id}` response (the contract surface)

Four shapes, all already present today; this spec extends them.

| Envelope | Purpose | Current shape | Extension this spec defines |
|---|---|---|---|
| `assembled_pl` | Flat P&L canonical subtotals | `revenue`, `ebitda_statutory`, `ebitda_cash`, `operating_ebit`, `pretax`, `net_income_statutory`, `total_operating_revenue`, `capitalized_own_work_memo`, `inventory_variation_memo`, `depreciation`, `interest_expense` | + per-class breakdowns needed for ratios (`gross_profit`, `total_operating_expense`, `cost_of_goods_sold`, `total_other_income_758_781`, `cash_from_operating_proxy`) |
| `assembled_bs` | Flat BS canonical subtotals | `total_assets`, `total_liabilities`, `total_equity`, `total_debt`, `current_year_pnl`, `bs_balance_delta` | + every grouping needed for ratios (`total_current_assets`, `total_current_liabilities`, `total_non_current_assets`, `total_non_current_liabilities`, `accounts_receivable`, `inventory`, `cash`, `accounts_payable`, `short_term_debt`, `long_term_debt`, `share_capital`, `retained_earnings`, `other_equity`) |
| `assembled_cf` | Flat CF canonical subtotals | `cash_from_operating` | + `cash_from_investing`, `cash_from_financing`, `net_change_in_cash`, `free_cash_flow`, `capex_total`, `working_capital_change` |
| `calculated_metrics[]` | Named ratio + score rows | ~25 rows today (revenue, EBITDA, margins, current/debt/IC ratios, Altman X1–4, composite, sub-scores) | + every ratio in §3 below, every Piotroski check in §5, every band threshold in §7 |
| **NEW: `assembled_metrics`** | Single bundled object for the FE | — | Wraps `calculated_metrics` rows as a typed object so the FE doesn't have to look up by name. See §8. |

The `assembled_metrics` envelope is new and is the single source the FE reads from in F3. Internally it is derived from the same row inserts to `calculated_metrics` (no parallel store, no drift).

---

## 2. What the engine emits today (baseline — already in pipeline.py)

For reference. None of these change; they are listed so the new fields in §3 don't accidentally duplicate.

### 2.1 `calculated_metrics` rows present today

P&L canonical:
- `revenue`, `gross_profit`, `ebitda`, `ebitda_cash`, `ebitda_statutory`, `operating_profit`, `net_income`, `net_income_operational`, `net_income_statutory`, `total_operating_revenue`, `capitalized_own_work_memo`, `inventory_variation_memo`, `free_cash_flow` (= net_income + depreciation — proxy, not real CF)
- `gross_margin`, `ebitda_margin`, `net_margin`

BS canonical:
- `total_assets`, `total_debt`, `total_equity`, `cash`

Ratios:
- `current_ratio`, `debt_to_equity`, `debt_to_ebitda`, `interest_coverage`, `roa`, `roe`, `roic`

Credit:
- `altman_z_score`, `altman_x1`, `altman_x2`, `altman_x3`, `altman_x4`
- `credit_composite`, `credit_subscore_altman`, `credit_subscore_profitability`, `credit_subscore_leverage`, `credit_subscore_coverage`, `credit_subscore_dscr`, `credit_subscore_liquidity`, `credit_subscore_equity`

### 2.2 `assembled_bs` fields present today

`total_assets`, `total_liabilities`, `total_equity`, `bs_balance_delta`, `current_year_pnl`.

### 2.3 `assembled_pl` fields present today

Per the canonical-metrics module's consumption: `revenue`, `ebitda_statutory`, `ebitda_cash`, `operating_ebit`, `pretax`, `net_income_statutory`, `total_operating_revenue`, `capitalized_own_work_memo`, `inventory_variation_memo`, `depreciation`, `interest_expense`.

### 2.4 `assembled_cf` fields present today

`cash_from_operating` (when the cash-flow path is enabled).

---

## 3. New `calculated_metrics` rows (the gap to close)

Every row below must be emitted by `stage_compute` in `pipeline.py`. **Formulas use canonical totals only — never raw line items in the FE.**

### 3.1 Liquidity ratios

| Field | Formula | Source canonical fields | Unit | Direction |
|---|---|---|---|---|
| **`quick_ratio`** | `(cash + accounts_receivable) / total_current_liabilities` | `assembled_bs.cash`, `assembled_bs.accounts_receivable`, `assembled_bs.total_current_liabilities` | ratio | higher |
| **`cash_ratio`** | `cash / total_current_liabilities` | `assembled_bs.cash`, `assembled_bs.total_current_liabilities` | ratio | higher |
| **`working_capital`** | `total_current_assets − total_current_liabilities` | `assembled_bs.total_current_assets`, `assembled_bs.total_current_liabilities` | RON | higher |
| **`net_debt`** | `total_debt − cash` | `assembled_bs.total_debt`, `assembled_bs.cash` | RON | lower |
| **`net_debt_to_ebitda`** | `net_debt / ebitda_statutory` | `net_debt`, `assembled_pl.ebitda_statutory` | ratio | lower |

### 3.2 Leverage / solvency

| Field | Formula | Source canonical fields | Unit | Direction |
|---|---|---|---|---|
| **`equity_ratio`** | `total_equity / total_assets` | `assembled_bs.total_equity`, `assembled_bs.total_assets` | ratio | higher |
| **`debt_to_assets`** | `total_debt / total_assets` | `assembled_bs.total_debt`, `assembled_bs.total_assets` | ratio | lower |
| **`lt_debt_to_equity`** | `long_term_debt / total_equity` | `assembled_bs.long_term_debt`, `assembled_bs.total_equity` | ratio | lower |
| **`loan_to_value`** | `total_debt / property_market_value` if `property_market_value` is supplied in the period's `supplementary`, else equals `debt_to_assets`. | `assembled_bs.total_debt`, `supplementary.property_market_value`, `assembled_bs.total_assets` (fallback) | ratio | lower |

### 3.3 Coverage

| Field | Formula | Source canonical fields | Unit | Direction |
|---|---|---|---|---|
| **`ebitda_to_interest`** | `ebitda_statutory / interest_expense` | `assembled_pl.ebitda_statutory`, `assembled_pl.interest_expense` | ratio | higher |
| **`dscr`** | `ebitda_statutory / (interest_expense + short_term_debt)` | `assembled_pl.ebitda_statutory`, `assembled_pl.interest_expense`, `assembled_bs.short_term_debt` | ratio | higher |
| **`dscr_with_lt_principal`** | `ebitda_statutory / (interest_expense + long_term_debt / 8)` — methodology-spec 8-year amortization proxy | `assembled_pl.ebitda_statutory`, `assembled_pl.interest_expense`, `assembled_bs.long_term_debt` | ratio | higher |
| **`adjusted_dscr_incl_lease`** | `(ebitda_statutory + annual_lease_expense) / (interest_expense + short_term_debt + annual_lease_expense)` when `supplementary.annual_lease_expense` present, else equals `dscr`. | `assembled_pl.ebitda_statutory`, `supplementary.annual_lease_expense`, `interest_expense`, `short_term_debt` | ratio | higher |

### 3.4 Efficiency

For DIO/DPO the **denominator is total operating expense, not narrow COGS** — per the calibration discipline already locked in [CLOSURE_B1_DIO_DENOMINATOR.md](CLOSURE_B1_DIO_DENOMINATOR.md).

| Field | Formula | Source canonical fields | Unit | Direction |
|---|---|---|---|---|
| **`asset_turnover`** | `revenue / total_assets` | `assembled_pl.revenue` (i.e. net turnover, class 70 less 709), `assembled_bs.total_assets` | ratio | higher |
| **`dso`** | `accounts_receivable / revenue × period_days` (default 365) | `assembled_bs.accounts_receivable`, `assembled_pl.revenue`, `supplementary.period_days` | days | lower |
| **`dio`** | `inventory / total_operating_expense × period_days` | `assembled_bs.inventory`, `assembled_pl.total_operating_expense`, `supplementary.period_days` | days | lower |
| **`dpo`** | `accounts_payable / total_operating_expense × period_days` | `assembled_bs.accounts_payable`, `assembled_pl.total_operating_expense`, `supplementary.period_days` | days | higher (within terms) |
| **`ccc`** | `dso + dio − dpo` | the three above | days | lower |
| **`inventory_turnover`** | `total_operating_expense / inventory` | as above | times/year | higher |

`total_operating_expense` = sum of class 6 expenses excluding financial (66x) and income tax (69x). To be added to `assembled_pl` (see §4 below).

### 3.5 Margin breakdowns (already partially emitted, finishing the set)

| Field | Formula | Notes |
|---|---|---|
| **`gross_margin`** ✓ already emitted | `gross_profit / revenue` | keep |
| **`ebitda_margin`** ✓ already emitted | `ebitda_statutory / revenue` — **switch the source from `ebitda` to `ebitda_statutory`** to match the variant decision (statutory canonical) | breaking change, but consistent with §0 rule 3 |
| **`net_margin`** ✓ already emitted | `net_income_statutory / revenue` — **switch source from `net_income` to `net_income_statutory`** | breaking change, same reason |
| **`operating_margin`** new | `operating_ebit / revenue` | new |
| **`core_ebitda_margin`** new | `core_ebitda / revenue` — where `core_ebitda = ebitda_statutory − account_758 − account_781` (the canonical-metrics bridge) | new |

The two "breaking change" switches above need the **migration note** flagged in §10 — every cached `calculated_metrics` row from before the cut needs to be invalidated, or the FE must namespace the new names. Default: invalidate per-period cache on the next /api/period read post-deploy.

---

## 4. New `assembled_pl` fields

To unlock the ratios above without the FE doing arithmetic, `assembled_pl` adds:

| Field | Definition | Source RAS accounts |
|---|---|---|
| **`gross_profit`** | `revenue − cost_of_goods_sold` | revenue per class 70 net of 709; COGS per accounts 601 + 602 + 607 + 608 (raw mat, consumables, merchandise cost, packaging). For services-heavy entities where 707 is empty, COGS = 0 and gross_profit = revenue. |
| **`cost_of_goods_sold`** | Per above | 601, 602, 607, 608 |
| **`total_operating_expense`** | All class 6 less 66x (financial) and 69x (tax) | 60x + 61x + 62x + 63x + 64x + 65x + 68x |
| **`opex_excluding_cogs_and_da`** | `total_operating_expense − cost_of_goods_sold − depreciation` | derived |
| **`other_income_758`** | Sum of class 758 only | 758 |
| **`other_income_781_reversals`** | Sum of class 781 (provision reversals) | 781 |
| **`core_ebitda`** | `ebitda_statutory − other_income_758 − other_income_781_reversals` (the canonical-metrics bridge) | derived |
| **`net_financial_result`** | `financial_income − financial_expense` | classes 76x (income), 66x (expense — incl. interest) |
| **`financial_income`** | Sum of class 76x | 761 (dividends), 765 (FX gain), 766 (interest income), 767 (discounts received), 768 (other) |
| **`financial_expense_total`** | Sum of class 66x | 665 (FX loss), 666 (interest exp), 667 (discounts paid), 668 (other) |
| **`income_tax`** | Sum of class 69x | 691, 698 |
| **`free_cash_flow_proxy`** | `net_income_statutory + depreciation` — flagged as proxy in the metric `direction: neutral` and the FE labels it "indirect approximation" | derived |

---

## 5. New `assembled_bs` fields

For every ratio that touches a sub-aggregate of the BS:

| Field | Definition | Source RAS accounts |
|---|---|---|
| **`cash`** ✓ via current emit, lift to envelope | Sum cash + equivalents | 5121, 5124, 5125, 5128, 5311, 5314, 5328 (cash equivalents) |
| **`accounts_receivable`** | Net trade receivables | 4111 less 491 (allowances) — closing debit balance |
| **`inventory`** | Net inventory | 301, 302, 303, 308, 31x, 32x, 33x, 34x, 35x, 36x, 37x, 38x, 39x (provisions, contra) |
| **`other_current_assets`** | Prepayments, short-term advances, recoverable taxes | 4091 (supplier advances), 411 excl. 4111, 442x debit (VAT recoverable), 461 (advances), 471 (prepayments) |
| **`total_current_assets`** | `cash + accounts_receivable + inventory + other_current_assets` | derived |
| **`property_plant_equipment`** | Net PP&E | 21x gross less 28x accumulated depreciation |
| **`intangibles`** | Net intangibles | 20x gross less 280 accumulated amortization |
| **`other_non_current_assets`** | Financial assets, LT investments, LT receivables | 26x (financial fixed assets), 267 (LT receivables) |
| **`total_non_current_assets`** | `property_plant_equipment + intangibles + other_non_current_assets` | derived |
| **`accounts_payable`** | Trade payables | 401, 403, 404, 408 (closing credit balance) |
| **`short_term_debt`** | Short-term bank credit | 519 (short-term bank loans), 5191 (line of credit) |
| **`other_current_liabilities`** | Wages, social charges, VAT payable, customer advances, tax payable | 421, 423, 425, 427, 428, 43x (social), 441 (income tax payable), 442x credit (VAT), 446, 447, 462 (other creditors), 419 (customer advances) |
| **`total_current_liabilities`** | `accounts_payable + short_term_debt + other_current_liabilities` | derived |
| **`long_term_debt`** | LT bank loans + leasing + LT interest accrued | 1621, 1622, 167, 168 (interest accrued — H2 closure routes these correctly) |
| **`other_non_current_liabilities`** | LT provisions, subsidies, grants | 15x (provisions), 475 (subsidies), 478 (grants) |
| **`total_non_current_liabilities`** | `long_term_debt + other_non_current_liabilities` | derived |
| **`share_capital`** | Paid-in share capital | 1012 (paid-in only); 1011 (subscribed unpaid) excluded |
| **`retained_earnings`** | Carry-forward retained earnings + current-year statutory net profit | 117 (`1171` credit less `1174` debit) + `current_year_pnl` (already populated from 121) |
| **`other_equity`** | Share premium + revaluation + reserves + 104 merger premium | 104 (Prime de capital — **must include statutory-path fix from Strand A.2**), 105 (revaluation), 106x (reserves) |
| **`total_equity`** | `share_capital + retained_earnings + other_equity` | derived — must reconcile to `total_assets − total_liabilities` within `bs_balance_delta` tolerance |
| **`total_debt`** | `short_term_debt + long_term_debt` | derived |

> **Critical dependency**: the 104 (Prime de capital / merger premium) statutory-path leak in [DIAGNOSTIC_EQUITY_BS_INTEREST_DIO_SAGA.md](DIAGNOSTIC_EQUITY_BS_INTEREST_DIO_SAGA.md) Strand A.2 **must be fixed before** these BS fields land. Otherwise `other_equity` and downstream `total_equity` are wrong for every F30/F10-parsed entity. This is the Phase-0 prerequisite the roadmap names.

---

## 6. New `assembled_cf` fields (indirect-method canonical)

| Field | Definition |
|---|---|
| **`cash_from_operating`** ✓ exists | Net income + D&A + provisions movement + working capital changes |
| **`cash_from_investing`** | −capex − CIP additions − affiliate increases + dividends/interest received + disposal proceeds |
| **`cash_from_financing`** | ±ΔLT debt ±ΔST bank − interest paid − dividends paid + capital increases |
| **`net_change_in_cash`** | `cfo + cfi + cff` |
| **`capex_total`** | `−(Δ PP&E gross − D&A) − Δ CIP` |
| **`working_capital_change`** | `−(Δ inventory + Δ receivables) + Δ payables + Δ tax/social` |
| **`free_cash_flow`** | `cfo − capex_total` — the **proper** FCF (not `net_income + depreciation`) |
| **`is_approximated`** | `true` when no prior-period BS is available; the FE renders an explicit "indirect-approximation" badge | derived flag |

When prior-period data isn't on file, `is_approximated = true` and the FE renders the same honest "indirect approximation" disclosure that already exists.

---

## 7. Verdict bands as engine-emitted data, not FE constants

Per §0 rule 5, even the verdict thresholds (strong / healthy / watch / critical) must come from the engine. Today they are FE-hardcoded in `computeRatios`. The engine emits one **`metric_bands`** row per ratio:

```
{
  "name": "current_ratio_bands",
  "value": null,
  "unit": "bands",
  "direction": "higher",
  "bands": {"strong": 2.0, "healthy": 1.5, "watch": 1.0}
}
```

For ratios where lower is better (debt/EBITDA, debt/equity, debt/assets, LTV, DIO, DSO, CCC), `direction: "lower"` and the bands are read inverted by the renderer.

Industry-aware bands (e.g. equity ratio 30% healthy for general SMEs, but real estate uses 25%; DIO 60 days FMCG vs 90 days mfg) come from the `industry_benchmarks` catalog. The engine selects the right industry's band set based on the period's resolved CAEN and emits the band row for THIS period. **The FE renders verdicts by looking up the value against the emitted bands — no FE-side band literals.**

---

## 8. The new `assembled_metrics` envelope (single typed object)

To stop the FE from doing key lookups by string on `calculated_metrics[]`, the response includes a typed bundle:

```typescript
interface AssembledMetrics {
  pl: AssembledPL;
  bs: AssembledBS;
  cf: AssembledCF;

  ratios: {
    liquidity: { current_ratio: number; quick_ratio: number; cash_ratio: number; working_capital: number; net_debt: number; net_debt_to_ebitda: number; };
    leverage:  { equity_ratio: number; debt_to_assets: number; debt_to_equity: number; debt_to_ebitda: number; lt_debt_to_equity: number; loan_to_value: number; };
    coverage:  { interest_coverage: number; ebitda_to_interest: number; dscr: number; dscr_with_lt_principal: number; adjusted_dscr_incl_lease: number; };
    profitability: { gross_margin: number; operating_margin: number; ebitda_margin: number; core_ebitda_margin: number; net_margin: number; roa: number; roe: number; roic: number; };
    efficiency: { asset_turnover: number; dso: number; dio: number; dpo: number; ccc: number; inventory_turnover: number; };
  };

  bands: {
    [ratioKey: string]: { strong?: number; healthy?: number; watch?: number; critical?: number; direction: "higher" | "lower"; };
  };

  credit: {
    altman_z_score: number;
    altman_variant: "Z\"";                    // always Z" for the RO SME book
    altman_components: { x1: number; x2: number; x3: number; x4: number };
    altman_zone: "safe" | "grey" | "distress";
    composite_score: number;                  // 0-100
    composite_grade: "AAA" | "AA" | "A" | "BBB" | "BB" | "B" | "CCC" | "CC";
    composite_weights: {                      // surface them so the FE can render the breakdown
      altman: 0.30; profitability: 0.20; leverage: 0.15; coverage: 0.10; dscr: 0.10; liquidity: 0.10; equity: 0.05;
    };
    subscores: {
      altman: number; profitability: number; leverage: number;
      coverage: number; dscr: number; liquidity: number; equity: number;
    };
  };

  piotroski: {
    score: number;                            // 0-9
    has_prior_period: boolean;                // when false, score caps at the 4 checks that don't need prior data
    checks: Array<{
      key:
        | "ni_positive" | "roa_positive" | "cfo_positive" | "cfo_gt_ni"
        | "roa_improving" | "debt_declining" | "no_share_issuance"
        | "margin_improving" | "asset_turnover_improving";
      label: string;
      result: "pass" | "fail" | "uncertain";  // uncertain when prior data missing
      detail: string;                          // engine-emitted human-readable explanation
    }>;
  };

  valuation: {                                // default-parameter outputs; user overrides via separate endpoint
    cost_of_capital: { wacc: number; ke: number; kd_after_tax: number; equity_weight: number; debt_weight: number; rf: number; beta: number; erp: number; };
    dcf:    { ev: number; equity_value: number; horizon: number; forecast_growth: number; terminal_growth: number; fcf_base: number; ev_to_ebitda_implied: number; ev_to_revenue_implied: number; };
    graham: { value_per_share: number | null; intrinsic_value_total: number; assumptions: { earnings_basis: "net_income_statutory"; growth_factor: number; aaa_yield: number; }; };
    nav:    { book_equity: number; ppe_uplift: number; affiliate_uplift: number; deferred_tax: number; nnnav: number; } | null;
    ev_ebitda_multiples: Array<{ label: "Conservative" | "Mid" | "Premium"; multiple: number; ev: number; equity_value: number }>;
  };

  facts_citation_keys: {                      // the keys engine alerts use in facts_cited
    [key: string]: { source: "pl" | "bs" | "cf" | "ratios" | "credit"; field: string };
  };
}
```

This bundle is computed once at `stage_compute` and persisted alongside `calculated_metrics`. The FE imports a single typed reader that returns this object — no key lookups by string, no fallbacks, no recompute.

---

## 9. Piotroski 9-check derivation (engine-emitted, FE renders)

The 9 checks (Altman/Piotroski 1995 spec):

| # | Check key | Pass condition | Source canonical fields |
|---|---|---|---|
| 1 | `ni_positive` | `net_income_statutory > 0` | `assembled_pl.net_income_statutory` |
| 2 | `roa_positive` | `net_income_statutory / total_assets > 0` | `assembled_pl.net_income_statutory`, `assembled_bs.total_assets` |
| 3 | `cfo_positive` | `cash_from_operating > 0` | `assembled_cf.cash_from_operating` |
| 4 | `cfo_gt_ni` | `cash_from_operating > net_income_statutory` (quality of earnings) | `assembled_cf.cash_from_operating`, `assembled_pl.net_income_statutory` |
| 5 | `roa_improving` | current ROA > prior ROA | current + prior `assembled_pl/bs` |
| 6 | `debt_declining` | current `long_term_debt` < prior `long_term_debt` | current + prior `assembled_bs.long_term_debt` |
| 7 | `no_share_issuance` | current `share_capital` ≤ prior `share_capital` | current + prior `assembled_bs.share_capital` |
| 8 | `margin_improving` | current `operating_margin` > prior `operating_margin` | current + prior `assembled_pl.operating_ebit, revenue` |
| 9 | `asset_turnover_improving` | current `asset_turnover` > prior `asset_turnover` | current + prior |

Checks 5–9 require prior-period data. When absent, `has_prior_period: false`, those checks report `result: "uncertain"`, and the composite Piotroski score caps at 4 (the count of checks #1–4 that pass).

---

## 10. Composite credit score — engine spec (locked)

Variant: Altman Z″ (1995 EM). Composite weights (locked to engine, the FE's 40/20/15/10/10/5 path is retired):

```
composite_score =
    0.30 × altman_subscore         (Z″ band → 0-100)
  + 0.20 × profitability_subscore  (ROE × 0.5 + net_margin × 5, capped 0-100)
  + 0.15 × leverage_subscore       (net_debt_to_ebitda bands)
  + 0.10 × coverage_subscore       (interest coverage bands)
  + 0.10 × dscr_subscore           (dscr bands)
  + 0.10 × liquidity_subscore      (current + quick + cash, averaged)
  + 0.05 × equity_subscore         (equity_ratio × 200, capped 100)
```

Sub-score band lookups are emitted alongside the composite so the FE can render the breakdown chart without recomputing.

Letter grade mapping (locked):
- ≥ 90 → AAA
- ≥ 80 → AA
- ≥ 70 → A
- ≥ 60 → BBB
- ≥ 50 → BB
- ≥ 40 → B
- ≥ 25 → CCC
- < 25 → CC

(The current engine mapping has only 7 letters with no AA; the spec adds AA between AAA and A for graduation, matching standard S&P-style notches. Decision point — see §13.)

---

## 11. Valuation (DCF / Graham / WACC) — engine-side defaults + override endpoint

Today: FE composes DCF/Graham/WACC from canonical totals + supplementary parameters. Per the "FE does zero arithmetic" rule, the engine emits a **default-parameter** result inside `assembled_metrics.valuation`. When the user changes parameters in the Valuation tab UI, the FE calls a new endpoint:

```
POST /api/period/{id}/valuation/recompute
body: {
  forecast_years?: number;
  forecast_growth?: number;
  terminal_growth?: number;
  beta?: number;
  equity_risk_premium?: number;
  property_market_value?: number;
  annual_lease_expense?: number;
  shares_outstanding?: number;
}
response: AssembledMetrics["valuation"]   // same shape, recomputed
```

This keeps the FE free of valuation arithmetic while preserving the interactive Valuation tab UX. The default parameters (used when the user hasn't overridden) live in engine constants — currently in `reference/financial_analysis.py`'s WACC build-up logic — and are spec'd to:

- `forecast_years = 5`
- `forecast_growth = 0.05`
- `terminal_growth = 0.03`
- `rf = 0.07` (Romanian 10Y govt average)
- `erp = 0.075` (Damodaran EM)
- `beta = industry-typical from `industry_benchmarks` (or 0.85 fallback)`
- `cost_of_debt_pretax = 0.065`, `tax_rate = 0.16`

---

## 12. Schema migration & versioning

1. **Add `canonical_version: "v2.0"`** field to the top-level `/api/period/{id}` response. v1 = today's shape; v2 = §1–§11 above.
2. **Per-period cache invalidation on first read post-deploy.** Cached `benchmark_reports` rows already have a CAEN integrity check (Phase D); add an analogous version check on `calculated_metrics` so v1 cached rows are invalidated.
3. **No DB schema change required.** `calculated_metrics` is already a name/value/unit/direction shape; new rows just add new `name` values. `assembled_*` are JSONB columns — additive only.
4. **FE rollout sequencing**: ship the engine extension first (server emits v2, but no FE reads it). Then F3 lands the FE rewrites. Each Tier-1 site can flip to v2 reader independently.

---

## 13. Decisions still needed before F1 implementation begins

These are explicit calls the user must make. None requires opening code; each is a one-line answer.

1. **AA notch in the grade ladder.** Add AA (≥ 80, between AAA and A)? Current engine has no AA. Decision: yes / no. *(Recommend yes — standard S&P notches improve readability.)*

2. **Industry-aware verdict bands.** Source from `industry_benchmarks` catalog per resolved CAEN, fall back to general-SME defaults when CAEN unseeded. Decision: confirm sourcing logic. *(Recommend confirm — same discipline as the picker-seeded-only fix.)*

3. **`free_cash_flow` redefinition.** Today's engine row `free_cash_flow = net_income + depreciation` is a proxy and is mislabeled. The spec adds a proper `cash_from_operating − capex_total` definition. Decision: rename the legacy field to `free_cash_flow_proxy` (kept for v1 back-compat) and define `free_cash_flow` as the proper CFO−Capex. *(Recommend yes — the proxy is misleading on every entity with material capex.)*

4. **`ebitda_margin` source switch (statutory vs cash).** Today's row uses cash-view EBITDA. Spec switches to `ebitda_statutory` per §0 rule 3. Decision: confirm the source switch. *(Recommend yes — matches the "statutory canonical" decision.)*

5. **Valuation override endpoint or FE-side composition.** The spec proposes a new `POST /api/period/{id}/valuation/recompute` endpoint for interactive DCF parameter changes. Alternative: keep the Valuation tab's parameter UI as the one FE arithmetic exception. Decision: endpoint (recommended) or exception.

6. **Net Debt to EBITDA basis — statutory or core?** Two reasonable answers: (a) `net_debt / ebitda_statutory` (matches the EBITDA the user sees in headlines), (b) `net_debt / core_ebitda` (the valuation-relevant figure that excludes 758/781). Decision: which is the headline? Both can be emitted, but one needs to be "the leverage ratio" in the credit composite. *(Recommend (a) statutory for the headline + composite, expose (b) as a secondary "leverage on core EBITDA" tile.)*

7. **periodFacts refactor sequence.** Per the audit, periodFacts becomes a reader of `assembled_metrics`. Should `periodFacts` shape stay the same (FE-internal) or be retired entirely (FE consumers read `assembled_metrics` directly)? Decision: keep periodFacts as a thin pass-through wrapper (recommended — keeps recommendationRules.ts contract stable), OR retire it (more invasive).

---

## 14. What this spec does NOT do

- Does not implement any of §1–§11. F1 is the **spec**; F3 is the implementation.
- Does not estimate engineering time. The surface is moderate: one Python file (`pipeline.py` stage_compute extension) + the 104 fix in `_statutory_parser.py` + one new endpoint for valuation overrides. FE rewrites land in F3, not here.
- Does not modify the canonical-metrics module — it is the consumer side, not the contract side. F3 rewires it to read from `assembled_metrics` instead of doing the 758/781 bridge locally.
- Does not change FE renderer files yet. Per the user's instruction: F1 is the contract review surface, not the F-code.

---

## 15. Acceptance — what makes this F1 deliverable "GREEN"

- [ ] Every ratio, score, sub-score, band, and verdict the FE displays today appears as either an `assembled_*` field or a `calculated_metrics` row (or both) in §3–§10 above.
- [ ] Each new field has a source-account derivation in §3–§6 — no "computed elsewhere" placeholders.
- [ ] Decisions 1–7 in §13 are answered.
- [ ] Variant decision (Z" always) is reflected throughout (§10 ✓).
- [ ] Composite weight decision (30/20/15/10/10/10/5) is reflected throughout (§10 ✓).
- [ ] Migration plan (§12) covers cache invalidation and v1→v2 versioning.

Once §13's 7 decisions are answered, F1 is complete and F2 (delete FE Altman path) + F3 (rewrite Tier-1 sites) become unblocked.

---

*Status: F1 contract spec drafted. No engine or FE code changed. The 9 Tier-1 FE recompute sites become readers of §3–§10 in F3. Approval signal needed on the 7 decisions in §13 before implementation begins.*
