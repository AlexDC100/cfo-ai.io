# Findings UX — rounds 4-7 critique (2026-08-30)

Shots: `design_review/findings-r4/` … `findings-r7/`.

## What changed between r3 and r4: the fixture became the whole period

Rounds 1-3 were reviewed against a single hand-assembled `Finding` for
the 461 case. From r4 the fixture is
`s_engine.run_single_period(agras_fy2025)` — the committed envelope,
every detector, dumped through the real `rank_findings`. That is two
surfaced findings, one info-tier row, one demoted (the planted
`input_cost_exposure` with its action removed) and **eighteen** checks,
including the detectors' long "not run: … is not carried by this
engine's canonical views" notes.

Reviewing against one card had been hiding real defects. Three surfaced
immediately, and none of them were cosmetic.

## Defects the real payload exposed

1. **"All checks" told the reader the recommendations had been demoted.**
   `classify()` bucketed every fired check with no floor/cap note as
   "fired, but demoted" — and every surfaced finding contributes a fired
   check row. So the panel listed `concentration_related_party` and
   `liquidity_cash_tight`, both shown as recommendations directly above,
   under a heading saying they had been suppressed. This is the exact
   inversion the panel exists to prevent.
   → Disposition is now a LOOKUP against the report (rule id + parameter,
   the key `_finding.check_record` itself builds), with a "Fired — shown
   above" group so a surfaced finding's row can never read as a
   suppressed one.

2. **The demotion reason was silently dropped.** The runner writes a
   check row when a finding is added and `rank_findings` writes another
   carrying `demoted: action: no action supplied`; the dedupe kept the
   first, bare one. The checks list lost the single piece of information
   it exists to carry.
   → A duplicate now UPGRADES the kept row's note / disposition /
   materiality instead of being discarded.

3. **Horizontal overflow at 390px** (r6). The `truncate`d threshold-source
   path is one unbreakable dotted string, and a grid item defaults to
   `min-width: auto`, so the column widened past the viewport and the
   whole card scrolled sideways — two of the four evidence figures were
   off-screen.
   → `min-w-0` on both columns. Verified in r7.

## Judgement calls this round

4. **MEDIUM ranked above HIGH.** The 461 finding (medium, 3rd consecutive
   period, score 0.468) outranks the cash finding (high, score 0.370),
   which is `_finding_rank` working exactly as designed — persistence and
   quantified impact beat a severity label. It still reads as a bug. Pro
   prints each card's multiplicands, but that is at the foot of the card;
   the panel now carries a one-line statement of the ordering rule
   wherever two cards are visible at once.

5. **The profile's signal chips repeated on all three cards** — they
   belong to the PERIOD's profile, so they are identical everywhere.
   Capped at two plus a "+N" chip whose title carries the rest.

6. **"action: no action supplied; action: no action supplied".**
   `rank_findings._check_from` concatenates a note that already embeds
   the reasons with `demotion_reason`, which is the same reasons again.
   Byte-identical segments are collapsed at render (`dedupeNoteSegments`)
   — the surviving text is a subsequence of what the engine sent, so no
   claim is edited. The duplication is engine-side and is reported as
   such rather than fixed here.

## One thing that looked like a defect and was not

The checks table showed `valuation_ebitda_non_positive` observed as
`18.420.481,28 RON` at RON display and `3.509.400 €` at EUR — a factor of
5.2489 apart, which reads like a double conversion. Probed with a
throwaway test rather than argued from a screenshot: the engine's own
observed value is 18,420,491.28 RON, and 18,420,491.28 ÷ 5.2489 =
3,509,400. Both renders are correct and one-currency. The probe was
deleted; the habit is the point — a currency suspicion gets measured, not
reasoned about.
