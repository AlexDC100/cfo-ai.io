# CANONICAL_SCHEMA_V1 — design draft

> **Status:** F4.0 design artifact, 2026-05-23. No engine code lives here yet.
> This is the schema the F4.1+ migration will produce in parallel alongside
> the existing RAS-flavored canonical (see §10 for the deprecation horizon).
>
> **Locked operator decisions (F3.15 close):**
> - **3a.** Wide-grained buckets (~30 BS / ~20 PL parent aggregates as the floor; ~50 BS / ~40 PL leaves once cross-standard distinctions are included). Add a bucket whenever a real economic distinction surfaces — don't compress.
> - **3b.** Always-positive magnitudes + explicit `sign_meaning` metadata. Old natural-side fields stay byte-identical under parallel emission; new `_unsigned` fields appear alongside.
> - **3c.** Externalized methodology in YAML files, one file per `methodology_id`, versioned per file. Engine becomes a reader; methodology authors don't touch engine source.
> - **3d.** Confidence-based detection with fan-out, **threshold-gated**: >85% → single-pack fast path; 60–85% → top-2 fan-out and pick cleanest assembled output; <60% → surface to operator with top-3 candidates + evidence.
> - **3e.** Parallel migration. Old canonical surface stays alive ≥2 quarters after Layer 2 reaches feature parity. Every deprecated field emits a runtime `deprecated_fields` warning in the API response before deletion.

---

## 1. Cross-standard concept survey (the discipline check, before any bucket list)

The trap this section catches: a bucket list shaped by RAS happens to fit IFRS at 70% and US-GAAP at 50%, then we ship and discover three years later that "operating expenses" means something subtly different in each pack. Below: every major economic concept the schema must represent, with its representation in each of the three standards we're designing against.

| Concept | RAS (OMFP 1802) | IFRS | US-GAAP | Schema implication |
|---|---|---|---|---|
| Land vs depreciable PPE | All in `imobilizări corporale` (211 + 212/213/214) | IAS 16 splits land (not depreciated) from buildings/equipment | ASC 360 same as IFRS | **Separate buckets.** `ppe_land` vs `ppe_buildings` vs `ppe_machinery_equipment` (operator-flagged) |
| Right-of-use assets | Not recognized pre-OMFP-update; operating lease = P&L expense (612) | IFRS 16: ROU asset + lease liability on BS for all leases except short-term/low-value | ASC 842: same as IFRS 16 (operating + finance lease both on BS) | **Separate bucket** `right_of_use_assets` + `lease_liability_st/lt`. RAS pack emits zero for now; converts to non-zero when an entity adopts IFRS-flavored leasing |
| Inventory categories | 301 raw, 331 WIP, 345 finished, 371 merchandise, 381 packaging | IAS 2 same categories at conceptual level | ASC 330 same | **Match all** (`inventory_raw`, `inventory_wip`, `inventory_finished`, `inventory_merchandise`, `inventory_packaging`) |
| Inventory production variation (711) | Class 7 credit = production stocked; debits = consumed | IFRS: no equivalent; inventory delta hits COGS directly | US-GAAP: same as IFRS | **RAS-specific memo bucket** `inventory_variation_memo` — kept but documented as RAS-only artifact; other packs emit zero |
| Capitalized own work (RAS 72x) | Class 7 credit; reduces cost base of construction | IFRS: same (IAS 23 borrowing costs + IAS 16 directly attributable costs capitalized to PPE-under-construction) | US-GAAP: same | **Universal** `capitalized_own_work_memo` — concept exists in all 3 but RAS surfaces it more explicitly |
| Deferred tax | Not always recognized in RAS SMEs (Romanian micro-companies opt out); appears in 4412/4424 | IAS 12 — full deferred tax on temporary differences, BS asset/liability split | ASC 740 — same | **Separate buckets** `deferred_tax_assets`, `deferred_tax_liabilities` (operator-flagged) |
| Goodwill | RAS 207 (`Fond comercial`); amortized over 5 years | IFRS 3: tested for impairment, not amortized | ASC 350: same as IFRS | **Separate bucket** `intangibles_goodwill` + `accumulated_impairment_goodwill`. The "amortized vs impaired" methodology lives in the methodology layer, not the schema |
| Revaluation reserves | RAS 105 (`Rezerve din reevaluare`) recognized | IAS 16 allows revaluation model; recognized in OCI | US-GAAP: revaluation NOT permitted (asset stays at cost) | **Universal bucket** `revaluation_reserves` — US-GAAP packs emit zero by definition |
| Other Comprehensive Income (OCI) | Not a separate statement in RAS SMEs | IAS 1: distinct statement; accumulated OCI on BS | ASC 220: same | **Separate bucket** `accumulated_oci`. RAS SME packs emit zero (no OCI concept); IFRS/GAAP packs populate |
| Discounts given/received (709 contra-revenue) | Class 70 net of 709; 609 contra-cost | IFRS 15: revenue measured net of variable consideration (effectively the same net presentation) | ASC 606: same | **Universal** — bucket is `revenue_net_of_reductions` at the aggregate level; the per-account decomposition (gross, less reductions) is sub-aggregate metadata |
| Personnel cost components | 641 wages, 645 social, 642 vouchers, 646 work insurance | IAS 19: short-term employee benefits + post-employment benefits + termination benefits | ASC 715 + ASC 712: similar split | **Wide** — `personnel_wages`, `personnel_social_security`, `personnel_benefits`, `personnel_termination`. Pension liabilities get their own LT bucket |
| Affiliated/intercompany balances | 451 receivable + payable mixed-side per analytics | IAS 24 related-party disclosures (off-statement note) | ASC 850: same | **Separate buckets** `ar_intercompany` + `ap_intercompany` (related-party concentration is a credit-risk signal in every standard) |
| Government grants | 475 LT subsidies, 740 P&L recognition | IAS 20: deferred income approach OR netting against asset | ASC 832: limited recognition rules | **Universal buckets** `government_grants_deferred` (LT liability) + `government_grants_recognized` (P&L); methodology layer handles netting variant |
| Minority / Non-controlling interest | Not relevant for RAS single-entity SME | IAS 27 / IFRS 10: NCI shown within equity | ASC 810: same | **Universal bucket** `non_controlling_interest` (equity). Single-entity RAS packs emit zero |
| Investment property | RAS 215 (`Investiții imobiliare`) | IAS 40: distinct from operating PPE, fair-value-able | ASC 360: no specific "investment property" concept, lumped into PPE | **Separate bucket** `investment_property` (existing RAS sub-aggregate); US-GAAP packs route here from PPE based on use designation |
| Extraordinary income/expense | RAS 671/771 (legacy, pre-2015) | IAS 1: extraordinary items prohibited since 2003 | ASC 225: same (eliminated since 2015) | **No bucket** — collapse to `other_operating_income/expense_one_off`. RAS legacy accounts route here too |
| Treasury shares | Rare in RAS SMEs | IAS 32: contra-equity | ASC 505-30: same | **Bucket** `treasury_shares` (contra to equity) |
| Convertible instruments | Rare in RAS | IAS 32 split accounting (liability + equity components) | ASC 470 / 815: similar | **Two buckets** `convertible_debt_host` (LT debt) + `convertible_debt_equity_component` (equity). Methodology layer decides classification per standard |

This survey is intentionally not exhaustive — it covers the concepts that surfaced in F1-F3 work plus the IFRS/US-GAAP equivalents the operator's earlier 4-EBITDA family + IFRS-16 lessee example flagged. New concepts that surface during F4.1 implementation will earn buckets per the §3a "don't artificially compress" rule.

---

## 2. Schema-wide conventions

### 2a. Naming

`snake_case` throughout. No CamelCase, no abbreviations beyond `ppe` (property, plant, equipment), `ar` (accounts receivable), `ap` (accounts payable), `cf{o,i,f}` (cash flow from operations/investing/financing), `lt` / `st` (long/short term), `oci` (other comprehensive income), `nci` (non-controlling interest). The TS interface layer translates to camelCase at the FE boundary; canonical names stay snake_case so they round-trip cleanly through YAML methodology files + Python + Postgres.

### 2b. Sign meaning — always-positive

Every bucket emits a non-negative magnitude. The `sign_meaning` metadata field declares the economic direction:

- `asset_positive` — increases assets (debit-natural). E.g., `cash`, `inventory_raw`.
- `asset_negative` — reduces assets (credit-natural). E.g., `accumulated_depreciation_ppe`, `ar_provisions`. The bucket's magnitude is unsigned; the reader subtracts it when computing `ppe_net`.
- `liability_positive` — increases liabilities (credit-natural). E.g., `accounts_payable_trade`, `lt_debt_bank`.
- `equity_positive` — increases equity (credit-natural). E.g., `share_capital`, `retained_earnings_prior_years`.
- `equity_negative` — reduces equity (debit-natural). E.g., `treasury_shares`, `accumulated_deficit_current_year` (when current year is a loss).
- `revenue_positive` — increases revenue (credit-natural). E.g., `revenue_products`.
- `revenue_negative` — contra-revenue (debit-natural, magnitude unsigned). E.g., `revenue_commercial_reductions`.
- `expense_positive` — increases expense (debit-natural). E.g., `cogs_raw_materials`, `interest_expense`.
- `expense_negative` — reduces expense (contra-expense, e.g., supplier discounts received). E.g., `discounts_received_supplier`.

The defensive-flip logic that exists today (chart_of_accounts.py:1021) is the workaround that always-positive eliminates. The methodology layer computes `total_equity = share_capital + share_premium + reserves + retained_earnings_prior + (current_year_profit if profit else -current_year_loss) - treasury_shares` from the magnitudes + sign_meaning hints, not from signed bucket sums.

### 2c. Aggregation hierarchy

Every leaf bucket declares its `parent_aggregate`. Aggregates compose:

```
total_assets
  ├── current_assets
  │     ├── cash_and_equivalents (rolls up cash + cash_restricted + short_term_investments)
  │     ├── trade_receivables_net (rolls up ar_trade_gross + ar_doubtful_gross - ar_provisions)
  │     ├── other_receivables (rolls up ar_intercompany + ar_tax + ar_personnel + ar_other)
  │     ├── inventory_net (rolls up inventory_raw + wip + finished + merchandise + packaging - inventory_provisions)
  │     └── prepaid_expenses_and_other
  └── non_current_assets
        ├── ppe_net (rolls up land + buildings + machinery + furniture + cip + advances - accumulated_dep_ppe)
        ├── investment_property
        ├── right_of_use_assets
        ├── intangibles_net (rolls up goodwill + other - accum_amort - accum_impairment)
        ├── financial_investments
        ├── deferred_tax_assets
        └── other_non_current_assets
```

Aggregates are computed, not stored. Methodology files reference whichever level they need.

### 2d. Bucket metadata schema

Every bucket carries these fields in the canonical definition:

```yaml
canonical_name: string         # e.g. "ppe_land"
display_label: string          # e.g. "Land"
type: enum {asset, liability, equity, revenue, expense, oci_item, memo}
sign_meaning: enum (see §2b)
parent_aggregate: string       # e.g. "ppe_net"
contra_of: string | null       # for *_negative sign-meaning, the bucket this offsets
description: string            # 1-sentence economic meaning
ras_mapping:
  account_prefixes: [...]      # e.g. ["211"]
  notes: string                # any RAS-specific quirks
ifrs_mapping:
  paragraph_ref: string        # e.g. "IAS 16.37"
  notes: string
us_gaap_mapping:
  asc_ref: string              # e.g. "ASC 360-10-35"
  notes: string
introduced_in: string          # methodology version where the bucket first appeared
deprecation_horizon: string | null  # ISO date if the bucket is being deprecated
```

---

## 3. Balance Sheet — bucket inventory

### 3a. Current Assets

| canonical_name | type / sign | parent_aggregate | contra_of | RAS example | IFRS ref |
|---|---|---|---|---|---|
| `cash_operating` | asset / asset_positive | cash_and_equivalents | — | 5121, 5311 | IAS 7.6 |
| `cash_fx` | asset / asset_positive | cash_and_equivalents | — | 5124, 5314 | IAS 7.6 + IAS 21 |
| `cash_restricted` | asset / asset_positive | cash_and_equivalents | — | (sub of 512/581) | IAS 7.48 |
| `short_term_investments` | asset / asset_positive | cash_and_equivalents | — | 501, 503, 505-508 | IFRS 9 |
| `ar_trade_gross` | asset / asset_positive | trade_receivables_net | — | 4111, 4118 | IFRS 9 / IAS 1.54(h) |
| `ar_doubtful_gross` | asset / asset_positive | trade_receivables_net | — | 4118 sub | IFRS 9 expected credit loss |
| `ar_provisions` | asset / asset_negative | trade_receivables_net | `ar_trade_gross + ar_doubtful_gross` | 491 | IFRS 9 ECL allowance |
| `ar_intercompany` | asset / asset_positive | other_receivables | — | 451 D-side, 4511 | IAS 24 |
| `ar_tax_recoverable` | asset / asset_positive | other_receivables | — | 4424 (VAT recoverable), 4411 advance | IAS 12 |
| `ar_personnel` | asset / asset_positive | other_receivables | — | 425, 4282 | IAS 19 short-term |
| `ar_supplier_advances` | asset / asset_positive | other_receivables | — | 4091, 4092 | IAS 1 |
| `ar_other` | asset / asset_positive | other_receivables | — | 461 D-side, 471 prepaid | IFRS 9 |
| `inventory_raw_materials` | asset / asset_positive | inventory_net | — | 301 | IAS 2.6 |
| `inventory_consumables` | asset / asset_positive | inventory_net | — | 302, 303 | IAS 2.6 |
| `inventory_wip` | asset / asset_positive | inventory_net | — | 331, 341 (production WIP, semi-finished) | IAS 2.6 |
| `inventory_finished_goods` | asset / asset_positive | inventory_net | — | 345 | IAS 2.6 |
| `inventory_merchandise_resale` | asset / asset_positive | inventory_net | — | 371 | IAS 2.6 |
| `inventory_packaging` | asset / asset_positive | inventory_net | — | 381 | IAS 2.6 |
| `inventory_at_third_parties` | asset / asset_positive | inventory_net | — | 351, 357 | IAS 2 |
| `inventory_provisions` | asset / asset_negative | inventory_net | (all inventory_* above) | 39x | IAS 2.9 (NRV) |
| `prepaid_expenses_st` | asset / asset_positive | prepaid_expenses_and_other | — | 471 | IFRS 15.66 / IAS 1 |

21 leaf buckets, 5 parent aggregates.

### 3b. Non-current Assets

| canonical_name | type / sign | parent_aggregate | contra_of | RAS | IFRS |
|---|---|---|---|---|---|
| `ppe_land` | asset / asset_positive | ppe_net | — | 211 | IAS 16.37(a) |
| `ppe_buildings` | asset / asset_positive | ppe_net | — | 212 | IAS 16.37(b) |
| `ppe_machinery_equipment` | asset / asset_positive | ppe_net | — | 2131, 2132, 2133 | IAS 16.37(c-e) |
| `ppe_furniture_office` | asset / asset_positive | ppe_net | — | 214 | IAS 16.37(g) |
| `ppe_under_construction` | asset / asset_positive | ppe_net | — | 231, 232 | IAS 16.37 |
| `ppe_advances` | asset / asset_positive | ppe_net | — | 4093 | IAS 16 |
| `accumulated_depreciation_ppe` | asset / asset_negative | ppe_net | (ppe_buildings/machinery/etc — NOT land) | 281x | IAS 16.43 |
| `accumulated_impairment_ppe` | asset / asset_negative | ppe_net | (all ppe_*) | 291 | IAS 36 |
| `investment_property` | asset / asset_positive | (own aggregate) | — | 215 | IAS 40.5 |
| `right_of_use_assets` | asset / asset_positive | (own aggregate) | — | (n/a in current RAS, IFRS-adopted entities only) | IFRS 16.22 |
| `accumulated_depreciation_rou` | asset / asset_negative | right_of_use_assets | — | (n/a in RAS) | IFRS 16.31 |
| `intangibles_goodwill` | asset / asset_positive | intangibles_net | — | 207 | IFRS 3.32 / IAS 36 |
| `intangibles_other` | asset / asset_positive | intangibles_net | — | 201, 203, 205, 208 | IAS 38.118 |
| `accumulated_amortization_intangibles` | asset / asset_negative | intangibles_net | `intangibles_other` (NOT goodwill — goodwill is impaired, not amortized) | 280x | IAS 38.97 |
| `accumulated_impairment_goodwill` | asset / asset_negative | intangibles_net | `intangibles_goodwill` | (n/a separate in RAS) | IAS 36.124 |
| `financial_investments_affiliates` | asset / asset_positive | financial_investments | — | 261, 263 | IAS 28 / IFRS 10/11 |
| `financial_investments_other` | asset / asset_positive | financial_investments | — | 265, 267 | IFRS 9 |
| `deferred_tax_assets` | asset / asset_positive | (own aggregate) | — | (4412 partial, rarely populated in RAS SME) | IAS 12.24 |
| `other_non_current_assets` | asset / asset_positive | (own aggregate) | — | 2678 LT recv, 267 | IAS 1.54 |

19 leaf buckets, 6 parent aggregates.

### 3c. Current Liabilities

| canonical_name | type / sign | parent_aggregate | contra_of | RAS | IFRS |
|---|---|---|---|---|---|
| `ap_trade` | liability / liability_positive | trade_payables | — | 401, 403, 404, 408 | IAS 1.54(k) |
| `ap_intercompany` | liability / liability_positive | trade_payables | — | 451 C-side, 4511 C, 455 C | IAS 24 |
| `ap_tax` | liability / liability_positive | tax_payables | — | 441 (income tax), 442 (VAT C), 444-448 | IAS 12 / IAS 1.54(n) |
| `ap_personnel_salaries` | liability / liability_positive | personnel_payables | — | 421, 423 | IAS 19 |
| `ap_personnel_social` | liability / liability_positive | personnel_payables | — | 431, 436, 438 | IAS 19 |
| `ap_personnel_other` | liability / liability_positive | personnel_payables | — | 425 (if C), 426, 427, 428 | IAS 19 |
| `ap_dividends` | liability / liability_positive | other_payables_st | — | 457 | IAS 10 |
| `ap_other` | liability / liability_positive | other_payables_st | — | 462, 419 customer advances | IAS 1 |
| `st_debt_bank` | liability / liability_positive | financial_liabilities_st | — | 519, 5191, 5192 | IFRS 9 / IAS 1.54(m) |
| `st_debt_other` | liability / liability_positive | financial_liabilities_st | — | 509 | IFRS 9 |
| `st_lease_liabilities` | liability / liability_positive | financial_liabilities_st | — | (167 portion <12m for IFRS-adopted; n/a for RAS SME) | IFRS 16.47 |
| `customer_advances` | liability / liability_positive | deferred_revenue_st | — | 419 | IFRS 15.106 |
| `deferred_revenue_st` | liability / liability_positive | deferred_revenue_st | — | 472 | IFRS 15.106 |
| `provisions_st` | liability / liability_positive | provisions_st | — | (151 portion <12m) | IAS 37.14 |
| `accrued_expenses` | liability / liability_positive | other_payables_st | — | 408 (invoices not received), 4281 | IAS 1.54(k) |
| `other_current_liabilities` | liability / liability_positive | other_payables_st | — | (residual) | IAS 1 |

16 leaf buckets, 5 parent aggregates.

### 3d. Non-current Liabilities

| canonical_name | type / sign | parent_aggregate | contra_of | RAS | IFRS |
|---|---|---|---|---|---|
| `lt_debt_bank` | liability / liability_positive | financial_liabilities_lt | — | 1621-1625, 168 accrued interest | IFRS 9 |
| `lt_debt_other` | liability / liability_positive | financial_liabilities_lt | — | 166 bonds, 167 leasing legacy | IFRS 9 |
| `lt_lease_liabilities` | liability / liability_positive | financial_liabilities_lt | — | (167 portion >12m for IFRS-adopted; n/a for RAS SME) | IFRS 16.47 |
| `deferred_tax_liabilities` | liability / liability_positive | (own aggregate) | — | (rarely populated in RAS SME) | IAS 12.24 |
| `provisions_lt` | liability / liability_positive | provisions_lt | — | 151 portion >12m | IAS 37.14 |
| `pension_liabilities` | liability / liability_positive | pension_liabilities | — | (rare in RAS SME; 1515 if present) | IAS 19.55 |
| `government_grants_deferred` | liability / liability_positive | deferred_income_lt | — | 475, 478 | IAS 20.12 |
| `convertible_debt_host` | liability / liability_positive | financial_liabilities_lt | — | (rare in RAS SME) | IAS 32.28 |
| `other_non_current_liabilities` | liability / liability_positive | (own aggregate) | — | (residual) | IAS 1 |

9 leaf buckets, 5 parent aggregates.

### 3e. Equity

| canonical_name | type / sign | parent_aggregate | contra_of | RAS | IFRS |
|---|---|---|---|---|---|
| `share_capital` | equity / equity_positive | contributed_capital | — | 101, 1012 | IAS 1.78(e) |
| `share_premium` | equity / equity_positive | contributed_capital | — | 104 | IAS 1.78(e) |
| `revaluation_reserves` | equity / equity_positive | reserves | — | 105 | IAS 16.39 |
| `legal_reserves` | equity / equity_positive | reserves | — | 1061 | IAS 1.78(e) / local statutes |
| `other_reserves` | equity / equity_positive | reserves | — | 1068 | IAS 1.78(e) |
| `retained_earnings_prior_years` | equity / equity_positive | retained_earnings | — | 117 (C net), 1171 | IAS 1.79(b) |
| `accumulated_losses_prior_years` | equity / equity_negative | retained_earnings | `retained_earnings_prior_years` | 117 (D net), 1174 | IAS 1.79(b) |
| `current_year_profit` | equity / equity_positive | retained_earnings | — | 121 closing C | IAS 1.81A |
| `current_year_loss` | equity / equity_negative | retained_earnings | `current_year_profit` | 121 closing D | IAS 1.81A |
| `profit_distribution_provision` | equity / equity_negative | retained_earnings | `current_year_profit` | 129 | local statutes |
| `treasury_shares` | equity / equity_negative | (own aggregate) | (contributed_capital) | (rare in RAS SME) | IAS 32.33 |
| `accumulated_oci` | equity / equity_positive | (own aggregate) | — | (n/a in RAS SME) | IAS 1.7 |
| `non_controlling_interest` | equity / equity_positive | (own aggregate) | — | (n/a in single-entity RAS) | IAS 27.27 |
| `convertible_debt_equity_component` | equity / equity_positive | (own aggregate) | — | (rare in RAS SME) | IAS 32.28 |

14 leaf buckets, 5 parent aggregates.

**BS total:** 79 leaf buckets, 26 parent aggregates. Above the "~30" floor — every additional bucket carries a real economic distinction surfaced by the cross-standard survey.

---

## 4. P&L — bucket inventory

### 4a. Revenue

| canonical_name | type / sign | parent_aggregate | RAS | IFRS |
|---|---|---|---|---|
| `revenue_products` | revenue / revenue_positive | revenue_gross | 701 | IFRS 15.31 |
| `revenue_semi_finished` | revenue / revenue_positive | revenue_gross | 702 | IFRS 15.31 |
| `revenue_residual_products` | revenue / revenue_positive | revenue_gross | 703 | IFRS 15.31 |
| `revenue_services` | revenue / revenue_positive | revenue_gross | 704, 705 | IFRS 15.31 |
| `revenue_rental_royalty` | revenue / revenue_positive | revenue_gross | 706 | IFRS 15.31 / IAS 17 / IAS 40.75 |
| `revenue_merchandise_resale` | revenue / revenue_positive | revenue_gross | 707 | IFRS 15.31 |
| `revenue_other_operating` | revenue / revenue_positive | revenue_gross | 708 | IFRS 15.31 |
| `revenue_commercial_reductions` | revenue / revenue_negative | revenue_gross | 709 | IFRS 15 variable consideration |

8 leaf buckets, 1 parent aggregate (`revenue_net = revenue_gross - revenue_commercial_reductions`).

### 4b. Operating expenses (excl. D&A and provisions)

| canonical_name | type / sign | parent_aggregate | RAS | IFRS |
|---|---|---|---|---|
| `cogs_raw_materials` | expense / expense_positive | cogs | 601 | IAS 2.34 |
| `cogs_auxiliary_consumables` | expense / expense_positive | cogs | 602 | IAS 2.34 |
| `cogs_merchandise` | expense / expense_positive | cogs | 607 | IAS 2.34 |
| `cogs_packaging` | expense / expense_positive | cogs | 608 | IAS 2.34 |
| `discounts_received_supplier` | expense / expense_negative | cogs | 609 | IFRS 15 / IAS 2 |
| `materials_non_inventory` | expense / expense_positive | opex_general | 603, 604 | IAS 1.99 |
| `energy_utilities` | expense / expense_positive | opex_general | 605 | IAS 1.99 |
| `maintenance_repairs` | expense / expense_positive | opex_general | 611 | IAS 1.99 |
| `rent_operating_lease` | expense / expense_positive | opex_general | 612 (RAS), 612 + 613 IFRS-16-exempt | IFRS 16.5/6 short-term exemption |
| `insurance` | expense / expense_positive | opex_general | 613 (RAS) | IAS 1.99 |
| `third_party_services` | expense / expense_positive | opex_general | 622, 623, 626, 627, 628 | IAS 1.99 |
| `transport_logistics` | expense / expense_positive | opex_general | 624 | IAS 1.99 |
| `travel_protocol` | expense / expense_positive | opex_general | 625, 623 | IAS 1.99 |
| `other_operating_taxes` | expense / expense_positive | opex_general | 63 | IAS 12 (non-income tax) / IAS 1.99 |
| `personnel_wages` | expense / expense_positive | personnel_total | 641 | IAS 19.5(a) |
| `personnel_social_security` | expense / expense_positive | personnel_total | 645 | IAS 19.5(a) |
| `personnel_benefits` | expense / expense_positive | personnel_total | 642, 644, 647 | IAS 19.5(a) |
| `personnel_other_contributions` | expense / expense_positive | personnel_total | 646 | IAS 19.5(a) |
| `other_operating_expenses` | expense / expense_positive | opex_general | 65 catchall | IAS 1.99 |

19 leaf buckets, 3 parent aggregates (`cogs`, `opex_general`, `personnel_total`).

### 4c. Depreciation, Amortization, Impairment, Provisions

| canonical_name | type / sign | parent_aggregate | RAS | IFRS |
|---|---|---|---|---|
| `depreciation_ppe` | expense / expense_positive | dap | 6811 | IAS 16.50 |
| `depreciation_rou_assets` | expense / expense_positive | dap | (n/a in RAS SME) | IFRS 16.32 |
| `amortization_intangibles` | expense / expense_positive | dap | 6811 (RAS doesn't split D vs A) | IAS 38.97 |
| `impairment_goodwill` | expense / expense_positive | dap | (rare in RAS SME) | IAS 36.124 |
| `impairment_ppe_intangibles` | expense / expense_positive | dap | 6813 | IAS 36 |
| `impairment_receivables` | expense / expense_positive | dap | 654, 6814 | IFRS 9 ECL |
| `provision_charges` | expense / expense_positive | dap | 6812 | IAS 37.59 |
| `provision_reversals` | expense / expense_negative | dap | 781 | IAS 37.59 |

8 leaf buckets, 1 parent aggregate (`dap`).

### 4d. Other operating income / one-offs

| canonical_name | type / sign | parent_aggregate | RAS | IFRS |
|---|---|---|---|---|
| `other_operating_income_recurring` | revenue / revenue_positive | other_op_income | 758 sub-detail | IAS 1.99 |
| `other_operating_income_one_off` | revenue / revenue_positive | other_op_income | 758 sub-detail | IAS 1.99 |
| `government_grants_recognized` | revenue / revenue_positive | other_op_income | 740, 7584 | IAS 20.12 |
| `gain_loss_disposal_ppe` | revenue / revenue_positive (or _negative if loss) | other_op_income | 7583 (G), 6583 (L) | IAS 16.71 |
| `capitalized_own_work_memo` | revenue / revenue_positive (memo) | (excluded from EBITDA cash view) | 72x | IAS 16.22 / IAS 23 |
| `inventory_variation_memo` | revenue / revenue_positive or _negative (memo) | (excluded from EBITDA cash view) | 711 net | (n/a; IFRS books inventory delta in COGS) |

6 leaf buckets, 1 parent aggregate (`other_op_income`) + 2 memo lines.

### 4e. Financial items

| canonical_name | type / sign | parent_aggregate | RAS | IFRS |
|---|---|---|---|---|
| `interest_income` | revenue / revenue_positive | financial_income | 766 | IFRS 9.5.4.1 / IAS 1.82(a) |
| `dividend_income_affiliates` | revenue / revenue_positive | financial_income | 7611, 7612 | IAS 27 / IAS 1.82(a) |
| `dividend_income_other` | revenue / revenue_positive | financial_income | 762, 763 | IFRS 9 |
| `fx_gain_realized` | revenue / revenue_positive | financial_income | 7651 | IAS 21.28 |
| `fx_gain_unrealized` | revenue / revenue_positive (memo) | financial_income | 7651 (sub) | IAS 21.28 |
| `discounts_received_financial` | revenue / revenue_positive | financial_income | 767 | IFRS 9 |
| `other_financial_income` | revenue / revenue_positive | financial_income | 768 | IAS 1 |
| `interest_expense` | expense / expense_positive | financial_expense | 666 | IFRS 9 / IAS 1.82(b) |
| `fx_loss_realized` | expense / expense_positive | financial_expense | 6651 | IAS 21.28 |
| `fx_loss_unrealized` | expense / expense_positive (memo) | financial_expense | 6651 (sub) | IAS 21.28 |
| `discount_charges` | expense / expense_positive | financial_expense | 667 | IFRS 9 |
| `other_financial_expense` | expense / expense_positive | financial_expense | 668 | IAS 1 |

12 leaf buckets, 2 parent aggregates. **Note:** realized vs unrealized FX is split into separate buckets because the "cash EBITDA" methodology must strip unrealized FX even though it sits in the same RAS account 7651/6651.

### 4f. Tax

| canonical_name | type / sign | parent_aggregate | RAS | IFRS |
|---|---|---|---|---|
| `income_tax_current` | expense / expense_positive | income_tax | 691 | IAS 12.46 |
| `income_tax_deferred` | expense / expense_positive | income_tax | 6912 (rare in RAS SME) | IAS 12.46 |

2 leaf buckets, 1 parent aggregate.

**PL total:** 55 leaf buckets (including 2 memo lines), 9 parent aggregates. Above the "~20" floor — the wide leaf set is what makes the four-EBITDA family composable.

---

## 5. Cash Flow Statement — bucket inventory

Indirect method only for v1 (direct method is rare in RAS SMEs; can be added later if a country pack needs it).

### 5a. CFO — Operating

| canonical_name | type / sign | parent_aggregate | source |
|---|---|---|---|
| `cfo_net_income_anchor` | (signed) | cfo | `current_year_profit - current_year_loss` from BS |
| `cfo_da_addback` | expense_negative (addback) | cfo | `dap` parent total |
| `cfo_provision_net_addback` | expense_negative (addback) | cfo | `provision_charges - provision_reversals` |
| `cfo_fx_unrealized_addback` | (signed addback) | cfo | `fx_loss_unrealized - fx_gain_unrealized` |
| `cfo_other_non_cash_addback` | (signed) | cfo | residual non-cash items |
| `cfo_delta_inventory` | (signed) | cfo | -(closing_inventory_net - opening_inventory_net) |
| `cfo_delta_receivables` | (signed) | cfo | -(closing_total_recv - opening_total_recv) |
| `cfo_delta_payables` | (signed) | cfo | +(closing_total_pay - opening_total_pay) |
| `cfo_delta_other_wc` | (signed) | cfo | residual WC movements |
| `cfo_interest_paid` | expense / expense_positive (out) | cfo | from `interest_expense` (cash basis) |
| `cfo_income_tax_paid` | expense / expense_positive (out) | cfo | from `income_tax_current` (cash basis) |

### 5b. CFI — Investing

| canonical_name | type / sign | parent_aggregate | source |
|---|---|---|---|
| `cfi_capex_ppe` | (out) | cfi | -(delta in PPE gross before depreciation) |
| `cfi_capex_intangibles` | (out) | cfi | -(delta in intangibles gross) |
| `cfi_acquisitions` | (out) | cfi | new affiliate / business combinations |
| `cfi_disposals` | (in) | cfi | PPE / business disposals net proceeds |
| `cfi_financial_investments_net` | (signed) | cfi | delta in `financial_investments` |
| `cfi_interest_received` | (in) | cfi | from `interest_income` (cash basis) |
| `cfi_dividends_received` | (in) | cfi | from `dividend_income_*` (cash basis) |

### 5c. CFF — Financing

| canonical_name | type / sign | parent_aggregate | source |
|---|---|---|---|
| `cff_debt_drawn` | (in) | cff | from delta in `lt_debt_bank + st_debt_bank` |
| `cff_debt_repaid` | (out) | cff | from delta in `lt_debt_bank + st_debt_bank` |
| `cff_lease_payments_principal` | (out) | cff | IFRS 16 principal portion only |
| `cff_equity_issued` | (in) | cff | delta in `share_capital + share_premium` |
| `cff_equity_repurchased` | (out) | cff | delta in `treasury_shares` |
| `cff_dividends_paid` | (out) | cff | from `ap_dividends` movement |
| `cff_other` | (signed) | cff | residual financing |

### 5d. Reconciliation

| canonical_name | source |
|---|---|
| `cf_net_change_in_cash` | cfo + cfi + cff |
| `cf_opening_cash` | from `cash_and_equivalents` (opening) |
| `cf_closing_cash` | from `cash_and_equivalents` (closing) |
| `cf_fx_effect_on_cash` | IAS 7.28 — separate line for FX impact on opening balances |

25 CF buckets, 3 parent aggregates.

---

## 6. Methodology layer — the four-EBITDA family as YAML

First methodology file. Doubles as the format spec for all future methodology files.

```yaml
# methodology/ro_ras_2025_v1.yaml
# Romanian RAS methodology under OMFP 1802, fiscal year 2025.

methodology_id: ro_ras_2025_v1
applies_to:
  countries: [RO]
  standards: [ras_omfp_1802]
  fiscal_year_range: [2024-01-01, 2025-12-31]
schema_version: canonical_v1
created_at: 2026-05-23
authors: [alex_cretin]

# ─── Bucket aliases — short-form names used in formulas below ───────
# Always reference canonical names; aliases for readability only.
aliases:
  revenue_net:           revenue_gross - revenue_commercial_reductions
  cogs_total:            cogs.sum  # parent_aggregate sum
  opex_total:            opex_general.sum
  personnel_total:       personnel_total.sum
  dap_total:             dap.sum
  other_op_income_total: other_op_income.sum
  financial_income_net:  financial_income.sum - financial_expense.sum

# ─── EBITDA family — declared as composable formulas over canonical ──
# Every EBITDA variant is a NAMED VIEW. Variants reference each other
# via `base:` so changes propagate. The methodology version pinned per
# period determines which formulas were used to produce the displayed
# numbers (provenance trail).
ebitda_variants:

  reported:
    description: >
      Headline EBITDA as filed under statutory reporting. Includes all
      operating revenue and all operating income (recurring + one-off
      + provision reversals + government grants). This is the number
      lender covenants typically reference and the value the briefing's
      headline reads.
    formula: >
      revenue_net
      + other_op_income_total
      + capitalized_own_work_memo
      - cogs_total
      - opex_total
      - personnel_total
    excludes: [dap_total, financial_income_net, income_tax]
    note: "Cash + non-cash operating items both included; D&A excluded."

  strict:
    description: >
      Reported EBITDA stripped of non-recurring AND non-cash operating
      credits. This is the conservative valuation basis — strips
      provision reversals (non-cash), 758 one-off operating income,
      grants, and disposal gains. PE diligence teams typically anchor
      to this view.
    base: reported
    subtract:
      - other_operating_income_one_off
      - government_grants_recognized
      - gain_loss_disposal_ppe
      - provision_reversals
      - fx_gain_unrealized
    add: []
    note: "Lenders and PE diligence reference this. The narrow strip."

  cash:
    description: >
      EBITDA measured on a strict cash basis — strips ALL non-cash
      operating items (provision charges + reversals, unrealized FX,
      inventory variation memo, capitalized own-work). This is the
      operator's "what hit the bank" view.
    base: reported
    subtract:
      - capitalized_own_work_memo
      - inventory_variation_memo
      - provision_reversals
      - fx_gain_unrealized
    add:
      - provision_charges
      - fx_loss_unrealized
      - impairment_receivables
    note: >
      Re-adds non-cash CHARGES (provisions, unrealized FX losses,
      receivable impairments) because they're already net-excluded
      from reported. Net effect: pure cash EBITDA.

  adjusted:
    description: >
      Strict EBITDA + operator-curated add-backs (owner compensation
      normalization, related-party rent adjustments, non-recurring
      legal costs, etc.). The operator's per-period add-back list is
      stored on the financial_period row; this formula references it.
    base: strict
    add: [operator_addbacks]    # references period.operator_addbacks[]
    note: >
      Default add-back list empty; operator populates per-deal via the
      "Adjustments" panel. Every add-back row carries justification +
      timestamp for audit trail.

# ─── Industry overrides — point to industry-specific composition rules
# (optional; falls back to defaults above when no industry override).
industry_overrides:
  real_estate_developer:
    # Developers in pre-livrare phase: capitalize cost flows; EBITDA
    # is computed on RECURRENT operations only, not on the dev cycle.
    ebitda_variants.reported.formula: >
      revenue_rental_royalty
      + revenue_services
      + government_grants_recognized
      - opex_total
      - personnel_total
    note: "Construction P&L is BS-capitalized; EBITDA reflects recurring ops only."

# ─── Ratio definitions (sketch — fleshed out in F4.2) ────────────────
ratios:
  ebitda_margin_reported:
    formula: ebitda.reported / revenue_net
    units: ratio
    higher_is_better: true
  net_debt_to_ebitda_strict:
    formula: (lt_debt_bank + st_debt_bank + lt_lease_liabilities + st_lease_liabilities - cash_and_equivalents) / ebitda.strict
    units: ratio
    higher_is_better: false
  # ... full ratio set in F4.2 work
```

**Format properties:**
- Plain YAML — readable without a Python interpreter
- Every formula references canonical bucket names (no engine internals)
- Variants compose via `base:` references — changing `reported` propagates to `strict` and `cash` automatically
- Methodology version pinned per period in DB (`financial_periods.methodology_version`); every displayed number carries provenance
- Industry overrides at the bottom — same file, different formula per industry-key

---

## 7. Detection envelope contract

Every upload carries forward a metadata envelope from detection (Layer 0) through extraction (Layer 1) through canonical assembly (Layer 2) into methodology rendering (Layer 3). The envelope is the source of truth for "which methodology applies here."

```typescript
interface DetectionEnvelope {
  // Country detection (drives pack selection)
  country: {
    iso2: string;                    // "RO", "HU", "BG", "DE", ...
    confidence: number;              // 0.0 - 1.0
    evidence: string[];              // ["account codes match OMFP 1802", "header in Romanian"]
  };

  // Accounting standard detection (drives chart-of-accounts pack within country)
  standard: {
    code: string;                    // "ras_omfp_1802", "ifrs_eu", "us_gaap"
    confidence: number;
    evidence: string[];
  };

  // Document type (drives extraction path within pack)
  doc_type: {
    code: string;                    // "trial_balance", "statutory_f30_f10", "public_records_summary", "sku_dataset"
    confidence: number;
    evidence: string[];
  };

  // Industry (drives methodology overrides + benchmark selection)
  industry: {
    key: string;                     // "food_manufacturing", "real_estate_developer", ...
    caen_code: string | null;        // when available
    confidence: number;
    evidence: string[];
  };

  // Period / currency context
  currency: string;                  // ISO 4217: "RON", "EUR", "USD"
  fiscal_year_end: string;           // ISO date "2025-12-31"
  period_start: string;
  period_end: string;

  // Methodology pin — determines which YAML methodology file rendered
  // the displayed numbers. Stored on financial_periods at write time.
  methodology_version: string;       // "ro_ras_2025_v1"

  // Fan-out audit (when Layer 0 ran in fan-out mode under 3d)
  routing_decision: {
    mode: "fast_path" | "fan_out" | "operator_required";
    candidates_evaluated: Array<{
      pack_id: string;
      assembled_bs_drift_pct: number;
      unmapped_accounts: number;
      coverage_score: number;
      chosen: boolean;
    }>;
    operator_choice_required: boolean;  // true when min confidence < 60%
  };

  // F3.9 source-data quality (already-shipped; relocated here)
  source_data_quality: {
    raw_imbalance_pct: number;
    raw_imbalance_abs: number;
    warn: boolean;
  } | null;
}
```

**Where the envelope travels:**

1. **Upload time:** Layer 0 fills `country`, `standard`, `doc_type`, `industry`, `routing_decision`. Confidence scores feed the 3d threshold gating.
2. **Extraction:** Layer 1 adds `currency`, `fiscal_year_end`, `period_*`, `source_data_quality`. Picks the methodology version that matches `standard + fiscal_year_end`.
3. **Persistence:** envelope serialized as JSONB on `financial_periods.detection_envelope`. Read at every dashboard query so the FE can show provenance + the operator can audit "which methodology produced this number."
4. **API responses:** envelope returned alongside `assembled_*` views. FE renders a "Methodology: ro_ras_2025_v1 · Standard: RAS · Industry: food manufacturing" footer chip on every analysis page.

---

## 8. Deprecation list — current RAS-isms → canonical equivalents

Every entry: current field/bucket, new canonical name, migration step, deprecation horizon (minimum 2 quarters per §3e). Runtime warning emits in API responses when a consumer reads a deprecated field; field stays alive until the horizon.

### 8a. Bucket name renames (chart_of_accounts.py _BUCKET_TO_*_FIELD maps)

| Current bucket | Canonical (v1) | Notes | Horizon |
|---|---|---|---|
| `cash` | `cash_operating` | rolls up into `cash_and_equivalents` aggregate | 2026-Q4 |
| `cash_fx` | `cash_fx` (unchanged) | already canonical | n/a |
| `ar` | `ar_trade_gross` | the canonical splits gross / doubtful / provisions; current `ar` was net | 2026-Q4 |
| `ar_doubtful` | `ar_doubtful_gross` | clarify "gross" semantics | 2026-Q4 |
| `ar_provisions` | `ar_provisions` (unchanged) | already canonical | n/a |
| `ar_intercompany` | `ar_intercompany` (unchanged) | already canonical | n/a |
| `ap` | `ap_trade` | distinguish from `ap_intercompany`, `ap_tax`, `ap_personnel_*` | 2026-Q4 |
| `ap_dividends` | `ap_dividends` (unchanged) | already canonical | n/a |
| `stDebt` | `st_debt_bank` | distinguish from `st_debt_other`, `st_lease_liabilities` | 2026-Q4 |
| `ltDebt` | `lt_debt_bank` | same logic | 2026-Q4 |
| `ppe` | `ppe_net` (aggregate) — and split into leaves (`ppe_land`, `ppe_buildings`, ...) | wide-grained per §3a | 2027-Q1 |
| `ppe_investment` | `investment_property` | matches IAS 40 naming | 2027-Q1 |
| `ppe_under_construction` | `ppe_under_construction` (unchanged) | already canonical | n/a |
| `intangibles` | `intangibles_net` (aggregate) — and split into leaves (`intangibles_goodwill`, `intangibles_other`) | wide-grained per §3a | 2027-Q1 |
| `inventory` | `inventory_net` (aggregate) — and split into leaves | wide-grained per §3a | 2027-Q1 |
| `retainedEarnings` | `retained_earnings` (snake_case) — and split into leaves (`retained_earnings_prior_years`, `current_year_profit`, etc.) | normalize naming + wide-grained | 2027-Q1 |
| `shareCapital` | `share_capital` (snake_case) | normalize | 2026-Q4 |
| `otherEquity` | (split into `share_premium`, `legal_reserves`, `other_reserves`) | wide-grained | 2027-Q1 |
| `equity_revaluation` | `revaluation_reserves` | match IAS 16 naming | 2027-Q1 |

### 8b. assembled_pl field renames

| Current field | Canonical (v1) | Notes | Horizon |
|---|---|---|---|
| `operating_ebitda` | `ebitda.reported` (methodology view) | comes from methodology YAML, not chart_of_accounts source | 2027-Q1 |
| `ebitda_statutory` | (DELETE — replaced by `ebitda.reported`) | the "_statutory" suffix was RAS-specific naming | 2027-Q1 |
| `ebitda_statutory_with_711` | (DELETE — methodology layer handles 711) | inventory variation is an addback inside methodology | 2027-Q1 |
| `ebitda_cash` | `ebitda.cash` (methodology view) | move to methodology | 2027-Q1 |
| `core_ebitda` | `ebitda.strict` (methodology view) | rename to match the four-family naming | 2027-Q1 |
| `adjusted_ebitda` | `ebitda.adjusted` (methodology view) | move to methodology | 2027-Q1 |
| `inventoryVariationMemo` | `inventory_variation_memo` (snake_case, kept as memo) | normalize naming | 2027-Q1 |
| `capitalizedOwnWork` | `capitalized_own_work_memo` (snake_case, kept as memo) | normalize naming | 2027-Q1 |
| `net_income_statutory` | `net_income` | drop the "_statutory" suffix; one net income, anchored to account 121 in RAS but to a country-pack-specific anchor elsewhere | 2027-Q1 |
| `net_income_operational` | (DELETE — same as `net_income` post-canonical) | the "_operational" variant was a RAS-specific scratch field | 2027-Q1 |

### 8c. Engine internals

| Current symbol | Replacement | Notes | Horizon |
|---|---|---|---|
| `_BUCKET_TO_BS_FIELD` / `_BUCKET_TO_PL_FIELD` maps in chart_of_accounts.py | Layer-2 canonical schema module (new) | the maps become the country-pack's per-bucket router | 2027-Q1 |
| `MappingRule` dataclass | `BucketRoute` (new) — extends with `sign_meaning`, `parent_aggregate` | richer per-rule metadata | 2027-Q1 |
| Defensive-flip logic at chart_of_accounts.py:1021 | (DELETE — replaced by always-positive convention) | scar tissue removed once §3b migration completes | 2027-Q2 |
| `SIDE_FLIP_TO_LIAB_PREFIXES` in trial_balance_parser.py | (DELETE — same reason) | scar tissue removed | 2027-Q2 |

---

## 9. Open second-order questions surfaced by this draft

These didn't get full answers during F4.0 drafting; they're real design questions that need addressing before F4.1 implementation. Flagged here so they don't surprise us mid-migration.

1. **Right-of-use assets vs operating PPE under IFRS 16 transition.** A Romanian entity that adopts IFRS in year N+1 will have year-N comparatives without ROU + year-N+1 with ROU. The canonical schema has `right_of_use_assets` as a separate bucket — does the year-N comparative show ROU as zero (cleaner) or as-restated (more useful for trend analysis)? Recommendation: **as-reported**, with a `restated: bool` field on the period envelope so the FE can disclose.

2. **Goodwill: amortized (RAS) vs impaired (IFRS).** The bucket `intangibles_goodwill` is universal, but the EXPENSE side bifurcates: RAS books `amortization_intangibles` (which includes goodwill), IFRS books `impairment_goodwill` (separate from amortization, only when impaired). Methodology layer can normalize, but the underlying engine emits per the country pack's rule. **Decision needed:** does the canonical schema accept that goodwill expense is "amortization in RAS, impairment in IFRS" (operator-friendly, asymmetric) or force both packs to emit `impairment_goodwill` (purer, requires RAS pack to reclassify)?

3. **Deferred tax under RAS SME opt-out.** Romanian micro-companies (revenue < EUR 500k) opt out of deferred tax recognition entirely. The canonical bucket `deferred_tax_assets` / `deferred_tax_liabilities` will be zero for these entities. **Decision needed:** does the methodology layer emit a "not applicable" marker (operator sees grey-out + tooltip "deferred tax not recognized under RAS SME opt-out") or just zero (cleaner, but operator might think the company simply has no deferred tax positions)?

4. **Currency-of-record vs presentation currency.** Today the engine assumes RON everywhere. Multi-country support means a Hungarian subsidiary of a Romanian parent could file in HUF locally but report in RON to parent. **Decision needed:** does `currency` in the detection envelope mean functional or presentation? Recommend functional (the currency the entity transacts in); presentation currency lives on a separate `presentation_currency` field that the FE can flip per dashboard view.

5. **Fan-out cost ceiling under §3d.** Confidence-based fan-out (60-85% range) doubles parse + assembly cost for ambiguous uploads. **Decision needed:** is there a per-upload cost ceiling (e.g., "fan-out caps at 2 packs"), and does the ceiling interact with the operator's quota system (one fan-out counts as one upload, or as N)?

6. **Methodology versioning across periods.** If an entity has 5 years of periods, all originally produced under `ro_ras_2025_v1`, and then we release `ro_ras_2025_v2` with a refined EBITDA formula, do the old periods re-render under v2 (so trends are comparable) or stay pinned at v1 (so historicals are stable)? **Recommendation:** stay pinned at v1 by default; offer a "re-render trend lines under v2" toggle for trend views.

7. **OCI accumulation under partial-IFRS adoption.** A RAS entity that adopts IFRS only for consolidated reporting will have NO OCI in solo statements but SOME OCI in consolidated. Bucket `accumulated_oci` must distinguish or accept the asymmetry. **Decision needed:** does each period know its reporting basis (`solo` vs `consolidated`) and emit OCI conditionally, or do we always emit zero in solo and only populate in consolidated?

---

## 10. Migration roadmap (F4.x sketch)

| Chunk | Scope | Risk | Estimate |
|---|---|---|---|
| **F4.0** | This document. Design only. | None — pure design artifact. | 1 session (done) |
| **F4.1** | RO pack emits Layer-2 canonical alongside existing surface. New JSONB column `assembled_canonical_v1` on `financial_periods`. F3.1-PARITY preserved on the legacy surface. | Medium. Touches every BS bucket. Per §3e parallel migration. | 4-6 chunks |
| **F4.2** | Methodology layer wired up. First methodology file `ro_ras_2025_v1.yaml`. Engine becomes a methodology-reader. Briefing prompts pinned to methodology version. | Medium. Affects every EBITDA / ratio. Operator-visible: side-by-side rendering of "v1 vs current" until cutover. | 3-4 chunks |
| **F4.3** | Detection envelope. Layer 0 emits the JSONB envelope at upload time. FE shows methodology + standard + country chips. | Low. Mostly additive. | 2-3 chunks |
| **F4.4** | Confidence-based fan-out routing per §3d. Operator-required surfacing for <60% confidence. | Medium. Requires upload classifier overhaul. | 3-4 chunks |
| **F4.5** | Second country pack (HU or BG). Forces every design assumption to a real test. Standardize the country-pack template. | High. Where the schema's cross-standard discipline is tested. | 6-8 chunks |
| **F4.6** | Deprecation horizon: emit `deprecated_fields` warnings on all old surface. Operator dashboard banner "Update consumers by 2026-Q4". | Low. Communication, not engineering. | 1 chunk |
| **F4.7** | Old-surface deletion (after 2-quarter horizon). | Medium. Final cleanup; F3.1-PARITY retires once all consumers migrated. | 2-3 chunks |

**Total F4 sprint:** 22-30 chunks at F3-cadence (~6-10 weeks). Most of the value lands at F4.2 (methodology externalized) and F4.5 (second country pack — the schema's real test).

---

## 11. Discipline notes

- Every bucket in §3-§5 was validated against three standards (RAS / IFRS / US-GAAP). Any future bucket addition must include the same three-mapping table before it lands in the canonical schema.
- The methodology format spec in §6 is intentionally minimal. Adding methodology features (industry overrides, conditional formulas, etc.) is allowed; **removing canonical bucket references in favor of methodology-specific shortcuts is forbidden** — that breaks the round-trip property that makes the schema auditable.
- The deprecation horizons in §8 are minimums. Operator can extend any horizon at any time. Operator cannot shorten a horizon below 2 quarters from announcement without explicit chat-authorization (per §3e migration discipline).
- Open questions in §9 are flagged for follow-up in subsequent F4.x chunks. They do NOT block F4.1 implementation — F4.1 can use sensible defaults and revisit. Decision authority for each question stays with the operator.

— Romania pack lead, F4.0 design draft, 2026-05-23
