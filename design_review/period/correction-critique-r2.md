# Correction path + display — self-critique, rounds 2 and 3

Shots: `design_review/period/correction-r2/` (after the r1 fixes) and
`correction-r3/` (after the one defect r2 introduced). 1440 + 390,
light + dark, five states each: the period list, the disputed review,
the unknown review, the move dialog, and the list with menus visible.

## r1 defects — all four closed

**1. Hover-only correction path → fixed.** The file kebab is now always
rendered at reduced contrast and rises on hover/focus
(`text-ink-mute/60 group-hover/file:text-ink-mute`). Visible on every
file row in `correction-r2/harness-rows--mobile-390--*.png`, where r1 had
nothing at all. Pinned by a test that fails if `opacity-0` ever comes
back.

**2. The "date unknown" dead end → fixed.** The review's footer always
carries a way into the month picker. With a detected month it is the
secondary "Another month…" beside the primary "Move to Dec 2025"; with no
detected month it becomes the primary "Choose a month…"
(`harness-review-unknown--desktop-1440--dark.png`). `onChooseMonth` is a
required prop, so the dead end cannot be reintroduced by forgetting to
pass a handler.

**3. "Couldn't ask" rendered as "the file said nothing" → fixed.**
`detectPeriodForFilename` now returns a discriminated
`{kind:"answered", detection} | {kind:"unavailable"}`. Only an actual
engine answer of `signal_used: "none"` produces *"This file does not say
which month it covers."*; a failed read says *"Couldn't read this file's
own date just now. Pick the month yourself."* Both leave the picker
empty. The dialog's ABSENT state is the one captured in
`harness-move--*.png` (the harness has no session, so the read
legitimately fails) — which is exactly the state that needed the
distinction.

**4. "this month" → the month is named.** "A person confirmed Dec 2017
for this file." Visible in `harness-review--*.png`.

## Defect introduced in r2, fixed in r3

**Three footer buttons wrapped to two lines each** at the dialog's 480px
width — "Keep it / here", "Choose another / month…", "Move to Dec / 2025"
overflowing their fixed `h-8`. Cause: adding a third action to a footer
sized for two. Fixed by shortening the secondary to "Another month…"
("Altă lună…") and pinning `shrink-0 whitespace-nowrap` on all three.
`correction-r3/harness-review--desktop-1440--light.png` shows one clean
row; mobile stacks them with the primary on top.

## What the r3 shots show, read as a reviewer

The Dec 2017 row is the whole bug on one line:

```
Dec 2017   1 file   ⚠ DATE DISPUTED · Review
  Carniprod Trial Balance 2025.xlsx   ☆ SOURCE            ···
  Uploaded 14 Jan 2026 · 🗓 File says Dec 2025
```

Three dates that are three different facts, none standing in for another.
The Dec 2025 row shows one `SOURCE` and one `ATTACHMENT` — the audited
"one month, two companies" shape, now legible. Dec 2024 (a period written
before the engine stamped its verdict) carries no chip: absence renders
as absence. Jan 2026 with no files is an invitation, not a blank.

## How a completed move was verified

Not from a screenshot. The test-mode workspace is empty and its engine
process predates this route, and seeding the shared test org would have
disturbed a lane running against the same stack. The move was verified
where it can actually be proven:

- **The engine, against a real store** —
  `tests/engine/test_period_move.py`, 52 tests on the audited production
  shape (Carniprod under 2017-12, Dec 2025 holding two companies). The
  hint is written, the document is detached, the emptied period and every
  derivative of it are deleted, `Dec 2025` is untouched, and
  `find_orphaned_snapshots` returns empty. Mutation-checked: deleting the
  derivative wipe turns the W4 assertion red with
  `derivatives_without_period`.
- **The live HTTP contract** — a throwaway engine on :8009 built from
  this source: `401` without a bearer token; `422` with
  `open_period_end` in the body (`extra_forbidden` — UI state cannot be
  smuggled onto the wire); `422` with no `period_end` (there is no
  default); and `/api/period/detect?filename=Carniprod Trial Balance
  2025.xlsx` returning `proposed_period_end: 2025-12-31, signal_used:
  filename` — the exact payload the move dialog renders.
- **The dialog, end to end** —
  `__tests__/moveFileDialog.test.tsx`, 10 tests: the offered month comes
  from the engine reading the file and is never the row's own month; a
  completed move posts `("org-1", "doc-carniprod", "2025-12")` and
  reports both periods re-analysing; a non-empty `orphaned_after` warns
  instead of reporting a clean success; a failure never claims the move
  happened.

## Still open, deliberately

- **No entity name on period rows** (Part E asks for one). There is no
  honest source: the engine's served `statements.companyName` is the
  *workspace* name, identical on every period, and the deterministic
  trial-balance path derives `company_name` from the filename stem.
  Printing either as "detected entity" would fabricate the exact kind of
  fact this lane repairs. Needs the engine to persist the extracted
  company name per period — flagged for the owner, not faked.
- **The review harness used for these shots was deleted** after r3. It
  mounted the real components with fixtures; the durable record is these
  screenshots plus 35 component tests. Recreating it is ten minutes if a
  round 4 needs one.
