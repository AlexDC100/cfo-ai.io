# Forecast blast radius (plan/2)

What the default `GET /api/forecast/{period_id}?horizon=5` serves, per plan
year, against the baseline recorded before any plan/2 batch changed the engine
(plan_contract_v2 1.9, ruling R1). Produced by
`python scripts/measure_plan_blast_radius.py --markdown`; the script measures
and never asserts. Every batch that changes a served base figure (B2, B3, B4,
B7) appends its output below its own anchor in the same commit. The owner
receives the cumulative table before the Scenarios cut-over (B13) and before
the forecast flag flips (B21); those commits cite this file.

Columns: revenue and EBITDA are sums over the plan year's periods; closing
cash is `bs.cash` in its last period; peak funding the largest `bs.revolver`
inside the year; first shortfall the first period of the year in which the
funding line draws. Amounts are integer minor units printed with two decimals.

The baseline is `tests/engine/fixtures/forecast/base_get_b0.json` (the
delta-mode reference of contract 5.3): every line of every period in minor
units, from `engine.forecast.project_payload(book, horizon_years=5)` in
process with no overrides, on the committed books. Scandia is measured locally
only (`--local-xlsx`, aggregates printed, never committed).

<!-- ═══ B0 baseline ═════════════════════════════════════════════════════ -->

## B0 — baseline on main at 1944109

Recorded 2026-09-15 on `wave/plan-b0` (parent 1944109). The GET was reached
through `create_app()` with the route's own loader, statement rebuild from the
committed `statement_line_items` rows, engine, adapter, contract and boundary
guard; every delta below is 0, which is the evidence that the engine-in-process
baseline and the served GET are the same numbers on today's tree (100 of 100
cells equal). All four books answer 200 at horizon 5. Recording the baseline
twice, and once with `PYTHONHASHSEED=7`, gave byte-identical files (sha1
76a4df84d78c2a69a0b7b0cc4165d2dd59a692c2).

Facts a later batch will move, stated so the move is legible: base revenue
growth is 0 on every book (the single-period `engine_default` rung R1 replaces
in B3), so revenue is flat across plan years; realestate draws the funding line
from 2026-01 and in every later year (peak 171,693,460.04 in plan year 5);
carniprod does not draw at the default GET on this tree, although contract S3
names carniprod as the book whose base plan reaches the partial refusal of 6.5
(that is measured again when B5 lands `stop_at_unpriced_draw`).

### agras  GET status 200
| plan year | metric | baseline B0 | now | delta |
|---|---|---:|---:|---:|
| 1 | revenue | 118,576,819.64 | 118,576,819.64 | 0 |
| 1 | EBITDA | 18,420,553.26 | 18,420,553.26 | 0 |
| 1 | closing cash | 14,253,382.76 | 14,253,382.76 | 0 |
| 1 | peak funding | 0.00 | 0.00 | 0 |
| 1 | first shortfall | none | none | same |
| 2 | revenue | 118,576,819.64 | 118,576,819.64 | 0 |
| 2 | EBITDA | 18,420,553.20 | 18,420,553.20 | 0 |
| 2 | closing cash | 27,338,717.43 | 27,338,717.43 | 0 |
| 2 | peak funding | 0.00 | 0.00 | 0 |
| 2 | first shortfall | none | none | same |
| 3 | revenue | 118,576,819.64 | 118,576,819.64 | 0 |
| 3 | EBITDA | 18,420,553.20 | 18,420,553.20 | 0 |
| 3 | closing cash | 40,452,739.96 | 40,452,739.96 | 0 |
| 3 | peak funding | 0.00 | 0.00 | 0 |
| 3 | first shortfall | none | none | same |
| 4 | revenue | 118,576,819.64 | 118,576,819.64 | 0 |
| 4 | EBITDA | 18,420,553.20 | 18,420,553.20 | 0 |
| 4 | closing cash | 53,509,711.43 | 53,509,711.43 | 0 |
| 4 | peak funding | 0.00 | 0.00 | 0 |
| 4 | first shortfall | none | none | same |
| 5 | revenue | 118,576,819.64 | 118,576,819.64 | 0 |
| 5 | EBITDA | 18,420,553.20 | 18,420,553.20 | 0 |
| 5 | closing cash | 66,594,797.91 | 66,594,797.91 | 0 |
| 5 | peak funding | 0.00 | 0.00 | 0 |
| 5 | first shortfall | none | none | same |

### carniprod  GET status 200
| plan year | metric | baseline B0 | now | delta |
|---|---|---:|---:|---:|
| 1 | revenue | 99,424,740.16 | 99,424,740.16 | 0 |
| 1 | EBITDA | 9,588,720.73 | 9,588,720.73 | 0 |
| 1 | closing cash | 15,275,007.90 | 15,275,007.90 | 0 |
| 1 | peak funding | 0.00 | 0.00 | 0 |
| 1 | first shortfall | none | none | same |
| 2 | revenue | 99,424,740.16 | 99,424,740.16 | 0 |
| 2 | EBITDA | 9,588,720.78 | 9,588,720.78 | 0 |
| 2 | closing cash | 20,425,145.65 | 20,425,145.65 | 0 |
| 2 | peak funding | 0.00 | 0.00 | 0 |
| 2 | first shortfall | none | none | same |
| 3 | revenue | 99,424,740.16 | 99,424,740.16 | 0 |
| 3 | EBITDA | 9,588,720.78 | 9,588,720.78 | 0 |
| 3 | closing cash | 25,597,677.52 | 25,597,677.52 | 0 |
| 3 | peak funding | 0.00 | 0.00 | 0 |
| 3 | first shortfall | none | none | same |
| 4 | revenue | 99,424,740.16 | 99,424,740.16 | 0 |
| 4 | EBITDA | 9,588,720.78 | 9,588,720.78 | 0 |
| 4 | closing cash | 30,726,977.98 | 30,726,977.98 | 0 |
| 4 | peak funding | 0.00 | 0.00 | 0 |
| 4 | first shortfall | none | none | same |
| 5 | revenue | 99,424,740.16 | 99,424,740.16 | 0 |
| 5 | EBITDA | 9,588,720.78 | 9,588,720.78 | 0 |
| 5 | closing cash | 35,877,055.09 | 35,877,055.09 | 0 |
| 5 | peak funding | 0.00 | 0.00 | 0 |
| 5 | first shortfall | none | none | same |

### realestate  GET status 200
| plan year | metric | baseline B0 | now | delta |
|---|---|---:|---:|---:|
| 1 | revenue | 162,365.46 | 162,365.46 | 0 |
| 1 | EBITDA | -29,038,838.13 | -29,038,838.13 | 0 |
| 1 | closing cash | 0.00 | 0.00 | 0 |
| 1 | peak funding | 30,022,209.80 | 30,022,209.80 | 0 |
| 1 | first shortfall | 2026-01 | 2026-01 | same |
| 2 | revenue | 162,365.46 | 162,365.46 | 0 |
| 2 | EBITDA | -29,038,838.13 | -29,038,838.13 | 0 |
| 2 | closing cash | 0.00 | 0.00 | 0 |
| 2 | peak funding | 62,287,548.32 | 62,287,548.32 | 0 |
| 2 | first shortfall | FY2027 | FY2027 | same |
| 3 | revenue | 162,365.46 | 162,365.46 | 0 |
| 3 | EBITDA | -29,038,838.13 | -29,038,838.13 | 0 |
| 3 | closing cash | 0.00 | 0.00 | 0 |
| 3 | peak funding | 96,580,574.35 | 96,580,574.35 | 0 |
| 3 | first shortfall | FY2028 | FY2028 | same |
| 4 | revenue | 162,365.46 | 162,365.46 | 0 |
| 4 | EBITDA | -29,038,838.13 | -29,038,838.13 | 0 |
| 4 | closing cash | 0.00 | 0.00 | 0 |
| 4 | peak funding | 133,000,427.16 | 133,000,427.16 | 0 |
| 4 | first shortfall | FY2029 | FY2029 | same |
| 5 | revenue | 162,365.46 | 162,365.46 | 0 |
| 5 | EBITDA | -29,038,838.13 | -29,038,838.13 | 0 |
| 5 | closing cash | 0.00 | 0.00 | 0 |
| 5 | peak funding | 171,693,460.04 | 171,693,460.04 | 0 |
| 5 | first shortfall | FY2030 | FY2030 | same |

### retail  GET status 200
| plan year | metric | baseline B0 | now | delta |
|---|---|---:|---:|---:|
| 1 | revenue | 79,510,264.65 | 79,510,264.65 | 0 |
| 1 | EBITDA | 220,163.89 | 220,163.89 | 0 |
| 1 | closing cash | 2,114,064.19 | 2,114,064.19 | 0 |
| 1 | peak funding | 0.00 | 0.00 | 0 |
| 1 | first shortfall | none | none | same |
| 2 | revenue | 79,510,264.65 | 79,510,264.65 | 0 |
| 2 | EBITDA | 220,163.92 | 220,163.92 | 0 |
| 2 | closing cash | 3,090,118.81 | 3,090,118.81 | 0 |
| 2 | peak funding | 0.00 | 0.00 | 0 |
| 2 | first shortfall | none | none | same |
| 3 | revenue | 79,510,264.65 | 79,510,264.65 | 0 |
| 3 | EBITDA | 220,163.92 | 220,163.92 | 0 |
| 3 | closing cash | 4,042,245.71 | 4,042,245.71 | 0 |
| 3 | peak funding | 0.00 | 0.00 | 0 |
| 3 | first shortfall | none | none | same |
| 4 | revenue | 79,510,264.65 | 79,510,264.65 | 0 |
| 4 | EBITDA | 220,163.92 | 220,163.92 | 0 |
| 4 | closing cash | 5,036,928.00 | 5,036,928.00 | 0 |
| 4 | peak funding | 0.00 | 0.00 | 0 |
| 4 | first shortfall | none | none | same |
| 5 | revenue | 79,510,264.65 | 79,510,264.65 | 0 |
| 5 | EBITDA | 220,163.92 | 220,163.92 | 0 |
| 5 | closing cash | 6,012,823.50 | 6,012,823.50 | 0 |
| 5 | peak funding | 0.00 | 0.00 | 0 |
| 5 | first shortfall | none | none | same |


<!-- ═══ plan/2 B2 ═══════════════════════════════════════════════════════ -->

## B2 — timeline and year-to-date tax

Measured 2026-09-15 on `wave/plan-b2` (parent `wave/plan-b0` eb2ff8f) with
`python scripts/measure_plan_blast_radius.py --markdown`. B2 changes how
income tax is charged inside a plan year (contract 6.3: tax on the
year-to-date pre-tax result less tax already charged that year, one rounding
per period) and moves the horizon out of the driver set into `project()`'s
arguments (2.2). All four books answer 200 at horizon 5, and every plan-year
cell below is unchanged (100 of 100 deltas 0 / same).

What did move, below this table's resolution, is printed cell by cell by the
`forecast-base-parity` gate (delta mode against `base_get_b0.json`): 135
monthly cells on agras (55), carniprod (25) and retail (55) moved by exactly
one minor unit (75 by -1, 60 by +1), all inside the tax closure
(`pl.income_tax`, `pl.net_income`, `cf.net_income`, the cash roll and
`bs.equity_retained`), in the months 2026-02 to 2026-11 only. Every plan-year
total of every line is identical to the baseline: per-period rounding of a
positive monthly result telescopes to the same annual charge that one
year-to-date rounding gives. Realestate is loss-making in every period and is
charged no tax either way, so nothing on it moved. No book carries a loss
month inside a profitable year, so the in-year reversal the new rule allows is
exercised only by the constructed cases of
`tests/engine/test_forecast_timeline_tax.py`.

PLAN BLAST RADIUS — default GET /api/forecast/{id}?horizon=5, per plan year, against base_get_b0.json
scope: books agras, carniprod, realestate, retail; amounts in minor units shown as currency with two decimals; this script never asserts
### agras  GET status 200
| plan year | metric | baseline B0 | now | delta |
|---|---|---:|---:|---:|
| 1 | revenue | 118,576,819.64 | 118,576,819.64 | 0 |
| 1 | EBITDA | 18,420,553.26 | 18,420,553.26 | 0 |
| 1 | closing cash | 14,253,382.76 | 14,253,382.76 | 0 |
| 1 | peak funding | 0.00 | 0.00 | 0 |
| 1 | first shortfall | none | none | same |
| 2 | revenue | 118,576,819.64 | 118,576,819.64 | 0 |
| 2 | EBITDA | 18,420,553.20 | 18,420,553.20 | 0 |
| 2 | closing cash | 27,338,717.43 | 27,338,717.43 | 0 |
| 2 | peak funding | 0.00 | 0.00 | 0 |
| 2 | first shortfall | none | none | same |
| 3 | revenue | 118,576,819.64 | 118,576,819.64 | 0 |
| 3 | EBITDA | 18,420,553.20 | 18,420,553.20 | 0 |
| 3 | closing cash | 40,452,739.96 | 40,452,739.96 | 0 |
| 3 | peak funding | 0.00 | 0.00 | 0 |
| 3 | first shortfall | none | none | same |
| 4 | revenue | 118,576,819.64 | 118,576,819.64 | 0 |
| 4 | EBITDA | 18,420,553.20 | 18,420,553.20 | 0 |
| 4 | closing cash | 53,509,711.43 | 53,509,711.43 | 0 |
| 4 | peak funding | 0.00 | 0.00 | 0 |
| 4 | first shortfall | none | none | same |
| 5 | revenue | 118,576,819.64 | 118,576,819.64 | 0 |
| 5 | EBITDA | 18,420,553.20 | 18,420,553.20 | 0 |
| 5 | closing cash | 66,594,797.91 | 66,594,797.91 | 0 |
| 5 | peak funding | 0.00 | 0.00 | 0 |
| 5 | first shortfall | none | none | same |

### carniprod  GET status 200
| plan year | metric | baseline B0 | now | delta |
|---|---|---:|---:|---:|
| 1 | revenue | 99,424,740.16 | 99,424,740.16 | 0 |
| 1 | EBITDA | 9,588,720.73 | 9,588,720.73 | 0 |
| 1 | closing cash | 15,275,007.90 | 15,275,007.90 | 0 |
| 1 | peak funding | 0.00 | 0.00 | 0 |
| 1 | first shortfall | none | none | same |
| 2 | revenue | 99,424,740.16 | 99,424,740.16 | 0 |
| 2 | EBITDA | 9,588,720.78 | 9,588,720.78 | 0 |
| 2 | closing cash | 20,425,145.65 | 20,425,145.65 | 0 |
| 2 | peak funding | 0.00 | 0.00 | 0 |
| 2 | first shortfall | none | none | same |
| 3 | revenue | 99,424,740.16 | 99,424,740.16 | 0 |
| 3 | EBITDA | 9,588,720.78 | 9,588,720.78 | 0 |
| 3 | closing cash | 25,597,677.52 | 25,597,677.52 | 0 |
| 3 | peak funding | 0.00 | 0.00 | 0 |
| 3 | first shortfall | none | none | same |
| 4 | revenue | 99,424,740.16 | 99,424,740.16 | 0 |
| 4 | EBITDA | 9,588,720.78 | 9,588,720.78 | 0 |
| 4 | closing cash | 30,726,977.98 | 30,726,977.98 | 0 |
| 4 | peak funding | 0.00 | 0.00 | 0 |
| 4 | first shortfall | none | none | same |
| 5 | revenue | 99,424,740.16 | 99,424,740.16 | 0 |
| 5 | EBITDA | 9,588,720.78 | 9,588,720.78 | 0 |
| 5 | closing cash | 35,877,055.09 | 35,877,055.09 | 0 |
| 5 | peak funding | 0.00 | 0.00 | 0 |
| 5 | first shortfall | none | none | same |

### realestate  GET status 200
| plan year | metric | baseline B0 | now | delta |
|---|---|---:|---:|---:|
| 1 | revenue | 162,365.46 | 162,365.46 | 0 |
| 1 | EBITDA | -29,038,838.13 | -29,038,838.13 | 0 |
| 1 | closing cash | 0.00 | 0.00 | 0 |
| 1 | peak funding | 30,022,209.80 | 30,022,209.80 | 0 |
| 1 | first shortfall | 2026-01 | 2026-01 | same |
| 2 | revenue | 162,365.46 | 162,365.46 | 0 |
| 2 | EBITDA | -29,038,838.13 | -29,038,838.13 | 0 |
| 2 | closing cash | 0.00 | 0.00 | 0 |
| 2 | peak funding | 62,287,548.32 | 62,287,548.32 | 0 |
| 2 | first shortfall | FY2027 | FY2027 | same |
| 3 | revenue | 162,365.46 | 162,365.46 | 0 |
| 3 | EBITDA | -29,038,838.13 | -29,038,838.13 | 0 |
| 3 | closing cash | 0.00 | 0.00 | 0 |
| 3 | peak funding | 96,580,574.35 | 96,580,574.35 | 0 |
| 3 | first shortfall | FY2028 | FY2028 | same |
| 4 | revenue | 162,365.46 | 162,365.46 | 0 |
| 4 | EBITDA | -29,038,838.13 | -29,038,838.13 | 0 |
| 4 | closing cash | 0.00 | 0.00 | 0 |
| 4 | peak funding | 133,000,427.16 | 133,000,427.16 | 0 |
| 4 | first shortfall | FY2029 | FY2029 | same |
| 5 | revenue | 162,365.46 | 162,365.46 | 0 |
| 5 | EBITDA | -29,038,838.13 | -29,038,838.13 | 0 |
| 5 | closing cash | 0.00 | 0.00 | 0 |
| 5 | peak funding | 171,693,460.04 | 171,693,460.04 | 0 |
| 5 | first shortfall | FY2030 | FY2030 | same |

### retail  GET status 200
| plan year | metric | baseline B0 | now | delta |
|---|---|---:|---:|---:|
| 1 | revenue | 79,510,264.65 | 79,510,264.65 | 0 |
| 1 | EBITDA | 220,163.89 | 220,163.89 | 0 |
| 1 | closing cash | 2,114,064.19 | 2,114,064.19 | 0 |
| 1 | peak funding | 0.00 | 0.00 | 0 |
| 1 | first shortfall | none | none | same |
| 2 | revenue | 79,510,264.65 | 79,510,264.65 | 0 |
| 2 | EBITDA | 220,163.92 | 220,163.92 | 0 |
| 2 | closing cash | 3,090,118.81 | 3,090,118.81 | 0 |
| 2 | peak funding | 0.00 | 0.00 | 0 |
| 2 | first shortfall | none | none | same |
| 3 | revenue | 79,510,264.65 | 79,510,264.65 | 0 |
| 3 | EBITDA | 220,163.92 | 220,163.92 | 0 |
| 3 | closing cash | 4,042,245.71 | 4,042,245.71 | 0 |
| 3 | peak funding | 0.00 | 0.00 | 0 |
| 3 | first shortfall | none | none | same |
| 4 | revenue | 79,510,264.65 | 79,510,264.65 | 0 |
| 4 | EBITDA | 220,163.92 | 220,163.92 | 0 |
| 4 | closing cash | 5,036,928.00 | 5,036,928.00 | 0 |
| 4 | peak funding | 0.00 | 0.00 | 0 |
| 4 | first shortfall | none | none | same |
| 5 | revenue | 79,510,264.65 | 79,510,264.65 | 0 |
| 5 | EBITDA | 220,163.92 | 220,163.92 | 0 |
| 5 | closing cash | 6,012,823.50 | 6,012,823.50 | 0 |
| 5 | peak funding | 0.00 | 0.00 | 0 |
| 5 | first shortfall | none | none | same |


## B3 — one driver authority and tier pedigree

Measured 2026-09-15 on `wave/plan-b3` (parent `wave/plan-b2` f9ca64a) with
`python scripts/measure_plan_blast_radius.py --markdown`. B3 gives every
driver its contract 3.4 ladder. The one base figure that moves is revenue
growth: one trial balance still measures no growth (the book rung is absent,
"prior periods are not read in this build"), and the ladder now takes the
macro anchor — the BNR inflation target, 2.5000%, `ro.bnr.inflation_target` —
for a book whose envelope records jurisdiction RO, where B0-B2 held growth at
a silent 0. All four corpus books record RO (`pack_provenance`), so revenue,
EBITDA and cash move on every book in every plan year below. All four books
answer GET 200 at horizon 5 (below) and at horizon 3 (measured through the same
harness: agras, carniprod, realestate, retail 200).

No other served base figure moves by a cent at plan-year resolution:

* tax_rate — the statutory 16% was an `engine_default` literal; it is now the
  macro statutory record (`ro_macro.yaml#statutory.profit_tax_rate`) for RO
  books. No corpus book measures its own effective rate, so the rate is
  unchanged on all four. **Periods that now refuse the plan with
  `no_statutory_tax_rate`** (rate not measured, jurisdiction without a packed
  statutory record or not recorded): **0 of the 4 corpus books, and 0 on the
  local Scandia FY2025 book** (jurisdiction RO). The live count needs the
  jurisdiction of every persisted period; no script this batch owns reads
  live periods (B5's `measure_statement_rebuilds.py` is the first), so the
  owner's count is owed at the B13 hand-off.
* capex_pct_of_revenue on a nil-revenue book — was a refusal, now the
  convention terminal rung (0); no corpus book has nil revenue.
* the held money drivers with no line in the book — stamped `unavailable`
  with 0, now the convention terminal rung with the same 0.
* dividend_payout_pct, intangible_additions_pct_of_revenue, min_cash — the
  same 0 on a named convention rung with the book rung recorded.
* dio_days / dpo_days renamed dio_cogs_days / dpo_cogs_days (R8), same values.

The cells are printed by `forecast-base-parity` (delta mode): 2212 differences,
0 outside the B2+B3 CHANGED closure. Realestate draws more on its funding line
(peak +12,284,498.62 in plan year 5) because its losses grow with revenue.
Carniprod still draws nothing in any plan year (B0-8 stands for B5).

Scandia FY2025 (`files/scandia_trial_balance_2025_downloaded.xlsx`, local
only, aggregates reported to the owner and not written here, R22): GET 200 at
horizons 5 and 3; revenue, EBITDA and closing cash move with the anchor;
still no funding draw in any plan year.

PLAN BLAST RADIUS — default GET /api/forecast/{id}?horizon=5, per plan year, against base_get_b0.json
scope: books agras, carniprod, realestate, retail; amounts in minor units shown as currency with two decimals; this script never asserts
### agras  GET status 200
| plan year | metric | baseline B0 | now | delta |
|---|---|---:|---:|---:|
| 1 | revenue | 118,576,819.64 | 121,541,240.13 | +2,964,420.49 |
| 1 | EBITDA | 18,420,553.26 | 18,881,066.99 | +460,513.73 |
| 1 | closing cash | 14,253,382.76 | 14,311,097.41 | +57,714.65 |
| 1 | peak funding | 0.00 | 0.00 | 0 |
| 1 | first shortfall | none | none | same |
| 2 | revenue | 118,576,819.64 | 124,579,771.13 | +6,002,951.49 |
| 2 | EBITDA | 18,420,553.20 | 19,353,093.71 | +932,540.51 |
| 2 | closing cash | 27,338,717.43 | 27,769,890.92 | +431,173.49 |
| 2 | peak funding | 0.00 | 0.00 | 0 |
| 2 | first shortfall | none | none | same |
| 3 | revenue | 118,576,819.64 | 127,694,265.41 | +9,117,445.77 |
| 3 | EBITDA | 18,420,553.20 | 19,836,921.05 | +1,416,367.85 |
| 3 | closing cash | 40,452,739.96 | 41,587,131.34 | +1,134,391.38 |
| 3 | peak funding | 0.00 | 0.00 | 0 |
| 3 | first shortfall | none | none | same |
| 4 | revenue | 118,576,819.64 | 130,886,622.05 | +12,309,802.41 |
| 4 | EBITDA | 18,420,553.20 | 20,332,844.08 | +1,912,290.88 |
| 4 | closing cash | 53,509,711.43 | 55,680,397.51 | +2,170,686.08 |
| 4 | peak funding | 0.00 | 0.00 | 0 |
| 4 | first shortfall | none | none | same |
| 5 | revenue | 118,576,819.64 | 134,158,787.60 | +15,581,967.96 |
| 5 | EBITDA | 18,420,553.20 | 20,841,165.18 | +2,420,611.98 |
| 5 | closing cash | 66,594,797.91 | 70,151,016.30 | +3,556,218.39 |
| 5 | peak funding | 0.00 | 0.00 | 0 |
| 5 | first shortfall | none | none | same |

### carniprod  GET status 200
| plan year | metric | baseline B0 | now | delta |
|---|---|---:|---:|---:|
| 1 | revenue | 99,424,740.16 | 101,910,358.66 | +2,485,618.50 |
| 1 | EBITDA | 9,588,720.73 | 9,828,438.80 | +239,718.07 |
| 1 | closing cash | 15,275,007.90 | 15,194,162.13 | -80,845.77 |
| 1 | peak funding | 0.00 | 0.00 | 0 |
| 1 | first shortfall | none | none | same |
| 2 | revenue | 99,424,740.16 | 104,458,117.63 | +5,033,377.47 |
| 2 | EBITDA | 9,588,720.78 | 10,074,149.79 | +485,429.01 |
| 2 | closing cash | 20,425,145.65 | 20,370,707.24 | -54,438.41 |
| 2 | peak funding | 0.00 | 0.00 | 0 |
| 2 | first shortfall | none | none | same |
| 3 | revenue | 99,424,740.16 | 107,069,570.57 | +7,644,830.41 |
| 3 | EBITDA | 9,588,720.78 | 10,326,003.53 | +737,282.75 |
| 3 | closing cash | 25,597,677.52 | 25,682,017.83 | +84,340.31 |
| 3 | peak funding | 0.00 | 0.00 | 0 |
| 3 | first shortfall | none | none | same |
| 4 | revenue | 99,424,740.16 | 109,746,309.83 | +10,321,569.67 |
| 4 | EBITDA | 9,588,720.78 | 10,584,153.62 | +995,432.84 |
| 4 | closing cash | 30,726,977.98 | 31,060,969.64 | +333,991.66 |
| 4 | peak funding | 0.00 | 0.00 | 0 |
| 4 | first shortfall | none | none | same |
| 5 | revenue | 99,424,740.16 | 112,489,967.58 | +13,065,227.42 |
| 5 | EBITDA | 9,588,720.78 | 10,848,757.46 | +1,260,036.68 |
| 5 | closing cash | 35,877,055.09 | 36,579,732.15 | +702,677.06 |
| 5 | peak funding | 0.00 | 0.00 | 0 |
| 5 | first shortfall | none | none | same |

### realestate  GET status 200
| plan year | metric | baseline B0 | now | delta |
|---|---|---:|---:|---:|
| 1 | revenue | 162,365.46 | 166,424.60 | +4,059.14 |
| 1 | EBITDA | -29,038,838.13 | -29,764,809.67 | -725,971.54 |
| 1 | closing cash | 0.00 | 0.00 | 0 |
| 1 | peak funding | 30,022,209.80 | 30,771,633.35 | +749,423.55 |
| 1 | first shortfall | 2026-01 | 2026-01 | same |
| 2 | revenue | 162,365.46 | 170,585.22 | +8,219.76 |
| 2 | EBITDA | -29,038,838.13 | -30,508,930.85 | -1,470,092.72 |
| 2 | closing cash | 0.00 | 0.00 | 0 |
| 2 | peak funding | 62,287,548.32 | 64,557,688.81 | +2,270,140.49 |
| 2 | first shortfall | FY2027 | FY2027 | same |
| 3 | revenue | 162,365.46 | 174,849.85 | +12,484.39 |
| 3 | EBITDA | -29,038,838.13 | -31,271,654.03 | -2,232,815.90 |
| 3 | closing cash | 0.00 | 0.00 | 0 |
| 3 | peak funding | 96,580,574.35 | 101,231,109.23 | +4,650,534.88 |
| 3 | first shortfall | FY2028 | FY2028 | same |
| 4 | revenue | 162,365.46 | 179,221.10 | +16,855.64 |
| 4 | EBITDA | -29,038,838.13 | -32,053,446.05 | -3,014,607.92 |
| 4 | closing cash | 0.00 | 0.00 | 0 |
| 4 | peak funding | 133,000,427.16 | 140,963,044.06 | +7,962,616.90 |
| 4 | first shortfall | FY2029 | FY2029 | same |
| 5 | revenue | 162,365.46 | 183,701.63 | +21,336.17 |
| 5 | EBITDA | -29,038,838.13 | -32,854,782.65 | -3,815,944.52 |
| 5 | closing cash | 0.00 | 0.00 | 0 |
| 5 | peak funding | 171,693,460.04 | 183,977,958.66 | +12,284,498.62 |
| 5 | first shortfall | FY2030 | FY2030 | same |

### retail  GET status 200
| plan year | metric | baseline B0 | now | delta |
|---|---|---:|---:|---:|
| 1 | revenue | 79,510,264.65 | 81,498,021.27 | +1,987,756.62 |
| 1 | EBITDA | 220,163.89 | 225,668.07 | +5,504.18 |
| 1 | closing cash | 2,114,064.19 | 2,256,977.71 | +142,913.52 |
| 1 | peak funding | 0.00 | 0.00 | 0 |
| 1 | first shortfall | none | none | same |
| 2 | revenue | 79,510,264.65 | 83,535,471.80 | +4,025,207.15 |
| 2 | EBITDA | 220,163.92 | 231,309.72 | +11,145.80 |
| 2 | closing cash | 3,090,118.81 | 3,348,488.93 | +258,370.12 |
| 2 | peak funding | 0.00 | 0.00 | 0 |
| 2 | first shortfall | none | none | same |
| 3 | revenue | 79,510,264.65 | 85,623,858.60 | +6,113,593.95 |
| 3 | EBITDA | 220,163.92 | 237,092.47 | +16,928.55 |
| 3 | closing cash | 4,042,245.71 | 4,390,540.30 | +348,294.59 |
| 3 | peak funding | 0.00 | 0.00 | 0 |
| 3 | first shortfall | none | none | same |
| 4 | revenue | 79,510,264.65 | 87,764,455.07 | +8,254,190.42 |
| 4 | EBITDA | 220,163.92 | 243,019.78 | +22,855.86 |
| 4 | closing cash | 5,036,928.00 | 5,453,679.73 | +416,751.73 |
| 4 | peak funding | 0.00 | 0.00 | 0 |
| 4 | first shortfall | none | none | same |
| 5 | revenue | 79,510,264.65 | 89,958,566.45 | +10,448,301.80 |
| 5 | EBITDA | 220,163.92 | 249,095.26 | +28,931.34 |
| 5 | closing cash | 6,012,823.50 | 6,471,758.66 | +458,935.16 |
| 5 | peak funding | 0.00 | 0.00 | 0 |
| 5 | first shortfall | none | none | same |


## B3 repair — the ratio table's days value, one tax derivation, and the periods that may refuse

Measured 2026-09-15 on `wave/plan-b3` after f6d6cf6 and bdbe2b9 with
`python scripts/measure_plan_blast_radius.py --markdown`: all four books GET
200 at horizon 5, and at horizon 3 through the same harness (agras,
carniprod, realestate, retail 200). **Every cell of the B3 table above is
unchanged** (the 108 table rows of the regenerated output are byte-identical
to the B3 section's), so the table is not repeated. What moved:

* the dio_cogs_days / dpo_cogs_days basis sentences on GET: they quote the
  ratio table's own dio/dpo (engine.ratios.table, over total operating
  expense; agras 31.503485 / 26.642244 days) instead of methodology.ratios
  (over cost of sales; agras 45.548379 / 36.641162) under the ratio table's
  name. No driver value and no cent moves.
* tax_rate on the forecast_drivers path (cases, not served on GET): on the
  four corpus books the drivers package now holds the engine's statutory
  rung (macro, 160000 micros) where it held an absence; the model already
  held that rung, so no plan moves. On a book that ties to account 121 with
  a nil charge and no class-69 account, both paths now charge 0 (the drivers
  path charged the statutory rate after B3).

**The no_statutory_tax_rate count owed to the owner is wider than B3 said.**
GET reads the jurisdiction from `financial_periods.assembled_canonical_v1`
(`_forecast_routes._load_period`). The `pack_provenance` stamp is written by
`country_packs/ro_romania/chart_of_accounts.py` (line 1757) since 4d65125
(2026-08-20, the Phase 3 pack cutover); `api/_reconcile.py` already treats an
envelope without it as a pre-cutover snapshot. **Every period persisted
before 4d65125 and not re-processed since carries no pack_provenance, so B3
reads its jurisdiction as not recorded, and unless its effective tax rate is
measured (none of the four corpus books nor Scandia FY2025 is), GET now
answers 422 "the jurisdiction of this book is not recorded".** No script in
this batch reads live periods. The owner's count at the B13 hand-off must
include: (a) periods whose envelope lacks `pack_provenance.jurisdiction`
(and `ai_audit.jurisdiction`), the likeliest class being every period
persisted before 2026-08-20; (b) periods in a jurisdiction with no packed
statutory record (today every non-RO jurisdiction, e.g. HU packs). Each
refuses only when its effective rate is not measured.


## 609 — the retail disagreement, investigated (plan/2 B4, contract 5.1)

Question (5.1): the retail book's statement line items carry 609 at
+1,267,606.26 (7.62 percent of opex) while the canonical leaf
`discounts_received_supplier` says `expense_negative`. Is the assembled
operating cost wrong, or is the leaf's word the odd one out?

What the source says. 609 is "reduceri comerciale primite" (OMFP 1802,
credit function: supplier discounts reduce cost), and 709 is "reduceri
comerciale acordate" (debit function: customer reductions reduce revenue).
All three Saga books close class 6/7 into 121, so each P&L row prints the
same cumulative value on both turnover sides ("mirrored"). The corpus
inputs, read cell by cell:

| book | 609 / 709 rows (mirrored cumulative value) | exporter writes reductions |
|---|---|---|
| retail | 609.401 +1,177,554.93; 609.403 +131,534.14; 609.304 -34,053.41 (storno); 609.904 -7,429.40 (storno); 709.401 +171,011.99; 709.304 +61,262.95; 709.305 +13,704.00 | positive |
| agras | 609.402 +67,198.73; 709.304 +2,087,418.08; 709.401 +1,797,564.61; 709.904 +4,272.56 | positive |
| carniprod | 6090.01 +28,135.62; 6090.05 +123,045.43; 7094.01 +1,336,597.29; 7093.04 +987,775.35 (and three more) | positive |
| saga_10_col (frozen Scandia golden) | 709101 -202,772.78; 709502 -12,350.57; 709901 -11,722.00 | negative |
| Scandia FY2025 (local only, not committed) | 709102 -22,700,688.49; 609003 -27,374.00 (33 contra rows, net -35,834,590.64) | negative |

The deterministic parser (`country_packs/ro_romania/trial_balance_parser.py`,
`accounts_to_assemble_shape`, the mirrored branch) takes a mirrored row's
sign as the entry's direction. That is right for the negative-writing
exporter and wrong for the positive-writing one: on retail, agras and
carniprod every supplier discount is ADDED to operating cost and every
customer reduction ADDED to revenue.

The independent check is account 121. The engine's own invariant
`canonical_bs.invariants.p121_cross_check` compares the class-7 minus class-6
build-up with the filed profit:

| book | reconstruction as assembled | 121 filed | with 609/709 read as reductions |
|---|---|---|---|
| retail | 1,161,957.98 (`ok` false, gap 2,043,254.64) | 3,205,212.62 | 3,205,212.62 (`ok` true, gap 0.00) |
| agras | 14,106,102.03 (gap -6,572,426.01) | 7,533,676.02 | 6,461,988.99 (gap 1,071,687.03, the 711 production variation remains) |
| carniprod | 5,843,449.04 (gap -4,407,915.45) | 1,435,533.59 | 1,248,684.06 (gap 186,849.53) |
| saga_10_col, Scandia FY2025 | unchanged (the exporter already writes reductions negative) | | |

Retail reproduces account 121 to the cent only when both 609 (2 x
1,267,606.26 off opex) and 709 (2 x 245,978.94 off revenue) enter as
reductions; nothing else on the statement moves.

DECISION: **the assembled opex is wrong** (and, by the same defect, the
assembled revenue on the same three books). Contract 5.1's branch fires: B4
splits into B4a (statements repair, on the critical path) and B4b (pools),
two commit groups on `wave/plan-b4`. B4a repairs the parser, not the leaf:
the leaf's `expense_negative` is the declared nature the repair reads. The
owner is asked to confirm the reading of the positive-writing exporter and to
count live periods persisted by `tb_parser_v5` or earlier (the repaired parser stamps `tb_parser_v6`) that carry mirrored 609/709
rows (every such period's revenue and opex are overstated until
re-processed).


## B4a — the 609/709 contra-sign repair (plan/2, contract 5.1; owner ruling 2026-09-18)

The parser (`country_packs/ro_romania/trial_balance_parser.py`) now decides
each document's contra convention once, from its own mirrored 609/709 rows
(`contra_reading`): `entry_magnitude` when reductions print positive (the
retail, agras and carniprod corpus exports), `natural_signed` when they print
negative (the frozen Scandia golden and both local Scandia years), and
`not_decided` when the document carries no mirrored contra row (realestate;
nothing flips). Under `entry_magnitude` a mirrored contra row enters its
bucket negated. `pl_sanity.class_movement` (the served-P&L guard the live
pipeline raises on) reads the same row through the same decision, or it would
have refused the three repaired books. Gate: `statements-anchor-gap`
(`tests/engine/test_statements_anchor_gap.py`, floor from
`packs/ro/statements_anchor.yaml#anchor_gap`).

### Served P&L figures that move, per book (assemble path, parent 832c566 -> B4a)

| book | figure | before (parent) | after (B4a) | delta |
|---|---|---|---|---|
| retail | revenue | 79,510,264.65 | 79,018,306.77 | -491,957.88 |
| retail | opex_excluding_cogs_and_da | 16,640,349.00 | 14,105,136.48 | -2,535,212.52 |
| retail | gross_profit | 16,133,643.20 | 15,641,685.32 | -491,957.88 |
| retail | ebitda | 220,162.84 | 2,263,417.48 | +2,043,254.64 |
| retail | ebitda_adjusted | 5,674,086.62 | 7,717,341.26 | +2,043,254.64 |
| retail | ebit | -1,256,674.81 | 786,579.83 | +2,043,254.64 |
| retail | net_income_operational | 1,161,957.98 | 3,205,212.62 | +2,043,254.64 |
| retail | net_income_reconstructed | 1,161,957.98 | 3,205,212.62 | +2,043,254.64 |
| retail | net_income_unexplained_vs_121 | 2,043,254.64 | 0.00 | -2,043,254.64 |
| retail | total_operating_revenue | 79,512,188.43 | 79,020,230.55 | -491,957.88 |
| agras | revenue | 118,576,819.64 | 110,798,309.14 | -7,778,510.50 |
| agras | opex_excluding_cogs_and_da | 29,989,304.23 | 29,854,906.77 | -134,397.46 |
| agras | gross_profit | 48,019,704.96 | 40,241,194.46 | -7,778,510.50 |
| agras | ebitda | 18,420,491.28 | 10,776,378.24 | -7,644,113.04 |
| agras | ebitda_adjusted | 18,420,491.28 | 10,776,378.24 | -7,644,113.04 |
| agras | ebit | 15,465,144.89 | 7,821,031.85 | -7,644,113.04 |
| agras | net_income_operational | 14,106,102.03 | 6,461,988.99 | -7,644,113.04 |
| agras | net_income_reconstructed | 14,106,102.03 | 6,461,988.99 | -7,644,113.04 |
| agras | net_income_unexplained_vs_121 | -6,572,426.01 | 1,071,687.03 | +7,644,113.04 |
| agras | total_operating_revenue | 118,576,819.64 | 110,798,309.14 | -7,778,510.50 |
| carniprod | revenue | 99,424,740.16 | 94,509,939.96 | -4,914,800.20 |
| carniprod | opex_excluding_cogs_and_da | 33,812,420.43 | 33,492,385.21 | -320,035.22 |
| carniprod | gross_profit | 41,994,943.93 | 37,080,143.73 | -4,914,800.20 |
| carniprod | ebitda | 9,588,744.57 | 4,993,979.59 | -4,594,764.98 |
| carniprod | ebitda_adjusted | 9,588,744.57 | 4,993,979.59 | -4,594,764.98 |
| carniprod | ebit | 5,893,218.98 | 1,298,454.00 | -4,594,764.98 |
| carniprod | net_income_operational | 5,843,449.04 | 1,248,684.06 | -4,594,764.98 |
| carniprod | net_income_reconstructed | 5,843,449.04 | 1,248,684.06 | -4,594,764.98 |
| carniprod | net_income_unexplained_vs_121 | -4,407,915.45 | 186,849.53 | +4,594,764.98 |
| carniprod | total_operating_revenue | 99,424,740.16 | 94,509,939.96 | -4,914,800.20 |
| realestate | every served P&L figure | unchanged | unchanged | 0.00 (convention not_decided, 0 mirrored contra rows) |
| saga_10_col (frozen Scandia golden) | every served P&L figure | unchanged | unchanged | 0.00 (convention natural_signed, 3 mirrored contra rows) |
| local scandia_trial_balance_2025_downloaded.xlsx | every served P&L figure | unchanged | unchanged | 0.00 (convention natural_signed, 33 mirrored contra rows) |
| local Balanta decembrie 2024_extern .xlsx | every served P&L figure | unchanged | unchanged | 0.00 (convention natural_signed, 6 mirrored contra rows) |

Account 121 after the repair: retail 0.00 (ties to the cent); agras
1,071,687.03 and carniprod 186,849.53 remain, both inside what their mirrored
711 production-variation turnover hides (192,091,846.33 / 88,453,995.50);
realestate, the frozen Scandia golden (`saga_10_col`), the Scandia regression
baseline and the two local Scandia books (FY2025 downloaded, FY2024 extern —
aggregates to the owner only) are unchanged to the cent: 29,589,814.24 /
231,203.19 / 519,389.11 / 519,389.11 / 2,832,404.19, every one inside its
floor.

### Forecast (default GET, horizon 5): the B3 engine over the OLD books -> the same engine over the repaired books

The committed `base_get_b0.json` was re-recorded on this tree (the B0 baseline
was recorded from the wrong statements); the honest before/after is therefore
measured against a scratch record of the B3 engine (832c566, unchanged engine
code) over the pre-repair fixtures. Realestate: every cell delta 0 (its
document carries no mirrored contra row). GET 200 on all four books at
horizons 5 and 3.

### agras  GET status 200
| plan year | metric | baseline B0 | now | delta |
|---|---|---:|---:|---:|
| 1 | revenue | 121,541,240.13 | 113,568,266.87 | -7,972,973.26 |
| 1 | EBITDA | 18,881,066.99 | 11,045,763.22 | -7,835,303.77 |
| 1 | closing cash | 14,311,097.41 | 7,729,408.10 | -6,581,689.31 |
| 1 | peak funding | 0.00 | 0.00 | 0 |
| 1 | first shortfall | none | none | same |
| 2 | revenue | 124,579,771.13 | 116,407,473.54 | -8,172,297.59 |
| 2 | EBITDA | 19,353,093.71 | 11,321,907.28 | -8,031,186.43 |
| 2 | closing cash | 27,769,890.92 | 14,441,971.32 | -13,327,919.60 |
| 2 | peak funding | 0.00 | 0.00 | 0 |
| 2 | first shortfall | none | none | same |
| 3 | revenue | 127,694,265.41 | 119,317,660.38 | -8,376,605.03 |
| 3 | EBITDA | 19,836,921.05 | 11,604,954.97 | -8,231,966.08 |
| 3 | closing cash | 41,587,131.34 | 21,344,326.77 | -20,242,804.57 |
| 3 | peak funding | 0.00 | 0.00 | 0 |
| 3 | first shortfall | none | none | same |
| 4 | revenue | 130,886,622.05 | 122,300,601.89 | -8,586,020.16 |
| 4 | EBITDA | 20,332,844.08 | 11,895,078.84 | -8,437,765.24 |
| 4 | closing cash | 55,680,397.51 | 28,349,836.61 | -27,330,560.90 |
| 4 | peak funding | 0.00 | 0.00 | 0 |
| 4 | first shortfall | none | none | same |
| 5 | revenue | 134,158,787.60 | 125,358,116.94 | -8,800,670.66 |
| 5 | EBITDA | 20,841,165.18 | 12,192,455.82 | -8,648,709.36 |
| 5 | closing cash | 70,151,016.30 | 35,555,505.80 | -34,595,510.50 |
| 5 | peak funding | 0.00 | 0.00 | 0 |
| 5 | first shortfall | none | none | same |
### carniprod  GET status 200
| plan year | metric | baseline B0 | now | delta |
|---|---|---:|---:|---:|
| 1 | revenue | 101,910,358.66 | 96,872,688.46 | -5,037,670.20 |
| 1 | EBITDA | 9,828,438.80 | 5,118,849.76 | -4,709,589.04 |
| 1 | closing cash | 15,194,162.13 | 11,238,097.48 | -3,956,064.65 |
| 1 | peak funding | 0.00 | 0.00 | 0 |
| 1 | first shortfall | none | none | same |
| 2 | revenue | 104,458,117.63 | 99,294,505.67 | -5,163,611.96 |
| 2 | EBITDA | 10,074,149.79 | 5,246,820.98 | -4,827,328.81 |
| 2 | closing cash | 20,370,707.24 | 12,359,676.48 | -8,011,030.76 |
| 2 | peak funding | 0.00 | 0.00 | 0 |
| 2 | first shortfall | none | none | same |
| 3 | revenue | 107,069,570.57 | 101,776,868.31 | -5,292,702.26 |
| 3 | EBITDA | 10,326,003.53 | 5,377,991.50 | -4,948,012.03 |
| 3 | closing cash | 25,682,017.83 | 13,514,646.86 | -12,167,370.97 |
| 3 | peak funding | 0.00 | 0.00 | 0 |
| 3 | first shortfall | none | none | same |
| 4 | revenue | 109,746,309.83 | 104,321,290.02 | -5,425,019.81 |
| 4 | EBITDA | 10,584,153.62 | 5,512,441.28 | -5,071,712.34 |
| 4 | closing cash | 31,060,969.64 | 14,633,349.97 | -16,427,619.67 |
| 4 | peak funding | 0.00 | 0.00 | 0 |
| 4 | first shortfall | none | none | same |
| 5 | revenue | 112,489,967.58 | 106,929,322.27 | -5,560,645.31 |
| 5 | EBITDA | 10,848,757.46 | 5,650,252.32 | -5,198,505.14 |
| 5 | closing cash | 36,579,732.15 | 15,785,357.65 | -20,794,374.50 |
| 5 | peak funding | 0.00 | 0.00 | 0 |
| 5 | first shortfall | none | none | same |
### realestate  GET status 200
| plan year | metric | baseline B0 | now | delta |
|---|---|---:|---:|---:|
| 1 | revenue | 166,424.60 | 166,424.60 | 0 |
| 1 | EBITDA | -29,764,809.67 | -29,764,809.67 | 0 |
| 1 | closing cash | 0.00 | 0.00 | 0 |
| 1 | peak funding | 30,771,633.35 | 30,771,633.35 | 0 |
| 1 | first shortfall | 2026-01 | 2026-01 | same |
| 2 | revenue | 170,585.22 | 170,585.22 | 0 |
| 2 | EBITDA | -30,508,930.85 | -30,508,930.85 | 0 |
| 2 | closing cash | 0.00 | 0.00 | 0 |
| 2 | peak funding | 64,557,688.81 | 64,557,688.81 | 0 |
| 2 | first shortfall | FY2027 | FY2027 | same |
| 3 | revenue | 174,849.85 | 174,849.85 | 0 |
| 3 | EBITDA | -31,271,654.03 | -31,271,654.03 | 0 |
| 3 | closing cash | 0.00 | 0.00 | 0 |
| 3 | peak funding | 101,231,109.23 | 101,231,109.23 | 0 |
| 3 | first shortfall | FY2028 | FY2028 | same |
| 4 | revenue | 179,221.10 | 179,221.10 | 0 |
| 4 | EBITDA | -32,053,446.05 | -32,053,446.05 | 0 |
| 4 | closing cash | 0.00 | 0.00 | 0 |
| 4 | peak funding | 140,963,044.06 | 140,963,044.06 | 0 |
| 4 | first shortfall | FY2029 | FY2029 | same |
| 5 | revenue | 183,701.63 | 183,701.63 | 0 |
| 5 | EBITDA | -32,854,782.65 | -32,854,782.65 | 0 |
| 5 | closing cash | 0.00 | 0.00 | 0 |
| 5 | peak funding | 183,977,958.66 | 183,977,958.66 | 0 |
| 5 | first shortfall | FY2030 | FY2030 | same |
### retail  GET status 200
| plan year | metric | baseline B0 | now | delta |
|---|---|---:|---:|---:|
| 1 | revenue | 81,498,021.27 | 80,993,764.44 | -504,256.83 |
| 1 | EBITDA | 225,668.07 | 2,319,985.40 | +2,094,317.33 |
| 1 | closing cash | 2,256,977.71 | 4,536,725.98 | +2,279,748.27 |
| 1 | peak funding | 0.00 | 0.00 | 0 |
| 1 | first shortfall | none | none | same |
| 2 | revenue | 83,535,471.80 | 83,018,608.55 | -516,863.25 |
| 2 | EBITDA | 231,309.72 | 2,377,985.02 | +2,146,675.30 |
| 2 | closing cash | 3,348,488.93 | 7,959,941.07 | +4,611,452.14 |
| 2 | peak funding | 0.00 | 0.00 | 0 |
| 2 | first shortfall | none | none | same |
| 3 | revenue | 85,623,858.60 | 85,094,073.76 | -529,784.84 |
| 3 | EBITDA | 237,092.47 | 2,437,434.64 | +2,200,342.17 |
| 3 | closing cash | 4,390,540.30 | 11,381,174.01 | +6,990,633.71 |
| 3 | peak funding | 0.00 | 0.00 | 0 |
| 3 | first shortfall | none | none | same |
| 4 | revenue | 87,764,455.07 | 87,221,425.60 | -543,029.47 |
| 4 | EBITDA | 243,019.78 | 2,498,370.51 | +2,255,350.73 |
| 4 | closing cash | 5,453,679.73 | 14,875,709.94 | +9,422,030.21 |
| 4 | peak funding | 0.00 | 0.00 | 0 |
| 4 | first shortfall | none | none | same |
| 5 | revenue | 89,958,566.45 | 89,401,961.24 | -556,605.21 |
| 5 | EBITDA | 249,095.26 | 2,560,829.78 | +2,311,734.52 |
| 5 | closing cash | 6,471,758.66 | 18,376,168.35 | +11,904,409.69 |
| 5 | peak funding | 0.00 | 0.00 | 0 |
| 5 | first shortfall | none | none | same |

### Consequences the owner should read

- Retail's plan is now charged NO income tax: the book reproduces account 121
  to the cent with a nil charge and no class-69 account, so the engine's
  ruled effective-rate rule (3.4, R16; B3R-4) measures book 0 where the
  statutory 16% stood only because the double count kept the book from
  tying. `test_a_book_that_ties_with_a_nil_charge_is_charged_nothing` pins it
  by name. This is the ruled rule on a book that now ties, not a new rule; if
  the owner wants a tying book with no charge to take the statutory rung, that
  is a definition change (stop condition) and is not made here.
- Every live period persisted by `tb_parser_v5` or earlier (the repaired parser stamps `tb_parser_v6`) from an entry-magnitude
  export carries revenue and operating cost overstated by twice its mirrored
  709/609 rows until re-processed; the count is owed by the owner (above,
  under 609).
- The p121 cross-check invariant's `cls7_minus_cls6` sums the mirrored 711
  gross on both sides (agras 198.6M against a filed 7.5M), so `ok` is false
  on every book with production variation whatever the parser does; the
  anchor-gap gate reads `net_income_unexplained_vs_121` instead. Not repaired
  here (not the 609 defect; flagged for the owner).

## B4b — cost pools, held other operating income, inflation on fixed costs (plan/2, contract 5)

Cost of sales and operating costs are no longer shares of revenue. Each is a
POOL split from the anchor's `statement_line_items` rows
(`engine.forecast.pools`, `packs/forecast/cost_behaviour.yaml#prefix_to_pool`,
longest prefix wins; the pools plus the unallocated residual equal
`assembled_pl.opex_excluding_cogs_and_da` to the cent on all four books,
unallocated 0.00 on each). Every opex pool splits into a fixed part that
follows the `inflation` driver and a variable part that follows
`revenue_growth` (5.3, one exact product rounded once); cost of sales follows
revenue growth in full (fixed share 0 by convention). Other operating income
is HELD at the anchor's own amount (`other_operating_income_annual`, 5.5),
sliced by days, growing with nothing. Gates: `forecast-pools` (new),
`forecast-base-parity` re-pointed to parity mode against
`base_b3_growth0.json`, `forecast-route` canary (GET 200, no clause
violation, on the four books at horizons 3 and 5).

### What moves at the default GET, and why

At the default GET on the RO corpus books the `inflation` driver takes the
SAME macro anchor as `revenue_growth` (3.4), so a pool's fixed part and its
variable part grow by the same factor and every pool reproduces the B3
share-of-revenue cost to within the rounding the parity gate bounds. The one
figure that moves is other operating income: B3 grew it with revenue, B4b
holds it. Plan-year-one EBITDA deltas are that line's growth on each book
(agras -9,727.79 on 390,090.55 of other operating income at the anchor's
2.494 percent; carniprod -35,176.21; retail -18,154.19; realestate -414.91),
compounding through cash in later years. Revenue is byte-identical on every
book and plan year; no funding-line first-shortfall period moves; realestate's
peak funding rises by the same held-income shortfall (+426.96 in plan year 1).

Under a REVENUE MOVE the change is the whole point of the batch and is not in
this table: at revenue_growth -0.20 and inflation 0, plan-year-one cost of
sales falls by exactly 20 percent and operating costs fall only by their
variable parts (agras 29,854,906.77 -> 28,300,097.59: personnel and rent
fixed, energy, transport, third-party services and materials variable;
forecast-pools prints every pool). The Scenarios page still runs its own
cascade until B13.

Baseline for this section: `base_get_b0.json` as re-recorded by B4a (the B3
engine over the repaired books), so the delta below is B4b's alone.

### agras  GET status 200
| plan year | metric | baseline B0 | now | delta |
|---|---|---:|---:|---:|
| 1 | revenue | 113,568,266.87 | 113,568,266.87 | 0 |
| 1 | EBITDA | 11,045,763.22 | 11,036,035.43 | -9,727.79 |
| 1 | closing cash | 7,729,408.10 | 7,721,237.38 | -8,170.72 |
| 1 | peak funding | 0.00 | 0.00 | 0 |
| 1 | first shortfall | none | none | same |
| 2 | revenue | 116,407,473.54 | 116,407,473.54 | 0 |
| 2 | EBITDA | 11,321,907.28 | 11,302,184.05 | -19,723.23 |
| 2 | closing cash | 14,441,971.32 | 14,417,233.10 | -24,738.22 |
| 2 | peak funding | 0.00 | 0.00 | 0 |
| 2 | first shortfall | none | none | same |
| 3 | revenue | 119,317,660.38 | 119,317,660.38 | 0 |
| 3 | EBITDA | 11,604,954.97 | 11,574,986.39 | -29,968.58 |
| 3 | closing cash | 21,344,326.77 | 21,294,414.95 | -49,911.82 |
| 3 | peak funding | 0.00 | 0.00 | 0 |
| 3 | first shortfall | none | none | same |
| 4 | revenue | 122,300,601.89 | 122,300,601.89 | 0 |
| 4 | EBITDA | 11,895,078.84 | 11,854,608.79 | -40,470.05 |
| 4 | closing cash | 28,349,836.61 | 28,265,929.98 | -83,906.63 |
| 4 | peak funding | 0.00 | 0.00 | 0 |
| 4 | first shortfall | none | none | same |
| 5 | revenue | 125,358,116.94 | 125,358,116.94 | 0 |
| 5 | EBITDA | 12,192,455.82 | 12,141,221.75 | -51,234.07 |
| 5 | closing cash | 35,555,505.80 | 35,428,562.58 | -126,943.22 |
| 5 | peak funding | 0.00 | 0.00 | 0 |
| 5 | first shortfall | none | none | same |

### carniprod  GET status 200
| plan year | metric | baseline B0 | now | delta |
|---|---|---:|---:|---:|
| 1 | revenue | 96,872,688.46 | 96,872,688.46 | 0 |
| 1 | EBITDA | 5,118,849.76 | 5,083,673.55 | -35,176.21 |
| 1 | closing cash | 11,238,097.48 | 11,208,548.35 | -29,549.13 |
| 1 | peak funding | 0.00 | 0.00 | 0 |
| 1 | first shortfall | none | none | same |
| 2 | revenue | 99,294,505.67 | 99,294,505.67 | 0 |
| 2 | EBITDA | 5,246,820.98 | 5,175,609.87 | -71,211.11 |
| 2 | closing cash | 12,359,676.48 | 12,270,309.98 | -89,366.50 |
| 2 | peak funding | 0.00 | 0.00 | 0 |
| 2 | first shortfall | none | none | same |
| 3 | revenue | 101,776,868.31 | 101,776,868.31 | 0 |
| 3 | EBITDA | 5,377,991.50 | 5,269,844.57 | -108,146.93 |
| 3 | closing cash | 13,514,646.86 | 13,334,436.92 | -180,209.94 |
| 3 | peak funding | 0.00 | 0.00 | 0 |
| 3 | first shortfall | none | none | same |
| 4 | revenue | 104,321,290.02 | 104,321,290.02 | 0 |
| 4 | EBITDA | 5,512,441.28 | 5,366,435.18 | -146,006.10 |
| 4 | closing cash | 14,633,349.97 | 14,330,494.88 | -302,855.09 |
| 4 | peak funding | 0.00 | 0.00 | 0 |
| 4 | first shortfall | none | none | same |
| 5 | revenue | 106,929,322.27 | 106,929,322.27 | 0 |
| 5 | EBITDA | 5,650,252.32 | 5,465,440.53 | -184,811.79 |
| 5 | closing cash | 15,785,357.65 | 15,327,260.63 | -458,097.02 |
| 5 | peak funding | 0.00 | 0.00 | 0 |
| 5 | first shortfall | none | none | same |

### realestate  GET status 200
| plan year | metric | baseline B0 | now | delta |
|---|---|---:|---:|---:|
| 1 | revenue | 166,424.60 | 166,424.60 | 0 |
| 1 | EBITDA | -29,764,809.67 | -29,765,224.58 | -414.91 |
| 1 | closing cash | 0.00 | 0.00 | 0 |
| 1 | peak funding | 30,771,633.35 | 30,772,060.31 | +426.96 |
| 1 | first shortfall | 2026-01 | 2026-01 | same |
| 2 | revenue | 170,585.22 | 170,585.21 | -0.01 |
| 2 | EBITDA | -30,508,930.85 | -30,509,770.71 | -839.86 |
| 2 | closing cash | 0.00 | 0.00 | 0 |
| 2 | peak funding | 64,557,688.81 | 64,558,982.27 | +1,293.46 |
| 2 | first shortfall | FY2027 | FY2027 | same |
| 3 | revenue | 174,849.85 | 174,849.84 | -0.01 |
| 3 | EBITDA | -31,271,654.03 | -31,272,930.47 | -1,276.44 |
| 3 | closing cash | 0.00 | 0.00 | 0 |
| 3 | peak funding | 101,231,109.23 | 101,233,760.10 | +2,650.87 |
| 3 | first shortfall | FY2028 | FY2028 | same |
| 4 | revenue | 179,221.10 | 179,221.09 | -0.01 |
| 4 | EBITDA | -32,053,446.05 | -32,055,169.24 | -1,723.19 |
| 4 | closing cash | 0.00 | 0.00 | 0 |
| 4 | peak funding | 140,963,044.06 | 140,967,583.58 | +4,539.52 |
| 4 | first shortfall | FY2029 | FY2029 | same |
| 5 | revenue | 183,701.63 | 183,701.61 | -0.02 |
| 5 | EBITDA | -32,854,782.65 | -32,856,963.99 | -2,181.34 |
| 5 | closing cash | 0.00 | 0.00 | 0 |
| 5 | peak funding | 183,977,958.66 | 183,984,962.86 | +7,004.20 |
| 5 | first shortfall | FY2030 | FY2030 | same |

### retail  GET status 200
| plan year | metric | baseline B0 | now | delta |
|---|---|---:|---:|---:|
| 1 | revenue | 80,993,764.44 | 80,993,764.44 | 0 |
| 1 | EBITDA | 2,319,985.40 | 2,301,831.21 | -18,154.19 |
| 1 | closing cash | 4,536,725.98 | 4,518,570.44 | -18,155.54 |
| 1 | peak funding | 0.00 | 0.00 | 0 |
| 1 | first shortfall | none | none | same |
| 2 | revenue | 83,018,608.55 | 83,018,608.55 | 0 |
| 2 | EBITDA | 2,377,985.02 | 2,341,205.27 | -36,779.75 |
| 2 | closing cash | 7,959,941.07 | 7,905,005.75 | -54,935.32 |
| 2 | peak funding | 0.00 | 0.00 | 0 |
| 2 | first shortfall | none | none | same |
| 3 | revenue | 85,094,073.76 | 85,094,073.76 | 0 |
| 3 | EBITDA | 2,437,434.64 | 2,381,563.67 | -55,870.97 |
| 3 | closing cash | 11,381,174.01 | 11,270,367.69 | -110,806.32 |
| 3 | peak funding | 0.00 | 0.00 | 0 |
| 3 | first shortfall | none | none | same |
| 4 | revenue | 87,221,425.60 | 87,221,425.61 | +0.01 |
| 4 | EBITDA | 2,498,370.51 | 2,422,931.07 | -75,439.44 |
| 4 | closing cash | 14,875,709.94 | 14,689,464.15 | -186,245.79 |
| 4 | peak funding | 0.00 | 0.00 | 0 |
| 4 | first shortfall | none | none | same |
| 5 | revenue | 89,401,961.24 | 89,401,961.25 | +0.01 |
| 5 | EBITDA | 2,560,829.78 | 2,465,332.61 | -95,497.17 |
| 5 | closing cash | 18,376,168.35 | 18,094,425.36 | -281,742.99 |
| 5 | peak funding | 0.00 | 0.00 | 0 |
| 5 | first shortfall | none | none | same |

## B4 REPAIR ROUND — what moves at the default GET between 50cc222 and the repaired branch (plan/2, 2026-09-20)

Measured with `scripts/measure_plan_blast_radius.py --markdown` on a checkout of
50cc222 and on the repaired tree, then diffed; tax, pre-tax result and net income
read off the same served body (sums over the five plan years, horizon 5). All
four books answer 200 on both trees.

| book | served figure | 50cc222 | repaired | delta | cause |
|---|---|---:|---:|---:|---|
| agras | every line | — | — | 0.00 | none of the repairs reaches a served figure |
| carniprod | every line | — | — | 0.00 | same |
| realestate | every line | — | — | 0.00 | same (loss-making: no tax on either tree) |
| retail | pre-tax result, 5 plan years | 16,327,446.15 | 16,327,446.15 | 0.00 | unchanged |
| retail | income tax, 5 plan years | 0.00 | -2,612,391.38 | -2,612,391.38 | the book files NO class-69 row: the charge is ABSENT, not a measured 0%; the ladder falls to the statutory rung (16.0% of pre-tax) |
| retail | net income, 5 plan years | 16,327,446.15 | 13,715,054.77 | -2,612,391.38 | follows the tax |
| retail | closing cash, plan year 1 | 4,518,570.44 | 4,000,929.28 | -517,641.16 | follows the tax |
| retail | closing cash, plan year 2 | 7,905,005.75 | 6,864,724.97 | -1,040,280.78 | |
| retail | closing cash, plan year 3 | 11,270,367.69 | 9,708,105.18 | -1,562,262.51 | |
| retail | closing cash, plan year 4 | 14,689,464.15 | 12,602,343.09 | -2,087,121.06 | |
| retail | closing cash, plan year 5 | 18,094,425.36 | 15,482,033.98 | -2,612,391.38 | equals the cumulative tax, to the cent |

Revenue, EBITDA, peak funding and first shortfall do not move on any book. The
retail move is the direction of caution: 50cc222 served a plan with no profit tax
in any year on a profitable book. It restores what the same book took before B4a
(the statutory rate); the definition ("no class-69 row = absent charge; a class-69
row closing at 0.00 = a measured nil") is recorded for the owner's confirmation in
the as-built log, B4R-6.

Not reaching a served figure today, by construction: the absent-total refusal (the
route rebuild always emits both totals), the per-family contra decision (every real
book prints both families on one sign), `tb_parser_v6` (a provenance stamp).

## plan/2 B5 — plan compilation, project_plan, the unwind, the partial refusal, debt timing, the one period reader (wave/plan-b5 on 5bf8b23)

**Served figures that move, per book: none.** GET /api/forecast is held to the
recorded B4 GET (`tests/engine/fixtures/forecast/get_b4.json`, battery gate
forecast-get-b4-parity) on agras, carniprod, realestate and retail at horizons
3 and 5: every byte equal, status 200 on all eight cells, except the one named
org-row field, printed by the gate on every run:

| book | horizon | field | B4 | B5 |
|---|---|---|---|---|
| agras, carniprod, realestate, retail | 3 and 5 | company_name | null (read off `financial_periods`, which has no such column) | `organizations.name` of the period's org |

GET /api/period/{id}: unchanged; its reads go through `pipeline.load_period_rows`
with no rebuild, and period-loader-parity holds the loader's rebuilt statements
to the served ones byte for byte on the four books.

**A status that can move: 200/422 to 409.** An anchor whose statements do not
rebuild now answers 409 {code: statements_rebuild_failed} where B4 projected off
statements None. `scripts/measure_statement_rebuilds.py` (read-only): four
corpus books rebuilt 4, StatementsRebuildError 0; the local Scandia FY2025 book
rebuilds. **The live count is not measured: no session reads production. The
owner runs `python scripts/measure_statement_rebuilds.py --live` (read-only)
before B13**, because from B13 those periods show the Scenarios refusal state.

**A refusal that is new: absent source revenue** (B4RV-2). A payload whose
assembled P&L carries no revenue line refuses (`levers.yaml#request_refusals.revenue_absent`)
where B4 projected revenue 0.00. No corpus book and not Scandia is such a book.

**The lever path (engine only; reached by a route in B6).** Not served anywhere
yet, printed so B6's cut-over has its before-picture. total_years 3,
monthly_months 12, from each book's own anchor:

| book | year-one EBITDA, base plan | year-one EBITDA, volume -20% (growth and inflation 0) | same, base at growth and inflation 0 | first shortfall under the shock | served in year one |
|---|---:|---:|---:|---|---|
| agras | 11,036,035.43 | 4,282,948.51 | 10,776,378.24 | none | 12 of 12 months |
| carniprod | 5,083,673.55 | -744,209.66 | 4,993,979.59 | FY2028 | 12 of 12 months (partial refusal 6.5) |
| realestate | -29,765,224.58 | -29,071,184.61 | -29,038,838.12 | 2026-01 | 12 of 12 months |
| retail | 2,301,831.21 | -498,833.89 | 2,263,417.48 | 2026-03 | 12 of 12 months |

Local Scandia FY2025 (aggregates only, never committed; growth and inflation 0,
monthly_months 24, a caller revolver rate): base year-one revenue
413,727,560.16, EBITDA 54,443,833.33 (the calibration figure); measured
aggregate opex fixed share 0.590128. Volume -10% / -15% / -20%: EBITDA
40,787,257.60 / 33,958,969.77 / 27,130,682.03; the same with every opex pool
level at -5%: 48,406,385.18 / 41,415,280.45 / 34,424,176.01; cash stays above
the floor for all 24 modelled months in every case. The owner ruling's
"about 35.5M with the template's -5 percent opex" sits between the -15% and
-20% volume rows; the Recession template itself is B10's, so its exact figure
is B10's to print. -3.9M is not reachable from the measured split.
