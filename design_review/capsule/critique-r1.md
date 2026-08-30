# Capsule r1 — honest critique

Shots: `design_review/capsule/capsule-r1/` (desktop 1440 + mobile 390 × Paper/Terminal).
Baseline for comparison: `design_review/capsule/capsule-r0-before/`.
Tool reads stubbed (`--stub-tools 1`) — **the figures on these shots are
fixture figures**, the model call is real.

## What the round fixed (r0 → r1)

| r0 defect (owner's list) | r1 |
|---|---|
| placeholder verb was SEARCH | placeholder verb is ASK |
| five stacked sections, 18 rows | three zones, 7 rows |
| "Ask a question" as a list row | row deleted; Enter answers, footer says so |
| detached flat panel below the pill | morphs out of the pill's own box |
| answer led with prose | answer leads with the fact card |
| no follow-ups | chips computed from the answer's evidence |

## What is STILL WRONG

### 1. The placeholder does not name the period — the whole point of it
`2-palette-search--*`: it reads **"Ask anything — or jump anywhere"**. The
header two rows above it says **"Aug 2026"**. The period is on screen; the
sentence that is supposed to name it does not.

Cause: `periodMonth` comes from `formatPeriodMonth(activePeriod.periodEnd)`,
and this workspace's active period carries no `period_end`. The header does
not use that field — it uses the stepper's own period row. So the capsule
asks a different question of the app than the header does and gets a
different answer. **This is the r0 company-name bug wearing the opposite
sign**: r0 filled the month slot with something that was not a month; r1
refuses to fill it with anything at all. Both are wrong; the fix is to read
the stepper's period row, which holds a month and never a company.

Knock-on: the context strip is missing its period too (it reads a bare
"· Not verified"), and the honest "Nothing to suggest" line is suppressed
because it is gated on `context.periodLabel`.

### 2. The input still wears a magnifying glass
The verb is ASK and the icon says SEARCH. It is the single loudest piece of
contradicting evidence left on the surface, and it is 16px from the
placeholder that says the opposite.

### 3. The question chip is not a chip
`5-answer-done--*`: the pinned question is full-width, bordered and
rounded — it reads as a **disabled text input**, i.e. as something you
could type into. It should hug its own text.

### 4. The provenance dot is orphaned
On the fact card the dot sits hard right at x≈1055 while the number it
belongs to ends at x≈620. Four hundred pixels of nothing between a figure
and its proof is not a relationship the eye makes. It belongs beside the
number.

### 5. The figure list repeats the fact card
`5-answer-done--*` shows `413.727.560,00 RON` at 26px in the fact card and
then again, at 12.5px, in a "FIGURES" list whose only row is that same
fact. One answer, one number, printed twice. The list has to earn its
heading by holding something the card does not.

### 6. Two hints saying the same thing
"Jump to… **Type to search everything**" and the footer's "Type to ask, or
to jump anywhere". The zone-3 hint is the redundant one.

## Not wrong, recorded so it is not re-litigated

- **No micro-visual on this answer.** Correct: one period is loaded, so
  there is no comparison to draw and no series to spark. Drawing one would
  require inventing the second point.
- **The 2-decimal headline** (`413.727.560,00`). It looks heavy at 26px,
  but the headline and the figure list resolve the same fact through the
  same renderer; giving the headline its own rounding is exactly how one
  number acquires two spellings. Left alone deliberately.
- **Mobile 390** is clean at 7 rows with no horizontal overflow.

## Round 2 targets

1. `periodMonth` resolves from the stepper's period row → placeholder, strip.
2. Icon reflects the primary action (ask vs jump), never a fixed magnifier.
3. Question chip hugs its content.
4. Provenance dot moves beside the headline value.
5. Figure list drops rows the fact card already showed; hides when empty.
6. Delete the zone-3 hint.
