# PROMPT — CFO AI: One-way-to-do-everything redesign (Apple-calm, top to bottom)

> Paste this whole file as the opening prompt of a fresh Claude Code session
> in this repo. It encodes the operator's directive from 2026-08-04:
> *"stop complicating and duplicating features and drop zones — smooth,
> clear, Apple-like feel, whole redesign improvement from top to bottom,
> too many options duplicated or not working."*

---

## Mission

Make CFO AI feel like one calm, inevitable product. Today it feels like
five products stapled together: the same action exists in three places,
several controls do nothing, and every surface grew its own upload zone.
Your job is to REMOVE and MERGE until there is exactly **one way to do each
thing**, and that one way is excellent on a phone and on a desktop, in
English and in Romanian.

**North star:** a first-time Romanian founder on an iPhone uploads one
balanță de verificare and reads their briefing within two minutes, never
seeing a single choice they don't understand. A returning power user never
hunts for a feature because everything is where it obviously belongs.

## Non-negotiable rules

1. **One entry point per job.** If two controls trigger the same job, keep
   the better-placed one and delete the other. No "also available here".
2. **Nothing ships that doesn't work.** Every visible control must have a
   working, verified backend path — otherwise remove it (git history is the
   archive; no "Coming soon" chips).
3. **Subtraction before addition.** You may not introduce a new component
   while a similar one exists — extend the existing one.
4. **Both languages, always.** Every string through i18n (`en.json` +
   `ro.json`, informal tu-form RO); run the sweep (below) after every phase.
5. **Never break desktop while fixing mobile,** or English while fixing
   Romanian.
6. **Verify like this session did:** typecheck + vitest + the e2e sweep +
   **boot-test `dist/` in a real browser** (`npm run build` succeeding is
   NOT proof — see CLAUDE.md §19 manualChunks hazard) + Playwright walk of
   the changed flows in test mode.

## Known duplication inventory (verified 2026-08-04 — start here)

### A. Upload / drop zones — SIX of them, unify to ONE router
- Dashboard hero dropzone + "Replace or add files" tile (`FinancialStatements.tsx`)
- Products page dropzone (`Products.tsx` + `DatasetSourceFiles`)
- Workspace wizard step-3 dropzone (`Workspace.tsx` `StepUpload`)
- Budget/Variance dropzone + its own template card (`comparison/BudgetUploadCard.tsx`)
- DocsPanel "add file" (`DocsPanel.tsx`)
- Command Center → Data tab upload rows (`command/tabs/`)

**Target:** ONE shared `<SmartDropzone>` + ONE routing brain. The routing
already half-exists: budget decks are intercepted client-side
(`FinancialStatements.tsx onFileChosen`), and trial balances dropped on the
SKU parser are rerouted via the backend's `[TRIAL_BALANCE]` token
(`Workspace.tsx routeTrialBalanceToDashboard`, added 2026-08-04).
Generalize: any file, dropped anywhere, is classified (trial balance /
statutory / SKU workbook / budget deck / invoice) and routed to the right
pipeline with one consistent progress UI (`ScanProgressView`). Then delete
the per-surface dropzones and their duplicated "official template" cards
(`TemplateDownloadCard` and `BudgetTemplateCard` must become one component
with a config).

### B. "Ask CFO AI" — FIVE launchers
Header button, sidebar item, in-page chips, empty-state prompts, plus the
`/chat` page itself. Keep: header button + sidebar item + `/chat`. Delete
scattered chips OR make them plain links — no more floating variants.

### C. Duplicated settings/controls
- Currency: header `CurrencyMenu` AND Settings currency card — keep both
  ONLY if Settings card becomes the same component; today they're two
  implementations (`CurrencyToggle` is now used by nothing but its test —
  delete it and its test, or reuse it in Settings).
- Learning mode: avatar menu (new) — confirm Settings no longer duplicates
  it (`LearningSettingsSection`); one place only.
- Period/month management: sidebar stepper + Workspace "Months" section +
  DocsPanel period list = three surfaces mutating the same thing. Decide:
  Workspace = manage (create/delete), sidebar = switch, DocsPanel = view
  files only. Remove period mutation from anywhere else.

### D. Orphaned / dead / not-working (verified)
- `CommandCenter` (`components/cfo/command/`): its avatar trigger and
  sidebar button were both removed — confirm what still opens it; if
  nothing meaningful, DELETE the whole module (it duplicates Settings +
  Workspace + upload + account).
- `src/engine/api/_dashboard.py`: fully built router never mounted in
  `server.py` — decide: wire it or delete it.
- `PeriodBreadcrumb.tsx`: removed from header 2026-08-04, currently
  unmounted — reuse it in the sidebar or delete it.
- Landing pricing cards hardcode Solo €19.99/Business €59 while
  `/pricing` renders server-driven Starter/Pro (documented mismatch in
  `CurrentPlanCard.tsx` header comment) — the landing MUST render the same
  `PricingTableV2` data or link to /pricing; no fake tiers.
- Decisions/Alerts (`DECISIONS_ALERTS_ENABLED=false`), Inventory/Invoices
  (registry-gated): if there is no near-term plan to ship them, delete the
  routes, sidebar entries and flags.
- Cookie banner promises analytics cookies but no analytics is ever
  loaded — simplify the banner to match reality or wire consent for real.
- Legacy `scandi-desk-main/` tree and duplicate `files/CLAUDE.md`: propose
  archival (do not delete without operator ack).

### E. Data hygiene that pollutes the UI
Corrupt periods (year 5309 / 2050) existed in production; creation-side is
now clamped (`_sane_period_end`, engine) and display-side falls back
(`formatPeriodMonth/Year`). Add a Workspace "Months" affordance that shows
implausible periods as "Corrupt period — delete?" so users can clean up
old rows themselves.

## Design language (Apple-calm, already started — finish it)

- **Chrome:** 56px frosted header (done); ONE primary accent button per
  screen; everything else quiet (`text-ink-soft`, hairline `border-rule`).
- **Type:** Instrument Serif for the one display moment per page; Inter for
  everything else; JetBrains Mono ONLY for small-caps eyebrows/labels and
  tabular figures (`tabular-nums` on every number).
- **Motion:** 150–200ms color/opacity transitions; no decorative continuous
  animations outside the Ask-AI accent; skeletons are abstract shimmer bars
  (see `RouteFallback`), never fake content.
- **Density:** each screen leads with ONE hero statement + at most 4 KPI
  tiles; everything else behind tabs or progressive disclosure. If a
  section needs a paragraph to explain itself, it's too complicated —
  redesign the section, don't write the paragraph.
- **Empty states:** one pattern app-wide (icon, one sentence, one action).
- Reuse tokens from `index.css` / `tailwind.config.ts`; **never** introduce
  hex colors or new fonts.

## Process — four gated phases (get operator ack between phases)

**Phase 1 — Inventory & kill list.** Walk every route at 390px and 1280px
in test mode (recipe below). Produce a table: surface → controls → job →
duplicate-of → verdict (KEEP / MERGE-INTO / DELETE / FIX). Post it as the
phase-1 report and get approval on anything marked DELETE that has data
implications.

**Phase 2 — Deletions & merges.** Execute the approved list. Every merge
lands with its i18n keys, both languages, and a passing sweep.

**Phase 3 — The unified upload.** Build `<SmartDropzone>` + file router;
migrate all six zones; delete the leftovers; E2E-test each file type ends
in the right pipeline (Playwright, test mode).

**Phase 4 — Polish pass.** Apply the design language checklist to every
route; re-run the FULL verification battery; deploy; verify live.

## Verification battery (all must pass before deploy)

```bash
npx tsc --noEmit -p tsconfig.json
npx vitest run                      # only pre-existing failures allowed (chatScope 4, currencyToggle 3, commandCenter 1 — fewer once those modules die)
SWEEP_MODE=public npx playwright test e2e/i18n-mobile-sweep.spec.ts --project=chromium
SWEEP_MODE=authed npx playwright test e2e/i18n-mobile-sweep.spec.ts --project=chromium
npm run build   # then BOOT-TEST dist/ in a real browser (vite preview + Playwright goto, root must render, zero pageerrors)
```

Local authed test mode: engine `PUBLIC_TEST_MODE=1` (source `.env` first) +
`.env.local` with `VITE_PUBLIC_TEST_MODE=1` + `VITE_API_URL=http://127.0.0.1:8000`.
Deploy: `./scripts/deploy.sh --yes`, then
`ssh root@187.124.0.37 "docker exec cfo-ai-backend python3 /app/scripts/measure_bs_drift.py"`
must stay GREEN. Commit + push to GitHub `main` when green.

## Reporting

After each phase: what was deleted (file list + line counts), what was
merged, before/after screenshots at 390px and 1280px in EN and RO, and the
verification battery output. No feature additions anywhere in this work —
if you catch yourself building something new, stop and re-read rule 3.
