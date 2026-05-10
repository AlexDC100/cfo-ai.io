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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  AlertCircle,
  ArrowDown,
  Boxes,
  Check,
  Loader2,
  PackageX,
  RefreshCcw,
  Search,
  ShoppingCart,
  Sparkles,
  TrendingDown,
  TrendingUp,
  UploadCloud,
} from "lucide-react";
import { AppShell } from "@/components/cfo/AppShell";
import { useActivePeriod } from "@/lib/activePeriod";
import { productsAnalytics, type ProductBucket } from "@/lib/invoiceAnalytics";
import {
  enqueuePipeline,
  getSupabase,
  subscribeToDocumentStatus,
  uploadDocument,
  type DocumentStatus,
} from "@/lib/supabase";
import { useToast } from "@/hooks/use-toast";

interface SkuAnalysis {
  id: string;
  document: { id: string; filename: string; status: DocumentStatus; scope: string; created_at: string; error: string | null };
  briefing: string | null;
  summary: Record<string, unknown> | null;
  recommendations: Array<{ severity?: string; title?: string; rationale?: string; actions?: string[]; estimated_ron_impact?: number | null }>;
  model: string | null;
  created_at: string;
}

interface InflightDoc {
  id: string;
  filename: string;
  status: DocumentStatus;
  error?: string | null;
}

async function fetchLatestSkuAnalysis(): Promise<{ analysis: SkuAnalysis | null }> {
  const supabase = getSupabase();
  if (!supabase) return { analysis: null };
  const { data: session } = await supabase.auth.getSession();
  const token = session.session?.access_token;
  if (!token) return { analysis: null };
  const apiUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";
  const res = await fetch(`${apiUrl}/api/sku-analysis/latest`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return { analysis: null };
  return (await res.json()) as { analysis: SkuAnalysis | null };
}

async function fetchInflightSkuDoc(): Promise<InflightDoc | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data: session } = await supabase.auth.getSession();
  const token = session.session?.access_token;
  if (!token) return null;
  const apiUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";
  const res = await fetch(`${apiUrl}/api/sku-analysis/inflight`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { document: { id: string; original_filename: string; status: DocumentStatus; error: string | null } | null };
  if (!data.document) return null;
  return {
    id: data.document.id,
    filename: data.document.original_filename,
    status: data.document.status,
    error: data.document.error,
  };
}

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

  // SKU analysis is independent of useActivePeriod (which is the financial-
  // statement data model). Products fetches scope='sku' analyses directly.
  const [skuAnalysis, setSkuAnalysis] = useState<SkuAnalysis | null>(null);
  const [inflight, setInflight] = useState<InflightDoc | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    const [{ analysis }, inflightDoc] = await Promise.all([fetchLatestSkuAnalysis(), fetchInflightSkuDoc()]);
    setSkuAnalysis(analysis);
    setInflight(inflightDoc);
    setLoading(false);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Subscribe to document status changes so the in-flight progress card
  // updates in real time + flips to the analysis when the run completes.
  useEffect(() => {
    if (!inflight) return;
    const unsub = subscribeToDocumentStatus(inflight.id, (next) => {
      setInflight((prev) => prev && { ...prev, status: next.status, error: next.error ?? null });
      if (next.status === "analyzed" || next.status === "failed") {
        // Pipeline terminal state — re-fetch to grab the persisted analysis.
        void refresh();
      }
    });
    return unsub;
  }, [inflight?.id, refresh]);

  // Loaded surface — prefer real invoice rows when the active period has
  // them (e.g. a sample dataset). Otherwise render the SKU briefing card.
  const hasInvoiceRows = period.isLoaded && period.invoices && period.invoices.length > 0;
  const hasSkuAnalysis = !!skuAnalysis;

  if (loading) {
    return (
      <AppShell>
        <section className="max-w-[680px] mx-auto py-16 text-center">
          <Loader2 size={20} strokeWidth={1.5} className="animate-spin mx-auto text-ink-mute mb-3" />
          <p className="text-[13px] text-ink-soft">Loading SKU data…</p>
        </section>
      </AppShell>
    );
  }

  return (
    <AppShell>
      {inflight && (
        <ProductsInflightCard inflight={inflight} />
      )}
      {!inflight && !hasInvoiceRows && !hasSkuAnalysis && (
        <ProductsEmptyState onUploaded={refresh} />
      )}
      {!inflight && hasSkuAnalysis && !hasInvoiceRows && skuAnalysis && (
        <ProductsBriefing analysis={skuAnalysis} onReplace={refresh} />
      )}
      {hasInvoiceRows && (
        <ProductsLoaded
          invoices={period.invoices!}
          bucketFilter={(params.get("bucket") as ProductBucket | null) ?? null}
          onSetBucket={(b) => {
            if (!b) params.delete("bucket");
            else params.set("bucket", b);
            setParams(params, { replace: true });
          }}
          search={search}
          onSearch={setSearch}
        />
      )}
    </AppShell>
  );
}

function ProductsInflightCard({ inflight }: { inflight: InflightDoc }) {
  const STAGES: Record<DocumentStatus, { label: string; ordinal: number }> = {
    queued:     { label: "Queued for analysis…",  ordinal: 0 },
    extracting: { label: "Reading the workbook…", ordinal: 1 },
    mapping:    { label: "Categorizing rollups…", ordinal: 2 },
    computing:  { label: "Computing margins…",    ordinal: 3 },
    narrating:  { label: "Generating insights…",  ordinal: 4 },
    analyzed:   { label: "Analysis ready",        ordinal: 6 },
    failed:     { label: "Analysis failed",       ordinal: 0 },
  };
  const total = 6;
  const stage = STAGES[inflight.status];
  const isFailed = inflight.status === "failed";
  return (
    <section className="max-w-[680px] mx-auto py-16">
      <div data-testid="products-inflight" className="rounded-2xl border border-rule bg-surface p-7">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            {isFailed
              ? <AlertCircle size={16} className="text-alert" strokeWidth={2} />
              : <Loader2 size={16} className="text-brand animate-spin" strokeWidth={2} />}
            <span className="text-[14px] font-medium text-ink">
              {isFailed ? "Couldn't finish analysis" : "Analyzing your SKU data…"}
            </span>
          </div>
          {!isFailed && (
            <span className="text-[11.5px] text-ink-mute tabular-nums">Step {stage.ordinal} of {total}</span>
          )}
        </div>
        <div className="text-[13px] text-ink-soft mb-3">
          <span className="text-ink font-medium">{inflight.filename}</span>{" "}· {stage.label}
        </div>
        {!isFailed && (
          <div className="h-1.5 rounded-full bg-bg-2 overflow-hidden">
            <div
              className="h-full bg-brand transition-all duration-500"
              style={{ width: `${(stage.ordinal / total) * 100}%` }}
            />
          </div>
        )}
        {isFailed && inflight.error && (
          <div className="mt-2 rounded-md border border-alert/30 bg-alert/5 px-3 py-2 text-[12px] text-alert">
            {inflight.error}
          </div>
        )}
      </div>
    </section>
  );
}

function ProductsBriefing({ analysis, onReplace }: { analysis: SkuAnalysis; onReplace: () => void }) {
  const { document: docInfo, briefing, recommendations } = analysis;
  const summary = (analysis.summary ?? {}) as Record<string, unknown>;
  const headlineTotal = typeof summary.headline_total === "number" ? summary.headline_total : null;
  const headlineLabel = typeof summary.headline_label === "string" ? summary.headline_label : null;
  const rowCount = typeof summary.row_count === "number" ? summary.row_count : null;
  const topRecords = Array.isArray(summary.top_records) ? (summary.top_records as string[]) : [];

  return (
    <div data-testid="products-briefing" className="space-y-6 max-w-[1080px]">
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="label-eyebrow">SKU analysis</div>
          <h1 className="mt-2 font-serif text-[30px] sm:text-[34px] leading-[1.1] tracking-[-0.02em] text-ink">
            {docInfo.filename}
          </h1>
          <p className="mt-1 text-[12.5px] text-ink-mute">
            Analyzed {new Date(analysis.created_at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}
            {analysis.model ? ` · ${analysis.model}` : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={onReplace}
          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-rule bg-surface text-[12.5px] font-medium text-ink hover:bg-bg-2 transition-colors"
        >
          <RefreshCcw size={12} strokeWidth={1.75} />
          Refresh
        </button>
      </header>

      {(rowCount !== null || headlineTotal !== null || topRecords.length > 0) && (
        <section className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          {rowCount !== null && (
            <div className="rounded-2xl border border-rule bg-surface p-4">
              <div className="text-[11px] uppercase tracking-[0.1em] text-ink-mute font-medium">Rows analyzed</div>
              <div className="mt-1 font-serif text-[24px] text-ink">{rowCount.toLocaleString("en-GB")}</div>
            </div>
          )}
          {headlineTotal !== null && (
            <div className="rounded-2xl border border-rule bg-surface p-4">
              <div className="text-[11px] uppercase tracking-[0.1em] text-ink-mute font-medium">{headlineLabel ?? "Headline total"}</div>
              <div className="mt-1 font-serif text-[24px] text-ink tabular-nums">
                {headlineTotal.toLocaleString("en-GB", { maximumFractionDigits: 0 })}
              </div>
            </div>
          )}
          {topRecords.length > 0 && (
            <div className="rounded-2xl border border-rule bg-surface p-4 col-span-2 lg:col-span-1">
              <div className="text-[11px] uppercase tracking-[0.1em] text-ink-mute font-medium mb-2">Top records</div>
              <ul className="space-y-1 text-[12.5px] text-ink-soft">
                {topRecords.slice(0, 6).map((r, i) => (
                  <li key={i} className="truncate">· {r}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {briefing && (
        <section className="rounded-2xl border border-brand/25 bg-brand-tint/40 p-5">
          <div className="flex items-center gap-2 text-[10.5px] uppercase tracking-[0.1em] text-brand-d font-medium mb-2">
            <Sparkles size={11} strokeWidth={2} />
            CFO briefing — Opus 4.7
          </div>
          <p className="text-[14px] text-ink leading-relaxed whitespace-pre-line">{briefing}</p>
        </section>
      )}

      {recommendations.length > 0 && (
        <section>
          <div className="label-eyebrow mb-3">Recommendations</div>
          <ul className="space-y-3">
            {recommendations.map((r, i) => {
              const sev = (r.severity ?? "medium").toLowerCase();
              const tone =
                sev === "critical" ? "border-red-300/60 bg-red-50/40" :
                sev === "high"     ? "border-amber-300/60 bg-amber-50/40" :
                sev === "low"      ? "border-blue-300/60 bg-blue-50/40" :
                                     "border-rule bg-surface";
              return (
                <li key={i} data-testid="recommendation-card" className={`rounded-2xl border ${tone} p-5`}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[10.5px] uppercase tracking-[0.06em] font-semibold text-ink-mute px-2 py-0.5 rounded-full bg-bg-2">{sev}</span>
                    <h3 className="font-serif text-[16px] text-ink">{r.title ?? "Untitled"}</h3>
                  </div>
                  {r.rationale && <p className="mt-1 text-[13px] text-ink-soft leading-snug">{r.rationale}</p>}
                  {r.actions && r.actions.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {r.actions.map((a, j) => (
                        <li key={j} className="text-[13px] text-ink-soft flex items-start gap-1.5">
                          <Check size={11} className="text-brand-d mt-1 shrink-0" strokeWidth={2.25} />
                          <span>{a}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {typeof r.estimated_ron_impact === "number" && (
                    <div className="mt-2 inline-flex items-center text-[11.5px] font-medium text-emerald-700 bg-emerald-50 px-3 py-1 rounded-md">
                      Est. impact: ~RON {Math.round(r.estimated_ron_impact).toLocaleString("en-GB")}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

function ProductsEmptyState({ onUploaded }: { onUploaded: () => void }) {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);

  // Dedicated SKU/inventory upload. Tags the document with scope='sku' so
  // the pipeline routes it to sku_analyses instead of financial_periods —
  // Dashboard / Cash / Profit are NEVER touched by this upload.
  async function handleFile(file: File) {
    const MAX = 25 * 1024 * 1024;
    if (file.size > MAX) {
      toast({
        title: "File too large",
        description: `${(file.size/1_000_000).toFixed(1)} MB exceeds the 25 MB limit.`,
        variant: "destructive",
      });
      return;
    }
    setBusy(true);
    const { row, error } = await uploadDocument(file, { scope: "sku" });
    if (!row) {
      setBusy(false);
      toast({ title: "Upload failed", description: error ?? "Unknown error.", variant: "destructive" });
      return;
    }
    const enqueued = await enqueuePipeline(row.id);
    setBusy(false);
    if (!enqueued) {
      toast({ title: "Couldn't start analysis", description: "Backend is unreachable.", variant: "destructive" });
      return;
    }
    toast({ title: "Analysis started", description: file.name });
    // Trigger parent refresh — the inflight document is now visible to
    // /api/sku-analysis/inflight and the parent will subscribe.
    onUploaded();
  }

  return (
    <section className="max-w-[720px] mx-auto py-12" data-testid="products-empty">
      <div className="text-center mb-6">
        <div className="mx-auto h-14 w-14 rounded-2xl bg-bg-2 text-ink-mute flex items-center justify-center mb-4">
          <Boxes size={22} strokeWidth={1.5} />
        </div>
        <h1 className="font-serif text-[34px] sm:text-[40px] leading-[1.1] tracking-[-0.02em] text-ink">
          Upload your SKU data to begin
        </h1>
        <p className="mt-4 text-[15px] text-ink-soft max-w-[520px] mx-auto">
          The trading analysis (XLSX), invoice register, or sales-by-product
          export. CFO AI extracts category / brand / channel rollups, computes
          working-capital impact per SKU, and surfaces the top decisions —
          completely separate from your financial-statement uploads.
        </p>
      </div>

      <div
        data-testid="products-upload-dropzone"
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; if (f) void handleFile(f); }}
        className={`rounded-2xl border-2 border-dashed transition-colors ${drag ? "border-brand bg-brand/5" : "border-rule bg-bg-2/30"} px-6 py-10 text-center`}
      >
        <UploadCloud size={28} strokeWidth={1.5} className="mx-auto text-brand-d mb-3" />
        <h3 className="font-serif text-[18px] text-ink">Drop your trading analysis or invoice register</h3>
        <p className="text-[12.5px] text-ink-soft mt-1 max-w-[420px] mx-auto">
          XLSX · CSV — multi-sheet workbooks supported. Drag-and-drop or click below.
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
          className="mt-4 inline-flex items-center gap-2 h-10 px-4 rounded-lg bg-brand text-paper text-[13px] font-medium hover:bg-brand-d transition-colors disabled:opacity-50"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <UploadCloud size={13} strokeWidth={2} />}
          {busy ? "Uploading…" : "Choose a file"}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); }}
        />
        <p className="mt-4 text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium">
          <Sparkles size={9} strokeWidth={2} className="inline mr-1" />
          Detect · extract sheets · category/SKU rollup · Opus 4.7 narrative
        </p>
      </div>
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
