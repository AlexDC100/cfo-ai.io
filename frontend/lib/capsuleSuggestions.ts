// THE CAPSULE — SUGGESTION ENGINE (Part D).
//
// Three questions, at most, computed from THIS workspace's state. Never
// a static starter list: if the state yields nothing, the surface shows
// fewer rows — the one thing it may never show is filler.
//
// ── Why this module is pure ───────────────────────────────────────────
//
// Same discipline as `capsuleRouter.ts`: no fetch, no i18n, no storage,
// no clock, no React. `buildCapsuleSuggestions(snapshot, mode)` is a
// function of its arguments, which is what lets the test file assert
// behaviour instead of snapshotting a render. The connected hook that
// assembles a snapshot from the live app lives beside the components
// (`components/instrument/shell/capsuleEmpty/useCapsuleSnapshot.ts`);
// everything decision-shaped is here.
//
// ── The four hard rules this file enforces ────────────────────────────
//
// S1  NO FIGURES IN A SUGGESTION. A suggestion is a QUESTION, and the
//     money discipline (the 1553% / 461 rule) says a figure may only
//     reach the DOM through `Amount` / `NarrativeText` with provenance.
//     A capsule row renders neither, so it carries no figure at all.
//     Every interpolated parameter passes `looksLikeFigure` first; a
//     candidate whose only available label is figure-shaped is DROPPED,
//     not printed. `Finding.title` is deliberately never read — it is
//     the RESOLVED narrative and may carry source-currency numerals.
//
// S2  NOTHING IS INVENTED. Every suggestion names a `basisKey` — the
//     honest sentence about where it came from. The covenant tests below
//     are DEFAULTS from the methodology's "common Romanian SME covenants"
//     table, not the user's loan documents, and the basis line says so.
//
// S3  ABSENT ≠ ZERO. A missing metric produces no covenant candidate; a
//     period with no trust verdict produces no trust candidate. There is
//     no "unknown" branch that fills the slot.
//
// S4  DETERMINISTIC. Candidates carry an integer priority and sort by
//     (priority desc, kind asc, id asc). The same snapshot always yields
//     the same three rows in the same order — no clock, no randomness.
//
// Copy lives in `capsuleEmpty/capsuleEmptyStrings.json`; rows carry KEYS
// so this module stays renderable without i18n loaded.

import type { ViewMode } from "@/lib/viewMode";
import type { Finding, FindingsReport } from "@/lib/findings";

// ─── Vocabulary ────────────────────────────────────────────────────────

/** Why a suggestion exists. Also the i18n leaf under
 *  `capsuleEmpty.suggest.<kind>`. */
export type CapsuleSuggestionKind =
  | "unattached"
  | "finding"
  | "trust"
  | "covenant"
  | "silence";

/** Mirror of `servedFacts.BsStatusPresentation["band"]`. Kept as a local
 *  union so this module never imports the served gateway (it takes a
 *  snapshot, it does not read one). */
export type CapsuleTrustBand =
  | "balanced"
  | "reconciled"
  | "needs_review"
  | "minor_drift"
  | "material_imbalance"
  | "unverified";

export interface CapsuleSuggestion {
  /** Stable within a snapshot — a React key and a test anchor. */
  id: string;
  kind: CapsuleSuggestionKind;
  /** `capsuleEmpty.suggest.<kind>[.<variant>].<mode>`. */
  labelKey: string;
  /** Interpolation params. Every value has passed `looksLikeFigure`. */
  labelParams: Record<string, string>;
  /** The honest provenance line — `capsuleEmpty.basis.<kind>`. */
  basisKey: string;
  /** Sort weight. Higher runs first. Exposed so the gate can assert
   *  ordering rather than re-derive it. */
  priority: number;
  /** Which mode phrased it — carried so a surface cannot render a Pro
   *  string under a Simple dial by accident. */
  mode: ViewMode;
}

/** The minimum a finding must give up to become a question. Built by
 *  `seedFindings` — the engine never sees a `Finding` object. */
export interface CapsuleFindingSeed {
  key: string;
  severity: Finding["effectiveSeverity"];
  /** A LABEL — parameter label, metric label, account name or scope.
   *  Never a resolved figure. */
  subject: string;
}

export interface CapsuleMetricSeed {
  name: string;
  value: number | null;
  unit: string | null;
}

export interface CapsuleUnattachedPeriod {
  periodId: string;
  /** Formatted month label ("Dec 2025") — never a period id (D11). */
  label: string;
}

/** Everything the engine is allowed to know. Flat primitives on purpose:
 *  a snapshot cannot be walked back into a live store. */
export interface CapsuleWorkspaceSnapshot {
  /** A period is selected AND resolved. */
  hasPeriod: boolean;
  /** Formatted label of the active period. Null when none. */
  periodLabel: string | null;
  /** Served balance verdict for the active period; null when the period
   *  carries no canonical envelope (an unverified period gets no trust
   *  question, exactly as it gets no trust chip). */
  trustBand: CapsuleTrustBand | null;
  /** Surfaced findings, already reduced to seeds and ranked by the
   *  engine's own order. */
  findings: readonly CapsuleFindingSeed[];
  /** True when the contract ran and NOTHING surfaced — a result, not an
   *  empty state. */
  silence: boolean;
  /** Server-computed headline metrics for the active period. */
  metrics: readonly CapsuleMetricSeed[];
  /** Periods in this workspace with no financial document attached. */
  unattached: readonly CapsuleUnattachedPeriod[];
}

export const EMPTY_SNAPSHOT: CapsuleWorkspaceSnapshot = Object.freeze({
  hasPeriod: false,
  periodLabel: null,
  trustBand: null,
  findings: Object.freeze([]) as readonly CapsuleFindingSeed[],
  silence: false,
  metrics: Object.freeze([]) as readonly CapsuleMetricSeed[],
  unattached: Object.freeze([]) as readonly CapsuleUnattachedPeriod[],
});

/** Three. The empty state is a glance, not a menu. */
export const MAX_SUGGESTIONS = 3;

// ─── S1: the figure guard ──────────────────────────────────────────────
//
// A label may carry an account CODE (a bare integer — "461", "5121" are
// identifiers, not amounts) but never an AMOUNT. These four patterns are
// what an amount looks like once a presenter has touched it:
//   · a number wearing a unit           "1,553 RON", "12%", "3.2×"
//   · grouped thousands                 "1.553.210" / "1,553,210"
//   · a decimal                         "1.24", "0,87"
//   · a currency symbol next to digits  "€ 12", "$4"
// Anything matching is refused as a suggestion parameter.

/** Separator characters a presenter may put between thousands: plain
 *  space, no-break space, narrow no-break space, thin space. Written as
 *  class CONTENTS (no brackets) so they can be spliced into a larger
 *  character class without nesting one. */
const SEP_CHARS = " \\u00A0\\u202F\\u2009";

const FIGURE_PATTERNS: readonly RegExp[] = Object.freeze([
  // a number wearing a unit — "1 553 RON", "12%", "3\u00D7"
  new RegExp(`\\d[\\d.,${SEP_CHARS}]*\\s*(?:(?:RON|LEI|EUR|USD|GBP)\\b|%|\u00D7)`, "i"),
  // a currency CODE leading the number \u2014 "RON 461", "EUR 12"
  /\b(?:RON|LEI|EUR|USD|GBP)\s*\d/i,
  // a currency symbol beside digits, either side
  /[\u20AC$\u00A3]\s*\d/,
  /\d\s*[\u20AC$\u00A3]/,
  // grouped thousands — "1.553.210" / "1,553,210" / "1 553 210"
  new RegExp(`\\d{1,3}(?:[.,${SEP_CHARS}]\\d{3})+`),
  // any decimal — "1.24", "0,87"
  /\d[.,]\d/,
]);

/** True when a string carries something that reads as an AMOUNT. Used to
 *  refuse a suggestion parameter, never to sanitise one — a label that
 *  fails is dropped, because rewriting it would be inventing copy. */
export function looksLikeFigure(input: string): boolean {
  const s = (input ?? "").trim();
  if (!s) return false;
  return FIGURE_PATTERNS.some((re) => re.test(s));
}

/** First candidate that is non-empty, short enough to sit in a row, and
 *  free of figures. Null when every candidate fails — the caller then
 *  drops the suggestion (S1 + "fewer, not filler"). */
export function pickLabel(
  candidates: readonly (string | null | undefined)[],
  maxLength = 72,
): string | null {
  for (const raw of candidates) {
    const s = (raw ?? "").trim();
    if (!s || s.length > maxLength) continue;
    if (looksLikeFigure(s)) continue;
    return s;
  }
  return null;
}

// ─── Adapters (still pure) ─────────────────────────────────────────────

/**
 * A `FindingsReport` reduced to seeds.
 *
 * Reads LABELS only, in a fixed preference order — the threshold's
 * parameter label, the impact's metric label, the first account name,
 * then the subject scope. `title` / `body` are never consulted: they are
 * the resolved narrative and may carry source-currency numerals that
 * would bypass `NarrativeText` if they landed in a capsule row.
 *
 * A finding whose every label is figure-shaped yields NO seed.
 */
export function seedFindings(report: FindingsReport | null): CapsuleFindingSeed[] {
  if (!report) return [];
  const out: CapsuleFindingSeed[] = [];
  for (const f of report.surfaced) {
    const subject = pickLabel([
      f.elements.threshold?.parameter_label,
      f.elements.impact?.metric_label,
      f.elements.subject?.accounts?.[0]?.name,
      f.elements.subject?.scope,
    ]);
    if (!subject) continue;
    out.push({ key: f.key, severity: f.effectiveSeverity, subject });
  }
  return out;
}

// ─── Covenant proximity (S2: defaults, and we say so) ──────────────────
//
// The methodology's "common Romanian SME covenants" table, as DEFAULT
// tests. These are not the user's facility — `capsuleEmpty.basis.covenant`
// states that in the row itself. Thresholds live here as data so adding a
// test is an edit, not a branch.
//
// `band` is the proximity window as a fraction of the threshold: a metric
// inside it (or already the wrong side of it) becomes a candidate.

export interface CapsuleCovenantTest {
  /** i18n variant leaf under `capsuleEmpty.suggest.covenant.<id>`. */
  id: string;
  /** `PeriodMetric.name`, as the engine emits it (pipeline.py). */
  metric: string;
  /** "min" = the metric must stay ABOVE the threshold. */
  direction: "min" | "max";
  threshold: number;
  band: number;
}

export const CAPSULE_COVENANT_TESTS: readonly CapsuleCovenantTest[] = Object.freeze([
  { id: "dscr", metric: "dscr", direction: "min", threshold: 1.25, band: 0.25 },
  { id: "interestCover", metric: "ebitda_to_interest", direction: "min", threshold: 4.0, band: 0.25 },
  { id: "leverage", metric: "net_debt_to_ebitda", direction: "max", threshold: 3.0, band: 0.25 },
  { id: "liquidity", metric: "current_ratio", direction: "min", threshold: 1.2, band: 0.25 },
]);

export interface CapsuleCovenantProximity {
  test: CapsuleCovenantTest;
  /** Signed headroom as a fraction of the threshold. Negative = already
   *  the wrong side. Used ONLY for ranking — never rendered (S1). */
  headroom: number;
}

/**
 * The tightest default covenant test on this snapshot, or null.
 *
 * A metric that is absent, null, or non-finite produces nothing (S3).
 * A zero threshold would divide by zero, so it is skipped by
 * construction rather than guarded downstream.
 */
export function tightestCovenant(
  metrics: readonly CapsuleMetricSeed[],
  tests: readonly CapsuleCovenantTest[] = CAPSULE_COVENANT_TESTS,
): CapsuleCovenantProximity | null {
  let best: CapsuleCovenantProximity | null = null;
  for (const test of tests) {
    if (!test.threshold) continue;
    const row = metrics.find((m) => m.name === test.metric);
    const value = row?.value;
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const headroom =
      test.direction === "min"
        ? (value - test.threshold) / test.threshold
        : (test.threshold - value) / test.threshold;
    if (headroom > test.band) continue;
    // Ties break on the tests' declared order — `>` keeps the earlier one.
    if (best === null || headroom < best.headroom) best = { test, headroom };
  }
  return best;
}

// ─── Trust variants ────────────────────────────────────────────────────

/** Which trust question a band earns. `balanced` and `unverified` earn
 *  none: a clean verdict has nothing to ask about, and an unverified
 *  period must not be spoken about as if it had been checked. */
export function trustVariant(
  band: CapsuleTrustBand | null,
): { variant: "imbalance" | "drift" | "reconciled"; priority: number } | null {
  switch (band) {
    case "material_imbalance":
      return { variant: "imbalance", priority: 95 };
    case "minor_drift":
    case "needs_review":
      return { variant: "drift", priority: 75 };
    case "reconciled":
      return { variant: "reconciled", priority: 60 };
    default:
      return null;
  }
}

// ─── Priorities (S4) ───────────────────────────────────────────────────

const SEVERITY_PRIORITY: Record<CapsuleFindingSeed["severity"], number> = {
  critical: 100,
  high: 90,
  medium: 70,
  low: 55,
  info: 50,
};

const UNATTACHED_PRIORITY = 80;
const COVENANT_PRIORITY = 65;
const SILENCE_PRIORITY = 40;

const KIND_ORDER: Record<CapsuleSuggestionKind, number> = {
  unattached: 0,
  finding: 1,
  trust: 2,
  covenant: 3,
  silence: 4,
};

// ─── The builder ───────────────────────────────────────────────────────

/**
 * At most three questions, computed from this workspace's state.
 *
 * Candidate set, each contributing AT MOST ONE row:
 *   · unattached — the newest period with no document attached
 *   · finding    — the top surfaced Anomaly Radar row, as a question
 *   · trust      — the active period's balance verdict, when it is not
 *                  a clean BALANCED
 *   · covenant   — the tightest DEFAULT covenant test (S2)
 *   · silence    — the checks ran and nothing surfaced
 *
 * `finding` and `silence` are mutually exclusive by construction: the
 * engine only claims silence when nothing surfaced.
 *
 * Returns fewer than three — including ZERO — when the state yields
 * fewer. There is no padding branch.
 */
export function buildCapsuleSuggestions(
  snapshot: CapsuleWorkspaceSnapshot,
  mode: ViewMode,
): CapsuleSuggestion[] {
  const s = snapshot ?? EMPTY_SNAPSHOT;
  const out: CapsuleSuggestion[] = [];

  // 1. Unattached period — the workspace is missing a file, which no
  //    amount of analysis can answer around.
  const unattached = s.unattached[0];
  if (unattached) {
    const label = pickLabel([unattached.label]);
    if (label) {
      out.push({
        id: `capsule.suggest.unattached.${unattached.periodId}`,
        kind: "unattached",
        labelKey: `capsuleEmpty.suggest.unattached.${mode}`,
        labelParams: { period: label },
        basisKey: "capsuleEmpty.basis.unattached",
        priority: UNATTACHED_PRIORITY,
        mode,
      });
    }
  }

  // 2. Top surfaced finding, as a question about its SUBJECT (S1).
  const finding = s.findings[0];
  if (finding) {
    out.push({
      id: `capsule.suggest.finding.${finding.key}`,
      kind: "finding",
      labelKey: `capsuleEmpty.suggest.finding.${mode}`,
      labelParams: { subject: finding.subject },
      basisKey: "capsuleEmpty.basis.finding",
      priority: SEVERITY_PRIORITY[finding.severity] ?? SEVERITY_PRIORITY.info,
      mode,
    });
  }

  // 3. Balance verdict — only when there is a verdict to ask about.
  const trust = trustVariant(s.trustBand);
  if (trust && s.periodLabel) {
    const label = pickLabel([s.periodLabel]);
    if (label) {
      out.push({
        id: `capsule.suggest.trust.${trust.variant}`,
        kind: "trust",
        labelKey: `capsuleEmpty.suggest.trust.${trust.variant}.${mode}`,
        labelParams: { period: label },
        basisKey: "capsuleEmpty.basis.trust",
        priority: trust.priority,
        mode,
      });
    }
  }

  // 4. Tightest default covenant test.
  const covenant = tightestCovenant(s.metrics);
  if (covenant) {
    out.push({
      id: `capsule.suggest.covenant.${covenant.test.id}`,
      kind: "covenant",
      labelKey: `capsuleEmpty.suggest.covenant.${covenant.test.id}.${mode}`,
      labelParams: {},
      basisKey: "capsuleEmpty.basis.covenant",
      priority: COVENANT_PRIORITY,
      mode,
    });
  }

  // 5. Silence is a RESULT — the checks ran and said nothing.
  if (s.silence && s.findings.length === 0) {
    out.push({
      id: "capsule.suggest.silence",
      kind: "silence",
      labelKey: `capsuleEmpty.suggest.silence.${mode}`,
      labelParams: {},
      basisKey: "capsuleEmpty.basis.silence",
      priority: SILENCE_PRIORITY,
      mode,
    });
  }

  out.sort(
    (a, b) =>
      b.priority - a.priority ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return out.slice(0, MAX_SUGGESTIONS);
}

// ─── The context zone (rendered ABOVE the suggestions) ─────────────────

export interface CapsuleContextModel {
  /** A period is loaded. Kept SEPARATE from `periodLabel` because the
   *  two can disagree: a loaded period whose only label is figure-shaped
   *  is refused a name (S1) but is still loaded, and telling the reader
   *  "no period loaded" in that state would be a false statement. */
  hasPeriod: boolean;
  /** Formatted period label, or null — the surface then says so in words
   *  rather than printing a placeholder id. */
  periodLabel: string | null;
  /** Trust band for the chip; null renders NO chip (never a fake one). */
  trustBand: CapsuleTrustBand | null;
  /** True when the workspace has a period but it carries no verdict. */
  unverified: boolean;
  /** Count of periods still waiting for a document. */
  unattachedCount: number;
  /** Count of surfaced findings — a count is not a figure; it is never
   *  money and never converts. */
  findingCount: number;
}

/** The context zone's model. Pure; same rules as the suggestions. */
export function buildCapsuleContext(
  snapshot: CapsuleWorkspaceSnapshot,
): CapsuleContextModel {
  const s = snapshot ?? EMPTY_SNAPSHOT;
  return {
    hasPeriod: s.hasPeriod,
    periodLabel: s.hasPeriod ? pickLabel([s.periodLabel]) : null,
    trustBand: s.trustBand,
    unverified: s.hasPeriod && (s.trustBand === null || s.trustBand === "unverified"),
    unattachedCount: s.unattached.length,
    findingCount: s.findings.length,
  };
}
