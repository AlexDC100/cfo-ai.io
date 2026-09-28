// cmdbarSources.ts — THE ONLY readers the command bar uses on a served
// period body (GET /api/period/{id}). The browser twin of
// src/engine/attention/sources.py, and for the same reason:
//
// Two figures are being redefined by parallel lanes while this bar ships,
// so each has exactly ONE reader here and nothing else in the bar touches
// the underlying fields:
//
//   EBITDA          `servedEbitda` returns THE ONE EBITDA the engine
//                   serves (owner ruling 2026-09-26: 711 and 72x inside,
//                   outside turnover) through lib/servedOneEbitda — the
//                   browser's one reader of it — or its typed refusal
//                   (`assembled_pl.ebitda_refusal`) WITH the engine's own
//                   words, which the bar prints; never 0, never a code.
//
//   INVENTORY DAYS  `inventoryDays` returns THE served inventory-days
//                   block (schema inventory_days/1) through lib/
//                   inventoryDays — the reader the Ratios tile, the report
//                   and the bank export use: its total at the block's own
//                   quantization, the served basis LABEL (never the code),
//                   and the block's refusal with its words. There is no
//                   fallback formula: no block, no figure.
//
// Also the account-121 rule: the net result is "din contul 121" only when
// the served anchor status says it IS account 121.
//
// A REFUSED LINE IS NOT AN ABSENT ONE (src/engine/comparatives/lines.py
// `refusal_of`). The one-EBITDA refusal refuses the operating result, gross
// profit and PBT with it; with no account 121 and a refused net 711 the
// engine refuses TOTAL EQUITY as total equity (`assembled_bs.
// total_equity_refusal` — the equity rows sum short by the year's result).
// `servedLine` reads both through the browser's one readers of them
// (lib/servedOneEbitda `plLevelsOf`, `equityRefusalOf`) and returns the
// refusal WITH the engine's words — never "not in this book", never the
// short figure.
//
// Pure. No arithmetic: every value returned is a served value or null
// with the served reason.

import type { PeriodApiResponse } from "@/lib/activePeriod";
import { readInventoryDays, readInventoryDaysSplit } from "@/lib/inventoryDays";
import type { RatioTableRow } from "@/lib/ratioTable";
import { equityRefusalOf, plLevelsOf, readServedOneEbitda, type ServedRefusal } from "@/lib/servedOneEbitda";

export interface ServedReason {
  code: string;
  inputs?: unknown[];
  /** The engine's own words for a refusal it served, per language — the
   *  bar prints these rather than a sentence of its own. */
  text?: { ro: string; en: string };
}

type Body = Pick<PeriodApiResponse, "statements"> & {
  assembled_metrics?: Record<string, unknown> | null;
};

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function pl(body: Body | null | undefined): Record<string, unknown> {
  const st = body?.statements as unknown;
  const p = isObj(st) ? st.assembled_pl : null;
  return isObj(p) ? p : {};
}

function bs(body: Body | null | undefined): Record<string, unknown> {
  const st = body?.statements as unknown;
  const b = isObj(st) ? st.assembled_bs : null;
  return isObj(b) ? b : {};
}

export interface ServedFigure {
  value: number | null;
  refusal: ServedReason | null;
  /** The served path the value was read from. */
  source: string;
}

/** THE ONE EBITDA as served, or its typed refusal with the engine's words.
 *  Never 0 for an absent figure. */
export function servedEbitda(body: Body | null | undefined): ServedFigure {
  const st = body?.statements as unknown;
  const one = readServedOneEbitda(isObj(st) ? st.assembled_pl : null);
  if (!one) {
    return { value: null, refusal: { code: "ebitda_absent", inputs: ["assembled_pl.ebitda"] }, source: "assembled_pl.ebitda" };
  }
  if (one.ebitda !== null) return { value: one.ebitda, refusal: null, source: "assembled_pl.ebitda" };
  const r = one.refusal;
  return {
    value: null,
    refusal: r
      ? { code: r.code, inputs: [], text: { ro: r.text.ro, en: r.text.en } }
      : { code: "ebitda_absent", inputs: ["assembled_pl.ebitda"] },
    source: "assembled_pl.ebitda",
  };
}

/** Net-result statuses that mean "this IS account 121". Mirrors
 *  packs/serving/attention.yaml `anchor_statuses`. */
export const ANCHOR_STATUSES: readonly string[] = ["anchored", "within_tolerance"];

export function anchorStatus(body: Body | null | undefined): string | null {
  const s = pl(body).net_income_anchor_status;
  return typeof s === "string" ? s : null;
}

/** The net result the bar may print: the served statutory figure, and only
 *  when the served anchor says it is account 121. Otherwise a refusal
 *  naming the status — never the reconstructed (metrics[]) figure. */
export function servedNetResult(body: Body | null | undefined): ServedFigure & { anchor: string | null } {
  const anchor = anchorStatus(body);
  const value = num(pl(body).net_income_statutory);
  if (!anchor || !ANCHOR_STATUSES.includes(anchor)) {
    return {
      value: null,
      refusal: { code: "net_result_not_account_121", inputs: [anchor ?? "absent"] },
      source: "assembled_pl.net_income_statutory",
      anchor,
    };
  }
  if (value === null) {
    return {
      value: null,
      refusal: { code: "net_result_absent", inputs: ["assembled_pl.net_income_statutory"] },
      source: "assembled_pl.net_income_statutory",
      anchor,
    };
  }
  return { value, refusal: null, source: "assembled_pl.net_income_statutory", anchor };
}

/** A served refusal as the bar carries it: its code and the engine's own
 *  words in both languages (absentText prints them). */
function worded(r: ServedRefusal): ServedReason {
  return { code: r.code, inputs: [], text: { ro: r.text.ro, en: r.text.en } };
}

/** THE OPERATING RESULT (EBIT) as served, through the browser's one reader
 *  of the P&L levels (lib/servedOneEbitda `plLevelsOf` — the source the
 *  report and the dashboard's EBIT card print): the figure, or the one
 *  EBITDA's refusal with the engine's words (EBIT refuses with it). Only
 *  the SERVED block is read — a body the engine did not assemble has no
 *  operating result here, never one rebuilt from buckets. */
export function servedEbit(body: Body | null | undefined): ServedFigure {
  const st = body?.statements as unknown;
  const apl = isObj(st) ? st.assembled_pl : null;
  const source = "assembled_pl.ebit";
  if (!isObj(apl)) return { value: null, refusal: { code: "line_absent", inputs: [source] }, source };
  const levels = plLevelsOf({ assembled_pl: apl });
  if (levels.ebit !== null) return { value: levels.ebit, refusal: null, source };
  return {
    value: null,
    refusal: levels.ebitRefusal ? worded(levels.ebitRefusal) : { code: "line_absent", inputs: [source] },
    source,
  };
}

/** TOTAL EQUITY as served — or, when the engine refuses it as total equity
 *  (`assembled_bs.total_equity_refusal`: the year's result is refused and
 *  the sheet does not balance without it), that refusal with the engine's
 *  words. The short figure beside the refusal is never printed as total
 *  equity (chart_of_accounts.py: "every consumer that would use it as total
 *  equity refuses"). */
export function servedTotalEquity(body: Body | null | undefined): ServedFigure {
  const source = "assembled_bs.total_equity";
  const refusal = equityRefusalOf(body?.statements as unknown);
  if (refusal) return { value: null, refusal: worded(refusal), source };
  const value = num(bs(body).total_equity);
  return value === null
    ? { value: null, refusal: { code: "line_absent", inputs: [source] }, source }
    : { value, refusal: null, source };
}

/** A money line of the served statements (`assembled_pl.<field>` /
 *  `assembled_bs.<field>`) — the SAME path the comparatives column reads
 *  (src/engine/comparatives/lines.py), so the value printed before the
 *  comparison lands is the column's `current` once it does. The two lines
 *  the bar and the account view read that the engine can REFUSE return
 *  that refusal with its words: the operating result through `servedEbit`,
 *  total equity through `servedTotalEquity`. (Of the one-EBITDA refusal's
 *  `fields`, EBITDA has its own reader and no other — gross profit, PBT —
 *  is a line either surface reads.) */
export function servedLine(body: Body | null | undefined, statement: "pl" | "bs", field: string): ServedFigure {
  if (statement === "pl" && (field === "ebit" || field === "operating_result")) return servedEbit(body);
  if (statement === "bs" && field === "total_equity") return servedTotalEquity(body);
  const value = num((statement === "pl" ? pl(body) : bs(body))[field]);
  const source = `assembled_${statement}.${field}`;
  return value === null
    ? { value: null, refusal: { code: "line_absent", inputs: [source] }, source }
    : { value, refusal: null, source };
}

// ── Account 711: what its rows ARE ──────────────────────────────────────

/** An account-711 row ("Venituri aferente costurilor stocurilor de
 *  produse"): on a closed trial balance it holds the production stocked in
 *  the period (its credit turnover), not the change in inventories. */
export function isStockVariationAccount(code: string | null | undefined): boolean {
  return typeof code === "string" && code.startsWith("711");
}

export interface StockVariation {
  /** A served `assembled_pl.inventory_variation` block was read. */
  served: boolean;
  /** The served book state ("closed" | "open" | "mixed"), or null. */
  bookState: string | null;
  /** Net 711 — "Variația stocurilor de produse" — as served, or null. */
  value: number | null;
  /** The engine's refusal of it, with its words, when refused. */
  refusal: ServedReason | null;
  /** The engine's provenance sentence, both languages. */
  provenanceLabel: { ro: string; en: string } | null;
  /** The owner's Romanian name of the line, verbatim. */
  nameRo: string | null;
  source: "assembled_pl.inventory_variation";
}

/** The served stock variation — the SAME block the Capsule's account note
 *  reads (src/engine/api/_capsule_tools.py `_stock_variation_account_note`)
 *  — through lib/servedOneEbitda. Nothing is computed here. */
export function stockVariation(body: Body | null | undefined): StockVariation {
  const st = body?.statements as unknown;
  const one = readServedOneEbitda(isObj(st) ? st.assembled_pl : null);
  const c = one?.inventoryVariation ?? null;
  return {
    served: c !== null,
    bookState: c?.bookState ?? null,
    value: c?.value ?? null,
    refusal: c?.refusal ? worded(c.refusal) : null,
    provenanceLabel: c?.provenanceLabel ? { ro: c.provenanceLabel.ro, en: c.provenanceLabel.en } : null,
    nameRo: c?.nameRo ?? null,
    source: "assembled_pl.inventory_variation",
  };
}

// ── Ratios: assembled_metrics.ratio_table ONLY ──────────────────────────

/** The served ratio-table rows by key. NEVER `metrics[]`: on the corpus the
 *  two disagree (current ratio 1.1601 vs the table's 1.15, the net result
 *  36,267,963.64 vs account 121's 36,787,352.75), and the table is the
 *  one the Ratios tab, the report and the workbook print. */
export function ratioTableRows(body: Body | null | undefined): Map<string, RatioTableRow> {
  const am = body?.assembled_metrics;
  const table = isObj(am) ? am.ratio_table : null;
  const rows = isObj(table) && Array.isArray(table.rows) ? table.rows : [];
  const out = new Map<string, RatioTableRow>();
  for (const r of rows) {
    if (isObj(r) && typeof r.key === "string") out.set(r.key, r as unknown as RatioTableRow);
  }
  return out;
}

// ── Inventory days: ONE reader ─────────────────────────────────────────

export interface InventoryDays {
  /** The served block's total: its value and the block's own quantization
   *  (`value_q`, the ratio table's days rule — the string the Ratios tile,
   *  the split and the report print). Null when refused or not served. */
  total: { value: number; value_q: string } | null;
  /** The served basis code (average_monthly | average_two_year_ends |
   *  year_end_snapshot) — for the gates; never printed. */
  basis: string | null;
  /** The served basis LABEL, both languages — what the bar prints beside
   *  the figure ("media soldurilor la 1 ianuarie și 31 decembrie", "stoc la
   *  31 decembrie — o singură zi"). */
  basisLabel: { ro: string; en: string } | null;
  source: "statements.inventory_days";
  /** The block's claim policy: a slow / high claim only on the split AND an
   *  average (owner ruling on inventory days, point 5). */
  maySlowClaim: boolean;
  /** The block's refusal with the engine's words, or `inventory_days_absent`
   *  when the period serves no block. */
  reason: ServedReason | null;
}

export function inventoryDays(body: Body | null | undefined): InventoryDays {
  const st = (body?.statements ?? null) as { inventory_days?: unknown } | null;
  const view = readInventoryDays(st);
  const split = readInventoryDaysSplit(st);
  if (!view || !split) {
    return {
      total: null, basis: null, basisLabel: null,
      source: "statements.inventory_days",
      maySlowClaim: false,
      reason: { code: "inventory_days_absent", inputs: ["statements.inventory_days"] },
    };
  }
  const total = view.total !== null && split.totalQ !== null ? { value: view.total, value_q: split.totalQ } : null;
  const reason: ServedReason | null = total
    ? null
    : view.reason
      ? { code: view.reason.code, inputs: [], text: { ro: view.reason.text.ro, en: view.reason.text.en } }
      : { code: "inventory_days_absent", inputs: ["statements.inventory_days"] };
  return {
    total,
    basis: view.basis,
    basisLabel: view.basisLabel ? { ro: view.basisLabel.ro, en: view.basisLabel.en } : null,
    source: "statements.inventory_days",
    maySlowClaim: view.maySlowClaim,
    reason,
  };
}
