# The Capsule — closing critique, round 1

**Build:** working tree on `main` @ `cca5f95` + this lane's changes.
**Stack:** vite :5173 + engine :8000 PUBLIC_TEST_MODE, workspace
"Test workspace · Aug 2026" (Meridian Industries SRL, demo data).
**Captures:** `design_review/capsule-craft/critique-r0` (before),
`critique-r1` / `critique-r2` (after) — 16 frames each: rest / typing /
empty / answering × {1440×900, 390×844} × {dark, light}.
**Instruments:** `craft.mjs` (geometry + ink + lead gap),
`families.mjs` (which query summons which row family). Both in this
folder; both measure GLYPH extents, not element boxes.

---

## What was asked, and what the numbers say

### Defect 1 — the class of complaint 3 was alive

**Before (measured, 29-query sweep, both viewports):**

| query | rows | offenders | example |
|---|---|---|---|
| `range` | 9 | **9** | "Core Range" → "Protect", glyph gutter 509px (element gutter 12px) |
| `core` | 10 | **4** | four Product rows, **all four saying "Protect"** |
| `tinned` | 4 | 4 | "Tinned 100g" → "Fix", 527px |
| `juice` | 3 | 3 | "Orange Juice 1L" → "Scale", 495px |
| — | — | **20 at 1440 · 20 at 390** | |

Every offender was a `BucketChip` passed as `item.trailing` from one of
two call sites in `CommandPalette.tsx`.

**After:** `0 offenders at 1440, 0 at 390`, same 29-query sweep
(`famcensus-r1/FAMILIES.json`). The `trailing` slot is deleted from the
row's type, so the class cannot return by assignment — it has to delete
a static-gate line first.

**What was NOT done, deliberately.** The bucket did not become a
`qualifier` (a qualifier earns its ink by distinguishing one row from a
same-named sibling; "Protect" on four consecutive rows distinguishes
nothing) and did not become `searchText` (it was never matchable — only
rendered — so making it matchable would be a new feature wearing a
cleanup's clothes).

### Defect 1's gate half — the axis the sweep was blind on

G4's predicate called all 20 of those rows offenders and G4 reported
**zero**, because its nine queries — `dash sce work bench prod sett cash
bal zzqqxx` — summon eight row families and every offender was in the
ninth. Per-state floors could not see it either: every state it visited
was healthy; the sick ones were the states it never typed.

G4 now floors itself **per family**, from a recorded census
(2026-08-31, identical at both viewports):

| family | query | measured | floor |
|---|---|---|---|
| page | `a` | 8 | 6 |
| action | `a` | 5 | 4 |
| glossary | `glossary` | 1 | 1 |
| concept | `cash` | 13 | 8 |
| category | `range` | 2 | 2 |
| sku | `range` | 7 | 5 |
| company | `trans` | 6 | 4 |
| suggestion | (rest) | 1 | 1 |
| ask | `zzqqxx` | 1 | 1 |
| **period** | — | **0** | **PINNED at exactly 0** |
| **jump-row** | — | **0** | **PINNED at exactly 0** |

`period` is unreachable on this stack and that was **measured, not
assumed**: `usePeriodStepper().periods` is empty (the demo period
`demo-meridian` is a resolved sample id, not a `financial_periods` row),
and `aug`, `dec`, `202`, `a`, `e`, `2`, `0` — all of which match the
label a period would carry — produced no Periods section, while `a`
returned the palette's full 18-row cap with the slots after
Pages/Actions/Learn filled by Products. A floor of zero is the vacuity
this gate exists to refuse, so it is **pinned at exactly zero**: if a
period row ever appears, the gate fails and says to move it into the
floored table.

`check_capsule_craft.mjs` (new **F2b**) holds the two lists to each
other in 200 ms: a family in `CAPSULE_ROW_FAMILIES` with no expectation
is a red before a browser starts, and an expectation for a family no
component can paint is a red too.

### Defect 2 — 113px of air

| | before | after |
|---|---|---|
| rest 1440 | 298px card, **lead gap 113px (37.9%)**, ink 5.62% | **208px**, **lead 24px (11.5%)**, ink **8.05%** |
| rest 390 | 268px card, **lead 104px (38.8%)**, ink 9.72% | **187px**, **lead 24px (12.8%)**, ink **13.93%** |
| composer y 1440 | 355 | **355** |
| composer y 390 | 825 | **825** |
| typing 1440 | 358px | 358px |
| answering 1440 | 358px | 358px |
| typing 390 | 590px (G1) | 590px |
| answering 390 | 499px (G1) | 499px |
| G2 drift | 0px | **0px, both viewports** |
| K6 CLS open/close/stream | 0.0000 | **0.0000** |

The answer canvas is **unchanged** — that is the decoupling the ruling
asked for. `maxHeight` is no longer `restHeight + 60`; the bottom edge
is its own constant (`CAPSULE_ANCHOR_TOP + CAPSULE_REST_BUDGET`) and the
ceiling is `min(0.7 × viewportH, bottom − 8)`, so a leaner resting card
cannot shorten the answer.

`REST_LEADING_GAP_PX` went **130 → 32**. 130 was not a budget, it was a
receipt: it had been set just above the 113/104 it was meant to catch,
and the file said so in its own comment. Measured maximum across all
eight G1 states after the fix: **27px**.

---

## The open conflict, measured and priced — NOT worked around

**K6 (`e2e/design/capsule.spec.ts`, outside this lane) is RED:**

```
[K6 anchor] inline left "350px" · expected 350px          ✓
[K6 centre] drift 2.0px · gap 113.5px                     ✘  (tolerance 24px)
[K6 width]  capsule 538 overlay 680 · Δ 0 / 0             ✓
[K6 CLS]    open 0.0000 · close 0.0000 · stream 0.0000    ✓
Error: K6: 113.5px of empty space between the capsule and the panel it
is supposed to have become.
```

This is not a side effect I discovered late. It is the ruling. K6's gap
assertion encodes constraint **(A)** — "the resting card starts under
the pill" — and (A), (B) "the composer never moves" and (C) "the resting
card is the size of its content" are **algebraically incompatible**, not
merely in tension:

```
pillBottom   = 44.5   (fixed by the header)
restContent  = 208    (fixed by what the resting card says)

(A) ⟹ cardTop_rest ≈ 68  ⟹  composerY = 68 + 208 − 11 = 265
the card may not grow above EDGE_MARGIN=8, so
maxHeight = (composerY + 11) − 8 = restContent + 60
```

So under (A)+(B) the answer canvas ceiling **is** `restContent + 60`:
the 113px of air at rest and the 113px the answering state uses are the
same pixels. The owner's sentence — *"anchoring the bottom does not
require reserving space you're not using"* — drops (A).

**The alternative was built and measured rather than argued about.**
Setting `CAPSULE_REST_BUDGET = 208`:

| | budget 298 (shipped here) | budget 208 (K6-preserving) |
|---|---|---|
| K6 | **1 of 4 RED**, gap 113.5px | **4 of 4 GREEN**, gap 23.5px |
| rest 1440 | 208px @ y158 (detached) | 208px @ y68 (attached) |
| typing 1440 | 358px | **268px** — 9 rows into 268 |
| answering 1440 | 358px | **268px** — action row + follow-up chips below the fold |
| composer y | 355 | 265 |
| 3-chip workspace at rest | 298px @ y68, K6 untouched | 268px **@ y8 — the card covers the pill it grew out of**, and K6 passes it, because a negative gap is ≤ 24 |

298 was chosen because it degrades gracefully (the card detaches) where
208 degrades pathologically (the surface hides its own trigger while the
gate says nothing). **Both are workspace-dependent**, and that is the
real finding: once the resting card measures its content, K6's static
gap is a function of the content and can no longer be a stable law about
this surface. Whether K6 should measure the morph's ORIGIN instead of a
static gap is an owner decision on a file this lane does not own. It is
reported, not edited, and not worked around.

---

## Honest defects still open after this round

1. **K6 red, above.** Owner decision. Not mine to weaken.
2. **`restBudget` describes nothing at 390.** The narrow bottom edge is
   `viewportH − 8`; the budget plays no part there, yet
   `data-rest-budget` still stamps a number. Documented in the field's
   doc comment this round; it is a stamp that could mislead a future
   gate.
3. **The typing list clips with no scroll affordance.** At 1440,
   `range` paints 9 rows into a 358px card; ~7.5 are visible and the
   8th is cut by the key-legend band with no gradient, no scrollbar, no
   "more" cue. Pre-existing, outside both defects, recorded because it
   was visible in every typing capture.
4. **G4's `suggestion` expectation depends on a network-fed chip.** The
   resting chip comes from the workspace snapshot's unattached-period
   half, which arrives over the network; `boot`'s 8s settle is *usually*
   enough. It was not, twice: one capture run and one full-suite G4 run
   read a resting card with zero chips. `openSurface` now waits it out
   (bounded, not swallowed — if the chip never arrives, the family floor
   and the ink floor fail on the measurement rather than on a timeout).
   The dependency is real and is recorded here rather than hidden.
5. **Harness flake — see r3 §5.** Two of six full-suite runs failed
   one test each (`G2 @390` inside `geometry(page)` with
   `locator.evaluate: Timeout … waiting for locator('[data-testid="command-palette"]')`,
   and `G7/C4`). Neither reproduced in isolation; the run immediately
   after each, with nothing changed, was 22/22. A CONCURRENT LANE is
   editing this same working tree (r3 §5, §6), so the cause is not
   established and the instrument was deliberately **not** given a retry
   on a confounded correlation.

## Round-1 verdict

Both defects are closed on the measurement that defined them, at both
viewports and in both themes, with the answer canvas and the composer
anchor unchanged to the pixel. Every gate that certifies this was
planted and proven RED (`GATES-close2.md`). One shipped gate in another
lane now contradicts the ruling that produced this change; it is
reported with the numbers and the priced alternative, and it is left
untouched.
