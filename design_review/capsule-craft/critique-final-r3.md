# The Capsule — closing critique, round 3

Round 1 measured the product. Round 2 audited the gates I had written
and found the TC-6 disease inside my own per-family floor. Round 3 asks
the two questions neither of those covers: **what did the change take
away that nobody measured**, and **who actually runs any of this**.

**Captures:** `design_review/capsule-craft/critique-r3` — geometry
byte-identical to r2 at all 16 frames, confirming the r2→r3 edits
(doc comments, a wide-only stamp, a jsdom fixture) moved nothing.

---

## 1. What the bucket chip took with it, checked rather than assumed

The chip was plain text inside the row's `<button>`, so it was part of
the row's **accessible name**: a screen reader announced "Core 200g
Protect". It now announces "Core 200g".

That is a real subtraction and it was checked rather than waved through.
It is the right one: the bucket takes five values across the whole
catalogue, so on the list a reader actually sees — `core` → four SKUs,
all four "Protect" — it distinguishes nothing for a sighted reader and
nothing for a screen-reader user either. It is not a name, it is a
partition, and the row it names opens `/products?search=…` where the
bucket sits in a column that IS a column, beside the numbers that give
it meaning.

Where a second string genuinely disambiguates, the row keeps it: the
company row still announces "Banca Transilvania · TLV", and
`CommandPalette`'s collision pass still promotes `searchText` to a
visible qualifier when two visible rows in one group share a label.

## 2. A NEW risk this change introduces, stated before anyone finds it

The resting card used to be a fixed 298px and therefore could never be
taller than its anchor allowed. It is now measured, so on a workspace
whose resting content **exceeds** `CAPSULE_REST_BUDGET` — three long
suggestion chips that wrap — the resting card grows upward past
`CAPSULE_ANCHOR_TOP` and can partially cover the pill.

This is arithmetic, not a measurement: `top = bottom − height` and
`height ≤ maxHeight`, so `top ≥ CAPSULE_EDGE_MARGIN = 8`. It is bounded
at 8px from the viewport top, it is the same direction every other state
already grows in (typing and answering both rest at y=8 and cover the
pill outright), and the alternative — clamping the resting card to the
budget — would CLIP a suggestion the workspace had something to say
with. Recorded as a bounded, deliberate consequence rather than
discovered later as a surprise. It is not reproducible on this stack:
this workspace yields one chip.

## 3. Nobody runs the static half of this lane

`scripts/check_capsule_craft.mjs` — F1 (no native tooltip), F2 (no
category column, now including the `trailing` slot ban), F2b (every row
family gated), F3 (strings), F4 (footer ≠ placeholder), F5 (the spec is
alive), F6 (no `title` anywhere) — appears in:

* `design_review/HERMETICITY.md` (prose),
* `docs/engine_book/testing_conventions.md` (prose),
* a comment in `scripts/check_staged_is_change.mjs`,
* this folder's own critiques.

and in **no** battery gate and **no** `.github/workflows/*.yml`. Its
sibling `capsule-ask` is a battery gate. So the gate that would have
caught PLANT B in 200 ms is one a human has to remember to type.

`scripts/run_battery.py` is BANNED for this lane, so here is the line,
verbatim, for whoever owns it — modelled on `capsule-ask` directly above
it, with the floor set from a measured `units=154`:

```python
        # F1-F6 — THE CAPSULE READS AS A CONVERSATION. Static half of the
        # craft lane: no native row tooltip, no category column and no
        # generic `trailing` slot for one to come back through, every row
        # family gated by G4's sweep (F2b), strings registered in EN+RO,
        # the footer does not restate the placeholder, the live spec's
        # anchors are producible. In the battery because the shipped build
        # carried 20 right-aligned category words at 1440 and 20 at 390
        # while every gate that could see them was either measuring element
        # boxes or never summoning the rows. Live half (G1-G7, needs vite
        # :5173 + engine :8000): e2e/design/capsule-craft.spec.ts.
        # Plants: design_review/capsule-craft/GATES-close2.md
        Gate("capsule-craft", ["node", "scripts/check_capsule_craft.mjs"],
             work_rx=r"GATE-WORK capsule-craft units=(\d+)", floor=100,
             units="capsule files + rows + row components + bundles + placeholders + spec anchors",
             canaries=("familiesGated", "rowComponents")),
```

Measured `units=155` on 2026-08-31 (154 before the r3 jsdom edit); `--probe-vacuity` fails as it must,
and `familiesGated` is part of the gate's own `discoveryBroken`
disjunction, so an F2b that reads nothing is a FAIL rather than a quiet
pass.

## 4. What I did NOT do, and why

* **Did not touch K6.** It is red at 113.5px against a 24px tolerance,
  it is in another lane's file, and it encodes the constraint the
  owner's ruling supersedes. Priced (`critique-final-r1.md`), reported,
  left alone.
* **Did not give `geometry()` a retry** to smooth over the harness
  flake in §5. I do not know the cause with certainty; I know the error
  shape means "the overlay was gone" because PLANT B's malformed first
  attempt produced it deliberately, and I know the trigger pattern
  (first run after a source edit). Guessing at an instrument is how an
  instrument stops measuring.
* **Did not raise G1's rest ink floors** to match the doubled density
  (5.62% → 8.05% at 1440, 9.72% → 13.93% at 390). A workspace that
  yields three chips is a taller card with proportionally less ink, and
  a floor tuned to this demo's one chip would red on it. The air is
  bounded by `REST_LEADING_GAP_PX`, which is the instrument that can
  actually see it.
* **Did not add a scroll affordance** to the typing list, which clips
  ~1.5 rows at 1440 with no cue. Real, visible in every typing capture,
  pre-existing, and outside both defects. Recorded, not fixed.
* **Did not make the bucket searchable.** It was never matchable — only
  rendered — so adding it to `searchText` would be a new feature wearing
  a cleanup's clothes.

---

## Final numbers

| | before | after |
|---|---|---|
| trailing offenders, 29-query sweep | 20 @1440 · 20 @390 | **0 · 0** |
| G4 row families floored | 0 (state floors only) | **9 floored + 2 pinned at zero** |
| G4 rows examined | 24 across 10 states | **70 across 15 states** (68 palette-rows) |
| rest card @1440 | 298px, lead 113px (37.9%), ink 5.62% | **208px, lead 24px (11.5%), ink 8.05%** |
| rest card @390 | 268px, lead 104px (38.8%), ink 9.72% | **187px, lead 24px (12.8%), ink 13.93%** |
| composer y @1440 / @390 | 355 / 825 | **355 / 825** (drift 0px) |
| answer ceiling @1440 / @390 | 358 / 590 | **358 / 590** |
| `REST_LEADING_GAP_PX` | 130 (above the 113 defect) | **32** (measured max 27) |
| K6 | 4/4 green | **3/4 — gap 113.5px, reported** |

Nine plants across the three rounds (A, B, C, D, E′, G, H, I), each
recorded with its diff and its red output in `GATES-close2.md`. No plant
was committed; `check_no_plants.mjs` is clean over 862 product source
files.

---

## 5. The harness flake — and the confounder I found only at the end

Six full runs of `capsule-craft.spec.ts` were made on this tree. Four
were 22/22. Two failed **one test each, a different one each time**:

| run | result |
|---|---|
| 1 | ✘ `G2 @390` — `locator.evaluate: Timeout … waiting for locator('[data-testid="command-palette"]')` inside `geometry(page)` |
| 2 | ✓ 22/22 |
| 3 | ✓ 22/22 |
| 4 | ✘ `G7/C4` |
| 5 | ✓ 22/22 |
| 6 | ✓ 22/22 |

Each failing test passed in isolation immediately afterwards (`G2 @390`
2/2; `G7/C4` 1/1 with `p50=19ms p95=26ms` against a 50ms budget, so its
timing half was nowhere near its limit), and the full run immediately
after each failure was green.

I first wrote this section claiming the trigger was "the first full run
after **my** source edit", with Vite dep re-optimisation as the cause.
**That correlation is confounded and I am withdrawing it**, because
`git status` at the end of the lane shows six tracked files modified
that this lane never touched:

```
 M design_review/E2E_BASELINE.txt        (mtime 21:10)
 M e2e/design/axe-dark.spec.ts
 M e2e/design/axe.spec.ts                (mtime 21:04)
 M e2e/design/modes.spec.ts              (mtime 21:03)
 M frontend/test/envPin.ts               (mtime 19:53)
 M scripts/run_playwright_gate.mjs       (mtime 21:29)
```

They belong to a hermeticity/egress lane (`design_review/HERMETICITY.md`,
`hermeticEnv.json`, `check_hermetic.mjs`) working in the SAME working
tree, and their timestamps interleave with my runs — `run_playwright_gate.mjs`
was written at 21:29, after my last battery run had already started.
Another lane editing this tree, and very likely running its own browser
suites against the same dev server, is at least as good an explanation
for a reload mid-run as anything I did, and I cannot separate the two
from here.

What IS established, and is worth keeping:

* the `G2` message means the overlay was not in the DOM — that meaning
  is not inferred, PLANT B's malformed first attempt reproduced the
  identical message deliberately by making the palette throw and unmount;
* neither failure reproduces in isolation, and neither reproduces on a
  re-run with the tree untouched.

**Recommendation: run this suite twice and read the second, and prefer
to run it when no other lane is editing the tree.** The instrument was
NOT given a retry — a retry chosen against a confounded correlation
would have been a guess dressed as a fix.

---

## 6. Verification was performed on a shared tree — what is actually mine

Because of §5, the exact file list matters. **This lane modified six
tracked files:**

```
frontend/components/instrument/shell/CapsulePaletteRow.tsx
frontend/components/instrument/shell/CommandPalette.tsx
frontend/components/instrument/shell/capsuleGeometry.ts
frontend/components/instrument/shell/__tests__/capsuleCraft.test.tsx
e2e/design/capsule-craft.spec.ts
scripts/check_capsule_craft.mjs
```

plus new evidence under `design_review/capsule-craft/`
(`craft.mjs`, `families.mjs`, `critique-final-r{1,2,3}.md`,
`GATES-close2.md`, and the `critique-r{0,1,2,3}` / `famcensus-r{0,1}`
captures). The other six modified files in `git status` are the other
lane's and were not read, run or reverted by this one. Every gate result
recorded here was therefore measured on a tree that also contained that
lane's in-flight changes — stated so the coordinator can re-run on a
quiet tree if any number matters enough.
