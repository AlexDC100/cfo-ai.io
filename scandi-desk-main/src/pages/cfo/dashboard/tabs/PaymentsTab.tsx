// Payments tab — DSO, aging buckets, 6-month collection forecast, and the
// top-10 slow-payer table. Uses recharts (already in the bundle) for the
// stacked bar + line chart.

import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { paymentsAnalytics, type Invoice } from "@/lib/invoiceAnalytics";

interface Props {
  invoices: Invoice[];
  currency?: string;
}

const BUCKET_COLORS: Record<string, string> = {
  "0-30":  "hsl(160 70% 45%)",  // green
  "31-60": "hsl(48 95% 55%)",   // amber
  "61-90": "hsl(25 90% 55%)",   // orange
  "90+":   "hsl(0 75% 55%)",    // red
};

export function PaymentsTab({ invoices, currency = "RON" }: Props) {
  const data = useMemo(() => paymentsAnalytics(invoices), [invoices]);

  return (
    <div className="space-y-6">
      {/* KPI strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiTile
          label="DSO"
          value={`${data.dso_days.toFixed(0)} days`}
          sub={data.dso_days > 60 ? "Above 60 days — review collections" : data.dso_days > 45 ? "Slightly stretched" : "Healthy collection cycle"}
          tone={data.dso_days > 60 ? "warn" : data.dso_days > 45 ? "watch" : "ok"}
        />
        <KpiTile
          label="Paid on time"
          value={`${(data.paid_on_time_pct * 100).toFixed(0)}%`}
          sub={data.paid_on_time_pct < 0.5 ? "Less than half on terms" : "Of settled invoices"}
          tone={data.paid_on_time_pct < 0.5 ? "warn" : data.paid_on_time_pct < 0.7 ? "watch" : "ok"}
        />
        <KpiTile
          label="Outstanding"
          value={money(data.total_outstanding, currency)}
          sub="Across all unpaid invoices"
        />
        <KpiTile
          label="Slow payers (top)"
          value={data.worst_payers[0] ? `${Math.round(data.worst_payers[0].avg_days_late)} days late` : "—"}
          sub={data.worst_payers[0]?.customer.slice(0, 24) ?? ""}
          tone={data.worst_payers[0] && data.worst_payers[0].avg_days_late > 30 ? "warn" : "watch"}
        />
      </div>

      {/* Aging buckets bar */}
      <div className="rounded-2xl border border-rule bg-surface overflow-hidden">
        <div className="px-5 py-3 bg-bg-2/40 border-b border-rule">
          <h2 className="font-serif text-[18px] text-ink">Outstanding · aging buckets</h2>
          <p className="text-[12px] text-ink-soft mt-0.5">
            Distribution of {money(data.total_outstanding, currency)} across days outstanding.
          </p>
        </div>
        <div className="px-5 py-5">
          <div className="h-[200px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.aging_buckets} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--rule))" vertical={false} />
                <XAxis dataKey="bucket" stroke="hsl(var(--ink-soft))" fontSize={12} />
                <YAxis stroke="hsl(var(--ink-soft))" fontSize={11} tickFormatter={(v) => moneyShort(v, currency)} />
                <Tooltip
                  formatter={(v: number) => money(v, currency)}
                  contentStyle={{
                    background: "hsl(var(--surface))",
                    border: "1px solid hsl(var(--rule))",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                />
                <Bar dataKey="amount" radius={[6, 6, 0, 0]}>
                  {data.aging_buckets.map((b) => (
                    // eslint-disable-next-line react/jsx-key
                    <CellOverride key={b.bucket} fill={BUCKET_COLORS[b.bucket]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-3 grid grid-cols-4 gap-2 text-center">
            {data.aging_buckets.map((b) => (
              <div key={b.bucket} className="rounded-lg bg-bg-2/30 border border-rule px-3 py-2">
                <div className="flex items-center justify-center gap-1.5">
                  <div className="w-2 h-2 rounded-full" style={{ background: BUCKET_COLORS[b.bucket] }} />
                  <span className="text-[10.5px] uppercase tracking-[0.06em] font-medium text-ink-mute">{b.bucket}d</span>
                </div>
                <div className="font-serif text-[15px] text-ink mt-1">{(b.pct * 100).toFixed(1)}%</div>
                <div className="text-[10.5px] text-ink-mute">{b.invoices_count} inv</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Forecast line */}
      <div className="rounded-2xl border border-rule bg-surface overflow-hidden">
        <div className="px-5 py-3 bg-bg-2/40 border-b border-rule">
          <h2 className="font-serif text-[18px] text-ink">6-month collection forecast</h2>
          <p className="text-[12px] text-ink-soft mt-0.5">
            Expected receipts, based on due dates + observed late-payment slip.
          </p>
        </div>
        <div className="px-5 py-5 h-[220px]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data.forecast} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--rule))" vertical={false} />
              <XAxis dataKey="month" stroke="hsl(var(--ink-soft))" fontSize={11} />
              <YAxis stroke="hsl(var(--ink-soft))" fontSize={11} tickFormatter={(v) => moneyShort(v, currency)} />
              <Tooltip
                formatter={(v: number) => money(v, currency)}
                contentStyle={{
                  background: "hsl(var(--surface))",
                  border: "1px solid hsl(var(--rule))",
                  borderRadius: 8,
                  fontSize: 12,
                }}
              />
              <Line
                type="monotone"
                dataKey="expected_collection"
                stroke="hsl(var(--brand))"
                strokeWidth={2.5}
                dot={{ r: 4, fill: "hsl(var(--brand))" }}
                activeDot={{ r: 6 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Slow payer table */}
      <div className="rounded-2xl border border-rule bg-surface overflow-hidden">
        <div className="px-5 py-3 bg-bg-2/40 border-b border-rule">
          <h2 className="font-serif text-[18px] text-ink">Top 10 slow payers</h2>
        </div>
        <table className="w-full text-[13px]">
          <thead>
            <tr className="bg-bg-2/30 text-[11px] uppercase tracking-[0.08em] text-ink-mute">
              <th className="text-left py-2.5 px-4 font-medium">Customer</th>
              <th className="text-right py-2.5 px-4 font-medium">Avg days late</th>
              <th className="text-right py-2.5 px-4 font-medium">Outstanding</th>
              <th className="text-right py-2.5 px-4 font-medium">Invoices</th>
            </tr>
          </thead>
          <tbody>
            {data.worst_payers.length === 0 ? (
              <tr><td colSpan={4} className="py-8 text-center text-ink-soft">No slow payers — all invoices settled within terms.</td></tr>
            ) : (
              data.worst_payers.map((p) => (
                <tr key={p.customer} className="border-t border-rule">
                  <td className="py-2 px-4 text-ink">{p.customer}</td>
                  <td className="py-2 px-4 text-right tabular-nums">
                    <span className={p.avg_days_late > 30 ? "text-red-700 font-medium" : p.avg_days_late > 14 ? "text-amber-700" : "text-ink"}>
                      {p.avg_days_late.toFixed(0)} days
                    </span>
                  </td>
                  <td className="py-2 px-4 text-right tabular-nums text-ink">{money(p.outstanding, currency)}</td>
                  <td className="py-2 px-4 text-right tabular-nums text-ink-soft">{p.invoices_count}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// recharts doesn't support per-bar fill via a child easily — `<Cell>` is
// the right primitive. Imported here to keep the JSX clean.
import { Cell } from "recharts";
function CellOverride(props: { fill: string }) {
  return <Cell {...props} />;
}

function KpiTile({
  label, value, sub, tone,
}: { label: string; value: string; sub?: string; tone?: "ok" | "watch" | "warn" }) {
  const tones = {
    ok: "border-rule",
    watch: "border-amber-200 bg-amber-50/40",
    warn: "border-red-200 bg-red-50/40",
    undefined: "border-rule",
  } as const;
  return (
    <div className={`rounded-xl border ${tones[tone ?? "undefined"]} bg-surface px-4 py-3`}>
      <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium">{label}</div>
      <div className="mt-1.5 font-serif text-[22px] text-ink leading-tight">{value}</div>
      {sub && <div className="mt-0.5 text-[11.5px] text-ink-soft truncate">{sub}</div>}
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
