// The served ratio table — typed mirror and the ONE formatter.
//
// ── AUTHORITY ─────────────────────────────────────────────────────────
//
// The engine is the one authority for ratio values, bands, deltas, band
// movements and credit composites for BOTH periods. It serves:
//
//   · a per-period block at get_period → assembled_metrics.ratio_table
//     (src/engine/ratios/table.py), mirrored here as RatioTableV1;
//   · a two-period block at /comparatives → ratios
//     (src/engine/comparatives/ratio_compare.py), mirrored here as
//     RatioComparisonV1.
//
// Every FE surface (tile, comparison table, drawer, report HTML and PDF,
// workbook, executive summary) is a READER of those documents. This file
// is where a reader turns a served row into printed text, and it does
// ZERO arithmetic on a served value:
//
//   · `value_q`, `delta.value` and `delta.pct_change` are quantized
//     decimal STRINGS, serialised by the engine with ROUND_HALF_UP at the
//     unit's display precision. They are printed verbatim. The only change
//     is the decimal separator, localised for the reader's language, and
//     the unit suffix, which comes from i18n (statements.ratioCmp.unit.*).
//     No toFixed, no Number(), no subtraction — printed prior plus printed
//     delta equals printed current because the engine made it so.
//   · The colour of a delta comes from the served `favourable` verdict,
//     never from the sign of the delta. A days ratio whose value FELL is an
//     improvement when the engine says lower is better; reading the sign
//     would paint it red.
//   · A missing number is never a dash. It prints the sentence for the
//     served reason code, in the reader's language; a missing reason code
//     prints a sentence saying no reason was served, so the gap is visible
//     rather than disguised as "no change".
//
// A served string that is not a plain decimal (for example "1E+2" or
// "NaN") is refused with its own sentence instead of being printed: the
// contract says quantized decimal, and a reader that prints whatever
// arrives would forward an engine defect to the user as a figure.

import i18n from "@/i18n";
import type { ChipTone } from "@/components/instrument/Panel";

// ─── Enumerations (closed, mirrored from the served schema) ─────────────

export type RatioBand = "strong" | "healthy" | "watch" | "critical";

/** CREDIT_LETTER_LADDER letters. For the letter_grade row the side's
 *  `band` is the letter itself, never re-banded into a ratio word. */
export type CreditLetter = "AAA" | "AA" | "A" | "BBB" | "BB" | "B" | "CCC" | "CC";

export type RatioGroup =
  | "liquidity"
  | "profitability"
  | "leverage"
  | "coverage"
  | "efficiency"
  | "distress"
  | "credit";

export const RATIO_DISPLAY_UNITS = ["x", "pct", "days", "z", "score", "grade"] as const;
export type RatioDisplayUnit = (typeof RATIO_DISPLAY_UNITS)[number];

export const RATIO_DELTA_UNITS = ["turns", "pp", "days", "z", "points", "notches"] as const;
export type RatioDeltaUnit = (typeof RATIO_DELTA_UNITS)[number];

export type RatioBandStatus = "graded" | "ungraded_sector" | "withheld_sign" | "refused";

export type RatioFavourable = "improved" | "deteriorated" | "none";

export type RatioMovementStatus = "crossed_up" | "crossed_down" | "same_band" | "not_comparable";

export type AltmanZone = "safe" | "grey" | "distress";

// ─── Row shapes ─────────────────────────────────────────────────────────

export interface RatioOperand {
  name: string;
  value: number | null;
  /** 'assembled_pl.<k>' | 'canonical_bs.<row_id>' | 'assembled_bs.<k>' | 'credit_model.<name>' */
  source: string;
}

export interface RatioReason {
  code: string;
  inputs: string[];
}

/** Rungs in the value's DISPLAY unit (pct rows are percent, not fractions),
 *  quantized strings. `critical` is optional: a ladder without it floors at
 *  watch. */
export interface RatioLadder {
  strong: string;
  healthy: string;
  watch: string;
  critical?: string;
}

export interface RatioSide {
  /** Full precision. Never printed; carried for charts and audits. */
  value: number | null;
  /** Quantized at the display precision, the only printable form. */
  value_q: string | null;
  band: RatioBand | CreditLetter | null;
  band_status: RatioBandStatus;
  ladder: RatioLadder | null;
  operands: RatioOperand[];
  reason: RatioReason | null;
}

export interface RatioDelta {
  /** Quantized, signed, computed by the engine from the QUANTIZED sides. */
  value: string | null;
  unit: RatioDeltaUnit;
  /** Turns rows only; null when the quantized prior is zero. */
  pct_change: string | null;
  favourable: RatioFavourable | null;
  reason_code: string | null;
}

export interface RatioRungCrossed {
  name: string;
  value: string;
}

export interface RatioMateriality {
  basis_key: string;
  basis_value: string | number | null;
  headroom_money: string | number | null;
  share: string | number | null;
}

export interface RatioMovement {
  status: RatioMovementStatus;
  from: RatioBand | CreditLetter | null;
  to: RatioBand | CreditLetter | null;
  /** rank(to) − rank(from) on critical 0, watch 1, healthy 2, strong 3. */
  rungs_crossed: number;
  rung_crossed: RatioRungCrossed | null;
  distance_past_rung: string | null;
  band_width: string | null;
  band_width_basis: "closed" | "adjacent" | null;
  distance_fraction: string | null;
  materiality: RatioMateriality | null;
  reason_code: string | null;
}

/** A row of the per-period table: one Side plus the row's identity. */
export interface RatioTableRow extends RatioSide {
  key: string;
  group: RatioGroup;
  label_key: string;
  formula_key: string;
  display_unit: RatioDisplayUnit;
  /** Required on every row, refused and ungraded rows included. */
  higher_is_better: boolean;
}

/** A row of the two-period table. */
export interface RatioCompareRow {
  key: string;
  group: RatioGroup;
  label_key: string;
  formula_key: string;
  display_unit: RatioDisplayUnit;
  higher_is_better: boolean;
  current: RatioSide;
  prior: RatioSide;
  delta: RatioDelta;
  movement: RatioMovement;
  finding_id: string | null;
}

// ─── Credit block ───────────────────────────────────────────────────────

export type CreditSubscoreKey =
  | "altman"
  | "profitability"
  | "leverage"
  | "coverage"
  | "dscr"
  | "liquidity"
  | "equity";

export interface CreditAltman {
  z: number | null;
  x1: number | null;
  x2: number | null;
  x3: number | null;
  x4: number | null;
  zone: AltmanZone | null;
  thresholds: Record<string, number>;
}

export interface CreditLadderRung {
  min: number;
  grade: CreditLetter;
}

export interface CreditAsFiled {
  composite: number | null;
  altman_z: number | null;
  letter: CreditLetter | null;
  credit_model_revision: number | "unknown";
}

export interface CreditBlock {
  revision: number;
  altman: CreditAltman;
  subscores: Record<CreditSubscoreKey, number | null>;
  weights: Record<CreditSubscoreKey, number>;
  composite: number | null;
  letter: CreditLetter | null;
  ladder: CreditLadderRung[];
  as_filed: CreditAsFiled | null;
  as_filed_differs: boolean;
}

// ─── Per-period block (get_period → assembled_metrics.ratio_table) ──────

export interface RatioTableStamps {
  ratio_table_version: string;
  credit_model_revision: number;
  bands: {
    source: string;
    industry_resolved: string | null;
    table_sha256: string;
  };
  pack_provenance: Record<string, unknown> | null;
  methodology_version: string | null;
  assembled_at: "serve";
}

export interface RatioTableCoverage {
  census_count: number;
  served: number;
  refused: Record<string, string>;
  band_withheld: Record<string, string>;
}

export interface RatioTableV1 {
  table_version: "ratio_table.v1";
  stamps: RatioTableStamps;
  /** TC-13 declared census of ratio keys. */
  census: string[];
  coverage: RatioTableCoverage;
  rows: RatioTableRow[];
  credit: CreditBlock;
}

// ─── Two-period block (/comparatives → ratios) ──────────────────────────

export type RatioRankOrderTerm =
  | "abs(rungs_crossed) desc"
  | "distance_fraction desc nulls last"
  | "materiality.share desc nulls last"
  | "key asc";

export interface RatioRankBasis {
  order: RatioRankOrderTerm[];
  sentence_key: string;
  materiality_floor: string | number | null;
  bases: Record<string, unknown>;
}

export interface RatioBandMovements {
  rank_basis: RatioRankBasis;
  improved: string[];
  deteriorated: string[];
  unchanged: { key: string; band: RatioBand | CreditLetter | null }[];
  not_comparable: { key: string; reason_code: string }[];
  /** Finding.to_payload() rows, or check rows when demoted, in rank order.
   *  Typed loosely here: the findings contract owns that shape. */
  findings: Record<string, unknown>[];
}

export interface RatioComparisonStamps {
  current: RatioTableStamps;
  prior: RatioTableStamps;
  comparable_model: boolean;
  differences: string[];
}

export interface RatioComparisonCoverage {
  census_count: number;
  both_sides: number;
  prior_refused: Record<string, string>;
  current_refused: Record<string, string>;
}

export interface RatioComparisonV1 {
  table_version: string;
  current_label: string;
  prior_label: string;
  stamps: RatioComparisonStamps;
  rows: RatioCompareRow[];
  /** altman_z, credit_composite, letter_grade. */
  composites: RatioCompareRow[];
  /** Supporting detail, never listed as movements. */
  subscores: RatioCompareRow[];
  band_movements: RatioBandMovements;
  coverage: RatioComparisonCoverage;
}

// ─── Reason codes ───────────────────────────────────────────────────────
//
// The closed set of reason codes this reader has a sentence for, in both
// languages (statements.ratioCmp.reason.<code>). The engine batches that
// emit the codes must emit from this set; a code outside it still renders,
// through the `unlisted` sentence that NAMES the code, so a new code shows
// up as a visible gap rather than as a dash. `unstated` is the sentence for
// a null where the contract requires a reason; `malformed_value` is this
// reader's own refusal to print a served string that is not a decimal.

export const RATIO_REASON_CODES = [
  // side
  "operand_missing",
  "denominator_zero",
  "denominator_negative",
  "credit_inputs_missing",
  "period_absent",
  // band
  "sector_ungraded",
  "sign_withheld",
  // delta
  "current_refused",
  "prior_refused",
  "both_refused",
  // movement
  "band_not_graded",
  "ladder_differs",
  "credit_model_differs",
] as const;

export type RatioReasonCode = (typeof RATIO_REASON_CODES)[number];

/** Reader-side sentences that are not served codes. */
export const RATIO_READER_REASONS = ["unstated", "unlisted", "malformed_value"] as const;

const REASON_SET: ReadonlySet<string> = new Set(RATIO_REASON_CODES);

export function reasonKey(reasonCode: string | null | undefined): string {
  if (reasonCode === null || reasonCode === undefined || reasonCode === "") {
    return "statements.ratioCmp.reason.unstated";
  }
  return REASON_SET.has(reasonCode)
    ? `statements.ratioCmp.reason.${reasonCode}`
    : "statements.ratioCmp.reason.unlisted";
}

// ─── Locale plumbing ────────────────────────────────────────────────────

export type RatioLocale = "en" | "ro";

export function ratioLocale(lang: string | null | undefined): RatioLocale {
  return lang?.startsWith("ro") ? "ro" : "en";
}

function tFor(locale: string | null | undefined) {
  return i18n.getFixedT(ratioLocale(locale ?? i18n.language));
}

/** Text for a reason code in the given language. */
export function reasonText(reasonCode: string | null | undefined, locale?: string): string {
  return tFor(locale)(reasonKey(reasonCode), { code: reasonCode ?? "" });
}

/** A plain quantized decimal: optional sign, digits, optional fraction. */
const DECIMAL_SHAPE = /^[+-]?\d+(\.\d+)?$/;

/** Localise the decimal separator of a served decimal string. String
 *  replacement only: the digits are the engine's. */
export function localiseDecimal(served: string, locale: RatioLocale): string {
  return locale === "ro" ? served.replace(".", ",") : served;
}

/** "1", "+1", "-1" — the one string whose unit takes the singular form.
 *  A string comparison, not a numeric one: "1.0" stays plural. */
function isUnitOne(served: string): boolean {
  return served.replace(/^[+-]/, "") === "1";
}

// ─── Formatters ─────────────────────────────────────────────────────────

const SIDE_UNIT_KEY: Record<RatioDisplayUnit, string> = {
  x: "x",
  pct: "pct",
  days: "days",
  z: "z",
  score: "score",
  grade: "grade",
};

const DELTA_UNIT_KEY: Record<RatioDeltaUnit, string> = {
  turns: "turns",
  pp: "pp",
  days: "days",
  z: "z",
  points: "points",
  notches: "notches",
};

/** Units whose i18n suffix has a singular form (daysOne, pointsOne, …). */
const HAS_ONE_FORM = new Set(["days", "points", "notches"]);

function withUnit(
  t: ReturnType<typeof tFor>,
  unitKey: string,
  served: string,
  locale: RatioLocale,
): string {
  const one = HAS_ONE_FORM.has(unitKey) && isUnitOne(served);
  const key = `statements.ratioCmp.unit.${unitKey}${one ? "One" : ""}`;
  return t(key, { v: localiseDecimal(served, locale) });
}

/** One side of a ratio (current or prior) as printed text. */
export function formatRatioSide(
  side: RatioSide | null | undefined,
  unit: RatioDisplayUnit,
  locale?: string,
): string {
  const loc = ratioLocale(locale ?? i18n.language);
  const t = tFor(loc);
  if (!side) return t(reasonKey("period_absent"));
  const served = side.value_q;
  if (served === null || served === undefined) {
    const code = side.reason?.code ?? null;
    return t(reasonKey(code), { code: code ?? "" });
  }
  if (unit === "grade") {
    // A letter. No separator to localise, no suffix.
    return t(`statements.ratioCmp.unit.${SIDE_UNIT_KEY.grade}`, { v: served });
  }
  if (!DECIMAL_SHAPE.test(served)) return t("statements.ratioCmp.reason.malformed_value");
  return withUnit(t, SIDE_UNIT_KEY[unit], served, loc);
}

export interface FormattedRatioDelta {
  /** The delta in its unit, or the reason sentence when there is none. */
  primary: string;
  /** Turns rows: the percent change, or the sentence for why there is none.
   *  Every other unit: null. */
  secondary: string | null;
}

/** The served delta as printed text. */
export function formatRatioDelta(
  delta: RatioDelta | null | undefined,
  locale?: string,
): FormattedRatioDelta {
  const loc = ratioLocale(locale ?? i18n.language);
  const t = tFor(loc);
  if (!delta) return { primary: t(reasonKey(null)), secondary: null };
  const served = delta.value;
  if (served === null || served === undefined) {
    return {
      primary: t(reasonKey(delta.reason_code), { code: delta.reason_code ?? "" }),
      secondary: null,
    };
  }
  if (!DECIMAL_SHAPE.test(served)) {
    return { primary: t("statements.ratioCmp.reason.malformed_value"), secondary: null };
  }
  const primary = withUnit(t, DELTA_UNIT_KEY[delta.unit], served, loc);
  if (delta.unit !== "turns") return { primary, secondary: null };
  const pct = delta.pct_change;
  if (pct === null || pct === undefined) {
    return { primary, secondary: t("statements.ratioCmp.pctNoBase") };
  }
  if (!DECIMAL_SHAPE.test(pct)) {
    return { primary, secondary: t("statements.ratioCmp.reason.malformed_value") };
  }
  return {
    primary,
    secondary: t("statements.ratioCmp.unit.turnsPct", { v: localiseDecimal(pct, loc) }),
  };
}

/** Delta colour from the served favourable verdict — never from the sign
 *  of the delta and never from higher_is_better: the engine already
 *  combined the two. */
export function deltaTone(favourable: RatioFavourable | null | undefined): ChipTone {
  switch (favourable) {
    case "improved":
      return "success";
    case "deteriorated":
      return "alert";
    default:
      return "neutral";
  }
}

/** Band-movement chip tone from the served movement status. "Up" is up the
 *  band ladder (critical → strong), as rungs_crossed counts it. When the
 *  served status and the sign of rungs_crossed disagree the engine sent a
 *  contradiction: the chip is amber, neither praise nor alarm. */
export function movementTone(movement: RatioMovement | null | undefined): ChipTone {
  if (!movement) return "neutral";
  switch (movement.status) {
    case "crossed_up":
      return movement.rungs_crossed > 0 ? "success" : "caution";
    case "crossed_down":
      return movement.rungs_crossed < 0 ? "alert" : "caution";
    case "same_band":
      return movement.rungs_crossed === 0 ? "neutral" : "caution";
    default:
      return "neutral";
  }
}

const BAND_WORD_KEY: Record<RatioBand, string> = {
  strong: "dashV2.ratioVerdictStrong",
  healthy: "dashV2.ratioVerdictHealthy",
  watch: "dashV2.ratioVerdictWatch",
  critical: "dashV2.ratioVerdictCritical",
};

/** The one spelling of a band word (the same keys the tile uses). A null
 *  band is "not reported"; a credit letter has no word — it returns null
 *  and the letter is printed as served. */
export function bandWordKey(band: RatioBand | CreditLetter | null | undefined): string | null {
  if (band === null || band === undefined) return "dashV2.ratioVerdictUnknown";
  return (BAND_WORD_KEY as Record<string, string>)[band] ?? null;
}

/** The word for a side whose band is not graded. */
export function bandStatusKey(status: RatioBandStatus): string | null {
  switch (status) {
    case "graded":
      return null;
    case "ungraded_sector":
      return "dashV2.ratioVerdictUngraded";
    case "withheld_sign":
      return "statements.ratioCmp.band.withheldSign";
    case "refused":
      return "dashV2.ratioVerdictUnknown";
  }
}

/** A side's band as printed text: the band word, the letter as served, or
 *  the word for why there is no band. */
export function formatRatioBand(side: RatioSide | null | undefined, locale?: string): string {
  const t = tFor(locale);
  if (!side) return t("dashV2.ratioVerdictUnknown");
  const statusKey = bandStatusKey(side.band_status);
  if (statusKey) return t(statusKey);
  const key = bandWordKey(side.band);
  return key ? t(key) : String(side.band);
}

/** The band movement as printed text: "Healthy → Strong", "Held Watch", or
 *  the served reason when the two sides are not comparable. */
export function formatRatioMovement(
  movement: RatioMovement | null | undefined,
  locale?: string,
): string {
  const t = tFor(locale);
  if (!movement) return t(reasonKey(null));
  const word = (b: RatioBand | CreditLetter | null) => {
    const key = bandWordKey(b);
    return key ? t(key) : String(b);
  };
  switch (movement.status) {
    case "crossed_up":
    case "crossed_down":
      return t("statements.ratioCmp.movement.crossed", {
        from: word(movement.from),
        to: word(movement.to),
      });
    case "same_band":
      return t("statements.ratioCmp.movement.held", { band: word(movement.to) });
    case "not_comparable":
      return t(reasonKey(movement.reason_code), { code: movement.reason_code ?? "" });
  }
}
