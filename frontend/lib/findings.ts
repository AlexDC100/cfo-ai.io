// THE CONTRACT, CLIENT-SIDE — types, normalisation, and the one rule
// this layer is allowed to apply.
//
// `src/engine/api/_finding.py` decides what a finding IS. It carries
// seven typed elements, validates itself, and stamps `surfaced` inside
// its only serializer — so a row arrives here already judged. This
// module is the mirror of that payload plus `_finding_rank.py`'s ranked
// wrapper, and it holds itself to the engine's own asymmetry:
//
//   DEMOTION IS THE DEFAULT PATH. This layer may demote — a row that
//   claims `surfaced: true` while missing a contract element is put on
//   the checks list, because the alternative is rendering an empty slot
//   as if it were an insight. It may NEVER promote: nothing here sets
//   `surfaced` to true, infers it from severity, or treats "looks
//   important" as a verdict. `surfacedOf()` is a conjunction of the
//   engine's stamp AND the client's own completeness check, so the two
//   can only ever agree downward.
//
//   NO NUMBERS ARE INVENTED. Every figure rendered by this feature comes
//   from `facts_cited`, `evidence.figures`, `threshold` or `impact`. The
//   "recompute without this item" affordance shows `impact.adjusted` —
//   a number the ENGINE computed through `_ratio_units` — never a
//   client-side subtraction. There is no arithmetic in this file beyond
//   counting rows.
//
//   ABSENT IS NOT ZERO. Every optional number is `number | null`. A
//   missing limit renders as "—", never as 0.
//
//   SILENCE IS VALID. `silence_statement()` from the engine is passed
//   through untouched; when it is present the UI states it verbatim and
//   lists what was checked. There is no filler branch.
//
// Money is deliberately NOT formatted here. Every money figure in this
// feature renders through `NarrativeText` (frontend/lib/narrativeMoney.tsx)
// so one claim can never straddle the currency-conversion boundary — the
// Critical-461 defect. This module's `formatDimensionless` handles only
// units that are, by definition, currency-invariant.

import { useMemo, useSyncExternalStore } from "react";

import { activeLocale } from "@/lib/locale";
import { FACT_TO_SOURCE } from "@/lib/linkifyAlertBody";
import type { TraceableSource } from "@/lib/traceableSource";

// ── the vocabulary, mirroring the engine ────────────────────────────────

/** `_ratio_units` unit names. `unknown` is a refusal, never a default. */
export type FindingUnit =
  | "money"
  | "ratio"
  | "percent"
  | "days"
  | "count"
  | "score"
  | "unknown";

export type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";

/** `_finding_rank.DISPOSITION_*`. */
export type FindingDisposition = "surfaced" | "info" | "all_checks";

/** `_finding_rank.TIER_*`. */
export type MaterialityTier = "material" | "info" | "immaterial";

export type ConfidenceLevel = "high" | "medium" | "low";

/** `_finding.CONTRACT_ELEMENTS`, in the engine's own order. */
export const CONTRACT_ELEMENTS = [
  "subject",
  "evidence",
  "threshold",
  "impact",
  "why_here",
  "action",
  "confidence",
] as const;
export type ContractElement = (typeof CONTRACT_ELEMENTS)[number];

/** `_finding.COMPARATORS` — the word the engine prints for each. */
export const COMPARATOR_WORD: Record<string, string> = {
  ">": "above",
  ">=": "at or above",
  "<": "below",
  "<=": "at or below",
  "!=": "away from",
};

// ── the seven, as they arrive ───────────────────────────────────────────

export interface FindingAccount {
  code: string;
  name: string;
  statement: string | null;
  bucket: string | null;
}

export interface FindingSubject {
  accounts: FindingAccount[];
  scope: string;
}

export interface FindingFigure {
  fact: string;
  value: number;
  unit: FindingUnit;
  label: string;
}

export interface FindingProvenance {
  period_id: string;
  snapshot_id: string | null;
  line_refs: string[];
  source: string;
}

export interface FindingComparisonBasis {
  kind: string;
  description: string;
  basis_value: number | null;
  basis_unit: string | null;
}

export interface FindingEvidence {
  figures: FindingFigure[];
  provenance: FindingProvenance | null;
  comparison_basis: FindingComparisonBasis | null;
}

export interface FindingThreshold {
  rule_id: string;
  parameter: string;
  parameter_label: string;
  comparator: string;
  limit: number | null;
  observed: number | null;
  unit: FindingUnit;
  source: string;
}

export interface FindingImpact {
  kind: "recomputed_ratio" | "money_delta" | "headroom" | string;
  metric: string;
  metric_label: string;
  baseline: number | null;
  adjusted: number | null;
  delta: number | null;
  unit: FindingUnit;
  currency: string | null;
  baseline_fact: string | null;
  adjusted_fact: string | null;
}

export interface FindingWhyHere {
  profile_id: string;
  profile_label: string;
  rationale: string;
  signals: string[];
  anchors: string[];
}

export interface FindingActionStep {
  imperative: string;
  artefact: string;
  provider: string;
  horizon: string | null;
}

export interface FindingAction {
  steps: FindingActionStep[];
}

export interface FindingConfidence {
  level: ConfidenceLevel | string;
  basis: string;
  caveat: string | null;
}

export interface FindingContractElements {
  subject: FindingSubject | null;
  evidence: FindingEvidence | null;
  threshold: FindingThreshold | null;
  impact: FindingImpact | null;
  why_here: FindingWhyHere | null;
  action: FindingAction | null;
  confidence: FindingConfidence | null;
}

// ── the ranked wrapper ──────────────────────────────────────────────────

export interface FindingMateriality {
  basis_id: string;
  basis_label: string;
  basis_value: number | null;
  amount: number | null;
  share: number | null;
  floor: number | null;
  tier: MaterialityTier | string;
  source: string;
  statement: string;
}

export interface FindingScore {
  impact: number;
  confidence: number;
  persistence: number;
  actionability: number;
  total: number;
}

export interface FindingDismissal {
  rule_id: string;
  scope_key: string;
  reason: string;
  dismissed_by: string;
  dismissed_at: string;
  from_period_ordinal: number | null;
  periods: number | null;
}

/** One check that RAN — fired or not. The proof that silence is a claim. */
export interface CheckRow {
  rule_id: string;
  parameter: string;
  comparator: string;
  limit: number | null;
  observed: number | null;
  unit: FindingUnit;
  fired: boolean;
  profile_id: string;
  note: string;
  disposition?: FindingDisposition | string;
  materiality?: FindingMateriality | null;
}

/** `FindingSet.silence_statement()` — passed through, never rephrased. */
export interface SilenceStatement {
  material_findings: number;
  profile_id: string;
  checks_performed: number;
  statement: string;
  checks: CheckRow[];
}

/**
 * One normalised row. Everything the engine stamped, plus the two things
 * this layer computes about it — and neither of them can raise its
 * standing.
 */
export interface Finding {
  /** Stable per period+rule+scope. Used as a React key and as the
   *  dismissal / export-pack identity. */
  key: string;
  ruleKey: string;
  severity: FindingSeverity;
  effectiveSeverity: FindingSeverity;
  category: string;
  sourceCurrency: string;
  factsCited: Record<string, number>;
  factUnits: Record<string, string>;
  profileId: string;
  profileFingerprint: string;
  narrativeSource: string;

  title: string | null;
  body: string | null;
  titleTemplate: string | null;
  bodyTemplate: string | null;

  elements: FindingContractElements;

  /** The engine's stamp, verbatim. */
  engineSurfaced: boolean;
  /** Elements this layer found absent. Empty for a complete finding. */
  missingElements: ContractElement[];
  /** The engine's own reasons, when it demoted the row. */
  demotionReasons: string[];
  demotionReason: string;

  rank: number;
  score: FindingScore | null;
  disposition: FindingDisposition;
  materiality: FindingMateriality | null;
  persistence: number;
  persistenceLabel: string;
  rootCause: string;
  recommendation: boolean;
  mergedFrom: string[];
  contributorRules: string[];
  contributorSummary: string;
  dismissed: boolean;
  dismissal: FindingDismissal | null;
  dismissedButRetained: boolean;
}

export interface FindingsReport {
  /** Complete, material, above the cap — the recommendations. */
  surfaced: Finding[];
  /** Complete but below the materiality floor. Never a recommendation. */
  info: Finding[];
  /** Everything that did not surface, with the reason attached. */
  demoted: Finding[];
  /** Every rule that ran, fired or not. */
  checks: CheckRow[];
  counts: {
    candidates: number;
    surfaced: number;
    info: number;
    demoted: number;
    checks: number;
    fired: number;
    dismissed: number;
    incomplete: number;
    immaterial: number;
    heldBack: number;
    merged: number;
  };
  cap: number | null;
  /** `RankedReport.statement()` — the engine's own sentence about what
   *  is shown and what is not. Null when no ranked report was supplied. */
  statement: string | null;
  materialityPolicy: string | null;
  /** Present only when NOTHING surfaced. The exact claim, plus the list. */
  silence: SilenceStatement | null;
  /** False when the period carried no contract rows at all — the caller
   *  should fall back to its legacy surface rather than claim silence. */
  hasContractRows: boolean;
}

// ── parsing ─────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, dflt = ""): string {
  return typeof v === "string" ? v : dflt;
}

/** A number, or null. Never 0 as a stand-in — ABSENT IS NOT ZERO. */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function unit(v: unknown): FindingUnit {
  const s = str(v);
  return s === "money" ||
    s === "ratio" ||
    s === "percent" ||
    s === "days" ||
    s === "count" ||
    s === "score"
    ? s
    : "unknown";
}

function severity(v: unknown): FindingSeverity {
  const s = str(v);
  return s === "critical" || s === "high" || s === "medium" || s === "low" || s === "info"
    ? s
    : "info";
}

function numberMap(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isRecord(v)) return out;
  for (const [k, raw] of Object.entries(v)) {
    if (typeof raw === "number" && Number.isFinite(raw)) out[k] = raw;
  }
  return out;
}

function stringMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(v)) return out;
  for (const [k, raw] of Object.entries(v)) {
    if (typeof raw === "string") out[k] = raw;
  }
  return out;
}

function parseSubject(v: unknown): FindingSubject | null {
  if (!isRecord(v)) return null;
  const accounts = Array.isArray(v.accounts)
    ? v.accounts.filter(isRecord).map((a) => ({
        code: str(a.code),
        name: str(a.name),
        statement: typeof a.statement === "string" ? a.statement : null,
        bucket: typeof a.bucket === "string" ? a.bucket : null,
      }))
    : [];
  const scope = str(v.scope);
  // An element that is structurally empty is an ABSENT element, not a
  // present-but-blank one. Returning `{}` here would let a card render a
  // heading with nothing under it and still count as complete.
  if (accounts.length === 0 || !scope) return null;
  return { accounts, scope };
}

function parseEvidence(v: unknown): FindingEvidence | null {
  if (!isRecord(v)) return null;
  const figures = Array.isArray(v.figures)
    ? v.figures
        .filter(isRecord)
        .map((f) => ({
          fact: str(f.fact),
          value: num(f.value) ?? Number.NaN,
          unit: unit(f.unit),
          label: str(f.label),
        }))
        .filter((f) => f.fact !== "" && Number.isFinite(f.value))
    : [];
  const p = isRecord(v.provenance) ? v.provenance : null;
  const provenance: FindingProvenance | null = p
    ? {
        period_id: str(p.period_id),
        snapshot_id: typeof p.snapshot_id === "string" ? p.snapshot_id : null,
        line_refs: strList(p.line_refs),
        source: str(p.source),
      }
    : null;
  const c = isRecord(v.comparison_basis) ? v.comparison_basis : null;
  const comparison_basis: FindingComparisonBasis | null = c
    ? {
        kind: str(c.kind),
        description: str(c.description),
        basis_value: num(c.basis_value),
        basis_unit: typeof c.basis_unit === "string" ? c.basis_unit : null,
      }
    : null;
  if (figures.length === 0) return null;
  return { figures, provenance, comparison_basis };
}

function parseThreshold(v: unknown): FindingThreshold | null {
  if (!isRecord(v)) return null;
  const parameter_label = str(v.parameter_label);
  const comparator = str(v.comparator);
  if (!parameter_label || !comparator) return null;
  return {
    rule_id: str(v.rule_id),
    parameter: str(v.parameter),
    parameter_label,
    comparator,
    limit: num(v.limit),
    observed: num(v.observed),
    unit: unit(v.unit),
    source: str(v.source),
  };
}

function parseImpact(v: unknown): FindingImpact | null {
  if (!isRecord(v)) return null;
  const metric_label = str(v.metric_label);
  if (!metric_label) return null;
  return {
    kind: str(v.kind),
    metric: str(v.metric),
    metric_label,
    baseline: num(v.baseline),
    adjusted: num(v.adjusted),
    delta: num(v.delta),
    unit: unit(v.unit),
    currency: typeof v.currency === "string" ? v.currency : null,
    baseline_fact: typeof v.baseline_fact === "string" ? v.baseline_fact : null,
    adjusted_fact: typeof v.adjusted_fact === "string" ? v.adjusted_fact : null,
  };
}

function parseWhyHere(v: unknown): FindingWhyHere | null {
  if (!isRecord(v)) return null;
  const rationale = str(v.rationale);
  if (!rationale) return null;
  return {
    profile_id: str(v.profile_id),
    profile_label: str(v.profile_label),
    rationale,
    signals: strList(v.signals),
    anchors: strList(v.anchors),
  };
}

function parseAction(v: unknown): FindingAction | null {
  if (!isRecord(v)) return null;
  const steps = Array.isArray(v.steps)
    ? v.steps
        .filter(isRecord)
        .map((s) => ({
          imperative: str(s.imperative),
          artefact: str(s.artefact),
          provider: str(s.provider),
          horizon: typeof s.horizon === "string" ? s.horizon : null,
        }))
        .filter((s) => s.imperative !== "")
    : [];
  if (steps.length === 0) return null;
  return { steps };
}

function parseConfidence(v: unknown): FindingConfidence | null {
  if (!isRecord(v)) return null;
  const level = str(v.level);
  if (!level) return null;
  return {
    level,
    basis: str(v.basis),
    caveat: typeof v.caveat === "string" && v.caveat.trim() !== "" ? v.caveat : null,
  };
}

function parseMateriality(v: unknown): FindingMateriality | null {
  if (!isRecord(v)) return null;
  return {
    basis_id: str(v.basis_id),
    basis_label: str(v.basis_label),
    basis_value: num(v.basis_value),
    amount: num(v.amount),
    share: num(v.share),
    floor: num(v.floor),
    tier: str(v.tier, "material"),
    source: str(v.source),
    statement: str(v.statement),
  };
}

function parseDismissal(v: unknown): FindingDismissal | null {
  if (!isRecord(v)) return null;
  return {
    rule_id: str(v.rule_id),
    scope_key: str(v.scope_key, "*"),
    reason: str(v.reason),
    dismissed_by: str(v.dismissed_by),
    dismissed_at: str(v.dismissed_at),
    from_period_ordinal: num(v.from_period_ordinal),
    periods: num(v.periods),
  };
}

export function parseCheckRow(v: unknown): CheckRow | null {
  if (!isRecord(v)) return null;
  const rule_id = str(v.rule_id);
  if (!rule_id) return null;
  return {
    rule_id,
    parameter: str(v.parameter),
    comparator: str(v.comparator),
    limit: num(v.limit),
    observed: num(v.observed),
    unit: unit(v.unit),
    fired: v.fired === true,
    profile_id: str(v.profile_id),
    note: str(v.note),
    disposition: typeof v.disposition === "string" ? v.disposition : undefined,
    materiality: parseMateriality(v.materiality),
  };
}

export function parseSilenceStatement(v: unknown): SilenceStatement | null {
  if (!isRecord(v)) return null;
  const statement = str(v.statement);
  if (!statement) return null;
  const checks = Array.isArray(v.checks)
    ? v.checks.map(parseCheckRow).filter((c): c is CheckRow => c !== null)
    : [];
  return {
    material_findings: num(v.material_findings) ?? 0,
    profile_id: str(v.profile_id),
    checks_performed: num(v.checks_performed) ?? checks.length,
    statement,
    checks,
  };
}

/**
 * One row → one Finding, or `null` when the row is not a contract row at
 * all (a legacy alert written before the rebuild). Returning null rather
 * than a half-built Finding is what lets the calling surface fall back to
 * its old renderer instead of showing a card with six empty sections.
 */
export function parseFinding(raw: unknown): Finding | null {
  if (!isRecord(raw)) return null;
  const ce = raw.contract_elements;
  if (!isRecord(ce)) return null;

  const elements: FindingContractElements = {
    subject: parseSubject(ce.subject),
    evidence: parseEvidence(ce.evidence),
    threshold: parseThreshold(ce.threshold),
    impact: parseImpact(ce.impact),
    why_here: parseWhyHere(ce.why_here),
    action: parseAction(ce.action),
    confidence: parseConfidence(ce.confidence),
  };

  const missingElements = CONTRACT_ELEMENTS.filter((el) => elements[el] === null);

  const ruleKey = str(raw.rule_key) || elements.threshold?.rule_id || "";
  const rootCause = str(raw.root_cause);
  const scope = elements.subject?.scope ?? "";
  const periodId = elements.evidence?.provenance?.period_id ?? "";

  return {
    key: [periodId, ruleKey, rootCause || scope].filter(Boolean).join("|") || ruleKey,
    ruleKey,
    severity: severity(raw.severity),
    effectiveSeverity: severity(raw.effective_severity ?? raw.severity),
    category: str(raw.category),
    sourceCurrency: (str(raw.source_currency, "RON") || "RON").toUpperCase(),
    factsCited: numberMap(raw.facts_cited),
    factUnits: stringMap(raw.fact_units),
    profileId: str(raw.profile_id),
    profileFingerprint: str(raw.profile_fingerprint),
    narrativeSource: str(raw.narrative_source, "deterministic"),

    title: typeof raw.title === "string" ? raw.title : null,
    body: typeof raw.body === "string" ? raw.body : null,
    titleTemplate: typeof raw.title_template === "string" ? raw.title_template : null,
    bodyTemplate: typeof raw.body_template === "string" ? raw.body_template : null,

    elements,
    engineSurfaced: raw.surfaced === true,
    missingElements,
    demotionReasons: strList(raw.demotion_reasons),
    demotionReason: str(raw.demotion_reason),

    rank: num(raw.rank) ?? 0,
    score: isRecord(raw.score)
      ? {
          impact: num(raw.score.impact) ?? 0,
          confidence: num(raw.score.confidence) ?? 0,
          persistence: num(raw.score.persistence) ?? 0,
          actionability: num(raw.score.actionability) ?? 0,
          total: num(raw.score.total) ?? 0,
        }
      : null,
    disposition:
      raw.disposition === "surfaced" || raw.disposition === "info" || raw.disposition === "all_checks"
        ? raw.disposition
        : raw.surfaced === true
          ? "surfaced"
          : "all_checks",
    materiality: parseMateriality(raw.materiality),
    persistence: num(raw.persistence) ?? 1,
    persistenceLabel: str(raw.persistence_label),
    rootCause,
    recommendation: raw.recommendation === true,
    mergedFrom: strList(raw.merged_from),
    contributorRules: strList(raw.contributor_rules),
    contributorSummary: str(raw.contributor_summary),
    dismissed: raw.dismissed === true,
    dismissal: parseDismissal(raw.dismissal),
    dismissedButRetained: raw.dismissed_but_retained === true,
  };
}

/**
 * THE ONE RULE THIS LAYER APPLIES.
 *
 * A finding is surfaced when the engine stamped it surfaced AND the row
 * that arrived actually carries all seven elements. The conjunction only
 * moves in one direction: a truncated payload demotes, a rich-looking
 * payload never promotes. `disposition` is honoured too — a complete
 * finding held back by the cap stays held back.
 */
export function surfacedOf(f: Finding): boolean {
  return (
    f.engineSurfaced && f.missingElements.length === 0 && f.disposition === "surfaced"
  );
}

/** Complete and material, but ranked below the cap or under the floor. */
export function isInfoRow(f: Finding): boolean {
  return f.engineSurfaced && f.missingElements.length === 0 && f.disposition === "info";
}

/** The check row a demoted finding degrades to, when the engine did not
 *  already supply one. Never prose — the rule and the numbers only. */
export function checkRowFor(f: Finding): CheckRow {
  const t = f.elements.threshold;
  const reasons = f.demotionReasons.length
    ? f.demotionReasons.join("; ")
    : f.demotionReason;
  return {
    // `_finding.check_record` keys the row by the THRESHOLD's rule id when
    // there is a threshold, falling back to the finding's own. Mirrored
    // exactly: a different key here would fail to match the engine's own
    // check row for the same finding and list it twice under two names.
    rule_id: (t ? t.rule_id : f.ruleKey) || "",
    parameter: t?.parameter ?? "",
    comparator: t?.comparator ?? "",
    limit: t?.limit ?? null,
    observed: t?.observed ?? null,
    unit: t?.unit ?? "unknown",
    fired: t !== null,
    profile_id: f.profileId,
    note: reasons,
    disposition: f.disposition,
    materiality: f.materiality,
  };
}

const EMPTY_COUNTS: FindingsReport["counts"] = {
  candidates: 0,
  surfaced: 0,
  info: 0,
  demoted: 0,
  checks: 0,
  fired: 0,
  dismissed: 0,
  incomplete: 0,
  immaterial: 0,
  heldBack: 0,
  merged: 0,
};

export const EMPTY_REPORT: FindingsReport = {
  surfaced: [],
  info: [],
  demoted: [],
  checks: [],
  counts: { ...EMPTY_COUNTS },
  cap: null,
  statement: null,
  materialityPolicy: null,
  silence: null,
  hasContractRows: false,
};

/**
 * Build the report from whatever the period actually carried.
 *
 * Accepts the ranked-report shape (`{surfaced, info, demoted, checks,
 * counts, cap, statement}` from `RankedReport.to_payload()`) OR a flat
 * list of alert rows, because the persistence lane may land either. Rows
 * that are not contract rows are ignored, and `hasContractRows` says so —
 * a caller must not claim silence over a period it could not read.
 */
export function buildFindingsReport(input: unknown): FindingsReport {
  const rows: unknown[] = [];
  let cap: number | null = null;
  let statement: string | null = null;
  let materialityPolicy: string | null = null;
  let silence: SilenceStatement | null = null;
  let engineChecks: CheckRow[] = [];
  let engineCounts: Record<string, number> = {};

  if (Array.isArray(input)) {
    rows.push(...input);
  } else if (isRecord(input)) {
    const report = isRecord(input.report) ? input.report : input;
    for (const bucket of ["surfaced", "info", "demoted"]) {
      const list = report[bucket];
      if (Array.isArray(list)) rows.push(...list);
    }
    if (Array.isArray(report.alerts)) rows.push(...report.alerts);
    if (Array.isArray(report.checks)) {
      engineChecks = report.checks
        .map(parseCheckRow)
        .filter((c): c is CheckRow => c !== null);
    }
    if (Array.isArray(report.all_checks)) {
      engineChecks = engineChecks.concat(
        report.all_checks.map(parseCheckRow).filter((c): c is CheckRow => c !== null),
      );
    }
    cap = num(report.cap);
    statement = typeof report.statement === "string" ? report.statement : null;
    materialityPolicy =
      typeof report.materiality_policy === "string" ? report.materiality_policy : null;
    silence = parseSilenceStatement(input.silence ?? report.silence);
    engineCounts = numberMap(report.counts);
  }

  const findings = rows
    .map(parseFinding)
    .filter((f): f is Finding => f !== null);

  const surfaced: Finding[] = [];
  const info: Finding[] = [];
  const demoted: Finding[] = [];
  for (const f of findings) {
    if (surfacedOf(f)) surfaced.push(f);
    else if (isInfoRow(f)) info.push(f);
    else demoted.push(f);
  }
  surfaced.sort(compareSurfaced);
  info.sort(compareSurfaced);
  demoted.sort((a, b) => a.ruleKey.localeCompare(b.ruleKey));

  // The engine's own check rows first; a demoted finding contributes one
  // only when the engine did not already list it (matched on rule id).
  // `silence.checks` IS the check list on a quiet period — merged here so
  // a silence payload that carries nothing else still proves itself.
  //
  // DEDUPE PREFERS THE ROW THAT SAYS SOMETHING. `rank_findings` emits a
  // check row per finding AND the runner already emitted one when the
  // finding was added, so a demoted finding arrives twice: once bare,
  // once carrying "demoted: action: no action supplied". Keeping the
  // first would drop the reason — the one piece of information the
  // checks list exists to carry. So a later duplicate upgrades the
  // kept row's note, disposition and materiality instead of being
  // discarded whole.
  const byId = new Map<string, CheckRow>();
  const checks: CheckRow[] = [];
  for (const c of engineChecks.concat(silence?.checks ?? [])) {
    const id = `${c.rule_id}|${c.parameter}`;
    const kept = byId.get(id);
    if (!kept) {
      const row = { ...c };
      byId.set(id, row);
      checks.push(row);
      continue;
    }
    if (!kept.note && c.note) kept.note = c.note;
    if (!kept.disposition && c.disposition) kept.disposition = c.disposition;
    if (!kept.materiality && c.materiality) kept.materiality = c.materiality;
  }
  // A demoted finding the engine did not already list contributes its
  // own row — and upgrades an existing bare row with its reason, for the
  // same reason the dedupe above does.
  for (const f of demoted) {
    const row = checkRowFor(f);
    const id = `${row.rule_id}|${row.parameter}`;
    const kept = byId.get(id);
    if (!kept) {
      byId.set(id, row);
      checks.push(row);
      continue;
    }
    if (!kept.note && row.note) kept.note = row.note;
    if (!kept.materiality && row.materiality) kept.materiality = row.materiality;
  }

  const heldBack = engineCounts.held_back ?? 0;
  const counts: FindingsReport["counts"] = {
    candidates: engineCounts.candidates ?? findings.length,
    surfaced: surfaced.length,
    info: info.length,
    demoted: demoted.length,
    checks: checks.length,
    fired: checks.filter((c) => c.fired).length,
    dismissed: engineCounts.dismissed ?? surfaced.filter((f) => f.dismissed).length,
    incomplete:
      engineCounts.incomplete ?? demoted.filter((f) => f.missingElements.length > 0).length,
    immaterial:
      engineCounts.immaterial ??
      demoted.filter((f) => f.materiality?.tier === "immaterial").length,
    heldBack,
    merged: engineCounts.merged ?? 0,
  };

  return {
    surfaced,
    info,
    demoted,
    checks,
    counts,
    cap,
    statement,
    materialityPolicy,
    // SILENCE IS VALID — but only when nothing surfaced. The engine's
    // own `silence_statement()` returns None in that case; this mirrors
    // it rather than second-guessing it.
    silence: surfaced.length === 0 ? silence : null,
    hasContractRows: findings.length > 0 || engineChecks.length > 0 || silence !== null,
  };
}

/** Rank ascending, then severity, then rule id — the engine's own total
 *  order, reproduced so the client cannot reshuffle the queue. */
function compareSurfaced(a: Finding, b: Finding): number {
  if (a.rank !== b.rank) {
    if (a.rank === 0) return 1;
    if (b.rank === 0) return -1;
    return a.rank - b.rank;
  }
  const sev = SEVERITY_RANK[a.effectiveSeverity] - SEVERITY_RANK[b.effectiveSeverity];
  if (sev !== 0) return sev;
  return a.ruleKey.localeCompare(b.ruleKey);
}

export const SEVERITY_RANK: Record<FindingSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

/** Derive the report from rows already loaded with the period. */
export function useFindingsReport(rows: unknown): FindingsReport {
  return useMemo(() => buildFindingsReport(rows), [rows]);
}

// ── rendering helpers (dimensionless only — money never passes here) ────

/**
 * Mirror of `_finding._format_value` for the units that are
 * currency-invariant. Money is absent ON PURPOSE: it renders through
 * `NarrativeText`, which is the only path that knows the display
 * currency and the rate. A `money` unit here returns null so a caller
 * that forgot cannot print a bare number.
 */
export function formatDimensionless(
  value: number | null | undefined,
  u: FindingUnit,
  opts?: { daysWord?: string },
): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const locale = activeLocale();
  const fixed = (v: number, d: number) =>
    new Intl.NumberFormat(locale, {
      minimumFractionDigits: d,
      maximumFractionDigits: d,
    }).format(v);
  if (u === "percent") return `${fixed(value * 100, 1)}%`;
  if (u === "ratio") return `${fixed(value, 2)}×`;
  if (u === "days") return `${fixed(value, 0)} ${opts?.daysWord ?? "days"}`;
  if (u === "count") return fixed(value, 0);
  if (u === "score") return fixed(value, 1);
  return null;
}

/** Signed variant, for a delta. Percent deltas read as points. */
export function formatSignedDimensionless(
  value: number | null | undefined,
  u: FindingUnit,
  opts?: { daysWord?: string; pointsWord?: string },
): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const body = formatDimensionless(Math.abs(value), u, opts);
  if (body === null) return null;
  const sign = value >= 0 ? "+" : "−";
  if (u === "percent" && opts?.pointsWord) {
    return `${sign}${body.replace("%", "")} ${opts.pointsWord}`;
  }
  return `${sign}${body}`;
}

/** The template that routes ONE money fact through the money path. */
export function moneyTemplate(fact: string): string {
  return `{{money:${fact}}}`;
}

/**
 * Which named fact IS this money value.
 *
 * Not a guess, and not arithmetic: a SURFACED finding cannot carry a
 * money figure that is absent from `facts_cited`, because the engine's
 * renderer would have printed it as a bare "RON 123" and
 * `_orphan_currency_labels` would have refused the render (see
 * `OrphanCurrencyLabelError`). So a money number on a surfaced card is
 * always one of the cited facts, and this resolves WHICH — which is what
 * lets a threshold limit or an impact endpoint travel the same currency
 * path as the evidence figures instead of printing as an unconvertible
 * literal.
 *
 * Deterministic: candidate names are sorted, so the same payload always
 * resolves to the same fact. No match → `undefined`, and the caller
 * renders the absent dash rather than a raw number with a raw label.
 */
export function resolveMoneyFact(
  value: number | null | undefined,
  facts: Record<string, number> | null | undefined,
  factUnits: Record<string, string> | null | undefined,
): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || !facts) return undefined;
  const names = Object.keys(facts).sort();
  for (const name of names) {
    if (factUnits && factUnits[name] && factUnits[name] !== "money") continue;
    const v = facts[name];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const tol = 1e-6 * Math.max(1, Math.abs(v), Math.abs(value));
    if (Math.abs(v - value) <= tol) return name;
  }
  return undefined;
}

/** Where a figure's source row lives, when it has one. Clickability and
 *  currency are independent — a fact with nowhere to jump to still
 *  renders through the money path. */
export function traceFor(fact: string): TraceableSource | undefined {
  return FACT_TO_SOURCE[fact];
}

/** The first figure of a finding that has somewhere to jump to. */
export function primaryTrace(f: Finding): TraceableSource | undefined {
  for (const fig of f.elements.evidence?.figures ?? []) {
    const t = traceFor(fig.fact);
    if (t) return t;
  }
  return undefined;
}

/** Scope key — what a dismissal is scoped BY. One key, learned once:
 *  the same meaning for persistence, dismissal and merge. */
export function scopeKeyOf(f: Finding): string {
  return f.rootCause || f.elements.subject?.accounts.map((a) => a.code).join("+") || "*";
}

/**
 * The exact `Dismissal` payload `_finding_rank.Dismissal.from_payload`
 * consumes. Built here so a caller cannot invent a shape; `reason` is
 * required by construction because a dismissal without one is a deletion.
 */
export function buildDismissal(
  f: Finding,
  reason: string,
  opts?: { dismissedBy?: string; dismissedAt?: string; periods?: number | null },
): FindingDismissal {
  return {
    rule_id: f.ruleKey,
    scope_key: scopeKeyOf(f),
    reason,
    dismissed_by: opts?.dismissedBy ?? "",
    dismissed_at: opts?.dismissedAt ?? "",
    from_period_ordinal: null,
    periods: opts?.periods ?? null,
  };
}

/**
 * The question to hand the assistant. Built from the finding's own
 * elements — the model is asked to EXPLAIN numbers that are already on
 * the page, never to produce them.
 */
export function chatPromptFor(f: Finding): string {
  const scope = f.elements.subject?.scope ?? f.ruleKey;
  const accounts = (f.elements.subject?.accounts ?? [])
    .map((a) => `${a.code} (${a.name})`)
    .join(", ");
  const lines = [
    `Explain this finding from my period analysis: ${scope}.`,
    accounts ? `Accounts: ${accounts}.` : "",
    f.title ? `Headline: ${f.title}` : "",
    f.elements.threshold
      ? `Rule ${f.elements.threshold.rule_id} fired on ${f.elements.threshold.parameter_label}.`
      : "",
    "Do not restate the numbers — tell me what they mean for the business and what the first step costs.",
  ];
  return lines.filter(Boolean).join("\n");
}

// ── the export pack (device-local selection, not a preference) ──────────
//
// Which findings a reader has marked for the export pack describes THIS
// screen's working set, so it stays in localStorage and is never mirrored
// to `user_prefs` / `org_prefs`. Same reasoning as DocsPanel filters in
// the Milestone C contract.

const PACK_KEY = "cfo:findings-export-pack:v1";
type Listener = () => void;
const packListeners = new Set<Listener>();

function readPack(): string[] {
  try {
    const raw = localStorage.getItem(PACK_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writePack(keys: string[]): void {
  try {
    localStorage.setItem(PACK_KEY, JSON.stringify(keys));
  } catch {
    /* storage unavailable — the session still works, unpersisted */
  }
  for (const l of packListeners) l();
}

let packCache: string[] | null = null;
let packSnapshot = "[]";

function packStoreSnapshot(): string {
  const current = JSON.stringify(readPack());
  if (current !== packSnapshot) {
    packSnapshot = current;
    packCache = null;
  }
  return packSnapshot;
}

export function exportPackKeys(): string[] {
  if (packCache === null) packCache = JSON.parse(packStoreSnapshot()) as string[];
  return packCache;
}

export function toggleExportPack(key: string): void {
  const keys = readPack();
  const next = keys.includes(key) ? keys.filter((k) => k !== key) : keys.concat(key);
  packCache = null;
  writePack(next);
}

export function clearExportPack(): void {
  packCache = null;
  writePack([]);
}

function subscribePack(l: Listener): () => void {
  packListeners.add(l);
  return () => packListeners.delete(l);
}

/** The keys currently in the export pack, re-rendering on change. */
export function useExportPack(): string[] {
  useSyncExternalStore(subscribePack, packStoreSnapshot, () => "[]");
  return exportPackKeys();
}
