# Landing global line — critique r1

Lane: LANDING GLOBAL LINE (Mission-13 Part C deferred item, built under Prompt 12).
Files: `frontend/pages/cfo/Landing.tsx`, `frontend/pages/cfo/landingStrings.ts`.
Shots: `design_review/landing-global-r1/` — home full-page (desktop-1440 /
laptop-1280 / mobile-390 × light+dark) + strip close-ups (desktop/mobile × EN/RO).

## What was checked

**Copy (G3 phrasing discipline).** EN and RO lines are character-exact against
the directive: "Romania at deterministic grade. Any other country accepted —
structure read by AI, numbers machine-verified twice." / "România la nivel
determinist. Orice altă țară acceptată — structura citită de AI, cifrele
verificate mecanic de două ori." Verbs are "accepted" / "machine-verified";
no "supported / certified / guaranteed" anywhere near a global claim.
`node scripts/check_global_positioning.mjs` → PASS (G2 + G3).

**Marquee row (G4).** Rendered straight from `lib/markets.ts` `MARQUEE` — the
order cannot drift from the taxonomy: United States · Germany · United Kingdom ·
France · Italy · Spain · UAE. Hungary absent from the row (confirmed in both
EN and RO strip shots). RO shot renders localized names (Statele Unite …
Emiratele Arabe Unite) in the same order.

**Quiet styling / no country singled out.** Every name in identical mono caps
(10.5px, .18em tracking, `--ink-mute`), middot separators at `--rule-strong`,
`aria-hidden` on the separators. No flags, no color accents, no weight change
on any single market. The strip sits under the hero mock behind a hairline
`--rule-soft` top border, max-width 820px — it reads as a colophon, not a
second headline.

**Hero contrast over the ticker.** The strip lands in the lower hero band where
the ticker layer is capped at .55 opacity under the readability overlays. The
sentence at `--ink-soft` (#ABABAB on ~#080D0B) ≈ 6.9:1; the mono row at
`--ink-mute` (#8C8C8C) ≈ 5.5:1 — both clear AA at their sizes. In the desktop
shots the residual ticker digits behind the strip are dim enough that the line
stays unambiguously dominant; no glyph collision observed at 1440 or 1280.
The hero headline itself is unaffected (strip is below the mock, not behind
the display type).

**Responsive.** Mobile-390 RO (worst case — longest names) wraps to three
balanced lines via flex-wrap with 14px/8px gaps; baseline alignment holds.
Accepted nit: a middot can land at a line end on wrap (standard behavior for
inline-separated lists; attaching separators to neighbors would instead start
lines with an orphan dot — worse).

**Serif voice / ticker untouched.** No changes to the hero display type, the
ticker board, or any existing landing section; the strip is additive markup
inside `homeMain` only.

## Gates

- `check_global_positioning.mjs` — PASS
- `check_design_lint.mjs` — PASS (0 hex / 0 shadow / 0 serif violations added;
  landing palette hexes carry the pre-existing scoped `design-lint-allow-hex`)
- `npx tsc --noEmit` — clean
- `npx vitest run frontend/pages/cfo/__tests__` — 6/6 pass (known failing trio
  not in scope)

## Verdict

**PASS at r1.** No iteration required.
