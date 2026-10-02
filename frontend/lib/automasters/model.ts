// AutoMasters — the CFO side of the AutoMasters dealership app.
//
// Pure model: types for the rows the AutoMasters desktop app (or a JSON
// import) puts in the am_* tables, and every rule the six screens apply to
// them. No I/O here — `data.ts` reads and writes Supabase, the screens render.
//
// The rules mirror the database where both exist (supabase/
// schema_phase_custom_solutions.sql): a profit centre's DMS ↔ ledger
// difference above 0.5% is MATERIAL and blocks the month close, and a close
// needs every checklist item done. The screen states the reason; the
// database refuses regardless.

// ── Rows ────────────────────────────────────────────────────────────────

export interface BankLine {
  id: string;
  external_ref: string;
  booked_on: string;
  payer: string;
  reference: string | null;
  amount: number;
  currency: string;
  suggested_document: string | null;
}

export type DocKind = "final" | "advance" | "service" | "deposit" | "other";

export interface OpenDocument {
  id: string;
  doc_number: string;
  customer: string;
  kind: DocKind;
  amount: number;
  currency: string;
  issued_on: string | null;
}

export interface PaymentMatch {
  id: string;
  bank_line_id: string;
  document_id: string;
  difference: number;
  method: "manual" | "auto";
  matched_at: string;
}

export type ExportChannel = "saga" | "efactura";
export type ExportStatus = "pending" | "sent" | "accepted" | "error" | "rejected" | "reconciled";

export interface ExportEvent {
  at: string;
  text: string;
}

export interface ExportItem {
  id: string;
  channel: ExportChannel;
  ref: string;
  description: string | null;
  counterparty: string | null;
  doc_count: number;
  amount: number;
  currency: string;
  status: ExportStatus;
  error_message: string | null;
  events: ExportEvent[];
  retry_requested_at: string | null;
  updated_at: string;
}

export interface Contributor {
  name: string;
  value: number;
}

export interface CentreFigure {
  period: string;
  centre: string;
  revenue: number;
  margin: number;
  budget_margin: number | null;
  dms_amount: number | null;
  ledger_amount: number | null;
  note: string | null;
  contributors: Contributor[];
}

export interface FunnelRow {
  period: string;
  stage: string;
  position: number;
  count: number;
}

export interface ClosePeriod {
  period: string;
  status: "open" | "closed";
  closed_at: string | null;
}

export interface CloseCheck {
  period: string;
  check_key: string;
  position: number;
  done: boolean;
  done_at: string | null;
}

export interface AmData {
  bank: BankLine[];
  documents: OpenDocument[];
  matches: PaymentMatch[];
  exports: ExportItem[];
  centres: CentreFigure[];
  funnel: FunnelRow[];
  periods: ClosePeriod[];
  checks: CloseCheck[];
}

export const EMPTY_DATA: AmData = {
  bank: [], documents: [], matches: [], exports: [], centres: [], funnel: [], periods: [], checks: [],
};

export const STATUS_ORDER: ExportStatus[] = ["error", "rejected", "pending", "sent", "accepted", "reconciled"];

export function isFailed(s: ExportStatus): boolean {
  return s === "error" || s === "rejected";
}

// ── Numbers ─────────────────────────────────────────────────────────────

export const round2 = (n: number): number => Math.round(n * 100) / 100;

/** "412.850,00 EUR" (ro-RO) / "412,850.00 EUR" (en-GB). Amounts in transactional
 *  screens are never rounded to thousands; cents always shown. */
export function formatMoney(n: number, currency = "EUR", locale = "ro-RO"): string {
  const s = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(n));
  return `${n < 0 ? "−" : ""}${s} ${currency}`;
}

export function formatPct(n: number | null, locale = "ro-RO", signed = false): string {
  if (n === null || !Number.isFinite(n)) return "—";
  const s = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(Math.abs(n));
  const sign = n < 0 ? "−" : signed && n > 0 ? "+" : "";
  return `${sign}${s}%`;
}

// ── Periods ─────────────────────────────────────────────────────────────

export const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function periodOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** Every period the data mentions, newest first. */
export function knownPeriods(data: AmData): string[] {
  const set = new Set<string>();
  data.centres.forEach((c) => set.add(c.period));
  data.funnel.forEach((f) => set.add(f.period));
  data.periods.forEach((p) => set.add(p.period));
  return [...set].filter((p) => PERIOD_RE.test(p)).sort().reverse();
}

// ── Reconciliation (month close) ────────────────────────────────────────

export type ReconState = "balanced" | "minor" | "material" | "missing";

/** The 0.5% line between a minor drift and a material imbalance — the
 *  same threshold `am_close_period()` applies. */
export const MATERIAL_SHARE = 0.005;

export function classifyRecon(dms: number | null, ledger: number | null): ReconState {
  if (dms === null || ledger === null) return "missing";
  const d = round2(dms - ledger);
  if (d === 0) return "balanced";
  if (dms === 0) return "material";
  return Math.abs(d) / Math.abs(dms) > MATERIAL_SHARE ? "material" : "minor";
}

export interface ReconRow {
  centre: string;
  dms: number | null;
  ledger: number | null;
  difference: number | null;
  sharePct: number | null;
  state: ReconState;
}

export function reconRows(centres: CentreFigure[], period: string): ReconRow[] {
  return centres
    .filter((c) => c.period === period)
    .map((c) => {
      const has = c.dms_amount !== null && c.ledger_amount !== null;
      const diff = has ? round2((c.dms_amount as number) - (c.ledger_amount as number)) : null;
      return {
        centre: c.centre,
        dms: c.dms_amount,
        ledger: c.ledger_amount,
        difference: diff,
        sharePct: has && c.dms_amount ? (Math.abs(diff as number) / Math.abs(c.dms_amount)) * 100 : null,
        state: classifyRecon(c.dms_amount, c.ledger_amount),
      };
    })
    .sort((a, b) => a.centre.localeCompare(b.centre));
}

export const CLOSE_CHECK_KEYS = [
  "invoices_vs_deliveries",
  "advances_allocated",
  "service_wip",
  "parts_inventory",
  "saga_export_clean",
  "warranty_claims",
  "fx_rate",
  "close_reports",
] as const;

export type CloseStatus = "not_started" | "open" | "review" | "closed";

export interface CloseState {
  status: CloseStatus;
  checks: CloseCheck[];
  doneCount: number;
  openCount: number;
  material: string[];
  canClose: boolean;
  /** Why the close is blocked: open checks first, then material centres. */
  block: { kind: "open_checks"; count: number } | { kind: "material"; centres: string[] } | null;
}

export function closeState(data: AmData, period: string): CloseState {
  const row = data.periods.find((p) => p.period === period);
  const checks = data.checks
    .filter((c) => c.period === period)
    .sort((a, b) => a.position - b.position);
  const material = reconRows(data.centres, period)
    .filter((r) => r.state === "material")
    .map((r) => r.centre);
  const doneCount = checks.filter((c) => c.done).length;
  const openCount = checks.length - doneCount;
  if (!row) {
    return { status: "not_started", checks, doneCount, openCount, material, canClose: false, block: null };
  }
  if (row.status === "closed") {
    return { status: "closed", checks, doneCount, openCount, material, canClose: false, block: null };
  }
  const block = openCount > 0
    ? { kind: "open_checks" as const, count: openCount }
    : material.length
      ? { kind: "material" as const, centres: material }
      : null;
  return {
    status: material.length ? "review" : "open",
    checks,
    doneCount,
    openCount,
    material,
    canClose: block === null,
    block,
  };
}

/** Facts the data already knows about a checklist item — shown beside it so
 *  the person ticking it sees what still disagrees. `null` = nothing to say. */
export function closeHint(data: AmData, key: string, period: string):
  { tone: "ok" | "warn"; count: number } | null {
  if (key === "saga_export_clean") {
    const failed = data.exports.filter((e) => e.channel === "saga" && isFailed(e.status)).length;
    return { tone: failed ? "warn" : "ok", count: failed };
  }
  if (key === "advances_allocated") {
    const matched = new Set(data.matches.map((m) => m.document_id));
    const open = data.documents.filter((d) => d.kind === "advance" && !matched.has(d.id)).length;
    return { tone: open ? "warn" : "ok", count: open };
  }
  if (key === "warranty_claims") {
    const w = reconRows(data.centres, period).find((r) => /warrant|garan/i.test(r.centre));
    if (!w || w.state === "missing") return null;
    return { tone: w.state === "material" ? "warn" : "ok", count: w.state === "material" ? 1 : 0 };
  }
  return null;
}

// ── Profit centres ──────────────────────────────────────────────────────

export interface CentreTotal {
  centre: string;
  revenue: number;
  margin: number;
  marginPct: number | null;
  budgetMargin: number | null;
  /** Margin vs budget, % of budget. null when any month lacks a budget. */
  vsBudgetPct: number | null;
  shareOfMargin: number;
  note: string | null;
  contributors: Contributor[];
  months: number;
}

/** Year-to-date totals per centre, for `year` up to and including
 *  `throughPeriod` (default: the latest month with figures). */
export function centreTotals(centres: CentreFigure[], year: number, throughPeriod?: string): CentreTotal[] {
  const rows = centres.filter((c) =>
    c.period.startsWith(`${year}-`) && (!throughPeriod || c.period <= throughPeriod));
  const by = new Map<string, CentreFigure[]>();
  rows.forEach((r) => by.set(r.centre, [...(by.get(r.centre) ?? []), r]));
  const totalMargin = rows.reduce((a, r) => a + r.margin, 0);
  return [...by.entries()].map(([centre, list]) => {
    list.sort((a, b) => a.period.localeCompare(b.period));
    const revenue = round2(list.reduce((a, r) => a + r.revenue, 0));
    const margin = round2(list.reduce((a, r) => a + r.margin, 0));
    const budgets = list.map((r) => r.budget_margin);
    const budgetMargin = budgets.every((b) => b !== null)
      ? round2(budgets.reduce((a: number, b) => a + (b as number), 0))
      : null;
    const contrib = new Map<string, number>();
    list.forEach((r) => r.contributors.forEach((c) =>
      contrib.set(c.name, (contrib.get(c.name) ?? 0) + c.value)));
    const latestNote = [...list].reverse().find((r) => r.note)?.note ?? null;
    return {
      centre,
      revenue,
      margin,
      marginPct: revenue ? (margin / revenue) * 100 : null,
      budgetMargin,
      vsBudgetPct: budgetMargin ? ((margin - budgetMargin) / Math.abs(budgetMargin)) * 100 : null,
      shareOfMargin: totalMargin ? (margin / totalMargin) * 100 : 0,
      note: latestNote,
      contributors: [...contrib.entries()]
        .map(([name, value]) => ({ name, value: round2(value) }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 3),
      months: list.length,
    };
  });
}

export type CentreSort = "revenue" | "margin" | "marginPct" | "vsBudget";

export function sortCentres(rows: CentreTotal[], key: CentreSort): CentreTotal[] {
  const v = (r: CentreTotal): number => {
    if (key === "revenue") return r.revenue;
    if (key === "margin") return r.margin;
    if (key === "marginPct") return r.marginPct ?? -Infinity;
    return r.vsBudgetPct ?? -Infinity;
  };
  return [...rows].sort((a, b) => v(b) - v(a) || a.centre.localeCompare(b.centre));
}

// ── Performance (revenue by segment and month) ──────────────────────────

export type Segment = "new_cars" | "service" | "parts" | "other";
export const SEGMENTS: Segment[] = ["new_cars", "service", "parts", "other"];

export function segmentOf(centre: string): Segment {
  const c = centre.toLowerCase();
  if (/new\s*cars?|auto(turisme)?\s*no[ui]|vehicule\s*no[ui]/.test(c)) return "new_cars";
  if (/service|atelier/.test(c)) return "service";
  if (/parts?|pies/.test(c)) return "parts";
  return "other";
}

export interface MonthBar {
  period: string;
  total: number;
  parts: Record<Segment, number>;
}

/** Revenue per segment per month of `year`, months in order. */
export function monthlyRevenue(centres: CentreFigure[], year: number): MonthBar[] {
  const by = new Map<string, MonthBar>();
  centres
    .filter((c) => c.period.startsWith(`${year}-`))
    .forEach((c) => {
      const bar = by.get(c.period) ?? {
        period: c.period, total: 0, parts: { new_cars: 0, service: 0, parts: 0, other: 0 },
      };
      const seg = segmentOf(c.centre);
      bar.parts[seg] = round2(bar.parts[seg] + c.revenue);
      bar.total = round2(bar.total + c.revenue);
      by.set(c.period, bar);
    });
  return [...by.values()].sort((a, b) => a.period.localeCompare(b.period));
}

export interface FunnelStep {
  stage: string;
  count: number;
  /** Width relative to the first stage, 0–100. */
  width: number;
  /** Conversion from the previous stage, %. null on the first. */
  conversion: number | null;
}

export function funnelFor(rows: FunnelRow[], period: string): FunnelStep[] {
  const list = rows.filter((r) => r.period === period).sort((a, b) => a.position - b.position);
  const first = list[0]?.count ?? 0;
  return list.map((r, i) => ({
    stage: r.stage,
    count: r.count,
    width: first ? Math.round((r.count / first) * 100) : 0,
    conversion: i && list[i - 1].count ? Math.round((r.count / list[i - 1].count) * 100) : null,
  }));
}

// ── Payments reconciliation ─────────────────────────────────────────────

const fold = (s: string): string =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

export interface MatchProposal {
  bank_line_id: string;
  document_id: string;
  difference: number;
}

/** Pairs the matcher can make on its own, never touching an already-matched
 *  payment or document: first the DMS's own suggestion (the document number
 *  it read off the payment), then a single document of the same payer for
 *  the exact amount. Ambiguous cases are left to Finance. */
export function proposeMatches(data: AmData): MatchProposal[] {
  const usedBank = new Set(data.matches.map((m) => m.bank_line_id));
  const usedDoc = new Set(data.matches.map((m) => m.document_id));
  const out: MatchProposal[] = [];
  const take = (b: BankLine, d: OpenDocument) => {
    usedBank.add(b.id);
    usedDoc.add(d.id);
    out.push({ bank_line_id: b.id, document_id: d.id, difference: round2(d.amount - b.amount) });
  };
  for (const b of data.bank) {
    if (usedBank.has(b.id) || !b.suggested_document) continue;
    const d = data.documents.find((x) => !usedDoc.has(x.id) && fold(x.doc_number) === fold(b.suggested_document as string));
    if (d) take(b, d);
  }
  for (const b of data.bank) {
    if (usedBank.has(b.id)) continue;
    const cands = data.documents.filter((d) =>
      !usedDoc.has(d.id) && round2(d.amount) === round2(b.amount) && d.currency === b.currency
      && (fold(d.customer).includes(fold(b.payer)) || fold(b.payer).includes(fold(d.customer))));
    if (cands.length === 1) take(b, cands[0]);
  }
  return out;
}

// ── Import (automasters.cfo.v1) ─────────────────────────────────────────

export const IMPORT_FORMAT = "automasters.cfo.v1";

export interface ImportPayload {
  currency: string;
  bank_lines: Array<Omit<BankLine, "id">>;
  documents: Array<Omit<OpenDocument, "id">>;
  exports: Array<Omit<ExportItem, "id" | "retry_requested_at" | "updated_at">>;
  centres: CentreFigure[];
  funnel: FunnelRow[];
}

export type ImportResult =
  | { ok: true; payload: ImportPayload; counts: Record<string, number> }
  | { ok: false; errors: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS: DocKind[] = ["final", "advance", "service", "deposit", "other"];
const STATUSES: ExportStatus[] = ["pending", "sent", "accepted", "error", "rejected", "reconciled"];

/** Validate an export from the AutoMasters app. Every row is checked; one
 *  bad row refuses the whole file (with every reason), so a half import
 *  never lands. */
export function parseImport(raw: unknown): ImportResult {
  const errors: string[] = [];
  if (!isObj(raw)) return { ok: false, errors: ["The file is not a JSON object."] };
  if (raw.format !== IMPORT_FORMAT) {
    return { ok: false, errors: [`"format" must be "${IMPORT_FORMAT}".`] };
  }
  const currency = str(raw.currency) ?? "EUR";
  const list = (key: string): Record<string, unknown>[] => {
    const v = raw[key];
    if (v === undefined) return [];
    if (!Array.isArray(v)) { errors.push(`"${key}" must be a list.`); return []; }
    return v.map((x, i) => {
      if (!isObj(x)) errors.push(`${key}[${i}] is not an object.`);
      return isObj(x) ? x : {};
    });
  };
  const need = <T>(key: string, i: number, field: string, v: T | null): T => {
    if (v === null) errors.push(`${key}[${i}].${field} is missing or invalid.`);
    return v as T;
  };

  const bank_lines = list("bank_lines").map((r, i) => ({
    external_ref: need("bank_lines", i, "ref", str(r.ref)),
    booked_on: need("bank_lines", i, "booked_on", str(r.booked_on) && DATE_RE.test(str(r.booked_on) as string) ? str(r.booked_on) : null),
    payer: need("bank_lines", i, "payer", str(r.payer)),
    reference: str(r.reference),
    amount: need("bank_lines", i, "amount", num(r.amount)),
    currency: str(r.currency) ?? currency,
    suggested_document: str(r.suggested_document),
  }));

  const documents = list("documents").map((r, i) => {
    const kind = (str(r.kind) ?? "other") as DocKind;
    if (!KINDS.includes(kind)) errors.push(`documents[${i}].kind must be one of ${KINDS.join(", ")}.`);
    const issued = str(r.issued_on);
    if (issued && !DATE_RE.test(issued)) errors.push(`documents[${i}].issued_on must be YYYY-MM-DD.`);
    return {
      doc_number: need("documents", i, "number", str(r.number)),
      customer: need("documents", i, "customer", str(r.customer)),
      kind,
      amount: need("documents", i, "amount", num(r.amount)),
      currency: str(r.currency) ?? currency,
      issued_on: issued,
    };
  });

  const exports = list("exports").map((r, i) => {
    const channel = str(r.channel) as ExportChannel;
    if (channel !== "saga" && channel !== "efactura") errors.push(`exports[${i}].channel must be "saga" or "efactura".`);
    const status = (str(r.status) ?? "pending") as ExportStatus;
    if (!STATUSES.includes(status)) errors.push(`exports[${i}].status must be one of ${STATUSES.join(", ")}.`);
    const events = Array.isArray(r.events)
      ? r.events.filter(isObj).map((e) => ({ at: str(e.at) ?? "", text: str(e.text) ?? "" })).filter((e) => e.text)
      : [];
    const count = num(r.doc_count);
    return {
      channel,
      ref: need("exports", i, "ref", str(r.ref)),
      description: str(r.description),
      counterparty: str(r.counterparty),
      doc_count: count === null ? 1 : Math.max(0, Math.round(count)),
      amount: num(r.amount) ?? 0,
      currency: str(r.currency) ?? currency,
      status,
      error_message: str(r.error),
      events,
    };
  });

  const period = (key: string, i: number, v: unknown): string =>
    need(key, i, "period", str(v) && PERIOD_RE.test(str(v) as string) ? str(v) : null);

  const centres = list("centres").map((r, i) => ({
    period: period("centres", i, r.period),
    centre: need("centres", i, "centre", str(r.centre)),
    revenue: num(r.revenue) ?? 0,
    margin: num(r.margin) ?? 0,
    budget_margin: num(r.budget_margin),
    dms_amount: num(r.dms_amount),
    ledger_amount: num(r.ledger_amount),
    note: str(r.note),
    contributors: Array.isArray(r.contributors)
      ? r.contributors.filter(isObj)
        .map((c) => ({ name: str(c.name) ?? "", value: num(c.value) ?? 0 }))
        .filter((c) => c.name)
      : [],
  }));

  const funnel = list("funnel").map((r, i) => ({
    period: period("funnel", i, r.period),
    stage: need("funnel", i, "stage", str(r.stage)),
    position: num(r.position) ?? i,
    count: Math.max(0, Math.round(need("funnel", i, "count", num(r.count)) ?? 0)),
  }));

  const dup = <T>(key: string, rows: T[], id: (r: T) => string) => {
    const seen = new Set<string>();
    rows.forEach((r) => {
      const k = id(r);
      if (seen.has(k)) errors.push(`${key} has a duplicate entry: ${k}.`);
      seen.add(k);
    });
  };
  dup("bank_lines", bank_lines, (r) => String(r.external_ref));
  dup("documents", documents, (r) => String(r.doc_number));
  dup("exports", exports, (r) => `${r.channel}:${r.ref}`);
  dup("centres", centres, (r) => `${r.period}:${r.centre}`);
  dup("funnel", funnel, (r) => `${r.period}:${r.stage}`);

  if (errors.length) return { ok: false, errors };
  const payload: ImportPayload = { currency, bank_lines, documents, exports, centres, funnel };
  const counts = {
    bank_lines: bank_lines.length,
    documents: documents.length,
    exports: exports.length,
    centres: centres.length,
    funnel: funnel.length,
  };
  if (!Object.values(counts).some(Boolean)) return { ok: false, errors: ["The file holds no rows."] };
  return { ok: true, payload, counts };
}

// ── Snapshot for Ask CFO AI ─────────────────────────────────────────────

/** A plain-text snapshot of the dealership's figures, handed to the chat as
 *  its workspace data. Figures only — the model explains, it does not
 *  compute, so everything it may cite is stated here. */
export function aiSnapshot(data: AmData, opts: { company?: string; today?: Date } = {}): string {
  const lines: string[] = [];
  const periods = knownPeriods(data);
  const latest = periods[0];
  lines.push(`AutoMasters dealership${opts.company ? ` — ${opts.company}` : ""}. Amounts in EUR, VAT excluded.`);
  if (opts.today) lines.push(`Snapshot date: ${opts.today.toISOString().slice(0, 10)}.`);
  if (latest) {
    const year = Number(latest.slice(0, 4));
    const totals = sortCentres(centreTotals(data.centres, year, latest), "margin");
    if (totals.length) {
      lines.push("", `Profit centres, year to date ${year} (through ${latest}):`);
      totals.forEach((t) => lines.push(
        `- ${t.centre}: revenue ${t.revenue.toFixed(2)}, margin ${t.margin.toFixed(2)}`
        + (t.marginPct === null ? "" : ` (${t.marginPct.toFixed(1)}%)`)
        + (t.vsBudgetPct === null ? "" : `, vs budget ${t.vsBudgetPct >= 0 ? "+" : ""}${t.vsBudgetPct.toFixed(1)}%`)
        + (t.note ? `. Note: ${t.note}` : "")));
    }
    const months = monthlyRevenue(data.centres, year);
    if (months.length) {
      lines.push("", `Monthly revenue ${year}:`);
      months.forEach((m) => lines.push(`- ${m.period}: ${m.total.toFixed(2)} (new cars ${m.parts.new_cars.toFixed(2)}, service ${m.parts.service.toFixed(2)}, parts ${m.parts.parts.toFixed(2)}, other ${m.parts.other.toFixed(2)})`));
    }
    const f = funnelFor(data.funnel, latest);
    if (f.length) {
      lines.push("", `Sales funnel ${latest}: ` + f.map((s) => `${s.stage} ${s.count}`).join(" → "));
    }
    const close = closeState(data, latest);
    const recon = reconRows(data.centres, latest).filter((r) => r.state !== "missing");
    lines.push("", `Month close ${latest}: ${close.status}` + (close.checks.length ? `, ${close.doneCount}/${close.checks.length} checks done` : ""));
    recon.forEach((r) => lines.push(`- ${r.centre}: DMS ${(r.dms as number).toFixed(2)} vs ledger ${(r.ledger as number).toFixed(2)}, difference ${(r.difference as number).toFixed(2)} (${r.state})`));
  }
  const matchedBank = new Set(data.matches.map((m) => m.bank_line_id));
  const unmatched = data.bank.filter((b) => !matchedBank.has(b.id));
  lines.push("", `Payments: ${data.bank.length} bank lines, ${unmatched.length} not matched`
    + (unmatched.length ? ` (${round2(unmatched.reduce((a, b) => a + b.amount, 0)).toFixed(2)})` : "") + ".");
  const matchedDoc = new Set(data.matches.map((m) => m.document_id));
  const openAdv = data.documents.filter((d) => d.kind === "advance" && !matchedDoc.has(d.id));
  if (openAdv.length) lines.push(`Advance invoices not yet settled: ${openAdv.map((d) => `${d.doc_number} (${d.customer}, ${d.amount.toFixed(2)})`).join("; ")}.`);
  const failed = data.exports.filter((e) => isFailed(e.status));
  lines.push(`Exports: ${data.exports.filter((e) => e.channel === "saga").length} SAGA batches, ${data.exports.filter((e) => e.channel === "efactura").length} e-Factura documents, ${failed.length} failed.`);
  failed.forEach((e) => lines.push(`- ${e.channel === "saga" ? "SAGA" : "e-Factura"} ${e.ref} ${e.status}: ${e.error_message ?? "no reason given"}`));
  return lines.join("\n");
}

/** Short headline alerts for the Ask CFO AI side panel. */
export interface AmAlert {
  tone: "danger" | "warn";
  key: "recon_material" | "recon_minor" | "exports_failed" | "advances_open" | "payments_open";
  centre?: string;
  count?: number;
}

export function alertsFor(data: AmData): AmAlert[] {
  const out: AmAlert[] = [];
  const latest = knownPeriods(data)[0];
  if (latest) {
    reconRows(data.centres, latest).forEach((r) => {
      if (r.state === "material") out.push({ tone: "danger", key: "recon_material", centre: r.centre });
      else if (r.state === "minor") out.push({ tone: "warn", key: "recon_minor", centre: r.centre });
    });
  }
  const failed = data.exports.filter((e) => isFailed(e.status)).length;
  if (failed) out.push({ tone: "danger", key: "exports_failed", count: failed });
  const matchedDoc = new Set(data.matches.map((m) => m.document_id));
  const adv = data.documents.filter((d) => d.kind === "advance" && !matchedDoc.has(d.id)).length;
  if (adv) out.push({ tone: "warn", key: "advances_open", count: adv });
  const matchedBank = new Set(data.matches.map((m) => m.bank_line_id));
  const pay = data.bank.filter((b) => !matchedBank.has(b.id)).length;
  if (pay) out.push({ tone: "warn", key: "payments_open", count: pay });
  return out;
}
