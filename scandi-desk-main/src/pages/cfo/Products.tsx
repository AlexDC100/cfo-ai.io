// Products — full SKU portfolio with virtualized table.
//
// One row per unique product_name (406 for the user's trading-analysis
// file), classified deterministically by the Python engine. Filters,
// search, and sort are client-side over the full payload — the API
// returns the whole portfolio in one request (~150KB for 400 SKUs)
// because the table virtualizes via @tanstack/react-virtual.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertCircle,
  Boxes,
  Check,
  Loader2,
  Search,
  Sparkles,
  UploadCloud,
} from "lucide-react";
import { AppShell } from "@/components/cfo/AppShell";
import {
  enqueuePipeline,
  getSupabase,
  subscribeToDocumentStatus,
  uploadDocument,
  type DocumentStatus,
} from "@/lib/supabase";
import { useToast } from "@/hooks/use-toast";

// ─── Types ──────────────────────────────────────────────────────────────────

type Classification =
  | "anchor" | "anchor_alert" | "keep" | "watch"
  | "eliminate" | "wind_down" | "scale";

interface SkuAggregate {
  id: string;
  product_name: string;
  brand: string | null;
  category: string | null;
  volume_tons: number | null;
  niv_krn: number | null;
  gm_krn: number | null;
  gm_pct: number | null;
  classification: Classification;
  classification_reason: string | null;
  channels_present: string[] | null;
  clients_present: string[] | null;
  line_row_count: number | null;
}

interface DatasetPayload {
  dataset: {
    id: string;
    label: string;
    source_filename: string | null;
    row_count: number | null;
    sku_count: number | null;
    uploaded_at: string;
  };
  totals: {
    sku_count: number;
    classification_counts: Partial<Record<Classification, number>>;
    volume_tons: number;
    niv_krn: number;
    gm_krn: number;
    losses_krn: number;
    category_count: number;
    brand_count: number;
    categories: string[];
    brands: string[];
  };
  skus: SkuAggregate[];
}

interface DatasetSummary {
  id: string;
  label: string;
  source_filename: string | null;
  row_count: number | null;
  sku_count: number | null;
  uploaded_at: string;
  is_active: boolean;
  document_status: DocumentStatus | null;
}

interface DatasetsListPayload {
  active_dataset_id: string | null;
  datasets: DatasetSummary[];
}

interface InflightDoc {
  id: string;
  filename: string;
  status: DocumentStatus;
  error?: string | null;
}

// ─── API helpers ────────────────────────────────────────────────────────────

async function authHeader(): Promise<Record<string, string> | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : null;
}

const apiBase = (): string =>
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";

async function fetchDatasets(): Promise<DatasetsListPayload | null> {
  const h = await authHeader();
  if (!h) return null;
  const r = await fetch(`${apiBase()}/api/sales-datasets`, { headers: h });
  if (!r.ok) return null;
  return (await r.json()) as DatasetsListPayload;
}

async function fetchDatasetSkus(datasetId: string): Promise<DatasetPayload | null> {
  const h = await authHeader();
  if (!h) return null;
  const r = await fetch(`${apiBase()}/api/sales-datasets/${datasetId}/skus`, { headers: h });
  if (!r.ok) return null;
  return (await r.json()) as DatasetPayload;
}

async function fetchInflight(): Promise<InflightDoc | null> {
  const h = await authHeader();
  if (!h) return null;
  const r = await fetch(`${apiBase()}/api/sku-analysis/inflight`, { headers: h });
  if (!r.ok) return null;
  const j = await r.json() as { document: { id: string; original_filename: string; status: DocumentStatus; error: string | null } | null };
  return j.document ? { id: j.document.id, filename: j.document.original_filename, status: j.document.status, error: j.document.error } : null;
}

// ─── Bucket meta ────────────────────────────────────────────────────────────

const BUCKET_META: Record<Classification, { label: string; dot: string; rowTint: string }> = {
  eliminate:    { label: "Eliminate",    dot: "bg-red-500",     rowTint: "" },
  wind_down:    { label: "Wind down",    dot: "bg-orange-500",  rowTint: "" },
  watch:        { label: "Watch",        dot: "bg-amber-500",   rowTint: "" },
  keep:         { label: "Keep",         dot: "bg-ink-mute",    rowTint: "" },
  anchor_alert: { label: "Anchor alert", dot: "bg-amber-500",   rowTint: "" },
  scale:        { label: "Scale",        dot: "bg-blue-500",    rowTint: "" },
  anchor:       { label: "Anchor",       dot: "bg-emerald-500", rowTint: "" },
};

const FILTER_ORDER: Classification[] = ["eliminate", "wind_down", "watch", "anchor_alert", "scale", "anchor", "keep"];

// ─── Page ───────────────────────────────────────────────────────────────────

export default function Products() {
  const [params, setParams] = useSearchParams();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [sortKey, setSortKey] = useState<"gm_krn" | "gm_pct" | "volume_tons" | "niv_krn" | "name">("gm_krn");
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");

  // Debounce search 200ms
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 200);
    return () => clearTimeout(t);
  }, [search]);

  // Datasets list — drives the dataset selector and the active id
  const { data: datasetsPayload, isLoading: loadingDatasets } = useQuery({
    queryKey: ["sales-datasets"],
    queryFn: fetchDatasets,
  });
  const activeDatasetId = params.get("dataset") ?? datasetsPayload?.active_dataset_id ?? null;

  // Active dataset's SKUs
  const { data: dsPayload, isLoading: loadingSkus } = useQuery({
    queryKey: ["sales-dataset", activeDatasetId],
    queryFn: () => activeDatasetId ? fetchDatasetSkus(activeDatasetId) : Promise.resolve(null),
    enabled: !!activeDatasetId,
  });

  const { data: inflight } = useQuery({
    queryKey: ["sku-analysis", "inflight"],
    queryFn: fetchInflight,
  });

  // Live status — invalidate datasets list when an inflight upload terminates
  useEffect(() => {
    if (!inflight) return;
    const unsub = subscribeToDocumentStatus(inflight.id, (next) => {
      if (next.status === "analyzed" || next.status === "failed") {
        void qc.invalidateQueries({ queryKey: ["sales-datasets"] });
        void qc.invalidateQueries({ queryKey: ["sku-analysis", "inflight"] });
      }
    });
    return unsub;
  }, [inflight?.id, qc]);

  const refresh = useCallback(async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["sales-datasets"] }),
      qc.invalidateQueries({ queryKey: ["sales-dataset", activeDatasetId] }),
      qc.invalidateQueries({ queryKey: ["sku-analysis", "inflight"] }),
    ]);
  }, [qc, activeDatasetId]);

  // ── Hooks above any early return (rules of hooks)
  const activeFilters = useMemo(() => {
    const raw = params.get("state");
    return new Set<Classification>(
      raw ? (raw.split(",").filter(Boolean) as Classification[]) : [],
    );
  }, [params]);
  const channelFilter = params.get("channel") ?? "";
  const categoryFilter = params.get("category") ?? "";
  const brandFilter = params.get("brand") ?? "";

  const filtered = useMemo<SkuAggregate[]>(() => {
    const skus = dsPayload?.skus ?? [];
    let xs = skus;
    if (activeFilters.size > 0) xs = xs.filter((s) => activeFilters.has(s.classification));
    if (channelFilter) xs = xs.filter((s) => (s.channels_present ?? []).includes(channelFilter));
    if (categoryFilter) xs = xs.filter((s) => s.category === categoryFilter);
    if (brandFilter) xs = xs.filter((s) => s.brand === brandFilter);
    const q = debouncedSearch.trim().toLowerCase();
    if (q) {
      xs = xs.filter((s) =>
        s.product_name.toLowerCase().includes(q)
        || (s.brand ?? "").toLowerCase().includes(q)
        || (s.category ?? "").toLowerCase().includes(q),
      );
    }
    const cmp = (a: SkuAggregate, b: SkuAggregate): number => {
      let av: number | string;
      let bv: number | string;
      switch (sortKey) {
        case "name":        av = a.product_name; bv = b.product_name; break;
        case "gm_pct":      av = a.gm_pct ?? 0; bv = b.gm_pct ?? 0; break;
        case "volume_tons": av = a.volume_tons ?? 0; bv = b.volume_tons ?? 0; break;
        case "niv_krn":     av = a.niv_krn ?? 0; bv = b.niv_krn ?? 0; break;
        case "gm_krn":
        default:            av = a.gm_krn ?? 0; bv = b.gm_krn ?? 0; break;
      }
      if (typeof av === "string" && typeof bv === "string") {
        return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      return sortDir === "asc" ? (av as number) - (bv as number) : (bv as number) - (av as number);
    };
    return [...xs].sort(cmp);
  }, [dsPayload, activeFilters, channelFilter, categoryFilter, brandFilter, debouncedSearch, sortKey, sortDir]);

  function setStateFilter(c: Classification | null) {
    setParams((prev) => {
      const sp = new URLSearchParams(prev);
      if (!c) sp.delete("state");
      else {
        const next = new Set(activeFilters);
        if (next.has(c)) next.delete(c); else next.add(c);
        if (next.size === 0) sp.delete("state");
        else sp.set("state", Array.from(next).join(","));
      }
      return sp;
    }, { replace: true });
  }

  function setUrlParam(key: string, value: string | null) {
    setParams((prev) => {
      const sp = new URLSearchParams(prev);
      if (!value) sp.delete(key); else sp.set(key, value);
      return sp;
    }, { replace: true });
  }

  // ── Render branches
  if (loadingDatasets) {
    return (
      <AppShell>
        <div className="max-w-[680px] mx-auto py-16 text-center">
          <Loader2 size={20} className="animate-spin mx-auto text-ink-mute mb-3" />
          <p className="text-[13px] text-ink-soft">Loading datasets…</p>
        </div>
      </AppShell>
    );
  }

  if (inflight) {
    return <AppShell><InflightCard inflight={inflight} /></AppShell>;
  }

  const hasAnyDataset = (datasetsPayload?.datasets.length ?? 0) > 0;

  if (!hasAnyDataset) {
    return <AppShell><EmptyState onUploaded={refresh} /></AppShell>;
  }

  if (loadingSkus || !dsPayload) {
    return (
      <AppShell>
        <div className="max-w-[680px] mx-auto py-16 text-center">
          <Loader2 size={20} className="animate-spin mx-auto text-ink-mute mb-3" />
          <p className="text-[13px] text-ink-soft">Loading SKUs…</p>
        </div>
      </AppShell>
    );
  }

  const { totals, dataset } = dsPayload;

  return (
    <AppShell>
      <section className="space-y-6 max-w-[1200px]">
        <header data-testid="portfolio-header">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <div className="label-eyebrow">Portfolio</div>
              <h1 className="mt-2 font-serif text-[34px] sm:text-[40px] leading-[1.05] tracking-[-0.02em] text-ink">
                {totals.sku_count.toLocaleString("en-GB")} unique SKUs across {totals.category_count} categories
              </h1>
              <p className="mt-1 text-[12.5px] text-ink-mute">
                {dataset.label} · {dataset.source_filename} · {dataset.row_count?.toLocaleString("en-GB")} line rows · analyzed {new Date(dataset.uploaded_at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}
              </p>
            </div>
            {/* Dataset switcher pill (full panel UI deferred to Step 4) */}
            <DatasetSwitcher
              datasets={datasetsPayload?.datasets ?? []}
              activeId={activeDatasetId}
              onSwitch={(id) => setUrlParam("dataset", id)}
            />
          </div>

          <div className="mt-6 grid grid-cols-2 lg:grid-cols-6 gap-3">
            <KpiCard data-testid="kpi-sku-count" label="SKUs" value={totals.sku_count.toLocaleString("en-GB")} sub={`${totals.category_count} cats · ${totals.brand_count} brands`} />
            <KpiCard data-testid="kpi-eliminate" label="Eliminate" value={(totals.classification_counts.eliminate ?? 0).toLocaleString("en-GB")} sub={totals.losses_krn < 0 ? `${formatKron(totals.losses_krn)}` : "no losses"} tone="critical" />
            <KpiCard data-testid="kpi-wind-down" label="Wind down" value={(totals.classification_counts.wind_down ?? 0).toLocaleString("en-GB")} sub="sub-decile vol" tone="warn" />
            <KpiCard data-testid="kpi-watch" label="Watch" value={(totals.classification_counts.watch ?? 0).toLocaleString("en-GB")} sub="thin GM" tone="warn" />
            <KpiCard data-testid="kpi-anchor" label="Anchor" value={(totals.classification_counts.anchor ?? 0).toLocaleString("en-GB")} sub="top P90 GM" tone="strong" />
            <KpiCard data-testid="kpi-scale" label="Scale" value={(totals.classification_counts.scale ?? 0).toLocaleString("en-GB")} sub="high margin" tone="strong" />
          </div>
        </header>

        {/* Search + filters */}
        <div className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-2 rounded-lg border border-rule bg-surface px-3 h-9 flex-1 min-w-[260px] max-w-[460px]">
              <Search size={13} className="text-ink-mute" strokeWidth={1.75} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search SKU, brand, category…"
                className="flex-1 bg-transparent text-[13px] outline-none placeholder:text-ink-mute"
              />
            </div>
            <select value={brandFilter} onChange={(e) => setUrlParam("brand", e.target.value || null)} className="h-9 rounded-lg border border-rule bg-surface px-2.5 text-[12.5px] text-ink">
              <option value="">All brands ({totals.brand_count})</option>
              {totals.brands.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
            <select value={categoryFilter} onChange={(e) => setUrlParam("category", e.target.value || null)} className="h-9 rounded-lg border border-rule bg-surface px-2.5 text-[12.5px] text-ink">
              <option value="">All categories ({totals.category_count})</option>
              {totals.categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <select value={channelFilter} onChange={(e) => setUrlParam("channel", e.target.value || null)} className="h-9 rounded-lg border border-rule bg-surface px-2.5 text-[12.5px] text-ink">
              <option value="">All channels</option>
              {(["KA", "DIST", "EXP", "OLN"] as const).map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <select value={`${sortKey}_${sortDir}`} onChange={(e) => { const [k, d] = e.target.value.split("_") as [typeof sortKey, "asc" | "desc"]; setSortKey(k); setSortDir(d); }} data-testid="sort-dropdown" className="h-9 rounded-lg border border-rule bg-surface px-2.5 text-[12.5px] text-ink">
              <option value="gm_krn_desc">Sort: GM ↓ (profit)</option>
              <option value="gm_krn_asc">Sort: GM ↑ (loss-makers first)</option>
              <option value="gm_pct_desc">Sort: GM% ↓</option>
              <option value="gm_pct_asc">Sort: GM% ↑</option>
              <option value="volume_tons_desc">Sort: Volume ↓</option>
              <option value="niv_krn_desc">Sort: NIV ↓</option>
              <option value="name_asc">Sort: Name A→Z</option>
            </select>
            <button onClick={() => exportCsv(filtered, dataset.label)} className="h-9 px-3 rounded-lg border border-rule bg-surface text-[12.5px] text-ink hover:bg-bg-2 transition-colors" data-testid="export-portfolio">
              Export CSV
            </button>
          </div>

          <div className="flex items-center gap-1.5 flex-wrap">
            <Chip testid="chip-all" label="All" count={totals.sku_count} active={activeFilters.size === 0} onClick={() => setStateFilter(null)} />
            {FILTER_ORDER.map((c) => {
              const n = totals.classification_counts[c] ?? 0;
              if (!n) return null;
              return (
                <Chip
                  key={c}
                  testid={`chip-${c}`}
                  label={BUCKET_META[c].label}
                  count={n}
                  dotClass={BUCKET_META[c].dot}
                  active={activeFilters.has(c)}
                  onClick={() => setStateFilter(c)}
                />
              );
            })}
          </div>

          <div data-testid="sku-table-summary" className="text-[11.5px] text-ink-mute">
            Showing {filtered.length.toLocaleString("en-GB")} of {totals.sku_count.toLocaleString("en-GB")} SKUs
          </div>
        </div>

        <SkuTable rows={filtered} />

        <PortfolioTotalsBar totals={totals} />
      </section>
    </AppShell>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function KpiCard({
  label, value, sub, tone, ...rest
}: { label: string; value: string; sub?: string; tone?: "critical" | "warn" | "strong" } & React.HTMLAttributes<HTMLDivElement>) {
  const ring = tone === "critical" ? "border-red-300/60" : tone === "warn" ? "border-amber-300/60" : tone === "strong" ? "border-emerald-300/60" : "border-rule";
  return (
    <div {...rest} className={`rounded-2xl border ${ring} bg-surface p-3.5`}>
      <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium">{label}</div>
      <div className="mt-1 font-serif text-[22px] text-ink leading-tight">{value}</div>
      {sub && <div className="text-[11px] text-ink-soft mt-0.5">{sub}</div>}
    </div>
  );
}

function Chip({
  testid, label, count, active, onClick, dotClass,
}: { testid: string; label: string; count: number; active: boolean; onClick: () => void; dotClass?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testid}
      className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-[12px] border transition-colors ${
        active ? "bg-ink text-paper border-ink" : "bg-surface text-ink-soft border-rule hover:text-ink hover:border-rule-strong"
      }`}
    >
      {dotClass && <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotClass}`} />}
      {label}
      <span className={`ml-0.5 ${active ? "text-paper/70" : "text-ink-mute"}`}>{count}</span>
    </button>
  );
}

function DatasetSwitcher({ datasets, activeId, onSwitch }: {
  datasets: DatasetSummary[];
  activeId: string | null;
  onSwitch: (id: string) => void;
}) {
  if (datasets.length === 0) return null;
  return (
    <select
      value={activeId ?? ""}
      onChange={(e) => onSwitch(e.target.value)}
      className="h-9 rounded-lg border border-rule bg-surface px-3 text-[12.5px] font-medium text-ink hover:bg-bg-2"
      data-testid="dataset-switcher"
      title="Switch dataset"
    >
      {datasets.map((d) => (
        <option key={d.id} value={d.id}>
          {d.label}{typeof d.sku_count === "number" ? ` (${d.sku_count} SKUs)` : ""}
        </option>
      ))}
    </select>
  );
}

function SkuTable({ rows }: { rows: SkuAggregate[] }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 52,
    overscan: 10,
  });

  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-rule bg-surface px-6 py-10 text-center text-[13px] text-ink-soft">
        No SKUs match these filters.
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-rule bg-surface overflow-hidden">
      <div className="grid grid-cols-[1fr_120px_120px_90px_90px_80px_80px_120px] gap-3 px-4 py-2.5 bg-bg-2/40 border-b border-rule text-[10.5px] uppercase tracking-[0.08em] text-ink-mute font-medium">
        <div>SKU · Category</div>
        <div className="text-right">Volume (t)</div>
        <div className="text-right">NIV (kRON)</div>
        <div className="text-right">GM%</div>
        <div className="text-right">GM (kRON)</div>
        <div className="text-center"># lines</div>
        <div className="text-center"># channels</div>
        <div>Signal</div>
      </div>
      <div
        ref={parentRef}
        data-testid="sku-table-scroll"
        className="overflow-auto"
        style={{ height: 600 }}
      >
        <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative", width: "100%" }}>
          {rowVirtualizer.getVirtualItems().map((virt) => {
            const s = rows[virt.index];
            const meta = BUCKET_META[s.classification];
            const gm = s.gm_krn ?? 0;
            return (
              <div
                key={s.id}
                data-testid="sku-row"
                title={s.classification_reason ?? ""}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virt.start}px)`,
                  height: virt.size,
                }}
                className="grid grid-cols-[1fr_120px_120px_90px_90px_80px_80px_120px] gap-3 px-4 py-2.5 border-b border-rule/60 hover:bg-bg-2/40 transition-colors text-[12.5px] items-center"
              >
                <div className="min-w-0">
                  <div className="text-ink truncate" title={s.product_name}>{s.product_name}</div>
                  <div className="text-[10.5px] text-ink-mute mt-0.5 truncate">
                    {s.brand && <span>{s.brand}</span>}
                    {s.brand && s.category && <span> · </span>}
                    {s.category && <span>{s.category}</span>}
                  </div>
                </div>
                <div className="text-right tabular-nums text-ink-soft">
                  {s.volume_tons !== null ? s.volume_tons.toLocaleString("en-GB", { maximumFractionDigits: 1 }) : "—"}
                </div>
                <div className="text-right tabular-nums text-ink-soft">
                  {s.niv_krn !== null ? s.niv_krn.toLocaleString("en-GB", { maximumFractionDigits: 0 }) : "—"}
                </div>
                <div className={`text-right tabular-nums ${(s.gm_pct ?? 0) < 0 ? "text-red-700" : "text-ink"}`}>
                  {s.gm_pct !== null ? `${(s.gm_pct * 100).toFixed(1)}%` : "—"}
                </div>
                <div className={`text-right tabular-nums font-medium ${gm < 0 ? "text-red-700" : "text-ink"}`}>
                  {gm.toLocaleString("en-GB", { maximumFractionDigits: 0 })}
                </div>
                <div className="text-center text-[11.5px] text-ink-mute tabular-nums">{s.line_row_count ?? "—"}</div>
                <div className="text-center text-[11.5px] text-ink-mute">
                  {s.channels_present?.length || 0}
                </div>
                <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.06em] font-semibold text-ink-soft">
                  <span className={`h-1.5 w-1.5 rounded-full ${meta.dot} shrink-0`} />
                  <span className="truncate">{meta.label}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function PortfolioTotalsBar({ totals }: { totals: DatasetPayload["totals"] }) {
  return (
    <section data-testid="portfolio-totals" className="rounded-2xl border border-rule bg-surface p-4">
      <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium mb-2">Total portfolio</div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-[12.5px]">
        <Stat label="Volume" value={`${totals.volume_tons.toLocaleString("en-GB", { maximumFractionDigits: 1 })} t`} />
        <Stat label="NIV" value={formatKron(totals.niv_krn)} />
        <Stat label="GM" value={formatKron(totals.gm_krn)} />
        <Stat label="Losses" value={formatKron(totals.losses_krn)} tone={totals.losses_krn < 0 ? "alert" : undefined} />
      </div>
    </section>
  );
}
function Stat({ label, value, tone }: { label: string; value: string; tone?: "alert" }) {
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-[0.08em] text-ink-mute">{label}</div>
      <div className={`mt-0.5 font-serif text-[18px] tabular-nums ${tone === "alert" ? "text-red-700" : "text-ink"}`}>{value}</div>
    </div>
  );
}

// ─── Inflight + Empty ───────────────────────────────────────────────────────

function InflightCard({ inflight }: { inflight: InflightDoc }) {
  const STAGES: Record<DocumentStatus, { label: string; ordinal: number }> = {
    queued:     { label: "Queued for analysis…",   ordinal: 0 },
    extracting: { label: "Reading the workbook…",  ordinal: 1 },
    mapping:    { label: "Mapping SKU columns…",   ordinal: 2 },
    computing:  { label: "Aggregating rows…",      ordinal: 3 },
    narrating:  { label: "Classifying portfolio…", ordinal: 4 },
    analyzed:   { label: "Analysis ready",         ordinal: 6 },
    failed:     { label: "Analysis failed",        ordinal: 0 },
  };
  const stage = STAGES[inflight.status];
  const failed = inflight.status === "failed";
  return (
    <section className="max-w-[680px] mx-auto py-16">
      <div data-testid="products-inflight" className="rounded-2xl border border-rule bg-surface p-7">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            {failed ? <AlertCircle size={16} className="text-alert" strokeWidth={2} /> : <Loader2 size={16} className="text-brand animate-spin" strokeWidth={2} />}
            <span className="text-[14px] font-medium text-ink">{failed ? "Couldn't finish analysis" : "Analyzing your SKU data…"}</span>
          </div>
          {!failed && <span className="text-[11.5px] text-ink-mute tabular-nums">Step {stage.ordinal} of 6</span>}
        </div>
        <div className="text-[13px] text-ink-soft mb-3">
          <span className="text-ink font-medium">{inflight.filename}</span> · {stage.label}
        </div>
        {!failed && (
          <div className="h-1.5 rounded-full bg-bg-2 overflow-hidden">
            <div className="h-full bg-brand transition-all duration-500" style={{ width: `${(stage.ordinal / 6) * 100}%` }} />
          </div>
        )}
        {failed && inflight.error && (
          <div className="mt-2 rounded-md border border-alert/30 bg-alert/5 px-3 py-2 text-[12px] text-alert">{inflight.error}</div>
        )}
      </div>
    </section>
  );
}

function EmptyState({ onUploaded }: { onUploaded: () => void }) {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);

  async function handleFile(file: File) {
    if (file.size > 25 * 1024 * 1024) {
      toast({ title: "File too large", description: `${(file.size/1_000_000).toFixed(1)} MB exceeds the 25 MB limit.`, variant: "destructive" });
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
      toast({ title: "Couldn't start analysis", description: "Backend unreachable.", variant: "destructive" });
      return;
    }
    toast({ title: "Analysis started", description: file.name });
    onUploaded();
  }

  return (
    <section className="max-w-[720px] mx-auto py-12" data-testid="products-empty">
      <div className="text-center mb-6">
        <div className="mx-auto h-14 w-14 rounded-2xl bg-bg-2 text-ink-mute flex items-center justify-center mb-4">
          <Boxes size={22} strokeWidth={1.5} />
        </div>
        <h1 className="font-serif text-[34px] sm:text-[40px] leading-[1.1] tracking-[-0.02em] text-ink">
          Upload your sales dataset
        </h1>
        <p className="mt-4 text-[15px] text-ink-soft max-w-[520px] mx-auto">
          Trading analysis (XLSX) or sales-by-SKU export. We extract every line, roll up to the SKU,
          classify into anchor / scale / watch / eliminate, and surface the loss-makers.
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
        <h3 className="font-serif text-[18px] text-ink">Drop your trading analysis</h3>
        <p className="text-[12.5px] text-ink-soft mt-1">XLSX · CSV — multi-sheet supported.</p>
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
          Stream rows · roll up to SKU · classify · briefing
        </p>
      </div>
    </section>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatKron(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}M kRON`;
  if (abs >= 1_000)     return `${sign}${(abs / 1_000).toFixed(1)}k kRON`;
  return `${sign}${Math.round(abs)} kRON`;
}

function exportCsv(rows: SkuAggregate[], datasetLabel: string) {
  const headers = ["product_name", "brand", "category", "volume_tons", "niv_krn", "gm_krn", "gm_pct", "classification", "channels_present", "line_row_count"];
  const lines = [headers.join(",")];
  for (const r of rows) {
    const cells = [
      r.product_name, r.brand ?? "", r.category ?? "",
      r.volume_tons ?? "", r.niv_krn ?? "", r.gm_krn ?? "",
      r.gm_pct !== null ? r.gm_pct : "",
      r.classification,
      (r.channels_present ?? []).join("|"),
      r.line_row_count ?? "",
    ].map((v) => {
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    });
    lines.push(cells.join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${datasetLabel.replace(/[^a-z0-9-_]+/gi, "_")}_skus.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
}
