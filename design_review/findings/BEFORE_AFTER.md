# BEFORE / AFTER — three real workspaces, note by note

**Date:** 2026-08-30. **Lane:** GATES (F1–F9) + this delivery table.
**Before:** the `alerts` table in production, read-only.
**After:** `s_engine.run_single_period` at `c2fa175`, run locally over the
committed regression fixture that mirrors each workspace.
**Gates + plant log:** `design_review/findings/GATES.md`.
**Measured baseline:** `design_review/findings/BASELINE.md`.

---

## How these rows were taken

The BEFORE column is not paraphrased. Every title, body and
`payload.facts_cited` below was pulled verbatim from the live database
with a read-only select:

```
ssh root@187.124.0.37 "docker exec cfo-ai-backend python3 -c \"
from engine.api import _supabase
with _supabase.admin() as ac:
    rows = ac.select('alerts',
        columns='period_id,alert_key,severity,title,body,payload', limit=5000)
...\""
```

67 rows live, of which 8 are `ai_council::summary` (a different surface,
excluded) and **59 are rule-authored findings** — the population
BASELINE.md measured. This table takes the three workspaces with the
richest coverage: **16 findings across three companies**, including the
461 case.

**Each of the three maps exactly onto a committed regression fixture.**
That is not a convenience — it is what makes the AFTER column checkable:
the same total assets, the same 461 balance, the same EBITDA, to the cent
except for the two lines named below.

| Workspace (period id) | Fixture | Resolved profile | Live findings |
|---|---|---|---|
| `11b8e759…` | `agras_fy2025` | `inventory_operator / band_mid / fin_related_party_funded` | 3 |
| `b967905e…` | `scandia_frozen_fy2025` | `inventory_operator / band_mid / fin_bank_levered` | 5 |
| `6c6b8503…` | `eei_dec_2025` | `property_rental / band_small / fin_bank_levered` | 8 |

Workspace identities are given by period id only. The companies are the
owner's; the arithmetic is what this document is about.

Two figures moved between the eras, and both are stated rather than
smoothed over:

* `b967905e` current liabilities — live `28,988,864.40`, rebuilt
  `28,947,043.15` (a 0.14% difference: the legacy note read a sub-aggregate,
  the rebuilt one reads `assembled_bs.total_current_liabilities`). Both
  round to a **4.3%** cash ratio.
* `6c6b8503` total assets — live `20,181,886.52`, rebuilt `20,183,415.93`
  (0.008%, balance-sheet drift inside the fixture). Equity and the
  revaluation reserve match to the cent.

---

## Workspace 1 — `11b8e759…` · the 461 case

This is the note the whole contract was designed around.

### BEFORE — live, `concentration_intercompany_loan`, severity `medium`

> **Intercompany receivable RON 7,692,203 = 19.6% of total assets**
>
> Account 461 (Debitori diverși) holds RON 7,692,203 due from related
> parties — 19.6% of total assets RON 39,194,178. Recoverability and
> intent on settlement should be confirmed. Lenders typically haircut
> related-party receivables during covenant measurement.

`facts_cited`: `total_assets`, `pct_of_assets`, `intercompany_loans`.

### AFTER — `concentration_related_party`, severity `medium`, category `data_quality`

> **Related-party receivable on 461 at 19.6% — above the 10.0%
> related-party share of total assets (elevated) for mid-size
> inventory-heavy operator**
>
> 461 (Debitori diverși), 451 (Decontări între entitățile afiliate), 452
> (Decontări privind interesele de participare), 455 (Sume datorate
> acționarilor / asociaților): related-party balance on 461 — RON
> 7,692,203; total assets — RON 39,194,178; current liabilities — RON
> 12,934,654; share of total assets — 19.6%. Basis: measured against the
> company's own total assets for the same period. Source: period
> 11b8e759; snapshot snap-11b8e759; accounts 461, 451, 452, 455;
> assembled_canonical_v1. Rule concentration_related_party fires when
> related-party share of total assets (elevated) is above 10.0%; observed
> 19.6%. Impact: Current ratio after a full related-party haircut moves
> from 2.12× to 1.52× (-0.59×). For a mid-size inventory-heavy operator
> this balance is not a customer receivable — it is capital lent inside
> the group with no contractual maturity on the face of the books, and the
> group treasury and the statutory auditor haircuts it in full when
> measuring the covenants. Do this: 1) Pull the 461 sub-ledger by
> counterparty with settlement dates — 461 aging schedule per related
> entity, from the group financial controller (before the next covenant
> certificate). 2) Recompute the gearing covenant with the 461 balance
> excluded — restated covenant calculation, from the treasury team.
> Confidence medium — Cash-flow lines are indirect-method approximations
> because no prior period was supplied; working-capital movements carry a
> wide band. (profile inventory_operator/band_mid/fin_related_party_funded
> resolved from structure).

### Element by element

| Element | BEFORE | AFTER |
|---|---|---|
| **Subject** | ✅ 461 named | ✅ the whole family — 461 + 451 + 452 + 455, each with its Romanian name, the four the pack actually routes into `ar_intercompany` |
| **Evidence** | ⚠ two figures, no provenance, no comparison basis | ✅ four figures with labels; provenance `period 11b8e759; snapshot snap-11b8e759; accounts 461, 451, 452, 455; assembled_canonical_v1`; basis `self_total` — "the company's own total assets for the same period" |
| **Threshold** | ❌ the 10% rule that fired is never stated | ✅ `concentration_related_party` · `share_of_assets_medium` · `> 0.10` · observed `0.19625880786990732`, addressed to `profiles.yaml#detectors.concentration_related_party.thresholds.default.share_of_assets_medium` |
| **Impact** | ❌ none | ✅ recomputed ratio: current ratio **2.12× → 1.52×** (−0.59×) |
| **Why-here** | ❌ reads identically for any company | ✅ profile-derived and anchored — "for a **mid-size inventory-heavy operator** … the **group treasury and the statutory auditor** haircuts it in full" |
| **Action** | ❌ "should be confirmed" — banned form, no artefact, no provider | ✅ two steps, each with an artefact, a provider and (step 1) a horizon: *Pull the 461 sub-ledger by counterparty with settlement dates* → 461 aging schedule per related entity → the group financial controller → before the next covenant certificate |
| **Confidence** | ❌ none | ✅ `medium` — basis `profile inventory_operator/band_mid/fin_related_party_funded resolved from structure`, caveat: cash-flow lines are indirect-method approximations |
| **Score** | **1.5 / 7** | **7.0 / 7** |

### The native-unit maths, in full

Every quotient below has operands in **the same unit, the same currency
and the same scale** — that is what makes the result dimensionless and
identical whether the reader displays RON or EUR.

```
share of assets   7,692,202.74 RON / 39,194,178.46 RON
                = 0.19625880786990732            (RON/RON → dimensionless)
                → 19.6%                          printed as literal text
limit             0.10                            profiles.yaml, default band
fires             0.19625880786990732 > 0.10      ✓

current assets   27,397,734.37 RON   assembled_bs.total_current_assets
current liab     12,934,654.20 RON   assembled_bs.total_current_liabilities
baseline ratio    27,397,734.37 / 12,934,654.20 = 2.118165197644016  → 2.12×
haircut ratio    (27,397,734.37 − 7,692,202.74) / 12,934,654.20
                = 1.5234679895810437             → 1.52×
delta             −0.5946972080629724             → −0.59×
                  ( = 7,692,202.74 / 12,934,654.20 exactly — the haircut is
                    the balance itself, expressed in units of one period's
                    current liabilities )
```

The 19.6% and both multiples render as **literal text**; the three money
figures render as `{{money:intercompany_loans}}`,
`{{money:total_assets}}` and `{{money:cur_liab}}`. That is what makes the
claim single-currency: switch the display to EUR and the three money spans
convert together while every ratio in the sentence is byte-identical
(gated by `test_f5_the_same_book_reported_in_eur_yields_the_same_findings`
and by `frontend/lib/__tests__/findingsGates.test.ts`).

### The other two on this workspace

| Rule | BEFORE (score) | AFTER (score) |
|---|---|---|
| `risk_inventory_cash_tight` → `liquidity_cash_tight` | "Cash covers only 9.0% of current liabilities — heavy dependence on revolvers." No account, no threshold, no action. **0.5/7** | "Cash cover on 5121 / 5124 / 531 … at 0.09× — below the 0.12× cash-ratio floor for mid-size inventory-heavy operator", impact **4 days → 6 days** of operating cost, two steps with providers. **7.0/7** |
| `risk_inventory_fx_exposure` → `fx_exposure` | "Significant FX cash position. Movements in EUR/RON or USD/RON create P&L volatility. Consider an FX hedging policy…" — **zero figures in the body**, and the identical body shipped to all three workspaces. **0.0/7** | "Foreign-currency cash on 5124 inside the cash balance at 11.4% — above the 10.0% FX share of cash ceiling…", with 5124/765/665 named and the net-margin consequence recomputed. **7.0/7** |

---

## Workspace 2 — `b967905e…` · a levered inventory operator

### `leverage_debt_to_ebitda_high` → `leverage_debt_to_ebitda` (critical)

**BEFORE**

> **Debt/EBITDA at 6.28× exceeds 6.0× critical threshold for generic**
>
> Bank debt RON 32,986,479 divided by statutory EBITDA RON 5,256,298 =
> 6.28×, above the 6.0× critical threshold typical for this industry.
> Covenant breach risk.

Note the word **"generic"** in the live title. That is the industry key
printing itself: the threshold table was keyed by `industry_key`, and when
nothing was assigned the note told the reader they were being graded as
*generic*. It also names no ledger account and no action.

**AFTER**

> **Drawn bank debt on 162 / 167 / 519 against statutory EBITDA at 6.28× —
> above the 6.00× Debt/EBITDA covenant alarm for mid-size inventory-heavy
> operator**
>
> 162 (Credite bancare pe termen lung), 167 (Alte împrumuturi și datorii
> asimilate), 519 (Credite bancare pe termen scurt): drawn bank debt — RON
> 32,986,479; statutory EBITDA — RON 5,256,298; gross leverage multiple —
> 6.28×. Basis: the multiple is the company's own drawn debt over its own
> statutory EBITDA, judged against the ceiling this structural profile is
> graded on. Source: period b967905e; snapshot snap-b967905e; accounts
> 162, 167, 519; assembled_canonical_v1. Rule leverage_debt_to_ebitda
> fires when Debt/EBITDA covenant alarm is above 6.00×; observed 6.28×.
> Impact: Gross leverage, as drawn versus after the cash balance is
> applied moves from 6.28× to 6.04× (-0.24×). Earnings cover is the test a
> mid-size inventory-heavy operator is refinanced on: the lending bank's
> credit committee sizes facilities off EBITDA, and at this multiple the
> next renewal is negotiated from a position of weakness rather than
> choice. Do this: 1) Draft the covenant certificate on this period's
> figures before the testing date — covenant compliance certificate with
> the leverage calculation shown, from the treasury team (before the next
> testing date). 2) Refinance the facilities maturing inside twelve months
> — refinancing term sheet or a written extension of the existing
> facility, from the relationship bank. Confidence medium — … (profile
> inventory_operator/band_mid/fin_bank_levered resolved from structure).

| Element | BEFORE | AFTER |
|---|---|---|
| Subject | ❌ no account named | ✅ 162 / 167 / 519 |
| Evidence | ⚠ figures, no provenance, no basis | ✅ 3 figures + provenance + basis |
| Threshold | ⚠ the limit is stated, the rule and its address are not — and "typical for this industry" with the industry printed as *generic* | ✅ `leverage_debt_to_ebitda` · `critical` · `> 6.00×`, addressed to `…thresholds.by_profile.inventory_operator.critical` |
| Impact | ❌ "Covenant breach risk." | ✅ gross → net leverage **6.28× → 6.04×** (−0.24×) |
| Why-here | ❌ "typical for this industry" | ✅ "the test a **mid-size inventory-heavy operator** is refinanced on: **the lending bank's credit committee** sizes facilities off EBITDA" |
| Action | ❌ none | ✅ *Draft the covenant certificate…* / *Refinance the facilities maturing inside twelve months…* |
| Confidence | ❌ none | ✅ `medium`, with the cash-flow approximation caveat |
| **Score** | **1.0 / 7** | **7.0 / 7** |

```
gross leverage    32,986,478.75 RON / 5,256,298.14 RON
                = 6.275610300522261              → 6.28×
limit             6.00×    profiles.yaml#…by_profile.inventory_operator.critical
net of cash      (32,986,478.75 − 1,255,039.17) / 5,256,298.14
                = 6.036841658300608              → 6.04×
delta             −0.238768642221653             → −0.24×
```

The threshold moved with the profile, not with a guess: the default
`critical` band is 6.0× and `inventory_operator` inherits it, but a
`property_rental` book would have been judged at 12.0× and a
`service_operator` at 5.0×. In the baseline the same 6.0× applied to all
of them unless someone remembered to add an `elif`.

### `risk_inventory_cash_tight` → `liquidity_cash_tight` (high)

**BEFORE** — "Cash covers only 4.3% of current liabilities — heavy
dependence on revolvers. A 15-day disruption could push the company past
covenants or payment terms." **0.5/7** — one figure, no account, no
threshold, no action, and the identical body shipped to `11b8e759` with
`9.0%` in place of `4.3%`.

**AFTER** — "Cash cover on 5121 / 5124 / 531 against current liabilities
at 0.04× — below the 0.12× cash-ratio floor for mid-size inventory-heavy
operator", with cash RON 1,255,039 and current liabilities RON 28,947,043
cited, the impact recomputed as **10 days → 29 days** of operating cost,
and two steps (*Obtain a committed overdraft sized to one month of
operating cost* → signed committed facility term sheet → the relationship
bank → within this quarter; *Negotiate longer settlement terms on the
largest 401 supplier balances* → revised payment calendar for the ten
largest supplier accounts → the procurement lead). **7.0/7**

```
cash ratio        1,255,039.17 RON / 28,947,043.15 RON
                = 0.043356385779941053           → 0.04×
limit             0.12×  (floor; comparator "<")
fires             0.0434 < 0.12                  ✓
```

The remaining three on this workspace — `risk_inventory_leverage`,
`risk_inventory_fx_exposure`, `equity_quality_revaluation_reserves` —
score **1.5 / 0.0 / 1.5** before and **7.0** after
(`risk_inventory_leverage` is now `leverage_net_debt_ebitda`, observed
**6.04×** against a `4.50×` covenant alarm).

Both leverage rows surface here, and deliberately so: the single-period
runner reports every rule that fired. Collapsing two views of one balance
into a primary and a contributor is `_finding_rank.rank_findings`'
one-root-cause merge, which runs when a caller ranks the candidates — it
is not the detector's decision, and this lane does not claim it happened
where it did not.

---

## Workspace 3 — `6c6b8503…` · a small property-rental vehicle

### `equity_quality_revaluation_reserves` — same rule key, both eras

**BEFORE** (severity `info`)

> **Revaluation reserves are 68% of equity**
>
> Account 105 (Rezerve din reevaluare) of RON 3,980,158 represents 68% of
> total equity RON 5,823,954. This is a non-cash accounting reserve from
> upward revaluation of property — equity quality is materially lower than
> the balance sheet suggests for lender / buyer analysis.

This is the **best** of the sixteen live notes: it names the account, cites
two figures and explains itself. It still scores **1.5 / 7** — because it
never says what rule fired or at what level, never recomputes what "lower
equity quality" is worth, and never says what to do.

**AFTER** (severity `medium`)

> **Revaluation reserve on 105 inside book equity at 68.3% — above the
> 40.0% revaluation share of equity ceiling for small property-rental
> vehicle**
>
> 105 (Rezerve din reevaluare): revaluation reserve on account 105 — RON
> 3,980,158; book equity — RON 5,823,954; total assets — RON 20,183,416;
> revaluation reserve as a share of book equity — 68.3%. … Rule
> equity_quality_revaluation_reserves fires when revaluation share of
> equity ceiling is above 40.0%; observed 68.3%. Impact: Equity ratio once
> the revaluation reserve is removed from both sides moves from 28.9% to
> 11.4% (-17.5%). Book equity is how a small property-rental vehicle
> demonstrates solvency to the lending bank's credit committee; the part of
> it created by writing assets up has never been cash, and is the first
> thing discounted in a gearing covenant. Do this: 1) Obtain the valuation
> report that supports the 105 balance, with its effective date —
> independent valuation report and the valuer's engagement terms, from the
> valuer engaged by the company (before the next covenant certificate). 2)
> Recompute the gearing covenant on equity excluding account 105 —
> restated gearing calculation on both definitions, from the treasury team.
> Confidence medium — …

| Element | BEFORE | AFTER |
|---|---|---|
| Subject | ✅ 105 named | ✅ 105 named |
| Evidence | ⚠ two figures, no provenance, no basis | ✅ four figures + provenance + `self_total` basis |
| Threshold | ❌ | ✅ `> 40.0%`, from `…by_profile.property_rental.share_of_equity_high` — a property vehicle is graded at 40%, everyone else at 25% |
| Impact | ❌ "materially lower than the balance sheet suggests" | ✅ equity ratio **28.9% → 11.4%** (−17.5pp), removing the reserve from **both** sides |
| Why-here | ⚠ generic lender/buyer framing | ✅ "how a **small property-rental vehicle** demonstrates solvency to **the lending bank's credit committee**" |
| Action | ❌ | ✅ obtain the valuation report (with its effective date, from the valuer) · recompute the covenant on both definitions |
| Confidence | ❌ | ✅ `medium` |
| **Score** | **1.5 / 7** | **7.0 / 7** |

```
share of equity   3,980,157.61 RON / 5,823,953.67 RON
                = 0.6834116195845356             → 68.3%
limit             0.40    profiles.yaml#…by_profile.property_rental
equity ratio      5,823,953.67 / 20,183,415.93 = 0.28855143699156777  → 28.9%
ex-revaluation   (5,823,953.67 − 3,980,157.61) / (20,183,415.93 − 3,980,157.61)
                = 1,843,796.06 / 16,203,258.32
                = 0.11379168458507918            → 11.4%
delta             −0.17475975240648859           → −17.5 percentage points
```

The reserve comes out of **both** numerator and denominator. Removing it
from equity alone would have overstated the fall — the write-up sits in
the asset carrying value too, and a gearing covenant that discounts the
reserve discounts the asset with it.

### `risk_inventory_fx_exposure` → `fx_exposure`

**BEFORE** — the same body as the other two workspaces, word for word:
"Significant FX cash position. Movements in EUR/RON or USD/RON create P&L
volatility. Consider an FX hedging policy or natural-hedge alignment with
foreign-currency liabilities." The title carried the only company-specific
content in the whole note: `45%`. **0.0 / 7** — no figure in the body, no
account, a banned lead verb ("Consider").

**AFTER** — "Foreign-currency cash on 5124 inside the cash balance at
45.4% — above the 10.0% FX share of cash ceiling for small property-rental
vehicle", naming 5124 / 765 / 665, citing RON 679,103 against RON
1,494,837, and recomputing net margin **52.3% → 63.7%** (+11.4pp) with the
recorded currency result excluded. Two steps: *Match the foreign-currency
cash against foreign-currency payables, currency by currency* → net
exposure schedule per currency → the treasury team; *Lock a forward
contract over the uncovered net position* → forward contract confirmation
→ the relationship bank. **7.0 / 7**

```
fx share of cash  679,102.51 RON / 1,494,836.81 RON
                = 0.45429876054497215            → 45.4%
limit             0.10
```

### Three rows that stop firing here — and why that is the point

The live surface showed **eight** findings for this company. The rebuilt
one surfaces **five**. Nothing was suppressed: three rules were graded
against a **property vehicle's** thresholds instead of a manufacturer's,
and passed. Each is on the checks list with its own number and the limit
that let it through:

| Rule | Observed | Limit for `property_rental` | Limit for the default profile | Outcome |
|---|---|---|---|---|
| `leverage_debt_to_ebitda` | 6.62× | **8.00×** (high) | 4.00× | did not fire |
| `leverage_net_debt_ebitda` | 5.92× | **7.00×** (high) | 3.00× | did not fire |
| `concentration_related_party` | 12.9% | **15.0%** (elevated) | 10.0% | did not fire |

> `related-party balances sit inside the share this profile tolerates`
> `gross leverage sits inside the comfort ceiling this profile is graded on`

This is the single clearest demonstration of why `profiles.yaml` is data.
A property-rental vehicle is underwritten on the asset and on rent cover;
6.6× EBITDA is unremarkable there and alarming at a food manufacturer. The
baseline had one threshold table keyed by `industry_key` — the same 6.0×
for both, unless someone remembered to add an `elif` — and so it shipped a
**critical** covenant alert to a property company that was not near a
covenant. Three of eight live findings on this workspace were that
mistake.

The three legacy rows not detailed above —
`fcf_negative_development_phase` (2.0),
`earnings_quality_capitalized_own_work` (2.5) and
`risk_inventory_affiliate_dep` (0.0) — score **0.0–2.5** before; their
rebuilt counterparts (`fcf_negative`,
`earnings_quality_capitalized_own_work`, `affiliate_income_dependency`)
score **7.0**.

---

## The measured specificity distribution

Scored with `scripts/check_finding_specificity.py::score_text` — the same
scorer, the same ruler, both eras. The scorer is calibrated against
BASELINE.md's hand audit: it returns exactly **1.5** for the legacy 461
body, and `--self-test` fails the build if that ever drifts.

Scored on **title + body**, since that is what a reader sees.

### BEFORE — 16 live findings, three workspaces

| Score /7 | Findings |
|---|---|
| 0.0 | 4 |
| 0.5 | 2 |
| 1.0 | 2 |
| 1.5 | 6 |
| 2.0 | 1 |
| 2.5 | 1 |

**min 0.0 · mean 1.03 · max 2.5 · at full marks: 0**

Prose-lint failures across those 16:

| Rule | Failing |
|---|---|
| no imperative verb (F2-IMPERATIVE) | **13 of 16 — 81%** |
| no ledger account code (F2-SUBJECT) | **10 of 16 — 63%** |
| fewer than two figures (F2-FIGURES) | **4 of 16 — 25%** |
| banned phrasing (F2-BANNED) | **3 of 16 — 19%** |

15 of the 16 trip at least one. The 81% with no imperative verb reproduces
BASELINE.md's 80% over the full 59-row population, on an independent
sample — the ruler is measuring the same thing the hand audit did.

**Swap test:** all **7** same-rule pairs fail. Every one fails **S2** —
with the numerals masked, the two companies' notes are byte-identical.
Two of them (`risk_inventory_fx_exposure`) fail **S1** as well, because
the body contains no figure that *could* differ.

### AFTER — 33 surfaced findings, eight fixtures

| Score /7 | Findings |
|---|---|
| 7.0 | 33 |

**min 7.0 · mean 7.000 · max 7.0 · at full marks: 33 of 33**

Prose-lint failures: **0**. Swap test: **20 pairs, 0 failing** — every
rule that fires on two books produces text that differs by more than its
numerals, and at least half of the cited numbers differ.

```
$ .venv/bin/python scripts/check_finding_specificity.py
F2 SPECIFICITY — 33 surfaced finding(s) over 8 fixture(s)
  score/7.0   min 7.00  mean 7.000  max 7.00  at-full 33
  distribution {'7.0': 33}
  baseline for comparison: the legacy 461 note scores 1.5/7.0
  swap test: 20 pair(s), 0 failing
```

### The distribution is not the whole claim

A finding at 7.0 that nobody should have been shown is still noise. Three
things the score does not measure, gated separately:

* **F4 materiality** — the ranker drops anything below 0.5% of the balance
  sheet out of the recommendation list, whatever its severity says.
* **The cap** — seven surfaced, the rest listed under All checks with a
  count, so "we found 23 things and are showing you 7" is visible.
* **F8 silence** — a clean book scores nothing at all, and that is the
  correct output. The live surface had no way to express it.

---

## What did not improve, and is not claimed to have

* **`asset_maturity` still never fires.** It is registered with the
  parameter "accumulated-depreciation share of gross PP&E", and the
  canonical views carry neither gross PP&E nor accumulated depreciation.
  The rule now *says so* on the checks list, naming both missing fields,
  instead of silently computing 0.0 — which is what it did for months. The
  gap is stated, not closed.
* **A bare model numeral is not yet refused.** See F9-OPEN in `GATES.md`.
  A currency-labelled numeral written by an advisory model is demoted; a
  bare one ("grown 47% since the prior year") is not. Cross-lane item for
  the ai-sharpening lane; the gate is written and skips loudly until it
  lands.
* **The one thin swap pair.** `liquidity_cash_tight` on two
  identically-classified books differs only in its numerals and its
  provenance. Recorded in `GATES.md` rather than tuned around.
