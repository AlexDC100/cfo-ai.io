# THE ARTIFACTS — gates and plant log (Part B)

The eight artifact types, and the gates that make their contract
falsifiable. `docs/engine_book/gates.md` carries the two battery-
registered sections (`artifact-export`, `artifact-law`); this page is
the lane's own record, including the gates that ride vitest and are not
in the battery.

---

## The contract, in one line each

| | law |
|---|---|
| **L1** | No number type anywhere in a spec tree. There is no field in the schema that accepts one. |
| **L2** | Every figure is a fact NAME that exists in the evidence and carries a DECLARED unit. |
| **L3** | Free text obeys the prose law — titles and labels go through `guardAnswer`, the answer lane's own parser. |
| **L4** | One unit per series, one currency per artifact. |
| **L5** | No cross-standard blending. The percentile law, applied to an artifact. |
| **A1** | The export derives nothing. A live `SUM()` is written only when it reproduces the served total. |
| **A2** | Absent is not zero — on screen, in the CSV, and in the workbook. |
| **A3** | Provenance survives the export, as a cell comment. |
| **A4** | The same request produces the same bytes. |

---

## Where each gate lives

| gate | runs | what it examines |
|---|---|---|
| **B1–B11** | `npx vitest run frontend/components/cfo/canvas/artifacts/__tests__/artifactGates.test.tsx` | 44 tests; per-KIND work census |
| **artifact-law** | `node scripts/check_artifact_law.mjs` (battery) | 22 lane files; per-kind wiring, no chart library, tokens, reserved red |
| **artifact-export** | `pytest tests/engine/test_artifact_export.py` (battery) | 26 tests; per-FORMAT part census, plus the live route |

The vitest suite prints its census, per kind, on every run:

```
GATE-WORK artifact-chart       guarded=1 planted=1 rendered=6 figures=46
GATE-WORK artifact-table       guarded=1 planted=1 rendered=1 figures=8
GATE-WORK artifact-spreadsheet guarded=1 planted=1 rendered=1 figures=8
GATE-WORK artifact-slide       guarded=1 planted=1 rendered=1 figures=6
GATE-WORK artifact-document    guarded=1 planted=1 rendered=1 figures=2
GATE-WORK artifact-scenario    guarded=1 planted=1 rendered=1 figures=5
GATE-WORK artifact-comparison  guarded=1 planted=1 rendered=1 figures=4
GATE-WORK artifact-finding     guarded=1 planted=1 rendered=1 figures=4
```

A floor per kind, not per sum. `import-boundary` printed "boundary
holds" with a live violation planted because its frontend half collapsed
517 → 1 while the total stayed above a global floor; a single
"43 tests passed" here would have exactly that property.

---

## The plants — vitest suite

Each was applied, observed RED, and reverted. The revert was verified
GREEN in every case (`44 passed`).

B11 is the runtime complement to `artifact-law`'s B-COMPLETE: the static
gate proves the dispatcher's branch EXISTS, B11 proves it WORKS. A branch
can be present and still resolve to a refusal, an empty body or the wrong
component, and a source census cannot tell the difference.

| # | plant | gate that caught it | red |
|---|---|---|---|
| P1 | `scanForNumbers` (L1) commented out in `artifactSpec.ts` | B1 | `scenario accepted a model digit` |
| P2 | `data-fact` removed from `ArtifactFigure` | B2 | `chart: 5 attributed figure(s), floor 8` |
| P3 | `totalAgrees = true` — the bridge adopts the reported total | B4 | `expected true to be false` |
| P4 | the `cross_standard` push disabled | B5 | `expected true to be false` |
| P5 | `PARITY_EPSILON = 1` | B6 | `expected true to be false` |
| P6 | `undo()` returns its argument | B7 | two reds, including `expected 'line' to be 'bar'` |
| P7 | `includeZero` disabled in `scaleOf` | B8 | `expected 30122880400 to be +0` |
| P8 | `data-testid="artifact-comparison"` removed | B2 (after the fix below) | `artifact-comparison did not render` |
| P9 | the spreadsheet RENDER branch removed from `<Artifact>` | B11 | `spreadsheet: the card rendered but artifact-spreadsheet did not` |

**P8 was GREEN on the first attempt**, and that is the entry worth
reading. Removing a component's root marker broke nothing: the B2 loop
counted attributed FIGURES in the container and they still rendered, so
nothing was bound to the component that produced them. That is
`CapsuleJumpList` again — a change applied to a surface no assertion was
watching (TC-7). The loop now asserts `ROOT_TESTID[kind]` FIRST, before
any count, with the message *"…did not render, so any count below
describes something else"*. Re-planted: RED.

---

## The plants — export builder

| # | plant | red |
|---|---|---|
| Q1 | `_rewrite_zip_deterministic` bypassed | `test_a4_no_entry_carries_a_wall_clock_timestamp[xlsx]` |
| Q2 | absent cell written as `0` | `test_a2_an_absent_cell_is_a_glyph_not_a_zero…` |
| Q3 | the live `SUM()` always written | `test_a1_a_disagreeing_total_is_written_static_and_says_why` + `test_a1_a_gap_in_the_rows_withholds_the_formula` |
| Q4 | provenance comment suppressed | `test_a3_every_fact_cell_carries_its_source_and_snapshot` |
| Q5 | `ppt/theme/theme1.xml` removed from the package | `test_package_is_structurally_sound[pptx-req2]` |

**The route was 422 while every builder test was green.** `_artifact_export`
carries `from __future__ import annotations`; fastapi is imported inside
`build_router` so the pure builders stay importable without it. A handler
annotated `request: Request` resolved to nothing and FastAPI read it as an
unknown QUERY parameter — `{"loc":["query","request"],"type":"missing"}` on
every POST. The module imported, the builders passed, `tsc` was clean. Only
a request could see it. Same trap as `CreateCheckoutRequest` in the 2026-07-24
backend cleanup. The body is now typed `Dict[str, Any] = Body(...)` —
`Dict`/`Any` are module-level imports, so the annotation resolves — and
`test_the_route_returns_bytes_not_a_422` covers it. Re-planting the forward
ref reds that test and `test_the_route_refuses_rather_than_guessing`.

**Q1 exposed a weakness in the determinism test itself.** Restoring the
wall clock reddened the timestamp assertion but NOT
`test_a4_the_same_request_produces_the_same_bytes` — two builds a few
milliseconds apart read the same second and produced identical bytes. A
determinism test that passes only because it ran fast is TC-9's shape:
its clean output is indistinguishable from "the clock never had a chance
to move". The test now moves `time.localtime` between three builds, and
re-running Q1 fails both assertions.

---

## The plants — static law

| # | plant | red |
|---|---|---|
| R1b | the comparison RESOLVE branch deleted | `comparison: missing wiring: resolved` |
| R1d | the comparison RENDER branch deleted | `comparison: missing wiring: rendered` |
| R2 | `import { BarChart } from "recharts"` | `B-NOLIB … imports recharts` |
| R3 | `NEGATIVE_FILL = "rgb(198,40,40)"` | `B-ONEACCENT … hard-coded colour: rgb(198,40,40)` |
| R4 | `text-alert` on a slide heading | `B-REDRESERVED … outside the allowlist` |

**R1 was GREEN twice before it was RED.** The first draft searched the
whole of `Artifact.tsx` for `kind === "<kind>"`; deleting the comparison
branch outright still printed **7/7 for every kind**, because
`figureCensus()` at the bottom of the same file also names every kind.
The detector's subject had been removed and its canary survived — TC-6,
exactly. The check now extracts the resolve block and the render block
by their own boundaries and searches each separately.

**R3 is why the colour rule is not a hex rule.** `rgb(198,40,40)` is a
hard-coded semantic red that `check_design_lint.mjs`'s D5-HEX cannot
see, because it contains no hex literal. The lane rule tests colour
VALUES.

`if (false && spec.kind === "comparison")` is deliberately NOT covered
here: `no-plants` owns that shape and reports it as
`[disabled branch: if (false && …)]`. Recorded so nobody adds a
duplicate rule.

---

## Two design decisions the gates forced

**EBITDA is a lever, not an output.** The scenario registry originally
computed `ebitda = revenue − expenses`. Baseline parity failed on the
real fixtures: `capsuleFactIndex` derives `expenses` as
`revenue − net_result`, so that subtraction yields the NET result, and
the engine's own EBITDA differs from it by the whole of D&A. There is no
D&A fact in the gateway, so EBITDA is not derivable at all. It became a
DRIVER (a lever on a served fact) and `net_result` became the output —
the engine's own identity, inverted, which is why it now reproduces the
engine exactly rather than approximately. **The parity check found this,
not review.**

**A chart shows a figure at rest.** The first draft put figures only in
the hover readout, and B2 reported *zero attributed figures* for the
chart kind — the DOM law had nothing to examine. Hover-only is also
wrong on a touch screen. Ticks now carry their value through `<Amount>`
while it fits (`TICK_VALUE_LIMIT = 6`; past that the values collide and
the readout carries the pointed-at one), and the readout shows the
latest point at rest.

---

## Known gap

`check_vitest.mjs` records a per-file executed-test baseline in
`design_review/VITEST_BASELINE.json`. A **brand-new** test file is not
in that baseline and is therefore unguarded until someone runs
`--write-baseline`. The baseline was NOT rewritten in this lane: at the
time of writing the tree carries two failures in
`frontend/components/cfo/__tests__/headerLaw.test.tsx` from a concurrent
header lane, and rewriting the baseline would absorb them as "known".
Whoever lands both lanes should run `node scripts/check_vitest.mjs
--write-baseline` once, with the header failures resolved.
