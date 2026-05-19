// Customers tab — concentration analytics over the active invoice register.
//
// Data source today: client-side `customerAnalytics(invoices)`. When the
// /api/invoices/customers endpoint exists, swap the call site without
// touching the render — the output shape is identical.

import { useMemo } from "react";
import { AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";
import { customerAnalytics, type Invoice } from "@/lib/invoiceAnalytics";

interface Props {
  invoices: Invoice[];
  currency?: string;
}

export function CustomersTab({ invoices, currency = "RON" }: Props) {
  const data = useMemo(() => customerAnalytics(invoices), [invoices]);
  const concentrationRisk = data.top_1_share > 0.30 || data.top_5_share > 0.70;

  return (
    <div className="space-y-6">
      {/* KPI strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiTile
          label="Top customer"
          value={`${(data.top_1_share * 100).toFixed(1)}%`}
          sub={data.customers[0] ? `${data.customers[0].name.slice(0, 22)}${data.customers[0].name.length > 22 ? "…" : ""}` : "—"}
          tone={data.top_1_share > 0.30 ? "warn" : data.top_1_share > 0.20 ? "watch" : "ok"}
        />
        <KpiTile
          label="Top 5 share"
          value={`${(data.top_5_share * 100).toFixed(1)}%`}
          sub={`Of ${money(data.total_revenue, currency)} revenue`}
          tone={data.top_5_share > 0.70 ? "warn" : data.top_5_share > 0.50 ? "watch" : "ok"}
        />
        <KpiTile
          label="Top 10 share"
          value={`${(data.top_10_share * 100).toFixed(1)}%`}
          sub={`${data.customer_count} customers total`}
        />
        <KpiTile
          label="HHI"
          value={data.hhi.toFixed(0)}
          sub={hhiBand(data.hhi)}
          tone={data.hhi > 2500 ? "warn" : data.hhi > 1500 ? "watch" : "ok"}
        />
      </div>

      {/* Concentration banner */}
      {concentrationRisk && (
        <div className="rounded-2xl border border-amber-300/60 bg-amber-50 text-amber-800 px-4 py-3 flex items-start gap-3">
          <AlertTriangle size={16} className="text-amber-600 mt-0.5 shrink-0" strokeWidth={1.75} />
          <div className="text-[13px] leading-relaxed">
            <strong>Customer concentration risk:</strong>{" "}
            {data.top_1_share > 0.30 && (
              <>your largest customer drives <strong>{(data.top_1_share * 100).toFixed(1)}%</strong> of revenue. </>
            )}
            {data.top_5_share > 0.70 && (
              <>top 5 customers control <strong>{(data.top_5_share * 100).toFixed(1)}%</strong>. </>
            )}
            Single-tenant exits at this level can crater monthly cash flow — diversify
            actively, or build retention insurance into your contracts.
          </div>
        </div>
      )}

      {/* Revenue table with horizontal share bars */}
      <div className="rounded-2xl border border-rule bg-surface overflow-hidden">
        <div className="px-5 py-3 bg-bg-2/40 border-b border-rule flex items-center justify-between">
          <h2 className="font-serif text-[18px] text-ink">Customers · revenue & share</h2>
          <span className="text-[11px] uppercase tracking-[0.1em] text-ink-mute font-medium">
            {data.customer_count} total
          </span>
        </div>
        <table className="w-full text-[13px]">
          <thead>
            <tr className="bg-bg-2/30 text-[11px] uppercase tracking-[0.08em] text-ink-mute">
              <th className="text-left py-2.5 px-4 font-medium">#</th>
              <th className="text-left py-2.5 px-4 font-medium">Customer</th>
              <th className="text-right py-2.5 px-4 font-medium">Revenue</th>
              <th className="text-right py-2.5 px-4 font-medium">Share</th>
              <th className="text-right py-2.5 px-4 font-medium">Invoices</th>
              <th className="text-right py-2.5 px-4 font-medium">Avg invoice</th>
              <th className="text-right py-2.5 px-4 font-medium">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {data.customers.slice(0, 50).map((c, i) => (
              <tr key={c.name} className="border-t border-rule">
                <td className="py-2 px-4 text-ink-mute tabular-nums">{i + 1}</td>
                <td className="py-2 px-4 text-ink">{c.name}</td>
                <td className="py-2 px-4 text-right tabular-nums text-ink">{money(c.revenue, currency)}</td>
                <td className="py-2 px-4">
                  <div className="flex items-center justify-end gap-2">
                    <div className="w-[80px] sm:w-[120px] h-1.5 rounded-full bg-bg-2 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-brand"
                        style={{ width: `${Math.min(100, c.share * 100 * 4)}%` }}
                      />
                    </div>
                    <span className="tabular-nums text-ink-soft min-w-[44px] text-right">
                      {(c.share * 100).toFixed(1)}%
                    </span>
                  </div>
                </td>
                <td className="py-2 px-4 text-right tabular-nums text-ink-soft">{c.invoices_count}</td>
                <td className="py-2 px-4 text-right tabular-nums text-ink-soft">{money(c.avg_invoice, currency)}</td>
                <td className="py-2 px-4 text-right text-ink-soft">{formatDate(c.last_invoice_date)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.customers.length > 50 && (
          <div className="px-5 py-2 border-t border-rule text-[12px] text-ink-mute text-center">
            Showing top 50 of {data.customers.length}.
          </div>
        )}
      </div>
    </div>
  );
}

function hhiBand(hhi: number): string {
  if (hhi < 1500) return "Competitive (< 1,500)";
  if (hhi < 2500) return "Moderately concentrated";
  return "Highly concentrated (> 2,500)";
}

function KpiTile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "ok" | "watch" | "warn";
}) {
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

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}
