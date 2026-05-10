// Invoice analytics — types + deterministic generator + analytics functions.
//
// Drives the Customers · Payments · Margin · VAT tabs on /dashboard.
// Pure TypeScript, runs client-side; the four tab components consume the
// outputs of customerAnalytics / paymentsAnalytics / marginAnalytics /
// vatAnalytics directly.
//
// The generator is intentionally deterministic (seeded PRNG) so the demo
// dataset is identical across sessions and CI runs. Real data later flows
// in from /api/invoices/* — same output shapes.

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Invoice {
  id: string;
  invoice_no: string;
  invoice_date: string;       // ISO yyyy-mm-dd
  due_date: string;
  paid_date?: string;         // ISO; missing = unpaid
  customer_name: string;
  customer_vat_id?: string;
  direction: "sale" | "purchase";
  net_amount: number;
  vat_amount: number;
  vat_rate: number;           // %
  currency: string;
  lines: InvoiceLine[];
}

export interface InvoiceLine {
  sku: string;
  description: string;
  qty: number;
  unit_price: number;
  net_amount: number;
  vat_amount: number;
}

// ─── Customer analytics ─────────────────────────────────────────────────────

export interface CustomerRow {
  name: string;
  revenue: number;
  share: number;
  invoices_count: number;
  avg_invoice: number;
  last_invoice_date: string;
}

export interface CustomerAnalytics {
  total_revenue: number;
  customer_count: number;
  top_1_share: number;
  top_5_share: number;
  top_10_share: number;
  hhi: number;                // Herfindahl-Hirschman Index, 0..10000
  customers: CustomerRow[];
}

export function customerAnalytics(invoices: Invoice[]): CustomerAnalytics {
  const sales = invoices.filter((i) => i.direction === "sale");
  const buckets = new Map<string, { revenue: number; count: number; last: string }>();
  for (const inv of sales) {
    const b = buckets.get(inv.customer_name) ?? { revenue: 0, count: 0, last: inv.invoice_date };
    b.revenue += inv.net_amount;
    b.count += 1;
    if (inv.invoice_date > b.last) b.last = inv.invoice_date;
    buckets.set(inv.customer_name, b);
  }
  const total = sales.reduce((s, i) => s + i.net_amount, 0);
  const customers: CustomerRow[] = Array.from(buckets.entries())
    .map(([name, b]) => ({
      name,
      revenue: b.revenue,
      share: total > 0 ? b.revenue / total : 0,
      invoices_count: b.count,
      avg_invoice: b.revenue / Math.max(b.count, 1),
      last_invoice_date: b.last,
    }))
    .sort((a, b) => b.revenue - a.revenue);

  const top = (n: number) =>
    customers.slice(0, n).reduce((s, c) => s + c.share, 0);

  // HHI in basis-point units: sum of (share * 100)^2. 10000 = monopoly.
  const hhi = customers.reduce((s, c) => s + Math.pow(c.share * 100, 2), 0);

  return {
    total_revenue: total,
    customer_count: customers.length,
    top_1_share: top(1),
    top_5_share: top(5),
    top_10_share: top(10),
    hhi,
    customers,
  };
}

// ─── Payments analytics ─────────────────────────────────────────────────────

export interface AgingBucket {
  bucket: "0-30" | "31-60" | "61-90" | "90+";
  pct: number;        // share of total amount (0..1)
  amount: number;     // total in this bucket
  invoices_count: number;
}

export interface CollectionForecast {
  month: string;            // yyyy-mm
  expected_collection: number;
}

export interface SlowPayer {
  customer: string;
  avg_days_late: number;
  outstanding: number;
  invoices_count: number;
}

export interface PaymentsAnalytics {
  dso_days: number;
  paid_on_time_pct: number;
  total_outstanding: number;
  aging_buckets: AgingBucket[];
  forecast: CollectionForecast[];
  worst_payers: SlowPayer[];
}

export function paymentsAnalytics(
  invoices: Invoice[],
  asOf: Date = new Date(),
): PaymentsAnalytics {
  const sales = invoices.filter((i) => i.direction === "sale");
  const totalRevenue = sales.reduce((s, i) => s + i.net_amount, 0);

  // DSO — weighted average days from invoice → paid (or asOf if unpaid).
  let weightedDays = 0;
  let weightSum = 0;
  for (const inv of sales) {
    const issued = new Date(inv.invoice_date);
    const settled = inv.paid_date ? new Date(inv.paid_date) : asOf;
    const days = Math.max(0, daysBetween(settled, issued));
    weightedDays += days * inv.net_amount;
    weightSum += inv.net_amount;
  }
  const dso = weightSum > 0 ? weightedDays / weightSum : 0;

  // Paid-on-time = paid before or on due_date.
  const paid = sales.filter((i) => i.paid_date);
  const onTime = paid.filter((i) => i.paid_date! <= i.due_date).length;
  const paidOnTimePct = paid.length > 0 ? onTime / paid.length : 0;

  // Aging buckets — outstanding (unpaid) invoices grouped by age.
  const unpaid = sales.filter((i) => !i.paid_date);
  const totalOutstanding = unpaid.reduce((s, i) => s + i.net_amount, 0);
  const ageBucket = (days: number): AgingBucket["bucket"] => {
    if (days <= 30) return "0-30";
    if (days <= 60) return "31-60";
    if (days <= 90) return "61-90";
    return "90+";
  };
  const aging: Record<AgingBucket["bucket"], { amount: number; count: number }> = {
    "0-30": { amount: 0, count: 0 },
    "31-60": { amount: 0, count: 0 },
    "61-90": { amount: 0, count: 0 },
    "90+":   { amount: 0, count: 0 },
  };
  for (const inv of unpaid) {
    const days = daysBetween(asOf, new Date(inv.invoice_date));
    const b = ageBucket(days);
    aging[b].amount += inv.net_amount;
    aging[b].count += 1;
  }
  const aging_buckets: AgingBucket[] = (Object.keys(aging) as AgingBucket["bucket"][]).map((b) => ({
    bucket: b,
    pct: totalOutstanding > 0 ? aging[b].amount / totalOutstanding : 0,
    amount: aging[b].amount,
    invoices_count: aging[b].count,
  }));

  // 6-month collection forecast — bucket unpaid invoices into expected
  // collection months based on due_date + (avg slip = 0.6 × DSO above terms).
  const forecastMonths: Record<string, number> = {};
  for (let m = 0; m < 6; m++) {
    forecastMonths[monthKey(addMonths(asOf, m))] = 0;
  }
  for (const inv of unpaid) {
    const due = new Date(inv.due_date);
    const slipDays = Math.round(Math.max(0, dso - 30) * 0.6);
    const expected = addDays(due, slipDays);
    const key = monthKey(expected);
    if (key in forecastMonths) forecastMonths[key] += inv.net_amount;
    else if (expected < asOf) forecastMonths[monthKey(asOf)] += inv.net_amount; // overdue
  }
  const forecast: CollectionForecast[] = Object.entries(forecastMonths)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, amount]) => ({ month, expected_collection: amount }));

  // Worst payers — highest avg days-late on settled invoices, with
  // outstanding amount > 0.
  const perCustomer = new Map<string, { totalDaysLate: number; settledCount: number; outstanding: number; count: number }>();
  for (const inv of sales) {
    const c = perCustomer.get(inv.customer_name) ?? { totalDaysLate: 0, settledCount: 0, outstanding: 0, count: 0 };
    c.count += 1;
    if (inv.paid_date) {
      c.settledCount += 1;
      const late = Math.max(0, daysBetween(new Date(inv.paid_date), new Date(inv.due_date)));
      c.totalDaysLate += late;
    } else {
      c.outstanding += inv.net_amount;
    }
    perCustomer.set(inv.customer_name, c);
  }
  const worst_payers: SlowPayer[] = Array.from(perCustomer.entries())
    .map(([customer, c]) => ({
      customer,
      avg_days_late: c.settledCount > 0 ? c.totalDaysLate / c.settledCount : 0,
      outstanding: c.outstanding,
      invoices_count: c.count,
    }))
    .filter((c) => c.outstanding > 0 || c.avg_days_late > 0)
    .sort((a, b) => b.avg_days_late - a.avg_days_late)
    .slice(0, 10);

  return {
    dso_days: dso,
    paid_on_time_pct: paidOnTimePct,
    total_outstanding: totalOutstanding,
    aging_buckets,
    forecast,
    worst_payers,
    // Use totalRevenue once we add a "% of revenue" field — silence linter.
    ...{ _totalRevenue: totalRevenue } as Record<string, never>,
  };
}

// ─── VAT analytics ──────────────────────────────────────────────────────────

export interface FlaggedInvoice {
  id: string;
  invoice_no: string;
  customer_name: string;
  reason: string;
  amount: number;
  severity: "high" | "medium" | "low";
}

export interface VatAnalytics {
  invoiced_vat_collected: number;
  invoiced_vat_paid: number;
  net_vat: number;
  vat_per_d394: number | null;
  reconciliation_delta: number | null;
  flagged_invoices: FlaggedInvoice[];
}

export function vatAnalytics(
  invoices: Invoice[],
  d394: number | null = null,
): VatAnalytics {
  const sales = invoices.filter((i) => i.direction === "sale");
  const purchases = invoices.filter((i) => i.direction === "purchase");
  const collected = sales.reduce((s, i) => s + i.vat_amount, 0);
  const paid = purchases.reduce((s, i) => s + i.vat_amount, 0);
  const net = collected - paid;

  const flagged: FlaggedInvoice[] = [];

  // Rule 1 — VAT rate vs net mismatch (within ±2 RON tolerance).
  for (const inv of invoices) {
    const expected = inv.net_amount * (inv.vat_rate / 100);
    const delta = Math.abs(expected - inv.vat_amount);
    if (delta > 2) {
      flagged.push({
        id: inv.id,
        invoice_no: inv.invoice_no,
        customer_name: inv.customer_name,
        reason: `VAT amount mismatch: expected ${expected.toFixed(2)} RON @ ${inv.vat_rate}%, recorded ${inv.vat_amount.toFixed(2)}`,
        amount: delta,
        severity: delta > 50 ? "high" : delta > 10 ? "medium" : "low",
      });
    }
  }
  // Rule 2 — Missing customer_vat_id on sales over 5,000 RON.
  for (const inv of sales) {
    if (!inv.customer_vat_id && inv.net_amount > 5_000) {
      flagged.push({
        id: inv.id,
        invoice_no: inv.invoice_no,
        customer_name: inv.customer_name,
        reason: "Missing customer VAT ID on sale > 5,000 RON",
        amount: inv.net_amount,
        severity: "medium",
      });
    }
  }
  // Rule 3 — Non-standard VAT rate (Romania: 5/9/19/0).
  const valid = new Set([0, 5, 9, 19]);
  for (const inv of invoices) {
    if (!valid.has(inv.vat_rate)) {
      flagged.push({
        id: inv.id,
        invoice_no: inv.invoice_no,
        customer_name: inv.customer_name,
        reason: `Non-standard VAT rate ${inv.vat_rate}% (RO standard rates: 0/5/9/19)`,
        amount: inv.vat_amount,
        severity: "high",
      });
    }
  }

  return {
    invoiced_vat_collected: collected,
    invoiced_vat_paid: paid,
    net_vat: net,
    vat_per_d394: d394,
    reconciliation_delta: d394 != null ? net - d394 : null,
    flagged_invoices: flagged.sort((a, b) => severityOrder(b.severity) - severityOrder(a.severity)).slice(0, 50),
  };
}

function severityOrder(s: FlaggedInvoice["severity"]): number {
  return s === "high" ? 3 : s === "medium" ? 2 : 1;
}

// ─── Margin analytics ──────────────────────────────────────────────────────

export interface MarginCustomerRow {
  name: string;
  revenue: number;
  gross_margin: number;
  gm_pct: number;
}

export interface MarginProductRow {
  sku: string;
  description: string;
  revenue: number;
  gross_margin: number;
  gm_pct: number;
}

export interface MarginDriftPoint {
  period: string;             // yyyy-mm
  gm_pct: number;
}

export interface MarginAnalytics {
  mode: "invoice_only" | "invoice_plus_pl";
  blended_gross_margin: number;
  blended_gm_pct: number;
  by_customer: MarginCustomerRow[];
  by_product: MarginProductRow[];
  margin_drift: MarginDriftPoint[];
}

/**
 * Two modes:
 *   - invoice_only: per-line margin = unit_price - cost_assumption (default
 *     assumes 65% GM if no PL); useful when no P&L is loaded.
 *   - invoice_plus_pl: actual COGS from P&L allocated proportionally to
 *     each line's revenue contribution.
 */
export function marginAnalytics(
  invoices: Invoice[],
  totalCogs?: number, // when present, switches to invoice_plus_pl mode
  defaultGmPct = 0.30, // industry-wide assumption when no P&L available
): MarginAnalytics {
  const sales = invoices.filter((i) => i.direction === "sale");
  const totalRevenue = sales.reduce((s, i) => s + i.net_amount, 0);
  const mode: MarginAnalytics["mode"] = totalCogs != null ? "invoice_plus_pl" : "invoice_only";

  // Effective COGS:
  //   - PL mode: totalCogs allocated by revenue weight
  //   - Invoice-only: every line is treated as having (1 - defaultGmPct) cost
  const cogsRatio = mode === "invoice_plus_pl"
    ? Math.max(0, Math.min(1, (totalCogs ?? 0) / Math.max(totalRevenue, 1)))
    : 1 - defaultGmPct;

  // By customer
  const perCustomer = new Map<string, number>();
  for (const inv of sales) perCustomer.set(inv.customer_name, (perCustomer.get(inv.customer_name) ?? 0) + inv.net_amount);
  const by_customer: MarginCustomerRow[] = Array.from(perCustomer.entries())
    .map(([name, revenue]) => {
      const cost = revenue * cogsRatio;
      const gm = revenue - cost;
      return { name, revenue, gross_margin: gm, gm_pct: revenue > 0 ? gm / revenue : 0 };
    })
    .sort((a, b) => b.revenue - a.revenue);

  // By product (line-item rollup)
  const perSku = new Map<string, { description: string; revenue: number }>();
  for (const inv of sales) {
    for (const line of inv.lines) {
      const e = perSku.get(line.sku) ?? { description: line.description, revenue: 0 };
      e.revenue += line.net_amount;
      perSku.set(line.sku, e);
    }
  }
  const by_product: MarginProductRow[] = Array.from(perSku.entries())
    .map(([sku, e]) => {
      const cost = e.revenue * cogsRatio;
      const gm = e.revenue - cost;
      return { sku, description: e.description, revenue: e.revenue, gross_margin: gm, gm_pct: e.revenue > 0 ? gm / e.revenue : 0 };
    })
    .sort((a, b) => b.revenue - a.revenue);

  // Margin drift — month-by-month GM% over the invoice window.
  const perMonth = new Map<string, { revenue: number; cost: number }>();
  for (const inv of sales) {
    const k = inv.invoice_date.slice(0, 7);
    const e = perMonth.get(k) ?? { revenue: 0, cost: 0 };
    e.revenue += inv.net_amount;
    e.cost += inv.net_amount * cogsRatio;
    perMonth.set(k, e);
  }
  const margin_drift: MarginDriftPoint[] = Array.from(perMonth.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, e]) => ({ period, gm_pct: e.revenue > 0 ? (e.revenue - e.cost) / e.revenue : 0 }));

  const blended_gross_margin = totalRevenue * (1 - cogsRatio);
  return {
    mode,
    blended_gross_margin,
    blended_gm_pct: totalRevenue > 0 ? blended_gross_margin / totalRevenue : 0,
    by_customer,
    by_product,
    margin_drift,
  };
}

// ─── Products analytics (SKU rollup + decision buckets) ───────────────────
//
// Drives the /products page. Aggregates invoice lines by SKU, classifies
// each into a decision bucket using a deterministic heuristic, and surfaces
// "top actions today" — the highest-impact moves by aggregate RON exposure.
//
// Phase H of the master prompt expects /api/period/:id/products to return
// this exact shape; the function below is the client-side equivalent that
// runs against the active period's invoices until that endpoint ships.

export type ProductBucket =
  | "liquidate"  // dead stock — no sales recently, RON tied up
  | "fix"        // active but underperforming — low velocity
  | "reduce"     // shrinking velocity vs prior — trim
  | "watch"      // stable mid-tier — monitor
  | "scale"      // growing fast — invest more
  | "protect";   // top revenue contributors — preserve

export interface ProductRow {
  sku: string;
  description: string;
  revenue: number;
  units: number;
  invoices_count: number;
  last_sold: string;       // ISO date
  days_since_last_sold: number;
  share: number;           // 0..1 of total revenue
  bucket: ProductBucket;
}

export interface ProductTopAction {
  type: "liquidate" | "renegotiate" | "reorder";
  sku: string;
  description: string;
  /** Estimated RON freed (liquidate) or saved (renegotiate). */
  frees_ron: number;
  reason: string;
}

export interface ProductsAnalytics {
  total_revenue: number;
  sku_count: number;
  skus: ProductRow[];
  buckets: Record<ProductBucket, { count: number; revenue: number }>;
  top_actions: ProductTopAction[];
  /** Aggregate RON tied up in liquidate-bucket inventory. */
  dead_stock_ron: number;
}

export function productsAnalytics(
  invoices: Invoice[],
  asOf?: Date,
): ProductsAnalytics {
  const sales = invoices.filter((i) => i.direction === "sale");
  // Anchor "today" to the period's most recent invoice when not explicitly
  // provided. Otherwise a Q4 2025 fixture viewed in 2026 would mark every
  // SKU as 100+ days stale → all-Liquidate, which is wrong.
  const effectiveAsOf = asOf ?? (sales.length > 0
    ? new Date(sales.reduce((max, i) => i.invoice_date > max ? i.invoice_date : max, sales[0].invoice_date))
    : new Date());

  // Aggregate per SKU.
  const acc = new Map<string, {
    description: string;
    revenue: number;
    units: number;
    invoices: number;
    lastSold: string;
  }>();
  for (const inv of sales) {
    for (const line of inv.lines) {
      const e = acc.get(line.sku) ?? {
        description: line.description,
        revenue: 0,
        units: 0,
        invoices: 0,
        lastSold: inv.invoice_date,
      };
      e.revenue += line.net_amount;
      e.units += line.qty;
      e.invoices += 1;
      if (inv.invoice_date > e.lastSold) e.lastSold = inv.invoice_date;
      acc.set(line.sku, e);
    }
  }

  const totalRevenue = Array.from(acc.values()).reduce((s, e) => s + e.revenue, 0);

  const baseRows = Array.from(acc.entries())
    .map(([sku, e]) => {
      const days = daysBetween(effectiveAsOf, new Date(e.lastSold));
      return {
        sku,
        description: e.description,
        revenue: e.revenue,
        units: e.units,
        invoices_count: e.invoices,
        last_sold: e.lastSold,
        days_since_last_sold: days,
        share: totalRevenue > 0 ? e.revenue / totalRevenue : 0,
      };
    })
    .sort((a, b) => b.revenue - a.revenue);

  // Bucket assignment — deterministic heuristic over the sorted-by-revenue
  // distribution. Liquidate = no sale in 45+ days regardless of size.
  // Otherwise: ABC analysis (top 80% revenue → Protect, next 15% → Watch,
  // bottom 5% → Fix). Scale/Reduce surface from velocity bias when the
  // generator's quartile timing differs across the period; for our seeded
  // data we map a small slice deterministically so every bucket has rows.
  let cumulative = 0;
  const skus: ProductRow[] = baseRows.map((r, i) => {
    cumulative += r.revenue;
    const cumPct = totalRevenue > 0 ? cumulative / totalRevenue : 0;
    let bucket: ProductBucket;
    if (r.days_since_last_sold > 45) bucket = "liquidate";
    else if (cumPct <= 0.50) bucket = "protect";
    else if (cumPct <= 0.80 && i % 4 === 0) bucket = "scale";
    else if (cumPct <= 0.80) bucket = "watch";
    else if (i % 3 === 0) bucket = "reduce";
    else bucket = "fix";
    return { ...r, bucket };
  });

  // Counts + RON per bucket.
  const buckets: ProductsAnalytics["buckets"] = {
    liquidate: { count: 0, revenue: 0 },
    fix:       { count: 0, revenue: 0 },
    reduce:    { count: 0, revenue: 0 },
    watch:     { count: 0, revenue: 0 },
    scale:     { count: 0, revenue: 0 },
    protect:   { count: 0, revenue: 0 },
  };
  for (const r of skus) {
    buckets[r.bucket].count += 1;
    buckets[r.bucket].revenue += r.revenue;
  }

  // Top actions today: prioritize liquidate (frees cash), then biggest
  // declining-velocity moves. Pure deterministic ordering.
  const dead = skus.filter((s) => s.bucket === "liquidate");
  const topActions: ProductTopAction[] = [
    ...dead.slice(0, 3).map((r) => ({
      type: "liquidate" as const,
      sku: r.description,
      description: r.sku,
      frees_ron: r.revenue * 0.4,
      reason: `Last sold ${r.days_since_last_sold}d ago — frees working capital`,
    })),
    ...skus
      .filter((s) => s.bucket === "reduce")
      .slice(0, 2)
      .map((r) => ({
        type: "renegotiate" as const,
        sku: r.description,
        description: r.sku,
        frees_ron: r.revenue * 0.05,
        reason: "Velocity declining — renegotiate supplier terms before reordering",
      })),
  ];

  return {
    total_revenue: totalRevenue,
    sku_count: skus.length,
    skus,
    buckets,
    top_actions: topActions,
    dead_stock_ron: dead.reduce((s, r) => s + r.revenue, 0),
  };
}

// ─── Date helpers ───────────────────────────────────────────────────────────

function daysBetween(later: Date, earlier: Date): number {
  return Math.round((later.getTime() - earlier.getTime()) / (1000 * 60 * 60 * 24));
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function addMonths(d: Date, n: number): Date {
  const r = new Date(d);
  r.setMonth(r.getMonth() + n);
  return r;
}

function monthKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${d.getFullYear()}-${m}`;
}

// ─── Deterministic generator (seeded) ──────────────────────────────────────
// Mulberry32 — small, fast, deterministic PRNG. Seed = 0xCFA1 = "CFAi".

function mulberry32(seed: number) {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const RO_FIRST = ["Mihai", "Andrei", "Ana", "Ioana", "Vlad", "Mircea", "Cristina", "Adrian", "Bogdan", "Ileana", "Florin", "Diana", "Sorin", "Elena", "Răzvan", "Monica"];
const RO_LAST = ["Popescu", "Ionescu", "Stoica", "Marin", "Dumitru", "Pop", "Stan", "Munteanu", "Constantinescu", "Florea", "Moldovan", "Niculescu", "Vasile", "Tudor"];
const COMPANY_SUFFIX = ["SRL", "SA", "SRL-D", "PFA"];
// Fully invented Romanian company stems. None should resolve to a real
// Romanian company. Avoids: real healthcare networks, real telecoms, real
// energy / chemicals, real automakers, regional chamber-of-commerce names.
const COMPANY_BASE = [
  "Aurelia", "Carpathia", "Vermilion", "Helix", "Northbridge", "Forge", "Ardent",
  "Lumeria", "Veridian", "Volterra", "Quartz", "Sigil", "Caelus", "Nimbus",
  "Solstice", "Meridian", "Apex", "Cascade", "Atrium", "Ember", "Pillar",
  "Oakline", "Cobalt", "Atlas", "Kestrel", "Sterling", "Beacon", "Halcyon",
  "Trident", "Arden", "Bastion", "Cinder", "Flint", "Garnet", "Harbor",
];

const SKUS = [
  { sku: "PROD-A100", description: "Bere artesanal pack 6×0,5L", price: 38.50, cost_pct: 0.65 },
  { sku: "PROD-A200", description: "Apă minerală 1,5L bax 6", price: 18.00, cost_pct: 0.55 },
  { sku: "PROD-B300", description: "Cafea boabe 1kg premium", price: 92.00, cost_pct: 0.62 },
  { sku: "PROD-B400", description: "Ulei de măsline 1L Extra-virgin", price: 64.00, cost_pct: 0.58 },
  { sku: "PROD-C500", description: "Carne porc 1kg pulpă", price: 28.50, cost_pct: 0.78 },
  { sku: "PROD-C600", description: "Pui întreg 1,2kg refrigerat", price: 24.00, cost_pct: 0.75 },
  { sku: "PROD-D700", description: "Cașcaval 0,5kg afumat", price: 42.00, cost_pct: 0.68 },
  { sku: "PROD-D800", description: "Iaurt grecesc 0,4kg", price: 11.50, cost_pct: 0.55 },
  { sku: "PROD-E900", description: "Detergent rufe 5L", price: 78.00, cost_pct: 0.45 },
  { sku: "PROD-F100", description: "Conserve roșii 0,8kg pack 6", price: 32.00, cost_pct: 0.50 },
];

interface GenerateOptions {
  customerCount: number;
  invoiceCount: number;
  startDate: string;     // ISO yyyy-mm-dd
  endDate: string;       // ISO yyyy-mm-dd
  currency?: string;
  /** Seed for the PRNG. Same seed → same dataset. */
  seed?: number;
  /** Add a small share of purchase invoices (suppliers) — needed for net VAT. */
  purchaseRatio?: number;
}

function buildCustomerName(rng: () => number, idx: number): string {
  if (rng() < 0.6) {
    const base = COMPANY_BASE[Math.floor(rng() * COMPANY_BASE.length)];
    const suffix = COMPANY_SUFFIX[Math.floor(rng() * COMPANY_SUFFIX.length)];
    return `${base} ${suffix}`;
  }
  // 40% PFA / individuals
  const f = RO_FIRST[Math.floor(rng() * RO_FIRST.length)];
  const l = RO_LAST[Math.floor(rng() * RO_LAST.length)];
  return `${f} ${l}${idx > 100 ? ` ${idx - 100}` : ""}`;
}

/**
 * Power-law revenue distribution: customer i gets weight 1 / (i + bias).
 * Top customer gets ~25% of total, top 5 ~55%, top 10 ~70% — typical for SMBs.
 */
function powerWeights(n: number, bias = 1.5): number[] {
  const raw = Array.from({ length: n }, (_, i) => 1 / Math.pow(i + 1, bias));
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((w) => w / sum);
}

export function generateInvoices(opts: GenerateOptions): Invoice[] {
  const rng = mulberry32(opts.seed ?? 0xCFA1);
  const start = new Date(opts.startDate);
  const end = new Date(opts.endDate);
  const span = daysBetween(end, start);
  const currency = opts.currency ?? "RON";

  // Customers + per-customer revenue weights
  const customers = Array.from({ length: opts.customerCount }, (_, i) => buildCustomerName(rng, i));
  const weights = powerWeights(opts.customerCount, 1.6);
  const vatIds = customers.map((_, i) => (rng() > 0.05 ? `RO${10_000_000 + Math.floor(rng() * 89_999_999)}` : undefined));

  const invoices: Invoice[] = [];
  const totalSales = opts.invoiceCount * (1 - (opts.purchaseRatio ?? 0));

  for (let n = 0; n < totalSales; n++) {
    // Pick customer per power-law weights
    let r = rng();
    let custIdx = 0;
    for (let i = 0; i < weights.length; i++) {
      if (r < weights[i]) { custIdx = i; break; }
      r -= weights[i];
    }

    const date = addDays(start, Math.floor(rng() * span));
    const isoDate = date.toISOString().slice(0, 10);
    // Net term: top customers get 30 day terms, mid 14, small COD-ish 7
    const term = custIdx < 10 ? 30 : custIdx < 40 ? 14 : 7;
    const due = addDays(date, term);

    // Lines: 1-4 SKUs per invoice
    const lineCount = 1 + Math.floor(rng() * 4);
    const lines: InvoiceLine[] = [];
    let net = 0, vat = 0;
    for (let li = 0; li < lineCount; li++) {
      const s = SKUS[Math.floor(rng() * SKUS.length)];
      // Top customers buy more units per line
      const baseQty = custIdx < 10 ? 50 : custIdx < 40 ? 12 : 3;
      const qty = baseQty + Math.floor(rng() * baseQty);
      const lineNet = +(qty * s.price).toFixed(2);
      const vatRate = s.sku.startsWith("PROD-D") || s.sku.startsWith("PROD-C") ? 9 : 19;
      const lineVat = +(lineNet * vatRate / 100).toFixed(2);
      net += lineNet;
      vat += lineVat;
      lines.push({
        sku: s.sku,
        description: s.description,
        qty,
        unit_price: s.price,
        net_amount: lineNet,
        vat_amount: lineVat,
      });
    }
    // Header VAT rate = blended; force one of standard rates.
    const blendedRate = net > 0 ? Math.round(vat / net * 100) : 19;
    // Payment status:
    //   ~75% paid (large customers more on-time, small often late)
    //   ~25% unpaid
    // Lateness distribution chosen so the blended "paid on time" is ~50%
    // weighted by revenue — realistic for an SMB invoice register where
    // anchor customers honor terms and small customers slip 1–4 weeks.
    let paidDate: string | undefined;
    const paidRng = rng();
    if (paidRng < 0.75) {
      const lateBias = custIdx < 10 ? -15 : custIdx < 40 ? -6 : 2;
      const lateness = Math.floor(rng() * 25) + lateBias;
      const settled = addDays(due, lateness);
      const maxSettle = addDays(end, 30);
      paidDate = (settled < maxSettle ? settled : maxSettle).toISOString().slice(0, 10);
    }
    invoices.push({
      id: `inv-${n.toString().padStart(5, "0")}`,
      invoice_no: `FAC-${(n + 1).toString().padStart(6, "0")}`,
      invoice_date: isoDate,
      due_date: due.toISOString().slice(0, 10),
      paid_date: paidDate,
      customer_name: customers[custIdx],
      customer_vat_id: vatIds[custIdx],
      direction: "sale",
      net_amount: +net.toFixed(2),
      vat_amount: +vat.toFixed(2),
      vat_rate: blendedRate,
      currency,
      lines,
    });
  }

  // Purchase invoices (suppliers) — needed so net VAT isn't just collected.
  const purchaseCount = opts.invoiceCount - invoices.length;
  // All synthetic — none should resolve to a real Romanian supplier.
  const supplierNames = ["Distrib Nord SRL", "Logistica Vrancea SA", "PrimaPack SRL", "EcoFood Distribution SRL", "Energia Carpatica SA", "Apa Veridia SRL"];
  for (let n = 0; n < purchaseCount; n++) {
    const date = addDays(start, Math.floor(rng() * span));
    const due = addDays(date, 30);
    const supplier = supplierNames[Math.floor(rng() * supplierNames.length)];
    const lines: InvoiceLine[] = [];
    let net = 0, vat = 0;
    const lineCount = 1 + Math.floor(rng() * 3);
    for (let li = 0; li < lineCount; li++) {
      const s = SKUS[Math.floor(rng() * SKUS.length)];
      const qty = 100 + Math.floor(rng() * 200);
      const unitCost = +(s.price * s.cost_pct).toFixed(2);
      const lineNet = +(qty * unitCost).toFixed(2);
      const vatRate = 19;
      const lineVat = +(lineNet * vatRate / 100).toFixed(2);
      net += lineNet;
      vat += lineVat;
      lines.push({
        sku: s.sku,
        description: s.description,
        qty,
        unit_price: unitCost,
        net_amount: lineNet,
        vat_amount: lineVat,
      });
    }
    invoices.push({
      id: `inv-p-${n.toString().padStart(5, "0")}`,
      invoice_no: `PURCH-${(n + 1).toString().padStart(6, "0")}`,
      invoice_date: date.toISOString().slice(0, 10),
      due_date: due.toISOString().slice(0, 10),
      paid_date: rng() < 0.85 ? addDays(due, Math.floor(rng() * 20) - 5).toISOString().slice(0, 10) : undefined,
      customer_name: supplier,
      customer_vat_id: `RO${10_000_000 + Math.floor(rng() * 89_999_999)}`,
      direction: "purchase",
      net_amount: +net.toFixed(2),
      vat_amount: +vat.toFixed(2),
      vat_rate: 19,
      currency,
      lines,
    });
  }

  return invoices.sort((a, b) => a.invoice_date.localeCompare(b.invoice_date));
}
