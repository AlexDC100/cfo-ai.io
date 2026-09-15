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
count live periods persisted by `tb_parser_v5` that carry mirrored 609/709
rows (every such period's revenue and opex are overstated until
re-processed).
