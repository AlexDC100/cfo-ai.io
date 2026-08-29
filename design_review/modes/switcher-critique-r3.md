# THE DIAL Part A — switcher + onboarding, critique r3 (PASS)

Lane: **switcher** (ModeSwitch + first-login role question).
Shots: `design_review/switcher-r1..r3/` — `/dashboard`, `/settings`,
`/onboarding` × 1440/1280/390 × Paper/Terminal.

## r1 — first capture (dashboard + settings)

**Header switcher (both themes, 1440 + 1280).** SIMPLE | PRO rail sits
after the ContextObject — reads as "what you're looking at · how you're
looking at it". 11px mono caps, active segment raised to surface with a
2px brand underline; quiet enough that the ContextObject and the ⌘K bar
still dominate. No crowding at 1280 (search bar keeps full width; right
cluster untouched). Terminal theme: underline reads clearly against the
raised dark segment; no contrast issue. Mobile 390: correctly hidden
(<sm) — drawer/Settings own it there.

**Settings > Appearance.** VIEW MODE block seats under THEME and DENSITY
with the identical 10.5px caps label + 11px hint pattern — scans as one
family. Deliberate mismatch kept: the mode control is the SAME component
as the header (mono caps + underline), not the sentence-case
SegmentedControl — the brief asks for the same control, and the mono
voice marks it as the header control relocated.

**Issues found in r1:**
1. ModeSwitch buttons were h-7 (28px) at every width — fine in the
   header (sm+ only) but an undersized touch target in Settings on
   phones. → fixed: `h-10 sm:h-7`, matching the neighboring
   SegmentedControl's responsive pattern.

## r2 — onboarding added

**/onboarding (both themes, all widths).** Serif question ("What
describes you best?") over three Panel options with icon plates + a
centered quiet Skip. Terminal theme keeps hairline panels, no shadow.
Mobile 390 stacks cleanly, no overflow, descriptions wrap to two lines.
Serif is legitimate here — first-run surface, file allowlisted in
check_design_lint.mjs.

**Issue found in r2:**
2. Subtitle said "switch anytime from the header" — false on phones,
   where the header hides the switcher. → copy now says "from the
   header or Settings" (EN + RO, tu-form).

## r3 — verification

- Onboarding subtitle reads correctly in both languages.
- Settings/onboarding re-captured both themes — no regressions.
- Design lint: 0 violations from this lane's files (the one open
  D10-SHADOW hit is `instrument/ExplainDrawer.tsx:109`, another lane's
  file, pre-existing).
- a11y habits: radiogroup/radio + aria-checked on the switcher;
  aria-label from strings; single interactive element per Panel option;
  focus-visible rings everywhere; no nested-interactive.

**Verdict: PASS.** Switcher is quiet, both-theme clean, persisted;
onboarding is show-once, skippable, and the mode only ever FOLLOWS the
role via lib/viewMode's default chain — no value branches on mode
anywhere in this lane.
