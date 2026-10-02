# Design 2026-10-01 — Phase 2.3: the client-side valuation moves into the engine (`dcf/1`)

**Status: RULED · design complete · adversarially reviewed · NOT STARTED (no branch, no code).**
Executor: the main session, as Phase 2.3, after `release/r-rulings2` is merged
to `main` and deployed (`main == production`).

Hand-off set (all under `specs-durable/`): this document ·
`ticket_2026-10-01_nav_cascade_engine.md` · `dcf_engine/check_served_valuation.py`
(read-only dump / diff; not committed to the repo — it enters `scripts/` with
the release).

Measured on `release/r-rulings2` at `b4cf1ee7` (read-only worktree); `main` was
`e043845c`. Every file:line is at `b4cf1ee7` (`pipeline.py` sits +158 lines
against `8bf2a3af`; no valuation / cash-flow file changed between the two).
A three-lens adversarial review (facts · executability · rulings and risk; 66
findings, 4 blockers) is folded in; what no reviewer could check is in §10.

Release order (owner): `r-rulings2` → **Phase 2.3 (this)** → measured cash flow
("release C") → NAV cascade → engine.

---

## 0. The ticket and the rulings (owner, 2026-10-01, verbatim)

Ticket:
> move the client-side DCF into the engine, same rule as Scenarios — no
> financial computation in the browser, one engine for every number.

Scope as stated: the engine computes and serves the whole DCF (inputs,
year-by-year FCF, terminal value undiscounted and present, EV, net debt,
equity value, the sensitivity grid, the FCF snapshot tile's rows, refusals in
the engine's words) as ONE served block with a schema id; the Valuation tab,
the workbook, the PDF/HTML report, the bank export, the command bar and the
chat snapshot only PRINT it. Overrides are applied by the engine through a
compute route (module-scope Pydantic model, read-only). One CFO figure and one
depreciation add-back per book across every surface. Delete the client
arithmetic (no fallback); a refused DCF prints the refusal, never 0 or NaN.
Gates: served-equality, no-browser-computation (plant-proven), reader-language
(§26), route-binding + tenancy, reprocess (dry-run first) if a stored figure
moves. Per-period table to the owner before any deploy; deploy under §14.

Rulings on the decisions this design raised:
> 1. CFO = A. Drop the 0.6 × other-income proxy. All four client formulas go —
>    including the Cash Flow tab's residual plug — one engine CFO. Measured CFO
>    replaces it in the measured-cash-flow release.
> 2. Graham into the engine — include.
> 3. EV/EBITDA slider preview → compute route, debounced. CRE NAV cascade = its
>    own release right after measured cash flow; ticket it now.

And on two findings (same day):
> - Cash Flow tab misclassifying interest and back-solving opening cash
>   (negative on two real books) → the measured-cash-flow release (C).
> - EV/EBITDA card on "core EBITDA" vs the engine's EBITDA → the DCF release:
>   the card reads the engine's single EBITDA, no second definition on the page.

---

## 1. What exists (measured)

### 1.1 Two DCFs on one page

| | client `runDcf` (`frontend/lib/financialValuation.ts:236-396`) | engine `_dcf_cross_check` (`src/engine/api/_valuation.py:303-531`) |
|---|---|---|
| base FCF | `assembled_cf.cash_from_operating − assembled_cf.depreciation`, **floored at 0** | `net_income + net_wc_change` when `capex_real` is 0 / absent or the book is real estate in development (`:416`, `:789`); otherwise `net_income + D&A + net_wc_change + capex_real` (`:429`); REFUSES when ≤ 0 |
| WACC equity | `max(served equity, 1)` | refuses when equity ≤ 0 / absent |
| Kd | implied, **floor 5 %** pre-tax | implied; methodology range when unmeasurable; n/a without debt |
| tax | effective **clamped [0, 25 %]** | effective in [0, statutory], else statutory, labelled |
| WACC ≤ g | **12× exit-multiple** fallback | refuses (per scenario) |
| scenarios | −100 / 0 / +150 bps, WACC nudged to g + 0.5 % | same shifts; the crossing scenario refuses |
| reaches the FE | computed in the browser | `cross_checks.dcf {wacc, terminal_growth, enterprise_value, equity_value, sensitivity_low/high, refusals}` and `fcf_breakdown`; **not served:** `dcf_scenarios`, `dcf_wacc_components`, `dcf_base_fcf`, `dcf_forecast_growth` |

One panel prints both: the header equity tile reads the engine
(`FinancialStatements.tsx:5916-5919`), the table's bottom row and everything
else the client (`:5943-6072`). The workbook's Valuation sheet is client-only
(`financialExports.ts:141-144, 597-646`). No frontend caller of
`POST …/valuation/recompute`; no UI sets rf / ERP / β / g;
`statements.supplementary` carries only `periodDays` on engine periods.

### 1.2 The gap is the "provision movement" proxy

`client base − engine base == assembled_cf.provision_movement` to the cent on
the four committed real books (`tests/engine/fixtures/firm/saga_10_col_*.json`;
all four have `capex_real` 0 — on a book with 722 capex the gap is
proxy − D&A − capex_real). The proxy is `chart_of_accounts.py:2322`
`max(0, (pl.get("otherIncome", 0) or 0) * 0.6)` — 60 % of the whole
`otherIncome` bucket (758, 74x and every 781x leaf) — inside `cf_before_wc`
(`:2324`) and `cash_from_operating` (`:2325`). 60 % of the 7812 / 7814
reversals is inside it (agras 2,393.22 · carniprod 276,190.49 · retail
46,760.77 · realestate 0.00); the rest is 60 % of 758 / 74x income.

| book | proxy | 6812/6814 charges | 7812/7814 reversals | served CFO today | **post-ruling CFO** (NI + 68x + ΔWC) | engine base FCF | client base FCF |
|---|---|---|---|---|---|---|---|
| agras | 234,054.33 | 135,383.36 | 3,988.70 | 10,234,999.93 | **10,000,945.60** | 7,045,599.21 | 7,279,653.54 |
| carniprod | 843,732.64 | 393,123.16 | 460,317.48 | 5,620,484.36 | **4,776,751.72** | 1,081,226.13 | 1,924,958.77 |
| retail | 436,121.18 | 350,361.72 | 77,934.61 | 5,109,521.75 | **4,673,400.57** | 3,196,562.92 | 3,632,684.10 |
| realestate | 9,972.17 | 0.00 | 0.00 | −3,945,493.79 | **−3,955,465.96** | −4,017,685.40 → REFUSED | 0.00 (floored: a table of zeros) |

The engine ALREADY serves the post-ruling CFO in a second place:
`valuation.fcf_breakdown.cash_from_operating` (`_valuation.py:824-832`), equal
to the post-ruling column to the cent on all four books.

### 1.3 CFO on the surfaces today — more than four formulas

| surface | what prints as CFO | formula |
|---|---|---|
| Valuation tab FCF tiles (`FinancialStatements.tsx:5796-5848`) | `valuation.fcf_breakdown.cash_from_operating` → client `deriveCashFlow` | NI + 68x + ΔWC(approx) |
| **Cash Flow tab** (`buildCashFlowStatement.ts:198-211`) | `modeledCfo + wcReconciliationPlug` | = **served CFO + `interest_paid`** (the tab leaves interest out of financing, `:176`; the plug = `provision_movement + net_wc_change + interest_paid`) |
| /report §4 (`ComprehensiveReport.tsx:1243`) | `assembled_cf.cash_from_operating` | with the proxy; the only surface printing "+ Provision movements" (`:1237`) |
| workbook Cash Flow sheet (`financialExports.ts:561-582`) | `deriveCashFlow(s).cfo` | reconstructed NI + `incomeStatement` D&A − client ΔWC (0 without a prior); **"- Capex" = `supplementary.capex ?? D&A`** (`financialValuation.ts:83`) |
| recommendations, feeder 1 (`financialReport.ts:2609`, `:2803-2808`) | served CFO ?? NI + D&A; `net_change_in_cash: cfo + capexReal`, `opening_cash: 0` | a written decision to stay on a local proxy (`:2783-2800`) |
| recommendations, feeder 2 (`periodFacts.ts:476-493`) | `net_profit + depreciation`; rule `cip_project_resolution` TRIGGERS on `fcf = cfo + cash_used_in_investing; if (fcf >= 0) return null` (`recommendationRules.ts:1084-1088`) | never reads `assembled_cf` |
| Piotroski client fallback (`financialValuation.ts:688-693`) | served CFO ?? NI + D&A + provision charges | |
| chat snapshot (`Chat.tsx:299-314`), Capsule (`capsuleFactIndex.ts:700-705`), popover snapshot (`buildReportingMetrics.ts:140`) | `assembled_cf.cash_from_operating` | with the proxy |
| **stored alert rows** (R8 `pipeline.py:3220`; R9 `:3229-3243`) | `payload.facts_cited.cash_from_operating` / `free_cash_flow`, the CFO in R9's body | written at analysis time; GET serves the STORED rows (`:9612-9618`, `:10227-10258`); printed by `Alerts.tsx:139-148`, `StatementNotes.tsx:377` |

Tab CFO vs served, per book (tab − served = `interest_paid`): agras
9,957,069.58 vs 10,234,999.93; carniprod equal (no interest); realestate
−5,103,367.10 vs −3,945,493.79; retail 2,688,411.41 vs 5,109,521.75.

Also on the tab: **opening cash = closing − served net change**, back-solved
in the browser (`buildCashFlowStatement.ts:187-190`) — **−4,819,845.20 on
agras, −2,515,056.95 on retail**; the same back-solve in
`buildReportingMetrics.ts:145-148` and `reportCharts.ts:277-284`. Opening cash
is served nowhere. `net_change_in_cash` is the sum of three approximations
(`chart_of_accounts.py:2351-2354`). → owned by release C (owner, §0).

The public-company dashboard renders the SAME `CashFlowStatementView` over a
`CashFlowStatement` built by `publicCompanyAdapters.ts` (its own plug `:490`,
`openingCash: 0`, `PublicCompanyDashboard.tsx:247`).

### 1.4 What moves when the proxy leaves

- Served CFO, `cf_before_wc`, `net_change_in_cash`, `free_cash_flow` fall by
  the proxy on every book (§1.2). Scandia FY2025: proxy 6,987,964.99, CFO
  55,353,012.31 → 48,365,047.32.
- **On the measured books no verdict changes** (the four firm books, the eight
  live regression baselines, 30 committed `assembled_cf` blocks, the 12 corpus
  inputs): Piotroski `CFO > 0` / `CFO > NI` (`chart_of_accounts.py:783, 789`),
  alerts R8 / R9 (`pipeline.py:3211-3244`), findings `fcf_negative`
  (`findings/s_liquidity.py:180-185`), the credit stock-build regime (cash is
  `approximated` both ways).
- **It DOES change wherever** (a) NI + 68x + ΔWC ≤ 0 < that + proxy
  [`cfo_positive`, R8's wording]; (b) 68x + ΔWC ≤ 0 < that + proxy
  [`cfo_gt_ni`]; (c) 0 ≤ FCF < proxy with `capex_real < 0` [R9, finding
  `fcf_negative`, the browser rule `cip_project_resolution`]. Three ordinary
  books built in memory through the real assembler: **A** trader (NI 950,000,
  proxy 180,000): CFO 1,055,000 → 875,000, `cfo_gt_ni` pass → FAIL, Piotroski
  4 → 3. **B** own-work builder (722 400,000): FCF +110,000 → −10,000, R9
  False → True (a new alert; `fcf_negative` fires). **C** thin trader with 457:
  CFO +135,800 → −44,200, Piotroski 4 → 2, R8's body flips to "Operating cash
  flow is negative…". Production periods of these shapes are unknown until the
  dump (§7).
- Bytes that change with no verdict change: `assembled_piotroski.checks[2..3].detail`;
  the `leverage_net_debt_ebitda` impact (realestate, retail);
  `credit.regime.cash.value` (realestate −3,945,493.79 → −3,955,465.96);
  `cf.approximation_notes[1]` and its copy `credit.regime.cash.approximation_notes[1]`;
  the cash-walk chart's first and last bars; /report §4; the chat snapshot
  line; the Capsule fact.
- **Stored rows that go stale:** every `alerts` row whose title / body /
  `facts_cited` cites CFO or FCF (rule keys `cash_dividends_declared_unpaid`,
  `fcf_negative_development_phase`). Scandia FY2025 is a known case (457 =
  4,678,772.34 → R8 fires; its stored fact stays 55,353,012.31 beside a served
  48,365,047.32). → §7.
- The engine's DCF reads neither `cash_from_operating` nor `provision_movement`:
  the six persisted `valuations` DCF columns do not move.
- After the ruling the walk adds back the 6812 / 6814 charges and does not
  deduct the non-cash 7812 / 7814 reversals inside NI (carniprod 460,317.48):
  that net belongs to release C.

### 1.5 Valuation serving and routes

- `GET /api/period/{id}` (id-only under RLS, no `X-Org-Id`) →
  `_serialize_valuation` (`pipeline.py:7353-7544`) **returns `None` when no
  `valuations` row exists** (`:7369-7370`). Fresh recompute otherwise
  (`_fresh_or_lawful_valuation`, `:7299-7350`; it fails only on the benchmark
  read, which the DCF does not need); the stored row is the lawful fallback.
- `POST …/valuation/recompute` (`:10608-10761`): `body: Dict[str, Any]`, local
  whitelist; `_require_jwt` only; 400 string details (incl. an explicit rule,
  `:10745-10756`, that a WACC ≤ g caused by the caller's override is a 400);
  returns the FLAT `compute_valuation` dict, not GET's shape. GET rebuilds
  statements inline (`:9776-9790`), POST through `_rebuild_assembled_for_briefing`
  (`:10694`).
- **LIVE DEFECT (cross-user, same workspace).** The recompute route reads
  `user_valuation_assumptions` with the ADMIN client by `period_id` alone and
  takes the first row (`:10715-10728`). Any member who can see the period can
  POST any body (`{}` included) and receive a valuation computed on another
  member's saved EBITDA, debt, cash and multiple. Not cross-workspace (the
  period select is per-user); reachable only by a direct call (no frontend
  caller). `POST …/briefing/regenerate` reads the same way (`:10858-10868`) and
  hands one member's override to the narrator; the briefing is stored for the
  whole workspace. `tests/engine/test_service_role_tenant_filter.py:97-99`
  declares that select as "the period passed `_verify_user_may_write_period`" —
  false for both sites.
- `PUT …/valuation-assumptions` (`:10467-10552`): no validation; the upsert
  (`:10505`) runs before the non-fatal recompute. Measured on
  `compute_valuation` (which the what-if path will reach directly): `NaN`, `0`,
  `-2`, `True`, `"9.5"` are accepted (`NaN` serves `nan` in `ev_ebitda_p50`,
  `primary_equity_value`, `formula_text`); `"abc"` raises `ValueError`. Through
  the PUT, NaN / a non-numeric string are expected to fail at the upsert (500)
  — not measured against the real table; `0`, a negative multiple and `True`
  are stored. The PUT then PERSISTS the caller's overrides into the ONE shared
  `valuations` row (`:10539-10549`, upsert on `period_id`).
- A saved `multiple_used` OVERWRITES `multiple_p50` (`_valuation.py:743-746`);
  the benchmark P50 is then served nowhere, persisted as
  `valuations.multiple_ebitda_p50`, and `row_benchmarks` (`:1247-1264`) reads it
  back as the benchmark — possibly another user's. The primary equity can sit
  outside its own range (agras at 12× on a 6 / 8 / 10 band: 139.7M against
  68.6M–116.0M).
- On a non-positive EBITDA the engine still serves `primary.ev_*` / `equity_*`
  (negative EVs); only a REFUSED EBITDA nulls them (`:754-763`).
- `valuations` and `user_valuation_assumptions` have no `CREATE TABLE` in the repo.

### 1.6 The EV/EBITDA slider (two of them, three bases)

- **`EbitdaMultiplePrimaryCard.tsx`** (`FinancialStatements.tsx:2623, 2656`):
  client-only, persists nothing. `ev = coreEbitda * multiple` (`:92`), `equity
  = ev - netDebt` (`:93`). **Core EBITDA = reported − 758 − 781**, computed in
  the browser (`canonicalMetrics.ts:213-216, 328-331`). Slider literals 2 / 20
  / 0.1, fallback 7 (`:54-57`). No `t()`; `formatCanonicalFull` (`Intl en-US`),
  code before the figure.
- **`ValuationSection.tsx`** (also the Overview hero, `:3934`): headline =
  `ebitda * multiple - debt + cash` (`:205-208`) — the served
  `primary.equity_p50` is never printed; auto-saves by PUT after a literal
  350 ms (`:187-192`); every save sends ALL FOUR fields, debt and cash being
  the SERVED values (`:168-176`); raw `fetch`, no `X-Org-Id`; no `t()`; prints
  engine-authored English (`method_warnings`, `primary_label`, football-field
  subtitles).
- **/report §6** (`ComprehensiveReport.tsx:1460-1476`): the one EBITDA × fixed
  6 / 8 / 10 − net debt, only when EBITDA > 0; reads no `valuation`. The
  methodology (CLAUDE.md Appendix A §6) says "Always include EV/EBITDA at 6x,
  8x, 10x".
- The engine multiplies the ONE EBITDA (`_valuation.py:621, 680, 751`). The
  gap to the card's basis: carniprod 4,720,511.64 vs 3,774,608.05 (+25.1 %),
  retail 2,185,482.87 vs 1,939,569.70 (+12.7 %), agras 11,844,076.57 vs
  11,457,974.72 (+3.4 %).
- Places that still call core EBITDA "the valuation basis": `Chat.tsx:186`,
  `canonicalMetrics.ts:351` (`basis_for_valuation: "core"`),
  `EbitdaMultiplePrimaryCard.tsx:367-377`, `en.json:858` / `ro.json:858`
  (`EbitdaReconciliationPanel`), `LearnableValuationBridge.tsx:88`,
  `chart_of_accounts.py:1950-1951` (comment).

### 1.7 Graham

- Panel + workbook: `runGraham` (`financialValuation.ts:400-467`):
  `NI × (8.5 + 2g) × 4.4 / Y`, g = 5 %, Y = 4.5 % (always the defaults; shares
  are never supplied) = **18.0889 × NI**; a negative NI prints a negative "fair
  value" (realestate −14.5M).
- NAV view: a second Graham, `buildNavCascade.ts:378-379`, g = 3 % = **14.1778 × NI**.
- `computeCostOfCapital` uses 6.75 % for the same `riskFreeRate` Graham reads
  as 4.5 %. No pack or engine module carries the constants.

### 1.8 Routes of the Valuation tab; surfaces with no engine valuation

- The browser decides the route (`FinancialStatements.tsx:2530-2561`): industry
  string OR rental-dominated OR `valuation.primary_method === "asset_based"` OR
  `ppe_net / total_assets ≥ 0.6`. **carniprod (a meat processor, 0.75) is routed
  to the NAV view** although the engine's primary is `ev_ebitda`. The NAV route
  renders `NavValuationView` + the card + `ValuationSection` and **no
  `ValuationPanel`**: on those books the DCF / WACC / Graham panel never
  appears on screen.
- Engine period with no `valuations` row → `valuation: null`; the Overview hero
  and the assumptions section render only when `valuation` is truthy
  (`:2635, 2684, 3931-3939`).
- Engine periods whose pack serves `assembled_cf: {}` / `assembled_pl: {}`
  (HU pack, AI lane).
- Sample period `demo-meridian` (`frontend/lib/demo/*`): purely client-side.
  `Dockerfile.frontend` / `docker-compose.yml` pass no `VITE_ENABLE_SAMPLES`
  build arg, so a production bundle shows it only if `VITE_PUBLIC_TEST_MODE`
  is set in the host `.env` — confirm unset at step 1.
- Public-company pages: no valuation function imported (market feed), but the
  shared Cash Flow view (§1.3).
- The HTML export, the CFO Report PDF (= "Exportă raportul pentru bancă"; one
  builder, `renderReportHtml`), /report, the command bar and the chat snapshot
  print NO DCF / WACC / Graham today. The engine keeps the DCF off the football
  field on purpose (`_valuation.py:974-979`); `ValuationSection` filters DCF
  rows out (`:488`).
- Client cache: the whole react-query cache is persisted to `localStorage`
  (`cfoai-query-cache-v1`, 24 h, `lib/queryPersist.ts:27-28`) and hydrated
  before first render; hydrated entries no page mounted are never refetched.

---

## 2. What the rulings mean for this release

**Ruling 1 — one engine CFO.** The proxy leaves the walk. Every client CFO
formula in §1.3 is deleted or re-pointed to `assembled_cf.cash_from_operating`,
the Cash Flow tab's plug included; stored alert rows are refreshed (§7).

**Cash Flow tab, interim until release C (owner: interest classification and
opening cash are C's).** Phase 2.3 changes the tab's OPERATING section only: the
CFO row prints the served CFO, the plug row is deleted, the working-capital
rows are the served `delta_*` lines. Investing, financing, opening cash and the
net change keep today's code. **Measured consequence:** with the plug gone the
tab's own net change differs from the served one by `interest_paid`, so its
existing "Reconciliation drift" line (`cf-drift-warning`, shown when |drift| >
1) appears on every book with interest — agras 277,930.35 · realestate
1,157,873.31 · retail 2,421,110.34 · carniprod none. That line is the truth the
plug was hiding inside CFO; it is also new on screen. → open item O1 (the
alternative that removes it in this release is one served row).

**Ruling 2 — Graham in the engine.** One Graham in the served block, constants
in the pack. → O4.

**Ruling 3 — slider through the compute route; NAV cascade ticketed.** The
card's slider sends a non-persisting what-if; the section stops computing.
`buildNavCascade.ts` / `NavValuationView.tsx` are untouched
(`ticket_2026-10-01_nav_cascade_engine.md`).

**The card reads the engine's single EBITDA; no second definition on the page.**
The card, the bridge and the section print the engine's `primary.*` on the ONE
EBITDA. The card's headline rises by the 758 / 781 strip × the multiple on
every book that has such income (§1.6). Every statement of "core EBITDA = the
valuation basis" (§1.6, last bullet) is removed; `EbitdaReconciliationPanel`
leaves the Valuation tab; `canonicalMetrics`' browser-computed `core` is
deleted where nothing else reads it (grep `ebitda.core`), or reads the served
`assembled_pl.core_ebitda`.

---

## 3. Design

### 3.1 Pack — `packs/valuation/valuation.yaml` (new)

`dcf.defaults` (`rf 0.0675, equity_risk_premium 0.075, beta 1.0,
forecast_growth 0.035, terminal_growth 0.030, forecast_years 5` —
`_valuation.py:179-186`), `dcf.scenario_shifts` (−0.010 / 0 / +0.015),
`dcf.override_domains` (`:200-210`), `dcf.development_phase.capex_to_da_multiple:
2` (`:789`), `graham` (8.5, 2, 4.4, `g`, `Y` — O4), `report_multiples: [6, 8,
10]` (§3.2), `assumption_domains` (`ebitda_used` finite; `multiple_used` finite
and > 0; `debt_used`, `cash_used` finite — no sign rule, the engine has its own
negative-debt refusal), `client` (`debounce_ms: 150`, `multiple: {min: 2, max:
20, step: 0.1, fallback_default: 7}`), and every label, row name, verdict,
note and refusal sentence in RO and EN with `money_display` per §26. The
asset-based band, markup and confidence literals (`:852-854, 914-915, 928-929`)
stay in code this release. Verified at boot (`boot_verify.verify_config`,
`:106-112`, pattern `test_boot_verify_pl_definition.py`); `packs/` is runtime —
confirm the Dockerfile COPY and the deploy sync set cover the new directory.

### 3.2 Engine — one served block, schema `dcf/1`

New pure module `src/engine/valuation/dcf.py` (no HTTP, no Supabase, no model
import), built from the statements alone — independent of the benchmark read.
`_valuation.py` calls it.

```
valuation.dcf = {
  schema: "dcf/1", definition: EBITDA_DEFINITION_REVISION, currency,
  status: "computed" | "refused",
  refusal: {code, inputs, text:{ro,en}} | null,
  refusals: [ {code, inputs, text:{ro,en}} ],
  cash_flow: {                                 # rows READ from assembled_cf, never re-derived
    rows: [ {key, label:{ro,en}, sign:"+"|"−"|"=", value|null, refusal|null, source?:"approximated"|"measured"} ],
            # row key -> assembled_cf key: net_income->net_profit; depreciation, net_wc_change,
            # cash_from_operating, capex_real, free_cash_flow identical. An absent key: value null,
            # refusal {code: cash_flow_line_not_served}.
    depreciation_includes_provision_charges: bool,
    stabilized_fcf, is_development_phase,
    verdict: {code: positive_cash_generation | cash_burning | development_phase_cash_drag | null, text:{ro,en}} },
  inputs: { rf, equity_risk_premium, beta, cost_of_equity, cost_of_debt_pre_tax, cost_of_debt_after_tax,
            cost_of_debt_after_tax_range, kd_source, kd_note:{ro,en}, tax_rate, tax_source, tax_label:{ro,en},
            effective_tax_rate, weight_equity, weight_debt, total_equity_used, total_debt_used, wacc,
            forecast_years, forecast_growth, terminal_growth,
            source: {<key>: "default" | "override"}, standing_defaults_note:{ro,en} },
  base_fcf, base_fcf_formula:{ro,en}, wc_change_source,
  years: [ {year, fcf, discount_factor, present_value} ], explicit_pv_total,
  terminal: {method:"gordon", undiscounted, discount_factor, present_value},
  enterprise_value, net_debt, equity_value,
  rounding_note: {ro,en} | null,
  scenarios: [ {key: optimistic|central|conservative, label:{ro,en}, wacc_shift_bps, wacc, enterprise_value,
                net_debt, equity_value, refusal|null} ],
  multiples: { ev_to_ebitda: {value|null, refusal|null}, ev_to_revenue: {value|null, refusal|null} },
  graham: { status, value|null, net_income, growth, bond_yield, multiplier, formula:{ro,en},
            refusal|null, standing_defaults_note:{ro,en} }
}
```

- **Rounding.** `enterprise_value`, `equity_value` and the scenario figures are
  today's computation (unrounded WACC, unrounded flows), rounded once at the end
  — gate `dcf-served-block` asserts they equal the pre-change
  `compute_valuation` output to the cent on every corpus book (computing from
  the 4-dp WACC would move agras' EV by −34,989.29). `years[]` and `terminal`
  are the same computation rounded for display; `discount_factor` is served at
  6 dp. When Σ printed present values + printed terminal PV ≠ printed EV the
  block serves `rounding_note` (pack sentence, §25) and the panel prints it —
  never a second total.
- **Refusals.** The flat `compute_valuation` result keeps `dcf_refusals[].text`
  as the English string (the narrator reads the flat dict); the block's
  bilingual sentences come from the pack. A refused figure is `null` beside its
  refusal — never 0, never NaN. DCF refusals are no longer copied into the
  served `method_warnings` (the block is their one home).
- **Serializer.** One serializer for GET, POST and PUT's response. It ALWAYS
  returns the full existing shape (`inputs`, `primary`,
  `cross_checks.revenue_multiple`, `football_field`, `user_assumptions`,
  `method_warnings`) with nulls and refusals — never a partial object, never a
  dereferenced `None`. When the benchmark table cannot be read the multiple
  methods refuse (`benchmarks_unavailable`) and the DCF block is still served.
  Whether a period with NO stored row starts serving a valuation is O2.
- **Deploy-window mirrors.** `valuation.fcf_breakdown` and
  `valuation.cross_checks.dcf` stay served for ONE release as deprecated
  mirrors READ FROM the block (never re-derived), listed in
  `deprecated_fields`, held equal to the block by `dcf-served-block`; deleted
  in release C. Reason: a tab holding the OLD bundle falls back to client math
  when they are absent (`FinancialStatements.tsx:5785, 5796-5802, 5910-5919`)
  and would print a client DCF equity on a book the engine refuses. The new
  bundle never reads them.
- **`primary`** gains `benchmark: {p25, p50, p75}` (the table's, untouched by an
  override) and `multiple_used: {value, source: "benchmark" | "saved" |
  "what_if"}`. Persisted-row semantics: O3.
- **`valuation.report_multiples`**: the methodology's three rows — 6 / 8 / 10
  from the pack, EV and equity on the ONE EBITDA and the BOOK's debt and cash,
  no user override, refused (`ev_ebitda_not_meaningful`) when EBITDA is not
  positive — so /report §6 prints served rows and no printed figure moves.
- **`valuation.client`** = `{debounce_ms, multiple: {min, max, step,
  fallback_default}}`.
- **Language (§26).** `primary_label`, `asset_based_label`,
  `football_field[].method / subtitle`, `formula_text` and `method_warnings` are
  English strings with embedded figures today (`_fmt_ron`, `:1339-1346`). → O5.

### 3.3 Engine — one CFO (`chart_of_accounts.py:2298-2438`)

- Delete the proxy (`:2322`). Totals are computed FROM the rounded served rows,
  so every printed total foots to the cent: `net_wc_change` = Σ of the four
  rounded `delta_*`; `cf_before_wc = net_profit + depreciation`;
  `cash_from_operating = cf_before_wc + net_wc_change`; `free_cash_flow =
  cash_from_operating + capex_real`; `net_change_in_cash` = Σ of the three
  served totals. (Today totals are rounded from unrounded operands: 9 of 30
  committed blocks miss an identity by a cent — this moves a served total by at
  most 0.01 on those books; expected in the diff.)
- Drop the `provision_movement` key (`canonical_model.py:290`, optional).
- Serve `depreciation_includes_provision_charges`.
- `approximation_notes` stays `List[str]` (English; `canonical_model.py:312`,
  `credit_model.py:428-429`, `buildCashFlowStatement.ts:260-261`,
  `ComprehensiveReport.tsx:1201, 1279` stringify each element): note [1]
  (`:2367-2369`, "The reconciliation plug captures the residual…") is replaced
  by a true sentence; the RO / EN pair is a NEW key `approximation_notes_i18n:
  [{ro, en}]`. Correct the comment at `:2298-2299`.
- `fcf_breakdown`'s own re-derivation (`_valuation.py:824-844`) is deleted; the
  block's `cash_flow` reads `assembled_cf`. `stabilized_fcf` and `base_fcf` stay
  the DCF's own computation.
- Scope: every RO book; a pack serving `assembled_cf: {}` (HU, AI lane) serves
  null rows with `cash_flow_line_not_served` and a refused DCF.
- `scripts/floor_census_baseline.json`: `chart_of_accounts.py` CLAMP 7 → 6,
  OR_ZERO 7 → 5 (`--write-baseline`, named commit);
  `scripts/check_floor_census.py` `RATCHET_TIER` gains
  `src/engine/valuation/dcf.py`.

### 3.4 Routes (`pipeline.py`; models at MODULE SCOPE — CLAUDE.md §22; `_Strict` is redefined there, not imported from `_forecast_routes`)

`POST /api/period/{period_id}/valuation/recompute`, in this order:
1. bearer → 401; 2. `_org.resolve_org(jwt, x_org_id)` → 403; 3. the period, per-user,
filtered on `id` AND `org_id` → 404 `{code: "period_not_found", text, id}`;
4. body shape and domains → 422 `{code, text, field}`; 5. compute.
- `class ValuationRecomputeBody(_Strict)`: `dcf: Optional[DcfInputsBody]` (`rf,
  equity_risk_premium, beta, forecast_years, forecast_growth, terminal_growth`),
  `what_if: Optional[WhatIfBody]` (`multiple_used` ONLY — the one field with a
  caller). The three never-consumed pass-through keys are no longer accepted.
- The caller's own saved row (per-user client, `user_id` + `period_id`) — never
  the admin first-row read. Precedence, echoed in the response: `what_if` > the
  caller's saved field > the engine's. Domain validation judges the REQUEST's
  fields; a SAVED field outside the domain is ignored with a served note, never
  a 422 on a preview. A what-if carries the current `ebitda_definition` stamp.
- A WACC ≤ g caused by a `dcf` override is 422 with the pack sentence (the rule
  at `:10745` stays); at engine defaults it is a refusal inside the 200 body.
- Read-only. Statements and the benchmark row come from one cached seam keyed
  `(org_id, period_id, period.updated_at, engine version)` (pattern
  `_forecast_history.py:60-118`): a what-if costs one period read plus the pure
  computation. Response `{valuation: <the GET shape>, recompute_ms}`.
- The frontend sends the PERIOD's `org_id` as `X-Org-Id` (GET is id-only; the
  active-workspace id can differ from the period's org).

`PUT …/valuation-assumptions`: `AssumptionsBody(_Strict)` (`ebitda_used,
multiple_used, debt_used, cash_used, notes`, all optional), the same domain
validator → 422; a MERGE over the caller's row (an omitted field keeps its
saved value; `null` clears it); returns `{ok: true, valuation: <the GET
shape>}`. `DELETE` returns the same shape. Write wall unchanged.

`POST …/briefing/regenerate` (`:10858-10868`): stops the admin first-row read.
Default (O3): the briefing is workspace-wide, so it values on the engine's
figures with no user override.

Census: `test_cross_org_reads.py` `_routes()` (`:52-62`) — add the POST with a
body, remove the never-mounted `GET …/valuation`; `test_identity_wall.py`
`DECLARED` (`:225`); `test_service_role_tenant_filter.py:97-99` — the
`user_valuation_assumptions` select declaration is removed only when BOTH admin
selects are gone; `scripts/check_deployed_routes.py` `PROBES` (`:97-119`) — add
POST recompute and DELETE.

### 3.5 Frontend — printers only

New: `lib/dcfServed.ts` (typed reader; `readDcf(valuation)` checks `schema ===
"dcf/1"`; zero arithmetic), `lib/useValuationWhatIf.ts` (Scenarios pattern,
`Scenarios.tsx:120-210`: `edits` → `committed` after the SERVED
`valuation.client.debounce_ms`; key `["valuation-whatif", periodId,
committedKey]`; `placeholderData` scoped to the same period; `retry: false`;
refusals through `readEngineRefusal`), `cfoApi.valuationRecompute /
saveValuationAssumptions / resetValuationAssumptions` through `call()`,
`components/cfo/valuation/DcfPanel.tsx` (extracted from
`FinancialStatements.ValuationPanel`, `:5770-6159`), `test/servedDigits.ts`
(modelled on the private `expectEveryDigitServed`,
`scenariosEngine.test.tsx:777-863`).

- **DcfPanel**: FCF rows, WACC tiles, DCF table, sensitivity, EV multiples,
  Graham — every figure, label, verdict, note and refusal from the block;
  `rounding_note` printed when served. Money through `useAmountFormatter` /
  `formatMoneyFrom`; percent / multiples through `formatMeasure` /
  `formatMultiple` with the UI locale; refusals through `pickLang`. The growth
  table (`multiPeriodGrowth`) stays in `FinancialStatements.tsx` — NOT moved
  into `components/cfo/valuation/` — and moves to `formatMoneyFrom` (the
  panel's `useFmtMoney`, `:5755-5766`, is deleted).
- **EbitdaMultiplePrimaryCard**: the slider sends `what_if.multiple_used`; EV,
  equity, range, the formula's operands and the bridge are the served
  `primary.*` / `inputs.*` on the ONE EBITDA; bounds, step and the "Benchmark"
  tick are served (`client.multiple`, `primary.benchmark.p50`). With no
  benchmark on file the card says so and the slider starts at
  `fallback_default`; the first figure is the first what-if response. Every
  string through `t()`, every amount through `lib/money`; `formatCanonicalFull`
  is no longer used here. No "Core EBITDA" label, provenance line or bridge
  link (§2).
- **ValuationSection**: `livePreviewEquity` deleted; the headline prints the
  served `primary.equity_p50` (the last served figure, marked recomputing,
  while a save is in flight); the formula line prints served operands through
  an i18n template; a save sends ONLY the fields the user typed (a slider move
  sends `multiple_used` alone — served debt / cash are never re-sent); the
  PUT's returned `valuation` is written into the period query (`setQueryData`)
  — no period refetch per save; the debounce is the served one; `t()` and
  `lib/money` throughout. Football-field bar geometry is the ONE declared
  plotting door. Same for `LearnableValuationBridge`.
- **Cash Flow tab** (`buildCashFlowStatement.ts`): operating section only (§2) —
  `cashFromOperating = assembled_cf.cash_from_operating`; the plug row and its
  note deleted; working-capital rows = the served `delta_*` (labels through
  i18n keys); `cfBeforeWcChanges = assembled_cf.cf_before_wc`; the add-back
  label by the served flag. An absent `cash_from_operating` prints the
  not-served refusal, not a client sum. `CashFlowStatementView`, `cfStructure`
  and the public-company adapter keep their shape (the public page is
  untouched). The financing sum, the opening back-solve, the net-change sum
  and the drift line stay as DECLARED exceptions owned by release C.
- **/report §4**: the "+ Provision movements" row goes
  (`comprehensiveReportAbsent.test.tsx:211` floor `cfAmounts.length ≥ 20` is
  then exactly met — re-measure). **/report §6**: prints the served
  `valuation.report_multiples` rows and book equity; no `[6, 8, 10].map`.
- **Workbook**: the served valuation rides in the envelopes object
  (`CreditEnvelopes.valuation?: PeriodValuation | null`; the call
  `downloadExcelReport(statementsForExport ?? statements, creditEnvelopes)` is
  pinned verbatim by `ratioCompareTab.test.tsx:896-900` and keeps its
  signature). Cash Flow sheet rows = `assembled_cf` (NI = `net_profit`,
  add-back = `depreciation`, ΔWC = `net_wc_change`, CFO, "- Capex" =
  `capex_real`, FCF); Valuation sheet = the block. A workbook built without a
  served valuation prints the not-served refusal on the Valuation sheet.
- **Recommendations**: `CFFacts` gains `free_cash_flow` and `capex_real`, read
  from `assembled_cf`; rule `cip_project_resolution` triggers on
  `assembled_cf.free_cash_flow < 0` and cites the served CFO, capex and FCF with
  `is_approximated`; `net_change_in_cash` / `opening_cash` / `drift` leave
  `CFFacts`; the comment at `financialReport.ts:2783-2800` is replaced. The
  rule's firing before / after is measured per book (§7).
- **Deleted, no fallback** (`financialValuation.ts:48-467`): `CashFlowSnapshot`,
  `NET_RESULT_NOT_SERVED`, `deriveCashFlow`, `workingCapitalChange`,
  `CostOfCapital`, `computeCostOfCapital`, `DcfYear`, `DcfResult`, `runDcf`,
  `GrahamResult`, `runGraham`; the Piotroski fallback CFO (`:688-693`) reads
  the served CFO or refuses. `SupplementaryData` loses its eleven dead fields
  (`financialReport.ts:224-244`; `capex` is set by `lib/demo/demoFinancials.ts:172`
  — remove it there). `PeriodValuation` (`activePeriod.ts:104-212`): `dcf`,
  `client`, `report_multiples`, `primary.benchmark`, `primary.multiple_used`;
  `fcf_breakdown` and `cross_checks.dcf` leave the type.
- **Client cache**: bump `STORAGE_KEY` to `cfoai-query-cache-v2`
  (`lib/queryPersist.ts`; the old key is removed on boot); a period payload
  whose `assembled_cf` still carries `provision_movement` is a pre-release
  document — the page refetches it rather than printing it.
- **No served block** (a sample, an `assembled_cf: {}` period): the Valuation
  panel, the Cash Flow tab's CFO row, /report §4 / §6 and the workbook's two
  sheets print the not-served refusal — one pack sentence; no client fallback.
- **Learning popovers** opened from the DCF panel (`analytics.ts:811-881,
  1080-1109`, `statements.ts:114-150`): formula text only, no browser-built
  operands, on those sites. (O7.)
- Comments naming the client math as live are corrected
  (`ValuationSection.tsx:7-9`, `EbitdaMultiplePrimaryCard.tsx:403-408, 436`,
  `buildReportingMetrics.ts:56-58, 75-77`, `servedOneEbitda.ts:294`,
  `financialReport.ts:714-715`; `gates.md:4415-4455`, `STATUS.md:76`).

---

## 4. Work order

**pytest is green after every step; vitest / tsc / the battery are green from
step 8; nothing is merged or deployed before step 9.**

0. **The owner rules O1–O5 before step 3** (a ruling against a default after
   step 9 costs a second pass over the pack, the fixtures and the plant log).
1. Branch from `main` once `main == production`. Read production first (images,
   host tree sha vs commits; `VITE_PUBLIC_TEST_MODE` unset in `/opt/cfo-ai/.env`).
2. Baseline: the A/A control, then `--dump` on production's image (§7).
3. Pack + `engine/valuation/dcf.py` + `_valuation.py` wiring + the one
   serializer (full shape, mirrors, `report_multiples`, `client`,
   `primary.benchmark`). Gate `dcf-served-block`.
4. One CFO in `chart_of_accounts.py`; gate `dcf-one-cfo`; re-capture the
   ENGINE-side fixtures (§6.1, first group); floor-census baseline.
5. Routes (models, validator, order of walls, cached seam, PUT merge +
   response, regenerate); census updates; gate `valuation-route`.
6. `capture_valuation.py` → `tests/engine/fixtures/firm/valuation.json`, held to
   the real route. The served-books harness has no `industry_benchmarks` table
   (`test_rebuild_net_income_anchor.py:869-883`): seed a committed
   `tests/engine/fixtures/firm/inputs/industry_benchmarks.json` first, or every
   book serves null multiples. Capture per book: GET `valuation`, POST `{}`
   (must equal GET), POST `{what_if: {multiple_used: P50 + 1}}`, one domain
   refusal. `exportBooks` gains `valuationFor(book)` / `envelopesFor(book)`.
7. Frontend: reader, hook, DcfPanel, card, section, Cash Flow tab, /report,
   workbook, recommendations, cache key; deletions; i18n keys (EN + RO);
   re-capture the FRONTEND / e2e / design_review fixtures (§6.1, second group).
8. Frontend gates; census files.
9. Full engine suite, full vitest, `tsc`, `vite build`, the battery.
10. Candidate image, the three-part table to the owner, approval, the alert
    refresh dry run, then the deploy (§7).

---

## 5. Gates (each: `Gate(...)` in `scripts/run_battery.py` with a measured floor and a canary; a `## <gate>` section in `docs/engine_book/gates.md` with PLANT / RED / REVERT, "after the repair it reds on", "CANNOT SEE" — `tests/engine/test_gate_canaries.py`)

| gate | kind | law | plants |
|---|---|---|---|
| `dcf-served-block` | pytest `tests/engine/test_dcf_block.py` | `dcf/1` shape on the four firm books, the synthetic equity books, the Scandia baseline and one book with `capex_real ≠ 0` (EEI — the non-stabilised branch); EV / equity / scenarios equal the pre-change `compute_valuation` to the cent; the six persisted columns equal the block; the mirrors equal the block; every refusal bilingual; refused → nulls with the reason; no stored row + `load_valuation_benchmarks` raising → 200, full shape, DCF served; `rounding_note` present exactly when the printed rows do not foot; Graham refuses on a non-positive net result; a malformed pack fails `verify_config` | serve 0 for a refused EV; compute EV from the 4-dp WACC; drop a scenario; EN-only text; dereference a `None` row |
| `dcf-one-cfo` | pytest | §3.3 identities, exact, on every RO corpus book; no `provision_movement` key; `dcf.cash_flow` equals `assembled_cf`; on a served body every alert's `facts_cited.cash_from_operating / free_cash_flow` equals `assembled_cf`; the constructed books A, B, C (§1.4) as witnesses of each flip shape | re-insert the proxy; re-derive CFO in `_valuation.py`; a stored alert with the old CFO |
| `dcf-fixture` | pytest | `valuation.json` equals what the real route serves; ≥ 1 book with a non-null `primary.ev_p50` | edit one figure |
| `valuation-route` | pytest | module-scope models (`__qualname__`); the wall order (stranger → 401 / 403 / 404, never 422); 422 `{code, text, field}` for shape and domain; POST `{}` equals GET's `valuation` byte for byte on the four books; what-if does not persist; what-if > saved > engine; two members of one workspace — B saves, A's recompute and the regenerate route carry none of B's figures; PUT merges, refuses NaN / a non-positive multiple, returns the valuation; a second what-if performs no line-item select; **the exact bodies the frontend builds** (`tests/engine/fixtures/firm/valuation_request_bodies.json`, written by a vitest test from `cfoApi`, capture-parity) each answer 200 on the real app — §22: an intercepted route is a route with no gate | nest a model; the admin first-row read on either route; let NaN through; rename a field in `cfoApi` |
| `tenant-boundary`, `route-binding` | existing | the POST in `test_cross_org_reads` | existing |
| `dcf-served-equality` | vitest `frontend/pages/cfo/__tests__/dcfServedEquality.test.tsx` | DcfPanel, the card, the section, the Cash Flow tab's operating section, /report §4 + §6 and the workbook over the four books' SERVED payloads (`valuationFor`): every digit is a served figure, label or sentence (`test/servedDigits.ts`); expected strings stated per language and an independent `foreignNumber` pass in EN and RO (§26: never the same printer on both sides); the HTML export, the bank PDF, the command bar and the chat snapshot print NO DCF / WACC / Graham figure that is not served; a no-block payload (sample, AI-lane `assembled_cf: {}`) prints the refusal, no zero; a v1 cache blob is dropped, not hydrated; the popover sites show no operands | print EV + 1; print the old client base; a hard-coded "6×" row; hydrate the v1 blob |
| `dcf-no-browser-math` | vitest, the `cockpitNoMoneyMath.test.ts` pattern (R1–R8, `codeOnly` tokenizer) | roster: `lib/dcfServed.ts`, `lib/useValuationWhatIf.ts`, `components/cfo/valuation/*`, `EbitdaMultiplePrimaryCard.tsx`, `ValuationSection.tsx`, `LearnableValuationBridge.tsx`, the workbook's valuation + cash-flow sheet builder and /report's ValuationView + CashFlowTable (each extracted to its own module), `buildCashFlowStatement.ts`; no arithmetic beside a money-named operand, no `.reduce`, no laundering cast; exactly one plotting door; the DECLARED exceptions (the tab's financing sum, opening back-solve, net-change sum, drift — owner: release C) are listed by name and counted, so the list cannot grow; the deleted symbols are absent from `financialValuation.ts`; the roster is whole | in-file plants that must each red; real-file plants in gates.md |
| `ui-language-figures` | existing, extended | DcfPanel, the card, the section, the bridge in EN and RO (subject to O5) | existing pattern |
| existing gates to RE-POINT, not delete | | `refusal-carries` (floor 44; canaries at `run_battery.py:1448-1449`; `refusalCarries.test.tsx:825-921`) · `one-ebitda` (canary "carniprod: stabilised FCF = CFO − assembled_cf.depreciation…", `:1374-1385`) · `valuation-refused-override` (`:1497-1507`; add canaries "moving the multiple slider sends no debt and no cash") · `floor-valuation` (canary `test_recompute_answers_400_on_an_out_of_domain_override`, `:1993`, renamed with the test) · `valuation-one-ebitda` · `f31-parity` · `floor-census` · `provenance-census` · `no-plants` | |

Never compare a printed figure only against the same printer; state what each
gate fails on after the repair (TC-11).

---

## 6. Fallout the executor must expect

### 6.1 Fixtures (re-capture through each one's own writer)
**Engine side (step 4):** `tests/engine/fixtures/firm/*.json` (8) ·
`tests/engine/fixtures/firm/served_ratio_pair.json`, `served_ratio_pairs.json`
(no `assembled_cf` block, but the Piotroski CFO strings and
`regime.cash.value`; writer `capture_served_ratio_pair.py`) ·
`tests/engine/fixtures/radar/**` (6 + 5) · `regression_baselines/*.json` (8
live; `archive/` untouched). Red until re-captured, by design:
`test_credit_regime_fe_fixture.py`, `test_firm_attention.py:140-152`,
`check_assembled_parity.py` (`f31-parity`), `test_one_ebitda_fe_books.py`,
`test_radar_determinism.py`, `test_served_ratio_pair_fixture.py`.
**Frontend / e2e (step 7):** `frontend/lib/__tests__/fixtures/`
(`oneEbitda/constructed_books.json`, `coverage_popover_corpus.json`,
`comparatives/pair_served.json`, `comparatives/pair_prior_blocks.json` — writer
`scripts/capture_comparatives_pair.py`, test `test_ratio_compare_fe_fixture.py`
—, `served_credit_regime.json`, `served_credit_refusals.json`,
`capsuleTier0/period_*.json`) · `e2e/fixtures/workspace_v2/{scandia,agras}_fy2025.json`,
`e2e/fixtures/provenance/carniprod_period.json` ·
`design_review/capsule/fixtures/period-scandia-fy2025.json`. Every
route-captured fixture holds `valuation: null` today; if O2's default stands
they flip to an object and suites that never painted `ValuationSection` start
to (workspace-v2 e2e, `provenance.spec`, capsule) — re-measure their counts.

### 6.2 Tests that lose their subject (rewrite to the served block; keep the law)
`refusalCarries.test.tsx` (`:88, 114-116, 235, 825-921`) ·
`provisionsAddBack.test.tsx` (`:60, 158-188`) ·
`servedFactsCrossSurface.test.tsx` (`:48, 168-173`) ·
`cashFlowNumericNarrowing.test.ts` · `reportingMetricsCashFlow.test.ts`
(`:51-60, 85-88, 96-102`) · `headlineRefusedEbitda.test.tsx:141` ·
`valuationRefusedOverride.test.tsx` · `oneEbitdaSurfaceComponents.test.tsx:99-145`
· `oneEbitdaSurfaces.test.tsx` · `threeWayParity.test.ts:989-1025` ·
`reportCharts.test.ts:292-300` · `exportRecommendationFigures.test.ts`,
`recommendationMateriality.test.ts` · `ratioCompareTab.test.tsx:896-900` (pins
the export call) · `test_floor_dcf.py` (`:210-304` and `:348-376` read
`fcf_breakdown` on the flat dict; `:310-342` pin the flat route shape and 400s)
· `test_valuation_one_ebitda.py:255-271` (PUTs a forged `ebitda_definition` and
expects 200 — under `extra="forbid"` a 422 that stores nothing) ·
`e2e/valuation.spec.ts` (asserts testids nothing renders; skipped unless
`E2E_REAL=1`) · `e2e/learning-valuation-bridge.spec.ts`.
`scripts/check_cross_view_consistency.py` crashes at HEAD (`NameError`, `:389`)
and is in no gate: port its CFO law (`:172-179`) into `dcf-one-cfo`, then
repair-and-register or delete it.

### 6.3 Census ratchets that move
`design_review/PROVENANCE_CENSUS.json` (`FinancialStatements.tsx` sites,
`financialValuation.ts` absent-leaf 6, the card 22 / 1, the section 7 / 3, the
bridge 14) and `scripts/check_provenance_census.mjs` SURFACES (a registered
render file on no roster is its own red; surface ratchets are exact) ·
`PROVENANCE_BURNDOWN.json` · `design_review/provenance/GATES.md` ·
`design_review/narrative/SWEEP.md:135` · `scripts/floor_census_baseline.json` ·
`scripts/import_boundary_allowlist.txt` · `scripts/check_narrative_units.mjs` ·
the vitest canary list (`scripts/check_vitest.mjs`).

---

## 7. The owner's table, stored rows, deploy

**The table has three parts.** A diff of served keys alone would omit the
figures that move most on screen, because they are computed in the browser
today.

1. **Served keys** — `check_served_valuation.py --dump` before and after,
   `--diff --table --require-key valuation.dcf.schema`. The diff reports MOVED
   / ADDED / REMOVED and the ALIAS rows (an old key against the key that
   replaces it — this is what checks "the DCF equity does not move"). Money
   moves beyond half a cent, everything else beyond 5e-7.
2. **On-screen figures, before → after** — a vitest script run AT THE
   PRODUCTION COMMIT over each dumped body (a second read-only dump keeps the
   full bodies; customer data — it stays on the VPS / the laptop scratch, never
   in the repo) evaluates today's `deriveCashFlow`, `computeCostOfCapital`,
   `runDcf`, `runGraham`, `buildCashFlowStatement`, the card's `core × multiple
   − net debt`, /report §6 and the recommendation rules, and writes `printed.*`
   keys; each is printed beside the AFTER served figure: DCF base / EV /
   equity, WACC tiles, Graham, Cash Flow tab CFO and its new drift line, the
   card's headline (§2: it rises by the 758 / 781 strip), which recommendation
   rules fire, and the Valuation-tab route per period (non-CRE / NAV, by the
   browser's four tests).
3. **Verdict rows** — `piotroski.score`, `verdict.cfo_positive`,
   `verdict.cfo_gt_net_income`, `verdict.fcf_negative_with_capex`, every
   credit letter and composite, and every stored alert that cites CFO or FCF.

Reading rule: any flip of a verdict row, any sign change of
`cf.cash_from_operating` / `cf.free_cash_flow`, and any period whose
`valuation` goes null → object is named to the owner individually.

**Expected to move:** `cf.*` totals down by the proxy (and by ≤ 0.01 where a
total is now footed from rounded rows); `cf.provision_movement` REMOVED;
`cf.depreciation_includes_provision_charges`, `cf.approximation_notes_i18n`,
`valuation.dcf.*`, `valuation.client.*`, `valuation.report_multiples.*`,
`valuation.primary.benchmark.*`, `valuation.primary.multiple_used.*` ADDED;
`cf.approximation_notes[1]` and `credit.regime.cash.*` MOVED; Piotroski detail
strings. **Expected NOT to move** (alias rows silent): DCF EV / equity / WACC /
bookends, the mirrors, every credit letter and composite, the six persisted
columns. Anything else is a finding.

**Stored alert rows are rewritten in this release.** A new read-mostly tool
(`scripts/refresh_period_alerts.py`, dry run first): per stored period, rebuild
the statements from line items, run `stage_validate`, and `--apply` through
`_persist_period_alerts` (council alerts carried over) — no re-extraction, no
model, no quota. (`reprocess_periods_definition.py --force` is the fallback: it
skips periods already on the current definition without `--force`, `:437`,
re-extracts from the stored document and refuses every `needs_model` period.)
The dry run lists, per period, each alert whose title / body / facts change and
each alert that appears or disappears; the owner approves it with the table.

**Recipe (§14; nothing is copied into the running container).**
```
# A/A control, then BEFORE — production's image, the script bind-mounted read-only
docker run --rm --env-file /opt/cfo-ai/.env --network cfo-ai_default -v /tmp/dcf:/hosttmp \
  -v /tmp/dcf/check_served_valuation.py:/app/scripts/check_served_valuation.py:ro \
  --entrypoint python3 cfo-ai-backend:latest /app/scripts/check_served_valuation.py --dump /hosttmp/val_before.jsonl
# AFTER — the CANDIDATE: rsync the branch to /opt/cfo-ai-candidate-dcf (never /opt/cfo-ai),
docker build -t cfo-ai-backend:candidate-dcf /opt/cfo-ai-candidate-dcf     # pattern: specs-durable/build_v6_candidate.sh
docker run --rm --env-file /opt/cfo-ai/.env --network cfo-ai_default -v /tmp/dcf:/hosttmp \
  --entrypoint python3 cfo-ai-backend:candidate-dcf /app/scripts/check_served_valuation.py --dump /hosttmp/val_after.jsonl
```
Never `docker compose run backend` in `/opt/cfo-ai` for the AFTER dump: that is
production's image, and two dumps of one image diff GREEN. After the owner's
approval: `specs-durable/deploy_lane.sh <worktree> dcf <prod_base>` (it syncs
`/opt/cfo-ai`, builds and switches in ONE unattended run and its own move gate
compares only letter / composite — add the valuation dump with the approved
diff as the expected file), `PREFLIGHT_PY` asserting the `dcf/1` schema, the
route models at module scope, the pack at boot and the §3.3 identities on a
served period; F-A3.1; both data gates before and after; backend (with the
mirrors) and frontend in the same lane; then the alert refresh `--apply`;
`docker rmi` the candidate. No schema migration is required.

---

## 8. Open items — the owner rules O1–O5 before step 3 (defaults stated; none assumed approved)

| | item | default in this design | what the owner sees |
|---|---|---|---|
| **O1** | **Cash Flow tab, interim until release C.** With the plug gone and financing untouched, the tab's drift line appears on books with interest (§2). | as §2: operating section only; the drift line shows the unclassified interest | alternative: print the served financing total with a served "Interest paid" row (`assembled_cf.interest_paid`) — one served row, no measurement — and the drift line does not appear in this release |
| **O2** | **Periods with no stored `valuations` row** serve `valuation: null` today; without the client math their panel has no source. | they start serving the engine's valuation (the Overview hero and the assumptions card appear, with a slider that persists); a period with no assembled P&L keeps `valuation: null` | the list of such periods from the BEFORE dump, each with its new primary method (asset-based ones open on the NAV view) |
| **O3** | **Whose figures are in the shared row and the briefing.** PUT persists the caller's overrides into the one `valuations` row; the briefing route and the fallback read them back for everyone; a saved multiple is stored as the benchmark P50 (§1.5). | `persist_valuation` writes the ENGINE's result (no user override; `multiple_ebitda_p50` = the benchmark again); a user's figures live only in `user_valuation_assumptions`, applied at serve time for that user; the briefing values on the engine's figures. Rows already written under an override are used as benchmarks only when p25 ≤ p50 ≤ p75 | the stored columns move on every period that holds an override — count and rows from the dump |
| **O4** | **Graham constants.** Panel g 5 % / Y 4.5 % (18.09 × NI); NAV view g 3 %; Y 4.5 % beside rf 6.75 % in the WACC. | the pack keeps the panel's (no printed figure moves); a non-positive NI REFUSES (it printed a negative "fair value") | confirm, or rule one g and Y = rf |
| **O5** | **Engine-authored valuation sentences are English** (`primary_label`, football-field rows, `method_warnings`, `formula_text`) and are printed on the Romanian page. | served `{ro, en}` from the pack with `money_display` | alternative: English by a named ruling — the gate then excludes those testids by a counted list |
| O6 | The ticket names surfaces that print no DCF today (HTML export, bank PDF, command bar, chat snapshot). | nothing is ADDED (the engine keeps the DCF off public display on purpose); the gate holds them to "absent or served" | rule otherwise to add a section / an answer (the command bar needs a new reader kind: every answer line must be in `LINE_SPECS` and `evidenceLines.json`) |
| O7 | Learning popovers on the DCF panel show operands that contradict the tile (EV operand always 0, ΔWC always 0). | formula text only on those sites | — |
| O8 | Books the browser routes to the NAV view (every `asset_based` primary, and asset intensity ≥ 0.6 — carniprod) get no DcfPanel on screen; the block reaches them through the workbook only, and their only on-screen Graham is the browser's 14.18 × NI, until the NAV release. | as is | rule otherwise to render the DcfPanel inside the NAV route's disclosure in this release |
| O9 | PUT refuses NaN and a non-positive multiple (422); debt / cash are no longer re-sent from served values. | as designed | — |

Ruled already: the card reads the engine's single EBITDA (§2); the Cash Flow
tab's interest classification and opening cash are release C's (§2).

## 9. Out of scope, ticketed or flagged
- **NAV cascade → engine**: `ticket_2026-10-01_nav_cascade_engine.md`.
- **Release C (measured cash flow)**: measured CFO, opening cash (class-5
  opening balances; measured for agras 2,484,418.69), measured Δcash, the
  interest classification on the tab, the tab's declared exceptions, the
  7812 / 7814 reversals inside NI, `dividends_paid` (+400,802.07 on the
  loss-making realestate book: −NI × 0.5 printed as "Dividends paid in cash"),
  deleting the two mirrors.
- `multiPeriodGrowth` CAGR (`financialValuation.ts:2988-3044`) and the
  comparative Δ column (`ComparativeCells.tsx:373`): comparatives.
- Two more "FCF" definitions on the engine: `credit_model.py:1304-1305`,
  `assembled_pl.free_cash_flow_proxy` (`chart_of_accounts.py:1995-1996`).
- `publicCompanyAdapters.ts:490, 524` — the public-company plug (market feed).
- `ScenarioOutcome.tsx:74-88` formats with its own `Intl.NumberFormat` (§26).
- `valuations` / `user_valuation_assumptions` have no DDL in the repo.

## 10. Not verified by anyone
- Production: which periods carry an R8 / R9 alert, have no `valuations` row,
  hold an override (one or several users'), serve negative cash or debt, or have
  one of the flip shapes of §1.4; the column types of the two tables; the host
  `.env` flags; whether HU / AI-lane periods exist in production.
- The post-ruling engine was not run: the "no flip on the measured books" claim
  is arithmetic over the quoted conditions for Piotroski and R8 / R9; findings
  and the credit regime were read, `stage_validate` and the findings engine
  were not invoked.
- No suite was executed for this design (pytest, vitest, tsc, the battery); gate
  floors and canary strings were read, not measured.
- The client TypeScript was not executed for the on-screen "before" figures of
  the three firm books beyond the closed forms quoted here.
- Whether persisted briefings or recommendations cite the proxy CFO (only
  alerts were traced).
- The learning-popover claims of O7 and the line ranges in §6.2 / §6.3 beyond
  the files' existence.
- TanStack Query's hydration behaviour, taken from the repository's own comments.
