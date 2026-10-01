// The public sample's generated document, and the printers the /sample
// page reads it with.
//
// `frontend/data/publicSample.json` is written by
// scripts/build_public_sample.py from the documents the engine served for
// the fictional book: every figure carries the pointer it was read from.
// Nothing here computes or decides — the functions below only PRINT, through
// the product's own printers (lib/money, lib/ratioTable), in the reader's
// language. The page is frontend/pages/cfo/PublicSample.tsx; the gate is
// `public-sample-page` (frontend/pages/cfo/__tests__/publicSample.test.tsx).

import sampleData from "@/data/publicSample.json";
import i18n from "@/i18n";
import { formatMoneyFrom, moneyLocaleFor } from "@/lib/money";
import {
  bandWordKey,
  formatRatioSide,
  type RatioDisplayUnit,
  type RatioSide,
} from "@/lib/ratioTable";
import type { Rates } from "@/lib/rates";

export type SampleLang = "en" | "ro";

/** The page's nine file cards. */
export type FileKey =
  | "trial_balance_current"
  | "trial_balance_prior"
  | "report_html"
  | "report_pdf"
  | "mapping"
  | "labels"
  | "served_current"
  | "served_prior"
  | "served_comparatives";

// ── the generated document ────────────────────────────────────────────

export interface SampleFigure {
  key: string;
  pointer: string;
  value: number;
}

export interface SampleRatioSide {
  value: number | null;
  value_q: string | null;
  band: string | null;
  band_status: string;
  reason: { code: string; inputs?: string[] } | null;
}

export interface SampleRatio {
  key: string;
  kind: "ratio" | "composite";
  display_unit: string;
  pointer: string;
  current: SampleRatioSide;
  prior: SampleRatioSide;
}

export interface SampleLabel {
  key: string;
  kind: string;
  area: string;
  source: string;
  engine_en: string | null;
  engine_ro: string | null;
  /** A refused ratio: the served code and the inputs it lacked. */
  reason: { ratio: string; display_unit: string; code: string; inputs: string[] } | null;
}

/** What the page quotes for a label, and the language it is quoted in.
 *  A refused ratio has no engine sentence: its served reason is worded by
 *  the ratio table's own reader, in the reader's language. */
export function labelQuote(label: SampleLabel, lang: SampleLang): { text: string; quotedIn: SampleLang } {
  if (label.reason !== null) {
    const side: SampleRatioSide = {
      value: null,
      value_q: null,
      band: null,
      band_status: "refused",
      reason: { code: label.reason.code, inputs: label.reason.inputs },
    };
    return { text: sampleRatio(side, label.reason.display_unit, lang), quotedIn: lang };
  }
  const own = lang === "ro" ? label.engine_ro : label.engine_en;
  if (own !== null) return { text: own, quotedIn: lang };
  return label.engine_en !== null
    ? { text: label.engine_en, quotedIn: "en" }
    : { text: label.engine_ro ?? "", quotedIn: "ro" };
}

export interface SampleMappingRow {
  account: string;
  account_name: string;
  statement: string | null;
  engine_bucket: string | null;
  balance_sheet_section: string | null;
  balance_sheet_row: string | null;
  /** The served P&L line (a field of `assembled_pl`) the account sums into. */
  pl_line: string | null;
  amount_ron: number | null;
  status: string;
  note: { key: string; value: number } | null;
}

export interface SampleFile {
  name: string;
  kind: string;
  bytes?: number;
  sha256?: string;
}

export type PublicSampleData = typeof sampleData;

export const SAMPLE: PublicSampleData = sampleData;

/** Where the published files are served from. */
export const SAMPLE_FILES_BASE = "/sample/";

/** The page's file cards, in order: which published file each one is. */
export function fileKeys(data: PublicSampleData): Array<{ key: FileKey; file: SampleFile }> {
  const files = data.files as SampleFile[];
  const of = (kind: string) => files.filter((f) => f.kind === kind);
  const [tbCurrent, tbPrior] = of("trial_balance");
  const [servedCurrent, servedPrior, servedCmp] = of("served_document");
  return [
    { key: "trial_balance_current", file: tbCurrent },
    { key: "trial_balance_prior", file: tbPrior },
    { key: "report_html", file: of("report_html")[0] },
    { key: "report_pdf", file: of("report_pdf")[0] },
    { key: "mapping", file: of("mapping")[0] },
    { key: "labels", file: of("labels")[0] },
    { key: "served_current", file: servedCurrent },
    { key: "served_prior", file: servedPrior },
    { key: "served_comparatives", file: servedCmp },
  ];
}

// ── printers (the product's own; nothing is formatted by hand) ────────

/** Same-currency print: the rates are never read. */
const NO_CONVERSION: Rates = { EUR: 1, RON: 1, USD: 1 };

/** A served RON amount in the reader's language: "9,358,823.90 RON" /
 *  "9.358.823,90 RON" (CLAUDE.md §26). */
export function sampleMoney(value: number, lang: SampleLang): string {
  return formatMoneyFrom(value, "RON", "RON", NO_CONVERSION, { locale: moneyLocaleFor(lang) });
}

/** A served ratio side through the ratio table's printer. */
export function sampleRatio(side: SampleRatioSide, unit: string, lang: SampleLang): string {
  const full: RatioSide = {
    value: side.value,
    value_q: side.value_q,
    band: side.band as RatioSide["band"],
    band_status: side.band_status as RatioSide["band_status"],
    ladder: null,
    ladder_floor: null,
    operands: [],
    reason: side.reason as RatioSide["reason"],
  };
  return formatRatioSide(full, unit as RatioDisplayUnit, lang);
}

/** The band a ratio was graded into, in the reader's language; a credit
 *  letter has no word of its own and prints nothing. */
export function sampleBand(side: SampleRatioSide, lang: SampleLang): string {
  if (side.band === null) return "";
  const key = bandWordKey(side.band as RatioSide["band"]);
  return key === "" ? "" : i18n.getFixedT(lang)(key);
}
