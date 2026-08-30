# Narrative numerics — gates U1..U6

**Lane:** GATES (U1–U6) + verification Parts D and E. **Date:** 2026-08-30.
**Baseline:** `c05eab2` (containment, already shipped — not redone here).
**Battery gate name:** `narrative-units` (`scripts/run_battery.py`, one line,
immediately after `metric-units`).

```
.venv/bin/python -m pytest tests/engine/test_narrative_units.py -q
node scripts/check_narrative_units.mjs
node scripts/check_narrative_units.mjs --self-test
npx vitest run frontend/lib/__tests__/narrativeUnitGates.test.tsx
```

Inventory this lane depends on: `design_review/narrative/SWEEP.md` (63 sites,
29 files). Nothing here re-audits it; it enforces it.

---

## The defect these gates exist for

The Critical note for account 461 rendered:

> Account 461 (Debitori diverși) holds **RON 7,692,203** — 19.6% of total
> assets **7.467.122,25 €**

One claim, two currencies. **The percentage was correct and native**
(7,692,202.74 / 39,194,178.46, both RON — verified row by row in Part D
below). The harm was not arithmetic: a rendered sentence made a correct
ratio unverifiable and invited a cross-currency reading of it.

The class is a **rendering-boundary mismatch**. A string is authored in the
source currency; some of its figures later pass through a converting
renderer and the rest do not. Whichever figures miss the conversion path
keep their source magnitude *and their source label*, beside siblings that
changed.

---

## The laws

| | Law |
|---|---|
| **U1** | A rendered claim carries **at most one currency**. A currency counts only when it labels a figure — a currency word in prose ("movements in EUR/RON create volatility") is not a unit. |
| **U2** | A ratio is computed on **native operands of identical currency AND scale**, then displayed. Conversion never participates. Consequence, and what is actually asserted: the ratio is **invariant** under a display-currency change — the RON view and the EUR view show the same percentage. |
| **U3** | A narrative template must not **build its own money numeral** and must not **hard-code a currency label** beside an interpolation. Placeholders only. |
| **U4** | The same fact is **cent- and percent-identical** in a note, in the statement rows it is drawn from, and in an export. |
| **U5** | The live 461 case is pinned in **both** display currencies. |
| **U6** | **AI carries narrative; it never authors digits.** |

---

## The gates

Every gate ships with a **plant** — something that deliberately breaks the
law and proves the gate goes red. Plants live *inside* the suites wherever
possible, so the proof runs forever instead of being a one-off experiment
someone has to trust. The two file-level plants that cannot live in-tree
were run against real files, verified red, and reverted; both are logged
below with their output.

| # | Law | Where | Plant | State |
|---|---|---|---|---|
| **U0** | The Python mirror of the TS render contract IS the TS contract | `test_narrative_units.py::TestU0ContractInSync` | `test_u0_regex_still_refuses_a_leading_minus` (pins the sign trap as a fact, so fixing it is a visible act) | GREEN |
| **U1** | One currency per rendered claim — engine corpus, all 67 live rows | `test_narrative_units.py::TestU1MixedCurrency` | `test_u1_plant_a_second_currency_trips_the_gate` **+ its inverse** `test_u1_plant_a_prose_currency_word_is_NOT_a_violation` | GREEN (6 rows quarantined, below) |
| **U1** | One currency per rendered claim — real components, real formatter, real toggle | `narrativeUnitGates.test.tsx` | `PLANT — the pre-c05eab2 render is caught in EUR` | GREEN (sign trap asserted as KNOWN RED) |
| **U1-SOURCE / U1-HELPER** | A narrative template must not bake in a currency | `check_narrative_units.mjs` | `--self-test` (5 firing + 7 inverse) **+ the live-file plant logged below** · `narrativeCount()` per-file coverage guard | GREEN (8 violations quarantined) |
| **U2** | Ratio units + display invariance | `test_narrative_units.py::TestU2RatioUnits` (hypothesis, 200 examples) · `narrativeUnitGates.test.tsx` | `test_u2_plant_a_ratio_computed_post_conversion_is_wrong_and_caught` | GREEN |
| **U3** | No money numeral built inside a narrative template | `check_narrative_units.mjs` | `--self-test` case 3, and the *quiet* case "a RATIO rendered inline is correct" | GREEN (8 quarantined) |
| **U3E** | Engine templates interpolate the cited FACT, not a transform of it | `test_narrative_units.py::TestU3EngineTemplates` | `test_u3e_plant_a_transformed_money_interpolation_is_caught` + `test_u3e_scan_finds_the_rule_templates_at_all` (anti-vacuity) | GREEN (4 quarantined) |
| **U4** | Cross-surface parity, cent- and percent-identical | `test_narrative_units.py::TestU4CrossSurfaceParity` · `narrativeUnitGates.test.tsx` | `test_u4_the_two_asset_authorities_diverge_by_a_known_amount` (pins a real 124,935.63 divergence line by line) | GREEN |
| **U5** | The 461 case in RON, EUR **and** USD | `narrativeUnitGates.test.tsx::U5` | `PLANT — an un-armed plant is not a pass` | GREEN |
| **U6** | Model-authored numerals rejected | `test_narrative_units.py::TestU6ModelNumerals` | `test_u6_plant_a_model_authored_numeral_is_rejected` | GREEN — `engine.ai.numerals` **landed mid-lane**; no skip needed |

### U5 — extended, not duplicated

`frontend/lib/__tests__/noteCurrencyUnity.test.tsx` (shipped with `c05eab2`,
read-only for this lane) pins the **parser** on the **RON** side.
`narrativeUnitGates.test.tsx` extends it to the **rendered output** under a
real currency toggle, in RON, EUR and USD. It deliberately restates none of
what the parser test already proves.

### U6 — no longer conditional

The brief allowed a `skipIf`-missing with a loud note. It is not needed:
the ai-boundary lane landed `src/engine/ai/numerals.py` while this lane was
running. The `importorskip` remains, with its reason string written as a
**loud alarm** rather than a shrug — a silent skip is how a missing guard
looks exactly like a working one.

### U2 — imports the law, does not re-implement it

The first draft of U2 hand-rolled a `Quantity` / `ratio` / `UnitMismatch`
trio. `engine.api._ratio_units` landed mid-lane with exactly that law, so
U2 now **imports it** and reads as its acceptance test from the narrative
side. The one thing U2 defines locally is `convert()` — deliberately, in
the test: a module whose purpose is to keep conversion out of arithmetic
has no business exporting a converter.

---

## U3 scope — exactly what is in, and what is not

**IN** (frontend narrative producers, from SWEEP §2.3, listed as `SCOPE` in
`check_narrative_units.mjs` with their sweep ids):

| file | sweep id |
|---|---|
| `frontend/lib/recommendationRules.ts` | F1 |
| `frontend/lib/buildCashFlowStatement.ts` | F2 |
| `frontend/lib/financialReport.ts` | F3 |
| `frontend/lib/financialValuation.ts` | F4 |
| `frontend/lib/financialExports.ts` | F11/F12 |
| `frontend/lib/thresholdSchema.ts` | F13 |
| `frontend/pages/cfo/Chat.tsx` | F5/F6 |

A file in this list that is renamed or deleted is a **MANIFEST failure**,
not a silent coverage loss. So is a file that yields **zero** narrative
template literals: the lint asserts non-zero coverage per scoped file,
because a walker that quietly stops seeing anything passes just as green as
a clean file. That guard fired for real during this lane —
`thresholdSchema.ts` yields no prose at all, only unit-stamping formatters
— and the answer was to teach `U1-HELPER` the trailing-unit and scale-
prefixed shape (`${…} kRON`) rather than to drop the file from scope.

**OUT, and why:**

- **Engine Python narrative** — covered by U3E in the pytest suite instead;
  a JS lint has no business parsing f-strings.
- **`.toFixed()` on a ratio, percentage, multiple or day-count.** These are
  dimensionless and invariant under the display currency; rendering one
  inline is *correct* and is what the reference-quality `lib/contextLines.ts`
  does. The first draft of this lint flagged all 47 of them, which would have
  buried the real findings and got the gate switched off. `toLocaleString()`
  is the money shape **and** the locale-dependent one — that is the line.
- **i18n-mediated surfaces** (`PLStatementView.tsx`, `ComprehensiveReport.tsx`)
  — reference-quality: converted value + display label via placeholders.
- **`lib/explain.ts`** — figures arrive as already-formatted screen strings
  by construction; it is safe as long as its callers are, which is a caller
  problem (F10), not a template problem.
- **Render sites** (`StatementNotes.tsx`, `RecommendationsView.tsx`,
  `Alerts.tsx`, `Decisions.tsx`, …) — they choose a *renderer*, they do not
  author a template. U1's render-level gates cover them.
- **Tests, fixtures, `corpus/`, `src/engine/public_ro/`,
  `src/engine/public_market/`** — out of this lane entirely.

---

## The quarantines are ratchets, not exemptions

Several laws are violated by code this lane does not own. Rather than ship
a red battery or a silent skip, every violation is **enumerated with an
owner**, and the assertion is **equality**:

- a **new** violation fails — the gate's day job;
- a **fixed** violation *also* fails, with "delete its entry" — so the list
  cannot rot into a permanent exemption and the owning lane's fix is forced
  through this gate.

### U1 — 6 live claim/surface pairs (`U1_QUARANTINE`)

> **The four `notes` entries are LANDED-BUT-INERT, not unfixed.** The
> render-surface lane shipped `narrativeMoney.tsx` mid-lane:
> `StatementNotes.tsx` now renders title *and* body through `NarrativeText`,
> which resolves **named** facts from `title_template` / `body_template`
> rather than guessing money out of rendered text. That is a better fix
> than this gate asked for — it kills the regex guess, the sign trap and
> the locale trap at once.
>
> It is also inert today. `NarrativeText` falls back to `linkifyAlertBody`
> when a row carries no template, and **0 of the 67 live alert rows carry
> one** — verified read-only against production, where every payload holds
> exactly `facts_cited`, `industry`, `rule_key`. Templates are written by
> `_ratio_units.templatize` at `stage_validate` time, so they appear only
> after the engine change is **deployed** and each period is
> **reprocessed**. Until then these rows still show two currencies to a
> EUR user. The gate fails the day the data catches up — which is the
> signal the deploy wants. **Owner: engine deploy + period reprocess.**

| rule | surface | why | owner |
|---|---|---|---|
| `cash_dividends_declared_unpaid` | notes | title renders raw — legacy row, no `title_template` | deploy + reprocess |
| `concentration_intercompany_loan` | notes | same — **the 461 note's own remaining defect** | deploy + reprocess |
| `earnings_quality_capitalized_own_work` | notes | same | deploy + reprocess |
| `fcf_negative_development_phase` | notes | same | deploy + reprocess |
| `earnings_quality_capitalized_own_work` | alerts | sign trap (`ebitda_operational` is negative) | engine-rules / linkify lane |
| `fcf_negative_development_phase` | alerts | sign trap (`capex_real`, `capitalized_construction` are negative) | engine-rules / linkify lane |

### U3E — 4 engine templates (`U3E_QUARANTINE`)

| interpolation | why | owner |
|---|---|---|
| `abs(revaluation_reserves)` | R6 prints `abs()`; `facts_cited` stores the signed value | engine-rules lane |
| `abs(cf_capex)` | R9, same shape; `capex_real` is negative | engine-rules lane |
| `abs(cip_capex)` | R9, same shape | engine-rules lane |
| `total_liabilities + total_equity` | R1 prints a **derived sum**; both addends are cited, their sum is not, so the figure can never match a fact and can never convert. Latent — `data_quality_bs_imbalance` has no live rows | engine-rules lane |

### U1-SOURCE / U1-HELPER / U3 — 7 frontend sites (`QUARANTINE` in the mjs)

| file | codes | why | owner |
|---|---|---|---|
| `frontend/lib/recommendationRules.ts` | U1-HELPER ×1 | `const RON = (n) => \`RON ${…toLocaleString()}\`` — one helper, 27 call sites, rendered raw directly above the same facts rendered **converted** at `RecommendationsView.tsx:142` | recommendations lane |
| `frontend/lib/buildCashFlowStatement.ts` | U1-SOURCE ×3, U3 ×3 | the CF notes assert "the statement balances to the BS cash position of RON X within RON 1" while every cell of that statement is converted | cash-flow lane |
| `frontend/lib/thresholdSchema.ts` | U1-HELPER ×1 | `fmtKron = (v) => \`${v.toFixed(1)} kRON\`` — labels its unit honestly, which is more than most of this codebase manages, but the value never converts and renders in `DecisionRulesModal` beside product money that does. Low severity, real class | decision-rules lane |

---

## Plant log — the four that could not live in-tree

**1. `check_narrative_units.mjs` against a real file.**
Planted into `frontend/lib/financialReport.ts:823`, replacing the correct
`${formatCurrency(t.ebitda, s.currency)} EBITDA — …` with
``` `EBITDA of RON ${Math.round(t.ebitda).toLocaleString()} in operating cash generation.` ```:

```
NARRATIVE-UNITS: FAIL
  U1-SOURCE  frontend/lib/financialReport.ts  1 violation(s), quarantine allows 0
            823: RON ${
  U3         frontend/lib/financialReport.ts  1 violation(s), quarantine allows 0
            823: ${Math.round(t.ebitda).toLocaleString(
2 problem(s).                                                        exit=1
```

Reverted; `git diff --stat frontend/lib/financialReport.ts` is empty and the
gate returns to PASS.

**2. The U1 render plant, verified against real DOM output.**
Rendering the live body with only the *bucketed* fact supplied reproduces
the pre-`c05eab2` state exactly:

```
post-fix, EUR display :  … holds 1.547.726,96 € due from related parties
                         — 19.6% of total assets 7.886.152,52 €.
PLANT   (pre-fix)     :  … holds RON 7,692,203 due from related parties
                         — 19.6% of total assets 7.886.152,52 €.
```

The second line is the reported defect, character for character in shape.
It lives on as `PLANT — the pre-c05eab2 render is caught in EUR`.

**3. The skip plant — proving the suite cannot vanish into green.**
Both `_ratio_units` and `engine.ai.numerals` were made to raise `ImportError`
at their import site:

```
15 passed, 11 skipped
SKIPPED  !!! U2 NOT ENFORCED !!! engine.api._ratio_units is missing …
SKIPPED  !!! U6 NOT ENFORCED !!! engine.ai.numerals is missing …
```

U0, U1, U3E and most of U4 still ran. The first draft used a **module-level**
`pytest.importorskip`, which would have skipped all 26 tests and reported
the identical green as a full pass. Class-level `skipif` with an alarm in
the reason string is what replaced it. Reverted.

**4. A plant that did not arm — and why that is in the record.**
The first draft of the U1 plant did `body.replace("RON 39,194,178", …)` on
a shape fetched by rule name alone. Five companies fired that rule; the
helper returned a *different* company's row, the replacement matched
nothing, and the "plant" proved the gate worked when it had done nothing.
Only the plant's own assertion caught it. `_shape()` now takes a `contains=`
selector and the plant asserts `planted != original`. **A plant that cannot
fail to arm is not a plant.**

---

## Part D — account 461, recomputed natively, row by row

Period `11b8e759-70b2-47fd-b08f-3a2c7550c21c`, org `b2025358…`, currency
**RON** (all 128 production periods are RON). The engine's own extraction is
the source of truth: `statement_line_items` + `assembled_canonical_v1`.

### The numerator — 7,692,202.74

`assembled_canonical_v1.leaves.ar_intercompany` declares
`ras_line_items_count: 4`. Those four rows:

| RAS account | name | amount (RON) |
|---|---|---:|
| `4511.01` | Sume de încasat SCR | 7,536,754.90 |
| `461.016` | Debitori diverşi afiliaţi | 143,709.49 |
| `461.06` | Debitori diverşi Băbeanu Eduard | 5,637.91 |
| `461.07` | Debitori diverşi ALBU ADRIAN MIRCEA | 6,100.44 |
| | **SUM** | **7,692,202.74** |

Cent-identical to `facts_cited.intercompany_loans`. ✅

### The denominator — 39,194,178.46

`assembled_bs.total_assets` is the sum of seven legacy buckets
(`chart_of_accounts.py:1331`). Summing the **108 persisted BS asset rows**:

| bucket | rows | RON |
|---|---:|---:|
| cash | 36 | 1,168,047.04 |
| ar | 6 | 8,513,384.96 |
| inventory | 25 | 8,933,332.42 |
| otherCurrentAssets | 12 | 8,782,969.95 |
| ppe | 19 | 11,055,449.54 |
| intangibles | 4 | 673,090.13 |
| otherNonCurrentAssets | 6 | 67,904.42 |
| | **108** | **39,194,178.46** |

Cent-identical to `facts_cited.total_assets`. ✅

### The ratio

7,692,202.74 / 39,194,178.46 = **0.19625880786990732** → **19.6%**, which is
`facts_cited.pct_of_assets` to twelve decimals. Both operands native RON,
same scale. **The 19.6% is correct and is not cross-currency.** The
`7.467.122,25 €` on screen was 39,194,178.46 RON ÷ 5.2489 — a display
conversion of the denominator only.

All of the above is now pinned in `TestU4CrossSurfaceParity`; the tables are
the test's fixtures.

### Two findings Part D turned up that are NOT currency defects

**D-1 — the note attributes the whole figure to the wrong account.**
The prose says *"Account 461 (Debitori diverși) holds RON 7,692,203"*.
**97.98% of that figure — 7,536,754.90 — is account `4511.01`**, a class-451
affiliate settlement account, not 461. The 461 family alone totals
**155,447.84**, which is **0.40%** of total assets — far below the rule's
own 10% firing threshold, so on account 461 alone this note would not
exist. Two of the three 461 rows are named natural persons, not entities.
The **number** is right for "intercompany receivables (451 + 461)", which is
what the canonical leaf `ar_intercompany` means and what the rule reads
(`pipeline.py:2376`); the **sentence** is wrong. Not this lane's file
(`pipeline.py:2538`) — reported, not fixed. Severity: a reader who opens
account 461 to verify the claim will find 2% of it.

**D-2 — the period carries two total-asset authorities that disagree by
124,935.63 (0.32%).** `canonical_bs` (schema `bs_v2`, `status: BALANCED`,
`difference: 0.0`, source-conservation invariant satisfied) totals
**39,319,114.09**; `assembled_bs.total_assets` — the one the note, the
balance sheet (`buildBsStatement.ts:1071`) and the export all read — totals
**39,194,178.46**. The bridge reconciles exactly:

| | RON |
|---|---:|
| canonical_bs total assets | 39,319,114.09 |
| less `4428` tax recoverable, absent from the legacy buckets | −48,733.72 |
| less `413` unclassified debit, absent from the legacy buckets | −46,613.06 |
| less `4091.01` supplier debtors, negative in legacy only | −29,588.85 |
| **= assembled_bs.total_assets** | **39,194,178.46** |

**The 19.6% survives either denominator** (19.63% legacy vs 19.56%
canonical — both render "19.6%"), so the pin is safe. Pinned in
`test_u4_the_two_asset_authorities_diverge_by_a_known_amount` so the
divergence cannot drift silently. Owner: the canonical-BS lane.

---

## Part E — every other note re-verified

### The affected workspace (`b2025358…`, period `11b8e759`)

All **4** notes re-verified individually:

| note | money in prose? | verdict now |
|---|---|---|
| `concentration_intercompany_loan` | yes | **body single-currency** (was RON + display). Title still raw → quarantined. |
| `risk_inventory_cash_tight` | no | clean, both surfaces |
| `risk_inventory_fx_exposure` | no | clean — names EUR/RON as **prose**, labels no figure |
| `ai_council::summary` | no | clean (deterministic "no AI members" baseline) |

### Every workspace — 67 alerts, 11 orgs, 13 periods

Measured by replaying the exact `parseLinkifiedBody` contract before and
after `c05eab2` over every live row, on both render surfaces.

| surface | before | after | fixed | newly armed | persisting |
|---|---:|---:|---:|---:|---:|
| `/alerts` (title + body linkified) | 14 | **4** | 14 | 4 | 0 |
| Statements → Notes (title raw) | 14 | **10** | 9 | 5 | 5 |
| **union** | **14 of 67 (20.9%)** | **10 of 67 (14.9%)** | **9** | **5** | **5** |

**Answer to "how many notes were affected and are now correct":**
**14 notes across 10 orgs and 12 periods rendered two currencies. 9 are now
correct** — every `equity_quality_revaluation_reserves` row, whose
`revaluation_reserves` fact has no `FACT_TO_SOURCE` bucket and so stayed
literal beside a converted `total_equity`: the 461 mechanism exactly. On the
`/alerts` surface **all 14 bodies are fixed**, including all 5
`concentration_intercompany_loan` rows.

### ⚠ `c05eab2` also armed 5 rows that were not two-currency before

This is the finding that most needs an owner, and it is why U1 is asserted
as *equality* rather than *no more than before*.

Pre-`c05eab2`, a fact with no `FACT_TO_SOURCE` bucket rendered as literal
text. In four rules, **no** cited fact had a bucket, so nothing converted
and the claim was uniformly RON — wrong for a EUR user, but *internally
consistent*. Post-fix, the matchable facts convert while the unmatchable
ones (negative, or in a raw title) do not, so the claim is now **two**
currencies:

| rule | rows | orgs | what converts | what cannot |
|---|---:|---:|---|---|
| `fcf_negative_development_phase` | 2 | 2 | `cash_from_operating` 1,781,405 | `capex_real` −2,164,080 ×2 (sign trap) |
| `earnings_quality_capitalized_own_work` | 2 | 2 | `capitalized_own_work_memo`, `ebitda_statutory` | `ebitda_operational` −36,676 (sign trap) |
| `cash_dividends_declared_unpaid` | 1 | 1 | `dividends_payable` in the body | the same figure, raw, in the title |

Live body, verbatim from production today:

> Operating cash flow RON 1,781,405 minus capex RON 2,164,080 …

At EUR display that reads *"Operating cash flow 358,432.60 € minus capex
RON 2,164,080"*. Two currencies, one sentence, shipped by the fix.

`c05eab2` was still net-positive (14 → 10, and 14 → 4 on `/alerts`) and was
the right containment. But **the sign trap is now load-bearing**: until the
regex consumes a leading `-` and the rules stop printing `abs()` beside a
signed fact, every negative money figure is a second currency waiting for a
converted neighbour. Losses, outflows and negative equity are precisely the
figures a CFO reads hardest.

All five are quarantined by name in `U1_QUARANTINE` / `U3E_QUARANTINE` and
asserted as **KNOWN RED** in `narrativeUnitGates.test.tsx`, which fails the
moment they are fixed and tells whoever fixed them to promote the case.

---

## Reading the evidence yourself

Production reads were read-only, via PostgREST with the service-role key
(`SUPABASE_SERVICE_ROLE_KEY`), against `alerts`, `financial_periods` and
`statement_line_items`. Nothing was written. The census is reproducible from
the fixtures committed inside `tests/engine/test_narrative_units.py`:
`LIVE_ALERT_CORPUS` is all 28 distinct `(rule, title, body, facts_cited)`
shapes covering all 67 rows, with live multiplicities, so a census over that
tuple **is** a census over production. Real bytes, not synthetic fixtures —
the sign trap and the 461 attribution error would both have survived a
hand-written fixture.
