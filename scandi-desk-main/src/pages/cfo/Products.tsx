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
  FileSpreadsheet,
  Loader2,
  Search,
  Sparkles,
  TableProperties,
  UploadCloud,
  Layers,
  Cpu,
  FileText,
} from "lucide-react";
import { AppShell } from "@/components/cfo/AppShell";
import { DatasetsToggle, useDatasetsCount } from "@/components/cfo/DatasetsPanel";
import { SkuDetailDrawer } from "@/components/cfo/SkuDetailDrawer";
import { openAskCfoAi } from "@/components/cfo/chat/openAskCfoAi";
import { useActivePeriod } from "@/lib/activePeriod";
import { computeRatios } from "@/lib/financialReport";
import { useUploadEnqueue } from "@/hooks/useUploadEnqueue";
import {
  getSupabase,
  recoverStuckPipelines,
  retryPipeline,
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
  // Engine-computed economics — already in `sku_aggregates`, surfaced
  // verbatim by `/api/sales-datasets/{id}/skus`. The detail drawer needs
  // these to render the "Marjă reală" breakdown card.
  real_margin_krn: number | null;
  real_margin_pct: number | null;
  days_inventory_on_hand: number | null;
  inventory_value_krn: number | null;
  /** COGS aggregated from the upload (Optional column). Surfaces when
   *  the upload provided a `COGS` column. Used by the Working-Capital
   *  roll-up panel to compute company DIO as sum(inv)/sum(cogs)*365.
   *  When absent the panel falls back to a weighted-average by
   *  inventory_value_krn so the metric remains computable on older
   *  schemas — but the spec's preferred path is COGS-driven. */
  cogs_krn?: number | null;
  classification: Classification;
  classification_reason: string | null;
  channels_present: string[] | null;
  clients_present: string[] | null;
  line_row_count: number | null;
  // Operator decision persisted from the drawer. Null = engine
  // classification stands; 'eliminate_approved' / 'strategic_override'
  // are user choices that lock the bucket.
  user_override: string | null;
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

interface ComparePayload {
  active: { id: string; label: string; source_filename: string | null };
  compared: { id: string; label: string; source_filename: string | null };
  totals: {
    niv_a: number; niv_b: number;
    gm_a: number; gm_b: number;
    sku_count_a: number; sku_count_b: number;
    new_in_active: number;
  };
  winners: CompareRow[];
  losers: CompareRow[];
  new_in_active: CompareRow[];
  rows: CompareRow[];
}

interface CompareRow {
  product_name: string;
  brand: string | null;
  category: string | null;
  niv_a: number; niv_b: number; niv_delta: number;
  gm_a: number; gm_b: number; gm_delta: number;
  volume_a: number; volume_b: number; volume_delta: number;
  classification_a: Classification | null;
  classification_b: Classification | null;
  new_in_a: boolean;
  new_in_b: boolean;
}

async function fetchCompare(a: string, b: string): Promise<ComparePayload | null> {
  const h = await authHeader();
  if (!h) return null;
  const r = await fetch(`${apiBase()}/api/sales-datasets/compare?a=${a}&b=${b}`, { headers: h });
  if (!r.ok) return null;
  return (await r.json()) as ComparePayload;
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
  // Selected SKU drives the detail drawer. We store the id (not the row) so
  // the drawer re-renders from fresh data after a mutation invalidates the
  // SKUs query.
  const [selectedSkuId, setSelectedSkuId] = useState<string | null>(null);

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

  // ── Watchdog: on mount, ask the BE to recover any docs that got stuck at
  // status='queued' because /api/pipeline/run failed at upload moment (env
  // crash, network blip, backend restart between FE upload and FE enqueue).
  // Idempotent on the server — calling it when nothing is stuck is a no-op.
  // Without this, a user who uploads while the backend is briefly unhealthy
  // is silently stranded at "Step 0 of 6 · Queued for analysis…" forever.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await recoverStuckPipelines();
      if (cancelled || !result || result.recovered_count === 0) return;
      // Re-poll inflight so the card updates from queued→extracting.
      void qc.invalidateQueries({ queryKey: ["sku-analysis", "inflight"] });
    })();
    return () => {
      cancelled = true;
    };
    // Run once on mount, NOT on every qc identity change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ?compare=<id> triggers the side-by-side comparison view. We render a
  // banner above the SKU table; the table itself still shows the active
  // dataset's SKUs (the comparison is additive, not replacement).
  const compareId = params.get("compare");
  const { data: compare } = useQuery({
    queryKey: ["sales-dataset-compare", activeDatasetId, compareId],
    queryFn: () =>
      activeDatasetId && compareId && activeDatasetId !== compareId
        ? fetchCompare(activeDatasetId, compareId)
        : Promise.resolve(null),
    enabled: !!activeDatasetId && !!compareId && activeDatasetId !== compareId,
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
  // Datasets badge count — hook MUST be called unconditionally on every render.
  // Previously this was called inline inside the main return JSX, which meant
  // the four early-return branches above skipped it, producing "Rendered more
  // hooks than during the previous render" when the component switched from a
  // loading branch into the main branch.
  const datasetsCount = useDatasetsCount();

  const activeFilters = useMemo(() => {
    const raw = params.get("state");
    const tokens = raw ? (raw.split(",").filter(Boolean) as Classification[]) : [];
    // `eliminate` and `anchor_alert` were removed as user-facing filter
    // chips. Defensively scrub them out of any persisted `?state=` URL so a
    // returning user doesn't get stranded on an empty filtered view (the
    // chip to clear them is gone).
    const HIDDEN_FILTERS = new Set<Classification>(["eliminate", "anchor_alert"]);
    return new Set<Classification>(tokens.filter((c) => !HIDDEN_FILTERS.has(c)));
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
    return (
      <AppShell>
        <EmptyState
          onUploaded={refresh}
          datasets={datasetsPayload?.datasets ?? []}
        />
      </AppShell>
    );
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
            {/* Dataset switcher — header pill opens the right-anchored
                Datasets panel for full switch / rename / re-run / delete.
                Cmd/Ctrl+Shift+D also toggles. */}
            <DatasetsToggle count={datasetsCount} />
          </div>

          <div className="mt-6 grid grid-cols-2 lg:grid-cols-5 gap-3">
            <KpiCard data-testid="kpi-sku-count" label="SKUs" value={totals.sku_count.toLocaleString("en-GB")} sub={`${totals.category_count} cats · ${totals.brand_count} brands`} />
            {/* `kpi-eliminate` removed per operator request — the bucket is
                still computed server-side (losses_krn rolls into total), it
                just doesn't surface its own KPI tile. */}
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
            <select value={`${sortKey}_${sortDir}`} onChange={(e) => {
              // Sort keys themselves contain underscores (gm_krn, gm_pct,
              // volume_tons, niv_krn). Split on the LAST underscore so the
              // key+direction parse correctly.
              const value = e.target.value;
              const idx = value.lastIndexOf("_");
              const k = value.slice(0, idx) as typeof sortKey;
              const d = value.slice(idx + 1) as "asc" | "desc";
              setSortKey(k);
              setSortDir(d);
            }} data-testid="sort-dropdown" className="h-9 rounded-lg border border-rule bg-surface px-2.5 text-[12.5px] text-ink">
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
            {FILTER_ORDER.filter((c) => c !== "eliminate" && c !== "anchor_alert").map((c) => {
              const n = totals.classification_counts[c] ?? 0;
              // `eliminate` and `anchor_alert` are filtered out per operator
              // request. Defensive scrub in `activeFilters` above ensures any
              // persisted `?state=` URL containing them doesn't strand the
              // user on an empty filtered view.
              return (
                <Chip
                  key={c}
                  testid={`chip-${c}`}
                  label={BUCKET_META[c].label}
                  count={n}
                  dotClass={BUCKET_META[c].dot}
                  active={activeFilters.has(c)}
                  empty={n === 0}
                  onClick={() => setStateFilter(c)}
                />
              );
            })}
          </div>

          <div data-testid="sku-table-summary" className="text-[11.5px] text-ink-mute">
            Showing {filtered.length.toLocaleString("en-GB")} of {totals.sku_count.toLocaleString("en-GB")} SKUs
          </div>
        </div>

        {compare && (
          <ComparisonSection
            payload={compare}
            onClose={() => setUrlParam("compare", null)}
            onSwitchActive={() => {
              // Promote the compared dataset to active (swap roles).
              setParams((prev) => {
                const sp = new URLSearchParams(prev);
                sp.set("dataset", compare.compared.id);
                sp.set("compare", compare.active.id);
                return sp;
              }, { replace: true });
            }}
          />
        )}

        <SkuTable rows={filtered} onSelect={(s) => setSelectedSkuId(s.id)} />

        {/* Company working-capital roll-up — per-SKU DIO covered rows
         *  aggregated to a company DIO (with coverage %), combined with
         *  DSO/DPO from the loaded period's trial-balance context
         *  (when available) into CCC = DIO + DSO − DPO. Each component
         *  is labelled with its source; missing components show
         *  "not available" rather than a fabricated value. */}
        <WorkingCapitalRollup skus={dsPayload.skus} />

        <PortfolioTotalsBar totals={totals} />
      </section>

      <SkuDetailDrawer
        sku={
          selectedSkuId
            ? dsPayload.skus.find((s) => s.id === selectedSkuId) ?? null
            : null
        }
        onClose={() => setSelectedSkuId(null)}
        datasetId={activeDatasetId}
        categoryNivTotal={(() => {
          if (!selectedSkuId) return null;
          const sel = dsPayload.skus.find((s) => s.id === selectedSkuId);
          if (!sel || !sel.category) return null;
          // Sum NIV across the same category — drives "Cotă din categorie".
          return dsPayload.skus
            .filter((s) => s.category === sel.category)
            .reduce((acc, s) => acc + (s.niv_krn ?? 0), 0);
        })()}
      />
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
      <div className="mt-2 num-hero text-[30px] text-ink leading-none">{value}</div>
      {sub && <div className="text-[11px] text-ink-soft mt-0.5">{sub}</div>}
    </div>
  );
}

// ─── Working-capital roll-up ────────────────────────────────────────────────
//
// Per the spec:
//   · Per-SKU DIO is parsed from the upload (`Inventory value` + `COGS`
//     columns). Graceful-missing: rows without inputs show "—" + n/a
//     in the SKU table, never 0.
//   · Company DIO aggregates ONLY covered rows. Coverage % of NIV and
//     of line count are surfaced so the user knows exactly how broad
//     the metric is. Formula: sum(inv) / sum(cogs) * 365 when cogs is
//     present per-SKU; weighted-average-by-inventory fallback when
//     only DIO+inv are available (older schema without the cogs_krn
//     column persisted).
//   · DSO and DPO come from the loaded period's trial-balance context
//     (receivables 4111 / payables 401, vs revenue / COGS) — reused
//     via the same `computeRatios()` the dashboard ratios tab uses.
//     No pipeline/engine recompute.
//   · CCC = DIO + DSO − DPO. Shown ONLY when all three components are
//     available; otherwise the panel labels CCC "not available" and
//     names which component is missing. Never fabricated.

function WorkingCapitalRollup({ skus }: { skus: SkuAggregate[] }) {
  const period = useActivePeriod();

  // ── Per-SKU DIO coverage + company DIO ────────────────────────────
  const covered = useMemo(
    () => skus.filter(
      (s) => s.days_inventory_on_hand != null && s.inventory_value_krn != null,
    ),
    [skus],
  );
  const coverageLinesPct = skus.length > 0 ? (covered.length / skus.length) : 0;
  const totalNiv = skus.reduce((acc, s) => acc + (s.niv_krn ?? 0), 0);
  const coveredNiv = covered.reduce((acc, s) => acc + (s.niv_krn ?? 0), 0);
  const coverageNivPct = totalNiv > 0 ? coveredNiv / totalNiv : 0;

  // Company DIO. Preferred formula: sum(inv) / sum(cogs) * 365 when
  // cogs_krn is available per covered row. Fallback: weighted average
  // of per-SKU DIO by inventory_value_krn (mathematically valid since
  // each per-SKU DIO is inv/cogs*365; weighting by inv reduces to
  // sum(inv²/cogs) / sum(inv) — used only when cogs_krn is missing on
  // the schema). Both formulas honestly use only covered rows.
  let companyDio: number | null = null;
  let companyDioFormulaNote = "";
  if (covered.length > 0) {
    const hasCogs = covered.every((s) => s.cogs_krn != null && (s.cogs_krn ?? 0) > 0);
    if (hasCogs) {
      const sumInv = covered.reduce((a, s) => a + (s.inventory_value_krn ?? 0), 0);
      const sumCogs = covered.reduce((a, s) => a + (s.cogs_krn ?? 0), 0);
      companyDio = sumCogs > 0 ? (sumInv / sumCogs) * 365 : null;
      companyDioFormulaNote = "sum(Inventory) ÷ sum(COGS) × 365, covered rows";
    } else {
      const sumInv = covered.reduce((a, s) => a + (s.inventory_value_krn ?? 0), 0);
      const wsum = covered.reduce(
        (a, s) => a + (s.inventory_value_krn ?? 0) * (s.days_inventory_on_hand ?? 0),
        0,
      );
      companyDio = sumInv > 0 ? wsum / sumInv : null;
      companyDioFormulaNote = "weighted by Inventory (per-SKU DIO; COGS not persisted)";
    }
  }

  // ── DSO / DPO from period trial-balance context ───────────────────
  // `computeRatios()` is the same FE arithmetic the Dashboard's Ratios
  // tab consumes — receivables / payables / revenue / cogs already
  // emitted by the engine into the period's statements. No recompute.
  let dso: number | null = null;
  let dpo: number | null = null;
  let periodContextNote: string | null = null;
  if (period.statements) {
    try {
      const r = computeRatios(period.statements);
      const dsoRatio = r.efficiency.find((x) => x.key === "dso");
      const dpoRatio = r.efficiency.find((x) => x.key === "dpo");
      dso = dsoRatio && Number.isFinite(dsoRatio.value) ? dsoRatio.value : null;
      dpo = dpoRatio && Number.isFinite(dpoRatio.value) ? dpoRatio.value : null;
      periodContextNote = `period: ${period.label ?? period.id ?? "loaded"}`;
    } catch {
      // Sample periods may not have a full balance sheet; leave nulls
      // and the panel will mark these "not available" honestly.
      dso = null;
      dpo = null;
    }
  }

  // ── CCC = DIO + DSO − DPO ─────────────────────────────────────────
  const ccc =
    companyDio != null && dso != null && dpo != null
      ? companyDio + dso - dpo
      : null;
  const missingForCcc: string[] = [];
  if (companyDio == null) missingForCcc.push("DIO");
  if (dso == null) missingForCcc.push("DSO");
  if (dpo == null) missingForCcc.push("DPO");

  return (
    <section
      data-testid="wc-rollup-panel"
      className="rounded-2xl border border-rule bg-surface px-5 py-5"
    >
      <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
        <div>
          <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-semibold">
            Working-capital roll-up
          </div>
          <h4 className="font-serif text-[18px] leading-tight text-ink mt-1">
            Company DIO · DSO · DPO · CCC
          </h4>
          <p className="text-[12px] text-ink-soft mt-1 max-w-[640px]">
            DIO from uploaded SKU inventory &amp; COGS, covered rows only.
            DSO / DPO from the period&rsquo;s trial-balance context. CCC is a
            company roll-up, not per-SKU.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <WcCard
          label="Company DIO"
          value={companyDio}
          unit="days"
          source={
            covered.length > 0
              ? `${(coverageNivPct * 100).toFixed(0)}% of NIV · ${covered.length} of ${skus.length} SKUs`
              : "Inventory / COGS not provided on any SKU"
          }
          formula={companyDioFormulaNote}
          missingHint="Add Inventory value and COGS columns to the upload to compute DIO."
          testid="wc-dio"
        />
        <WcCard
          label="DSO"
          value={dso}
          unit="days"
          source={dso != null ? `from trial balance${periodContextNote ? ` · ${periodContextNote}` : ""}` : "no trial balance in this session"}
          missingHint="Load a period with a trial balance to compute DSO."
          testid="wc-dso"
        />
        <WcCard
          label="DPO"
          value={dpo}
          unit="days"
          source={dpo != null ? `from trial balance${periodContextNote ? ` · ${periodContextNote}` : ""}` : "no trial balance in this session"}
          missingHint="Load a period with a trial balance to compute DPO."
          testid="wc-dpo"
        />
        <WcCard
          label="CCC"
          value={ccc}
          unit="days"
          source={
            ccc != null
              ? "DIO + DSO − DPO, company-level"
              : `missing: ${missingForCcc.join(", ")}`
          }
          missingHint={
            ccc == null
              ? "CCC is computed only when DIO, DSO and DPO are all available."
              : undefined
          }
          accent={ccc != null}
          testid="wc-ccc"
        />
      </div>

      <p className="mt-3 text-[11px] text-ink-mute italic">
        Rows without inventory + COGS show DIO as &ldquo;—&rdquo; in the table above and are
        excluded from the company DIO aggregate (never treated as zero).
      </p>
    </section>
  );
}

function WcCard({
  label, value, unit, source, formula, missingHint, accent, testid,
}: {
  label: string;
  value: number | null;
  unit: string;
  source: string;
  formula?: string;
  missingHint?: string;
  accent?: boolean;
  testid?: string;
}) {
  const available = value != null && Number.isFinite(value);
  return (
    <div
      data-testid={testid}
      data-available={available ? "true" : "false"}
      className={`rounded-xl border ${accent ? "border-brand/40" : "border-rule"} bg-bg-2/30 px-4 py-3`}
    >
      <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium">
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-1.5">
        {available ? (
          <>
            <span className="text-[22px] tabular-nums text-ink font-semibold leading-none">
              {Math.round(value).toLocaleString("en-GB")}
            </span>
            <span className="text-[11.5px] text-ink-soft">{unit}</span>
          </>
        ) : (
          <span className="text-[14px] text-ink-mute italic">not available</span>
        )}
      </div>
      <div className="mt-1.5 text-[11px] text-ink-soft leading-snug">{source}</div>
      {formula && available && (
        <div className="mt-0.5 text-[10.5px] text-ink-mute leading-snug">{formula}</div>
      )}
      {!available && missingHint && (
        <div className="mt-1 text-[10.5px] text-ink-mute leading-snug">{missingHint}</div>
      )}
    </div>
  );
}

function Chip({
  testid, label, count, active, onClick, dotClass, empty,
}: { testid: string; label: string; count: number; active: boolean; onClick: () => void; dotClass?: string; empty?: boolean }) {
  // `empty` chips (count = 0) render dimmed so they're visually distinct
  // from populated buckets — but still clickable, so the user can see the
  // full classification surface and confirm the bucket really is empty
  // (vs the chip being missing entirely, which used to read as a bug).
  const baseTone = active
    ? "bg-ink text-paper border-ink"
    : empty
      ? "bg-surface text-ink-mute/70 border-rule/60 hover:text-ink-soft hover:border-rule"
      : "bg-surface text-ink-soft border-rule hover:text-ink hover:border-rule-strong";
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testid}
      className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-[12px] border transition-colors ${baseTone}`}
    >
      {dotClass && (
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full ${dotClass} ${empty && !active ? "opacity-40" : ""}`}
        />
      )}
      {label}
      <span className={`ml-0.5 ${active ? "text-paper/70" : "text-ink-mute"}`}>{count}</span>
    </button>
  );
}

// DatasetSwitcher was replaced by <DatasetsToggle /> + <DatasetsPanel />;
// inline <select> retired in favor of the slide-out panel.

function ComparisonSection({
  payload,
  onClose,
  onSwitchActive,
}: {
  payload: ComparePayload;
  onClose: () => void;
  onSwitchActive: () => void;
}) {
  const { active, compared, totals, winners, losers, new_in_active } = payload;
  const nivDelta = totals.niv_a - totals.niv_b;
  const gmDelta = totals.gm_a - totals.gm_b;

  return (
    <section
      data-testid="comparison-section"
      className="rounded-2xl border border-brand/25 bg-brand-tint/30 p-5 space-y-4"
    >
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="text-[10.5px] uppercase tracking-[0.1em] text-brand-d font-medium">Comparison</div>
          <h3 className="mt-1 font-serif text-[20px] text-ink leading-tight">
            <span>{active.label}</span>
            <span className="text-ink-soft font-normal mx-2">vs</span>
            <span>{compared.label}</span>
          </h3>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onSwitchActive}
            className="h-8 px-3 rounded-md border border-rule bg-surface text-[12px] font-medium text-ink hover:bg-bg-2 transition-colors"
          >
            Switch active to {compared.label}
          </button>
          <button
            type="button"
            onClick={onClose}
            data-testid="comparison-close"
            aria-label="Close comparison"
            className="h-8 w-8 inline-flex items-center justify-center rounded-md text-ink-mute hover:text-ink hover:bg-bg-2"
          >
            ✕
          </button>
        </div>
      </header>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat
          label={`SKUs · ${active.label}`}
          value={totals.sku_count_a.toLocaleString("en-GB")}
        />
        <Stat
          label={`SKUs · ${compared.label}`}
          value={totals.sku_count_b.toLocaleString("en-GB")}
        />
        <Stat
          label="NIV delta"
          value={formatKron(nivDelta)}
          tone={nivDelta < 0 ? "alert" : undefined}
        />
        <Stat
          label="GM delta"
          value={formatKron(gmDelta)}
          tone={gmDelta < 0 ? "alert" : undefined}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <MoversList title="Top winners (Δ GM ↑)" rows={winners} dir="up" />
        <MoversList title="Top losers (Δ GM ↓)" rows={losers} dir="down" />
      </div>

      {new_in_active.length > 0 && (
        <div>
          <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium mb-1.5">
            New in {active.label} ({totals.new_in_active})
          </div>
          <ul className="text-[12px] text-ink-soft space-y-0.5 max-h-32 overflow-y-auto">
            {new_in_active.slice(0, 12).map((r) => (
              <li key={r.product_name} className="truncate">
                + {r.product_name} <span className="text-ink-mute">· GM {formatKron(r.gm_a)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function MoversList({ title, rows, dir }: { title: string; rows: CompareRow[]; dir: "up" | "down" }) {
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium mb-1.5">{title}</div>
      <ul className="rounded-lg border border-rule bg-surface divide-y divide-rule/60 max-h-64 overflow-y-auto">
        {rows.length === 0 && (
          <li className="px-3 py-2 text-[12px] text-ink-mute">No movers in this bucket.</li>
        )}
        {rows.map((r) => (
          <li key={r.product_name} className="px-3 py-2 grid grid-cols-[1fr_auto] gap-2 items-center">
            <div className="min-w-0">
              <div className="text-[12px] text-ink truncate">{r.product_name}</div>
              <div className="text-[10.5px] text-ink-mute truncate">{r.brand} · {r.category}</div>
            </div>
            <div className={`text-right tabular-nums text-[12px] font-medium ${dir === "up" ? "text-emerald-700" : "text-red-700"}`}>
              {dir === "up" ? "+" : ""}{formatKron(r.gm_delta)}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SkuTable({ rows, onSelect }: { rows: SkuAggregate[]; onSelect: (sku: SkuAggregate) => void }) {
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
      <div className="grid grid-cols-[1fr_120px_120px_90px_90px_90px_80px_80px_120px] gap-3 px-4 py-2.5 bg-bg-2/40 border-b border-rule text-[10.5px] uppercase tracking-[0.08em] text-ink-mute font-medium">
        <div>SKU · Category</div>
        <div className="text-right">Volume (t)</div>
        <div className="text-right">NIV (kRON)</div>
        <div className="text-right">GM%</div>
        <div className="text-right">GM (kRON)</div>
        <div className="text-right">DIO (days)</div>
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
                role="button"
                tabIndex={0}
                title={s.classification_reason ?? ""}
                onClick={() => onSelect(s)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(s);
                  }
                }}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virt.start}px)`,
                  height: virt.size,
                }}
                className="grid grid-cols-[1fr_120px_120px_90px_90px_90px_80px_80px_120px] gap-3 px-4 py-2.5 border-b border-rule/60 hover:bg-bg-2/40 transition-colors text-[12.5px] items-center cursor-pointer focus:outline-none focus:bg-bg-2/60 focus:ring-1 focus:ring-inset focus:ring-ink/20"
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
                {/* DIO (days). Graceful-missing — when inventory/COGS
                 *  weren't provided for this SKU, render an explicit
                 *  "—" with an "inv/COGS n/a" caption on hover so the
                 *  user never reads a 0 as "perfect inventory turn".
                 *  This is the no-fabrication rail for DIO. */}
                <div
                  className="text-right tabular-nums"
                  title={
                    s.days_inventory_on_hand == null
                      ? "DIO not available — inventory value and/or COGS not provided for this SKU"
                      : undefined
                  }
                  data-testid="sku-dio-cell"
                  data-dio-available={s.days_inventory_on_hand != null ? "true" : "false"}
                >
                  {s.days_inventory_on_hand != null
                    ? <span className="text-ink">{Math.round(s.days_inventory_on_hand).toLocaleString("en-GB")}</span>
                    : <span className="text-ink-mute/70 italic">—<span className="ml-1 text-[10px]">n/a</span></span>}
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

  // ── Hang detector ──────────────────────────────────────────────────────────
  // If the doc stays at status='queued' (ordinal=0) for >60s the user is
  // most likely staring at a silent backend hang — typically /api/pipeline/run
  // failed at upload moment so the worker thread never started. Surface a
  // clear message + retry button rather than spinning forever. Status changes
  // away from "queued" reset the timer; analysis completing makes it moot.
  const HANG_TIMEOUT_MS = 60_000;
  const [hangSuspected, setHangSuspected] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const { toast } = useToast();
  const qc = useQueryClient();
  useEffect(() => {
    setHangSuspected(false);
    if (inflight.status !== "queued") return;
    const t = setTimeout(() => setHangSuspected(true), HANG_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [inflight.status, inflight.id]);

  const handleRetry = async () => {
    setRetrying(true);
    // Try the generic watchdog first (catches the common "worker never ran"
    // case without wiping derivatives), then fall back to a hard retry which
    // resets the doc and re-enqueues fresh.
    const recovered = await recoverStuckPipelines();
    let ok = (recovered?.recovered_count ?? 0) > 0;
    if (!ok) ok = await retryPipeline(inflight.id);
    setRetrying(false);
    if (ok) {
      toast({ title: "Retrying analysis", description: inflight.filename });
      setHangSuspected(false);
      void qc.invalidateQueries({ queryKey: ["sku-analysis", "inflight"] });
    } else {
      toast({
        title: "Retry failed",
        description: "Backend is unreachable. Refresh the page or try again in a moment.",
        variant: "destructive",
      });
    }
  };

  // Staged steps — labels users can recognise. Mapped to the engine's
  // own `DocumentStatus` so the active step always matches reality.
  // Each step shows pending / running / done so a 6-step pipeline reads
  // as a real workflow instead of a generic spinner.
  const STEPS: Array<{ ordinal: number; label: string; sub: string }> = [
    { ordinal: 1, label: "Reading workbook",   sub: "Picking the right sheet" },
    { ordinal: 2, label: "Detecting columns",  sub: "Matching synonyms · RO/EN" },
    { ordinal: 3, label: "Mapping SKUs",       sub: "One row per product line" },
    { ordinal: 4, label: "Calculating margins", sub: "NIV · GM · DIO when present" },
    { ordinal: 5, label: "Classifying portfolio", sub: "anchor · scale · watch · wind-down" },
    { ordinal: 6, label: "Generating briefing", sub: "Executive summary + actions" },
  ];

  return (
    <section className="max-w-[760px] mx-auto py-12 sm:py-16">
      <div
        data-testid="products-inflight"
        className="
          relative overflow-hidden rounded-3xl
          border border-rule
          bg-gradient-to-br from-bg-2/40 via-surface to-surface
          ring-1 ring-inset ring-white/[0.03]
          shadow-[0_24px_48px_-30px_rgba(0,0,0,0.25)]
          px-6 sm:px-8 py-7 sm:py-8
        "
      >
        <div aria-hidden className="pointer-events-none absolute -top-24 -right-20 h-56 w-56 rounded-full bg-brand/10 blur-3xl" />

        <div className="relative flex items-center justify-between gap-3 mb-3 flex-wrap">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className={`inline-flex items-center justify-center h-8 w-8 rounded-xl ${
              failed || hangSuspected
                ? "bg-alert/10 text-alert"
                : "bg-brand-tint text-brand-d"
            }`}>
              {failed || hangSuspected
                ? <AlertCircle size={15} strokeWidth={2} />
                : <Loader2 size={15} strokeWidth={2.25} className="animate-spin" />}
            </span>
            <span className="text-[14.5px] font-semibold text-ink truncate">
              {failed
                ? "Couldn't finish analysis"
                : hangSuspected
                ? "Upload appears stuck"
                : "Analyzing your SKU data…"}
            </span>
          </div>
          {!failed && !hangSuspected && (
            <span className="text-[11px] text-ink-mute tabular-nums uppercase tracking-[0.08em]">
              Step {Math.max(1, stage.ordinal)} of {STEPS.length}
            </span>
          )}
        </div>

        <div className="relative text-[12.5px] text-ink-soft mb-5 truncate">
          <span className="text-ink font-medium">{inflight.filename}</span>
          <span className="mx-1.5 text-ink-mute">·</span>
          <span>{stage.label}</span>
        </div>

        {!failed && !hangSuspected && (
          <ol className="relative space-y-3" data-testid="products-inflight-steps">
            {STEPS.map((step) => {
              const isDone = stage.ordinal > step.ordinal;
              const isActive = stage.ordinal === step.ordinal || (stage.ordinal === 0 && step.ordinal === 1);
              return (
                <li
                  key={step.ordinal}
                  className={`
                    relative flex items-start gap-3
                    transition-opacity duration-300
                    ${isDone ? "opacity-100" : isActive ? "opacity-100" : "opacity-55"}
                  `}
                  data-step-state={isDone ? "done" : isActive ? "active" : "pending"}
                >
                  <span className={`
                    inline-flex items-center justify-center
                    h-6 w-6 rounded-full shrink-0
                    transition-colors duration-200
                    ${isDone
                      ? "bg-brand text-paper"
                      : isActive
                      ? "bg-brand/15 text-brand-d ring-2 ring-brand/40"
                      : "bg-bg-2 text-ink-mute"}
                  `}>
                    {isDone
                      ? <Check size={12} strokeWidth={2.75} />
                      : isActive
                      ? <Loader2 size={11} strokeWidth={2.5} className="animate-spin" />
                      : <span className="text-[10px] font-semibold tabular-nums">{step.ordinal}</span>}
                  </span>
                  <span className="min-w-0">
                    <span className={`block text-[13px] ${isDone || isActive ? "text-ink" : "text-ink-soft"} ${isActive ? "font-medium" : ""}`}>
                      {step.label}
                    </span>
                    <span className="block text-[11.5px] text-ink-mute mt-0.5">{step.sub}</span>
                  </span>
                  {/* Connector — vertical line linking the steps. The
                   *  last step has no connector below it. */}
                  {step.ordinal < STEPS.length && (
                    <span
                      aria-hidden
                      className="absolute left-[11px] top-7 bottom-[-12px] w-px bg-rule/70"
                    />
                  )}
                </li>
              );
            })}
          </ol>
        )}
        {failed && inflight.error && (
          <div className="mt-2 rounded-md border border-alert/30 bg-alert/5 px-3 py-2 text-[12px] text-alert">{inflight.error}</div>
        )}
        {hangSuspected && !failed && (
          <div
            data-testid="products-inflight-hang"
            className="mt-2 rounded-md border border-alert/30 bg-alert/5 px-3 py-2.5 text-[12.5px] text-alert space-y-2"
          >
            <p>
              The upload reached the server but analysis hasn't started for more than 60 seconds.
              This usually means the worker thread never picked up the job (a brief backend hiccup
              right at upload moment). Click below to re-queue it.
            </p>
            <button
              type="button"
              onClick={handleRetry}
              disabled={retrying}
              data-testid="products-inflight-retry"
              className="inline-flex items-center gap-1.5 rounded-md border border-alert/40 bg-surface px-3 py-1.5 text-[12px] font-medium text-alert hover:bg-alert/10 transition-colors disabled:opacity-50"
            >
              {retrying ? <Loader2 size={12} className="animate-spin" /> : null}
              {retrying ? "Retrying…" : "Retry analysis"}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

// Real, enforced upload limits — kept in one place so the UI never
// states a number the parser doesn't actually enforce. (Spec: "Accepted-
// formats limits match the real parser/handler".)
const PRODUCTS_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
const PRODUCTS_UPLOAD_MAX_MB = 25;
const PRODUCTS_UPLOAD_ACCEPT = ".xlsx,.xls,.csv";

function EmptyState({
  onUploaded,
  datasets,
}: {
  onUploaded: () => void;
  /** Real prior imports — drives the stats strip and recent-imports
   *  panel. Pass an empty array on a brand-new account; the strip and
   *  the panel render their honest empty states. NEVER fabricated. */
  datasets: DatasetSummary[];
}) {
  const { toast } = useToast();
  // Pricing V3 — wraps enqueuePipeline so the 402 extra-doc dialog +
  // 429 quota-blocked toast fire automatically.
  const uploadEnqueue = useUploadEnqueue();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);

  async function handleFile(file: File) {
    if (file.size > PRODUCTS_UPLOAD_MAX_BYTES) {
      toast({ title: "File too large", description: `${(file.size/1_000_000).toFixed(1)} MB exceeds the ${PRODUCTS_UPLOAD_MAX_MB} MB limit.`, variant: "destructive" });
      return;
    }
    setBusy(true);
    const { row, error } = await uploadDocument(file, { scope: "sku" });
    if (!row) {
      setBusy(false);
      toast({ title: "Upload failed", description: error ?? "Unknown error.", variant: "destructive" });
      return;
    }
    const enq = await uploadEnqueue.enqueue(row.id);
    setBusy(false);
    if (enq.kind !== "queued") {
      // Modal/toast already surfaced by the hook; nothing to do here.
      return;
    }
    toast({ title: "Analysis started", description: file.name });
    onUploaded();
  }

  // ── Real-or-absent stats (no fabrication) ───────────────────────
  // Every figure here is computed from `datasets` (the already-loaded
  // /api/sales-datasets payload). When `datasets.length === 0` the
  // strip renders an honest "Upload your first dataset…" state — never
  // sample numbers, never "↑X% vs last import".
  const stats = useMemo(() => buildHonestStats(datasets), [datasets]);
  const sortedDatasets = useMemo(
    () => [...datasets].sort((a, b) => new Date(b.uploaded_at).getTime() - new Date(a.uploaded_at).getTime()),
    [datasets],
  );

  return (
    <section className="max-w-[1080px] mx-auto py-10 sm:py-12" data-testid="products-empty">
      {/* Pricing V3 — extra-doc confirm dialog mount. */}
      {uploadEnqueue.dialog}
      {/* ── Hero panel — glass-card with soft gradient. Headline + a
       *  premium dropzone live in a 2-column split that stacks under lg.
       *  The wrapper card adds the gradient + ring so the hero reads as
       *  a single integrated surface rather than two loose blocks. */}
      <div className="
        relative overflow-hidden rounded-3xl
        border border-rule
        bg-gradient-to-br from-bg-2/40 via-surface to-surface
        ring-1 ring-inset ring-white/[0.03]
        shadow-[0_24px_48px_-30px_rgba(0,0,0,0.25)]
        px-6 sm:px-8 py-8 sm:py-10
      ">
        {/* Decorative top-right brand glow — purely visual, no real data */}
        <div aria-hidden className="pointer-events-none absolute -top-24 -right-24 h-64 w-64 rounded-full bg-brand/10 blur-3xl" />

        <div className="grid lg:grid-cols-[1.05fr_1fr] gap-6 lg:gap-10 items-start relative">
          <div>
            <div className="inline-flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.16em] text-ink-mute font-semibold">
              <Sparkles size={10} strokeWidth={2.25} className="text-brand-d" />
              Product intelligence
            </div>
            <h1 className="mt-3 text-[34px] sm:text-[42px] leading-[1.05] tracking-[-0.02em] text-ink font-semibold">
              Upload your data. CFO AI finds what matters.
            </h1>
            <p className="mt-4 text-[14.5px] text-ink-soft leading-relaxed max-w-[520px]">
              Drop a trading analysis or sales-by-SKU export. CFO AI streams every row, rolls them
              up to the SKU, classifies into anchor / scale / watch / wind-down, and surfaces
              loss-makers — with optional per-SKU DIO when{" "}
              <span className="text-ink">Inventory value</span> and{" "}
              <span className="text-ink">COGS</span> columns are included.
            </p>

            <div className="mt-5 flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => fileRef.current?.click()}
                data-testid="products-upload-choose-primary"
                className="
                  inline-flex items-center gap-2 h-10 px-4 rounded-lg
                  bg-gradient-to-b from-brand to-brand-d text-paper text-[13px] font-medium
                  shadow-[0_8px_22px_-8px_rgba(45,191,179,0.6)]
                  hover:shadow-[0_10px_26px_-8px_rgba(45,191,179,0.75)]
                  disabled:opacity-50 transition-all
                  ring-1 ring-inset ring-white/15
                "
              >
                {busy ? <Loader2 size={13} className="animate-spin" /> : <UploadCloud size={13} strokeWidth={2} />}
                {busy ? "Uploading…" : "Upload dataset"}
              </button>
              <button
                type="button"
                onClick={() => openAskCfoAi("Help me understand what my product dataset upload should look like, and what CFO AI will do with it.")}
                className="
                  inline-flex items-center gap-2 h-10 px-4 rounded-lg
                  border border-rule bg-surface/70 backdrop-blur
                  text-[13px] font-medium text-ink
                  hover:bg-bg-2/60 hover:border-rule-strong
                  transition-colors
                "
                data-testid="products-ask-cfo-ai"
              >
                <Sparkles size={13} strokeWidth={2} className="text-brand-d" />
                Ask CFO AI
              </button>
            </div>
          </div>

          {/* Dropzone — glass, brand-glow on drag-over */}
          <div
            data-testid="products-upload-dropzone"
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; if (f) void handleFile(f); }}
            className={`
              relative rounded-2xl border-2 border-dashed transition-all
              ${drag
                ? "border-brand bg-brand/[0.06] shadow-[0_0_0_4px_rgba(45,191,179,0.12)]"
                : "border-rule/80 bg-bg-2/30 hover:bg-bg-2/50 hover:border-rule-strong"}
              px-6 py-10 text-center
              backdrop-blur-sm
            `}
          >
            <div className="mx-auto h-12 w-12 rounded-xl bg-gradient-to-br from-brand/15 to-brand-d/15 text-brand-d flex items-center justify-center mb-3 ring-1 ring-brand/15">
              <UploadCloud size={20} strokeWidth={1.75} />
            </div>
            <h3 className="text-[16px] font-semibold text-ink">Drop your dataset here</h3>
            <p className="text-[12.5px] text-ink-soft mt-1">
              XLSX · CSV · multi-sheet · up to {PRODUCTS_UPLOAD_MAX_MB} MB
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
              data-testid="products-upload-choose"
              className="mt-4 inline-flex items-center gap-2 h-9 px-3.5 rounded-lg border border-rule bg-surface text-ink text-[12.5px] font-medium hover:bg-bg-2/60 transition-colors disabled:opacity-50"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <UploadCloud size={12} strokeWidth={2} />}
              {busy ? "Uploading…" : "Choose a file"}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept={PRODUCTS_UPLOAD_ACCEPT}
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); }}
            />
            <p className="mt-4 text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium">
              <Sparkles size={9} strokeWidth={2} className="inline mr-1 text-brand-d" />
              Stream · roll up · classify · briefing
            </p>
          </div>
        </div>
      </div>

      {/* ── Contextual Ask CFO AI prompt chips ─────────────────────── */}
      <ProductsPromptChips />

      {/* ── Stats strip — REAL or absent (no fabrication) ──────────── */}
      <ProductsStatsStrip stats={stats} hasData={datasets.length > 0} />

      {/* ── What happens next (process explanation — static & accurate) ── */}
      <ProductsProcessFlow />

      {/* ── Accepted formats — limits match the real parser/handler ── */}
      <ProductsAcceptedFormats />

      {/* ── Recent imports — REAL history or honest empty state ───── */}
      <ProductsRecentImports datasets={sortedDatasets} />

      {/* ── Expected format card — preserves the columnar source-doc
       *  example, anchor for the example download link. The card was
       *  the original lineage/source-doc element in the pre-upload
       *  flow; kept as-is so the existing example_products_trading.xlsx
       *  remains accessible (Decision 4 — preserve source-doc). */}
      <SalesAnalysisFormatHint />

      {/* ── Bottom insight strip — premium CTA. Opens the Ask CFO AI
       *  slide-over with no prefill (general entry); the prompt chips
       *  above cover the more specific intents. */}
      <ProductsBottomInsightStrip />
    </section>
  );
}

// ─── Contextual prompt chips ─────────────────────────────────────
// Each chip dispatches `openAskCfoAi(prompt)` which AppShell receives
// and translates into either: focus the live composer with prefill
// (when already on /chat) or open the slide-over with the prompt
// queued (any other route — including this Products page). The
// prompts are real CFO-finance questions, NOT fabricated insights.

const PRODUCTS_PROMPT_CHIPS: Array<{ label: string; prompt: string }> = [
  { label: "Analyze product profitability",   prompt: "Walk me through how I should analyze product profitability across my SKU portfolio. What metrics matter most and in what order?" },
  { label: "Which SKUs are loss-makers?",      prompt: "Once I upload my sales dataset, how do you decide which SKUs are loss-makers? Explain the classification rules CFO AI uses." },
  { label: "What should we discontinue?",      prompt: "What framework should a CFO use to decide which products to discontinue? Include the financial AND operational signals to weigh." },
  { label: "Where are margin leaks?",          prompt: "Where do margin leaks typically hide in a SKU portfolio? Give me the top causes and how I'd spot them in a trading analysis." },
  { label: "Summarize latest product dataset", prompt: "Once a Products dataset is loaded, summarize it for me: top performers, loss-makers, and the most important pricing or mix actions." },
];

function ProductsPromptChips() {
  return (
    <section className="mt-8" data-testid="products-prompt-chips">
      <div className="flex items-center gap-2 mb-2.5">
        <Sparkles size={11} strokeWidth={2.25} className="text-brand-d" />
        <span className="text-[10.5px] uppercase tracking-[0.14em] text-ink-mute font-semibold">
          Ask CFO AI
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {PRODUCTS_PROMPT_CHIPS.map((c) => (
          <button
            key={c.label}
            type="button"
            onClick={() => openAskCfoAi(c.prompt)}
            className="
              group inline-flex items-center gap-2
              h-9 px-3.5 rounded-full
              border border-rule bg-surface
              text-[12.5px] text-ink-soft hover:text-ink
              hover:border-brand/30 hover:bg-brand/[0.04]
              transition-all
            "
            data-testid="products-prompt-chip"
          >
            <Sparkles size={11} strokeWidth={2} className="text-ink-mute group-hover:text-brand-d transition-colors" />
            {c.label}
          </button>
        ))}
      </div>
    </section>
  );
}

// ─── Bottom insight strip ────────────────────────────────────────
// Sits at the foot of the empty-state page. Premium gradient panel
// with a single Ask CFO AI CTA. No fabricated metric — copy is a
// product positioning line, not a claim about the user's data.

function ProductsBottomInsightStrip() {
  return (
    <section
      className="
        mt-12 rounded-3xl
        bg-surface
        text-ink
        px-6 sm:px-8 py-8
        relative overflow-hidden
        border border-rule
        ring-1 ring-inset ring-rule-soft
        shadow-[0_24px_48px_-30px_rgba(0,0,0,0.20)]
      "
      data-testid="products-bottom-insight"
    >
      <div aria-hidden className="pointer-events-none absolute -top-12 -right-16 h-56 w-56 rounded-full bg-brand/15 blur-3xl" />
      <div aria-hidden className="pointer-events-none absolute -bottom-12 -left-16 h-48 w-48 rounded-full bg-brand-2/10 blur-3xl" />

      <div className="relative flex items-start justify-between gap-5 flex-wrap">
        <div className="max-w-[640px]">
          <div className="inline-flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.16em] text-ink-soft font-semibold">
            <Sparkles size={10} strokeWidth={2.25} className="text-brand" />
            Clarity, on demand
          </div>
          <h2 className="mt-3 text-[24px] sm:text-[28px] leading-[1.15] tracking-[-0.01em] font-semibold">
            CFO AI gives you clarity on what grows profit.
          </h2>
          <p className="mt-2 text-[13.5px] text-ink-soft leading-relaxed max-w-[540px]">
            Already uploaded? Ask CFO AI about your active dataset — loss-makers, mix shifts, margin
            outliers, or what to discontinue. Haven&rsquo;t uploaded yet? Ask anything about the
            framework first.
          </p>
        </div>
        <button
          type="button"
          onClick={() => openAskCfoAi()}
          className="
            inline-flex items-center gap-2
            h-10 px-4 rounded-lg
            bg-ink text-paper text-[13px] font-medium
            hover:bg-ink/90 transition-colors
            shadow-1
          "
          data-testid="products-bottom-ask-cfo-ai"
        >
          <Sparkles size={13} strokeWidth={2} className="text-brand" />
          Ask CFO AI for insights
        </button>
      </div>
    </section>
  );
}

// ─── Stats strip ─────────────────────────────────────────────────
// Each card renders only when its backing figure exists. The 4 stats
// the spec's reference mockup shows ("SKUs analyzed", "margin outliers",
// "↑18.6% vs last import", "loss-makers") were AUDITED against the
// real API: 2 of 4 needed per-dataset detail that the summary endpoint
// doesn't provide. Rather than fabricate, we substitute 4 stats that
// ARE backed by the already-loaded /api/sales-datasets payload.

interface HonestStats {
  datasetCount: number;
  totalSkus: number | null;        // Σ sku_count across datasets, null when no datasets had it
  totalLineRows: number | null;    // Σ row_count across datasets, null when none
  latestUploadAt: string | null;   // ISO ts of the most recent import
}

function buildHonestStats(datasets: DatasetSummary[]): HonestStats {
  let totalSkus = 0;
  let skusKnown = false;
  let totalLineRows = 0;
  let rowsKnown = false;
  let latest = 0;
  for (const d of datasets) {
    if (typeof d.sku_count === "number") { totalSkus += d.sku_count; skusKnown = true; }
    if (typeof d.row_count === "number") { totalLineRows += d.row_count; rowsKnown = true; }
    const t = new Date(d.uploaded_at).getTime();
    if (Number.isFinite(t) && t > latest) latest = t;
  }
  return {
    datasetCount: datasets.length,
    totalSkus: skusKnown ? totalSkus : null,
    totalLineRows: rowsKnown ? totalLineRows : null,
    latestUploadAt: latest > 0 ? new Date(latest).toISOString() : null,
  };
}

function ProductsStatsStrip({ stats, hasData }: { stats: HonestStats; hasData: boolean }) {
  // True first-visit: explicit honest empty state — no numbers at all.
  if (!hasData) {
    return (
      <section className="mt-10 rounded-2xl border border-rule bg-bg-2/30 px-5 py-5" data-testid="products-stats-empty">
        <p className="text-[13px] text-ink-soft">
          <span className="text-ink font-medium">Insights appear once data is in.</span> Upload your first dataset
          to see SKU counts, line-rows analyzed, and roll-ups across imports — no figures are shown
          until they reflect actual analysis.
        </p>
      </section>
    );
  }

  return (
    <div className="mt-10 grid grid-cols-2 lg:grid-cols-4 gap-3" data-testid="products-stats-strip">
      <StatCard
        label="Datasets analyzed"
        value={stats.datasetCount.toLocaleString("en-GB")}
        sub={stats.datasetCount === 1 ? "1 import on file" : `${stats.datasetCount} imports on file`}
      />
      {stats.totalSkus !== null && (
        <StatCard
          label="SKUs analyzed"
          value={stats.totalSkus.toLocaleString("en-GB")}
          sub="cumulative across imports"
        />
      )}
      {stats.totalLineRows !== null && (
        <StatCard
          label="Line rows ingested"
          value={stats.totalLineRows.toLocaleString("en-GB")}
          sub="cumulative across imports"
        />
      )}
      {stats.latestUploadAt && (
        <StatCard
          label="Latest import"
          value={shortRelative(stats.latestUploadAt)}
          sub={new Date(stats.latestUploadAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}
        />
      )}
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-rule bg-surface px-4 py-3">
      <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium">{label}</div>
      <div className="mt-1.5 text-[22px] font-semibold text-ink tabular-nums leading-none">{value}</div>
      {sub && <div className="mt-1 text-[11px] text-ink-mute">{sub}</div>}
    </div>
  );
}

function shortRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const diff = Date.now() - t;
  if (diff < 60_000) return "just now";
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / (60 * 60_000))}h ago`;
  if (diff < 7 * 24 * 60 * 60_000) return `${Math.floor(diff / (24 * 60 * 60_000))}d ago`;
  return new Date(iso).toLocaleDateString("en-GB", { month: "short", day: "numeric" });
}

// ─── Process flow ────────────────────────────────────────────────
// Static explanatory copy about what the pipeline does. This is
// legitimately static content (describes the flow, not data) — it is
// NOT fabricated numbers. Each step describes a real stage of the
// existing pipeline; nothing here is invented.

function ProductsProcessFlow() {
  const steps = [
    { icon: UploadCloud,    title: "Upload",         body: "Drag your XLSX or CSV. We never store the raw file outside your workspace." },
    { icon: TableProperties, title: "Map rows",       body: "Synonyms find your columns automatically — Romanian or English headers." },
    { icon: Cpu,            title: "Analyze",        body: "Roll up to the SKU, classify, compute per-SKU DIO when inventory/COGS are present." },
    { icon: FileText,       title: "Generate briefing", body: "A board-ready briefing with the anchor / wind-down picture and loss-maker list." },
  ];
  return (
    <section className="mt-10" data-testid="products-process">
      <h2 className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-semibold mb-3">
        What happens next
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {steps.map((s, i) => {
          const Icon = s.icon;
          return (
            <div key={s.title} className="rounded-xl border border-rule bg-surface px-4 py-4">
              <div className="flex items-center gap-2 mb-2">
                <span className="inline-flex items-center justify-center h-7 w-7 rounded-md bg-brand-tint text-brand-d">
                  <Icon size={13} strokeWidth={1.75} />
                </span>
                <span className="text-[11px] tabular-nums text-ink-mute font-medium">0{i + 1}</span>
              </div>
              <div className="text-[13.5px] font-medium text-ink">{s.title}</div>
              <div className="mt-1 text-[12px] text-ink-soft leading-relaxed">{s.body}</div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ─── Accepted formats ────────────────────────────────────────────
// Limits below mirror the actual handler at handleFile() above:
// max 25 MB (enforced), .xlsx / .xls / .csv (accept= attr). The
// multi-sheet line reflects `_pick_data_sheet()` in _sales_extract.py
// which scans sheets and picks the YTD/Q*/first non-summary sheet.

function ProductsAcceptedFormats() {
  return (
    <section className="mt-10 rounded-2xl border border-rule bg-surface px-5 py-5" data-testid="products-accepted-formats">
      <div className="flex items-start gap-4 flex-wrap">
        <div className="flex-1 min-w-0">
          <h2 className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-semibold mb-2">
            Accepted formats
          </h2>
          <ul className="space-y-1.5 text-[12.5px] text-ink-soft">
            <li className="flex items-start gap-2">
              <FileSpreadsheet size={13} strokeWidth={1.75} className="mt-0.5 text-ink-mute" />
              <span><span className="text-ink font-medium">XLSX, XLS, CSV</span> — trading analysis or sales-by-SKU export</span>
            </li>
            <li className="flex items-start gap-2">
              <Layers size={13} strokeWidth={1.75} className="mt-0.5 text-ink-mute" />
              <span>Multi-sheet workbooks supported — the parser picks the YTD/quarterly tab automatically</span>
            </li>
            <li className="flex items-start gap-2">
              <Check size={13} strokeWidth={1.75} className="mt-0.5 text-ink-mute" />
              <span>Up to <span className="text-ink font-medium">{PRODUCTS_UPLOAD_MAX_MB} MB</span> per file (enforced)</span>
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}

// ─── Recent imports ──────────────────────────────────────────────
// Real history only — sourced from `datasets` (the same payload that
// drives the post-upload portfolio view). Empty → honest empty card,
// NEVER sample rows. Each row shows: real filename, real date, real
// row count, real document_status.

function ProductsRecentImports({ datasets }: { datasets: DatasetSummary[] }) {
  if (datasets.length === 0) {
    return (
      <section className="mt-10 rounded-2xl border border-rule bg-surface px-5 py-6 text-center" data-testid="products-recent-empty">
        <div className="mx-auto h-9 w-9 rounded-lg bg-bg-2 text-ink-mute flex items-center justify-center mb-2">
          <Boxes size={15} strokeWidth={1.75} />
        </div>
        <p className="text-[13px] text-ink-soft">
          <span className="text-ink font-medium">No imports yet.</span> Your uploads will appear here.
        </p>
      </section>
    );
  }
  const rows = datasets.slice(0, 5);
  return (
    <section className="mt-10" data-testid="products-recent-imports">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-semibold">
          Recent imports
        </h2>
        {datasets.length > rows.length && (
          <span className="text-[11px] text-ink-mute">{datasets.length - rows.length} more</span>
        )}
      </div>
      <div className="rounded-xl border border-rule bg-surface overflow-hidden">
        <div className="grid grid-cols-[1fr_140px_100px_110px] gap-3 px-4 py-2 bg-bg-2/40 border-b border-rule text-[10.5px] uppercase tracking-[0.08em] text-ink-mute font-medium">
          <div>File</div>
          <div className="text-right">Rows</div>
          <div className="text-right">SKUs</div>
          <div>Status</div>
        </div>
        <ul>
          {rows.map((d) => (
            <li key={d.id} className="grid grid-cols-[1fr_140px_100px_110px] gap-3 px-4 py-2.5 border-b border-rule/60 last:border-0 items-baseline">
              <div className="min-w-0">
                <div className="text-[13px] text-ink truncate">{d.source_filename ?? d.label}</div>
                <div className="text-[10.5px] text-ink-mute mt-0.5">
                  {d.label !== (d.source_filename ?? d.label) && <span>{d.label} · </span>}
                  {new Date(d.uploaded_at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}
                </div>
              </div>
              <div className="text-right text-[12.5px] tabular-nums text-ink-soft">
                {d.row_count != null ? d.row_count.toLocaleString("en-GB") : "—"}
              </div>
              <div className="text-right text-[12.5px] tabular-nums text-ink-soft">
                {d.sku_count != null ? d.sku_count.toLocaleString("en-GB") : "—"}
              </div>
              <div>
                <DocumentStatusPill status={d.document_status} active={d.is_active} />
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function DocumentStatusPill({ status, active }: { status: DocumentStatus | null; active: boolean }) {
  // Real status from the backend; never a placeholder.
  const s = (status ?? "").toLowerCase();
  let label = status ?? "unknown";
  let cls = "border-rule text-ink-soft bg-bg-2/40";
  if (s === "analyzed") { label = active ? "Active" : "Analyzed"; cls = "border-emerald-300/60 text-emerald-700 bg-emerald-50 dark:bg-emerald-500/10"; }
  else if (s === "queued" || s === "extracting" || s === "ingesting") { label = "Processing"; cls = "border-amber-300/60 text-amber-800 bg-amber-50 dark:bg-amber-500/10"; }
  else if (s === "failed") { label = "Failed"; cls = "border-red-300/60 text-red-700 bg-red-50 dark:bg-red-500/10"; }
  return (
    <span className={`inline-flex items-center h-5 px-2 rounded-full border text-[10.5px] font-medium uppercase tracking-[0.04em] ${cls}`}>
      {label}
    </span>
  );
}

/** Structure-only example of an accepted sales-analysis file.
 *  Columns mirror what `_sales_extract.py` synonyms accept; placeholder
 *  rows are fictional and labeled as such.
 *
 *  `Inventory value` + `COGS` are NEW optional columns (added together)
 *  that unlock per-SKU DIO and the company-level CCC roll-up. Existing
 *  files without them upload identically; rows without inventory/COGS
 *  show DIO as "—" rather than as 0 (no fabricated turnover). */
function SalesAnalysisFormatHint() {
  const headers = [
    "Canal", "Categ_pr", "Brand", "Denumire produs",
    "Volume (to)", "NIV (kRON)", "GM (kRON)", "GM2 pct",
    "Inventory value", "COGS",
  ];
  const rows: Array<(string | number)[]> = [
    ["RETAIL", "CATEGORY 1", "BRAND X", "EXAMPLE PRODUCT A", 100, 1500, 300, 0.20,  450, 1200],
    ["HORECA", "CATEGORY 1", "BRAND X", "EXAMPLE PRODUCT B",  50,  800, 120, 0.15,  220,  680],
    ["EXPORT", "CATEGORY 2", "BRAND Y", "EXAMPLE PRODUCT C", 200, 3000, 450, 0.15, "—", "—"],
  ];
  function fmt(v: string | number): string {
    if (typeof v === "number") {
      if (v < 1) return v.toFixed(2);
      return v.toLocaleString("en-US");
    }
    return v;
  }
  return (
    <div
      data-testid="sales-format-hint"
      className="mt-8 rounded-2xl border border-rule bg-surface px-5 py-5"
    >
      <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
        <div className="min-w-0">
          <div className="text-[10.5px] uppercase tracking-[0.1em] font-semibold text-ink-soft">
            Expected format
          </div>
          <h4 className="font-serif text-[18px] leading-tight text-ink mt-1">
            Sales / trading analysis — XLSX
          </h4>
          <p className="text-[12.5px] text-ink-soft mt-1 max-w-[640px]">
            One row per SKU-channel-period line. Headers below show the column
            names the parser recognizes (Romanian and English variants both
            accepted). Only <strong className="text-ink">Denumire produs</strong> and{" "}
            <strong className="text-ink">NIV</strong> are required overall;{" "}
            <strong className="text-ink">Inventory value</strong> +{" "}
            <strong className="text-ink">COGS</strong> are optional but unlock
            per-SKU <strong className="text-ink">DIO</strong>; the company-level{" "}
            <strong className="text-ink">CCC</strong> roll-up additionally uses
            the period trial balance for DSO / DPO.
          </p>
        </div>
        <div className="shrink-0 flex flex-col items-end gap-1">
          <a
            href="/examples/example_products_trading.xlsx"
            download="example_products_trading.xlsx"
            data-testid="download-sales-template"
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-rule bg-bg-2/40 text-ink text-[12.5px] font-medium hover:bg-bg-2 transition-colors"
          >
            <UploadCloud size={13} strokeWidth={1.75} className="rotate-180" />
            Download example (XLSX)
          </a>
          <span className="text-[10.5px] text-ink-mute italic max-w-[220px] text-right">
            Anonymized example — match these columns; fictional data.
          </span>
        </div>
      </div>

      <div className="overflow-x-auto -mx-1 px-1">
        <table className="w-full text-[12.5px] tabular-nums">
          <thead>
            <tr className="text-left border-b border-rule">
              {headers.map((h) => (
                <th
                  key={h}
                  className="py-1.5 pr-4 font-semibold text-[10.5px] uppercase tracking-[0.04em] text-ink-soft whitespace-nowrap"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-rule/50 last:border-0">
                {r.map((v, j) => (
                  <td
                    key={j}
                    className={`py-1.5 pr-4 whitespace-nowrap ${
                      typeof v === "number" ? "font-mono text-ink" : "text-ink"
                    }`}
                  >
                    {fmt(v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-[11px] text-ink-mute italic">
        Placeholder rows for illustration only &mdash; replace with your real export.
        The third row deliberately omits Inventory value &amp; COGS to demonstrate
        the &ldquo;DIO not available&rdquo; rendering: rows without both inputs show
        &ldquo;&mdash;&rdquo;, never 0, and are excluded from the company DIO aggregate.
      </p>
    </div>
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
