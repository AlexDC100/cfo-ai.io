# public_market fixtures — REAL BYTES provenance

Policy: adapters that parse an external format are tested against real bytes
fetched live from the source, never against idealized hand-written samples
(this repo has been burned twice by spec-label/BOM drift in invented fixtures).

Both files below are **untouched subsets** of live SEC responses: every kept
value, key, and key order is verbatim from the origin bytes. The only
transformation is *omission* (documented per file) plus compact JSON
re-serialization (`separators=(",", ":")` — the SEC serves compact JSON too;
no whitespace-sensitive consumer exists).

Fetched: **2026-08-29 ~20:53 UTC**, HTTP 200, with the declared User-Agent
`cfo-ai.io engine (contact: ad.crestin@gmail.com)` (SEC fair-access guidance:
declare your user agent; max 10 requests/second).

## companyfacts_CIK0000320193_truncated.json

Source: `https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json`
(Apple Inc., CIK 320193). Full response: 3,789,099 bytes; truncated: ~85 KB.

Truncation rules (subset-only, no value edits):

| Kept | Fact filter | Why |
|---|---|---|
| dei: EntityCommonStockSharesOutstanding, EntityPublicFloat | end >= 2022-01-01 | shares mapping + distractor |
| us-gaap: RevenueFromContractWithCustomerExcludingAssessedTax, NetIncomeLoss, Assets, StockholdersEquity, LongTermDebtCurrent, LongTermDebtNoncurrent, CommercialPaper | end >= 2022-01-01 | mapped chain members |
| us-gaap: Revenues | **all facts kept** | REAL stale-concept case: Apple's `Revenues` facts stop at 2018-09-29 while RFCWCEAT runs on — exercises the period-anchored chain; also contains genuine quarterly spans mislabeled `fp="FY"` (e.g. 2018-04-01..2018-06-30), exercising the annual-span guard |
| us-gaap: SalesRevenueNet | end >= 2016-01-01 | legacy chain member (tail of its life) |
| us-gaap: LongTermDebt | end >= 2022-01-01 | documented-EXCLUDED neighbor (double-count trap: includes current portion) |
| us-gaap: AccountsPayableCurrent, CashAndCashEquivalentsAtCarryingValue, OperatingIncomeLoss, Liabilities | end >= 2022-01-01 | distractors — must never leak into the IR |
| us-gaap: RetainedEarningsAccumulatedDeficit | end >= 2022-01-01 | **added 2026-09-05** from a fresh fetch of the same URL (HTTP 200, 3,789,099 bytes — byte-count identical to the 2026-08-29 response; sha256 73a86c6aedc31f77cac2ea4df5f80f0b3bd7e6eb58bb4e01444fbedf3afb9c43). Appended as the LAST us-gaap key; the first 85,508 bytes of the file are the previous fixture's bytes unchanged (asserted at regeneration). Apple tags this and ONLY this retained-earnings concept: no RetainedEarningsAppropriated / Unappropriated, no AccumulatedDistributionsInExcessOfNetIncome. 33 USD facts kept; the FY2025 10-K instant at 2025-09-27 is **-14,264,000,000** (an accumulated deficit — negative, and it must stay negative) under accession 0000320193-25-000079 |

All other concepts (488 of 503 us-gaap) omitted. Top-level `cik`,
`entityName`, and each kept concept's `label`/`description` preserved verbatim.

Notable real values used as test anchors (FY2025 10-K, accession
`0000320193-25-000079`, filed 2025-10-31, period end 2025-09-27):
revenue 416,161,000,000 USD; net income 112,010,000,000; assets
359,241,000,000; equity 73,733,000,000; LongTermDebtCurrent 12,350,000,000;
CommercialPaper 7,979,000,000; LongTermDebtNoncurrent 78,328,000,000;
RetainedEarningsAccumulatedDeficit -14,264,000,000 (cross-checked 2026-09-04
against the live Sharadar-normalised body of `/api/public/companies/AAPL`,
whose `unmapped[].retained_earnings.amount` is the same -14,264,000,000).

## company_tickers_truncated.json

Source: `https://www.sec.gov/files/company_tickers.json`. Full response:
795,179 bytes / 10,391 entries; truncated to the **first 25 entries**
(keys "0".."24", original object shape preserved). Includes AAPL (key "1",
cik_str 320193) which the tests resolve against.

## Regenerating

Fetch the two URLs above with the declared User-Agent (one request each,
sleep >= 1s between), then re-apply the subset filters listed in the tables.
Update the fetch date here and any test anchors that moved (a new fiscal year
shifts the FY-anchor values by design — that is the adapter working).
