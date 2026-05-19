// Margin tab — dual-mode by-customer + by-product margin analytics.
//
//   • invoice_only mode (no P&L loaded): assumes a default 30% blended GM
//     and decomposes contribution by line-item.
//   • invoice_plus_pl mode: actual COGS from the P&L allocated proportionally
//     to each invoice line by revenue weight. Shown via a tooltip on the
//     mode chip.
//
// Layout: scatter plot (revenue vs GM%) + table beneath, then a 6-period
// margin drift line chart.

import { useMemo } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import { Info } from "lucide-react";
import { marginAnalytics, type Invoice } from "@/lib/invoiceAnalytics";

interface Props {
  invoices: Invoice[];
  /** When loaded, switches to invoice_plus_pl mode. */
  totalCogs?: number;
  currency?: string;
}

export function MarginTab({ invoices, totalCogs, currency = "RON" }: Props) {
  const data = useMemo(() => marginAnalytics(invoices, totalCogs), [invoices, totalCogs]);

  return (
    <div className="space-y-6">
      {/* Mode chip + headline KPIs */}
      <div className="flex items-center gap-3 flex-wrap">
        <span
          className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] px-2.5 py-1 rounded-full border border-blue-200 bg-blue-50 text-blue-700"
          title={
            data.mode === "invoice_plus_pl"
              ? "Gross margin allocated from P&L COGS — actual financial-statement values applied to each line proportionally to revenue."
              : "Margin assumed at industry-average 30% — load a P&L to switch to allocated COGS mode."
          }
        >
          <Info size={11} strokeWidth={2} />
          {data.mode === "invoice_plus_pl" ? "Allocated COGS mode" : "Invoice-only mode"}
        </span>
        <div className="text-[11px] text-ink-soft">
          {data.mode === "invoice_plus_pl"
            ? "Gross margin allocated from P&L COGS."
            : "Load a P&L to switch to allocated COGS mode."}
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <Tile label="Blended gross margin" value={`${(data.blended_gm_pct * 100).toFixed(1)}%`} sub={money(data.blended_gross_margin, currency)} />
        <Tile label="Customers analyzed" value={data.by_customer.length.toLocaleString()} />
        <Tile label="Products analyzed" value={data.by_product.length.toLocaleString()} />
      </div>

      {/* Scatter: customer revenue vs GM% */}
      <div className="rounded-2xl border border-rule bg-surface overflow-hidden">
        <div className="px-5 py-3 bg-bg-2/40 border-b border-rule">
          <h2 className="font-serif text-[18px] text-ink">Customer revenue × gross margin</h2>
          <p className="text-[12px] text-ink-soft mt-0.5">
            Each dot is a customer. Top-right = high revenue + healthy margin.
          </p>
        </div>
        <div className="px-5 py-5 h-[280px]">
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 8, right: 16, bottom: 28, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--rule))" />
              <XAxis
                type="number"
                dataKey="revenue"
                name="Revenue"
                stroke="hsl(var(--ink-soft))"
                fontSize={11}
                tickFormatter={(v) => moneyShort(v, currency)}
                label={{ value: "Revenue", position: "bottom", offset: 0, style: { fill: "hsl(var(--ink-soft))", fontSize: 11 } }}
              />
              <YAxis
                type="number"
                dataKey="gmPct"
                name="GM %"
                stroke="hsl(var(--ink-soft))"
                fontSize={11}
                tickFormatter={(v) => `${v.toFixed(0)}%`}
                domain={[0, "dataMax + 5"]}
                label={{ value: "GM %", angle: -90, position: "left", style: { fill: "hsl(var(--ink-soft))", fontSize: 11 } }}
              />
              <ZAxis range={[40, 200]} />
              <Tooltip
                cursor={{ strokeDasharray: "3 3" }}
                formatter={(v: number, key: string) => key === "gmPct" ? `${v.toFixed(1)}%` : money(v, currency)}
                contentStyle={{
                  background: "hsl(var(--surface))",
                  border: "1px solid hsl(var(--rule))",
                  borderRadius: 8,
                  fontSize: 12,
                }}
                labelFormatter={() => ""}
                content={({ payload }) => {
                  if (!payload?.length) return null;
                  const p = payload[0].payload as { name: string; revenue: number; gmPct: number };
                  return (
                    <div className="rounded-lg border border-rule bg-surface px-3 py-2 text-[12px] shadow-md">
                      <div className="font-medium text-ink">{p.name}</div>
                      <div className="text-ink-soft">Revenue {money(p.revenue, currency)}</div>
                      <div className="text-ink-soft">GM {p.gmPct.toFixed(1)}%</div>
                    </div>
                  );
                }}
              />
              <Scatter
                data={data.by_customer.map((c) => ({ name: c.name, revenue: c.revenue, gmPct: c.gm_pct * 100 }))}
                fill="hsl(var(--brand))"
                fillOpacity={0.7}
              />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* By-customer table */}
      <div className="rounded-2xl border border-rule bg-surface overflow-hidden">
        <div className="px-5 py-3 bg-bg-2/40 border-b border-rule">
          <h2 className="font-serif text-[18px] text-ink">Margin by customer · top 25</h2>
        </div>
        <table className="w-full text-[13px]">
          <thead>
            <tr className="bg-bg-2/30 text-[11px] uppercase tracking-[0.08em] text-ink-mute">
              <th className="text-left py-2.5 px-4 font-medium">Customer</th>
              <th className="text-right py-2.5 px-4 font-medium">Revenue</th>
              <th className="text-right py-2.5 px-4 font-medium">Gross margin</th>
              <th className="text-right py-2.5 px-4 font-medium">GM %</th>
            </tr>
          </thead>
          <tbody>
            {data.by_customer.slice(0, 25).map((c) => (
              <tr key={c.name} className="border-t border-rule">
                <td className="py-2 px-4 text-ink truncate max-w-[300px]">{c.name}</td>
                <td className="py-2 px-4 text-right tabular-nums text-ink">{money(c.revenue, currency)}</td>
                <td className="py-2 px-4 text-right tabular-nums text-ink">{money(c.gross_margin, currency)}</td>
                <td className="py-2 px-4 text-right tabular-nums text-ink">{(c.gm_pct * 100).toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Margin drift line */}
      <div className="rounded-2xl border border-rule bg-surface overflow-hidden">
        <div className="px-5 py-3 bg-bg-2/40 border-b border-rule">
          <h2 className="font-serif text-[18px] text-ink">Margin drift</h2>
          <p className="text-[12px] text-ink-soft mt-0.5">Month-over-month blended gross margin %.</p>
        </div>
        <div className="px-5 py-5 h-[200px]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data.margin_drift.map((p) => ({ ...p, gm_pct: p.gm_pct * 100 }))} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--rule))" vertical={false} />
              <XAxis dataKey="period" stroke="hsl(var(--ink-soft))" fontSize={11} />
              <YAxis stroke="hsl(var(--ink-soft))" fontSize={11} tickFormatter={(v) => `${v.toFixed(0)}%`} domain={["dataMin - 2", "dataMax + 2"]} />
              <Tooltip
                formatter={(v: number) => `${v.toFixed(1)}%`}
                contentStyle={{
                  background: "hsl(var(--surface))",
                  border: "1px solid hsl(var(--rule))",
                  borderRadius: 8,
                  fontSize: 12,
                }}
              />
              <Line
                type="monotone"
                dataKey="gm_pct"
                stroke="hsl(var(--brand))"
                strokeWidth={2.5}
                dot={{ r: 4, fill: "hsl(var(--brand))" }}
                activeDot={{ r: 6 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-rule bg-surface px-4 py-3">
      <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium">{label}</div>
      <div className="mt-1.5 font-serif text-[22px] text-ink leading-tight">{value}</div>
      {sub && <div className="mt-0.5 text-[11.5px] text-ink-soft">{sub}</div>}
    </div>
  );
}

function money(n: number, currency: string): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${currency} ${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${currency} ${(n / 1_000).toFixed(0)}K`;
  return `${currency} ${n.toFixed(0)}`;
}

function moneyShort(n: number, currency: string): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return n.toFixed(0);
}
