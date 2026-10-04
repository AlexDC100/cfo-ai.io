// The Ratios page's reading of the two served ratio documents.
//
// ── WHAT IT READS ─────────────────────────────────────────────────────
//
//   · the CURRENT column: `assembled_metrics.ratio_table` on GET
//     /api/period (src/engine/ratios/table.py), one Side per census row;
//   · the PRIOR column, the change, both bands and the band movement:
//     `ratios` on GET /api/period/{id}/comparatives
//     (src/engine/comparatives/ratio_compare.py), whose `composites`
//     carry Altman Z″, the composite credit score and the letter grade for
//     both periods.
//
// ── WHAT IT DOES ──────────────────────────────────────────────────────
//
// It picks the served side for a key and hands it to the ONE formatter
// (ratioTable.ts). It computes nothing: no subtraction, no rounding, no
// re-banding, no ranking. The improved and deteriorated lists are the
// served key lists in served order; the counts beside them are the
// lengths of the served lists.
//
// One reading is not a pass-through, and it is a refusal, not a repair:
// the current figure exists on both documents. When the per-period table
// and the comparison disagree about the FIGURE (`value_q`), the served
// change and movement were computed from a current the tab is not
// printing, so they would not tie to the column beside them. Both cells
// then state the two figures and print no change.
//
// A disagreement about the BAND alone is not that case and is not a
// disagreement to report. The comparison grades both periods on ONE
// sector decision (ratio_compare.py, SECTOR WITHHOLDING): when either
// period's `industry_signal` blocks sector content, both sides withhold
// the sector bands, while the current period's own table, which knows
// nothing of the prior, still grades them. The figure ties, the served
// change is printed, and band now, band prior and band movement are all
// read from the comparison's sides (`bandSideOf`), so the three cells and
// the badge state the one sector decision and a withheld movement prints
// its served `sector_unconfirmed` reason.
//
// `PrintedRatioRow` is the printed form every tab surface embeds
// (`data-ratio-printed-json`), so a surface that formats on its own can be
// caught by comparing strings. The served row itself rides as
// `data-ratio-cmp-json` (`ratioCmpHandleOf`), the same bytes the report
// embeds for that row.

import i18n from "@/i18n";
import type { ChipTone } from "@/components/instrument/Panel";
import {
  deltaTone,
  formatRatioBand,
  formatRatioDelta,
  formatRatioMovement,
  formatRatioSide,
  localiseDecimal,
  movementTone,
  ratioLocale,
  reasonText,
  serializeRatioCompareRow,
  type CreditBlock,
  type RatioCompareRow,
  type RatioComparisonV1,
  type RatioDisplayUnit,
  type RatioSide,
  type RatioTableV1,
} from "@/lib/ratioTable";
import { ratioGroupI18nKey, ratioLabelI18nKey } from "@/lib/ratioCompareKeys";
import type { CreditEnvelope, PiotroskiEnvelope } from "@/lib/financialValuation";

type T = ReturnType<typeof i18n.getFixedT>;

function tFor(locale?: string | null): T {
  return i18n.getFixedT(ratioLocale(locale ?? i18n.language));
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ─── The served documents, shape-checked at the boundary ────────────────

/** `assembled_metrics.ratio_table`, or null when the period was served
 *  without one (a sample dataset, an engine that predates the table). */
export function readRatioTable(assembledMetrics: unknown): RatioTableV1 | null {
  if (!isObj(assembledMetrics)) return null;
  const table = assembledMetrics.ratio_table;
  if (!isObj(table) || table.table_version !== "ratio_table.v1" || !Array.isArray(table.rows)) return null;
  return table as unknown as RatioTableV1;
}

/** The comparatives document's `ratios` block, or null when absent. */
export function readRatioComparison(doc: unknown): RatioComparisonV1 | null {
  if (!isObj(doc)) return null;
  const r = doc.ratios;
  if (!isObj(r) || !Array.isArray(r.rows) || !Array.isArray(r.composites) || !isObj(r.band_movements)) {
    return null;
  }
  return r as unknown as RatioComparisonV1;
}

// ─── The view ───────────────────────────────────────────────────────────

export type RatioPriorState =
  /** A comparatives document with its ratio block. */
  | { kind: "compared" }
  /** No prior was requested (comparatives off, or no earlier period). */
  | { kind: "no_comparison" }
  /** A prior was requested and its document has not arrived yet. */
  | { kind: "loading" }
  /** A prior was requested and the request failed (`status` 0: no HTTP
   *  response at all). Not a refusal: the engine said nothing. */
  | { kind: "failed"; status: number }
  /** The engine refused the comparison; `code` is its refusal code, printed
   *  as that code's sentence (lib/comparisonRefusal.ts) — never the engine's
   *  message, which can carry a raw period id. */
  | { kind: "refused"; code: string }
  /** A comparatives document arrived without `ratios`. */
  | { kind: "without_ratios"; priorLabel: string };

export interface RatioCompareView {
  currentLabel: string;
  priorLabel: string | null;
  periodTable: RatioTableV1 | null;
  comparison: RatioComparisonV1 | null;
  prior: RatioPriorState;
}

export function buildRatioCompareView(input: {
  periodTable: RatioTableV1 | null;
  /** The whole served comparatives document (or null). */
  comparativesDoc: unknown;
  /** The engine's refusal of the comparison (its code), when it refused. */
  refusal?: { code: string } | null;
  /** Whether a prior period was requested at all. A view without a
   *  document, refusal or failure is `loading` when one was requested and
   *  `no_comparison` only when none was. Omitted: not requested. */
  requested?: boolean;
  /** The request for the prior failed; its HTTP status, 0 for none. */
  failure?: { status: number } | null;
  /** The current period's own label, used when no comparison names it. */
  currentLabel: string;
}): RatioCompareView | null {
  const comparison = readRatioComparison(input.comparativesDoc);
  if (!input.periodTable && !comparison) return null;
  let prior: RatioPriorState;
  let priorLabel: string | null = null;
  if (comparison) {
    prior = { kind: "compared" };
    priorLabel = comparison.prior_label;
  } else if (isObj(input.comparativesDoc)) {
    const p = input.comparativesDoc.prior;
    priorLabel = isObj(p) && typeof p.label === "string" ? p.label : null;
    prior = { kind: "without_ratios", priorLabel: priorLabel ?? "" };
  } else if (input.refusal) {
    prior = { kind: "refused", code: input.refusal.code };
  } else if (input.failure) {
    prior = { kind: "failed", status: input.failure.status };
  } else if (input.requested === true) {
    prior = { kind: "loading" };
  } else {
    prior = { kind: "no_comparison" };
  }
  return {
    currentLabel: comparison?.current_label ?? input.currentLabel,
    priorLabel,
    periodTable: input.periodTable,
    comparison,
    prior,
  };
}

/** computeRatios keys that the engine serves under another key. Only one:
 *  the FE's `ltv` row is the census row `debt_to_assets`
 *  (table.py _SPECS fe_key). ratioCompareTab.test.tsx reads the Python
 *  specs and reds when this map and the engine's disagree. */
export const ENGINE_KEY_OF_FE_KEY: Readonly<Record<string, string>> = { ltv: "debt_to_assets" };

export function engineKeyOf(feKey: string): string {
  return ENGINE_KEY_OF_FE_KEY[feKey] ?? feKey;
}

function compareRowOf(view: RatioCompareView, key: string): RatioCompareRow | null {
  const c = view.comparison;
  if (!c) return null;
  return (
    c.rows.find((r) => r.key === key) ??
    c.composites.find((r) => r.key === key) ??
    (c.subscores ?? []).find((r) => r.key === key) ??
    null
  );
}

/** The byte-match handle for a key: the served two-period row serialised
 *  (`serializeRatioCompareRow`, the string the report embeds for the same
 *  row), or undefined when no comparison serves the key. Every tab surface
 *  embeds it as `data-ratio-cmp-json`; the PRINTED form, which the tab's
 *  own surfaces hold byte-equal to one another, rides as
 *  `data-ratio-printed-json`. */
export function ratioCmpHandleOf(view: RatioCompareView | null, key: string): string | undefined {
  if (!view) return undefined;
  const row = compareRowOf(view, key);
  return row ? serializeRatioCompareRow(row) : undefined;
}

/** The served current Side for a key: the per-period table's row, else
 *  the comparison's current side (the composites exist only there). */
export function currentSideOf(view: RatioCompareView | null, key: string): RatioSide | null {
  if (!view) return null;
  const row = view.periodTable?.rows.find((r) => r.key === key);
  if (row) return row;
  return compareRowOf(view, key)?.current ?? null;
}

/** The two documents disagree about the current FIGURE. The band is not
 *  compared: the comparison may withhold a sector band the per-period
 *  table grades (see the header), and that is one decision, not a
 *  disagreement. */
function figuresDiffer(a: RatioSide, b: RatioSide): boolean {
  return a.value_q !== b.value_q;
}

/**
 * The current Side whose BAND a surface prints (badge text, badge colour,
 * ladder line, band-now cell) for a key.
 *
 * With a comparison row whose current figure ties to the table: the
 * comparison's current side, so band now, band prior and band movement
 * read the same sector decision. Without a comparison, or when the two
 * figures differ (the band must grade the figure printed beside it): the
 * per-period table's row. Composites exist only on the comparison.
 */
export function bandSideOf(view: RatioCompareView | null, key: string): RatioSide | null {
  if (!view) return null;
  const tableRow = view.periodTable?.rows.find((r) => r.key === key) ?? null;
  const cmp = compareRowOf(view, key);
  if (cmp && (!tableRow || !figuresDiffer(tableRow, cmp.current))) return cmp.current;
  return tableRow ?? null;
}

/** The served row's identity (unit, direction, group) for a key. */
export function servedIdentityOf(
  view: RatioCompareView | null,
  key: string,
): { display_unit: RatioDisplayUnit; higher_is_better: boolean; group: string } | null {
  if (!view) return null;
  return view.periodTable?.rows.find((r) => r.key === key) ?? compareRowOf(view, key) ?? null;
}

// ─── Printed form ───────────────────────────────────────────────────────

export interface PrintedRatioRow {
  key: string;
  group: string;
  label: string;
  unit: RatioDisplayUnit;
  current: string;
  /** Null only when no comparison is loaded (the surface states why once). */
  prior: string | null;
  delta: string | null;
  /** Turns rows: the served percent change or the sentence for its absence. */
  deltaSecondary: string | null;
  bandNow: string;
  bandPrior: string | null;
  movement: string | null;
  deltaTone: ChipTone;
  movementTone: ChipTone;
  movementStatus: string | null;
  currentStatus: "present" | "refused";
  priorStatus: "present" | "refused" | "no_comparison";
  /** The two served documents disagree about the current figure. */
  currentDiffers: boolean;
}

export function ratioLabel(labelKey: unknown, key: string, locale?: string | null): string {
  const t = tFor(locale);
  const k = ratioLabelI18nKey(labelKey);
  return k ? t(k) : t("statements.ratioCmp.ui.unlabelled", { key });
}

export function ratioGroupLabel(group: unknown, locale?: string | null): string {
  const t = tFor(locale);
  const k = ratioGroupI18nKey(group);
  return k ? t(k) : t("statements.ratioCmp.reason.unrecognised", { field: "group", value: JSON.stringify(group) ?? "undefined" });
}

/** The printed row for one served key, or null when neither document
 *  serves that key. */
export function printRatioRow(
  view: RatioCompareView | null,
  key: string,
  locale?: string | null,
): PrintedRatioRow | null {
  if (!view) return null;
  const loc = ratioLocale(locale ?? i18n.language);
  const t = tFor(loc);
  const tableRow = view.periodTable?.rows.find((r) => r.key === key) ?? null;
  const cmp = compareRowOf(view, key);
  const identity = tableRow ?? cmp;
  if (!identity) return null;
  const unit = identity.display_unit;
  const current: RatioSide = tableRow ?? (cmp as RatioCompareRow).current;
  const base = {
    key,
    group: identity.group,
    label: ratioLabel(identity.label_key, key, loc),
    unit,
    current: formatRatioSide(current, unit, loc),
    bandNow: formatRatioBand(bandSideOf(view, key), loc),
    currentStatus: (current.value_q === null ? "refused" : "present") as PrintedRatioRow["currentStatus"],
  };
  if (!cmp) {
    return {
      ...base,
      prior: null,
      delta: null,
      deltaSecondary: null,
      bandPrior: null,
      movement: null,
      deltaTone: "neutral",
      movementTone: "neutral",
      movementStatus: null,
      priorStatus: "no_comparison",
      currentDiffers: false,
    };
  }
  const priorStatus: PrintedRatioRow["priorStatus"] = cmp.prior.value_q === null ? "refused" : "present";
  if (tableRow && figuresDiffer(tableRow, cmp.current)) {
    const sentence = t("statements.ratioCmp.ui.currentDiffers", {
      table: formatRatioSide(tableRow, unit, loc),
      compare: formatRatioSide(cmp.current, unit, loc),
    });
    return {
      ...base,
      prior: formatRatioSide(cmp.prior, unit, loc),
      delta: sentence,
      deltaSecondary: null,
      bandPrior: formatRatioBand(cmp.prior, loc),
      movement: sentence,
      deltaTone: "caution",
      movementTone: "caution",
      movementStatus: "current_differs",
      priorStatus,
      currentDiffers: true,
    };
  }
  const d = formatRatioDelta(cmp.delta, loc);
  return {
    ...base,
    prior: formatRatioSide(cmp.prior, unit, loc),
    delta: d.primary,
    deltaSecondary: d.secondary,
    bandPrior: formatRatioBand(cmp.prior, loc),
    movement: formatRatioMovement(cmp.movement, loc),
    deltaTone: deltaTone(cmp.delta?.favourable, cmp.delta?.value),
    movementTone: movementTone(cmp.movement),
    movementStatus: cmp.movement?.status ?? null,
    priorStatus,
    currentDiffers: false,
  };
}

/** The canonical string a surface embeds for one printed row. */
export function serializePrintedRow(row: PrintedRatioRow): string {
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(row).sort()) sorted[k] = (row as unknown as Record<string, unknown>)[k];
  return JSON.stringify(sorted);
}

/** Census keys in served order, then the composites, then the sub-scores. */
export function ratioKeysInServedOrder(view: RatioCompareView | null): {
  census: string[];
  composites: string[];
  subscores: string[];
} {
  if (!view) return { census: [], composites: [], subscores: [] };
  const census = (view.comparison?.rows ?? view.periodTable?.rows ?? []).map((r) => r.key);
  const composites = (view.comparison?.composites ?? []).map((r) => r.key);
  const subscores = (view.comparison?.subscores ?? []).map((r) => r.key);
  return { census, composites, subscores };
}

// ─── Bands and ladders ──────────────────────────────────────────────────

/** Badge tone for a served side: the band, never the value. */
export function bandTone(side: RatioSide | null | undefined): ChipTone {
  if (!side || side.band_status !== "graded") return "neutral";
  switch (side.band) {
    case "strong":
    case "healthy":
      return "success";
    case "watch":
      return "caution";
    case "critical":
      return "alert";
    default:
      return "neutral";
  }
}

/** The served side's band as the verdict vocabulary the drawer's prose
 *  is keyed by: the band when graded on the four-rung ladder, `unknown`
 *  when no figure was served, `ungraded` for every other band status (a
 *  withheld, not-banded or letter-graded side has no rung word). */
export type ServedVerdict = "strong" | "healthy" | "watch" | "critical" | "ungraded" | "unknown";

export function servedVerdictOf(side: RatioSide | null | undefined): ServedVerdict {
  if (!side || side.value_q === null) return "unknown";
  if (side.band_status === "graded") {
    switch (side.band) {
      case "strong":
      case "healthy":
      case "watch":
      case "critical":
        return side.band;
    }
  }
  return "ungraded";
}

/**
 * Whether a browser commentary line may sit beside a served figure.
 *
 * `computeRatios` commentary is prose chosen by the BROWSER's own cutoffs
 * (`v >= 1.5 ? "Comfortable…" : …`) and sometimes prints the browser's own
 * figure (`${v.toFixed(1)}% of assets funded by equity`). Beside a served
 * row it is printed only when it can contradict neither: the served band
 * is the verdict the line was chosen for, and the line carries no digit
 * (no figure and no cutoff of its own, TC-10). Otherwise it is withheld;
 * the served band and ladder beside it already say what it would.
 */
export function commentaryAgreesWithServed(
  commentary: string | null | undefined,
  browserVerdict: string,
  side: RatioSide | null | undefined,
): boolean {
  if (typeof commentary !== "string" || commentary.trim() === "") return false;
  if (/\d/.test(commentary)) return false;
  return servedVerdictOf(side) === browserVerdict;
}

const LADDER_ORDER = ["strong", "healthy", "watch"] as const;
const BAND_WORD: Record<string, string> = {
  strong: "dashV2.ratioVerdictStrong",
  healthy: "dashV2.ratioVerdictHealthy",
  watch: "dashV2.ratioVerdictWatch",
  critical: "dashV2.ratioVerdictCritical",
};

/** The served ladder as a sentence, rung values verbatim through the one
 *  formatter ("Strong from 2×, Healthy from 1.5×, Watch from 1×, Critical
 *  below"). A side with no ladder states why. TC-10: no cutoff is typed
 *  here; each one is the served rung. */
export function ladderText(
  side: RatioSide | null | undefined,
  higherIsBetter: boolean,
  unit: RatioDisplayUnit,
  locale?: string | null,
): string {
  const loc = ratioLocale(locale ?? i18n.language);
  const t = tFor(loc);
  if (!side) return t("statements.ratioCmp.reason.period_absent");
  const ladder = side.ladder;
  if (side.band_status !== "graded" || !isObj(ladder) || unit === "grade") {
    const reason = side.reason
      ? reasonText(side.reason.code, loc, side.reason.inputs, side.reason)
      : formatRatioBand(side, loc);
    return t("statements.ratioCmp.ui.ladderUnread", { reason });
  }
  const parts: string[] = [];
  for (const name of LADDER_ORDER) {
    const rung = (ladder as Record<string, unknown>)[name];
    if (typeof rung !== "string") continue;
    const value = formatRatioSide(
      { value: null, value_q: rung, band: null, band_status: "graded", ladder: null, ladder_floor: null, operands: [], reason: null },
      unit,
      loc,
    );
    parts.push(
      t(higherIsBetter ? "statements.ratioCmp.ui.ladderRungHigher" : "statements.ratioCmp.ui.ladderRungLower", {
        band: t(BAND_WORD[name]),
        value,
      }),
    );
  }
  if (side.ladder_floor && BAND_WORD[side.ladder_floor]) {
    parts.push(
      t(higherIsBetter ? "statements.ratioCmp.ui.ladderFloorHigher" : "statements.ratioCmp.ui.ladderFloorLower", {
        band: t(BAND_WORD[side.ladder_floor]),
      }),
    );
  }
  let out = parts[0] ?? "";
  for (let i = 1; i < parts.length; i++) out = t("statements.ratioCmp.listComma", { head: out, next: parts[i] });
  return out;
}

// ─── Band movements ─────────────────────────────────────────────────────

export interface PrintedBandMovements {
  improved: PrintedRatioRow[];
  deteriorated: PrintedRatioRow[];
  counts: {
    improved: number;
    deteriorated: number;
    unchanged: number;
    notComparable: number;
    /** Entries refused in at least one period (prior, current or both). */
    refused: number;
    bothSides: number;
  };
  rankBasis: string;
  /** The engine serves NO improved / deteriorated verdict for this pair: the
   *  comparison period closes later, or the order of the two cannot be read.
   *  The lists above are empty by the engine's hand, and "nothing crossed a
   *  band" would be a false sentence — the tab says THIS instead. */
  verdictsWithheld: "prior_is_later" | "period_order_unknown" | null;
}

function listedRow(view: RatioCompareView, key: string, loc: string): PrintedRatioRow {
  const printed = printRatioRow(view, key, loc);
  if (printed) return printed;
  // A served list naming a key no row serves: shown, named, never dropped.
  const t = tFor(loc);
  const text = t("statements.ratioCmp.ui.unlabelled", { key });
  return {
    key, group: "", label: text, unit: "x", current: text, prior: text, delta: text,
    deltaSecondary: null, bandNow: text, bandPrior: text, movement: text,
    deltaTone: "caution", movementTone: "caution", movementStatus: null,
    currentStatus: "refused", priorStatus: "refused", currentDiffers: false,
  };
}

export function printBandMovements(
  view: RatioCompareView | null,
  locale?: string | null,
): PrintedBandMovements | null {
  const c = view?.comparison;
  if (!view || !c) return null;
  const loc = ratioLocale(locale ?? i18n.language);
  const t = tFor(loc);
  const bm = c.band_movements;
  const sentenceKey = bm.rank_basis?.sentence_key;
  const rankBasis =
    typeof sentenceKey === "string" && sentenceKey.startsWith("statements.ratioCmp.") && i18n.exists(sentenceKey, { lng: loc })
      ? t(sentenceKey)
      : t("statements.ratioCmp.reason.unrecognised", {
          field: "rank_basis.sentence_key",
          value: JSON.stringify(sentenceKey) ?? "undefined",
        });
  const withheld: unknown = bm.verdicts_withheld;
  return {
    verdictsWithheld: withheld === "prior_is_later" || withheld === "period_order_unknown" ? withheld : null,
    improved: (bm.improved ?? []).map((k) => listedRow(view, k, loc)),
    deteriorated: (bm.deteriorated ?? []).map((k) => listedRow(view, k, loc)),
    counts: {
      improved: (bm.improved ?? []).length,
      deteriorated: (bm.deteriorated ?? []).length,
      unchanged: (bm.unchanged ?? []).length,
      notComparable: (bm.not_comparable ?? []).length,
      refused: (bm.refused ?? []).length,
      bothSides: c.coverage.both_sides,
    },
    rankBasis,
  };
}

// ─── Credit: the composites and the as-filed disclosure ─────────────────

export const CREDIT_COMPOSITE_KEYS = ["altman_z", "credit_composite", "letter_grade"] as const;

/** The three composite rows, printed, when a comparison is loaded. */
export function printCreditComparison(
  view: RatioCompareView | null,
  locale?: string | null,
): PrintedRatioRow[] {
  if (!view?.comparison) return [];
  return CREDIT_COMPOSITE_KEYS.map((k) => printRatioRow(view, k, locale)).filter(
    (r): r is PrintedRatioRow => r !== null,
  );
}

function asFiledFigure(v: unknown, t: T, loc: "en" | "ro", withdrawn = false): string {
  if (withdrawn) return t("statements.ratioCmp.ui.asFiledValueWithdrawn");
  if (typeof v === "number" && Number.isFinite(v)) return localiseDecimal(String(v), loc);
  if (typeof v === "string" && v !== "") return v;
  return t("statements.ratioCmp.ui.asFiledValueAbsent");
}

/** The figures the engine withdrew from the filing (`as_filed.withdrawn`),
 *  by the figure name they were filed under. */
function withdrawnFigures(af: { withdrawn?: unknown }): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(af.withdrawn)) return out;
  for (const w of af.withdrawn) if (isObj(w) && typeof w.figure === "string") out.add(w.figure);
  return out;
}

/** The served as-filed disclosure for the CURRENT period's credit block:
 *  a sentence only when the engine says the filed composite differs from
 *  the served one (`as_filed_differs`). The filed figures are printed as
 *  persisted. */
export function asFiledSentence(credit: CreditBlock | null | undefined, locale?: string | null): string | null {
  if (!credit || credit.as_filed_differs !== true || !isObj(credit.as_filed)) return null;
  const loc = ratioLocale(locale ?? i18n.language);
  const t = tFor(loc);
  const af = credit.as_filed;
  // A withdrawn filed figure prints as "withdrawn", never as a number and
  // never as "not filed": it WAS filed, outside its range, and the engine
  // says so in its own words (re-checked here: a numeric value beside a
  // withdrawal is never printed, whatever the payload carries).
  const withdrawn = withdrawnFigures(af);
  const compositeWithdrawn = withdrawn.has("credit_composite");
  const zWithdrawn = withdrawn.has("altman_z_score");
  const sentence = t("statements.ratioCmp.ui.asFiled", {
    composite: asFiledFigure(af.composite, t, loc, compositeWithdrawn),
    letter: asFiledFigure(af.letter, t, loc, compositeWithdrawn),
    z: asFiledFigure(af.altman_z, t, loc, zWithdrawn),
    revision:
      af.credit_model_revision === "unknown"
        ? t("statements.ratioCmp.ui.asFiledRevisionUnknown")
        : asFiledFigure(af.credit_model_revision, t, loc),
    servedRevision: asFiledFigure(credit.revision, t, loc),
  });
  if (withdrawn.size === 0) return sentence;
  const notes = (af.withdrawn ?? [])
    .filter((w) => isObj(w) && typeof w.text === "string")
    .map((w) => `${w.figure}: ${w.text}`)
    .join("; ");
  return `${sentence} ${t("statements.ratioCmp.ui.asFiledWithdrawnNote", { notes })}`;
}

// ─── The current period's credit, for the hero, the Risks tab, exports ──

/** The credit-family `calculated_metrics` rows (financialValuation.ts
 *  ENGINE_CREDIT_METRIC_KEYS, which the credit reader prefers over the
 *  envelope). */
export const CREDIT_METRIC_ROW_NAMES: readonly string[] = [
  "credit_composite",
  "altman_z_score",
  "altman_x1", "altman_x2", "altman_x3", "altman_x4",
  "credit_subscore_altman", "credit_subscore_profitability", "credit_subscore_leverage",
  "credit_subscore_coverage", "credit_subscore_dscr", "credit_subscore_liquidity",
  "credit_subscore_equity",
];

export interface ServedCreditEnvelopes {
  credit: CreditEnvelope | undefined;
  piotroski: PiotroskiEnvelope | undefined;
  metricsByName: Record<string, number | null>;
  /** Which served block the credit reader is handed. */
  source: "ratio_table" | "envelope";
}

/**
 * ONE place decides which credit the dashboard's readers see.
 *
 * When GET /api/period served its credit from the serve-time model
 * (`assembled_metrics.credit.basis === "serve"`), the reader is handed the
 * served table's own credit block (`assembled_metrics.ratio_table.credit`),
 * renamed into the envelope fields `computeCreditScore` reads, and the
 * credit-family metric rows are withheld from it: that reader prefers a
 * row over the envelope, so a row that ever drifted from the table would
 * print a second composite beside the comparison's. Nothing is computed
 * here; every figure is moved, not derived.
 *
 * Any other body (a period whose statements the serve-time model could not
 * score, labelled `basis: "as_filed"`, or a sample with no envelope) keeps
 * the envelope and rows exactly as served.
 */
export function servedCreditEnvelopes(
  assembledMetrics: unknown,
  statements: unknown,
  metricsByName: Record<string, number | null>,
): ServedCreditEnvelopes {
  const am = isObj(assembledMetrics) ? assembledMetrics : null;
  const envelope = (am?.credit ?? undefined) as (CreditEnvelope & { basis?: unknown }) | undefined;
  const piotroski = (am?.piotroski ??
    (isObj(statements) ? statements.assembled_piotroski : undefined) ??
    undefined) as PiotroskiEnvelope | undefined;
  const table = readRatioTable(am);
  if (!table || !isObj(envelope) || envelope.basis !== "serve" || !isObj(table.credit)) {
    return { credit: envelope, piotroski, metricsByName, source: "envelope" };
  }
  const cb = table.credit;
  const altman = isObj(cb.altman) ? cb.altman : null;
  const credit: CreditEnvelope = {
    composite_score: cb.composite,
    letter_grade: cb.letter,
    letter_grade_bands: cb.ladder,
    altman_z_score: altman ? altman.z : null,
    altman_variant: typeof envelope.altman_variant === "string" ? envelope.altman_variant : null,
    altman_components: altman
      ? { x1: altman.x1, x2: altman.x2, x3: altman.x3, x4: altman.x4 }
      : null,
    composite_weights: cb.weights,
    subscores: cb.subscores,
  };
  const rows: Record<string, number | null> = {};
  for (const [name, value] of Object.entries(metricsByName)) {
    if (!CREDIT_METRIC_ROW_NAMES.includes(name)) rows[name] = value;
  }
  return { credit, piotroski, metricsByName: rows, source: "ratio_table" };
}
