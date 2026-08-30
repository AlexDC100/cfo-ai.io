# SWEEP — narrative numerics, Part A

> **Purpose.** Find every sibling of the Critical-461 mixed-currency note
> **before** anyone writes a fix. This document is the inventory. It changes
> no behaviour and proposes no patch.
>
> **Date:** 2026-08-30 · **Baseline:** `c05eab2` (containment, already shipped)
> **Scope:** every site where a monetary value is interpolated into generated
> text — engine-side and frontend-side.
> **Read-only artefacts:** `scripts/sweep_alert_currency_unity.py` (this lane's
> analysis script; reads `alerts`, writes nothing).

---

## 0. The defect class, stated precisely

The 461 note read:

> Account 461 (Debitori diverși) holds **RON 7,692,203** — 19.6% of total
> assets **7.467.122,25 €**

Two currencies inside one claim. The percentage was *correct* and *native*
(7,692,202.74 / 39,194,178.46 = 19.63%, both RON). The harm was not the
arithmetic — it was that the rendered sentence made a correct ratio look like
cross-currency arithmetic, and made it impossible for the reader to verify.

**The generalised class is a rendering-boundary mismatch, not a maths bug:**

> A generated string is authored in the **source** currency. Some of its
> figures are later re-rendered through a **converting** component; the rest
> are not. Whichever figures miss the conversion path keep their source
> magnitude *and their source label*, next to siblings that changed.

So the audit question at every site is not "is the maths right?" but:

1. Who authored this string, and in which currency?
2. At render time, which of its numbers pass through a **converting**
   renderer, and which stay literal?
3. Does any *ratio* in the same sentence take operands from both sides of
   that boundary?

### The two money renderers in this codebase

Everything turns on this distinction, and it is not signposted anywhere in
the code today:

| Renderer | Converts to display currency? | Labels? |
|---|---|---|
| `components/instrument/Amount.tsx` (`<Amount kind="money" currency=…>`) | **NO** — pure formatter | yes, with the currency you pass |
| `components/ui/Money.tsx` (`<Money fromCurrency=…>`) | **YES** | yes, display currency |
| `components/comparison/MoneyAmount.tsx` (`<MoneyAmount fromCurrency=…>`) | **YES** | yes, display currency |
| `stores/currency.tsx` → `useAmountFormatter(src)` | **YES** | yes, display currency |
| `components/cfo/TraceableNumber.tsx` (`format="currency"`) | **YES** (`sourceCurrency` defaults to `"RON"`) | yes, display currency |
| a bare template literal / f-string | **NO** | only if the author typed one |

A surface is safe when every money figure on it sits on **one** side of that
table. Every finding below is a surface that straddles it.

---

## 1. Verdicts used in the table

| Verdict | Meaning |
|---|---|
| **SAFE** | One currency per claim under every reachable display currency. |
| **MIXED-CURRENCY RISK** | Within one rendered claim / card / drawer, one figure converts and another does not. This is the 461 class. |
| **RATIO RISK** | A ratio, multiple, percentage or per-unit figure is exposed to conversion, or is computed across operands of different unit/scale. |
| **UNLABELLED** | A money figure reaches the reader with no currency word attached, so its unit is inferred from neighbours. |
| **SAFE (fragile)** | Correct today only because of a coincidence (all data is RON, a code path is dark, a flag is unset). One data change arms it. |

`RATIO RISK` and `UNLABELLED` are separate from `MIXED-CURRENCY RISK` on
purpose: they are different failures with different fixes, and one site can
carry more than one.

---

## 2. The audit table

### 2.1 Engine — deterministic alert rules (`stage_validate`)

All 17 rules live in `src/engine/api/pipeline.py`, all emit through the same
`_add(rule_key, severity, category, title, body, facts)` helper (`:2407`).
Every one of them hard-codes the literal string `RON` (26 occurrences) with
no reference to `assembled["statements"]["currency"]`.

| # | site | interpolates | carries a currency label | native / converted at that point | ratio same-sentence, same-unit? | verdict |
|---|---|---|---|---|---|---|
| E1 | `pipeline.py:2426` R1 `data_quality_bs_imbalance` | title + body: `total_assets`, `total_liabilities+total_equity`, `drift`, `drift/assets %` | yes — hard-coded `RON` | native, authored in source currency | yes — pct on two native RON operands | **MIXED-CURRENCY RISK** (title raw on Notes surface) |
| E2 | `pipeline.py:2439` R2 `data_quality_pnl_zero` | title: `total_assets` | yes, hard-coded `RON` | native | n/a | **MIXED-CURRENCY RISK** (title raw on Notes surface) |
| E3 | `pipeline.py:2453/2463` R3 `leverage_debt_to_ebitda_high` | body: `bank_debt_total`, `ebitda_statutory`, `dte`, threshold | yes, hard-coded `RON` | native | yes — `dte` from two native RON operands | **SAFE** *(both money facts are in `facts_cited` and positive → both convert)* |
| E4 | `pipeline.py:2485` R4 `equity_below_half_capital` | title: `total_equity`, `share_capital` | yes, hard-coded `RON` | native | ratio in facts only, not in prose | **MIXED-CURRENCY RISK** (title raw on Notes) + **sign trap** when equity < 0 |
| E5 | `pipeline.py:2501` R5 `earnings_quality_capitalized_own_work` | title + body: `capitalized`, `ebitda_statutory`, **`ebitda_operational` (can be negative)**, pct | yes, hard-coded `RON` | native | pct from two native RON operands | **MIXED-CURRENCY RISK — LIVE, CONFIRMED IN PROD** |
| E6 | `pipeline.py:2518` R6 `equity_quality_revaluation_reserves` | body: `abs(revaluation_reserves)`, `total_equity`, pct | yes | native | yes, native pair | **SAFE (fragile)** — body prints `abs()` while `facts_cited` stores the signed value; a negative 105 balance arms the sign trap |
| E7 | `pipeline.py:2535` R7 `concentration_intercompany_loan` | title + body: `intercompany`, `total_assets`, `pct` | yes | native | yes — the reported 19.6%, correct | **MIXED-CURRENCY RISK — LIVE (5 rows)** via the raw title on the Notes surface. The body was fixed by `c05eab2`; the title was not. |
| E8 | `pipeline.py:2548` R8 `cash_dividends_declared_unpaid` | title + body: `ap_dividends` | yes | native | n/a | **MIXED-CURRENCY RISK — LIVE (1 row)** (raw title) |
| E9 | `pipeline.py:2563/2574` R9 `fcf_negative_development_phase` | title: `cf_fcf` (**negative**); body: `cf_cfo`, `abs(cf_capex)`, `abs(cip_capex)` — while `facts_cited` stores **`capex_real` and `capitalized_construction` as negatives** | yes | native | n/a | **MIXED-CURRENCY RISK — LIVE, CONFIRMED IN PROD (2 rows)** |
| E10 | `pipeline.py:2585` R10 `valuation_ebitda_negative` | title: `ebitda_statutory` (negative when it fires — always) | yes | native | n/a | **MIXED-CURRENCY RISK (latent)** — the one fact is negative by definition, so it can never linkify |
| E11 | `pipeline.py:2633,2644,2655,2666,2677,2687,2699` R-RI-1…7 | percentages, ratios, ×-multiples only. **No money in prose.** | n/a | n/a | operands native, same unit | **SAFE (fragile)** — the render site (`RiskInventory.tsx:112`) has no linkify at all, so the first money figure added to any of these rules is instantly a defect |
| E12 | `_ai_council.py:700-728` `ai_council` summary + per-finding alerts | **LLM free text** ("citing the numbers you were given"), `facts_cited: None` **hard-coded** | whatever the model types | native evidence packet, `currency` passed at `_ai_council.py:301` | unconstrained | **MIXED-CURRENCY RISK (armed, not yet fired)** + **AI authors digits.** 8 rows live today, all the deterministic "no AI members available" baseline. The moment credits are live this writes model-authored money into an alert that structurally *cannot* convert. |

**Sign trap (E4/E5/E6/E9/E10) — the single biggest structural gap left after
`c05eab2`.** The linkify regex is
`/(?:RON\s+)?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:\s+RON)?/g`. It
does **not** consume a leading `-`. A body printing `RON -382,675` matches the
token `382,675` and compares it against `facts_cited.free_cash_flow =
-382675.3`; the delta is 765,350 and the tolerance is 1,913, so it never
matches. **Every negative money fact is permanently unconvertible**, and keeps
its `RON` label beside converted siblings. Same for bodies that print
`abs(x)` while the fact stores the signed value (R9's capex, R6's 105).

### 2.2 Engine — recommendations

| # | site | interpolates | label | native/converted | ratio | verdict |
|---|---|---|---|---|---|---|
| E13 | `pipeline.py:3306` `"expected_cash_impact_kron": r.get("estimated_ron_impact")` | one scalar | none | see below | n/a | **RATIO RISK / scale collision** |
| E14 | `pipeline.py:3188` schema `"briefing": "3 sentences. Industry-aware. **RON-denominated**. …"` vs `pipeline.py:2911` `currency_hint` "cite currency as `{effective_display}`" | the whole briefing | contradictory | — | — | **MIXED-CURRENCY RISK** — two contradictory currency instructions in one prompt; the model picks |
| E15 | `pipeline.py:3124` `_convert_briefing_facts(...)` converts **only** `briefing_facts`; `balance_sheet`, `income_statement`, `metrics[]`, `valuation{}` in the same payload stay **native** | ~40 numbers | none in the payload | mixed inside one payload | — | **MIXED-CURRENCY RISK (severity-max)** — see §4.1 |
| E16 | `pipeline.py:2774` `_convert_briefing_facts` converts **any** top-level `int/float` | every top-level scalar | — | — | — | **RATIO RISK (latent)** — allowlist-free: the first non-money scalar added to `briefing_facts_raw` gets silently FX-multiplied |
| E17 | `briefing/generator.py:26` system prompt: *"Currencies as 'EUR 1.2M' or 'kEUR' as appropriate"* while `:67-68` feeds `… RON` and `:95` feeds `… kRON` | the SKU daily briefing | conflicting | native RON / kRON | — | **MIXED-CURRENCY RISK + RATIO RISK (scale)** — the persona instructs a RON→EUR relabel, and mixes RON with kRON in one fact list |
| E18 | `cfo_ai.py:571-573` `f"Inventory ties up {cash_trapped_m:,.1f}M; {cash_recovery/1000.0:,.1f}M recoverable…"` | two money figures | **none** | native, kRON→MRON in prose | n/a | **UNLABELLED** |
| E19 | `recommendations.py:_explanation_for` (`:126`) | percentages, tonnes, DIO days only | n/a | n/a | native | **SAFE** |
| E20 | `recommendations.py:_expected_cash_impact` (`:75`) returns **kRON**; `cfoDerive.ts:237` also emits kRON; `pipeline.py:3306` writes **RON** — all into the same `recommendations.expected_cash_impact_kron` column, all read by `Decisions.tsx:133` as full units | one scalar | none | — | — | **RATIO RISK — 1000× scale collision in one column** |
| E21 | `_valuation.py:767 _fmt_ron` | — | hard-codes `RON` | — | — | **dead code** — defined, never called. Delete or wire; do not leave a hard-coded-RON formatter lying in the valuation path. |
| E22 | `_reconcile.py:565,586,614` reconciliation rationale details | source-file amounts, `RON`-labelled | yes | native | n/a | **SAFE** — rendered in `TrustChip` beside `<Amount currency={source}>`, which does **not** convert |
| E23 | `confidence/reconciliation_checks.py:281-425` diagnosis details | source-file amounts; 2 of 9 say `RON`, the rest are bare | partial | native | n/a | **UNLABELLED** (SAFE in placement — same `TrustChip` native context) |
| E24 | `public_market/freshness/briefing.py:96` prompt: *"do NOT include financial figures — describe events, not numbers"* | events only | n/a | n/a | n/a | **SAFE (fragile)** — the *only* structural defence in the codebase against AI-authored money, but `_validate_claims` checks `source_url`/`article_date` only; a claim containing a figure is not rejected. Dark today. |

### 2.3 Frontend — narrative producers

| # | site | interpolates | label | native/converted | ratio | verdict |
|---|---|---|---|---|---|---|
| F1 | `lib/recommendationRules.ts:49` `const RON = (n) => \`RON ${Math.round(n).toLocaleString()}\`` — 27 call sites across 13 rules (`:88,90,91,119,127,132,154,162,193,204,207,210,278,286,287,291,347,348,370,377,401,411,412,416,450,481,508`) | titles, rationales, actions | **hard-coded `RON`**, ignoring `facts.currency` | **native, never converted** | rule ratios are native-native | **MIXED-CURRENCY RISK** + **locale trap** (see §4.3) |
| F2 | `lib/buildCashFlowStatement.ts:131,135,147` CF notes | `ap_dividends`, `wcReconciliationPlug`, `closingCashActual` | hard-coded `RON` | **native** | — | **MIXED-CURRENCY RISK** — the note asserts *"the statement balances to the BS cash position of RON X within RON 1"* while every cell of that statement is converted (`CashFlowStatementView.tsx:44`) |
| F3 | `lib/financialReport.ts:814,823,832` ratio commentary | `revenue`, `ebitda`, `netIncome` | yes, `s.currency` (source) | **native** | pct native-native | **MIXED-CURRENCY RISK** at 3 render sites — `FinancialStatements.tsx:4719`, `RatioDetailDrawer.tsx:216` and `:491`, `PublicCompanyDashboard.tsx:306` — all pages whose money converts |
| F4 | `lib/financialValuation.ts:504,522,523,567,631` Piotroski check `detail` | `totalAssets`, `cfo`, `netIncomeStatutory`, `priorDebt`, `totalDebt`, `shareCapital` | yes, `s.currency` (source) | **native** | ROA / margin pairs native-native | **MIXED-CURRENCY RISK** — rendered raw at `FinancialStatements.tsx:5725` |
| F5 | `pages/cfo/Chat.tsx:107-227` `buildWorkspaceSnapshot` | ~35 money figures (`fmtNum`, `:228`) | **none at all** — the only currency word in the whole snapshot is the literal label `"Reconciliation gap (RON)"` at `:152` | native | ratios pushed as separate lines | **UNLABELLED** + **MIXED-CURRENCY RISK** — see §4.2 |
| F6 | `pages/cfo/Chat.tsx:199-226` snapshot embeds the persisted briefing verbatim **and** alert titles verbatim | RON-labelled prose | yes, `RON` | native | — | **MIXED-CURRENCY RISK** — RON-labelled prose injected into a prompt whose directive says "cite in EUR" |
| F7 | `supabase/functions/chat-llm/index.ts:383-397` `buildCurrencyDirective` | *"Reference FX rate: 1 RON = 0.1905 EUR … Show the value in EUR as the primary unit"* | display code | **the model is asked to convert** | *"For ratios, multiples, days, counts, percentages: present unchanged"* — correct, but unenforceable | **MIXED-CURRENCY RISK + AI authors digits (severity-max)** — see §4.2 |
| F8 | `components/learning/LearningPopover.tsx:630, 988, 1228-1230, 1272` `formatValue(v, fmt, {currency})` | headline value, benchmark P25/median/P75, source-account amounts | yes, **source** currency | **native** | — | **MIXED-CURRENCY RISK** — the *same popover* renders `CompositionBreakdown` (`:758`) whose bars use `<Money fromCurrency>` (`components/learning/CompositionBreakdown.tsx:159,186`) = **converted**. Two currencies inside one popover. |
| F9 | `components/learning/LearningPopover.tsx:988` bakes `formatValue(value, format, {currency})` — a **native** figure — into the "Ask CFO AI" preload prompt | one money figure | source currency | native | — | **MIXED-CURRENCY RISK** — a native RON figure lands in the user's chat message, where F7's directive tells the model to convert it |
| F10 | `pages/cfo/BenchmarkReport.tsx:924` `plainValueText` hard-codes `formatExact(value, {currency: "RON"})` for the Explain drawer figures, while the same panel's table (`:269`) and the drawer's own `figureDisplay` (`:973`) use `<MoneyAmount fromCurrency="RON">` = **converted** | company value + industry median, per metric | `RON` hard-coded | native | pct/ratio units correctly excluded | **MIXED-CURRENCY RISK** — and the code comment at `:914` claims *"cent-identical to the table by construction"*, which is false outside RON display |
| F11 | `lib/financialExports.ts:76-120` Cover sheet audit footer *"All figures shown in {display}. Conversion rate: …"* while **no cell in the workbook is converted** | whole workbook | declares display currency | native | — | **MIXED-CURRENCY RISK (unreachable today)** — the only caller (`FinancialStatements.tsx:2372`) omits `currencyCtx`, so the branch is dead. Wiring it without converting the cells produces a workbook that lies on its cover. |
| F12 | `lib/financialExports.ts:341` `"Estimated annual impact"` column | one scalar | **none** | native | — | **UNLABELLED** |
| F13 | `lib/thresholdSchema.ts:40` `fmtKron` (call sites `:101,148`) | rule thresholds | `kRON` | native config value, never converted | — | **UNLABELLED / scale** (low) — labelled, but sits beside converted product money in `DecisionRulesModal` |
| F14 | `lib/contextLines.ts` (all 5 functions) | months, %, × only — **zero money** | n/a | inputs are native, same currency (`StoryOverview.tsx:124,132`) | **operands native, same unit — correct** | **SAFE** — reference-quality |
| F15 | `lib/explain.ts` (whole module) | figures arrive as **already-formatted screen strings** (`:38-43`); the AI prompt (`:157-166`) forbids recompute/convert | inherits the caller's label | inherits the caller | — | **SAFE by construction** — but only as safe as its callers, and F10 is a broken caller |

### 2.4 Frontend — render sites that lose the currency path

| # | site | what it renders | verdict |
|---|---|---|---|
| F16 | `components/cfo/StatementNotes.tsx:285` `{alert.title}` — **raw, no linkify** | engine alert titles, 8 of 17 rules put money in the title | **MIXED-CURRENCY RISK — LIVE, 10 rows.** The body one line below (`:291`) *is* linkified and converts. This is the surface where the 461 note is still two-currency after `c05eab2`. |
| F17 | `components/cfo/StatementNotes.tsx:332` `linkifyAlertBody(rec.explanation, null)` — **facts deliberately null** | server recommendation prose | **MIXED-CURRENCY RISK — LIVE, 4 rows.** With `null` facts the parser early-returns one text part; nothing ever converts. |
| F18 | `pages/cfo/Decisions.tsx:244,249,253` `linkifyAlertBody(x, rec.factsCited)` where `PeriodRecommendation` (`lib/activePeriod.ts:53`) **has no `facts_cited` field** | server recommendation title/rationale/action | **MIXED-CURRENCY RISK — LIVE.** `factsCited` is always `undefined` for DB recs → raw RON prose, directly above `<Money value={rec.estimatedImpact}>` (`:257`) which converts. |
| F19 | `components/cfo/RecommendationsView.tsx:93,100,107,119` title / rationale / actions / what-not-to-do — **raw** | F1's RON-baked prose | **MIXED-CURRENCY RISK** — the "Facts backing" expander at `:142` renders the *same facts* through `fmt(v)` = converted. One card, two currencies, same numbers. |
| F20 | `components/cfo/RecommendationsView.tsx:142` and `pages/cfo/Alerts.tsx:319` — `typeof v === "number" && Math.abs(v) > 1 ? fmt(v) : String(v)` | **every** fact ≥ 1, money or not | **RATIO RISK (severity-max).** `dscr: 1.43`, `debt_to_ebitda: 8.5`, `threshold: 12.0`, `net_debt_ebitda: 4.2`, `lender_concentration_pct`, `current_rate` all clear the `> 1` gate and get **currency-formatted and FX-converted**. A leverage multiple of 8.5× renders as "€1.62". Conversion participating in a ratio, literally. |
| F21 | `components/cfo/simple/StoryOverview.tsx:238,242` `annotateTerms(topRec.title / .rationale)` — no linkify | server recommendation prose | **MIXED-CURRENCY RISK** — Simple mode. The five figure rows above (`:116,147`) are converted through `useConvertedAmounts`; the "one thing to watch" prose below is raw RON. |
| F22 | `pages/cfo/FinancialStatements.tsx:5725` `{c.detail}` | F4's Piotroski details | **MIXED-CURRENCY RISK** |
| F23 | `components/cfo/CashFlowStatementView.tsx:318-320` `{note}` | F2's CF notes | **MIXED-CURRENCY RISK** |
| F24 | `components/cfo/RiskInventory.tsx:112` `{risk.body}` — raw, and the declared `facts_cited` prop (`:21`) is never used | E11's risk bodies | **SAFE (fragile)** — money-free today by luck of rule authorship |
| F25 | `components/cfo/CFOBriefingCard.tsx:150` `{text}` — raw | the AI briefing | **SAFE (fragile)** — correct only because the card re-requests a whole new briefing per currency (`:89`); it inherits every defect of E14/E15 |
| F26 | `components/instrument/shell/TrustChip.tsx:156,183,188 + :212,229` | `<Amount currency={period.statements.currency}>` (**native**) beside raw `rec.rationale` / `d.detail` (**native**) | **SAFE** — reference-quality: both halves are on the same side of the boundary |
| F27 | `components/cfo/PLStatementView.tsx:323,371,390` i18n footnotes: `amount: fmt(x)` (converted) + `currency: display` | 722/628 wash narrative | **SAFE** — reference-quality: converted value + display label, and every derived figure (`fmt(revenueExOwnWork - opexExcl628)`) is computed **native then converted once** |
| F28 | `pages/cfo/ComprehensiveReport.tsx:517,558,718,719` `{fmt(x)} {displayCurrency}` | report narrative | **SAFE** — reference-quality |
| F29 | `lib/financialReport.ts:1870-2000` standalone HTML report — `money(x, s.currency)` (`:2083`) throughout, no conversion anywhere | whole report | **SAFE** — self-consistent native document, *provided* `s.currency === "RON"` (F1's hard-coded label is the one thing that breaks it on a non-RON workspace) |

---

## 3. Quantification

**Sites audited:** 63 distinct interpolation / render sites across 29 files
(19 engine rules + 10 other engine sites + 15 frontend producers + 14 frontend
render sites, some overlapping).

| Verdict | Sites |
|---|---|
| SAFE | 11 |
| SAFE (fragile) | 5 |
| MIXED-CURRENCY RISK | **24** |
| RATIO RISK | 5 |
| UNLABELLED | 6 |

**Reachable today with display currency ≠ native:** 18 of the 24
mixed-currency sites. The 6 that are not reachable today are: F11 (dead
`currencyCtx` branch), E12 (council dark — no credits), E24 (public-market
briefing dark), E10/E17/E20 (need a specific data shape or the SKU path).

**Reachable only on a non-RON source workspace:** F1, F29, plus
`linkifyAlertBody.tsx`'s own `fromCurrency="RON"` / `sourceCurrency="RON"`
and `RatioDetailDrawer.tsx:346` (`<TraceableNumber>` with no `sourceCurrency`,
defaulting to RON). **All 128 production periods are `currency = 'RON'`
today**, so this whole family is latent — but `_detect.py:92-98` genuinely
assigns EUR/other for non-Romanian documents, so it is a real path, not a
theoretical one.

---

## 4. The three highest-risk sites

### 4.1 `stage_narrate` hands the model a payload in TWO currencies and tells it to cite ONE — `pipeline.py:3117-3175`

`_convert_briefing_facts` converts **only** the `briefing_facts` block.
In the same `user_payload`, still **native**:

- `balance_sheet` (`:3149`), `income_statement` (`:3150`)
- `metrics[]` (`:3151-3154`)
- `valuation{}` (`:3158-3175`) — including `equity_p50`, `dcf_equity_value`,
  `ebitda_used`, `total_debt_used`, `cash_used`

Meanwhile `currency_hint` (`:2911`) says *"cite currency as 'EUR' … Every
monetary figure in `briefing_facts` is pre-converted to EUR — do NOT
re-convert"*, and the system prompt says *"You MUST NEVER produce a different
valuation number than the one in `valuation.equity_p50`. The engine is the
source of truth."*

Those two instructions together **guarantee** a RON magnitude printed with a
EUR label — a 5.25× error carrying full engine authority. And `schema.briefing`
(`:3180`) simultaneously demands *"RON-denominated"*. Three currency
instructions, two of them contradictory, one dataset in two currencies.

Reachable now: `CFOBriefingCard.tsx:89` fires
`POST /briefing/regenerate?currency=EUR` on every currency toggle
(`pipeline.py:7344-7362`). The regenerated briefing is returned to the user
and rendered raw.

Also here: `schema.recommendations[].estimated_ron_impact` (`:3188`) asks for
a field named `_ron_` from a model reading EUR facts, and `:3306` writes that
answer into a column named `_kron`. Three units named on one value's path.

### 4.2 Ask CFO AI asks the model to do the FX arithmetic — `chat-llm/index.ts:383-397` + `Chat.tsx:107`

`buildWorkspaceSnapshot` emits ~35 money figures through `fmtNum` with **no
currency word anywhere**, except the single literal label
`"Reconciliation gap (RON)"`. It then appends, verbatim:

- the persisted briefing (RON-denominated prose), and
- alert titles (`"… holds RON 7,692,203 …"`).

The Edge Function wraps that in a directive that says *"Reference FX rate:
1 RON = 0.1905 EUR … Show the value in EUR as the primary unit"*.

So the model receives unlabelled RON numbers, RON-labelled prose, and an
instruction to output EUR — and is expected to multiply. That is **the AI
authoring digits**, the one thing the house law forbids outright. The
directive's *"For ratios, multiples, days, counts, percentages: present
unchanged"* line is correct and completely unenforceable: nothing in the
snapshot marks which lines are money and which are ratios.

`LearningPopover.tsx:988` feeds this same lane a *native* formatted figure
inside the user's own message text.

### 4.3 `recommendationRules.ts:49` — one helper, 27 sites, three defects

```ts
const RON = (n: number) => `RON ${Math.round(n).toLocaleString()}`;
```

1. **Hard-coded label.** Ignores `facts.currency`, which the same module's
   consumer (`RecommendationsView.tsx:69`) reads and passes to `fmt`.
2. **Never converted.** Rendered raw at `RecommendationsView.tsx:100/107/119`,
   directly above the same facts rendered *converted* at `:142`.
3. **Locale trap.** `toLocaleString()` with no locale argument follows the
   **browser**, not the app language. On a `ro-RO` browser it emits
   `7.692.203`, which the linkify regex — which requires comma grouping —
   cannot match at all. So on Romanian browsers this prose is unconvertible
   *even where a linkify path exists*. The engine's Python `{x:,.0f}` is
   locale-stable, so this is a frontend-only hazard, and it is invisible to
   anyone testing on an `en-*` browser.

The same `toLocaleString()` pattern is in `buildCashFlowStatement.ts:131,135,147`.

---

## 5. Production evidence

Read-only, via `scripts/sweep_alert_currency_unity.py` against
`cfo-ai-backend`. **67 alert rows, 11 orgs, 13 periods, 19 recommendations,
14 briefings, 128 financial periods (all `currency = 'RON'`).**

### Alerts a EUR-display user sees with two currencies

| surface | rows | distinct `alert_key`s |
|---|---|---|
| `/alerts` (title **and** body linkified) | **4** | `earnings_quality_capitalized_own_work`, `fcf_negative_development_phase` |
| Statements → Notes (title rendered **raw** beside a converted body) | **10** | `cash_dividends_declared_unpaid`, `concentration_intercompany_loan`, `earnings_quality_capitalized_own_work`, `fcf_negative_development_phase` |
| **UNION — answer to "which notes are affected"** | **10 of 67 (14.9%)** | **`cash_dividends_declared_unpaid`, `concentration_intercompany_loan`, `earnings_quality_capitalized_own_work`, `fcf_negative_development_phase`** |

Spread: **6 orgs, 6 periods.** Severity: 8 `medium`, 2 `info`.
All 5 live `concentration_intercompany_loan` rows — the reported defect's own
rule — are still two-currency on the Notes surface.

Two confirmed live bodies (verbatim from prod):

> **`fcf_negative_development_phase`** — title `Free cash flow RON -382,675 — one-time CIP capex`
> body: `Operating cash flow RON 1,781,405 minus capex RON 2,164,080 (RON 2,164,080 into account 231 …)`
> `facts_cited = {capex_real: -2164079.83, free_cash_flow: -382675.3, cash_from_operating: 1781404.53, capitalized_construction: -2164079.83}`
> → `1,781,405` **converts**; both `2,164,080` and the title's `382,675` **stay RON** (sign trap). **Two currencies in one sentence, live, today.**

> **`earnings_quality_capitalized_own_work`** — body: `… Statutory EBITDA RON 2,127,404 (with 722) vs operational view RON -36,676 (without).`
> `facts_cited.ebitda_operational = -36676.13`
> → `2,127,404` **converts**; `-36,676` **stays RON** (sign trap). **Two currencies in one sentence, live, today.**

Facts that can never match, by rule: `fcf_negative_development_phase` →
`capex_real`, `capitalized_construction`, `free_cash_flow`;
`earnings_quality_capitalized_own_work` → `ebitda_operational`;
`valuation_ebitda_negative` → `ebitda_statutory`.

### Recommendations

4 of 19 carry money in prose, all in the `N RON` **suffix** form the LLM was
taught by `currency_hint`:

| title | tokens in prose | `expected_cash_impact_kron` |
|---|---|---|
| Stress-test debt service against rate scenarios | `716,741 RON`, `210,000 RON` | 210000 |
| Accelerate completion of PPE under construction | `2,164,080 RON` | 250000 |
| Review property opex and tax assessments | `355,607 RON` | 80000 |
| Reconcile balance sheet imbalance | `1,529 RON` ×3 | null |

None can convert (`PeriodRecommendation` carries no facts), and 12 of 19 rows
have a non-null `expected_cash_impact_kron` rendered *converted* beside them.

### Briefings / council

- 14 briefings; 1 contains money tokens (8 of them), 4 mention `RON`.
  Rendered raw; correctness rests entirely on §4.1.
- All 8 `ai_council` rows are the deterministic `"No AI members available"`
  baseline — the council is **dark**, so E12 is armed but has not fired.

---

## 6. Structural root causes (what a fix has to address, not the symptoms)

1. **No marker separating money from ratio.** `facts_cited` is
   `Record<string, number>` with no unit. Every consumer re-guesses:
   linkify guesses "≥1000 = money", the facts expander guesses "|v| > 1 =
   money". Both guesses are wrong in production today (F20).
2. **Sign is dropped on the way in and on the way out.** The regex won't take
   a `-`; several rules print `abs()` while the fact stores the signed value.
   Negatives — losses, outflows, negative equity — are precisely the figures a
   CFO reads hardest, and they are exactly the ones that can't convert.
3. **Titles are second-class.** Three of five render sites linkify the body
   and not the title. 8 of 17 engine rules put money in the title.
4. **`RON` is a literal in 30+ places**, never `statements.currency`.
5. **AI is asked to convert.** Two prompts (F7, E17) instruct the model to
   perform FX arithmetic; one (E15) hands it a payload in two currencies at
   once; one (E14) gives it contradictory currency instructions. None validate
   the digits that come back.
6. **`toLocaleString()` with no locale** in the two frontend narrative
   producers makes the conversion path itself locale-dependent (§4.3).

---

## 7. Blocking notes for the other lanes

- **Do not touch the 19.6% in R7.** It is native-native and correct
  (`pipeline.py:2532`, `pct = intercompany / total_assets`, both RON). It is
  pinned by `frontend/lib/__tests__/noteCurrencyUnity.test.tsx`.
- **The remaining R7 defect is the TITLE**, not the body — `StatementNotes.tsx:285`.
- **Copy these patterns, don't invent one:** `PLStatementView.tsx:323`
  (converted value + display label via i18n), `ComprehensiveReport.tsx:718`,
  `contextLines.ts` + `StoryOverview.tsx:124` (ratio on native operands,
  conversion applied only to the displayed figures), `TrustChip.tsx`
  (native value + native label, both sides consistent), `explain.ts` (screen
  strings only, never a raw number).
- **File ownership:** this lane wrote only
  `design_review/narrative/SWEEP.md` and
  `scripts/sweep_alert_currency_unity.py`. Nothing else was modified.
