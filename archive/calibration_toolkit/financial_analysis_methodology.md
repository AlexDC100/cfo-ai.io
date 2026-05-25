# Comprehensive Financial Analysis Methodology

A reusable framework for producing CFO-grade financial analyses from Romanian trial balances (RAS) — 8 sections, end-to-end. Calibrated on the Scandia Food FY2025 case.

This document is the **map**. Read it first, then apply the framework by:
1. Following the eight-section structure (Section 4 below)
2. Using the RAS account-mapping cheat sheet (Section 3)
3. Running the Python implementation (`financial_analysis.py`) for the heavy compute
4. Filling the HTML template with the computed values

---

## 1. When to use this framework

This is the right framework for:

- **Romanian SME / mid-cap financial analysis** — anywhere you have a trial balance (balanță de verificare) and need a comprehensive read
- **Investment due diligence** — buy-side or sell-side analysis of operating companies
- **Annual review / board reports** — structured presentation of a fiscal year
- **Credit underwriting** — bank or non-bank lender risk assessment
- **Family-office portfolio reviews** — recurring analysis across multiple group entities

Not the right framework for:

- Real estate single-asset vehicles (use the NAV framework — `nav_methodology.md`)
- Pre-revenue startups (no operating history to ratio-analyze)
- Banks, insurance, regulated financial institutions (different account structure)
- Pure holding companies with no operations (NAV-only)

Rule of thumb: if the entity has ≥ 12 months of operating P&L activity (class 6/7 accounts populated) and a meaningful balance sheet (>500K RON total assets), use this framework.

---

## 2. The eight sections — what each one delivers

Every analysis produces these eight sections, in this order. Each builds on the prior.

| § | Section | Purpose | Input | Output |
|---|---|---|---|---|
| 1 | **Overview** | Executive summary, KPI dashboard, company snapshot | Raw trial balance | 8 headline KPIs + narrative |
| 2 | **P&L** | Statutory P&L reconstruction from class 6/7 movements | Class 6 (D) + Class 7 (C) sums | Full income statement |
| 3 | **Balance Sheet** | Assets / Equity-Liabilities from closing balances | Classes 1–5 closing balances | Full balance sheet |
| 4 | **Cash Flow** | Indirect method from P&L + BS changes | P&L + period-end balances | CFO/CFI/CFF reconciliation |
| 5 | **Ratios** | 25+ ratios across 5 dimensions | P&L + BS | Profitability/liquidity/leverage/coverage/efficiency |
| 6 | **Valuation** | Multi-method valuation envelope | EBITDA + balance sheet | EV/EBITDA + DCF + NAV cascade |
| 7 | **Risk & Credit** | Composite credit score, Altman Z″, risk inventory | All prior sections | 0–100 composite score + risk list |
| 8 | **Recommendations** | Prioritized action items | All prior sections | 5–8 ranked recommendations |

The flow is sequential: P&L feeds ratios feeds valuation feeds credit feeds recommendations. Don't skip steps.

---

## 3. Romanian RAS account-mapping cheat sheet

This is the universal mapping. Every Romanian trial balance follows this structure.

### Class 1 — Capital, reserves, long-term debt (Credit balance)
| Prefix | Meaning | Where it goes |
|---|---|---|
| 101 / 1012 | Share capital (paid-in) | Equity |
| 104 | Share premium / merger premium | Equity |
| 105 | Revaluation reserve | Equity |
| 106 / 1061 / 1068 | Legal & other reserves | Equity |
| 117 / 1171 / 1174 | Retained earnings (1171 credit, 1174 debit) | Equity (net) |
| 121 | Profit & loss account (closing C = net profit) | Equity |
| 129 | Profit distribution | Equity (offset) |
| 15x | Provisions (litigation, decommissioning) | LT liabilities |
| 162 | LT bank loans | LT debt |
| 167 | Leasing obligations | LT debt |
| 168 | Accrued LT interest | LT debt |

### Class 2 — Fixed assets (Debit balance)
| Prefix | Meaning | Where it goes |
|---|---|---|
| 205 / 208 | Intangibles (licenses, software, etc.) | Intangibles gross |
| 211 | Land & site improvements | PP&E gross |
| 212 | Buildings | PP&E gross |
| 213 (2131/2132/2133) | Equipment (technological, measurement, transport) | PP&E gross |
| 214 | Furniture & office | PP&E gross |
| 215 | Investment property | PP&E (separate) |
| 23x | Construction in progress (CIP) | Non-current |
| 261 | Shares in affiliates | Financial fixed |
| 263 | Other equity interests | Financial fixed |
| 265 / 267 | Other LT investments / receivables | Financial fixed |
| 28x | Accumulated depreciation/amortization (Credit) | Contra-asset |

### Class 3 — Inventory (Debit balance)
| Prefix | Meaning | Where it goes |
|---|---|---|
| 301 / 302 / 303 | Raw materials, consumables, small inventory | Inventory |
| 32x | Inventory in transit | Inventory |
| 331 / 341 | WIP, semi-finished | Inventory |
| 345 | Finished products | Inventory |
| 348 / 378 | Price differentials (D or C) | Inventory adjustment |
| 351 / 357 | Inventory at third parties | Inventory |
| 371 | Merchandise (for resale) | Inventory |
| 381 | Packaging | Inventory |
| 39x | Inventory provisions (Credit) | Contra-asset |

### Class 4 — Receivables / Payables (Mixed)
| Prefix | Meaning | Where it goes |
|---|---|---|
| 401 | Trade payables (domestic) | ST liability |
| 403 | Notes payable | ST liability |
| 404 / 405 | Fixed asset payables | ST liability |
| 408 | Invoices not received | ST liability |
| 409 | Supplier advances (Debit) | Receivable |
| 411 | Trade receivables (D) | Receivable |
| 413 | Notes receivable (D) | Receivable |
| 418 | Customer accruals | Receivable or liability (C = liability) |
| 419 | Customer advances | ST liability |
| 42x (421/423/425/427/428) | Personnel-related (mostly C) | ST liability |
| 43x | Social security (mixed; usually C) | ST liability |
| 44x | State / tax (mixed) | ST liab if C, receivable if D |
| 45x (451/452/455) | Affiliated parties (mixed) | Group rec/pay |
| 457 | Dividends payable | ST liability |
| 46x | Other debtors/creditors | Receivable or liability |
| 471 | Prepaid expenses (D) | Receivable |
| 472 | Deferred revenue (C) | ST liability |
| 475 | Investment subsidies (C) | LT liability |
| 478 | Grants (C) | LT liability |
| 49x | Receivables provisions (C) | Contra-asset |

### Class 5 — Cash & equivalents (Debit balance)
| Prefix | Meaning | Where it goes |
|---|---|---|
| 5121 | Bank accounts in RON | Cash |
| 5124 | Bank accounts in FX | Cash |
| 519 | ST bank loans (Credit) | ST debt |
| 531 | Petty cash | Cash |
| 541 / 542 | Other cash | Cash |
| 581 | Internal transfers (should net to ~0) | Cash |

### Class 6 — Expenses (Debit movements)
| Prefix | Meaning |
|---|---|
| 601 | Raw materials |
| 602 | Auxiliary materials / consumables |
| 603 | Inventory items (small tools) |
| 604 | Non-storable materials |
| 605 | Utilities (electricity, gas, water) |
| 607 | Cost of merchandise sold |
| 608 | Packaging |
| 61x | Maintenance, rent, insurance |
| 62x | External services (logistics, marketing, consulting) |
| 63x | Other taxes & levies |
| 64x | Personnel (641 salaries, 645 social) |
| 65x | Other operating expenses |
| 665 | FX losses |
| 666 | Interest expense |
| 667 | Discounts paid |
| 668 | Other financial expenses |
| 681 | Depreciation & amortization |
| 69x | Income tax |

### Class 7 — Revenue (Credit movements)
| Prefix | Meaning |
|---|---|
| 701 | Sale of finished products |
| 702 | Sale of semi-finished |
| 703 | Sale of residues |
| 704 | Sale of services |
| 705 | Studies/research |
| 706 | Rent / royalties |
| 707 | Sale of merchandise |
| 708 | Activity revenue / discounts received from suppliers |
| 709 | **Commercial reductions to customers (contra-revenue)** |
| 711 / 712 | Production variation (nets D vs C) |
| 72x | Capitalized own work |
| 758 | Other operating revenue |
| 761 | Income from affiliates / dividends |
| 765 | FX gains |
| 766 | Interest income |
| 768 | Other financial income |
| 781 | Operating provision reversals |

### Critical reconciliation points

1. **Trial balance must balance**: Sum of all `sume_totale_D` must equal Sum of all `sume_totale_C`. If not, the data feed is broken — stop and re-extract.
2. **Net profit anchor**: The closing C balance of account 121 IS the statutory net profit. Reconstruct from class 6/7 and check within ±2%; if larger gap, find the missing accounts.
3. **709 is contra-revenue**: Class 70 sum already nets 709. Don't subtract it twice.
4. **711 nets to ~0**: Production variation movements offset between debit (production consumed) and credit (production stored). Net is the change in WIP/finished inventory.
5. **Class 44 is mixed**: VAT receivable (442x debit) is an asset; income tax payable (441 credit) is a liability. Don't sum them as one.

---

## 4. The eight sections — detailed methodology

### Section 1: Overview

**Purpose:** A 30-second read of the company. KPI dashboard + narrative.

**The 8 headline KPIs**:
1. Net Turnover (cifra de afaceri)
2. EBITDA + margin %
3. Net Profit + margin %
4. Total Assets
5. Equity Ratio (E/A)
6. Net Debt / EBITDA
7. ROE
8. Altman Z″ Score

**Narrative structure (3-4 sentences):**
- Company snapshot (industry, scale, ownership type from share capital line)
- Profitability verdict (compare margins to industry — use Section 5 benchmarks)
- Capital structure verdict (equity ratio + leverage)
- Key forward concern or strength

---

### Section 2: P&L Reconstruction

**Purpose:** Build the full income statement from class 6 (Debit movements) and class 7 (Credit movements).

**Algorithm:**

```
1. Net Turnover = Σ(class 70 Credit movements)
2. Other operating revenue: 758 + 781 + (711_C - 711_D) + 72x
3. Total operating revenue = Net Turnover + Other operating revenue
4. Operating expenses (sum class 60-65, 68)
5. EBIT = Operating revenue - Operating expense
6. EBITDA = EBIT + D&A (681)
7. Financial result: (761+765+766+768) - (665+666+667+668)
8. PBT = EBIT + Net financial
9. Income tax = sum class 69 Debit
10. Net profit (reconstructed) = PBT - Tax

RECONCILIATION:
  Reconstructed net profit must match closing C of account 121 ±2%.
  If gap > 2%, search for missing accounts in class 6/7.
```

---

### Section 3: Balance Sheet

**Purpose:** Build the closing balance sheet from classes 1-5 closing balances.

Detailed algorithm in `financial_analysis.py:build_balance_sheet()`. Key sub-aggregates:

- **Non-current assets:** intangibles (205/208 net of 280), PP&E (211/212/213/214 net of 281), CIP (23x), financial fixed (26x)
- **Current assets:** inventory (3xx gross net of 39x provisions), receivables (411 + class 4 debit-side), cash (512/531/541/542 net of 581)
- **Equity:** 101 + 104 + 105 + 106 + 117 + 121
- **LT liabilities:** 15x provisions + 162 bank + 167 leasing + 168 interest + 475 subsidies + 478 grants
- **ST liabilities:** 519 ST bank + 401/403/404/405/408 trade + 42x personnel + 43x social + 44x tax + 457 dividends + 462 + 451/452/455 + 419 + 472

**Reconciliation target:** Total Assets = Total Equity + Liabilities ±0.5%.

---

### Section 4: Cash Flow Statement

**Purpose:** Reconstruct cash flow via indirect method.

**Required input:** Both opening (Dec prior year) AND closing trial balances. If only closing available, mark working capital changes as `~approximated` with ±15% uncertainty band.

```
OPERATING: Net profit + D&A + provisions ± WC changes
INVESTING: −Capex (Δ PP&E gross) − Δ CIP − Δ affiliates + dividends received + interest received
FINANCING: Δ LT debt + Δ ST bank − interest paid − dividends paid + capital increases
```

---

### Section 5: Financial Ratios

**Profitability (6):** EBITDA margin, EBIT margin, Net margin, Gross margin, ROE, ROA, ROIC
**Liquidity (4):** Current ratio, Quick ratio, Cash ratio, Working capital
**Leverage (5):** Equity ratio, D/E, LT D/E, Net Debt / EBITDA, Debt / Assets
**Coverage (3):** Interest coverage, EBITDA / Interest, DSCR
**Efficiency (6):** Asset turnover, Inventory turnover, DIO, DSO, DPO, CCC

---

### Section 6: Valuation

**Method selection:**
- Real estate / holding → NAV primary
- Food / consumer / services → EV/EBITDA primary
- Tech / high growth → DCF primary

**Always include:** EV/EBITDA at 6×/8×/10×, DCF with Gordon terminal, NAV (4-layer cascade), Book equity floor.

**WACC build-up (Romania):**
- Rf = 6.5-7.5% (RO 10Y govt)
- ERP = 7-8% (Damodaran emerging markets)
- Beta = industry-typical
- Cost of debt = 5.5-7.5% after-tax
- WACC = Equity weight × Ke + Debt weight × Kd × (1 - 0.16)

---

### Section 7: Risk & Credit Rating

**Altman Z″ (emerging-markets variant):**
```
Z" = 6.56·X1 + 3.26·X2 + 6.72·X3 + 1.05·X4
  X1 = (CA − CL) / Total Assets
  X2 = Retained Earnings / Total Assets
  X3 = EBIT / Total Assets
  X4 = Book Equity / Total Liabilities

  Z" > 2.60     → SAFE
  1.10 ≤ Z" ≤ 2.60 → GREY
  Z" < 1.10     → DISTRESS
```

**Composite credit (0-100, weighted):**
- 30% Altman Z″
- 20% Profitability (ROE + Net margin)
- 15% Leverage (lower D/E = higher)
- 10% Interest coverage
- 10% DSCR
- 10% Liquidity (current + quick + cash avg)
- 5% Equity ratio

**Letter grades:**
- 90-100 → AAA / AA
- 80-89 → A
- 70-79 → BBB
- 60-69 → BB
- 50-59 → B
- 40-49 → CCC
- <40 → CC / C / D

---

### Section 8: Recommendations

5-8 prioritized items. Each must:
- Address a specific finding from Sections 5-7
- Have measurable impact (RON or pp improvement)
- Be feasible (no "double EBITDA" platitudes)

Distribution: 1-2 Critical / 2-3 High / 2-4 Medium.

**Per-recommendation format:**
```
[Severity tag]
[Numbered title]
- Why: 1-2 sentences linking to finding
- Action: 2-3 sentences with concrete steps
- Impact: Quantified outcome
```

---

## 5. Common errors

| Error | Symptom | Fix |
|---|---|---|
| Trial balance doesn't balance | Sum D ≠ Sum C | Re-extract source |
| Net profit >5% off from 121 | Missing class 6 or 7 accounts | Search for unusual prefixes |
| Balance sheet >1% off | Misclassified mixed accounts | Net debit/credit per account |
| Negative inventory | 39x provisions > gross | Check 39x columns |
| Negative cash | 519 ST debt netted into class 5 | Separate 512/531 from 519 |
| Affiliates 261 = 0 but 761 income | Investment classification issue | Check 263 / 265 |
| Class 44 net negative | Mixed VAT receivable + tax payable | Split 442x asset, 441 liability |
| Foreign / IFRS data | Different account structure | RAS-specific framework only |

---

## 6. Calibration: the Scandia Food example

Reference values (FY2025):

| Metric | Value |
|---|---|
| Trial balance total | 460,963,810 RON (balanced ✓) |
| Accounts active | 809 |
| Net turnover | 413,727,560 |
| EBITDA | 54,443,834 (13.2% margin) |
| Net profit (121 closing) | 36,787,353 |
| Reconstructed net profit | 36,267,964 (gap 1.4%, acceptable) |
| Total assets | 293,050,085 (reconciled within 0.5%) |
| Total equity | 150,151,551 (51.2% equity ratio) |
| Altman Z″ | 3.09 (safe zone) |
| Composite credit | 82/100 → A− |
| Valuation range | 380-500M RON (EV/EBITDA 6-10×) |

Sanity-check rule: if a similar-size food manufacturer comes back with Z″ <2 or composite <65, double-check the data; it's an outlier.
