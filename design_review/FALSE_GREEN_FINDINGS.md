# Vacuity probe — gates that pass while examining nothing

**Measured 2026-08-30, independently of the sweep lane**, so there is a
second opinion to check its report against. Probe harness lives outside
`scripts/` on purpose (a lane owns that tree); nothing was permanently
edited — each gate's discovery root was neutered, the gate run, and the
file restored byte-for-byte with an assertion on the restore.

## The failure being probed

`npx tsc --noEmit` returned **exit 0 in 0.2s having checked zero files**,
and nothing in its output distinguished that from a clean check of 610.
It sat in the battery for months.

The generalisation: **a gate that discovers its own inputs can lose its
inputs and still pass.** The runtime is the tell — but only if someone
reads it, which nobody does for a green gate. So the gate must say what
it examined, and fail when that count is zero.

## Method

For each gate, set its discovery root to empty, run it, restore.
A gate that still exits 0 is a confirmed false green.

## Result — 5 of 9 probed gates pass while examining nothing

| Gate | Neutered | Verdict |
|---|---|---|
| `import-boundary` | `FE_PATTERNS = []` | **VACUOUS-PASS** — prints "boundary holds (engine=OK, frontend=OK)" |
| `metric-declared` | `SURFACE_DIRS = []` | **VACUOUS-PASS** |
| `metric-units` | scan roots emptied | **VACUOUS-PASS** |
| `capsule-ask` | `ASK_ROW_KEYS = []` | **VACUOUS-PASS** |
| `global-positioning` | `ROOTS = []` | **VACUOUS-PASS** — output byte-identical to a real pass |
| `narrative-units` | `SCOPE = []` | correctly failed |
| `stale-gates` | `GATE_ROOTS = []` | correctly failed |
| `finding-specificity` | — | not probed; no discovery root matched the pattern |
| `public-sitemaps` | — | not probed; same |

## The most serious: `import-boundary`

It enforces the facts-gateway single-read-path invariant — the rule that
no surface reads an envelope except through `engine.serving.facts` /
`frontend/lib/servedFacts.ts`. With its pattern list emptied it prints
`boundary holds (engine=OK, frontend=OK, private-fields=OK)` and exits 0.
A real boundary violation plus any change that broke its discovery would
read as compliance.

## The instructive one: `metric-declared` is mine

I wrote the DISCOVERY BROKEN canary as the antibody for this exact
class, put it in this gate, and **the gate still passes vacuously** —
because the canary is asserted *inside* the per-surface loop. With
`SURFACE_DIRS = []` the loop body never executes, so the canary never
fires and the census prints a clean pass over zero surfaces.

The correction generalises to every canary in the repo:

> A canary checked inside the discovery loop cannot fire when discovery
> returns nothing, which is the case it exists to catch. The canary and
> the work-count floor must both be asserted **after** the loop, against
> the totals.

## Cross-check

`narrative-units` and `stale-gates` fail correctly, and both are gates
that compare against a recorded expectation (a producer count; a
baseline). That is the structural property that saves them: they do not
merely look for violations, they assert a *known quantity was found*.
