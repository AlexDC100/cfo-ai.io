# THE DIAL — entry-points lane critique, round 2 (PASS)

Lane: mode-aware entry points (Part E, minus first-upload).
Routes: `/chat`, `/dashboard/scenarios` · themes: light+dark · modes: simple+pro
· viewports: desktop-1440, mobile-390. Shots: `design_review/modes/entry-r2/`
(taken with `entry-shots.mjs`, which stamps `cfo-view-mode-v1` via
`addInitScript` so the mode is read on first paint).

## Round 1 → round 2

r1 captured both modes on both routes but had no shot of the Simple results
table EXPANDED — the "Show all rows" state was untested visually. r2 adds
`dashboard-scenarios--*--simple-expanded.png` (toggle clicked before capture).
No code changed between rounds; r2 is a coverage fix on the harness.

## /chat — verdict PASS

- **Simple (light+dark, desktop)**: the three mandate questions lead — "Can I
  afford to hire?" / "Why is profit lower than last year?" / "Do I have a cash
  problem?" — then bills / take money out / worry / worth / bank loan. Cards
  use the same DocGuideCard pattern as Pro (3px brand left rule, icon + title,
  hairline divider, muted prompt body). No layout drift between modes: the
  grid, card chrome, and type scale are identical; only strings and icons
  change.
- **Pro (light+dark, desktop)**: byte-identical legacy set — Biggest financial
  risk / Cash flow position / Summarize latest P&L / Working-capital change /
  Calculate DSCR / Year-over-year / Leverage position / Liquidity questions.
  Nothing removed, nothing reworded.
- **Trust copy frozen**: "Grounded in Meridian Industries SRL" pill, the
  general-questions disclaimer line, and the "No workspace selected — affects
  answers" chip render identically in both modes.
- **Mobile 390**: 2-up grid holds; the composer overlay covers the lower cards
  at rest exactly as it does in Pro (pre-existing overlay design, not a mode
  regression — the list scrolls under it).

## /dashboard/scenarios — verdict PASS

- **Template cards, Simple**: question leads ("What if sales drop 20%?" /
  "What if we grow 25%?" / "What if we cut costs 15%?" / "How far can sales
  fall before the bank worries?"), Pro label survives as the subtitle
  (Recession scenario / Aggressive growth / Cost optimization / Covenant
  stress test). The `sm:min-h-[34px]` title-row reservation keeps all four
  subtitles on one baseline even though only the covenant question wraps to
  two lines — verified in both themes.
- **Template cards, Pro**: unchanged pre-modes rendering — template name +
  full description, `line-clamp-3`.
- **Results table, Simple collapsed**: exactly the headline group (Revenue,
  EBITDA, Net profit, Cash, Total debt) + "Show all rows (6 more)" toggle,
  chevron-down, quiet ink-soft styling on a hairline top rule — reads as
  table chrome, not a competing action.
- **Results table, Simple expanded**: RATIOS & LEVERAGE group appears with
  values character-identical to Pro (EBITDA margin 11.2%, Net margin 3.2%,
  Net debt / EBITDA 1.52×, Current ratio 1.85×, Debt/equity 0.50×, ROE 7.0%);
  toggle flips to "Show fewer rows", chevron-up.
- **Results table, Pro**: all 11 rows, no toggle anywhere.
- **Gate M1 on-screen**: headline figures match across all three states
  (295.1 M / 33.0 M / 9.4 M / 17.7 M / 67.9 M) — same accessors, same Amount
  group scale computed over ALL rows in both modes, so collapsing cannot
  change a rendered string. Also asserted cent-identical in
  `scenarios/__tests__/scenarioModes.test.tsx` (gate M1 test).
- **Trust copy frozen**: "Actuals never change" chip and the three covenant
  Pass chips identical in both modes and both themes.
- **Mobile 390**: cards stack single-column, question + subtitle intact; no
  horizontal overflow.

## Gates at time of critique

- `npx tsc --noEmit` — clean.
- `npx vitest run` (chat + scenarios + lib/scenarios + lib/__tests__) —
  294 passed; only `chatScope.test.ts` fails, part of the known pre-existing
  trio (currencyToggle/chatScope/commandCenterMenu) outside this lane.
- `node scripts/check_design_lint.mjs` — PASS (0 hex, 0 shadow, 0 serif).

No further iteration required — round 2 passes.
