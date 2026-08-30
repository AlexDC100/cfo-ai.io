# Attach/replace confirm step — critique, round 2

Shots: `design_review/period-r2/` — same matrix as r1 (5 states × 3 viewports ×
2 themes), captured after the four r1 fixes.

## The r1 defects, re-checked against the shots

1. **Two teal primaries in `entity` — FIXED.** `attach-entity--*` now shows one
   filled button, "Attach to a new period", inside the alert. The footer
   "Attach file" is an outline button, so ticking the acknowledgement no longer
   creates two equal calls to action. The mismatch state keeps its filled footer
   button (`attach-mismatch--laptop-1280--dark.png`) — correct, since nothing
   competes with it there.
2. **Evidence line weight — FIXED.** "Detected December 2025 — from the file's
   closing date" now sits at body colour with the quoted source line muted
   beneath it. In `mismatch` it holds its own against the field that
   contradicts it, which is the whole point of that screen.
3. **Empty month field in `absent` — PARTLY FIXED, accepted.** The caution
   border is on the field, but the dialog opens with that field focused, so the
   focus ring wins and the border only appears once focus moves. Accepted: the
   amber "Not detected — choose the month this file covers" sits directly above
   it and the confirm is visibly disabled, so the state is never ambiguous.
   Fighting the focus ring would mean a louder ring than the app uses anywhere
   else.
4. **Field↔list link — FIXED.** The selected row carries a teal left rule
   (`attach-mismatch--laptop-1280--dark.png`: December 2017 selected, December
   2025 quiet), matching the workspace settings nav idiom. The list now reads as
   a shortcut into the field above it.

## State of the surface

All five states hold at 1440 / 1280 / 390 in both themes, with no horizontal
overflow and no scrolling at 390 — including `entity`, the tallest, which
carries the file chip, evidence, picker, list, alert and acknowledgement.

The screen answers, in order: what file · what the document says · what month
you are choosing · what else lives there · what disagrees · confirm. That order
is the fix — the old flow answered only the last question, and answered it with
the row the user happened to drop on.

## Follow-up, not blocking

- The live-drop capture on `/workspace` is still skipped every round: the
  preview stack is mid-onboarding, so no period rows exist, and finishing the
  wizard would create a workspace in the shared test-mode database. The gesture
  itself is covered by the unit test ("dropping a file uploads NOTHING until a
  human confirms the month"). Worth one live capture whenever the preview stack
  has a real workspace again.
- Long company names in the entity guard wrap rather than truncate. That is the
  right call for a sentence a user has to judge, but a 60-character SRL name
  will make that block three lines tall on a 390 viewport.
