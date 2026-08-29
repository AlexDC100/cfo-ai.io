# THE INSTRUMENT — design gates (CI)

The design identity is enforced by machines, not memory. This document is the
index of every gate, how to run it, what it asserts, and the honest state of
the codebase against it at the time the gates landed (2026-08-29, migration
lanes still in flight — counts below are a snapshot, not a verdict).

## How to run

| Command | What runs |
|---|---|
| `npm run design:gates` | D2 contrast matrix + D5/D10 style lint (one exit code) |
| `npm run design:lint` | D5/D10 style lint alone |
| `npx playwright test e2e/design` | D1 axe + D11 context object + D6 keyboard (needs the test-mode stack: vite :5173, engine :8000 PUBLIC_TEST_MODE) |
| `npx vitest run frontend/lib/__tests__/designGateRawError.test.ts` | D8 raw-error zero |

## The gates

### D2 — contrast matrix (`scripts/design_gates.mjs`)
Parses the `:root` / `.dark` HSL tokens straight out of `frontend/index.css`
(var() chains resolved), computes WCAG ratios for every pair that carries
text, prints the full matrix, exits 1 under threshold. Numbers are ink, so
the numeric-data pairs (`ink` on `bg` / `surface`, both themes) are held to
AAA 7.0; text pairs to AA 4.5; `ink-mute` is documented label/large-only and
held to 3.0. Chip tones from `components/instrument/Panel.tsx` are included
for both themes (accent chip = `brand-d`/tint on Paper, `brand-l`/tint on
Terminal).

**State: FAIL — 1 of 36 pairs.** `dark --alert on --alert-tint = 4.41`
(needs 4.5). Everything else passes, most pairs with wide margin (ink/bg
18.4 light, 16.6 dark). Fix belongs to the token-sheet owner —
`frontend/index.css` is shared-banned for this lane. Either lift dark
`--alert` L 58%→60% or drop `--alert-tint` L 13%→12%.

### D5 — no raw hex (`scripts/check_design_lint.mjs`)
Hex color literals outside the token sheet. Allowlist (commented per entry in
the script): `index.css`, `styles/marketing-tokens.css`, `styles/eeiBoard.css`,
`theme/tokens.ts`, `theme/theme.ts` (the documented canvas/SVG/email escape
hatch — NOTE it still carries the retired `#5CD3C5` teal and needs a
migration-lane retheme), config files, test files, and a per-line
`design-lint-allow-hex` escape comment.

**State: FAIL — ~374 violations** (count moves as migration lanes land).
Largest owners: `pages/cfo/Landing.tsx` (33 — self-contained HTML-in-string
marketing page; coordinator may bless with escape comments),
`lib/financialReport.ts` (25) + `lib/stagedFilePreview.ts` (9) — both
generate standalone HTML exports that cannot read CSS vars and are honest
escape-comment candidates; `PeerComparisonReport` (23), `Products` (18),
`BenchmarkReport` (16), `MultiYearHistory` (14), `FinancialStatements` (11),
plus a long tail of old-teal (`#5CD3C5`/`#2AA89B`) literals in cfo components.

### D10 — resting shadows + serif (`scripts/check_design_lint.mjs`)
- Shadow: `shadow-lg|xl|2xl|3|4` (any variant prefix, `hover:` included)
  outside the floating-layer allowlist (`ui/dialog|alert-dialog|popover|
  dropdown-menu|tooltip|sheet|toast|toaster|sonner`, `CommandCenter`,
  `SearchDialog`, `instrument/shell/*`, `instrument/Amount.tsx` +
  `instrument/Term.tsx` — both shadows sit on floating tooltips).
  **State: FAIL — 16.** Several are drawers/dialogs implemented ad hoc
  (`SkuDetailDrawer`, `UploadDialog`, `MetricGlossaryDrawer`,
  `StockDetailDrawer`, `CFOChatPanel`, `DocsPanel`, `DatasetsPanel`,
  `DocumentSwitcher`, `IndustryPicker`, `LastYearSourcePicker`,
  `MetricInfoTip`, `DocumentChip`, `GeographicMapPanel`) — coordinator
  call: migrate them onto the ui/ primitives (inherit the allowlisted
  shadow) or extend the allowlist per file. `Pricing.tsx:231 hover:shadow-3`
  is marketing; the spec gave shadows no marketing exemption, flagged as-is.
- Serif: `font-serif` under `pages/cfo/` + `components/cfo/` except
  marketing (`Landing`, `Pricing`, `RoadmapPage`, `ContactSalesPage`,
  `landingStrings`) and designated empty states (`chat/CFOEmptyState.tsx`,
  `RouteErrorBoundary.tsx`).
  **State: FAIL — ~98 and falling** as the migration lanes strip serif from
  authed screens. Confirmed on-screen (gates-r1 shots): the dashboard
  metrics grid still renders serif "mil. RON" numerals.
  Scope note: the lint targets `font-serif` exactly as briefed; the serif
  utility classes (`num-hero`, `hero-number`, `section-hero`) appear in 7
  more files and are NOT linted — extend `SERIF_RE` once the coordinator
  confirms those classes are also retired from authed screens.

### D1 — axe (`e2e/design/axe.spec.ts`)
`@axe-core/playwright` on `/dashboard /chat /products /public-companies
/dashboard/scenarios /dashboard/variance /benchmark /settings /workspace /`,
test-mode banner dismissed and excluded; fails on serious/critical, prints
moderate/minor as advisory.

**State: FAIL — 10/10 routes.**
- `color-contrast [serious]` on ALL routes. Recurring offenders: sidebar
  group labels (9.5px uppercase in an ink-faint tone — confirmed visually),
  `.hover:text-brand` links, assorted 10.5px eyebrows.
- `/dashboard`: `nested-interactive [serious]` — KPI metric cards are
  `role="button"` wrapping a real `<button data-testid="metric-info-*">`.
- `/settings`: `label [critical]` — `input[value="test@cfo-ai.io"]` has no
  label.
- `/dashboard/variance`: `aria-hidden-focus [serious]`.
- Advisory: `heading-order` (/products, /dashboard/variance),
  `page-has-heading-one` (/benchmark).

### D11 — context object (`e2e/design/context-object.spec.ts`)
Probes every authed route for `data-testid="context-object"` (the shell
lane's workspace·period switcher — it shipped in
`instrument/shell/ContextObject.tsx`, mounted via `TopHeader`); asserts it
visible when present, and always asserts the unambiguous half of D11: no
visible UUID fragment (`/[0-9a-f]{8}-[0-9a-f]{4}/i`) in page text.

**State: PASS — 9/9 routes.**

### D6 — keyboard (`e2e/design/keyboard.spec.ts`)
On `/dashboard`: the first five Tab stops must show a visible focus
indicator (outline or box-shadow — the token sheet's `--ring-focus`), and
⌘K must open the command palette (`[role="dialog"]` / `[cmdk-root]`), Escape
must close it. Skips-with-annotation if no palette exists at run time.

**State: PASS.** Tab head: Ask CFO AI → Settings → theme toggle → collapse
sidebar → reload, all ringed. Palette opens on ⌘K and closes on Escape.

### D8 — raw-error zero (`frontend/lib/__tests__/designGateRawError.test.ts`)
Drives a realistic AI 400 body (braces + `request_id` + provider slug)
through every export of `frontend/lib/aiDegraded` and asserts nothing raw
reaches user copy.

**State: DORMANT.** `frontend/lib/aiDegraded` had not landed when the gate
was written; the suite is `skipIf(module missing)` with an always-on
tripwire test that warns in every vitest run. It arms itself automatically
on the module's first appearance; if its API defies the generic probes, the
test fails loudly with instructions to bind it to the real signature.

### D3/D7 — Lighthouse + bundle budget
**Not implemented** — deliberately. Neither is quick against this stack: a
meaningful Lighthouse number needs a prod build served with compression (the
dev server's unbundled output scores junk), and a bundle budget needs an
agreed baseline per chunk (the repo already has `scripts/check_perf_budget.py`
on the Python side). Recommend wiring both to `dist/` in a follow-up once the
migration settles; the npm script slot (`design:gates`) is where they chain.

## Known in-flight noise
- Counts in this file are a snapshot; migration lanes were actively landing
  during the runs (hex went 419→374 between two executions).
- Pre-existing vitest failures (currencyToggle, chatScope, commandCenterMenu
  ×8) are unrelated to the gates. One additional failure observed during the
  wave, NOT caused by this lane and not on the known list:
  `frontend/lib/__tests__/bsAiLaneUi.test.tsx` (JurisdictionSelect option
  labels drifted) — flagged for whoever owns the AI-lane UI.
