# M-GATES lane — screenshot critique, round 2

Shots: `design_review/modes/m-gates-r2/` — /dashboard + /settings,
simple × pro, light × dark, 1440 + 390. Captured with the entry lane's
mode-aware harness (`design_review/modes/entry-shots.mjs`), which stamps
`cfo-view-mode-v1` via addInitScript so the mode is live at first paint.
Round 1 (`m-gates-r1/`) predates the story + switcher lanes landing; it
captured the pre-dial surfaces and is kept only as the baseline trail.

## What the shots verify (my gates, read against the frames)

**Parity by eyeball, backing the M1 harness.** The same demo period in
both modes shows identical figures everywhere both surfaces render one:
health 85.5/100, revenue 295.1 M RON, net profit 9.4 M RON, cash
17.7 M RON, net debt 50.2 M RON, +6.0% delta chip. No formatting drift
(same magnitude unit, same tabular mono). The machine gate for this is
`modeParityHarness` + the story lane's parity test (see owed items).

**The dial is where the specs assume it is.** `mode-switch` renders in
the TopHeader at 1440 in both themes and again in Settings under
"VIEW MODE" with honest explainer copy ("Same figures in both."). Active
segment reads clearly in both themes (surface chip + brand underline).

**Simple ≠ rearranged Pro.** Simple/dashboard is the story surface
(HOW YOU DID / YOUR CASH / WHAT YOU OWE with dual labels — "Total sales
(revenue)", "Money in the bank (cash)"); Pro/dashboard is the untouched
classic overview (KPI cards, RECOMMENDATIONS, metrics grid, Add metric).
Nothing pro was removed — tab strip, export, trust chips all present in
Pro. Trust copy ("Unverified", "Demo data", "Data accuracy") is
identical in both modes — frozen, as required.

## Findings

1. **[LEAK — story lane owes] Engine-authored jargon flows raw into
   Simple.** "THE ONE THING TO WATCH" renders the recommendation title/
   body verbatim: bare "DSCR", "Debt-EBITDA", "covenant", "capex" on the
   Simple dashboard (light/1440 shot, bottom third). "SUGGESTED NEXT
   STEPS" does it too ("Refinance window: DSCR 1.51×…"). My M3 lint is
   clean because it scans authored strings — this is *runtime data*
   (engine recommendation copy) that no static gate can see. Simple
   needs either a plain-language rewrite path for recommendation cards
   or <Term>-wrapping of known terms in that panel. Filed in GATES.md
   as an owed item, not a gate failure (the gate covers what it claims).
2. **[ADVISORY — story lane] Story panel headings skip a level.** Axe
   flags moderate `heading-order` on /dashboard under Simple only; a
   targeted probe (pro vs simple, heading-order rule alone) confirms
   Pro is clean and the node is `div[data-testid="story-how"] > … > h3`
   ("How you did") — the story panels jump to `<h3>` past the page's
   heading chain. Below the serious/critical gate line, so M6 passes;
   an `h2` (or aria-level fix) in StoryOverview clears it.
3. **[OK, noted] Mobile 390 hides the header switcher.** The dial is
   reachable on phones only via Settings → VIEW MODE. Deliberate
   (header space), and the M5 persistence spec tolerates it (falls back
   to storage with an annotation) — but discoverability on mobile rests
   entirely on Settings. Shell lane's call; flagged, not blocking.
4. **[OK] No design-lint regressions from gate files.** My lane ships
   scripts/tests/docs only; `check_design_lint.mjs` stays at 0/0/0 and
   no serif/hex/shadow could originate here. Mono-caps story panel
   headers ("HOW YOU DID") match the instrument's eyebrow register.

## Verdict

PASS for the m-gates lane deliverables. The one red flag (finding 1)
belongs to the story-dashboard lane and is tracked in GATES.md as owed.
No further shot round needed for gate machinery; next round should be
taken by whoever fixes finding 1, in Simple mode, same routes.
