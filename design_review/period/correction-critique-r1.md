# Correction path + display — self-critique, round 1

Surfaces: the Periods list in Workspace settings (period rows, file rows,
the date chip), the date review, and the move dialog.

**How these were captured.** The test-mode workspace is empty (it lands in
onboarding), so the real `/workspace` shots show no periods at all — nothing
to critique. Rather than seed the shared test org (another lane is running
against the same stack), the states were rendered through a throwaway harness
mounting the real components with fixtures pinned to the production audit:
`Carniprod Trial Balance 2025.xlsx` filed under Dec 2017, a Dec 2025 period
holding two companies' books, an undated `scan.pdf` filed under the upload
day, a legacy period the engine never judged, and an empty month. Shots:
`design_review/period/correction-r1/harness-*.png`, 1440 + 390, light + dark.

## What works

**The contradiction is legible in one glance.** The Dec 2017 row reads
`Dec 2017 · DATE DISPUTED` over `Carniprod Trial Balance 2025.xlsx · SOURCE`
over `Uploaded 14 Jan 2026 · File says Dec 2025`. Three dates, three
different facts, none standing in for another. The old row showed one
plausible upload date and an eight-year error was invisible.

**Two companies in one month is now visible as such.** The Dec 2025 row shows
one `SOURCE` and one `ATTACHMENT`, so "whose numbers am I looking at" has an
answer on the row instead of in someone's head.

**Absence renders as absence.** `File date not recorded` (italic, muted)
where the engine recorded nothing; the Dec 2024 legacy row carries no chip at
all rather than a reassuring all-clear; the empty Jan 2026 row is an
invitation, not a blank.

**Disputed and unknown are visibly different states** — amber warning
triangle vs a question mark, different words. Merging them would have hidden
every period nobody ever dated.

## Defects found

### 1. The correction path is unreachable without a mouse — BLOCKING

The file kebab is `opacity-0 group-hover/file:opacity-100`. On the mobile
shot (`harness-rows--mobile-390--*.png`) it is simply not there, and no touch
device produces a hover. "Move to another period…" is the only way to fix a
misfiled row, and on a phone it does not exist. A one-tap chip that leads to
a dialog offering no way to act (defect 2) compounds it.

**Fix:** the menu button is always visible, at low contrast, and rises to
full contrast on hover/focus. Discoverability of a correction affordance is
not a hover-worthy detail.

### 2. The "date unknown" review is a dead end — BLOCKING

`harness-review-unknown--*.png`: the body says "Pick the month it really
covers" and then the only button is **Keep it here**. There is no picker.
The state that most needs a human decision is the one state that offers no
way to make one, because the move button only renders when a detected month
exists.

**Fix:** always offer a way into the month picker. When the engine detected a
month, the primary action stays "Move to <month>" and a secondary
"Choose another month…" opens the picker; when it detected nothing, "Choose a
month…" becomes the primary action.

### 3. "Couldn't ask" is rendered as "the file said nothing" — HONESTY

`detectPeriodForFilename` returns `null` both when the engine answered
`signal_used: "none"` *and* when the call failed (offline, engine down,
signed out). The move dialog printed the same sentence for both: *"This file
does not say which month it covers."* That is a claim about the document,
made without having read it. It is the same class of error as the bug this
lane exists to fix — asserting a fact about a document from something that
never came off the document.

**Fix:** distinguish the two. A failed read says so and asks the user to pick;
only a real `none` answer says the file is silent.

### 4. The review names a month it does not name — COPY

"A person confirmed this month for this file." sits directly under
`THE FILE SAYS Dec 2025`, so "this month" reads as Dec 2025 when it means
Dec 2017. In a dialog whose entire job is telling two months apart, a
demonstrative pronoun is the wrong word.

**Fix:** name the month — "A person confirmed Dec 2017 for this file."

## Not defects (deliberate, recorded so round 2 does not "fix" them)

- **No entity name on period rows.** Part E asks for it, and there is no
  honest source: the engine's served `statements.companyName` is the
  *workspace* name (`pipeline.py:4580`), identical for every period, and the
  deterministic trial-balance path derives its `company_name` from the
  filename stem (`pipeline.py:681`). Printing the workspace name on each row
  as "detected entity" would be a fabricated fact of exactly the kind under
  repair. The filenames, which are the real identity signal here, are shown
  instead. Surfacing a true per-period entity needs the engine to persist the
  extracted `company_name` on the period row — flagged, not faked.
- **The native month input's empty `---- ----` placeholder** is the same
  control the Add and Rename dialogs already use. Consistency beats a
  prettier one-off.
- **`ATTACHMENT` is quiet and `SOURCE` is not.** Only one file per period
  backs the numbers; the other rows should recede.
