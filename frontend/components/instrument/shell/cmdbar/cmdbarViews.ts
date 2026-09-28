// cmdbarViews.ts — what a Răspuns, Cont or "Ce contează acum" row SAYS,
// as plain data, from served payloads through the shared printers
// (cmdbarFigures.ts). Pure: the component renders these; the gates read
// them.
//
// Cold open is honest, never blank and never 0: the value comes from the
// period body (already cached for the period on screen); the Δ and the
// sector position say "se încarcă" until THEIR cached document lands, and
// say why when there is none (no prior, comparison off, sector refused).

import i18n from "@/i18n";
import type { ComparativeColumnDto, ComparativesResponse } from "@/lib/comparatives";
import type { PeriodLineItem } from "@/lib/activePeriod";
import type { RatioCompareRow, RatioDisplayUnit, RatioSide, RatioTableRow } from "@/lib/ratioTable";
import { SPLIT_BASIS_CARDS, type SectorBenchmarkDoc, type SectorRow } from "@/lib/sectorBenchmark";
import { printDaysQ } from "@/lib/inventoryDays";
import type { AttentionAction, AttentionDoc, AttentionItem } from "@/lib/attention";
import {
  accountEvidenceHref,
  dashboardEvidenceHref,
  findingEvidenceHref,
  lineEvidenceHref,
  ratioEvidenceHref,
  sectorRowEvidenceHref,
} from "@/lib/evidence/evidenceLink";

import {
  absentText,
  printColumnChange,
  printMeasure,
  printMoney,
  printRatioChange,
  printRatioSide,
  printSectorRow,
  ratioLabel,
  type Printer,
} from "./cmdbarFigures";
import {
  inventoryDays,
  isStockVariationAccount,
  ratioTableRows,
  servedEbitda,
  servedLine,
  servedNetResult,
  stockVariation,
  type ServedFigure,
} from "./cmdbarSources";
import { accountMetricKey, type AnswerDef } from "./cmdbarIndex";
import { unwrapWord } from "./cmdbarSearch";

/** A cached document's state as the bar sees it. `none` carries why. */
export type SourceState<T> =
  | { state: "pending" }
  | { state: "ok"; data: T }
  | { state: "none"; reason: "no_prior" | "off" | "refused" | "error" | "no_period" };

export type ServedBody = {
  statements?: unknown;
  assembled_metrics?: Record<string, unknown> | null;
  line_items?: PeriodLineItem[];
};

export interface ViewContext {
  printer: Printer;
  /** Sector rows printed as a POSITION only, never with a verdict word —
   *  the attention document's served rule (`rules.sector_position_only`),
   *  the filed-basis inventory row today. */
  positionOnly?: readonly string[];
  body: ServedBody | null;
  comparatives: SourceState<ComparativesResponse>;
  sector: SourceState<SectorBenchmarkDoc>;
  periodId: string | null;
  orgId: string | null;
}

export interface Chip {
  /** `pending`: its document has not landed; `none`: there is none, and
   *  `text` says why; `ok`: a served figure. */
  state: "pending" | "none" | "ok";
  text: string;
}

export interface FigureView {
  id: string;
  label: string;
  /** The served value, printed — null when absent (then `absent` says why). */
  value: string | null;
  absent: string | null;
  /** "din contul 121" — only on an anchored net result. */
  tag: string | null;
  change: Chip | null;
  /** The figure's share of turnover / its key ratio, printed from the
   *  ratio table. */
  ratios: string[];
  sector: Chip | null;
  /** The basis a figure is on, printed beside it when it is not the
   *  obvious one: inventory days carry the served basis LABEL ("media
   *  soldurilor la 1 ianuarie și 31 decembrie", "stoc la 31 decembrie — o
   *  singură zi"). */
  basis: string | null;
  href: string;
  /** The served numbers the printed strings came from (for the gates). */
  served: { value: number | null; source: string; ratioKeys: string[]; sectorKey: string | null; columnKey: string | null };
}

/** The filed-basis inventory row of the sector document (stock ÷ net
 *  turnover on the abridged filings; packs/ratios/inventory_days.yaml
 *  `filed_basis.sector_row_key`). */
const FILED_BASIS_ROW = "inventory_days_on_turnover";

/** The pack's rule when no attention document has been served yet. */
const DEFAULT_POSITION_ONLY: readonly string[] = [FILED_BASIS_ROW];

function tt(ctx: ViewContext) {
  return i18n.getFixedT(ctx.printer.lang);
}

/** The scope every evidence link is built in: the (company, period) the
 *  bar's facts come from. */
function scopeOf(ctx: ViewContext) {
  return { periodId: ctx.periodId, orgId: ctx.orgId };
}

function ratioLine(ctx: ViewContext, row: RatioTableRow | null | undefined, key: string): string | null {
  if (!row) return null;
  return `${ratioLabel(ctx.printer, key)} ${printRatioSide(ctx.printer, row, row.display_unit as RatioDisplayUnit)}`;
}

/** Inventory days through the ONE adapter (the served block): the printed
 *  total at the block's own quantization — the string the Ratios tile, the
 *  split and the report print (lib/inventoryDays printDaysQ) — with the
 *  served basis LABEL beside it; a refused or absent block prints the
 *  engine's reason, never a number. */
function inventoryDaysLine(ctx: ViewContext): { value: string | null; text: string | null; basis: string | null; key: string } {
  const inv = inventoryDays(ctx.body as never);
  const t = tt(ctx);
  const lang = ctx.printer.lang;
  const label = ratioLabel(ctx.printer, "dio");
  const basis = inv.basisLabel ? inv.basisLabel[lang] : null;
  if (inv.total) {
    const value = printDaysQ(inv.total.value_q, lang);
    return { value, text: t("cmdbar.figure.inventoryDays", { label, value }), basis, key: "dio" };
  }
  return {
    value: null,
    text: t("cmdbar.figure.inventoryDaysRefused", { label, reason: absentText(ctx.printer, inv.reason) }),
    basis,
    key: "dio",
  };
}

function priorBody(cmp: ComparativesResponse): ServedBody {
  return { statements: cmp.prior_statements };
}

function columnChip(ctx: ViewContext, lineKey: string, guard?: (prior: ServedBody) => ServedFigure | null): Chip {
  const t = tt(ctx);
  const c = ctx.comparatives;
  if (c.state === "pending") return { state: "pending", text: t("cmdbar.figure.pending") };
  if (c.state === "none") {
    return { state: "none", text: c.reason === "off" ? t("cmdbar.figure.comparisonOff") : t("cmdbar.figure.noPrior") };
  }
  const col: ComparativeColumnDto | undefined = c.data.columns.find((x) => x.key === lineKey);
  if (!col) return { state: "none", text: t("cmdbar.figure.noPrior") };
  if (guard) {
    // The PRIOR's refusal, NAMED AS THE PRIOR'S: printed bare beside the
    // current figure it reads as a statement about that figure — "Total
    // equity <figure> · total equity excludes the year's result, which is
    // refused …" of a book that HAS account 121 (critic round 2). The
    // engine's own column names the side the same way ("<prior>: <text>",
    // src/engine/comparatives/columns.py).
    const prior = guard(priorBody(c.data));
    if (prior && prior.refusal) {
      return {
        state: "none",
        text: t("cmdbar.figure.priorRefused", { prior: c.data.prior.label, reason: absentText(ctx.printer, prior.refusal) }),
      };
    }
  }
  const change = printColumnChange(ctx.printer, col);
  if (change === null) return { state: "none", text: t("cmdbar.figure.noPrior") };
  return { state: "ok", text: t("cmdbar.figure.vsPrior", { change, prior: c.data.prior.label }) };
}

/** The sector position beside a figure. `besideSplit`: the figure is built
 *  on the split by stock type (inventory days, inventory turnover, the
 *  cycle) — no sector is measured on the split, and the filed-basis row
 *  (stock ÷ net turnover) is NEVER placed beside it (owner spec 2026-09-26
 *  P1.3; the served block's `filed_basis_pointer.never_compare`). */
function sectorChip(
  ctx: ViewContext,
  key: string | null | undefined,
  cardKey?: string,
  besideSplit = false,
): { chip: Chip | null; key: string | null } {
  if (besideSplit && (key === FILED_BASIS_ROW || !key)) return { chip: null, key: null };
  const t = tt(ctx);
  const s = ctx.sector;
  let rowKey = key ?? null;
  if (s.state === "pending") return { chip: rowKey || cardKey ? { state: "pending", text: t("cmdbar.figure.pending") } : null, key: rowKey };
  if (s.state !== "ok") return { chip: null, key: rowKey };
  let row: SectorRow | undefined = rowKey ? s.data.rows.find((r) => r.key === rowKey) : undefined;
  if (!row && cardKey) {
    // The served join: a sector row whose definition names this ratio card.
    row = s.data.rows.find((r) => r.definition?.card_key === cardKey);
    rowKey = row?.key ?? null;
  }
  if (!row) return { chip: null, key: rowKey };
  if (besideSplit && row.key === FILED_BASIS_ROW) return { chip: null, key: null };
  const positionOnly = (ctx.positionOnly ?? DEFAULT_POSITION_ONLY).includes(row.key);
  const printed = printSectorRow(ctx.printer, row, s.data.min_peers, { positionOnly });
  if (!printed) return { chip: null, key: rowKey };
  const position = printed.verdict ? `${printed.position}, ${printed.verdict}` : printed.position;
  // The basis beside a sector figure: the owner's own label for the
  // filed-basis inventory row; the benchmark page's note wherever the
  // sector's definition differs from the ratio card's.
  const basisKey = `cmdbar.sectorBasis.${row.key}`;
  const basis = i18n.exists(basisKey, { lng: ctx.printer.lang })
    ? t(basisKey)
    : row.definition?.differs_from_card && row.definition.card_key
      ? t("benchmarkPage.sector.noteDiffers", { card: t(`benchmarkPage.sector.card.${row.definition.card_key}`) })
      : null;
  // WHAT the sector compares, named: the sector's row for "Net turnover"
  // is revenue GROWTH, and a bare "17.2%" beside a turnover would read as
  // something it is not. A ratio's own row (joined by its card key) is
  // the answer's own name, so it is not repeated.
  const rowLabel = cardKey ? "" : t(`benchmarkPage.sector.ratio.${row.key}`);
  const what = [rowLabel, printed.company ?? ""].filter(Boolean).join(" ");
  return {
    chip: {
      state: "ok",
      text: basis
        ? t("cmdbar.figure.sectorBasis", { what, position, basis })
        : t("cmdbar.figure.sector", { what, position }),
    },
    key: rowKey,
  };
}

/** Răspuns — a statement figure. */
export function statementView(ctx: ViewContext, a: AnswerDef): FigureView {
  const t = tt(ctx);
  const fig: ServedFigure & { anchor?: string | null } =
    a.reader === "ebitda" ? servedEbitda(ctx.body as never)
    : a.reader === "net_result" ? servedNetResult(ctx.body as never)
    : servedLine(ctx.body as never, a.statement ?? "pl", a.field ?? "");
  const value = printMoney(ctx.printer, fig.value);
  const ratios = ratioTableRows(ctx.body as never);
  const lines: string[] = [];
  const ratioKeys: string[] = [];
  let basis: string | null = null;
  for (const key of [a.margin, a.ratio].filter((k): k is string => !!k)) {
    const l = ratioLine(ctx, ratios.get(key), key);
    if (l) { lines.push(l); ratioKeys.push(key); }
  }
  if (a.inventoryDays) {
    const inv = inventoryDaysLine(ctx);
    if (inv.text) { lines.push(inv.text); ratioKeys.push(inv.key); basis = inv.basis; }
  }
  // A prior the engine REFUSED on this line (its words served — the
  // operating result under the one-EBITDA refusal, total equity short by a
  // refused result) carries no Δ: the column would compare a figure the
  // engine does not state. A line merely absent from the prior keeps the
  // column's own word ("new").
  const guard =
    a.reader === "net_result" ? (p: ServedBody) => servedNetResult(p as never)
    : a.reader === "ebitda" ? (p: ServedBody) => servedEbitda(p as never)
    : (p: ServedBody) => {
        const f = servedLine(p as never, a.statement ?? "pl", a.field ?? "");
        return f.refusal?.text ? f : null;
      };
  // An answer that prints the split never carries the filed-basis row.
  const sector = sectorChip(ctx, a.sector, undefined, !!a.inventoryDays);
  return {
    id: `answer:${a.id}`,
    label: t(`cmdbar.answer.${a.id}`),
    value,
    absent: value === null ? absentText(ctx.printer, fig.refusal) : null,
    tag: a.reader === "net_result" && value !== null ? t("cmdbar.figure.fromAccount121") : null,
    change: value === null ? null : columnChip(ctx, a.line, guard),
    ratios: lines,
    sector: sector.chip,
    basis,
    // The line's evidence: its served figure and the accounts that feed it
    // (the account view, `?line=`), on the statement it belongs to.
    href: lineEvidenceHref(scopeOf(ctx), a.line, a.tab),
    served: { value: fig.value, source: fig.source, ratioKeys, sectorKey: sector.key, columnKey: a.line },
  };
}

/** Răspuns — a ratio-table row (never metrics[]). */
export function ratioView(ctx: ViewContext, key: string): FigureView {
  const t = tt(ctx);
  let value: string | null;
  let basis: string | null = null;
  let servedValue: number | null = null;
  let source = `assembled_metrics.ratio_table.${key}`;
  let absent: string | null = null;
  if (key === "dio") {
    const inv = inventoryDays(ctx.body as never);
    const line = inventoryDaysLine(ctx);
    value = line.value;
    basis = line.basis;
    servedValue = inv.total?.value ?? null;
    source = inv.source;
    absent = value === null ? absentText(ctx.printer, inv.reason) : null;
  } else {
    const row = ratioTableRows(ctx.body as never).get(key);
    value = row ? printRatioSide(ctx.printer, row, row.display_unit as RatioDisplayUnit) : null;
    servedValue = row?.value ?? null;
  }
  let change: Chip | null = null;
  const c = ctx.comparatives;
  if (c.state === "pending") change = { state: "pending", text: t("cmdbar.figure.pending") };
  else if (c.state === "none") change = { state: "none", text: c.reason === "off" ? t("cmdbar.figure.comparisonOff") : t("cmdbar.figure.noPrior") };
  else {
    const row: RatioCompareRow | undefined = (c.data.ratios?.rows ?? []).find((r) => r.key === key);
    change = row
      ? { state: "ok", text: t("cmdbar.figure.vsPrior", { change: printRatioChange(ctx.printer, row), prior: c.data.ratios?.prior_label ?? c.data.prior.label }) }
      : { state: "none", text: t("cmdbar.figure.noPrior") };
  }
  // A card built on the split carries no sector position at all — least
  // of all the filed-basis row's (owner spec 2026-09-26 P1.3).
  const split = SPLIT_BASIS_CARDS.has(key);
  const sector = split ? { chip: null, key: null } : sectorChip(ctx, null, key);
  return {
    id: `ratio:${key}`,
    label: ratioLabel(ctx.printer, key),
    value,
    absent: value === null ? absent ?? absentText(ctx.printer, { code: "line_absent" }) : null,
    tag: null,
    change,
    ratios: [],
    sector: sector.chip,
    basis,
    href: ratioEvidenceHref(scopeOf(ctx), key),
    served: { value: servedValue, source, ratioKeys: [key], sectorKey: sector.key, columnKey: null },
  };
}

export interface AccountView {
  id: string;
  code: string;
  name: string;
  statement: string;
  value: string | null;
  absent: string | null;
  keyMetric: string | null;
  basis: string | null;
  /** An account-711 row: what its amount IS (the Capsule's note, from the
   *  served stock-variation block) — null for every other account. */
  note: string | null;
  href: string;
  served: { amount: number | null; metricKey: string | null };
}

export interface StockVariationNote {
  /** The book is CLOSED: a 711 row's amount is its credit turnover (the
   *  production stocked) — never labelled a balance. */
  turnover: boolean;
  /** What a 711 row holds, then the served variation ("Variația stocurilor
   *  de produse") with its provenance — or its refusal in the engine's
   *  words, or that the period serves none. */
  text: string;
  /** The served numbers the text came from (for the gates). */
  served: { value: number | null; bookState: string | null; source: string };
}

/** THE NOTE AN ACCOUNT-711 ROW NEVER PRINTS WITHOUT (owner ruling
 *  2026-09-26, design A1 / A6): on a closed trial balance a 711 row holds
 *  the gross production stocked in the period — its credit turnover — not
 *  the change in inventories, which feeds EBITDA as the served net 711.
 *  The browser twin of the Capsule's `_stock_variation_account_note`
 *  (src/engine/api/_capsule_tools.py), over the SAME served block; the
 *  variation is printed by the bar's money printer, its provenance in the
 *  engine's words. Used by the bar's Cont row and the account view. */
export function stockVariationNote(printer: Printer, body: ServedBody | null): StockVariationNote {
  const t = i18n.getFixedT(printer.lang);
  const sv = stockVariation(body as never);
  const closed = sv.bookState === "closed";
  const head = t(closed ? "cmdbar.account.stockVariation.closed" : "cmdbar.account.stockVariation.open");
  const name = sv.nameRo ?? t("cmdbar.account.stockVariation.name");
  let tail: string;
  if (sv.value !== null) {
    const provenance = sv.provenanceLabel ? sv.provenanceLabel[printer.lang] : null;
    tail = provenance
      ? t("cmdbar.account.stockVariation.served", { name, value: printer.money(sv.value), provenance })
      : t("cmdbar.account.stockVariation.servedBare", { name, value: printer.money(sv.value) });
  } else if (sv.refusal) {
    tail = t("cmdbar.account.stockVariation.refused", { name, reason: absentText(printer, sv.refusal) });
  } else {
    tail = t("cmdbar.account.stockVariation.notServed");
  }
  return { turnover: closed, text: `${head} ${tail}`, served: { value: sv.value, bookState: sv.bookState, source: sv.source } };
}

/** Cont — one served leaf account (never a sum the engine did not serve). */
export function accountView(ctx: ViewContext, item: PeriodLineItem): AccountView {
  const t = tt(ctx);
  const value = printMoney(ctx.printer, item.amount);
  const metricKey = accountMetricKey(item.ro_account_code);
  let keyMetric: string | null = null;
  let basis: string | null = null;
  if (metricKey === "dio") {
    const inv = inventoryDaysLine(ctx);
    keyMetric = inv.text;
    basis = inv.basis;
  } else if (metricKey) {
    keyMetric = ratioLine(ctx, ratioTableRows(ctx.body as never).get(metricKey), metricKey);
  }
  return {
    id: `account:${item.ro_account_code}:${item.bucket}`,
    code: item.ro_account_code,
    name: item.ro_account_name ?? "",
    statement: item.statement === "PL" ? t("cmdbar.account.statementPL") : t("cmdbar.account.statementBS"),
    value,
    absent: value === null ? absentText(ctx.printer, { code: "line_absent" }) : null,
    keyMetric,
    basis,
    note: isStockVariationAccount(item.ro_account_code) ? stockVariationNote(ctx.printer, ctx.body).text : null,
    // The account view (`?account=`): the account's served leaves with
    // period, document and provenance, the requested code highlighted.
    href: accountEvidenceHref(scopeOf(ctx), [item.ro_account_code]),
    served: { amount: typeof item.amount === "number" ? item.amount : null, metricKey },
  };
}

/** The Cont group's overflow row: every account the query found past the
 *  group's cap is counted and opened, never hidden. */
export interface AccountMoreView {
  id: string;
  text: string;
  /** How many the group does not show, and how many it found in all. */
  more: number;
  total: number;
  /** The account view listing every match: the typed code prefix itself
   *  when every match starts with it (`?account=4111` lists all its
   *  leaves), else every matched code. */
  href: string;
  codes: string[];
}

/** The overflow row for the Cont group, or null when nothing is hidden.
 *  `shown` and `hidden` are the group's served line items, in rank order. */
export function accountMoreView(
  ctx: ViewContext,
  query: string,
  shown: readonly PeriodLineItem[],
  hidden: readonly PeriodLineItem[],
): AccountMoreView | null {
  if (hidden.length === 0) return null;
  const t = tt(ctx);
  const all = [...shown, ...hidden];
  const codes: string[] = [];
  for (const li of all) if (!codes.includes(li.ro_account_code)) codes.push(li.ro_account_code);
  const q = query.trim();
  // A single typed word with a digit is a code prefix; the account view
  // lists a prefix's leaves itself (evidenceView accountBlock), so the link
  // is the prefix — exactly when every match starts with it as written.
  // The punctuation around the word ("(4111)", "#4111") is not the code.
  const w = unwrapWord(q);
  const prefix = w && !/\s/.test(q) && /\d/.test(w) && codes.every((c) => c.startsWith(w)) ? w : null;
  return {
    id: `account-more:${q}`,
    text: prefix
      ? t("cmdbar.account.more", { code: prefix, total: all.length, n: hidden.length })
      : t("cmdbar.account.moreMatch", { query: q, total: all.length, n: hidden.length }),
    more: hidden.length,
    total: all.length,
    href: accountEvidenceHref(scopeOf(ctx), prefix ? [prefix] : codes),
    codes,
  };
}

// ── "Ce contează acum" ────────────────────────────────────────────────

export interface NowItemView {
  key: string;
  rank: number;
  subject: string;
  /** The item's served figure, printed. */
  figure: string;
  /** The change / position beside it, printed. */
  context: string | null;
  basis: string | null;
  href: string;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
}

/** The receiver an item's served `evidence` names (design C4):
 *   statement      the account view for that line (`?line=`) — its served
 *                  figure and the accounts that feed it, or, when the
 *                  finding cited accounts, THOSE accounts (`&account=`);
 *   ratio          the ratio's drawer / its ratio-table row (`?ratio=`);
 *   benchmark_row  the sector row on /benchmark (`?row=`);
 *   account        the account view for every account the item cites —
 *                  for a finding, under the finding's own measure
 *                  (`&finding=&measure=`), so the view heads with the
 *                  number the item printed.
 *  Exported for the landing gate (evidenceLanding.test.tsx). */
export function evidenceHref(ctx: ViewContext, item: AttentionItem): string {
  const ev = item.evidence as Record<string, unknown>;
  switch (ev.kind) {
    case "statement":
      return lineEvidenceHref(scopeOf(ctx), String(ev.line ?? ""), String(ev.tab ?? ""), strings(ev.accounts));
    case "ratio":
      return ratioEvidenceHref(scopeOf(ctx), String(ev.ratio ?? ""));
    case "benchmark_row":
      return sectorRowEvidenceHref(scopeOf(ctx), String(ev.route ?? "/benchmark"), String(ev.row ?? ""));
    case "account": {
      const cited = strings(ev.accounts);
      const codes = cited.length > 0 ? cited : strings([ev.account]);
      // A finding's accounts open under the finding's OWN measure — the
      // number this item prints — never under another figure.
      if (typeof ev.finding === "string" && ev.finding && typeof ev.measure === "string" && ev.measure) {
        return findingEvidenceHref(scopeOf(ctx), codes, ev.finding, ev.measure);
      }
      return accountEvidenceHref(scopeOf(ctx), codes);
    }
    default:
      return dashboardEvidenceHref(scopeOf(ctx), {});
  }
}

export function nowItemView(ctx: ViewContext, item: AttentionItem, doc: AttentionDoc): NowItemView {
  const t = tt(ctx);
  const lang = ctx.printer.lang;
  const f = item.figure;
  let figure = "";
  let context: string | null = null;
  if (f.kind === "comparatives_column") {
    figure = printMoney(ctx.printer, f.column.current) ?? absentText(ctx.printer, { code: "line_absent" });
    const change = printColumnChange(ctx.printer, f.column);
    context = change ? t("cmdbar.now.vsPrior", { change, prior: f.prior_label ?? "" }) : null;
  } else if (f.kind === "sector_row") {
    const printed = printSectorRow(ctx.printer, f.row, f.min_peers, { positionOnly: item.verdict === null });
    figure = printed?.company ?? absentText(ctx.printer, { code: "line_absent" });
    context = printed ? (printed.verdict ? `${printed.position}, ${printed.verdict}` : printed.position) : null;
  } else if (f.kind === "ratio_compare_row") {
    figure = printRatioSide(ctx.printer, f.row.current, f.row.display_unit);
    context = t("cmdbar.now.vsPrior", {
      change: printRatioChange(ctx.printer, f.row),
      prior: printRatioSide(ctx.printer, f.row.prior, f.row.display_unit),
    });
  } else if (f.kind === "insight_measure") {
    figure = printMeasure(f.measure, f.currency ?? doc.period.currency);
  }
  return {
    key: item.key,
    rank: item.rank,
    subject: item.subject[lang],
    figure,
    context,
    basis: item.basis_label ? item.basis_label[lang] : null,
    href: evidenceHref(ctx, item),
  };
}

export interface NowActionView {
  key: string;
  label: string;
  target: AttentionAction["target"];
  requiresFeature: string | null;
}

export function nowActionView(ctx: ViewContext, action: AttentionAction): NowActionView {
  return {
    key: action.key,
    label: action.label[ctx.printer.lang],
    target: action.target,
    requiresFeature: action.requires_feature ?? null,
  };
}
