# Ticket 2026-10-01 — the CRE NAV cascade moves into the engine

**Status: TICKETED by owner ruling 2026-10-01** ("CRE NAV cascade = its own
release right after measured cash flow; ticket it now"). Not designed, not
started. Release order: `r-rulings2` → Phase 2.3 (DCF → engine,
`design_2026-10-01_dcf_engine.md`) → measured cash flow → **this**.

Rule (owner, 2026-10-01): no financial computation in the browser, one engine
for every number. The NAV view is a whole valuation computed in the browser.

Inventory measured on `release/r-rulings2` at `b4cf1ee7` (read-only).

## 1. What runs in the browser today

`frontend/lib/buildNavCascade.ts` (492 lines), printed by
`frontend/components/cfo/NavValuationView.tsx` (449 lines). One caller:
`frontend/pages/cfo/FinancialStatements.tsx:2580` (`buildNavCascade`) and
`:2607` (`NavValuationView`), on the CRE route only.

### 1.1 Computed figures (all client arithmetic)
1. **NOI** (`:164-174`): `opex_property_management` is written nowhere in `src/`,
   so NOI is always the proxy — the served `valuation.noi_approximation.value`
   when passed, else `ebitda − inventory_variation`.
2. **Dividend stream** (`:177`): `pl.dividend_income ?? pl.financial_income_other`
   — `dividend_income` is not a served key, so the stream is
   `financial_income_other`: the `financial_income` sub-aggregate (7611 / 7612 /
   762 / 763 / 767 — dividends plus other financial income and 767 discounts),
   excluding interest (766) and FX gains (765) (`chart_of_accounts.py:494, 2098`).
   It is 0.00 on agras, carniprod and realestate; retail 5,453,923.78.
3. **Book value per rule** (`:182-193`): BS line items grouped by account
   pattern, summing `Math.abs(amount)` (credit-side sub-accounts add, not net).
4. **215 accumulated depreciation** (`:197-202`): account `2815` exactly.
5. **Per-account fair value** (`:204-275`): 215 → `NOI / cap rate`; 261x →
   `dividends / yield`; 471 → 50 % haircut; the rest at face. **212 carries
   method `cap_rate` but no branch marks it** (the branches test `code === "215"`):
   fair = book, labelled as cap-rate.
6. **Total uplift** (`:291-292`).
7. **Layer 1 Book NAV** (`:302-312`): `bs.total_equity` or its served refusal.
8. **Layer 2 Adjusted NAV** (`:315`): book + uplift.
9. **Deferred tax** (`:321-322`): `(revaluation_reserves + uplift) × 16 %`.
10. **Layer 3 NNNAV** (`:323`) — the page's primary figure.
11. **Liability adjustment** (`:326-336`): computed, never rendered.
12. **Hidden items** (`:339`): always `[]`.
13. **Sensitivity 3 × 3** (`:344-356`): cap rate {7, 8, 9 %} × yield {8, 10, 12 %}.
14. **Cap-rate equity** (`:360-367`): `NOI / cap + (total_assets − ppe_net) −
    total_debt`; `investment_property_net` is not served and `ppe_net` is ALL
    PP&E.
15. **Graham** (`:374-379`): `NI × (8.5 + 2×3) × 4.4 / 4.5` = 14.1778 × NI — a
    different Graham from the Valuation panel's (g 5 %, 18.0889 × NI), which
    Phase 2.3 moves into the engine block.
16. **"EV/EBITDA"** (`:383-384`): `ebitda × 10.5 − (total_debt − cash)` — an
    equity figure at a hard-coded multiple, on the reported EBITDA.
17. **Convergence band / confidence** (`:390-401`): spread < 20 % high, < 40 %
    medium.
18. Layer descriptions and use-case mapping (`:419-490`): static English prose.

Layer 4 "Liquidation NAV" exists only as a type (`navStructure.ts:12, 22, 39`).

### 1.2 Constants hard-coded in the browser
cap rate 0.08 (`:142`), affiliate yield 0.10 (`:143`), CIT 0.16 (`:144`),
prepaid haircut 0.50 (`:75`), materiality floor 100 (`:284`), sensitivity grids
(`:345-346`, duplicated in the view `:242, 245`), Graham 8.5 / g 3 / 4.4 / Y 4.5
(`:379`), EV/EBITDA 10.5 (`:384`), convergence 0.20 / 0.40 (`:401`), cap-rate
range ± 0.01 (`:464`), yield range [0.08, 0.12] (`:466`), the account rule table
`ASSET_RULES` (`:57-84`), the cap-rate basis sentence (`:145-147`).

### 1.3 Routing — two different CRE tests
- Frontend (`FinancialStatements.tsx:2530-2561`): industry string OR
  rental-dominated OR `valuation.primary_method === "asset_based"` OR asset
  intensity ≥ 0.6. The intensity reads `investment_property` and `cip`, which
  `assembled_bs` does not serve (it serves `ppe_investment_net`,
  `ppe_under_construction`), so it is `ppe_net / total_assets`.
- Engine (`_valuation.py:704-734`): a set of `real_estate*` keys; and
  `primary_method = "asset_based"` on FOUR bases (`sector_real_estate`,
  `margin_not_meaningful`, `ebitda_refused`, `ebitda_not_positive`) — so a
  non-real-estate company with a refused or non-positive EBITDA also lands on
  the NAV view.
- **Measured: carniprod — a meat processor with a positive EBITDA — is routed
  to the NAV view by the browser** (`ppe_net / total_assets` 0.75 ≥ 0.6; agras
  0.282, retail 0.035, realestate 0.079, the Scandia baseline 0.386) although
  the engine's primary method for it is `ev_ebitda`: its on-screen primary is a
  cap-rate NNNAV. The routing block (thresholds 0.5, 100,000 and 0.6,
  `FinancialStatements.tsx:2530-2561`) is itself financial arithmetic in the
  browser.
- The NAV route renders `NavValuationView` + the EV/EBITDA card +
  `ValuationSection` and no `ValuationPanel`: until this release lands, those
  books never see the engine's DCF / WACC / Graham block on screen (Phase 2.3
  open item O8), and their only on-screen Graham is this view's.

### 1.4 Defects seen while reading (verify before fixing)
- `fmtShort` (`NavValuationView.tsx:40-47`) returns a suffixed string and the JSX
  appends a literal `M` again (`:81, 94, 102-103, 325-326, 337`) — as written a
  value prints "36.73MM". Not rendered to confirm.
- All copy English-only (no `t()`); refusals print `.text.en`; figures are not
  on `lib/money` (§26).
- 212 buildings never marked to market (§1.1.5).
- No e2e spec references any `nav-*` testid.

## 2. What the engine already has (`src/engine/api/_valuation.py`)
Routing (`:704-734`); `asset_based_equity` / `asset_based_refusal`
(`:875-885`); the CRE range book + 20 % / + 50 % of `ppe_net` (`:909-929`,
labelled investment property but reading all PP&E, `:645-646`);
`noi_approximation` (`:1124, 1157-1182`); the football-field NAV row
(`:936-944`). **No NAV module exists under `src/engine`** — no cap-rate
marking, no account ladder, no deferred tax on revaluation, no sensitivity
grid, no convergence band. `archive/calibration_toolkit/` holds only the
"simple version" (`financial_analysis.py:632-637`); `nav_calculator.py` and
`nav_methodology.md`, named in CLAUDE.md §2, are not in the tree.

## 3. Scope of the release
- A pure engine module (`src/engine/valuation/nav.py`) and a served block
  (`valuation.nav`, schema `nav/1`): layers, the per-account adjustment table,
  deferred tax, the sensitivity grid, cross-methods, the convergence band, the
  use-case mapping, every refusal bilingual — constants and sentences in the
  valuation pack Phase 2.3 creates (`packs/valuation/valuation.yaml`).
- ONE routing authority, the engine's, served (`valuation.routing`); the
  frontend's four-way test is deleted.
- ONE Graham: the block Phase 2.3 serves (`valuation.dcf.graham`); the NAV
  view's own goes (this moves NAV figures — owner decision 6 below).
- Consumes from Phase 2.3: `packs/valuation/valuation.yaml`,
  `valuation.dcf.graham`, `valuation.primary.benchmark`, `valuation.client`,
  the single-EBITDA ruling (the 10.5× row), `lib/dcfServed.ts`, the
  no-browser-math gate pattern. Nothing this ticket defers is required for
  Phase 2.3 to keep the NAV view working (`buildNavCascade` imports only
  `plStructure` / `servedOneEbitda` / `navStructure`; `valuation.noi_approximation`
  stays served).
- `NavValuationView` becomes a printer (i18n, `lib/money`); `buildNavCascade.ts`
  is deleted, no fallback.
- Gates on the Phase 2.3 pattern: served block, served-equality,
  no-browser-math, reader-language, fixture held to the route; the
  `refusal-carries` NAV canaries (`run_battery.py:1433, 1438`) re-pointed.
- Per-period dry-run table of every NAV figure that moves, to the owner, before
  any deploy (§14).

## 4. Owner decisions the design will need
1. Which properties are marked: 215 only, or 212 too.
2. The dividend stream for 261x: real dividend income (761x only) or the
   761 / 762 / 763 / 767 sub-aggregate as today.
3. Cap rate, yield, haircut, CIT: standing pack defaults vs per-company inputs
   (the recompute route already echoes `property_market_value`,
   `annual_lease_expense`, `shares_outstanding` without consuming them —
   Phase 2.3 drops those pass-throughs).
4. The "EV/EBITDA" row at 10.5×: keep (on which EBITDA — see Phase 2.3 open
   item O1) or replace by the served primary band.
5. Who is routed to the NAV view (§1.3).
6. Graham in the NAV cross-methods: the engine's (18.09 × NI as ruled in Phase
   2.3, refusing on NI ≤ 0) replaces this view's 14.18 × NI — the convergence
   band and its confidence move on every NAV-routed book; or the pack carries a
   real-estate growth.
7. A refused Graham: the band is formed on the remaining methods (today a
   negative Graham is a bound of the band — realestate −11.4M).

## 5. Tests and ratchets that pin today's behaviour
`refusalCarries.test.tsx:236-243, 332-362, 498-556` (gate `refusal-carries`);
`oneEbitdaSurfaceComponents.test.tsx:236-258` (NOI proxy = EBITDA − net 711);
`oneEbitdaSurfaces.test.tsx:151-160` (NAV EV/EBITDA back-solves the served
EBITDA at 10.5×; gate `one-ebitda`); `design_review/PROVENANCE_CENSUS.json`
(`NavValuationView.tsx` 33 sites, `buildNavCascade.ts` 10 absent-leaf);
`scripts/check_provenance_census.mjs:580`.
