// VAT tab — 4-tile reconciliation summary + flagged-invoices table.
//
// The D394 reconciliation row stays null until the user uploads their D394
// declaration; the inline CTA opens the upload pre-selected to that doc type.

import { useMemo } from "react";
import { Upload } from "lucide-react";
import { vatAnalytics, type Invoice } from "@/lib/invoiceAnalytics";

interface Props {
  invoices: Invoice[];
  currency?: string;
  /** When the D394 declaration is parsed elsewhere, pass the reported net VAT
   *  here to populate the reconciliation_delta row. */
  vatPerD394?: number | null;
  onUploadD394?: () => void;
}

export function VatTab({ invoices, currency = "RON", vatPerD394 = null, onUploadD394 }: Props) {
  const data = useMemo(() => vatAnalytics(invoices, vatPerD394), [invoices, vatPerD394]);

  return (
    <div className="space-y-6">
      {/* 4-tile reconciliation summary */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Tile
          label="VAT collected (sales)"
          value={money(data.invoiced_vat_collected, currency)}
          sub={`${invoices.filter((i) => i.direction === "sale").length} sales invoices`}
          tone="info"
        />
        <Tile
          label="VAT paid (purchases)"
          value={money(data.invoiced_vat_paid, currency)}
          sub={`${invoices.filter((i) => i.direction === "purchase").length} purchase invoices`}
          tone="info"
        />
        <Tile
          label="Net VAT (payable)"
          value={money(data.net_vat, currency)}
          sub={data.net_vat > 0 ? "To remit to ANAF" : "Refund position"}
          tone="ink"
        />
        <Tile
          label="D394 declared"
          value={data.vat_per_d394 != null ? money(data.vat_per_d394, currency) : "—"}
          sub={
            data.vat_per_d394 == null
              ? "Upload D394 to reconcile"
              : data.reconciliation_delta != null && Math.abs(data.reconciliation_delta) > 1
                ? `Δ ${money(data.reconciliation_delta, currency)}`
                : "Reconciles ✓"
          }
          tone={
            data.vat_per_d394 == null
              ? "muted"
              : data.reconciliation_delta != null && Math.abs(data.reconciliation_delta) > 100
                ? "warn"
                : "ok"
          }
        />
      </div>

      {/* D394 upload CTA — appears only when D394 hasn't been ingested yet */}
      {data.vat_per_d394 == null && (
        <div className="rounded-2xl border border-rule bg-bg-2/30 px-5 py-4 flex items-center gap-3">
          <div className="h-9 w-9 rounded-lg bg-brand-tint text-brand-d flex items-center justify-center shrink-0">
            <Upload size={16} strokeWidth={1.75} />
          </div>
          <div className="flex-1">
            <div className="text-[13.5px] text-ink font-medium">Reconcile against your ANAF D394 filing</div>
            <div className="text-[12px] text-ink-soft mt-0.5">
              Upload the .xml or .pdf you submitted to ANAF and we'll surface any
              line-by-line mismatches between invoices and the declaration.
            </div>
          </div>
          <button
            type="button"
            onClick={onUploadD394}
            className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-ink text-paper text-[12.5px] font-medium hover:bg-ink/90 transition-colors shrink-0"
          >
            <Upload size={13} strokeWidth={2} />
            Upload D394
          </button>
        </div>
      )}

      {/* Flagged-invoice table */}
      <div className="rounded-2xl border border-rule bg-surface overflow-hidden">
        <div className="px-5 py-3 bg-bg-2/40 border-b border-rule flex items-center justify-between">
          <h2 className="font-serif text-[18px] text-ink">Flagged invoices</h2>
          <span className="text-[11px] uppercase tracking-[0.1em] text-ink-mute font-medium">
            {data.flagged_invoices.length} flagged
          </span>
        </div>
        {data.flagged_invoices.length === 0 ? (
          <div className="px-6 py-12 text-center text-ink-soft text-[13px]">
            No mismatches detected — VAT amounts and rates check out across all invoices.
          </div>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="bg-bg-2/30 text-[11px] uppercase tracking-[0.08em] text-ink-mute">
                <th className="text-left py-2.5 px-4 font-medium">Severity</th>
                <th className="text-left py-2.5 px-4 font-medium">Invoice</th>
                <th className="text-left py-2.5 px-4 font-medium">Customer</th>
                <th className="text-left py-2.5 px-4 font-medium">Reason</th>
                <th className="text-right py-2.5 px-4 font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {data.flagged_invoices.map((f) => (
                <tr key={f.id} className="border-t border-rule">
                  <td className="py-2 px-4">
                    <span
                      className={`inline-flex items-center text-[10.5px] font-semibold uppercase tracking-[0.06em] px-2 py-0.5 rounded-full ${
                        f.severity === "high"
                          ? "bg-red-50 text-red-700"
                          : f.severity === "medium"
                            ? "bg-amber-50 text-amber-700"
                            : "bg-blue-50 text-blue-700"
                      }`}
                    >
                      {f.severity}
                    </span>
                  </td>
                  <td className="py-2 px-4 text-ink font-mono text-[12px]">{f.invoice_no}</td>
                  <td className="py-2 px-4 text-ink-soft truncate max-w-[180px]">{f.customer_name}</td>
                  <td className="py-2 px-4 text-ink-soft">{f.reason}</td>
                  <td className="py-2 px-4 text-right tabular-nums text-ink">{money(f.amount, currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Tile({
  label, value, sub, tone,
}: { label: string; value: string; sub?: string; tone: "info" | "ok" | "warn" | "muted" | "ink" }) {
  const tones = {
    info: "border-blue-200 bg-blue-50/40",
    ok:   "border-emerald-200 bg-emerald-50/40",
    warn: "border-red-200 bg-red-50/40",
    muted: "border-rule bg-bg-2/30",
    ink:  "border-rule bg-surface",
  } as const;
  return (
    <div className={`rounded-xl border ${tones[tone]} px-4 py-3`}>
      <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium">{label}</div>
      <div className="mt-2 num-hero text-[30px] text-ink leading-none">{value}</div>
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
