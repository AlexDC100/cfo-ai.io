#!/usr/bin/env node
/**
 * THE PROVENANCE CENSUS — every figure render site, and its verdict.
 *
 * ══ WHY A REGISTRY AND NOT A HEURISTIC ═══════════════════════════════
 *
 * Whether a figure SHOULD carry the provenance affordance is a question
 * about its PAYLOAD, and no regex can read a payload. What a script can
 * do is make the question unavoidable: it discovers every site, and any
 * site not carrying a recorded verdict fails.
 *
 * Two-sided, the same protocol PLANT_MANIFEST.json uses:
 *   · a figure-render file with no registry entry           => FAIL
 *   · a registry entry whose file renders no figures        => FAIL
 *   · a file whose measured counts drift from its entry     => FAIL
 *
 * The third is the one that earns its keep. Adding a figure to a page
 * changes its count, and the author has to answer "does this payload
 * carry provenance?" before the gate goes green. That is the whole
 * mechanism: not a rule anybody remembers, a number that moves.
 *
 * ══ THE FOUR BUCKETS ══════════════════════════════════════════════════
 *
 *   HAS_SHOWS      payload carries provenance, affordance is rendered
 *   HAS_MISSING    payload carries it, affordance is NOT rendered — work
 *   LACKS_SILENT   payload carries none, nothing claimed — correct
 *   LACKS_SHOWS    payload carries none, affordance rendered anyway —
 *                  A FABRICATED AFFORDANCE. The worst bucket. A figure
 *                  that offers a provenance jump and lands nowhere
 *                  teaches the reader the affordance is decorative, and
 *                  then the ones that DO land stop being believed.
 *
 * LACKS_SHOWS is never an acceptable steady state: the gate fails on it.
 * UNAUDITED — a file nobody opened — was a fifth, capped state. The cap
 * is now ZERO: a verdict nobody formed is not a verdict, and a census
 * that tolerates twelve of them is a census with twelve holes.
 *
 * ══ HOW THIS GATE WAS BLIND, AND WHAT CHANGED (2026-09-04) ════════════
 *
 * Two adversarial critics broke the first version (commit ea6df1f):
 *
 *   · DISCOVERY WAS FIVE JSX TAGS. 81 files painted figures through
 *     primitives it could not see — <Money>, <LearnableNumber>,
 *     <NarrativeText>, <PercentLevel>, useAmountFormatter, formatRON… —
 *     including PLStatementView and CashFlowStatementView, two of the
 *     three statements. A census that finds nothing where the
 *     fabrications live is the tsc failure again. Discovery now
 *     ENUMERATES THE PRIMITIVES FROM SOURCE (`PRIMITIVES` / `FORMATTERS`
 *     below, each verified declared in its home on every run, plus a
 *     sweep of the primitive homes for a figure-shaped export nobody
 *     rostered).
 *   · WRAPPER LINES COUNTED TWICE. `<ProvenanceAffordance provenance=…>`
 *     matched both the tag count and the `provenance=` prop count (99
 *     units = 85 lines), and `const provenance = {}` in a LACKS_SILENT
 *     file bought a unit. Counting is now a brace-aware JSX scanner: ONE
 *     unit per opening tag that is the affordance itself, or a figure
 *     primitive carrying a non-null `provenance=` attribute. Declarations
 *     and plumbing props on non-figure components count for nothing.
 *   · THE ANTIBODY MATCHED AN IDENTIFIER. `source: fact.periodLabel`
 *     tripped it; `source: "FY2025"` (a literal) and
 *     `fact.periodLabel as string` (a cast) walked past. It now matches
 *     the VALUE SHAPE: a period-shaped literal, a template that spells or
 *     interpolates one, or an identifier chain whose leaf names a period
 *     — casts, `!`, `String()`, `.toString()` stripped first; every `??`
 *     / `||` operand and every ternary ARM checked (the condition is not
 *     a value and is not).
 *   · A ZERO WEARING A SOURCE. `val: -(pl.cogs ?? 0), origin: neg("cogs")`
 *     renders "0" with "Source: input.xlsx · assembled_pl.cogs" when the
 *     field is absent, and the HU pack emits `assembled_cf: {}`. That is
 *     a LACKS_SHOWS site inside a HAS_SHOWS file, invisible to a per-file
 *     bucket. A second antibody reds on a `value`/`val` fed by `?? 0` /
 *     `|| 0` inside the same object literal as an `origin`/`provenance`
 *     field, and on a figure tag whose `value=` does the same beside a
 *     `provenance=`.
 *   · FLOORS WERE STALE. SURFACES equalled the base census while the tree
 *     flipped 11 files; 77 of 99 units could vanish with both gates
 *     green. Every floor below is re-derived from the MEASURED count on
 *     this tree with ~10% headroom, all three statements are rostered,
 *     every registered file belongs to a surface, and a surface's zero
 *     floor prints WHY it is zero.
 *
 * ══ WHAT IT STILL CANNOT SEE, STATED ══════════════════════════════════
 *
 *   · A `.ts` module that builds a figure STRING (an export, a narrative,
 *     a chat context) and hands it to a `.tsx` that paints `{label}`
 *     through no primitive and no formatter. The producers are walked,
 *     printed and floored so a collapse is loud, but their consumers are
 *     not attributed. The live spec (e2e/design/provenance.spec.ts) is
 *     the instrument for what a screen actually paints.
 *   · `toLocaleString` on a Date is excluded by a stated heuristic; a
 *     miss shifts one file's count by one, which the registry equality
 *     then makes visible.
 *
 * ══ WORK + FLOOR + CANARY ═════════════════════════════════════════════
 *
 * Exit zero is half a verdict. This prints how many files it walked, how
 * many figure sites it found, per surface, and CANARIES it must see.
 * `--probe-vacuity` empties discovery and REQUIRES a failure. A census
 * that finds nothing is broken, not clean (TC-3).
 *
 * Zero dependencies. `node scripts/check_provenance_census.mjs`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not URL.pathname — this repo's path contains spaces and
// pathname would keep them percent-encoded.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FE = join(ROOT, "frontend");
const REGISTRY_PATH = join(ROOT, "design_review", "PROVENANCE_CENSUS.json");

// ══════════════════════════════════════════════════════════════════════
// ENUMERATED FROM SOURCE — the primitives a figure is painted through
// ══════════════════════════════════════════════════════════════════════
//
// Each entry names the file(s) that DECLARE the primitive. The gate
// checks every declaration on every run: a primitive that moved or was
// deleted reds as PRIMITIVE ROSTER STALE rather than silently shrinking
// the census. `local` primitives are declared inside one surface file and
// only ever appear there; they are rostered so their tags count as sites.
//
// NOT here, on purpose (each verified by reading its home): `AmountGroup`
// and `MoneyAmountGroup` are scale contexts that paint nothing;
// `ProvenanceAffordance` is the affordance, counted separately;
// `ProvenanceDot` is a dot; chips, terms and labels are not figures.
const PRIMITIVES = {
  Amount: { homes: ["frontend/components/instrument/Amount.tsx"] },
  MoneyAmount: { homes: ["frontend/components/comparison/MoneyAmount.tsx"] },
  PercentLevel: { homes: ["frontend/components/comparison/MoneyAmount.tsx"] },
  CappedMultiple: { homes: ["frontend/components/comparison/MoneyAmount.tsx"] },
  PpDelta: { homes: ["frontend/components/comparison/MoneyAmount.tsx"] },
  Money: { homes: ["frontend/components/ui/Money.tsx"] },
  LearnableNumber: { homes: ["frontend/components/learning/LearnableNumber.tsx"] },
  LearnableMetricCard: { homes: ["frontend/components/learning/LearnableMetricCard.tsx"] },
  TraceableNumber: { homes: ["frontend/components/cfo/TraceableNumber.tsx"] },
  NarrativeText: { homes: ["frontend/lib/narrativeMoney.tsx"] },
  // Declared twice — the findings' figure and the Capsule's — both render
  // a figure and both accept a provenance.
  FigureValue: {
    homes: [
      "frontend/components/cfo/findings/parts.tsx",
      "frontend/components/instrument/shell/capsuleAnswer/CapsuleFigures.tsx",
    ],
  },
  FigureCell: { homes: ["frontend/components/cfo/findings/parts.tsx"] },
  DeltaChip: { homes: ["frontend/components/instrument/shell/capsuleAnswer/CapsuleFigures.tsx"] },
  BsAmountCell: { homes: ["frontend/components/cfo/BSStatementView.tsx"], local: true },
  FactTileValue: {
    homes: ["frontend/components/instrument/shell/capsuleEmpty/CapsuleFactTiles.tsx"],
    local: true,
  },
  MetricAmount: {
    homes: ["frontend/components/public-companies/BenchmarkingPanel.tsx"],
    local: true,
  },
  Stat: {
    homes: ["frontend/pages/cfo/Products.tsx", "frontend/pages/cfo/Settings.tsx"],
    local: true,
  },
};

/** Where new figure primitives get written. Every exported component in
 *  these files whose name reads like a figure and is not rostered above
 *  (or excused below, with a reason) is an UNROSTERED PRIMITIVE — the
 *  census cannot count what it does not know the name of. */
const PRIMITIVE_HOMES = [
  "frontend/components/instrument",
  "frontend/components/comparison/MoneyAmount.tsx",
  "frontend/components/ui/Money.tsx",
  "frontend/components/learning/LearnableNumber.tsx",
  "frontend/components/learning/LearnableMetricCard.tsx",
  "frontend/components/cfo/TraceableNumber.tsx",
  "frontend/lib/narrativeMoney.tsx",
];
const FIGURE_NAME =
  /(Amount|Money|Number|Figure|Value|Percent|Multiple|Metric|Stat(?![a-z])|Ratio|Level|Delta)/;
/** Exported from a primitive home, figure-shaped name, NOT a figure. */
const NOT_A_FIGURE = new Map([
  ["AmountGroup", "scale context; paints nothing (Amount.tsx)"],
  ["MoneyAmountGroup", "converts values and renders <AmountGroup>; paints nothing"],
  ["ProvenanceAffordance", "the affordance itself, counted separately"],
  ["ProvenanceCard", "the card the affordance opens; its numerals are the payload's"],
  ["ProvenanceDot", "a 7px dot, not a figure"],
  ["FigureRow", "a labelled row AROUND FigureValue; the value tag is the site"],
  ["FigureList", "a list of FigureRows"],
  ["ComparisonVisual", "chart body; any numeral it spells goes through a formatter counted in its file"],
  ["SparklineVisual", "chart body; same"],
  ["CapsuleVisuals", "dispatches to the two visuals above"],
  ["FigureProvenanceProvider", "context plumbing (lib/figureProvenanceContext)"],
  ["FigureProvenanceEntry", "type"],
  ["FigureProvenanceMap", "type"],
]);

/** Formatter functions a component calls to spell a figure it paints
 *  without a primitive. Each is verified declared in its home. Natives
 *  (`toFixed`, `toLocaleString`, `Intl.NumberFormat`) are matched by
 *  shape. */
const FORMATTERS = {
  useAmountFormatter: "frontend/stores/currency.tsx",
  formatRON: "frontend/lib/formatRon.ts",
  formatPercent: "frontend/lib/formatRon.ts",
  formatMoney: "frontend/lib/money.ts",
  formatAmount: "frontend/lib/amountFormat.ts",
  formatCanonicalFull: "frontend/lib/canonicalMetrics.ts",
  formatCanonicalCompact: "frontend/lib/canonicalMetrics.ts",
  formatCanonicalPct: "frontend/lib/canonicalMetrics.ts",
  formatCurrency: "frontend/lib/financialReport.ts",
  formatRatio: "frontend/lib/financialReport.ts",
  formatNumber: "frontend/lib/financialReport.ts",

  // ── R3, 2026-09-04 — TWENTY-ONE FORMATTERS THE CENSUS COULD NOT SEE ──
  //
  // The roster above was hand-written, and the sweep that was supposed to
  // catch what it missed looked for `export (function|const) [A-Z]\w*`
  // over SEVEN named directories. Two holes, and they compounded: no
  // lowercase name could ever trip it (`fmtX`, `fmtPct1`), and three of
  // the files that declare the most figure formatters — pciData.ts,
  // amountFormat.ts, valueFormat.ts — were not among the seven, so even a
  // capitalised one there was invisible.
  //
  // The live miss that proves it was not hypothetical:
  // public-companies/CompareTray.tsx paints SIXTEEN figures at :306 via
  // `{row.cell(r)}`, every cell built from `fmtCompactMoney` / `fmtPct1` /
  // `fmtX`. The file was in no roster, no surface and no floor — the
  // census did not know it rendered anything. Four more files were
  // likewise absent (PublicCompanyIntelligence, AccountMenu,
  // command/tabs/AccountTab, learning/InteractiveFormula).
  //
  // The sweep is now over the WHOLE frontend and matches either case (see
  // UNROSTERED FORMATTER below), so this list can no longer silently fall
  // behind the tree.
  fmtCompactMoney: "frontend/components/public-companies/pciData.ts",
  fmtPrice: "frontend/components/public-companies/pciData.ts",
  fmtSignedPct: "frontend/components/public-companies/pciData.ts",
  fmtPct1: "frontend/components/public-companies/pciData.ts",
  fmtX: "frontend/components/public-companies/pciData.ts",
  fmtStandoutValue: "frontend/components/public-companies/pciData.ts",
  formatValue: "frontend/components/learning/valueFormat.ts",
  formatPercentDelta: "frontend/lib/amountFormat.ts",
  formatMultiple: "frontend/lib/amountFormat.ts",
  formatExact: "frontend/lib/amountFormat.ts",
  formatCardValue: "frontend/lib/dashboard/resolveConceptValue.ts",
  formatDimensionless: "frontend/lib/findings.ts",
  formatSignedDimensionless: "frontend/lib/findings.ts",
  formatRONSigned: "frontend/lib/formatRon.ts",
  formatRONParen: "frontend/lib/formatRon.ts",
  formatConfidence: "frontend/lib/industryApi.ts",
  formatAmountFrom: "frontend/lib/money.ts",
  formatMoneyFrom: "frontend/lib/money.ts",
  formatCitedFact: "frontend/lib/narrativeMoney.tsx",
  formatEur: "frontend/lib/pricingConfig.ts",
  formatTokens: "frontend/lib/tokenUsage.ts",
};

/** Exported, figure-shaped NAME, spells something — but not a FIGURE. Each
 *  excused with the reason, so the sweep below stays two-sided. */
const NOT_A_FIGURE_FORMATTER = new Map([
  ["formatDateOnly", "a DATE (lib/locale.ts); pins timeZone UTC — no figure"],
  ["formatDateTime", "a TIMESTAMP (lib/locale.ts)"],
  ["formatDetectedMonth", "a period month label (lib/detectPeriodEnd.ts)"],
  ["formatPeriodMonth", "a period label (lib/orgPeriods.ts)"],
  ["formatPeriodYear", "a period label (lib/orgPeriods.ts)"],
  ["formatPeriodMonthLoose", "a period label (lib/orgPeriods.ts)"],
  ["formatPriceLabel", "a PLAN price on the marketing surface (lib/plans.ts) — not a company figure"],
]);
const NATIVE_FORMATTERS = ["toFixed", "toLocaleString", "Intl.NumberFormat"];

/** R6 — formatters DISCOVERED BY BEHAVIOUR on this run, name-agnostic:
 *  every exported function anywhere under frontend/ that returns display
 *  text spelled from a number. Populated before the walk, merged into the
 *  counted set, so a helper called `spellRon` is a render site the first
 *  time it ships — with no edit to the roster above, which is the property
 *  a hand-written roster structurally cannot have. */
let AUTO_FORMATTERS = new Map();
/** The counted set: the verified roster plus whatever behaviour found. */
const countedFormatterNames = () =>
  new Set([...Object.keys(FORMATTERS), ...AUTO_FORMATTERS.keys()]);

const AFFORDANCE_TAG = "ProvenanceAffordance";

// ══════════════════════════════════════════════════════════════════════
// R10 — THE RENDER WITNESS: SOMETHING MUST ASSERT THE RENDERED RESULT
// ══════════════════════════════════════════════════════════════════════
//
// A critic moved the kill up one layer, where a census of call sites is
// structurally blind:
//
//   · one `||` → `&&` in `hasProvenance` (Provenance.tsx) and EVERY
//     affordance in the product renders bare. Census: units 76, every
//     surface unchanged, PASS.
//   · gut `ProvenanceCard`'s body and every dotted rule in the product
//     opens an EMPTY card — the state this gate's own header calls the
//     worst bucket, product-wide. Census: units 76, PASS.
//
// Both are true because the call sites did not move, and call sites are
// all this file can see. The affordance is a PRIMITIVE, and a primitive
// that stopped working leaves the source unchanged everywhere it is used.
//
// So the census stops being the only instrument. Every tag it credits
// with a bearing site must name a spec that RENDERS that primitive and
// asserts the painted result, and the census RUNS those specs: the gate
// cannot print PASS while the affordance is dead. The requirement is
// DERIVED from the measurement (`bearingTags`), not from this list — a
// primitive that starts bearing needs a witness before the gate goes
// green, with no edit here.
const RENDER_WITNESS = {
  ProvenanceAffordance: [
    "frontend/components/instrument/__tests__/provenance.test.tsx",
    "frontend/components/instrument/__tests__/provenanceRenderWitness.test.tsx",
  ],
  Amount: ["frontend/components/instrument/__tests__/provenanceRenderWitness.test.tsx"],
  MoneyAmount: ["frontend/components/instrument/__tests__/provenanceRenderWitness.test.tsx"],
  FigureCell: ["frontend/components/instrument/__tests__/provenanceRenderWitness.test.tsx"],
  // Local to BSStatementView.tsx — cannot be imported, so its witness
  // renders the statement that declares it.
  BsAmountCell: ["frontend/components/cfo/__tests__/statementProvenance.test.tsx"],
};
/** A witness that asserts nothing is a fourth instrument examining
 *  nothing (TC-9). Each named spec must PAINT the marker the affordance
 *  paints and must carry real assertions. */
const WITNESS_MARKER = /data-provenance/;
const WITNESS_MIN_EXPECTS = 8;

// ══════════════════════════════════════════════════════════════════════
// FLOORS — measured 2026-09-04 on this tree, ~10% headroom
// ══════════════════════════════════════════════════════════════════════
//
// A floor catches COLLAPSE (a walk that stops walking, a lane's work
// silently deleted); it is not a ratchet. Each is the measured count
// rounded down by roughly a tenth. When a number here moves DOWN,
// something was lost and the change must say what.

/** Files walked (.ts + .tsx; tests excluded from measurement, counted
 *  here). Measured 660. */
const FLOOR_FILES = 590;
/** .tsx files that paint at least one figure. Measured 83. */
const FLOOR_REGISTERED = 74;
/** Figure render sites (primitive tags + formatter calls) across those
 *  files. Measured 665. */
const FLOOR_SITES = 598;
// ── R8 — A FLOOR WITH HEADROOM IS AN ALLOWANCE NOBODY IS USING ───────
//
// `FLOOR_AFFORDANCES = 68` against a measured 76 meant EIGHT real
// affordances could be deleted, with honest registry updates, and this
// gate would still print PASS. A floor is supposed to catch a collapse;
// eight is not a rounding error, it is a whole surface.
//
// Affordance counts are now checked TWO ways, and neither has headroom:
//
//   · the DERIVED floor — the registry's own `affordances` numbers,
//     summed globally and per surface. This catches the registry and the
//     tree disagreeing at a level that NAMES the surface (the per-file
//     equality already reds, but a sum that names "findings" is what a
//     reader acts on).
//   · the RATCHET — a constant here, set to the measured high-water. A
//     deletion reds even when the registry is updated honestly, because
//     the registry is not the authority on how much provenance the
//     product HAD. Raising it is free; lowering it is an edit in this
//     file that has to say which affordance was retired and why.
//
// Discovery floors (files, sites, producers) keep their headroom on
// purpose: sites move up and down with ordinary refactors, and those
// floors exist to catch a walk that stopped walking, not a deletion.
/** Affordance-bearing sites, EXACT high-water. Measured 76 on 2026-09-04.
 *  MAY ONLY BE RAISED. Lowering it retires an affordance: say which. */
const RATCHET_AFFORDANCES = 76;
/** .ts files that BUILD figure strings — they cannot wear the affordance
 *  and are not registered, but a collapse here is a walk that broke.
 *  Measured 23 (was 28). The DEFINITION changed, not the tree: R6 stopped
 *  counting a formatter's own declaration as a call site (`function money(`
 *  matched `money(`), so six modules that only DECLARE formatters —
 *  pciData, valueFormat, canonicalMetrics, resolveConceptValue,
 *  tokenUsage, capsuleAnswerClient — correctly stopped being counted as
 *  files that CALL one. Lowered with that reason, not to make room. */
const FLOOR_PRODUCERS = 20;
/** Files allowed to carry no payload verdict. ZERO. */
const CEILING_UNAUDITED = 0;

/** R5 — builder modules a card-bearing component imports directly. The
 *  absent-leaf lint's SCOPE; a collapse here is the import walk breaking,
 *  which would make the lint pass by examining nothing. Measured 79. */
const FLOOR_BUILDER_SCOPE = 70;
/** R5 — absent-payload-leaf substitutions still registered OPEN_DEFECT.
 *  A RATCHET: it may only ever be lowered. Set from the measured count of
 *  the live defects the source lane owns on 2026-09-04; when a fix lands,
 *  the entry's count falls, this falls with it, and it can never be raised
 *  to make room for a new fabrication. */
const CEILING_OPEN_DEFECT = 3;   // LOWERED 25 -> 3 on 2026-09-04: the source
// lane closed CreditScoreCard's seven `credit_subscore_* ?? 0` bars and
// servedFacts' pair-derived liabilities total. The ratchet follows the
// measurement DOWN and may never be raised to make room for a new one.
/** R5 — substitutions nobody has yet checked against a real envelope. A
 *  RATCHET, same as above: it may only ever be lowered, one file at a time,
 *  as each is run against `corpus/*​/expected/*.json` and re-bucketed
 *  FILED_ZERO or OPEN_DEFECT. It is NOT an allowance to add more. */
const CEILING_UNADJUDICATED_LEAF = 114;  // LOWERED 130 -> 114 (same day,
// same closures). Still the largest number in this file, and still the
// honest one: 114 substitutions nobody has driven against a real envelope.

// ══════════════════════════════════════════════════════════════════════
// P4 — PER-SURFACE FLOORS (TC-6), EVERY SURFACE THE CENSUS KNOWS
// ══════════════════════════════════════════════════════════════════════
//
// FLOOR_AFFORDANCES above is a floor on a SUM, and this repo has already
// measured what a sum is worth: `import-boundary` printed "boundary holds"
// with one half collapsed 517 -> 1, because the total stayed above the
// global floor. So each named surface records its OWN floor over its OWN
// files, and a breach names the surface.
//
// The per-FILE expectation is the registry's `affordances` EQUALITY —
// that is what sees one addend collapse. The surface floor is the
// backstop that names which screen went dark.
//
// `witness` records the live twin in e2e/design/provenance.spec.ts — or
// says UNWITNESSED with the precondition that is missing. A surface with
// no runtime path is printed as such rather than counted as evidence.
//
// Floors of ZERO print their reason: VACUOUS-PENDING when the surface has
// HAS_MISSING files (a zero floor cannot red; the lane that threads them
// raises it in the same change), NONE-EXPECTED when every file is
// LACKS_SILENT (a zero is the LAW there, and the live spec asserts the
// surface renders no affordance at all where it has a runtime path).
const SURFACES = {
  dashboard: {
    ratchet: 12, // MEASURED, exact — no headroom (see RATCHET above)
    witness: "live: P2/P5[dashboard] + P4[dashboard]",
    files: [
      "frontend/components/cfo/KeyMetricsRow.tsx",
      "frontend/components/cfo/simple/StoryOverview.tsx",
      "frontend/components/cfo/simple/FirstUploadJourney.tsx",
      "frontend/components/dashboard/MetricCard.tsx",
      "frontend/pages/cfo/FinancialStatements.tsx",
      "frontend/components/instrument/shell/TrustChip.tsx",
      "frontend/components/cfo/SourceQualityBanner.tsx",
      "frontend/components/period/DeltaBadge.tsx",
    ],
  },
  statements: {
    ratchet: 5, // MEASURED, exact — no headroom (see RATCHET above)
    witness:
      "live: P1/P2/P5[statements] (BS row by row) + P4[statements]; P2[statements-pl-cf] asserts PL and CF render NO affordance while HAS_MISSING",
    files: [
      "frontend/components/cfo/BSStatementView.tsx",
      "frontend/components/cfo/PLStatementView.tsx",
      "frontend/components/cfo/CashFlowStatementView.tsx",
      "frontend/components/cfo/StatementNotes.tsx",
    ],
  },
  findings: {
    ratchet: 10, // MEASURED, exact — no headroom (see RATCHET above)
    witness:
      "live: P1/P2/P5[findings] (cited figures) + P2/P5[findings-limits] (limit / observed / impact) + P4[findings]; AllChecksList UNWITNESSED (the fixture carries no all_checks rows)",
    files: [
      "frontend/components/cfo/findings/parts.tsx",
      "frontend/components/cfo/findings/EvidenceLine.tsx",
      "frontend/components/cfo/findings/ThresholdMeter.tsx",
      "frontend/components/cfo/findings/FindingCard.tsx",
      "frontend/components/cfo/findings/AllChecksList.tsx",
      "frontend/components/cfo/findings/ImpactRow.tsx",
    ],
  },
  capsule: {
    ratchet: 7, // MEASURED, exact — no headroom (see RATCHET above)
    witness: "live: P2/P5[capsule] + P4[capsule]",
    files: [
      "frontend/components/instrument/shell/capsuleAnswer/CapsuleFigures.tsx",
      "frontend/components/instrument/shell/capsuleAnswer/CapsuleTier0Preview.tsx",
      "frontend/components/instrument/shell/capsuleAnswer/CapsuleFactCard.tsx",
      "frontend/components/instrument/shell/capsuleAnswer/CapsuleAnswerPanel.tsx",
      "frontend/components/instrument/shell/capsuleEmpty/CapsuleFactTiles.tsx",
      "frontend/components/instrument/shell/capsuleEmpty/CapsuleAccountCard.tsx",
    ],
  },
  "public-companies": {
    ratchet: 7, // MEASURED, exact — no headroom (see RATCHET above)
    witness:
      "live: P2/P5[public-companies] (MarketSurface, AAPL companyfacts) + P2[markets-overview] (MarketsOverview / PeerSuggestRail / MarketPulseStrip) + P4[public-companies] + P4[markets-overview]",
    files: [
      "frontend/components/public-companies/MarketSurface.tsx",
      "frontend/components/public-companies/BenchmarkingPanel.tsx",
      "frontend/components/public-companies/MarketPulseStrip.tsx",
      "frontend/components/public-companies/MarketsOverview.tsx",
      "frontend/components/public-companies/PeerSuggestRail.tsx",
      "frontend/components/public-companies/StockDetailDrawer.tsx",
      "frontend/components/public-companies/StockMetricGrid.tsx",
      "frontend/components/public-companies/StockPriceChart.tsx",
      "frontend/components/public-companies/CompanyExposureDetail.tsx",
      "frontend/components/public-companies/GeographicMapPanel.tsx",
      "frontend/components/public-companies/RiskRadar.tsx",
      // R3, 2026-09-04: the file the census could not see. 16 figures, in
      // no roster and no floor until the formatter sweep found it.
      "frontend/components/public-companies/CompareTray.tsx",
    ],
  },
  "public-company-dashboard": {
    ratchet: 10, // MEASURED, exact — no headroom (see RATCHET above)
    witness: "UNWITNESSED: /api/public/companies/{ticker} answers 503 nasdaq_key_missing on the test stack",
    files: ["frontend/pages/cfo/PublicCompanyDashboard.tsx"],
  },
  products: {
    ratchet: 8, // MEASURED, exact — no headroom (see RATCHET above)
    witness: "UNWITNESSED: /api/sales-datasets answers {datasets: []} on the test stack; the SKU table needs one",
    files: [
      "frontend/pages/cfo/Products.tsx",
      "frontend/components/cfo/products/CategoriesOverview.tsx",
      "frontend/components/cfo/SkuDetailDrawer.tsx",
      "frontend/components/cfo/products/DioPersistenceBanner.tsx",
      "frontend/components/cfo/DatasetsPanel.tsx",
    ],
  },
  report: {
    ratchet: 6, // MEASURED, exact — no headroom (see RATCHET above)
    witness: "live: P2/P5[report] (/report on the fixture period) + P4[report]",
    files: [
      "frontend/pages/cfo/ComprehensiveReport.tsx",
      "frontend/components/cfo/CreditScoreCard.tsx",
      "frontend/components/cfo/EbitdaMultiplePrimaryCard.tsx",
      "frontend/components/cfo/EbitdaReconciliationPanel.tsx",
      "frontend/components/cfo/NavValuationView.tsx",
      "frontend/components/cfo/ValuationSection.tsx",
      "frontend/components/cfo/RecommendationsView.tsx",
      "frontend/components/cfo/RatioDetailDrawer.tsx",
      "frontend/components/valuation/LearnableValuationBridge.tsx",
    ],
  },
  benchmark: {
    ratchet: 3, // MEASURED, exact — no headroom (see RATCHET above)
    witness: "UNWITNESSED: /api/benchmarks/report/{period} answers 401 Missing Bearer token on the test stack",
    files: [
      "frontend/pages/cfo/BenchmarkReport.tsx",
      "frontend/pages/cfo/PeerComparisonReport.tsx",
      "frontend/components/cfo/Level1BenchmarkView.tsx",
    ],
  },
  "multi-year-history": {
    ratchet: 7, // MEASURED, exact — no headroom (see RATCHET above)
    witness: "UNWITNESSED: route compile-gated off (config/features.ts PUBLIC_RECORDS_ENABLED = false)",
    files: [
      "frontend/pages/cfo/MultiYearHistory.tsx",
      "frontend/components/cfo/PublicRecordsQuickCard.tsx",
    ],
  },
  variance: {
    ratchet: 0, // MEASURED, exact — no headroom (see RATCHET above)
    witness: "live: P2[variance] asserts 0 affordances while both files are HAS_MISSING",
    files: [
      "frontend/components/comparison/KpiVarianceStrip.tsx",
      "frontend/components/comparison/VarianceTable.tsx",
    ],
  },
  scenarios: {
    ratchet: 0, // MEASURED, exact — no headroom (see RATCHET above)
    witness: "live: P2[scenarios] asserts NO affordance on a LACKS_SILENT surface",
    files: [
      "frontend/components/scenarios/ScenarioComparison.tsx",
      "frontend/components/scenarios/AdjustmentEditor.tsx",
      "frontend/components/scenarios/CovenantPanel.tsx",
      "frontend/pages/cfo/Scenarios.tsx",
    ],
  },
  "decisions-alerts": {
    ratchet: 0, // MEASURED, exact — no headroom (see RATCHET above)
    witness: "UNWITNESSED: routes compile-gated off (config/features.ts DECISIONS_ALERTS_ENABLED = false)",
    files: [
      "frontend/pages/cfo/Alerts.tsx",
      "frontend/pages/cfo/Decisions.tsx",
      "frontend/lib/linkifyAlertBody.tsx",
    ],
  },
  "settings-workspace": {
    ratchet: 0, // MEASURED, exact — no headroom (see RATCHET above)
    witness: "live: P2[settings] asserts NO affordance on a LACKS_SILENT surface",
    files: [
      "frontend/pages/cfo/Settings.tsx",
      "frontend/components/cfo/workspace/WorkspaceSettingsV2.tsx",
      "frontend/components/cfo/command/DecisionRulesModal.tsx",
      "frontend/components/cfo/UploadDialog.tsx",
      "frontend/components/cfo/pricing/ExtraDocConfirmDialog.tsx",
      "frontend/components/cfo/chat/CFOFilePreview.tsx",
      // R3, 2026-09-04 — account telemetry (plan price, token usage) and
      // the currency store's own formatter binding.
      "frontend/components/cfo/AccountMenu.tsx",
      "frontend/components/cfo/command/tabs/AccountTab.tsx",
    ],
  },
  learning: {
    ratchet: 0, // MEASURED, exact — no headroom (see RATCHET above)
    witness: "UNWITNESSED: learning popovers open per concept; CompositionBreakdown is HAS_MISSING (named), no figure there is threaded yet",
    files: [
      "frontend/components/learning/CompositionBreakdown.tsx",
      "frontend/components/learning/LearningPopover.tsx",
      "frontend/components/learning/StaticInterpretation.tsx",
      "frontend/components/learning/BenchmarkMicroBar.tsx",
      "frontend/components/learning/InteractiveFormula.tsx",
    ],
  },
  // R3, 2026-09-04 — TWO SURFACES THE CENSUS HAD NO ROSTER FOR. Every
  // figure on both is a PRICE LIST entry or a classifier's confidence in
  // its own output; none is read from a company's envelope, so a zero is
  // the law and the live spec asserts it.
  "billing-pricing": {
    ratchet: 0, // MEASURED, exact — no headroom (see RATCHET above)
    witness:
      "UNWITNESSED: the pricing page and the billing surfaces render from a static price list (lib/plans.ts) and Stripe's invoice preview; no workspace fixture reaches them",
    files: [
      "frontend/pages/cfo/Pricing.tsx",
      "frontend/components/cfo/BillingSection.tsx",
      "frontend/components/cfo/CurrentPlanCard.tsx",
      "frontend/components/cfo/PricingTableV2.tsx",
      "frontend/components/cfo/UpcomingInvoicePreview.tsx",
      "frontend/components/cfo/pricing/IntroUnlockCallout.tsx",
      "frontend/components/cfo/pricing/MonthlyBillEstimator.tsx",
    ],
  },
  "industry-classification": {
    ratchet: 0, // MEASURED, exact — no headroom (see RATCHET above)
    witness:
      "UNWITNESSED: the CAEN badge and suggestion card render only once an industry assignment exists; the design fixture carries none",
    files: [
      "frontend/components/cfo/industry/IndustryBadge.tsx",
      "frontend/components/cfo/industry/IndustrySuggestionCard.tsx",
    ],
  },
  instrument: {
    ratchet: 1, // MEASURED, exact — no headroom (see RATCHET above)
    witness: "unit: frontend/components/instrument/__tests__/provenance.test.tsx",
    files: [
      "frontend/components/instrument/Amount.tsx",
      "frontend/components/comparison/MoneyAmount.tsx",
      "frontend/components/ui/Money.tsx",
      "frontend/components/cfo/TraceableNumber.tsx",
      "frontend/lib/narrativeMoney.tsx",
      "frontend/stores/currency.tsx",
    ],
  },
  "marketing-ops": {
    ratchet: 0, // MEASURED, exact — no headroom (see RATCHET above)
    witness: "live: P2[landing] asserts NO affordance on synthetic demo figures",
    files: [
      "frontend/pages/cfo/Landing.tsx",
      "frontend/components/landing/PrivateBusinessDemo.tsx",
      "frontend/pages/cfo/Chat.tsx",
      "frontend/pages/cfo/Ops.tsx",
    ],
  },
};

/** Files the census MUST see. Absent => DISCOVERY BROKEN. Each is a
 *  named surface in the mission — and three of them are exactly the
 *  files the five-tag census could not see. */
const CANARIES = [
  "frontend/components/instrument/Amount.tsx",
  "frontend/components/cfo/BSStatementView.tsx",
  "frontend/components/cfo/PLStatementView.tsx", // invisible to the 5-tag census
  "frontend/components/cfo/CashFlowStatementView.tsx", // invisible to the 5-tag census
  "frontend/components/instrument/shell/capsuleAnswer/CapsuleFigures.tsx",
  "frontend/components/cfo/findings/parts.tsx",
  "frontend/components/ui/Money.tsx", // invisible to the 5-tag census
  "frontend/pages/cfo/ComprehensiveReport.tsx",
];

// ══════════════════════════════════════════════════════════════════════
// FILE WALK
// ══════════════════════════════════════════════════════════════════════

const SKIP_DIRS = new Set(["node_modules", "dist", ".vite", "__preview__"]);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) yield* walk(p);
    } else if (p.endsWith(".tsx") || p.endsWith(".ts")) {
      yield p;
    }
  }
}

const rel = (p) => relative(ROOT, p).split(sep).join("/");
const isTest = (f) =>
  /(\.test\.|\.spec\.)/.test(f) || f.includes("/__tests__/") || f.includes("/test/");

/** Comments are stripped first: this codebase's comments name `<Amount>`
 *  constantly and a naive count would triple. A `//` inside a string
 *  (`"https://…"`) is preceded by `:`, and an escaped one by `\`. */
function stripComments(src) {
  // Block comments are replaced by their own newlines, not deleted, so a
  // line number computed on the stripped text is the line in the FILE —
  // the first draft reported MarketSurface.tsx:446 for a plant at :462.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
}

// ══════════════════════════════════════════════════════════════════════
// THE JSX SCANNER — one unit per opening tag
// ══════════════════════════════════════════════════════════════════════

/**
 * Every JSX opening tag with a capitalised name: `{ name, attrs, index }`.
 * Brace- and quote-aware, so an attribute like
 * `provenance={provenanceOf({ source: x })}` is one tag, not two. A `<`
 * preceded by an identifier, `)` or `]` is a generic (`useState<Foo>`),
 * not a tag, and is skipped.
 */
function openingTags(code) {
  const raw = [];
  const rx = /(?<![\w)\]])<([A-Z][A-Za-z0-9_.]*)(?=[\s/>])/g;
  let m;
  while ((m = rx.exec(code)) !== null) {
    let i = rx.lastIndex;
    let depth = 0;
    let quote = null;
    for (; i < code.length; i += 1) {
      const c = code[i];
      if (quote) {
        if (c === "\\") {
          i += 1;
          continue;
        }
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        quote = c;
        continue;
      }
      if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
      else if (c === ">" && depth <= 0) break;
    }
    raw.push({ name: m[1], start: rx.lastIndex, end: i, index: m.index });
    // Resume right after the NAME, not after the closing `>`: a figure tag
    // nested inside another tag's attribute — `<ValTile value={<MoneyAmount
    // provenance=…/>}>` — is a render site too.
    rx.lastIndex = m.index + m[0].length;
  }
  // A tag's OWN attributes: the span with every nested tag blanked out, so
  // an outer wrapper is not credited with an inner figure's `provenance=`.
  return raw.map((t) => {
    let attrs = code.slice(t.start, t.end);
    for (const n of raw) {
      if (n === t || n.index <= t.start || n.end > t.end) continue;
      const from = n.index - t.start;
      const to = n.end - t.start + 1;
      attrs = attrs.slice(0, from) + " ".repeat(Math.max(0, to - from)) + attrs.slice(to);
    }
    return { name: t.name, attrs, index: t.index };
  });
}

// ══════════════════════════════════════════════════════════════════════
// THE IMPORT GRAPH — resolved from source, shared by R2 and the R5 axis
// ══════════════════════════════════════════════════════════════════════
//
// Two checks need to know what a file actually depends on: `renders_via`
// (does the claiming file import the file it credits?) and the
// absent-leaf lint (which builders feed a card-bearing component?). Both
// were assertions about a RELATION that nothing measured; both are now
// measured here. Resolution covers the two specifiers this tree uses —
// `@/…` (Vite alias for `frontend/`) and relative — and the extension
// order Vite resolves in. A bare package specifier resolves to nothing,
// which is correct: node_modules is not this census's subject.
const importCache = new Map();
function resolveSpecifier(fromRel, spec) {
  let base;
  if (spec.startsWith("@/")) base = join(FE, spec.slice(2));
  else if (spec.startsWith(".")) base = resolvePath(dirname(join(ROOT, fromRel)), spec);
  else return null;
  for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx", ""]) {
    const p = base + ext;
    if (existsSync(p) && statSync(p).isFile()) return rel(p);
  }
  return null;
}
/** Repo-relative paths `fromRel` imports (static `from "…"` specifiers). */
function importsOf(fromRel) {
  const hit = importCache.get(fromRel);
  if (hit) return hit;
  const out = new Set();
  const abs = join(ROOT, fromRel);
  if (existsSync(abs)) {
    const src = stripComments(readFileSync(abs, "utf-8"));
    for (const m of src.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
      const r = resolveSpecifier(fromRel, m[1]);
      if (r) out.add(r);
    }
  }
  importCache.set(fromRel, out);
  return out;
}

// ══════════════════════════════════════════════════════════════════════
// R9 — `renders_via` NAMES COMPONENTS, AND MUST COVER EVERY FIGURE
// ══════════════════════════════════════════════════════════════════════
//
// R2 tightened `renders_via` from "a sentence" to "a file this one
// imports". A critic showed that is still the wrong relation.
// BenchmarkingPanel.tsx paints ELEVEN figures, carries no provenance prop
// anywhere, and imports `@/components/instrument/Amount` — so relabelling
// it HAS_SHOWS with `renders_via: ".../Amount.tsx"` passed. "A imports B,
// and B can paint an affordance" is not "A's figures paint one". Eleven
// of the seventy zero-bearing registered files were launderable that way,
// one copy-pasted line each.
//
// The relation that IS true when this verdict is honest — a component
// paints my figures and owns their payload — has four parts, and all four
// are measurable:
//
//   1. `renders_via` names COMPONENTS, not just a file: "path#A,B".
//   2. the file exports each of them, and this file imports that file.
//   3. this file RENDERS each of them as a tag.
//   4. COVERAGE: every figure this file paints goes through one of them.
//      A formatter call is a figure this file spelled itself — no child
//      can be answerable for it — so `fmtSites` must be zero, and every
//      rostered primitive tag must be one of the named components.
//
// (4) is what kills the BenchmarkingPanel launder: it spells its figures
// through fmtX / fmtPct1 / a local MetricAmount, none of which any child
// component can be responsible for.
const VIA_SPLIT = /^([^#]+)#(.+)$/;

/** Capitalised names a file exports. */
function componentExportsOf(fileRel) {
  const abs = join(ROOT, fileRel);
  if (!existsSync(abs)) return new Set();
  const code = stripComments(readFileSync(abs, "utf-8"));
  const out = new Set();
  for (const m of code.matchAll(/\bexport\s+(?:default\s+)?(?:function|const)\s+([A-Z][\w$]*)/g))
    out.add(m[1]);
  for (const m of code.matchAll(/\bexport\s*\{([^}]*)\}/g))
    for (const part of m[1].split(","))
      for (const w of part.trim().split(/\s+as\s+/))
        if (/^[A-Z][\w$]*$/.test(w.trim())) out.add(w.trim());
  return out;
}

function rendersViaFindings(f, m, e) {
  const out = [];
  const via = e.renders_via;
  if (!via) {
    out.push(
      `VERDICT UNBACKED: ${f} is registered HAS_SHOWS but bears 0 affordances and names ` +
        "no `renders_via`. Either a child component paints it from its own payload " +
        '(name it as "file#Component") or nothing shows and the verdict is wrong.',
    );
    return out;
  }
  const parts = VIA_SPLIT.exec(String(via));
  if (!parts) {
    out.push(
      `RENDERS_VIA UNQUALIFIED: ${f} names \`${via}\`, a bare file path. A file is not a ` +
        'relation — write "path/to/File.tsx#ComponentA,ComponentB" and name the components ' +
        "this file actually renders. BenchmarkingPanel.tsx passed the file-only form by " +
        "importing <Amount> and painting none of its eleven figures through it.",
    );
    return out;
  }
  const [, viaFile, compList] = parts;
  const comps = compList
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  if (entries.get(viaFile)?.bucket !== "HAS_SHOWS" || !(measured.get(viaFile)?.bearing > 0)) {
    out.push(
      `VERDICT UNBACKED: ${f} says its affordance renders via ${viaFile}, which is not a ` +
        "registered HAS_SHOWS file bearing at least one affordance.",
    );
    return out;
  }
  if (!importsOf(f).has(viaFile)) {
    out.push(
      `RENDERS_VIA UNIMPORTED: ${f} claims its affordance renders via ${viaFile}, but ${f} ` +
        `does not import ${viaFile}.`,
    );
    return out;
  }
  const exported = componentExportsOf(viaFile);
  const code = stripComments(readFileSync(join(ROOT, f), "utf-8"));
  const rendered = new Set(openingTags(code).map((t) => t.name));
  for (const c of comps) {
    if (!exported.has(c)) {
      out.push(`RENDERS_VIA NOT EXPORTED: ${f} names <${c}>, which ${viaFile} does not export.`);
    } else if (!rendered.has(c)) {
      out.push(
        `RENDERS_VIA NOT RENDERED: ${f} names <${c}> from ${viaFile} but renders no <${c}> ` +
          "tag. Importing a component is not painting with it.",
      );
    }
  }
  // (4) COVERAGE — every figure this file paints must go through them.
  if (m.fmtSites > 0) {
    out.push(
      `RENDERS_VIA UNCOVERED: ${f} is HAS_SHOWS-via-${comps.join("/")} but spells ` +
        `${m.fmtSites} figure(s) itself through a formatter (${Object.keys(m.fmt).join(", ")}). ` +
        "A number this file formatted is a number no child can carry the provenance for. " +
        "Either thread the payload here, or the verdict is HAS_MISSING.",
    );
  }
  const uncovered = Object.keys(m.tags).filter((t) => !comps.includes(t));
  if (uncovered.length) {
    out.push(
      `RENDERS_VIA UNCOVERED: ${f} paints through <${uncovered.join(">, <")}>, which ` +
        `${comps.join("/")} cannot be answerable for. Name every component its figures go ` +
        "through, or the verdict is HAS_MISSING for the ones left over.",
    );
  }
  return out;
}

const PROVENANCE_ATTR = /(^|\s)provenance\s*=/;
const PROVENANCE_ATTR_NULL = /(^|\s)provenance\s*=\s*\{\s*(null|undefined)\s*\}/;

// ══════════════════════════════════════════════════════════════════════
// R1 — `bearing` COUNTS WHAT RENDERS, NOT WHAT IS TYPED
// ══════════════════════════════════════════════════════════════════════
//
// The first version credited a bearing site to EVERY <ProvenanceAffordance>
// tag before testing a single attribute, while the primitive branch below
// it tested `provenance=` and rejected an explicit null. Two consequences,
// both demonstrated against this tree on 2026-09-04:
//
//   · `provenance={null}` on four LIVE findings figures (ImpactRow ×2,
//     ThresholdMeter ×2) removed every dotted rule and every card on that
//     surface, and the gate printed units=76 — UNCHANGED — and PASS.
//   · three inert `<ProvenanceAffordance provenance={null}>` tags in a
//     module nothing renders PADDED 76 to 79 and the findings surface 10
//     to 13, so the same change that deleted the surface's provenance
//     reported MORE of it. Every floor in this gate was paddable with
//     tags that paint nothing.
//
// The counter now mirrors the component's own three early returns
// (Provenance.tsx: `hasProvenance`, `absent`, `isAbsentFigure`). A tag
// that the component would render as bare children is not a bearing site,
// whatever it is called. Where an attribute's value is an EXPRESSION the
// gate cannot evaluate (`provenance={x}`, `value={v}`), it counts — the
// gate refuses only what it can PROVE inert, so this can never silently
// under-count a real affordance.
const ABSENT_TRUE = /(^|\s)absent(\s*=\s*\{\s*true\s*\}|\s*(?=[/>\s])(?!\s*=))/;
const VALUE_ATTR_NULL = /(^|\s)value\s*=\s*\{\s*(null|undefined)\s*\}/;

/** Would <ProvenanceAffordance {...attrs}> paint a dotted rule and a
 *  card, or return its children bare? Mirrors Provenance.tsx exactly. */
function affordanceRenders(attrs) {
  if (!PROVENANCE_ATTR.test(attrs)) return false; // no payload prop at all
  if (PROVENANCE_ATTR_NULL.test(attrs)) return false; // !hasProvenance(null)
  if (ABSENT_TRUE.test(attrs)) return false; // explicit refusal
  if (VALUE_ATTR_NULL.test(attrs)) return false; // isAbsentFigure(null)
  return true;
}

/** A `toLocaleString` that spells a DATE, not a figure. Heuristic, and
 *  stated: the receiver is `new Date(…)`, or the call passes date
 *  options, or the receiver's leaf is a date-ish name. */
function isDateLocaleString(receiver, args) {
  if (/new\s+Date\s*\(/.test(receiver)) return true;
  if (/dateStyle|timeStyle|weekday|month|hour|minute/.test(args)) return true;
  const leaf = receiver.split(".").pop() ?? "";
  return /^(d|date|dt|when|ts|time|at|now|createdAt|updatedAt|uploadedAt)$/.test(leaf);
}

// ══════════════════════════════════════════════════════════════════════
// R4 — A LOCAL HELPER IS A FORMATTER, AND ITS CALLS ARE THE SITES
// ══════════════════════════════════════════════════════════════════════
//
// A component that declares `const fmt = (n) => …toFixed(1)…` and calls
// it on eight rows paints EIGHT figures. The first version counted the
// three native calls inside the declaration and nothing else, so the file
// measured 3 where it renders 8 — and every one of those eight is a site
// that must answer "does this payload carry provenance?".
//
// Measured on this tree 2026-09-04: ComprehensiveReport.tsx declares `fmt`
// (2 toFixed + 1 Intl.NumberFormat in its body) and `pct`, and calls them
// on 6 and 7 lines respectively; LearningPopover.tsx calls `formatValue`
// six times and measured 1.
//
// So: a local declaration whose body SPELLS A FIGURE (it calls a native or
// rostered formatter) and contains no JSX is itself a formatter. Its body
// is IMPLEMENTATION — masked out, so its internal calls are not sites —
// and its call sites are counted instead. Name-agnostic on purpose: `fmt`,
// `pct` and `nf` are not figure-shaped names, and a roster of names is the
// thing this gate keeps being broken by.
// ── R6, 2026-09-04 — SPELLING IS A BEHAVIOUR, NOT A NAME ─────────────
//
// The previous shape listed `fmt\w*` and eleven `format…` names, so a
// helper called `spellRon` or `money` was not a formatter as far as this
// gate was concerned. A critic's plant made that concrete: a file painting
// twelve figures through a local `money()` built on `Math.round` and a
// thousands-grouping regex measured ZERO sites and was not even counted as
// a producer. Nothing in that file is unusual — `Math.round` + a grouping
// regex is the most ordinary hand-rolled money formatter there is.
//
// So the test is now on the BODY: does this function turn a number into
// display text? Three ways, all behavioural:
//   · a native number formatter (toFixed / toLocaleString / Intl.NumberFormat)
//   · a THOUSANDS-GROUPING regex — `\B(?=(\d{3})+(?!\d))` and its variants,
//     the only reason anyone writes a lookahead over digit triples
//   · a call to a formatter already known to spell one (the roster below,
//     plus any local helper already classified — resolved iteratively)
// `NUMERIC_TEXT_RX` is deliberately not anchored on any NAME.
const GROUPING_REGEX =
  /\\B\(\?=\(\??:?\\d\{3\}\)|\\d\{1,3\}\(\?=\(\?:\\d\{3\}\)|\(\\d\)\(\?=\(\\d\{3\}\)\+/;
const NATIVE_SPELLING = /\.toFixed\s*\(|\.toLocaleString\s*\(|\bIntl\.NumberFormat\s*\(/;
const FIGURE_SPELLING = new RegExp(
  NATIVE_SPELLING.source +
    "|" +
    GROUPING_REGEX.source +
    "|\\b(?:formatRON|formatPercent|formatMoney|formatAmount|formatValue|formatCurrency|" +
    "formatRatio|formatNumber|formatCanonical\\w*|formatMoneyFrom|formatAmountFrom|fmt\\w*)\\s*\\(",
);

// ── R6 — THE BODY OF A DECLARATION, AND WHAT IT RETURNS ──────────────
//
// Both halves of behavioural discovery need the same two primitives: the
// span of a declaration's body, and the expressions it RETURNS. The
// distinction they draw is the one the census has to draw:
//
//   a FORMATTER  returns display text spelled from a number. Its CALLS
//                are figure render sites — `fmtX(v)` in a table cell
//                paints a figure, and every such call must answer for
//                its provenance.
//   a PRODUCER   spells figures somewhere inside and returns a STRUCTURE
//                (a statement object, a workbook, an HTML document). Its
//                own internal spellings are the sites, counted in its own
//                file; its call sites are not figures.
//
// Getting this backwards in either direction is a real cost: treat every
// producer as a formatter and `buildBSStatement()` becomes a "figure
// render site", which is noise; treat every formatter as a producer and a
// screenful of numbers measures zero — which is exactly what happened to
// CompareTray.tsx (16 figures, in no roster) and to the critic's
// `spellRon()` plant.

/** The body of a declaration whose name ends at `from`: `{ body, block }`.
 *  Handles a block body and an arrow expression body. Returns an empty
 *  body for a non-function declaration (`const X = [...]`), so an array of
 *  spec objects is never mistaken for a function that returns one. */
function bodySpanAt(code, from) {
  let i = from;
  let depth = 0;
  let guard = 0;
  while (i < code.length && guard < 4000) {
    guard += 1;
    const c = code[i];
    if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    else if (depth === 0 && (c === "[" || c === '"' || c === "'" || c === "`")) {
      return { body: "", block: false }; // a value, not a function
    } else if (depth === 0 && c === "{") {
      let d = 0;
      for (let j = i; j < code.length; j += 1) {
        if (code[j] === "{") d += 1;
        else if (code[j] === "}") {
          d -= 1;
          if (d === 0) return { body: code.slice(i, j + 1), block: true };
        }
      }
      return { body: code.slice(i), block: true };
    } else if (depth === 0 && code.startsWith("=>", i)) {
      let d = 0;
      let j = i + 2;
      for (; j < code.length; j += 1) {
        const q = code[j];
        if ("([{".includes(q)) d += 1;
        else if (")]}".includes(q)) {
          if (d === 0) break;
          d -= 1;
        } else if (q === ";" && d === 0) break;
      }
      return { body: code.slice(i + 2, j), block: false };
    }
    i += 1;
  }
  return { body: "", block: false };
}

/** Blank out every nested function body, so a `return` belonging to an
 *  inner callback is not read as this function's own. */
function maskNestedBodies(body) {
  let out = body;
  const rx = /=>\s*\{|\bfunction\s*[\w$]*\s*\([^)]*\)\s*\{/g;
  const spans = [];
  let m;
  while ((m = rx.exec(out)) !== null) {
    const open = out.indexOf("{", m.index);
    if (open < 0) break;
    let d = 0;
    let j = open;
    for (; j < out.length; j += 1) {
      if (out[j] === "{") d += 1;
      else if (out[j] === "}") {
        d -= 1;
        if (d === 0) {
          j += 1;
          break;
        }
      }
    }
    spans.push([open, j]);
    rx.lastIndex = j;
  }
  for (const [a, b] of spans.reverse()) out = out.slice(0, a) + " ".repeat(b - a) + out.slice(b);
  return out;
}

/** Blank out `toLocaleString` calls that spell a DATE, so a helper that
 *  formats a timestamp is not read as a figure formatter. Without this,
 *  NotificationsMenu's `d.toLocaleString(locale, {dateStyle, timeStyle})`
 *  and IndustryAuditTrail's audit-time helper were both discovered as
 *  figure formatters and their call sites demanded a provenance verdict
 *  for a clock reading. */
function maskDateSpellings(expr) {
  return expr.replace(
    /([\w$.\])]+(?:\([^()]*\))?)\.toLocaleString\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g,
    (whole, receiver, args) =>
      isDateLocaleString(receiver, args) ? " ".repeat(whole.length) : whole,
  );
}

/** The first RETURN expression that itself spells a figure, or null. An
 *  object/array literal is a structure; a template carrying HTML tags is a
 *  document. Neither is display text for one number. */
function returnsFigureText({ body, block }) {
  const exprs = [];
  if (!block) exprs.push(body);
  else {
    const masked = maskNestedBodies(body);
    const rx = /\breturn\b/g;
    let m;
    while ((m = rx.exec(masked)) !== null) {
      let d = 0;
      let j = m.index + 6;
      for (; j < masked.length; j += 1) {
        const q = masked[j];
        if ("([{".includes(q)) d += 1;
        else if (")]}".includes(q)) {
          if (d === 0) break;
          d -= 1;
        } else if (q === ";" && d === 0) break;
      }
      exprs.push(masked.slice(m.index + 6, j));
    }
  }
  for (const raw of exprs) {
    const e = raw.trim();
    if (!e) continue;
    if (/^[{[]/.test(e)) continue; // a structure
    if (/<\/?[a-z][a-z0-9]*[\s>]/.test(e)) continue; // an HTML document
    const noDates = maskDateSpellings(e);
    if (FIGURE_SPELLING.test(noDates)) return e.slice(0, 70).replace(/\s+/g, " ");
  }
  return null;
}

/** Every exported declaration under frontend/, with its body — the raw
 *  material both behavioural sweeps read. */
function* exportedDeclarations() {
  for (const abs of walk(FE)) {
    const f = rel(abs);
    if (isTest(f)) continue;
    const code = stripComments(readFileSync(abs, "utf-8"));
    const rx = /\bexport\s+(?:default\s+)?(?:function|const)\s+([A-Za-z_$][\w$]*)/g;
    let m;
    while ((m = rx.exec(code)) !== null) {
      yield { file: f, name: m[1], code, at: m.index, body: bodySpanAt(code, rx.lastIndex) };
    }
  }
}

/** R6 — DISCOVERY BY BEHAVIOUR. Name-agnostic: any exported function that
 *  paints no JSX and RETURNS display text spelled from a number. */
function discoverFormatters() {
  const out = new Map();
  for (const d of exportedDeclarations()) {
    if (!d.body.body) continue;
    if (/<[A-Za-z][A-Za-z0-9_.]*[\s/>]/.test(d.body.body)) continue; // a component
    const why = returnsFigureText(d.body);
    if (!why) continue;
    if (!out.has(d.name)) out.set(d.name, { file: d.file, why });
  }
  return out;
}

/** Local `const NAME = (…) => …` / `function NAME(…)` declarations whose
 *  body spells a figure and paints no JSX. Returns name + body span. */
function localFigureHelpers(code) {
  const out = [];
  // Both declaration forms. R6 fix: `function NAME(` used to have its body
  // read from just after the `(`, so the scanner saw `n: number` and every
  // `function`-form helper in the tree measured as spelling nothing. That
  // is exactly the half of the A4 plant that stayed invisible — a local
  // `money()` built on Math.round and a grouping regex, painting six
  // figures, counted as zero. `bodySpanAt` walks the parameter list.
  const rx =
    /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]{0,120})?=(?=\s*(?:async\s*)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=>]{0,120})?=>)|(?:export\s+)?function\s+([A-Za-z_$][\w$]*)(?=\s*\()/g;
  let m;
  while ((m = rx.exec(code)) !== null) {
    const name = m[1] ?? m[2];
    const span = bodySpanAt(code, rx.lastIndex);
    if (!span.body) continue;
    const start = code.indexOf(span.body, rx.lastIndex);
    if (start < 0) continue;
    const end = start + span.body.length;
    const body = maskDateSpellings(span.body);
    if (!FIGURE_SPELLING.test(body)) continue;
    if (/<[A-Za-z][A-Za-z0-9_.]*[\s/>]/.test(body)) continue; // paints JSX: its tags are the sites
    // R6: a local helper is a FORMATTER only when it RETURNS display text.
    // An event handler or an effect whose body happens to call `.toFixed`
    // is implementation sitting in the component file — masking its body
    // and counting its calls would both lose real sites and invent fake
    // ones (`onFileChosen()×4` was measured that way).
    if (!returnsFigureText(span)) continue;
    // Mask from the DECLARATION, not from the body: `function money(` is
    // itself a `money(` match, so a function-form helper counted its own
    // declaration as a seventh call site (measured on the A4 plant: 13
    // where the file paints 12).
    out.push({ name, start: m.index, end });
  }
  return out;
}

/** Formatter CALL sites in a file (declarations excluded). */
function formatterSites(code) {
  let n = 0;
  const detail = Object.create(null);
  const bump = (k, by = 1) => {
    if (!by) return;
    n += by;
    detail[k] = (detail[k] ?? 0) + by;
  };

  // useAmountFormatter binds a function; count the CALLS of that binding.
  const bindRx = /\b(?:const|let)\s+(\w+)\s*=\s*useAmountFormatter\s*\(/g;
  const bound = new Set();
  let b;
  while ((b = bindRx.exec(code)) !== null) bound.add(b[1]);
  for (const name of bound) {
    const calls = code.match(new RegExp(`(?<![\\w.])${name}\\s*\\(`, "g")) ?? [];
    bump("useAmountFormatter", calls.length);
  }
  if (bound.size === 0) {
    const hookCalls = code.match(/(?<!function\s)(?<![\w.])useAmountFormatter\s*\(/g) ?? [];
    bump("useAmountFormatter", hookCalls.length);
  }

  for (const name of countedFormatterNames()) {
    if (name === "useAmountFormatter") continue;
    if (NOT_A_FIGURE_FORMATTER.has(name)) continue;
    const calls = code.match(new RegExp(`(?<!function\\s)(?<![\\w.])${name}\\s*\\(`, "g")) ?? [];
    bump(name, calls.length);
  }

  bump("toFixed", (code.match(/\.toFixed\s*\(/g) ?? []).length);

  const lsRx = /([\w$.\])]+(?:\([^()]*\))?)\.toLocaleString\s*\(([^)]*)\)/g;
  let ls;
  let lsCount = 0;
  while ((ls = lsRx.exec(code)) !== null) {
    if (!isDateLocaleString(ls[1], ls[2])) lsCount += 1;
  }
  bump("toLocaleString", lsCount);

  bump("Intl.NumberFormat", (code.match(/\bIntl\.NumberFormat\s*\(/g) ?? []).length);

  return { n, detail };
}

function measure(src, isTsx) {
  const code = stripComments(src);
  const tags = Object.create(null);
  let tagSites = 0;
  let bearing = 0;
  // An affordance tag that paints nothing. `absent` / `absent={true}` is a
  // LEGITIMATE refusal (a formatted range, a string — the prop exists for
  // it), so it is merely counted. A literal `provenance={null}` or a tag
  // with no `provenance` prop at all is DEAD: it can never paint, on any
  // input, so it is decoration — and decoration is exactly what padded
  // this gate's floors. That one fails.
  let inertAffordances = 0;
  let deadAffordances = 0;
  // R7 — WHICH PRIMITIVE bears, and WHERE. The witness requirement below
  // is derived from this: a primitive the census credits with a bearing
  // site must be proven, by RENDER, to actually paint one.
  const bearingTags = Object.create(null);
  const bearingAt = [];
  if (isTsx) {
    for (const tag of openingTags(code)) {
      if (tag.name === AFFORDANCE_TAG) {
        // R1: the tag is not the affordance — the RENDER is.
        if (affordanceRenders(tag.attrs)) {
          bearing += 1;
          bearingTags[tag.name] = (bearingTags[tag.name] ?? 0) + 1;
          bearingAt.push({ name: tag.name, index: tag.index });
        } else {
          inertAffordances += 1;
          if (!PROVENANCE_ATTR.test(tag.attrs) || PROVENANCE_ATTR_NULL.test(tag.attrs))
            deadAffordances += 1;
        }
        continue;
      }
      if (!PRIMITIVES[tag.name]) continue;
      tags[tag.name] = (tags[tag.name] ?? 0) + 1;
      tagSites += 1;
      if (affordanceRenders(tag.attrs)) {
        bearing += 1;
        bearingTags[tag.name] = (bearingTags[tag.name] ?? 0) + 1;
        bearingAt.push({ name: tag.name, index: tag.index });
      }
    }
  }
  // R4: a local figure helper's body is implementation, its calls are the
  // sites. Mask the bodies, then count the calls in what is left.
  const helpers = localFigureHelpers(code);
  let masked = code;
  for (const h of helpers) {
    masked =
      masked.slice(0, h.start) +
      masked.slice(h.start, h.end).replace(/[^\n]/g, " ") +
      masked.slice(h.end);
  }
  const fmt = formatterSites(masked);
  for (const h of helpers) {
    const calls = masked.match(new RegExp(`(?<![\\w.$])${h.name}\\s*\\(`, "g")) ?? [];
    if (calls.length) {
      fmt.n += calls.length;
      fmt.detail[`${h.name}()`] = (fmt.detail[`${h.name}()`] ?? 0) + calls.length;
    }
  }
  // A helper can ESCAPE into a lookup table and be called through it:
  // GeographicMapPanel.tsx binds `fmtRon`/`fmtPct`/`fmtInt` into
  // `METRICS[k].fmt` / `.cofmt` and paints four figures as
  // `METRICS[metric].fmt(…)`. Masking the bodies without this left the
  // file measuring ZERO sites and the gate calling its live entry STALE —
  // an under-count is the one direction a census must never drift, so the
  // property a helper is bound to is followed to its call sites.
  const aliases = new Set();
  for (const h of helpers) {
    for (const m of masked.matchAll(
      new RegExp(`([A-Za-z_$][\\w$]*)\\s*:\\s*${h.name}\\s*(?=[,}\\n])`, "g"),
    ))
      aliases.add(m[1]);
  }
  for (const a of aliases) {
    const calls = masked.match(new RegExp(`\\.${a}\\s*\\(`, "g")) ?? [];
    if (calls.length) {
      fmt.n += calls.length;
      fmt.detail[`.${a}()`] = (fmt.detail[`.${a}()`] ?? 0) + calls.length;
    }
  }
  return {
    sites: tagSites + fmt.n,
    tagSites,
    fmtSites: fmt.n,
    bearing,
    inertAffordances,
    deadAffordances,
    tags,
    bearingTags,
    bearingAt,
    fmt: fmt.detail,
  };
}

// ══════════════════════════════════════════════════════════════════════
// R7 — A TAG NOBODY RENDERS IS NOT AN AFFORDANCE
// ══════════════════════════════════════════════════════════════════════
//
// The floors could be PADDED. A critic exported one component holding four
// `<FigureValue provenance={…}>` tags with real payload expressions,
// referenced it from nowhere, deleted four REAL findings affordances, and
// the census printed units=76 and the findings surface unchanged. Every
// number this gate publishes was purchasable with code that renders on no
// screen.
//
// `affordanceRenders()` refuses only what it can PROVE inert from the
// tag's own attributes; unreachable code is inert for a reason the tag
// cannot show. So reachability is measured separately, and narrowly
// enough to be PROVABLE: the component declaration enclosing a bearing tag
// must be NAMED somewhere else — rendered as a tag, imported, exported in
// a list, referenced in a lazy import. A component whose name appears
// nowhere in the tree outside its own declaration paints on no screen, in
// any router, under any feature flag.

/** The component declaration enclosing `index`: the last capitalised
 *  `function NAME` / `const NAME =` at or before it. */
function enclosingComponent(code, index) {
  const rx = /\b(?:export\s+)?(?:default\s+)?(?:function|const)\s+([A-Z][\w$]*)/g;
  let best = null;
  let m;
  while ((m = rx.exec(code)) !== null) {
    if (m.index > index) break;
    best = m[1];
  }
  return best;
}

/** Every occurrence of `name` as an identifier across the frontend,
 *  excluding the file it is declared in. Tests count: a component only a
 *  test renders is not in the product, but it is not padding either — it
 *  is reported separately. */
function referencesOf(name, declaredIn, allSources) {
  const rx = new RegExp(`(?<![\\w$.])${name}(?![\\w$])`, "g");
  let product = 0;
  let test = 0;
  for (const [f, code] of allSources) {
    if (f === declaredIn) continue;
    const n = (code.match(rx) ?? []).length;
    if (!n) continue;
    if (isTest(f)) test += n;
    else product += n;
  }
  return { product, test };
}

// ══════════════════════════════════════════════════════════════════════
// ANTIBODY 1 — A PERIOD IN THE FIELD THE CARD LABELS "SOURCE"
// ══════════════════════════════════════════════════════════════════════
//
// The shape that shipped: `{ source: fact.periodLabel || … }`. The card
// renders that field under "Source"; a period is not a source. The first
// antibody matched the identifier. A literal ("FY2025") and a cast
// (`fact.periodLabel as string`) walked past it, so this one matches the
// VALUE: every operand of every `??` / `||`, every ternary ARM, casts
// stripped, literals and template literals tested for a period shape,
// identifier chains tested on their leaf.

/** Names that are NOT a source, however they are reached. Matched on the
 *  LEAF of a property chain, so `period.source` (the period's own source
 *  field — legitimate, live in lib/canonicalMetrics.ts) does not trip
 *  while `fact.periodLabel` does. */
const NOT_A_SOURCE = new Set([
  "period",
  "periodlabel",
  "period_label",
  "periodlabels",
  "periodid",
  "period_id",
  "periodend",
  "period_end",
  "fiscalyear",
  "fiscal_year",
  "fiscalperiod",
  "fiscal_period",
  "fiscal_period_end",
  "fiscalperiodend",
  "year",
  "quarter",
  "month",
  "date",
  "asof",
  "as_of",
  "asofdate",
  "scope",
  "label",
  "title",
]);

/** A string that IS a period: FY2025, FY 25, 2025, Q4 2025, H1 2025,
 *  Dec 2025, December 2025, 2025-12, 2025-12-31, 12/2025, 31.12.2025. */
const PERIOD_LITERAL =
  /^\s*(FY\s?'?\d{2,4}|\d{4}|[QH][1-4]\s?\d{4}|(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|Ian|Mai|Iun|Iul|Noi)[a-z]*\.?\s+\d{4}|\d{4}-\d{2}(-\d{2})?|\d{1,2}[/.]\d{4}|\d{1,2}\.\d{1,2}\.\d{4})\s*$/i;

/** The expression after `source:` up to the field's end, brace/paren/
 *  quote-aware so `source: [doc, path].filter(Boolean).join(" · ")` is
 *  one operand and a comma inside a string does not end it. */
function fieldExpression(code, start) {
  let depth = 0;
  let quote = null;
  let i = start;
  for (; i < code.length; i += 1) {
    const c = code[i];
    if (quote) {
      if (c === "\\") {
        i += 1;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) break;
      depth -= 1;
    } else if (c === "," && depth === 0) break;
    else if (c === ";" && depth === 0) break;
  }
  return code.slice(start, i);
}

/** Split at depth 0 on a set of two-character or one-character tokens,
 *  quote-aware. Returns the pieces (trimmed, non-empty). */
function splitTop(expr, isSplit) {
  const out = [];
  let depth = 0;
  let quote = null;
  let cur = "";
  for (let i = 0; i < expr.length; i += 1) {
    const c = expr[i];
    const two = expr.slice(i, i + 2);
    if (quote) {
      cur += c;
      if (c === "\\") {
        cur += expr[i + 1] ?? "";
        i += 1;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      cur += c;
      continue;
    }
    if ("([{".includes(c)) depth += 1;
    if (")]}".includes(c)) depth -= 1;
    if (depth === 0) {
      const w = isSplit(c, two);
      if (w) {
        out.push(cur);
        cur = "";
        i += w - 1;
        continue;
      }
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Index of the first depth-0, outside-quotes character satisfying
 *  `pred(c, two)`, or -1. */
function topIndexOf(expr, pred) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < expr.length; i += 1) {
    const c = expr[i];
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if ("([{".includes(c)) depth += 1;
    else if (")]}".includes(c)) depth -= 1;
    else {
      const two = expr.slice(i, i + 2);
      if (depth === 0 && pred(c, two)) return i;
      // `??` and `?.` are one token: the second character must not be
      // re-read as a ternary `?`. The L1 plant (`source: periodLabel ??
      // undefined`) walked past this antibody until it was.
      if (two === "??" || two === "?.") i += 1;
    }
  }
  return -1;
}
const isTernaryQ = (c, two) => c === "?" && two !== "?." && two !== "??";

/** The VALUE operands of a field expression: `??` / `||` operands, and
 *  for a ternary both ARMS — the condition decides which arm is the
 *  value and is not itself one (`source: fact.periodLabel ? a : b` is
 *  judged on `a` and `b`; `a ? b : c ? d : e` on b, d and e). The first
 *  draft of this rebuilt the arm text from a trimmed piece and lost the
 *  `?` itself, so a period in a ternary arm walked past — caught by the
 *  A1-ternary plant, not by reading. */
function valueOperands(expr) {
  const q = topIndexOf(expr, isTernaryQ);
  let arms = [expr];
  if (q !== -1) {
    const rest = expr.slice(q + 1);
    const col = topIndexOf(rest, (c) => c === ":");
    arms = col === -1 ? [rest] : [rest.slice(0, col), rest.slice(col + 1)];
    arms = arms.flatMap((a) => (topIndexOf(a, isTernaryQ) !== -1 ? valueOperands(a) : [a]));
  }
  return arms.flatMap((arm) => splitTop(arm, (c, two) => (two === "??" || two === "||" ? 2 : 0)));
}

/** Strip the shapes a cast hides behind: `x as string`, `x!`, `<string>x`,
 *  `String(x)`, `x.toString()`, `x.trim()`, `(x)`. */
function stripCasts(expr) {
  let e = expr.trim();
  for (let k = 0; k < 6; k += 1) {
    const before = e;
    e = e.replace(/\s+as\s+(const|[\w.<>|\[\]\s]+)$/i, "");
    e = e.replace(/^<[\w.<>|\[\]\s]+>\s*/, "");
    e = e.replace(/!+$/, "");
    e = e.replace(/^String\s*\((.*)\)$/s, "$1");
    e = e.replace(/\.(toString|trim|toUpperCase|toLowerCase)\(\)$/, "");
    e = e.replace(/^\((.*)\)$/s, "$1");
    e = e.trim();
    if (e === before) break;
  }
  return e;
}

function periodShapedOperand(op) {
  const e = stripCasts(op);
  // A plain string literal.
  const str = /^(["'])(.*)\1$/s.exec(e);
  if (str) return PERIOD_LITERAL.test(str[2]) ? `literal "${str[2]}"` : null;
  // A template literal: its literal text, and every interpolation.
  const tpl = /^`(.*)`$/s.exec(e);
  if (tpl) {
    const parts = tpl[1].split(/\$\{([^}]*)\}/);
    const text = parts.filter((_, i) => i % 2 === 0).join("");
    if (PERIOD_LITERAL.test(text)) return `template \`${tpl[1]}\``;
    for (let i = 1; i < parts.length; i += 2) {
      const inner = periodShapedOperand(parts[i]);
      if (inner) return `template interpolates ${inner}`;
    }
    return null;
  }
  // An identifier chain — judge its leaf.
  if (/^[\w$.?\[\]"'`]+$/.test(e)) {
    const leaf = e
      .replace(/\[[^\]]*\]/g, "")
      .split(/[.?]/)
      .filter(Boolean)
      .pop();
    if (leaf && NOT_A_SOURCE.has(leaf.toLowerCase())) return `identifier ${e}`;
  }
  return null;
}

function fabrications(src) {
  const code = stripComments(src);
  const out = [];
  const rx = /(?<![\w.?])source\s*:\s*/g;
  let m;
  while ((m = rx.exec(code)) !== null) {
    const expr = fieldExpression(code, rx.lastIndex);
    for (const op of valueOperands(expr)) {
      const why = periodShapedOperand(op);
      if (why) {
        const line = code.slice(0, m.index).split("\n").length;
        out.push({ line, text: `source: ${op.trim()}`.slice(0, 90), why });
      }
    }
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════
// ANTIBODY 2 — A ZERO WEARING A SOURCE
// ══════════════════════════════════════════════════════════════════════
//
// `val: -(pl.cogs ?? 0), origin: neg("cogs")` renders "0" with a Source
// when the field is absent — a figure the payload never carried, wearing
// the origin of one it did. Matched in two shapes: an object literal
// whose `value`/`val` field is fed by `?? 0` / `|| 0` and which also
// carries an `origin`/`provenance` field (multi-line rows included), and
// a figure tag whose `value=` attribute does the same beside a
// `provenance=` attribute. ABSENT is not ZERO; the fix is to render plain
// (or nothing) when the field is missing.

const ZERO_FALLBACK = /(\?\?|\|\|)\s*0(?![\d.])/;

/** The object literal that ENCLOSES index `at`: the span between the
 *  nearest unmatched `{` before it and that brace's match. */
function enclosingObject(code, at) {
  let depth = 0;
  let open = -1;
  for (let i = at; i >= 0; i -= 1) {
    const c = code[i];
    if (c === "}") depth += 1;
    else if (c === "{") {
      if (depth === 0) {
        open = i;
        break;
      }
      depth -= 1;
    }
  }
  if (open < 0) return "";
  depth = 0;
  for (let i = open; i < code.length; i += 1) {
    const c = code[i];
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return code.slice(open, i + 1);
    }
  }
  return code.slice(open);
}

function zeroWearsSource(src) {
  const code = stripComments(src);
  const out = [];
  const lineOf = (idx) => code.slice(0, idx).split("\n").length;

  // Shape 1: an object literal's value field.
  const fieldRx = /(?<![\w.])(val|value)\s*:\s*/g;
  let m;
  while ((m = fieldRx.exec(code)) !== null) {
    const expr = fieldExpression(code, fieldRx.lastIndex);
    if (!ZERO_FALLBACK.test(expr)) continue;
    const obj = enclosingObject(code, m.index);
    const wears = /(?<![\w.])(origin|provenance)\s*:/.exec(obj);
    if (!wears) continue;
    out.push({
      line: lineOf(m.index),
      text: `${m[1]}: ${expr.trim().replace(/\s+/g, " ")} … ${wears[1]}:`.slice(0, 110),
    });
  }
  // Shape 2: a figure tag — or the affordance itself, now that it takes
  // the figure's `value` in order to refuse an absent one.
  for (const tag of openingTags(code)) {
    if (!PRIMITIVES[tag.name] && tag.name !== AFFORDANCE_TAG) continue;
    if (!PROVENANCE_ATTR.test(tag.attrs) || PROVENANCE_ATTR_NULL.test(tag.attrs)) continue;
    const v = /(^|\s)value\s*=\s*\{([^}]*)\}/.exec(tag.attrs);
    if (v && ZERO_FALLBACK.test(v[2])) {
      out.push({
        line: lineOf(tag.index),
        text: `<${tag.name} value={${v[2].trim()}} … provenance=`.slice(0, 110),
      });
    }
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════
// RUN
// ══════════════════════════════════════════════════════════════════════

let registry;
try {
  registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
} catch (e) {
  console.error(`PROVENANCE CENSUS\n${"=".repeat(62)}`);
  console.error(`FAIL — cannot read ${rel(REGISTRY_PATH)}: ${e.message}`);
  process.exit(1);
}
const entries = new Map(Object.entries(registry.sites ?? {}));

const measured = new Map();
const producers = new Map();
let filesWalked = 0;
const fabricationHits = [];
const zeroHits = [];

// --probe-vacuity: empty the gate's own discovery and REQUIRE a failure.
// A self-test that cannot fail is a fourth instrument examining nothing
// (TC-9). The gate DOES red on empty discovery; this proves it.
const PROBE_VACUITY = process.argv.includes("--probe-vacuity");
// R6 — behaviour-discovered formatters, BEFORE the walk that counts calls.
if (!PROBE_VACUITY) AUTO_FORMATTERS = discoverFormatters();
if (process.argv.includes("--dump-formatters")) {
  console.log("  behaviour-discovered formatters:");
  for (const [n, d] of [...AUTO_FORMATTERS].sort())
    console.log(`     ${n.padEnd(24)} ${d.file}  →  ${d.why}`);
}
/** Every source in the tree, tests included — the reference index R7 reads.
 *  Comments stripped, so a name that only appears in prose is not a
 *  reference (this codebase names its components in comments constantly). */
const allSources = new Map();
for (const abs of PROBE_VACUITY ? [] : walk(FE)) {
  filesWalked += 1;
  const f = rel(abs);
  const raw = readFileSync(abs, "utf-8");
  allSources.set(f, stripComments(raw));
  if (isTest(f)) continue;
  const src = raw;
  const isTsx = f.endsWith(".tsx");
  const m = measure(src, isTsx);
  if (isTsx) {
    if (m.sites > 0 || m.bearing > 0) measured.set(f, m);
  } else if (m.sites > 0) {
    producers.set(f, m);
  }
  for (const hit of fabrications(src)) fabricationHits.push({ file: f, ...hit });
  for (const hit of zeroWearsSource(src)) zeroHits.push({ file: f, ...hit });
}

// --dump <path>: write the measured map as JSON (re-deriving the registry
// starts from the measurement, never from memory).
const dumpAt = process.argv.indexOf("--dump");
if (dumpAt !== -1 && process.argv[dumpAt + 1]) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    process.argv[dumpAt + 1],
    JSON.stringify(
      { measured: Object.fromEntries(measured), producers: Object.fromEntries(producers) },
      null,
      2,
    ),
  );
  console.log(`  measurement dumped to ${process.argv[dumpAt + 1]}`);
}

const sum = (map, key) => [...map.values()].reduce((a, b) => a + b[key], 0);
const totalSites = sum(measured, "sites");
const totalBearing = sum(measured, "bearing");
const totalProducerSites = sum(producers, "sites");
/** R8 — the DERIVED floor: what the registry itself says the product has.
 *  Summed over registered files only, so a stale entry cannot inflate it
 *  (STALE ENTRY reds separately). */
const registryAffordanceTotal = [...entries]
  .filter(([f]) => measured.has(f))
  .reduce((a, [, e]) => a + (e.affordances ?? 0), 0);

console.log("PROVENANCE CENSUS");
console.log("=".repeat(62));
console.log(
  `GATE-WORK provenance-census units=${measured.size} floor=${FLOOR_REGISTERED} ` +
    "label=tsx-files-rendering-figures",
);
console.log(
  `GATE-WORK provenance-sites units=${totalSites} floor=${FLOOR_SITES} ` +
    "label=figure-render-sites (primitive tags + formatter calls)",
);
console.log(
  `GATE-WORK provenance-affordances units=${totalBearing} ` +
    `floor=${RATCHET_AFFORDANCES} label=affordance-bearing-sites (one per rendering tag; ` +
    `ratchet is EXACT — derived registry total ${registryAffordanceTotal})`,
);
console.log(
  `GATE-WORK provenance-producers units=${producers.size} floor=${FLOOR_PRODUCERS} ` +
    `label=ts-figure-string-producers (${totalProducerSites} call sites; not DOM, not registered)`,
);
console.log(`  ${filesWalked} frontend file(s) walked`);
console.log(
  `  primitives rostered: ${Object.keys(PRIMITIVES).length} tags + ` +
    `${Object.keys(FORMATTERS).length} formatters + ${NATIVE_FORMATTERS.length} natives; ` +
    `${AUTO_FORMATTERS.size} formatter(s) discovered by BEHAVIOUR this run ` +
    "(--dump-formatters names each with the return expression that classified it)",
);

const failures = [];

// ── the roster is verified against source, every run ───────────────────
function declares(file, name) {
  if (!existsSync(join(ROOT, file))) return false;
  const code = stripComments(readFileSync(join(ROOT, file), "utf-8"));
  return new RegExp(`(^|\\n)\\s*(export\\s+)?(default\\s+)?(function|const)\\s+${name}\\b`).test(code);
}
if (!PROBE_VACUITY) {
  for (const [name, spec] of Object.entries(PRIMITIVES)) {
    for (const home of spec.homes) {
      if (!declares(home, name)) {
        failures.push(
          `PRIMITIVE ROSTER STALE: ${name} is not declared in ${home}. Discovery counts a ` +
            "primitive it can no longer find in source; correct the roster.",
        );
      }
    }
  }
  for (const [name, home] of Object.entries(FORMATTERS)) {
    if (!declares(home, name)) {
      failures.push(`FORMATTER ROSTER STALE: ${name} is not declared in ${home}.`);
    }
  }
  // A figure-shaped export in a primitive home that nobody rostered.
  const homeFiles = [];
  for (const h of PRIMITIVE_HOMES) {
    const abs = join(ROOT, h);
    if (!existsSync(abs)) {
      failures.push(`PRIMITIVE HOME MISSING: ${h} is not on disk.`);
      continue;
    }
    if (statSync(abs).isDirectory()) {
      for (const p of walk(abs)) if (!isTest(rel(p))) homeFiles.push(p);
    } else homeFiles.push(abs);
  }
  const rostered = new Set([...Object.keys(PRIMITIVES), ...Object.keys(FORMATTERS)]);
  for (const abs of homeFiles) {
    const code = stripComments(readFileSync(abs, "utf-8"));
    const rx = /\bexport\s+(?:default\s+)?(?:function|const)\s+([A-Z]\w*)/g;
    let m;
    while ((m = rx.exec(code)) !== null) {
      const name = m[1];
      if (rostered.has(name) || NOT_A_FIGURE.has(name)) continue;
      if (!FIGURE_NAME.test(name)) continue;
      failures.push(
        `UNROSTERED PRIMITIVE: ${rel(abs)} exports ${name}, a figure-shaped component the ` +
          "census cannot count. Add it to PRIMITIVES (or NOT_A_FIGURE with a reason).",
      );
    }
  }

  // ── R3: THE FORMATTER SWEEP IS OVER THE WHOLE FRONTEND ───────────────
  //
  // Not seven directories, and not capitalised names only. Any exported
  // `fmt…` / `format…` ANYWHERE under frontend/ whose body actually spells
  // a figure (a native formatter, or a rostered formatter it delegates to)
  // must be rostered in FORMATTERS or excused in NOT_A_FIGURE_FORMATTER
  // with a reason. This is the check that makes the roster self-widening:
  // the twenty-one entries added above were found BY this sweep, not by
  // reading files and hoping.
  for (const abs of walk(FE)) {
    const f = rel(abs);
    if (isTest(f)) continue;
    const code = stripComments(readFileSync(abs, "utf-8"));
    const rx = /\bexport\s+(?:default\s+)?(?:function|const)\s+((?:fmt|format)[A-Za-z0-9_$]*)/g;
    let m;
    while ((m = rx.exec(code)) !== null) {
      const name = m[1];
      if (rostered.has(name) || NOT_A_FIGURE_FORMATTER.has(name)) continue;
      const tail = code.slice(m.index, m.index + 1600);
      if (!FIGURE_SPELLING.test(tail)) continue;
      failures.push(
        `UNROSTERED FORMATTER: ${f} exports ${name}, which spells a figure the census ` +
          "cannot count. Add it to FORMATTERS (or NOT_A_FIGURE_FORMATTER with a reason). " +
          "A formatter nobody rosters is a screenful of figures with no provenance verdict — " +
          "CompareTray.tsx rendered 16 that way, in no roster and no floor.",
      );
    }
  }
}

// ── discovery floors ───────────────────────────────────────────────────
if (filesWalked < FLOOR_FILES) {
  failures.push(
    `DISCOVERY BROKEN: walked ${filesWalked} files, floor ${FLOOR_FILES}. ` +
      "A census that finds nothing is broken, not clean.",
  );
}
if (totalSites < FLOOR_SITES) {
  failures.push(`DISCOVERY BROKEN: found ${totalSites} figure sites, floor ${FLOOR_SITES}.`);
}
if (measured.size < FLOOR_REGISTERED) {
  failures.push(
    `DISCOVERY BROKEN: ${measured.size} files render figures, floor ${FLOOR_REGISTERED}.`,
  );
}
if (totalBearing < RATCHET_AFFORDANCES) {
  failures.push(
    `AFFORDANCE RATCHET: ${totalBearing} affordance-bearing sites, ratchet ` +
      `${RATCHET_AFFORDANCES} (EXACT, no headroom). ${RATCHET_AFFORDANCES - totalBearing} ` +
      "affordance(s) the product had are gone. Updating the registry does not answer this: " +
      "the registry records what the tree says today, and the ratchet records what it had. " +
      "If the retirement is intended, lower RATCHET_AFFORDANCES and name which figure lost " +
      "its provenance and why.",
  );
}
if (totalBearing > RATCHET_AFFORDANCES) {
  console.log(
    `  NOTE: ${totalBearing} affordances measured, ratchet ${RATCHET_AFFORDANCES} — raise it ` +
      "to lock the gain in.",
  );
}
if (!PROBE_VACUITY && registryAffordanceTotal !== totalBearing) {
  failures.push(
    `DERIVED FLOOR: the registry declares ${registryAffordanceTotal} affordance-bearing ` +
      `site(s) in total, the tree measures ${totalBearing}. The registry is the derived ` +
      "floor and it has no headroom by construction; the per-file COUNT DRIFT findings " +
      "above name which files disagree.",
  );
}
if (producers.size < FLOOR_PRODUCERS) {
  failures.push(
    `DISCOVERY BROKEN: ${producers.size} .ts figure producers, floor ${FLOOR_PRODUCERS}.`,
  );
}
for (const c of CANARIES) {
  if (!measured.has(c)) {
    failures.push(`DISCOVERY BROKEN: canary not seen — ${c} renders no figure.`);
  }
}

// ── the buckets, two-sided ─────────────────────────────────────────────
const buckets = {
  HAS_SHOWS: [],
  HAS_MISSING: [],
  LACKS_SILENT: [],
  LACKS_SHOWS: [],
  UNAUDITED: [],
};
const bucketOf = new Map();
for (const [f, m] of [...measured].sort()) {
  const e = entries.get(f);
  if (!e) {
    failures.push(
      `UNREGISTERED: ${f} renders ${m.sites} figure site(s) (${m.tagSites} tags, ` +
        `${m.fmtSites} formatter calls) and carries no provenance verdict. Add it to ` +
        "design_review/PROVENANCE_CENSUS.json with one of HAS_SHOWS / HAS_MISSING / " +
        "LACKS_SILENT / LACKS_SHOWS and a one-line reason.",
    );
    continue;
  }
  if (!buckets[e.bucket]) {
    failures.push(`${f}: unknown bucket "${e.bucket}".`);
    continue;
  }
  buckets[e.bucket].push(f);
  bucketOf.set(f, e.bucket);
  if (e.affordances !== m.bearing) {
    failures.push(
      `COUNT DRIFT: ${f} declares ${e.affordances} affordance-bearing site(s), ` +
        `measured ${m.bearing}. Either the change is intended (update the entry ` +
        "and re-state the verdict) or a figure lost its provenance.",
    );
  }
  if (e.sites !== m.sites) {
    failures.push(
      `COUNT DRIFT: ${f} declares ${e.sites} figure site(s), measured ${m.sites} ` +
        `(${m.tagSites} tags + ${m.fmtSites} formatter calls). A new figure needs a ` +
        "provenance verdict before it ships.",
    );
  }
  if (e.bucket === "LACKS_SILENT" && m.bearing > 0) {
    failures.push(
      `VERDICT CONTRADICTED: ${f} is registered LACKS_SILENT (nothing to claim) but ` +
        `${m.bearing} of its tags carry a provenance. Either the payload has an origin ` +
        "(re-state the verdict) or the prop is decoration (remove it).",
    );
  }
  if (e.bucket === "HAS_MISSING" && m.bearing > 0) {
    failures.push(
      `VERDICT STALE: ${f} is registered HAS_MISSING but measures ${m.bearing} ` +
        "affordance-bearing site(s). The work landed; re-state the verdict.",
    );
  }
  // R1 — a tag that can never paint is decoration, and decoration is what
  // padded every floor in this gate.
  if (m.deadAffordances > 0) {
    failures.push(
      `DEAD AFFORDANCE: ${f} has ${m.deadAffordances} <${AFFORDANCE_TAG}> tag(s) with a ` +
        "literal `provenance={null}` or no `provenance` prop at all. That tag renders its " +
        "children bare on every input — it paints no dotted rule and opens no card. Delete " +
        "it, or give it the payload. (`absent` is the supported way to refuse a figure.)",
    );
  }

  // A HAS_SHOWS file that bears NOTHING must name the file that renders the
  // affordance for it — TC-7: the census owner and the painter agree — and
  // that file must itself be registered HAS_SHOWS with a real count.
  //
  // R2 — `renders_via` USED TO BE A SENTENCE, NOT A RELATION. The check
  // below once asked only "does the named file exist in the registry as
  // HAS_SHOWS with >=1 bearing", never whether the CLAIMING file has
  // anything to do with it. Measured 2026-09-04: relabelling 17 of the 20
  // HAS_MISSING files to HAS_SHOWS and pointing every one of their
  // `renders_via` at BSStatementView.tsx — a file none of them import or
  // render — PASSED. Seventeen surfaces that paint no affordance could
  // claim they do, with one copy-pasted line each.
  //
  // The relation is now checked against the import graph: the claiming
  // file must actually IMPORT the file it says paints for it. That is the
  // weakest true statement of "renders via" a static pass can make, and it
  // is not satisfiable by typing.
  if (e.bucket === "HAS_SHOWS" && m.bearing === 0) {
    for (const why of rendersViaFindings(f, m, e)) failures.push(why);
  }
}

for (const f of entries.keys()) {
  if (!measured.has(f)) {
    failures.push(
      `STALE ENTRY: ${f} is registered but renders no figures. A stale ` +
        "registration silently widens the allowance.",
    );
  }
}

// ── R7: every counted affordance is reachable, or it is padding ────────
//
// Two-sided, and both sides PROVABLE from the tree:
//   · the FILE holding a bearing tag is imported by something (or is the
//     app entry). A new module imported by nobody paints on no screen.
//   · the COMPONENT enclosing the tag is NAMED somewhere outside its own
//     declaration — rendered, imported, re-exported, lazily loaded. The
//     one exception is a file's DEFAULT export, which a router reaches
//     through the file, never through the name.
//
// A tag that fails either test is subtracted from the counted total AND
// fails the gate, so padding can neither buy units nor pass quietly.
const importedBy = new Map();
for (const [f, code] of allSources) {
  if (isTest(f)) continue;
  for (const m of code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)["']([^"']+)["']/g)) {
    const r = resolveSpecifier(f, m[1]);
    if (r) importedBy.set(r, (importedBy.get(r) ?? 0) + 1);
  }
}
const ENTRY_FILES = new Set(["frontend/main.tsx", "frontend/App.tsx", "frontend/index.tsx"]);
let inertBearing = 0;
const componentLiveCache = new Map();
for (const [f, m] of measured) {
  if (!m.bearing) continue;
  const code = allSources.get(f) ?? "";
  const fileLive = ENTRY_FILES.has(f) || (importedBy.get(f) ?? 0) > 0;
  if (!fileLive) {
    inertBearing += m.bearing;
    failures.push(
      `INERT AFFORDANCE (unreachable file): ${f} carries ${m.bearing} affordance-bearing ` +
        "site(s) and is imported by nothing in the tree and is not an app entry. Code no " +
        "screen renders cannot be evidence that a screen renders it — this is the shape " +
        "that padded units to 76 while four real findings affordances were deleted.",
    );
    continue;
  }
  const seen = new Set();
  for (const at of m.bearingAt) {
    const owner = enclosingComponent(code, at.index);
    if (!owner || seen.has(owner)) continue;
    seen.add(owner);
    const key = `${f}::${owner}`;
    let live = componentLiveCache.get(key);
    if (live === undefined) {
      const rx = new RegExp(`(?<![\\w$.])${owner}(?![\\w$])`, "g");
      let occurrences = 0;
      for (const [g, c] of allSources) occurrences += (c.match(rx) ?? []).length;
      const isDefault = new RegExp(
        `export\\s+default\\s+(?:function\\s+${owner}\\b|${owner}\\b)|export\\s+default\\s+function\\s+${owner}\\b`,
      ).test(code);
      // The declaration itself is one occurrence. Anything above one is a
      // reference: a tag, an import, a re-export, a lazy() specifier.
      live = occurrences > 1 || isDefault;
      componentLiveCache.set(key, live);
    }
    if (!live) {
      const n = m.bearingTags ? m.bearing : 0;
      inertBearing += 1;
      failures.push(
        `INERT AFFORDANCE (unreferenced component): ${f} declares <${owner}>, which holds ` +
          `affordance-bearing tag(s) counted toward the ${n ? "file's" : ""} total, but the ` +
          "name appears nowhere else in the tree — not rendered, not imported, not lazily " +
          "loaded, not exported by default. An affordance nothing renders is decoration " +
          "that buys units.",
      );
    }
  }
}

// ── R10: the render witness, DERIVED then EXECUTED ─────────────────────
const bearingByTag = Object.create(null);
for (const m of measured.values())
  for (const [t, n] of Object.entries(m.bearingTags ?? {}))
    bearingByTag[t] = (bearingByTag[t] ?? 0) + n;

const witnessFiles = new Set();
for (const [tag, n] of Object.entries(bearingByTag)) {
  const specs = RENDER_WITNESS[tag];
  if (!specs || specs.length === 0) {
    failures.push(
      `WITNESS MISSING: <${tag}> is credited with ${n} affordance-bearing site(s) and no ` +
        "spec renders it. A census of call sites cannot see a primitive that stopped " +
        "working — one `||` → `&&` in hasProvenance blanks every affordance in the product " +
        "and leaves every count here unchanged. Add a render witness to RENDER_WITNESS.",
    );
    continue;
  }
  for (const spec of specs) {
    const abs = join(ROOT, spec);
    if (!existsSync(abs)) {
      failures.push(`WITNESS MISSING FILE: <${tag}> names ${spec}, which is not on disk.`);
      continue;
    }
    const src = readFileSync(abs, "utf-8");
    if (!WITNESS_MARKER.test(src)) {
      failures.push(
        `WITNESS ASSERTS NOTHING: ${spec} never mentions \`data-provenance\` — it cannot be ` +
          "checking whether the affordance painted. A witness that would pass over a dead " +
          "primitive is not a witness.",
      );
      continue;
    }
    const expects = (src.match(/\bexpect\s*\(/g) ?? []).length;
    if (expects < WITNESS_MIN_EXPECTS) {
      failures.push(
        `WITNESS TRUNCATED: ${spec} carries ${expects} expectation(s), floor ` +
          `${WITNESS_MIN_EXPECTS}. Emptying the witness is the cheapest way to make this ` +
          "gate green over a dead affordance.",
      );
      continue;
    }
    const declaredIn = PRIMITIVES[tag]?.homes ?? [];
    const names = [tag, ...declaredIn.map((h) => h.split("/").pop().replace(/\.tsx?$/, ""))];
    if (!names.some((nm) => new RegExp(`(?<![\\w$])${nm}(?![\\w$])`).test(src))) {
      failures.push(
        `WITNESS UNRELATED: ${spec} names neither <${tag}> nor the component that declares ` +
          "it. Pointing a witness at an unrelated spec is the `renders_via` mistake again.",
      );
      continue;
    }
    witnessFiles.add(spec);
  }
}

console.log(
  `GATE-WORK provenance-render-witness units=${witnessFiles.size} floor=${
    Object.keys(RENDER_WITNESS).length ? 2 : 0
  } label=specs-that-render-the-primitive (${Object.entries(bearingByTag)
    .map(([t, n]) => `${t}×${n}`)
    .join(" ")})`,
);

if (!PROBE_VACUITY && witnessFiles.size > 0) {
  const args = ["vitest", "run", ...witnessFiles, "--reporter=dot"];
  const run = spawnSync("npx", args, { cwd: ROOT, encoding: "utf-8", timeout: 300_000 });
  const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const passed = /Test Files\s+\d+ passed/.test(out) && !/failed/.test(out);
  if (run.status !== 0 || !passed) {
    const tail = out.split("\n").filter(Boolean).slice(-14).join("\n      ");
    failures.push(
      `RENDER WITNESS FAILED (exit ${run.status}): the specs that render the affordance do ` +
        "not pass. The static census cannot tell a live primitive from a dead one; this is " +
        `the instrument that can, and it is red.\n      ${tail}`,
    );
  } else {
    const m = /Tests\s+(\d+) passed/.exec(out);
    console.log(
      `  render witness: ${witnessFiles.size} spec(s), ${m ? m[1] : "?"} assertion group(s) ` +
        "green — the affordance paints, and refuses, through the real components",
    );
  }
}

// ── P4: per-surface floors, asserted AFTER discovery (TC-3) ────────────
const rostered = new Set();
for (const [name, spec] of Object.entries(SURFACES)) {
  const ratchet = spec.ratchet;
  if (typeof ratchet !== "number") {
    failures.push(`SURFACE RATCHET MISSING: ${name} declares no \`ratchet\`.`);
    continue;
  }
  let sites = 0;
  let bearing = 0;
  let declared = 0;
  let seen = 0;
  const kinds = new Set();
  for (const f of spec.files) {
    if (rostered.has(f)) {
      failures.push(`SURFACE ROSTER DOUBLE-COUNTS: ${f} is listed under two surfaces (${name}).`);
    }
    rostered.add(f);
    if (!existsSync(join(ROOT, f))) {
      failures.push(
        `SURFACE ROSTER STALE: ${name} lists ${f}, which is not on disk. A floor over ` +
          "a file that no longer exists is an allowance nobody is using.",
      );
      continue;
    }
    const m = measured.get(f);
    if (!m) continue; // renders no figure today; the registry side says so
    seen += 1;
    sites += m.sites;
    bearing += m.bearing;
    declared += entries.get(f)?.affordances ?? 0;
    kinds.add(bucketOf.get(f) ?? "UNREGISTERED");
  }
  let zeroNote = "";
  if (ratchet === 0) {
    zeroNote = kinds.has("HAS_MISSING")
      ? " (VACUOUS-PENDING: floor is zero while the surface has HAS_MISSING files)"
      : " (NONE-EXPECTED: every file is LACKS_SILENT; a zero is the law here)";
    if (kinds.has("HAS_SHOWS")) {
      failures.push(
        `SURFACE RATCHET VACUOUS: ${name} has a HAS_SHOWS file and a ratchet of 0 — a zero ` +
          "ratchet cannot red. Set it to the measured count.",
      );
    }
  }
  console.log(
    `GATE-WORK provenance-surface-${name} units=${bearing} floor=${ratchet} ` +
      `label=affordance-bearing-sites over ${seen} file(s), ${sites} site(s)${zeroNote}`,
  );
  console.log(`  witness: ${spec.witness}`);
  if (seen === 0) {
    failures.push(
      `SURFACE VACUITY: none of the ${spec.files.length} file(s) rostered under ${name} ` +
        "renders a figure. The surface has no subject, or its roster is wrong.",
    );
  }
  if (bearing < ratchet) {
    failures.push(
      `SURFACE RATCHET: ${name} renders ${bearing} affordance-bearing site(s) across its ` +
        `${seen} figure file(s), ratchet ${ratchet} (EXACT) — the ${name} surface lost ` +
        `${ratchet - bearing} of its dots (the product-wide total is still ${totalBearing}, ` +
        "which is why a sum cannot see this).",
    );
  }
  if (declared !== bearing) {
    failures.push(
      `SURFACE DERIVED FLOOR: ${name} — the registry declares ${declared} affordance-bearing ` +
        `site(s) over its files, the tree measures ${bearing}.`,
    );
  }
}
// Every registered file belongs to a surface, or the surface table has a
// hole the same size as the file.
for (const f of measured.keys()) {
  if (!rostered.has(f) && entries.has(f)) {
    failures.push(
      `UNSURFACED: ${f} is registered but belongs to no SURFACES roster. A file no ` +
        "surface floor covers can lose its dots without any surface going red.",
    );
  }
}

// ══════════════════════════════════════════════════════════════════════
// R5 — THE AXIS THE CENSUS DID NOT HAVE: IS THE FIGURE REAL?
// ══════════════════════════════════════════════════════════════════════
//
// Everything above this line is a census of CALL SITES. It asks whether a
// site RECORDS a verdict; it cannot ask whether the number that arrives at
// that site is a number the engine actually served. A second critic put it
// exactly: every fabrication happens in a BUILDER, upstream, so the value
// reaches the affordance as a finite number and all five of its guards
// correctly wave it through. The guard is downstream of the lie.
//
// Three live examples this gate could not see, each verified against a
// REAL fixture (corpus/*/expected/*.json and the repo's own AAPL fixture):
//
//   · buildBsStatement.ts   `opening: row.opening ?? row.amount` — the
//     Carniprod envelope serves `opening: null` on all 44 rows, so 50 rows
//     paint an opening EQUAL to closing, 47 wear data-provenance="true",
//     and the card names sheet/account/method for a figure in none of them.
//   · publicCompanyAdapters.ts  84 `?? 0` sites; on the AAPL fixture cogs,
//     opex, interestExpense, accountsPayable and longTermDebt all adapt to
//     0 — every one an ABSENT leaf, not a filed zero — and 15 ratios then
//     render 0.00x WITH a card while EBIT in the same fixture is 123.2bn.
//   · servedFacts.ts  `differenceCents: servedDifference ?? assets - el`
//     invents a perfect balance when `totals.liabilities` is missing, on
//     the one surface whose entire job is trust.
//
// ── WHAT IS CHECKED, AND WHY IT IS SHAPED THIS WAY ────────────────────
//
// SCOPE is derived, not hand-listed: the modules a CARD-BEARING component
// directly imports (the import graph, resolved above). A builder that
// starts feeding a provenance-bearing surface enters scope on its next
// run, with no edit here — which is the property the roster-based halves
// of this gate kept failing to have.
//
// THE SHAPE is narrow on purpose. A blanket ban on `?? 0` over the whole
// reachable set is 434 hits, most of them accumulator seeds and index
// guards; a 434-entry allowlist is a rubber stamp, not a gate. What is
// banned is the shape that actually fabricates: an absent PAYLOAD LEAF —
// a member-access chain, or a call on one — substituted by 0 or by a
// DIFFERENT field, in the value of a built field or binding. That is
// `row.opening ?? row.amount`, `c.cash ?? 0` and
// `centsOrNull(cbs.totals?.assets) ?? 0`, and it is not `acc = acc ?? 0`.
//
// EVERY IN-SCOPE FILE WITH HITS CARRIES A VERDICT, with an EXACT count —
// the same two-sided protocol the render census uses, and for the same
// reason: a number that moves is the only rule anyone keeps.
//
//   FILED_ZERO   the substitution is on a genuinely filed zero, or on a
//                field no figure is painted from. Justified in `why`.
//   OPEN_DEFECT  a real absent-to-zero fabrication, NAMED, with its owner.
//                Counted against a CEILING that may only fall. This bucket
//                exists so the gate can SEE a live defect another lane owns
//                without either lying about it or blocking on it — the
//                same role HAS_MISSING plays for the render census.
//
// An in-scope file with hits and no entry FAILS. A count that drifts
// FAILS. OPEN_DEFECT above the ceiling FAILS.
// The substituted-IN value: a literal zero, another payload chain, or an
// ARITHMETIC EXPRESSION over other terms. The third alternative is F3's
// `differenceCents: servedDifference ?? assets - el` — a trust receipt
// that, with `totals.liabilities` absent, INVENTS a perfect balance out of
// the terms it still has. A fallback computed from other fields is the
// same lie as a fallback of zero, and is if anything more convincing.
const SUBSTITUTE =
  "(0\\b|[A-Za-z_$][\\w$]*(?:\\??\\.[\\w$]+)+|[A-Za-z_$][\\w$]*(?:\\??\\.[\\w$]+)*\\s*[-+*/]\\s*[A-Za-z_$][\\w$]*(?:\\??\\.[\\w$]+)*)";
const ABSENT_LEAF_PROP = new RegExp(
  "(^|[\\s{,(])([A-Za-z_$][\\w$]*)\\s*:\\s*([^,;{}\\n]*?)\\s*(\\?\\?|\\|\\|)\\s*" + SUBSTITUTE,
  "g",
);
const ABSENT_LEAF_DECL = new RegExp(
  "\\b(?:const|let)\\s+([A-Za-z_$][\\w$]*)(?:\\s*:[^=]{0,160}?)?\\s*=\\s*([^;\\n]*?)\\s*(\\?\\?|\\|\\|)\\s*" + SUBSTITUTE + "\\s*;",
  "g",
);

/** A zero-returning division helper — F2's `safeDiv`. A ratio whose
 *  denominator is ABSENT is not zero, it is unanswerable, and a 0.00x
 *  wearing a derived-origin card is the worst bucket. */
const ZERO_DIV =
  /=>\s*\(?\s*[A-Za-z_$][\w$]*\s*===?\s*0\s*\?\s*0\s*:|\bif\s*\(\s*!?[A-Za-z_$][\w$]*\s*(?:===?\s*0\s*)?\)\s*return\s+0\s*;/;

// A field name that is not a FIGURE, however it is reached. Matched on the
// built key and on the leaf of the substituted chain. Without this the lint
// reds on `rawChip = line.accountCode ?? split?.code` (an account code),
// `labelA = a.periodLabel ?? a.scope` (a label) and
// `target = opts.basePath ?? window.location.pathname` (a route) — none of
// which any figure is painted from, and a lint that cries about routes is a
// lint nobody reads.
const NON_FIGURE_FIELD =
  /(^|_)(label|labels|name|names|code|codes|id|ids|path|paths|scope|period|periods|date|dates|time|times|status|state|kind|type|slug|title|url|href|src|key|keys|sort|sortkey|index|idx|start|end|ordinal|standard|currency|locale|lang|language|icon|color|colour|text|msg|message|reason|note|notes|version|hash|token|email|sheet|method|pack|mode|variant|side|display|align|width|height|offset|delay|timeout|ms|zindex|z_index|step|page|cursor|seed|retry|attempt|ttl|decimals|precision|digits|fraction|fractiondigits|maximumfractiondigits)($|_)/i;
// A field a FIGURE is painted from. Required when the substitute is another
// field rather than a literal zero — `row.opening ?? row.amount` is the
// defect; `draft.accountingStandard ?? doc.market.accounting_standard` is a
// string falling back to a string.
const FIGURE_FIELD =
  /(amount|value|val|total|totals|opening|closing|balance|cents|margin|ratio|score|revenue|turnover|ebitda|ebit|profit|income|expense|cost|cogs|opex|capex|debt|equity|assets|liabilit|cash|price|qty|quantity|count|sum|net|gross|delta|change|pct|percent|rate|yield|multiple|coverage|dso|dio|dpo|ccc|depreciation|amortisation|amortization|tax|interest|altman|zscore|z_score|piotroski|nav|wacc|fcf|eps|shares|dividend|payable|receivable|inventory|provision|impact|baseline|adjusted|observed|threshold|limit)/i;

function absentLeafHits(fileRel) {
  const abs = join(ROOT, fileRel);
  if (!existsSync(abs)) return [];
  const src = stripComments(readFileSync(abs, "utf-8"));
  // A payload leaf is often CAPTURED INTO A LOCAL first and substituted a
  // few lines later — which is exactly F3:
  //     const servedDifference = centsOrNull(cbs.difference);
  //     …
  //     differenceCents: servedDifference ?? assets - el
  // The left operand there is a bare identifier, so a "must contain a dot"
  // test walks straight past the fabrication it was written to catch. Any
  // local bound from a member chain (or a call on one) counts as the
  // payload it came from.
  const payloadLocals = new Set();
  for (const m of src.matchAll(
    /\b(?:const|let)\s+([A-Za-z_$][\w$]*)(?:\s*:[^=]{0,160}?)?\s*=\s*([^;\n]{0,200})/g,
  )) {
    if (/[A-Za-z_$][\w$]*\s*\??\.\s*[\w$]+/.test(m[2])) payloadLocals.add(m[1]);
  }
  const out = [];
  const push = (key, lhs, op, rhs, idx) => {
    const l = lhs.trim();
    // Must reach into a payload: a member chain, or a local that holds one.
    if (!/[.[]/.test(l) && !payloadLocals.has(l)) return;
    if (/\.length\b/.test(l)) return; // an array length is not a served leaf
    if (/\bDate\.(parse|now)\s*\(/.test(l)) return; // a timestamp, not a figure
    // `?? NaN` / `?? null` is the CORRECT refusal — a non-finite figure is
    // what `isAbsentFigure` catches and what makes the affordance stand
    // down. Never red on the honest shape.
    if (/^(Number\.NaN|NaN|null|undefined)$/.test(rhs)) return;
    // camelCase → snake_case before the name tests, so `accountCode` reads
    // as `account_code` and trips the `code` deny-word. Without this the
    // lint reds on `rawChip = line.accountCode ?? split?.code`, which is an
    // account code falling back to an account code.
    const norm = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
    const leaf = norm(l.split(/[.?[\]]+/).filter(Boolean).pop() ?? "");
    const k = norm(key);
    if (NON_FIGURE_FIELD.test(k) || NON_FIGURE_FIELD.test(leaf)) return;
    // Substituting a literal ZERO is in scope on any numeric-looking field.
    // Substituting ANOTHER FIELD is in scope only when a figure is painted
    // from it — that is F1's `opening: row.opening ?? row.amount`.
    if (rhs !== "0" && !(FIGURE_FIELD.test(k) || FIGURE_FIELD.test(leaf))) return;
    out.push({ key, lhs: l, op, rhs, line: src.slice(0, idx).split("\n").length });
  };
  for (const m of src.matchAll(ABSENT_LEAF_PROP)) push(m[2], m[3], m[4], m[5], m.index);
  for (const m of src.matchAll(ABSENT_LEAF_DECL)) push(m[1], m[2], m[3], m[4], m.index);

  // ── R11 — THE THREE EVASIONS A CRITIC WALKED THROUGH ────────────────
  //
  // The lint matched `??` and `||` literally. Seven evasions were tried
  // against it; it caught three (`Number(x) || 0`, a bag-lookup chain, a
  // JSON.parse chain) and missed these, which are not exotic — they are
  // the three most ordinary ways to spell the same substitution:

  // (a) A HELPER THAT HIDES IT. `const or0 = (x) => x ?? 0` and then
  //     `or0(row.opening)` reads as a call, not a fallback. Any local
  //     one-liner that turns its own parameter into 0 is one, whatever it
  //     is called — `or0`, `num`, `n`, `safe`.
  const zeroHelpers = new Set();
  for (const m of src.matchAll(
    /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]{0,120})?=\s*\(?\s*([A-Za-z_$][\w$]*)[^)]{0,80}?\)?\s*(?::[^=>]{0,80})?=>\s*([^;\n]{0,160})/g,
  )) {
    const [, name, param, body] = m;
    const p = param.replace(/[^\w$]/g, "");
    const substitutes =
      new RegExp(`(?<![\\w$])${p}\\s*(\\?\\?|\\|\\|)\\s*0(?![\\d.])`).test(body) ||
      new RegExp(`(?<![\\w$])${p}\\s*[=!]==?\\s*(null|undefined)\\s*\\?\\s*0(?![\\d.])`).test(body) ||
      new RegExp(`Number\\.isFinite\\s*\\(\\s*${p}\\s*\\)\\s*\\?\\s*${p}\\s*:\\s*0(?![\\d.])`).test(
        body,
      );
    if (substitutes) zeroHelpers.add(name);
  }
  for (const name of zeroHelpers) {
    for (const m of src.matchAll(
      new RegExp(`([A-Za-z_$][\\w$]*)\\s*:\\s*${name}\\s*\\(([^)]{0,120})\\)`, "g"),
    ))
      push(m[1], m[2], `${name}()`, "0", m.index);
    for (const m of src.matchAll(
      new RegExp(`\\b(?:const|let)\\s+([A-Za-z_$][\\w$]*)[^=\\n]{0,120}=\\s*${name}\\s*\\(([^)]{0,120})\\)`, "g"),
    ))
      push(m[1], m[2], `${name}()`, "0", m.index);
  }

  // (b) A DESTRUCTURING DEFAULT. `const { opening = 0, closing = 0 } =
  //     row;` is the SAME substitution with the `??` spelled by the
  //     language. An absent `opening` becomes 0 with nothing to grep for.
  for (const m of src.matchAll(/\b(?:const|let)\s*\{([^{}]{0,400})\}\s*=\s*([^;\n]{0,160});/g)) {
    const [, fields, source] = m;
    // The source may be a member chain, a captured payload local, OR a
    // bare parameter — `function row({ opening = 0 })` is the same
    // substitution, and a builder's parameters are payloads by
    // construction. `push` still applies the figure/non-figure field
    // tests, so an options bag's `{ timeout = 0 }` is not a figure.
    if (!/^[A-Za-z_$][\w$.?[\]]*$/.test(source.trim())) continue;
    for (const fm of fields.matchAll(/([A-Za-z_$][\w$]*)\s*(?::\s*[A-Za-z_$][\w$]*\s*)?=\s*0(?![\d.])/g))
      push(fm[1], `${source.trim()}.${fm[1]}`, "= (destructuring default)", "0", m.index);
  }

  // (c) A NULL-TEST TERNARY. `x == null ? 0 : x` and `!x ? 0 : x` are the
  //     `??` written long-hand, and `Number.isFinite(x) ? x : 0` is the
  //     same thing wearing a guard that looks like diligence.
  for (const m of src.matchAll(
    /([A-Za-z_$][\w$]*(?:\??\.[\w$]+)*)\s*[=!]==?\s*(?:null|undefined)\s*\?\s*(0)(?![\d.])\s*:/g,
  )) {
    const key = m[1].split(/[.?[\]]+/).filter(Boolean).pop() ?? m[1];
    push(key, m[1], "== null ?", "0", m.index);
  }
  for (const m of src.matchAll(
    /Number\.isFinite\s*\(\s*([A-Za-z_$][\w$]*(?:\??\.[\w$]+)*)\s*\)\s*\?\s*\1\s*:\s*0(?![\d.])/g,
  )) {
    const key = m[1].split(/[.?[\]]+/).filter(Boolean).pop() ?? m[1];
    push(key, m[1], "isFinite ? :", "0", m.index);
  }

  if (ZERO_DIV.test(src))
    out.push({ key: "<zero-returning division>", lhs: "denominator === 0", op: "?", rhs: "0", line: 0 });
  return out;
}

// ══════════════════════════════════════════════════════════════════════
// ANTIBODY 3 — ONE COMPANY'S FIGURE STANDING IN FOR ANOTHER'S
// ══════════════════════════════════════════════════════════════════════
//
// `dscr: safeDiv(ebitdaStatutory, plFacts.interest_expense +
//  Math.max(773894.83, plFacts.depreciation))` — periodFacts.ts:440.
//
// That constant is not a threshold, a unit conversion or a rounding
// epsilon. It is EEI Imobiliara's FY2025 long-term-loan principal repaid,
// account 1621, ytd_debit — it is sitting in
// `e2e/fixtures/ground-truth/ro_eei_dec_2025/expected_extraction.json:34`
// and quoted in that fixture's `_dscr_note`. It became the principal
// proxy for EVERY company whose own depreciation is smaller, and DSCR is
// a lender-facing verdict.
//
// This is a different failure from absent-read-as-zero, and the leaf lint
// cannot see it: nothing is absent, nothing is `?? 0`, the arithmetic is
// finite and the card is honest about the derivation. What is wrong is
// that one company's number is inside another company's ratio.
//
// The shape is cheap to refuse and, measured over this tree, has exactly
// one hit: a money-shaped literal (five or more integer digits with a
// decimal fraction, or seven or more digits) used in ARITHMETIC or in a
// Math call, in a module that feeds a card-bearing surface. Percentages,
// basis points, years, epsilons, HTTP codes, pixel sizes and 1e6/1_000_000
// scale factors are all below the threshold or carry no fraction.
// A MONEY SHAPE, stated precisely: five or more integer digits AND a
// decimal fraction. `773894.83` is one; `1e6`, `2 ** 32`, `4294967296`
// (a PRNG modulus, the one false positive the first draft produced),
// 10_000, 0.16 and 365 are not. A whole-RON foreign constant with no
// cents (`773894`) is NOT seen — that is the stated hole, and it is the
// price of a check with no false positives on this tree.
const FOREIGN_CONSTANT = /(?<![\w$.])(\d{5,}\.\d+)(?![\w$])/g;
/** Contexts where a big literal is a SCALE, not a company's figure. */
const CONSTANT_IS_SCALE = /^(1000000|10000000|100000000|1000000000|10000000000)(\.0+)?$/;

function foreignConstantHits(fileRel) {
  const abs = join(ROOT, fileRel);
  if (!existsSync(abs)) return [];
  const src = stripComments(readFileSync(abs, "utf-8"));
  const out = [];
  for (const m of src.matchAll(FOREIGN_CONSTANT)) {
    const lit = m[1];
    if (CONSTANT_IS_SCALE.test(lit.replace(/_/g, ""))) continue;
    // A number inside a STRING is data (bvbStaticUniverse.ts carries a
    // whole JSON universe on three lines), not a figure in a formula.
    const lineStart = src.lastIndexOf("\n", m.index) + 1;
    const quotesBefore = (src.slice(lineStart, m.index).match(/(?<!\\)"/g) ?? []).length;
    if (quotesBefore % 2 === 1) continue;
    const before = src.slice(Math.max(0, m.index - 60), m.index);
    const after = src.slice(m.index + lit.length, m.index + lit.length + 40);
    // USED as a figure — an argument to a Math call, an operand, a
    // comparison — rather than DECLARED as data. The distinction that
    // matters is the value position: `"netIncome": -1222697.0` inside
    // bvbStaticUniverse's embedded JSON is a minus sign in a table, and
    // the first draft read it as arithmetic (three false positives, all
    // in that one data file).
    const isMathArg = /Math\.(max|min|abs|round|pow)\s*\([^()]{0,80}$/.test(before);
    const dataPosition = /[:,[]\s*[-+]?\s*$/.test(before);
    const inArithmetic =
      isMathArg ||
      (/[-+*/]\s*$/.test(before) && !dataPosition) ||
      /^\s*[-+*/](?![/*])/.test(after) ||
      /[<>]=?\s*$/.test(before) ||
      /^\s*[<>]=?/.test(after);
    if (!inArithmetic) continue;
    out.push({ literal: lit, line: src.slice(0, m.index).split("\n").length });
  }
  return out;
}

// SCOPE — modules a card-bearing registered component imports directly.
const cardBearing = [...measured.keys()].filter(
  (f) => entries.get(f)?.bucket === "HAS_SHOWS" && measured.get(f).bearing > 0,
);
const builderScope = new Set();
for (const f of cardBearing)
  for (const dep of importsOf(f)) if (/\.tsx?$/.test(dep) && !isTest(dep)) builderScope.add(dep);

const leafEntries = new Map(Object.entries(registry.absent_leaf ?? {}));
// THREE buckets, and the third is the honest one.
//
//   FILED_ZERO      checked against a real envelope; the zero is filed, or
//                   no figure is painted from the field. Justified.
//   OPEN_DEFECT     PROVEN to fabricate — a real fixture shows the leaf
//                   absent and a figure rendering anyway. Ceilinged.
//   UNADJUDICATED   nobody has yet run this file's substitutions against a
//                   real envelope. This is a verdict about the EVIDENCE,
//                   which is true, rather than a verdict about the payload,
//                   which would be invented — and inventing one here would
//                   be the same move the whole lane exists to stop. Also
//                   ceilinged, and the ceiling only falls.
//
// The distinction matters: writing FILED_ZERO over 160 substitutions
// nobody opened would make this lint pass while asserting 160 things no
// one checked. That is a rubber stamp with a schema.
const LEAF_BUCKETS = new Set(["FILED_ZERO", "OPEN_DEFECT", "UNADJUDICATED"]);
let leafTotal = 0;
let openDefectTotal = 0;
let unadjudicatedTotal = 0;
const leafMeasured = new Map();
for (const f of [...builderScope].sort()) {
  const hits = absentLeafHits(f);
  if (hits.length) leafMeasured.set(f, hits);
}
for (const f of PROBE_VACUITY ? [] : [...allSources.keys()].filter((x) => !isTest(x))) {
  for (const h of foreignConstantHits(f)) {
    failures.push(
      `FOREIGN CONSTANT at ${f}:${h.line} — the literal \`${h.literal}\` is used as a ` +
        "figure in arithmetic. A money-shaped constant " +
        "is one company's number standing in every other company's formula. The live one " +
        "this check was written for is periodFacts.ts's DSCR principal proxy, " +
        "`Math.max(773894.83, plFacts.depreciation)` — 773,894.83 is EEI Imobiliara's " +
        "FY2025 account-1621 principal repaid, verbatim from " +
        "e2e/fixtures/ground-truth/ro_eei_dec_2025/expected_extraction.json:34. Refuse the " +
        "ratio when the real input is absent; do not borrow another company's.",
    );
  }
}
// `--dump-leaf` prints every substitution the lint sees, so a reviewer can
// check the lint against the source rather than trusting its count.
const DUMP_LEAF = process.argv.includes("--dump-leaf");
if (DUMP_LEAF) {
  for (const [f, hits] of [...leafMeasured].sort()) {
    console.log(`\n  ${f} — ${hits.length}`);
    for (const h of hits) console.log(`     :${h.line}  ${h.key} = ${h.lhs} ${h.op} ${h.rhs}`);
  }
  console.log("");
}
for (const [f, hits] of leafMeasured) {
  leafTotal += hits.length;
  const e = leafEntries.get(f);
  if (!e) {
    failures.push(
      `ABSENT-LEAF UNREGISTERED: ${f} substitutes an absent payload leaf ${hits.length} ` +
        `time(s) (first: :${hits[0].line} \`${hits[0].key}\` = ${hits[0].lhs} ${hits[0].op} ` +
        `${hits[0].rhs}) and feeds a card-bearing surface, but carries no verdict in ` +
        "`absent_leaf`. ABSENT is not ZERO: decide FILED_ZERO (justified) or OPEN_DEFECT.",
    );
    continue;
  }
  if (!LEAF_BUCKETS.has(e.bucket)) {
    failures.push(`ABSENT-LEAF: ${f} has unknown bucket "${e.bucket}".`);
    continue;
  }
  if (e.substitutions !== hits.length) {
    failures.push(
      `ABSENT-LEAF COUNT DRIFT: ${f} declares ${e.substitutions} substitution(s), ` +
        `measured ${hits.length}. A new absent-to-zero needs a verdict before it ships; ` +
        "a removed one is progress and re-states the entry.",
    );
  }
  if (!e.why || String(e.why).trim().length < 12) {
    failures.push(
      `ABSENT-LEAF UNJUSTIFIED: ${f} is ${e.bucket} with no usable \`why\`. An allowlist ` +
        "entry with no reason is a rubber stamp.",
    );
  }
  if (e.bucket === "OPEN_DEFECT") openDefectTotal += hits.length;
  if (e.bucket === "UNADJUDICATED") unadjudicatedTotal += hits.length;
  // An OPEN_DEFECT must name who owns it, or "open" has no end.
  if (e.bucket === "OPEN_DEFECT" && !e.owner) {
    failures.push(
      `ABSENT-LEAF UNOWNED: ${f} is OPEN_DEFECT with no \`owner\`. A defect nobody owns ` +
        "is a defect nobody closes.",
    );
  }
}
for (const f of leafEntries.keys()) {
  if (!leafMeasured.has(f)) {
    failures.push(
      `ABSENT-LEAF STALE: ${f} carries an \`absent_leaf\` verdict but measures no ` +
        "substitution in scope. Remove the entry (or it silently widens the allowance).",
    );
  }
}
console.log(
  `GATE-WORK provenance-absent-leaf units=${leafTotal} ceiling=${CEILING_OPEN_DEFECT} ` +
    `label=absent-payload-leaf-substitutions over ${leafMeasured.size} builder file(s) ` +
    `feeding ${cardBearing.length} card-bearing component(s) ` +
    `(${openDefectTotal} OPEN_DEFECT · ${unadjudicatedTotal} UNADJUDICATED · ` +
    `${leafTotal - openDefectTotal - unadjudicatedTotal} FILED_ZERO)`,
);
if (unadjudicatedTotal > CEILING_UNADJUDICATED_LEAF) {
  failures.push(
    `ABSENT-LEAF UNADJUDICATED CEILING: ${unadjudicatedTotal} substitution(s) nobody has ` +
      `checked against a real envelope, ceiling ${CEILING_UNADJUDICATED_LEAF}. This ceiling ` +
      "only falls: each one is a figure that may be an invented zero wearing a card.",
  );
}
if (builderScope.size < FLOOR_BUILDER_SCOPE) {
  failures.push(
    `ABSENT-LEAF SCOPE COLLAPSED: the import walk reached ${builderScope.size} builder ` +
      `module(s), floor ${FLOOR_BUILDER_SCOPE}. A lint over nothing is not a clean lint.`,
  );
}
if (openDefectTotal > CEILING_OPEN_DEFECT) {
  failures.push(
    `ABSENT-LEAF CEILING: ${openDefectTotal} OPEN_DEFECT substitution(s), ceiling ` +
      `${CEILING_OPEN_DEFECT}. This ceiling only falls. A new fabrication does not get ` +
      "to hide behind an existing one's allowance.",
  );
}

// ── the unaudited ceiling, now zero ────────────────────────────────────
if (buckets.UNAUDITED.length > CEILING_UNAUDITED) {
  failures.push(
    `UNAUDITED CEILING: ${buckets.UNAUDITED.length} file(s) carry no payload ` +
      `verdict, ceiling ${CEILING_UNAUDITED}. Open the file and decide, or the census ` +
      "records an opinion nobody formed.",
  );
}

// ── the worst bucket is never a steady state ───────────────────────────
for (const f of buckets.LACKS_SHOWS) {
  failures.push(
    `FABRICATED AFFORDANCE: ${f} is registered LACKS_SHOWS — a figure offering ` +
      "provenance it does not have. This bucket is never an acceptable state; " +
      "fix the site or correct the verdict.",
  );
}

for (const h of fabricationHits) {
  failures.push(
    `FABRICATION SHAPE at ${h.file}:${h.line} — \`${h.text}\` (${h.why}). A period, a ` +
      "scope, a date or a bare label is not a SOURCE. The card labels that field " +
      "\"Source\"; feed it what the figure was read from, or use the `period` field.",
  );
}
for (const h of zeroHits) {
  failures.push(
    `ZERO WEARS A SOURCE at ${h.file}:${h.line} — \`${h.text}\`. A \`?? 0\` fallback ` +
      "paints a figure the payload never carried, wearing the origin of one it did. " +
      "ABSENT is not ZERO: render plain, or render nothing, when the field is missing.",
  );
}

// ── report ─────────────────────────────────────────────────────────────
console.log("");
for (const [name, files] of Object.entries(buckets)) {
  console.log(`  ${name.padEnd(13)} ${String(files.length).padStart(3)} file(s)`);
  for (const f of files) {
    const m = measured.get(f);
    const tags = Object.entries(m.tags)
      .map(([k, v]) => `${k}×${v}`)
      .join(" ");
    const fmt = Object.entries(m.fmt)
      .map(([k, v]) => `${k}×${v}`)
      .join(" ");
    console.log(
      `      ${f} — ${m.sites} site(s) [${[tags, fmt].filter(Boolean).join(" · ")}], ` +
        `${m.bearing} bearing`,
    );
    const why = entries.get(f)?.why;
    if (why) console.log(`        ${why}`);
  }
}
console.log(
  `  PRODUCERS     ${String(producers.size).padStart(3)} .ts file(s) — strings, not DOM; ` +
    "consumers are the sites above",
);
for (const [f, m] of [...producers].sort()) {
  const fmt = Object.entries(m.fmt)
    .map(([k, v]) => `${k}×${v}`)
    .join(" ");
  console.log(`      ${f} — ${m.sites} call(s) [${fmt}]`);
}

console.log("");
if (failures.length) {
  console.log(`FAIL — ${failures.length} finding(s):`);
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log(
  `PASS — ${totalSites} figure site(s) across ${measured.size} file(s), each with a ` +
    "recorded provenance verdict; no fabricated affordance.",
);
