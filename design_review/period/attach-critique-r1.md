# Attach/replace confirm step — critique, round 1

Shots: `design_review/period-r1/` — 5 states × 3 viewports × 2 themes
(`attach-{detected,absent,mismatch,entity,replace}--{desktop-1440,laptop-1280,mobile-390}--{light,dark}.png`).

Captured from `design_review/period/harness-attach-confirm.html` through the
running dev server: the real component, real tokens, real i18n, only the two
seams (`inspect`, `resolvePeriodEntity`) stubbed. The live-drop capture on
`/workspace` was attempted every round and skipped — the preview stack sits in
the onboarding wizard, and finishing it would create a workspace in the shared
test-mode database (CLAUDE.md memory: "test-mode junk workspaces incident").

## What works

- **The month field is pre-filled from the document, and the drop target is
  visibly demoted.** `detected` shows `December 2025` in the field while
  `December 2017` sits in the list below, tagged "YOU DROPPED IT HERE". The old
  bug is not just fixed, it is legible on the screen.
- **`mismatch` is the reported production case, end to end.** "Detected
  December 2025" stays on screen while the field reads December 2017, the amber
  guard names both months, and the confirm is off until the acknowledgement is
  ticked. Three independent signals of the same disagreement.
- **`absent` refuses to invent.** Empty field, amber "Not detected — choose the
  month this file covers", confirm disabled. Nothing pre-fills.
- **`replace` answers "what am I replacing?" before asking anything else** —
  filename, month, upload date, and the promise that the old file is kept.
- **Mobile 390 needs no scrolling in any state**, including `entity` with both
  the alert and the acknowledgement.

## Defects to fix in r2

1. **Two teal primaries in `entity`.** "Attach to a new period" (the primary way
   out) and the footer "Attach file" carry the same fill. While the confirm is
   disabled the hierarchy holds by dimming alone, and the moment the user ticks
   the acknowledgement both become equal-weight teal — the escape hatch stops
   reading as the recommended action. → Footer confirm becomes SECONDARY
   whenever the entity guard is up. (Not for the mismatch guard: there is no
   competing CTA there, so the footer should stay primary.)

2. **The evidence line is the most important sentence in the dialog and is set
   as caption-weight muted text.** "Detected December 2025 — from the file's
   closing date" is the entire justification for the pre-filled month; at
   `text-ink-soft` it scans as a footnote under the filename chip. → Sentence to
   `text-ink`; the quoted snippet stays muted beneath it.

3. **The empty month field in `absent` reads as broken, not as required.** The
   native `--------- ----` placeholder plus a neutral border looks like a
   failed input rather than the one thing the user must supply. → Caution border
   on the field while the detection is absent and nothing has been chosen, so
   its colour matches the amber line that just told them to choose.

4. **The link between the field and the list is weak.** In `mismatch` the
   chosen row (December 2017) is only faintly tinted, so it is not obvious that
   the list is a shortcut into the same field rather than a second control. →
   Left accent rule on the selected row, the same idiom the workspace settings
   nav already uses.

## Not changed, deliberately

- **The month input takes focus on open** (the native month segment shows
  selected). That is the field the dialog exists to collect; focusing it is
  correct, and the highlight is the browser's own.
- **Disabled confirm keeps `opacity-40` on the brand fill** rather than a
  greyed variant — it is the app's existing disabled treatment in every other
  dialog, including the add-period dialog directly above it.
- **The entity guard uses the alert (red) palette while the mismatch guard uses
  caution (amber).** The severity difference is real: a wrong month is one
  period's problem, a second company in one workspace month corrupts every
  comparison built on it.
