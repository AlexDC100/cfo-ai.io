/**
 * THE INSIGHT READER — and nothing but a reader.
 *
 * `src/engine/insights/` finds what a sharp CFO would notice in a finished
 * book and emits it, with the accounts and the ladder behind every finding,
 * as `statements.insights`. This module hands that block to the two render
 * surfaces (`financialReport.ts`'s printed export and
 * `pages/cfo/ComprehensiveReport.tsx`'s screen).
 *
 * THE ONE RULE
 * ------------
 * **It computes no number the engine did not emit.** There is no
 * arithmetic in this file beyond formatting: no division, no share, no
 * "if it's missing use zero". Every digit a reader sees came off an
 * `InsightMeasure` the engine authored, and `formatMeasure` is the only
 * thing that turns one into a string.
 *
 * That is not stylistic. The last wave's defects were four-of-five
 * export-only, because the export recomputed things the screen read
 * straight. Two surfaces that both format the SAME emitted measure cannot
 * disagree; two surfaces that both compute cannot be made to agree for
 * long.
 *
 * ABSENT IS NOT ZERO
 * ------------------
 * `value: null` means the engine could not compute it. `formatMeasure`
 * returns the literal `"not reported"` for it — never `0`, never `"—"`,
 * never an empty cell that reads as a rendering bug. Do not write `?? 0`
 * anywhere near an insight.
 *
 * SMALL IS NOT ZERO EITHER
 * ------------------------
 * A share of 0.0125% printed at one decimal reads as "0.0%", i.e. as
 * nothing. `formatMeasure` widens the precision until a significant digit
 * survives, mirroring `engine.insights.measures._percent` exactly, so the
 * screen, the export and the engine's own `claim` string render one
 * measure one way.
 */

export type InsightUnit =
  | "money"
  | "ratio"
  | "pct"
  | "multiple"
  | "days"
  | "years"
  | "count";

export type InsightLevel = "critical" | "high" | "medium" | "low" | "info";

/** critical first. The colour ramp and every sort read this. */
export const SEVERITY_ORDER: InsightLevel[] = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
];

export const SEVERITY_LABEL: Record<InsightLevel, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  info: "Info",
};

export interface InsightAccount {
  /** RO chart-of-accounts code exactly as the book carries it. */
  code: string;
  /** The book's own account name. Scrubbed in the committed fixtures. */
  name: string;
  /** Signed, in the block's currency. Contra accounts are negative. */
  amount: number;
  /** Which side of the detector's arithmetic this account fed. */
  role: string;
}

export interface InsightFact {
  /** Dotted address into the served envelope: `assembled_bs.ppe_net`. */
  name: string;
  label: string;
  value: number | null;
  unit: InsightUnit;
}

export interface InsightMeasure {
  key: string;
  label: string;
  value: number | null;
  unit: InsightUnit;
  /** What a `count` counts ("account"). Only counts carry one. */
  noun?: string;
}

export interface InsightSeverityBand {
  level: InsightLevel;
  /** Inclusive lower bound on the materiality scale; `null` on the floor. */
  at_least: number | null;
}

export interface InsightSeverity {
  level: InsightLevel;
  basis: string;
  basis_label: string;
  basis_value: number | null;
  magnitude: number | null;
  /** magnitude ÷ basis_value. `null` when the basis was unavailable. */
  materiality: number | null;
  /** The ladder the verdict was actually read against. */
  bands: InsightSeverityBand[];
  why: string;
}

export interface InsightNarrative {
  explanation: string | null;
  so_what: string | null;
  /** `"deterministic"` when the advisory lane did not run or was refused. */
  source: "ai" | "deterministic";
  reason?: string;
}

export interface Insight {
  id: string;
  title: string;
  claim_template: string;
  /** The claim the ENGINE rendered. Prefer this for plain text. */
  claim: string;
  formula: string;
  severity: InsightSeverity;
  measures: InsightMeasure[];
  accounts: InsightAccount[];
  facts: InsightFact[];
  rank: number;
  rank_basis: string;
  in_summary: boolean;
  narrative: InsightNarrative;
}

export interface InsightNotFired {
  id: string;
  title: string;
  /** The stated gap. Render it — a detector that found nothing is news. */
  reason: string;
}

export interface InsightsBlock {
  schema_version: string;
  currency: string;
  /** Already in rank order, 1..N. */
  insights: Insight[];
  /** At most 5 ids, in rank order. */
  summary_ids: string[];
  not_fired: InsightNotFired[];
}

const UNITS: InsightUnit[] = [
  "money",
  "ratio",
  "pct",
  "multiple",
  "days",
  "years",
  "count",
];

function isLevel(value: unknown): value is InsightLevel {
  return typeof value === "string" && (SEVERITY_ORDER as string[]).includes(value);
}

function isUnit(value: unknown): value is InsightUnit {
  return typeof value === "string" && (UNITS as string[]).includes(value);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Read the block off a served `statements` payload.
 *
 * Returns `null` — never a synthesised empty block — when the payload
 * carries no insights. An older period, or a payload served before the
 * engine emitted the block, must render NOTHING rather than an empty
 * "no findings" section, which would assert that the book is clean when
 * in fact it was never read.
 */
export function readInsights(statements: unknown): InsightsBlock | null {
  if (!statements || typeof statements !== "object") return null;
  const raw = (statements as Record<string, unknown>).insights;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const block = raw as Record<string, unknown>;
  const list = block.insights;
  if (!Array.isArray(list)) return null;

  const insights = list
    .map(readInsight)
    .filter((i): i is Insight => i !== null);

  const notFired = Array.isArray(block.not_fired)
    ? block.not_fired
        .map((n) => {
          if (!n || typeof n !== "object") return null;
          const entry = n as Record<string, unknown>;
          if (typeof entry.id !== "string" || typeof entry.reason !== "string") {
            return null;
          }
          return {
            id: entry.id,
            title: typeof entry.title === "string" ? entry.title : entry.id,
            reason: entry.reason,
          };
        })
        .filter((n): n is InsightNotFired => n !== null)
    : [];

  return {
    schema_version:
      typeof block.schema_version === "string" ? block.schema_version : "",
    currency: typeof block.currency === "string" ? block.currency : "",
    insights,
    summary_ids: Array.isArray(block.summary_ids)
      ? block.summary_ids.filter((s): s is string => typeof s === "string")
      : insights.filter((i) => i.in_summary).map((i) => i.id),
    not_fired: notFired,
  };
}

function readInsight(raw: unknown): Insight | null {
  if (!raw || typeof raw !== "object") return null;
  const i = raw as Record<string, unknown>;
  if (typeof i.id !== "string" || typeof i.claim !== "string") return null;
  const severityRaw = (i.severity ?? {}) as Record<string, unknown>;
  const level = isLevel(severityRaw.level) ? severityRaw.level : "info";

  const bands = Array.isArray(severityRaw.bands)
    ? severityRaw.bands
        .map((b) => {
          if (!b || typeof b !== "object") return null;
          const band = b as Record<string, unknown>;
          if (!isLevel(band.level)) return null;
          return { level: band.level, at_least: numberOrNull(band.at_least) };
        })
        .filter((b): b is InsightSeverityBand => b !== null)
    : [];

  const narrativeRaw = (i.narrative ?? {}) as Record<string, unknown>;

  return {
    id: i.id,
    title: typeof i.title === "string" ? i.title : i.id,
    claim_template:
      typeof i.claim_template === "string" ? i.claim_template : i.claim,
    claim: i.claim,
    formula: typeof i.formula === "string" ? i.formula : "",
    severity: {
      level,
      basis: typeof severityRaw.basis === "string" ? severityRaw.basis : "",
      basis_label:
        typeof severityRaw.basis_label === "string"
          ? severityRaw.basis_label
          : "",
      basis_value: numberOrNull(severityRaw.basis_value),
      magnitude: numberOrNull(severityRaw.magnitude),
      materiality: numberOrNull(severityRaw.materiality),
      bands,
      why: typeof severityRaw.why === "string" ? severityRaw.why : "",
    },
    measures: readList(i.measures, readMeasure),
    accounts: readList(i.accounts, readAccount),
    facts: readList(i.facts, readFact),
    rank: typeof i.rank === "number" ? i.rank : 0,
    rank_basis: typeof i.rank_basis === "string" ? i.rank_basis : "",
    in_summary: i.in_summary === true,
    narrative: {
      explanation:
        typeof narrativeRaw.explanation === "string"
          ? narrativeRaw.explanation
          : null,
      so_what:
        typeof narrativeRaw.so_what === "string" ? narrativeRaw.so_what : null,
      source: narrativeRaw.source === "ai" ? "ai" : "deterministic",
      reason:
        typeof narrativeRaw.reason === "string" ? narrativeRaw.reason : undefined,
    },
  };
}

function readList<T>(raw: unknown, read: (r: unknown) => T | null): T[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(read).filter((x): x is T => x !== null);
}

function readMeasure(raw: unknown): InsightMeasure | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.key !== "string" || !isUnit(m.unit)) return null;
  return {
    key: m.key,
    label: typeof m.label === "string" ? m.label : m.key,
    value: numberOrNull(m.value),
    unit: m.unit,
    noun: typeof m.noun === "string" ? m.noun : undefined,
  };
}

function readAccount(raw: unknown): InsightAccount | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  if (typeof a.code !== "string" || typeof a.amount !== "number") return null;
  return {
    code: a.code,
    name: typeof a.name === "string" ? a.name : "",
    amount: a.amount,
    role: typeof a.role === "string" ? a.role : "",
  };
}

function readFact(raw: unknown): InsightFact | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  if (typeof f.name !== "string" || !isUnit(f.unit)) return null;
  return {
    name: f.name,
    label: typeof f.label === "string" ? f.label : f.name,
    value: numberOrNull(f.value),
    unit: f.unit,
  };
}

// ── formatting: the only thing this module does to a number ────────────

function group(value: number, decimals: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Mirrors `engine.insights.measures._percent` exactly. */
function percent(pct: number): string {
  if (pct === 0) return "0.0%";
  for (const decimals of [1, 2, 3, 4]) {
    const text = group(pct, decimals);
    if (Number(text.replace(/,/g, "")) !== 0) return `${text}%`;
  }
  return pct > 0 ? "<0.0001%" : ">-0.0001%";
}

/**
 * The ONE formatter. `null` is `"not reported"` — an absent input is a
 * stated gap, never a plausible figure.
 */
export function formatMeasure(
  measure: Pick<InsightMeasure, "value" | "unit" | "noun">,
  currency: string,
): string {
  if (measure.value === null) return "not reported";
  const value = measure.value;
  switch (measure.unit) {
    case "money":
      return `${(currency || "").toUpperCase()} ${group(value, 2)}`;
    case "ratio":
      return percent(value * 100);
    case "pct":
      return percent(value);
    case "multiple":
      return `${group(value, 2)}×`;
    case "days":
      return `${group(value, 1)} days`;
    case "years":
      return `${group(value, 1)} years`;
    default: {
      const text = group(value, 0);
      if (!measure.noun) return text;
      const noun =
        Math.abs(value) !== 1 && !measure.noun.endsWith("s")
          ? `${measure.noun}s`
          : measure.noun;
      return `${text} ${noun}`;
    }
  }
}

/** Format a raw amount in the block's currency. Formatting only. */
export function formatAmount(value: number | null, currency: string): string {
  return formatMeasure({ value, unit: "money" }, currency);
}

// ── lookups ────────────────────────────────────────────────────────────

export function summaryInsights(block: InsightsBlock): Insight[] {
  const wanted = new Set(block.summary_ids);
  return block.insights.filter((i) => wanted.has(i.id));
}

export function insightById(block: InsightsBlock, id: string): Insight | null {
  return block.insights.find((i) => i.id === id) ?? null;
}

export function measure(insight: Insight, key: string): InsightMeasure | null {
  return insight.measures.find((m) => m.key === key) ?? null;
}

/**
 * The claim, rebuilt from the measures rather than taken from the engine's
 * pre-rendered string. Use it only when the figures need styling; the
 * engine's `claim` is the default because the two are asserted identical
 * by `frontend/lib/__tests__/insightsReader.test.ts` and one string is
 * cheaper than a re-substitution.
 *
 * A template naming a measure the insight does not carry throws — a claim
 * with a hole in it is worse than no claim, and silently leaving the
 * placeholder visible would ship `{money:step}` to a reader.
 */
export function renderInsightClaim(insight: Insight, currency: string): string {
  return insight.claim_template.replace(
    /\{(measure|money):([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_full, kind: string, key: string) => {
      const found = measure(insight, key);
      if (!found) {
        throw new Error(
          `insight ${insight.id} claim names measure "${key}", which it does not carry; it carries: ${insight.measures
            .map((m) => m.key)
            .join(", ")}`,
        );
      }
      if (kind === "money" && found.unit !== "money") {
        throw new Error(
          `insight ${insight.id} claim asks for {money:${key}} but that measure is a ${found.unit}`,
        );
      }
      return formatMeasure(found, currency);
    },
  );
}

/**
 * The severity ladder as printable rows, with the ACTIVE band marked.
 *
 * TC-10: the cutoffs render from the same table the verdict read, so a
 * reader who disagrees with a level can see the ladder that produced it
 * — instead of prose restating a threshold that can drift from the code.
 */
export function severityLadder(
  insight: Insight,
): Array<{ level: InsightLevel; label: string; active: boolean }> {
  const basis = insight.severity.basis_label || "the basis";
  return insight.severity.bands.map((band) => ({
    level: band.level,
    label:
      band.at_least === null
        ? `${SEVERITY_LABEL[band.level]} — below every cutoff`
        : `${SEVERITY_LABEL[band.level]} at ${percent(band.at_least * 100)} of ${basis.toLowerCase()} or more`,
    active: band.level === insight.severity.level,
  }));
}

/**
 * The one-line severity caption: the level AND the basis it was scaled
 * against. A level printed alone is a bare threshold claim — "High"
 * against what? — which is what R4 exists to stop.
 */
export function severityCaption(insight: Insight): string {
  const { level, materiality, basis_label } = insight.severity;
  if (materiality === null) {
    return `${SEVERITY_LABEL[level]} · ${basis_label || "scale"} not available on this book`;
  }
  return `${SEVERITY_LABEL[level]} · ${percent(materiality * 100)} of ${(basis_label || "the basis").toLowerCase()}`;
}
