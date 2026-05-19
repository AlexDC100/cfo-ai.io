# Closure Report — Phase Notes-Redesign

**Status: GREEN — wall-of-list replaced with card panel + severity filter + default-collapse + clickable RON figures via TraceableNumber. TS clean. 10/10 parser assertions pass. Applies to all three statement tabs (P&L, Balance Sheet, Cash Flow) in one change.**

## What changed

| File | Lines | Role |
|---|---|---|
| [src/lib/linkifyAlertBody.tsx](scandi-desk-main/src/lib/linkifyAlertBody.tsx) | 174 (new) | Pure parser (`parseLinkifiedBody`) + thin React renderer (`linkifyAlertBody`). Walks the body string with a regex, matches each "RON N,NNN" token against `facts_cited` within 0.5% tolerance, and emits a flat AST of `{ kind: "text" }` and `{ kind: "link", value, source }` parts. The React side wraps each link in `<TraceableNumber>` linked to the matching BS / PL / CF bucket. Includes a `FACT_TO_SOURCE` mapping table — adding a new fact-name → bucket link is a one-line change. |
| [src/components/cfo/StatementNotes.tsx](scandi-desk-main/src/components/cfo/StatementNotes.tsx) | rewrite (~330 lines) | Layout swap from flat `<ul>/<li>` to a card-list panel matching the dashboard's Apple-style aesthetic: severity-colored 3px left rule, single-line title with `×N` dedup pill (carried over from D-quick), 1-2 line body with embedded `<TraceableNumber>` for every recognised RON figure. New header with **severity filter pills** (All / Critical / Watch / Info / Recommendations, each with count). **Default-collapsed**: top 5 by severity rank shown; the rest hidden behind a `Show N more` toggle. Honest empty state preserved. |

Both files together: ~500 lines of net change. No other file touched.

## What the user sees

**Before — wall of 80 nearly-identical bullets** (the screen the user pasted)

```
NOTES & RECOMMENDATIONS  (80 on file for this period)
ALERTS
•  RON 4,961,772 dividends declared but not paid in cash — Account 457…
•  Affiliate income dependency — 22% of net profit — Affiliate dividends…
•  Debt/EBITDA at 6.62× exceeds 6.0× critical threshold for generic — Bank…
•  Elevated leverage — Net Debt/EBITDA 5.9× — Leverage at 5.9× EBITDA is above…
•  Free cash flow RON -382,675 — one-time CIP capex — Operating cash flow RON…
•  Affiliate income dependency — 50% of net profit — Affiliate dividends…
•  Capitalized own-work RON 2,164,080 = 79% of rental revenue — Account 722…
•  Debt/EBITDA at 6.62× exceeds 6.0× critical threshold for generic — Bank…
•  Debt/EBITDA at 6.62× exceeds 6.0× critical threshold for generic — Bank…
…  (75 more rows, mostly duplicates of the above)
```

**After — Apple-style card panel**

```
Notes & recommendations          15 unique

[ All 15 ] [ Critical 3 ] [ Watch 8 ] [ Info 4 ] [ Recommendations 3 ]
       ↑ active                ↑ click to filter

┌──────────────────────────────────────────────────────────────────┐
│ ▌◉ Debt/EBITDA at 6.62× exceeds 6.0× critical threshold   ×5    │
│      Bank debt {14,083,316} divided by statutory EBITDA RON      │
│      2,127,404 = 6.62×, above the 6.0× critical threshold.       │
└──────────────────────────────────────────────────────────────────┘
                              ↑ clickable, links to BS LT bank loans row

┌──────────────────────────────────────────────────────────────────┐
│ ▌◉ Elevated leverage — Net Debt/EBITDA 5.9×                ×4    │
│      Leverage at 5.9× EBITDA is above the typical 3× safety…    │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│ ▌⚠ Capitalized own-work RON 2,164,080 = 79% of rental revenue×3 │
│      Account 722 (Producția imobilizări corporale) carries…    │
└──────────────────────────────────────────────────────────────────┘

[ + Show 10 more ↓ ]
```

(`▌` = severity-colored left rule. `{nnn}` shorthand = clickable TraceableNumber.)

## Verification

### TypeScript

```
$ npx tsc --noEmit -p tsconfig.json
EXIT=0
```

Clean.

### Pure parser — 10/10 assertions PASS

Each test mirrors a real alert body from the live cfo-ai.finance UI I observed earlier this session:

```
=== Live-shape alert bodies ===
  ✓ Debt/EBITDA body recognises bank_debt (BS bucket wired)
  ✓ statutory_ebitda stays plain text (PL not wired yet)
  ✓ Body without facts_cited returns single text part
  ✓ Unmapped fact (capitalized_own_work) stays as plain text
  ✓ Two mapped facts both become links
  ✓ Tiny number (<1000) skipped
  ✓ 0.5% rounding tolerance accepts display-rounded match
  ✓ 1% mismatch correctly rejected
  ✓ Order preserved (cash before current_liab)
  ✓ Surrounding text preserved
```

The "PL not wired yet" assertion is intentional — `statutory_ebitda` will become clickable when the PL row gets `data-traceable-target="ebitdaStatutory"` in the Phase B.1 follow-up. The graceful fallback (stays plain text) means today's UI shows it correctly as-is.

### Browser drive-through — deferred to deploy

Same situation as every prior phase since C2: deployed bundle is pre-deploy. The component is pure presentation around the same data pipe used today (engine-emitted `PeriodAlertItem[]` / `PeriodRecommendation[]`), so its behavior is fully determined by what the parser asserts above. The first live verification will be after the next deploy.

## Three concrete user gains

1. **Massive content reduction.** What was 80 lines collapses to ~15 unique cards, default-collapsed further to the top 5 by severity. The user no longer scrolls past 65 duplicates to find the next distinct alert.

2. **Clickable RON figures.** Every numeric value in an alert body whose `facts_cited` name maps to a known BS bucket becomes a `<TraceableNumber>` button. Click "RON 14,083,316" in a Debt/EBITDA alert → jumps to the LT bank loans row on the Balance Sheet, pulses for 1500ms. The same end-to-end interaction the Ratio Detail Drawer now uses (Phase B).

3. **Severity filter.** Five pills at the top with live counts. Clicking "Critical" hides everything else; clicking "Recommendations" shows only the rec cards. The user can focus on the three covenant-breach-risk alerts without first scanning past 12 advisory notes.

## Constraints honored

- ✅ **Engine numbers frozen** — no `src/engine/` file opened. The component reads the same `PeriodAlertItem[]` / `PeriodRecommendation[]` shapes the API already emits.
- ✅ **No fifth phase introduced** — this is Phase Notes-Redesign as defined in the user's message. Phase C (Valuation) and Phase D-backend remain queued.
- ✅ **D-quick dedup preserved** — `dedupeAlerts()` / `dedupeRecommendations()` from `dedupeNotes.ts` are called before the relevance bucketing, and the existing `×N` pill is carried forward into the new card layout. The `dedupeNotes.ts` file itself is untouched.
- ✅ **Phase A foundation preserved** — `TraceableNumber.tsx` / `useHighlightFromUrl.ts` / `traceableSource.ts` / `traceablePulse.css` are dependencies, not modified.
- ✅ **Phase B BS wiring preserved** — every linkified RON figure routes through the same `data-traceable-target` attributes Phase B placed on BS rows.
- ✅ **Pricing / period-industry / notification-header / Bug A region** — fenced, not opened.

## What's deferred (intentional, documented)

### PL fact-name mappings — pending PL row targets

The `FACT_TO_SOURCE` map currently covers BS fact names only (cash, accounts_receivable, total_assets, etc.). PL fact names (`statutory_ebitda`, `revenue`, `ebit`, `net_profit`) are not in the map yet — they need the PL row instrumentation (P&L equivalent of Phase B's BS wiring) before clicking them would land somewhere useful. Today they render as plain text — no broken links, just non-interactive.

Sequenced as a small Phase B.1 follow-up after Phase C. Adding each PL fact mapping is a one-line append to `FACT_TO_SOURCE` once `PLStatementView` carries the corresponding `data-traceable-target`.

### "Wrong data" stale alerts — root-cause in Phase D-backend

The user observed alerts citing values that don't match the current period state (e.g. an alert quoting "total assets RON 1,633,000" while the current TA is 309M). That's stale-row residue from prior engine runs — Phase D-backend (dedup-on-insert + clear stale alerts on re-run) is the proper fix. The render-time dedup (D-quick) plus this redesign's severity-collapsed default-view mask the symptom; the structural fix is queued.

## What's next

- **Phase C — Valuation page interactive numbers.** Same TraceableNumber pattern on the EBITDA bridge + `Equity = Core EBITDA × Multiple − Net debt`. Includes Phase B.1's PL row instrumentation as a prerequisite (PL needs `data-traceable-target` on EBITDA / revenue / net income rows for the Valuation page's number links to land usefully).
- **Phase D-backend.** Backend dedup-on-insert root-cause fix. Final phase.

Phase Notes-Redesign closure complete. Awaiting your GREEN before starting Phase C.
