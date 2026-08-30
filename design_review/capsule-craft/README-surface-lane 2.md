# `design_review/capsule-craft/` — what in here is the SURFACE lane's

Two lanes worked the Capsule craft pass in the same session and this
directory holds output from one of them. Everything listed below is the
**surface** lane (the one that changed product code). Anything else in
here, and everything in `e2e/design/capsule-craft.spec.ts` and
`frontend/components/instrument/shell/__tests__/capsuleCraft.test.tsx`,
belongs to the **gates** lane and was neither written nor edited here.

## Harnesses (this lane's, runnable)

| file | what it does |
|---|---|
| `shoot.mjs` | drives the overlay into rest / typing / answering at 1440 + 390 in both themes and screenshots each, writing `MEASURE.json`. `scripts/design_shots.mjs` captures ROUTES; every state in this pass is a state of an overlay and is invisible to it |
| `zoom.mjs` | close-ups at dsf 2–4 of the composer's edge treatment and the coach mark, which a full-page shot cannot settle |
| `measure.mjs` | geometry, a WCAG contrast census over the **composited** pixel (every ancestor background alpha-composited down), a `[title]` sweep, and the coach mark's anchor |

```
node design_review/capsule-craft/shoot.mjs   --label craft-r5
node design_review/capsule-craft/zoom.mjs    --label craft-r5
node design_review/capsule-craft/measure.mjs --label craft-r5
```

All three need the authed test-mode stack (vite :5173 + engine :8000
`PUBLIC_TEST_MODE`). None of them asks a question, so none of them spends.

## Rounds

`craft-r0/` is the surface as shipped in 62fba00 — the evidence the seven
complaints were checked against, including the two places the owner's
description and the measurement disagree. `craft-r1/` … `craft-r5/` are
the passes; `craft-r5/` matches the final code.

## Critiques

`critique-surface-r1.md` … `critique-surface-r4.md`, one per round, each
naming what is still wrong. `critique-surface-r4.md` carries the
complaint-by-complaint verdict and the proof for the one gate left RED.

## Plants

`PLANTS-surface.md` — every gate this lane wrote or touched, planted,
observed RED, reverted, observed GREEN, with the diffs. Including the
one that needed a THREE-line plant before it would fail, and the two
detectors that were wrong before they were right.
