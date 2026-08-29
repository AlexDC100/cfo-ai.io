# PRODUCTS lane — critique r3 (final)

Shots reviewed: `products-r1/` + `products-r2/` (empty state, both themes, 1440/1280/390),
`products-r3/` (populated categories + All-SKUs table, light + dark + mobile — captured
against fixture API payloads because the local stack's `/api/test-mode/session` 503s
without Supabase env; populated-state markup additionally covered by
`frontend/components/cfo/products/__tests__/productsInstrument.test.tsx`).

## Hierarchy
- Populated page now opens on the compact instrument header (PORTFOLIO eyebrow →
  Product intelligence → dataset facts + source-file chip → Guide me action), then the
  quality verdict, then the KPI row — the reading order is verdict-first instead of a
  56px serif billboard. GOOD.
- Empty state: sans 32/40 hero with the gradient phrase; the template Panel's caps
  header sits at the same visual weight as the other section labels (EXPECTED FORMAT /
  EXAMPLE RESULT), so the right column no longer out-shouts the dropzone. GOOD.
- All-SKUs table: 32px single-line rows put ~2× more portfolio on screen; the totals
  line under a double hairline reads as the table's landing point. GOOD.

## Density
- KPI + working-capital tiles dropped num-hero for a 26px mono count — tighter and the
  chip label (SKUS / PROTECT / WATCH / WIND DOWN, DIO/DSO/DPO/CCC) carries the
  identity. Cards trimmed p-[18px]→p-4.
- Brand·category moved inline after the SKU name; both truncate. At 1440 the name
  column is tight against 8 fixed columns — acceptable, and the row tooltip (title)
  still carries the full name. WATCH, not a blocker.

## Contrast / color
- One semantic system end to end: protect=success, watch=caution, wind-down/negative
  =alert; brand only for identity (SKUs, company DIO). All raw hex, tailwind reds/
  ambers/emeralds/blues/violets and the retired #5CD3C5 family are gone from lane
  files; lint contributes 0 from this lane.
- Accounting negatives render "(0.7 M RON)" + "-6.8%" in alert — reads instantly in
  both themes. The DIO>365 category border + callout moved from (mistuned) teal to
  alert — red now means danger only, as the law requires.
- Dark (Terminal): success-tint quality banner, chip tints and hairlines all hold; no
  borrowed light-theme fills.

## Soul / consistency
- Every figure flows through <Amount>/<MoneyAmount>/<PercentLevel> — mono, tabular,
  locale-aware, magnitude-grouped (whole SKU table shares one M-scale; category cards
  group NIV+GM per card; comparison deltas share one scale). Em-dash for absent
  values everywhere (DIO, signals in the example preview) — nothing fabricated.
- Chips are the one chip system (status pills, KPI badges, WC badges, file chip in the
  header, wind-down tags) via instrument Chip tones.
- Resting shadows removed (inflight card's 24px drop, ViewToggle active pill,
  dropzone drag glow, step-number shadows); the template card's animated gradient +
  blur blobs replaced by a resting Panel with real file-affordance rows.
- New pre-upload "Example result" panel shows the product's output shape from the
  format sample's own fictional rows: derived DIO (inv/COGS×365), summed totals under
  a double hairline, and honest em-dash Signal cells with a caption saying signals
  appear only once real rows are classified.

## Issues found and fixed during the loop
- r1 mobile: whole hero clipped at 390px — my nowrap meta line in the new file rows
  inflated the implicit grid column's max-content. Fixed (meta wraps again) and the
  hero grid got an explicit `grid-cols-1` fallback; re-probed: page scrollWidth = 390,
  only intentional overflow-x-auto tables exceed it.
- r2 mobile: file rows crushed the filename to 3 chars — rows now flex-wrap so the
  View/Download pair drops below the name at phone widths.

## Remaining known nits (accepted)
- Column header "NIV (kRON)" vs converted cell units ("M RON"/€) — the label lives in
  the locale files (banned for this lane); the mismatch predates this pass (the old
  <Money compact> also rendered its own unit).
- GM column keeps its pre-existing forced "+" sign; changed nothing to preserve
  behavior parity.
