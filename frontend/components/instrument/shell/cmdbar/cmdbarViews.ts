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
import type { SectorBenchmarkDoc, SectorRow } from "@/lib/sectorBenchmark";
import type { AttentionAction, AttentionDoc, AttentionItem } from "@/lib/attention";
import {
  accountEvidenceHref,
  dashboardEvidenceHref,
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
  ratioTableRows,
  servedEbitda,
  servedLine,
  servedNetResult,
  type ServedFigure,
} from "./cmdbarSources";
import { accountMetricKey, type AnswerDef } from "./cmdbarIndex";

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
   *  obvious one (inventory days on a closing snapshot). */
  basis: string | null;
  href: string;
  /** The served numbers the printed strings came from (for the gates). */
  served: { value: number | null; source: string; ratioKeys: string[]; sectorKey: string | null; columnKey: string | null };
}

/** The pack's rule when no attention document has been served yet. */
const DEFAULT_POSITION_ONLY: readonly string[] = ["inventory_days_on_turnover"];

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

/** Inventory days through the ONE adapter, with its basis: the printed
 *  value alone, and the value with the metric's name. */
function inventoryDaysLine(ctx: ViewContext): { value: string | null; text: string | null; basis: string | null; key: string } {
  const inv = inventoryDays(ctx.body as never);
  const t = tt(ctx);
  const label = ratioLabel(ctx.printer, "dio");
  if (inv.row) {
    const value = printRatioSide(ctx.printer, inv.row, inv.row.display_unit as RatioDisplayUnit);
    return {
      value,
      text: `${label} ${value}`,
      basis: inv.basis === "ratio_table_dio_snapshot" ? t("cmdbar.figure.inventoryBasis") : inv.basis,
      key: "dio",
    };
  }
  if (inv.total) {
    const side = { value: inv.total.value, value_q: inv.total.value_q, reason: inv.reason } as unknown as RatioSide;
    const value = printRatioSide(ctx.printer, side, "days");
    return { value, text: `${label} ${value}`, basis: inv.basis, key: "dio" };
  }
  return { value: null, text: null, basis: null, key: "dio" };
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
    const prior = guard(priorBody(c.data));
    if (prior && prior.refusal) return { state: "none", text: absentText(ctx.printer, prior.refusal) };
  }
  const change = printColumnChange(ctx.printer, col);
  if (change === null) return { state: "none", text: t("cmdbar.figure.noPrior") };
  return { state: "ok", text: t("cmdbar.figure.vsPrior", { change, prior: c.data.prior.label }) };
}

function sectorChip(ctx: ViewContext, key: string | null | undefined, cardKey?: string): { chip: Chip | null; key: string | null } {
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
  const guard =
    a.reader === "net_result" ? (p: ServedBody) => servedNetResult(p as never)
    : a.reader === "ebitda" ? (p: ServedBody) => servedEbitda(p as never)
    : undefined;
  const sector = sectorChip(ctx, a.sector);
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
  if (key === "dio") {
    const inv = inventoryDays(ctx.body as never);
    const line = inventoryDaysLine(ctx);
    value = line.value;
    basis = line.basis;
    servedValue = inv.row ? inv.row.value ?? null : inv.total?.value ?? null;
    source = inv.source;
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
  const sector = sectorChip(ctx, key === "dio" ? "inventory_days_on_turnover" : null, key === "dio" ? undefined : key);
  return {
    id: `ratio:${key}`,
    label: ratioLabel(ctx.printer, key),
    value,
    absent: value === null ? absentText(ctx.printer, { code: key === "dio" ? "inventory_days_absent" : "line_absent" }) : null,
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
  href: string;
  served: { amount: number | null; metricKey: string | null };
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
    // The account view (`?account=`): the account's served leaves with
    // period, document and provenance, the requested code highlighted.
    href: accountEvidenceHref(scopeOf(ctx), [item.ro_account_code]),
    served: { amount: typeof item.amount === "number" ? item.amount : null, metricKey },
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
 *   account        the account view for every account the item cites.
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
