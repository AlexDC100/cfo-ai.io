# THE DIAL Part D — Explain Anything, critique r1 (PASS)

Lane: **explain** (ExplainDrawer + lib/explain + ExplainButton kit; wired
into BenchmarkReport + Scenarios results panels).
Shots: `design_review/explain-r1/` — `/benchmark`, `/dashboard/scenarios`
× 1440/1280/390 × Paper/Terminal (12 route shots), plus 4 drawer-state
captures at 1440 driven by `scripts/tmp_explain_drawer_shots.mjs` (a
tiny playwright driver: sets Simple mode, activates the Recession
template so the results column exists, clicks the Explain pill, waits
for the drawer to settle, captures both themes — button-visible and
drawer-open frames).

## What the shots show

**Explain pill (`scenarios-explain-button--{light,dark}.png`).** With a
scenario active, a single quiet pill (sparkles + "Explain", 28px,
rule-bordered, surface bg) sits right-aligned above the METRIC · RON
results table — clearly attached to the results column, clearly NOT on
the template cards (entry-points lane's territory; boundary note below).
It reads at the same visual weight as the table's "Show all rows"
affordance — present, not shouting. Terminal theme: brand-light sparkle
+ ink-soft label on the dark surface, fully legible.

**Drawer open (`scenarios-explain-drawer--{light,dark}.png`).** The
right floating Sheet uses the Command-Center shell geometry (rounded-2xl,
m-2/3, border-rule-strong, shadow-4 — allowlisted as a floating layer in
check_design_lint.mjs, the one lint change this lane made). Structure
top→bottom:

- Header: sparkles glyph + "Explained simply", panel title ("Scenario
  impact") as the quiet subline.
- "THE FIGURES THIS EXPLAINS" box: the panel's OWN rendered figures —
  `1.52× → ≥99×` via the same CappedMultiple the impact strip uses, and
  the covenant count. Cent-identical to the page by construction (the
  drawer re-renders the consumer's nodes; it never formats).
- Prose: the deterministic template — scenario lead sentence, the
  figures sentence ("would go from 1.52× to ≥99×; Covenants breached:
  3."), the closing read, and the glossary's plain-language leverage
  sentence. 2–4 short sentences, 13.5px, comfortable measure.
- Degraded row (see M4 below): one ink-mute line + a quiet bordered
  Retry pill. No red, no alert iconography, no error framing.
- Footer caption: "STANDARD EXPLANATION" (10.5px mono-ish caps) —
  flips to "AI EXPLANATION · GROUNDED IN YOUR FIGURES" when the AI
  answer lands (unit-tested; not photographable locally, see below).

Both themes hold: dark drawer sits on bg-2, hairlines read, the scrim
dims the page behind. No layout shift between themes.

**M4 evidence, live.** The drawer shots were taken against the local
stack with the chat Edge Function unreachable — i.e. AI genuinely dead.
What renders is exactly the gate's demand: full template text, calm
"CFO AI couldn't add more right now — the explanation above still
stands." + Retry, "Standard explanation" caption, and **no raw payload
anywhere**. The same states are pinned by
`frontend/components/cfo/simple/__tests__/explainM4.test.tsx` (thrown
network error AND the 200-with-error sentinel; asserts template text,
no `request_id`/JSON-brace/`Couldn't reach Claude` fragment in the DOM)
and `frontend/lib/__tests__/explain.test.ts` (never-throws contract,
determinism EN+RO, cache keying by figure values).

**Route shots.** `/dashboard/scenarios` idle (no active scenario): no
Explain pill — correct, there is nothing to explain until the results
column exists; page identical to pre-lane state. Mobile 390: idle state
clean; the pill row is a `flex justify-end` above the comparison panel
and the drawer is `w-[calc(100vw-16px)]` below sm, so phone geometry is
covered by construction. `/benchmark` in the zero-owner test workspace
renders the sample/upload state — the ComparisonSection tables (where
this lane's three Explain pills mount, one per section, `periodId` as
snapshotKey) only exist once the API returns a report, so they could
not be photographed in this environment. Their wiring follows the exact
pattern photographed on Scenarios and is covered by the M4 suite using
the `benchmark` panel kind + `glossaryIdForMetric` enrichment.

## Issues found and resolved in r1

1. Drawer text initially re-formatted figures for the figure list →
   replaced with the consumer-passed `figureDisplay` nodes (the panel's
   own CappedMultiple/formatValue output) so drawer and page cannot
   disagree.
2. Scenario leverage prose could print "Infinity×" for a degenerate
   scenario → `leverageText()` now applies the same ≥99× bound as
   CappedMultiple, so sentence and strip always match.

## Boundary note (Scenarios)

The entry-points lane owns `ScenarioTemplateCards` (the four template
cards). This lane touched only the results side of
`frontend/pages/cfo/Scenarios.tsx`: the Explain pill mounts above
`ScenarioComparison`/covenant panels, grounded in the figures the
ImpactSummary strip already renders. No template-card file was edited.

## Gate checklist

- `npx tsc --noEmit` — clean.
- `npx vitest run` (explain.test.ts, explainM4.test.tsx, viewModes,
  contextLines, instrument/amount) — 38/38 pass.
- `node scripts/check_design_lint.mjs` — PASS (0 hex, 0 shadow,
  0 serif); the drawer's shadow-4 is via the floating-layer allowlist,
  which is what the brief prescribes for a right Sheet.
- Pro mode: `ExplainButton` returns null (unit-tested) — the
  Instrument renders exactly what it did before this lane.
- RO copy: informal tu-form with diacritics throughout
  (`explainStrings.json`, template sentences in `lib/explain.ts`).
