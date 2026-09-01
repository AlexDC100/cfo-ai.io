# The Canvas — critique r2

Re-captured after the r1 fixes. Same 16 files, same run
(`CV-G6` in `e2e/design/canvas.spec.ts`, 10 passed / 2.6m).

---

## r1 items — verified fixed, on the pixels

| | r1 defect | r2 evidence |
|---|---|---|
| D1 | composer collapsed to ~40px at 390 | `canvas-390-dark-thread.png`: full-width field, placeholder on ONE line |
| D2 | 180px rail ate 46% of a phone | rail is gone below `md`; a `≡` toggle in the header opens it as an overlay |
| D3 | header said "No period" | header and grounding line both read **FY2025**, matching the page three inches away |
| D4 | streaming capture captured a settled thread | `canvas-1440-light-streaming.png` shows **EXPLANATION / Composing…** — a real in-flight card, asserted before the shutter |
| D5 | sidebar's ⌘J hint lied | removed from the row and from `SHELL_NAV_ALL` (the palette renders that field as a kbd hint too) |
| D6 | 560px default − 180px rail = a 380px document | default 620, rail 156 → 464px document, floor unchanged at 480 |
| D7 | command hints truncated at 390 | list is `sm:block`; below that, a one-line "Type / for commands." |

---

## What the r1 fixes uncovered — the important one

### D9 (severe) — mid-flight, every model answer said "the engine returned no figures"

The new streaming assertion went **RED on all four capture combinations**:
`canvas-artifact-pending` was not on screen while the answer was in flight.

Cause: `CanvasArtifactCard` branched on `!turn`. For the model lane a turn
exists from the moment of dispatch (`status: "retrieving"`), so an in-flight
answer fell through to the body, found `factNames.length === 0`, and rendered
**"The engine returned no figures for this one."**

That is not a cosmetic wrong state. It is a *false statement about the data*,
shown for the whole duration of every model answer, in a product whose entire
claim is that what it says about the numbers is true. Nothing in the r1
captures showed it, because r1 never photographed the state.

**Fixed:** the card now branches on `retrieving` / `generating` separately from
`done`, and says which is happening — "Reading the statements…" while the
engine reads, "Composing…" while the model writes over figures already in hand.

**This is the whole argument for the screenshot loop.** A gate written to catch
a *capture* defect caught a *product* defect instead, because forcing the
instrument to observe a state is what makes the state observable at all.

### D10 (real) — the composer unlocked 400ms after dispatch, not on completion

Found while fixing D9, not on the pixels. `submit` set `busy` true and cleared
it with `window.setTimeout(finish, 400)`. So the field re-opened while the
answer was still streaming, and a second Enter called `newController()` —
which **aborts the previous controller**, silently cancelling the answer the
reader was waiting for.

**Fixed:** `busy` is now derived from the pipeline's own status
(`retrieving` / `generating` on any live turn in the thread), with a
`dispatching` flag covering only the gap before a turn is observable. A timer
is not a completion signal.

---

## New in r2 — ranked

### D11 (moderate) — the header truncated the wrong half

`canvas-390-dark-thread.png` r2: "Meridian Industries SRL · FY20…". One
`truncate` spanning both halves, so the ellipsis ate the **period**.

Which company you are in is on every other surface. Which period the figures
below belong to is the thing this header exists to say.

**Fix:** company name shrinks, period is `shrink-0`.

### D12 (harness, recurring) — the banner circle survived being dismissed

r1/D8's fix (dismiss at the shutter) did not work: `public-test-mode-banner`
re-renders, and its circular × still sits on the canvas header in every r2
capture. Clicking a dismiss button is the wrong instrument for "this must not
be in the photograph".

**Fix:** one scoped `addStyleTag` hiding that single testid, inside the capture
run only. The geometry gates still measure the real DOM with the banner
present — only the photographs are cleaned.

### D13 (accepted, not a defect) — the thread is top-aligned and looks empty with one entry

`canvas-1440-light-streaming.png`: one entry at the top, ~650px of nothing, the
composer at the bottom.

A chat bottom-aligns, because the newest message is the subject. A document
top-aligns, because the FIRST section is where you start reading. This surface
is explicitly the second thing, and the empty space below is the page you have
not written yet.

**Kept.** Recorded because it looks like a defect in a screenshot and is not.

---

## Still open, and deliberately so

- **The Pro "SHOW THE SPEC" row repeats on every card** and is heavy for what
  it is (uppercase, full-width). At 390 it appears three times in one screen.
  Candidate for r3.
- **`/table` and `/chart` render a figure LIST**, with one line of copy saying
  the shape is missing. Correct floor, and it stays until the renderer lane
  registers through `canvasArtifactRegistry`. Not something this lane fixes by
  drawing its own chart.
