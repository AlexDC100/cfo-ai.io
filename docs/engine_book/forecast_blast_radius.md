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

