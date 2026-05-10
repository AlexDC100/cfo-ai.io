// Products — SKU explorer + decision-bucket grid + top actions today.
//
// Step 3 of FIX-NOW: this page absorbs the SKU + bucket content that was
// stripped out of Dashboard. Driven by the active period's invoice register.
// For periods without invoice data, renders the per-page empty-state
// CTA per the H.5 contract.
//
// Data path: useActivePeriod() → invoices → productsAnalytics(invoices) →
// per-bucket counts + top actions + SKU rollup. The Phase G read API
// (/api/period/:id/products) returns the same shape; swap the call site
// once it ships.

import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  ArrowDown,
  Boxes,
  PackageX,
  Search,
  ShoppingCart,
  Sparkles,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { AppShell } from "@/components/cfo/AppShell";
import { useActivePeriod } from "@/lib/activePeriod";
import { productsAnalytics, type ProductBucket } from "@/lib/invoiceAnalytics";

const BUCKET_ORDER: ProductBucket[] = ["liquidate", "fix", "reduce", "watch", "scale", "protect"];

const BUCKET_META: Record<ProductBucket, { label: string; tone: string; icon: typeof PackageX; description: string }> = {
  liquidate: { label: "Liquidate", tone: "border-red-300/60 bg-red-50/60 text-red-700",       icon: PackageX,     description: "Dead stock — clear inventory" },
  fix:       { label: "Fix",       tone: "border-amber-300/60 bg-amber-50/60 text-amber-700", icon: TrendingDown, description: "Underperforming — renegotiate or reposition" },
  reduce:    { label: "Reduce",    tone: "border-orange-300/60 bg-orange-50/60 text-orange-700", icon: ArrowDown,  description: "Declining velocity — trim reorders" },
  watch:     { label: "Watch",     tone: "border-blue-300/60 bg-blue-50/60 text-blue-700",    icon: Boxes,        description: "Stable mid-tier — monitor" },
  scale:     { label: "Scale",     tone: "border-emerald-300/60 bg-emerald-50/60 text-emerald-700", icon: TrendingUp, description: "Growing fast — invest more" },
  protect:   { label: "Protect",   tone: "border-violet-300/60 bg-violet-50/60 text-violet-700", icon: ShoppingCart, description: "Top revenue — preserve listings" },
};

export default function Products() {
  const period = useActivePeriod();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState("");

  // ─── Empty state ─ no period, or period with statements but no invoice register
  if (!period.isLoaded || !period.invoices || period.invoices.length === 0) {
    return (
      <AppShell>
        <ProductsEmptyState />
      </AppShell>
    );
  }

  return (
    <AppShell>
      <ProductsLoaded
        invoices={period.invoices}
        bucketFilter={(params.get("bucket") as ProductBucket | null) ?? null}
        onSetBucket={(b) => {
          if (!b) params.delete("bucket");
          else params.set("bucket", b);
          setParams(params, { replace: true });
        }}
        search={search}
        onSearch={setSearch}
      />
    </AppShell>
  );
}

function ProductsEmptyState() {
  return (
    <section className="max-w-[680px] mx-auto py-16 text-center" data-testid="products-empty">
      <div className="mx-auto h-14 w-14 rounded-2xl bg-bg-2 text-ink-mute flex items-center justify-center mb-4">
        <Boxes size={22} strokeWidth={1.5} />
      </div>
      <h1 className="font-serif text-[34px] sm:text-[40px] leading-[1.1] tracking-[-0.02em] text-ink">
        No invoice or inventory data yet
      </h1>
      <p className="mt-4 text-[15px] text-ink-soft max-w-[480px] mx-auto">
        Products renders SKU-level rollups, decision buckets, and the top-actions
        queue from your invoice register. Load an invoice-bearing period to see
        them — or open Statements to upload one.
      </p>
      <Link
        to="/dashboard?source=invoices"
        className="mt-6 inline-flex items-center gap-2 h-11 px-5 rounded-lg bg-brand text-paper text-[14px] font-medium hover:bg-brand-d transition-colors"
      >
        Upload an invoice register
      </Link>
    </section>
  );
}

function ProductsLoaded({
  invoices,
  bucketFilter,
  onSetBucket,
  search,
  onSearch,
}: {
  invoices: ReturnType<typeof useActivePeriod>["invoices"];
  bucketFilter: ProductBucket | null;
  onSetBucket: (b: ProductBucket | null) => void;
  search: string;
  onSearch: (s: string) => void;
}) {
  const data = useMemo(() => productsAnalytics(invoices ?? []), [invoices]);
  const period = useActivePeriod();
  const currency = invoices?.[0]?.currency ?? period.statements?.currency ?? "RON";

  const filtered = useMemo(() => {
    let xs = data.skus;
    if (bucketFilter) xs = xs.filter((s) => s.bucket === bucketFilter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      xs = xs.filter((s) => s.sku.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
    }
    return xs.slice(0, 50);
  }, [data, bucketFilter, search]);

  return (
    <>
      <header className="mb-7">
        <div className="label-eyebrow">Products</div>
        <h1 className="mt-2 font-serif text-[36px] leading-[1.1] tracking-[-0.02em]">
          SKU explorer
        </h1>
        <p className="mt-3 text-[14.5px] text-ink-soft max-w-[640px]">
          {data.sku_count.toLocaleString()} SKUs · {money(data.total_revenue, currency)} aggregate revenue · {money(data.dead_stock_ron, currency)} tied up in liquidate-bucket inventory.
        </p>
      </header>

      {/* ROW 2 — Decision buckets (MOVED from Dashboard) */}
      <section className="mb-8">
        <div className="text-[11px] uppercase tracking-[0.12em] text-ink-mute font-medium mb-2">
          Decision buckets
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          {BUCKET_ORDER.map((b) => {
            const m = BUCKET_META[b];
            const isActive = bucketFilter === b;
            const Icon = m.icon;
            return (
              <button
                key={b}
                data-testid={`decision-bucket-${b}`}
                onClick={() => onSetBucket(isActive ? null : b)}
                className={`text-left rounded-xl border ${m.tone} px-3 py-2.5 transition-all hover:-translate-y-0.5 ${isActive ? "ring-2 ring-ink/30" : ""}`}
              >
                <div className="flex items-center gap-1.5 mb-1">
                  <Icon size={11} strokeWidth={2} />
                  <span className="text-[10.5px] uppercase tracking-[0.06em] font-semibold">{m.label}</span>
                </div>
                <div className="font-serif text-[22px] text-ink leading-tight">{data.buckets[b].count}</div>
                <div className="text-[10.5px] text-ink-soft mt-0.5 truncate">{money(data.buckets[b].revenue, currency)}</div>
              </button>
            );
          })}
        </div>
      </section>

      {/* Top actions today (MOVED from Dashboard) */}
      {data.top_actions.length > 0 && (
        <section className="mb-8" data-testid="products-top-actions">
          <div className="text-[11px] uppercase tracking-[0.12em] text-ink-mute font-medium mb-2">
            Top actions today
          </div>
          <ul className="rounded-2xl border border-rule bg-surface overflow-hidden divide-y divide-rule/50">
            {data.top_actions.map((a, i) => (
              <li key={`${a.type}-${a.sku}-${i}`} className="px-4 py-3 flex items-center gap-3" data-testid={`top-action-${a.type}`}>
                <span
                  className={`inline-flex items-center text-[10.5px] font-semibold uppercase tracking-[0.06em] px-2 py-0.5 rounded-full ${
                    a.type === "liquidate" ? "bg-red-50 text-red-700"
                    : a.type === "renegotiate" ? "bg-amber-50 text-amber-700"
                    : "bg-blue-50 text-blue-700"
                  }`}
                >
                  {a.type}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-[13.5px] text-ink truncate">{a.sku}</div>
                  <div className="text-[11.5px] text-ink-soft truncate">{a.reason}</div>
                </div>
                <div className="text-[12.5px] text-emerald-700 font-medium tabular-nums shrink-0">
                  ~{money(a.frees_ron, currency)}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* SKU table */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-[320px]">
          <Search size={14} strokeWidth={1.75} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-mute" />
          <input
            type="text"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search SKU or description"
            className="w-full bg-surface border border-rule rounded-md pl-9 pr-3 py-2 text-[13px] focus:outline-none focus:border-brand"
          />
        </div>
        {bucketFilter && (
          <button
            onClick={() => onSetBucket(null)}
            className="text-[12px] text-ink-soft hover:text-ink underline-offset-2 hover:underline"
          >
            Clear bucket filter ({BUCKET_META[bucketFilter].label})
          </button>
        )}
      </div>
      <div className="rounded-2xl border border-rule bg-surface overflow-hidden">
        <table className="w-full text-[13px]">
          <thead className="bg-bg-2/50 border-b border-rule">
            <tr className="text-left">
              <th className="px-4 py-3 text-[11px] font-medium uppercase tracking-[0.06em] text-ink-soft">SKU</th>
              <th className="px-4 py-3 text-[11px] font-medium uppercase tracking-[0.06em] text-ink-soft">Description</th>
              <th className="px-4 py-3 text-[11px] font-medium uppercase tracking-[0.06em] text-ink-soft">Bucket</th>
              <th className="px-4 py-3 text-[11px] font-medium uppercase tracking-[0.06em] text-ink-soft text-right">Revenue</th>
              <th className="px-4 py-3 text-[11px] font-medium uppercase tracking-[0.06em] text-ink-soft text-right">Share</th>
              <th className="px-4 py-3 text-[11px] font-medium uppercase tracking-[0.06em] text-ink-soft text-right">Last sold</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule/40">
            {filtered.map((s) => {
              const m = BUCKET_META[s.bucket];
              return (
                <tr key={s.sku} className="hover:bg-bg-2/40">
                  <td className="px-4 py-3 text-ink font-mono text-[12.5px]">{s.sku}</td>
                  <td className="px-4 py-3 text-ink-soft">{s.description}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center text-[10.5px] font-semibold uppercase tracking-[0.06em] px-2 py-0.5 rounded-full border ${m.tone}`}>
                      {m.label}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-ink">{money(s.revenue, currency)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-ink-soft">{(s.share * 100).toFixed(1)}%</td>
                  <td className="px-4 py-3 text-right text-ink-soft">{formatDate(s.last_sold)} ({s.days_since_last_sold}d)</td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-ink-soft">
                  No products match this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-[12px] text-ink-mute">
        Showing {filtered.length} of {data.skus.length} SKUs
        {bucketFilter && <> · filtered to <span className="text-ink">{BUCKET_META[bucketFilter].label.toLowerCase()}</span></>}
      </p>
    </>
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
