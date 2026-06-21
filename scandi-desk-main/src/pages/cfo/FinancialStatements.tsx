// /dashboard — Financial Statement Intelligence flagship page.
//
// Multi-tab dashboard wrapped in the standard AppShell:
//   Overview · Statements · Ratios · Valuation · Risks · Recommendations · Export
//
// Inputs:
//   • Sample picker (synthetic fictional datasets — Step 2 of the REAL-AUTH prompt)
//   • Drop-zone upload (PDF/XLSX/CSV/JPG/PNG) — sole upload entry point
//     after F3-UX-2 removed the paste-trial-balance dialog
//
// Engines (all pure TypeScript, run client-side):
//   • computeRatios()         — 25+ ratios (financialReport.ts)
//   • runDcf() / runGraham()  — intrinsic valuation (financialValuation.ts)
//   • runPiotroski()          — 9-point quality screen
//   • computeCreditScore()    — composite 0–100 → S&P-style rating
//   • multiPeriodGrowth()     — y/y trend + CAGR
//
// Exports:
//   • HTML report (downloadReport) — single-file, browser-printable to PDF
//   • Excel workbook (downloadExcelReport) — 8-sheet xlsx model

import { useMemo, useState, useRef, useCallback, useEffect } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useBudgetComparison } from "@/stores/budget";
import { parseBudgetFile } from "@/lib/comparison/parseBudget";
import { useTranslation } from "react-i18next";
import { AppShell } from "@/components/cfo/AppShell";
import { Money } from "@/components/ui/Money";
import { LearnableNumber } from "@/components/learning/LearnableNumber";
import { LearnableRowLabel } from "@/components/learning/LearnableRowLabel";
import { ReportingContextProvider } from "@/components/learning/ReportingContextProvider";
import { LearningCoach } from "@/components/learning/LearningCoach";
import { GuideMeButton } from "@/components/learning/GuideMeButton";
import { RATIOS_GUIDE, RECOMMENDATIONS_GUIDE, RISK_GUIDE } from "@/components/learning/pageGuides";
import { factToConceptKey, factLabel } from "@/lib/learning/concepts/recommendations";
import { openAskCfoAi } from "@/components/cfo/chat/openAskCfoAi";
import type { ReportingMetrics } from "@/lib/learning/concepts/_schema";
import { buildReportingMetricsSnapshot } from "@/lib/learning/buildReportingMetrics";
import { ConfigurableDashboard } from "@/components/dashboard/ConfigurableDashboard";
import { DashboardProvider } from "@/stores/dashboard";
import { DashboardViewProvider } from "@/stores/dashboardView";
import { DemoBanner } from "@/components/dashboard/DemoBanner";
import { buildMultiYearSeries } from "@/lib/learning/multiPeriodSeries";
import { DEMO_SAMPLE_ID } from "@/lib/demo/demoCompany";
import type { Currency } from "@/lib/rates";
// First-class Public Company Intelligence module on the empty-state dashboard.
// Renders as a full premium module card (same weight as Trial Balances)
// rather than a small CTA. Clicks navigate to /public-companies (the hub).
import { PublicCompaniesLandingCard } from "@/components/public-companies/PublicCompaniesLandingCard";
import { useDisplayCurrency, useRates } from "@/stores/currency";
import { convertFromTo } from "@/lib/money";
import { useUploadEnqueue } from "@/hooks/useUploadEnqueue";
import { PLStatementView } from "@/components/cfo/PLStatementView";
import { BSStatementView } from "@/components/cfo/BSStatementView";
import { CashFlowStatementView } from "@/components/cfo/CashFlowStatementView";
import { NavValuationView } from "@/components/cfo/NavValuationView";
import {
  EbitdaMultiplePrimaryCard,
  ValuationCrossChecksDisclosure,
  HeavyReReasonBanner,
} from "@/components/cfo/EbitdaMultiplePrimaryCard";
import { pickPLBuilder, buildPLStatementFromAggregates } from "@/lib/buildPlStatement";
import { buildBSStatement } from "@/lib/buildBsStatement";
import { buildCashFlowStatement } from "@/lib/buildCashFlowStatement";
import { buildNavCascade } from "@/lib/buildNavCascade";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  AlertCircle,
  ArrowDownToLine,
  ArrowRight,
  Building2,
  // P0-FIX (2026-06-01) — `Check` was used at line 2822 inside
  // UploadProgressCard's STEPS render for the "done" step state but
  // had never been imported. Survived TS check (Vite/SWC treats
  // capitalized JSX as a component reference and trusts the runtime
  // module graph). At runtime: as soon as one upload step transitioned
  // to done state (status='mapping' → step 1 done → render <Check/>) →
  // ReferenceError: Check is not defined → InlineErrorBoundary fallback.
  // Explains why steps 3-6 never lit up — the card crashed the moment
  // step 1 completed.
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileSpreadsheet,
  FileText,
  Info,
  Loader2,
  Shield,
  Sparkles,
  TrendingUp,
  UploadCloud,
} from "lucide-react";
import {
  computeRatios,
  deriveTotals,
  downloadReport,
  formatRatio,
  generateRecommendations,
  verdictColor,
  verdictLabel,
  type Ratio,
  type RatioBundle,
  type Recommendation,
  type Statements,
} from "@/lib/financialReport";
import {
  computeCostOfCapital,
  computeCreditScore,
  deriveCashFlow,
  multiPeriodGrowth,
  runDcf,
  runGraham,
  runPiotroski,
} from "@/lib/financialValuation";
import {
  buildStatementsFromTrialBalance,
  parseTrialBalance,
} from "@/lib/trialBalanceParser";
import { downloadExcelReport } from "@/lib/financialExports";
import { SAMPLE_DATASETS, SAMPLES_ENABLED } from "@/data/sampleStatements";
import { useActivePeriod, type PeriodValuation } from "@/lib/activePeriod";
import { useActivePeriodFallback } from "@/hooks/useActivePeriodFallback";
import {
  clearUpload,
  patchUpload,
  startUpload,
  useUploadStore,
} from "@/lib/uploadStore";
import { InlineErrorBoundary } from "@/components/cfo/InlineErrorBoundary";
import { StatementNotes } from "@/components/cfo/StatementNotes";
import { ValuationSection } from "@/components/cfo/ValuationSection";
import { RatioDetailDrawer } from "@/components/cfo/RatioDetailDrawer";
import { buildCanonicalMetricsFromInputs } from "@/lib/canonicalMetrics";
import { EbitdaReconciliationPanel } from "@/components/cfo/EbitdaReconciliationPanel";
import { SourceQualityBanner } from "@/components/cfo/SourceQualityBanner";
import { DocsToggle, useDocsCount } from "@/components/cfo/DocsPanel";
import { PublicRecordsQuickCard } from "@/components/cfo/PublicRecordsQuickCard";
import { DocumentSwitcher } from "@/components/cfo/DocumentSwitcher";
import { PUBLIC_RECORDS_ENABLED } from "@/config/features";
import {
  allTabs,
  disabledHint,
  resolveActiveTab,
  tabEnabled,
  type DocumentType,
  type TabId,
} from "@/lib/financialStatementTabs";
import {
  customerAnalytics,
  paymentsAnalytics,
  vatAnalytics,
  type Invoice,
} from "@/lib/invoiceAnalytics";
// CustomersTab / PaymentsTab / MarginTab / VatTab were removed in the
// 9-tab restructure. Their canonical signals (customer concentration,
// DSO, paid-on-time, net VAT) still surface as KPI tiles in the
// `InvoiceKpiStrip` at the top of the page when invoice data is loaded.
// The archived bottom-tab implementations live in src/_removed/tabs/.
import { useToast } from "@/hooks/use-toast";

export default function FinancialStatements() {
  const { t } = useTranslation();
  // Initial state — empty. The page starts as a sample picker / upload zone;
  // tab visibility evolves as the user picks a sample or uploads a document.
  // This honors the master-prompt acceptance: "with no documents uploaded:
  // only Overview · Recommendations · Export tabs are visible."
  const [statements, setStatements] = useState<Statements | null>(null);
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [availableTypes, setAvailableTypes] = useState<Set<DocumentType>>(new Set());
  const [activeSampleId, setActiveSampleId] = useState<string | null>(null);
  const [uploadName, setUploadName] = useState<string | null>(null);
  const [parseSource, setParseSource] = useState<{
    documentName: string;
    /** null when we don't have real extraction confidence — banner skips
     *  the "confidence X%" chip rather than fabricating 100%. */
    confidence: number | null;
    warnings: string[];
    /** null when we don't have real account count — banner skips the
     *  "N accounts" chip rather than rendering "0 accounts". */
    accountCount: number | null;
  } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const navigate = useNavigate();
  // F6.0.1c — a PowerPoint/CSV/XLSX budget deck dropped on the MAIN upload
  // is a budget, not a trial balance; intercept it (see onFileChosen) and
  // route it to the Budget vs Actual variance store instead of the engine.
  const { save: saveBudgetDeck } = useBudgetComparison();
  // Pricing V3 — wraps enqueuePipeline so 402 (extra-doc) opens the
  // confirm dialog, 429 (quota blocked) surfaces a toast, and queued
  // proceeds normally. `uploadEnqueue.dialog` is rendered in JSX
  // below so the modal lives in the same tree as the upload action.
  const uploadEnqueue = useUploadEnqueue();

  // Hand-off slot — populated by /upload's "Run analysis" flow. We hydrate
  // statements + availableTypes here on mount so the page lights up with the
  // user's extracted data without needing to refetch from the DB. Cleared
  // immediately so a refresh shows the empty workspace cleanly.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem("cfoai.parsed");
      if (!raw) return;
      sessionStorage.removeItem("cfoai.parsed");
      const payload = JSON.parse(raw) as {
        statements: Statements;
        availableTypes: DocumentType[];
        source: {
          documentName: string;
          confidence: number;
          warnings: string[];
          accountCount: number;
        };
      };
      setStatements(payload.statements);
      setAvailableTypes(new Set(payload.availableTypes));
      setActiveSampleId("uploaded");
      setParseSource(payload.source);
    } catch {
      /* ignore — corrupted hand-off slot is non-fatal */
    }
  }, []);

  // ── Watchdog: on page load, ask the BE to re-enqueue any docs that got
  // stuck at status='queued' with pipeline_started_at=null (i.e. uploaded
  // but the worker thread never ran — typically /api/pipeline/run failed at
  // upload moment). Idempotent. Without this, a user landing on Financial
  // Statements after a backend hiccup sees their inflight doc spinning
  // forever at "Step 0 of 6 · Queued for analysis…".
  useEffect(() => {
    void (async () => {
      try {
        const { recoverStuckPipelines } = await import("@/lib/supabase");
        await recoverStuckPipelines();
      } catch {
        /* non-fatal — page still renders */
      }
    })();
  }, []);

  // ─── Tab state + URL sync ───────────────────────────────────────────────
  // Phase F: every tab is always visible. `enabled[id]` says whether the user
  // can click it; disabled tabs render with the same styling but tooltipped.
  // ?tab=customers selects a tab on load + writes back when the user clicks.
  // ?period=<sample_id> hydrates State B directly on initial render.
  const [searchParams, setSearchParams] = useSearchParams();
  const enabled = useMemo(() => tabEnabled(availableTypes), [availableTypes]);
  const tabs = useMemo(() => allTabs(), []);
  const activeTab = resolveActiveTab(searchParams.get("tab"), enabled);

  // The defining state-flip for Phase F: anything loaded → State B. Anything
  // missing → State A. The page chrome below this is conditional on the flag.
  const hasPeriodLoaded = statements !== null || invoices !== null;

  const onTabChange = useCallback((next: string) => {
    setSearchParams((prev) => {
      const sp = new URLSearchParams(prev);
      if (next === "overview") sp.delete("tab");
      else sp.set("tab", next);
      return sp;
    }, { replace: true });
  }, [setSearchParams]);

  // When a sample (or upload) lands, surface the period in the URL so a
  // refresh hydrates straight into State B without flashing State A.
  function setPeriodParam(periodId: string | null) {
    setSearchParams((prev) => {
      const sp = new URLSearchParams(prev);
      if (periodId) sp.set("period", periodId);
      else sp.delete("period");
      // Setting a period always supersedes the "empty state" sticky flag —
      // user just uploaded / picked a sample, so they explicitly want
      // content rendered, not the empty state.
      sp.delete("empty");
      return sp;
    }, { replace: true });
  }

  // F3-UX-2: applyTrialBalance() helper removed alongside paste-text UI.
  // Backend POST /api/paste-trial-balance endpoint left intact pending a
  // separate cleanup chunk that audits other callers (none found in FE).

  // 2026-05-24 — auto-canonicalize the URL when ?period= is missing but
  // the user has a default period set in /api/org/periods-with-documents.
  // Without this, opening /dashboard from the sidebar (which doesn't
  // preserve the period query) shows the empty "Upload your trial balance"
  // state even when the user has docs loaded. See useActivePeriodFallback
  // for the shared pattern (also used by Benchmark, Peer, Comprehensive).
  useActivePeriodFallback();

  // F1.e — `useActivePeriod()` hoisted up so the engine-canonical margin
  // pair (`dashboardCanonicalMargins` below) can read from `remotePeriod.metrics`
  // before `ratios` / `recommendations` consume it. The hook body itself is
  // unchanged — only the declaration line moved. Original location was at
  // ~line 468 alongside the URL-hydration effect (still there in spirit; the
  // effect that consumes `remotePeriod` stays in its original position).
  const remotePeriod = useActivePeriod();

  // Statements-derived metrics — only computed when statements is non-null,
  // otherwise the tabs that need them aren't visible anyway.
  const totals = useMemo(() => (statements ? deriveTotals(statements) : null), [statements]);
  // F6.1 — Multi-year series (oldest → newest) built once from the active
  // period's historicalPeriods. Drives the dashboard Trend view; empty
  // (available=0/1) for single-period uploads, which keeps the Trend toggle
  // disabled. The demo company carries five years so Trend lights up.
  const multiYearSeries = useMemo(() => buildMultiYearSeries(statements), [statements]);
  const isDemoPeriod = remotePeriod.source === "sample" && remotePeriod.id === DEMO_SAMPLE_ID;
  // F1.e — Engine-canonical margin pair used by the Ratios tab Profitability
  // section so EBITDA margin / Net margin agree with the dashboard tile and
  // the P&L Key Margins block. Falls back to FE arithmetic when the engine
  // row is missing (pre-v2.1 cached period).
  const dashboardCanonicalMargins = useMemo(() => {
    const ebitdaRow = remotePeriod.metrics.find((mt) => mt.name === "ebitda_margin");
    const netRow = remotePeriod.metrics.find((mt) => mt.name === "net_margin");
    return {
      ebitdaMargin:
        typeof ebitdaRow?.value === "number" ? ebitdaRow.value : null,
      netMargin: typeof netRow?.value === "number" ? netRow.value : null,
    };
  }, [remotePeriod.metrics]);
  // ‡ F1.e — Engine canonical statutory net profit (ct.121). Plumbed into
  // the dashboard tile and the CFO AI Summary block so the RON figure
  // agrees with the margin.
  const canonicalNetIncomeStatutory = useMemo(() => {
    const row = remotePeriod.metrics.find((mt) => mt.name === "net_income_statutory");
    return typeof row?.value === "number" ? row.value : null;
  }, [remotePeriod.metrics]);
  // F3.11 — F3.9 source-data quality telemetry. Derived FE-side from
  // the four numeric metrics the BE persists post-F3.11
  // (source_imbalance_pct / _abs / _closing_debit_sum / _closing_credit_sum).
  // Returns null on pre-F3.11 cached periods, Claude-extracted uploads,
  // and statutory F30/F10 files — banner renders nothing in those
  // cases. The warn flag is derived from pct > 2.0 (the canonical
  // F3.9 threshold) rather than persisted separately to keep the
  // metrics shape strictly numeric.
  const sourceDataQuality = useMemo(() => {
    const find = (n: string) => {
      const row = remotePeriod.metrics.find((mt) => mt.name === n);
      return typeof row?.value === "number" ? row.value : null;
    };
    const pct = find("source_imbalance_pct");
    const abs = find("source_imbalance_abs");
    const sumD = find("source_closing_debit_sum");
    const sumC = find("source_closing_credit_sum");
    if (pct === null || abs === null || sumD === null || sumC === null) {
      return null;
    }
    return {
      raw_imbalance_pct: pct,
      raw_imbalance_abs: abs,
      sum_closing_debit: sumD,
      sum_closing_credit: sumC,
      warn: pct > 2.0,
      warn_threshold_pct: 2.0,
    };
  }, [remotePeriod.metrics]);
  // F2.2 — Engine-canonical metrics map. Every ratio that has a direct
  // engine equivalent (current/quick/cash/gross_margin/net_margin/
  // debt_to_ebitda/debt_to_equity/equity_ratio/interest_coverage/dscr/
  // dso/dio/dpo/ccc/asset_turnover/roa/roe/roic/altman_*) is sourced
  // from this map so the Ratios tab matches the engine calculated_metrics
  // to the cent. Fallback to FE arithmetic only for pre-v2.1 periods.
  const metricsByName = useMemo(() => {
    const out: Record<string, number | null> = {};
    for (const mt of remotePeriod.metrics) {
      out[mt.name] = typeof mt.value === "number" ? mt.value : null;
    }
    return out;
  }, [remotePeriod.metrics]);
  const ratios = useMemo(
    () => (statements ? computeRatios(statements, dashboardCanonicalMargins, metricsByName) : null),
    [statements, dashboardCanonicalMargins, metricsByName],
  );
  const recommendations = useMemo(
    () => (statements && ratios ? generateRecommendations(statements, ratios) : []),
    [statements, ratios],
  );

  const criticalCount = recommendations.filter((r) => r.priority === "critical").length;
  const highCount = recommendations.filter((r) => r.priority === "high").length;

  function pickSample(id: string, opts: { additive?: boolean } = {}) {
    const found = SAMPLE_DATASETS.find((s) => s.id === id);
    if (!found) return;
    setActiveSampleId(id);
    // Phase F: picking from State B's [Replace ▾] dropdown is REPLACE (a
    // user actively swapping samples doesn't want the prior data sticking
    // around). Picking from State A is also replace because nothing was
    // loaded. Additive stacking (statements + invoices) is now opt-in via the
    // `additive` flag, surfaced in the dropdown as "Add ... on top".
    if (opts.additive) {
      if (found.statements !== undefined) setStatements(found.statements);
      if (found.invoicesGetter !== undefined) setInvoices(found.invoicesGetter());
      setAvailableTypes((prev) => new Set([...prev, ...found.availableTypes]));
    } else {
      setStatements(found.statements ?? null);
      setInvoices(found.invoicesGetter ? found.invoicesGetter() : null);
      setAvailableTypes(new Set(found.availableTypes));
    }
    setUploadName(null);
    setParseSource(null);
    setPeriodParam(found.id);
  }

  async function resetWorkspace() {
    // Two phases:
    //   1. If the URL has ?period=<uuid> AND it points to a real (non-
    //      sample) period, delete it server-side. Without this step the
    //      "Reset (clear period)" item only wiped local state — the period
    //      and all its documents/line items/metrics stayed in the DB and
    //      reappeared on next page load.
    //   2. Always clear the local React state + URL so the dashboard
    //      returns to the empty/upload state immediately.
    const periodParam = searchParams.get("period");
    const looksLikeUuid =
      !!periodParam && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(periodParam);
    if (looksLikeUuid) {
      const ok = window.confirm(
        "Clear this period? This permanently removes the analysis (P&L, balance sheet, ratios, briefing) " +
          "and moves the attached document(s) to Recently deleted (restorable for 30 days). Cannot be undone.",
      );
      if (!ok) return;
      try {
        const { getSupabase } = await import("@/lib/supabase");
        const sb = getSupabase();
        const { data: session } = sb ? await sb.auth.getSession() : { data: { session: null } };
        const token = session?.session?.access_token;
        const apiUrl =
          (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";
        if (token) {
          const r = await fetch(`${apiUrl}/api/period/${periodParam}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!r.ok) {
            const body = await r.json().catch(() => null);
            toast({
              title: "Couldn't clear period",
              description:
                (body && (body.detail?.message || body.detail)) ||
                "The server didn't accept the delete. Try again or refresh.",
              variant: "destructive",
            });
            return;
          }
          toast({
            title: "Period cleared",
            description: "Analysis removed; documents moved to Recently deleted.",
          });
        }
      } catch (err) {
        toast({
          title: "Couldn't reach the backend",
          description: err instanceof Error ? err.message : "Network error.",
          variant: "destructive",
        });
        return;
      }
    }
    setStatements(null);
    setInvoices(null);
    setAvailableTypes(new Set());
    setActiveSampleId(null);
    setUploadName(null);
    setParseSource(null);
    // F3-FE-FIX-1 (root cause A): clear uploadInFlight too. Without this,
    // a Reset after a completed analysis left the loader rendering
    // "Analyzing your document… Step 6 of 6 · Analysis ready" with a
    // stale filename, because State A wraps `uploadInFlight ? <Progress/>
    // : <Empty/>` and the stale "analyzed" inflight stayed truthy.
    clearUpload();
    // After a reset, force the dashboard into its empty state instead of
    // letting `useActivePeriodFallback` auto-resolve to the next-most-recent
    // period (which is what was making "Reset" feel like "Next document").
    // The `empty=1` flag is read by useActivePeriodFallback() — it short-
    // circuits the lookup so the user lands on the upload + sample picker
    // + "Search public companies" cards, exactly where they can pick the
    // next action themselves.
    setSearchParams((prev) => {
      const sp = new URLSearchParams(prev);
      sp.delete("tab");
      sp.delete("period");
      sp.set("empty", "1");
      return sp;
    }, { replace: true });
  }

  // ─── URL hydration ──────────────────────────────────────────────────────
  // ?period=<sample_id|uuid> on first render → resolve via useActivePeriod()
  // (handles both fictional samples and pipeline-produced uploads). Hydrates
  // local statements/invoices/availableTypes in sync with the URL so the rest
  // of this page (which still uses local state) stays correct.
  // NOTE: `remotePeriod` was hoisted to the top of this component above; the
  // hydration effect below still references the same object — same hook
  // call, just declared earlier so F1.e's canonical-margin useMemo can
  // read `remotePeriod.metrics` before `ratios` consumes it.
  useEffect(() => {
    if (!remotePeriod.isLoaded || !remotePeriod.statements) return;
    setStatements(remotePeriod.statements);
    if (remotePeriod.invoices) setInvoices(remotePeriod.invoices);
    setAvailableTypes(new Set(remotePeriod.availableTypes));
    setActiveSampleId(remotePeriod.id ?? "remote");
    if (remotePeriod.source === "upload") {
      // accountCount + confidence are not currently sourced from the period
      // payload — the orchestrator emits them per-stage in `pipeline_state`
      // but those fields aren't propagated through `remotePeriod` yet. Until
      // they are, setting them to 0/1 here fabricates a "0 accounts ·
      // confidence 100%" banner that's structurally contradictory and lies
      // to the user. Setting them to null makes the banner render the
      // honest minimum ("Extracted from · <filename>") and skip the false
      // metric chips. Will rewire once the period payload exposes the
      // real extraction stats.
      setParseSource({
        // Prefer the real source-document filename (e.g. "Carniprod Trial
        // Balance 2025.xlsx") over `remotePeriod.label`, which is the
        // workspace/company name (e.g. "alexandru.crestin's organization")
        // — the banner is supposed to say "Extracted from <file>", not
        // "Extracted from <user>".
        documentName:
          remotePeriod.sourceDocumentFilename ??
          remotePeriod.label ??
          "Uploaded document",
        confidence: null,
        warnings: [],
        accountCount: null,
      });
    }
  }, [remotePeriod.isLoaded, remotePeriod.id, remotePeriod.statements, remotePeriod.invoices, remotePeriod.availableTypes, remotePeriod.label, remotePeriod.source]);

  // Single canonical upload entry point. Used by:
  //   - Empty-state dropzone (drag-and-drop or "Choose a file")
  //   - Replace dropdown's "Choose a file…" menu item
  //   - Statements > Documents section (when added)
  // Pushes the file to Storage, creates the documents row, kicks off the
  // pipeline, subscribes to status changes, and navigates to
  // /dashboard?period=<id> once the orchestrator hits 'analyzed'.
  // Active upload — now LIFTED to the global persistent store
  // (src/lib/uploadStore.ts). The store uses useSyncExternalStore +
  // localStorage so the in-flight upload survives:
  //   • navigation across pages (the previous local-useState lived on
  //     this component, so a hop to /products dropped it)
  //   • page refresh (analysis resumes via the rehydrate-on-mount path
  //     in AppShell, see src/components/cfo/AppShell.tsx)
  // The variable name `uploadInFlight` is preserved as the read-side
  // binding so downstream JSX (State A + State B overlay) keeps reading
  // exactly the same shape as before.
  const uploadInFlight = useUploadStore().current;

  // F3-FE-FIX-1 (Option 2 defensive guard): if hasPeriodLoaded ever
  // flips to false while a stale `analyzed` inflight is still around,
  // auto-clear it. Targeted clears in resetWorkspace() + the post-
  // analyze handler cover the known paths; this hedge covers any
  // unknown state path that drops statements without clearing
  // inflight (including the unverified "stuck after refresh" symptom
  // reported by the operator but not reproducible from code-reading).
  useEffect(() => {
    if (!hasPeriodLoaded && uploadInFlight?.status === "analyzed") {
      clearUpload();
    }
  }, [hasPeriodLoaded, uploadInFlight?.status]);

  async function onFileChosen(file: File) {
    // F6.0.1c — Budget-deck interception. A PowerPoint / budget workbook is
    // NOT a trial balance and must not go to the engine extraction pipeline.
    // Parse it client-side into the Budget vs Actual store and route there.
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".pptx") || lower.endsWith(".ppt")) {
      try {
        const ds = await parseBudgetFile(file);
        saveBudgetDeck(ds);
        const n = Object.keys(ds.budget).length;
        toast({
          title: "Budget deck loaded",
          description: `${n} P&L line${n === 1 ? "" : "s"} from ${file.name} — opening Budget vs Actual.`,
        });
        navigate("/dashboard/variance");
      } catch (e) {
        toast({
          title: "Couldn't read that budget deck",
          description: e instanceof Error ? e.message : "Unknown parse error.",
          variant: "destructive",
        });
      }
      return;
    }

    setUploadName(file.name);
    const MAX_BYTES = 25 * 1024 * 1024;
    if (file.size > MAX_BYTES) {
      toast({
        title: "File too large",
        description: `${(file.size / 1_000_000).toFixed(1)} MB exceeds the 25 MB limit.`,
        variant: "destructive",
      });
      return;
    }
    startUpload({ docId: "", filename: file.name, status: "queued" });
    const { uploadDocument, subscribeToDocumentStatus, getSupabase } =
      await import("@/lib/supabase");
    // Dashboard surface = financial-statement documents (trial balance,
    // P&L, balance sheet). Mirror Products.tsx's explicit `scope: "sku"`
    // pattern so the call-site advertises the intent — no relying on
    // uploadDocument's default. Matches the "scope set at upload time,
    // not inferred" rule.
    const { row, error } = await uploadDocument(file, { scope: "financial" });
    if (!row) {
      clearUpload();
      toast({
        title: "Upload failed",
        description: error ?? "Unknown error.",
        variant: "destructive",
      });
      return;
    }
    startUpload({ docId: row.id, filename: file.name, status: "queued" });
    // Pricing V3 — `enqueuePipeline` now returns a discriminated union.
    // queued                → start polling status.
    // extra_doc_required    → 402; the useUploadEnqueue hook opens the
    //                         confirm dialog and re-enqueues on confirm.
    //                         Here we treat any non-queued outcome as
    //                         "don't start polling".
    // quota_blocked         → 429; user is over cap with no extras path.
    // transport_failed      → backend down / network error.
    const enq = await uploadEnqueue.enqueue(row.id);
    if (enq.kind !== "queued") {
      const reason =
        enq.kind === "quota_blocked"
          ? enq.message
          : enq.kind === "transport_failed"
          ? enq.message
          : "Upload was cancelled.";
      patchUpload({ status: "failed", error: reason });
      return;
    }
    const unsub = subscribeToDocumentStatus(row.id, (next) => {
      patchUpload({ status: next.status, error: next.error, periodId: next.period_id ?? null });
      if (next.status === "analyzed") {
        unsub();
        void (async () => {
          // Three terminal outcomes for "analyzed":
          //   1. Public-records summary (listafirme/termene/firme.info)
          //      → no period; route to /multi-year-history.
          //   2. Financial doc with a period_id → /dashboard?period=<id>.
          //   3. Analyzed with no period_id and not a public-records doc
          //      → degraded; show toast + stay on this page (empty state).
          //
          // We probe for case 1 by hitting the public-records endpoint.
          // DB CHECK constraint on documents.detected_type doesn't accept
          // `public_records_summary`, so we can't rely on that column —
          // the briefing.kind in sku_analyses is the canonical signal,
          // surfaced via /api/public-records/by-document/{id}.
          if (!next.period_id) {
            try {
              const sb = getSupabase();
              const { data: session } = sb ? await sb.auth.getSession() : { data: { session: null } };
              const token = session?.session?.access_token;
              const apiUrl =
                (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";
              const r = await fetch(`${apiUrl}/api/public-records/by-document/${row.id}`, {
                headers: token ? { Authorization: `Bearer ${token}` } : {},
              });
              if (r.ok) {
                toast({
                  title: "Multi-year history ready",
                  description: `${file.name} parsed — view the trends.`,
                });
                window.location.href = `/multi-year-history?doc=${row.id}`;
                return;
              }
            } catch { /* fall through */ }
          }
          if (next.period_id) {
            toast({
              title: "Analysis ready",
              description: `${file.name} loaded into Dashboard.`,
            });
            setSearchParams((prev) => {
              const sp = new URLSearchParams(prev);
              sp.set("period", next.period_id!);
              return sp;
            }, { replace: true });
          } else {
            toast({
              title: "Analysis complete",
              description: `${file.name} processed but no financial period was created. The document type may not be supported.`,
            });
          }
          // F3-FE-FIX-1 (root cause B): clear uploadInFlight once analysis
          // terminates and we've handed off to State B (or toasted a
          // degraded outcome). Without this, the loader stayed mounted
          // with status="analyzed" — invisible in State B but ready to
          // re-appear the moment statements cleared (Reset, error, etc.),
          // showing "Analyzing your document… Step 6 of 6 · Analysis
          // ready" indefinitely.
          clearUpload();
        })();
      }
      if (next.status === "failed") {
        unsub();
        toast({
          title: "Analysis failed",
          description: next.error ?? "Unknown error.",
          variant: "destructive",
        });
      }
    });
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) void onFileChosen(file);
  }

  // F5.0 Phase 1.5 — Reporting metrics snapshot for LearnableNumber
  // recursion. Pulled from the active period's canonical envelope so the
  // formula popovers can drill from EBITDA Margin → EBITDA → EBIT →
  // Revenue → source accounts. When no period is loaded the provider
  // wraps with an empty snapshot and the formulas degrade to structural
  // skeletons — no crash, no broken layout.
  // LEARN-FIX-2 — extracted to lib/learning/buildReportingMetrics.ts
  // so the popover can call the SAME builder via useActivePeriod when
  // it sits outside this provider (App-root PopoverStackRenderer).
  const reportingMetricsSnapshot = useMemo<ReportingMetrics>(
    () => buildReportingMetricsSnapshot(statements),
    [statements],
  );

  return (
    <ReportingContextProvider
      metrics={reportingMetricsSnapshot}
      currency={statements?.currency ?? "RON"}
      locale="en"
      // LEARN-FIX-1 — plumb per-account line items so source-account
      // composition bars inside the popover read REAL engine amounts
      // (keyed by ro_account_code) instead of the 0-RON placeholder
      // from staticSourceAccounts().
      lineItems={remotePeriod.lineItems ?? []}
    >
    <AppShell>
    {/* F5.0 Step 3 (CFO AI Learn) — first-run coach. Renders only for
        guided-mode users who haven't dismissed yet. "Show me" deep-links
        to /financials → Balance Sheet tab where the page guide auto-opens. */}
    <LearningCoach
      onShowGuide={() => {
        // Drop the user on the Balance Sheet tab; BSStatementView's
        // auto-open effect picks up from there.
        if (typeof window !== "undefined") {
          const url = new URL(window.location.href);
          url.searchParams.set("tab", "balance_sheet");
          window.history.replaceState(null, "", url.toString());
        }
      }}
    />
      {/* Pricing V3 — extra-doc confirm dialog mounts here so the modal
          sits inside the same tree as the upload action. Renders `null`
          unless the hook has a pending extra-doc decision. */}
      {uploadEnqueue.dialog}
      {/*
        Phase F — two states, one route.
        ─────────────────────────────────
        State A (no period):  Hero + 11 tabs (3 enabled / 8 disabled w/ tooltip)
                              + upload zone + sample picker right panel.
        State B (period loaded):  Compact company header + Replace ▾ dropdown
                                  + Re-run + 11 tabs (enabled per visibility)
                                  + KPI grid + AI summary + mini statements
                                  + top 3 risks/opportunities.
        Transition is a 200ms cross-fade. Refresh on ?period=X hydrates
        directly into State B (see useEffect above). The upload zone is
        verifiably absent in State B (acceptance F.5).
      */}
      {/* Page-level hidden file input.
        *
        * Rendered ALWAYS (not nested inside UploadAndSamplePanel) so both
        * states can trigger it via `fileRef.current?.click()`:
        *   · State A (empty): the dropzone's "Choose a file" button
        *   · State B (period loaded): the Replace dropdown's "Choose a file…"
        *
        * Bug it fixes: prior to this, `<input ref={fileRef}>` lived inside
        * UploadAndSamplePanel which is unmounted in State B → fileRef.current
        * was null → clicking the menu item did nothing.
        */}
      <input
        ref={fileRef}
        type="file"
        accept=".pdf,.xlsx,.xls,.csv,.jpg,.jpeg,.png,.heic,.heif,image/heic,image/heif,.pptx,.ppt,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) {
            void onFileChosen(f);
            e.target.value = "";  // allow re-picking the same file later
          }
        }}
      />

      {/* FE-FIX-2 (revised): State B upload overlay — full-viewport
          centred card with a subtle blurred backdrop, so the upload
          progress feels foregrounded (modal-like) rather than glued to
          the top of the viewport. Replaces the earlier `top-4` placement
          which read as "badly placed" against the dashboard underneath.
          Card is centred both axes; entrance fades + zooms; backdrop is
          translucent enough that the user can still see the dashboard
          re-bucketing in the background, but the upload card commands
          the eye. */}
      {hasPeriodLoaded && uploadInFlight && (
        <div
          aria-live="polite"
          role="status"
          data-testid="upload-progress-overlay"
          className="
            fixed inset-0 z-50
            flex items-center justify-center
            p-4
            bg-bg-2/40 backdrop-blur-[3px]
            animate-in fade-in duration-200
          "
        >
          <div
            className="
              w-full max-w-[560px]
              shadow-[0_24px_64px_-12px_rgba(0,0,0,0.35)]
              animate-in zoom-in-95 fade-in duration-200
            "
          >
            {/* P0-FIX (2026-06-01) — granular boundary around the
                progress card render. Previous behaviour: a render
                crash here (stale-statements field access, malformed
                status string from the BE during a fast transition,
                etc.) propagated up to RouteErrorBoundary and took the
                entire dashboard down to "This page hit an error." See
                RouteErrorBoundary.tsx comment block — the team
                already documented this class of bug; this boundary is
                the surgical containment.
                onReset clears the persisted upload state via
                clearUpload(), which is the same recovery the
                RouteErrorBoundary's "Clear & restart" button performs
                — except in-place so the rest of the page stays alive. */}
            <InlineErrorBoundary
              tag="UploadProgressOverlay"
              label="Upload progress display crashed. Your file is still being processed on the server — click Reset to dismiss this and let the dashboard refresh on its own."
              onReset={() => clearUpload()}
            >
              <UploadProgressCard inflight={uploadInFlight} statements={statements} />
            </InlineErrorBoundary>
          </div>
        </div>
      )}

      <TooltipProvider delayDuration={150}>
        {hasPeriodLoaded ? (
          <CompactPeriodHeader
            statements={statements}
            invoices={invoices}
            activeSampleId={activeSampleId}
            onPickSample={pickSample}
            onTriggerFile={() => fileRef.current?.click()}
            onReset={resetWorkspace}
          />
        ) : (
          <section className="mb-10 transition-opacity duration-200 relative">
            {/* Soft atmospheric brand glow behind the hero — visual
             *  texture only, no information. Sits behind the headline. */}
            <div aria-hidden className="pointer-events-none absolute -top-12 -left-12 h-72 w-72 rounded-full bg-brand/10 blur-3xl" />

            <div className="relative">
              <div className="inline-flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.16em] text-ink-mute font-semibold">
                <Sparkles size={10} strokeWidth={2.25} className="text-brand-d" />
                {t("dashboard.label_eyebrow")}
              </div>
              <h1 className="mt-3 text-[40px] sm:text-[48px] leading-[1.04] tracking-[-0.02em] text-ink max-w-[820px] font-semibold">
                {t("dashboard.hero_pre")}{" "}
                <span className="text-grad font-semibold">{t("dashboard.hero_highlight")}</span>
                {" "}{t("dashboard.hero_post")}
              </h1>
              <p className="mt-5 text-[15.5px] text-ink-soft max-w-[680px] leading-relaxed">
                {t("dashboard.hero_subtitle")}
              </p>
            </div>
          </section>
        )}

        {/* Persistent accuracy banner above the KPI tiles. Now drift-aware:
            CLEAN uploads (drift < 0.5%, source balanced) show a green
            "Quality checks passed" with the measured drift number; WATCH /
            PROBLEM bands show a specific warning naming the issue (source
            imbalance %, BS drift %) — no more generic "~90%+" nag. */}
        {hasPeriodLoaded && (
          <AccuracyBanner
            assembledBs={statements?.assembled_bs as Record<string, number> | undefined}
            sourceDataQuality={sourceDataQuality ?? null}
          />
        )}

        {/* Statutory-format limitation banner — only shows when this
            period was loaded from an ANAF Formular F30+F10 filing, where
            line-item drilldown isn't available. */}
        {hasPeriodLoaded && remotePeriod.detectedType === "statutory_f30_f10" && (
          <StatutoryFormatBanner />
        )}

        {/* KPI strip — driven by the SAME P&L statement the Financial
            Statements tab renders. This guarantees dashboard headlines and
            the detailed P&L always show identical numbers (operating view:
            722 + 767 in revenue, statutory net profit). */}
        {hasPeriodLoaded && statements && totals && (() => {
          // F1.e — Pull the engine-canonical margin pair from
          // calculated_metrics so dashboard tile / Key Margins / Summary
          // all show the SAME number. Falls back to FE arithmetic ONLY
          // when the engine row is missing (cached pre-v2.1 period).
          const canonicalEbitdaMarginRow = remotePeriod.metrics.find(
            (mt) => mt.name === "ebitda_margin",
          );
          const canonicalNetMarginRow = remotePeriod.metrics.find(
            (mt) => mt.name === "net_margin",
          );
          const canonicalEbitdaMargin =
            typeof canonicalEbitdaMarginRow?.value === "number"
              ? canonicalEbitdaMarginRow.value
              : null;
          const canonicalNetMargin =
            typeof canonicalNetMarginRow?.value === "number"
              ? canonicalNetMarginRow.value
              : null;
          const canonicalMargins = {
            ebitdaMargin: canonicalEbitdaMargin,
            netMargin: canonicalNetMargin,
          };
          const pl = pickPLBuilder(
            {
              lineItems: remotePeriod.lineItems,
              entity: statements.companyName ?? "Entity",
              period: statements.periodLabel,
              currency: statements.currency,
              canonicalMargins,
            },
            statements,
          );
          const totalOperatingRevenue = pl.sections[0]?.subtotalAmount ?? statements.incomeStatement.revenue;
          // ── KPI-tile EBITDA view selection (overrides F2.5 / F1.e) ──
          //
          // F2.5 routed the EBITDA tile through the engine canonical
          // `ebitda` metric (operational / cash view, excludes 722
          // capitalized own work). On entities where the OPERATING
          // REVENUE tile INCLUDES 722 (real-estate investment vehicles
          // like EEI Imobiliara: revenue 4.91M including 2.16M of CIP),
          // routing EBITDA through the cash view produced a tile that
          // read RON −37K / −1.3% margin — visually broken next to
          // a 4.91M revenue tile, and contradicting the AI briefing
          // which honestly reports +2.15M EBITDA / +43.75% margin
          // (the OPERATING view that includes 722).
          //
          // Fix: align the EBITDA tile + its margin sub-label with the
          // SAME basis as the OPERATING REVENUE tile next to it. The FE
          // PL builder already computes `pl.ebitda` as the operating
          // view (totalOperatingRevenue − totalOpexCash, per
          // buildPlStatement.ts comment line 182). Use that directly for
          // the value AND derive the margin against
          // totalOperatingRevenue so both tiles speak the same basis.
          //
          // Why not the engine `ebitda_margin` metric? Because on
          // current engine output (v2.1), that metric also uses the
          // operational denominator (class-70 turnover, 2.73M for EEI)
          // — which produces the same inconsistency the tile suffered
          // from. Pinning to FE arithmetic on the visible revenue
          // denominator keeps the dashboard self-consistent until the
          // engine emits a dedicated `ebitda_operating_view` /
          // `ebitda_margin_operating_view` metric pair we can trust.
          //
          // Same reasoning for net margin: the Net Profit tile value
          // reads `net_income_statutory` (the ct.121 anchor, includes
          // 722's contribution to profit). Its margin must also use the
          // operating revenue denominator so the displayed %  reflects
          // "statutory net profit ÷ total operating revenue", not
          // "operational net income ÷ class-70 turnover".
          // ── Overview EBITDA tile: hybrid canonical routing ──────────
          //
          // The tile VALUE reads engine `assembled_pl.ebitda_statutory`
          // (the legally-reported EBITDA, includes 722 + 758 + 781). The
          // MARGIN sub-label divides that canonical numerator by the
          // FE-built `totalOperatingRevenue` denominator — the same
          // basis the OPERATING REVENUE tile to the left renders.
          //
          // Why hybrid: engine emits `calculated_metrics.ebitda_margin`
          // computed from `ebitda` (cash view that excludes 722 for
          // asset-heavy entities), not `ebitda_statutory`. On Scandia
          // those coincide (no 722/758/781 wedge) so the engine metric
          // looks fine. On EEI they diverge (cash EBITDA −36K vs
          // statutory 2.13M) — routing the tile margin to the engine
          // metric would render −1.34%, contradicting the briefing's
          // 43.7%. Computing locally from the canonical numerator + the
          // FE denominator pins the displayed margin to the same basis
          // as the EBITDA tile value and is closed-form correct across
          // both operating businesses and asset-heavy entities.
          //
          // Fallback to `pl.ebitda` handles old persisted envelopes
          // pre-v2.1 that lack `ebitda_statutory`. On those fixtures
          // pl.ebitda is the operating view, which is the same number
          // the dashboard rendered before this routing — graceful
          // degradation, not a regression.
          //
          // Out of scope here (operator decision, scope-sweep): the
          // Recommendations engine intentionally stays on operating-view
          // (`pl.ebitda`); the PL statement table's boxed EBITDA stays
          // on builder basis so line items sum.
          const tileEbitdaCanonical =
            typeof statements.assembled_pl?.ebitda_statutory === "number"
              ? statements.assembled_pl.ebitda_statutory
              : null;
          const tileEbitdaRon = tileEbitdaCanonical ?? pl.ebitda;
          // (F6.0.4) ebitdaMarginPct removed — the EBITDA-margin metric is
          // now a configurable card that computes margin from the same
          // canonical EBITDA via resolveConceptValue's override overlay.
          // ‡ F1.e — Net profit RON on the tile reads engine canonical
          // `net_income_statutory` (the ct.121 anchor) so the magnitude
          // and the margin agree. Order of preference:
          //   1. engine `net_income_statutory` (canonical, always when v2.1)
          //   2. FE `pl.netProfitStatutory` (operational + 722, only ≠
          //      operational when capitalized own-work is present)
          //   3. FE `pl.netProfit` (operational; final fallback)
          const niStatRow = remotePeriod.metrics.find(
            (mt) => mt.name === "net_income_statutory",
          );
          const tileNetProfitRon =
            typeof niStatRow?.value === "number"
              ? niStatRow.value
              : typeof pl.netProfitStatutory === "number"
                ? pl.netProfitStatutory
                : pl.netProfit;
          // (F6.0.4) netMarginPct removed — net margin is now an addable
          // configurable card; resolveConceptValue computes it from the
          // canonical net-profit override so the basis stays consistent.
          // Honest source label. Trial balance + statutory F30+F10 produce
          // similar but NOT identical metrics (711 inventory variation is
          // explicit in TB, aggregated inside the F30 operating result).
          // Per the spec's "ONE HONEST CAUTION": never let the UI pretend
          // they're interchangeable.
          const sourceTooltip =
            remotePeriod.detectedType === "statutory_f30_f10"
              ? "Source: statutory statement (Formular F30 + F10). Aggregate-only — no per-account drilldown."
              : remotePeriod.detectedType === "trial_balance"
                ? "Source: trial balance. Full account-level granularity."
                : null;
          return (
            <div title={sourceTooltip ?? undefined}>
              {/* F6.1 — Demo banner: only when the active period is the
                  fictional Meridian demo (public/marketing surface). "Upload
                  yours" opens the same file picker; a real upload replaces
                  the demo. Renders nothing once the visitor has their own
                  data loaded. */}
              {isDemoPeriod && (
                <DemoBanner onUpload={() => fileRef.current?.click()} />
              )}
              {/* F6.0.4 (2026-06-20) — Configurable dashboard.
                  Replaces the legacy fixed 4-tile KPI strip with a
                  user-configurable card grid. The first four default
                  cards (operating_revenue, ebitda, net_profit,
                  total_debt) receive canonical value OVERRIDES so they
                  render byte-identical to the pre-F6.0.4 tiles — the
                  engine-routed EBITDA + net-profit numbers, not the raw
                  snapshot. Additional cards the user adds resolve from
                  the ReportingMetrics snapshot. Wrapped in
                  DashboardProvider for the per-user layout store.
                  F6.1 — DashboardViewProvider adds the Snapshot/Trend
                  toggle; `series` feeds the per-card sparklines. */}
              <DashboardProvider>
                <DashboardViewProvider>
                  <ConfigurableDashboard
                    overrides={{
                      operating_revenue: totalOperatingRevenue,
                      ebitda: tileEbitdaRon,
                      net_profit: tileNetProfitRon,
                      total_debt: totals.totalDebt,
                    }}
                    series={multiYearSeries}
                  />
                </DashboardViewProvider>
              </DashboardProvider>
              {/* Source badge — visible label so users understand why two
                  periods of the same company might carry slightly
                  different EBITDA when one was uploaded as TB and the
                  other as F30+F10. */}
              {sourceTooltip && (
                <div
                  data-testid="kpi-source-badge"
                  className="text-[10.5px] text-ink-mute mb-3 -mt-1"
                >
                  {remotePeriod.detectedType === "statutory_f30_f10"
                    ? "Source: statutory statement (Formular F30 + F10)"
                    : "Source: trial balance"}
                </div>
              )}
            </div>
          );
        })()}

        {/* Second KPI row — invoice analytics (when invoices loaded). */}
        {hasPeriodLoaded && invoices && invoices.length > 0 && <InvoiceKpiStrip invoices={invoices} />}

        {/* Server-generated CFO briefing. Only renders when the active period
            came from the pipeline (Opus 4.7 narrate stage). Empty for samples.
            Currency-aware: when the TopHeader currency toggle ≠ RON, we POST
            /briefing/regenerate?currency=X so the prose says "€1.6M revenue"
            instead of "8.1M RON". The regenerated text isn't persisted —
            stays in component state until the next toggle. */}
        {hasPeriodLoaded && remotePeriod.briefing && remotePeriod.id && (
          <CFOBriefingCard
            periodId={remotePeriod.id}
            baseBriefing={remotePeriod.briefing}
          />
        )}
        <div className={hasPeriodLoaded ? "mb-8" : ""} />

        <Tabs value={activeTab} onValueChange={onTabChange} className="w-full">
          {/* Phase F: every tab is always visible — disabled tabs render with
              the same width but at 45% opacity, cursor-not-allowed, and a
              tooltip explaining the data needed to enable them. The user
              can see the platform's full capability surface on first visit. */}
          <div className="relative">
            <TabsList
              data-testid="tabs-list"
              className="
                bg-bg-2/40 backdrop-blur-sm
                border border-rule
                rounded-2xl p-1.5 h-auto
                flex flex-nowrap sm:flex-wrap gap-0.5
                overflow-x-auto sm:overflow-visible scrollbar-none
                shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_1px_2px_rgba(0,0,0,0.04)]
              "
            >
              {tabs.map((t) => {
                const isEnabled = enabled[t.id];
                if (isEnabled) {
                  return (
                    <TabsTrigger
                      key={t.id}
                      value={t.id}
                      data-testid={`tab-${t.id}`}
                      className="
                        shrink-0 px-3.5 py-1.5 text-[12.5px] font-medium
                        text-ink-soft hover:text-ink
                        data-[state=active]:text-ink data-[state=active]:font-semibold
                        data-[state=active]:bg-surface
                        data-[state=active]:shadow-[0_1px_2px_rgba(0,0,0,0.06),0_0_0_1px_hsl(var(--rule-strong)/0.4)]
                        data-[state=active]:ring-1 data-[state=active]:ring-inset data-[state=active]:ring-brand/10
                        rounded-xl whitespace-nowrap
                        transition-all duration-150
                      "
                    >
                      {t.label}
                    </TabsTrigger>
                  );
                }
                // Disabled tab — Radix won't fire tooltip events on a
                // disabled trigger, so we render a styled span lookalike
                // and wrap it in <Tooltip>.
                return (
                  <Tooltip key={t.id}>
                    <TooltipTrigger asChild>
                      <span
                        role="tab"
                        aria-disabled="true"
                        data-testid={`tab-${t.id}`}
                        className="
                          shrink-0 px-3.5 py-1.5 text-[12.5px] font-medium
                          rounded-xl whitespace-nowrap
                          opacity-40 cursor-not-allowed select-none text-ink-soft
                        "
                      >
                        {t.label}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-[280px] text-[12px] leading-snug">
                      {disabledHint(t.id)}
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </TabsList>
            <div aria-hidden className="sm:hidden pointer-events-none absolute inset-y-1 left-0 w-6 bg-gradient-to-r from-bg to-transparent" />
            <div aria-hidden className="sm:hidden pointer-events-none absolute inset-y-1 right-0 w-6 bg-gradient-to-l from-bg to-transparent" />
          </div>

        {/* OVERVIEW ─────────────────────────────────────────────────────── */}
        <TabsContent value="overview" className="mt-6 space-y-6">
          {/* DocumentSwitcher — single control listing every analyzed
              document (trial-balance + public-records uploads) with
              type badges and per-entry delete. Picking an entry sets
              ?period= / ?doc= which the existing useActivePeriod hook
              + Multi-Year History page consume. Renders nothing when
              the org has no analyses yet (so the upload hero is the
              only thing visible on a brand-new account). */}
          <DocumentSwitcher className="max-w-[480px]" />

          {/* F3.11 — Source-data quality WARN banner. Renders only when
              `sourceDataQuality.warn === true` (closing-side imbalance >2%)
              — see SourceQualityBanner for the hide-when-OK logic. Placed
              above ExtractionConfidenceBanner so source-data issues are
              the FIRST thing the operator sees on a problematic upload.

              F3.14 B1 — When telemetry is genuinely missing AND the period
              DOES have meaningful TB data (statements is loaded), surface
              the quiet "n/a" pill explaining that source-quality is RAS-
              specific and pointing to the BS reconciliation rec instead.
              Per ADR-1 in ADR_F3_14_DEFERRED_ITEMS.md. The `telemetryAvailable`
              flag is false ONLY when statements exist but sourceDataQuality
              doesn't — i.e., Claude-path upload (EEI PDFs, etc.). Pre-load
              and dataless states still show no banner. */}
          <SourceQualityBanner
            sourceQuality={sourceDataQuality}
            currency={statements?.currency ?? "RON"}
            telemetryAvailable={!statements ? true : sourceDataQuality !== null}
          />

          {parseSource && <ExtractionConfidenceBanner source={parseSource} />}

          {!hasPeriodLoaded ? (
            // STATE A — entry surface. Upload zone + sample picker.
            // While a pipeline run is in flight, swap the dropzone for an
            // in-place progress card so the user sees the analysis is
            // happening without leaving the page.
            //
            // ABOVE the dropzone, we surface the user's most recent public-
            // records upload (listafirme.ro / termene.ro / firme.info PDF)
            // as a Level-1 quick card. Without this, returning users who
            // only uploaded a public-summary PDF see an empty dashboard
            // even though their data is parsed and available. The card
            // renders nothing when there's no public-records data — so
            // first-time visitors still see the clean upload hero.
            uploadInFlight ? (
              <InlineErrorBoundary
                tag="UploadProgressInline"
                label="Upload progress display crashed. Your file is still being processed on the server — click Reset to dismiss this and let the dashboard refresh on its own."
                onReset={() => clearUpload()}
              >
                <UploadProgressCard inflight={uploadInFlight} statements={statements} />
              </InlineErrorBoundary>
            ) : (
              <>
                <PublicRecordsQuickCard />
                <UploadAndSamplePanel
                  statements={statements}
                  activeSampleId={activeSampleId}
                  uploadName={uploadName}
                  onPickSample={pickSample}
                  onReset={undefined}
                  onTriggerFile={() => fileRef.current?.click()}
                  onDrop={onDrop}
                  fileRef={fileRef}
                  onFileChosen={onFileChosen}
                />
              </>
            )
          ) : (
            <StateBOverview
              statements={statements}
              invoices={invoices}
              ratios={ratios}
              recommendations={recommendations}
              criticalCount={criticalCount}
              highCount={highCount}
              onJumpToTab={onTabChange}
              valuation={remotePeriod.valuation}
              periodId={remotePeriod.id}
              canonicalMargins={dashboardCanonicalMargins}
              netIncomeStatutory={canonicalNetIncomeStatutory}
            />
          )}
        </TabsContent>

        {/* P&L ──────────────────────────────────────────────────────────── */}
        {enabled.pl && statements && (
          <TabsContent value="pl" className="mt-6 space-y-8 min-h-[400px]">
            <PLStatementView
              statement={pickPLBuilder(
                {
                  lineItems: remotePeriod.lineItems,
                  entity: statements.companyName ?? "Entity",
                  period: statements.periodLabel,
                  currency: statements.currency,
                  // F1.e — Engine-canonical margin pair so the Key Margins
                  // block on the P&L tab collapses to 2 rows matching the
                  // dashboard tile and the Ratios tab.
                  canonicalMargins: dashboardCanonicalMargins,
                },
                statements,
              )}
            />
            {/* Server-emitted, period-keyed notes & recommendations
             *  rendered as part of the P&L tab. Honest empty-state when
             *  the engine produced none for this period — never filler. */}
            <StatementNotes
              recommendations={remotePeriod.recommendations}
              alerts={remotePeriod.alerts}
              relevantTo="pl"
            />
          </TabsContent>
        )}

        {/* BALANCE SHEET ───────────────────────────────────────────────── */}
        {enabled.balance_sheet && statements && (
          <TabsContent value="balance_sheet" className="mt-6 space-y-8 min-h-[400px]">
            {remotePeriod.lineItems && remotePeriod.lineItems.length > 0 ? (
              <BSStatementView
                statement={buildBSStatement({
                  lineItems: remotePeriod.lineItems,
                  entity: statements.companyName ?? "Entity",
                  asOf: statements.periodLabel ?? "Period end",
                  comparativeDate: "Opening",
                  currency: statements.currency,
                  // F1.n — Anchor "Current year net profit (121)" to the
                  // STATUTORY ct.121 closing balance, not the FE-recomputed
                  // operational net profit. The engine emits this as the
                  // `net_income_statutory` calculated metric (already
                  // plumbed in F1.e as `canonicalNetIncomeStatutory`).
                  // Fallback chain handles older cached periods that
                  // lack the canonical row: FE statutory (operational +
                  // 722) → FE operational (the prior behavior).
                  currentYearNetProfit:
                    canonicalNetIncomeStatutory
                    ?? buildPLStatementFromAggregates(statements).netProfitStatutory
                    ?? buildPLStatementFromAggregates(statements).netProfit,
                  // F2.1 — Engine canonical `assembled_bs` for top-level
                  // totals + per-engine-bucket residual surfacing. When
                  // present, BS totals match engine to the cent and any
                  // FE row-enumeration gap renders as a labeled "Other
                  // [bucket]" line. Falls back to legacy FE-recompute
                  // behavior when assembled_bs absent (pre-v2.1 cached
                  // periods).
                  assembledBs: (statements as Statements & {
                    assembled_bs?: Record<string, number>;
                  }).assembled_bs,
                })}
              />
            ) : (
              <BalanceSheetTable statements={statements} />
            )}
            <StatementNotes
              recommendations={remotePeriod.recommendations}
              alerts={remotePeriod.alerts}
              relevantTo="bs"
            />
          </TabsContent>
        )}

        {/* CASH FLOW ──────────────────────────────────────────────────── */}
        {enabled.cash_flow && statements && (
          <TabsContent value="cash_flow" className="mt-6 space-y-8 min-h-[400px]">
            <CashFlowStatementView
              statement={buildCashFlowStatement({
                pl: (statements as Statements & { assembled_pl?: Record<string, number> }).assembled_pl,
                bs: (statements as Statements & { assembled_bs?: Record<string, number> }).assembled_bs,
                cf: (statements as Statements & { assembled_cf?: Record<string, number> }).assembled_cf,
                lineItems: remotePeriod.lineItems ?? [],
                entity: statements.companyName ?? "Entity",
                period: statements.periodLabel ?? "Period",
                currency: statements.currency,
                yearLabel: (() => {
                  const lbl = statements.periodLabel ?? "";
                  const m = lbl.match(/\b(20\d{2})\b/);
                  return m ? m[1] : "the period";
                })(),
              })}
            />
            <StatementNotes
              recommendations={remotePeriod.recommendations}
              alerts={remotePeriod.alerts}
              relevantTo="cf"
            />
          </TabsContent>
        )}

        {/* RATIOS ──────────────────────────────────────────────────────── */}
        {enabled.ratios && ratios && (
          <TabsContent value="ratios" className="mt-6 space-y-8 min-h-[400px]">
            <RatiosTabContent ratios={ratios} statements={statements} />
          </TabsContent>
        )}

        {/* Customers / Payments / Margin / VAT tabs removed in the
            9-tab restructure — non-FMCG companies (the majority of users)
            don't benefit from them; the relevant signals (margin metrics,
            VAT compliance) now surface on the Overview KPI strip and
            the Recommendations card stack. Old `?tab=customers|payments|
            margin|vat` URLs redirect to a sensible tab via
            `resolveActiveTab`'s legacy-slug map. */}

        {/* VALUATION — Primary: EV/EBITDA peer-multiple. Cross-checks: DCF +
            WACC + Graham (client-side math, demoted from headline). The new
            ValuationSection also renders on the Overview tab as the hero,
            so visiting this tab is for users who want to drill into the
            cross-checks themselves. */}
        {enabled.valuation && statements && (
          <TabsContent value="valuation" className="mt-6 space-y-10 min-h-[400px]">
            {/* ── Phase 2: EBITDA-multiple primary for ~99% of companies
             *  (operating businesses, Core EBITDA basis, client-side
             *  slider). Heavy-RE → NAV primary, EBITDA-multiple second
             *  with an on-screen reason banner. DCF + Graham collapsed
             *  into a single Cross-checks disclosure, default closed.
             *  Method routing reuses the engine's existing CRE signal
             *  (industry name + rental-dominated heuristic + the
             *  PeriodValuation.primary_method field) — no parallel
             *  detector. */}
            {(() => {
              // Robust CRE detection — handles all the forms the upstream
              // payload uses (industry_key snake_case, display name,
              // Romanian display) + rental-dominated revenue heuristic.
              const indRaw = String(statements.industry ?? remotePeriod.industry ?? "").toLowerCase();
              const indNorm = indRaw.replace(/[^a-z]/g, "");
              const explicitCre =
                indNorm.includes("realestate") ||
                indNorm.includes("commercialrealestate") ||
                indNorm.includes("residentialrealestate") ||
                indNorm.includes("investitiiimobiliare") ||
                indNorm.includes("imobiliar");
              const apForRouting = (statements as Statements & { assembled_pl?: Record<string, number> }).assembled_pl;
              let rentalDominated = false;
              if (apForRouting) {
                const rev = apForRouting.revenue ?? 0;
                const totalOp = apForRouting.total_operating_revenue ?? rev;
                rentalDominated = totalOp > 0 && rev / totalOp > 0.5 &&
                  (apForRouting.capitalized_own_work_memo ?? 0) > 100_000;
              }
              // Asset-intensity fallback signal (PPE + investment_property
              // + CIP) / total assets ≥ 0.6 — used to surface the heavy-RE
              // reason line when the industry label is missing or wrong.
              const abForRouting = (statements as Statements & { assembled_bs?: Record<string, number> }).assembled_bs;
              const ASSET_INTENSITY_THRESHOLD = 0.6;
              let assetIntensity: number | null = null;
              if (abForRouting && (abForRouting.total_assets ?? 0) > 0) {
                const heavyAssets =
                  (abForRouting.ppe_net ?? 0) +
                  (abForRouting.investment_property ?? 0) +
                  (abForRouting.cip ?? 0);
                assetIntensity = heavyAssets / abForRouting.total_assets;
              }
              const assetIntensityHeavy = assetIntensity !== null && assetIntensity >= ASSET_INTENSITY_THRESHOLD;
              const engineSaysAssetBased = remotePeriod.valuation?.primary_method === "asset_based";
              const isCre = explicitCre || rentalDominated || engineSaysAssetBased || assetIntensityHeavy;

              // Canonical metric object — single source of truth for
              // EBITDA / net debt. Same builder the Overview tab uses.
              const canonical = buildCanonicalMetricsFromInputs({
                assembled_pl: apForRouting as Record<string, number> | undefined,
                assembled_bs: abForRouting as Record<string, number> | undefined,
                line_items: remotePeriod.lineItems,
                company: statements.companyName ?? null,
                period: statements.periodLabel ?? null,
                period_id: remotePeriod.id,
                source: "trial_balance",
              });

              if (isCre) {
                const ap = apForRouting;
                const ab = abForRouting;
                const sa = (statements as Statements & { subAggregates?: Record<string, number> }).subAggregates;
                if (ap && ab) {
                  const cascade = buildNavCascade({
                    pl: ap,
                    bs: ab,
                    subAgg: sa,
                    lineItems: remotePeriod.lineItems ?? [],
                    industry: indRaw,
                  });

                  // Build the reason lines — surface WHY NAV is primary
                  // so the routing isn't silent.
                  const reasonLines: string[] = [];
                  if (explicitCre) reasonLines.push(`Industry classified as real-estate (${indRaw}).`);
                  if (rentalDominated) reasonLines.push("Revenue is rental-dominated (account 706 ≥ 50% of operating revenue).");
                  if (engineSaysAssetBased) reasonLines.push("Engine valuation pipeline already routed this period to asset-based primary.");
                  if (assetIntensityHeavy && assetIntensity !== null) {
                    reasonLines.push(`Asset intensity ${(assetIntensity * 100).toFixed(0)}% (PPE + investment property + CIP / total assets) is above the ${(ASSET_INTENSITY_THRESHOLD * 100).toFixed(0)}% threshold for heavy-RE routing.`);
                  }

                  return (
                    <>
                      <HeavyReReasonBanner reasonLines={reasonLines} />
                      {/* NAV cascade — PRIMARY for CRE */}
                      <NavValuationView
                        cascade={cascade}
                        entity={statements.companyName ?? "Entity"}
                        period={statements.periodLabel ?? "Period"}
                        currency={statements.currency}
                      />
                      {/* EBITDA-multiple SECOND — still visible because
                       *  lenders + brokers reference it, but explicitly
                       *  framed as the secondary method. */}
                      {canonical && (
                        <section className="space-y-3">
                          <header>
                            <div className="text-[10.5px] uppercase tracking-[0.14em] text-ink-mute font-semibold">
                              Secondary · EBITDA-multiple cross-check
                            </div>
                          </header>
                          <EbitdaMultiplePrimaryCard
                            metrics={canonical}
                            valuation={remotePeriod.valuation}
                            currency={statements.currency}
                          />
                        </section>
                      )}
                      {/* Existing persisted-override flow remains
                       *  available as the operator-facing tuning UI. */}
                      {remotePeriod.valuation && remotePeriod.id && (
                        <ValuationCrossChecksDisclosure>
                          <ValuationSection
                            valuation={remotePeriod.valuation}
                            periodId={remotePeriod.id}
                            currency={statements.currency}
                          />
                        </ValuationCrossChecksDisclosure>
                      )}
                    </>
                  );
                }
              }

              // ── Non-CRE: EBITDA-multiple is PRIMARY ──────────────
              // Canonical-aware client-side primary card on top,
              // existing persisted-override ValuationSection follows
              // (for users who want to set board-grade assumptions),
              // then DCF + Graham collapsed into Cross-checks.
              return (
                <>
                  {canonical && (
                    <>
                      <EbitdaMultiplePrimaryCard
                        metrics={canonical}
                        valuation={remotePeriod.valuation}
                        currency={statements.currency}
                      />
                      {/* Itemized 758 → 781 → Core bridge anchor — the
                       *  provenance line in the primary card jumps here. */}
                      <div id="ebitda-bridge">
                        <EbitdaReconciliationPanel metrics={canonical} currency={statements.currency} />
                      </div>
                    </>
                  )}

                  {/* Existing persisted-override flow — operator-tuning
                   *  surface, kept for board-grade assumption setting. */}
                  {remotePeriod.valuation && remotePeriod.id && (
                    <section>
                      <header className="mb-3">
                        <div className="text-[10.5px] uppercase tracking-[0.14em] text-ink-mute font-semibold">
                          Persisted assumptions
                        </div>
                        <p className="text-[12.5px] text-ink-soft mt-1 max-w-[640px]">
                          Set custom EBITDA, multiple, debt or cash for board reporting. Persists to
                          this period; the primary card above always reflects the latest canonical
                          values plus your slider position.
                        </p>
                      </header>
                      <ValuationSection
                        valuation={remotePeriod.valuation}
                        periodId={remotePeriod.id}
                        currency={statements.currency}
                      />
                    </section>
                  )}

                  {/* Cross-checks · DCF + WACC + Graham — collapsed
                   *  into a single disclosure per the Phase 2 spec.
                   *  Default closed; the user can expand to see the
                   *  intrinsic-value calculations and the >30%
                   *  divergence flag. Not deleted. */}
                  <ValuationCrossChecksDisclosure>
                    <ValuationPanel statements={statements} valuation={remotePeriod.valuation} />
                  </ValuationCrossChecksDisclosure>
                </>
              );
            })()}
          </TabsContent>
        )}

        {/* RISKS & CREDIT ──────────────────────────────────────────────── */}
        {enabled.risks && statements && (
          <TabsContent value="risks" className="mt-6 space-y-6 min-h-[400px]">
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: -8 }}>
              <GuideMeButton pageId="risk-credit" title="Risk & Credit" steps={RISK_GUIDE} />
            </div>
            <RisksPanel
              statements={statements}
              // F2.4 — engine canonical envelopes. RisksPanel reads
              // composite / letter / subscores / Piotroski from
              // assembled_metrics (30/20/15/10/10/10/5 weights, F1.h
              // letter ladder, engine-emitted piotroski).
              creditEnvelope={
                (remotePeriod.assembled_metrics as { credit?: import("@/lib/financialValuation").CreditEnvelope } | null)?.credit
              }
              piotroskiEnvelope={
                (remotePeriod.assembled_metrics as { piotroski?: import("@/lib/financialValuation").PiotroskiEnvelope } | null)?.piotroski
                ?? (statements as unknown as {
                  assembled_piotroski?: import("@/lib/financialValuation").PiotroskiEnvelope;
                }).assembled_piotroski
              }
              metricsByName={metricsByName}
            />
          </TabsContent>
        )}

        {/* RECOMMENDATIONS ─────────────────────────────────────────────── */}
        <TabsContent value="recommendations" className="mt-6 space-y-3 min-h-[400px]">
          {statements && recommendations.length > 0 && (
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 4 }}>
              <GuideMeButton pageId="recommendations" title="Recommendations" steps={RECOMMENDATIONS_GUIDE} />
            </div>
          )}
          {statements && recommendations.length > 0 ? (
            recommendations.map((rec) => (
              <RecommendationCard key={rec.id} rec={rec} currency={statements.currency} />
            ))
          ) : (
            <EmptyTabState
              title="No recommendations yet"
              body="Upload a balance sheet, P&L, or trial balance to receive prioritized recommendations."
              ctaTab="overview"
              onCta={() => onTabChange("overview")}
            />
          )}
        </TabsContent>

        {/* EXPORT ─────────────────────────────────────────────────────── */}
        <TabsContent value="export" className="mt-6 space-y-4 min-h-[400px]">
          {!statements ? (
            <EmptyTabState
              title="Nothing to export yet"
              body="Load a sample or upload a financial statement to enable HTML and Excel exports."
              ctaTab="overview"
              onCta={() => onTabChange("overview")}
            />
          ) : (
          <>
          <div className="rounded-2xl border border-rule bg-surface p-6">
            <div className="flex items-start gap-4">
              <div className="h-10 w-10 rounded-xl bg-brand-tint text-brand-d flex items-center justify-center shrink-0">
                <FileText size={18} strokeWidth={1.75} />
              </div>
              <div className="flex-1">
                <h3 className="font-serif text-[18px] text-ink">HTML financial analysis report</h3>
                <p className="text-[13.5px] text-ink-soft mt-1">
                  Single-file HTML — opens in any browser, prints to PDF cleanly.
                  Includes balance sheet, P&L, all 25+ ratios with verdicts,
                  bankruptcy assessment, and prioritized recommendations.
                </p>
                <button
                  onClick={() => downloadReport(statements)}
                  className="mt-4 inline-flex items-center gap-2 h-10 px-4 rounded-lg bg-brand text-paper text-[13px] font-medium hover:bg-brand-d transition-colors"
                >
                  <ArrowDownToLine size={15} strokeWidth={2} />
                  Download report
                </button>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-rule bg-surface p-6">
            <div className="flex items-start gap-4">
              <div className="h-10 w-10 rounded-xl bg-emerald-50 text-emerald-700 flex items-center justify-center shrink-0">
                <FileSpreadsheet size={18} strokeWidth={1.75} />
              </div>
              <div className="flex-1">
                <h3 className="font-serif text-[18px] text-ink">Excel workbook</h3>
                <p className="text-[13.5px] text-ink-soft mt-1">
                  8-sheet xlsx model: cover, P&L, balance sheet, ratios, cash flow,
                  valuation (WACC + DCF + Graham), credit & risk, recommendations.
                </p>
                <button
                  onClick={() => downloadExcelReport(statements)}
                  className="mt-4 inline-flex items-center gap-2 h-10 px-4 rounded-lg bg-ink text-paper text-[13px] font-medium hover:bg-ink/90 transition-colors"
                >
                  <ArrowDownToLine size={15} strokeWidth={2} />
                  Download Excel
                </button>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-rule bg-bg-2/40 p-6">
            <div className="flex items-start gap-4">
              <div className="h-10 w-10 rounded-xl bg-bg-2 text-ink-mute flex items-center justify-center shrink-0">
                <FileText size={18} strokeWidth={1.75} />
              </div>
              <div className="flex-1">
                <h3 className="font-serif text-[18px] text-ink">PowerPoint deck</h3>
                <p className="text-[13.5px] text-ink-soft mt-1">
                  Investor-grade pptx export with cover slide, KPIs, ratios, valuation,
                  and recommendations slides arrives in the next phase.
                </p>
                <span className="mt-3 inline-flex items-center gap-1.5 text-[11.5px] uppercase tracking-[0.1em] text-ink-mute font-medium">
                  <Sparkles size={11} strokeWidth={2} />
                  Coming next
                </span>
              </div>
            </div>
          </div>
          </>
          )}
        </TabsContent>
      </Tabs>
      </TooltipProvider>

    </AppShell>
    </ReportingContextProvider>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

// Phase 5 — Friendly mapper for upload / paste error messages. Users
// shouldn't see "BadZipFile" or python tracebacks; map known patterns to
// actionable copy. Anything that doesn't match falls through unchanged.
function friendlyUploadError(detail: string | undefined | null): string {
  const d = (detail || "").toString();
  if (!d) return "Couldn't finish analysis. Please try again or contact support if it persists.";
  if (/BadZipFile|not a zip file/i.test(d)) {
    return "This looks like a legacy Excel file (.xls). The backend now reads those — try re-uploading. If you still see this, the backend may need to be restarted to pick up the latest code.";
  }
  if (/password|encrypted/i.test(d)) {
    return "This file is password-protected. Remove the password and re-upload.";
  }
  if (/CorruptedFileError|file is corrupted/i.test(d)) {
    return "This file appears to be corrupted. Try re-exporting from your accounting software.";
  }
  if (/Couldn't identify these columns|non-standard layout/i.test(d)) {
    return "This file has a non-standard column layout. Try renaming your columns to 'Cont', 'Nume Cont', 'Debit', 'Credit' and re-upload, or contact support.";
  }
  if (/empty/i.test(d) && /paste/i.test(d)) {
    return "Paste area is empty. Copy your trial balance from Excel first.";
  }
  if (/network|fetch failed|Failed to fetch/i.test(d)) {
    return "Couldn't reach the analysis backend. Check your connection or try again in a moment.";
  }
  // Pass through backend-provided detail if it looks user-facing (no
  // python traceback noise, no internal symbols).
  if (!/Traceback|File ".*\.py"|TypeError|KeyError|AttributeError/i.test(d)) {
    return d;
  }
  return "Couldn't finish analysis. Please try again or contact support if it persists.";
}

function ExtractionConfidenceBanner({
  source,
}: {
  source: {
    documentName: string;
    confidence: number | null;
    warnings: string[];
    accountCount: number | null;
  };
}) {
  // When confidence is null we don't have a real extraction metric to show.
  // Treat "unknown" as non-low (emerald) — we're not actively warning the
  // user about quality, we just don't have the number plumbed yet. Hides
  // the false "0 accounts · confidence 100%" pattern previously shipped.
  const hasConfidence = typeof source.confidence === "number";
  const hasCount = typeof source.accountCount === "number";
  const pct = hasConfidence ? Math.round((source.confidence as number) * 100) : null;
  const low = hasConfidence && (source.confidence as number) < 0.8;
  return (
    <div
      className={`rounded-2xl border px-4 py-3.5 flex items-start gap-3 ${
        low
          ? "border-amber-300/60 bg-amber-50 text-amber-800"
          : "border-emerald-300/60 bg-emerald-50 text-emerald-800"
      }`}
    >
      <Sparkles size={16} className={`mt-0.5 shrink-0 ${low ? "text-amber-600" : "text-emerald-600"}`} strokeWidth={1.75} />
      <div className="flex-1 text-[13px] leading-relaxed">
        <div>
          <strong>{low ? "Verify the extracted data" : "Extracted from"}</strong> ·{" "}
          <span className="font-mono text-[12px]">{source.documentName}</span>
          {hasCount && (
            <> · {source.accountCount} accounts</>
          )}
          {hasConfidence && (
            <> · <strong>confidence {pct}%</strong></>
          )}
        </div>
        {source.warnings.length > 0 && (
          <ul className="mt-1.5 list-disc list-inside space-y-0.5 text-[12px]">
            {source.warnings.slice(0, 5).map((w, i) => (
              <li key={i}>{w}</li>
            ))}
            {source.warnings.length > 5 && (
              <li className="opacity-60">+ {source.warnings.length - 5} more</li>
            )}
          </ul>
        )}
        {low && (
          <p className="mt-1.5 text-[12px] opacity-80">
            Some lines were inferred — open Financial statements to spot-check before sharing externally.
          </p>
        )}
      </div>
    </div>
  );
}

// ─── CFO Briefing card — currency-aware ─────────────────────────────────
// The briefing prose is generated by Opus 4.7 with numbers baked into the
// text ("8,121,590 RON revenue"). The top-bar currency toggle can't reformat
// baked text, so we re-POST to /briefing/regenerate?currency=X whenever the
// toggle changes. Server FX-converts briefing_facts before the LLM call,
// LLM re-narrates in the new currency. Loading state shows the cached RON
// briefing greyed out + a spinner so the user knows fresh prose is incoming.
function CFOBriefingCard({
  periodId,
  baseBriefing,
}: {
  periodId: string;
  baseBriefing: string;
}) {
  const display = useDisplayCurrency();
  const [text, setText] = useState<string>(baseBriefing);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset to baseline if user switches periods (different periodId)
  // OR returns to RON (the canonical persisted briefing).
  useEffect(() => {
    if (display === "RON") {
      setText(baseBriefing);
      setError(null);
    }
  }, [baseBriefing, display]);

  useEffect(() => {
    if (display === "RON") return;
    // Debounce 600ms so rapid RON→EUR→USD toggles don't fire 3 Opus calls.
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const { getSupabase } = await import("@/lib/supabase");
        const sb = getSupabase();
        const { data: session } = sb
          ? await sb.auth.getSession()
          : { data: { session: null } };
        const token = session?.session?.access_token;
        if (!token) {
          throw new Error("Not signed in");
        }
        const apiUrl =
          (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";
        const res = await fetch(
          `${apiUrl}/api/period/${periodId}/briefing/regenerate?currency=${display}`,
          { method: "POST", headers: { Authorization: `Bearer ${token}` } },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled && typeof data.briefing === "string" && data.briefing.length > 0) {
          setText(data.briefing);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [display, periodId]);

  return (
    <section className="mt-3">
      <article
        data-testid="cfo-briefing"
        className="rounded-2xl border border-brand/25 bg-brand-tint/40 p-5"
      >
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-2 text-[10.5px] uppercase tracking-[0.1em] text-brand-d font-medium">
            <Sparkles size={11} strokeWidth={2} />
            CFO briefing — Opus 4.7
            {display !== "RON" && (
              <span className="text-ink-mute normal-case tracking-normal">
                · displayed in {display}
              </span>
            )}
          </div>
          {loading && (
            <div className="flex items-center gap-1.5 text-[11px] text-ink-mute">
              <Loader2 size={12} className="animate-spin" />
              Regenerating in {display}…
            </div>
          )}
        </div>
        <p
          className={`text-[14px] text-ink leading-relaxed transition-opacity ${loading ? "opacity-60" : ""}`}
        >
          {text}
        </p>
        {error && (
          <p className="mt-2 text-[11px] text-amber-700">
            Couldn't regenerate in {display} ({error}). Showing RON version.
          </p>
        )}
        <footer className="mt-4 pt-3 border-t border-rule/60 text-[11px] italic text-ink-mute">
          Generated from automated trial-balance extraction — accuracy auto-measured
          per upload (clean uploads reconcile within 0.5%). Cross-check headline numbers
          against your source on critical decisions.
        </footer>
      </article>
    </section>
  );
}

function InvoiceKpiStrip({ invoices }: { invoices: Invoice[] }) {
  const customers = useMemo(() => customerAnalytics(invoices), [invoices]);
  const payments = useMemo(() => paymentsAnalytics(invoices), [invoices]);
  const vat = useMemo(() => vatAnalytics(invoices), [invoices]);
  const cur = invoices[0]?.currency ?? "RON";
  return (
    <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-3">
      <KpiTile
        label="Top customer share"
        value={`${(customers.top_1_share * 100).toFixed(1)}%`}
        sub={customers.customers[0]?.name?.slice(0, 26) ?? "—"}
      />
      <KpiTile
        label="DSO"
        value={`${payments.dso_days.toFixed(0)} days`}
        sub="Days sales outstanding"
      />
      <KpiTile
        label="Paid on time"
        value={`${(payments.paid_on_time_pct * 100).toFixed(0)}%`}
        sub="Of settled invoices"
      />
      <KpiTile
        label="Net VAT"
        value={`${cur} ${(vat.net_vat / 1000).toFixed(0)}K`}
        sub={vat.net_vat > 0 ? "Payable to ANAF" : "Refund position"}
      />
    </section>
  );
}

function EmptyTabState({
  title,
  body,
  ctaTab: _ctaTab,
  onCta,
}: {
  title: string;
  body: string;
  ctaTab: TabId;
  onCta: () => void;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-rule bg-bg-2/20 p-12 text-center">
      <div className="mx-auto h-12 w-12 rounded-full bg-bg-2 text-ink-mute flex items-center justify-center mb-3">
        <FileText size={20} strokeWidth={1.5} />
      </div>
      <h3 className="font-serif text-[20px] text-ink">{title}</h3>
      <p className="text-[13px] text-ink-soft mt-1 max-w-[460px] mx-auto">{body}</p>
      <button
        onClick={onCta}
        className="mt-4 inline-flex items-center gap-2 h-10 px-4 rounded-lg bg-brand text-paper text-[13px] font-medium hover:bg-brand-d transition-colors"
      >
        Pick a sample or upload
      </button>
    </div>
  );
}

// Persistent data-accuracy disclosure — rendered once at the top of the
// dashboard above the KPI tiles. Dismissable via localStorage so it doesn't
// re-nag returning users; collapses to a small "About data accuracy" link
// in the same slot once dismissed, so the disclosure is always discoverable.
//
// 2026-05-24 rewrite — replaced the hardcoded "~90%+ accurate" marketing
// claim with REAL drift-based messaging. The banner now reads three states
// from the same signals the ExtractionAccuracyBanner uses:
//   • clean    (drift < 0.5% AND source TB balanced) → green confidence:
//                "Quality checks passed — extraction accuracy XX.XX%."
//   • watch    (drift 0.5-2% OR source 0.5-2% imbalance) → amber call-out
//                naming the specific signal that's off
//   • problem  (drift > 2% OR source > 2% imbalance) → red warning
//                naming the SPECIFIC issue ("source TB has X.XX% debit /
//                credit imbalance") so the user knows what to fix
// Default copy on a CLEAN upload is confident sub-0.5% messaging; alert
// copy is reserved for periods that actually have a measurable issue. No
// more nagging clean uploads with marketing-fear claims.
interface AccuracyBannerProps {
  /** assembled_bs for the current period — provides bs_balance_delta + total_assets */
  assembledBs?: Record<string, number> | null;
  /** F3.11 source-data-quality telemetry (null on pre-F3.11 / Claude-extracted / statutory periods) */
  sourceDataQuality?: { raw_imbalance_pct: number; raw_imbalance_abs: number } | null;
}

function AccuracyBanner({ assembledBs, sourceDataQuality }: AccuracyBannerProps) {
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem("accuracy_banner_dismissed") === "true";
    } catch {
      return false;
    }
  });

  // ── Compute the measured signals ──────────────────────────────────
  const totalAssets = Number(assembledBs?.total_assets ?? 0);
  const bsDelta = Number(assembledBs?.bs_balance_delta ?? NaN);
  const bsDriftPct = isFinite(bsDelta) && totalAssets > 0
    ? (Math.abs(bsDelta) / totalAssets) * 100
    : null;
  const sourceImbalancePct = sourceDataQuality?.raw_imbalance_pct ?? null;

  // ── Severity bands ────────────────────────────────────────────────
  // CLEAN: BS reconciles within 0.5% AND source TB balanced within 0.5%
  // WATCH: either signal between 0.5% and 2%
  // PROBLEM: either signal above 2% (would noticeably affect headline numbers)
  const worstPct = Math.max(bsDriftPct ?? 0, sourceImbalancePct ?? 0);
  const band: "clean" | "watch" | "problem" | "unknown" =
    bsDriftPct === null && sourceImbalancePct === null
      ? "unknown"
      : worstPct < 0.5
      ? "clean"
      : worstPct < 2
      ? "watch"
      : "problem";

  // Dismissed → small re-open link (always discoverable per disclosure
  // discipline; never hide drift warnings even when dismissed — see below).
  if (dismissed && band === "clean") {
    return (
      <button
        type="button"
        data-testid="accuracy-banner-link"
        onClick={() => {
          try { localStorage.removeItem("accuracy_banner_dismissed"); } catch { /* private mode */ }
          setDismissed(false);
        }}
        className="inline-flex items-center gap-1 text-[11.5px] text-ink-mute hover:text-ink mb-3"
      >
        <CheckCircle2 size={11} strokeWidth={1.75} className="text-emerald-600" />
        Quality checks passed · About data accuracy
      </button>
    );
  }
  // Watch + problem bands ALWAYS render — dismissal doesn't suppress
  // real warnings. User can dismiss the green state only.

  // ── Render per band ───────────────────────────────────────────────
  const tone =
    band === "clean"
      ? {
          border: "border-emerald-300/40",
          bg: "bg-emerald-50/40 dark:bg-emerald-500/[0.06]",
          icon: <CheckCircle2 size={13} strokeWidth={1.75} className="text-emerald-600 mt-0.5 shrink-0" />,
          headline: "text-emerald-700 dark:text-emerald-500",
        }
      : band === "watch"
      ? {
          border: "border-amber-300/50",
          bg: "bg-amber-50/40 dark:bg-amber-500/[0.06]",
          icon: <Info size={13} strokeWidth={1.75} className="text-amber-600 mt-0.5 shrink-0" />,
          headline: "text-amber-700 dark:text-amber-500",
        }
      : band === "problem"
      ? {
          border: "border-alert/50",
          bg: "bg-alert/[0.06] dark:bg-alert/[0.08]",
          icon: <AlertCircle size={13} strokeWidth={1.75} className="text-alert mt-0.5 shrink-0" />,
          headline: "text-alert",
        }
      : {
          border: "border-rule",
          bg: "bg-bg-2/40",
          icon: <Info size={13} strokeWidth={1.75} className="text-ink-mute mt-0.5 shrink-0" />,
          headline: "text-ink",
        };

  return (
    <div
      data-testid="accuracy-banner"
      data-band={band}
      className={`flex items-start justify-between gap-3 mb-3 rounded-lg border-l-[3px] ${tone.border} ${tone.bg} px-4 py-3`}
    >
      <div className="flex items-start gap-2.5 text-[12.5px] leading-relaxed text-ink-soft">
        {tone.icon}
        <div>
          {band === "clean" && (
            <>
              <strong className={tone.headline}>Quality checks passed.</strong>{" "}
              Extraction reconciles within <strong>{(Math.floor(worstPct * 100) / 100).toFixed(2)}%</strong>{" "}
              on this document (target: under 0.5%). Balance sheet balances; source debits and credits agree.
              Headline figures (revenue, EBITDA, net profit, debt, equity) are safe to use —
              cross-check on board-level / external decisions out of habit.
            </>
          )}
          {band === "watch" && (
            <>
              <strong className={tone.headline}>Verify before external use.</strong>{" "}
              {sourceImbalancePct !== null && sourceImbalancePct >= 0.5 ? (
                <>
                  Your source trial balance has a{" "}
                  <strong>{sourceImbalancePct.toFixed(2)}% debit / credit imbalance</strong>{" "}
                  (small, but not zero).{" "}
                </>
              ) : null}
              {bsDriftPct !== null && bsDriftPct >= 0.5 ? (
                <>
                  Reconstructed balance sheet drifts <strong>{bsDriftPct.toFixed(2)}%</strong> from total assets.{" "}
                </>
              ) : null}
              Cross-check headline numbers (revenue, EBITDA, net profit, debt, equity)
              against your source before board reports or external submissions.
            </>
          )}
          {band === "problem" && (
            <>
              <strong className={tone.headline}>Data quality issue — don't use figures externally without fixing.</strong>{" "}
              {sourceImbalancePct !== null && sourceImbalancePct >= 2 ? (
                <>
                  Your source trial balance has a{" "}
                  <strong>{sourceImbalancePct.toFixed(2)}% debit / credit imbalance</strong>{" "}
                  (debits don't equal credits) — re-export from your accounting system after running its trial-balance reconciliation.{" "}
                </>
              ) : null}
              {bsDriftPct !== null && bsDriftPct >= 2 ? (
                <>
                  The reconstructed balance sheet differs from your assets by{" "}
                  <strong>{bsDriftPct.toFixed(2)}%</strong> — accounts may be missing or misclassified.{" "}
                </>
              ) : null}
              Headline numbers below (revenue, EBITDA, net profit, debt, equity) may not match your source.
              Resolve the source-data issue before any external use.
            </>
          )}
          {band === "unknown" && (
            <>
              <strong className={tone.headline}>About data accuracy.</strong>{" "}
              Each upload is auto-checked against its source trial balance. Clean uploads pass with under
              0.5% drift; if anything is off, you'll see a specific warning here naming the issue
              (source imbalance, account misclassification, etc.). Headline numbers are always safe to
              cross-check against your source.
            </>
          )}
        </div>
      </div>
      {band === "clean" && (
        <button
          type="button"
          aria-label="Dismiss accuracy notice"
          data-testid="accuracy-banner-close"
          onClick={() => {
            try { localStorage.setItem("accuracy_banner_dismissed", "true"); } catch { /* private mode */ }
            setDismissed(true);
          }}
          className="text-ink-mute hover:text-ink shrink-0 text-[16px] leading-none px-1"
        >
          ×
        </button>
      )}
      {/* watch + problem bands intentionally NOT dismissible — they're
          real signals about THIS document, not a marketing nag. */}
    </div>
  );
}

// Statutory-format limitation banner — fires only when the active
// period's source document was detected as an ANAF Formular F30+F10
// filing rather than a raw trial balance. F30+F10 carries aggregate
// totals only, so a chunk of the platform (line-item drilldown, 711
// inventory variation memo, SKU rollups) isn't available. We surface
// that honestly here so the user doesn't think the missing tabs are
// a bug.
function StatutoryFormatBanner() {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      data-testid="statutory-format-banner"
      className="mb-3 rounded-lg border-l-[3px] border-blue-400 bg-blue-50/40 dark:bg-blue-500/[0.06] px-4 py-3"
    >
      <div className="flex items-start gap-2.5 text-[12.5px] leading-relaxed text-ink-soft">
        <Info size={13} strokeWidth={1.75} className="text-blue-600 mt-0.5 shrink-0" />
        <div className="flex-1">
          <strong className="text-ink">Statutory format detected (Formular F30 + F10).</strong>{" "}
          Headline figures (revenue, EBITDA, debt, equity) extracted from your filed
          financial statements.
          <button
            type="button"
            data-testid="statutory-banner-toggle"
            onClick={() => setExpanded((v) => !v)}
            className="ml-1 text-[12px] text-blue-700 hover:text-blue-900 underline-offset-2 hover:underline"
          >
            {expanded ? "Hide details" : "What's not available with this format"}
          </button>
          {expanded && (
            <>
              <ul className="mt-2 list-disc pl-5 text-[12px] space-y-0.5">
                <li>Per-account drilldown (only aggregate categories)</li>
                <li>SKU-level analysis (requires a sales export)</li>
                <li>Working-capital roll-forward at account level</li>
                <li>Inventory variation memo (account 711) split-out</li>
              </ul>
              <p className="mt-2 text-[12px]">
                For deeper analysis, upload your raw trial balance from your accounting software.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function KpiTile({
  label,
  value,
  sub,
  ...rest
}: {
  label: string;
  /** Accepts string (legacy) OR ReactNode (preferred — lets callers pass
   *  <Money> which subscribes to currency context and re-renders live
   *  when the user toggles RON / EUR / USD). */
  value: React.ReactNode;
  sub?: React.ReactNode;
} & React.HTMLAttributes<HTMLDivElement>) {
  // FIT-1 (2026-06-08) — `overflow-hidden` + `min-w-0` lets the tile
  // shrink to fit its grid cell so a long RON / EUR currency string
  // inside doesn't blow out the column. `num-hero-fluid` clamps the
  // font-size between 18-30 px so the same hero number reads at full
  // size on the dashboard hero but auto-compacts in a tight 6-col row.
  return (
    <div
      className="rounded-xl border border-rule bg-surface px-4 py-3 min-w-0 overflow-hidden"
      {...rest}
    >
      <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium">{label}</div>
      <div className="mt-2 num-hero num-hero-fluid text-ink leading-none">
        {value}
      </div>
      {sub && <div className="mt-0.5 text-[11.5px] text-ink-soft leading-snug break-words">{sub}</div>}
    </div>
  );
}

// ─── Phase F: State B compact header + Replace ▾ dropdown ─────────────────

function CompactPeriodHeader({
  statements,
  invoices,
  activeSampleId,
  onPickSample,
  onTriggerFile,
  onReset,
}: {
  statements: Statements | null;
  invoices: Invoice[] | null;
  activeSampleId: string | null;
  onPickSample: (id: string, opts?: { additive?: boolean }) => void;
  onTriggerFile: () => void;
  onReset: () => void;
}) {
  const docsCount = useDocsCount();
  const companyName =
    statements?.companyName
    ?? (invoices && invoices.length > 0 ? "Invoice register" : "Loaded period");
  const periodLabel = statements?.periodLabel ?? (invoices ? `${invoices.length.toLocaleString()} invoices` : "");
  const lastAnalyzed = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

  // The Replace dropdown also offers "Add ... on top" for samples that
  // contribute a different document type than what's already loaded — that's
  // how the user assembles a full balance sheet + invoices workspace.
  const currentlyHas: DocumentType[] = [];
  if (statements) currentlyHas.push("bilant", "pl");
  if (invoices) currentlyHas.push("invoice_register");

  // 2026-05-26 (mobile fix): stack vertically on mobile so the
  // company name + period heading reads as one line instead of
  // getting squeezed by the DocsToggle + Replace dropdown.
  return (
    <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-3" data-testid="compact-period-header">
      <div className="min-w-0">
        <div className="label-eyebrow">Period loaded</div>
        <h1 className="mt-1 font-serif text-[26px] sm:text-[30px] leading-[1.15] tracking-[-0.01em] text-ink truncate max-w-[640px]">
          {companyName}
          {periodLabel && (
            <span className="text-ink-soft font-normal"> · {periodLabel}</span>
          )}
        </h1>
      </div>
      <div className="flex items-center gap-2 flex-wrap sm:shrink-0">
        <DocsToggle count={docsCount} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              data-testid="replace-period"
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-rule bg-surface text-[12.5px] font-medium text-ink hover:bg-bg-2 transition-colors"
            >
              Replace
              <ChevronDown size={13} strokeWidth={2} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium">
              Upload
            </DropdownMenuLabel>
            <DropdownMenuItem
              data-testid="replace-menu-upload"
              // Radix closes the menu on click before the synchronous
              // file-picker request fires, which on some browsers consumes
              // the user-activation context. onSelect + e.preventDefault()
              // keeps the menu open just long enough for the picker to grab
              // the activation and open.
              onSelect={(e) => {
                e.preventDefault();
                onTriggerFile();
              }}
              className="text-[12.5px] cursor-pointer"
            >
              <UploadCloud size={13} strokeWidth={1.75} className="mr-1.5" />
              Choose a file…
            </DropdownMenuItem>
            {SAMPLES_ENABLED && SAMPLE_DATASETS.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium">
                  Try a synthetic sample
                </DropdownMenuLabel>
                {SAMPLE_DATASETS.map((s) => (
                  <DropdownMenuItem
                    key={s.id}
                    data-testid={`sample-pick-${s.id}`}
                    onClick={() => onPickSample(s.id)}
                    className={`text-[12.5px] cursor-pointer ${activeSampleId === s.id ? "bg-bg-2 text-ink" : ""}`}
                  >
                    <span className="truncate">{s.label}</span>
                  </DropdownMenuItem>
                ))}
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onReset} className="text-[12.5px] cursor-pointer text-ink-soft">
              Reset (clear period)
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="hidden sm:inline text-[11.5px] text-ink-mute">Last analyzed {lastAnalyzed}</span>
      </div>
    </header>
  );
}

// ─── Phase F: State B Overview body ───────────────────────────────────────
// Sections in the order specified by §F.4:
//   1. AI summary (deterministic for now; LLM upgrade in Phase G's narrate())
//   2. Mini financial statements (BS / P&L / CF cards, top 6 lines each)
//   3. Top 3 risks · Top 3 opportunities (split from recommendations)
//   4. Footer with re-run

function StateBOverview({
  statements,
  invoices,
  ratios,
  recommendations,
  criticalCount,
  highCount,
  onJumpToTab,
  valuation,
  periodId,
  canonicalMargins,
  netIncomeStatutory,
}: {
  statements: Statements | null;
  invoices: Invoice[] | null;
  ratios: ReturnType<typeof computeRatios> | null;
  recommendations: Recommendation[];
  criticalCount: number;
  highCount: number;
  onJumpToTab: (tab: string) => void;
  valuation: import("@/lib/activePeriod").PeriodValuation | null;
  periodId: string | null;
  // F1.e — Engine-canonical margin pair plumbed in so the CFO AI Summary
  // block matches the dashboard tile and the P&L Key Margins block.
  canonicalMargins?: { ebitdaMargin: number | null; netMargin: number | null };
  // ‡ F1.e — Engine canonical statutory net profit (ct.121) so the RON
  // figure in the summary block matches the dashboard tile.
  netIncomeStatutory?: number | null;
}) {
  // 2026-05-24 — display currency threaded into the briefing snippet so
  // the "Operating revenue X with Y% EBITDA margin and net profit Z"
  // line matches whatever the user has the global toggle set to (matches
  // the KPI tiles + the Statements tables).
  const display = useDisplayCurrency();
  const ratesPayload = useRates();
  const summary = useMemo(
    () =>
      buildDeterministicSummary({
        statements,
        invoices,
        ratios,
        criticalCount,
        highCount,
        canonicalMargins,
        netIncomeStatutory,
        display,
        rates: ratesPayload.rates,
      }),
    [statements, invoices, ratios, criticalCount, highCount, canonicalMargins, netIncomeStatutory, display, ratesPayload],
  );

  // Risks = critical + high recommendations (top 3).
  // Opportunities = medium / info recommendations (top 3).
  const risks = recommendations.filter((r) => r.priority === "critical" || r.priority === "high").slice(0, 3);
  const opportunities = recommendations.filter((r) => r.priority === "medium" || r.priority === "info").slice(0, 3);

  return (
    <div className="space-y-7" data-testid="state-b-overview">
      {/* AI summary — single source of truth for Statements + Dashboard. */}
      {summary && (
        <section data-testid="ai-summary" className="rounded-2xl border border-rule bg-surface p-5">
          <div className="flex items-center gap-2 mb-2">
            <Sparkles size={13} strokeWidth={2} className="text-brand-d" />
            <h2 className="text-[11px] uppercase tracking-[0.12em] font-medium text-ink-mute">CFO AI summary</h2>
          </div>
          <p className="text-[14px] text-ink leading-relaxed">{summary}</p>
        </section>
      )}

      {/* Enterprise & Equity Value — HERO valuation section on Dashboard.
          EBITDA × peer-multiple is the headline; DCF + EV/Revenue are
          cross-checks. Renders only when the pipeline produced a
          valuations row for this period. */}
      {valuation && periodId && (
        <section data-testid="dashboard-valuation">
          <ValuationSection
            valuation={valuation}
            periodId={periodId}
            currency={statements?.currency ?? "RON"}
          />
        </section>
      )}

      {/* Top 3 risks + opportunities. */}
      {(risks.length > 0 || opportunities.length > 0) && (
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <RiskOpsList
            title="Top 3 risks"
            tone="warn"
            items={risks}
            currency={statements?.currency ?? "RON"}
            onJumpToTab={onJumpToTab}
            jumpTab="risks"
            emptyText="No critical or high-severity issues flagged."
          />
          <RiskOpsList
            title="Top 3 opportunities"
            tone="ok"
            items={opportunities}
            currency={statements?.currency ?? "RON"}
            onJumpToTab={onJumpToTab}
            jumpTab="recommendations"
            emptyText="No improvement opportunities surfaced — rerun analysis after adding more data."
          />
        </section>
      )}
    </div>
  );
}

function buildDeterministicSummary({
  statements,
  invoices,
  ratios,
  criticalCount,
  highCount,
  canonicalMargins,
  netIncomeStatutory,
  display,
  rates,
}: {
  statements: Statements | null;
  invoices: Invoice[] | null;
  ratios: ReturnType<typeof computeRatios> | null;
  criticalCount: number;
  highCount: number;
  // F1.e — Engine-canonical margin pair from calculated_metrics so this
  // summary block matches every other margin display on the dashboard.
  canonicalMargins?: { ebitdaMargin: number | null; netMargin: number | null };
  // ‡ F1.e — Engine canonical statutory net profit (ct.121) so the RON
  // figure in the summary agrees with the dashboard tile.
  netIncomeStatutory?: number | null;
  // 2026-05-24 — display currency + rates passed in from the caller's
  // useCurrency() so the summary text converts source → display alongside
  // the rest of the dashboard.
  display: Currency;
  rates: import("@/lib/rates").Rates;
}): string {
  const parts: string[] = [];
  // Compact display-currency formatter — matches the formatCurrency()
  // contract (returns "<CCY> 413.7M") but converts via the FX rates first.
  const fmtCompact = (n: number, src: string): string => {
    const converted = convertFromTo(n, src as Currency, display, rates);
    const abs = Math.abs(converted);
    let body: string;
    if (abs >= 1_000_000_000) body = `${(converted / 1_000_000_000).toFixed(2)}B`;
    else if (abs >= 1_000_000) body = `${(converted / 1_000_000).toFixed(2)}M`;
    else if (abs >= 1_000) body = `${(converted / 1_000).toFixed(0)}K`;
    else body = converted.toFixed(0);
    return `${display} ${body}`;
  };
  if (statements && ratios) {
    // Use the operating-view P&L so the summary matches the dashboard
    // KPI tiles and the Financial Statements tab. EBITDA includes the
    // 722 capitalized own-work / 767 discounts in revenue (reference
    // convention); Net profit is the statutory bottom line.
    const pl = buildPLStatementFromAggregates(statements, canonicalMargins);
    const totalOperatingRevenue = pl.sections[0]?.subtotalAmount ?? statements.incomeStatement.revenue;
    // F1.e — Prefer engine-canonical margin so summary matches the rest of
    // the page; ×100 because engine emits a ratio and the UI shows percent.
    const ebitdaMargin =
      canonicalMargins && canonicalMargins.ebitdaMargin != null
        ? canonicalMargins.ebitdaMargin * 100
        : totalOperatingRevenue > 0
          ? (pl.ebitda / totalOperatingRevenue) * 100
          : 0;
    // ‡ F1.e — Net profit RON in the summary is engine-canonical
    // `net_income_statutory` (ct.121). Falls back to `pl.netProfitStatutory`
    // / `pl.netProfit` only when the canonical row is unavailable.
    const summaryNetProfit =
      typeof netIncomeStatutory === "number"
        ? netIncomeStatutory
        : typeof pl.netProfitStatutory === "number"
          ? pl.netProfitStatutory
          : pl.netProfit;
    const dteRatio = ratios.leverage.find((r) => r.key === "debt_to_ebitda");
    parts.push(
      `Operating revenue ${fmtCompact(totalOperatingRevenue, statements.currency)} with ` +
      `${ebitdaMargin.toFixed(1)}% EBITDA margin and net profit ${fmtCompact(summaryNetProfit, statements.currency)}.`,
    );
    // Leverage paragraph — uses the same statutory EBITDA basis the
    // Overview tile renders, computed locally from canonical numerator
    // (engine `ebitda_statutory`) ÷ statement-level total debt. We do
    // NOT route through `dteRatio.value` (which reads engine
    // `calculated_metrics.debt_to_ebitda`) because that metric divides
    // by cash-view `ebitda` rather than statutory — see comment on the
    // tile rewire above for the EEI failure mode (−384× artifact).
    // FE-arithmetic fallback through `pl.ebitda` preserves graceful
    // degradation for pre-v2.1 envelopes.
    const summaryEbitdaRon =
      typeof statements.assembled_pl?.ebitda_statutory === "number"
        ? statements.assembled_pl.ebitda_statutory
        : pl.ebitda;
    if (dteRatio && summaryEbitdaRon > 0) {
      const dte = deriveTotals(statements).totalDebt / summaryEbitdaRon;
      parts.push(
        `Leverage ${dte.toFixed(2)}× Debt/EBITDA — ${
          dte > 4.5 ? "stretched, refinancing risk elevated"
          : dte > 3 ? "elevated, monitor covenants"
          : "comfortable"
        }.`,
      );
    } else if (dteRatio) {
      parts.push(
        `Leverage: EBITDA near zero — use LTV or NOI/debt-service instead of Debt/EBITDA for this asset profile.`,
      );
    }
  }
  if (invoices && invoices.length > 0) {
    const ca = customerAnalytics(invoices);
    parts.push(
      `${invoices.filter((i) => i.direction === "sale").length.toLocaleString()} sales invoices across ${ca.customer_count} customers; ` +
      `top customer ${(ca.top_1_share * 100).toFixed(1)}% of revenue.`,
    );
  }
  if (criticalCount > 0 || highCount > 0) {
    parts.push(
      `${criticalCount} critical and ${highCount} high-priority recommendation${criticalCount + highCount === 1 ? "" : "s"} require attention.`,
    );
  }
  return parts.join(" ");
}

function MiniStatements({
  statements,
  onJumpToTab,
}: {
  statements: Statements;
  onJumpToTab: (tab: string) => void;
}) {
  const t = deriveTotals(statements);
  const cur = statements.currency;
  const cf = deriveCashFlow(statements);

  // Pick the top-6 most material lines per statement. "Material" = absolute
  // amount; we want the user to see real numbers without having to open the
  // full statement.
  const bsLines = [
    ["Cash & equivalents", statements.balanceSheet.cash],
    ["Property, plant & equipment", statements.balanceSheet.propertyPlantEquipment],
    ["Accounts receivable", statements.balanceSheet.accountsReceivable],
    ["Long-term debt", statements.balanceSheet.longTermDebt],
    ["Accounts payable", statements.balanceSheet.accountsPayable],
    ["Total equity", t.totalEquity],
  ] as const;
  const plLines = [
    ["Revenue", statements.incomeStatement.revenue],
    ["Operating expenses", -statements.incomeStatement.operatingExpenses],
    ["EBITDA", t.ebitda],
    ["D&A", -statements.incomeStatement.depreciationAmortization],
    ["Interest expense", -statements.incomeStatement.interestExpense],
    ["Net income", t.netIncome],
  ] as const;
  const cfLines = [
    ["Net income", cf.netIncome],
    ["+ D&A", cf.depreciationAmortization],
    ["− ΔWorking capital", -cf.workingCapitalChange],
    ["Cash from ops", cf.cfo],
    ["− Capex", -cf.capex],
    ["Free cash flow", cf.fcf],
  ] as const;

  return (
    <section data-testid="mini-statements" className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <MiniCard title="Balance sheet" lines={bsLines} currency={cur} onOpen={() => onJumpToTab("statements")} />
      <MiniCard title="P&L" lines={plLines} currency={cur} onOpen={() => onJumpToTab("statements")} />
      <MiniCard title="Cash flow (derived)" lines={cfLines} currency={cur} onOpen={() => onJumpToTab("statements")} />
    </section>
  );
}

function MiniCard({
  title,
  lines,
  currency,
  onOpen,
}: {
  title: string;
  lines: ReadonlyArray<readonly [string, number]>;
  currency: string;
  onOpen: () => void;
}) {
  return (
    <div className="rounded-2xl border border-rule bg-surface overflow-hidden flex flex-col">
      <div className="px-4 py-2.5 bg-bg-2/40 border-b border-rule">
        <h3 className="text-[12px] uppercase tracking-[0.1em] text-ink-mute font-medium">{title}</h3>
      </div>
      <ul className="divide-y divide-rule/50 flex-1">
        {lines.map(([label, amount]) => (
          <li key={label} className="px-4 py-2 flex items-center justify-between gap-2 text-[12.5px]">
            <span className="text-ink-soft truncate">{label}</span>
            <span className={`tabular-nums font-medium ${amount < 0 ? "text-ink-soft" : "text-ink"}`}>
              {amount < 0 ? `(${fmtMoney(Math.abs(amount), currency)})` : fmtMoney(amount, currency)}
            </span>
          </li>
        ))}
      </ul>
      <button
        onClick={onOpen}
        className="text-[11.5px] text-brand-d hover:text-brand transition-colors px-4 py-2 border-t border-rule text-left inline-flex items-center gap-1"
      >
        View full statements
        <ArrowRight size={11} strokeWidth={2} />
      </button>
    </div>
  );
}

function RiskOpsList({
  title,
  tone,
  items,
  currency,
  emptyText,
  onJumpToTab,
  jumpTab,
}: {
  title: string;
  tone: "warn" | "ok";
  items: Recommendation[];
  currency: string;
  emptyText: string;
  onJumpToTab: (tab: string) => void;
  jumpTab: string;
}) {
  const headerColor = tone === "warn" ? "text-amber-700" : "text-emerald-700";
  return (
    <div className="rounded-2xl border border-rule bg-surface overflow-hidden">
      <div className="px-5 py-3 border-b border-rule">
        <h3 className={`text-[12px] uppercase tracking-[0.1em] font-medium ${headerColor}`}>{title}</h3>
      </div>
      {items.length === 0 ? (
        <p className="px-5 py-4 text-[12.5px] text-ink-soft">{emptyText}</p>
      ) : (
        <ul className="divide-y divide-rule/50">
          {items.map((rec) => (
            <li key={rec.id} className="px-5 py-3">
              <button
                onClick={() => onJumpToTab(jumpTab)}
                className="text-left w-full hover:bg-bg-2/40 rounded -m-1 p-1 transition-colors"
              >
                <div className="text-[13px] text-ink font-medium leading-tight">{rec.title}</div>
                <div className="text-[12px] text-ink-soft mt-0.5 line-clamp-2 leading-snug">{rec.rationale}</div>
                {rec.estimatedImpact && (
                  <div className="text-[11.5px] text-emerald-700 mt-1">
                    Estimated impact: <Money value={rec.estimatedImpact} fromCurrency={currency as Currency} compact /> / yr
                  </div>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CalloutCard({
  tone,
  title,
  body,
  metric,
  metricLabel,
}: {
  tone: "strong" | "healthy" | "watch" | "critical";
  title: string;
  body: string;
  metric?: string;
  metricLabel?: string;
}) {
  const tones: Record<string, { ring: string; chip: string; chipText: string; label: string }> = {
    strong: { ring: "border-emerald-300/60", chip: "bg-emerald-50", chipText: "text-emerald-700", label: "Strong" },
    healthy: { ring: "border-blue-300/60", chip: "bg-blue-50", chipText: "text-blue-700", label: "Healthy" },
    watch: { ring: "border-amber-300/60", chip: "bg-amber-50", chipText: "text-amber-700", label: "Watch" },
    critical: { ring: "border-red-300/60", chip: "bg-red-50", chipText: "text-red-700", label: "Critical" },
  };
  const t = tones[tone];
  return (
    <div className={`rounded-2xl border ${t.ring} bg-surface p-5`}>
      <div className="flex items-center justify-between mb-2">
        <div className="text-[11px] uppercase tracking-[0.12em] text-ink-mute font-medium">{title}</div>
        <span className={`text-[10.5px] font-semibold uppercase tracking-[0.06em] px-2 py-0.5 rounded-full ${t.chip} ${t.chipText}`}>
          {t.label}
        </span>
      </div>
      {metric && (
        <div className="mb-2">
          <div className="font-serif text-[26px] text-ink leading-tight">{metric}</div>
          {metricLabel && <div className="text-[11px] text-ink-mute uppercase tracking-[0.1em]">{metricLabel}</div>}
        </div>
      )}
      <p className="text-[13px] text-ink-soft leading-snug">{body}</p>
    </div>
  );
}

/**
 * In-flight pipeline progress card. Replaces the dropzone while an upload
 * is being analyzed so the user sees status without navigating away.
 */
function UploadProgressCard({
  inflight,
  statements,
}: {
  inflight: { docId: string; filename: string; status: import("@/lib/supabase").DocumentStatus; error?: string | null };
  /** Available once analysis completes — used to compute REAL extraction
   *  accuracy from the BS reconciliation, not the old hardcoded "90%+" claim. */
  statements?: (Statements & { assembled_bs?: Record<string, number> }) | null;
}) {
  const STAGES: Record<string, { label: string; ordinal: number }> = {
    queued:     { label: "Queued for analysis…",  ordinal: 0 },
    extracting: { label: "Reading the document…", ordinal: 1 },
    mapping:    { label: "Mapping accounts…",     ordinal: 2 },
    computing:  { label: "Computing ratios…",     ordinal: 3 },
    narrating:  { label: "Generating insights…",  ordinal: 4 },
    analyzed:   { label: "Analysis ready",        ordinal: 6 },
    failed:     { label: "Analysis failed",       ordinal: 0 },
  };
  const total = 6;
  const stage = STAGES[inflight.status] ?? { label: inflight.status, ordinal: 0 };
  const isFailed = inflight.status === "failed";
  // F3-FE-FIX-1: explicit branch for the terminal success state so the
  // header text never contradicts the stage sub-label. Without this,
  // status="analyzed" rendered the bold header "Analyzing your
  // document…" alongside the sub-label "Analysis ready" — two
  // contradictory statements in one card.
  const isAnalyzed = inflight.status === "analyzed";

  // ── Hang detector ────────────────────────────────────────────────────────
  // Show a clear "stuck" message + retry button after 60s of no progress past
  // status='queued'. The /api/pipeline/run handler should always advance to
  // 'extracting' within a second; if we're still at 'queued' a minute later
  // the worker thread never picked up the job (typically a transient backend
  // failure right at upload moment). Without this, the user stares at
  // "Step 0 of 6 · Queued for analysis…" forever with no recourse.
  const HANG_TIMEOUT_MS = 60_000;
  const [hangSuspected, setHangSuspected] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const { toast } = useToast();
  useEffect(() => {
    setHangSuspected(false);
    if (inflight.status !== "queued") return;
    const t = setTimeout(() => setHangSuspected(true), HANG_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [inflight.status, inflight.docId]);

  const handleRetry = async () => {
    setRetrying(true);
    const { recoverStuckPipelines, retryPipeline } = await import("@/lib/supabase");
    // Try the watchdog first — for the common "/api/pipeline/run failed at
    // upload" case it re-enqueues without wiping the doc's row. If nothing
    // got recovered (so this doc wasn't actually stuck on a missing worker),
    // fall through to a hard retry which resets the row + re-enqueues.
    const recovered = await recoverStuckPipelines();
    let ok = (recovered?.recovered_count ?? 0) > 0;
    if (!ok && inflight.docId) ok = await retryPipeline(inflight.docId);
    setRetrying(false);
    if (ok) {
      toast({ title: "Retrying analysis", description: inflight.filename });
      setHangSuspected(false);
    } else {
      toast({
        title: "Retry failed",
        description: "Backend is unreachable. Refresh the page or try again in a moment.",
        variant: "destructive",
      });
    }
  };

  // 2026-05-26 — match the rich 6-step UI from Products page InflightCard.
  // Server statuses (extracting/mapping/computing/narrating) map onto
  // ordinals 1..4; ordinals 5..6 are visual sub-phases of `narrating`
  // (the engine doesn't emit distinct statuses for "validating BS = E+L"
  // vs "generating CFO briefing" — they happen back-to-back during the
  // final stage). Mirrors the SKU pipeline's stage count so both screens
  // feel identical.
  const STEPS: Array<{ ordinal: number; label: string; sub: string }> = [
    { ordinal: 1, label: "Reading workbook",         sub: "Picking the trial-balance sheet" },
    { ordinal: 2, label: "Detecting accounts",       sub: "Romanian RAS · IFRS chart mapping" },
    { ordinal: 3, label: "Building statements",      sub: "Balance Sheet · P&L · Cash Flow" },
    { ordinal: 4, label: "Computing ratios",         sub: "Liquidity · leverage · profitability" },
    { ordinal: 5, label: "Reconciling balances",     sub: "BS balance check · drift tolerance" },
    { ordinal: 6, label: "Generating CFO briefing",  sub: "Executive summary + recommendations" },
  ];
  const totalSteps = STEPS.length;

  return (
    <div
      data-testid="dashboard-upload-progress"
      className="
        relative overflow-hidden rounded-3xl
        border border-rule
        bg-gradient-to-br from-bg-2/40 via-surface to-surface
        ring-1 ring-inset ring-white/[0.03]
        shadow-[0_24px_48px_-30px_rgba(0,0,0,0.25)]
        px-6 sm:px-8 py-7 sm:py-8
        max-w-[760px] mx-auto
      "
    >
        <div aria-hidden className="pointer-events-none absolute -top-24 -right-20 h-56 w-56 rounded-full bg-brand/10 blur-3xl" />

        <div className="relative flex items-center justify-between gap-3 mb-3 flex-wrap">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className={`inline-flex items-center justify-center h-8 w-8 rounded-xl ${
              isFailed || hangSuspected
                ? "bg-alert/10 text-alert"
                : isAnalyzed
                ? "bg-success/10 text-success"
                : "bg-brand-tint text-brand-d"
            }`}>
              {isFailed || hangSuspected
                ? <AlertCircle size={15} strokeWidth={2} />
                : isAnalyzed
                ? <CheckCircle2 size={15} strokeWidth={2} />
                : <Loader2 size={15} strokeWidth={2.25} className="animate-spin" />}
            </span>
            <span className="text-[14.5px] font-semibold text-ink truncate">
              {isFailed
                ? "Couldn't finish analysis"
                : hangSuspected
                ? "Upload appears stuck"
                : isAnalyzed
                ? "Analysis ready"
                : "Analyzing your document…"}
            </span>
          </div>
          {!isFailed && !hangSuspected && !isAnalyzed && (
            <span className="text-[11px] text-ink-mute tabular-nums uppercase tracking-[0.08em]">
              Step {Math.max(1, stage.ordinal)} of {totalSteps}
            </span>
          )}
        </div>

        <div className="relative text-[12.5px] text-ink-soft mb-5 truncate">
          <span className="text-ink font-medium">{inflight.filename}</span>
          <span className="mx-1.5 text-ink-mute">·</span>
          <span>{stage.label}</span>
        </div>

        {!isFailed && !hangSuspected && (
          <ol className="relative space-y-3" data-testid="dashboard-upload-progress-steps">
            {STEPS.map((step) => {
              const effectiveOrdinal = isAnalyzed ? totalSteps : stage.ordinal;
              const isDone = effectiveOrdinal > step.ordinal || isAnalyzed;
              const isActive =
                !isAnalyzed
                && (effectiveOrdinal === step.ordinal
                    || (effectiveOrdinal === 0 && step.ordinal === 1));
              return (
                <li
                  key={step.ordinal}
                  className={`
                    relative flex items-start gap-3
                    transition-opacity duration-300
                    ${isDone || isActive ? "opacity-100" : "opacity-55"}
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
                  {step.ordinal < totalSteps && (
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
      {isFailed && (
        // Failed-state actions. Without these the user is trapped under
        // the full-screen overlay above (see line 697 `fixed inset-0
        // z-50`) — no way to dismiss the card means the dashboard
        // beneath is unreachable. "Upload was cancelled" (extra-doc
        // dialog dismissed), "Couldn't start analysis" (transport),
        // "Document quota reached" (429), and pipeline failures all
        // land here; Dismiss must always be available.
        <div className="mt-2 space-y-2.5">
          {inflight.error && (
            <div className="rounded-md border border-alert/30 bg-alert/5 px-3 py-2 text-[12px] text-alert">
              {inflight.error}
            </div>
          )}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => clearUpload()}
              data-testid="dashboard-upload-progress-dismiss"
              className="inline-flex items-center gap-1.5 rounded-md border border-rule bg-surface px-3 py-1.5 text-[12px] font-medium text-ink-soft hover:bg-bg-2 transition-colors"
            >
              Dismiss
            </button>
            {inflight.docId && (
              <button
                type="button"
                onClick={handleRetry}
                disabled={retrying}
                data-testid="dashboard-upload-progress-retry-failed"
                className="inline-flex items-center gap-1.5 rounded-md border border-alert/40 bg-surface px-3 py-1.5 text-[12px] font-medium text-alert hover:bg-alert/10 transition-colors disabled:opacity-50"
              >
                {retrying ? <Loader2 size={12} className="animate-spin" /> : null}
                {retrying ? "Retrying…" : "Retry analysis"}
              </button>
            )}
          </div>
        </div>
      )}
      {hangSuspected && !isFailed && (
        <div
          data-testid="dashboard-upload-progress-hang"
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
            data-testid="dashboard-upload-progress-retry"
            className="inline-flex items-center gap-1.5 rounded-md border border-alert/40 bg-surface px-3 py-1.5 text-[12px] font-medium text-alert hover:bg-alert/10 transition-colors disabled:opacity-50"
          >
            {retrying ? <Loader2 size={12} className="animate-spin" /> : null}
            {retrying ? "Retrying…" : "Retry analysis"}
          </button>
        </div>
      )}
      {!isFailed && !hangSuspected && (
        <ExtractionAccuracyBanner
          analyzed={isAnalyzed}
          assembledBs={statements?.assembled_bs}
        />
      )}
    </div>
  );
}

/**
 * Honest, measured extraction-accuracy banner. Replaces the old hardcoded
 * "Automated extraction is typically 90%+ accurate" marketing claim.
 *
 * The number shown is REAL — computed from the just-uploaded document's
 * balance-sheet reconciliation: accuracy = 100% − |bs_balance_delta| / total_assets.
 * On calibrated Romanian fixtures this lands 99.97% (Scandia 0.03% drift),
 * 100.00% (EEI), 99.00% (Sibiu 1% drift), down to 92.6% on noisier source data
 * (Carniprod 7.4% drift). Never invents a number; never rounds up.
 *
 * Three states:
 *   1. analyzing (no statements yet)         → "Measuring extraction accuracy…"
 *   2. analyzed + drift available            → green/amber/red band + real number
 *   3. analyzed but no BS data (rare legacy) → quiet "Verify key numbers" advisory
 *      (no number claim — honesty over marketing).
 */
function ExtractionAccuracyBanner({
  analyzed,
  assembledBs,
}: {
  analyzed: boolean;
  assembledBs?: Record<string, number> | null;
}) {
  // ── State 1: still analyzing ─────────────────────────────────────
  if (!analyzed) {
    return (
      <div className="mt-5 flex gap-2.5 rounded-lg border border-rule bg-bg-2/40 px-3.5 py-3 text-[12.5px] leading-relaxed text-ink-soft">
        <Loader2 size={13} strokeWidth={1.75} className="text-ink-mute mt-0.5 shrink-0 animate-spin" />
        <div>
          <strong className="text-ink">Measuring extraction accuracy…</strong>{" "}
          Computed from balance-sheet reconciliation on your document. Final
          number appears once analysis completes.
        </div>
      </div>
    );
  }

  // ── State 3: analyzed but no BS data (compute impossible) ───────
  const totalAssets = Number(assembledBs?.total_assets ?? 0);
  const bsDelta = Number(assembledBs?.bs_balance_delta ?? NaN);
  if (!isFinite(bsDelta) || totalAssets <= 0) {
    return (
      <div className="mt-5 flex gap-2.5 rounded-lg border border-rule bg-bg-2/40 px-3.5 py-3 text-[12.5px] leading-relaxed text-ink-soft">
        <Info size={13} strokeWidth={1.75} className="text-ink-mute mt-0.5 shrink-0" />
        <div>
          <strong className="text-ink">Extraction accuracy not measurable on this document.</strong>{" "}
          Verify key numbers (revenue, EBITDA, debt, equity) against your
          source before sharing or using for decisions.
        </div>
      </div>
    );
  }

  // ── State 2: analyzed + real number ─────────────────────────────
  const driftPct = (Math.abs(bsDelta) / totalAssets) * 100;
  const accuracyPct = Math.max(0, 100 - driftPct);
  // NEVER round up. Truncate to 2 decimals for the headline; if accuracy
  // is mathematically 100.00% (zero drift), show "100.00%" honestly.
  const accuracyLabel = (Math.floor(accuracyPct * 100) / 100).toFixed(2);
  const driftLabel = driftPct < 0.01
    ? "< 0.01%"
    : `${(Math.floor(driftPct * 100) / 100).toFixed(2)}%`;

  // Bands (honesty over rounding):
  //   ≥ 99.5%  → green ("strong")
  //   ≥ 97.0%  → amber ("verify")
  //   <  97%   → red   ("review carefully")
  const band: "high" | "medium" | "low" =
    accuracyPct >= 99.5 ? "high" : accuracyPct >= 97 ? "medium" : "low";

  const tone =
    band === "high"
      ? {
          border: "border-emerald-300/40",
          bg: "bg-emerald-50/40 dark:bg-emerald-500/[0.06]",
          icon: <CheckCircle2 size={13} strokeWidth={1.75} className="text-emerald-600 mt-0.5 shrink-0" />,
          headline: "text-emerald-700 dark:text-emerald-500",
        }
      : band === "medium"
      ? {
          border: "border-amber-300/40",
          bg: "bg-amber-50/30 dark:bg-amber-500/[0.06]",
          icon: <Info size={13} strokeWidth={1.75} className="text-amber-600 mt-0.5 shrink-0" />,
          headline: "text-amber-700 dark:text-amber-500",
        }
      : {
          border: "border-alert/40",
          bg: "bg-alert/5",
          icon: <AlertCircle size={13} strokeWidth={2} className="text-alert mt-0.5 shrink-0" />,
          headline: "text-alert",
        };

  const advice =
    band === "high"
      ? "Strong reconciliation. Spot-check key figures (revenue, EBITDA, debt, equity) as routine."
      : band === "medium"
      ? "Verify key figures (revenue, EBITDA, debt, equity) against your source before sharing or relying on this analysis."
      : "Review every line before sharing or using for decisions — extraction may have misclassified material amounts.";

  return (
    <div
      data-testid="extraction-accuracy-banner"
      data-accuracy-pct={accuracyLabel}
      data-band={band}
      className={`mt-5 flex gap-2.5 rounded-lg border ${tone.border} ${tone.bg} px-3.5 py-3 text-[12.5px] leading-relaxed text-ink-soft`}
    >
      {tone.icon}
      <div>
        <strong className={tone.headline}>Extraction accuracy: {accuracyLabel}%</strong>{" "}
        <span className="text-ink-soft">
          — balance sheet reconciles within{" "}
          <span className="tabular-nums">{driftLabel}</span> drift on this document.
        </span>{" "}
        {advice}
      </div>
    </div>
  );
}

function UploadAndSamplePanel({
  statements,
  activeSampleId,
  uploadName,
  onPickSample,
  onReset,
  onTriggerFile,
  onDrop,
  fileRef,
  onFileChosen,
}: {
  statements: Statements | null;
  activeSampleId: string | null;
  uploadName: string | null;
  onPickSample: (id: string) => void;
  onReset?: () => void;
  onTriggerFile: () => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  fileRef: React.RefObject<HTMLInputElement>;
  onFileChosen: (file: File) => void;
}) {
  return (
    <div className="space-y-4">
      {/* ── HERO CALLOUT — empty-state primary CTA ──────────────────────
          Two variants, picked by the PUBLIC_RECORDS_ENABLED flag:
            · Flag ON  → UploadHeroCallout: legacy listafirme.ro pitch
                          ("free in 60 seconds, Print PDF, drop here").
            · Flag OFF (current) → TrialBalanceHeroCallout: positions
                          the trial balance (balanță de verificare) as
                          THE document to upload, lists the accepted
                          formats (SAGA, WinMentor, SmartBill, etc.),
                          and offers two downloadable example XLSX
                          fixtures so the user can match the structure
                          before uploading their real export.
          Rendered only on the empty state so the dashboard isn't
          crowded once the user has data. */}
      {PUBLIC_RECORDS_ENABLED ? <UploadHeroCallout /> : <TrialBalanceHeroCallout />}

      <div className={`grid grid-cols-1 ${SAMPLES_ENABLED ? "lg:grid-cols-[1.2fr_1fr]" : ""} gap-4`}>
      {/* Upload zone — premium AI ingestion surface. Same logic, same
       *  callbacks, same hidden <input ref={fileRef}> at the page root.
       *  Only the chrome was upgraded: glass card, gradient icon,
       *  ring-glow on drag-over, refined chip styling. */}
      <div
        data-testid="upload-dropzone"
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        className="
          relative overflow-hidden
          rounded-2xl border-2 border-dashed border-rule/80
          bg-gradient-to-br from-bg-2/30 via-surface/60 to-surface/40
          backdrop-blur-sm
          p-6 sm:p-7
          flex flex-col items-center justify-center text-center
          min-h-[240px]
          hover:border-rule-strong hover:from-bg-2/50 transition-all
        "
      >
        {/* Atmospheric brand glow */}
        <div aria-hidden className="pointer-events-none absolute -top-20 -right-12 h-56 w-56 rounded-full bg-brand/8 blur-3xl" />

        <div className="relative h-12 w-12 rounded-2xl bg-gradient-to-br from-brand/20 to-brand-d/25 text-brand-d flex items-center justify-center mb-3 ring-1 ring-brand/15">
          <UploadCloud size={20} strokeWidth={1.75} />
        </div>
        <h3 className="relative text-[18px] font-semibold text-ink tracking-[-0.005em]">Upload financial documents</h3>
        <p className="relative text-[12.5px] text-ink-soft mt-1 max-w-[440px] leading-relaxed">
          PDF · XLSX · CSV · JPG · PNG — invoices, balance sheets, P&amp;L, trial balance,
          annual reports. CFO AI auto-detects the format on drop.
        </p>
        {/* Recognized invoice-export formats — visual hint for accountants. */}
        <div className="relative mt-3 flex flex-wrap items-center justify-center gap-1.5 max-w-[480px] mx-auto">
          {["SAF-T", "e-Factura XML", "SmartBill CSV", "WinMentor", "Saga", "generic CSV"].map((f) => (
            <span
              key={f}
              className="
                inline-flex items-center
                text-[10.5px] uppercase tracking-[0.08em] font-semibold
                text-ink
                bg-bg-2 border border-rule-strong
                rounded-full px-2.5 py-0.5
              "
            >
              {f}
            </span>
          ))}
        </div>
        <div className="relative mt-5 flex items-center gap-2 flex-wrap justify-center">
          <button
            onClick={onTriggerFile}
            className="
              inline-flex items-center gap-2
              h-10 px-4 rounded-lg
              bg-gradient-to-b from-brand to-brand-d text-paper text-[13px] font-medium
              shadow-[0_8px_22px_-8px_rgba(45,191,179,0.6)]
              hover:shadow-[0_10px_26px_-8px_rgba(45,191,179,0.75)]
              ring-1 ring-inset ring-white/15
              transition-all
            "
          >
            <UploadCloud size={13} strokeWidth={2} />
            Choose a file
          </button>
        </div>
        {/* Hidden <input type="file" ref={fileRef}> is rendered at page
            level so it persists across State A ↔ State B. See FinancialStatements
            root — same ref, no duplicate needed here. */}
        {uploadName && (
          <div className="mt-3 text-[11.5px] text-ink-mute">
            Received: <span className="text-ink">{uploadName}</span>
          </div>
        )}
        {/* "What happens next" — premium 5-step pipeline. Replaces the
         *  single cramped tagline with a calm visual flow that explains
         *  what CFO AI does to the uploaded file. The connector line
         *  threads through the dots so the eye reads it as a pipeline,
         *  not a tag cloud. */}
        <ol
          className="relative mt-6 w-full max-w-[560px] flex items-start justify-between gap-2"
          aria-label="Analysis pipeline"
          data-testid="upload-pipeline"
        >
          {/* Connector line — drawn behind the dots */}
          <span aria-hidden className="absolute top-3 left-3 right-3 h-px bg-gradient-to-r from-transparent via-rule to-transparent" />
          {[
            "Detect format",
            "Extract data",
            "Rebuild statements",
            "Calculate ratios",
            "Generate recs",
          ].map((label, i) => (
            <li key={label} className="relative flex-1 min-w-0 flex flex-col items-center text-center">
              <span className={`
                relative z-10 inline-flex items-center justify-center
                h-6 w-6 rounded-full
                bg-surface border border-rule
                text-[10px] font-semibold tabular-nums text-ink-soft
                shadow-[0_1px_2px_rgba(0,0,0,0.04)]
              `}>
                {i + 1}
              </span>
              <span className="mt-1.5 text-[10px] uppercase tracking-[0.08em] text-ink-mute font-medium leading-tight max-w-[80px]">
                {label}
              </span>
            </li>
          ))}
        </ol>

        {/* ── Document-type guide ──────────────────────────────────────────
            What the platform actually accepts AND where the customer can
            download each format. This block is the trust-rail that
            replaces "magical AI" with "here are the four sources, here's
            what each one unlocks". Without it, users guess what to upload
            and we get garbage extractions (PRO TV regression: a public-
            records summary stuffed into the trial-balance pipeline).      */}
        <details className="mt-5 w-full max-w-[640px] text-left" data-testid="upload-document-guide">
          <summary className="cursor-pointer text-[12.5px] font-medium text-ink-soft hover:text-ink list-none flex items-center justify-center gap-2">
            <span>What can I upload? Where do I get it?</span>
            <span className="text-[10px] text-ink-mute">▼</span>
          </summary>
          <div className="mt-3 grid sm:grid-cols-2 gap-2">
            <DocGuideCard
              title="Trial balance (balanță de verificare)"
              format="XLSX · CSV · PDF"
              shows="Per-account drilldown, full P&L + BS + cash flow reconciliation, 25+ ratios, valuation, credit score, peer benchmarks"
              where={[
                { label: "Your accounting system (SAGA, WinMentor, SmartBill, NEXTUP, CIEL, etc.)", href: null },
                { label: "Export → Balanță de verificare → XLSX or PDF (10-column SAGA format)", href: null },
              ]}
              tone="best"
            />
            {/* Public-records card gated behind PUBLIC_RECORDS_ENABLED — when
                the flag is off (current product positioning) the listafirme/
                termene/firme.info/risco entries are hidden so the doc guide
                only shows accepted-document categories. */}
            {PUBLIC_RECORDS_ENABLED && (
              <DocGuideCard
                title="Public records summary"
                format="PDF only"
                shows="Multi-year history (up to 20 years): revenue, profit, debt, equity, employees. Deterministic, no LLM. Renders in /multi-year-history."
                where={[
                  { label: "listafirme.ro/<company-slug>-<CUI>", href: "https://listafirme.ro" },
                  { label: "termene.ro/firma/<CUI>", href: "https://termene.ro" },
                  { label: "firme.info/<CUI>", href: "https://firme.info" },
                  { label: "risco.ro/cui-<CUI>", href: "https://risco.ro" },
                ]}
                tone="free"
              />
            )}
            <DocGuideCard
              title="Statutory ANAF filing"
              format="XLSX (Formular F30 + F10)"
              shows="Aggregate P&L + BS from the annual filing. Less detail than a trial balance (no account-level drilldown) but the legally certified numbers."
              where={[
                { label: "Spațiul privat virtual (ANAF) → Bilanț contabil → descarcă XLSX", href: "https://anaf.ro" },
                { label: "Your accountant's archive — the annual filing they sent to ANAF", href: null },
              ]}
              tone="ok"
            />
            <DocGuideCard
              title="Sales / trading analysis"
              format="XLSX export"
              shows="SKU-level portfolio classification (anchor / scale / watch / eliminate), DIO + capital trap detection. Renders in /products."
              where={[
                { label: "Your ERP's Trading Analysis report (XLSX)", href: null },
                { label: "Pivot of monthly sales with: SKU, volume, revenue, GM, DIO, customer category", href: null },
              ]}
              tone="ok"
            />
          </div>
          {/* The "no document handy? try listafirme.ro" footer is gated
              behind the flag (same as the doc-guide card above). When OFF,
              show neutral accepted-document guidance instead. */}
          {PUBLIC_RECORDS_ENABLED ? (
            <p className="mt-3 text-[11px] text-ink-mute leading-relaxed">
              Don't have any of these handy? <strong className="text-ink-soft">listafirme.ro</strong>{" "}
              is free and instant — search any Romanian SRL/SA by name or CUI, hit "Date de
              bilanț" → "Print PDF", drop the file above. You'll get a 20-year financial
              history in under a minute.
            </p>
          ) : (
            <p className="mt-3 text-[11px] text-ink-mute leading-relaxed">
              Trial balance (balanță de verificare) is the document that unlocks the full
              analysis. Most Romanian accounting systems export it as XLSX from{" "}
              <em>Rapoarte → Balanța de verificare</em> or equivalent. The download buttons
              at the top of the page show the two structures we accept.
            </p>
          )}
        </details>
      </div>

      {/* Sample picker — production default OFF (set VITE_ENABLE_SAMPLES=true
          for development with fictional fixtures). When disabled, the entire
          right-rail panel is omitted and the dropzone above spans full-width. */}
      {SAMPLES_ENABLED && (
      <div data-testid="sample-picker-panel" className="rounded-2xl border border-rule bg-surface p-5">
        <div className="flex items-center justify-between mb-3 gap-2">
          <h3 className="font-serif text-[16px] text-ink">Try a sample</h3>
          <div className="flex items-center gap-3">
            {statements && (
              <span className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium truncate max-w-[140px]">
                {statements.companyName}
              </span>
            )}
            {onReset && (
              <button
                type="button"
                onClick={onReset}
                className="text-[11px] text-ink-mute hover:text-ink underline-offset-2 hover:underline"
              >
                Reset
              </button>
            )}
          </div>
        </div>
        <div className="space-y-1.5">
          {SAMPLE_DATASETS.map((s) => (
            <button
              key={s.id}
              data-testid={`sample-pick-${s.id}`}
              onClick={() => onPickSample(s.id)}
              className={`w-full text-left rounded-xl px-3 py-2.5 transition-colors flex items-start gap-3 ${
                activeSampleId === s.id
                  ? "bg-brand-tint border border-brand-d/20"
                  : "bg-bg-2/40 hover:bg-bg-2 border border-transparent"
              }`}
            >
              <div className="h-8 w-8 rounded-lg bg-bg-2 text-ink-mute flex items-center justify-center shrink-0 mt-0.5">
                <Building2 size={13} strokeWidth={1.75} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium text-ink truncate">{s.label}</div>
                <div className="text-[11.5px] text-ink-soft leading-snug mt-0.5 line-clamp-2">{s.description}</div>
              </div>
              <ChevronRight size={14} strokeWidth={1.75} className="text-ink-mute mt-1.5 shrink-0" />
            </button>
          ))}
        </div>
      </div>
      )}
      </div>

      {/* Public Company Intelligence — full-bleed module card. Equal visual
          weight to the upload zone above: ticker chips, mini KPI tiles,
          premium teal CTA. Clicks route to /public-companies (hub page). */}
      <div className="mt-6">
        <PublicCompaniesLandingCard />
      </div>
    </div>
  );
}

// Trial-balance guided setup. Refined from the previous loud navy-blue
// gradient block into a premium app-native panel: deep ink card with a
// subtle brand glow, modern sans hierarchy, framed download-example
// control group. EVERY download link, label, fictional-data note, and
// data-testid is preserved verbatim — only the chrome changed.
function TrialBalanceHeroCallout() {
  return (
    <section
      data-testid="trial-balance-hero"
      className="
        relative overflow-hidden rounded-3xl
        border border-rule
        bg-surface
        text-ink
        ring-1 ring-inset ring-rule-soft
        shadow-[0_24px_48px_-30px_rgba(0,0,0,0.20)]
        px-6 sm:px-8 py-6 sm:py-7
      "
    >
      {/* Atmospheric brand glow — purely visual */}
      <div aria-hidden className="pointer-events-none absolute -top-16 -right-16 h-56 w-56 rounded-full bg-brand/25 blur-3xl" />
      <div aria-hidden className="pointer-events-none absolute -bottom-20 -left-20 h-48 w-48 rounded-full bg-brand-2/15 blur-3xl" />

      <div className="relative flex flex-col sm:flex-row items-start gap-4 sm:gap-5">
        <span className="inline-flex items-center justify-center h-11 w-11 rounded-2xl bg-gradient-to-br from-brand/25 to-brand-d/30 text-brand-d ring-1 ring-inset ring-brand/20 shrink-0">
          <FileSpreadsheet size={18} strokeWidth={1.75} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="inline-flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.16em] text-ink-soft font-semibold">
            <Sparkles size={10} strokeWidth={2.25} className="text-brand" />
            Guided setup
          </div>
          <h2 className="mt-2 text-[20px] sm:text-[22px] leading-tight font-semibold tracking-[-0.01em] m-0">
            Upload your trial balance (balanță de verificare)
          </h2>
          <p className="mt-2 text-[13.5px] sm:text-[14px] leading-relaxed text-ink-soft">
            XLSX or PDF, exported from your accounting system —{" "}
            <strong className="text-ink">SAGA</strong>,{" "}
            <strong className="text-ink">WinMentor</strong>,{" "}
            <strong className="text-ink">SmartBill</strong>,{" "}
            <strong className="text-ink">NEXTUP</strong>,{" "}
            <strong className="text-ink">CIEL</strong>. This is the document the full
            analysis is built for: P&amp;L, Balance Sheet, Cash Flow, Ratios, Valuation,
            Risk, and Recommendations are all reconstructed from it.
          </p>
          <p className="mt-2 text-[12.5px] leading-relaxed text-ink-mute">
            Not sure your export is in the right shape? Download the example below and match its
            structure (account code, account name, debit/credit columns for opening balances,
            period movements, and total sums).
          </p>

          {/* 2026-05-24 — pre-upload quality disclosure. Sets expectations
              before the user uploads: clean trial balances pass under 0.5%
              drift; anything off gets a SPECIFIC warning naming the issue
              (source imbalance, account misclassification). Replaces the
              old "~90%+ accuracy" marketing claim with the actual quality
              contract. */}
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-emerald-300/40 bg-emerald-50/30 dark:bg-emerald-500/[0.06] px-3 py-2 text-[12px] leading-relaxed text-ink-soft">
            <CheckCircle2 size={12} strokeWidth={2} className="text-emerald-600 mt-0.5 shrink-0" />
            <div>
              <strong className="text-ink">Every upload is auto-checked.</strong>{" "}
              Clean trial balances reconcile within 0.5% of source — you'll see a green
              "Quality checks passed" badge. If anything's off (source debits don't equal credits,
              accounts can't be classified, balance sheet doesn't reconcile), you'll get a specific
              warning naming the issue before you act on any number.
            </div>
          </div>
        </div>
      </div>

      <div
        className="
          relative mt-5 rounded-2xl
          bg-bg-2/60 border border-rule
          backdrop-blur-sm
          px-4 py-3
          flex flex-col sm:flex-row sm:items-center gap-3
        "
      >
        <div className="text-[10.5px] uppercase tracking-[0.14em] font-semibold text-ink-mute sm:mr-1 shrink-0">
          Download example
        </div>
        <div className="flex flex-wrap gap-2 flex-1">
          <a
            href="/examples/example_trial_balance_8col.xlsx"
            download="example_trial_balance_8col.xlsx"
            data-testid="download-example-8col"
            className="
              inline-flex items-center gap-1.5
              rounded-lg px-3 py-1.5
              text-[12.5px] font-medium text-ink
              bg-gradient-to-b from-brand-2 to-brand-2/90
              hover:from-brand-2/95 hover:to-brand-2/80
              shadow-1
              ring-1 ring-inset ring-rule
              transition-all
            "
          >
            <ArrowDownToLine size={12} strokeWidth={2} />
            Multi-column format (XLSX)
          </a>
          <a
            href="/examples/example_trial_balance_6col.xlsx"
            download="example_trial_balance_6col.xlsx"
            data-testid="download-example-6col"
            className="
              inline-flex items-center gap-1.5
              rounded-lg px-3 py-1.5
              text-[12.5px] font-medium text-ink
              bg-surface hover:bg-bg-2
              shadow-1
              ring-1 ring-inset ring-rule
              transition-all
            "
          >
            <ArrowDownToLine size={12} strokeWidth={2} />
            Standard SAGA format (XLSX)
          </a>
        </div>
        <span className="text-[10.5px] text-ink-mute sm:ml-auto sm:text-right shrink-0">
          Fictional data; demonstrates the required structure.
        </span>
      </div>
    </section>
  );
}

// Hero callout — listafirme.ro as the primary "no document?" CTA.
// Rendered ABOVE the dropzone on the empty state (UploadAndSamplePanel
// only mounts when statements is null, i.e. no analysis yet). When the
// user has data, the dashboard renders the analysis view instead and
// this hero is unmounted along with the rest of the upload panel.
// Gated by PUBLIC_RECORDS_ENABLED — preserved on disk so the listafirme
// positioning can be restored by a one-line flag flip if needed.
function UploadHeroCallout() {
  return (
    <div
      data-testid="upload-hero-callout"
      className="rounded-2xl px-6 py-6 sm:px-8 sm:py-7 text-white flex flex-col sm:flex-row items-start gap-4 sm:gap-5"
      style={{ background: "linear-gradient(135deg, #003366 0%, #1a5490 100%)" }}
    >
      <div className="text-[36px] sm:text-[42px] leading-none shrink-0" aria-hidden>
        📊
      </div>
      <div className="flex-1 min-w-0">
        <h2 className="font-serif text-[20px] sm:text-[22px] leading-tight m-0 text-white">
          No financial document? Get one free in 60 seconds.
        </h2>
        <p className="mt-2 text-[13.5px] sm:text-[14px] leading-relaxed text-white/85">
          Search any Romanian company (SRL or SA) on{" "}
          <strong className="text-white">listafirme.ro</strong> by name or CUI, open{" "}
          <strong className="text-white">"Date de bilanț"</strong>, hit{" "}
          <strong className="text-white">"Print PDF"</strong>, then drop the file below.
          You'll get a 20-year financial history analyzed in under a minute.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <a
            href="https://www.listafirme.ro"
            target="_blank"
            rel="noopener noreferrer"
            data-testid="upload-hero-cta"
            className="inline-flex items-center gap-1.5 rounded-lg px-5 py-2.5 text-[13.5px] font-semibold transition-colors"
            style={{ background: "#f39c12", color: "#1a1a1a" }}
          >
            Open listafirme.ro ↗
          </a>
          <span className="text-[11.5px] text-white/70">
            Free · Instant · No accountant needed
          </span>
        </div>
      </div>
    </div>
  );
}

// Document-guide card. One row in the "what can I upload" expandable.
// `tone` colors the left border: best (green — most data unlocked), ok
// (neutral), free (blue — free public source, frictionless onboarding).
function DocGuideCard({ title, format, shows, where, tone }: {
  title: string;
  format: string;
  shows: string;
  where: Array<{ label: string; href: string | null }>;
  tone: "best" | "ok" | "free";
}) {
  const borderClass =
    tone === "best" ? "border-l-emerald-500"
    : tone === "free" ? "border-l-blue-500"
    : "border-l-rule-strong";
  const toneBadge =
    tone === "best" ? { label: "MOST DATA", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/[0.18] dark:text-emerald-300" }
    : tone === "free" ? { label: "FREE / INSTANT", cls: "bg-blue-100 text-blue-800 dark:bg-blue-500/[0.18] dark:text-blue-300" }
    : { label: "AGGREGATE", cls: "bg-bg-2 text-ink-soft" };
  return (
    <div className={`rounded-lg border border-rule border-l-[3px] ${borderClass} bg-surface p-3 text-left`}>
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="text-[12.5px] font-medium text-ink leading-tight">{title}</div>
        <span className={`shrink-0 text-[9px] uppercase tracking-[0.06em] font-semibold px-1.5 py-0.5 rounded ${toneBadge.cls}`}>
          {toneBadge.label}
        </span>
      </div>
      <div className="text-[10.5px] uppercase tracking-[0.08em] text-ink-mute font-medium mb-1.5">{format}</div>
      <p className="text-[11.5px] text-ink-soft leading-relaxed mb-2">{shows}</p>
      <div className="text-[10.5px] uppercase tracking-[0.08em] text-ink-mute font-medium mb-1">Where to get it</div>
      <ul className="space-y-0.5">
        {where.map((w, i) => (
          <li key={i} className="text-[11.5px] text-ink-soft leading-tight">
            <span className="text-ink-mute mr-1">·</span>
            {w.href ? (
              <a href={w.href} target="_blank" rel="noopener noreferrer"
                 className="text-blue-700 dark:text-blue-300 hover:underline underline-offset-2">
                {w.label}
              </a>
            ) : (
              <span>{w.label}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// Wrapper around all 6 RatioGroupSections that owns the selected-ratio
// state and renders the premium explainer drawer. Owning state here
// keeps the Ratios surface self-contained — no upstream prop drilling,
// no global store for an interaction that's scoped to this tab.
function RatiosTabContent({ ratios, statements }: { ratios: RatioBundle; statements: Statements | null }) {
  const [selected, setSelected] = useState<Ratio | null>(null);
  return (
    <>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
        <GuideMeButton pageId="ratios" title="Ratios" steps={RATIOS_GUIDE} />
      </div>
      <RatioGroupSection title="Liquidity"                           ratios={ratios.liquidity}     onPick={setSelected} />
      <div data-guide="ratios-profitability">
        <RatioGroupSection title="Profitability"                     ratios={ratios.profitability} onPick={setSelected} />
      </div>
      <div data-guide="ratios-leverage">
        <RatioGroupSection title="Leverage"                          ratios={ratios.leverage}      onPick={setSelected} />
        <RatioGroupSection title="Coverage"                          ratios={ratios.coverage}      onPick={setSelected} />
      </div>
      <div data-guide="ratios-efficiency">
        <RatioGroupSection title="Efficiency · working capital cycle" ratios={ratios.efficiency}    onPick={setSelected} />
      </div>
      <div data-guide="ratios-risk">
        <RatioGroupSection title="Bankruptcy risk"                   ratios={ratios.bankruptcy}    onPick={setSelected} />
      </div>

      {/* Premium explainer drawer — 8 sections + related-ratio pivot.
       *  See `src/components/cfo/RatioDetailDrawer.tsx` and the
       *  knowledge map at `src/lib/ratioKnowledge.ts`. The drawer
       *  reads the company's live values from the same `ratios`
       *  bundle this tab already has, so opening it is a free
       *  client-side action — no fetch, no re-compute. */}
      <RatioDetailDrawer
        ratio={selected}
        bundle={ratios}
        statements={statements}
        onClose={() => setSelected(null)}
        onPickRelated={setSelected}
      />
    </>
  );
}

function RatioGroupSection({
  title, ratios, onPick,
}: {
  title: string;
  ratios: Ratio[];
  /** Click on any ratio tile opens the premium explainer drawer.
   *  Threaded down from the Ratios TabsContent which owns the
   *  selected-ratio state and renders the drawer. */
  onPick?: (r: Ratio) => void;
}) {
  return (
    <div>
      {/* Eyebrow-style section header matches the new global design
       *  vocabulary used elsewhere in the app (uppercase + 0.12em
       *  tracking + brand-tinted small accent). */}
      <h2 className="text-[10.5px] uppercase tracking-[0.14em] text-ink-mute font-semibold mb-3">
        {title}
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {ratios.map((r) => (
          <RatioTile key={r.key} ratio={r} onPick={onPick} />
        ))}
      </div>
    </div>
  );
}

function RatioTile({
  ratio, onPick,
}: {
  ratio: Ratio;
  onPick?: (r: Ratio) => void;
}) {
  const c = verdictColor(ratio.verdict);
  const clickable = typeof onPick === "function";
  // The tile becomes a button when clickable, keeping keyboard focus,
  // Enter/Space activation, and an aria role for AT users. When the
  // Ratios tab isn't mounted with a `onPick` (legacy callers) it
  // gracefully degrades to the static-card look.
  const Tag = (clickable ? "button" : "div") as "button" | "div";
  return (
    <Tag
      type={clickable ? "button" : undefined}
      onClick={clickable ? () => onPick!(ratio) : undefined}
      data-testid="ratio-tile"
      data-ratio-key={ratio.key}
      aria-label={clickable ? `Open ${ratio.label} detail` : undefined}
      className={`
        group relative w-full text-left
        rounded-2xl border border-rule bg-surface p-4
        transition-all duration-150
        ${clickable
          ? "hover:border-brand/30 hover:bg-surface/95 hover:shadow-[0_8px_24px_-12px_rgba(0,0,0,0.12)] focus:outline-none focus:ring-2 focus:ring-brand/30 cursor-pointer"
          : ""}
      `}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="text-[11px] uppercase tracking-[0.1em] text-ink-mute font-medium">
          {ratio.label}
        </div>
        <span
          className="text-[9.5px] font-semibold uppercase tracking-[0.06em] px-2 py-0.5 rounded-full"
          style={{ backgroundColor: c.bg, color: c.text }}
        >
          {verdictLabel(ratio.verdict)}
        </span>
      </div>
      <div className="text-[24px] font-semibold text-ink leading-tight tabular-nums tracking-[-0.005em]">
        <LearnableNumber conceptKey={ratio.key} value={ratio.value}>
          {formatRatio(ratio)}
        </LearnableNumber>
      </div>
      <div className="text-[11px] text-ink-mute mt-1">{ratio.benchmark}</div>
      <p className="text-[12px] text-ink-soft leading-snug mt-2 line-clamp-3">
        {ratio.commentary}
      </p>
      {clickable && (
        <div className="mt-2 inline-flex items-center gap-1 text-[10.5px] text-ink-mute group-hover:text-brand-d transition-colors">
          <span>Open explainer</span>
          <span aria-hidden>→</span>
        </div>
      )}
    </Tag>
  );
}

function RecommendationCard({ rec, currency }: { rec: Recommendation; currency: string }) {
  const tones: Record<string, { pillBg: string; pillText: string }> = {
    critical: { pillBg: "bg-red-600", pillText: "text-white" },
    high:     { pillBg: "bg-amber-500", pillText: "text-white" },
    medium:   { pillBg: "bg-blue-600", pillText: "text-white" },
    info:     { pillBg: "bg-ink-mute", pillText: "text-white" },
  };
  const t = tones[rec.priority];

  // F5.0 Phase 7 — expose the engine's already-computed trigger facts so the
  // reader can audit WHY the rule fired. Each fact maps to a registered
  // concept where possible; clicking the label opens the underlying
  // ratio / metric popover (not the meta-concept). No new logic — these
  // values come straight from the rule's factsCited payload.
  const factEntries = rec.factsCited
    ? Object.entries(rec.factsCited).filter(([, v]) => Number.isFinite(v))
    : [];

  const fmtFactValue = (key: string, value: number): string => {
    const k = key.toLowerCase();
    // Ratios / multiples
    if (k === "dscr" || k === "current_ratio" || k === "quick_ratio"
        || k === "cash_ratio" || k === "interest_coverage"
        || k === "net_debt_ebitda" || k === "debt_to_equity"
        || k === "debt_to_ebitda_adjusted") {
      return `${value.toFixed(2)}×`;
    }
    // Percent metrics (engine emits as decimal)
    if (k.endsWith("_margin") || k === "roe" || k === "roa" || k === "roic"
        || k === "equity_ratio" || k === "current_rate"
        || k.endsWith("_pct")) {
      // current_rate is small (0.07 = 7%); roe/margins are also decimals.
      return `${(value * 100).toFixed(1)}%`;
    }
    // Day-count metrics
    if (k === "dio" || k === "dso" || k === "dpo" || k === "ccc"
        || k.endsWith("_days")) {
      return `${Math.round(value)} days`;
    }
    // Z-score family
    if (k.startsWith("altman_z")) {
      return value.toFixed(2);
    }
    // Score family (0-9 or 0-100)
    if (k === "piotroski_f") {
      return `${value.toFixed(0)} / 9`;
    }
    // Currency-ish (debt / impact / savings / cash / revenue)
    if (Math.abs(value) >= 1_000) {
      // Use Money for currency formatting where it's a money number.
      return ""; // sentinel — rendered via <Money/> in JSX
    }
    return value.toFixed(2);
  };

  const isMoneyFact = (key: string, value: number): boolean => {
    const k = key.toLowerCase();
    if (k === "dscr" || k === "current_ratio" || k === "quick_ratio"
        || k === "cash_ratio" || k === "interest_coverage"
        || k === "net_debt_ebitda" || k === "debt_to_equity"
        || k === "debt_to_ebitda_adjusted") return false;
    if (k.endsWith("_margin") || k === "roe" || k === "roa" || k === "roic"
        || k === "equity_ratio" || k === "current_rate"
        || k.endsWith("_pct")) return false;
    if (k === "dio" || k === "dso" || k === "dpo" || k === "ccc"
        || k.endsWith("_days")) return false;
    if (k.startsWith("altman_z") || k === "piotroski_f") return false;
    return Math.abs(value) >= 1_000;
  };

  const askPrompt =
    `Explain why the recommendation "${rec.title}" fired on this dataset. ` +
    `Walk me through the trigger metric(s), how they compare to the threshold, ` +
    `and what the proposed action would change in concrete numbers. ` +
    `Cite the underlying RAS accounts where possible.`;

  return (
    <div className="rounded-2xl border border-rule bg-surface p-5" data-testid={`rec-card-${rec.id}`}>
      <div className="flex items-start gap-3 mb-2">
        <span className={`text-[10.5px] font-semibold uppercase tracking-[0.06em] px-2.5 py-1 rounded ${t.pillBg} ${t.pillText}`}>
          <LearnableRowLabel conceptKey="alert_severity">{rec.priority}</LearnableRowLabel>
        </span>
        <h3 className="font-serif text-[16.5px] text-ink leading-tight">{rec.title}</h3>
      </div>
      <p className="text-[13px] text-ink-soft mt-2"><span className="text-ink font-medium">Why:</span> {rec.rationale}</p>
      <p className="text-[13px] text-ink-soft mt-2"><span className="text-ink font-medium">Action:</span> {rec.action}</p>

      {factEntries.length > 0 && (
        <div className="mt-3 rounded-lg border border-rule/70 bg-bg-2/40 px-3 py-2">
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-soft mb-1.5">
            Triggered by
          </div>
          <ul className="space-y-1">
            {factEntries.map(([k, v]) => {
              const conceptKey = factToConceptKey(k);
              const label = factLabel(k);
              const money = isMoneyFact(k, v);
              return (
                <li
                  key={k}
                  className="flex items-baseline justify-between gap-3 text-[12.5px]"
                  data-testid={`rec-fact-${rec.id}-${k}`}
                >
                  <span className="text-ink-soft">
                    {conceptKey ? (
                      <LearnableRowLabel conceptKey={conceptKey}>{label}</LearnableRowLabel>
                    ) : (
                      label
                    )}
                  </span>
                  <span className="font-medium tabular-nums text-ink">
                    {conceptKey ? (
                      <LearnableNumber conceptKey={conceptKey} value={v}>
                        {money ? (
                          <Money value={v} fromCurrency={currency as Currency} compact />
                        ) : (
                          fmtFactValue(k, v)
                        )}
                      </LearnableNumber>
                    ) : money ? (
                      <Money value={v} fromCurrency={currency as Currency} compact />
                    ) : (
                      fmtFactValue(k, v)
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="mt-3 flex items-center gap-3 flex-wrap">
        {rec.estimatedImpact && (
          <div className="inline-flex items-center text-[11.5px] font-medium text-emerald-700 bg-emerald-50 px-3 py-1 rounded-md">
            <LearnableRowLabel conceptKey="recommendation_impact">Estimated impact</LearnableRowLabel>:{" "}
            <LearnableNumber conceptKey="recommendation_impact" value={rec.estimatedImpact}>
              <Money value={rec.estimatedImpact} fromCurrency={currency as Currency} compact />
            </LearnableNumber>
            {" "}/ year
          </div>
        )}
        <button
          type="button"
          onClick={() => openAskCfoAi(askPrompt)}
          className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-ink-soft hover:text-ink hover:bg-bg-2/60 border border-rule rounded-md px-2.5 py-1 transition-colors"
          data-testid={`rec-ask-${rec.id}`}
        >
          <Sparkles size={11} strokeWidth={2.25} />
          Ask CFO AI about this
        </button>
      </div>
    </div>
  );
}

function BalanceSheetTable({ statements }: { statements: Statements }) {
  const t = deriveTotals(statements);
  const bs = statements.balanceSheet;
  const cur = statements.currency;
  const row = (label: string, val: number, opts?: { indent?: boolean; subtotal?: boolean; total?: boolean }) => (
    <tr
      className={`${opts?.total ? "border-y-2 border-ink/20 font-semibold" : opts?.subtotal ? "bg-bg-2/40 font-semibold" : "border-b border-rule"} text-[13px]`}
    >
      <td className={`py-2 px-3 ${opts?.indent ? "pl-8 text-ink-soft" : "text-ink"}`}>{label}</td>
      <td className="py-2 px-3 text-right tabular-nums text-ink">{fmtMoney(val, cur)}</td>
    </tr>
  );
  return (
    <div className="rounded-2xl border border-rule bg-surface overflow-hidden">
      <div className="px-5 py-3 bg-bg-2/40 border-b border-rule">
        <h2 className="font-serif text-[18px] text-ink">Balance sheet · {statements.periodLabel}</h2>
      </div>
      <table className="w-full">
        <tbody>
          {row("Current assets", t.totalCurrentAssets, { subtotal: true })}
          {row("Cash & equivalents", bs.cash, { indent: true })}
          {row("Accounts receivable", bs.accountsReceivable, { indent: true })}
          {row("Inventory", bs.inventory, { indent: true })}
          {row("Other current assets", bs.otherCurrentAssets, { indent: true })}
          {row("Non-current assets", t.totalNonCurrentAssets, { subtotal: true })}
          {row("Property, plant & equipment", bs.propertyPlantEquipment, { indent: true })}
          {row("Intangibles", bs.intangibles, { indent: true })}
          {row("Other non-current assets", bs.otherNonCurrentAssets, { indent: true })}
          {row("Total assets", t.totalAssets, { total: true })}
          {row("Current liabilities", t.totalCurrentLiabilities, { subtotal: true })}
          {row("Accounts payable", bs.accountsPayable, { indent: true })}
          {row("Short-term debt", bs.shortTermDebt, { indent: true })}
          {row("Other current liabilities", bs.otherCurrentLiabilities, { indent: true })}
          {row("Non-current liabilities", t.totalNonCurrentLiabilities, { subtotal: true })}
          {row("Long-term debt", bs.longTermDebt, { indent: true })}
          {row("Other non-current liabilities", bs.otherNonCurrentLiabilities, { indent: true })}
          {row("Total liabilities", t.totalLiabilities, { subtotal: true })}
          {row("Share capital", bs.shareCapital, { indent: true })}
          {row("Retained earnings", bs.retainedEarnings, { indent: true })}
          {row("Other equity", bs.otherEquity, { indent: true })}
          {row("Total equity", t.totalEquity, { subtotal: true })}
          {row("Total liabilities + equity", t.totalLiabilitiesAndEquity, { total: true })}
        </tbody>
      </table>
    </div>
  );
}

function IncomeStatementTable({ statements }: { statements: Statements }) {
  const t = deriveTotals(statements);
  const is = statements.incomeStatement;
  const cur = statements.currency;
  const row = (label: string, val: number, opts?: { indent?: boolean; subtotal?: boolean; total?: boolean; negative?: boolean }) => (
    <tr
      className={`${opts?.total ? "border-y-2 border-ink/20 font-semibold" : opts?.subtotal ? "bg-bg-2/40 font-semibold" : "border-b border-rule"} text-[13px]`}
    >
      <td className={`py-2 px-3 ${opts?.indent ? "pl-8 text-ink-soft" : "text-ink"}`}>{label}</td>
      <td className="py-2 px-3 text-right tabular-nums text-ink">
        {opts?.negative ? `(${fmtMoney(val, cur)})` : fmtMoney(val, cur)}
      </td>
    </tr>
  );
  return (
    <div className="rounded-2xl border border-rule bg-surface overflow-hidden">
      <div className="px-5 py-3 bg-bg-2/40 border-b border-rule">
        <h2 className="font-serif text-[18px] text-ink">Profit & loss · {statements.periodLabel}</h2>
      </div>
      <table className="w-full">
        <tbody>
          {row("Revenue", is.revenue)}
          {row("Cost of goods sold", is.costOfGoodsSold, { indent: true, negative: true })}
          {row("Gross profit", t.grossProfit, { subtotal: true })}
          {row("Operating expenses", is.operatingExpenses, { indent: true, negative: true })}
          {row("Other income", is.otherIncome, { indent: true })}
          {row("EBITDA", t.ebitda, { subtotal: true })}
          {row("Depreciation & amortization", is.depreciationAmortization, { indent: true, negative: true })}
          {row("EBIT", t.ebit, { subtotal: true })}
          {row("Interest expense", is.interestExpense, { indent: true, negative: true })}
          {row("Profit before tax", t.pbt, { subtotal: true })}
          {row("Tax expense", is.taxExpense, { indent: true, negative: true })}
          {row("Net income", t.netIncome, { total: true })}
        </tbody>
      </table>
    </div>
  );
}

/** Currency-aware money formatter for the DCF / valuation tables.
 *  Routes the source-currency value through the global currency switcher
 *  (RON → EUR → USD) so toggling the top-bar updates every KpiTile +
 *  table cell that consumes the return value. */
function useFmtMoney() {
  const display = useDisplayCurrency();
  const rates = useRates();
  return (n: number, sourceCurrency: string): string => {
    if (n === null || n === undefined || !Number.isFinite(n)) return "—";
    const src = (sourceCurrency || "RON") as Currency;
    const converted = convertFromTo(n, src, display, rates.rates);
    const sign = converted < 0 ? "-" : "";
    const abs = Math.abs(converted);
    return `${sign}${display} ${abs.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  };
}

// ─── VALUATION PANEL ──────────────────────────────────────────────────────

function ValuationPanel({
  statements,
  valuation,
}: {
  statements: Statements;
  valuation: PeriodValuation | null;
}) {
  const wacc = useMemo(() => computeCostOfCapital(statements), [statements]);
  const dcf = useMemo(() => runDcf(statements), [statements]);
  const graham = useMemo(() => runGraham(statements), [statements]);
  const cfClient = useMemo(() => deriveCashFlow(statements), [statements]);
  const growth = useMemo(() => multiPeriodGrowth(statements), [statements]);
  const cur = statements.currency;
  const fmtMoney = useFmtMoney();

  // ── PREFER backend-canonical FCF (real CapEx, statutory NI). The
  // client-side deriveCashFlow falls back to D&A when capex is missing —
  // the bug from the screenshots. When the period response carries
  // `fcf_breakdown`, use it verbatim. ──
  const fb = valuation?.fcf_breakdown ?? null;
  const netIncomeView = fb?.net_income ?? cfClient.netIncome;
  const depView = fb?.depreciation ?? cfClient.depreciationAmortization;
  const wcView = fb?.net_wc_change ?? cfClient.workingCapitalChange;
  const cfoView = fb?.cash_from_operating ?? cfClient.cfo;
  const capexView = fb?.capex_real ?? -cfClient.capex;       // negative = cash out
  const fcfView = fb?.free_cash_flow ?? cfClient.fcf;
  const capexAbs = Math.abs(capexView);
  const fcfNegativeDev = fb?.is_development_phase && fcfView < 0;

  const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;

  return (
    <>
      {/* Cash flow snapshot */}
      <div>
        <h2 className="font-serif text-[22px] text-ink mb-3">Free cash flow</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <KpiTile label="Net income" value={<LearnableNumber conceptKey="net_profit" value={netIncomeView}>{fmtMoney(netIncomeView, cur)}</LearnableNumber>} sub="statutory view" />
          <KpiTile label="+ D&A" value={<LearnableNumber conceptKey="depreciation_amortization" value={depView}>{fmtMoney(depView, cur)}</LearnableNumber>} />
          <KpiTile label="− ΔWorking capital" value={<LearnableNumber conceptKey="working_capital_changes" value={wcView}>{fmtMoney(wcView, cur)}</LearnableNumber>} />
          <KpiTile label="= CFO" value={<LearnableNumber conceptKey="operating_cash_flow" value={cfoView}>{fmtMoney(cfoView, cur)}</LearnableNumber>} />
          <KpiTile
            label="− CapEx"
            value={<LearnableNumber conceptKey="capex" value={capexAbs}>{fmtMoney(capexAbs, cur)}</LearnableNumber>}
            sub={fb ? "CIP additions, real" : "estimated as D&A"}
          />
          <KpiTile
            label="= FCF"
            value={<LearnableNumber conceptKey="free_cash_flow" value={fcfView}>{fmtMoney(fcfView, cur)}</LearnableNumber>}
            sub={
              fcfNegativeDev
                ? "Development-phase cash drag"
                : fcfView > 0
                  ? "Positive cash generation"
                  : "Cash burning"
            }
          />
        </div>
      </div>

      {/* WACC */}
      <div>
        <h2 className="font-serif text-[22px] text-ink mb-3">Cost of capital (WACC)</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <KpiTile label="WACC" value={<LearnableNumber conceptKey="wacc" value={wacc.wacc}>{pct(wacc.wacc, 2)}</LearnableNumber>} sub={`Cost of equity ${pct(wacc.costOfEquity, 2)}`} />
          <KpiTile label="Cost of equity" value={<LearnableNumber conceptKey="cost_of_equity" value={wacc.costOfEquity}>{pct(wacc.costOfEquity, 2)}</LearnableNumber>} sub={`Rf ${pct(wacc.riskFreeRate, 1)} + β${wacc.beta.toFixed(2)} × ERP ${pct(wacc.equityRiskPremium, 1)}`} />
          <KpiTile label="Cost of debt (after tax)" value={<LearnableNumber conceptKey="cost_of_debt" value={wacc.costOfDebtAfterTax}>{pct(wacc.costOfDebtAfterTax, 2)}</LearnableNumber>} sub={`Pre-tax ${pct(wacc.costOfDebtPreTax, 2)} · tax ${pct(wacc.taxRate, 1)}`} />
          <KpiTile label="Weight equity" value={pct(wacc.weightOfEquity, 1)} />
          <KpiTile label="Weight debt" value={pct(wacc.weightOfDebt, 1)} />
        </div>
      </div>

      {/* DCF */}
      <div>
        <h2 className="font-serif text-[22px] text-ink mb-3">DCF intrinsic value</h2>
        {fb?.is_development_phase && (
          <div className="mb-3 rounded-xl border border-info/40 bg-info-tint/40 px-4 py-3 text-[13px] text-ink leading-relaxed flex items-start gap-2">
            <Info size={14} strokeWidth={2} className="mt-0.5 shrink-0 text-info" />
            <span>
              Development phase detected — one-time CIP capex of{" "}
              <span className="tabular-nums font-medium">{fmtMoney(capexAbs, cur)}</span>{" "}
              is excluded from the perpetuity. DCF uses stabilized FCF
              (net income + ΔWC ≈ {fmtMoney(fb.stabilized_fcf, cur)}) for the terminal value, since
              the CIP spend is a one-shot development outlay, not recurring.
            </span>
          </div>
        )}
        <div className="rounded-2xl border border-rule bg-surface overflow-hidden">
          {/* FIT-1 — header row stacks vertically on narrow widths so the
              long "Equity value RON 450,489,717" headline never collides
              with the description block on its left. */}
          <div className="px-5 py-3 bg-bg-2/40 border-b border-rule flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <div className="min-w-0">
              <div className="font-serif text-[16px] text-ink">5-year explicit forecast + Gordon terminal</div>
              <div className="text-[12px] text-ink-soft break-words">
                Base FCF (stabilized run-rate){" "}
                <span className="text-ink font-medium tabular-nums">{fmtMoney(dcf.baseFcf, cur)}</span>
                {" · "}Forecast growth {pct(dcf.forecastGrowthRate, 1)} · Terminal growth {pct(dcf.terminalGrowthRate, 1)} · WACC {pct(dcf.wacc, 2)}
              </div>
              <div className="text-[11px] text-ink-mute mt-1 leading-snug">
                Stabilized FCF = CFO − maintenance capex (≈ D&A). Not the one-period FCF —
                that includes the one-shot CIP outlay and would crush the perpetuity.
              </div>
            </div>
            <div className="md:text-right min-w-0 md:shrink-0">
              <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium">Equity value</div>
              <div className="font-serif num-hero-fluid-lg text-ink leading-tight tabular-nums break-words">
                <LearnableNumber
                  conceptKey="equity_value"
                  value={valuation?.cross_checks?.dcf?.equity_value ?? dcf.equityValue}
                >
                  {fmtMoney(
                    valuation?.cross_checks?.dcf?.equity_value ?? dcf.equityValue,
                    cur,
                  )}
                </LearnableNumber>
              </div>
            </div>
          </div>
          <div className="overflow-x-auto">
          <table className="w-full text-[13px] min-w-[480px] sm:min-w-0">
            <thead>
              <tr className="bg-bg-2/30">
                <th className="text-left py-2 px-4 font-medium text-ink-mute">Year</th>
                <th className="text-right py-2 px-4 font-medium text-ink-mute">FCF</th>
                <th className="text-right py-2 px-4 font-medium text-ink-mute">Discount factor</th>
                <th className="text-right py-2 px-4 font-medium text-ink-mute">Present value</th>
              </tr>
            </thead>
            <tbody>
              {dcf.yearByYear.map((y) => (
                <tr key={y.year} className="border-t border-rule">
                  <td className="py-2 px-4 text-ink">Year {y.year}</td>
                  <td className="py-2 px-4 text-right tabular-nums text-ink">{fmtMoney(y.fcf, cur)}</td>
                  <td className="py-2 px-4 text-right tabular-nums text-ink-soft">{y.discountFactor.toFixed(4)}</td>
                  <td className="py-2 px-4 text-right tabular-nums text-ink">{fmtMoney(y.presentValue, cur)}</td>
                </tr>
              ))}
              <tr className="border-t border-rule bg-bg-2/30">
                <td className="py-2 px-4 text-ink font-medium" colSpan={3}>Terminal value (PV)</td>
                <td className="py-2 px-4 text-right tabular-nums text-ink font-medium">
                  <LearnableNumber conceptKey="terminal_value" value={dcf.terminalValuePresent}>
                    {fmtMoney(dcf.terminalValuePresent, cur)}
                  </LearnableNumber>
                </td>
              </tr>
              <tr className="border-t-2 border-ink/30 bg-bg-2/40">
                <td className="py-2 px-4 text-ink font-semibold" colSpan={3}>Enterprise value</td>
                <td className="py-2 px-4 text-right tabular-nums text-ink font-semibold">
                  <LearnableNumber conceptKey="enterprise_value" value={dcf.enterpriseValue}>
                    {fmtMoney(dcf.enterpriseValue, cur)}
                  </LearnableNumber>
                </td>
              </tr>
              <tr className="border-t border-rule">
                <td className="py-2 px-4 text-ink-soft" colSpan={3}>− Net debt</td>
                <td className="py-2 px-4 text-right tabular-nums text-ink">{fmtMoney(-dcf.netDebt, cur)}</td>
              </tr>
              <tr className="border-t-2 border-ink/30 bg-brand-tint">
                <td className="py-2 px-4 text-ink font-semibold" colSpan={3}>Equity value</td>
                <td className="py-2 px-4 text-right tabular-nums text-ink font-semibold">
                  <LearnableNumber conceptKey="equity_value" value={dcf.equityValue}>
                    {fmtMoney(dcf.equityValue, cur)}
                  </LearnableNumber>
                </td>
              </tr>
            </tbody>
          </table>
          </div>

          {/* ── 3-scenario sensitivity (Romania-corrected WACC) ──
              The DCF on real estate is highly sensitive to WACC. A ±100 bps
              shift in WACC moves equity value by RON ~6M. We show three
              brackets (Optimistic / Central / Conservative) explicitly
              so readers can locate themselves on the band rather than
              trusting a single point estimate. */}
          {dcf.scenarios && dcf.scenarios.length > 0 && (
            <div className="px-5 py-4 border-t border-rule bg-bg-2/20">
              <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium mb-2">
                Sensitivity (Romania-corrected WACC) · forecast g {pct(dcf.forecastGrowthRate, 1)} · terminal g {pct(dcf.terminalGrowthRate, 1)}
              </div>
              <div className="overflow-x-auto -mx-2 sm:mx-0">
              <table className="w-full text-[13px] min-w-[560px] sm:min-w-0">
                <thead>
                  <tr className="bg-bg-2/40">
                    <th className="text-left py-2 px-3 font-medium text-ink-mute">Scenario</th>
                    <th className="text-right py-2 px-3 font-medium text-ink-mute">WACC</th>
                    <th className="text-right py-2 px-3 font-medium text-ink-mute">Enterprise value</th>
                    <th className="text-right py-2 px-3 font-medium text-ink-mute">− Net debt</th>
                    <th className="text-right py-2 px-3 font-medium text-ink-mute">Equity value</th>
                  </tr>
                </thead>
                <tbody>
                  {dcf.scenarios.map((sc) => (
                    <tr
                      key={sc.label}
                      className={`border-t border-rule ${sc.label === "Central" ? "bg-amber-50/40 font-semibold" : ""}`}
                    >
                      <td className="py-2 px-3 text-ink">{sc.label}</td>
                      <td className="py-2 px-3 text-right tabular-nums text-ink">{pct(sc.wacc, 2)}</td>
                      <td className="py-2 px-3 text-right tabular-nums text-ink">{fmtMoney(sc.enterpriseValue, cur)}</td>
                      <td className="py-2 px-3 text-right tabular-nums text-ink-soft">{fmtMoney(-sc.netDebt, cur)}</td>
                      <td className="py-2 px-3 text-right tabular-nums text-ink">{fmtMoney(sc.equityValue, cur)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
              <p className="text-[11.5px] text-ink-mute mt-2 leading-snug">
                Inputs: Rf 6.75% (Romanian 10Y sovereign in RON) · ERP 7.5% (Romania mature EM, Damodaran) · β 1.00 (levered RE).
                The optimistic case (−100 bps WACC) converges with the cap-rate-implied equity value;
                the central case typically understates a yielding RE asset because DCF treats it as a
                perpetual cash-flow stream rather than an appreciating asset.
              </p>
            </div>
          )}

          <div className="px-5 py-3 border-t border-rule bg-bg-2/20 grid grid-cols-2 gap-4">
            <div className="min-w-0">
              <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium truncate">EV / EBITDA</div>
              <div className="font-serif text-[18px] text-ink tabular-nums break-words">{dcf.evToEbitda.toFixed(2)}×</div>
            </div>
            <div className="min-w-0">
              <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium truncate">EV / Revenue</div>
              <div className="font-serif text-[18px] text-ink tabular-nums break-words">{dcf.evToRevenue.toFixed(2)}×</div>
            </div>
          </div>
        </div>
      </div>

      {/* Graham — FIT-1: tile values use num-hero-fluid-sm so long
          intrinsic-equity strings (RON 656,047,165) shrink to fit in
          the 2-col grid at mobile widths. */}
      <div>
        <h2 className="font-serif text-[22px] text-ink mb-3">Graham intrinsic value</h2>
        <div className="rounded-2xl border border-rule bg-surface p-5">
          <div className="text-[12px] text-ink-soft mb-3 font-mono break-words">
            {graham.formula} &nbsp;·&nbsp; g = {pct(graham.growthRate, 1)} &nbsp;·&nbsp; Y = {pct(graham.bondYield, 2)}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="min-w-0">
              <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium truncate">Net income (TTM)</div>
              <div className="font-serif num-hero-fluid-sm text-ink tabular-nums break-words">
                {fmtMoney(graham.eps * (statements.supplementary.sharesOutstanding ?? 1), cur)}
              </div>
              <div className="text-[10.5px] text-ink-mute mt-0.5">statutory view</div>
            </div>
            <div className="min-w-0">
              <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium truncate">Graham fair equity value</div>
              <div className="font-serif num-hero-fluid-sm text-ink tabular-nums break-words">{fmtMoney(graham.intrinsicEquityValue, cur)}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Multi-period growth */}
      {growth.length > 0 && (
        <div>
          <h2 className="font-serif text-[22px] text-ink mb-3">Multi-period growth</h2>
          <div className="rounded-2xl border border-rule bg-surface overflow-hidden">
            <div className="overflow-x-auto">
            <table className="w-full text-[13px] min-w-[560px] sm:min-w-0">
              <thead>
                <tr className="bg-bg-2/30">
                  <th className="text-left py-2 px-4 font-medium text-ink-mute">Metric</th>
                  {growth[0].values.map((v) => (
                    <th key={v.period} className="text-right py-2 px-4 font-medium text-ink-mute">{v.period}</th>
                  ))}
                  <th className="text-right py-2 px-4 font-medium text-ink-mute">CAGR</th>
                </tr>
              </thead>
              <tbody>
                {growth.map((row) => (
                  <tr key={row.metric} className="border-t border-rule">
                    <td className="py-2 px-4 text-ink">{row.metric}</td>
                    {row.values.map((v) => (
                      <td key={v.period} className="py-2 px-4 text-right tabular-nums text-ink">{fmtMoney(v.value, cur)}</td>
                    ))}
                    <td className={`py-2 px-4 text-right tabular-nums font-medium ${row.cagr >= 0 ? "text-emerald-700" : "text-red-700"}`}>
                      {row.cagr >= 0 ? "+" : ""}{(row.cagr * 100).toFixed(1)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ─── RISKS & CREDIT PANEL ─────────────────────────────────────────────────

function RisksPanel({
  statements,
  creditEnvelope,
  piotroskiEnvelope,
  metricsByName,
}: {
  statements: Statements;
  // F2.4 — engine canonical envelopes (assembled_metrics.credit +
  // assembled_metrics.piotroski). When supplied, computeCreditScore
  // returns engine canonical (30/20/15/10/10/10/5 weights, engine
  // letter_grade, engine subscores). Falls back to FE arithmetic only
  // for sample data without an engine envelope.
  creditEnvelope?: import("@/lib/financialValuation").CreditEnvelope;
  piotroskiEnvelope?: import("@/lib/financialValuation").PiotroskiEnvelope;
  metricsByName?: Record<string, number | null>;
}) {
  const credit = useMemo(
    () => computeCreditScore(statements, creditEnvelope, piotroskiEnvelope, metricsByName),
    [statements, creditEnvelope, piotroskiEnvelope, metricsByName],
  );
  const piotroski = credit.piotroski;
  const altman = credit.altman;

  const ratingTone = (rating: string): string => {
    if (rating.startsWith("AAA") || rating.startsWith("AA") || rating === "A") return "bg-emerald-50 text-emerald-700 border-emerald-300/60";
    if (rating.startsWith("BBB")) return "bg-blue-50 text-blue-700 border-blue-300/60";
    if (rating.startsWith("BB")) return "bg-amber-50 text-amber-700 border-amber-300/60";
    if (rating.startsWith("B") || rating === "CCC") return "bg-orange-50 text-orange-700 border-orange-300/60";
    return "bg-red-50 text-red-700 border-red-300/60";
  };

  const gradeLabel = credit.grade.replace(/_/g, " ");

  return (
    <>
      {/* Composite credit score */}
      <div>
        <h2 className="font-serif text-[22px] text-ink mb-3">Composite credit score</h2>
        <div className={`rounded-2xl border-2 ${ratingTone(credit.rating)} p-4 sm:p-6 flex items-center justify-between gap-3`}>
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-[0.12em] font-medium opacity-80">Credit rating</div>
            <div className="font-serif text-[clamp(40px,11vw,64px)] leading-none mt-1">{credit.rating}</div>
            <div className="text-[12px] mt-2 opacity-80">
              Composite score: {credit.score} / 100 · <span className="capitalize">{gradeLabel}</span>
            </div>
          </div>
          <Shield className="opacity-30 shrink-0 h-12 w-12 sm:h-16 sm:w-16" strokeWidth={1.25} />
        </div>
        <div className="mt-3 rounded-2xl border border-rule bg-surface overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full text-[13px] min-w-[600px] sm:min-w-0">
            <thead>
              <tr className="bg-bg-2/30">
                <th className="text-left py-2 px-4 font-medium text-ink-mute">Component</th>
                <th className="text-right py-2 px-4 font-medium text-ink-mute">Value</th>
                <th className="text-right py-2 px-4 font-medium text-ink-mute">Weight</th>
                <th className="text-right py-2 px-4 font-medium text-ink-mute">Contribution</th>
                <th className="text-left py-2 px-4 font-medium text-ink-mute">Read</th>
              </tr>
            </thead>
            <tbody>
              {credit.components.map((c) => (
                <tr key={c.label} className="border-t border-rule">
                  <td className="py-2 px-4 text-ink">{c.label}</td>
                  <td className="py-2 px-4 text-right tabular-nums text-ink">
                    {Number.isFinite(c.value) ? c.value.toFixed(2) : "—"}
                  </td>
                  <td className="py-2 px-4 text-right tabular-nums text-ink-soft">{(c.weight * 100).toFixed(0)}%</td>
                  <td className="py-2 px-4 text-right tabular-nums text-ink">{c.contribution.toFixed(1)}</td>
                  <td className="py-2 px-4 text-ink-soft text-[12px]">{c.read}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      </div>

      {/* Piotroski F-Score */}
      <div>
        <h2 className="font-serif text-[22px] text-ink mb-3">Piotroski F-Score</h2>
        <div className="rounded-2xl border border-rule bg-surface p-5 flex items-center justify-between mb-3">
          <div>
            <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium">9-point quality screen</div>
            <div className="font-serif text-[clamp(28px,7vw,40px)] text-ink leading-none mt-1">
              {piotroski.passCount}
              {piotroski.uncertainCount > 0 ? (
                <span className="text-[16px] text-ink-soft"> / {9 - piotroski.uncertainCount} confirmed</span>
              ) : (
                <span className="text-[16px] text-ink-soft"> / 9</span>
              )}
            </div>
            <div className="text-[12px] text-ink-soft mt-1">
              {piotroski.band}
              {piotroski.uncertainCount > 0
                ? ` · ${piotroski.uncertainCount} check${piotroski.uncertainCount === 1 ? "" : "s"} uncertain (prior-period data missing)`
                : ""}
            </div>
          </div>
          <TrendingUp size={48} strokeWidth={1.25} className="text-ink-mute opacity-50" />
        </div>
        <div className="rounded-2xl border border-rule bg-surface overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full text-[13px] min-w-[480px] sm:min-w-0">
            <thead>
              <tr className="bg-bg-2/30">
                <th className="text-left py-2 px-4 font-medium text-ink-mute">Check</th>
                <th className="text-center py-2 px-4 font-medium text-ink-mute w-20">Result</th>
                <th className="text-left py-2 px-4 font-medium text-ink-mute">Detail</th>
              </tr>
            </thead>
            <tbody>
              {piotroski.checks.map((c) => {
                const tone =
                  c.result === "pass"
                    ? "text-emerald-700"
                    : c.result === "fail"
                      ? "text-red-700"
                      : "text-ink-mute";
                const glyph = c.result === "pass" ? "✓" : c.result === "fail" ? "✗" : "?";
                return (
                  <tr key={c.key} className="border-t border-rule">
                    <td className="py-2 px-4 text-ink">{c.label}</td>
                    <td className={`py-2 px-4 text-center font-semibold ${tone}`}>{glyph}</td>
                    <td className="py-2 px-4 text-ink-soft text-[12.5px]">{c.detail}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>
      </div>

      {/* Altman Z (variant-aware) */}
      <div>
        <h2 className="font-serif text-[22px] text-ink mb-3">
          Bankruptcy risk · Altman {altman.variant}
        </h2>
        <div className="rounded-2xl border border-rule bg-surface p-5">
          <div className="flex items-baseline justify-between gap-4 flex-wrap">
            <div>
              <div className="font-serif text-[clamp(28px,7vw,40px)] text-ink leading-none">{altman.score.toFixed(2)}</div>
              <div className="text-[12px] text-ink-soft mt-1">
                ≥ {altman.thresholds.safe.toFixed(2)} safe · {altman.thresholds.distress.toFixed(2)}–{altman.thresholds.safe.toFixed(2)} grey · &lt; {altman.thresholds.distress.toFixed(2)} distress
              </div>
            </div>
            <span
              className={`text-[11px] font-semibold uppercase tracking-[0.06em] px-3 py-1 rounded-full ${
                altman.zone === "safe"
                  ? "bg-emerald-50 text-emerald-700"
                  : altman.zone === "grey"
                    ? "bg-amber-50 text-amber-700"
                    : "bg-red-50 text-red-700"
              }`}
            >
              {altman.zone === "safe" ? "Safe zone" : altman.zone === "grey" ? "Grey zone" : "Distress"}
            </span>
          </div>
          <p className="text-[12.5px] text-ink-soft mt-3 leading-snug">{altman.methodologyNote}</p>
          <div className="mt-4 rounded-xl border border-rule bg-bg-2/30 overflow-hidden">
            <div className="overflow-x-auto">
            <table className="w-full text-[12.5px] min-w-[480px] sm:min-w-0">
              <thead>
                <tr className="bg-bg-2/40">
                  <th className="text-left py-2 px-3 font-medium text-ink-mute">Component</th>
                  <th className="text-right py-2 px-3 font-medium text-ink-mute">Coefficient</th>
                  <th className="text-right py-2 px-3 font-medium text-ink-mute">Value</th>
                  <th className="text-right py-2 px-3 font-medium text-ink-mute">Weighted</th>
                </tr>
              </thead>
              <tbody>
                {altman.weightedComponents.map((c, i) => (
                  <tr key={i} className="border-t border-rule">
                    <td className="py-2 px-3 text-ink">{c.label}</td>
                    <td className="py-2 px-3 text-right tabular-nums text-ink-soft">{c.coefficient.toFixed(3)}</td>
                    <td className="py-2 px-3 text-right tabular-nums text-ink">{c.value.toFixed(4)}</td>
                    <td className="py-2 px-3 text-right tabular-nums text-ink">{c.weighted.toFixed(3)}</td>
                  </tr>
                ))}
                <tr className="border-t-2 border-ink/30 bg-bg-2/50">
                  <td colSpan={3} className="py-2 px-3 text-ink font-semibold">
                    Altman {altman.variant}-Score
                  </td>
                  <td
                    className={`py-2 px-3 text-right tabular-nums font-semibold ${
                      altman.zone === "safe"
                        ? "text-emerald-700"
                        : altman.zone === "grey"
                          ? "text-amber-700"
                          : "text-red-700"
                    }`}
                  >
                    {altman.score.toFixed(2)}
                  </td>
                </tr>
              </tbody>
            </table>
            </div>
          </div>
        </div>
      </div>

      {/* Caveat */}
      <div className="rounded-xl border border-info/40 bg-info-tint/40 px-4 py-3 text-[12.5px] text-ink-soft leading-relaxed">
        <strong className="text-ink">Caveat:</strong> {credit.caveat}
      </div>
    </>
  );
}
