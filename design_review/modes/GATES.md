# THE DIAL — M-gates status (Part F, m-gates lane)

Last verified: 2026-08-29, live test-mode stack (vite :5173 + engine
:8000 PUBLIC_TEST_MODE), commit tree on top of ef1ce04.

The dial is verifiable through five machine gates plus a screenshot
critique trail. Every gate below names its runner, so any lane can
re-run it in isolation. npm shortcuts: `modes:jargon`, `modes:parity`,
`modes:e2e` (package.json).

## The table

| Gate | What it proves | Runner | Status |
|---|---|---|---|
| M1 — parity harness | Same fixture rendered in Simple AND Pro yields string-identical figures; a one-cent drift fails | `npx vitest run frontend/lib/__tests__/modeParityHarness.test.tsx` | PASS (7/7) — harness proven; story lane's own parity test still owed (below) |
| M2 — glossary coverage | All 20 entries carry EN+RO term/simple/plain; Simple labels are plain-first, not the bare term | `frontend/lib/__tests__/viewModes.test.ts` (with M5 default-routing pure half) | PASS (8/8) |
| M3 — jargon lint | No bare EBITDA/DSCR/DSO/DPO/DIO/covenant/leverage/CAPEX/YoY/LTM/NAV/WACC in Simple-namespace strings (dual-label `(TERM)` form allowed; `.pro` keys exempt); advisory 140-char sentence smoke | `node scripts/check_simple_jargon.mjs` | PASS — 13 files in scope, 0 jargon, 0 readability flags |
| M4 — explain templates | AI-dead deterministic fallback (story lane's gate; listed for the full picture) | `frontend/components/cfo/simple/__tests__/explainM4.test.tsx` + `frontend/lib/__tests__/explain.test.ts` | PASS (owned by story lane) |
| M5 — dial e2e | Mode persists across reload via the UI switcher; all 9 authed routes render in BOTH modes with zero console errors; Simple dashboard = `story-overview`, Pro = classic `tabs-list`/`tab-overview` with no story leak | `npx playwright test e2e/design/modes.spec.ts` (tests 1–21) | PASS 21/21, 0 skips — switcher visible and used (no storage fallback), `story-overview` present in Simple, absent in Pro |
| M6 — D-gates under Simple | Axe serious/critical clean on all 10 routes × light+dark with mode pinned to Simple; keyboard focus ring + ⌘K palette; context object visible + no raw UUID on any authed route | same spec, tests 22–52 | PASS 31/31, 0 skips — palette opened on ⌘K, no visible UUIDs; advisories below the gate line listed under owed item 5 |

Full suite: **52 passed (8.0m)**, exit 0, 2026-08-29 against the live
test-mode stack.
| Design lint | 0 hex / 0 shadow / 0 serif from any dial file | `node scripts/check_design_lint.mjs` | PASS (0/0/0) |
| Typecheck | whole tree | `npx tsc --noEmit` | PASS |
| Critique loop | shots read + written verdict | `design_review/modes/m-gates-critique-r2.md` (shots in `m-gates-r2/`) | PASS — 1 cross-lane finding filed |

Full vitest sweep (honesty check): 49/52 files pass. The 3 failing
files are exactly the pre-existing known trio — `chatScope` (4),
`currencyToggle` (3), `commandCenterMenu` (1) — untouched by any dial
lane and failing identically before this work.

## Violations other lanes still owe

1. **[story lane — HIGH] Runtime jargon leaks into Simple.** The Simple
   dashboard's "THE ONE THING TO WATCH" and "SUGGESTED NEXT STEPS"
   panels render engine recommendation copy verbatim: bare "DSCR",
   "Debt-EBITDA", "covenant", "capex" on a surface whose whole promise
   is no unexplained trade shorthand (see
   `m-gates-r2/dashboard--desktop-1440--light--simple.png`). M3 cannot
   see this — it lints authored strings, and this text arrives as data
   at runtime. Fix options: plain-language rewrite path for
   recommendation cards in Simple, or <Term>-wrap known terms in those
   panels. Until then M3's "clean" describes authored copy only.
2. **[story lane — MEDIUM] The M1 parity test itself.** Only the
   harness's own smoke test imports `renderBothModes` /
   `expectParityBySelector` (verified by grep). The story lane owns the
   real test: render the dashboard fixture both ways and assert parity
   on the shared figure testids. The machinery is proven and waiting at
   `frontend/lib/__tests__/modeParityHarness.tsx`.
3. **[unowned / pre-existing] The failing vitest trio** (chatScope,
   currencyToggle, commandCenterMenu) predates the dial and stays red.
4. **[shell lane — LOW, flagged not blocking] Mobile switcher
   discoverability.** At 390px the header hides `mode-switch`; the only
   phone path to the dial is Settings → VIEW MODE. Deliberate, but
   worth a think once real users hit it.
5. **[advisory — mixed ownership] Axe moderate `heading-order` under
   Simple** on /dashboard, /products, /dashboard/scenarios,
   /dashboard/variance and / (both themes; below the serious/critical
   gate line, so M6 passes). Attribution probe (pro vs simple,
   heading-order rule only, /dashboard): **Pro is clean; the Simple
   node is `[data-testid="story-how"] > … > h3` ("How you did")** — the
   story panels skip a heading level, so the /dashboard instance is
   story-lane-caused; an `h2` or `aria-level` in StoryOverview clears
   it. The other four routes were not individually probed and may be
   pre-existing structure.

## Re-run recipe

```
# stack: engine :8000 in PUBLIC_TEST_MODE + vite :5173
npm run modes:jargon
npm run modes:parity
npx tsc --noEmit
npm run design:lint
npm run modes:e2e          # 52 tests, ~9 min at 1 worker
node design_review/modes/entry-shots.mjs --label m-gates-rN \
  --routes /dashboard,/settings --theme both --mode both
```
