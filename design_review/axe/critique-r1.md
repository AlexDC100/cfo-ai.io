# AXE lane — critique r1 (shots: design_review/axe-r1, both themes, 9 routes × 3 viewports)

Scope of the round: drive D1 (axe serious/critical) to zero on all 10 routes,
both themes. The dominant repair was tonal — `text-ink-mute` (#808985, ~3.3-3.5:1
on Paper) was the app's small-text label voice and fails WCAG AA everywhere it
renders below 24px. Since `index.css` is banned for all lanes, the fix is a
per-element lift to `text-ink-soft` on every axe-flagged element (plus identical
same-file siblings), never a token change.

## Hierarchy
- Dashboard (light/dark): the three-step ladder still reads — figure (ink,
  mono) > section caps label (now ink-soft) > hairline chrome. Ink-soft is one
  step darker than the old mute but stays clearly subordinate to values; the
  KPI grid, Financial-health gauge and Recommendations header keep their order.
- Variance (dark): the favorable/unfavorable delta %s lost their `opacity-80`
  de-emphasis and now sit at full success/alert strength. Hierarchy survives
  because the % line is already a size step down (10.5px vs 12px absolute);
  the table does not read louder overall.
- Public-companies: standout chips ("Net margin 45.0% #2 of 30 in group") are
  now full brand-dark end to end; the rank fragment no longer fades. Slightly
  more even than before, acceptable — the chip is still one quiet line.

## Density
Unchanged — every fix was a color/semantic swap, no spacing, sizing or radius
was touched. Grid footprints, card chrome and table rhythm are identical to r0
shots from the shell/dashboard lanes.

## Contrast
- All 20 route×theme combinations scan clean at serious/critical (axe-core via
  @axe-core/playwright, full-node scan, light + dark forced via
  `cfoai_theme`).
- Ink-soft measures ~5.6:1 on Paper bg and ~7:1 on Terminal bg at the sizes in
  play; brand-d measures 5.3-6.1:1 on the brand washes where the PageHeader
  eyebrow sits.
- Deliberate residue: `--ink-mute` itself remains ~3.4:1 (Paper) / ~4.4:1
  (Terminal). Files not on the 10 gated routes still use it for small text and
  will fail the same rule when their surfaces are gated. The durable fix is a
  ~6pp lightness drop on the token — flagged for the token owner; out of this
  lane's write scope.

## Soul
- The quiet-caps-label voice survives: uppercase, tracked, small — just one
  shade firmer. No surface gained decoration, shadow, or serif.
- PageHeader's eyebrow moved from grey to brand-d; it now matches the Sparkles
  mark beside it and reads as intentional brand punctuation rather than a
  faded utility label. Verified on /products, /benchmark, /chat in both themes.
- Red still means imbalance only — the alert deltas on Variance were already
  semantic; removing their opacity strengthened, not spread, the meaning.

## Consistency
- One rule applied everywhere: failing small text on neutral ground → ink-soft;
  failing text on brand wash → brand-d; failing de-emphasis by opacity on a
  semantic color → drop the opacity, keep the size step.
- Interactive-structure fixes follow one pattern in both places that had
  nested-interactive (MetricCard, CompanyCard): plain-div wrapper + stretched
  sibling `<button>` at z-0 carrying the aria-label, corner controls lifted to
  z-10/z-[1]. Keyboard order and click behavior verified (concept sheet opens,
  tile navigates, compare/ⓘ still clickable).
- ComingSoon gained `inert` alongside `aria-hidden` so the blurred teaser can
  never be tabbed into — visually identical.

## Verdict
Ship. Zero serious/critical on all 10 routes in both themes; official
axe/keyboard/context-object suites green (21/21, chromium). No follow-up round
needed for D1; the ink-mute token itself is the one systemic item left, and it
belongs to the token lane.
