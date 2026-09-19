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
