// Products — SKU portfolio decision surface.
//
// Renders the engine-classified per-SKU rollup (one row per SKU) plus the
// Opus 4.7 briefing + recommendations layer. Driven by the latest active
// sku-scope document for the org. The classification engine is deterministic
// (Python pipeline → sku_aggregates table), the briefing is the LLM layer.
//
// Data path: GET /api/sku-analysis/portfolio → totals + skus + analysis.
// Independent of useActivePeriod — financial periods never appear here.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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

// ─── Types matching /api/sku-analysis/portfolio ─────────────────────────────

type Classification =
  | "anchor" | "anchor_alert" | "keep" | "watch"
  | "eliminate" | "wind_down" | "scale";

interface SkuRow {
  id: string;
  sku: string;
  brand: string | null;
  category: string | null;
  channel: string | null;
  volume: number | null;
  volume_unit: string | null;
  units_sold: number | null;
  revenue: number;
  cogs: number;
  gross_margin: number | null;
  gross_margin_pct: number | null;
  real_margin: number | null;
  real_margin_pct: number | null;
  inventory_value: number | null;
  days_inventory_on_hand: number | null;
  capital_tied_up: number | null;
  classification: Classification;
  classification_reason: string | null;
  user_override_classification: Classification | null;
}

interface PortfolioPayload {
  document: { id: string; filename: string; status: DocumentStatus; created_at: string; is_active: boolean } | null;
  totals: {
    sku_count: number;
    category_count: number;
    categories: string[];
    classification_counts: Partial<Record<Classification, number>>;
    losses_from_eliminate: number;
    revenue: number;
    profit: number;
    volume: number;
  } | null;
  skus: SkuRow[];
  analysis: {
    briefing: string | null;
    recommendations: Array<{ severity?: string; title?: string; rationale?: string; actions?: string[]; estimated_ron_impact?: number | null }>;
    summary: Record<string, unknown>;
    model: string | null;
  } | null;
}

interface InflightDoc {
  id: string;
  filename: string;
  status: DocumentStatus;
  error?: string | null;
}

// ─── API ────────────────────────────────────────────────────────────────────

async function authHeader(): Promise<Record<string, string> | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return null;
  return { Authorization: `Bearer ${token}` };
}

async function fetchPortfolio(): Promise<PortfolioPayload | null> {
  const headers = await authHeader();
  if (!headers) return null;
  const apiUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";
  const res = await fetch(`${apiUrl}/api/sku-analysis/portfolio`, { headers });
  if (!res.ok) return null;
  return (await res.json()) as PortfolioPayload;
}

async function fetchInflight(): Promise<InflightDoc | null> {
  const headers = await authHeader();
  if (!headers) return null;
  const apiUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";
  const res = await fetch(`${apiUrl}/api/sku-analysis/inflight`, { headers });
  if (!res.ok) return null;
  const j = await res.json() as { document: { id: string; original_filename: string; status: DocumentStatus; error: string | null } | null };
  return j.document ? { id: j.document.id, filename: j.document.original_filename, status: j.document.status, error: j.document.error } : null;
}

// ─── Bucket meta ────────────────────────────────────────────────────────────

const BUCKET_META: Record<Classification, { label: string; tone: string; dot: string; description: string }> = {
  eliminate:    { label: "Eliminate",    tone: "border-red-300/60 bg-red-50/40 text-red-700",       dot: "bg-red-500",     description: "Bleeds money on every unit" },
  wind_down:    { label: "Wind down",    tone: "border-orange-300/60 bg-orange-50/40 text-orange-700", dot: "bg-orange-500", description: "Sub-decile volume, negative margin" },
  watch:        { label: "Watch",        tone: "border-amber-300/60 bg-amber-50/40 text-amber-700", dot: "bg-amber-500",   description: "Thin margin or working-capital drag" },
  keep:         { label: "Keep",         tone: "border-rule bg-bg-2/30 text-ink-soft",              dot: "bg-ink-mute",    description: "Profitable, ordinary" },
  anchor_alert: { label: "Anchor alert", tone: "border-amber-300/60 bg-amber-50/40 text-amber-700", dot: "bg-amber-500",   description: "Anchor with deteriorating signal" },
  scale:        { label: "Scale",        tone: "border-blue-300/60 bg-blue-50/40 text-blue-700",    dot: "bg-blue-500",    description: "Top margin — allocate more" },
  anchor:       { label: "Anchor",       tone: "border-emerald-300/60 bg-emerald-50/40 text-emerald-700", dot: "bg-emerald-500", description: "Top-decile profit — protect" },
};

const FILTER_ORDER: Classification[] = ["eliminate", "watch", "anchor_alert", "scale", "anchor", "wind_down", "keep"];

// ─── Page ───────────────────────────────────────────────────────────────────

export default function Products() {
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("");
  const [sort, setSort] = useState<"profit_desc" | "rm_pct_desc" | "rm_pct_asc" | "volume_desc">("profit_desc");

  // Portfolio + inflight cached via React Query so navigating away and
  // back paints from cache instead of refetching. The realtime
  // subscription (below) is the canonical source of truth for status
  // changes — it invalidates these queries on terminal status.
  const qc = useQueryClient();
  const { data: portfolio, isLoading: loadingPortfolio } = useQuery({
    queryKey: ["sku-portfolio"],
    queryFn: fetchPortfolio,
  });
  const { data: inflightFetched, isLoading: loadingInflight } = useQuery({
    queryKey: ["sku-inflight"],
    queryFn: fetchInflight,
  });
  const inflight = inflightFetched ?? null;
  const loading = loadingPortfolio || loadingInflight;

  const refresh = useCallback(async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["sku-portfolio"] }),
      qc.invalidateQueries({ queryKey: ["sku-inflight"] }),
    ]);
  }, [qc]);

  // Live status updates while the pipeline runs — invalidate React Query
  // caches on terminal status so the portfolio + inflight data refresh.
  useEffect(() => {
    if (!inflight) return;
    const unsub = subscribeToDocumentStatus(inflight.id, (next) => {
      if (next.status === "analyzed" || next.status === "failed") {
        void refresh();
      }
    });
    return unsub;
  }, [inflight?.id, refresh]);

  // ALL HOOKS BEFORE ANY EARLY RETURN.
  // Rules of hooks: the hook count must match across every render. Earlier
  // versions of this component had `if (loading) return …; if (inflight)
  // return …; if (empty) return …;` ABOVE this useMemo, which meant the
  // first render (loading) called fewer hooks than subsequent renders
  // (loaded). React threw "Rendered more hooks than during the previous
  // render". Compute `filtered` against the (possibly-empty) sku list now
  // and let the JSX branches below decide what to actually render.
  const activeFilter = (params.get("filter") as Classification | null) ?? null;
  const skusForFilter = portfolio?.skus ?? [];
  const filtered = useMemo(() => {
    let xs = skusForFilter;
    if (activeFilter) xs = xs.filter((s) => s.classification === activeFilter);
    if (categoryFilter) xs = xs.filter((s) => s.category === categoryFilter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      xs = xs.filter((s) =>
        s.sku.toLowerCase().includes(q)
        || (s.brand ?? "").toLowerCase().includes(q)
        || (s.category ?? "").toLowerCase().includes(q),
      );
    }
    const cmp: Record<typeof sort, (a: SkuRow, b: SkuRow) => number> = {
      profit_desc: (a, b) => (b.real_margin ?? 0) - (a.real_margin ?? 0),
      rm_pct_desc: (a, b) => (b.real_margin_pct ?? 0) - (a.real_margin_pct ?? 0),
      rm_pct_asc:  (a, b) => (a.real_margin_pct ?? 0) - (b.real_margin_pct ?? 0),
      volume_desc: (a, b) => (b.volume ?? 0) - (a.volume ?? 0),
    };
    return [...xs].sort(cmp[sort]);
  }, [skusForFilter, activeFilter, categoryFilter, search, sort]);

  // ─── Render branches (no more hooks past this point) ──────────────────────
  if (loading && !portfolio) {
    return (
      <AppShell>
        <div className="max-w-[680px] mx-auto py-16 text-center">
          <Loader2 size={20} className="animate-spin mx-auto text-ink-mute mb-3" />
          <p className="text-[13px] text-ink-soft">Loading SKU portfolio…</p>
        </div>
      </AppShell>
    );
  }

  if (inflight) {
    return <AppShell><InflightCard inflight={inflight} /></AppShell>;
  }

  if (!portfolio || !portfolio.document || portfolio.skus.length === 0) {
    return <AppShell><EmptyState onUploaded={refresh} hasDocButNoSkus={!!portfolio?.document} /></AppShell>;
  }

  const { document: doc, totals, analysis } = portfolio;

  return (
    <AppShell>
      <section className="space-y-6 max-w-[1200px]">
        <PortfolioHeader
          totals={totals!}
          docFilename={doc.filename}
          createdAt={doc.created_at}
          modelName={analysis?.model ?? null}
        />

        <FilterBar
          totals={totals!}
          activeFilter={activeFilter}
          onSetFilter={(f) => {
            const sp = new URLSearchParams(params);
            if (f) sp.set("filter", f); else sp.delete("filter");
            setParams(sp, { replace: true });
          }}
          search={search}
          onSearch={setSearch}
          categoryFilter={categoryFilter}
          onCategoryFilter={setCategoryFilter}
          categories={totals!.categories}
          sort={sort}
          onSort={setSort}
          onExport={() => exportCsv(filtered, doc.filename)}
        />

        <SkuTable rows={filtered} />

        {analysis?.briefing && <BriefingCard briefing={analysis.briefing} model={analysis.model} />}

        {analysis && analysis.recommendations.length > 0 && (
          <Recommendations recs={analysis.recommendations} />
        )}

        <PortfolioTotals totals={totals!} />
      </section>
    </AppShell>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function PortfolioHeader({
  totals, docFilename, createdAt, modelName,
}: {
  totals: NonNullable<PortfolioPayload["totals"]>;
  docFilename: string;
  createdAt: string;
  modelName: string | null;
}) {
  const eliminate = totals.classification_counts.eliminate ?? 0;
  const watch = totals.classification_counts.watch ?? 0;
  const anchor = totals.classification_counts.anchor ?? 0;
  return (
    <header data-testid="portfolio-header">
      <div className="label-eyebrow">Portfolio</div>
      <h1 className="mt-2 font-serif text-[34px] sm:text-[40px] leading-[1.05] tracking-[-0.02em] text-ink">
        Each SKU, decided.
      </h1>
      <p className="mt-2 text-[14px] text-ink-soft max-w-[680px]">
        {totals.sku_count.toLocaleString("en-GB")} SKUs across {totals.category_count} categories. The engine classified every one — review the buckets below.
      </p>
      <p className="mt-1 text-[11.5px] text-ink-mute">
        Source: {docFilename} · analyzed {new Date(createdAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}
        {modelName ? ` · ${modelName}` : ""}
      </p>

      <div className="mt-6 grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard data-testid="kpi-sku-count" label="SKUs" value={totals.sku_count.toLocaleString("en-GB")} sub={`in ${totals.category_count} cats`} />
        <KpiCard
          data-testid="kpi-eliminate"
          label="Eliminate"
          value={eliminate.toLocaleString("en-GB")}
          sub={totals.losses_from_eliminate < 0 ? `${formatRon(totals.losses_from_eliminate)} losses` : "no losses"}
          tone="critical"
        />
        <KpiCard data-testid="kpi-watch" label="Watch" value={watch.toLocaleString("en-GB")} sub="thin margin / DIO" tone="warn" />
        <KpiCard data-testid="kpi-anchor" label="Anchors" value={anchor.toLocaleString("en-GB")} sub="protecting volume" tone="strong" />
      </div>
    </header>
  );
}

function KpiCard({
  label, value, sub, tone, ...rest
}: { label: string; value: string; sub?: string; tone?: "critical" | "warn" | "strong" } & React.HTMLAttributes<HTMLDivElement>) {
  const ring = tone === "critical" ? "border-red-300/60" : tone === "warn" ? "border-amber-300/60" : tone === "strong" ? "border-emerald-300/60" : "border-rule";
  return (
    <div {...rest} className={`rounded-2xl border ${ring} bg-surface p-4`}>
      <div className="text-[11px] uppercase tracking-[0.1em] text-ink-mute font-medium">{label}</div>
      <div className="mt-1 font-serif text-[26px] text-ink leading-tight">{value}</div>
      {sub && <div className="text-[11.5px] text-ink-soft mt-0.5">{sub}</div>}
    </div>
  );
}

function FilterBar({
  totals, activeFilter, onSetFilter, search, onSearch,
  categoryFilter, onCategoryFilter, categories, sort, onSort, onExport,
}: {
  totals: NonNullable<PortfolioPayload["totals"]>;
  activeFilter: Classification | null;
  onSetFilter: (f: Classification | null) => void;
  search: string;
  onSearch: (s: string) => void;
  categoryFilter: string;
  onCategoryFilter: (c: string) => void;
  categories: string[];
  sort: "profit_desc" | "rm_pct_desc" | "rm_pct_asc" | "volume_desc";
  onSort: (s: "profit_desc" | "rm_pct_desc" | "rm_pct_asc" | "volume_desc") => void;
  onExport: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-2 rounded-lg border border-rule bg-surface px-3 h-9 flex-1 min-w-[240px] max-w-[420px]">
          <Search size={13} className="text-ink-mute" strokeWidth={1.75} />
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search SKU, brand, category…"
            className="flex-1 bg-transparent text-[13px] outline-none placeholder:text-ink-mute"
          />
        </div>
        <select
          value={categoryFilter}
          onChange={(e) => onCategoryFilter(e.target.value)}
          className="h-9 rounded-lg border border-rule bg-surface px-2.5 text-[12.5px] text-ink"
        >
          <option value="">All categories</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select
          value={sort}
          onChange={(e) => onSort(e.target.value as never)}
          className="h-9 rounded-lg border border-rule bg-surface px-2.5 text-[12.5px] text-ink"
        >
          <option value="profit_desc">Sort: profit ↓</option>
          <option value="rm_pct_desc">Sort: real margin % ↓</option>
          <option value="rm_pct_asc">Sort: real margin % ↑</option>
          <option value="volume_desc">Sort: volume ↓</option>
        </select>
        <button
          type="button"
          onClick={onExport}
          data-testid="export-portfolio"
          className="h-9 px-3 rounded-lg border border-rule bg-surface text-[12.5px] text-ink hover:bg-bg-2 transition-colors"
        >
          Export CSV
        </button>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        <Chip
          testid="chip-all"
          label="All"
          count={totals.sku_count}
          active={activeFilter === null}
          onClick={() => onSetFilter(null)}
        />
        {FILTER_ORDER.map((c) => {
          const n = totals.classification_counts[c] ?? 0;
          if (!n) return null;
          const meta = BUCKET_META[c];
          return (
            <Chip
              key={c}
              testid={`chip-${c}`}
              label={meta.label}
              count={n}
              active={activeFilter === c}
              dotClass={meta.dot}
              onClick={() => onSetFilter(activeFilter === c ? null : c)}
            />
          );
        })}
      </div>
    </div>
  );
}

function Chip({
  testid, label, count, active, onClick, dotClass,
}: {
  testid: string; label: string; count: number; active: boolean; onClick: () => void; dotClass?: string;
}) {
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

function SkuTable({ rows }: { rows: SkuRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-rule bg-surface px-6 py-10 text-center text-[13px] text-ink-soft">
        No SKUs match this filter.
      </div>
    );
  }
  return (
    <div className="rounded-2xl border border-rule bg-surface overflow-hidden">
      <table className="w-full text-[12.5px]">
        <thead>
          <tr className="bg-bg-2/40 text-[10.5px] uppercase tracking-[0.08em] text-ink-mute">
            <th className="text-left py-2.5 px-4 font-medium">SKU · Category</th>
            <th className="text-right py-2.5 px-4 font-medium">Volume</th>
            <th className="text-right py-2.5 px-4 font-medium">GM %</th>
            <th className="text-right py-2.5 px-4 font-medium">Real margin %</th>
            <th className="text-right py-2.5 px-4 font-medium">Profit</th>
            <th className="text-left py-2.5 px-4 font-medium">Signal</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => {
            const meta = BUCKET_META[s.classification];
            const profit = s.real_margin ?? 0;
            return (
              <tr key={s.id} data-testid="sku-row" className="border-t border-rule hover:bg-bg-2/40 transition-colors">
                <td className="py-2.5 px-4">
                  <div className="text-ink truncate max-w-[420px]">{s.sku}</div>
                  <div className="text-[10.5px] text-ink-mute mt-0.5">
                    {s.brand && <span>{s.brand}</span>}
                    {s.brand && s.category && <span> · </span>}
                    {s.category && <span>{s.category}</span>}
                    {s.channel && <span> · {s.channel}</span>}
                  </div>
                </td>
                <td className="py-2.5 px-4 text-right tabular-nums text-ink-soft">
                  {s.volume !== null ? `${s.volume.toLocaleString("en-GB", { maximumFractionDigits: 1 })} ${s.volume_unit ?? "t"}` : "—"}
                </td>
                <td className="py-2.5 px-4 text-right tabular-nums text-ink-soft">
                  {s.gross_margin_pct !== null ? `${(s.gross_margin_pct * 100).toFixed(1)}%` : "—"}
                </td>
                <td className="py-2.5 px-4 text-right tabular-nums">
                  <span className={s.real_margin_pct !== null && s.real_margin_pct < 0 ? "text-red-700" : "text-ink"}>
                    {s.real_margin_pct !== null ? `${(s.real_margin_pct * 100).toFixed(1)}%` : "—"}
                  </span>
                </td>
                <td className="py-2.5 px-4 text-right tabular-nums">
                  <span className={profit < 0 ? "text-red-700" : "text-ink"}>
                    {formatRon(profit)}
                  </span>
                </td>
                <td className="py-2.5 px-4">
                  <span className={`inline-flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.06em] font-semibold px-2 py-0.5 rounded-full border ${meta.tone}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
                    {meta.label}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function BriefingCard({ briefing, model }: { briefing: string; model: string | null }) {
  return (
    <section data-testid="cfo-briefing" className="rounded-2xl border border-brand/25 bg-brand-tint/40 p-5">
      <div className="flex items-center gap-2 text-[10.5px] uppercase tracking-[0.1em] text-brand-d font-medium mb-2">
        <Sparkles size={11} strokeWidth={2} />
        CFO briefing{model ? ` — ${model}` : ""}
      </div>
      <p className="text-[14px] text-ink leading-relaxed whitespace-pre-line">{briefing}</p>
    </section>
  );
}

function Recommendations({ recs }: { recs: Array<{ severity?: string; title?: string; rationale?: string; actions?: string[]; estimated_ron_impact?: number | null }> }) {
  return (
    <section>
      <div className="label-eyebrow mb-3">AI recommendations</div>
      <ul className="space-y-3">
        {recs.map((r, i) => {
          const sev = (r.severity ?? "medium").toLowerCase();
          const tone =
            sev === "critical" ? "border-red-300/60 bg-red-50/40" :
            sev === "high"     ? "border-amber-300/60 bg-amber-50/40" :
            sev === "low"      ? "border-blue-300/60 bg-blue-50/40" :
                                 "border-rule bg-surface";
          return (
            <li key={i} data-testid="sku-recommendation-card" className={`rounded-2xl border ${tone} p-5`}>
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
  );
}

function PortfolioTotals({ totals }: { totals: NonNullable<PortfolioPayload["totals"]> }) {
  return (
    <section data-testid="portfolio-totals" className="rounded-2xl border border-rule bg-surface p-4">
      <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium mb-2">Total portfolio</div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-[12.5px]">
        <Stat label="Volume" value={`${totals.volume.toLocaleString("en-GB", { maximumFractionDigits: 1 })} t`} />
        <Stat label="Revenue (NIV)" value={formatRon(totals.revenue)} />
        <Stat label="Profit" value={formatRon(totals.profit)} />
        <Stat label="Losses" value={formatRon(totals.losses_from_eliminate)} tone={totals.losses_from_eliminate < 0 ? "alert" : undefined} />
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
    mapping:    { label: "Categorizing rollups…",  ordinal: 2 },
    computing:  { label: "Computing margins…",     ordinal: 3 },
    narrating:  { label: "Generating insights…",   ordinal: 4 },
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
            {failed
              ? <AlertCircle size={16} className="text-alert" strokeWidth={2} />
              : <Loader2 size={16} className="text-brand animate-spin" strokeWidth={2} />}
            <span className="text-[14px] font-medium text-ink">
              {failed ? "Couldn't finish analysis" : "Analyzing your SKU data…"}
            </span>
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

function EmptyState({ onUploaded, hasDocButNoSkus }: { onUploaded: () => void; hasDocButNoSkus: boolean }) {
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
          Upload your SKU data to begin
        </h1>
        <p className="mt-4 text-[15px] text-ink-soft max-w-[520px] mx-auto">
          {hasDocButNoSkus
            ? "Your last upload was processed but no SKU rows were extracted. Try a more granular file — invoice register, sales-by-product, or trading analysis."
            : "Trading analysis (XLSX), invoice register, or sales-by-product. The engine classifies every SKU into anchor / scale / watch / eliminate buckets — completely separate from your financial-statement uploads."}
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
          XLSX · CSV — multi-sheet workbooks supported.
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
          Detect · extract · classify · briefing
        </p>
      </div>
    </section>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatRon(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}RON ${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000)    return `${sign}RON ${Math.round(abs / 1_000).toLocaleString("en-GB")}k`;
  return `${sign}RON ${Math.round(abs).toLocaleString("en-GB")}`;
}

function exportCsv(rows: SkuRow[], filename: string) {
  const headers = ["sku", "brand", "category", "channel", "volume", "volume_unit", "revenue", "cogs", "gross_margin", "gross_margin_pct", "real_margin", "real_margin_pct", "classification", "classification_reason"];
  const lines = [headers.join(",")];
  for (const r of rows) {
    const cells = [
      r.sku, r.brand ?? "", r.category ?? "", r.channel ?? "",
      r.volume ?? "", r.volume_unit ?? "",
      r.revenue ?? "", r.cogs ?? "",
      r.gross_margin ?? "", r.gross_margin_pct ?? "",
      r.real_margin ?? "", r.real_margin_pct ?? "",
      r.classification, (r.classification_reason ?? "").replace(/"/g, '""'),
    ].map((v) => {
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s}"` : s;
    });
    lines.push(cells.join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${filename.replace(/\.[^.]+$/, "")}_portfolio.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
}
