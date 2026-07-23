// Products — full SKU portfolio with virtualized table.
//
// One row per unique product_name (406 for the user's trading-analysis
// file), classified deterministically by the Python engine. Filters,
// search, and sort are client-side over the full payload — the API
// returns the whole portfolio in one request (~150KB for 400 SKUs)
// because the table virtualizes via @tanstack/react-virtual.

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { SourceText } from "@/components/ui/SourceText";
import { Money } from "@/components/ui/Money";
import { useCurrency } from "@/stores/currency";
import { formatMoneyFrom } from "@/lib/money";
import type { Currency } from "@/lib/rates";
import { categoryHint } from "@/lib/categoryHints";
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
import { CategoriesOverview, BackToCategoriesPill } from "@/components/cfo/products/CategoriesOverview";
import { DioPersistenceBanner } from "@/components/cfo/products/DioPersistenceBanner";
import { ViewToggle, type ProductsView } from "@/components/cfo/products/ViewToggle";
import { TemplateDownloadCard } from "@/components/cfo/products/TemplateDownloadCard";
import { DatasetsToggle, useDatasetsCount } from "@/components/cfo/DatasetsPanel";
import { SkuDetailDrawer } from "@/components/cfo/SkuDetailDrawer";
import { openAskCfoAi } from "@/components/cfo/chat/openAskCfoAi";
import { useActivePeriod } from "@/lib/activePeriod";
import { useActivePeriodFallback } from "@/hooks/useActivePeriodFallback";
import { useAuth } from "@/lib/auth";
import { readSkuVerdict, writeSkuVerdict } from "@/lib/dataPresence";
import {
  DEFAULT_FINANCING,
  RULES,
  computeFinalBucket,
  countFinalBuckets,
  type BucketContext,
} from "@/lib/decisionRules";
import { useDecisionRules } from "@/lib/decisionRulesStore";
import type { Bucket3 } from "@/lib/bucket3";
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
import { GuideMeButton } from "@/components/learning/GuideMeButton";
import { PRODUCTS_GUIDE } from "@/components/learning/pageGuides";
// F5.0 Phase 8 — Products / SKU learning. The 3 bucket KPI labels
// (Protect / Watch / Wind down) become click-to-learn — each routes to
// the concept that explains its decision-rule logic. The SKU count
// stays a raw label since it doesn't need explanation.
import { LearnableRowLabel } from "@/components/learning/LearnableRowLabel";

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
  wind_down:    { label: "Wind down",    dot: "bg-[#5CD3C5]",  rowTint: "" },
  watch:        { label: "Watch",        dot: "bg-[#5CD3C5]",   rowTint: "" },
  keep:         { label: "Keep",         dot: "bg-ink-mute",    rowTint: "" },
  anchor_alert: { label: "Anchor alert", dot: "bg-[#5CD3C5]",   rowTint: "" },
  scale:        { label: "Scale",        dot: "bg-[#5CD3C5]",    rowTint: "" },
  anchor:       { label: "Anchor",       dot: "bg-[#5CD3C5]", rowTint: "" },
};

const FILTER_ORDER: Classification[] = ["eliminate", "wind_down", "watch", "anchor_alert", "scale", "anchor", "keep"];

// Display metadata for the 3-bucket filter chips. Kept in this file (not in
// bucket3.ts) so the chip-specific Tailwind tokens (`bg-[#5CD3C5]` etc.)
// stay co-located with the other Products-page UI tokens.
const BUCKET3_FILTER_META: Record<Bucket3, { label: string; dot: string }> = {
  protect:   { label: "Protect",   dot: "bg-[#5CD3C5]" },
  watch:     { label: "Watch",     dot: "bg-[#5CD3C5]" },
  wind_down: { label: "Wind down", dot: "bg-[#5CD3C5]" },
};

// ─── Page ───────────────────────────────────────────────────────────────────

export default function Products() {
  // 2026-05-24 — auto-canonicalize URL when ?period= missing. Without this,
  // navigating to Products from the sidebar shows the empty "Upload your
  // data" state even when the user has docs loaded.
  useActivePeriodFallback();

  // CUR-FIX-D — source currency for SKU money values. SKU uploads originate
  // from Romanian operator workflows so default is RON; when a trial-balance
  // period is loaded we honor its declared `statements.currency` instead so
  // a future multi-currency client lands on the right axis. Display side
  // (RON/EUR/USD) is owned globally by <CurrencyProvider>; the toggle in
  // TopHeader flips every <Money> on this page live without refetch.
  const period = useActivePeriod();
  const sourceCurrency: Currency = ((period.statements?.currency as Currency) || "RON");
  // CUR-FIX-F — export pipeline needs the display currency + rate as raw
  // primitives (the convert helper inside `exportCsv` lives outside the
  // React tree). Read them once here so the click handler stays a pure
  // arrow function.
  const { display: displayCurrencyForExport, rates: ratesPayload } = useCurrency();
  const exportRate =
    sourceCurrency === displayCurrencyForExport
      ? 1
      : (ratesPayload.rates[displayCurrencyForExport] ?? 1) /
        (ratesPayload.rates[sourceCurrency] ?? 1);

  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const { toast } = useToast();
  const qc = useQueryClient();

  // Data-presence gate for the SKU (sales-dataset) domain. When the persisted
  // verdict for this user is `false` ("no datasets"), the datasets + inflight
  // queries below stay DISABLED so Products renders its empty dropzone instantly
  // with ZERO API calls — even on a hard refresh / deep link. `undefined` means
  // "unknown, resolve once"; the resolution effect then records the verdict.
  const { user } = useAuth();
  const uid = user?.id ?? null;
  const [skuGate, setSkuGate] = useState<boolean | undefined>(
    () => (uid ? readSkuVerdict(uid) : undefined),
  );
  const skuQueriesEnabled = skuGate !== false;
  const [search, setSearch] = useState("");
  // 2026-05-26 (perf pass) — replaced the prior setTimeout-200ms debounce
  // with React 18's useDeferredValue. Both make the search input feel
  // instant by deferring the expensive 5,800-row filter pass, but
  // useDeferredValue is *adaptive*: on a fast device it defers ~0ms; on
  // a slow device it defers however long is needed for React to keep up
  // with input. A fixed 200ms setTimeout penalised everyone equally and
  // also fired even when the device wasn't busy — wasted latency. The
  // hook also integrates with concurrent rendering, so the filter pass
  // can be interrupted mid-work if the user keeps typing.
  const debouncedSearch = useDeferredValue(search);
  const [sortKey, setSortKey] = useState<"gm_krn" | "gm_pct" | "volume_tons" | "niv_krn" | "name">("gm_krn");
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");
  // Selected SKU drives the detail drawer. We store the id (not the row) so
  // the drawer re-renders from fresh data after a mutation invalidates the
  // SKUs query.
  const [selectedSkuId, setSelectedSkuId] = useState<string | null>(null);

  // 2026-05-26 — global upload trigger. DatasetsPanel's "Upload sales
  // dataset" button dispatches a `cfo:request-sku-upload` event. The
  // EmptyState dropzone unmounts as soon as a dataset is loaded, so
  // its file input isn't in the DOM when the user clicks the panel's
  // upload button. We mount our own always-present hidden input here
  // + listen for the event so the file picker opens regardless of
  // whether the dropzone is currently visible.
  const uploadEnqueue = useUploadEnqueue();
  const pageUploadRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const handler = () => pageUploadRef.current?.click();
    window.addEventListener("cfo:request-sku-upload", handler);
    return () => window.removeEventListener("cfo:request-sku-upload", handler);
  }, []);
  const handlePageUploadFile = useCallback(async (file: File) => {
    if (file.size > PRODUCTS_UPLOAD_MAX_BYTES) {
      toast({
        title: "File too large",
        description: `${(file.size / 1_000_000).toFixed(1)} MB exceeds the ${PRODUCTS_UPLOAD_MAX_MB} MB limit.`,
        variant: "destructive",
      });
      return;
    }
    const { row, error } = await uploadDocument(file, { scope: "sku" });
    if (!row) {
      toast({ title: "Upload failed", description: error ?? "Unknown error.", variant: "destructive" });
      return;
    }
    const enq = await uploadEnqueue.enqueue(row.id);
    if (enq.kind === "queued") {
      // Data now exists — re-enable the gated datasets/inflight queries so the
      // invalidations below actually refetch (they no-op while disabled).
      if (uid) { writeSkuVerdict(uid, true); setSkuGate(true); }
      // 2026-05-26 — invalidate BOTH the inflight query (so the
      // big-middle <InflightCard/> takeover at line 544 triggers — that
      // component renders only when useQuery(["sku-analysis","inflight"])
      // returns a doc) AND the datasets list (so the new dataset row
      // appears in DatasetsPanel mid-flight). Without the inflight
      // invalidation the user saw nothing but a toast in the corner
      // and assumed the upload failed silently.
      void qc.invalidateQueries({ queryKey: ["sku-analysis", "inflight"] });
      void qc.invalidateQueries({ queryKey: ["sales-datasets"] });
    }
  }, [toast, uploadEnqueue, qc, uid]);

  // (Search debounce removed — replaced by useDeferredValue above. No
  // setTimeout/clearTimeout needed; React schedules the deferred work
  // itself based on input pressure and device speed.)

  // Datasets list — drives the dataset selector and the active id. Gated by the
  // SKU data-presence verdict: when we already know the user has no datasets the
  // query stays disabled (no call, no loader) and Products falls straight to the
  // empty state below.
  const { data: datasetsPayload, isLoading: loadingDatasets } = useQuery({
    queryKey: ["sales-datasets"],
    queryFn: fetchDatasets,
    enabled: skuQueriesEnabled,
  });
  // Record the verdict once the query resolves, so future loads (this session
  // and, via localStorage, future ones) skip the round-trip entirely.
  useEffect(() => {
    if (!uid || datasetsPayload === undefined) return;
    const has = (datasetsPayload?.datasets.length ?? 0) > 0;
    writeSkuVerdict(uid, has);
    setSkuGate(has);
  }, [uid, datasetsPayload]);
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
    enabled: skuQueriesEnabled,
  });

  // Dismissed-inflight-IDs state. Without this, a failed-status doc returned
  // by /api/sku-analysis/inflight pins the user under <InflightCard/> at line
  // ~558 (full-page takeover) with no way out — the failed card has no
  // dismiss action, and the next inflight query re-fetches the same failed
  // doc. sessionStorage scopes it per tab; opens a fresh slate on browser
  // restart so server-side cleanup eventually wins.
  const [dismissedInflightIds, setDismissedInflightIds] = useState<Set<string>>(() => {
    try {
      const raw = sessionStorage.getItem("cfo-ai:dismissed-inflight-ids:v1");
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  });
  const dismissInflight = useCallback((id: string) => {
    setDismissedInflightIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      try {
        sessionStorage.setItem(
          "cfo-ai:dismissed-inflight-ids:v1",
          JSON.stringify([...next]),
        );
      } catch {
        /* quota */
      }
      return next;
    });
  }, []);

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
    // A refresh follows an upload, so data now exists — re-enable the gated
    // queries (the resolution effect reconciles the verdict from the refetch).
    if (uid) { writeSkuVerdict(uid, true); setSkuGate(true); }
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["sales-datasets"] }),
      qc.invalidateQueries({ queryKey: ["sales-dataset", activeDatasetId] }),
      qc.invalidateQueries({ queryKey: ["sku-analysis", "inflight"] }),
    ]);
  }, [qc, activeDatasetId, uid]);

  // ── Hooks above any early return (rules of hooks)
  // Datasets badge count — hook MUST be called unconditionally on every render.
  // Previously this was called inline inside the main return JSX, which meant
  // the four early-return branches above skipped it, producing "Rendered more
  // hooks than during the previous render" when the component switched from a
  // loading branch into the main branch.
  const datasetsCount = useDatasetsCount();

  // Filter chips now run on the 3-bucket model (Protect / Watch / Wind down).
  // Legacy ?state= URLs that named engine classifications (anchor / scale /
  // keep / etc.) are migrated into their 3-bucket parent on read so users
  // returning to a bookmarked filtered view land on a meaningful page.
  const VALID_BUCKET3 = new Set<Bucket3>(["protect", "watch", "wind_down"]);
  const LEGACY_TO_BUCKET3: Record<string, Bucket3> = {
    anchor:       "protect",
    scale:        "protect",
    keep:         "protect",
    anchor_alert: "watch",
    watch:        "watch",
    eliminate:    "wind_down",
    wind_down:    "wind_down",
  };
  const activeFilters = useMemo(() => {
    const raw = params.get("state");
    const tokens = raw ? raw.split(",").filter(Boolean) : [];
    const migrated = new Set<Bucket3>();
    for (const t of tokens) {
      if (VALID_BUCKET3.has(t as Bucket3)) migrated.add(t as Bucket3);
      else if (LEGACY_TO_BUCKET3[t]) migrated.add(LEGACY_TO_BUCKET3[t]);
    }
    return migrated;
    // VALID_BUCKET3 / LEGACY_TO_BUCKET3 are module-stable; not in deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);
  const channelFilter = params.get("channel") ?? "";
  const categoryFilter = params.get("category") ?? "";
  const brandFilter = params.get("brand") ?? "";

  // Decision-rules state — hoisted above the filtered useMemo because
  // filtering uses computeFinalBucket which reads it. JS const
  // declarations are hoisted but bindings aren't — referencing
  // `rulesState` from a useMemo declared earlier would TDZ-error.
  const rulesState = useDecisionRules();
  // BucketContext threaded into computeFinalBucket so rules that depend
  // on user-tunable assumptions (Adjusted GM% via financing rate)
  // re-derive on every drag of the financing slider in the modal.
  const bucketCtx: BucketContext = useMemo(
    () => ({ financing: rulesState.financing ?? DEFAULT_FINANCING }),
    [rulesState.financing],
  );

  const filtered = useMemo<SkuAggregate[]>(() => {
    const skus = dsPayload?.skus ?? [];
    let xs = skus;
    // Bucket filter now applies the 3-bucket model with thresholds — same
    // helper the KPI tiles use, so chips and tiles stay in sync.
    if (activeFilters.size > 0) {
      xs = xs.filter((s) => activeFilters.has(computeFinalBucket(s, RULES, rulesState, bucketCtx)));
    }
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
    // `rulesState` + `bucketCtx` used via computeFinalBucket inside the
    // activeFilters branch; include explicitly so chip-filtered views
    // re-run when any slider, toggle, mode change, OR financing-rate
    // drag fires.
  }, [dsPayload, activeFilters, channelFilter, categoryFilter, brandFilter, debouncedSearch, sortKey, sortDir, rulesState, bucketCtx]);

  // ─── Final-bucket reactive distribution ────────────────────────────────
  //
  // Multi-rule final bucket per SKU, recomputed via useMemo on every
  // decision-rules state change. The decisionRulesStore uses
  // useSyncExternalStore so a slider drag in the modal fires emit() →
  // subscribers (including this component) snapshot the new state in the
  // same render → counts3 recomputes → KPI tiles + filter chips re-render
  // with new numbers, no refetch.
  const counts3 = useMemo(() => {
    const skus = dsPayload?.skus ?? [];
    return countFinalBuckets(skus, RULES, rulesState, bucketCtx);
  }, [dsPayload?.skus, rulesState, bucketCtx]);

  function setStateFilter(c: Bucket3 | null) {
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
      <>
        <div className="max-w-[680px] mx-auto py-16 text-center">
          <Loader2 size={20} className="animate-spin mx-auto text-ink-mute mb-3" />
          <p className="text-[13px] text-ink-soft">Loading datasets…</p>
        </div>
      </>
    );
  }

  if (inflight && !dismissedInflightIds.has(inflight.id)) {
    return (
      <>
        <InflightCard
          inflight={inflight}
          onDismiss={() => dismissInflight(inflight.id)}
        />
      </>
    );
  }

  const hasAnyDataset = (datasetsPayload?.datasets.length ?? 0) > 0;

  if (!hasAnyDataset) {
    return (
      <>
        <EmptyState
          onUploaded={refresh}
          datasets={datasetsPayload?.datasets ?? []}
        />
      </>
    );
  }

  if (loadingSkus || !dsPayload) {
    return (
      <>
        <div className="max-w-[680px] mx-auto py-16 text-center">
          <Loader2 size={20} className="animate-spin mx-auto text-ink-mute mb-3" />
          <p className="text-[13px] text-ink-soft">Loading SKUs…</p>
        </div>
      </>
    );
  }

  const { totals, dataset } = dsPayload;

  return (
    <>
      {/* 2026-05-26 — always-mounted file input + extra-doc dialog.
          DatasetsPanel's "Upload sales dataset" button dispatches
          `cfo:request-sku-upload`; the useEffect above forwards to
          this hidden input's .click(). Lives at the page root so it
          survives whatever conditional render branches below. */}
      <input
        ref={pageUploadRef}
        type="file"
        accept={PRODUCTS_UPLOAD_ACCEPT}
        className="hidden"
        data-testid="products-page-upload-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handlePageUploadFile(f);
          // Reset so re-selecting the same file fires onChange again.
          e.target.value = "";
        }}
      />
      {uploadEnqueue.dialog}
      <section className="space-y-6">
        <header data-testid="portfolio-header">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <div className="label-eyebrow">{t("products.title")}</div>
              <h1 className="mt-2 font-serif text-[34px] sm:text-[40px] leading-[1.05] tracking-[-0.02em] text-ink">
                <Trans
                  i18nKey="products.subtitle"
                  values={{
                    rows: dataset.row_count?.toLocaleString("en-GB") ?? "—",
                    count: totals.sku_count.toLocaleString("en-GB"),
                    categories: totals.category_count,
                  }}
                />
              </h1>
              <p className="mt-1 text-[12.5px] text-ink-mute">
                {dataset.label} · <SourceText lang="ro">{dataset.source_filename}</SourceText> ·{" "}
                {new Date(dataset.uploaded_at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {/* F5.0 Step 4 — Products page guide. Auto-opens for first-time
                  guided-mode users; always-available CTA otherwise. */}
              <GuideMeButton pageId="products" title="Products" steps={PRODUCTS_GUIDE} />
              {/* Dataset switcher — header pill opens the right-anchored
                  Datasets panel for full switch / rename / re-run / delete.
                  Cmd/Ctrl+Shift+D also toggles. */}
              <DatasetsToggle count={datasetsCount} />
            </div>
          </div>

          {/* 4-tile KPI grid: SKUs total + the three threshold-reactive
              buckets. `counts3` recomputes via useMemo on every threshold
              change so dragging a Decision-rules slider live-updates these
              tiles — no refresh, no refetch. */}
          <div className="mt-6 grid grid-cols-2 lg:grid-cols-4 gap-3">
            {/* F5.0 Phase 8 — each bucket KPI label is now a click
                target opening its concept popover (sku_classification
                bucket = Protect / Watch / Wind Down). The SKU count
                tile stays a raw count with no learning hook since
                "how many SKUs you have" doesn't need explanation. */}
            <KpiCard data-testid="kpi-sku-count" label={t("products.kpi.skus")} value={totals.sku_count.toLocaleString("en-GB")} sub={t("products.kpi.skusSub", { cats: totals.category_count, brands: totals.brand_count })} />
            <KpiCard conceptKey="protect_bucket_count"   data-testid="kpi-protect"   label={t("products.kpi.protect")}  value={counts3.protect.toLocaleString("en-GB")}   sub={t("products.kpi.protectSub")} tone="strong" />
            <KpiCard conceptKey="watch_bucket_count"     data-testid="kpi-watch"     label={t("products.kpi.watch")}    value={counts3.watch.toLocaleString("en-GB")}     sub={t("products.kpi.watchSub")} tone="warn" />
            <KpiCard conceptKey="wind_down_bucket_count" data-testid="kpi-wind-down" label={t("products.kpi.windDown")} value={counts3.wind_down.toLocaleString("en-GB")} sub={t("products.kpi.windDownSub")} tone="warn" />
          </div>

          {/* Reconciliation chip — surfaces accuracy issues the moment
              they happen. Sums niv_krn across every loaded SKU and
              compares to the backend-reported totals.niv_krn. Green ✓
              when within 1 RON of the source. Amber ⚠ with the absolute
              delta if not. Click-through reveals the per-SKU breakdown
              so the operator can see exactly where divergence came
              from. Self-documenting Layer-D audit. */}
          <ReconciliationChip dsPayload={dsPayload} currency={sourceCurrency} />
        </header>

        {/* Search + filters */}
        <div className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-2 rounded-lg border border-rule bg-surface px-3 h-9 flex-1 min-w-[260px] max-w-[460px]">
              <Search size={13} className="text-ink-mute" strokeWidth={1.75} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("products.searchPlaceholder")}
                className="flex-1 bg-transparent text-[13px] outline-none placeholder:text-ink-mute"
              />
            </div>
            <select value={brandFilter} onChange={(e) => setUrlParam("brand", e.target.value || null)} className="h-9 rounded-lg border border-rule bg-surface px-2.5 text-[12.5px] text-ink">
              <option value="">{t("products.filters.allBrands", { count: totals.brand_count })}</option>
              {/* Brand names are proper nouns — source data, never translated */}
              {totals.brands.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
            <select value={categoryFilter} onChange={(e) => setUrlParam("category", e.target.value || null)} className="h-9 rounded-lg border border-rule bg-surface px-2.5 text-[12.5px] text-ink">
              <option value="">{t("products.filters.allCategories", { count: totals.category_count })}</option>
              {/* Romanian category codes — source data; categoryHints surfaces
                  an inline translation in the per-row UI, not in the dropdown. */}
              {totals.categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <select value={channelFilter} onChange={(e) => setUrlParam("channel", e.target.value || null)} className="h-9 rounded-lg border border-rule bg-surface px-2.5 text-[12.5px] text-ink">
              <option value="">{t("products.filters.allChannels")}</option>
              {/* Channel codes (KA/DIST/EXP/OLN) are parser tokens — source data */}
              {(["KA", "DIST", "EXP", "OLN"] as const).map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            {/* 2026-05-26 — Categories vs All-SKUs view toggle. Was a
                <select> dropdown; now a pill-style segmented control
                (Framer Motion `layoutId` slides the indicator between
                positions). URL state ownership stays here so deep
                links + back-button keep working. The legacy flat
                358-row SkuTable below is unchanged — virtualization
                (line 1355), memoization (line 415), and React 18
                useDeferredValue search (line 281) handle the row count. */}
            <ViewToggle
              value={(params.get("view") ?? "categories") as ProductsView}
              onChange={(v) => setUrlParam("view", v === "categories" ? null : v)}
            />
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
              <option value="gm_krn_desc">{t("products.sort.label") + " " + t("products.sort.gmDesc")}</option>
              <option value="gm_krn_asc">{t("products.sort.label") + " " + t("products.sort.gmAsc")}</option>
              <option value="gm_pct_desc">{t("products.sort.label") + " " + t("products.sort.gmPctDesc")}</option>
              <option value="gm_pct_asc">{t("products.sort.label") + " " + t("products.sort.gmPctAsc")}</option>
              <option value="volume_tons_desc">{t("products.sort.label") + " " + t("products.sort.volumeDesc")}</option>
              <option value="niv_krn_desc">{t("products.sort.label") + " " + t("products.sort.nivDesc")}</option>
              <option value="name_asc">{t("products.sort.label") + " " + t("products.sort.nameAsc")}</option>
            </select>
            <button
              onClick={() => exportCsv(filtered, dataset.label, {
                sourceCurrency: sourceCurrency,
                displayCurrency: displayCurrencyForExport,
                rate: exportRate,
                rateDate: ratesPayload.rateDate,
                provider: ratesPayload.provider,
              })}
              className="h-9 px-3 rounded-lg border border-rule bg-surface text-[12.5px] text-ink hover:bg-bg-2 transition-colors"
              data-testid="export-portfolio"
            >
              {t("products.exportCsv")}
            </button>
          </div>

          {/* 3-bucket filter chips. Counts come from `counts3` (live
              recompute on threshold change) so chip counts and KPI tiles
              stay in lock-step. */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <Chip testid="chip-all" label={t("products.buckets.all")} count={totals.sku_count} active={activeFilters.size === 0} onClick={() => setStateFilter(null)} />
            {(["protect", "watch", "wind_down"] as Bucket3[]).map((b) => {
              const n = counts3[b];
              const meta = BUCKET3_FILTER_META[b];
              // Translate at render time. Key shape matches `products.buckets.{name}`.
              const i18nKey =
                b === "wind_down" ? "products.buckets.windDown" : `products.buckets.${b}`;
              return (
                <Chip
                  key={b}
                  testid={`chip-${b}`}
                  label={t(i18nKey)}
                  count={n}
                  dotClass={meta.dot}
                  active={activeFilters.has(b)}
                  empty={n === 0}
                  onClick={() => setStateFilter(b)}
                />
              );
            })}
          </div>

          <div data-testid="sku-table-summary" className="text-[11.5px] text-ink-mute">
            {t("products.showing", {
              visible: filtered.length.toLocaleString("en-GB"),
              total: totals.sku_count.toLocaleString("en-GB"),
            })}
          </div>
        </div>

        {compare && (
          <ComparisonSection
            payload={compare}
            currency={sourceCurrency}
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

        {/* Loud-failure banner — surfaces /api/health.checks.dio_persistence
            when the upload pipeline's defensive retry path silently dropped
            DIO values. Auto-hides once operator runs the SQL migration. */}
        <DioPersistenceBanner />

        {/* 2026-05-26 — Products Layer 1/2 navigation.
            · Default (no category filter set, view≠"all"): render the
              CategoriesOverview cards. Click a card sets ?category=X
              which falls through to the SKU table below, scoped.
            · Drilled (category filter set): render the existing SKU
              table preceded by a "Back to categories" pill.
            · Power-user "All SKUs" view (?view=all): skip the cards,
              show the flat table directly — preserves the legacy
              workflow for operators who want everything at once. */}
        {(() => {
          const viewMode = params.get("view") ?? "categories";
          const drilledCategory = categoryFilter;
          if (viewMode === "all") {
            return (
              <SkuTable rows={filtered} currency={sourceCurrency} onSelect={(s) => setSelectedSkuId(s.id)} />
            );
          }
          if (drilledCategory) {
            return (
              <div className="space-y-3">
                <BackToCategoriesPill
                  categoryLabel={drilledCategory}
                  onClick={() => setUrlParam("category", null)}
                />
                <SkuTable rows={filtered} currency={sourceCurrency} onSelect={(s) => setSelectedSkuId(s.id)} />
              </div>
            );
          }
          return (
            <CategoriesOverview
              skus={dsPayload.skus}
              onSelectCategory={(cat) => setUrlParam("category", cat)}
              costOfFinancingPct={(rulesState.financing ?? DEFAULT_FINANCING).costOfFinancing}
              bankSpreadPct={(rulesState.financing ?? DEFAULT_FINANCING).bankSpread}
            />
          );
        })()}

        {/* Company working-capital roll-up — per-SKU DIO covered rows
         *  aggregated to a company DIO (with coverage %), combined with
         *  DSO/DPO from the loaded period's trial-balance context
         *  (when available) into CCC = DIO + DSO − DPO. Each component
         *  is labelled with its source; missing components show
         *  "not available" rather than a fabricated value. */}
        <WorkingCapitalRollup skus={dsPayload.skus} />

        {/* 2026-05-26 — PortfolioTotalsBar removed at operator request.
            The card was rendering "Portofoliu total" with NIV/GM/Losses
            converted at the wrong unit scale (kRON values displayed as
            if raw RON → ×1000 inflation; €17M revenue shown as €3.5 Mrd.).
            All four figures (Volume / NIV / GM / Losses) also already
            appear in the WorkingCapitalRollup + the KPI tiles above the
            Categories overview, so the bar was duplicate AND broken. The
            component function is left in place as dead code in case
            we want to restore a corrected version later. */}
      </section>

      <SkuDetailDrawer
        sku={
          selectedSkuId
            ? dsPayload.skus.find((s) => s.id === selectedSkuId) ?? null
            : null
        }
        onClose={() => setSelectedSkuId(null)}
        datasetId={activeDatasetId}
        currency={sourceCurrency}
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
    </>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

/**
 * ReconciliationChip — surfaces accuracy issues at a glance.
 *
 * Sums niv_krn across every loaded SKU and compares to the backend's
 * dataset.totals.niv_krn. They should match within rounding (the backend
 * computes the total by aggregating the same rows that come back in
 * payload.skus). When they diverge it's a Layer-C/D bug — either the
 * aggregation logic dropped/duplicated rows, or the FE is filtering
 * before counting.
 *
 * Renders inline below the KPI tiles. Green ✓ for clean match, amber ⚠
 * with the absolute delta if not.
 */
function ReconciliationChip({
  dsPayload,
  currency,
}: {
  dsPayload: DatasetPayload | null | undefined;
  currency: Currency;
}) {
  // CUR-FIX-D — the underlying NIV values are stored in thousands of the
  // source currency (kRON / kEUR / kUSD) so the gap math runs in "k" units;
  // we hand the result to `fmtKron` which scales ×1000 to base before FX.
  const fmtKron = useKronFormatter(currency);

  const recon = useMemo(() => {
    if (!dsPayload) return null;
    const expectedKrn = dsPayload.totals.niv_krn || 0;
    const observedKrn = (dsPayload.skus ?? []).reduce((s, x) => s + (x.niv_krn ?? 0), 0);
    const deltaKrn = observedKrn - expectedKrn;
    const absDelta = Math.abs(deltaKrn);
    // Tolerance: 1 currency unit (1 RON / 1 EUR / 1 USD) for rounding noise.
    // Values are stored as thousands of the source unit, so 1 base-unit
    // tolerance is `0.001` in kRON-space.
    const isClean = absDelta < 0.001;
    return { expectedKrn, observedKrn, deltaKrn, absDelta, isClean };
  }, [dsPayload]);

  if (!recon) return null;
  const cls = recon.isClean
    ? "border-[#5CD3C5]/30 bg-[#5CD3C5]/5 text-[#2AA89B] dark:text-[#8FE3D9]"
    : "border-[#5CD3C5]/30 bg-[#5CD3C5]/5 text-[#2AA89B] dark:text-[#5CD3C5]";
  return (
    <div
      data-testid="reconciliation-chip"
      data-clean={recon.isClean ? "true" : "false"}
      className={`mt-3 inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11.5px] tabular-nums ${cls}`}
      title={`Source NIV: ${fmtKron(recon.expectedKrn)} · SKU sum: ${fmtKron(recon.observedKrn)}`}
    >
      <span aria-hidden>{recon.isClean ? "✓" : "⚠"}</span>
      <span className="font-medium">
        {recon.isClean
          ? "Reconciles to source"
          : (
            <>
              Reconciliation gap: {recon.deltaKrn >= 0 ? "+" : "−"}
              {fmtKron(recon.absDelta)}
            </>
          )}
      </span>
      <span className="opacity-70">
        · {(dsPayload?.skus ?? []).length.toLocaleString("en-GB")} of {dsPayload?.totals.sku_count.toLocaleString("en-GB")} SKUs counted
      </span>
    </div>
  );
}

// F5.0 Phase 8 — KpiCard optionally accepts a `conceptKey` so the label
// becomes a clickable LearnableRowLabel that opens the concept popover.
// Used to expose the decision-rule bucket logic on the Products KPI
// strip (Protect / Watch / Wind down). When the prop is omitted the
// label renders exactly as before — no regression for the SKU count
// tile (no concept needed; it's a raw count).
function KpiCard({
  label, value, sub, tone, conceptKey, ...rest
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "critical" | "warn" | "strong";
  conceptKey?: string;
} & React.HTMLAttributes<HTMLDivElement>) {
  const ring = tone === "critical" ? "border-red-300/60" : tone === "warn" ? "border-[#8FE3D9]/60" : tone === "strong" ? "border-[#8FE3D9]/60" : "border-rule";
  const labelEl = conceptKey ? (
    <LearnableRowLabel
      conceptKey={conceptKey}
      value={0}
      data-testid={`products-kpi-label-${conceptKey}`}
    >
      {label}
    </LearnableRowLabel>
  ) : (
    label
  );
  // FIT-1 (2026-06-08) — same min-w-0 + overflow-hidden + fluid font
  // pattern as KpiTile so SKU counts / currency strings shrink to fit
  // their grid cell rather than overflowing into the neighbour.
  return (
    <div
      {...rest}
      className={`rounded-2xl border ${ring} bg-surface p-3.5 min-w-0 overflow-hidden`}
    >
      <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium">
        {labelEl}
      </div>
      <div className="mt-2 num-hero num-hero-fluid text-ink leading-none">{value}</div>
      {sub && <div className="text-[11px] text-ink-soft mt-0.5 leading-snug break-words">{sub}</div>}
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
      // F2.2 — Engine-canonical metrics map so DSO/DPO match the dashboard
      // Ratios tab to the cent.
      const metricsMap: Record<string, number | null> = {};
      for (const mt of period.metrics) {
        metricsMap[mt.name] = typeof mt.value === "number" ? mt.value : null;
      }
      const r = computeRatios(period.statements, undefined, metricsMap);
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
  currency,
  onClose,
  onSwitchActive,
}: {
  payload: ComparePayload;
  currency: Currency;
  onClose: () => void;
  onSwitchActive: () => void;
}) {
  const { active, compared, totals, winners, losers, new_in_active } = payload;
  const nivDelta = totals.niv_a - totals.niv_b;
  const gmDelta = totals.gm_a - totals.gm_b;
  const fmtKron = useKronFormatter(currency);

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
          value={fmtKron(nivDelta)}
          tone={nivDelta < 0 ? "alert" : undefined}
        />
        <Stat
          label="GM delta"
          value={fmtKron(gmDelta)}
          tone={gmDelta < 0 ? "alert" : undefined}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <MoversList title="Top winners (Δ GM ↑)" rows={winners} dir="up" currency={currency} />
        <MoversList title="Top losers (Δ GM ↓)" rows={losers} dir="down" currency={currency} />
      </div>

      {new_in_active.length > 0 && (
        <div>
          <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium mb-1.5">
            New in {active.label} ({totals.new_in_active})
          </div>
          <ul className="text-[12px] text-ink-soft space-y-0.5 max-h-32 overflow-y-auto">
            {new_in_active.slice(0, 12).map((r) => (
              <li key={r.product_name} className="truncate">
                + {r.product_name} <span className="text-ink-mute">· GM {fmtKron(r.gm_a)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function MoversList({
  title,
  rows,
  dir,
  currency,
}: {
  title: string;
  rows: CompareRow[];
  dir: "up" | "down";
  currency: Currency;
}) {
  const fmtKron = useKronFormatter(currency);
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
            <div className={`text-right tabular-nums text-[12px] font-medium ${dir === "up" ? "text-[#2AA89B]" : "text-red-700"}`}>
              {dir === "up" ? "+" : ""}{fmtKron(r.gm_delta)}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SkuTable({
  rows,
  currency,
  onSelect,
}: {
  rows: SkuAggregate[];
  currency: Currency;
  onSelect: (sku: SkuAggregate) => void;
}) {
  const { t } = useTranslation();
  const parentRef = useRef<HTMLDivElement>(null);
  // The Signal column was rendering `BUCKET_META[s.classification]` which
  // surfaced the engine's legacy 6-classification labels (Anchor / Keep /
  // Scale / Eliminate / etc.) — out of sync with the 3-bucket pills + filter
  // chips above. Subscribe to the rules store here so every row's badge
  // re-derives from the current rules + thresholds, matching the rest of
  // the surface. Pure recomputation — cheap, no memoisation needed at
  // 358-row scale (the work is 3 comparisons per row × per render).
  const rulesState = useDecisionRules();
  // BucketContext for Adjusted-GM rule — same shape as the page-level
  // bucketCtx; recomputed here because SkuTable doesn't receive props
  // from its parent for this. Memoisation keyed on financing only.
  const bucketCtx: BucketContext = useMemo(
    () => ({ financing: rulesState.financing ?? DEFAULT_FINANCING }),
    [rulesState.financing],
  );
  // estimateSize: desktop row ≈ 52px; mobile card ≈ 132px. measureElement
  // below corrects the estimate row-by-row so the scroll thumb stays
  // accurate at every viewport without a media-query re-mount.
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 52,
    overscan: 10,
    measureElement: (el) => el.getBoundingClientRect().height,
  });

  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-rule bg-surface px-6 py-10 text-center text-[13px] text-ink-soft">
        {t("products.table.emptyFiltered")}
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-rule bg-surface overflow-hidden">
      {/* Desktop header — hidden on mobile since cards label their own metrics */}
      <div className="hidden md:grid grid-cols-[1fr_120px_120px_90px_90px_90px_80px_80px_120px] gap-3 px-4 py-2.5 bg-bg-2/40 border-b border-rule text-[10.5px] uppercase tracking-[0.08em] text-ink-mute font-medium">
        <div>{t("products.columns.skuCategory")}</div>
        <div className="text-right">{t("products.columns.volume")}</div>
        <div className="text-right">{t("products.columns.niv")}</div>
        <div className="text-right">{t("products.columns.gmPct")}</div>
        <div className="text-right">{t("products.columns.gm")}</div>
        <div className="text-right">{t("products.columns.dio")}</div>
        <div className="text-center">{t("products.columns.lines")}</div>
        <div className="text-center">{t("products.columns.channels")}</div>
        <div>{t("products.columns.signal")}</div>
      </div>
      <div
        ref={parentRef}
        data-testid="sku-table-scroll"
        className="overflow-auto overscroll-contain h-[560px] sm:h-[600px]"
      >
        <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative", width: "100%" }}>
          {rowVirtualizer.getVirtualItems().map((virt) => {
            const s = rows[virt.index];
            // Signal cell — use the live 3-bucket derivation. NOT the
            // engine's static classification (anchor/keep/scale/etc.)
            // which is now legacy. This keeps row badges in sync with
            // the top KPI tiles, filter chips, and the modal's per-rule
            // counts on every threshold change.
            const bucket3 = computeFinalBucket(s, RULES, rulesState, bucketCtx);
            const bucketMeta = BUCKET3_FILTER_META[bucket3];
            const gm = s.gm_krn ?? 0;
            return (
              <div
                key={s.id}
                ref={rowVirtualizer.measureElement}
                data-index={virt.index}
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
                }}
                className="border-b border-rule/60 hover:bg-bg-2/40 active:bg-bg-2/60 transition-colors cursor-pointer focus:outline-none focus:bg-bg-2/60 focus:ring-1 focus:ring-inset focus:ring-ink/20"
              >
                {/* MOBILE CARD — stacked layout below md (768px) */}
                <div className="md:hidden px-4 py-3">
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div className="min-w-0 flex-1">
                      {/* Product name is source data (typically Romanian). lang="ro"
                          ensures correct screen-reader pronunciation in any UI lang. */}
                      <div className="text-ink text-[14px] font-medium truncate" title={s.product_name}>
                        <SourceText lang="ro">{s.product_name}</SourceText>
                      </div>
                      <div className="text-[11px] text-ink-mute mt-0.5 truncate">
                        {s.brand && <SourceText lang="ro">{s.brand}</SourceText>}
                        {s.brand && s.category && <span> · </span>}
                        {s.category && (
                          <>
                            <SourceText lang="ro">{s.category}</SourceText>
                            <CategoryHintInline category={s.category} />
                          </>
                        )}
                      </div>
                    </div>
                    <div
                      className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.06em] font-semibold text-ink-soft shrink-0"
                      data-testid="sku-bucket-badge"
                      data-bucket={bucket3}
                    >
                      <span className={`h-1.5 w-1.5 rounded-full ${bucketMeta.dot} shrink-0`} />
                      <span>{bucketMeta.label}</span>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-[11.5px]">
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.06em] text-ink-mute">Volume</div>
                      <div className="text-ink tabular-nums">
                        {s.volume_tons !== null ? `${s.volume_tons.toLocaleString("en-GB", { maximumFractionDigits: 1 })}t` : "—"}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.06em] text-ink-mute">NIV</div>
                      <div className="text-ink tabular-nums">
                        {s.niv_krn !== null
                          ? <Money value={s.niv_krn * 1000} fromCurrency={currency} compact />
                          : "—"}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.06em] text-ink-mute">GM%</div>
                      <div className={`tabular-nums ${(s.gm_pct ?? 0) < 0 ? "text-red-700" : "text-ink"}`}>
                        {s.gm_pct !== null ? `${(s.gm_pct * 100).toFixed(1)}%` : "—"}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.06em] text-ink-mute">GM</div>
                      <div className={`tabular-nums font-medium ${gm < 0 ? "text-red-700" : "text-ink"}`}>
                        <Money value={gm * 1000} fromCurrency={currency} compact signed />
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.06em] text-ink-mute">DIO</div>
                      <div
                        className="tabular-nums"
                        title={
                          s.days_inventory_on_hand == null
                            ? "DIO not available — inventory value and/or COGS not provided for this SKU"
                            : undefined
                        }
                        data-testid="sku-dio-cell"
                        data-dio-available={s.days_inventory_on_hand != null ? "true" : "false"}
                      >
                        {s.days_inventory_on_hand != null
                          ? <span className="text-ink">{Math.round(s.days_inventory_on_hand).toLocaleString("en-GB")}d</span>
                          : <span className="text-ink-mute/70">—</span>}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.06em] text-ink-mute">Lines / Ch</div>
                      <div className="text-ink-soft tabular-nums">
                        {(s.line_row_count ?? "—")} / {s.channels_present?.length || 0}
                      </div>
                    </div>
                  </div>
                </div>

                {/* DESKTOP ROW — 9-column grid at md and up */}
                <div className="hidden md:grid grid-cols-[1fr_120px_120px_90px_90px_90px_80px_80px_120px] gap-3 px-4 py-2.5 text-[12.5px] items-center">
                  <div className="min-w-0">
                    {/* Product name + category — source data, wrapped for AT phoneme correctness */}
                    <div className="text-ink truncate" title={s.product_name}>
                      <SourceText lang="ro">{s.product_name}</SourceText>
                    </div>
                    <div className="text-[10.5px] text-ink-mute mt-0.5 truncate">
                      {s.brand && <SourceText lang="ro">{s.brand}</SourceText>}
                      {s.brand && s.category && <span> · </span>}
                      {s.category && (
                        <>
                          <SourceText lang="ro">{s.category}</SourceText>
                          <CategoryHintInline category={s.category} />
                        </>
                      )}
                    </div>
                  </div>
                  <div className="text-right tabular-nums text-ink-soft">
                    {s.volume_tons !== null ? s.volume_tons.toLocaleString("en-GB", { maximumFractionDigits: 1 }) : "—"}
                  </div>
                  <div className="text-right tabular-nums text-ink-soft">
                    {s.niv_krn !== null
                      ? <Money value={s.niv_krn * 1000} fromCurrency={currency} compact />
                      : "—"}
                  </div>
                  <div className={`text-right tabular-nums ${(s.gm_pct ?? 0) < 0 ? "text-red-700" : "text-ink"}`}>
                    {s.gm_pct !== null ? `${(s.gm_pct * 100).toFixed(1)}%` : "—"}
                  </div>
                  <div className={`text-right tabular-nums font-medium ${gm < 0 ? "text-red-700" : "text-ink"}`}>
                    <Money value={gm * 1000} fromCurrency={currency} compact signed />
                  </div>
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
                  <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.06em] font-semibold text-ink-soft" data-bucket={bucket3}>
                    <span className={`h-1.5 w-1.5 rounded-full ${bucketMeta.dot} shrink-0`} />
                    <span className="truncate">{t(bucket3 === "wind_down" ? "products.buckets.windDown" : `products.buckets.${bucket3}`)}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function PortfolioTotalsBar({
  totals,
  currency,
}: {
  totals: DatasetPayload["totals"];
  currency: Currency;
}) {
  const { t } = useTranslation();
  const fmtKron = useKronFormatter(currency);
  return (
    <section data-testid="portfolio-totals" className="rounded-2xl border border-rule bg-surface p-4">
      <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium mb-2">{t("totals.title")}</div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-[12.5px]">
        <Stat label={t("totals.volume")} value={`${totals.volume_tons.toLocaleString("en-GB", { maximumFractionDigits: 1 })} t`} />
        <Stat label={t("totals.niv")} value={fmtKron(totals.niv_krn)} />
        <Stat label={t("totals.gm")} value={fmtKron(totals.gm_krn)} />
        <Stat label={t("totals.losses")} value={fmtKron(totals.losses_krn)} tone={totals.losses_krn < 0 ? "alert" : undefined} />
      </div>
    </section>
  );
}
function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: "alert" }) {
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-[0.08em] text-ink-mute">{label}</div>
      <div className={`mt-0.5 font-serif text-[18px] tabular-nums ${tone === "alert" ? "text-red-700" : "text-ink"}`}>{value}</div>
    </div>
  );
}

// ─── Inflight + Empty ───────────────────────────────────────────────────────

function InflightCard({
  inflight,
  onDismiss,
}: {
  inflight: InflightDoc;
  /** Called when the user clicks "Dismiss" on the failed state. Page-level
   *  remembers the ID so the card stays hidden across React re-renders and
   *  inflight-query re-fetches (server still returns the failed doc until
   *  the operator deletes it; the UI just stops showing it). */
  onDismiss?: () => void;
}) {
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
        {failed && (
          // Failed-state actions. Without these the user is trapped under
          // the full-page <InflightCard/> takeover (page-level early return).
          // "Upload cancelled" / "Couldn't start analysis" / pipeline errors
          // all land here; Dismiss is always available so they can navigate
          // back to the rest of Products without refreshing.
          <div className="mt-2 space-y-2.5">
            {inflight.error && (
              <div className="rounded-md border border-alert/30 bg-alert/5 px-3 py-2 text-[12px] text-alert">
                {inflight.error}
              </div>
            )}
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => onDismiss?.()}
                data-testid="products-inflight-dismiss"
                className="inline-flex items-center gap-1.5 rounded-md border border-rule bg-surface px-3 py-1.5 text-[12px] font-medium text-ink-soft hover:bg-bg-2 transition-colors"
              >
                Dismiss
              </button>
              <button
                type="button"
                onClick={handleRetry}
                disabled={retrying}
                data-testid="products-inflight-retry-failed"
                className="inline-flex items-center gap-1.5 rounded-md border border-alert/40 bg-surface px-3 py-1.5 text-[12px] font-medium text-alert hover:bg-alert/10 transition-colors disabled:opacity-50"
              >
                {retrying ? <Loader2 size={12} className="animate-spin" /> : null}
                {retrying ? "Retrying…" : "Retry analysis"}
              </button>
            </div>
          </div>
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

  // Detect whether the user just came from a public-company dashboard.
  // Set on mount of PublicCompanyDashboard via sessionStorage so Products
  // can render a contextual "public companies don't have SKU data" message
  // alongside the standard upload CTA — instead of a blank empty state
  // that makes the user feel something's broken.
  const publicCompanyContext = (() => {
    try {
      const ticker = typeof sessionStorage !== "undefined"
        ? sessionStorage.getItem("cfo:last-public-ticker")
        : null;
      if (!ticker) return null;
      const name = sessionStorage.getItem("cfo:last-public-name") || ticker;
      return { ticker, name };
    } catch { return null; }
  })();

  return (
    <section data-testid="products-empty">
      {/* Pricing V3 — extra-doc confirm dialog mount. */}
      {uploadEnqueue.dialog}

      {/* Public-company-aware contextual banner. Visible only when the user
          just came from a /dashboard/public/:ticker view. Explains why
          Products is empty (Sharadar SF1 is company-level, not SKU-level)
          and offers two paths forward: upload private sales data OR return
          to the public-company dashboard. */}
      {publicCompanyContext && (
        <div
          data-testid="products-public-company-context"
          className="
            mb-6 rounded-2xl border border-brand/20
            bg-gradient-to-br from-brand/[0.04] to-surface
            px-5 py-4
          "
        >
          <div className="flex items-start gap-3">
            <div className="
              flex h-9 w-9 shrink-0 items-center justify-center
              rounded-lg bg-brand/15 text-brand-d
            ">
              <Sparkles size={15} strokeWidth={1.75} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-semibold text-ink">
                Product-level analysis isn't available for public companies
              </div>
              <p className="text-[12.5px] text-ink-soft mt-1 leading-relaxed">
                <span className="font-mono">{publicCompanyContext.ticker}</span> ({publicCompanyContext.name}) is covered from public filings, which report
                company-level revenue, EBITDA, and balance sheet — not SKU-level economics.
                Product Intelligence needs your private sales / trading data to find
                loss-makers, mix outliers, and discontinuation candidates.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <a
                  href={`/dashboard/public/${encodeURIComponent(publicCompanyContext.ticker)}`}
                  className="
                    inline-flex items-center gap-1.5
                    h-9 px-3 rounded-lg
                    border border-rule bg-surface
                    text-[12.5px] text-ink-soft font-medium
                    hover:bg-bg-2/50 hover:text-ink
                    transition-all
                  "
                >
                  ← Back to {publicCompanyContext.ticker} dashboard
                </a>
                <span className="text-[11.5px] text-ink-mute">
                  · Or upload sales data below to unlock SKU analysis
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* ── Hero panel — glass-card with soft gradient. Headline + a
       *  premium dropzone live in a 2-column split that stacks under lg.
       *  The wrapper card adds the gradient + ring so the hero reads as
       *  a single integrated surface rather than two loose blocks. */}
      <div className="relative">
        {/* Decorative top-right brand glow — purely visual, no real data */}
        <div aria-hidden className="pointer-events-none absolute -top-24 -right-24 h-64 w-64 rounded-full bg-brand/10 blur-3xl" />

        <div className="grid lg:grid-cols-[1.05fr_1fr] gap-6 lg:gap-10 items-start relative">
          <div>
            <div className="inline-flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.16em] text-ink-mute font-semibold">
              <Sparkles size={10} strokeWidth={2.25} className="text-brand-d" />
              Product intelligence
            </div>
            <h1 className="mt-3 text-[44px] sm:text-[56px] leading-[1.04] tracking-[-0.02em] text-ink font-serif">
              Upload your data. CFO AI finds what matters.
            </h1>
            <p className="mt-4 text-[15.5px] text-ink-soft leading-relaxed max-w-[520px]">
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
                  shadow-[0_8px_22px_-8px_rgba(92,211,197,0.6)]
                  hover:shadow-[0_10px_26px_-8px_rgba(92,211,197,0.75)]
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

          {/* Start from the official template — swapped into the hero's
              right column (the file dropzone now sits below the grid). */}
          <div className="relative">
            <TemplateDownloadCard variant="prominent" />
          </div>
        </div>

        {/* File drop zone — swapped below the hero grid (the template card
            now occupies the hero's right column). Glass, brand-glow on
            drag-over. */}
        <div className="mt-6 relative">
          <div
            data-testid="products-upload-dropzone"
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; if (f) void handleFile(f); }}
            className={`
              relative overflow-hidden rounded-2xl border-2 border-dashed transition-all duration-150
              ${drag
                ? "border-brand bg-brand/10 ring-2 ring-inset ring-brand/30 shadow-[0_0_0_4px_rgba(92,211,197,0.08)]"
                : "border-rule/80 bg-gradient-to-br from-bg-2/30 via-surface/60 to-surface/40 hover:border-rule-strong hover:from-bg-2/50"}
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

      {/* ── Contextual Ask CFO AI prompt chips — only once a dataset
       *  exists; hidden in the pre-upload (no files) state. ─────────── */}
      {datasets.length > 0 && <ProductsPromptChips />}

      {/* ── Stats strip — REAL or absent (no fabrication) ──────────── */}
      <ProductsStatsStrip stats={stats} hasData={datasets.length > 0} />

      {/* ── What happens next (process explanation — static & accurate) ── */}
      <ProductsProcessFlow />

      {/* ── Accepted formats — limits match the real parser/handler ── */}
      <ProductsAcceptedFormats />

      {/* ── Recent imports — only once a dataset exists; hides the
       *  "No imports yet. Your uploads will appear here." placeholder in
       *  the pre-upload (no files) state. ─────────────────────────── */}
      {datasets.length > 0 && <ProductsRecentImports datasets={sortedDatasets} />}

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
  const { t } = useTranslation();
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
          <div>{t("datasets.columns.file")}</div>
          <div className="text-right">{t("datasets.columns.rows")}</div>
          <div className="text-right">{t("datasets.columns.skus")}</div>
          <div>{t("datasets.columns.status")}</div>
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
  if (s === "analyzed") { label = active ? "Active" : "Analyzed"; cls = "border-[#8FE3D9]/60 text-[#2AA89B] bg-[#E6F7F4] dark:bg-[#5CD3C5]/10"; }
  else if (s === "queued" || s === "extracting" || s === "ingesting") { label = "Processing"; cls = "border-[#8FE3D9]/60 text-[#1B7268] bg-[#E6F7F4] dark:bg-[#5CD3C5]/10"; }
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
  const { t } = useTranslation();
  // Header tokens mirror what the parser accepts as input column names —
  // they're SOURCE DATA, not UI copy. Wrapped in <SourceText lang="ro">
  // below so screen readers pronounce Romanian terms with Romanian phonemes
  // when UI language is English/French.
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
  // Tailwind class string for the in-Trans <code> tokens (column names).
  // Visually distinct from the surrounding prose so the user sees
  // they're literal parser tokens, not English phrases.
  const codeCls =
    "px-1.5 py-0.5 rounded text-[11px] font-mono bg-bg-2 text-ink border border-rule/60";
  return (
    <div
      data-testid="sales-format-hint"
      className="mt-8 rounded-2xl border border-rule bg-surface px-5 py-5"
    >
      <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
        <div className="min-w-0">
          <div className="text-[10.5px] uppercase tracking-[0.1em] font-semibold text-ink-soft">
            {t("expectedFormat.eyebrow")}
          </div>
          <h4 className="font-serif text-[18px] leading-tight text-ink mt-1">
            {t("expectedFormat.title")}
          </h4>
          <p className="text-[12.5px] text-ink-soft mt-1 max-w-[640px]">
            {t("expectedFormat.intro")}{" "}
            <Trans
              i18nKey="expectedFormat.required"
              components={{
                c1: <SourceText lang="ro" className={codeCls} />,
                c2: <code className={codeCls} />,
              }}
            />{" "}
            <Trans
              i18nKey="expectedFormat.optional"
              components={{
                c1: <code className={codeCls} />,
                c2: <code className={codeCls} />,
                c3: <code className={codeCls} />,
              }}
            />{" "}
            <Trans
              i18nKey="expectedFormat.rollup"
              components={{
                c1: <code className={codeCls} />,
              }}
            />
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
            {t("expectedFormat.downloadExample")}
          </a>
          <span className="text-[10.5px] text-ink-mute italic max-w-[220px] text-right">
            {t("expectedFormat.exampleCaption")}
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
                  {/* Source-data column name — parser-mirroring identifier.
                      lang="ro" hint so AT pronounces "Denumire produs" with
                      Romanian phonemes even when UI lang is English. */}
                  <SourceText lang="ro">{h}</SourceText>
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
                    {/* String cells are source-data placeholders too. */}
                    {typeof v === "string"
                      ? <SourceText lang="ro">{fmt(v)}</SourceText>
                      : fmt(v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-[11px] text-ink-mute italic">
        <Trans
          i18nKey="expectedFormat.exampleFooter"
          components={{
            c1: <code className={codeCls} />,
            c2: <code className={codeCls} />,
          }}
        />
      </p>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * CUR-FIX-D — drop-in replacement for the legacy `formatKron(n)` helper.
 *
 * SKU money values are persisted in thousands of the source currency
 * (kRON / kEUR / kUSD — the engine convention to keep table widths sane
 * with 9-digit revenue figures). The currency switcher in TopHeader drives
 * a single `display` setting in <CurrencyProvider>; this hook subscribes
 * to it so dragging RON→EUR→USD re-renders every Products-page money
 * surface live, without refetch.
 *
 * Returns a memoised `(krn: number) => string` formatter that:
 *   1. scales kSourceUnit → base SourceUnit (× 1000),
 *   2. applies FX through `formatMoneyFrom` (source → display),
 *   3. renders compactly ("12.3M €" / "1.2k RON") so KPI tiles stay tight.
 *
 * Memoisation is keyed on (fromCurrency, display, rates) — passing the
 * returned function down to memoised children does not bust their caches.
 */
function useKronFormatter(fromCurrency: Currency | string) {
  const { display, rates } = useCurrency();
  return useMemo(() => {
    const src = (fromCurrency as Currency) || "RON";
    return (krn: number): string =>
      formatMoneyFrom(krn * 1000, src, display, rates.rates, { compact: true });
  }, [fromCurrency, display, rates]);
}

interface ExportFxContext {
  sourceCurrency: Currency;
  displayCurrency: Currency;
  rate: number;
  rateDate: string | null;
  provider: string | null;
}

function exportCsv(
  rows: SkuAggregate[],
  datasetLabel: string,
  fx: ExportFxContext,
) {
  // CUR-FIX-F — every monetary column converts source → display at export
  // time. The metadata header preceding the data rows declares the rate
  // applied so the file is self-describing for banks / auditors / agents
  // who receive it. No converted CSV ships without this disclosure.
  const meta: string[] = [
    `# Exported: ${new Date().toISOString()}`,
    `# Display currency: ${fx.displayCurrency}`,
    `# Source currency: ${fx.sourceCurrency}`,
    `# FX rate applied: ${fx.rate.toFixed(6)} (1 ${fx.sourceCurrency} = ${fx.rate.toFixed(6)} ${fx.displayCurrency})`,
    `# FX provider: ${fx.provider ?? "n/a"} · rate date: ${fx.rateDate ?? "n/a"}`,
    "",
  ];

  const niv_col = `niv_k${fx.displayCurrency.toLowerCase()}`;
  const gm_col = `gm_k${fx.displayCurrency.toLowerCase()}`;
  const headers = [
    "product_name", "brand", "category", "volume_tons",
    niv_col, gm_col, "gm_pct", "classification",
    "channels_present", "line_row_count",
  ];

  const convert = (krn: number | null | undefined): string => {
    if (krn === null || krn === undefined || !Number.isFinite(krn)) return "";
    // kRON is already thousands; FX rate is per source unit. Apply rate
    // directly — output stays in thousands of the display currency.
    if (fx.sourceCurrency === fx.displayCurrency) return String(krn);
    return (krn * fx.rate).toFixed(2);
  };

  const lines = [...meta, headers.join(",")];
  for (const r of rows) {
    const cells = [
      r.product_name, r.brand ?? "", r.category ?? "",
      r.volume_tons ?? "",
      convert(r.niv_krn),
      convert(r.gm_krn),
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
  a.download = `${datasetLabel.replace(/[^a-z0-9-_]+/gi, "_")}_skus_${fx.displayCurrency}.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
}

/**
 * CategoryHintInline — renders an italic translation hint next to a
 * Romanian category code when the active UI language is EN or FR.
 * Returns null when:
 *   · UI lang is RO (native readers don't need the hint)
 *   · the category isn't in the CATEGORY_HINTS dictionary
 *   · UI lang isn't en/fr (no dictionary yet)
 *
 * Lives at file end (not in @/components/ui/) because the Romanian
 * category dictionary is Products-page specific. If another page needs
 * the same pattern, lift into @/components/ui/CategoryHint.tsx.
 */
function CategoryHintInline({ category }: { category: string }) {
  const { i18n } = useTranslation();
  const hint = categoryHint(category, i18n.language || "en");
  if (!hint) return null;
  return (
    <span className="ml-1.5 text-[10.5px] text-ink-mute italic">({hint})</span>
  );
}
