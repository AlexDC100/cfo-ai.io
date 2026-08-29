# THE DIAL — story lane critique, round 1

Lane: STORY DASHBOARD + STATEMENTS + FIRST-UPLOAD (Parts C + E2).
Shots: `story-r1/` (dashboard, 3 viewports x light/dark x simple/pro),
`story-stmts-r2/` (P&L / BS / CF tabs via clicked navigation, simple
collapsed + expanded + pro baseline, 1440 light). Interaction probe:
`story-hint-check.mjs` (trust hint) — all four assertions green.

## What was reviewed

### Story Overview (Simple /dashboard)
- Reading order lands as designed: health gauge (UNCHANGED HeroVerdictCard,
  same verdict sentence + Credit class chip) → How you did → Your cash →
  What you owe → The one thing to watch → Suggested next steps.
- Dual labels via glossary render with the Term dotted underline:
  "Total sales (revenue)", "What's truly left (net profit)", "What you'd
  still owe (net debt)". "Money in the bank (cash)" / "All loans (total
  debt)" are storyStrings copy (no glossary id for plain cash/total debt —
  correct, no dead underline).
- Deterministic context lines all render from served facts: YoY ("6.0%
  more than last year."), profit ("The business made money this period."),
  runway ("~0.8 months of your average costs." — from the P&L builder's
  Total operating expenses subtotal), net-debt meaning + coverage ("Net
  debt equals ~1.5 years of typical earnings."). No AI call anywhere.
- The one thing to watch = top existing recommendation with its own
  payload rationale; severity chip (Critical, alert tone). Next steps
  lists the remaining recommendations with severity chips + "See all
  suggestions" jump.
- Figures: cross-checked against the Pro shot — revenue 295.1 M RON,
  cash 17.7 M RON, net debt 50.2 M RON, profit 9.4 M RON identical in
  both modes (M1 also asserted in vitest with a cent-level fixture).
- Dark theme: tokens hold, no washed panels, chips legible. Mobile 390:
  panels stack, no horizontal overflow.

### Pro /dashboard
- Byte-for-byte the pre-lane overview: KeyMetricsRow (Revenue/EBITDA/
  Cash/Net debt), recommendations, All-metrics disclosure, templates.
  No trust hint, no story panels, no toggles. PASS (rule 3).

### Statements (Simple)
- P&L collapsed: only builder-marked rows remain (Total operating
  revenue, Total operating expenses, EBITDA box, EBIT, Net financial
  result, PBT, Net profit). Toggle "Show all lines" + caption "Key lines
  only — totals and headline rows." Expanded = the untouched full table
  (account chips, red negatives) + "Show key lines only". Key margins
  block stays in both states.
- CF collapsed: section headers + the four totals + full reconciliation
  block; approximation banner (honesty surface) always visible. The
  Term underline shows on "Cash from operating activities". Rules above
  totals keep the accounting anchor without the detail rows.
- BS: demo periods carry no lineItems so the tab renders the demo
  summary table (not BSStatementView) — already totals-first, no toggle,
  correct. The real-period BSStatementView path is covered by
  statementDisclosure.test.tsx (collapse/expand/Term/Pro-untouched, 7
  green) since the demo stack can't reach it.

### Trust hint
- Renders once under the accuracy chip row in Simple, frozen chip
  untouched. Probe: visible → tap opens the accuracy receipt → hint
  unmounts → stays dismissed after reload (guard key
  cfo-trust-hint-seen-v1). Not rendered in Pro.

## Defects found and disposition
1. P&L "Key margins: 0.0% / 0" stray zero — PRE-EXISTING (identical in
   the Pro baseline shot), demo-data canonical margins quirk. Not
   touched (outside lane).
2. Demo CF renders "–" for all amounts — PRE-EXISTING demo behavior,
   identical in Pro baseline.
3. Hint copy ("machine-checked") beside an Unverified chip on demo
   data: kept — the tap lands on the honest receipt ("unknown" band
   copy), and the chip copy itself is frozen. The hint invites
   inspection; it does not assert a verdict.
4. CF collapsed: floating hairline above Cash used in investing —
   inspected at 2x; reads as the total's anchor rule, consistent with
   the expanded rhythm. No change.

### RO register (dashboard--ro--simple.png)
- Full tu-form informal RO with diacritics: "CUM ȚI-A MERS", "Vânzări
  totale (cifra de afaceri)", "Ce rămâne cu adevărat (profit net)",
  "Bani în bancă (numerar)", "Cât ai mai datora (datorie netă)", trust
  hint "Fiecare cifră de aici e verificată automat — apasă ca să vezi
  cum.", context lines "Cu 6,0% mai mult decât anul trecut." / "≈ 0,8
  luni din costurile tale medii.". Figures follow the RO locale
  ("295,1 M RON", gauge "85,5"). Recommendation titles stay EN — they
  are engine payload content, not UI strings (out of lane).

## Cross-lane gate run (M5, gates lane's e2e)
`npx playwright test e2e/design/modes.spec.ts -g "M5" --workers=1`:
- [chromium] (local stack) — BOTH pass: "Simple dashboard carries
  data-testid=story-overview" ✓ and "Pro dashboard keeps the classic
  overview (nothing pro removed)" ✓.
- [prod] (https://cfo-ai.io) — skip + fail as expected: the deployed
  site does not carry this unshipped lane and the session is logged out
  (failure snapshot is the marketing header). Environmental, not a code
  defect; flagged for the gates lane's CI posture.

## Verdict
PASS at r1 for the story dashboard, statements disclosure, trust hint.
First-upload journey not reachable on the live demo stack without a real
scan — covered by unit tests (3-step walk, skip-always-visible, error →
onDone) and gated mount (Simple + !journeySeen + data landed).
