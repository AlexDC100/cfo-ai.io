// WHEN A MARGIN IS NOT MEANINGFUL — the READER of the engine's verdict.
//
// ── the defect this exists for ─────────────────────────────────────────
//
// A property developer in a building year books its construction cost
// through class 6 and capitalises it into stock through account 711; its
// turnover is a little rent. Its EBITDA margin printed −17,884.9% on the
// dashboard and the ratios tab, and the forecast cockpit printed "margin
// −17,886.1% · today −17,884.9%". Nothing was wrong with the division: the
// percent described an incidental line, not the company's sales.
//
// ── who decides ────────────────────────────────────────────────────────
//
// The ENGINE, once: `src/engine/ratios/margin_meaning.py` over
// `packs/ratios/margin_meaning.yaml` (a margin over turnover is not
// meaningful when |turnover| < max(floor, share_below × total operating
// expense)). `GET /api/period` serves the verdict on
// `statements.margin_meaning`, the ratio table refuses its margin rows as
// `margin_not_meaningful`, the forecast cockpit serves `margin_refused`.
//
// This module ONLY READS what was served: no threshold, no division, no
// percent is computed here — the refusal text arrives rendered, in both
// languages, and the one note ("EBITDA includes the stock variation")
// arrives with its figure already read off the measured net 711,
// `assembled_pl.inventory_variation.value` (one-EBITDA ruling). A payload that carries no
// verdict (an older period, a public-company adapter, a sample) refuses
// nothing, which is the behaviour it had before the rule.

/** A served pair of texts, one per UI language. */
export interface MarginBilingual {
  readonly ro: string;
  readonly en: string;
}

export type MarginMeaningStatus = "meaningful" | "not_meaningful" | "not_applicable";

export interface MarginNote {
  /** The note as the engine rendered it (RO + EN), amount included. */
  readonly display: MarginBilingual;
  /** The served figure the note quotes (assembled_pl.inventory_variation.value, net 711). */
  readonly figure: number | null;
}

export interface MarginMeaningView {
  readonly status: MarginMeaningStatus;
  /** True iff every margin over turnover must print the refusal instead of a percent. */
  readonly refused: boolean;
  /** The refusal text, when refused — "marjă nesemnificativă: …". */
  readonly display: MarginBilingual | null;
  /** What "activity" is and the threshold, rendered by the engine from its
   *  pack ("a margin is computed only when turnover is at least 10% of
   *  activity") — the cutoff is served, never typed here (TC-10). */
  readonly basis: MarginBilingual | null;
  /** |turnover| / activity and the pack threshold, as served decimal strings. */
  readonly share: string | null;
  readonly threshold: string | null;
  /** The one note the pack names for its one case, when served. */
  readonly note: MarginNote | null;
}

const STATUSES: ReadonlySet<string> = new Set(["meaningful", "not_meaningful", "not_applicable"]);

function rec(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function bilingual(v: unknown): MarginBilingual | null {
  const r = rec(v);
  if (!r) return null;
  const ro = typeof r.ro === "string" ? r.ro : "";
  const en = typeof r.en === "string" ? r.en : "";
  if (!ro && !en) return null;
  return { ro: ro || en, en: en || ro };
}

/** The served verdict, or null when the payload carries none (or one this
 *  reader does not recognise — which refuses nothing). */
export function readMarginMeaning(raw: unknown): MarginMeaningView | null {
  const r = rec(raw);
  if (!r || typeof r.status !== "string" || !STATUSES.has(r.status)) return null;
  const status = r.status as MarginMeaningStatus;
  const display = bilingual(r.display);
  // A refusal with no words to say it in is not printable as a refusal;
  // the reader then keeps the margin it had rather than print a blank.
  const refused = status === "not_meaningful" && display !== null;
  const noteRaw = rec(r.note);
  const noteDisplay = noteRaw ? bilingual(noteRaw.display) : null;
  const figureRaw = noteRaw ? rec(noteRaw.figure) : null;
  const figure = figureRaw && typeof figureRaw.value === "number" && Number.isFinite(figureRaw.value)
    ? figureRaw.value
    : null;
  return {
    status,
    refused,
    display: refused ? display : null,
    basis: bilingual(r.basis),
    share: typeof r.share === "string" ? r.share : null,
    threshold: typeof r.threshold === "string" ? r.threshold : null,
    note: noteDisplay ? { display: noteDisplay, figure } : null,
  };
}

/** The served statements' verdict when it REFUSES the margins, else null. */
export function marginRefusalOf(
  statements: { margin_meaning?: unknown } | null | undefined,
): MarginBilingual | null {
  const view = readMarginMeaning(statements?.margin_meaning);
  return view && view.refused ? view.display : null;
}

/** The served note (the developer's capitalised 711), else null. */
export function marginNoteOf(
  statements: { margin_meaning?: unknown } | null | undefined,
): MarginNote | null {
  return readMarginMeaning(statements?.margin_meaning)?.note ?? null;
}

/** The text for the active UI language: Romanian for any `ro*` locale,
 *  English otherwise. */
export function pickMargin(text: MarginBilingual, lang: string | null | undefined): string {
  return (lang ?? "").toLowerCase().startsWith("ro") ? text.ro : text.en;
}

/** The margin concepts / ratio keys a refusal covers — every margin over
 *  turnover a surface can print. The engine's pack lists the ratio-table
 *  keys (`rule.applies_to`); the dashboard's KPI concepts add their own
 *  spellings of the same margins. */
export const MARGIN_CONCEPT_KEYS: ReadonlySet<string> = new Set([
  "gross_margin",
  "gross_margin_ratio",
  "operating_margin",
  "ebit_margin",
  "ebitda_margin",
  "core_ebitda_margin",
  "net_margin",
]);
