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
import { RATIO_CMP_SURFACE_KEYS, RATIO_LABELLED_KEYS } from "@/lib/ratioCompareKeys";

// ─── Enumerations (closed, mirrored from the served schema) ─────────────

export type RatioBand = "strong" | "healthy" | "watch" | "critical";

/** CREDIT_LETTER_LADDER letters (src/engine/ratios/credit_model.py, batch
 *  B1). For the letter_grade row the side's `band` is the letter itself,
 *  never re-banded into a ratio word. A served letter outside this set is
 *  refused, not printed. */
export const CREDIT_LETTERS = ["AAA", "AA", "A", "BBB", "BB", "B", "CCC", "CC"] as const;
export type CreditLetter = (typeof CREDIT_LETTERS)[number];

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

/** MIRROR of `BAND_STATUSES` in src/engine/ratios/table.py, same order.
 *  The engine is the authority; ratioTableFormat.test.ts G5 reads the
 *  Python tuple and reds when the two differ. */
export const RATIO_BAND_STATUSES = [
  "graded",
  "ungraded_sector",
  "withheld_sign",
  "withheld_basis",
  "not_banded",
  "refused",
] as const;
export type RatioBandStatus = (typeof RATIO_BAND_STATUSES)[number];

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
  /** Served on a `margin_not_meaningful` refusal only: the engine's own
   *  sentence per language, with the share it read and the pack threshold
   *  (engine.ratios.margin_meaning). Printed verbatim — the reader never
   *  re-derives the share or re-states the threshold. */
  display?: { ro?: string; en?: string } | null;
  share?: string | null;
  threshold?: string | null;
}

/** Rungs in the value's DISPLAY unit (pct rows are percent, not fractions),
 *  quantized strings: the entry rung of each band the pack definition
 *  declares, best first. No served ladder carries a `critical` rung. A value
 *  that reaches no rung takes the side's `ladder_floor` — `critical` for
 *  most keys (dso, dio, ...), `watch` where the pack declares that floor
 *  (dpo: below watch 30 stays watch). The Altman ladder serves only
 *  `healthy` (safe from) and `watch` (grey from). */
export interface RatioLadder {
  strong?: string;
  healthy?: string;
  watch?: string;
}

/** The band a value past the last served rung takes. */
export type RatioLadderFloor = "watch" | "critical";

export interface RatioSide {
  /** Full precision. Never printed; carried for charts and audits. */
  value: number | null;
  /** Quantized at the display precision, the only printable form. */
  value_q: string | null;
  band: RatioBand | CreditLetter | null;
  band_status: RatioBandStatus;
  ladder: RatioLadder | null;
  /** Served beside every band ladder; null on a letter ladder (its last
   *  rung, min 0, is its own floor) and wherever no ladder is served. */
  ladder_floor: RatioLadderFloor | null;
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

/** A filed figure the engine WITHDREW: it was persisted outside its
 *  pack range (a revision-1 X4 1500 / Z'' 1584.89 / composite 88.5 on a
 *  zero-liability book), so `as_filed` carries null for it and this note
 *  in its place. The value is served for the audit trail only — never
 *  printed as a figure (R-RANGE, every surface). */
export interface CreditAsFiledWithdrawn {
  figure: "altman_z_score" | "credit_composite" | string;
  value: number;
  text: string;
}

export interface CreditAsFiled {
  composite: number | null;
  altman_z: number | null;
  letter: CreditLetter | null;
  credit_model_revision: number | "unknown";
  withdrawn?: CreditAsFiledWithdrawn[];
}

/** A sub-score the credit model refused (credit_model revision 2,
 *  `subscore_refusal`): its code, the inputs it names and the served
 *  sentence. `materiality` travels with the Altman refusal (the pack share
 *  it was read against, TC-10) and `range` with an out-of-range one. */
export interface CreditSubscoreRefusal {
  code:
    | "current_liabilities_not_positive"
    | "total_liabilities_below_materiality"
    | "revenue_not_positive"
    | "interest_expense_not_positive"
    | "credit_out_of_range"
    | "credit_inputs_absent";
  component: CreditSubscoreKey;
  inputs: string[];
  text: string;
  materiality?: { share: string; basis: string; source: string; file: string };
  range?: string;
}

/** A sub-score the model STATED rather than measured (rulings R-D1, R-D2,
 *  R-D3): the pack rung, its label and source, served so no surface prints
 *  it as a measurement. */
export interface CreditDeclaredRung {
  rung: string;
  score: number;
  when: string;
  label: string;
  source: string;
  file: string;
}

/** Why the composite and the letter are absent (R-COMPOSITE): every
 *  refused component listed with its own refusal, or the composed value
 *  outside its range, or a model that did not run. */
export interface CreditCompositeRefusal {
  code: "credit_component_undefined" | "credit_out_of_range" | "credit_inputs_absent";
  inputs: string[];
  components?: Array<CreditSubscoreRefusal & { cause: string }>;
  range?: string;
  text?: string;
}

/** The pack-declared ranges every served figure was read against
 *  (R-RANGE), with the Z'' bound derived for this book. */
export interface CreditRanges {
  subscore: { min: number; max: number; source: string; file: string };
  composite: { min: number; max: number; source: string; file: string };
  altman_x1: { max: number; source: string; file: string };
  altman_x4: { max: number; max_is: string; source: string; file: string };
  altman_z: { bound: number | null; bound_is: string; derivation: string | null; source: string; file: string };
}

export interface CreditBlock {
  revision: number;
  altman: CreditAltman;
  subscores: Record<CreditSubscoreKey, number | null>;
  /** Sub-scores the model refused, with why. Any entry here means
   *  `composite` and `letter` are null (R-COMPOSITE). */
  refused_subscores: Partial<Record<CreditSubscoreKey, CreditSubscoreRefusal>>;
  /** Sub-scores stated by declared rule rather than measured, labelled. */
  declared_rungs: Partial<Record<CreditSubscoreKey, CreditDeclaredRung>>;
  /** R-D2: set when ROE was dropped from the profitability blend. */
  profitability_disclosure: { formula: string; label: string; source: string; file: string } | null;
  /** THE MODEL'S WEIGHT TABLE — the only weights a composite is ever
   *  multiplied by. Never renormalised: with a refused component there is
   *  no composite at all. */
  weights: Record<CreditSubscoreKey, number>;
  ranges: CreditRanges;
  composite: number | null;
  letter: CreditLetter | null;
  /** Null beside a composite; otherwise why there is none. */
  reason: CreditCompositeRefusal | null;
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
  /** Valued on both sides and not comparable. With improved, deteriorated
   *  and unchanged it partitions `coverage.both_sides`. */
  not_comparable: { key: string; reason_code: string }[];
  /** Movable entries refused on either side (never dropped). */
  refused: { key: string; reason_code: string }[];
  /** ONE row per crossing (improved + deteriorated), in rank order:
   *  Finding.to_payload() when surfaced, the check row it demotes to
   *  otherwise. Typed loosely here: the findings contract owns that shape. */
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
  /** The composites the movement partition covers beside the census. */
  movable_composites: string[];
  /** Census rows plus `movable_composites`, valued on both sides. */
  both_sides: number;
  /** Census rows alone, valued on both sides. */
  both_sides_census: number;
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
// The ENGINE declares the reason codes; this reader mirrors them.
// `RATIO_REASON_CODES` is an exact copy of `REASON_CODES` in
// src/engine/ratios/table.py, same order, and ratioTableFormat.test.ts G5
// parses that tuple and reds when the copy drifts or a code has no EN or
// RO sentence. The two-period composer (src/engine/comparatives/
// ratio_compare.py, batch B4) declares the delta, movement and composite
// codes; `RATIO_COMPARE_REASON_CODES` mirrors them and G5 reds when that
// file declares a code this reader has no sentence for.
//
// `RATIO_READER_REASONS` are this reader's own sentences, never served:
// `period_absent` (no side at all), `unstated` (a null where the contract
// requires a reason), `unlisted` (a code with no sentence), `malformed_value`
// (a served string that is not printable in its unit), `unrecognised` (an
// enum value outside the mirror, named in the sentence).

export const RATIO_REASON_CODES = [
  // refused (no value)
  "operand_absent",
  "zero_denominator",
  "nonpositive_denominator",
  "non_finite",
  "engine_metric_absent",
  "user_input_absent",
  "source_declares_absence",
  // the one EBITDA / operating result is refused on this period (the stock
  // variation, account 711, could not be measured) — owner ruling 2026-09-26
  "ebitda_refused",
  // a margin over a turnover negligible against operating activity
  "margin_not_meaningful",
  // the ONE inventory-days block (engine.ratios.inventory_days) refuses its
  // total, or no block is served — never a fallback formula
  "inventory_days_refused",
  // band withheld (value kept)
  "sector_unconfirmed",
  "negative_denominator",
  "no_cost_of_sales",
  "not_in_pack_bands",
] as const;

export type RatioReasonCode = (typeof RATIO_REASON_CODES)[number];

/** MIRROR of the two-period composer's declared codes
 *  (src/engine/comparatives/ratio_compare.py DELTA_REASON_CODES,
 *  MOVEMENT_REASON_CODES, COMPOSITE_REASON_CODES), de-duplicated in first
 *  appearance order. A delta without a value or a direction, a movement
 *  that is not comparable, a composite that is not scored, and the
 *  Piotroski cap each carry one. ratioTableFormat.test.ts G5 reds when the
 *  composer declares a code with no sentence here. */
export const RATIO_COMPARE_REASON_CODES = [
  "current_refused",
  "prior_refused",
  "both_refused",
  "direction_withheld",
  "basis_differs",
  "ladder_differs",
  "graded_by_letter",
  "credit_inputs_absent",
  "piotroski_prior_capped",
  "current_liabilities_not_positive",
  "total_liabilities_below_materiality",
  "revenue_not_positive",
  "interest_expense_not_positive",
  "credit_out_of_range",
  "ebitda_refused",
  // credit model revision 5: the stock-build regime's cash components on a
  // cash from operations that is approximated or refused
  "cash_from_operations_approximated",
  "cash_from_operations_refused",
  "credit_component_undefined",
] as const;

export type RatioCompareReasonCode = (typeof RATIO_COMPARE_REASON_CODES)[number];

/** The codes whose sentence names the served `reason.inputs`. */
export const RATIO_REASON_CODES_WITH_INPUTS: ReadonlySet<string> = new Set([
  "operand_absent",
  "zero_denominator",
  "nonpositive_denominator",
  "negative_denominator",
  "user_input_absent",
]);

/** Reader-side sentences that are not served codes. */
export const RATIO_READER_REASONS = [
  "period_absent",
  "unstated",
  "unlisted",
  "malformed_value",
  "unrecognised",
] as const;

const REASON_SET: ReadonlySet<string> = new Set([...RATIO_REASON_CODES, ...RATIO_COMPARE_REASON_CODES]);

export function reasonKey(reasonCode: string | null | undefined): string {
  if (reasonCode === null || reasonCode === undefined || reasonCode === "") {
    return "statements.ratioCmp.reason.unstated";
  }
  return REASON_SET.has(reasonCode)
    ? `statements.ratioCmp.reason.${reasonCode}`
    : "statements.ratioCmp.reason.unlisted";
}

// ─── Operand vocabulary ─────────────────────────────────────────────────
//
// `reason.inputs` carries engine names: a served leaf path
// ("balanceSheet.cash", "canonical_bs.total_assets"), several leaf paths
// joined by "+" when a withheld denominator is a sum, or the denominator
// phrase the engine's division names ("current liabilities"). Each maps
// to one EN/RO word under statements.ratioCmp.operand.*. A name with no
// entry prints through `operandUnmapped`, which shows the raw name — the
// input the reader has to go find is never dropped. G5 derives every name
// table.py can emit and reds on one with no entry here.

export const RATIO_OPERAND_WORD: Readonly<Record<string, string>> = {
  "balanceSheet.cash": "cash",
  "balanceSheet.accountsReceivable": "tradeReceivables",
  "balanceSheet.inventory": "inventory",
  "balanceSheet.accountsPayable": "tradePayables",
  "balanceSheet.shortTermDebt": "shortTermDebt",
  "balanceSheet.longTermDebt": "longTermDebt",
  "incomeStatement.costOfGoodsSold": "costOfSales",
  "incomeStatement.depreciationAmortization": "depreciation",
  "incomeStatement.interestExpense": "interestExpense",
  "incomeStatement.operatingExpenses": "operatingExpenses",
  "incomeStatement.otherIncome": "otherIncome",
  "incomeStatement.capitalizedOwnWork": "capitalizedOwnWork",
  "incomeStatement.revenue": "revenue",
  "incomeStatement.taxExpense": "taxExpense",
  "incomeStatement.financialExpense": "financialExpense",
  "incomeStatement.financialIncome": "financialIncome",
  "canonical_bs.current_assets": "currentAssets",
  "canonical_bs.current_liabilities": "currentLiabilities",
  "canonical_bs.equity": "totalEquity",
  "canonical_bs.total_assets": "totalAssets",
  "assembled_bs.total_current_assets": "currentAssets",
  "assembled_bs.total_current_liabilities": "currentLiabilities",
  "assembled_bs.total_equity": "totalEquity",
  "assembled_bs.total_assets": "totalAssets",
  "assembled_pl.ebitda_statutory": "ebitdaStatutory",
  // THE ONE EBITDA (owner ruling 2026-09-26): the assembled figures the
  // engine's ratio table reads, and their pre-ruling incomeStatement build.
  "assembled_pl.ebitda": "ebitda",
  "assembled_pl.operating_result": "operatingResult",
  "assembled_pl.gross_profit": "grossProfit",
  "assembled_pl.inventory_variation": "inventoryVariation",
  "incomeStatement.inventoryVariationMemo": "inventoryVariation",
  // INVENTORY DAYS — the ONE served block's own operands
  // (engine.ratios.inventory_days)
  "assembled_metrics.inventory_days": "inventoryDays",
  "assembled_metrics.inventory_days.total": "inventoryDays",
  "inventory_days.total.flow.value": "inventoryDaysFlow",
  "inventory_days.total.stock.average": "inventoryAverage",
  "incomeStatement.ebitda": "ebitda",
  "incomeStatement.ebit": "operatingResult",
  "incomeStatement.gross_profit": "grossProfit",
  "assembled_pl.net_income_statutory": "netIncomeStatutory",
  "assembled_pl.revenue": "revenue",
  "supplementary.annualLeaseExpense": "annualLeaseExpense",
  "supplementary.periodDays": "periodDays",
  "industry_signal.block_sector_content": "industrySignal",
  // denominator phrases
  "current liabilities": "currentLiabilities",
  revenue: "revenue",
  "total assets": "totalAssets",
  "total equity": "totalEquity",
  "invested capital": "investedCapital",
  EBITDA: "ebitda",
  "interest expense": "interestExpense",
  "interest + short-term debt": "debtService",
  "interest + short-term debt + lease": "debtServiceLease",
  "interest + LT principal proxy": "debtServiceLtPrincipal",
  "total operating expense": "totalOperatingExpense",
};

// ─── Locale plumbing ────────────────────────────────────────────────────

export type RatioLocale = "en" | "ro";

export function ratioLocale(lang: string | null | undefined): RatioLocale {
  return lang?.startsWith("ro") ? "ro" : "en";
}

type T = ReturnType<typeof i18n.getFixedT>;

function tFor(locale: string | null | undefined): T {
  return i18n.getFixedT(ratioLocale(locale ?? i18n.language));
}

// ─── ONE LABEL, ONE HEADING SET, EVERY SURFACE ──────────────────────────
//
// The Ratios tab resolved a row's name from the served `label_key` through
// `statements.ratioCmp.label.<key>`, while the report and the workbook
// borrowed the `computeRatios` card's own words ("Current Ratio",
// "Interest Coverage (EBITDA / Interest)", "Altman Z\"-Score") and spelled
// their headings by hand ("Δ", "Band now"). The six cells byte-matched; the
// names beside them did not, on all 31 rows (B8 verifier). These two
// functions are the authority every surface prints from; the byte-match
// gate holds the tab, the report and the workbook to them.

/** The printed name of a served ratio key, from the i18n table the tab
 *  reads — or null for a key the table does not label, so a caller falls
 *  back to whatever name it has rather than printing the raw key. */
export function ratioLabelForKey(key: string, locale?: string | null): string | null {
  if (!(RATIO_LABELLED_KEYS as readonly string[]).includes(key)) return null;
  return tFor(locale)(`statements.ratioCmp.label.${key}`);
}

/** The six column headings, in cell order: the two period labels verbatim,
 *  then the change, band-now, band-prior and movement words. */
export function ratioCompareHeadingsFor(currentLabel: string, priorLabel: string, locale?: string | null): string[] {
  const t = tFor(locale);
  return [
    currentLabel,
    priorLabel,
    t("statements.ratioCmp.ui.colChange"),
    t("statements.ratioCmp.ui.colBandNow", { label: currentLabel }),
    t("statements.ratioCmp.ui.colBandPrior", { label: priorLabel }),
    t("statements.ratioCmp.ui.colMovement"),
  ];
}

/** A served enum value this reader does not recognise, named. */
function unrecognised(t: T, field: string, value: unknown): string {
  return t("statements.ratioCmp.reason.unrecognised", {
    field,
    value: JSON.stringify(value) ?? "undefined",
  });
}

/** "a, b and c" in the reader's language. */
function joinList(t: T, words: readonly string[], joinKey: "listAnd" | "listPlus"): string {
  if (words.length === 1) return words[0];
  let head = words[0];
  for (let i = 1; i < words.length - 1; i++) {
    head =
      joinKey === "listAnd"
        ? t("statements.ratioCmp.listComma", { head, next: words[i] })
        : t("statements.ratioCmp.listPlus", { head, next: words[i] });
  }
  const last = words[words.length - 1];
  return joinKey === "listAnd"
    ? t("statements.ratioCmp.listAnd", { head, last })
    : t("statements.ratioCmp.listPlus", { head, next: last });
}

function operandWord(t: T, name: string): string {
  const id = RATIO_OPERAND_WORD[name];
  return id
    ? t(`statements.ratioCmp.operand.${id}`)
    : t("statements.ratioCmp.operandUnmapped", { name });
}

function operandWordsT(t: T, inputs: readonly string[] | null | undefined): string {
  const names = (inputs ?? []).filter((n) => typeof n === "string" && n !== "");
  if (names.length === 0) return t("statements.ratioCmp.operandUnnamed");
  const words = names.map((name) =>
    !name.includes(" ") && name.includes("+")
      ? joinList(t, name.split("+").filter((p) => p !== "").map((p) => operandWord(t, p)), "listPlus")
      : operandWord(t, name),
  );
  return joinList(t, words, "listAnd");
}

/** The served `reason.inputs` as reader words. A "+"-joined leaf list (no
 *  spaces) is one summed input; a phrase with spaces is one name. */
export function operandWords(inputs: readonly string[] | null | undefined, locale?: string): string {
  return operandWordsT(tFor(locale), inputs);
}

/** The sentence the ENGINE rendered for a refusal, in `locale`, when the
 *  served reason carries one (a margin ruled not meaningful: its share is
 *  the engine's, so the words are too). */
function servedReasonText(
  code: string | null | undefined,
  served: { display?: unknown } | null | undefined,
  locale: RatioLocale,
): string | null {
  if (code !== "margin_not_meaningful" || !served || typeof served !== "object") return null;
  const display = (served as { display?: unknown }).display;
  if (!display || typeof display !== "object") return null;
  const text = (display as Record<string, unknown>)[locale];
  return typeof text === "string" && text !== "" ? text : null;
}

function reasonSentence(
  t: T,
  code: string | null | undefined,
  inputs?: readonly string[] | null,
  served?: { display?: unknown } | null,
  locale?: RatioLocale,
): string {
  const rendered = servedReasonText(code, served, locale ?? ratioLocale(i18n.language));
  if (rendered !== null) return rendered;
  const vars: Record<string, string> = { code: code ?? "" };
  if (code && RATIO_REASON_CODES_WITH_INPUTS.has(code)) {
    vars.inputs = operandWordsT(t, inputs);
  }
  return t(reasonKey(code), vars);
}

/** Text for a reason code (and its served inputs) in the given language. */
export function reasonText(
  reasonCode: string | null | undefined,
  locale?: string,
  inputs?: readonly string[] | null,
  /** The served reason object, when the caller has it: a refusal the engine
   *  rendered (margin_not_meaningful) prints the engine's sentence. */
  served?: { display?: unknown } | null,
): string {
  return reasonSentence(tFor(locale), reasonCode, inputs, served, ratioLocale(locale ?? i18n.language));
}

/** A plain quantized decimal: optional sign, digits, optional fraction. */
const DECIMAL_SHAPE = /^[+-]?\d+(\.\d+)?$/;

/** A served string that is a zero at any precision ("0", "-0.00"). */
const ZERO_SHAPE = /^[+-]?0+(\.0+)?$/;

/** Localise the decimal separator of a served decimal string. String
 *  replacement only: the digits are the engine's. */
export function localiseDecimal(served: string, locale: RatioLocale): string {
  return locale === "ro" ? served.replace(".", ",") : served;
}

// ─── Formatters ─────────────────────────────────────────────────────────

const DISPLAY_UNIT_SET: ReadonlySet<string> = new Set(RATIO_DISPLAY_UNITS);
const DELTA_UNIT_SET: ReadonlySet<string> = new Set(RATIO_DELTA_UNITS);
const CREDIT_LETTER_SET: ReadonlySet<string> = new Set(CREDIT_LETTERS);

/** Units whose i18n suffix has count forms (daysOne / daysMany, …). */
export const RATIO_UNITS_WITH_COUNT_FORMS = ["days", "points", "notches"] as const;
const HAS_COUNT_FORMS: ReadonlySet<string> = new Set(RATIO_UNITS_WITH_COUNT_FORMS);

/** Which suffix form a served string takes. String inspection only:
 *  "One" for exactly "1" (so "1.0" stays plural); "Many" for an integer
 *  string of two or more digits whose last two digits are "00" or from
 *  "20" up — the Romanian "de" form ("20 de zile", "101 zile"). EN spells
 *  Many the same as the plural. */
function countForm(unitKey: string, served: string): "" | "One" | "Many" {
  if (!HAS_COUNT_FORMS.has(unitKey)) return "";
  return countFormOf(served);
}

/** The count form of a printed quantity, whatever its unit — the rule
 *  above, exported so every noun that follows a number (the command bar's
 *  finding measures: years, accounts) takes the same Romanian forms. */
export function countFormOf(served: string): "" | "One" | "Many" {
  const magnitude = served.replace(/^[+-]/, "");
  if (magnitude === "1") return "One";
  if (/^\d+$/.test(magnitude) && magnitude.length >= 2) {
    const tail = magnitude.slice(-2);
    if (tail === "00" || tail >= "20") return "Many";
  }
  return "";
}

function withUnit(t: T, unitKey: string, served: string, locale: RatioLocale): string {
  const key = `statements.ratioCmp.unit.${unitKey}${countForm(unitKey, served)}`;
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
  if (!side) return t("statements.ratioCmp.reason.period_absent");
  if (!DISPLAY_UNIT_SET.has(unit)) return unrecognised(t, "display_unit", unit);
  const served: unknown = side.value_q;
  if (served === null || served === undefined) {
    return reasonSentence(t, side.reason?.code ?? null, side.reason?.inputs, side.reason, loc);
  }
  if (typeof served !== "string") return t("statements.ratioCmp.reason.malformed_value");
  if (unit === "grade") {
    // A letter from the one ladder. No separator to localise, no suffix.
    if (!CREDIT_LETTER_SET.has(served)) return t("statements.ratioCmp.reason.malformed_value");
    return t("statements.ratioCmp.unit.grade", { v: served });
  }
  if (!DECIMAL_SHAPE.test(served)) return t("statements.ratioCmp.reason.malformed_value");
  return withUnit(t, unit, served, loc);
}

export interface FormattedRatioDelta {
  /** The delta in its unit, or the reason sentence when there is none. */
  primary: string;
  /** Turns rows: the percent change, or the sentence for why there is none.
   *  Every other unit: null. */
  secondary: string | null;
}

/** How a turns row's percent change sits beside its turns change when the
 *  two are printed as ONE cell: "+0.28× (+15.4%)". The report, the
 *  workbook and the Ratios tab's change cell all print it this way, so a
 *  change cell is the same bytes on every surface
 *  (ratioTableByteMatch.test.tsx). A surface that lays the two parts out
 *  on separate lines renders these same three strings in order. */
export const RATIO_DELTA_SECONDARY_OPEN = " (";
export const RATIO_DELTA_SECONDARY_CLOSE = ")";

/** The one-cell text of a formatted delta. */
export function joinRatioDelta(d: FormattedRatioDelta): string {
  return d.secondary === null
    ? d.primary
    : `${d.primary}${RATIO_DELTA_SECONDARY_OPEN}${d.secondary}${RATIO_DELTA_SECONDARY_CLOSE}`;
}

function canonicalRatioJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalRatioJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalRatioJson(obj[k])}`)
    .join(",")}}`;
}

/** A served two-period row, serialised canonically: keys sorted at every
 *  depth, no whitespace. THE BYTE-MATCH HANDLE: every surface that prints a
 *  served row — the Ratios tab (table, tile, drawer, lists, credit strip),
 *  the report (cards, served-only table, executive summary) — embeds this
 *  string as `data-ratio-cmp-json`, so the same served row is the same
 *  bytes on the dashboard and in the downloaded document. Nothing is
 *  formatted, rounded or dropped on the way. */
export function serializeRatioCompareRow(row: RatioCompareRow): string {
  return canonicalRatioJson(row);
}

/** The served delta as printed text. */
export function formatRatioDelta(
  delta: RatioDelta | null | undefined,
  locale?: string,
): FormattedRatioDelta {
  const loc = ratioLocale(locale ?? i18n.language);
  const t = tFor(loc);
  if (!delta) return { primary: t(reasonKey(null)), secondary: null };
  if (!DELTA_UNIT_SET.has(delta.unit)) {
    return { primary: unrecognised(t, "delta.unit", delta.unit), secondary: null };
  }
  const served: unknown = delta.value;
  if (served === null || served === undefined) {
    return { primary: reasonSentence(t, delta.reason_code), secondary: null };
  }
  if (typeof served !== "string" || !DECIMAL_SHAPE.test(served)) {
    return { primary: t("statements.ratioCmp.reason.malformed_value"), secondary: null };
  }
  const primary = withUnit(t, delta.unit, served, loc);
  if (delta.unit !== "turns") return { primary, secondary: null };
  const pct: unknown = delta.pct_change;
  if (pct === null || pct === undefined) {
    return { primary, secondary: t("statements.ratioCmp.pctNoBase") };
  }
  if (typeof pct !== "string" || !DECIMAL_SHAPE.test(pct)) {
    return { primary, secondary: t("statements.ratioCmp.reason.malformed_value") };
  }
  return {
    primary,
    secondary: t("statements.ratioCmp.unit.turnsPct", { v: localiseDecimal(pct, loc) }),
  };
}

/** Delta colour from the served favourable verdict — never from the sign
 *  of the delta and never from higher_is_better: the engine already
 *  combined the two. Pass the served `delta.value` too: a zero delta
 *  marked improved or deteriorated is a contradiction (the authority rule
 *  makes a zero delta "none") and is amber, neither praise nor alarm. An
 *  unrecognised verdict is amber as well. */
export function deltaTone(
  favourable: RatioFavourable | null | undefined,
  value?: string | null,
): ChipTone {
  const zero = typeof value === "string" && ZERO_SHAPE.test(value);
  switch (favourable) {
    case "improved":
      return zero ? "caution" : "success";
    case "deteriorated":
      return zero ? "caution" : "alert";
    case "none":
    case null:
    case undefined:
      return "neutral";
    default:
      return "caution";
  }
}

/** Band-movement chip tone from the served movement status. "Up" is up the
 *  band ladder (critical → strong), as rungs_crossed counts it. When the
 *  served status and the sign of rungs_crossed disagree, or the status is
 *  not one this reader knows, the chip is amber. */
export function movementTone(movement: RatioMovement | null | undefined): ChipTone {
  if (!movement) return "neutral";
  switch (movement.status) {
    case "crossed_up":
      return movement.rungs_crossed > 0 ? "success" : "caution";
    case "crossed_down":
      return movement.rungs_crossed < 0 ? "alert" : "caution";
    case "same_band":
      return movement.rungs_crossed === 0 ? "neutral" : "caution";
    case "not_comparable":
      return "neutral";
    default:
      return "caution";
  }
}

const BAND_WORD_KEY: Record<RatioBand, string> = {
  strong: "dashV2.ratioVerdictStrong",
  healthy: "dashV2.ratioVerdictHealthy",
  watch: "dashV2.ratioVerdictWatch",
  critical: "dashV2.ratioVerdictCritical",
};

/** The one spelling of a band word (the same keys the tile uses). A null
 *  band is "not reported"; a credit letter from the ladder has no word —
 *  it returns null and the letter is printed as served; anything else
 *  returns the `unrecognised` key. */
export function bandWordKey(band: RatioBand | CreditLetter | null | undefined): string {
  if (band === null || band === undefined) return "dashV2.ratioVerdictUnknown";
  if (Object.prototype.hasOwnProperty.call(BAND_WORD_KEY, band)) {
    return BAND_WORD_KEY[band as RatioBand];
  }
  return CREDIT_LETTER_SET.has(band) ? "" : "statements.ratioCmp.reason.unrecognised";
}

/** A band (or letter) that is present and recognised, as its word; null
 *  when it is absent or outside the mirror. */
function bandText(t: T, band: unknown): string | null {
  if (typeof band !== "string") return null;
  if (Object.prototype.hasOwnProperty.call(BAND_WORD_KEY, band)) {
    return t(BAND_WORD_KEY[band as RatioBand]);
  }
  return CREDIT_LETTER_SET.has(band) ? band : null;
}

const BAND_STATUS_WORD_KEY: Record<Exclude<RatioBandStatus, "graded">, string> = {
  ungraded_sector: "dashV2.ratioVerdictUngraded",
  withheld_sign: "statements.ratioCmp.band.withheldSign",
  withheld_basis: "statements.ratioCmp.band.withheldBasis",
  not_banded: "statements.ratioCmp.band.notBanded",
  refused: "dashV2.ratioVerdictUnknown",
};

/** A side's band as printed text: the band word, the letter as served, the
 *  word for why there is no band, or the sentence naming a served value
 *  this reader does not recognise. */
export function formatRatioBand(side: RatioSide | null | undefined, locale?: string): string {
  const t = tFor(locale);
  if (!side) return t("statements.ratioCmp.reason.period_absent");
  const status: unknown = side.band_status;
  if (status === "graded") {
    return bandText(t, side.band) ?? unrecognised(t, "band", side.band);
  }
  if (typeof status === "string" && Object.prototype.hasOwnProperty.call(BAND_STATUS_WORD_KEY, status)) {
    return t(BAND_STATUS_WORD_KEY[status as keyof typeof BAND_STATUS_WORD_KEY]);
  }
  return unrecognised(t, "band_status", status);
}

/** The band movement as printed text: "Healthy → Strong", "Unchanged:
 *  Watch", the served reason when the two sides are not comparable, or the
 *  sentence naming a served value this reader does not recognise. */
export function formatRatioMovement(
  movement: RatioMovement | null | undefined,
  locale?: string,
): string {
  const t = tFor(locale);
  if (!movement) return t(reasonKey(null));
  const status: unknown = movement.status;
  switch (status) {
    case "crossed_up":
    case "crossed_down": {
      const from = bandText(t, movement.from);
      if (from === null) return unrecognised(t, "movement.from", movement.from);
      const to = bandText(t, movement.to);
      if (to === null) return unrecognised(t, "movement.to", movement.to);
      return t("statements.ratioCmp.movement.crossed", { from, to });
    }
    case "same_band": {
      const band = bandText(t, movement.to);
      if (band === null) return unrecognised(t, "movement.to", movement.to);
      return t("statements.ratioCmp.movement.held", { band });
    }
    case "not_comparable":
      return reasonSentence(t, movement.reason_code);
    default:
      return unrecognised(t, "movement.status", status);
  }
}

// ─── Key census ─────────────────────────────────────────────────────────

/** Every i18n key this module can resolve, built from the same tables the
 *  formatters read. ratioTableFormat.test.ts asserts each is a non-empty
 *  string in en.json AND ro.json (not through t(), which returns the key
 *  itself for a missing one) and that every key literal in this file's
 *  source is in the census. */
export function ratioCmpKeyCensus(): string[] {
  const keys = new Set<string>([
    "statements.ratioCmp.pctNoBase",
    "statements.ratioCmp.rankBasis",
    "statements.ratioCmp.listAnd",
    "statements.ratioCmp.listComma",
    "statements.ratioCmp.listPlus",
    "statements.ratioCmp.operandUnnamed",
    "statements.ratioCmp.operandUnmapped",
    "statements.ratioCmp.movement.crossed",
    "statements.ratioCmp.movement.held",
    "statements.ratioCmp.unit.turnsPct",
  ]);
  for (const u of [...RATIO_DISPLAY_UNITS, ...RATIO_DELTA_UNITS]) {
    keys.add(`statements.ratioCmp.unit.${u}`);
    if (HAS_COUNT_FORMS.has(u)) {
      keys.add(`statements.ratioCmp.unit.${u}One`);
      keys.add(`statements.ratioCmp.unit.${u}Many`);
    }
  }
  for (const c of [...RATIO_REASON_CODES, ...RATIO_COMPARE_REASON_CODES, ...RATIO_READER_REASONS]) {
    keys.add(`statements.ratioCmp.reason.${c}`);
  }
  for (const id of Object.values(RATIO_OPERAND_WORD)) keys.add(`statements.ratioCmp.operand.${id}`);
  for (const k of Object.values(BAND_WORD_KEY)) keys.add(k);
  for (const k of Object.values(BAND_STATUS_WORD_KEY)) keys.add(k);
  keys.add("dashV2.ratioVerdictUnknown");
  // The surfaces' own words (labels, groups, headers): see ratioCompareKeys.ts.
  for (const k of RATIO_CMP_SURFACE_KEYS) keys.add(k);
  return [...keys].sort();
}
