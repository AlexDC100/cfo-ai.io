# REPORT PAGES lane — critique r2 (final)

Shots: `design_review/report-pages-r2/` (same route set + fixture probe as r1).

## r1 → r2 deltas verified

1. **TLV header at 390px** — fixed and confirmed
   (fixture-public-tlv-overview--mobile-390--dark.png): back-link + monogram
   row, then ticker + name + meta, then the peer/refresh buttons on their own
   row. No overlap in either theme.
2. **Probe hygiene** — the GuideMe scrim no longer occludes any shot; the
   /report header (eyebrow → title → mono context → Export/Print) is fully
   visible in both themes.

## Final state check, per gate

- **Hierarchy** — every page leads with PageHeader (eyebrow/title/context/
  actions); one primary action per page (Export PDF on /report, Export PDF on
  /peer-report, Add-as-peer on TLV); serif display is gone from all five
  pages + their five exclusive components (lint D10-SERIF: 0 in lane).
- **Density** — statement tables on the h-8 grid; KPI tiles p-4 with 10.5px
  caps labels and 19-21px mono values; mobile 390 keeps 2-col KPI grids and
  in-panel horizontal scroll for wide ledgers (min-w + overflow-x-auto —
  page body never scrolls sideways).
- **Contrast** — both themes shot; token surfaces throughout; loss/danger
  red, caution amber, success green, info slate; brand reserved for the one
  headline emphasis + provenance affordances. No verdict is teal-washed
  anymore.
- **Soul** — the report reads as a ledger: mono tabular everywhere via the
  Amount family, magnitude groups per row, accounting conventions, honest
  approximation marks, exact figures preserved in sub-lines. Decoration
  removed (gradient heroes, glow shadows, rounded-2xl blobs → 6/10/12).
- **Consistency** — /report, /peer-report, TLV dashboard and MultiYear all
  share Panel/PanelHeader/Chip + the caps section-header idiom that
  Benchmark/Scenarios/Variance already use.

## Gates

- `node scripts/check_design_lint.mjs` — lane files contribute ZERO
  violations (repo total is other lanes' in-flight work).
- `npx tsc --noEmit` — clean.
- vitest: amount.test.tsx (7), amountFormat.test.ts (15),
  multiYearHistory.smoke.test.tsx (1, new) — all pass. Known pre-existing
  failures (currencyToggle, chatScope, commandCenterMenu) untouched.
- Routes/params/testids preserved: ?period=, :ticker, ?dimension=, ?tab=,
  ?doc=, report-export-pdf, peer-export-pdf, multiyear-print,
  public-company-* testids all intact; export actions unchanged
  (window.print / print-dialog PDF path).

Lane closed at r2.
