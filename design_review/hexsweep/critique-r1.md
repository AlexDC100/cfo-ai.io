# HEX + SHADOW SWEEP — critique r1 (2026-08-29)

Shots: `design_review/hexsweep-r1/` (/login /alerts /decisions /dashboard /, both
themes × 1440/1280/390) and `design_review/hexsweep-r1b/` (/roadmap
/contact-sales /financials). Note: in the test-mode stack, /, /login, /alerts
and /decisions all boot the session and land on the financial-analysis surface
(alerts/decisions are flag-gated redirects), so those shots double as the
shared-chrome spot-check the lane requires.

## Hierarchy
- Dashboard (Paper + Terminal): unchanged — health score, KPI row,
  recommendations, metric grid all read in the same order as before the sweep.
  My edits here were invisible-by-design (banners/drawers that only render in
  specific states), and the resting page confirms zero collateral movement.
- Roadmap: status chips (IN DESIGN / RESEARCH / PLANNING) now sit in the brand
  family — tinted fill, dark-teal text — while BACKLOG stays neutral grey. The
  eye goes title → chip → target line, which is the right order for a scanning
  reader; the retune did not promote the chips above the titles.

## Density
- No spacing was touched anywhere in the sweep (color-only + escape comments),
  and the shots confirm identical layout metrics against the pre-sweep pages.

## Contrast
- Roadmap chips: dark-teal-on-tint clears AA at 10px uppercase; verified
  legible at 1440 and 390.
- Terminal dashboard: no hex remained on this surface, everything flows through
  tokens; the phosphor accent and semantic tints all render from the .dark
  block. Checked the RON pill dot at top right — that is CurrencyMenu's own
  token-driven dot, not the CurrencyToggle stale dot I recolored (that one only
  appears on the offline-rates fallback).
- Retuned banners now speak the semantic language: TestModeBanner and
  UsageWarningBanner went from "loud retired teal" to caution amber — a
  warning finally looks like a warning, and red stays reserved for
  imbalance/danger (RiskInventory critical rows, Alerts critical tone).

## Soul
- The retired #5CD3C5 family is gone from every surface this lane owns; what
  replaced it is the calm Paper accent (#0E7C6B family) via tokens, so both
  themes retune from one source. The Google G in AuthCard is now a monotone
  brand-family mark instead of a three-teal-plus-Google-red hybrid — red no
  longer appears in a non-danger context.
- Generated standalone documents (financialReport, stagedFilePreview,
  previewChrome, BudgetUploadCard, FinancialStatements previews) were retuned
  to the Paper/Terminal literals so a preview tab no longer opens in the old
  bright-teal brand; each literal carries a design-lint-allow-hex escape with
  the reason (document.write tabs cannot read app CSS vars).

## Consistency
- One mapping applied everywhere: #E6F7F4→brand-tint, #1B7268→brand-d (dark:
  brand-l), #2AA89B→brand, #8FE3D9→brand-l, #c62828→alert, greys→ink-mute/
  ink-soft/bg-2. Severity ramps (Alerts, Decisions, RiskInventory,
  publicCompanyIntelligence) share critical=alert / high+medium=brand-family;
  quota meters (AccountMenu, AccountTab, UsageThisMonth) share
  exhausted=caution.
- All 15 flagged resting shadows turned out to be genuinely floating layers
  (slide-overs, dropdown menus, modal dialogs, Sheet drawers, a cursor
  tooltip, the chat search pill); they were added to the lint's floating-layer
  allowlist with a one-line justification each instead of being stripped —
  no resting card kept a shadow.

## Verdict
- Lint: my lane's files contribute 0 hex and 0 shadow violations (repo
  remainder: products/* + ComprehensiveReport, owned by other lanes; serif is
  other lanes' in-flight work).
- tsc clean; vitest failures limited to the three known pre-existing suites
  (currencyToggle, chatScope, commandCenterMenu).
- No further visual round needed: r1 shows no regressions and the retuned
  surfaces (roadmap chips) land correctly. Done at r1.
