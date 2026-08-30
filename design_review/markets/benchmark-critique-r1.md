# Benchmark Integrity — screenshot critique r1

Shots: `design_review/markets/benchmark-r1/`
· `panel--{bvb,global,global-technology,drill}--{desktop-1440,mobile-390}--{light,dark}.png`
(element-scoped, so the small-n states are actually readable)
· plus full-page `public-companies--*` and `benchmark--*` at 1440 / 1280 / 390 × light / dark.

Live cohorts on the page today: **Peers BVB n=2** (default), **Global n=6**,
**Global · Technology n=3**.

## What the round proved

- The live defect is gone. The default group is two companies, and the panel
  no longer prints a median, a P25, a P75, a Leader and a Laggard for it. It
  prints the refusal and the two members. Before this round the same tiles
  showed "Median +28.5% · P25 · P75" over CFH and TLV, plus a "Leader" and a
  "Laggard" — in a population where every member is both.
- The grouping law is visible: `POPULATION  BVB · RON · RAS/IFRS · FY2024`
  on the home cohort, `US · USD · US_GAAP · FY2025 vs FY2024` on the global
  one. The mixed-year case fires its own amber chip rather than averaging
  two fiscal years in silence.
- EV/EBITDA on the BVB cohort is a real zero-variance sample (CFH 8.00×,
  TLV 8.00×). It correctly refuses rather than printing P25 = P50 = P75 = 8.00×
  three times.
- Dark theme is clean at both viewports: the amber caution chip, the mono
  population line and the tile sleeves all hold contrast.

## Findings

**F1 — the section subtitle now contradicts the section. (copy, high)**
It reads "Median and 25th/75th percentiles computed per group", but on the
default group nothing computes a percentile. The subtitle should state the
LAW (one population at a time, minimum n) rather than promise a statistic
the panel is often right to withhold.

**F2 — the refusal is printed six times. (layout, high)**
Each tile repeats the same two-line explanation — "2 of 3 needed. A quartile
drawn between 2 points is interpolation, not a distribution." Six copies at
1440 is noise; on mobile-390 it is six stacked paragraphs and the grid stops
reading as a grid. The reason belongs once, at panel level; the tile should
carry only the verdict and its own n (per-metric n can differ from cohort n,
so the tile still needs a state of its own).

**F3 — the FX line is in the wrong place and runs the population line to
full width. (copy, medium)**
`… · Percentiles are computed on native USD figures. · 1 USD = 4.548 RON ·
BNR · 2026-08-05 → RON` competes with the fiscal chip and repeats verbatim
what the ⓘ tooltip already says. No figure on this panel is money, so no
figure here is ever converted — the rate and its date belong in the tooltip
(where the brief puts them) and the inline line should say only which
currency the numbers are native to.

**F4 — the drill-down title lost the group's name. (copy, medium)**
It now reads "EBITDA margin — US · USD · US_GAAP", so the sector context the
user actually clicked ("Global · Technology") disappears and the cohort key
is stated twice on screen. Title should carry the group label; the key stays
on the population line above.

**F5 — "IN THIS POPULATION" is a long label for a two-row list. (minor)**
Fine at 1440, heavy on mobile where it repeats under every tile.

## Not defects

- Ordering flips correctly with the metric's direction (LEVERAGE lists TLV
  0.00× above CFH 1.20×; FCF lists CFH +4.5% above TLV +0.0%).
- Negative medians render with sign and stay legible (`-0.45×`).
- The refusal tiles stay clickable and the drill-down shows the same two
  members — "show the raw members" is honoured on both surfaces.

## Route note

The brief said to loop `/benchmark`. `/benchmark` is `pages/cfo/BenchmarkReport.tsx`,
the backend CAEN percentile report — a different surface, owned by no lane
here and untouched. The panel this lane owns renders on `/public-companies`.
Both routes were captured; the critique above is of the panel.
