# Findings UX — round 3 critique (2026-08-30)

Shots: `design_review/findings-r3/` (harness, full matrix) and
`design_review/findings-r3-dash/` (`/dashboard`, light+dark, simple+pro).

## State of the surface

**Pro, 1280 dark.** Meta row (severity · rank · rule id · materiality ·
persistence) → the engine's rendered headline → subject accounts → two
columns: EVIDENCE with four provenance dots, the comparison basis and the
`period / snapshot / accounts / source` line, then THRESHOLD BREACHED
with the sentence, the meter and the parameter's source path; QUANTIFIED
IMPACT with `54.9% → 43.8% (−11.0 pp)` and the method line, WHY THIS
MATTERS HERE with the profile and signal chips, DO THIS with two steps
each naming artefact, provider and horizon → CONFIDENCE with its caveat
and basis → the score breakdown → six actions.

Seven elements, seven labelled regions, no gaps. Every number on the card
came from the payload; the only arithmetic on this screen is counting
rows.

**Simple, 390 dark.** Severity + persistence, a plain headline carrying
both figures ("Related-party receivable on 461 — 19.6%, above the 10.0%
limit"), the impact line, ONE action with its artefact and provider, "Show
the full check", four buttons. No horizontal overflow at 390.

**Silence, 1440.** The engine's `silence_statement()` verbatim, the note
that this is a claim rather than an absence, the profile, and the checks
table open by default with each rule's parameter, limit and observed
value. No green tick, no "you're all good".

## Verified this round

- All-checks count 3 = three rules; the demoted row appears there with
  "action: no action supplied" and no prose, never as a recommendation.
- Method line renders (`recomputed_ratio · equity_ratio_ex_related_party
  · percent`) in Pro and is absent in Simple.
- `/dashboard` renders unchanged — no regression from the
  `StatementNotes` / `RecommendationsView` edits.

## Open, deliberately

1. **Column balance** at ≥1280 (see r2 §4). Reading order beats a flush
   baseline.
2. **`RecommendationsSection` in `FinancialStatements.tsx`** is still the
   pre-contract shape and is outside this lane's files (r2, last section).
3. **The history strip is a count, not a series.** `persistence` is the
   only cross-period number in the payload, so "Compare periods" reveals
   the count, the root cause and the merged rules, and says on the strip
   that earlier VALUES are not in this payload. A per-period series would
   need a new engine surface — a cross-lane want, not a UI gap.
4. **The engine's claim is not translated.** Chrome is EN + RO; `title` /
   `body` are quoted as the engine composed them. Re-authoring them
   client-side would be a narrative mutation with no fingerprint check
   behind it — exactly what `apply_advisory_narrative` refuses.
