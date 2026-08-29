# METRICS GRID — critique r1 (post-migration, shots: metrics-grid-r1/)

Scope: /dashboard "All metrics" section (eyebrow METRICS) — the last serif
holdout on the flagship. Shots: desktop/laptop/mobile × light/dark, plus
targeted Trend-view captures.

## Hierarchy
- Label (11px caps ink-mute) → value (22px mono ink) → definition line
  (11px ink-soft) now matches the key-metric row directly above; the two
  grids finally read as ONE instrument. Before, the serif "295,1 mil. RON"
  made the configurable grid look like a different product.
- The METRICS eyebrow dropped the Sparkles glyph and the extra-wide
  tracking; it now sits at the same visual weight as RECOMMENDATIONS
  above it. Nothing in the section chrome competes with the figures. PASS.

## Density
- Tiles are px-4 py-3 vs the key-metric row's p-4 — one step tighter,
  appropriate for an 8–12 tile grid vs a 4-tile hero row. No dead air;
  the sm tiles hold label+value+definition without crowding the ⋯ corner
  control (pr-8 on the label row still clears it). PASS.
- "Add metric" reads as an invitation, not data: dashed hairline, ink-mute,
  same 10px radius as siblings. PASS.

## Contrast
- Light: mono values in ink on surface, hairline rule borders — no shadow
  halos left (the .card-2026 blur shadow is gone from this section).
- Dark (Terminal): borders survive, values legible, brand-l sparkline reads
  clearly against the tile. Both themes verified in shots. PASS.

## Soul
- Every figure is mono tabular via <Amount>: "295.1 M RON", "11.2%",
  "1.85×", "1.52×". One MoneyAmountGroup wraps the grid, so all money
  tiles share one magnitude (M RON across the board — the old mixed
  "295,1 mil." vs full-digit renderings is impossible now by construction).
- Percent metrics render as LEVELS via PercentLevel (unsigned "11.2%"),
  NOT kind="percent" — that kind is a signed delta per the instrument's
  own contract in MoneyAmount.tsx, and "+11,2%" on a margin level would
  misstate the figure. Ratios via CappedMultiple (kind="multiple", ≥99×
  discipline). Days/scores/counts via <Amount kind="count"> with the
  NNBSP unit joint.
- Red reserved: the remove menu item / remove hover are the only alert
  reds (destructive action — legitimate). Trend direction no longer
  colors red/green; the badge is a neutral Chip whose signed mono figure
  carries direction, matching the key-metric row's neutral YoY chip.
  Sparkline pinned to brand accent in both directions.

## Consistency
- Chrome = rounded-md border-rule bg-surface — identical to KeyMetricCard
  and Panel. Edit ring/focus ring moved to brand tokens; Done button to
  brand-tint/brand-d; empty-state CTA to bg-brand text-paper hover:brand-d
  (the FinancialStatements CTA recipe). ConceptPicker search focus border
  → brand/50. All raw hsl() literals and hex are gone from the family.

## FAILURES found this round (fix before r2)
1. **Trend badge unit split** — the Chip is a flex row with gap; the
   <Amount> and its unit suffix ("×", "/yr", "pp") are separate flex
   items, so ratio deltas render "-0.0 ×" with a hole. Units must be
   glued to their figure in one span.
2. **Ratio delta precision** — "-0.0×"/"+0.0×" beside a "1.85×" level
   claims less precision than the instrument has. Ratio deltas should
   carry 2 fraction digits like the level.
3. **Dark capture** — the one-off trend script set localStorage only;
   next-themes needs the root class forced (harness recipe). Re-shoot.
