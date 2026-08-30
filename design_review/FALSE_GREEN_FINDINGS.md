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

---

# Round 2 — what three adversarial refuters found

The sweep lane reported all 30 gates carrying a canary, a work-count
floor and a proven RED. Three refuters were then pointed at that claim
with instructions to **refute, not confirm**. They broke gates the lane
had just certified — which is the argument for adversarial verification
in one line.

## R1. `metric-declared` — 15 undeclared metrics were live in the tree

The gate matched **call shapes only** (`money(...)`, `_money_metric(...)`,
`facts_cited={...}`). A plain module-level registry was invisible to it,
so it printed `benchmarks 0 metrics OK` — and "0 metrics" reads as "this
surface declares nothing" rather than "this gate cannot see this
surface".

Undeclared, and therefore **refusing to render**, in production:

| Registry | Undeclared | Of |
|---|---|---|
| `_benchmark_engine.METRIC_DISPLAY` | 10 (4 are `fmt: "currency"`) | 17 |
| `serving/facts._MARKET_METRICS` | 5 (all of them) | 5 |

Note the shape of the six percent ones: `cogs_pct_revenue`,
`opex_*_pct_revenue`, `depreciation_pct_revenue`. They end in
`_revenue`, **not** `_pct`, so the house suffix convention never applied
— which is how ten of seventeen rows in one registry went undeclared
without anyone noticing.

FIXED: all 15 declared; the gate now reads both registries
authoritatively, as its own docstring always said it should.

## R2. `metric-declared` — its work count could not notice a lost surface

A refuter dropped five of seven surfaces. The census still reported
**41 names**, because `total_names` is a set UNION and the dropped
surfaces contributed no unique names. **No global floor value could ever
have caught this.**

FIXED: `SURFACE_FLOORS` per surface, asserted after the discovery loop.
Replaying their exact plant now yields `DISCOVERY BROKEN — benchmarks 0
metric(s), floor 15 · serving 0 metric(s), floor 5`.

## R3. `import-boundary` — the one that runs in CI

Truncating `_fe_files()` to a single file, with a real violation planted
in a frontend file no longer walked, produced:

```
[check_import_boundary] scanned 570 file(s): engine=284, frontend=1, private-fields=285
[check_import_boundary] boundary holds (engine=OK, frontend=OK, private-fields=OK)
```

The frontend half collapsed 517 → 1 and the **total** stayed far above
the single global floor of 200, because the engine half alone cleared
it. Both named canaries survived the plant. **A floor on a sum cannot
detect one addend collapsing.**

Aggravating: `.github/workflows/tier1-validation.yml:165` runs this
script **directly**, with no battery wrapper — so anything not asserted
inside the script is not asserted at all in CI.

FIXED: per-half floors (`engine` 200, `frontend` 300, `private-fields`
200) asserted **in the script**, not in the battery layer, for that
reason. Their exact kill now fails.

## R4. `capsule-ask` / K1 — grading a follow-up field, not the surface

K1's key filter was `/placeholder$/i` — the dotted path had to END in
`placeholder`. The real capsule placeholder is an OBJECT
(`placeholder: { ask, askNoPeriod, aria }`), so its leaves end in
`.ask` / `.askNoPeriod` and were **never selected**. A refuter set the
live string to `"Search pages, actions, periods, companies… then Ask"`
— the exact regression K1 exists to guard — and the gate stayed green.

PARTIALLY FIXED: the filter now matches nested placeholder objects.
**Open:** `isKeyRendered()` matches literal `t("…")` call sites, and the
redesign has moved the composer to a variable placeholder, so the keys
now read as DEAD COPY. That verdict is wrong, but the redesign is
mid-flight and chasing it against a moving tree would measure nothing.
**Re-verify once `wf_5d202ba7-535` lands.**

## What the refuters could NOT break

Corroborated by external instrumentation — an `open`-event audit hook
for Python gates and an `fs` shim for Node — the runtime/work table is a
real measurement. `tsc` (662 files), `stale-gates` (676 opened vs 635
claimed), `global-positioning` (665), `narrative-units` (7),
`corpus-policy` (3672) all check out. The three 0.1s suspects genuinely
do read 635/665/7 files that fast.

## The lesson that generalises past canaries

A canary names a file. A floor names a number. **Both can survive the
failure they exist to catch** — the canary if the plant keeps that one
file, the floor if it is a sum and only one addend collapses.

What survived every attack was the gate that compares against a
**recorded expectation per component**: per-surface, per-half, per-lane.
Not "did we find violations" but "did each part of the walk produce the
quantity it is supposed to produce".
