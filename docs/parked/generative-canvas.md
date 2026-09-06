# PARKED — The generative financial workspace ("the canvas")

**Status:** parked, not killed. **Branch:** `parked/generative-canvas`
(commit `6ebe3eb`, branched from `8191f1a` on `main`).
**Parked:** 2026-09-01, by the owner, mid-wave.

**Why parked:** the wrong moment, not the wrong idea. Nothing in the
user funnel was blocked on artifact generation, while several things
that *are* the funnel were stranded behind it — finishing and deploying
the Capsule, the grounded numeric demo owed across five waves,
provenance-on-hover, Anomaly Radar, and the global markets wave.

---

## What the mission was

Turn CFO AI from a text answerer into a workspace where you ask in
natural language and get **artifacts** back — charts, tables,
comparisons, spreadsheets, slide-ready summaries, exports — composed
live in the conversation, every figure traceable to a source cell.

The law it was built under, unchanged from the rest of the product:
**the model composes and explains; the engine computes.** Every numeral
in every artifact is a resolved fact from the facts gateway rendered
through `<Amount>`. A model-authored digit is rejected at parse, with no
exception for "it's just a chart label".

## What exists on the branch

Two of four lanes finished before the wave was stopped.

**Part C — the generation pipeline** (`src/engine/api/_artifact_spec.py`,
`_artifact_resolve.py`, `frontend/lib/artifactSpec.ts`, plus tests).
The model receives the question, a fact-index *summary* (names and
shapes, never values it could retype), and the artifact schemas; it
returns an **artifact spec** — metric ids, period ids, grouping, chart
type, labels — as strict JSON via tool use. The engine resolves every id
through the facts gateway and computes derived series natively.
**Spec-only is enforced structurally**: a payload carrying a numeric
series or a value is refused at parse, so the model *cannot* return a
value rather than being trusted not to.

**Part B — the eight artifact types**
(`frontend/components/cfo/canvas/artifacts/**`,
`frontend/lib/artifactExport.ts`, `src/engine/api/_artifact_export.py`):
chart (including the waterfall for EBITDA bridges), table, spreadsheet,
slide, document, scenario, comparison, finding — each with a citation
footer and an export builder.

## What does NOT exist

- **The canvas shell** (Parts A and D): the ⌘J right-side workspace
  panel, thread persistence per workspace, the docked composer, slash
  commands, attach routing, pinning. **The artifacts have no surface to
  live in.**
- **The A1–A10 gate lane.** No gate was written for artifact provenance,
  spec-only refusal, gap honesty, unit law across artifacts, export
  integrity, degraded mode, or artifact performance.
- **Both adversarial critics.** Neither the numeral-attack critic nor
  the gate-vacuity critic ran.

## What was learned, and should not be re-derived

1. **Spec-only wants to be structural, not contractual.** The pipeline
   makes it impossible for the model to return a value, rather than
   checking afterwards that it didn't. That shape is the same one that
   worked for `answerLocally()` (which cannot spend because it has no
   AbortController and no generator) and for the read-only tool view
   (which withholds callables rather than declining to call them).
2. **A chart label is a numeral.** The obvious hole in "no model
   numerals" is everything that isn't prose — axis ticks, legends,
   table headers, tooltips, export cells, slide titles, aria-labels. A
   guard written for prose does not cover any of them.
3. **Export integrity is a three-way assertion**, not a two-way one:
   xlsx/pptx/docx values must match the on-screen artifact *and* the
   facts gateway. Matching the screen alone would pass a screen that was
   already wrong.

## Resumption conditions

Resume when **all** of these hold:

1. The Capsule is finished, deployed, and the **grounded numeric demo**
   exists — a real period with an attached balance, a real number, a
   working provenance jump. That demo is the acceptance test for
   everything the artifacts would build on.
2. **Provenance-on-hover ships first.** Artifacts multiply the number of
   figures on screen; the affordance that makes one figure traceable has
   to work before there are hundreds.
3. Anomaly Radar has shipped — the `finding` artifact type is a
   projection of it, and building the projection before the thing is
   backwards.
4. A surface decision is made: this branch assumes a ⌘J right-side
   panel. If the Capsule's dropdown has since grown into the answer
   surface, the artifacts may belong there instead, and the shell lane
   should be re-specified before it is re-run.

**Before merging any of this:** it has never been through a refuter.
This session's record is that five independent critics each disputed at
least half of what a lane reported closed, and all five were right.
Treat every claim on the branch as unverified.

## How to resume

```
git checkout parked/generative-canvas
git rebase main            # main will have moved considerably
```

Then re-run the wave's remaining lanes — the shell and the A1–A10
gates — plus both critics. The original wave script is preserved in the
session scratchpad as `partf-canvas.js`; its lane briefs are the
specification.
