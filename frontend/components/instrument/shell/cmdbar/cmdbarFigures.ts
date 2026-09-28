// cmdbarFigures.ts — how the command bar PRINTS a served figure.
//
// It adds no formatter of its own. Every string below is produced by the
// printer the rest of the product already uses for the same served object,
// so "the bar's figure equals the served figure" holds by construction:
//
//   money            lib/money formatMoneyFrom, in the currency the engine
//                    SERVED the figure in, with that currency's code — never
//                    converted in the browser (`servedMoney`). The header's
//                    display toggle converts the dashboard's tables, which
//                    carry a currency chip; a converted figure here printed
//                    "81.060,2 from account 121" for a 402,869.16 RON result,
//                    with no currency, beside "RON 753,070.01" in the same
//                    panel. One panel, one currency: the served one;
//   a Δ of a line    the comparatives column's own `change_kind` and
//                    `delta_pct` through lib/changeKind + formatDeltaPct —
//                    the exact rule ComparativeCells prints (a move across
//                    zero or a sign is a WORD, never a percentage);
//   a ratio          lib/ratioTable formatRatioSide / formatRatioDelta over
//                    the served `value_q` strings (only the decimal
//                    separator is localised);
//   a sector row     lib/sectorBenchmark lawfulFigure (the law's door) and
//                    sectorValueText, and the page's own position words;
//   a finding        lib/insights formatMeasure.
//
// An absent figure prints the REASON (cmdbar.absent.*), never 0 and never
// a bare dash.

import i18n from "@/i18n";
import {
  CHANGE_KIND_NO_CHANGE_KEY,
  changeKindWordKey,
  isWordKind,
} from "@/lib/changeKind";
import { formatDeltaPct, type ComparativeColumnDto } from "@/lib/comparatives";
import { formatMeasure, type InsightMeasure } from "@/lib/insights";
import {
  formatRatioDelta,
  formatRatioSide,
  joinRatioDelta,
  localiseDecimal,
  ratioLabelForKey,
  type RatioCompareRow,
  type RatioSide,
  type RatioDisplayUnit,
} from "@/lib/ratioTable";
import {
  lawfulFigure,
  sectorValueText,
  type SectorRow,
} from "@/lib/sectorBenchmark";
import { formatMoneyFrom } from "@/lib/money";
import type { Currency, Rates } from "@/lib/rates";

import "./cmdbarI18n";
import type { ServedReason } from "./cmdbarSources";

export type Lang = "en" | "ro";

export function langOf(language: string | null | undefined): Lang {
  return (language ?? "en").toLowerCase().startsWith("ro") ? "ro" : "en";
}

export interface Printer {
  lang: Lang;
  /** The money printer: `servedMoney(<the period's served currency>)`. */
  money: (value: number) => string;
}

/** A served amount printed in the currency it was SERVED in, with that
 *  currency's code ("402,9 K RON", "−2.577.640,82 RON") — lib/money's
 *  formatMoneyFrom with source = display, so no rate is ever applied. The
 *  locale follows the currency, as everywhere money is printed. */
export function servedMoney(
  currency: string | null | undefined,
  opts: { compact?: boolean } = {},
): (value: number | null | undefined) => string {
  const code = (currency || "RON").toUpperCase() as Currency;
  const key = `${code}|${opts.compact ? "c" : "f"}`;
  const cached = SERVED_MONEY.get(key);
  if (cached) return cached;
  const print = (value: number | null | undefined): string => {
    // The bar never reaches this with no value (printMoney says why
    // instead); the account view's table cell keeps its dash.
    if (typeof value !== "number" || !Number.isFinite(value)) return "—";
    try {
      return formatMoneyFrom(value, code, code, {} as Rates, { compact: opts.compact });
    } catch {
      // Not an ISO code Intl knows: the number and the code as served.
      return `${value.toFixed(2)} ${code}`;
    }
  };
  SERVED_MONEY.set(key, print);
  return print;
}

/** One printer per (currency, compactness): a stable identity, so a
 *  component can bind it (`const fmt = servedMoney(currency)`) without a
 *  memo and the provenance census counts that binding's calls. */
const SERVED_MONEY = new Map<string, (value: number | null | undefined) => string>();

function t(lang: Lang) {
  return i18n.getFixedT(lang);
}

/** The sentence for a served refusal / absence. A refusal the engine
 *  WORDED (the one EBITDA's, the inventory-days block's) prints the
 *  engine's own words in the reader's language — never its code. */
export function absentText(p: Printer, reason: ServedReason | null | undefined): string {
  const worded = reason?.text?.[p.lang];
  if (typeof worded === "string" && worded) return worded;
  const code = reason?.code ?? "line_absent";
  const status = Array.isArray(reason?.inputs) && typeof reason?.inputs[0] === "string"
    ? (reason?.inputs[0] as string) : "";
  const key = `cmdbar.absent.${code}`;
  const out = t(p.lang)(key, { status, code });
  return out === key ? t(p.lang)("cmdbar.absent.unknown", { code }) : out;
}

/** A served money value, or null (the caller prints the reason). */
export function printMoney(p: Printer, value: number | null | undefined): string | null {
  return typeof value === "number" && Number.isFinite(value) ? p.money(value) : null;
}

/** The change of a comparatives column, printed the way ComparativeCells
 *  prints its Δ % cell: the classifier's WORD for a move from or to zero or
 *  across a sign; the engine's `delta_pct` otherwise; the refusal word for
 *  a line one period does not carry. Null when nothing can be said. */
export function printColumnChange(p: Printer, col: ComparativeColumnDto): string | null {
  const tt = t(p.lang);
  if (col.change_kind && isWordKind(col.change_kind)) return tt(changeKindWordKey(col.change_kind));
  switch (col.status) {
    case "absent_prior": return tt("statements.cmp.new");
    case "absent_current": return tt("statements.cmp.gone");
    case "not_disclosed_at_this_detail_level":
    case "incomparable": return tt("statements.cmp.notAtLevel");
    case "compared_no_base": return tt("statements.cmp.noBase");
    default: break;
  }
  const pct = formatDeltaPct(col.delta_pct);
  if (pct !== null) return localiseDecimal(pct, p.lang);
  if (col.status === "compared" && col.change_kind === "compared") return tt(CHANGE_KIND_NO_CHANGE_KEY);
  return null;
}

/** One side of a served ratio row. */
export function printRatioSide(p: Printer, side: RatioSide | null | undefined, unit: RatioDisplayUnit): string {
  return formatRatioSide(side, unit, p.lang);
}

/** The served change of a two-period ratio row, as one cell. */
export function printRatioChange(p: Printer, row: RatioCompareRow): string {
  return joinRatioDelta(formatRatioDelta(row.delta, p.lang));
}

/** The printed name of a served ratio key (the Ratios tab's own label). */
export function ratioLabel(p: Printer, key: string): string {
  return ratioLabelForKey(key, p.lang) ?? key;
}

export interface PrintedSector {
  /** The company's figure in the row's unit. */
  company: string | null;
  /** The quartile position, as the benchmark page words it. */
  position: string;
  /** The page's verdict word ("worse than the sector"), or null for a
   *  position-only row (the filed-basis inventory row). */
  verdict: string | null;
}

/** A sector row, or null when the law refuses it (no source, year, n, or
 *  fewer peers than the served minimum). */
export function printSectorRow(
  p: Printer,
  row: SectorRow,
  minPeers: number,
  opts: { positionOnly?: boolean } = {},
): PrintedSector | null {
  if (row.status !== "sourced" || !row.position) return null;
  if (!lawfulFigure(row.sector, minPeers)) return null;
  const tt = t(p.lang);
  const company = typeof row.company.value === "number"
    ? sectorValueText(row.company.value, row.unit, p.lang) : null;
  const verdict = opts.positionOnly || !row.vs_sector || row.vs_sector === "inside"
    ? null : tt(`cmdbar.vsSector.${row.vs_sector}`);
  return { company, position: tt(`benchmarkPage.sector.position.${row.position}`), verdict };
}

/** A finding's headline measure. */
export function printMeasure(measure: InsightMeasure, currency: string | null): string {
  return formatMeasure(measure, currency ?? "");
}
