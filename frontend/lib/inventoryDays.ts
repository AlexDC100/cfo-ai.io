// INVENTORY DAYS — the ONE served block, read; never computed here.
//
// The engine serves `statements.inventory_days` (and the same object as
// `assembled_metrics.inventory_days`, schema `inventory_days/1`,
// src/engine/ratios/inventory_days.py): inventory days split by stock type
// (materials, finished goods + WIP, merchandise, "alte stocuri" inside the
// total), each over the flow that moves it, on the AVERAGE balance where
// the book carries the opening — plus the same split on the period-end
// basis, which the cash-conversion cycle adds to the period-end DSO / DPO.
//
// Scandia Food FY2025 printed 48.8 / 52.5 / 95.3 days for one stock before
// this block existed: three denominators under one name. Every surface now
// prints the block's figure or its refusal (owner spec 2026-09-26, P1).
// A payload without the block REFUSES — no browser division of an
// inventory figure, ever.

import i18n from "@/i18n";

import type { Fig } from "./absentAware";
import { formatRatioSide } from "./ratioTable";

export interface InventoryDaysReason {
  readonly code: string;
  readonly text: { readonly ro: string; readonly en: string };
}

export interface InventoryDaysView {
  readonly basis: string | null;
  readonly basisLabel: { readonly ro: string; readonly en: string } | null;
  /** The basis of the period-end term the cycle adds (`ccc_dio_term`):
   *  "stoc la 31 decembrie — o singură zi" — never the served basis. */
  readonly closingBasisLabel: { readonly ro: string; readonly en: string } | null;
  readonly total: number | null;
  readonly totalClosing: number | null;
  readonly inventoryTurnover: number | null;
  readonly reason: InventoryDaysReason | null;
  readonly seasonal: boolean;
  readonly maySlowClaim: boolean;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const ABSENT_REASON: InventoryDaysReason = {
  code: "inventory_days_absent",
  text: {
    ro: "zilele de stoc nu sunt servite pentru această perioadă",
    en: "inventory days are not served for this period",
  },
};

function reasonOf(raw: unknown): InventoryDaysReason | null {
  if (!isObj(raw) || typeof raw.code !== "string") return null;
  const ro = typeof raw.text_ro === "string" ? raw.text_ro : raw.code;
  const en = typeof raw.text_en === "string" ? raw.text_en : raw.code;
  return { code: raw.code, text: { ro, en } };
}

/** The served block's figures, or null when the source serves none. */
export function readInventoryDays(statements: { inventory_days?: unknown } | null | undefined): InventoryDaysView | null {
  const block = statements?.inventory_days;
  if (!isObj(block) || typeof block.schema !== "string" || !block.schema.startsWith("inventory_days/")) {
    return null;
  }
  const total = isObj(block.total) ? block.total : {};
  const turnover = isObj(block.inventory_turnover) ? block.inventory_turnover : {};
  const label = isObj(block.basis_label) ? block.basis_label : null;
  const season = isObj(block.seasonality) ? block.seasonality : {};
  const policy = isObj(block.claim_policy) ? block.claim_policy : {};
  const term = isObj(block.ccc_dio_term) ? block.ccc_dio_term : {};
  const closingLabel = isObj(term.basis_label) ? term.basis_label : null;
  return {
    basis: typeof block.basis === "string" ? block.basis : null,
    basisLabel: label && typeof label.ro === "string" && typeof label.en === "string"
      ? { ro: label.ro, en: label.en } : null,
    closingBasisLabel: closingLabel && typeof closingLabel.ro === "string" && typeof closingLabel.en === "string"
      ? { ro: closingLabel.ro, en: closingLabel.en } : null,
    total: numOrNull(total.value),
    totalClosing: numOrNull(total.closing_value),
    inventoryTurnover: numOrNull(turnover.value),
    reason: reasonOf(total.reason),
    seasonal: season.flagged === true,
    maySlowClaim: policy.may_call_slow === true,
  };
}

/** The block's figure, or its refusal — an ENGINE refusal about inventory
 *  days (`subject`), never worded as the one-EBITDA refusal. */
function blockFig(value: number | null, reason: InventoryDaysReason): Fig {
  if (typeof value === "number" && Number.isFinite(value)) return { value, absence: null };
  return {
    value: null,
    absence: { kind: "refused", code: reason.code, display: reason.text, subject: "inventory_days" },
  };
}

/** The split total as a figure: `value` on the block's served basis (the
 *  average where the book carries the opening), `closing_value` on the
 *  period-end basis. A refused or absent block is a refusal with the
 *  engine's reason — never a number this reader computed. */
export function inventoryDaysFig(
  statements: { inventory_days?: unknown } | null | undefined,
  field: "value" | "closing_value",
): Fig {
  const view = readInventoryDays(statements);
  if (!view) return blockFig(null, ABSENT_REASON);
  const value = field === "value" ? view.total : view.totalClosing;
  return blockFig(value, view.reason ?? ABSENT_REASON);
}

/** The formula line of the PERIOD-END term (the one the cash-conversion
 *  cycle adds), from the DIO card's own line: the same arithmetic, with the
 *  card's served-basis words ("average of the balances at 1 January and
 *  31 December") replaced by the period-end term's own basis
 *  (`ccc_dio_term.basis_label`, "stock at 31 December — a single day"). A
 *  31 December figure is never printed under the average's words. Null
 *  when the card's line does not end with the served basis or the block
 *  serves no period-end basis — the caller then prints no formula of its
 *  own rather than a guessed one. */
export function periodEndInventoryFormula(
  servedFormula: string,
  statements: { inventory_days?: unknown } | null | undefined,
): string | null {
  const view = readInventoryDays(statements);
  if (!view?.basisLabel || !view.closingBasisLabel) return null;
  const served = ` — ${view.basisLabel.en}`;
  if (!servedFormula.endsWith(served)) return null;
  return `${servedFormula.slice(0, -served.length)} — ${view.closingBasisLabel.en}`;
}

/** Inventory turnover (period days ÷ the split total), or its refusal. */
export function inventoryTurnoverFig(statements: { inventory_days?: unknown } | null | undefined): Fig {
  const view = readInventoryDays(statements);
  if (!view) return blockFig(null, ABSENT_REASON);
  return blockFig(view.inventoryTurnover, view.reason ?? ABSENT_REASON);
}

// ─── THE SPLIT, AS EVERY SURFACE PRINTS IT ──────────────────────────────
//
// The owner's point 1 (P1, 2026-09-26): "Show all four, each with its
// accounts." The Ratios tile, the drawer, the CFO report (screen, PDF,
// workbook) and the forecast cockpit's bank export print the block through
// `printInventoryDays` — ONE printed form, so the two documents a bank
// reads carry the same lines byte for byte. Every figure is the block's
// quantized `value_q`; every label, basis and reason is the engine's own
// bilingual text. Nothing here divides, sums or rounds.

export interface Bilingual {
  readonly ro: string;
  readonly en: string;
}

export interface InventoryDaysLegView {
  readonly key: string;
  readonly label: Bilingual;
  /** The leg's definition (the pack's stock accounts, e.g. 301 302 303 308). */
  readonly accounts: readonly string[];
  /** The 39x allowances the book carries against this leg. */
  readonly provisions: readonly string[];
  readonly flowLabel: Bilingual;
  readonly valueQ: string | null;
  readonly closingQ: string | null;
  readonly reason: InventoryDaysReason | null;
}

export interface InventoryDaysSplitView {
  readonly basis: string | null;
  readonly basisLabel: Bilingual | null;
  /** True on `average_monthly` / `average_two_year_ends`. */
  readonly isAverage: boolean;
  readonly totalLabel: Bilingual;
  readonly totalFlowLabel: Bilingual | null;
  readonly totalQ: string | null;
  readonly totalClosingQ: string | null;
  readonly totalReason: InventoryDaysReason | null;
  readonly legs: readonly InventoryDaysLegView[];
  /** "Alte stocuri": every other class-3 account the book carries, inside
   *  the total, with no days of its own. Null when the book has none. */
  readonly other: { readonly label: Bilingual; readonly accounts: readonly string[] } | null;
  readonly seasonalNote: Bilingual | null;
  readonly openingReason: Bilingual | null;
  readonly maySlowClaim: boolean;
  readonly claimText: Bilingual | null;
}

const AVERAGE_BASES: ReadonlySet<string> = new Set(["average_monthly", "average_two_year_ends"]);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const codes = (v: unknown): string[] => (Array.isArray(v) ? v.filter((c): c is string => typeof c === "string") : []);

function bilingual(ro: unknown, en: unknown): Bilingual | null {
  const r = strOrNull(ro);
  const e = strOrNull(en);
  return r && e ? { ro: r, en: e } : null;
}

function bilingualOf(raw: unknown): Bilingual | null {
  return isObj(raw) ? bilingual(raw.ro, raw.en) : null;
}

/** An analytic account as its synthetic code ("381.001" → "381",
 *  "321001" → "321") — how "alte stocuri" names what it holds. */
function synthetic(account: string): string {
  const digits = account.replace(/\D/g, "");
  return digits.slice(0, 3);
}

function uniqueSorted(list: readonly string[]): string[] {
  return Array.from(new Set(list.filter(Boolean))).sort();
}

/** The served block as the split every surface prints, or null when the
 *  source serves none (every reader then refuses — never computes). */
export function readInventoryDaysSplit(
  statements: { inventory_days?: unknown } | null | undefined,
): InventoryDaysSplitView | null {
  const block = statements?.inventory_days;
  if (!isObj(block) || typeof block.schema !== "string" || !block.schema.startsWith("inventory_days/")) {
    return null;
  }
  const total = isObj(block.total) ? block.total : {};
  const season = isObj(block.seasonality) ? block.seasonality : {};
  const opening = isObj(block.opening) ? block.opening : {};
  const policy = isObj(block.claim_policy) ? block.claim_policy : {};
  const flow = isObj(total.flow) ? total.flow : {};
  const legs: InventoryDaysLegView[] = (Array.isArray(block.groups) ? block.groups : [])
    .filter(isObj)
    .map((g) => {
      const f = isObj(g.flow) ? g.flow : {};
      return {
        key: typeof g.key === "string" ? g.key : "",
        label: bilingual(g.label_ro, g.label_en) ?? { ro: String(g.key ?? ""), en: String(g.key ?? "") },
        accounts: codes(g.stock_accounts),
        provisions: uniqueSorted(codes(g.provision_accounts_present).map(synthetic)),
        flowLabel: bilingual(f.label_ro, f.label_en) ?? { ro: "", en: "" },
        valueQ: strOrNull(g.value_q),
        closingQ: strOrNull(g.closing_value_q),
        reason: reasonOf(g.reason),
      };
    });
  const o = isObj(block.other) ? block.other : null;
  const otherAccounts = o
    ? uniqueSorted([...codes(o.accounts), ...codes(o.provision_accounts_present)].map(synthetic))
    : [];
  const otherLabel = o ? bilingual(o.label_ro, o.label_en) : null;
  const basis = typeof block.basis === "string" ? block.basis : null;
  const flagged = season.flagged === true;
  return {
    basis,
    basisLabel: bilingualOf(block.basis_label),
    isAverage: basis !== null && AVERAGE_BASES.has(basis),
    totalLabel: bilingual(total.label_ro, total.label_en) ?? { ro: "Zile de stoc", en: "Inventory days" },
    totalFlowLabel: bilingual(flow.label_ro, flow.label_en),
    totalQ: strOrNull(total.value_q),
    totalClosingQ: strOrNull(total.closing_value_q),
    totalReason: reasonOf(total.reason),
    legs,
    other: otherLabel && otherAccounts.length > 0 ? { label: otherLabel, accounts: otherAccounts } : null,
    seasonalNote: flagged ? bilingual(season.note_ro, season.note_en) : null,
    openingReason: (() => {
      const r = reasonOf(opening.reason);
      return r ? r.text : null;
    })(),
    maySlowClaim: policy.may_call_slow === true,
    claimText: bilingualOf(policy.reason_text),
  };
}

/** One row of the printed split. `days` is the figure in the reader's
 *  language ("37,3 zile") or the engine's refusal. */
export interface InventoryDaysPrintedRow {
  readonly key: string;
  readonly label: string;
  readonly accounts: string;
  readonly days: string;
  readonly flow: string;
  readonly refused: boolean;
}

export interface InventoryDaysPrinted {
  readonly lang: "ro" | "en";
  readonly title: string;
  /** "Bază: media soldurilor la 1 ianuarie și 31 decembrie". */
  readonly basis: string;
  readonly total: InventoryDaysPrintedRow;
  readonly legs: readonly InventoryDaysPrintedRow[];
  readonly other: InventoryDaysPrintedRow | null;
  /** The same split on the period-end balance (the cycle's term), printed
   *  only where the served basis is an average and the figure differs. */
  readonly closing: string | null;
  /** Seasonality, and why a single balance was used — each once. */
  readonly notes: readonly string[];
  readonly headings: { readonly type: string; readonly accounts: string; readonly days: string; readonly flow: string };
}

function langOf(lang: string | null | undefined): "ro" | "en" {
  return (lang ?? "").toLowerCase().startsWith("ro") ? "ro" : "en";
}

/** Days at the block's own quantization, in the reader's language — the
 *  ratio table's formatter, so a tile and its split print one way. */
export function printDaysQ(q: string, lang: string | null | undefined): string {
  return formatRatioSide(
    { value: null, value_q: q, band: null, band_status: "graded", ladder: null, ladder_floor: null, operands: [], reason: null },
    "days",
    langOf(lang),
  );
}

/** THE ROUNDING NOTE (coordinator's ruling 2026-09-28, one CCC figure per
 *  report): where day figures printed as an identity (DSO + DIO − DPO =
 *  CCC; the trade float's DSO − DPO = gap) each print their OWN served
 *  figure on the ratio table's precision, the printed terms can miss the
 *  printed total by a day. The page then says so in this one line — never
 *  a second total, never a caption claiming they add up. The engine's
 *  trade-float claim carries the same EN words (packs/insights/
 *  detectors.yaml `claim_variants.rounded`, held to this key by
 *  tests/engine/test_one_metric_one_formula.py). */
export function roundedDaysNote(lang: string | null | undefined): string {
  return i18n.getFixedT(langOf(lang))("roundedDays.note");
}

/** Do the printed day figures foot to the printed total? Read back from the
 *  strings exactly as printed, never from the unrounded values: the note
 *  is about what the reader adds up. A term that is not a printed day
 *  figure cannot be shown to foot — false. */
export function printedDaysFoot(terms: readonly string[], total: string): boolean {
  const sum = sumOfPrintedDays(terms);
  return sum !== null && sum === total;
}

/** The sum of printed day figures ("39 days", "1 day", "-30 days"), read
 *  back from the strings exactly as printed and printed on the same rule
 *  (the ratio table's days formatter, EN), or null when any string is not
 *  a printed EN day figure. Decimal-exact: the terms are summed as integers
 *  at their widest printed precision. Used ONLY to decide whether the
 *  rounding note is due — never printed as a total. */
export function sumOfPrintedDays(printed: readonly string[]): string | null {
  const parts: { int: bigint; places: number }[] = [];
  for (const p of printed) {
    const m = /^([+-]?)(\d+)(?:\.(\d+))? days?$/.exec(p);
    if (!m) return null;
    const places = m[3]?.length ?? 0;
    parts.push({ int: BigInt(`${m[1] === "-" ? "-" : ""}${m[2]}${m[3] ?? ""}`), places });
  }
  const places = Math.max(0, ...parts.map((x) => x.places));
  let total = 0n;
  for (const x of parts) total += x.int * 10n ** BigInt(places - x.places);
  const neg = total < 0n;
  const abs = (neg ? -total : total).toString().padStart(places + 1, "0");
  const q = places === 0 ? abs : `${abs.slice(0, abs.length - places)}.${abs.slice(abs.length - places)}`;
  return printDaysQ(`${neg ? "-" : ""}${q}`, "en");
}

/** The split as printed text in one language. Pure over the served block. */
export function printInventoryDays(split: InventoryDaysSplitView, lang: string | null | undefined): InventoryDaysPrinted {
  const l = langOf(lang);
  const t = i18n.getFixedT(l);
  const pick = (b: Bilingual | null): string => (b ? b[l] : "");
  const days = (q: string | null, reason: InventoryDaysReason | null): { days: string; refused: boolean } =>
    q !== null
      ? { days: printDaysQ(q, l), refused: false }
      : { days: t("inventoryDays.refused", { reason: (reason ?? ABSENT_REASON).text[l] }), refused: true };
  const accountsOf = (accounts: readonly string[], provisions: readonly string[]): string =>
    [
      accounts.length > 0 ? t("inventoryDays.accounts", { codes: accounts.join(", ") }) : "",
      provisions.length > 0 ? t("inventoryDays.netOf", { codes: provisions.join(", ") }) : "",
    ].filter(Boolean).join(" · ");
  const legs = split.legs.map((g) => ({
    key: g.key,
    label: pick(g.label),
    accounts: accountsOf(g.accounts, g.provisions),
    ...days(g.valueQ, g.reason),
    flow: g.flowLabel[l] ? t("inventoryDays.flow", { label: g.flowLabel[l] }) : "",
  }));
  const total = {
    key: "total",
    label: pick(split.totalLabel),
    accounts: "",
    ...days(split.totalQ, split.totalReason),
    flow: split.totalFlowLabel ? t("inventoryDays.flow", { label: split.totalFlowLabel[l] }) : "",
  };
  const other = split.other
    ? {
        key: "other_stock",
        label: pick(split.other.label),
        accounts: t("inventoryDays.accounts", { codes: split.other.accounts.join(", ") }),
        days: t("inventoryDays.otherNote"),
        flow: "",
        refused: false,
      }
    : null;
  const closing =
    split.isAverage && split.totalClosingQ !== null && split.totalClosingQ !== split.totalQ
      ? t("inventoryDays.closing", { v: printDaysQ(split.totalClosingQ, l) })
      : null;
  const notes = [
    split.seasonalNote ? t("inventoryDays.seasonal", { note: split.seasonalNote[l] }) : "",
    !split.isAverage && split.openingReason ? t("inventoryDays.openingReason", { reason: split.openingReason[l] }) : "",
  ].filter(Boolean);
  return {
    lang: l,
    title: t("inventoryDays.title"),
    basis: split.basisLabel ? t("inventoryDays.basis", { label: split.basisLabel[l] }) : "",
    total,
    legs,
    other,
    closing,
    notes,
    headings: {
      type: t("inventoryDays.colType"),
      accounts: t("inventoryDays.colAccounts"),
      days: t("inventoryDays.colDays"),
      flow: t("inventoryDays.colFlow"),
    },
  };
}

function escapeDocHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** THE DOCUMENT BLOCK — the CFO report (screen and PDF) and the cockpit's
 *  bank export both print THIS string, so a bank reading both documents
 *  reads one split. `table.fin` / `.num` are the documents' shared table
 *  classes; each document styles `.inventory-days-note` with
 *  `INVENTORY_DAYS_DOC_CSS`. */
export const INVENTORY_DAYS_DOC_CSS =
  ".inventory-days-split { break-inside: avoid; margin: 10px 0 14px; }" +
  " .inventory-days-split h3 { margin: 12px 0 6px; }" +
  " .inventory-days-split .inventory-days-note { font-size: 8.5pt; margin: 2px 0; opacity: 0.85; }";

export function inventoryDaysDocHtml(printed: InventoryDaysPrinted): string {
  const e = escapeDocHtml;
  const row = (r: InventoryDaysPrintedRow, cls = ""): string =>
    `<tr${cls ? ` class="${cls}"` : ""} data-inventory-leg="${e(r.key)}"><td>${e(r.label)}</td><td>${e(r.accounts)}</td>` +
    `<td class="num"${r.refused ? ' data-refused="1"' : ""}>${e(r.days)}</td><td>${e(r.flow)}</td></tr>`;
  const h = printed.headings;
  const body = [...printed.legs.map((r) => row(r)), ...(printed.other ? [row(printed.other)] : []), row(printed.total, "total")].join("");
  const extra = [printed.basis, printed.closing ?? "", ...printed.notes]
    .filter(Boolean)
    .map((line) => `<p class="inventory-days-note" data-inventory-note="1">${e(line)}</p>`)
    .join("");
  return (
    `<div class="inventory-days-split" data-inventory-days="split" lang="${printed.lang}">` +
    `<h3>${e(printed.title)}</h3>` +
    `<table class="fin"><thead><tr><th>${e(h.type)}</th><th>${e(h.accounts)}</th><th class="num">${e(h.days)}</th><th>${e(h.flow)}</th></tr></thead>` +
    `<tbody>${body}</tbody></table>${extra}</div>`
  );
}

/** The split as plain rows for a workbook sheet (type, accounts, days,
 *  divided by), then the basis and note lines as one-cell rows. */
export function inventoryDaysSheetRows(printed: InventoryDaysPrinted): string[][] {
  const h = printed.headings;
  const rows = [...printed.legs, ...(printed.other ? [printed.other] : []), printed.total];
  return [
    [printed.title],
    [h.type, h.accounts, h.days, h.flow],
    ...rows.map((r) => [r.label, r.accounts, r.days, r.flow]),
    ...[printed.basis, printed.closing ?? "", ...printed.notes].filter(Boolean).map((line) => [line]),
  ];
}
