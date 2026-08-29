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
import { useCurrency } from "@/stores/currency";
import { formatMoneyFrom } from "@/lib/money";
import { openStagedFile, openUploadedFilePreview } from "@/lib/stagedFilePreview";
import { clearStagedFiles, readStagedFiles, writeStagedFiles } from "@/lib/stagedFilesStore";
import type { Currency } from "@/lib/rates";
import { categoryHint } from "@/lib/categoryHints";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import {
  AlertCircle,
  ArrowDownToLine,
  ArrowUp,
  Boxes,
  Check,
  CheckCircle2,
  Cloud,
  FileSpreadsheet,
  Info,
  Loader2,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { CategoriesOverview, BackToCategoriesPill } from "@/components/cfo/products/CategoriesOverview";
import { DioPersistenceBanner } from "@/components/cfo/products/DioPersistenceBanner";
import { ViewToggle, type ProductsView } from "@/components/cfo/products/ViewToggle";
import { TemplateDownloadCard } from "@/components/cfo/products/TemplateDownloadCard";
import { SkuDetailDrawer } from "@/components/cfo/SkuDetailDrawer";
import { openAskCfoAi } from "@/components/cfo/chat/openAskCfoAi";
import { useActivePeriod } from "@/lib/activePeriod";
import { useActiveOrg } from "@/lib/org";
import { fetchWorkspacePeriodsDirect, formatPeriodMonth } from "@/lib/orgPeriods";
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
import {
  clearUpload,
  isInFlight,
  patchUpload,
  readUploadStore,
  startUpload,
  useUploadStore,
} from "@/lib/uploadStore";
import { ScanProgressView, SCAN_TEXT_KEYS, SKU_DATASET_STEPS, SKU_STATUS_ORDINAL, SKU_STATUS_MESSAGES } from "@/components/cfo/ScanProgressView";
import { isScanSpherePaused } from "@/components/cfo/CouncilSphereHost";
// THE INSTRUMENT — compact page header, resting-surface panels, the one
// chip system, and <Amount>/<MoneyAmount> for every figure on this page.
import {
  Chip as InstrumentChip,
  PageHeader as InstrumentPageHeader,
  Panel,
  PanelBody,
  PanelHeader,
  type ChipTone,
} from "@/components/instrument/Panel";
import { Amount } from "@/components/instrument/Amount";
import {
  MoneyAmount,
  MoneyAmountGroup,
  PercentLevel,
  useDisplayMoney,
} from "@/components/comparison/MoneyAmount";
import { AddFileTile, SourceFilesRow } from "@/components/cfo/SourceFilesRow";
import { FilterDropdown } from "@/components/ui/FilterDropdown";
import { GuideMeButton } from "@/components/learning/GuideMeButton";
import { PRODUCTS_GUIDE } from "@/components/learning/pageGuides";
// F5.0 Phase 8 — Products / SKU learning. The 3 bucket KPI labels
// (Protect / Watch / Wind down) become click-to-learn — each routes to
// the concept that explains its decision-rule logic. The SKU count
// stays a raw label since it doesn't need explanation.
import { usePopoverStack } from "@/components/learning/PopoverStackProvider";

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
  /** Uploaded document behind this dataset — used to open the file preview. */
  document_id?: string | null;
  /** Month (financial_periods.id) this file was uploaded into. Drives the
   *  per-month nesting of "Source files". `null`/absent = unassigned, which
   *  shows under every month — that covers every upload made before the
   *  pinning landed, and any engine build that predates the field. */
  period_id?: string | null;
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
// (The legacy 6-classification BUCKET_META / FILTER_ORDER tables were dead
// code — the Signal column, chips and KPI tiles all run on the 3-bucket
// model — and were removed in the Instrument migration.)

// Display metadata for the 3-bucket filter chips and row signals. Semantic
// tokens only: protect = success, watch = caution, wind down = alert (red
// is reserved for danger/imbalance across the product).
const BUCKET3_FILTER_META: Record<Bucket3, { label: string; dot: string }> = {
  protect:   { label: "Protect",   dot: "bg-success" },
  watch:     { label: "Watch",     dot: "bg-caution" },
  wind_down: { label: "Wind down", dot: "bg-alert" },
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

  // The period an upload nests under. `useActivePeriod()` only knows what's in
  // the URL, and Products can be opened without `?period=` — in which case
  // every SKU file landed unattached, showing up under no month at all. Fall
  // back to the SIDEBAR's choice, resolved the same way it resolves: the
  // workspace's newest period. Empty containers count — a month created in
  // Workspace is a legitimate home for a sales file.
  const { org: uploadOrg } = useActiveOrg();
  const { data: uploadPeriodsPayload } = useQuery({
    queryKey: ["org-periods", uploadOrg?.id ?? null],
    queryFn: () => fetchWorkspacePeriodsDirect(uploadOrg!.id),
    enabled: !!uploadOrg?.id,
  });
  const uploadPeriodId =
    period.id ?? uploadPeriodsPayload?.periods[0]?.period_id ?? null;

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
  // EmptyState dropzone unmounts as soon as a dataset is loaded, so its
  // file input isn't in the DOM when the panel button is clicked. We mount
  // our own always-present hidden input here + listen for the event so the
  // native OS file picker opens regardless of whether the dropzone is
  // currently visible.
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
        title: t("productsX.toast.fileTooLarge"),
        description: t("productsX.toast.fileTooLargeDesc", {
          size: (file.size / 1_000_000).toFixed(1),
          limit: PRODUCTS_UPLOAD_MAX_MB,
        }),
        variant: "destructive",
      });
      return;
    }
    // Flip into the scan view immediately (docId lands after upload), the
    // same way the dropzone does — this path used to show nothing but a
    // toast until the inflight query happened to refetch.
    startUpload({ docId: "", filename: file.name, status: "queued", surface: "products" });
    // Pin the file to the month that's active right now, so it nests under
    // that month in "Source files" (see uploadDocument's `periodId`).
    const { row, error } = await uploadDocument(file, { scope: "sku", periodId: uploadPeriodId });
    if (!row) {
      clearUpload();
      toast({ title: t("productsX.toast.uploadFailed"), description: error ?? t("productsX.toast.unknownError"), variant: "destructive" });
      return;
    }
    startUpload({ docId: row.id, filename: file.name, status: "queued", surface: "products" });
    const enq = await uploadEnqueue.enqueue(row.id);
    if (enq.kind !== "queued") {
      // Modal/toast already surfaced by the hook.
      clearUpload();
      return;
    }
    // Data now exists — re-enable the gated datasets/inflight queries so the
    // invalidations below actually refetch (they no-op while disabled).
    if (uid) { writeSkuVerdict(uid, true); setSkuGate(true); }
    // 2026-05-26 — invalidate BOTH the inflight query (so a reload mid-scan
    // resumes on the query-driven surface) AND the datasets list (so the new
    // dataset row appears in DatasetsPanel mid-flight).
    void qc.invalidateQueries({ queryKey: ["sku-analysis", "inflight"] });
    void qc.invalidateQueries({ queryKey: ["sales-datasets"] });
    // Walk the store through every pipeline stage so the steps + council
    // sphere animate; the page-level handoff owns the finish.
    const unsub = subscribeToDocumentStatus(row.id, (next) => {
      patchUpload({ status: next.status, error: next.error });
      if (next.status === "analyzed") {
        unsub();
        toast({ title: t("productsX.toast.analysisReady"), description: file.name });
        void qc.invalidateQueries({ queryKey: ["sales-datasets"] });
      }
      if (next.status === "failed") {
        unsub();
        toast({
          title: t("productsX.toast.analysisFailed"),
          description: next.error ?? t("productsX.toast.unknownError"),
          variant: "destructive",
        });
      }
    });
  }, [toast, uploadEnqueue, qc, uid, uploadPeriodId, t]);

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
  // Active dataset, scoped to the active month (2026-07-26). Files are pinned
  // to the month they were uploaded into, so a `?dataset=` carried over from
  // another month — or a backend `active_dataset_id` belonging to one — must
  // NOT keep driving the page after a month switch: its pill is no longer on
  // screen, so the table would show numbers with nothing selected to explain
  // them. Fall back to this month's newest file instead. Unassigned files
  // (period_id null) count as in-scope for every month, so nothing uploaded
  // before the pinning shipped becomes unreachable.
  const monthDatasets = useMemo(
    () => datasetsForMonth(datasetsPayload?.datasets ?? [], period.id ?? null)
      .sort((a, b) => new Date(b.uploaded_at).getTime() - new Date(a.uploaded_at).getTime()),
    [datasetsPayload?.datasets, period.id],
  );
  const requestedDatasetId = params.get("dataset") ?? datasetsPayload?.active_dataset_id ?? null;
  const activeDatasetId =
    requestedDatasetId && monthDatasets.some((d) => d.id === requestedDatasetId)
      ? requestedDatasetId
      : monthDatasets[0]?.id ?? null;

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

  // Live status for the QUERY-driven scan surface (an upload started on
  // another device / before a refresh, or from the Datasets panel).
  //
  // 2026-07-26 — this used to invalidate ONLY on analyzed|failed, which is
  // why the scan sat at "Queued for analysis…" for its entire run: nothing
  // ever refreshed the query in between, so the steps + council sphere never
  // walked. Every status now writes straight into the query cache, so the
  // Products scan animates exactly like the dashboard's. Terminal statuses
  // deliberately do NOT null the inflight doc here — the completion handoff
  // below needs `analyzed` on screen to play the sphere's finale first.
  useEffect(() => {
    const docId = inflight?.id;
    if (!docId) return;
    const unsub = subscribeToDocumentStatus(docId, (next) => {
      qc.setQueryData<InflightDoc | null>(["sku-analysis", "inflight"], (prev) =>
        prev && prev.id === docId
          ? { ...prev, status: next.status, error: next.error }
          : prev,
      );
      // Keep the store in step too when it's tracking this same doc — the
      // council sphere paints off the store, so a resumed scan needs it.
      const cur = readUploadStore().current;
      if (cur && cur.surface === "products" && cur.docId === docId) {
        patchUpload({ status: next.status, error: next.error });
      }
      if (next.status === "analyzed" || next.status === "failed") {
        void qc.invalidateQueries({ queryKey: ["sales-datasets"] });
      }
    });
    return unsub;
  }, [inflight?.id, qc]);

  // Resume path — a scan already running when the page loads (refresh
  // mid-analysis, or an upload started from another surface) lives only in
  // the inflight query. Seed the upload store from it so the persistent
  // council sphere (CouncilSphereHost paints off the store) shows up
  // instead of leaving bare steps over an empty space.
  useEffect(() => {
    if (!inflight || !isInFlight(inflight.status)) return;
    const cur = readUploadStore().current;
    if (cur && cur.surface === "products" && cur.docId === inflight.id) return;
    startUpload({
      docId: inflight.id,
      filename: inflight.filename,
      status: inflight.status,
      surface: "products",
    });
    // Keyed on id+status only — depending on the `inflight` object itself
    // would re-run this on every refetch that returns an equal doc.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inflight?.id, inflight?.status]);

  // ── The scan surface (one source of truth) ────────────────────────────────
  // The upload store is PRIMARY while a Products upload is running: it's
  // patched on every pipeline status by the subscription in scanOneFile, so
  // it's the freshest signal. The inflight query is the RESUME path — it
  // covers a page reload mid-scan and uploads kicked off from elsewhere.
  const uploadCurrent = useUploadStore().current;
  const productsUpload =
    uploadCurrent && uploadCurrent.surface === "products" ? uploadCurrent : null;
  const queryInflight =
    inflight && !dismissedInflightIds.has(inflight.id) ? inflight : null;
  const liveScanDoc: InflightDoc | null = productsUpload
    ? {
        id: productsUpload.docId,
        filename: productsUpload.filename,
        status: productsUpload.status,
        error: productsUpload.error ?? null,
      }
    : queryInflight;
  // Only a scan we actually WATCHED run gets the completion ceremony. The
  // upload store persists to localStorage, so a scan that finished while the
  // user was on another tab would otherwise greet them with a "Analysis
  // ready" card for a file they finished with hours ago.
  const watchedScanIds = useRef<Set<string>>(new Set());
  if (liveScanDoc && isInFlight(liveScanDoc.status)) {
    watchedScanIds.current.add(liveScanDoc.id);
  }
  const staleAnalyzed =
    !!liveScanDoc
    && liveScanDoc.status === "analyzed"
    && !watchedScanIds.current.has(liveScanDoc.id);
  const scanDoc: InflightDoc | null = staleAnalyzed ? null : liveScanDoc;
  // …and drop that stale entry so the store doesn't hold a finished upload.
  useEffect(() => {
    if (staleAnalyzed) clearUpload();
  }, [staleAnalyzed]);

  // Completion handoff — fade the sphere out, then reveal the populated page
  // with the file that just landed. The sphere pulls its orbs into the core
  // and the "Analysis ready" card fades in over the cleared space; the card
  // then WAITS for the user (2026-07-26 per operator — a timed auto-dismiss
  // pulled it off screen ~1s after it finished fading in, before it could be
  // read). Only "View results" leaves the scan view.
  const revealResults = useCallback(() => {
    if (uid) { writeSkuVerdict(uid, true); setSkuGate(true); }
    clearUpload();
    // Drop a stale ?dataset= / ?compare= so the page falls back to this
    // month's NEWEST dataset — the one that just finished analyzing.
    setParams((prev) => {
      const sp = new URLSearchParams(prev);
      sp.delete("dataset");
      sp.delete("compare");
      return sp;
    }, { replace: true });
    qc.setQueryData(["sku-analysis", "inflight"], null);
    void qc.invalidateQueries({ queryKey: ["sales-datasets"] });
    void qc.invalidateQueries({ queryKey: ["sku-analysis", "inflight"] });
  }, [qc, uid, setParams]);


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
  //
  // The scan surface comes FIRST — before the datasets loader — because a
  // finishing scan invalidates the datasets query, and letting that flash
  // "Loading datasets…" over the sphere would cut the completion animation
  // in half.
  if (scanDoc) {
    // Failed → keep the InflightCard (it carries the retry / hang-recovery
    // UI). In-flight → show the council-sphere ScanProgressView, the same
    // premium scan surface as the dashboard + the empty-state upload, instead
    // of the old flat step-list card (removed 2026-07-25 per operator).
    if (scanDoc.status === "failed") {
      return (
        <InflightCard
          inflight={scanDoc}
          onDismiss={() => {
            clearUpload();
            dismissInflight(scanDoc.id);
          }}
        />
      );
    }
    // `analyzed` deliberately still renders here: onViewResults makes the
    // sphere converge + fade behind a "Scan complete" card, and the handoff
    // effect above swaps in the populated page a beat later.
    return (
      <section data-testid="products-scanning">
        {uploadEnqueue.dialog}
        <ScanProgressView
          status={scanDoc.status}
          steps={SKU_DATASET_STEPS}
          statusOrdinals={SKU_STATUS_ORDINAL}
          statusMessages={SKU_STATUS_MESSAGES}
          onCancel={() => {
            clearUpload();
            dismissInflight(scanDoc.id);
          }}
          onViewResults={revealResults}
          completeTitle={t("productsX.toast.analysisReady")}
          completeBody={t("productsX.scan.completeBody")}
        />
      </section>
    );
  }

  if (loadingDatasets) {
    return (
      <>
        <div className="max-w-[680px] mx-auto py-16 text-center">
          <Loader2 size={20} className="animate-spin mx-auto text-ink-soft mb-3" />
          <p className="text-[13px] text-ink-soft">{t("products.loading.datasets")}</p>
        </div>
      </>
    );
  }

  // Scoped to the ACTIVE MONTH, not the account (2026-07-26). With files
  // nested under months, a month can legitimately have none while other
  // months do — and in that case `activeDatasetId` resolves to null, which
  // would otherwise fall through to the "Loading SKUs…" branch below and
  // spin forever (its query is disabled without an id). The empty state is
  // the correct surface: it offers the upload that fills this month.
  // `datasets` still gets the FULL list — the stats strip and recent-imports
  // panel there are account-level history, not month-scoped.
  if (monthDatasets.length === 0) {
    return (
      <>
        <EmptyState
          onUploaded={refresh}
          datasets={datasetsPayload?.datasets ?? []}
          monthLabel={period.id ? formatPeriodMonth(period.periodEnd) : null}
          uploadPeriodId={uploadPeriodId}
        />
      </>
    );
  }

  if (loadingSkus || !dsPayload) {
    return (
      <>
        <div className="max-w-[680px] mx-auto py-16 text-center">
          <Loader2 size={20} className="animate-spin mx-auto text-ink-soft mb-3" />
          <p className="text-[13px] text-ink-soft">{t("products.loading.skus")}</p>
        </div>
      </>
    );
  }

  const { totals, dataset } = dsPayload;

  return (
    <>
      {/* Always-mounted file input. DatasetsPanel's "Upload sales dataset"
          button dispatches `cfo:request-sku-upload`; the useEffect above
          forwards to this hidden input's .click() → native OS file picker.
          Lives at the page root so it survives every render branch below. */}
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
        {/* Source files for the active month + the upload dropzone on their
            right (2026-07-26 per operator — replaced the pills row). Guide me
            rides above, far right (F5.0 Step 4 — auto-opens for first-time
            guided-mode users). */}
        <DatasetSourceFiles
          datasets={datasetsPayload?.datasets ?? []}
          activeDatasetId={activeDatasetId}
          activePeriodId={period.id ?? null}
          activeMonthLabel={period.id ? formatPeriodMonth(period.periodEnd) : null}
          onUpload={(f) => void handlePageUploadFile(f)}
        />

        {/* Header — compact instrument header (serif hero retired). The
            dataset facts that used to be the subtitle live in the context
            line; the source file rides as a neutral chip so provenance is
            one glance away. Guide me moved into the actions slot. */}
        <div data-testid="portfolio-header">
          <InstrumentPageHeader
            eyebrow={t("products.title")}
            title="Product intelligence"
            context={
              <>
                <span className="min-w-0">
                  <Trans
                    i18nKey="products.subtitle"
                    values={{
                      rows: dataset.row_count?.toLocaleString("en-GB") ?? "—",
                      count: totals.sku_count.toLocaleString("en-GB"),
                      categories: totals.category_count,
                    }}
                  />
                </span>
                <InstrumentChip tone="neutral" className="whitespace-nowrap max-w-[280px]">
                  <FileSpreadsheet size={11} strokeWidth={2} aria-hidden className="shrink-0" />
                  <span className="truncate">
                    <SourceText lang="ro">{dataset.source_filename ?? dataset.label}</SourceText>
                  </span>
                </InstrumentChip>
              </>
            }
            actions={
              <GuideMeButton pageId="products" title={t("productsX.guideTitle")} steps={PRODUCTS_GUIDE} />
            }
          />
          <p className="mt-1 text-[11.5px] text-ink-soft">
            {dataset.label} ·{" "}
            {new Date(dataset.uploaded_at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })} ·{" "}
            {t("productsX.sourceNeverAltered")}
          </p>
        </div>

        {/* Reconciliation chip — moved directly under the header description
            (2026-07-26 per operator). Surfaces accuracy issues the moment
            they happen: sums niv_krn across every loaded SKU and compares to
            the backend-reported totals.niv_krn. Green ✓ when within 1 RON of
            the source; amber ⚠ with the absolute delta otherwise.
            Click-through reveals the per-SKU breakdown. */}
        <header data-testid="portfolio-kpis">
          {/* Quality/reconciliation verdict above the KPI tiles, width-capped
              so its paragraph can't run the full page. (Guide me moved into
              the page header's actions slot.) */}
          <div className="min-w-0 max-w-[840px] mb-2">
            <ReconciliationChip dsPayload={dsPayload} currency={sourceCurrency} />
          </div>
          {/* 4-tile KPI grid: SKUs total + the three threshold-reactive
              buckets. `counts3` recomputes via useMemo on every threshold
              change so dragging a Decision-rules slider live-updates these
              tiles — no refresh, no refetch. */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {/* F5.0 Phase 8 — each bucket KPI label is now a click
                target opening its concept popover (sku_classification
                bucket = Protect / Watch / Wind Down). The SKU count
                tile stays a raw count with no learning hook since
                "how many SKUs you have" doesn't need explanation. */}
            <KpiCard data-testid="kpi-sku-count" label={t("products.kpi.skus")} value={totals.sku_count} sub={t("products.kpi.skusSub", { cats: totals.category_count, brands: totals.brand_count })} />
            <KpiCard conceptKey="protect_bucket_count"   data-testid="kpi-protect"   label={t("products.kpi.protect")}  value={counts3.protect}   sub={t("products.kpi.protectSub")} tone="strong" />
            <KpiCard conceptKey="watch_bucket_count"     data-testid="kpi-watch"     label={t("products.kpi.watch")}    value={counts3.watch}     sub={t("products.kpi.watchSub")} tone="warn" />
            <KpiCard conceptKey="wind_down_bucket_count" data-testid="kpi-wind-down" label={t("products.kpi.windDown")} value={counts3.wind_down} sub={t("products.kpi.windDownSub")} tone="critical" />
          </div>
        </header>

        {/* Company working-capital roll-up — moved to the top of the page
            (2026-07-26 per operator), directly under the KPI tiles. Per-SKU
            DIO covered rows aggregated to a company DIO (with coverage %),
            combined with DSO/DPO from the loaded period's trial-balance
            context (when available) into CCC = DIO + DSO − DPO. Each
            component is labelled with its source; missing components show
            "not available" rather than a fabricated value. */}
        <WorkingCapitalRollup skus={dsPayload.skus} />

        {/* Search + filters */}
        <div className="space-y-3">
          {/* View toggle — "By category / All SKUs" pinned ABOVE the search
              bar (2026-07-26 per operator). Pill-style segmented control;
              URL state ownership stays here so deep links + back-button keep
              working. */}
          <ViewToggle
            value={(params.get("view") ?? "categories") as ProductsView}
            onChange={(v) => setUrlParam("view", v === "categories" ? null : v)}
          />

          {/* Search — full-width row (2026-07-26 per operator), styled like
              the Public Companies search bar. Always visible; typing a query
              auto-switches into the flat All-SKUs view (the only view the
              search filters), so results are visible as you type. The button
              blurs the field (dismisses the mobile keyboard) — an affordance,
              not a submit. */}
          <div className="flex flex-col sm:flex-row items-stretch gap-2.5 w-full">
            <div className="
              flex-1 min-w-0
              flex items-center gap-3 h-12 px-4
              rounded-xl border border-rule bg-surface
              transition-colors
            ">
              <Search size={18} strokeWidth={1.75} className="text-ink-soft shrink-0" />
              <input
                value={search}
                onChange={(e) => {
                  const v = e.target.value;
                  setSearch(v);
                  // Typing a query jumps into the All-SKUs view (the view the
                  // search actually filters) so matches surface immediately.
                  if (v && (params.get("view") ?? "categories") !== "all") {
                    setUrlParam("view", "all");
                  }
                }}
                placeholder={t("products.searchPlaceholder")}
                spellCheck={false}
                data-testid="products-search-input"
                className="flex-1 min-w-0 bg-transparent outline-none text-[14px] text-ink placeholder:text-ink-soft tracking-[-0.005em]"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  aria-label={t("productsX.clearSearch")}
                  className="shrink-0 text-ink-soft hover:text-ink transition-colors"
                >
                  <X size={14} strokeWidth={2} />
                </button>
              )}
            </div>
          </div>
          {/* Filters row (All-SKUs view only, 2026-07-26 per operator) — the
              3-bucket filter chips on the LEFT, and the brand / category /
              channel / sort dropdowns pushed to the RIGHT (ml-auto), all on the
              same line. Chip counts come from `counts3` (live recompute on
              threshold change) so they stay in lock-step with the KPI tiles. */}
          {(params.get("view") ?? "categories") === "all" && (
          <div className="flex items-center gap-2 flex-wrap">
            <FilterChip testid="chip-all" label={t("products.buckets.all")} count={totals.sku_count} active={activeFilters.size === 0} onClick={() => setStateFilter(null)} />
            {(["protect", "watch", "wind_down"] as Bucket3[]).map((b) => {
              const n = counts3[b];
              const meta = BUCKET3_FILTER_META[b];
              // Translate at render time. Key shape matches `products.buckets.{name}`.
              const i18nKey =
                b === "wind_down" ? "products.buckets.windDown" : `products.buckets.${b}`;
              return (
                <FilterChip
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
            <div className="flex items-center gap-2 flex-wrap ml-auto">
              <FilterDropdown
                testid="filter-brand"
                value={brandFilter}
                onChange={(v) => setUrlParam("brand", v || null)}
                placeholder={t("products.filters.allBrandsShort", "All brands")}
                count={totals.brand_count}
                // Brand names are proper nouns — source data, never translated.
                options={[
                  { value: "", label: t("products.filters.allBrandsShort", "All brands") },
                  ...totals.brands.map((b) => ({ value: b, label: b })),
                ]}
              />
              <FilterDropdown
                testid="filter-category"
                value={categoryFilter}
                onChange={(v) => setUrlParam("category", v || null)}
                placeholder={t("products.filters.allCategoriesShort", "All categories")}
                count={totals.category_count}
                options={[
                  { value: "", label: t("products.filters.allCategoriesShort", "All categories") },
                  ...totals.categories.map((c) => ({ value: c, label: c })),
                ]}
              />
              <FilterDropdown
                testid="filter-channel"
                value={channelFilter}
                onChange={(v) => setUrlParam("channel", v || null)}
                placeholder={t("products.filters.allChannels")}
                // Channel codes (KA/DIST/EXP/OLN) shown as their full names
                // in the list (2026-07-26 per operator).
                options={[
                  { value: "", label: t("products.filters.allChannels") },
                  ...(["KA", "DIST", "EXP", "OLN"] as const).map((c) => ({ value: c, label: t(`productsX.channels.${c}`) })),
                ]}
              />
              <FilterDropdown
                testid="sort-dropdown"
                value={`${sortKey}_${sortDir}`}
                onChange={(v) => {
                  // Sort keys themselves contain underscores (gm_krn, gm_pct,
                  // volume_tons, niv_krn). Split on the LAST underscore so the
                  // key+direction parse correctly.
                  const idx = v.lastIndexOf("_");
                  setSortKey(v.slice(0, idx) as typeof sortKey);
                  setSortDir(v.slice(idx + 1) as "asc" | "desc");
                }}
                placeholder={t("products.sort.label")}
                options={[
                  { value: "gm_krn_desc", label: t("products.sort.label") + " " + t("products.sort.gmDesc") },
                  { value: "gm_krn_asc", label: t("products.sort.label") + " " + t("products.sort.gmAsc") },
                  { value: "gm_pct_desc", label: t("products.sort.label") + " " + t("products.sort.gmPctDesc") },
                  { value: "gm_pct_asc", label: t("products.sort.label") + " " + t("products.sort.gmPctAsc") },
                  { value: "volume_tons_desc", label: t("products.sort.label") + " " + t("products.sort.volumeDesc") },
                  { value: "niv_krn_desc", label: t("products.sort.label") + " " + t("products.sort.nivDesc") },
                  { value: "name_asc", label: t("products.sort.label") + " " + t("products.sort.nameAsc") },
                ]}
              />
            </div>
          </div>
          )}

          {(params.get("view") ?? "categories") === "all" && (
          <div data-testid="sku-table-summary" className="text-[11.5px] text-ink-soft">
            {t("products.showing", {
              visible: filtered.length.toLocaleString("en-GB"),
              total: totals.sku_count.toLocaleString("en-GB"),
            })}
          </div>
          )}
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
              currency={sourceCurrency}
              onSelectCategory={(cat) => setUrlParam("category", cat)}
              costOfFinancingPct={(rulesState.financing ?? DEFAULT_FINANCING).costOfFinancing}
              bankSpreadPct={(rulesState.financing ?? DEFAULT_FINANCING).bankSpread}
            />
          );
        })()}

        {/* 2026-05-26 — PortfolioTotalsBar removed at operator request.
            The card was rendering "Portofoliu total" with NIV/GM/Losses
            converted at the wrong unit scale (kRON values displayed as
            if raw RON → ×1000 inflation; €17M revenue shown as €3.5 Mrd.).
            All four figures (Volume / NIV / GM / Losses) also already
            appear in the WorkingCapitalRollup + the KPI tiles above the
            Categories overview, so the bar was duplicate AND broken. The
            component function is left in place as dead code in case
            we want to restore a corrected version later. */}

        {/* Divider above the export card (2026-07-26 per operator) — solid
            rule, no faded edges. */}
        <div aria-hidden className="h-px bg-rule-strong" />

        {/* Export CSV — moved from a small filter-row button into a full card
            at the bottom of the page (2026-07-26 per operator), styled like
            the dashboard's "HTML financial analysis report" export card:
            brand left sleeve, oversized faint background icon, serif title,
            dense description, animated-gradient Download button bottom-right. */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
          <div className="relative flex overflow-hidden rounded-2xl border border-rule bg-surface min-h-[240px]">
            <div className="w-2 shrink-0 bg-brand" />
            <div className="relative flex-1 p-3.5 flex flex-col">
              <div aria-hidden className="pointer-events-none absolute -bottom-10 -left-8 text-brand opacity-[0.08]">
                <FileSpreadsheet size={230} strokeWidth={1} />
              </div>
              <div className="relative">
                <h3 className="text-[17px] font-semibold tracking-tight leading-tight text-ink">{t("productsX.export.title")}</h3>
                <p className="text-[13px] text-ink-soft mt-1">
                  {t("productsX.export.body")}
                </p>
              </div>
              <div className="relative mt-auto pt-6 flex justify-end">
                <button
                  onClick={() => exportCsv(filtered, dataset.label, {
                    sourceCurrency: sourceCurrency,
                    displayCurrency: displayCurrencyForExport,
                    rate: exportRate,
                    rateDate: ratesPayload.rateDate,
                    provider: ratesPayload.provider,
                  })}
                  data-testid="export-portfolio"
                  className="inline-flex items-center gap-2 h-10 px-4 rounded-lg ask-ai-anim-fill [animation-duration:10s] border border-brand/40 text-ink text-[13px] font-medium hover:border-brand/60 transition-colors"
                >
                  <ArrowDownToLine size={15} strokeWidth={2} />
                  {t("common.download")}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Danger zone (2026-07-26 per operator) — ships in production, so the
            copy is written for a real user about to lose real data, not for a
            developer resetting a fixture. Lives at the very bottom, where a
            destructive action can't be hit by reflex. */}
        <div
            data-testid="products-dev-tools"
            className="mt-2 pt-5 border-t border-dashed border-rule flex items-center justify-between gap-3 flex-wrap"
          >
            <div>
              <div className="text-[10.5px] uppercase tracking-[0.14em] font-semibold text-alert/90">
                {t("productsX.danger.title")}
              </div>
              <p className="text-[12px] text-ink-soft mt-0.5 max-w-[560px]">
                {t("productsX.danger.body")}
              </p>
            </div>
            <DevWipeDataButton />
        </div>
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
 * Renders inline below the KPI tiles. Voice + presentation mirror the
 * Dashboard's AccuracyBanner (FinancialStatements.tsx): a full-sentence
 * quality-check verdict with the measured reconciliation %, what's safe
 * to use, and the standing cross-check caveat — teal for clean, alert
 * tone with the specific gap when the sums diverge.
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
  const { t } = useTranslation();

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
    const gapPct = expectedKrn !== 0 ? (absDelta / Math.abs(expectedKrn)) * 100 : 0;
    return { expectedKrn, observedKrn, deltaKrn, absDelta, isClean, gapPct };
  }, [dsPayload]);

  if (!recon) return null;
  const counted = (dsPayload?.skus ?? []).length.toLocaleString("en-GB");
  const total = (dsPayload?.totals.sku_count ?? 0).toLocaleString("en-GB");
  return (
    <div
      data-testid="reconciliation-chip"
      data-clean={recon.isClean ? "true" : "false"}
      className={`mt-3 flex items-start gap-2.5 rounded-lg border-l-[3px] px-4 py-3 text-[12.5px] leading-relaxed text-ink-soft ${
        recon.isClean
          ? "border-success/50 bg-success-tint/60"
          : "border-alert/50 bg-alert-tint/60"
      }`}
      title={t("productsX.recon.tooltip", {
        expected: fmtKron(recon.expectedKrn),
        observed: fmtKron(recon.observedKrn),
      })}
    >
      {recon.isClean ? (
        <CheckCircle2 size={13} strokeWidth={1.75} className="text-success mt-0.5 shrink-0" />
      ) : (
        <AlertCircle size={13} strokeWidth={1.75} className="text-alert mt-0.5 shrink-0" />
      )}
      <div>
        {recon.isClean ? (
          <Trans
            i18nKey="productsX.recon.clean"
            values={{
              pct: (Math.floor(recon.gapPct * 100) / 100).toFixed(2),
              counted,
              total,
            }}
            components={{
              b1: <strong className="text-success" />,
              b: <strong />,
            }}
          />
        ) : (
          <Trans
            i18nKey="productsX.recon.gap"
            values={{
              delta: `${recon.deltaKrn >= 0 ? "+" : "−"}${fmtKron(recon.absDelta)}`,
              pct: recon.gapPct.toFixed(2),
              counted,
              total,
            }}
            components={{
              b1: <strong className="text-alert" />,
              b: <strong />,
            }}
          />
        )}
      </div>
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
  value: number;
  sub?: string;
  tone?: "critical" | "warn" | "strong";
  conceptKey?: string;
} & React.HTMLAttributes<HTMLDivElement>) {
  // Instrument KPI tile: hairline card with a semantic left rail, the count
  // rendered mono via <Amount>, and the bucket label as a Chip top-right.
  // Semantic tokens only — protect = success, watch = caution, wind down =
  // alert (red is reserved for danger), SKUs = brand:
  const TONE_STYLES: Record<string, { rail: string; chip: ChipTone }> = {
    strong:   { rail: "border-l-success", chip: "success" },
    warn:     { rail: "border-l-caution", chip: "caution" },
    critical: { rail: "border-l-alert",   chip: "alert" },
    default:  { rail: "border-l-brand",   chip: "accent" },
  };
  const { rail, chip: chipTone } = TONE_STYLES[tone ?? "default"] ?? TONE_STYLES.default;
  // The learning popover click moved OFF the label pill and ONTO the WHOLE
  // card (2026-07-26 per operator). The badge is now plain text (no hover / no
  // click); clicking anywhere on a card with a conceptKey opens its concept
  // popover, seeded from the card's own rect.
  const { push } = usePopoverStack();
  const clickable = !!conceptKey;
  const openConcept = (rect: DOMRect) => {
    if (!conceptKey) return;
    push({ conceptKey, value: 0, triggerRect: rect });
  };
  // FIT-1 (2026-06-08) — same min-w-0 + overflow-hidden + fluid font
  // pattern as KpiTile so SKU counts / currency strings shrink to fit
  // their grid cell rather than overflowing into the neighbour.
  return (
    <div
      {...rest}
      onClick={clickable ? (e) => openConcept(e.currentTarget.getBoundingClientRect()) : undefined}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                openConcept(e.currentTarget.getBoundingClientRect());
              }
            }
          : undefined
      }
      data-testid={conceptKey ? `products-kpi-${conceptKey}` : undefined}
      className={`rounded-md border border-rule border-l-[3px] ${rail} bg-surface p-4 text-left min-w-0 overflow-hidden transition-colors ${clickable ? "cursor-pointer hover:bg-bg-2/40 hover:border-rule-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40" : ""}`}
    >
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <Amount kind="count" value={value} className="text-[26px] font-medium text-ink leading-none" />
        <InstrumentChip tone={chipTone} className="-mt-0.5 -mr-0.5 shrink-0 uppercase tracking-[0.06em] text-[10px] font-semibold">
          {label}
        </InstrumentChip>
      </div>
      {sub && <p className="text-[12px] text-ink-soft leading-relaxed break-words">{sub}</p>}
    </div>
  );
}

// Open the uploaded file behind a dataset as a preview in a new tab
// (2026-07-26 per operator). Resolves a short-lived signed URL for the stored
// document (looked up by document_id) and hands it to openUploadedFilePreview,
// which parses xlsx/csv into an HTML table since browsers can't preview them
// inline. The tab opens synchronously (pop-up-blocker safe) and fills once the
// bytes arrive.
async function openDatasetFile(d: DatasetSummary): Promise<void> {
  const name = d.source_filename ?? d.label ?? "dataset";
  await openUploadedFilePreview(name, async () => {
    const sb = getSupabase();
    if (!sb || !d.document_id) return null;
    const { data: doc } = await sb
      .from("documents")
      .select("storage_path")
      .eq("id", d.document_id)
      .single();
    const path = (doc as { storage_path?: string } | null)?.storage_path;
    if (!path) return null;
    const { data } = await sb.storage.from("documents").createSignedUrl(path, 300);
    return data?.signedUrl ?? null;
  });
}

/**
 * Which datasets belong to the month currently being viewed.
 *
 * A dataset is in scope when its file was uploaded into this month
 * (`period_id` matches) OR when it carries no month at all. That second arm
 * is deliberate and load-bearing: `period_id` is only populated for uploads
 * made after the pinning shipped, so without it every previously-uploaded
 * file would vanish from the page the moment this landed. Unassigned files
 * therefore show under every month until they're re-uploaded or assigned.
 *
 * With no month loaded yet (`activePeriodId` null) nothing is filtered —
 * there's no month to scope to, so showing everything is the honest answer.
 */
function datasetsForMonth(
  datasets: DatasetSummary[],
  activePeriodId: string | null,
): DatasetSummary[] {
  // Always a NEW array — callers sort the result in place, and returning the
  // caller's own array here would mutate their props.
  if (!activePeriodId) return [...datasets];
  return datasets.filter((d) => !d.period_id || d.period_id === activePeriodId);
}

// ─── Source files + dropzone ────────────────────────────────────────────────
//
// The uploaded dataset files for the active month, newest first, with the
// upload dropzone sitting to their right on the same strip.
//
// 2026-07-26 (per operator) this replaced the pills row that used to sit
// above: an "Upload dataset" button, one "SKU n" pill per dataset, and the
// dev-only "Wipe data" reset. Consequence worth knowing: with the pills gone
// there's no inline dataset switcher, so a month holding MORE than one file
// always renders its newest — switch datasets from the Datasets panel (⌘⇧D).
// The tiles keep their original job (open the file's preview).
function DatasetSourceFiles({
  datasets,
  activeDatasetId,
  activePeriodId,
  activeMonthLabel,
  onUpload,
  trailing,
}: {
  datasets: DatasetSummary[];
  activeDatasetId: string | null;
  activePeriodId: string | null;
  activeMonthLabel: string | null;
  /** Chosen/dropped file → upload + analyze straight away. */
  onUpload: (file: File) => void;
  /** Right-aligned content on the row above the tiles (the Guide me CTA). */
  trailing?: ReactNode;
}) {
  const { t } = useTranslation();
  // Newest-first, matching the dashboard month order, scoped to this month.
  const ordered = datasetsForMonth(datasets, activePeriodId).sort(
    (a, b) => new Date(b.uploaded_at).getTime() - new Date(a.uploaded_at).getTime(),
  );
  return (
    <div className="space-y-3">
      {trailing && (
        <div className="flex items-center justify-end" data-testid="dataset-row-actions">
          {trailing}
        </div>
      )}

      <SourceFilesRow
        testid="dataset-source-files"
        files={ordered.map((d) => ({
          id: d.id,
          filename: d.source_filename ?? d.label,
          uploadedAt: d.uploaded_at,
          isActive: d.id === activeDatasetId,
          onOpen: () => void openDatasetFile(d),
        }))}
        trailingHeading={t("productsX.sourceFiles.replaceOrAdd")}
        trailing={
          <AddFileTile
            accept={PRODUCTS_UPLOAD_ACCEPT}
            onFile={onUpload}
            variant="wide"
            label={t("products.empty.dropHere")}
            hint={t("productsX.sourceFiles.hint", { mb: PRODUCTS_UPLOAD_MAX_MB })}
            title={t("productsX.sourceFiles.addTitle")}
          />
        }
      />
    </div>
  );
}

// ─── Dev-only: delete every uploaded file on Products ───────────────────────
//
// A localhost-only reset so an upload → classify → verify loop can be re-run
// from a clean slate without hand-deleting rows in Supabase Studio.
//
// GATE: none as of 2026-07-26 — the operator asked for this in production too,
// so the former `import.meta.env.DEV` gate (which made the whole component dead
// code in a build) is gone. It is now a real, shipping, irreversible bulk
// delete behind a confirm dialog. If this ever needs restricting, gate it on
// workspace role rather than build mode.
//
// SCOPE: the SKU datasets this page lists, and nothing else. Periods, the
// dashboard analysis, workspaces, chats and the account are untouched — the
// earlier version of this button also wiped periods across every workspace,
// which is a different (and much larger) reset than "clear my Products
// uploads". Each DELETE soft-deletes the dataset's parent document, so files
// stay recoverable from Recently deleted for 30 days.
//
// Every request's outcome is checked. The first cut swallowed failures and
// reported success regardless, so with the engine container stopped it
// cheerfully announced "0 deleted" and reloaded — indistinguishable from a
// button that does nothing.
function DevWipeDataButton() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();
  const { t } = useTranslation();
  const qc = useQueryClient();


  async function wipe() {
    setBusy(true);
    try {
      const h = await authHeader();
      if (!h) {
        toast({ title: t("productsX.wipe.notSignedIn"), variant: "destructive" });
        setBusy(false);
        return;
      }

      // Re-reads the list the page itself renders. A non-ok response is the
      // common failure — the engine container isn't running — and has to be
      // reported as a failure, not silently read as "nothing to delete".
      const listDatasets = async (): Promise<DatasetSummary[]> => {
        let res: Response;
        try {
          res = await fetch(`${apiBase()}/api/sales-datasets`, { headers: h, cache: "no-store" });
        } catch {
          throw new Error(t("productsX.wipe.engineUnreachable", { url: apiBase() }));
        }
        if (!res.ok) {
          throw new Error(t("productsX.wipe.listFailed", { status: `${res.status} ${res.statusText}` }));
        }
        return ((await res.json()) as DatasetsListPayload).datasets ?? [];
      };

      // Force the React Query world to match the fresh server list. This must
      // run on EVERY exit path — including "the server is already empty".
      // The page paints from the ["sales-datasets"] cache, which is
      // deliberately sticky (30-min staleTime, refetchOnMount:false, persisted
      // to localStorage by queryPersist) — so after a delete, an invalidate
      // alone isn't what makes the screen change; the setQueryData is. The
      // first version of this handler early-returned on an empty server list
      // WITHOUT reconciling, which is exactly the "server empty, screen still
      // shows a file, nothing ever corrects it" the operator hit.
      const reconcile = (datasets: DatasetSummary[]) => {
        qc.setQueryData<DatasetsListPayload>(["sales-datasets"], {
          active_dataset_id: datasets[0]?.id ?? null,
          datasets,
        });
        qc.removeQueries({ queryKey: ["sales-dataset"] });
        qc.removeQueries({ queryKey: ["sales-dataset-compare"] });
        void qc.invalidateQueries({ queryKey: ["sales-datasets-deleted"] });
        void qc.invalidateQueries({ queryKey: ["sku-analysis", "inflight"] });
        // ?dataset= may point at a deleted id; left in place the page
        // re-requests it and lands on an empty payload instead of the empty
        // state.
        const url = new URL(window.location.href);
        if (url.searchParams.has("dataset")) {
          url.searchParams.delete("dataset");
          window.history.replaceState({}, "", url.toString());
        }
      };

      const before = await listDatasets();
      if (before.length === 0) {
        reconcile([]);
        toast({
          title: t("productsX.wipe.alreadyClean"),
          description: t("productsX.wipe.alreadyCleanDesc"),
        });
        setOpen(false);
        setBusy(false);
        return;
      }

      // Pass 1 — the engine's soft-delete endpoint.
      for (const d of before) {
        try {
          const r = await fetch(`${apiBase()}/api/sales-datasets/${d.id}`, {
            method: "DELETE",
            headers: h,
          });
          if (!r.ok) console.warn("[wipe] engine DELETE failed", d.id, r.status, await r.text());
        } catch (err) {
          console.warn("[wipe] engine DELETE threw", d.id, err);
        }
      }

      // Pass 2 — verify, and finish the job directly for anything still listed.
      //
      // This exists because pass 1 can report 200 and change nothing: the
      // endpoint stamps `documents.deleted_at` through PostgREST, and an UPDATE
      // that matches zero rows is a success response, not an error. Writing the
      // same column straight from the browser goes through the user's own RLS
      // (`documents member update`), so it either works or surfaces a real
      // error we can show — no third silent path.
      let remaining = await listDatasets();
      if (remaining.length > 0) {
        const sb = getSupabase();
        if (sb) {
          const docIds = remaining.map((d) => d.document_id).filter((id): id is string => !!id);
          if (docIds.length > 0) {
            const { error } = await sb
              .from("documents")
              .update({ deleted_at: new Date().toISOString() })
              .in("id", docIds);
            if (error) throw new Error(t("productsX.wipe.directDeleteFailed", { msg: error.message }));
          }
          // A dataset with no document_id can't be soft-deleted this way —
          // there's nothing to stamp. Say so rather than looping.
          const orphans = remaining.length - docIds.length;
          if (orphans > 0) {
            console.warn(`[wipe] ${orphans} dataset(s) have no document_id — cannot soft-delete`);
          }
        }
        remaining = await listDatasets();
      }

      // Repaint from the verified server list — setQueryData, not invalidate,
      // is what changes the screen (see `reconcile` above).
      reconcile(remaining);

      // Report what the SERVER says is left, not what we attempted — the whole
      // point of the verify pass.
      const gone = before.length - remaining.length;
      if (remaining.length > 0) {
        toast({
          title: t("productsX.wipe.couldNotDelete", { count: remaining.length }),
          description: remaining
            .map((d) => d.source_filename ?? d.label)
            .slice(0, 3)
            .join(" · "),
          variant: "destructive",
        });
      } else {
        toast({
          title: t("productsX.wipe.deleted", { count: gone }),
          description: t("productsX.wipe.deletedDesc"),
        });
      }
      setOpen(false);
      setBusy(false);
    } catch (err) {
      toast({
        title: t("productsX.wipe.errorTitle"),
        description: err instanceof Error ? err.message : t("productsX.toast.unknownError"),
        variant: "destructive",
      });
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="dev-wipe-data"
        title={t("productsX.wipe.buttonTitle")}
        className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-full border border-dashed border-alert/40 bg-alert/[0.06] text-[11px] font-mono uppercase tracking-[0.08em] text-alert hover:bg-alert/15 transition-colors"
      >
        <Trash2 size={12} strokeWidth={2} />
        {t("productsX.wipe.button")}
      </button>

      <Dialog open={open} onOpenChange={(o) => { if (!busy) setOpen(o); }}>
        <DialogContent className="sm:max-w-[440px]" data-testid="dev-wipe-dialog">
          <DialogHeader>
            <DialogTitle>{t("productsX.wipe.dialogTitle")}</DialogTitle>
            <DialogDescription>
              {t("productsX.wipe.dialogBody1")}
              <br />
              <br />
              {t("productsX.wipe.dialogBody2")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={busy}
              className="inline-flex items-center h-9 px-3.5 rounded-lg border border-rule text-[13px] font-medium text-ink hover:bg-bg-2/60 disabled:opacity-50 transition-colors"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              onClick={() => void wipe()}
              disabled={busy}
              data-testid="dev-wipe-confirm"
              className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg border border-alert/30 bg-alert/10 text-[13px] font-medium text-alert hover:bg-alert/20 disabled:opacity-50 transition-colors"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} strokeWidth={1.75} />}
              {busy ? t("productsX.wipe.deleting") : t("productsX.wipe.deleteAll")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
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
  const { t } = useTranslation();
  // "i" info modal explaining the four working-capital metrics.
  const [infoOpen, setInfoOpen] = useState(false);

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
      companyDioFormulaNote = t("productsX.wc.dioFormulaCogs");
    } else {
      const sumInv = covered.reduce((a, s) => a + (s.inventory_value_krn ?? 0), 0);
      const wsum = covered.reduce(
        (a, s) => a + (s.inventory_value_krn ?? 0) * (s.days_inventory_on_hand ?? 0),
        0,
      );
      companyDio = sumInv > 0 ? wsum / sumInv : null;
      companyDioFormulaNote = t("productsX.wc.dioFormulaWeighted");
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
      periodContextNote = `${period.label ?? period.id ?? t("productsX.wc.loadedPeriod")}`;
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
      className="!mt-3"
    >
      {/* Title on the left, description to its right, an "i" info button pinned
          far right (2026-07-26 per operator). The old "Working-capital roll-up"
          eyebrow was dropped — the title now leads; top gap tightened via the
          section's -mt-3. */}
      <div className="flex items-baseline gap-3 mb-1.5 min-w-0">
        <h4 className="text-[10.5px] uppercase tracking-[0.14em] text-ink-soft font-semibold shrink-0">
          {t("productsX.wc.heading")}
        </h4>
        <p className="text-[12px] text-ink-soft min-w-0 truncate">
          {t("productsX.wc.desc")}
        </p>
        <button
          type="button"
          onClick={() => setInfoOpen(true)}
          data-testid="wc-info-btn"
          aria-label={t("productsX.wc.infoAria")}
          title={t("productsX.wc.infoTitle")}
          className="ml-auto shrink-0 self-center grid place-items-center h-6 w-6 rounded-full border border-rule text-ink-soft hover:text-ink hover:border-rule-strong hover:bg-bg-2/60 transition-colors"
        >
          <Info size={13} strokeWidth={2} />
        </button>
      </div>

      <WcInfoModal open={infoOpen} onOpenChange={setInfoOpen} />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <WcCard
          label={t("productsX.wc.companyDio")}
          value={companyDio}
          unit={t("common.unit.days")}
          source={
            covered.length > 0
              ? t("productsX.wc.dioCoverage", {
                  pct: (coverageNivPct * 100).toFixed(0),
                  covered: covered.length,
                  total: skus.length,
                })
              : t("productsX.wc.dioNoInputs")
          }
          formula={companyDioFormulaNote}
          missingHint={t("productsX.wc.dioMissingHint")}
          tone="brand"
          testid="wc-dio"
        />
        <WcCard
          label="DSO"
          value={dso}
          unit={t("common.unit.days")}
          source={dso != null ? `${t("productsX.wc.fromTrialBalance")}${periodContextNote ? ` · ${periodContextNote}` : ""}` : t("productsX.wc.noTrialBalance")}
          missingHint={t("productsX.wc.dsoMissingHint")}
          tone="info"
          testid="wc-dso"
        />
        <WcCard
          label="DPO"
          value={dpo}
          unit={t("common.unit.days")}
          source={dpo != null ? `${t("productsX.wc.fromTrialBalance")}${periodContextNote ? ` · ${periodContextNote}` : ""}` : t("productsX.wc.noTrialBalance")}
          missingHint={t("productsX.wc.dpoMissingHint")}
          tone="neutral"
          testid="wc-dpo"
        />
        <WcCard
          label="CCC"
          value={ccc}
          unit={t("common.unit.days")}
          source={
            ccc != null
              ? t("productsX.wc.cccSource")
              : t("productsX.wc.cccMissing", { list: missingForCcc.join(", ") })
          }
          missingHint={
            ccc == null
              ? t("productsX.wc.cccHint")
              : undefined
          }
          tone="caution"
          testid="wc-ccc"
        />
      </div>

    </section>
  );
}

// WcInfoModal — explains what each working-capital pill (DIO / DSO / DPO /
// CCC) means, opened by the "i" button beside the section header.
function WcInfoModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  // Same semantic tones as the WcCard badges — one chip system app-wide.
  const items: { label: string; tone: ChipTone; title: string; body: string }[] = [
    { label: "DIO", tone: "accent",  title: t("productsX.wc.dioTitle"), body: t("productsX.wc.dioBody") },
    { label: "DSO", tone: "info",    title: t("productsX.wc.dsoTitle"), body: t("productsX.wc.dsoBody") },
    { label: "DPO", tone: "neutral", title: t("productsX.wc.dpoTitle"), body: t("productsX.wc.dpoBody") },
    { label: "CCC", tone: "caution", title: t("productsX.wc.cccTitle"), body: t("productsX.wc.cccBody") },
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{t("productsX.wc.modalTitle")}</DialogTitle>
          <DialogDescription>
            {t("productsX.wc.modalDesc")}
          </DialogDescription>
        </DialogHeader>
        <div className="mt-2 space-y-3">
          {items.map((it) => (
            <div key={it.label} className="flex gap-3">
              <InstrumentChip tone={it.tone} className="shrink-0 h-fit whitespace-nowrap uppercase tracking-[0.06em] text-[10px] font-semibold">
                {it.label}
              </InstrumentChip>
              <div className="min-w-0">
                <div className="text-[13px] font-semibold text-ink leading-tight">{it.title}</div>
                <p className="text-[12.5px] text-ink-soft leading-relaxed mt-0.5">{it.body}</p>
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function WcCard({
  label, value, unit, source, formula, missingHint, tone = "brand", testid,
}: {
  label: string;
  value: number | null;
  unit: string;
  source: string;
  formula?: string;
  missingHint?: string;
  tone?: "brand" | "info" | "neutral" | "caution";
  testid?: string;
}) {
  const { t } = useTranslation();
  const available = value != null && Number.isFinite(value);
  // Instrument working-capital tile: semantic left rail, the day-count mono
  // via <Amount>, the metric label as a Chip top-right, source/formula as
  // the dense body. Semantic tokens only — DIO = brand (the page's own
  // metric), DSO = info, DPO = neutral, CCC = caution (the tension metric).
  const WC_TONES: Record<string, { rail: string; chip: ChipTone }> = {
    brand:   { rail: "border-l-brand",       chip: "accent" },
    info:    { rail: "border-l-info",        chip: "info" },
    neutral: { rail: "border-l-rule-strong", chip: "neutral" },
    caution: { rail: "border-l-caution",     chip: "caution" },
  };
  const { rail, chip: chipTone } = WC_TONES[tone] ?? WC_TONES.brand;
  return (
    <div
      data-testid={testid}
      data-available={available ? "true" : "false"}
      className={`rounded-md border border-rule border-l-[3px] ${rail} bg-surface p-4 text-left min-w-0 overflow-hidden transition-colors hover:bg-bg-2/40 hover:border-rule-strong`}
    >
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="flex items-baseline gap-1.5 min-w-0">
          {available ? (
            <>
              <Amount kind="count" value={Math.round(value)} className="text-[26px] font-medium text-ink leading-none" />
              <span className="text-[12.5px] text-ink-soft shrink-0">{unit}</span>
            </>
          ) : (
            <span className="text-[15px] text-ink-soft italic">{t("common.notAvailable")}</span>
          )}
        </div>
        <InstrumentChip tone={chipTone} className="-mt-0.5 -mr-0.5 shrink-0 whitespace-nowrap uppercase tracking-[0.06em] text-[10px] font-semibold">
          {label}
        </InstrumentChip>
      </div>
      <p className="text-[12.5px] text-ink-soft leading-relaxed break-words">{source}</p>
      {formula && available && (
        <p className="mt-0.5 text-[11px] text-ink-soft leading-snug break-words">{formula}</p>
      )}
      {!available && missingHint && (
        <p className="mt-0.5 text-[11px] text-ink-soft leading-snug break-words">{missingHint}</p>
      )}
    </div>
  );
}

function FilterChip({
  testid, label, count, active, onClick, dotClass, empty,
}: { testid: string; label: string; count: number; active: boolean; onClick: () => void; dotClass?: string; empty?: boolean }) {
  // Styled like the Public Companies Explore pills (2026-07-26 per operator):
  // rounded-full, h-9, brand-tinted when selected, count in a muted trailing
  // span. `empty` chips (count = 0) render dimmed so they're visually distinct
  // from populated buckets — but still clickable, so the user can see the full
  // classification surface and confirm the bucket really is empty.
  const baseTone = active
    ? "border-brand/60 bg-brand/15 text-ink hover:bg-brand/25"
    : empty
      ? "border-rule/60 bg-surface text-ink-soft/70 hover:text-ink-soft hover:border-rule"
      : "border-rule bg-surface text-ink hover:bg-bg-2 hover:border-rule-strong";
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testid}
      aria-pressed={active}
      className={`group inline-flex items-center gap-1.5 h-9 px-3 rounded-full border text-[13px] font-medium transition-colors ${baseTone}`}
    >
      {dotClass && (
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full ${dotClass} ${empty && !active ? "opacity-40" : ""}`}
        />
      )}
      {label}
      <span className="text-[11px] text-ink-soft tabular-nums shrink-0">{count}</span>
    </button>
  );
}

// Channel code → full display name (2026-07-26 per operator) — the filter
// list shows the readable name instead of the raw KA/DIST/EXP/OLN token.
const CHANNEL_NAMES: Record<string, string> = {
  KA: "Key accounts",
  DIST: "Distribution",
  EXP: "Export",
  OLN: "Online",
};

// FilterDropdown — custom pill dropdown replacing the native <select> filters
// (2026-07-26 per operator). Native selects can't fade-in or style their menu;
// this Radix-Popover version gives: a pill trigger matching the filter chips,
// a chevron with extra right gap, a faded (parenthesis-free) count on the
// "all" placeholder, and a fade-in menu styled like the trigger.
// Moved to components/ui/FilterDropdown.tsx (2026-07-26) so the decision-rules
// controls can use the same pill dropdown instead of a native <select>.

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
  const { t } = useTranslation();
  const nivDelta = totals.niv_a - totals.niv_b;
  const gmDelta = totals.gm_a - totals.gm_b;
  const fmtKron = useKronFormatter(currency);

  return (
    <section
      data-testid="comparison-section"
      className="rounded-lg border border-brand/25 bg-brand-tint/30 p-5 space-y-4"
    >
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="text-[10.5px] uppercase tracking-[0.1em] text-brand-d dark:text-brand-l font-medium">{t("products.comparison")}</div>
          <h3 className="mt-1 text-[16px] font-semibold tracking-tight text-ink leading-tight">
            <span>{active.label}</span>
            <span className="text-ink-soft font-normal mx-2">{t("productsX.compare.vs")}</span>
            <span>{compared.label}</span>
          </h3>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onSwitchActive}
            className="h-8 px-3 rounded-md border border-rule bg-surface text-[12px] font-medium text-ink hover:bg-bg-2 transition-colors"
          >
            {t("productsX.compare.switchActive", { label: compared.label })}
          </button>
          <button
            type="button"
            onClick={onClose}
            data-testid="comparison-close"
            aria-label={t("productsX.compare.closeAria")}
            className="h-8 w-8 inline-flex items-center justify-center rounded-md text-ink-soft hover:text-ink hover:bg-bg-2"
          >
            ✕
          </button>
        </div>
      </header>

      {/* One magnitude for both deltas so "−1,2 M RON" beside "+0,3 M RON"
          reads as one instrument. Counts render mono via <Amount>. */}
      <MoneyAmountGroup values={[nivDelta * 1000, gmDelta * 1000]} fromCurrency={currency}>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat
            label={t("productsX.compare.skusIn", { label: active.label })}
            value={<Amount kind="count" value={totals.sku_count_a} />}
          />
          <Stat
            label={t("productsX.compare.skusIn", { label: compared.label })}
            value={<Amount kind="count" value={totals.sku_count_b} />}
          />
          <Stat
            label={t("productsX.compare.nivDelta")}
            value={<MoneyAmount value={nivDelta * 1000} fromCurrency={currency} signed />}
            tone={nivDelta < 0 ? "alert" : undefined}
          />
          <Stat
            label={t("productsX.compare.gmDelta")}
            value={<MoneyAmount value={gmDelta * 1000} fromCurrency={currency} signed />}
            tone={gmDelta < 0 ? "alert" : undefined}
          />
        </div>
      </MoneyAmountGroup>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <MoversList title={t("productsX.compare.topWinners")} rows={winners} dir="up" currency={currency} />
        <MoversList title={t("productsX.compare.topLosers")} rows={losers} dir="down" currency={currency} />
      </div>

      {new_in_active.length > 0 && (
        <div>
          <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-soft font-medium mb-1.5">
            {t("productsX.compare.newIn", { label: active.label, count: totals.new_in_active })}
          </div>
          <ul className="text-[12px] text-ink-soft space-y-0.5 max-h-32 overflow-y-auto">
            {new_in_active.slice(0, 12).map((r) => (
              <li key={r.product_name} className="truncate">
                + {r.product_name} <span className="text-ink-soft">· GM {fmtKron(r.gm_a)}</span>
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
  const { t } = useTranslation();
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-soft font-medium mb-1.5">{title}</div>
      {/* One shared magnitude for the whole movers column. */}
      <MoneyAmountGroup values={rows.map((r) => r.gm_delta * 1000)} fromCurrency={currency}>
        <ul className="rounded-md border border-rule bg-surface divide-y divide-rule-soft max-h-64 overflow-y-auto">
          {rows.length === 0 && (
            <li className="px-3 py-2 text-[12px] text-ink-soft">{t("productsX.compare.noMovers")}</li>
          )}
          {rows.map((r) => (
            <li key={r.product_name} className="px-3 py-1.5 min-h-8 grid grid-cols-[1fr_auto] gap-2 items-center">
              <div className="min-w-0">
                <div className="text-[12px] text-ink truncate">{r.product_name}</div>
                <div className="text-[10.5px] text-ink-soft truncate">{r.brand} · {r.category}</div>
              </div>
              <div className={`text-right text-[12px] font-medium ${dir === "up" ? "text-success" : "text-alert"}`}>
                <MoneyAmount value={r.gm_delta * 1000} fromCurrency={currency} signed />
              </div>
            </li>
          ))}
        </ul>
      </MoneyAmountGroup>
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
  // The table used to virtualize inside a fixed-height (h-[560px]) inner
  // scroll container. Per operator (2026-07-26) that inner scrollbar is gone —
  // the table now flows in the page and uses the full page scroll. We keep
  // virtualization for perf (hundreds of rows) but drive it off the WINDOW
  // via useWindowVirtualizer, offsetting by the table's distance from the top
  // of the document (scrollMargin) so row positions stay correct.
  const [scrollMargin, setScrollMargin] = useState(0);
  useEffect(() => {
    const measure = () => {
      const el = parentRef.current;
      if (!el) return;
      setScrollMargin(el.getBoundingClientRect().top + window.scrollY);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [rows.length]);
  // estimateSize: desktop row ≈ 52px; mobile card ≈ 132px. measureElement
  // below corrects the estimate row-by-row so positions stay accurate at
  // every viewport without a media-query re-mount.
  const rowVirtualizer = useWindowVirtualizer({
    count: rows.length,
    estimateSize: () => 44,
    overscan: 10,
    scrollMargin,
    measureElement: (el) => el.getBoundingClientRect().height,
  });

  // One shared magnitude across the NIV + GM money columns (instrument
  // table rule: mixed scales in one table are impossible by construction).
  const moneyGroupValues = useMemo(
    () => rows.flatMap((r) => [(r.niv_krn ?? 0) * 1000, (r.gm_krn ?? 0) * 1000]),
    [rows],
  );
  // Totals over the FILTERED rows — derived client-side from the same
  // payload the rows render from, never fabricated.
  const tableTotals = useMemo(() => {
    let vol = 0;
    let niv = 0;
    let gmSum = 0;
    for (const r of rows) {
      vol += r.volume_tons ?? 0;
      niv += r.niv_krn ?? 0;
      gmSum += r.gm_krn ?? 0;
    }
    return { vol, niv, gm: gmSum, gmPct: niv !== 0 ? (gmSum / niv) * 100 : null };
  }, [rows]);

  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-rule bg-surface px-6 py-10 text-center text-[13px] text-ink-soft">
        {t("products.table.emptyFiltered")}
      </div>
    );
  }

  return (
    <MoneyAmountGroup values={moneyGroupValues} fromCurrency={currency}>
    <div className="rounded-md border border-rule bg-surface overflow-hidden">
      {/* Desktop header — hidden on mobile since cards label their own metrics */}
      <div className="hidden md:grid grid-cols-[1fr_120px_120px_90px_90px_90px_80px_80px_120px] gap-3 px-4 h-8 items-center bg-bg-2/40 border-b border-rule text-[10.5px] uppercase tracking-[0.08em] text-ink-soft font-medium">
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
      <div ref={parentRef} data-testid="sku-table-scroll">
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
                  transform: `translateY(${virt.start - rowVirtualizer.options.scrollMargin}px)`,
                }}
                className="border-b border-rule-soft hover:bg-bg-2/40 active:bg-bg-2/60 transition-colors cursor-pointer focus:outline-none focus:bg-bg-2/60 focus:ring-1 focus:ring-inset focus:ring-ink/20"
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
                      <div className="text-[11px] text-ink-soft mt-0.5 truncate">
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
                      <span>{t(bucket3 === "wind_down" ? "products.buckets.windDown" : `products.buckets.${bucket3}`)}</span>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-[11.5px]">
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.06em] text-ink-soft">{t("totals.volume")}</div>
                      <div className="text-ink">
                        {s.volume_tons !== null
                          ? <><Amount kind="count" value={s.volume_tons} fractionDigits={1} />t</>
                          : "—"}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.06em] text-ink-soft">{t("totals.niv")}</div>
                      <div className="text-ink">
                        {s.niv_krn !== null
                          ? <MoneyAmount value={s.niv_krn * 1000} fromCurrency={currency} />
                          : "—"}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.06em] text-ink-soft">{t("products.columns.gmPct")}</div>
                      <div className={(s.gm_pct ?? 0) < 0 ? "text-alert" : "text-ink"}>
                        <PercentLevel value={s.gm_pct !== null ? s.gm_pct * 100 : null} />
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.06em] text-ink-soft">{t("totals.gm")}</div>
                      <div className={`font-medium ${gm < 0 ? "text-alert" : "text-ink"}`}>
                        <MoneyAmount value={gm * 1000} fromCurrency={currency} signed />
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.06em] text-ink-soft">DIO</div>
                      <div
                        className="tabular-nums"
                        title={
                          s.days_inventory_on_hand == null
                            ? t("products.table.dioMissingTooltip")
                            : undefined
                        }
                        data-testid="sku-dio-cell"
                        data-dio-available={s.days_inventory_on_hand != null ? "true" : "false"}
                      >
                        {s.days_inventory_on_hand != null
                          ? <span className="text-ink"><Amount kind="count" value={Math.round(s.days_inventory_on_hand)} />d</span>
                          : <span className="text-ink-soft/70">—</span>}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.06em] text-ink-soft">{t("productsX.cols.linesCh")}</div>
                      <div className="text-ink-soft font-mono tabular-nums text-[11px]">
                        {(s.line_row_count ?? "—")} / {s.channels_present?.length || 0}
                      </div>
                    </div>
                  </div>
                </div>

                {/* DESKTOP ROW — 9-column grid at md and up. Instrument
                    table row: 32px, single line, right-aligned mono figures
                    on hairline rules. Brand · category rides inline after
                    the name (muted) instead of a second line. */}
                <div className="hidden md:grid grid-cols-[1fr_120px_120px_90px_90px_90px_80px_80px_120px] gap-3 px-4 h-8 text-[12.5px] items-center">
                  <div className="min-w-0 flex items-baseline gap-2">
                    {/* Product name + category — source data, wrapped for AT phoneme correctness */}
                    <span className="text-ink truncate min-w-0" title={s.product_name}>
                      <SourceText lang="ro">{s.product_name}</SourceText>
                    </span>
                    {(s.brand || s.category) && (
                      <span className="text-[10.5px] text-ink-soft truncate min-w-0">
                        {s.brand && <SourceText lang="ro">{s.brand}</SourceText>}
                        {s.brand && s.category && <span> · </span>}
                        {s.category && (
                          <>
                            <SourceText lang="ro">{s.category}</SourceText>
                            <CategoryHintInline category={s.category} />
                          </>
                        )}
                      </span>
                    )}
                  </div>
                  <div className="text-right text-ink-soft">
                    <Amount kind="count" value={s.volume_tons} fractionDigits={1} />
                  </div>
                  <div className="text-right text-ink-soft">
                    <MoneyAmount value={s.niv_krn !== null ? s.niv_krn * 1000 : null} fromCurrency={currency} />
                  </div>
                  <div className={`text-right ${(s.gm_pct ?? 0) < 0 ? "text-alert" : "text-ink"}`}>
                    <PercentLevel value={s.gm_pct !== null ? s.gm_pct * 100 : null} />
                  </div>
                  <div className={`text-right font-medium ${gm < 0 ? "text-alert" : "text-ink"}`}>
                    <MoneyAmount value={gm * 1000} fromCurrency={currency} signed />
                  </div>
                  <div
                    className="text-right"
                    title={
                      s.days_inventory_on_hand == null
                        ? t("products.table.dioMissingTooltip")
                        : undefined
                    }
                    data-testid="sku-dio-cell"
                    data-dio-available={s.days_inventory_on_hand != null ? "true" : "false"}
                  >
                    {s.days_inventory_on_hand != null
                      ? <span className="text-ink"><Amount kind="count" value={Math.round(s.days_inventory_on_hand)} /></span>
                      : <span className="text-ink-soft/70 font-mono">—</span>}
                  </div>
                  <div className="text-center text-[11.5px] text-ink-soft font-mono tabular-nums">{s.line_row_count ?? "—"}</div>
                  <div className="text-center text-[11.5px] text-ink-soft font-mono tabular-nums">
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
      {/* Totals over the filtered rows — double hairline above, per the
          instrument table spec. Derived from the rendered rows, so it
          re-sums live as filters/search narrow the table. */}
      <div
        data-testid="sku-table-totals"
        className="hidden md:grid grid-cols-[1fr_120px_120px_90px_90px_90px_80px_80px_120px] gap-3 px-4 h-9 items-center border-t-[3px] border-t-rule [border-top-style:double] bg-bg-2/30 text-[12.5px]"
      >
        <div className="text-[10.5px] uppercase tracking-[0.08em] text-ink-soft font-medium">
          {t("totals.title")} · <Amount kind="count" value={rows.length} />
        </div>
        <div className="text-right text-ink font-medium">
          <Amount kind="count" value={tableTotals.vol} fractionDigits={1} />
        </div>
        <div className="text-right text-ink font-medium">
          <MoneyAmount value={tableTotals.niv * 1000} fromCurrency={currency} />
        </div>
        <div className={`text-right font-medium ${(tableTotals.gmPct ?? 0) < 0 ? "text-alert" : "text-ink"}`}>
          <PercentLevel value={tableTotals.gmPct} />
        </div>
        <div className={`text-right font-medium ${tableTotals.gm < 0 ? "text-alert" : "text-ink"}`}>
          <MoneyAmount value={tableTotals.gm * 1000} fromCurrency={currency} signed />
        </div>
        <div />
        <div />
        <div />
        <div />
      </div>
    </div>
    </MoneyAmountGroup>
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
      <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-soft font-medium mb-2">{t("totals.title")}</div>
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
      <div className="text-[10.5px] uppercase tracking-[0.08em] text-ink-soft">{label}</div>
      <div className={`mt-0.5 font-mono tabular-nums text-[16px] font-medium ${tone === "alert" ? "text-alert" : "text-ink"}`}>{value}</div>
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
  const { t } = useTranslation();
  const STAGES: Record<DocumentStatus, { label: string; ordinal: number }> = {
    queued:     { label: t("productsX.inflight.stage.queued"),     ordinal: 0 },
    extracting: { label: t("productsX.inflight.stage.extracting"), ordinal: 1 },
    mapping:    { label: t("productsX.inflight.stage.mapping"),    ordinal: 2 },
    computing:  { label: t("productsX.inflight.stage.computing"),  ordinal: 3 },
    narrating:  { label: t("productsX.inflight.stage.narrating"),  ordinal: 4 },
    analyzed:   { label: t("productsX.toast.analysisReady"),       ordinal: 6 },
    failed:     { label: t("productsX.toast.analysisFailed"),      ordinal: 0 },
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
      toast({ title: t("productsX.toast.retrying"), description: inflight.filename });
      setHangSuspected(false);
      void qc.invalidateQueries({ queryKey: ["sku-analysis", "inflight"] });
    } else {
      toast({
        title: t("productsX.toast.retryFailed"),
        description: t("productsX.toast.retryFailedDesc"),
        variant: "destructive",
      });
    }
  };

  // Staged steps — labels users can recognise. Mapped to the engine's
  // own `DocumentStatus` so the active step always matches reality.
  // Each step shows pending / running / done so a 6-step pipeline reads
  // as a real workflow instead of a generic spinner.
  const STEPS: Array<{ ordinal: number; label: string; sub: string }> = [
    { ordinal: 1, label: t("productsX.inflight.step1"), sub: t("productsX.inflight.step1Sub") },
    { ordinal: 2, label: t("productsX.inflight.step2"), sub: t("productsX.inflight.step2Sub") },
    { ordinal: 3, label: t("productsX.inflight.step3"), sub: t("productsX.inflight.step3Sub") },
    { ordinal: 4, label: t("productsX.inflight.step4"), sub: t("productsX.inflight.step4Sub") },
    { ordinal: 5, label: t("productsX.inflight.step5"), sub: t("productsX.inflight.step5Sub") },
    { ordinal: 6, label: t("productsX.inflight.step6"), sub: t("productsX.inflight.step6Sub") },
  ];

  return (
    <section className="max-w-[760px] mx-auto py-12 sm:py-16">
      <div
        data-testid="products-inflight"
        className="
          relative overflow-hidden rounded-lg
          border border-rule
          bg-gradient-to-br from-bg-2/40 via-surface to-surface
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
                ? t("productsX.inflight.failedTitle")
                : hangSuspected
                ? t("productsX.inflight.stuckTitle")
                : t("productsX.inflight.analyzing")}
            </span>
          </div>
          {!failed && !hangSuspected && (
            <span className="text-[11px] text-ink-soft tabular-nums uppercase tracking-[0.08em]">
              {t("productsX.inflight.stepOf", { current: Math.max(1, stage.ordinal), total: STEPS.length })}
            </span>
          )}
        </div>

        <div className="relative text-[12.5px] text-ink-soft mb-5 truncate">
          <span className="text-ink font-medium">{inflight.filename}</span>
          <span className="mx-1.5 text-ink-soft">·</span>
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
                      : "bg-bg-2 text-ink-soft"}
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
                    <span className="block text-[11.5px] text-ink-soft mt-0.5">{step.sub}</span>
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
                {t("productsX.inflight.dismiss")}
              </button>
              <button
                type="button"
                onClick={handleRetry}
                disabled={retrying}
                data-testid="products-inflight-retry-failed"
                className="inline-flex items-center gap-1.5 rounded-md border border-alert/40 bg-surface px-3 py-1.5 text-[12px] font-medium text-alert hover:bg-alert/10 transition-colors disabled:opacity-50"
              >
                {retrying ? <Loader2 size={12} className="animate-spin" /> : null}
                {retrying ? t("productsX.inflight.retrying") : t("productsX.inflight.retry")}
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
              {t("productsX.inflight.hangBody")}
            </p>
            <button
              type="button"
              onClick={handleRetry}
              disabled={retrying}
              data-testid="products-inflight-retry"
              className="inline-flex items-center gap-1.5 rounded-md border border-alert/40 bg-surface px-3 py-1.5 text-[12px] font-medium text-alert hover:bg-alert/10 transition-colors disabled:opacity-50"
            >
              {retrying ? <Loader2 size={12} className="animate-spin" /> : null}
              {retrying ? t("productsX.inflight.retrying") : t("productsX.inflight.retry")}
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
  monthLabel,
  uploadPeriodId,
}: {
  /** Period the upload nests under — resolved by the page (URL period, else
   *  the workspace's newest), NOT read from the URL here: Products can be
   *  opened without `?period=`, and a file with no period shows up under no
   *  month at all. */
  uploadPeriodId: string | null;
  /** Active month, when one is loaded. Present so the copy can say which
   *  month is empty — with files nested under months, "no data yet" would be
   *  wrong for a user who has uploads sitting on other months. */
  monthLabel?: string | null;
  onUploaded: () => void;
  /** Real prior imports — drives the stats strip and recent-imports
   *  panel. Pass an empty array on a brand-new account; the strip and
   *  the panel render their honest empty states. NEVER fabricated. */
  datasets: DatasetSummary[];
}) {
  const { toast } = useToast();
  const { t } = useTranslation();
  // Pricing V3 — wraps enqueuePipeline so the 402 extra-doc dialog +
  // 429 quota-blocked toast fire automatically.
  const uploadEnqueue = useUploadEnqueue();
  // The month an upload nests under arrives as `uploadPeriodId` from the page
  // (see its comment) — this component no longer reads the URL for it.
  const fileRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  // Staged-files flow (2026-07-25) — mirrors the dashboard dropzone:
  // choosing/dropping stages files locally; nothing uploads until the
  // user presses Start scan. Seeded from + mirrored to the module-level
  // store so a tab switch (which unmounts this page) doesn't drop the
  // selection.
  const [stagedFiles, setStagedFiles] = useState<File[]>(() => readStagedFiles("products"));
  // Leaving Products abandons the pick — come back to an empty dropzone.
  useEffect(() => () => clearStagedFiles("products"), []);
  const [scanning, setScanning] = useState(false);
  useEffect(() => {
    writeStagedFiles("products", stagedFiles);
  }, [stagedFiles]);
  // Global upload store — the scan view below and the debug simulator
  // both read/drive it. Only react to PRODUCTS-surface uploads so a dashboard
  // (trial-balance) scan doesn't flip the Products page into its scan view.
  const _upload = useUploadStore().current;
  const inflightDoc = _upload && _upload.surface === "products" ? _upload : null;

  function stageFile(file: File) {
    if (file.size > PRODUCTS_UPLOAD_MAX_BYTES) {
      toast({
        title: t("productsX.toast.fileTooLarge"),
        description: t("productsX.toast.fileTooLargeDesc", {
          size: (file.size / 1_000_000).toFixed(1),
          limit: PRODUCTS_UPLOAD_MAX_MB,
        }),
        variant: "destructive",
      });
      return;
    }
    // ONE file at a time (2026-07-26 per operator) — a new pick REPLACES the
    // staged file rather than appending. Array shape kept so the staged list
    // and startScan keep iterating as before.
    setStagedFiles([file]);
  }

  // Upload + analyze ONE file; resolves when the pipeline settles
  // (analyzed / failed / blocked) so startScan can run a batch
  // sequentially — same contract as the dashboard's scanOneFile.
  function scanOneFile(file: File): Promise<void> {
    return new Promise<void>((resolve) => {
      void (async () => {
        // Flip into the scan view immediately (docId lands after upload).
        startUpload({ docId: "", filename: file.name, status: "queued", surface: "products" });
        // Pin to the active month so the file nests under it in "Source files".
        const { row, error } = await uploadDocument(file, { scope: "sku", periodId: uploadPeriodId });
        if (!row) {
          clearUpload();
          toast({ title: t("productsX.toast.uploadFailed"), description: error ?? t("productsX.toast.unknownError"), variant: "destructive" });
          resolve();
          return;
        }
        // Drive the global upload store tagged as a PRODUCTS upload so the
        // Products rail spinner (not the Dashboard's) + the shared council
        // sphere render this scan's progress.
        startUpload({ docId: row.id, filename: file.name, status: "queued", surface: "products" });
        const enq = await uploadEnqueue.enqueue(row.id);
        if (enq.kind !== "queued") {
          // Modal/toast already surfaced by the hook; nothing to do here.
          clearUpload();
          resolve();
          return;
        }
        onUploaded();
        const unsub = subscribeToDocumentStatus(row.id, (next) => {
          patchUpload({ status: next.status, error: next.error });
          if (next.status === "analyzed") {
            unsub();
            toast({ title: t("productsX.toast.analysisReady"), description: file.name });
            // NOT clearUpload() — the page-level handoff keeps `analyzed`
            // on screen long enough for the sphere to converge and fade,
            // then swaps in the populated page. Clearing here would snap
            // the scan view away mid-animation.
            onUploaded();
            resolve();
          }
          if (next.status === "failed") {
            unsub();
            toast({ title: t("productsX.toast.analysisFailed"), description: next.error ?? t("productsX.toast.unknownError"), variant: "destructive" });
            clearUpload();
            resolve();
          }
        });
      })();
    });
  }

  async function startScan() {
    if (scanning || stagedFiles.length === 0) return;
    setScanning(true);
    const batch = [...stagedFiles];
    for (const f of batch) await scanOneFile(f);
    setStagedFiles([]);
    setScanning(false);
  }

  // Localhost-only: simulate the upload → analysis pipeline without a
  // real file or backend — the same status walk as the dashboard's
  // simulator, so the scan view + council sphere can be eyeballed here.
  async function simulateFileProcess() {
    if (inflightDoc) return; // don't clobber a real in-flight upload
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const waitWhilePaused = async () => {
      while (isScanSpherePaused()) await sleep(200);
    };
    // Mirrors the REAL sku-scope pipeline walk — it never emits 'computing'
    // (see pipeline.py), so the simulator skips it too.
    const steps: DocumentStatus[] = [
      "extracting", "mapping", "narrating", "analyzed",
    ];
    startUpload({
      docId: `debug-${Date.now()}`,
      filename: "debug_simulation.xlsx",
      status: "queued",
      surface: "products",
    });
    await sleep(2500);
    for (const status of steps) {
      await waitWhilePaused();
      patchUpload({ status });
      await sleep(status === "analyzed" ? 2000 : 6000);
    }
    await waitWhilePaused();
    await sleep(1000);
    clearUpload();
  }
  const isLocalhost =
    typeof window !== "undefined" &&
    /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);

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

  // ── SCANNING VIEW — owned by the PAGE now (2026-07-26), not this
  // component. Products renders one scan surface for every entry point
  // (this dropzone, the Datasets-panel button, a mid-scan page reload) so
  // the sphere + steps can't be handed off between two competing views
  // mid-run — which is exactly how the walk used to freeze at "Queued for
  // analysis…". `inflightDoc` is still read above for the debug simulator
  // guard; the page-level branch renders the view.

  return (
    <section data-testid="products-empty" className="overflow-x-clip">
      {/* Pricing V3 — extra-doc confirm dialog mount. */}
      {uploadEnqueue.dialog}

      {/* ── Hero panel — glass-card with soft gradient. Headline + a
       *  premium dropzone live in a 2-column split that stacks under lg.
       *  The wrapper card adds the gradient + ring so the hero reads as
       *  a single integrated surface rather than two loose blocks. */}
      <div className="relative overflow-x-clip">
        {/* Decorative top-right brand glow — purely visual, no real data */}
        <div aria-hidden className="pointer-events-none absolute -top-24 -right-24 h-64 w-64 rounded-full bg-brand/10 blur-3xl" />

        {/* Column split matches the dashboard hero (1.2fr_1fr + gap-6) so
            the "Start from the official template" card is the same width
            on both surfaces. min-w-0 on the columns: grid items default to
            min-width auto, so the format-hint table's intrinsic width was
            blowing the whole page out sideways on phones (sweep-caught). */}
        {/* grid-cols-1 below lg is load-bearing: without an explicit fr
            track the implicit auto column sizes to content max-content and
            clips the whole hero at phone widths. */}
        <div className="grid grid-cols-1 lg:grid-cols-[1.2fr_1fr] gap-6 items-start relative min-w-0">
          <div className="min-w-0">
            <div className="inline-flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.16em] text-brand-d font-semibold">
              <Sparkles size={10} strokeWidth={2.25} className="text-brand-d" />
              {t("productsX.empty.eyebrow")}
            </div>
            {/* Serif hero retired (Instrument migration) — calm sans display
                at page scale; the gradient phrase carries the emphasis. */}
            <h1 className="mt-3 text-[32px] sm:text-[40px] font-semibold leading-[1.08] tracking-[-0.02em] text-ink">
              <Trans
                i18nKey="productsX.empty.heroTitle"
                components={{ grad: <span className="text-grad" /> }}
              />
            </h1>
            <p className="mt-4 text-[15.5px] text-ink-soft leading-relaxed max-w-[520px]">
              {/* Files are pinned to the month that's active when they're
                  uploaded, so name the month here — with other months
                  possibly populated, an unqualified "upload your data" would
                  read as "you have nothing at all", which may be false. */}
              {monthLabel && datasets.length > 0 && (
                <>
                  <Trans
                    i18nKey="productsX.empty.monthNote"
                    values={{ month: monthLabel }}
                    components={{ m: <span className="text-ink" /> }}
                  />{" "}
                </>
              )}
              <Trans
                i18nKey="productsX.empty.heroBody"
                components={{
                  c1: <span className="text-ink" />,
                  c2: <span className="text-ink" />,
                }}
              />
            </p>

            <div className="mt-5 flex flex-wrap items-center gap-2">
              {/* The Import button that used to lead this row was removed
                  (2026-07-26 per operator) — the dropzone below is the one
                  import path. */}
              <button
                type="button"
                onClick={() => openAskCfoAi(t("productsX.empty.askPrompt"))}
                className="
                  inline-flex items-center gap-2 h-10 px-4 rounded-lg
                  border border-rule bg-surface/70 backdrop-blur
                  text-[13px] font-medium text-ink
                  hover:bg-bg-2/60 hover:border-rule-strong
                  transition-colors
                "
                data-testid="products-ask-cfo-ai"
              >
                <Sparkles size={16} strokeWidth={2} className="text-brand-d" />
                {t("topbar.ask")}
              </button>
            </div>
          </div>

          {/* Start from the official template — swapped into the hero's
              right column (the file dropzone now sits below the grid). */}
          <div className="relative">
            <TemplateDownloadCard variant="prominent" />
          </div>
        </div>

        {/* Expected format — moved ABOVE the dropzone (2026-07-24) so the
            column contract is visible before the user drops a file. */}
        <SalesAnalysisFormatHint />

        {/* Example RESULT — what the page computes from rows like the ones
            above, visible BEFORE the first upload. Built strictly from the
            format hint's own fictional rows (same figures, same labels);
            nothing the analysis would have to invent (bucket signals) is
            shown — those cells stay em-dash until real data lands. */}
        <ExampleResultPreview />

        {/* File drop zone — swapped below the hero grid (the template card
            now occupies the hero's right column). 2026-07-25: replaced
            with the dashboard's dropzone (same chrome, same staged-files
            → Start scan flow, same idle pipeline-steps preview) — only
            the copy and the stage names are Products-specific. */}
        <div className="mt-6 relative">
          <div
            data-testid="products-upload-dropzone"
            onDragEnter={(e) => { e.preventDefault(); setDrag(true); }}
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={(e) => { e.preventDefault(); setDrag(false); }}
            // First file only — a drop can carry several regardless of the
            // input's `multiple` attribute, which only governs the picker.
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              const f = e.dataTransfer.files?.[0];
              if (f) stageFile(f);
            }}
            data-drag-active={drag ? "true" : "false"}
            className={`
              relative overflow-hidden
              rounded-lg border-2 border-dashed
              backdrop-blur-sm
              p-6 sm:p-7
              flex flex-col items-center justify-center text-center
              min-h-[240px]
              transition-all duration-150
              ${drag
                ? "border-brand bg-brand/10 ring-2 ring-inset ring-brand/30"
                : "border-rule/80 bg-gradient-to-br from-bg-2/30 via-surface/60 to-surface/40 hover:border-rule-strong hover:from-bg-2/50"}
            `}
          >
            {/* Atmospheric brand glow */}
            <div aria-hidden className="pointer-events-none absolute -top-20 -right-12 h-56 w-56 rounded-full bg-brand/8 blur-3xl" />

            {/* Oversized upload mark — decorative, pinned to the bottom-left
                corner and clipped by the card's overflow-hidden. Opacity on
                the WRAPPER so overlapping strokes never stack. */}
            <div
              aria-hidden
              className="pointer-events-none absolute -bottom-32 -left-16 text-ink opacity-[0.08]"
            >
              <Cloud size={440} strokeWidth={1} />
              <ArrowUp
                size={160}
                strokeWidth={2.5}
                className="absolute left-1/2 top-[62%] -translate-x-1/2 -translate-y-1/2"
              />
            </div>

            {/* Localhost-only debug button — simulate a scan without a real
                file or backend. Never rendered on the deployed site. */}
            {isLocalhost && (
              <button
                type="button"
                data-testid="debug-simulate-upload"
                onClick={() => void simulateFileProcess()}
                className="absolute top-2.5 right-2.5 z-10 inline-flex items-center gap-1 rounded-lg border border-dashed border-rule bg-surface/90 backdrop-blur px-2.5 py-1 text-[11px] font-medium text-ink-soft hover:text-ink hover:border-rule-strong transition-colors"
              >
                Debug: simulate scan
              </button>
            )}

            <div className="relative flex flex-col items-center">
              <h3 className="text-[16px] font-semibold text-ink">
                {drag ? t("files.dropToUpload") : t("products.empty.dropHere")}
              </h3>
              <p className="text-[12.5px] text-ink-soft mt-1">
                {t("productsX.empty.dropFormats", { mb: PRODUCTS_UPLOAD_MAX_MB })}
              </p>
              {/* Same treatment as the dashboard dropzone's Import button:
                  animated teal gradient fill + brand border. Opens the OS
                  file picker. */}
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                data-testid="products-upload-choose"
                className="mt-4 inline-flex items-center justify-center h-9 px-3.5 rounded-lg border border-brand/40 ask-ai-anim-fill [animation-duration:10s] text-ink text-[12.5px] font-medium hover:border-brand/60 transition-colors"
              >
                {t("files.import")}
              </button>
              {/* Single-file only (2026-07-26 per operator). */}
              <input
                ref={fileRef}
                type="file"
                accept={PRODUCTS_UPLOAD_ACCEPT}
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) stageFile(f);
                  e.target.value = ""; // allow re-picking the same file later
                }}
              />
            </div>

            {/* Pipeline steps — idle preview of what CFO AI will do, using
                the Products stage names. During a scan the fullscreen
                ScanProgressView (above) takes over and lights these up. */}
            <ol
              className="relative w-full max-w-[560px] mx-auto flex items-start justify-between gap-2 mt-6"
              aria-label={t("productsX.empty.pipelineAria")}
              data-testid="products-upload-pipeline"
            >
              <span aria-hidden className="absolute top-4 left-3 right-3 h-px bg-gradient-to-r from-transparent via-rule to-transparent" />
              {SKU_DATASET_STEPS.map((label, i) => (
                <li key={label} className="relative flex-1 min-w-0 flex flex-col items-center text-center">
                  <span className="
                    relative z-10 inline-flex items-center justify-center
                    h-8 w-8 rounded-full text-[12px] font-mono font-semibold tabular-nums
                    transition-colors duration-300
                    bg-surface text-ink-soft border border-rule
                  ">
                    {`0${i + 1}`}
                  </span>
                  <span className="mt-2 text-[11.5px] uppercase tracking-[0.08em] font-medium leading-tight max-w-[100px] text-ink-soft">
                    {/* Same i18n bridge ScanProgressView uses — the step
                        constants stay English literals; translate at render. */}
                    {SCAN_TEXT_KEYS[label] ? t(SCAN_TEXT_KEYS[label]) : label}
                  </span>
                </li>
              ))}
            </ol>

            {stagedFiles.length > 0 && (
              /* Staged files — each has an X to discard; nothing uploads
                 until Start scan. Same block as the dashboard dropzone. */
              <div className="relative mt-6 w-full max-w-[640px] mx-auto text-left" data-testid="staged-files">
                <div className="text-[10.5px] uppercase tracking-[0.14em] font-semibold text-ink-soft mb-2">
                  {t("productsX.empty.stagedHeading")}
                </div>
                {/* Grid of staged-file cards — icon above name, everything
                    centered; clicking the card opens the file in a new window;
                    delete sits top-right and appears on hover only. */}
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {stagedFiles.map((f, i) => (
                    <div key={`${f.name}-${f.size}-${i}`} className="group relative">
                      <button
                        type="button"
                        onClick={() => void openStagedFile(f)}
                        aria-label={t("productsX.empty.openFileAria", { name: f.name })}
                        data-testid={`view-staged-${i}`}
                        className="w-full flex flex-col items-center justify-center text-center gap-1.5 rounded-lg border border-rule bg-bg-2/40 px-3 py-4 hover:bg-bg-2/70 hover:border-rule-strong transition-colors"
                      >
                        <FileSpreadsheet size={22} strokeWidth={1.5} className="text-ink-soft" />
                        <div className="w-full text-[12px] font-medium text-ink truncate">{f.name}</div>
                        <div className="text-[10.5px] text-ink-soft">{(f.size / 1024).toFixed(0)} KB</div>
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setStagedFiles((prev) => prev.filter((_, idx) => idx !== i));
                        }}
                        disabled={scanning}
                        aria-label={t("productsX.empty.removeFileAria", { name: f.name })}
                        data-testid={`discard-staged-${i}`}
                        className="absolute top-1.5 right-1.5 inline-flex items-center justify-center h-6 w-6 rounded-md text-ink-soft bg-surface/80 backdrop-blur hover:text-ink hover:bg-bg-2 ring-1 ring-inset ring-rule opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity disabled:opacity-0 disabled:pointer-events-none"
                      >
                        <X size={13} strokeWidth={2} />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="mt-3 flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => setStagedFiles([])}
                    disabled={scanning}
                    data-testid="dismiss-all-staged"
                    className="inline-flex items-center gap-1.5 h-10 px-3 rounded-lg text-[12.5px] font-medium text-ink-soft hover:text-ink hover:bg-bg-2 ring-1 ring-inset ring-rule transition-colors disabled:opacity-40"
                  >
                    <X size={13} strokeWidth={2} />
                    {t("productsX.empty.dismissAll")}
                  </button>
                  <button
                    type="button"
                    onClick={() => void startScan()}
                    disabled={scanning}
                    data-testid="start-scan"
                    className="inline-flex items-center gap-2 h-10 px-4 rounded-lg ask-ai-anim-fill [animation-duration:10s] border border-brand/40 text-ink text-[13px] font-medium hover:border-brand/60 transition-colors disabled:opacity-60"
                  >
                    {scanning && <Loader2 size={13} strokeWidth={2} className="animate-spin" />}
                    {scanning ? t("productsX.empty.scanning") : `${t("productsX.empty.startScan")}${stagedFiles.length > 1 ? ` (${stagedFiles.length})` : ""}`}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Contextual Ask CFO AI prompt chips — only once a dataset
       *  exists; hidden in the pre-upload (no files) state. ─────────── */}
      {datasets.length > 0 && <ProductsPromptChips />}

      {/* ── Stats strip — REAL or absent (no fabrication) ──────────── */}
      <ProductsStatsStrip stats={stats} hasData={datasets.length > 0} />

      {/* "What happens next" process-flow section removed 2026-07-24 per
          operator directive (ProductsProcessFlow deleted; git history
          has it). */}

      {/* The "Accepted formats" card was removed 2026-07-24 per operator
          directive (the dropzone's own format line covers it). */}

      {/* ── Recent imports — only once a dataset exists; hides the
       *  "No imports yet. Your uploads will appear here." placeholder in
       *  the pre-upload (no files) state. ─────────────────────────── */}
      {datasets.length > 0 && <ProductsRecentImports datasets={sortedDatasets} />}

      {/* Expected-format card moved ABOVE the dropzone (2026-07-24) —
          rendered from the hero block up top. */}

      {/* The bottom "Clarity, on demand" insight strip was removed
          2026-07-24 per operator directive (ProductsBottomInsightStrip,
          recoverable from git history). */}
    </section>
  );
}

// ─── Contextual prompt chips ─────────────────────────────────────
// Each chip dispatches `openAskCfoAi(prompt)` which AppShell receives
// and translates into either: focus the live composer with prefill
// (when already on /chat) or open the slide-over with the prompt
// queued (any other route — including this Products page). The
// prompts are real CFO-finance questions, NOT fabricated insights.

const PRODUCTS_PROMPT_CHIPS: Array<{ key: string }> = [
  { key: "profitability" },
  { key: "lossMakers" },
  { key: "discontinue" },
  { key: "marginLeaks" },
  { key: "summarize" },
];

function ProductsPromptChips() {
  const { t } = useTranslation();
  return (
    <section className="mt-8" data-testid="products-prompt-chips">
      <div className="flex items-center gap-2 mb-2.5">
        <Sparkles size={11} strokeWidth={2.25} className="text-brand-d" />
        <span className="text-[10.5px] uppercase tracking-[0.14em] text-ink-soft font-semibold">
          {t("topbar.ask")}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {PRODUCTS_PROMPT_CHIPS.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => openAskCfoAi(t(`productsX.chips.${c.key}.prompt`))}
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
            <Sparkles size={11} strokeWidth={2} className="text-ink-soft group-hover:text-brand-d transition-colors" />
            {t(`productsX.chips.${c.key}.label`)}
          </button>
        ))}
      </div>
    </section>
  );
}

// ─── Bottom insight strip ────────────────────────────────────────
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
  const { t } = useTranslation();
  // No data → render nothing (2026-07-24; the "Insights appear once
  // data is in" placeholder card was removed — a pre-upload page
  // shouldn't carry it).
  if (!hasData) return null;

  return (
    <div className="mt-10 grid grid-cols-2 lg:grid-cols-4 gap-3" data-testid="products-stats-strip">
      <StatCard
        label={t("productsX.stats.datasetsAnalyzed")}
        value={<Amount kind="count" value={stats.datasetCount} />}
        sub={t("productsX.stats.importsOnFile", { count: stats.datasetCount })}
      />
      {stats.totalSkus !== null && (
        <StatCard
          label={t("productsX.stats.skusAnalyzed")}
          value={<Amount kind="count" value={stats.totalSkus} />}
          sub={t("productsX.stats.cumulative")}
        />
      )}
      {stats.totalLineRows !== null && (
        <StatCard
          label={t("productsX.stats.lineRows")}
          value={<Amount kind="count" value={stats.totalLineRows} />}
          sub={t("productsX.stats.cumulative")}
        />
      )}
      {stats.latestUploadAt && (
        <StatCard
          label={t("productsX.stats.latestImport")}
          value={shortRelative(stats.latestUploadAt, t)}
          sub={new Date(stats.latestUploadAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}
        />
      )}
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return (
    <div className="rounded-md border border-rule bg-surface px-4 py-3">
      <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-soft font-medium">{label}</div>
      <div className="mt-1.5 text-[20px] font-mono font-medium text-ink tabular-nums leading-none">{value}</div>
      {sub && <div className="mt-1 text-[11px] text-ink-soft">{sub}</div>}
    </div>
  );
}

function shortRelative(iso: string, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return "—";
  const diff = Date.now() - ts;
  if (diff < 60_000) return t("productsX.rel.justNow");
  if (diff < 60 * 60_000) return t("productsX.rel.minAgo", { n: Math.floor(diff / 60_000) });
  if (diff < 24 * 60 * 60_000) return t("productsX.rel.hourAgo", { n: Math.floor(diff / (60 * 60_000)) });
  if (diff < 7 * 24 * 60 * 60_000) return t("productsX.rel.dayAgo", { n: Math.floor(diff / (24 * 60 * 60_000)) });
  return new Date(iso).toLocaleDateString("en-GB", { month: "short", day: "numeric" });
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
        <div className="mx-auto h-9 w-9 rounded-lg bg-bg-2 text-ink-soft flex items-center justify-center mb-2">
          <Boxes size={15} strokeWidth={1.75} />
        </div>
        <p className="text-[13px] text-ink-soft">
          <span className="text-ink font-medium">{t("productsX.recent.emptyTitle")}</span>{" "}
          {t("productsX.recent.emptyBody")}
        </p>
      </section>
    );
  }
  const rows = datasets.slice(0, 5);
  return (
    <section className="mt-10" data-testid="products-recent-imports">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-[10.5px] uppercase tracking-[0.12em] text-ink-soft font-semibold">
          {t("datasets.title")}
        </h2>
        {datasets.length > rows.length && (
          <span className="text-[11px] text-ink-soft">{t("datasets.more", { count: datasets.length - rows.length })}</span>
        )}
      </div>
      <div className="rounded-md border border-rule bg-surface overflow-hidden">
        <div className="grid grid-cols-[1fr_140px_100px_110px] gap-3 px-4 h-8 items-center bg-bg-2/40 border-b border-rule text-[10.5px] uppercase tracking-[0.08em] text-ink-soft font-medium">
          <div>{t("datasets.columns.file")}</div>
          <div className="text-right">{t("datasets.columns.rows")}</div>
          <div className="text-right">{t("datasets.columns.skus")}</div>
          <div>{t("datasets.columns.status")}</div>
        </div>
        <ul>
          {rows.map((d) => (
            <li key={d.id} className="grid grid-cols-[1fr_140px_100px_110px] gap-3 px-4 min-h-8 py-1 border-b border-rule-soft last:border-0 items-center">
              <div className="min-w-0 flex items-baseline gap-2">
                <span className="text-[12.5px] text-ink truncate min-w-0">{d.source_filename ?? d.label}</span>
                <span className="text-[10.5px] text-ink-soft truncate min-w-0">
                  {d.label !== (d.source_filename ?? d.label) && <span>{d.label} · </span>}
                  {new Date(d.uploaded_at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}
                </span>
              </div>
              <div className="text-right text-[12.5px] text-ink-soft">
                <Amount kind="count" value={d.row_count} />
              </div>
              <div className="text-right text-[12.5px] text-ink-soft">
                <Amount kind="count" value={d.sku_count} />
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
  const { t } = useTranslation();
  // Real status from the backend; never a placeholder. One chip system:
  // analyzed = success, in-flight = info, failed = alert, unknown = neutral.
  const s = (status ?? "").toLowerCase();
  let label = status ?? t("datasets.status.unknown");
  let tone: ChipTone = "neutral";
  if (s === "analyzed") { label = active ? t("datasets.status.active") : t("datasets.status.analyzed"); tone = "success"; }
  else if (s === "queued" || s === "extracting" || s === "ingesting") { label = t("datasets.status.processing"); tone = "info"; }
  else if (s === "failed") { label = t("datasets.status.failed"); tone = "alert"; }
  return (
    <InstrumentChip tone={tone} className="uppercase tracking-[0.04em] text-[10.5px]">
      {label}
    </InstrumentChip>
  );
}

// Fictional sample rows shared by the format hint (the INPUT shape) and
// the example-result preview (what the analysis computes from them).
// These figures are placeholders, labeled fictional wherever they render
// — never real product data, never presented as such.
const EXAMPLE_SALES_ROWS = [
  { channel: "RETAIL", category: "CATEGORY 1", brand: "BRAND X", name: "EXAMPLE PRODUCT A", volumeTons: 100, nivKrn: 1500, gmKrn: 300, gmPct: 0.20, invKrn: 450 as number | null, cogsKrn: 1200 as number | null },
  { channel: "HORECA", category: "CATEGORY 1", brand: "BRAND X", name: "EXAMPLE PRODUCT B", volumeTons: 50, nivKrn: 800, gmKrn: 120, gmPct: 0.15, invKrn: 220 as number | null, cogsKrn: 680 as number | null },
  { channel: "EXPORT", category: "CATEGORY 2", brand: "BRAND Y", name: "EXAMPLE PRODUCT C", volumeTons: 200, nivKrn: 3000, gmKrn: 450, gmPct: 0.15, invKrn: null as number | null, cogsKrn: null as number | null },
];

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
  const rows: Array<(string | number)[]> = EXAMPLE_SALES_ROWS.map((r) => [
    r.channel, r.category, r.brand, r.name,
    r.volumeTons, r.nivKrn, r.gmKrn, r.gmPct,
    r.invKrn ?? "—", r.cogsKrn ?? "—",
  ]);
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
    // Styled like the dashboard's DocGuideCard (2026-07-24): compact
    // bordered card with a brand left rail, uppercase format line, dense
    // description — the example table follows inside. The "Expected
    // format" label sits OUTSIDE, above the card, as a section heading.
    <section className="mt-6" data-testid="sales-format-hint">
      <h2 className="text-[10.5px] uppercase tracking-[0.12em] text-ink-soft font-semibold mb-3">
        {t("expectedFormat.eyebrow")}
      </h2>
      <div className="rounded-lg border border-rule border-l-[3px] border-l-brand bg-surface p-3 text-left">
      <div className="mb-1 text-[12.5px] font-medium text-ink leading-tight">
        {t("expectedFormat.title")}
      </div>
      <div className="text-[10.5px] uppercase tracking-[0.08em] text-ink-soft font-medium mb-1.5">
        {t("productsX.xlsxExport")}
      </div>
      <p className="text-[11.5px] text-ink-soft leading-relaxed mb-2 max-w-[640px]">
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
      {/* The "Download example (XLSX)" affordance moved into the
          "Start from the official template" card's action rows
          (2026-07-24). */}

      <div className="overflow-x-auto -mx-1 px-1">
        <table className="w-full text-[12.5px] tabular-nums">
          <thead>
            <tr className="border-b border-rule">
              {headers.map((h, j) => (
                <th
                  key={h}
                  className={`h-8 pr-4 font-semibold text-[10.5px] uppercase tracking-[0.04em] text-ink-soft whitespace-nowrap ${j >= 4 ? "text-right" : "text-left"}`}
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
              <tr key={i} className="border-b border-rule-soft last:border-0">
                {r.map((v, j) => (
                  <td
                    key={j}
                    className={`h-8 pr-4 whitespace-nowrap text-ink ${
                      j >= 4 ? "text-right font-mono" : "text-left"
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
      <p className="mt-3 text-[11px] text-ink-soft italic">
        <Trans
          i18nKey="expectedFormat.exampleFooter"
          components={{
            c1: <code className={codeCls} />,
            c2: <code className={codeCls} />,
          }}
        />
      </p>
      </div>
    </section>
  );
}

// ─── Example result preview ─────────────────────────────────────────────────
//
// The value proposition, visible BEFORE the first upload: the per-SKU view
// this page produces, rendered as a small instrument table from the SAME
// fictional rows the format hint shows (EXAMPLE_SALES_ROWS). Every figure
// is either copied from those rows or derived by the page's documented
// arithmetic (DIO = inventory / COGS × 365; the totals line sums the
// rows). What a real analysis would have to CLASSIFY — the Protect /
// Watch / Wind-down signal — is honestly em-dash here: signals exist only
// once the engine has graded real rows.
function ExampleResultPreview() {
  const { t } = useTranslation();
  const totals = EXAMPLE_SALES_ROWS.reduce(
    (a, r) => ({ vol: a.vol + r.volumeTons, niv: a.niv + r.nivKrn, gm: a.gm + r.gmKrn }),
    { vol: 0, niv: 0, gm: 0 },
  );
  const totalGmPct = totals.niv > 0 ? (totals.gm / totals.niv) * 100 : null;
  const dioOf = (r: (typeof EXAMPLE_SALES_ROWS)[number]): number | null =>
    r.invKrn != null && r.cogsKrn != null && r.cogsKrn > 0
      ? Math.round((r.invKrn / r.cogsKrn) * 365)
      : null;
  const grid = "grid grid-cols-[minmax(0,1fr)_72px_88px_64px_88px_56px_72px] gap-3 px-4 items-center";
  return (
    <section className="mt-6" data-testid="products-example-result">
      <h2 className="text-[10.5px] uppercase tracking-[0.12em] text-ink-soft font-semibold mb-3">
        Example result
      </h2>
      <Panel>
        <PanelHeader
          title="Every SKU, ranked and graded"
          actions={
            <InstrumentChip tone="neutral" className="whitespace-nowrap">
              {t("tmpl.salesExample")}
            </InstrumentChip>
          }
        />
        <MoneyAmountGroup
          values={EXAMPLE_SALES_ROWS.flatMap((r) => [r.nivKrn * 1000, r.gmKrn * 1000])}
          fromCurrency="RON"
        >
          <div className="overflow-x-auto">
            <div className="min-w-[640px]">
              <div className={`${grid} h-8 border-b border-rule bg-bg-2/40 text-[10.5px] uppercase tracking-[0.08em] text-ink-soft font-medium`}>
                <div>{t("products.columns.skuCategory")}</div>
                <div className="text-right">{t("products.columns.volume")}</div>
                <div className="text-right">{t("totals.niv")}</div>
                <div className="text-right">{t("products.columns.gmPct")}</div>
                <div className="text-right">{t("totals.gm")}</div>
                <div className="text-right">DIO</div>
                <div>{t("products.columns.signal")}</div>
              </div>
              {EXAMPLE_SALES_ROWS.map((r) => {
                const dio = dioOf(r);
                return (
                  <div key={r.name} className={`${grid} h-8 border-b border-rule-soft text-[12.5px]`}>
                    <div className="min-w-0 flex items-baseline gap-2">
                      <span className="text-ink truncate min-w-0">
                        <SourceText lang="ro">{r.name}</SourceText>
                      </span>
                      <span className="text-[10.5px] text-ink-soft truncate min-w-0">
                        <SourceText lang="ro">{`${r.brand} · ${r.category}`}</SourceText>
                      </span>
                    </div>
                    <div className="text-right text-ink-soft">
                      <Amount kind="count" value={r.volumeTons} />
                    </div>
                    <div className="text-right text-ink-soft">
                      <MoneyAmount value={r.nivKrn * 1000} fromCurrency="RON" />
                    </div>
                    <div className="text-right text-ink">
                      <PercentLevel value={r.gmPct * 100} />
                    </div>
                    <div className="text-right text-ink font-medium">
                      <MoneyAmount value={r.gmKrn * 1000} fromCurrency="RON" signed />
                    </div>
                    <div className="text-right">
                      {dio != null
                        ? <span className="text-ink"><Amount kind="count" value={dio} /></span>
                        : <span className="text-ink-soft/70 font-mono">—</span>}
                    </div>
                    {/* Signal is the ENGINE's judgment — not derivable from
                        a format sample, so it stays honestly absent. */}
                    <div className="text-[11px] text-ink-soft font-mono">—</div>
                  </div>
                );
              })}
              {/* Totals — double hairline, per the instrument table spec. */}
              <div className={`${grid} h-9 border-t-[3px] border-t-rule [border-top-style:double] bg-bg-2/30 text-[12.5px]`}>
                <div className="text-[10.5px] uppercase tracking-[0.08em] text-ink-soft font-medium">
                  {t("totals.title")} · <Amount kind="count" value={EXAMPLE_SALES_ROWS.length} />
                </div>
                <div className="text-right text-ink font-medium"><Amount kind="count" value={totals.vol} /></div>
                <div className="text-right text-ink font-medium"><MoneyAmount value={totals.niv * 1000} fromCurrency="RON" /></div>
                <div className="text-right text-ink font-medium"><PercentLevel value={totalGmPct} /></div>
                <div className="text-right text-ink font-medium"><MoneyAmount value={totals.gm * 1000} fromCurrency="RON" signed /></div>
                <div className="text-right text-ink-soft/70 font-mono">—</div>
                <div />
              </div>
            </div>
          </div>
        </MoneyAmountGroup>
        <PanelBody className="py-2.5">
          <p className="text-[11px] text-ink-soft italic">
            {t("expectedFormat.exampleCaption")} Signals (Protect / Watch / Wind down) appear once your
            real rows are classified.
          </p>
        </PanelBody>
      </Panel>
    </section>
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
    <span className="ml-1.5 text-[10.5px] text-ink-soft italic">({hint})</span>
  );
}

// ─── Test-only exports ──────────────────────────────────────────────────────
// The populated-state building blocks, exposed so the instrument-spec unit
// tests can render them without booting the whole page (which needs a live
// Supabase session). Not part of the page's public API.
export const __productsTestables = {
  SkuTable,
  KpiCard,
  WcCard,
  ExampleResultPreview,
  DocumentStatusPill,
};
