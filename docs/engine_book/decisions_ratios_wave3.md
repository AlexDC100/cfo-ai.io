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

## D16 — the range gate sits at the serving boundary (owner, 2026-09-20)

**Instruction.** "The credit range gate goes at the serving boundary so no
fallback can bypass it; plant a model-failure path serving an exploded value
→ RED."

**Decided.** One function, `engine.ratios.credit_boundary.
enforce_credit_boundary(payload, surface=)`, is applied to the object a
route returns: GET /api/period, GET /api/period/{id}/comparatives, and the
narrator payload (`enforce_metric_rows`). It lives in `engine/ratios`, not
`engine/serving`: that package's public API is closed by
`check_import_boundary.py` and is the facts gateway; the credit law's home
is beside the model and the pack it reads.

- **By shape, not by path.** It recognises an envelope, a ratio-table block,
  metric rows and comparatives rows under any key, so a cache or a future
  fallback is read without registering itself.
- **The as-filed envelope is composed there.** The per-path check in
  get_period was correct and one fallback away from being skipped. The route
  now hands the boundary the persisted rows untouched and reads no
  credit-family value itself; bypass the boundary and the rows are served
  raw — which is what makes the plant RED and keeps the gate a measurement
  of the boundary (the bypass is kept IN the suite).
- **Fails closed.** A pack that cannot be read, or any exception inside the
  check, withholds the whole credit family.
- **`credit_metrics_as_filed` was a live leak** (found by the independent
  law, not by a plant): on every switched zero-liability period it served Z''
  1584.89 / X4 1500 / liquidity 0.0 verbatim. Those rows are evidence, and
  they are rows in a served body: they are held to the whole law and a failing
  one is served as a record (`value: null, withheld: {code, inputs, value,
  text}`), which `build_ratio_table` reads back as evidence so the
  comparatives' as-filed disclosure does not change.
- **Comparatives reads the GATED period bodies** (it calls get_period
  in-process) and gates its own output. Under a raising model that route has
  no fallback and answers 500; the gate pins "500, or 200 without the figure".
- **Capsule tools and exports** serve no credit figure from the engine today
  (`_capsule_tools.py` names none; exports are FE-side and read the gated
  body). A census test reds when a new file under `src/engine/api` names a
  credit-family figure.

Blast radius (boundary on vs identity, persisted rows = today's model): agras
7.31 / 80.7 AA, carniprod 6.62 / 79.3 A, realestate 2.43 / 29.3 CCC, retail
0.6 / 15.8 CC, Scandia baseline 3.1 / 71.9 A — body identical on 6 of 6; no
pinning fixture moved.

## D17 — the items the two re-verifies left (2026-09-20)

**FE, an unread figure does not render.** `scoreRangeOf` fell back to a
literal [0, 100] (TC-10) and the Altman reader had no bound without served
`ranges`. An envelope that states a `basis` owes a range beside every figure
(the boundary guarantees it) and withholds a figure that has none; an envelope
with no `basis` (cached before the contract) is checked for finiteness alone.
The wider rule — refuse on every range-less envelope — was measured first: it
redded 38 tests across 5 suites built on hand-made envelopes that state no
basis, so the narrower, contract-keyed rule was chosen.

**FE no-envelope model's zero-interest floor (held in D15) — now closed** by
the owner's floors ruling: declared labelled top rung only when debt == 0,
interest == 0, EBIT > 0 are all reported; otherwise the term refuses and the
completeness law mints no letter. The storefront wiring D15 asked for first is
in the same commit (`interestExpense` figure; a reported non-positive interest
gets its own sentence, never "not reported"). ~~Mapping checked before refusing
(§23): SF1 `intexp` is mapped.~~ **CORRECTED in D18: that sentence was false at
the reader.** `intexp` is mapped by the NORMALIZER (`interest_expense` →
`interest_expense_bank`), but that leaf has no schema-v1 bucket, so the record
is shelved under `unmapped` and the adapter, which read only the leaf, saw an
absence for every SF1 ticker. Blast radius: carniprod 67.8 BB+ → 83.3 BBB on
the no-envelope path only; the three other firm books and every served figure
unchanged. **Open beside it:** the EDGAR lane (`public_market/edgar_concepts`)
extracts no `InterestExpense` concept; that lane serves the pm1 presentation
and does not feed this reader today, so nothing refuses because of it — if it
is ever wired to the rating reader, map the concept first.

**`metric-units`.** An operand record `{name, value, source}` under an
`"operands"` key is not a metric row; scoped out by shape and position,
counted and printed (3). Declaring a unit on the one operand that happened to
have a literal name would have made it the only operand of ~100 with one.

**`floor-census`.** Baseline tightened after the C6 merge (every movement
DOWN); the 3 new OR_ZERO sites in `_industry_classifier.py` reviewed by
measurement and found legitimate; the review is stored in the baseline file
and a stale review is RED; the script now runs inside tests/engine.

**B6.** Unary sign on a name, `+ (-x)`, `: any` / `as any`, `String(x).<m>`,
`.slice(` / `.substring(` are banned in the nine served-row paths.

**`credit_block` composition invariant.** Already held by the block since
31a8fca; now pinned by a rows-only unit test (plant: guard off →
`('coverage', 80.7, 'AA')`).

### D13a — DECIDED: liquidity is NOT gated by the liabilities materiality share

The open question: with exactly 1 RON of current liabilities the liquidity
sub-score is defined and saturates at 100 while Altman refuses by materiality
on the same book. Should the 1 % share also gate liquidity (pack and
`served_range_law._liquidity_defined` changed together)?

**No — Q2 stands: liquidity refuses only when current liabilities are not
positive.** Reasons, in order of weight:

1. *The two cases are not the same defect.* X4 = equity / total liabilities is
   UNBOUNDED as liabilities → 0 and fed Z'' an exploded operand (1500 →
   1584.89). The liquidity sub-score is a bounded ladder of three ratios; what
   is served is a score in [0, 100] by construction (the allow-listed band
   saturations), and the owner's rule "exploded values refuse" is about what is
   served as a figure. No liquidity figure outside its range can be served, and
   the boundary holds that on every path.
2. *A small current-liability base is a real, common state, not an artefact:*
   a single-asset property vehicle or a holding funded by a long-term loan
   carries almost nothing due within the year. Gating at 1 % of total assets
   would refuse liquidity — and with it the composite and the letter
   (R-COMPOSITE) — for exactly the Path B / Path C companies this platform
   analyses, for a reason the reader would rightly dispute: nothing falling
   due is the best liquidity there is, not an unknown one.
3. *Measured:* current liabilities are 33.1 % (agras), 13.6 % (carniprod),
   33.7 % (realestate), 24.3 % (retail) and 33.2 % (Scandia baseline) of total
   assets, so the gate would change nothing on the corpus today and could only
   ever act on the books in (2).
4. The 1-RON book still serves no composite and no letter: Altman, coverage,
   DSCR and profitability refuse on it.

Not changed: `packs/credit/model.yaml`, `served_range_law._liquidity_defined`.
**Revisit if** a real book is found whose liquidity score is materially driven
by a current-liability base under 1 % of total assets AND the score misleads;
the honest repair then is the owner's other floors tool — a LABELLED declared
rung ("nothing material falls due within the year"), not a refusal — and it
changes the pack, the law and the model revision together.

**Still open after this round:** `e2e/ratios-comparatives.spec.ts` is
unwritten; the branch is not merged or deployed.

## D18 — repair round credit2 (2026-09-20)

**The storefront named a reported figure as "not reported" (medium).** D17's
"mapping checked" read the normalizer's map and stopped there; the reader is
where a mapping is true or false. Measured on the real normalizer:
`normalize(Fundamentals(interest_expense=2.935e9, ...))` → `leaves
['cash_operating']`, `unmapped [... interest_expense ...]`,
`bucket_by_name('interest_expense_bank')` → `None`. Repaired in 4a48299:
`reportedInterestExpense` reads the shelved record first; `debtReported` also
holds on the feed's reported `totalDebt` (both legs are shelved for every
ticker, so R-D1's declared rung was unreachable on the storefront); and
`canonical()` reads the feed's reported EBIT / EBITDA / net income before the
reconstruction — a defect the bridge EXPOSED: with interest finally measured,
AAPL's coverage read 129.3× on an "EBIT" rebuilt as revenue − 0 − D&A, against
42.0× on the reported 123.2 B. Blast radius: no rating moves (every SF1 ticker
still refuses on X1's unreported current side); the committed real AAPL capture
carries no `interest_expense` record at all, so its sentence still names
interest expense and is true about that body. Private books carry no
`reportedTotals` and do not move. The wording "not reported in this filing" is
kept for a record the feed body truly lacks; R-PUBLIC-ABSENT's "input not
carried by the data producer" is reserved for a structural absence, of which
this reader now has none for interest expense.

**The lesson, general:** a "mapping checked" claim is checked at the last
reader, with the real producer's output in hand — not at the map.

**The boundary's contract is held by shape (low, six gaps).** (a) an envelope
is any dict carrying `altman_components`, `composite_score`, `altman_z_score`
or `letter_grade`; (b) R-COMPOSITE is held by the boundary itself — a composite
present beside a present-and-null sub-score, or beside a component the payload
lists in `refused_subscores`, is withheld with `credit_component_undefined`
(an ABSENT sub-score row says nothing: revision-1 filings carry none, and
`withhold_persisted` holds those over the statements); (c) every row of a name
is read, in layers, and a name withheld in any layer is withheld on every row;
(d) a document's credit compare rows are read together, per row, across sibling
lists, and an Altman breach takes that side's Altman sub-score; (e) a filed
Z'' is read against the bound derived from the X2 and X3 served beside it —
with none beside it, it is unread and not served. (f) lower bounds: not added.
R-RANGE as ruled declares upper bounds for X1/X4/Z''; a deeply negative X4 is a
real (distress) book, not an exploded operand, and its sub-score is in range.

**Gates added for ungated hunks:** `enforce_metric_rows`' fail-closed branch
(M7b) and the comparatives chokepoint, behaviourally (M8 — the composer itself
explodes a side from lawful inputs; only the comparatives boundary can refuse
it). **Gate scopes:** the floor census credit tier is DISCOVERED (every module
under `src/engine/ratios` + `ratio_compare.py`), with a pinned minimum so an
emptied package is DISCOVERY BROKEN; the metric-units operand scope-out is
PINNED by `file::function` and count.

**Queued, not done (pre-existing, measured this round, outside this step's
hunks):** the FE no-envelope model's own Altman has no R-D4 materiality and no
R-RANGE (1 RON of liabilities on 1,000,000 of assets → Z'' 1,050,006.52
"safe", sub-score 90), and leverage still floors a debt-free book at 30 (C9.1).
The repair needs the materiality share and the X4 maximum in the browser, and
they are pack data (TC-10): it must arrive served or packaged, never as a
literal. It goes with the C9 lane. Rare on listed companies; the engine refuses
the same book.

### D13a — IN FRONT OF THE OWNER (not a code defect)

D13a was decided as asked and its outcome sits against the floors wording: with
1 RON of current liabilities the liquidity sub-score is served as a MEASURED
100, not as a labelled declared rung. Nothing lender-facing is minted from it
today (that book serves no composite and no letter). The two options:

1. **Keep measured** (today): liquidity refuses only when current liabilities
   are not positive; a tiny base saturates the ladder at 100, unlabelled.
2. **Pack-declared labelled rung**: below a pack-declared share of total assets
   the liquidity sub-score is STATED at the top rung with the label "nothing
   material falls due within the year", never measured. Changes
   `packs/credit/model.yaml`, `served_range_law._liquidity_defined` and the
   model revision together, and re-captures the credit fixtures.

Owner call. No code changed for it in this round.
