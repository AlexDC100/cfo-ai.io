// Company vs sector — the ONE reader and the ONE printer of the served
// `sector_benchmark/1` document (GET /api/period/{id}/sector-benchmark).
//
// THE LAW, at the frontend boundary: a sector figure renders only with
// its SOURCE, YEAR and N. `lawfulFigure` is the single door every surface
// goes through; a figure that fails it prints NOTHING numeric — the row
// says the figure was withheld and why. Fewer peers than the served
// minimum prints words, never a median. Absent is never zero: a row
// without a company figure prints its served reason.
//
// Page, ratio card, report and workbook all print `printSectorRows` /
// `bandSourceText`, so the same row is the same bytes everywhere
// (sectorBenchmark.test.tsx holds the page and the report to that).
//
// No cut-off is typed here (TC-10): size-band limits, the peer minimum
// and the year come from the document.

import i18n from "@/i18n";
import { authOrgHeaders } from "@/lib/apiHeaders";

export const SECTOR_BENCHMARK_SCHEMA = "sector_benchmark/1";

export type SectorUnit = "fraction" | "days";
export type SectorPosition = "below_p25" | "p25_to_median" | "median_to_p75" | "above_p75";
export type VsSector = "better" | "worse" | "inside" | null;

export interface ServedReason {
  code: string;
  inputs?: unknown;
  text?: string | null;
  /** The engine's own sentence, per language, on a figure it REFUSED
   *  (`company_figure_refused`: a refused net result, total equity short
   *  by a refused result, a ratio card that refused the same figure). */
  text_en?: string | null;
  text_ro?: string | null;
  cause?: string | null;
}

export interface SectorFigure {
  median?: number;
  p25?: number;
  p75?: number;
  n?: number;
  year?: number;
  prior_year?: number;
  source?: string;
  filed_lines?: string[];
  level?: "caen4" | "caen2";
  sector_caen?: string;
  fallback_from?: { caen: string; reason: string; n_at_class: number | null };
  unit?: SectorUnit;
}

export interface SectorRow {
  key: string;
  unit: SectorUnit;
  direction: "higher" | "lower" | null;
  status: "sourced" | "insufficient_peers" | "company_absent" | "company_refused" | "sector_absent";
  definition: { formula?: string | null; company_basis?: string | null; card_key: string | null; differs_from_card: boolean };
  company: { value: number | null; basis: string | null; operands: unknown[] };
  sector: SectorFigure | null;
  position: SectorPosition | null;
  vs_sector: VsSector;
  percentile: number | null;
  reason: ServedReason | null;
}

export interface SizeBand { key: string; min_ron: number; max_ron: number | null }

export interface SectorMovementItem {
  key: string;
  unit: SectorUnit;
  from: SectorPosition;
  to: SectorPosition;
  company_prior: number | null;
  company_now: number | null;
  n?: number;
  year?: number;
  source?: string;
}

export type RatioCardBand =
  | ({ band_source: "sector"; sector_key: string; unit: SectorUnit; size_band: SizeBand;
       position: SectorPosition; vs_sector: VsSector } & SectorFigure)
  | { band_source: "general"; reason: ServedReason | null };

export interface SectorBenchmarkDoc {
  schema: string;
  status: "ok" | "refused";
  reason: ServedReason | null;
  period: { id: string | null; period_end: string | null };
  prior_period: { id: string | null; period_end: string | null } | null;
  source: string | null;
  year: number;
  prior_year: number | null;
  min_peers: number;
  size_bands: SizeBand[];
  peer_set: string | null;
  sector_disputed: boolean;
  caen: string | null;
  caen_source?: "workspace" | "period_industry_choice" | null;
  sector_label?: string | null;
  size_band?: SizeBand;
  rows: SectorRow[];
  refused: { key: string; reason: ServedReason }[];
  movements: {
    status: "ok" | "refused";
    reason: ServedReason | null;
    improved: SectorMovementItem[];
    deteriorated: SectorMovementItem[];
    compared: number;
    of: number;
  };
  ratio_cards: Record<string, RatioCardBand>;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The served document, shape-checked; anything else is null. */
export function readSectorBenchmark(doc: unknown): SectorBenchmarkDoc | null {
  if (!isObj(doc) || doc.schema !== SECTOR_BENCHMARK_SCHEMA) return null;
  if (!Array.isArray(doc.rows) || !isObj(doc.ratio_cards) || !isObj(doc.movements)) return null;
  return doc as unknown as SectorBenchmarkDoc;
}

export interface LawfulFigure {
  median: number; p25: number; p75: number; n: number; year: number; source: string;
}

/** THE LAW's door. A figure without source, year or n — or a median on
 *  fewer peers than the served minimum — is not a figure. */
export function lawfulFigure(fig: unknown, minPeers: number): LawfulFigure | null {
  if (!isObj(fig)) return null;
  const { median, p25, p75, n, year, source } = fig;
  const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  if (!num(median) || !num(p25) || !num(p75)) return null;
  if (!num(n) || !Number.isInteger(n) || !num(year)) return null;
  if (typeof source !== "string" || source.trim() === "") return null;
  if (!num(minPeers) || n < minPeers) return null;
  return { median, p25, p75, n, year, source };
}

// ─── fetch ──────────────────────────────────────────────────────────────

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";

export type SectorBenchmarkFetch =
  | { kind: "ok"; data: SectorBenchmarkDoc }
  | { kind: "error"; status: number };

export async function fetchSectorBenchmark(periodId: string): Promise<SectorBenchmarkFetch> {
  // The route resolves the ACTIVE workspace from X-Org-Id; without it the
  // engine falls back to the oldest membership and the period 403s. The ONE
  // helper builds both headers (and degrades to the bare bearer when the
  // workspace will not resolve) — gate: lib/__tests__/orgScopedFetch.test.ts.
  const headers = await authOrgHeaders();
  if (!headers) return { kind: "error", status: 401 };
  try {
    const res = await fetch(`${API_URL}/api/period/${encodeURIComponent(periodId)}/sector-benchmark`, { headers });
    if (!res.ok) return { kind: "error", status: res.status };
    const doc = readSectorBenchmark(await res.json());
    return doc ? { kind: "ok", data: doc } : { kind: "error", status: 0 };
  } catch {
    return { kind: "error", status: 0 };
  }
}

// ─── the printer ────────────────────────────────────────────────────────

type T = ReturnType<typeof i18n.getFixedT>;

function localeOf(locale?: string | null): "en" | "ro" {
  return (locale ?? i18n.language ?? "en").toLowerCase().startsWith("ro") ? "ro" : "en";
}

function tFor(locale?: string | null): T {
  return i18n.getFixedT(localeOf(locale));
}

function one(v: number, loc: "en" | "ro"): string {
  return new Intl.NumberFormat(loc === "ro" ? "ro-RO" : "en-US", {
    minimumFractionDigits: 1, maximumFractionDigits: 1,
  }).format(v);
}

/** One figure in its unit: a fraction prints as a percentage, days as days. */
export function sectorValueText(v: number, unit: SectorUnit, locale?: string | null): string {
  const loc = localeOf(locale);
  if (unit === "days") return tFor(loc)("benchmarkPage.sector.daysValue", { value: one(v, loc) });
  return `${one(v * 100, loc)}%`;
}

function whole(v: number, loc: "en" | "ro"): string {
  return new Intl.NumberFormat(loc === "ro" ? "ro-RO" : "en-US", { maximumFractionDigits: 0 }).format(v);
}

/** The size band with its cut-offs, printed from the served band. */
export function sizeBandText(band: SizeBand | undefined, locale?: string | null): string {
  if (!band) return "";
  const loc = localeOf(locale);
  const t = tFor(loc);
  return band.max_ron === null
    ? t("benchmarkPage.sector.sizeBandOpen", { min: whole(band.min_ron, loc) })
    : t("benchmarkPage.sector.sizeBandRange", { min: whole(band.min_ron, loc), max: whole(band.max_ron, loc) });
}

function reasonSentence(reason: ServedReason | null, t: T, loc?: string): string {
  const code = reason?.code ?? "unknown";
  const inputs = reason?.inputs;
  const vars: Record<string, unknown> = {};
  if (isObj(inputs)) Object.assign(vars, inputs);
  else if (Array.isArray(inputs)) vars.inputs = inputs.join(", ");
  // A REFUSED figure prints the engine's own sentence in the page's
  // language — never a bare "not compared".
  const engineText = loc === "ro" ? (reason?.text_ro ?? reason?.text_en) : (reason?.text_en ?? reason?.text_ro);
  vars.text = engineText ?? reason?.text ?? code;
  const key = `benchmarkPage.sector.reason.${code}`;
  const out = t(key, vars);
  return out === key ? t("benchmarkPage.sector.reason.unknown", { code }) : out;
}

export interface PrintedSectorRow {
  key: string;
  label: string;
  status: "sourced" | "refused";
  /** Company figure, or "" when absent (the reason carries the words). */
  company: string;
  median: string;
  iqr: string;
  n: string;
  fy: string;
  source: string;
  position: string;
  vsSector: VsSector;
  /** The refusal sentence when status is "refused"; else "". */
  reason: string;
  /** Definition note: the filed basis, and where the ratio card differs. */
  note: string;
  level: string;
  /** Numbers for the range bar — present ONLY on a lawful sourced row. */
  bar: { p25: number; median: number; p75: number; company: number } | null;
}

export function printSectorRows(doc: SectorBenchmarkDoc, locale?: string | null): PrintedSectorRow[] {
  const loc = localeOf(locale);
  const t = tFor(loc);
  return doc.rows.map((row) => {
    const label = t(`benchmarkPage.sector.ratio.${row.key}`);
    const fig = lawfulFigure(row.sector, doc.min_peers);
    const company = row.company.value === null || row.company.value === undefined
      ? "" : sectorValueText(row.company.value, row.unit, loc);
    const note = row.definition.differs_from_card && row.definition.card_key
      ? t("benchmarkPage.sector.noteDiffers", { card: t(`benchmarkPage.sector.card.${row.definition.card_key}`) })
      : "";
    const base = { key: row.key, label, company, note, vsSector: null as VsSector, bar: null,
                   median: "", iqr: "", n: "", fy: "", source: "", position: "", level: "" };
    if (row.status !== "sourced" || !fig || row.company.value === null || !row.position) {
      // A sourced row whose figure fails the law is withheld, and says so.
      const reason = row.status === "sourced"
        ? t("benchmarkPage.sector.reason.figure_withheld")
        : reasonSentence(row.reason, t, loc);
      // The peer count of a thin cell is a fact about the source, and is
      // printed only with that source and year beside it.
      const s = row.sector;
      const thin = row.status === "insufficient_peers" && s && typeof s.n === "number"
        && typeof s.year === "number" && typeof s.source === "string" && s.source.trim() !== "";
      return { ...base, status: "refused" as const, reason,
               n: thin ? String(s!.n) : "", fy: thin ? `FY${s!.year}` : "", source: thin ? s!.source! : "" };
    }
    const level = row.sector?.level === "caen2" && row.sector.sector_caen
      ? t("benchmarkPage.sector.levelDivision", { caen: row.sector.sector_caen }) : "";
    return {
      ...base,
      status: "sourced" as const,
      median: sectorValueText(fig.median, row.unit, loc),
      iqr: t("benchmarkPage.sector.iqr", {
        p25: sectorValueText(fig.p25, row.unit, loc), p75: sectorValueText(fig.p75, row.unit, loc) }),
      n: String(fig.n),
      fy: `FY${fig.year}`,
      source: fig.source,
      position: t(`benchmarkPage.sector.position.${row.position}`),
      vsSector: row.vs_sector,
      reason: "",
      level,
      bar: { p25: fig.p25, median: fig.median, p75: fig.p75, company: row.company.value },
    };
  });
}

/** How the peer set is NAMED: the 4-digit class, or the 2-digit division
 *  the band fell back to. A fallback band is a different peer set from the
 *  one the context line names, so every surface that prints the band says
 *  which level it came from. */
export function sectorRefText(fig: SectorFigure | undefined | null, fallbackCaen: string | null, locale?: string | null): string {
  const loc = localeOf(locale);
  const caen = fig?.sector_caen ?? fallbackCaen ?? "";
  const level = fig?.level === "caen2" ? "caen2" : "caen4";
  return tFor(loc)(`benchmarkPage.sector.sectorRef.${level}`, { caen });
}

/** The context line: CAEN, sector, size band with cut-offs, FY. */
export function sectorContextText(doc: SectorBenchmarkDoc, locale?: string | null): string {
  const loc = localeOf(locale);
  const t = tFor(loc);
  if (doc.status !== "ok") return reasonSentence(doc.reason, t, loc);
  return t("benchmarkPage.sector.context", {
    caen: doc.caen, sector: doc.sector_label ?? "", sizeBand: sizeBandText(doc.size_band, loc), year: doc.year });
}

export interface PrintedMovement { key: string; label: string; text: string; cite: string }

export function printSectorMovements(doc: SectorBenchmarkDoc, locale?: string | null): {
  status: "ok" | "refused"; reason: string; improved: PrintedMovement[]; deteriorated: PrintedMovement[]; counts: string;
} {
  const loc = localeOf(locale);
  const t = tFor(loc);
  const m = doc.movements;
  const print = (items: SectorMovementItem[]): PrintedMovement[] => items.flatMap((it) => {
    // Law: a movement item cites its figure or does not print.
    if (typeof it.n !== "number" || typeof it.year !== "number" || !it.source) return [];
    return [{
      key: it.key,
      label: t(`benchmarkPage.sector.ratio.${it.key}`),
      text: t("benchmarkPage.sector.movedFromTo", {
        from: t(`benchmarkPage.sector.position.${it.from}`), to: t(`benchmarkPage.sector.position.${it.to}`) }),
      cite: t("benchmarkPage.sector.cite", { n: it.n, year: it.year }),
    }];
  });
  return {
    status: m.status,
    reason: m.status === "refused" ? reasonSentence(m.reason, t, loc) : "",
    improved: print(m.improved),
    deteriorated: print(m.deteriorated),
    counts: t("benchmarkPage.sector.comparedCount", { compared: m.compared, of: m.of }),
  };
}

/** The ratio card's band-source line: the sector band beside the general
 *  ladder, or the sentence saying the ladder is the general fallback and
 *  why. `null` doc (no served document) prints the general sentence. */
export function bandSourceOf(doc: SectorBenchmarkDoc | null, censusKey: string): "sector" | "general" {
  const card = doc?.ratio_cards?.[censusKey];
  if (!doc || !card || card.band_source !== "sector") return "general";
  return lawfulFigure(card, doc.min_peers) ? "sector" : "general";
}

export function bandSourceText(doc: SectorBenchmarkDoc | null, censusKey: string, locale?: string | null): string {
  const loc = localeOf(locale);
  const t = tFor(loc);
  const card = doc?.ratio_cards?.[censusKey];
  if (!doc || !card) return t("benchmarkPage.sector.bandGeneral");
  if (bandSourceOf(doc, censusKey) === "sector" && card.band_source === "sector") {
    const fig = lawfulFigure(card, doc.min_peers)!;
    return t("benchmarkPage.sector.bandSector", {
      median: sectorValueText(fig.median, card.unit, loc),
      p25: sectorValueText(fig.p25, card.unit, loc),
      p75: sectorValueText(fig.p75, card.unit, loc),
      sectorRef: sectorRefText(card, doc.caen, loc),
      sizeBand: sizeBandText(card.size_band, loc),
      n: fig.n, year: fig.year, source: fig.source,
      position: t(`benchmarkPage.sector.position.${card.position}`),
    });
  }
  if (card.band_source === "sector") return t("benchmarkPage.sector.bandGeneral");
  return t("benchmarkPage.sector.bandGeneralBecause", { reason: reasonSentence(card.reason, t, loc) });
}

// ─── the report twin ────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** "Company vs sector" as report HTML (`table.fin`). Same printer as the
 *  page; the cells carry the same `data-cell` names so the byte-match gate
 *  reads both surfaces the same way. Empty string when there is nothing
 *  lawful to print a table from. */
export function sectorReportSectionHtml(doc: SectorBenchmarkDoc | null, locale?: string | null): string {
  if (!doc) return "";
  const loc = localeOf(locale);
  const t = tFor(loc);
  const head = `<h3>${esc(t("benchmarkPage.sector.title"))}</h3>`
    + `<p class="meta" data-sector-context>${esc(sectorContextText(doc, loc))}</p>`;
  if (doc.status !== "ok") return `<section class="sector-benchmark" data-sector-benchmark>${head}</section>`;
  const cols = ["ratio", "company", "median", "iqr", "n", "fy", "position", "level"] as const;
  const th = cols.map((c) => `<th>${esc(t(`benchmarkPage.sector.col.${c}`))}</th>`).join("");
  const body = printSectorRows(doc, loc).map((r) => {
    const cell = (name: string, text: string, cls = "") =>
      `<td data-cell="${name}"${cls ? ` class="${cls}"` : ""}>${esc(text)}</td>`;
    const tail = r.status === "sourced"
      ? cell("median", r.median, "num") + cell("iqr", r.iqr, "num") + cell("n", r.n, "num")
        + cell("fy", r.fy) + cell("position", r.position) + cell("level", r.level)
      : `<td data-cell="reason" colspan="6">${esc(r.reason)}</td>`;
    const note = r.note ? `<div class="meta" data-cell="note">${esc(r.note)}</div>` : "";
    return `<tr data-sector-row="${esc(r.key)}" data-status="${r.status}">`
      + `<td data-cell="label">${esc(r.label)}${note}</td>${cell("company", r.company, "num")}${tail}</tr>`;
  }).join("");
  const source = doc.source ? `<p class="meta" data-sector-source>${esc(t("benchmarkPage.sector.sourceLine", {
    source: doc.source, min: doc.min_peers }))}</p>` : "";
  return `<section class="sector-benchmark" data-sector-benchmark>${head}<table class="fin"><thead><tr>${th}</tr></thead>`
    + `<tbody>${body}</tbody></table>${source}</section>`;
}
