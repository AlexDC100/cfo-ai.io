# Benchmark Integrity — screenshot critique r2 (fixes applied, verified in r3)

Rounds: `benchmark-r1` (first wiring) → fixes → `benchmark-r2` (F1/F2/F4)
→ `benchmark-r3` (F3 refinement + theme-pinning fix in the harness).
`benchmark-r3` is the round that reflects what ships.

## r1 findings — disposition

| | finding | status |
|---|---|---|
| F1 | subtitle promised "median and P25/P75" that the default group withholds | **fixed** — subtitle now states the law: "One population at a time — a market group, one reporting currency, one accounting standard. Percentiles need at least 3 comparable peers; below that the panel names the peers instead." |
| F2 | the same 2-line refusal printed six times | **fixed** — the reason is one panel-level line (`benchmark-rule-note`), rendered only when at least one tile is actually refusing. Tiles keep the verdict plus a mono `2 of 3`. Mobile went from six stacked paragraphs to six two-line cards. |
| F3 | FX rate + date crowding the population line, duplicating the tooltip | **fixed twice** — r2 moved the rate + date into the ⓘ tooltip (where the brief puts them) leaving an inline `native USD`; r3 made even that marker conditional on the viewer's display currency differing from the cohort's. On the BVB cohort in RON it now says nothing, because the population line already says `RON`. |
| F4 | drill-down title lost the clicked group's name | **fixed** — the title is `EBITDA margin — Peers BVB` again; the subline carries `n=2 · FY2024 · RON`. |
| F5 | "IN THIS POPULATION" heavy on mobile | **fixed** — "Members" / "Companii". |

Side effect worth noting: fixing F2 also removed a real duplication in the
code. The statistic is now computed ONCE per (cohort × metric) in the panel
and handed to the tile, the panel note and the drill-down, so those three
surfaces cannot disagree about n, ordering or state. Previously the tile and
the drill-down each called `computeBenchmarkStats` on their own.

## What r3 shows

- **`panel--bvb--*`** — the live defect state, fixed. Two companies, six
  metrics, zero fake quartiles. Every tile: "Not enough peers for
  percentiles · 2 of 3", then TLV and CFH with their actual values.
  EV/EBITDA is a genuine zero-variance pair (8.00× / 8.00×) and does not
  invent a range around it.
- **`panel--global--*`** — n=6, percentiles earned. Population reads
  `US · USD · US_GAAP · FY2025 vs FY2024` with the amber **Mixed fiscal
  years** chip and `native USD` (the viewer's display currency is RON).
  No rule line, because nothing is refusing.
- **`panel--global-technology--*`** — n=3, the threshold itself. Percentiles
  appear at exactly 3, which is what `MIN_N_FOR_PERCENTILES` and the unit
  test both pin.
- **`panel--drill--*`** — group name restored, ordering identical to the
  tile above it.
- Light and dark hold at 1440 and 390. Negative medians (`-0.45×`) keep
  their sign and their tabular alignment.

## Open / not covered by a screenshot

1. **n=1 and zero-variance-at-n≥3 have no live cohort on this page.**
   `buildBenchGroups` only emits sector subgroups at n ≥ 3, and both
   shipped BVB names carry every metric, so nothing on `/public-companies`
   renders `single_comparable` today. Those two states are pinned by the
   PM3 fixtures in `frontend/lib/__tests__/benchmarkHonesty.test.ts`
   (`FIXTURE_N1`, `FIXTURE_FLAT`) rather than by a screenshot. Flagged
   deliberately instead of faking a fixture route to photograph them.
2. **The cohort chip row is likewise unphotographed.** It renders only when
   one group spans more than one population, and neither shipped group
   does (BVB is all RON/RAS-IFRS; Global is all USD/US_GAAP). The
   partitioning and its Romania-first / marquee ordering are covered by
   unit tests. The first non-US name added to the global watchlist will
   surface it live.
3. **Harness note.** The element-scoped shot script had to pin the theme
   via `addInitScript` before load — a post-load class swap was being
   re-hydrated back to light by next-themes at the 390 breakpoint, so the
   first mobile "dark" shots in r1/r2 are actually light. `r3` mobile darks
   are correct. `scripts/design_shots.mjs` (full-page) was never affected.

## Route note

`/benchmark` is `pages/cfo/BenchmarkReport.tsx` — the backend CAEN
percentile report, a different surface, not touched by this lane. It was
captured in `benchmark-r1/benchmark--*` for completeness. The panel this
lane owns lives on `/public-companies`.
