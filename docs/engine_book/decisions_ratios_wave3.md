# Decisions — ratios wave three (credit revision 2), 2026-09-19

Rulings applied: `floor_rulings.md` (R-COMPOSITE, R-D1..D4, R-RANGE) and
`ratios_rulings_r3.md` Q2 (corrected); owner 2026-09-18: a labelled top
rung only where reality is genuinely best-case and the label says why;
exploded values refuse; absent inputs refuse; the range gate is absolute.
Short entries, one per decision; the commit messages carry the detail.

## D1 — continuation: the previous attempt's work was kept, not re-derived

The prior attempt died on a spend limit with revision 2 already committed
(e2450ac engine, 6573270 fixtures, 0bea88d merge of main, d95c384 book).
Uncommitted on disk: the FE mirror (step 6) and the served-range gate
(step 7, half). Both were read against the rulings and kept whole:

- FE: the renormalised-weights reader from 2802d56 is gone; a served
  composite beside a refused component is withheld, never re-weighted; the
  reader re-checks the composite and every sub-score against the served
  `ranges` before rendering (C9.4); declared rungs render labelled and only
  when the rung score equals the served sub-score. Committed as b739795
  (tsc at the 10-error capsuleAskGuard baseline; vitest 45 passed; the
  full vitest run green).
- served-range: the law file imports nothing from the product; kept
  verbatim. Committed with the floor census and the registrations.

Nothing was trimmed or reverted.

## D2 — floor census: two tiers, because this batch rules on credit only

The sweep's printed scope is 14 files, but the R-OTHER fix list (C2-C10:
valuation, briefing, public risk, period days, SKU shares) belongs to
later waves. A gate that reds on those today is a gate nobody runs. So:

- CREDIT TIER (credit_model, credit_pack, ratios/table,
  comparatives/ratio_compare): S1-S7 and CLAMP are red absolutely unless
  the exact site is allow-listed.
- RATCHET TIER (the other ten files) and S8 / OR_ZERO everywhere: every
  (file, class) count is held to `scripts/floor_census_baseline.json`.

S8 (a literal 365 in the DSO/DIO/DPO products, the `else 365.0` period
fallbacks in table.py and ratio_compare.py) sits on the ratchet even in
the credit tier: the period-days law is R-OTHER, not this batch's ruling,
and pinning it as a hard red here would either block this wave or invite
an allow-list entry that lies. The ratchet prints the counts; the period
wave tightens its own rows.

## D3 — the ratchet reds on a count FALLING, not only rising

A ratchet whose baseline goes stale lets the next regression back up to
the old count pass unseen. A fall is a one-line `--write-baseline` in a
named commit; the gate says so in its message. Same reason
`check_null_boundaries.mjs` exists; a stricter form.

## D4 — allow-list guards are named by code text, never by line number

The sweep's design said `band_saturation:<file:line>`. Plant B (two lines
removed above the clamps) produced twelve spurious "stale guard" reds: an
edit anywhere above the site would trip the gate for nothing, which is how
a gate gets disabled. The guard is now `<file>:<guard code text>`; the
census checks the text exists in the file and holds a comparison. The
site's own `code` match already re-triggers review when the site itself
moves.

## D5 — the Altman refusal has three independent product-side guards; the gate is independent of all of them

Plant A (materiality predicate forced + `max(total_liab, 1)`) tripped only
the 1-RON test, on the refusal CODE: the model's own range check (X4 <=
1/share) withheld the exploded value, and `credit_block` re-checks every
served row again. Plant A3 took all three down and the served-range gate
red on five tests with "served 100.0 outside its domain". Recorded so the
next reader does not conclude from Plant A alone that the gate is weak:
the honest statement is that a rendered exploded Altman value needs three
separate repairs undone, and the gate reds on the first of them anyway.

## D6 — blast radius of the fixture re-captures (already committed, re-stated)

Per book, credit revision 1 -> 2 (from e2450ac / 6573270):

| book | composite / letter | Z'' | what moved |
|---|---|---|---|
| agras | 80.7 AA | 7.31 | nothing but the revision row |
| retail | unchanged | unchanged | nothing but the revision row |
| Scandia FY2025 baseline | unchanged | unchanged | nothing but the revision row |
| carniprod | 79.3 A | 6.62 | coverage 95 / DSCR 90 now served as the labelled R-D1 declared rung, not a measurement |
| realestate | unchanged | unchanged | leverage 0 now served as the labelled R-D3 declared rung |
| imbalance_03pct | REFUSES (was 39.2 CCC over 60 % of the model) | refused | altman + liquidity + profitability + coverage + dscr listed |
| synthetic_thin_equity | REFUSES | refused | same five components listed |
| saga_compact_6_col (FE fixture) | REFUSES (was 97.5 AAA over five renormalised terms) | refused | altman + liquidity listed |
| synthetic_negative_equity (golden) | null (was CC at -2.9) | — | roic null; profitability null (revenue 0); leverage 0 -> 100 (net cash); coverage/DSCR null; equity -500 -> declared rung 0 |
| saga_10_col_agras_zero_balance_sheet (golden) | — | — | roic 12,990,721.7 -> null (invested capital <= 0) |

ratio_parity, firm and radar fixtures: unchanged by this wave (the full
engine suite over them stays green; see the commit that lands this file).

## D7 — not done here, on purpose

- The FE half of the floor census (`check_floor_census.mjs` over the
  TypeScript compiler API) is not built; the engine half prints
  "FE half: separate gate" and the gates.md section says so. The FE
  sites of C9 (financialValuation.ts) that this batch touched are covered
  by the reader's own range re-check and its vitest fixture.
- `_valuation.py:201` / `financialValuation.ts:102` (effective tax rate
  clamped to [0, 25 %]) stay on the ratchet, unlisted, for owner triage
  (D6 of the sweep).

## D8 — repair round (B8 verifier, 2026-09-19): the fallback is deleted, not fenced

`credit_block(rows)` / `_refused_subscores(rows)` took a rows-only operands
fallback by DEFAULT and read an absent `total_debt` / `net_debt` / EBIT
row as 0.0 and an absent `ebitda_to_interest` row as "interest is zero":
agras with three rows removed was declared the R-D1 top rung. Both
product callers already passed statements, so `statements` is now
required and `operands_from_rows` is gone — a fenced fallback is a
fallback the next caller reaches. With statements the operands cannot be
read from, nothing is declared and every withheld row refuses
`credit_inputs_absent`. Gate: `test_credit_model_rungs_and_ranges.py`
(the file the refusals docstring already named).

## D9 — the withdrawal gate found the withdrawal losing its own disclosure

Pinning `as_filed.withdrawn` showed the served block nulling a withdrawn
filed Z'' / composite and THEN comparing them to the served (refused,
null) figures: `as_filed_differs` came out False and the note was never
served. The comparison now reads what was filed; any withdrawal differs.
The FE prints a withdrawn figure as "withdrawn" with the engine's note,
never as a number and never as "not filed". The served-range law gained
an as-filed row: a filed figure is inside the same bound as its served
twin, or withdrawn by name and value; a withdrawn Z'' is outside its
bound; a withdrawn composite is outside its bound or composed over a
withdrawn Z'' (an in-range 88.5 built on X4 1500 is not a score).

## D10 — a broken pack refuses the credit block, never the period; boot refuses to start

`_refused_subscores` ran outside every non-fatal try in `get_period`, so a
malformed pack was a 500 on every period page. The as-filed credit
envelope now refuses with the pack's own message (`credit_inputs_absent`,
inputs `packs/credit/model.yaml`) and the period serves; the ratio table
(inside its try) is absent, not invented. `boot_verify.verify_config`
loads the pack first, so a container with a bad pack fails to start with
the same message. Pinned through the real route and `verify_config`.

## D11 — CREDIT_MODEL_REVISION stays 2; revision 2 IS the refusing cut

The renormalising cut (c6ae80f / 2802d56 on the held branch) and this
refusing cut both carry revision 2. The renormalising cut was never
deployed and never persisted a row anywhere, so no stored row can be
mistaken for it. Recorded here rather than bumped to 3: a bump re-captures
every credit fixture and every served-fixture again for a cut that
existed only on a branch. Owner may still bump before merge; the golden's
"recaptured under revision 2" note means this cut.

## D12 — served-range books widened for the vacuous laws

The ROIC law (invested capital <= 0) and the R-D1 debt leg (debt > 0,
interest 0, EBIT > 0) matched no book. Added through the production write
seam: `synthetic_negative_equity` (ROIC refuses on the route) and the
compact book with a planted 1621 row of 1,000 (no rung, coverage / DSCR
refuse, X4 defined); plus the compact book with its revision-1 rows
persisted (the withdrawal on the route). Observation, not fixed here: a
planted SUMMING account 162 is silently dropped by the RO assembler (only
the leaf 1621 maps) — a reconciliation matter for the pack wave.

## D13 — open for the owner

- `packs/credit/model.yaml`: with exactly 1 RON of current liabilities the
  liquidity component scores 100 (cash / 1 saturates the clamp) while
  Altman refuses by materiality on the same book. Q2 refuses liquidity
  only at zero, so the letter of the ruling holds; whether the liabilities
  materiality share should also gate liquidity is a pack change plus a law
  change in `served_range_law.py`, together. Not changed.
- `credit_model.compute_period_metrics` still carries three OR_ZERO
  ratchet sites (`pl.get('operatingExpenses', 0.0)`, `bs.get('cash', 0.0)`
  x2) — the sites the verifier counted as "the three or 0.0" were the
  deleted fallback's, which the census had never classified; these three
  are real and held on the ratchet for the next pass.
- tsc carries one error beyond the capsuleAskGuard baseline after the
  main merge: `frontend/lib/__tests__/reportBooks.tsx:88` (`supplementary`
  on `Statements`) from main's floor-c3 harness commit 4826c06, untouched
  here.

## D14 — interest coverage is EBIT ÷ interest: the stated methodology applied, not a new definition

`credit_model.compute_period_metrics` served `interest_coverage` as
EBITDA ÷ interest while `ebitda_to_interest` was statutory EBITDA ÷
interest: two census rows, two names, one figure on every book (17.70×
twice on Scandia FY2025; 66.28× twice on agras). The methodology this
project runs on (CLAUDE.md Appendix A, section 5, Coverage: "Interest
coverage | EBIT / Interest expense"; "EBITDA / Interest" is the separate
row) and the credit sub-score (`ic = operating_profit / interest`, R-D1
rung text "EBIT / interest") already said EBIT. So this is the methodology
applied to the one row that had drifted from it — not a new definition,
and not a credit revision: no sub-score, weight, rung or range moved
(`CREDIT_MODEL_REVISION` stays 2).

What moved: the engine row (`credit_model.py`), the no-metric fallback
(`ratios/table.py`, which now agrees with the FE's `computeRatios`
fallback that always divided EBIT), the band-finding subject bucket
(`c_bands.py`: EBIT operands), and the ONE label authority
(`statements.ratioCmp.label.interest_coverage` = "Interest coverage
(EBIT / interest)", EN and RO; `ebitda_to_interest` = "EBITDA to interest
(EBITDA / interest)") so the basis is printed on the tab, the drawer, the
report and the workbook. `RATIO_KNOWLEDGE` and the report card's tooltip
say the same.

Blast radius, served figure per book (EBITDA basis → EBIT basis):
scandia_fy2025_baseline 17.70× → 13.27×; agras 66.28× → 55.64×;
realestate −25.08× → −25.13×; retail 0.09× → −0.52× (sign flip: retail's
EBIT is negative, its EBITDA barely positive — the row now reads as the
covenant-breach it is); carniprod unchanged (no interest: the labelled
R-D1 rung). Bands (pack rungs strong 6× / healthy 3× / watch 1.5×):
UNCHANGED on every book — scandia stays `strong`, agras `strong`,
realestate and retail `critical` (0.09× was already below the watch
rung). Sub-scores, composites and letters: UNCHANGED on every book (the
coverage sub-score already banded on EBIT).

Fixtures re-captured deliberately, each by its own writer:
`credit_model/stage_compute_rows_pre_extraction.json` (scratch script
mirroring `_case_input`; moves recorded inside the file),
`ratio_parity/{agras,realestate,retail}.json` (CAPTURE=1
ratioParityCapture), `firm/served_metrics.json`,
`firm/served_ratio_pair(s).json`, the FE `comparatives/pair_served.json`
and `pair_prior_blocks.json`. Gates: `test_ratio_table` (operands name
depreciation on `interest_coverage`, not on `ebitda_to_interest`),
`test_credit_model_pure::test_interest_coverage_divides_ebit_and_ebitda_to_interest_divides_ebitda`
(by operands, on the seven golden cases). Out of scope: the public-market
`risk_scoring_engine.py` (its own EBITDA-based tiers on filings, not the
RAS ratio census) and the scenarios covenant key `ebitda_to_interest`
(its own metric, correctly named).

## D15 — second repair round (2026-09-20): a revised definition is served, never left to the persisted row

**The medium.** D14 moved `interest_coverage` to EBIT ÷ interest and said
nothing about rows persisted before it. A reanalyze never recomputes
metrics, so every period analysed before this branch ships still holds the
EBITDA figure under that name. `GET /api/period` then served two figures
under one key in one body — `metrics[]` and
`assembled_metrics.ratios.coverage` persisted, `ratio_table` serve-time:
agras 66.28 beside 55.64, realestate −25.08 beside −25.13, retail **+0.09
beside −0.52** (a sign flip between two surfaces of one period). Readers of
the persisted row: `/report` `RatiosTables`, `computeRatios(…, metricsByName)`
on Alerts and Decisions, `periodFacts`.

Decision: **serve it, do not reprocess.** `DEFINITION_REVISED_METRICS =
("interest_coverage",)` joins the rows `serve_credit_rows` replaces from the
serve-time model; the filed value moves, verbatim, to
`credit_metrics_as_filed`; the typed `ratios.coverage` block follows the
served rows. No deploy precondition, no backfill: a period is correct the
moment the build is live. The set is a tuple so the next revised definition
is one entry, not a second mechanism. `ebitda_to_interest` is not in it (its
definition never moved). `/report` names the row through `ratioLabelForKey`,
so the basis prints there too.

Blast radius: fresh periods — none (the persisted row already equals the
serve-time one; `test_ratio_compare` and the served fixtures did not move).
Legacy periods — the one row, to the D14 figures above. No fixture
re-captured.

**R-RANGE on the two surfaces it missed.** (1) The FE reader re-checks a
served Z″, X1 and X4 against the bounds the SAME envelope serves
(`ranges.altman_x1.max`, `altman_x4.max`, `altman_z.bound`). The Altman row
refuses `credit_out_of_range`; the composite then refuses as
`credit_component_undefined` listing Altman — the engine's own shape
(`credit_reason`), not a second code. **No browser fallback constant**: the
bounds are pack data (TC-10) and `altman_z.bound` is derived per book, so
with no served bound only finiteness is checked. (2) That gap is closed at
the source instead: get_period's `basis: as_filed` envelope now runs the ONE
withdrawal (`withhold_out_of_range`, factored out of `credit_block`), nulls
the `metrics[]` rows it withdrew (the FE reads rows first), and serves its
`ranges`.

**Not done, on purpose — the no-envelope FE model's zero-interest floor.**
`computeCreditScore` without an envelope reads `safeDiv(ebit, 0) = 0` as
"Below covenant", sub-score 15 (carniprod: no debt, no interest, EBIT > 0 →
67.8 BB+; the engine serves the labelled rung and 79.3). The R-D1/refuse
repair was written and measured: it is correct on the four private books,
but the SAME model rates the public-company storefront, where feeds
commonly carry no interest expense — `retainedEarningsMapped.test.tsx` lost
its minted rating, and `ratingRefusalFor` has no figure for "interest
expense", so every such public page would print a rating refusal with an
empty reason. That is a storefront change (CLAUDE.md §23: refuse, in the
filing's register, naming the figure) and needs the public refusal wiring
first. Held for the owner; the patch is not on the branch.

Also: the three ungated D14 hunks got gates (band subject buckets, the
no-envelope coverage term, the RO label); R-D1's "all measured" is held by
a test over each absent leaf; B6 scans the whole Ratios-sheet builder and
catches an alias; `safeFacts` hands the rules each coverage basis under its
own name; the stage_compute golden has a committed writer
(`fixtures/credit_model/recapture_stage_compute_golden.py`). Main merged
again (22 commits; clean; engine book unchanged). Still unwritten:
`e2e/ratios-comparatives.spec.ts`.
