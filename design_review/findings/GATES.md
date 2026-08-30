# Findings — gates F1..F9

**Lane:** GATES (F1–F9) + the BEFORE/AFTER delivery table.
**Date:** 2026-08-30.
**Baseline:** `design_review/findings/BASELINE.md` (measured against
production, 2026-08-30).
**Engine under test:** `c2fa175` — the seven-element contract, the company
profile, both engines and the ranker. This lane wrote none of it; it
gates it.
**Battery gate name:** `finding-specificity` (`scripts/run_battery.py`,
one line, immediately before `determinism`). F1 and F3–F9 ride the
existing `pytest` gate.

```
.venv/bin/python -m pytest tests/engine/test_findings_gates.py -q
.venv/bin/python scripts/check_finding_specificity.py
.venv/bin/python scripts/check_finding_specificity.py --self-test
npx vitest run frontend/lib/__tests__/findingsGates.test.ts
```

Delivery table: `design_review/findings/BEFORE_AFTER.md` — three real
production workspaces, their current notes and the rebuilt ones, element
by element, plus the measured specificity distribution.

---

## The defect these gates exist for

Fifty-nine rule-authored findings live. Four out of five told the reader
nothing to **do**; more than half stated a single number with no
comparison basis; eleven rules were doing all of the firing. The worked
example — the note on account 461 — scored **1.5 of the seven contract
elements**:

> Account 461 (Debitori diverși) holds RON 7,692,203 due from related
> parties — 19.6% of total assets RON 39,194,178. Recoverability and
> intent on settlement should be confirmed. Lenders typically haircut
> related-party receivables during covenant measurement.

The figures are correct and native-unit. Everything else is missing: the
rule that fired is never stated, no consequence is recomputed, the
sentence would read identically for any other company, "should be
confirmed" names no artefact and no provider, and no confidence position
is taken at all.

**The class is a missing contract, not a bad sentence.** A finding
assembled out of seven typed elements cannot be missing one; a finding
authored as prose beside its numbers always can be. So the gates test the
contract, not the wording.

---

## The laws

| | Law |
|---|---|
| **F1** | A surfaced finding carries **all seven elements**. Missing any one **demotes** it — to the raw "All checks" row, with the reason. `surfaced` is a verdict the object computes about itself, never a field a caller sets. |
| **F2** | A finding is **specific**: no banned phrasing, at least two figures, at least one imperative verb, at least one ledger code — and the **swap test**: the same rule rendered against another company's data must be materially different text. |
| **F3** | A profile-gated detector **never fires out of profile**, and the reason it did not run is on the checks list. |
| **F4** | **Materiality first.** An item below the floor is at most an info row and is never a recommendation, whatever severity it carries. |
| **F5** | **Every ratio native-unit.** Identical findings and identical percentages whether the book reports RON or EUR; money reaches the reader only as a named placeholder. |
| **F6** | **Cold start.** One period yields the single-period findings plus an explicit needs-more-history note — nothing computed across a history that does not exist. |
| **F7** | **Determinism.** The same snapshot yields an identical finding set, identical ids and identical order, with AI reachable or not. |
| **F8** | **Silence is valid.** A clean book says "no material findings" **and** what was checked. Never filler. |
| **F9** | **No model numerals, and no model write path** — at construction and at runtime. Fully useful with AI unavailable. |

---

## The gates, and the plant that proves each one

Every gate ships with a **plant**: a deliberate defect, proven to trip it,
then reverted. Wherever the plant can live inside a suite it does, so the
proof runs on every battery instead of being an experiment someone has to
take on trust. Each plant below is reproduced with the exact text the gate
emits when it trips.

Two plants deliberately do **not** live in-tree as mutations of the engine:
P5 builds a private `ProfileCatalog` rather than editing `profiles.yaml`
(the module-level catalogue cache is shared with every other test in the
session), and P3 needs no mutation at all — it runs the lint over the 16
**live production bodies** this rebuild replaces, which is a stronger
proof than any synthetic defect.

---

### F1 — the contract

**Gate.** `test_f1_every_surfaced_finding_carries_all_seven_elements` walks
every surfaced finding on all eight regression fixtures (33 findings) and
asserts `missing_elements == []`, then asserts each element carries
content — accounts named, ≥2 figures, a `period_id`, a known comparison
basis, a `profiles.yaml#…` threshold address, a known impact kind, a
profile signal, at least one action step, a declared confidence level.

**Plant P1** — `test_f1_plant_stripping_any_one_element_demotes_the_finding`.
Remove each of the seven, one at a time, from the real 461 finding:

```
strip impact      -> surfaced=False  impact: no impact supplied
strip confidence  -> surfaced=False  confidence: no confidence position —
                     a null caveat is allowed, a null position is not
```

All seven demote, each naming its own element, and the demoted payload
carries `title: None` / `body: None` plus a `check_summary` — so an
incomplete finding degrades to a row with its numbers, never to prose.
**Reverted:** the plant operates on `dataclasses.replace` copies; the
control finding is re-asserted surfaced at the end.

**Plant P2** — `test_f1_plant_a_rule_that_did_not_fire_cannot_be_narrated`.
The subtler half: move the limit so the stated rule no longer holds.

```
threshold: observed 0.19625880786990732 does not satisfy > 1.9625880786990733
           — the rule did not actually fire
```

A detector cannot pick a dramatic band and narrate it anyway.

**Structural gate.** `test_f1_surfaced_is_a_verdict_not_a_field` asserts
`surfaced` is absent from `Finding.__dataclass_fields__` and that passing
it raises. If that ever becomes settable every other gate here is
decorative.

---

### F2 — specificity

**Gate.** Four prose checks plus the swap test, implemented once in
`scripts/check_finding_specificity.py` and **imported** by the pytest
suite, so the battery gate and the test suite cannot drift into
disagreeing about what "specific" means.

* banned phrasing — the four the law names **plus** the whole of
  `_finding.BANNED_PHRASES`. `test_f2_the_four_phrases_the_law_names_are_in_the_engines_own_list`
  fails if the engine's list is ever trimmed below the law.
* ≥ 2 distinct figures.
* ≥ 1 clause led by a verb from `_finding.IMPERATIVE_VERBS`. A verb from
  `WEAK_LEAD_VERBS` ("review the aging") does **not** count — it is the
  banned sentence with the hedge removed.
* ≥ 1 ledger account code.
* the 0..7 **specificity score**, calibrated so the legacy 461 body scores
  exactly the 1.5 BASELINE.md recorded by hand.

**The swap test.** Two measured requirements and one deliberate
non-requirement:

| | Requirement |
|---|---|
| **S1** | at least half the cited numbers differ between the two companies |
| **S2** | with every numeral masked out, the two renderings must **still** differ — so the text carries something that identifies the book (the accounts, the profile, the band that judged it, the period and snapshot the figures came from) |
| *not* | **novel wording**. Two companies that resolve to the same profile and trip the same rule on the same accounts *should* read alike; the narrative is the profile's, and forcing it to differ would mean inventing difference — exactly what the deterministic layer refuses to do. The 5-gram overlap is reported, never gated. |

> **Known limit, stated rather than hidden.** For one measured pair —
> `liquidity_cash_tight` on `scandia_realestate_fy2025` vs
> `scandia_retail_fy2025`, both `unclassified_operator/band_mid/
> fin_bank_levered`, both on accounts 5121/5124/531 — the *only*
> non-numeric difference is the evidence provenance (`period …;
> snapshot …`). S2 passes on that, and it is right to: provenance is one
> of the seven elements and a legacy note carried none. But the pair is
> the thin end of the gate, and it is recorded here so nobody discovers
> it later and mistakes it for a pass that was never examined.

**Plant P3** — the lint over the **live** corpus, no mutation required
(`check_finding_specificity.py --self-test` pins the calibration; the run
below is the same code over the 16 production bodies):

```
FAIL b967905e/leverage_debt_to_ebitda_high  F2-IMPERATIVE  no clause leads with a
     verb from _finding.IMPERATIVE_VERBS
FAIL b967905e/leverage_debt_to_ebitda_high  F2-SUBJECT     names no ledger account
     code, so the sentence is not about a specific book
FAIL b967905e/risk_inventory_cash_tight     F2-IMPERATIVE  …
FAIL b967905e/risk_inventory_cash_tight     F2-SUBJECT     …
FAIL b967905e/risk_inventory_leverage       F2-SUBJECT     …
... 15 of 16 live rows trip the lint
```

**Plant P4** — `test_f2_plant_a_hedge_written_back_into_the_rationale_demotes`.
The banned-phrase gate exercised through the only seam that can reach the
prose, an advisory rewrite:

```
surfaced=False  prose: banned phrasing 'should be monitored'
```

A model that writes the baseline's own sentence back in does not launder
the finding; it demotes it.

**Plant P4b** — `test_f2_plant_swap_test_rejects_the_production_bodies`.
The swap test over the live bodies. `risk_inventory_fx_exposure` shipped
one body to every company it fired on (fails S1 *and* S2);
`risk_inventory_cash_tight` shipped one that differed by a single
percentage (passes S1, fails S2 — which is why S2 exists). All seven
legacy same-rule pairs fail:

```
concentration_intercompany_loan      11b8e759 6c6b8503  figures-differ 0.86  anchored no  FAIL
equity_quality_revaluation_reserves  b967905e 6c6b8503  figures-differ 0.86  anchored no  FAIL
leverage_debt_to_ebitda_high         b967905e 6c6b8503  figures-differ 0.86  anchored no  FAIL
risk_inventory_cash_tight            b967905e 11b8e759  figures-differ 0.80  anchored no  FAIL
risk_inventory_fx_exposure           b967905e 11b8e759  figures-differ 1.00  anchored no  FAIL
risk_inventory_fx_exposure           11b8e759 6c6b8503  figures-differ 1.00  anchored no  FAIL
risk_inventory_leverage              b967905e 6c6b8503  figures-differ 0.67  anchored no  FAIL
```

All 20 rebuilt pairs pass.

---

### F3 — applicability

**Gate.** `test_f3_no_surfaced_rule_is_out_of_its_catalogued_profile`
checks every surfaced rule on every fixture against `profiles.yaml` — the
only place a scope is written down — and against the profile's own
`applicable_detector_ids()`.

`test_f3_an_inventory_rule_does_not_run_on_a_service_company` is the case
the law names: `input_cost_exposure` is scoped to
`inventory_operator, asset_operator`; Sibiu is a `service_operator`. The
rule must not fire, must not appear in the applicable set, must SAY why on
the checks list, and must have formed **no observation at all**
(`observed == [None]`) — a rule that computed a number and then discarded
it is a rule that could leak.

**Plant P5** — `test_f3_plant_widening_the_scope_makes_the_rule_fire_out_of_profile`.
Widen the detector to service companies in a **private** catalogue and
tune its ceiling below Sibiu's observed 24.0% share:

```
planted surfaced: ['fx_exposure', 'input_cost_exposure']
gate says       : input_cost_exposure is scoped to ('inventory_operator',
                  'asset_operator'), this period is service_operator
reverted        : ['fx_exposure']
```

The plant genuinely fires an inventory rule on a service book, and the
gate — measured against the real `profiles.yaml` — rejects it.
**Reverted:** the plant lives in a throwaway `ProfileCatalog`, never in
the module-level cache; the test re-asserts the real catalogue is
untouched and the rule is silent again.

---

### F4 — materiality

**Gate.** Materiality runs **first**, before merge, rank and cap — because
a correctly-detected, perfectly-worded finding about 0.02% of the balance
sheet is still noise, and no amount of ranking makes it not noise.

**Plant P6** — `test_f4_plant_a_critical_item_worth_three_tenths_of_a_percent_is_not_advice`.
Label the real 461 finding **critical** and make it worth 0.3% of the
balance sheet (floor: 0.5% of total assets):

```
0.3% -> tier=info       surfaced=0  info=1  recommendation=False
5.0% -> tier=material   surfaced=1  info=0  recommendation=True
```

The severity label buys it nothing: it lands as an info row with
`effective_severity == "info"` and `recommendation is False`, and it never
reaches `report.surfaced`. The 5% control proves the gate is not simply
rejecting everything. This is the baseline's ordering failure inverted —
there, a `high` note about a rounding difference outranked a `medium` note
about 19.6% of the balance sheet.

Two supporting gates:
`test_f4_arithmetically_invisible_items_do_not_even_reach_the_info_row`
(0.01% goes straight to the checks list with the reason attached), and
`test_f4_materiality_refuses_rather_than_defaults_when_the_basis_is_absent`
— a materiality decision taken against an unknown denominator is not a
materiality decision, so an absent or zero basis **raises**. ABSENT is not
ZERO and it is not "pass".

---

### F5 — the unit law

**Gate, engine side.** Three assertions:

1. every cited figure, threshold and impact declares a unit, and a figure
   whose name `_ratio_units` declares must be cited under that declaration;
2. money reaches the template **only** as a named placeholder —
   `F._orphan_currency_labels(template, currency) == []`, and every printed
   money fact appears as `{{money:…}}`, and no dimensionless fact does;
3. `test_f5_the_same_book_reported_in_eur_yields_the_same_findings`
   re-runs every fixture with `currency: "EUR"` and asserts the same rules
   fire in the same order on the same observations against the same limits
   — and that `title_template`, `body_template`, `facts_cited` and
   `fact_units` come out **byte-identical**. They can, precisely because
   every money figure in them is a placeholder rather than a numeral.

**Gate, display side** (`frontend/lib/__tests__/findingsGates.test.ts`,
fixtures = the engine's real bytes for period `11b8e759`): the parsed
template's dimensionless parts are identical in RON, EUR and USD; every
money part in one claim resolves to one currency; and with the money spans
masked, the RON and EUR renderings are byte-identical.

**Plant P7** — a percentage cited as money:

```
evidence: figure 'pct_of_assets' declared percent in _ratio_units but cited as money
```

**Plant P8** — the 461 defect itself, injected through the advisory seam:

```
prose: render refused: currency label(s) left outside a placeholder:
       unbound money figure at 799 ('RON 9')
```

A currency label beside a number nobody cited converts on one side of the
sentence and not the other. The renderer raises
`OrphanCurrencyLabelError` and the finding is demoted.

**Plant P8b** (display side) — a money numeral baked into a template
renders as inert text beside a converted sibling, producing `RON …` and
`€ …` in one claim. It proves the renderer **cannot** repair an
engine-side numeral, which is why the engine refuses to emit one.

**Plant P8c** (display side) — the same percentage declared as `money`
rides the conversion path and the two displays disagree; declared as
`percent` they are identical. The declaration *is* the gate.

---

### F6 — cold start

**Gate.** `test_f6_one_period_yields_single_period_findings_and_a_history_note`.
A one-period workspace gets the single-period lane in full **and**, from
the multi-period lane, a typed refusal: `cold_start() is True`,
`report is None`, and a `NeedsHistory` naming **every** one of the eight
analyses that is waiting, each also on the checks list with
`observed == 1.0` against its own `limit >= 2.0`. The note is asserted
free of banned phrasing — it is the only output a single-period upload
gets, so filler there is the whole impression it leaves.

**Plant P9** — `test_f6_plant_a_trend_computed_on_one_period_must_fail`.
Reach past the cold-start branch and ask for a trend on a single point:

```
NeedsHistoryError: m_trend needs 4 comparable period(s) and has 1;
accounts_payable has 1 contiguous period(s) at the end of the spine and 0 gap(s)

cold_start: True | report: None
note: This upload carries 1 period (P0) across 1 calendar year. 8 of 8
      multi-period analyses cannot run yet: Decoupling from its driver
      (needs 2 comparable periods); Same period last year …
```

F6 is enforced by **shape**, not by discipline: the windows refuse to be
built short, so the plant proves the refusal rather than the absence of a
call. **Reverted:** `test_f6_a_second_period_lifts_the_refusal` is the
control — with two periods the cold-start branch lifts and a report is
produced, so F6 cannot pass by breaking the feature.

---

### F7 — determinism

**Gate.** Three assertions:

1. the same snapshot yields the same bytes — profile payload, rows, checks
   and silence statement, twice, on all eight fixtures;
2. identical with an AI credential **present** and with the AI SDKs made
   **unimportable** (a `sys.meta_path` hook that raises on `anthropic` and
   `openai`; the modules are evicted from `sys.modules` first and the
   `ImportError` is asserted before the comparison, so the block is proven
   live);
3. the order is total and reproducible — order is part of the output, and
   two runs that agree on the set but not the sequence would still move a
   reader's attention.

**Plant P10** — `test_f7_plant_one_moved_input_changes_the_output`. Move a
single balance by 50%:

```
identical to baseline: False | lengths 29983 vs 29960
```

A determinism gate that cannot see a real change is measuring nothing.
**Reverted:** the baseline is re-computed after the plant and asserted
unchanged, so the mutation cannot have leaked into the fixture.

---

### F8 — silence

**Gate.** `test_f8_a_clean_book_says_nothing_material_and_what_it_checked`
runs a coherent, unremarkable book (defined inline in the suite — its
whole purpose is to carry no finding, and a JSON file of unremarkable
numbers is harder to read as an assertion than the dict that produced it):

```
clean : []  | silence: No finding met the seven-element contract for this
              period. 17 check(s) ran; each is listed …
```

All 17 catalogued detectors appear; at least 12 carry the number they
judged, with a parameter, a comparator, a limit and a declared unit; every
detector that did **not** measure says why. The statement is asserted free
of every banned phrase, and
`test_f8_silence_carries_no_finding_shaped_prose` asserts it has no
`title`, `body`, `severity` or `recommendation` key — there is nothing for
a surface to render as an insight.

**Plant P11** — `test_f8_plant_one_breach_ends_the_silence`. Write two
thirds of book equity up out of a revaluation:

```
planted: ['equity_quality_revaluation_reserves'] | silence: None
```

Exactly one rule fires, silence becomes `None` — silence is a verdict
about the checks, not a default — and the checks list is still complete at
17. **Reverted:** the control re-runs the untouched book and gets its
silence statement back.

> A second candidate breach was tried and rejected as the plant: draining
> cash to RON 200,000 fires `liquidity_cash_tight`, but the finding is
> **demoted** (`impact: no impact supplied`) because the synthetic book
> carries no `days_covered` and the days-of-cost impact cannot be formed.
> Instructive — the contract demotes rather than narrates a rule it cannot
> quantify — but a noisy plant. Recorded here so the observation is not
> lost.

---

### F9 — no model in the numeric path

**Construction.** `test_f9_the_lane_imports_no_model_at_construction`
AST-scans all 19 modules of the deterministic lane (`_finding.py`,
`_company_profile.py`, `_finding_rank.py` and the whole `findings/`
package) for an import of `anthropic`, `openai`, `engine.ai`,
`engine.passes.movement_review`, `engine.interp` or `engine.consensus`.
`test_f9_no_lane_module_constructs_a_client` adds a textual scan for
`Anthropic(`, `OpenAI(`, `messages.create`, `chat.completions`,
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` — which catches an SDK reached
through a late import that the AST scan cannot see.

**Runtime.** `test_f9_the_advisory_seam_takes_prose_and_nothing_else`
asserts the signature of the one seam a model may use is exactly
`(finding, rationale, action_steps)`. A model cannot write a number here
because **there is no parameter to write one into**.
`test_f9_the_numeric_fingerprint_has_teeth` proves the guard behind it
detects a moved severity, profile, cited fact, threshold limit or impact
endpoint. `test_f9_the_lane_is_fully_useful_with_no_credentials` deletes
every credential and asserts 33 findings still surface, all
`narrative_source == "deterministic"`, all with `missing_elements == []`.

**Plant P12** — model numerals, both kinds:

```
currency numeral surfaced: False        (refused — see plant P8)
bare numeral     surfaced: True         <-- F9-OPEN
```

#### F9-OPEN — the one gate this lane could not close

A model rewrite that writes a **money** numeral is refused today: the
currency label cannot bind to a placeholder and the render raises. A
rewrite that writes a **bare** numeral is not.
`apply_advisory_narrative` fingerprints the cited facts, the threshold and
the impact — and a percentage invented inside the rationale *text* moves
none of them. "…this balance has grown 47% since the prior year" survives
into a surfaced finding.

`test_f9_no_model_numeral_survives_into_the_prose` therefore **skips
loudly** rather than passing quietly — a green tick would claim F9 is
closed when it is not. It probes four names the guard may land under:

```
engine.api._finding.assert_no_new_numerals
engine.api._finding.advisory_numeral_guard
engine.api._finding_advisory.apply_advisory_narrative
engine.api.findings.ai_narrative.apply_advisory_narrative
```

and adopts the guard automatically the moment any of them exists — no edit
to this suite required. **This is a cross-lane item for the
ai-sharpening lane.** The obvious shape: extract the numerals from the
rewritten prose and refuse any that is not a cited fact rendered at its
declared unit — the same authority that already decides what money is.

---

## Verification

```
$ .venv/bin/python -m pytest tests/engine/test_findings_gates.py -q
38 passed, 1 skipped, 1 warning

$ .venv/bin/python scripts/check_finding_specificity.py --self-test
PASS self-test  scorer calibrated: legacy 461 = 1.5/7.0, lint trips,
                swap test detects a clone

$ .venv/bin/python scripts/check_finding_specificity.py
F2 SPECIFICITY — 33 surfaced finding(s) over 8 fixture(s)
  score/7.0   min 7.00  mean 7.000  max 7.00  at-full 33
  distribution {'7.0': 33}
  baseline for comparison: the legacy 461 note scores 1.5/7.0
  swap test: 20 pair(s), 0 failing

$ npx vitest run frontend/lib/__tests__/findingsGates.test.ts
13 passed

$ .venv/bin/python scripts/corpus_replay.py
18/18
```

The single skip is F9-OPEN, above. It is the only gate in this lane that
does not hold today, and it is loud on purpose.
