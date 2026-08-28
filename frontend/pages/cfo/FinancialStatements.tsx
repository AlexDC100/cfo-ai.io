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

import { useMemo, useState, useRef, useCallback, useEffect, type ReactNode } from "react";
import { Link, useSearchParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
// SourceFilesRow/AddFileTile no longer used here (2026-08-04 source-line fix) — Products still uses them.
import { openUploadedFilePreview } from "@/lib/stagedFilePreview";
import { useBudgetComparison } from "@/stores/budget";
import { parseBudgetFile } from "@/lib/comparison/parseBudget";
import { useTranslation } from "react-i18next";
// Module-level i18n handle — for the few strings rendered outside React
// (the example-workbook preview tab opened by previewExampleInNewTab).
import i18n from "@/i18n";
import { previewBackButtonHtml } from "@/lib/previewChrome";
import { formatDateTime } from "@/lib/locale";
import { pickActiveSourceDoc } from "@/lib/activeSourceDoc";
import { Money } from "@/components/ui/Money";
import { LearnableNumber } from "@/components/learning/LearnableNumber";
import { LearnableRowLabel } from "@/components/learning/LearnableRowLabel";
import { ReportingContextProvider } from "@/components/learning/ReportingContextProvider";
import { PageGuideOverlay, type GuideStep } from "@/components/learning/PageGuideOverlay";
import { PL_GUIDE, CF_GUIDE, RATIOS_GUIDE, RECOMMENDATIONS_GUIDE, RISK_GUIDE } from "@/components/learning/pageGuides";
import { BALANCE_SHEET_GUIDE } from "@/components/learning/balanceSheetGuide";
import { VALUATION_GUIDE } from "@/components/learning/valuationGuide";
import { factToConceptKey, factLabel } from "@/lib/learning/concepts/recommendations";
import { openAskCfoAi } from "@/components/cfo/chat/openAskCfoAi";
import type { ReportingMetrics } from "@/lib/learning/concepts/_schema";
import { buildReportingMetricsSnapshot } from "@/lib/learning/buildReportingMetrics";
import { ConfigurableDashboard } from "@/components/dashboard/ConfigurableDashboard";
import { DashboardProvider } from "@/stores/dashboard";
import { DashboardViewProvider } from "@/stores/dashboardView";
import { DemoBanner } from "@/components/dashboard/DemoBanner";
import { buildMultiYearSeries, seriesForConcept } from "@/lib/learning/multiPeriodSeries";
import { DEMO_SAMPLE_ID } from "@/lib/demo/demoCompany";
import type { Currency } from "@/lib/rates";
import { useDisplayCurrency, useRates } from "@/stores/currency";
import { convertFromTo } from "@/lib/money";
import { openStagedFile } from "@/lib/stagedFilePreview";
import { clearStagedFiles, readStagedFiles, writeStagedFiles } from "@/lib/stagedFilesStore";
import { useUploadEnqueue } from "@/hooks/useUploadEnqueue";
import { PLStatementView } from "@/components/cfo/PLStatementView";
import { AiReadBadge, BSStatementView } from "@/components/cfo/BSStatementView";
import {
  JurisdictionSelect,
  jurisdictionHintFromSelection,
} from "@/components/cfo/JurisdictionSelect";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { detectPeriodEndFromFilename, detectPeriodEndFromFile, formatDetectedMonth } from "@/lib/detectPeriodEnd";
import { fetchWorkspacePeriodsDirect, formatPeriodMonth, formatPeriodMonthLoose, useOrgPeriods } from "@/lib/orgPeriods";
import { useActiveOrg } from "@/lib/org";
import { cfoApi } from "@/lib/cfoApi";
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
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileSpreadsheet,
  FileText,
  Info,
  Loader2,
  Presentation,
  Scale,
  Shield,
  Sparkles,
  TrendingUp,
  ArrowUp,
  Cloud,
  UploadCloud,
  X,
  Trash2,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import {
  computeRatios,
  deriveTotals,
  downloadReport,
  formatRatio,
  generateRecommendations,
  type CanonicalBs,
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
// financialExports (and its xlsx dependency, ~430 KB) is dynamic-imported at
// the Download click site so the Dashboard chunk doesn't ship SpreadsheetML
// codecs to users who never export.
import { SAMPLE_DATASETS, SAMPLES_ENABLED } from "@/data/sampleStatements";
import { periodQueryKey, useActivePeriod, type PeriodValuation } from "@/lib/activePeriod";
import { useActivePeriodFallback } from "@/hooks/useActivePeriodFallback";
import {
  clearUpload,
  patchUpload,
  startUpload,
  useUploadStore,
} from "@/lib/uploadStore";
import { InlineErrorBoundary } from "@/components/cfo/InlineErrorBoundary";
import { CouncilVisualizer } from "@/components/cfo/CouncilVisualizer";
import { ScanProgressView, TRIAL_BALANCE_STEPS } from "@/components/cfo/ScanProgressView";
import { isScanSpherePaused } from "@/components/cfo/CouncilSphereHost";
import { TemplateDownloadCard } from "@/components/cfo/products/TemplateDownloadCard";
import { StatementNotes } from "@/components/cfo/StatementNotes";
import { ValuationSection } from "@/components/cfo/ValuationSection";
import { RatioDetailDrawer } from "@/components/cfo/RatioDetailDrawer";
import { buildCanonicalMetricsFromInputs } from "@/lib/canonicalMetrics";
import { EbitdaReconciliationPanel } from "@/components/cfo/EbitdaReconciliationPanel";
import { SourceQualityBanner } from "@/components/cfo/SourceQualityBanner";
import { DocsToggle, useDocsCount } from "@/components/cfo/DocsPanel";
import { PublicRecordsQuickCard } from "@/components/cfo/PublicRecordsQuickCard";
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
// The archived bottom-tab implementations were removed in the 2026-07
// dead-code cleanup (recoverable from git history: frontend/_removed/tabs/).
import { useToast } from "@/hooks/use-toast";

// Consolidated tab guides (2026-07-25) — the per-tab "Guide me" buttons were
// removed; a single button in the tab bar opens the guide for the ACTIVE tab.
// Keyed by TabId. Tabs without an entry (export) show no guide button.
// `title` holds the i18n KEY (module scope has no hook); translated at the
// PageGuideOverlay mount site.
const TAB_GUIDES: Record<string, { pageId: string; title: string; steps: GuideStep[] }> = {
  pl:              { pageId: "pnl",           title: "dash.guidePl",           steps: PL_GUIDE },
  balance_sheet:   { pageId: "balance-sheet", title: "dash.guideBalanceSheet", steps: BALANCE_SHEET_GUIDE },
  cash_flow:       { pageId: "cash-flow",     title: "dash.guideCashFlow",     steps: CF_GUIDE },
  ratios:          { pageId: "ratios",        title: "dash.guideRatios",       steps: RATIOS_GUIDE },
  valuation:       { pageId: "valuation",     title: "dash.guideValuation",    steps: VALUATION_GUIDE },
  risks:           { pageId: "risk-credit",   title: "dash.guideRisks",        steps: RISK_GUIDE },
  recommendations: { pageId: "recommendations", title: "dash.guideRecommendations", steps: RECOMMENDATIONS_GUIDE },
};

// ─── 2026 dashboard-redesign strings (dashV2.*) ─────────────────────────────
// The locale files are frozen for this redesign pass — new keys ship as a
// fragment (scratchpad i18n-fragments/dashv2.json) to be merged later. Until
// that merge lands, the SAME bag is registered here at module load
// (deep-merge, overwrite=false) so `t("dashV2.…")` resolves in both
// languages TODAY, and the locale files win the moment they carry the keys.
const DASHV2_EN = {
  verdictLabel: "Financial health",
  verdictScoreOf: "out of 100",
  verdictStrong: "Financially strong — solid profitability, comfortable debt and healthy liquidity.",
  verdictSolid: "Overall solid — the fundamentals hold up, with a few areas worth tightening.",
  verdictWatch: "Needs watching — several indicators are under pressure. Start with the recommendations below.",
  verdictCritical: "Critical — the numbers point to serious financial stress. Act on the critical recommendations now.",
  verdictPending: "Analysis pending — the health score will appear once this period's data is processed.",
  ratingLabel: "Rating",
  metricRevenue: "Revenue",
  metricRevenueDesc: "Income generated by the core business this period.",
  metricEbitda: "EBITDA",
  metricEbitdaDesc: "Cash generated by core operations, before interest, taxes, depreciation and amortization.",
  metricCash: "Cash",
  metricCashDesc: "Money available right now in bank accounts and petty cash.",
  metricNetDebt: "Net debt",
  metricNetDebtDesc: "Total debt minus cash — what would remain to repay after using available cash.",
  vsLastPeriod: "vs {{period}}",
  recsTitle: "Recommendations",
  filterAll: "All",
  filterCritical: "Critical",
  filterWatch: "Watch",
  filterInfo: "Info",
  badgeCritical: "Critical",
  badgeWatch: "Watch",
  badgeInfo: "Info",
  actionsLabel: "Actions",
  allMetricsTitle: "All metrics",
  allMetricsSub: "The configurable KPI grid and every indicator card for this period.",
  templatesTitle: "Templates & examples",
  templatesSub: "Official trial-balance template and example files.",
  briefingShowMore: "Read the full briefing",
  briefingShowLess: "Collapse the briefing",
  addFileTileLabel: "Add file",
  tabOverview: "Overview",
  dangerConfirmWord: "DELETE",
  scenarioOptimistic: "Optimistic",
  scenarioCentral: "Central",
  scenarioConservative: "Conservative",
  ratioVerdictStrong: "Strong",
  ratioVerdictHealthy: "Healthy",
  ratioVerdictWatch: "Watch",
  ratioVerdictCritical: "Critical",
  piotroskiStrong: "Strong (8–9)",
  piotroskiSolid: "Solid (6–7)",
  piotroskiWeak: "Weak (3–5)",
  piotroskiDistressed: "Distressed (0–2)",
  gradeInvestmentGrade: "investment grade",
  gradeBoundary: "boundary",
  gradeSpeculative: "speculative",
  gradeDistress: "distress",
} as const;
const DASHV2_RO: Record<keyof typeof DASHV2_EN, string> = {
  verdictLabel: "Sănătate financiară",
  verdictScoreOf: "din 100",
  verdictStrong: "Companie solidă financiar — profitabilitate bună, datorii confortabile și lichiditate sănătoasă.",
  verdictSolid: "Per ansamblu, o situație solidă — fundamentele sunt bune, cu câteva zone de îmbunătățit.",
  verdictWatch: "Necesită atenție — mai mulți indicatori sunt sub presiune. Începe cu recomandările de mai jos.",
  verdictCritical: "Situație critică — cifrele arată presiune financiară serioasă. Acționează acum pe recomandările critice.",
  verdictPending: "Analiză în curs — scorul de sănătate apare după procesarea datelor acestei perioade.",
  ratingLabel: "Rating",
  metricRevenue: "Venituri",
  metricRevenueDesc: "Veniturile generate de activitatea de bază în această perioadă.",
  metricEbitda: "EBITDA",
  metricEbitdaDesc: "Banii generați de activitatea de bază, înainte de dobânzi, taxe și amortizare.",
  metricCash: "Numerar",
  metricCashDesc: "Banii disponibili acum în conturi bancare și în casierie.",
  metricNetDebt: "Datorie netă",
  metricNetDebtDesc: "Datoriile totale minus numerarul — ce ar rămâne de plătit după folosirea banilor disponibili.",
  vsLastPeriod: "vs {{period}}",
  recsTitle: "Recomandări",
  filterAll: "Toate",
  filterCritical: "Critice",
  filterWatch: "De urmărit",
  filterInfo: "Info",
  badgeCritical: "Critic",
  badgeWatch: "De urmărit",
  badgeInfo: "Info",
  actionsLabel: "Acțiuni",
  allMetricsTitle: "Toți indicatorii",
  allMetricsSub: "Grila de KPI configurabilă și toate cardurile de indicatori pentru această perioadă.",
  templatesTitle: "Modele și exemple",
  templatesSub: "Modelul oficial de balanță de verificare și fișiere exemplu.",
  briefingShowMore: "Citește tot briefingul",
  briefingShowLess: "Restrânge briefingul",
  addFileTileLabel: "Adaugă fișier",
  tabOverview: "Sinteză",
  dangerConfirmWord: "ȘTERGE",
  scenarioOptimistic: "Optimist",
  scenarioCentral: "Central",
  scenarioConservative: "Conservator",
  ratioVerdictStrong: "Solid",
  ratioVerdictHealthy: "Sănătos",
  ratioVerdictWatch: "De urmărit",
  ratioVerdictCritical: "Critic",
  piotroskiStrong: "Puternic (8–9)",
  piotroskiSolid: "Solid (6–7)",
  piotroskiWeak: "Slab (3–5)",
  piotroskiDistressed: "În dificultate (0–2)",
  gradeInvestmentGrade: "grad investițional",
  gradeBoundary: "la limită",
  gradeSpeculative: "speculativ",
  gradeDistress: "dificultate",
};
i18n.addResourceBundle("en", "translation", { dashV2: DASHV2_EN }, true, false);
i18n.addResourceBundle("ro", "translation", { dashV2: DASHV2_RO }, true, false);

/** What the dashboard accepts as a financial document. Shared by the hidden
 *  page input and the "Add file" tile in the Source-files row so the two can't
 *  drift. */
const DASHBOARD_UPLOAD_ACCEPT =
  ".pdf,.xlsx,.xls,.csv,.jpg,.jpeg,.png,.heic,.heif,image/heic,image/heif,.pptx,.ppt,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation";

export default function FinancialStatements() {
  const { t, i18n } = useTranslation();
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
  const { uploaded: budgetDeck, save: saveBudgetDeck } = useBudgetComparison();
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
  const queryClient = useQueryClient();
  const enabled = useMemo(() => tabEnabled(availableTypes), [availableTypes]);
  const tabs = useMemo(() => allTabs(), []);
  // 2026 redesign — Overview is the State B landing again: the narrative
  // hierarchy (hero verdict + key metrics + recommendations) lives in the
  // overview TabsContent, so a clean URL (no ?tab) resolves to it. Explicit
  // ?tab=overview is honored too (resolveActiveTab would coerce it to "pl"
  // since the lib's TAB_SPECS no longer lists overview — a lib this file
  // doesn't own, so the override lives here).
  const rawTabParam = searchParams.get("tab");
  const activeTab: TabId =
    rawTabParam === null || rawTabParam === "overview"
      ? "overview"
      : resolveActiveTab(rawTabParam, enabled);
  // Single "Guide me" button in the tab bar opens the ACTIVE tab's guide.
  const activeGuide = TAB_GUIDES[activeTab];
  const [guideOpen, setGuideOpen] = useState(false);

  // The defining state-flip for Phase F: anything loaded → State B. Anything
  // missing → State A. The page chrome below this is conditional on the flag.
  const hasPeriodLoaded = statements !== null || invoices !== null;

  const onTabChange = useCallback((next: string) => {
    setSearchParams((prev) => {
      const sp = new URLSearchParams(prev);
      // Overview is the default landing (2026 redesign) — a clean URL
      // (no ?tab) means Overview.
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

  // The SIDEBAR's selected period, for the pre-scan confirm dialog
  // (2026-07-26 per operator). Deliberately NOT remotePeriod: that's the
  // resolved analysis payload, and an EMPTY period selected in the sidebar
  // has no analysis to resolve — remotePeriod misses it and the dialog's
  // "Selected period" card would come up blank. Resolve ?period= against the
  // same two feeds the sidebar stepper merges (both cache-shared, so this
  // adds no requests).
  const { org: activeOrgForPeriods } = useActiveOrg();
  const { data: enginePeriodsData } = useOrgPeriods();
  const { data: directPeriodsData } = useQuery({
    queryKey: ["org-periods", activeOrgForPeriods?.id],
    queryFn: () => fetchWorkspacePeriodsDirect(activeOrgForPeriods!.id),
    enabled: !!activeOrgForPeriods?.id,
    staleTime: 60_000,
  });
  const sidebarPeriod = useMemo(() => {
    // Same merge + order as SidebarMonthStepper: engine periods first,
    // deduped, newest month first.
    const engine = enginePeriodsData?.periods ?? [];
    const seen = new Set(engine.map((p) => p.period_id));
    const all = [
      ...engine,
      ...(directPeriodsData?.periods ?? []).filter((p) => !seen.has(p.period_id)),
    ].sort((a, b) => (b.period_end ?? "").localeCompare(a.period_end ?? ""));
    // Same fallback chain as the stepper's label too: the URL's period, else
    // the newest workspace period. Without the last step, a fresh workspace
    // whose only period is an empty container shows a month in the sidebar
    // (the stepper's own fallback) while this resolved null — and the
    // dialog's "Selected period" card rendered "—" (operator-reported).
    //
    // A pid that IS set but isn't in the feeds (a sample/demo period) stays
    // null on purpose — the caller's remotePeriod fallback carries the
    // sample's own month, which is more truthful than the newest real period.
    const pid = searchParams.get("period") ?? remotePeriod.id;
    if (pid) return all.find((p) => p.period_id === pid) ?? null;
    return all[0] ?? null;
  }, [searchParams, remotePeriod.id, enginePeriodsData, directPeriodsData]);

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

  // ── 2026 redesign: headline values for the four key-metric cards ────────
  // EXACTLY the same expressions the KPI-strip overrides use (hoisted out of
  // the former inline IIFE so the hero metric cards and the configurable
  // dashboard read one shared computation — figures can never diverge).
  const headline = useMemo(() => {
    if (!statements || !totals) return null;
    const pl = pickPLBuilder(
      {
        lineItems: remotePeriod.lineItems,
        entity: statements.companyName ?? t("dash.entity"),
        period: statements.periodLabel,
        currency: statements.currency,
        canonicalMargins: dashboardCanonicalMargins,
      },
      statements,
    );
    const totalOperatingRevenue =
      pl.sections[0]?.subtotalAmount ?? statements.incomeStatement.revenue;
    // Tile EBITDA: engine `assembled_pl.ebitda_statutory` first (the legally
    // reported EBITDA incl. 722/758/781), FE operating-view `pl.ebitda` as
    // the pre-v2.1 fallback — identical routing to the original KPI tile.
    const tileEbitdaCanonical =
      typeof statements.assembled_pl?.ebitda_statutory === "number"
        ? statements.assembled_pl.ebitda_statutory
        : null;
    const tileEbitdaRon = tileEbitdaCanonical ?? pl.ebitda;
    // Net profit: engine canonical `net_income_statutory` (ct.121 anchor),
    // then FE statutory, then FE operational — same chain as before.
    const niStatRow = remotePeriod.metrics.find(
      (mt) => mt.name === "net_income_statutory",
    );
    const tileNetProfitRon =
      typeof niStatRow?.value === "number"
        ? niStatRow.value
        : typeof pl.netProfitStatutory === "number"
          ? pl.netProfitStatutory
          : pl.netProfit;
    const sourceTooltip =
      remotePeriod.detectedType === "statutory_f30_f10"
        ? t("dash.sourceStatutoryTooltip")
        : remotePeriod.detectedType === "trial_balance"
          ? t("dash.sourceTbTooltip")
          : null;
    return { totalOperatingRevenue, tileEbitdaRon, tileNetProfitRon, sourceTooltip };
  }, [statements, totals, remotePeriod.lineItems, remotePeriod.metrics, remotePeriod.detectedType, dashboardCanonicalMargins, t]);

  // ── 2026 redesign: hero health verdict ──────────────────────────────────
  // Reuses the EXACT same reader the Risks tab mounts — engine canonical
  // envelopes (assembled_metrics.credit / .piotroski) through
  // computeCreditScore. Nothing is recomputed differently: the score, letter
  // rating and grade on the hero card are byte-identical to the Risks tab.
  const heroCredit = useMemo(() => {
    if (!statements) return null;
    const creditEnvelope = (
      remotePeriod.assembled_metrics as { credit?: import("@/lib/financialValuation").CreditEnvelope } | null
    )?.credit;
    const piotroskiEnvelope =
      (remotePeriod.assembled_metrics as { piotroski?: import("@/lib/financialValuation").PiotroskiEnvelope } | null)?.piotroski
      ?? (statements as unknown as {
        assembled_piotroski?: import("@/lib/financialValuation").PiotroskiEnvelope;
      }).assembled_piotroski;
    try {
      return computeCreditScore(statements, creditEnvelope, piotroskiEnvelope, metricsByName);
    } catch {
      // Never let a scoring edge case take down the overview — the hero
      // card renders its honest "analysis pending" state instead.
      return null;
    }
  }, [statements, remotePeriod.assembled_metrics, metricsByName]);

  // Per-concept vs-last-period trend, read from the SAME multi-year series
  // that already feeds the KPI sparklines (no new fetches). Null when fewer
  // than two periods exist — the metric cards then render no arrow.
  const trendFor = useCallback(
    (conceptKey: string): { pct: number; prevLabel: string } | null => {
      if (multiYearSeries.available < 2) return null;
      const s = seriesForConcept(multiYearSeries, conceptKey);
      if (s.length < 2) return null;
      const prev = s[s.length - 2];
      const curr = s[s.length - 1];
      if (!Number.isFinite(prev.value) || prev.value === 0) return null;
      return { pct: (curr.value - prev.value) / Math.abs(prev.value), prevLabel: prev.label };
    },
    [multiYearSeries],
  );

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
      const ok = window.confirm(t("dash.clearPeriodConfirm"));
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
              title: t("dash.clearPeriodFailTitle"),
              description:
                (body && (body.detail?.message || body.detail)) ||
                t("dash.clearPeriodFailBody"),
              variant: "destructive",
            });
            return;
          }
          toast({
            title: t("dash.periodClearedTitle"),
            description: t("dash.periodClearedBody"),
          });
        }
      } catch (err) {
        toast({
          title: t("dash.backendUnreachableTitle"),
          description: err instanceof Error ? err.message : t("dash.networkError"),
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
          t("dash.uploadedDocument"),
        confidence: null,
        warnings: [],
        accountCount: null,
      });
    }
  }, [remotePeriod.isLoaded, remotePeriod.id, remotePeriod.statements, remotePeriod.invoices, remotePeriod.availableTypes, remotePeriod.label, remotePeriod.source]);

  // …and the mirror image of it: a period with NOTHING behind it must clear
  // this page back to State A (2026-07-26). The hydration effect above only
  // ever WRITES — it bails on a period with no statements — so stepping from
  // a month that has a trial balance to an empty one (a container created in
  // Workspace, or one whose document was deleted) left the previous month's
  // numbers on screen under the new month's name. Anything that isn't a real
  // loaded period resets: empty payload, 404 for a stale id, deleted source.
  //
  // Guards: `isLoading` so the reset can't fire mid-fetch and flash the
  // dropzone, and `source === "sample"` so picking a dev sample (which sets
  // these locally, with no remote period) isn't wiped by its own selection.
  useEffect(() => {
    if (!remotePeriod.id) return;
    if (remotePeriod.isLoading) return;
    if (remotePeriod.source === "sample") return;
    if (remotePeriod.statements || remotePeriod.invoices) return;
    setStatements(null);
    setInvoices(null);
    setAvailableTypes(new Set());
    setActiveSampleId(null);
    setParseSource(null);
    setUploadName(null);
  }, [
    remotePeriod.id,
    remotePeriod.isLoading,
    remotePeriod.source,
    remotePeriod.statements,
    remotePeriod.invoices,
  ]);

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
  // Only the DASHBOARD's own uploads drive this page's scan takeover / State-A
  // progress. A products (SKU) upload lives in the same store but must NOT make
  // the dashboard flip into its scan view — it renders on /products instead.
  const _upload = useUploadStore().current;
  const uploadInFlight = _upload && _upload.surface !== "products" ? _upload : null;

  // When a scan lands, we HOLD the analyzed upload on screen (instead of
  // auto-routing into State B) so the scan view can show its "Scan complete"
  // card. `awaitingView` carries the period to open; the card's "View
  // results" button (viewResults) performs the deferred navigation. Declared
  // BEFORE the analyzed auto-clear hedge below, which reads it (a later
  // declaration would be a temporal-dead-zone throw in that effect's deps).
  const [awaitingView, setAwaitingView] = useState<{ periodId: string | null } | null>(null);
  function viewResults() {
    const periodId = awaitingView?.periodId ?? uploadInFlight?.periodId ?? null;
    setAwaitingView(null);
    console.info("[scan] viewResults →", periodId ?? "(no period)");
    if (periodId) {
      toast({ title: t("toasts.analysisComplete"), description: t("dash.loadedIntoDashboard") });
      // The scan just created (or replaced) a period — the workspace's month
      // list is now stale. Invalidate it so the top-bar month selector, the
      // month arrows, and the Workspace month pills / Months section all show +
      // select the new month rather than lagging a full staleTime behind.
      void queryClient.invalidateQueries({ queryKey: ["periods-with-documents"] });
      void queryClient.invalidateQueries({ queryKey: ["org-periods"] });
      setSearchParams((prev) => {
        const sp = new URLSearchParams(prev);
        sp.set("period", periodId);
        return sp;
      }, { replace: true });
    }
    clearUpload();
  }

  // F3-FE-FIX-1 (Option 2 defensive guard): if hasPeriodLoaded ever
  // flips to false while a stale `analyzed` inflight is still around,
  // auto-clear it. Targeted clears in resetWorkspace() + the post-
  // analyze handler cover the known paths; this hedge covers any
  // unknown state path that drops statements without clearing
  // inflight (including the unverified "stuck after refresh" symptom
  // reported by the operator but not reproducible from code-reading).
  useEffect(() => {
    // …unless we're intentionally holding the analyzed upload to show the
    // "Scan complete" card (awaitingView) — clearing it here would yank the
    // card away before the user clicks "View results".
    //
    // ALSO exempt analyzed uploads that carry a periodId (2026-07-26): that's
    // a scan that just COMPLETED and is being handed off, not a stale
    // leftover. The external-store flush means this effect can observe
    // status=analyzed one render before awaitingView lands — clearing in
    // that window killed the handoff (see the auto-open effect below).
    if (
      !hasPeriodLoaded &&
      uploadInFlight?.status === "analyzed" &&
      !awaitingView &&
      !uploadInFlight.periodId
    ) {
      clearUpload();
    }
  }, [hasPeriodLoaded, uploadInFlight?.status, uploadInFlight?.periodId, awaitingView]);

  // Rehydrate auto-open (2026-08-02, operator-reported "Analysis ready →
  // blank page on every reload"): the persisted upload store re-enters the
  // scan view after a refresh even when the scan FINISHED long ago — the
  // user re-lands on the "Scan complete" card (which short viewports
  // couldn't even reach, see ScanProgressView) instead of their data, on
  // every visit, forever. Holding the card is only meaningful for a LIVE
  // completion (the sphere finale the user is watching); on a reload they
  // already missed that moment, so open the results directly.
  // `rehydratedAnalyzedRef` is captured on FIRST render: true only when the
  // page mounted with the upload already analyzed (a reload of a finished
  // scan), never for scans that complete while the page is up.
  const rehydratedAnalyzedRef = useRef(_upload?.status === "analyzed");
  useEffect(() => {
    if (!rehydratedAnalyzedRef.current) return;
    if (uploadInFlight?.status !== "analyzed") return;
    rehydratedAnalyzedRef.current = false;
    console.info("[scan] rehydrated in analyzed state — auto-opening results");
    viewResults();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploadInFlight?.status]);

  // Completion hand-off — the same sequence Products runs (2026-07-26 per
  // operator), with the dashboard's own five trial-balance steps: the sphere
  // pulls its orbs into the core (~1s), the layer fades to a ghost, the
  // "Scan complete" card comes up over it — and then it WAITS. There used to
  // be a 2400ms auto-open here; it pulled the card off screen about a second
  // after it finished fading in, so the finish read as a flicker. Only "View
  // results" (viewResults, via awaitingView) leaves the scan view now.
  //
  // What the auto-open was defending, and why it's safe to drop: awaitingView
  // is React state set in the analyzed handler, so the auto-clear hedge above
  // (which observes the external upload store, flushed synchronously) can't
  // yank the hand-off out from under it. That was the real bug behind "the
  // dashboard never changes after a scan" — the fix is the gate, not the
  // timer.

  // Files staged for scanning. Choosing/dropping files ADDS them here;
  // nothing is uploaded until the user clicks "Start scan" (no auto-scan).
  // Mirrored to the module-level store so a re-render can't drop the
  // selection — but LEAVING the tab does (cleared on unmount, 2026-07-26
  // per operator), so returning offers a clean dropzone.
  const [stagedFiles, setStagedFiles] = useState<File[]>(() => readStagedFiles("dashboard"));
  useEffect(() => () => clearStagedFiles("dashboard"), []);
  const [scanning, setScanning] = useState(false);
  // "Add month" modal (opened from the month-pills row) — holds the dashboard
  // dropzone so the next month can be uploaded without the inline zone.
  const [addMonthOpen, setAddMonthOpen] = useState(false);
  // Files awaiting period-end confirmation before the scan runs (null = dialog
  // closed). Set by startScan; cleared by the dialog's confirm/cancel.
  const [periodConfirm, setPeriodConfirm] = useState<File[] | null>(null);
  useEffect(() => {
    writeStagedFiles("dashboard", stagedFiles);
  }, [stagedFiles]);

  // Stage one file (budget decks route straight to Variance; oversize is
  // rejected). Does NOT upload — that happens on Start scan via scanOneFile.
  async function onFileChosen(file: File): Promise<boolean> {
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
          title: t("dash.budgetDeckLoadedTitle"),
          description: t("dash.budgetDeckLoadedBody", { count: n, filename: file.name }),
        });
        navigate("/dashboard/variance");
      } catch (e) {
        toast({
          title: t("dash.budgetDeckErrorTitle"),
          description: e instanceof Error ? e.message : t("dash.unknownParseError"),
          variant: "destructive",
        });
      }
      return false;
    }

    const MAX_BYTES = 25 * 1024 * 1024;
    if (file.size > MAX_BYTES) {
      toast({
        title: t("dash.fileTooLargeTitle"),
        description: t("dash.fileTooLargeBody", { size: (file.size / 1_000_000).toFixed(1) }),
        variant: "destructive",
      });
      return false;
    }
    // Stage the file — do NOT upload yet. The scan starts only when the user
    // clicks "Start scan".
    //
    // ONE file at a time (2026-07-26 per operator): a newly chosen file
    // REPLACES whatever was staged rather than appending. The staged array
    // shape is kept (the dialog, the staged-file list and runScan all iterate
    // it) so this is a single-element invariant, not a refactor of every
    // consumer.
    setStagedFiles([file]);
    return true;
  }

  function discardStagedFile(index: number) {
    setStagedFiles((prev) => prev.filter((_, i) => i !== index));
  }

  function dismissAllStaged() {
    setStagedFiles([]);
  }

  // Upload + enqueue + await terminal status for ONE staged file. Hand-off to
  // State B (navigation / toast) happens only when navigateOnDone — the last
  // file in a batch; earlier files are processed silently, periods persist.
  function scanOneFile(
    file: File,
    navigateOnDone: boolean,
    periodEndHint: string | null = null,
    // AI LANE (2026-08-19) — the period-confirm dialog's jurisdiction
    // dropdown; null = Auto-detect (no hint written, engine decides).
    jurisdictionHint: string | null = null,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      void (async () => {
        setUploadName(file.name);
        startUpload({ docId: "", filename: file.name, status: "queued" });
        const { uploadDocument, subscribeToDocumentStatus, getSupabase } =
          await import("@/lib/supabase");
        const { row, error } = await uploadDocument(file, { scope: "financial", periodEndHint, jurisdictionHint });
        if (!row) {
          clearUpload();
          toast({ title: t("dash.uploadFailedTitle"), description: error ?? t("dash.unknownError"), variant: "destructive" });
          resolve();
          return;
        }
        startUpload({ docId: row.id, filename: file.name, status: "queued" });
        const enq = await uploadEnqueue.enqueue(row.id);
        if (enq.kind !== "queued") {
          const reason =
            enq.kind === "quota_blocked" ? enq.message
            : enq.kind === "non_ro_blocked" ? enq.message
            : enq.kind === "transport_failed" ? enq.message
            : t("dash.uploadCancelled");
          patchUpload({ status: "failed", error: reason });
          resolve();
          return;
        }
        const unsub = subscribeToDocumentStatus(row.id, (next) => {
          patchUpload({ status: next.status, error: next.error, periodId: next.period_id ?? null });
          if (next.status === "analyzed") {
            unsub();
            // A new month/period row now exists for this workspace. Refresh the
            // workspace Months lists (Workspace-tab card pills + the active
            // workspace's Months section, keyed ["org-periods", orgId]) AND the
            // active-workspace month selector (["periods-with-documents"]) so
            // the new month item shows up in the workspaces' months list right
            // away instead of lagging a full staleTime behind.
            if (next.period_id) {
              void queryClient.invalidateQueries({ queryKey: ["org-periods"] });
              void queryClient.invalidateQueries({ queryKey: ["periods-with-documents"] });
              // The period PAYLOAD too (2026-07-26). The cache used to rely on
              // "a re-run produces a brand-new period_id, so the URL key
              // changes" — no longer true: replace-month semantics and the
              // adopt-the-selected-empty-period flow reuse the SAME id, so
              // navigating to ?period=<id> after the scan repainted the STALE
              // payload for its full 30-min staleTime and the dashboard
              // "didn't change" (operator-reported). Two traps here:
              //   · The stale entry can even be a cached `{kind:"not_found"}` —
              //     fetchPeriodFromApi resolves 404s as SUCCESS data, so an
              //     empty period viewed before the upload caches "not found"
              //     as fresh.
              //   · removeQueries (the first fix) is NOT reliable on a query
              //     with active observers — the observer can keep serving its
              //     in-memory data without refetching. resetQueries is the
              //     API documented to reset AND refetch active observers.
              void queryClient.resetQueries({ queryKey: periodQueryKey(next.period_id) });
              // …and the month's Source-files tiles, so the file that just
              // landed shows up there immediately instead of a staleTime
              // later. Prefix key — matches the scoped
              // ["period-documents", id, "financial"] entry.
              void queryClient.invalidateQueries({ queryKey: ["period-documents", next.period_id] });
            }
            void (async () => {
              if (navigateOnDone) {
                // Public-records summary → route to multi-year history.
                if (!next.period_id) {
                  try {
                    const sb = getSupabase();
                    const { data: session } = sb ? await sb.auth.getSession() : { data: { session: null } };
                    const token = session?.session?.access_token;
                    const apiUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";
                    const r = await fetch(`${apiUrl}/api/public-records/by-document/${row.id}`, {
                      headers: token ? { Authorization: `Bearer ${token}` } : {},
                    });
                    if (r.ok) {
                      toast({ title: t("dash.multiYearReadyTitle"), description: t("dash.multiYearReadyBody", { filename: file.name }) });
                      window.location.href = `/multi-year-history?doc=${row.id}`;
                      return;
                    }
                  } catch { /* fall through */ }
                }
                if (next.period_id) {
                  // Don't route into State B yet — hold the analyzed upload on
                  // screen so the scan view shows its "Scan complete" card; the
                  // card's "View results" button (viewResults) navigates. The
                  // completion card is skipped when the tab isn't mounted, so a
                  // background batch that finishes off-screen still resolves.
                  console.info("[scan] analyzed → period", next.period_id, "— opening in 2.4s");
                  setAwaitingView({ periodId: next.period_id });
                  resolve();
                  return;
                }
                toast({ title: t("dash.analysisCompleteTitle"), description: t("dash.noPeriodCreatedBody", { filename: file.name }) });
              }
              clearUpload();
              resolve();
            })();
          }
          if (next.status === "failed") {
            unsub();
            toast({ title: t("dash.analysisFailedTitle"), description: next.error ?? t("dash.unknownError"), variant: "destructive" });
            resolve();
          }
        });
      })();
    });
  }

  // Start scan → first confirm each file's period-end date (auto-detected from
  // the filename, editable) via the dialog, THEN run the batch with the chosen
  // dates. periodConfirm holds the files awaiting confirmation.
  function startScan(filesOverride?: File[]) {
    // Array.isArray, not `??`: the upload zones pass this straight into
    // onClick (`onStartScan={startScan}`), so the first argument can be the
    // click EVENT — spreading that threw "E is not iterable" and the button
    // silently did nothing in prod (2026-08-12 operator report).
    const batch = Array.isArray(filesOverride) ? filesOverride : stagedFiles;
    if (scanning || batch.length === 0) return;
    setPeriodConfirm([...batch]);
  }

  // Scan every staged file sequentially; the last one navigates into its
  // result. Clears the staged list when the batch finishes. `dates` maps
  // filename → confirmed ISO period-end (or null to let the engine detect).
  async function runScan(
    dates: Record<string, string | null>,
    jurisdictionHint: string | null = null,
  ) {
    setPeriodConfirm(null);
    if (scanning || stagedFiles.length === 0) return;
    setScanning(true);
    const batch = [...stagedFiles];
    for (let i = 0; i < batch.length; i++) {
      await scanOneFile(
        batch[i],
        i === batch.length - 1,
        dates[batch[i].name] ?? null,
        jurisdictionHint,
      );
    }
    // Reset the drop zone once the batch is done — staged list AND the
    // "Received: <filename>" indicator, so it returns to a clean empty state.
    setStagedFiles([]);
    setUploadName(null);
    setScanning(false);
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    // First file only — a drop can carry several regardless of the input's
    // `multiple` attribute, which governs the picker dialog and nothing else.
    const file = e.dataTransfer.files?.[0];
    if (file) void onFileChosen(file);
  }

  // DEV-only: simulate the upload → analysis pipeline without a real file
  // or backend call. Drives the global upload store through the same
  // DocumentStatus sequence the real pipeline emits (queued → extracting →
  // mapping → computing → narrating → analyzed), so UploadProgressCard
  // animates end-to-end exactly as it would for a genuine upload. The
  // existing auto-clear effect (analyzed + !hasPeriodLoaded) resets the
  // card back to the dropzone when the walk completes. Never ships to
  // production — gated behind import.meta.env.DEV at the call site.
  async function simulateFileProcess() {
    if (uploadInFlight) return; // don't clobber a real in-flight upload
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // Cancel-confirmation pause: hold the walk while the scan view's
    // "Cancel this analysis?" state is up.
    const waitWhilePaused = async () => {
      while (isScanSpherePaused()) await sleep(200);
    };
    const steps: Array<import("@/lib/supabase").DocumentStatus> = [
      "extracting", "mapping", "computing", "narrating", "analyzed",
    ];
    startUpload({
      docId: `debug-${Date.now()}`,
      filename: "debug_simulation.xlsx",
      status: "queued",
    });
    // Deliberately UNHURRIED (2026-07-24): long enough for the council
    // sphere to evolve through its full visual arc and for every
    // pipeline step to be readable — this is the tool for eyeballing
    // the scanning view, not a smoke test.
    await sleep(2500);
    for (const status of steps) {
      await waitWhilePaused();
      // Hold the analyzed upload so the "Scan complete" card shows (same as
      // the real path). Set BEFORE patching analyzed so the auto-clear hedge,
      // which fires on the status change, sees awaitingView and stands down.
      if (status === "analyzed") setAwaitingView({ periodId: null });
      patchUpload({ status });
      await sleep(status === "analyzed" ? 2000 : 6000);
    }
    // Leave the completion card up — "View results" (no real period in the
    // simulation) clears it via viewResults(). No auto-clear here.
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
      // Follows the ACTIVE UI language (was hardcoded "en", which kept the
      // learning popovers English for RO users — metrics agent's finding).
      locale={i18n.language?.startsWith("ro") ? "ro" : "en"}
      // LEARN-FIX-1 — plumb per-account line items so source-account
      // composition bars inside the popover read REAL engine amounts
      // (keyed by ro_account_code) instead of the 0-RON placeholder
      // from staticSourceAccounts().
      lineItems={remotePeriod.lineItems ?? []}
    >
    <>
    {/* The first-run LearningCoach card ("Learn how CFO AI reads your
        numbers") was removed from this surface 2026-07-24 per operator
        directive; the component still exists for other mounts. */}
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
      {/* Single-file only (2026-07-26 per operator) — no `multiple`, and the
          handler takes just the first entry so a multi-file drag can't slip
          past the picker's own restriction. */}
      <input
        ref={fileRef}
        type="file"
        accept={DASHBOARD_UPLOAD_ACCEPT}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void onFileChosen(file);
          e.target.value = "";  // allow re-picking the same file later
        }}
      />

      {/* Period-end confirmation — auto-detects each staged file's closing
          month from its filename and lets the user confirm or edit before
          analysis runs. */}
      {periodConfirm && (
        <PeriodConfirmDialog
          files={periodConfirm}
          // The SIDEBAR's selection (?period= resolved against the stepper's
          // merged feeds) — covers empty periods, which the analysis payload
          // (remotePeriod) can't resolve. remotePeriod remains the fallback
          // for sample/demo periods, which the feeds don't list.
          activePeriodEnd={
            sidebarPeriod?.period_end ?? (remotePeriod.id ? remotePeriod.periodEnd : null)
          }
          activePeriodId={sidebarPeriod?.period_id ?? remotePeriod.id}
          // No documents ⇒ an empty container — safe to rename to the file's
          // month when the user picks "Scan and update period".
          activePeriodEmpty={
            sidebarPeriod
              ? sidebarPeriod.documents.length === 0
              : !remotePeriod.sourceDocumentFilename
          }
          onConfirm={runScan}
          onCancel={() => setPeriodConfirm(null)}
        />
      )}

      {/* Add-month modal — the dashboard dropzone, opened by the "Add month"
          pill above the header. Starting a scan closes the modal so the
          period-confirm dialog + full-screen scan takeover can show. */}
      <Dialog open={addMonthOpen} onOpenChange={setAddMonthOpen}>
        <DialogContent className="sm:max-w-[640px]" data-testid="add-month-modal">
          <DialogHeader>
            <DialogTitle>{t("dash.addAnotherMonth")}</DialogTitle>
            <DialogDescription>
              {t("dash.addMonthDialogDesc")}
            </DialogDescription>
          </DialogHeader>
          <DashboardAddMonthZone
            hideHeader
            stagedFiles={stagedFiles}
            scanning={scanning}
            onDrop={onDrop}
            onTriggerFile={() => fileRef.current?.click()}
            onViewStaged={(f) => void openStagedFile(f)}
            onDiscardStaged={discardStagedFile}
            onDismissAll={dismissAllStaged}
            onStartScan={() => { setAddMonthOpen(false); startScan(); }}
            onSimulate={() => { setAddMonthOpen(false); void simulateFileProcess(); }}
          />
        </DialogContent>
      </Dialog>

      {/* Consolidated page-guide overlay — driven by the single "Guide me"
          button in the tab bar; shows the ACTIVE tab's guide. */}
      {activeGuide && (
        <PageGuideOverlay
          open={guideOpen}
          pageId={activeGuide.pageId}
          title={t(activeGuide.title)}
          steps={activeGuide.steps}
          onClose={() => setGuideOpen(false)}
        />
      )}

      {/* FE-FIX-2 (revised): State B upload overlay — full-viewport
          centred card with a subtle blurred backdrop, so the upload
          progress feels foregrounded (modal-like) rather than glued to
          the top of the viewport. Replaces the earlier `top-4` placement
          which read as "badly placed" against the dashboard underneath.
          Card is centred both axes; entrance fades + zooms; backdrop is
          translucent enough that the user can still see the dashboard
          re-bucketing in the background, but the upload card commands
          the eye. */}

      <TooltipProvider delayDuration={150}>
        {/* Scan takeover — whenever an upload is in flight, the WHOLE surface
            (both State A entry and State B loaded-month) reduces to the pipeline
            steps + council sphere, so scanning a new month from the dashboard
            dropzone looks identical to the first upload. */}
        {uploadInFlight ? (
          <ScanProgressView
            status={uploadInFlight.status}
            steps={TRIAL_BALANCE_STEPS}
            onCancel={clearUpload}
            onViewResults={viewResults}
          />
        ) : (
        <>
        {hasPeriodLoaded ? (
          <>
            {/* Source files (2026-07-26) — the uploads behind THIS month's
                numbers, in the same tile row Products uses under its pills.
                Financial-scope documents here (that's what "add a file" adds
                on this surface), SKU datasets there. */}
            <DashboardSourceFiles
              periodId={remotePeriod.id ?? searchParams.get("period")}
              onAddFile={(f) => {
                // REPLACE semantics (2026-08-04 fix): stage and open the
                // period-confirm immediately for THIS month — one dialog,
                // one decision. The old wiring opened the "Add another
                // month" dialog, which read as being dumped on an upload
                // page instead of replacing the file.
                void (async () => {
                  const staged = await onFileChosen(f);
                  if (staged) startScan([f]);
                })();
              }}
            />
            {/* Loaded-month header — compact (2026 redesign). The official-
                template card moved into the Overview tab's "Templates &
                examples" disclosure so the first paint stays hero verdict +
                key metrics + recommendations. */}
            <div className="mb-4 min-w-0">
              <CompactPeriodHeader
                statements={statements}
                invoices={invoices}
                activeSampleId={activeSampleId}
                onPickSample={pickSample}
                onTriggerFile={() => fileRef.current?.click()}
                onReset={resetWorkspace}
                briefing={remotePeriod.briefing}
                briefingPeriodId={remotePeriod.id}
              />
            </div>
            {/* Accuracy note — full-width, directly under the header + official-
                template section. */}
            <AccuracyBanner
              assembledBs={statements?.assembled_bs as Record<string, number> | undefined}
              sourceDataQuality={sourceDataQuality ?? null}
              canonicalBs={(statements as Statements | null)?.canonical_bs ?? null}
            />
            {/* The add-another-month dropzone now lives in a modal opened by
                the "Add month" pill (see the Dialog near the period-confirm
                dialog above) — no longer inline here. */}
          </>
        ) : uploadInFlight ? null : (
          <section className="mb-10 transition-opacity duration-200 relative">
            {/* Hidden entirely while a scan is in flight (2026-07-24) — the
                scanning view is just the pipeline steps + the council
                sphere, no "Get started" copy. */}
            {/* Atmospheric brand glow now lives in AppShell (applied app-wide
             *  behind every tab's content), so the hero no longer paints its
             *  own — that would double the glow only on the dashboard. */}

            {/* 2-column hero (2026-07-24, mirrors /products): copy on the
                left, the official-template card (with example trial
                balances) on the right; stacks below lg. */}
            <div className="relative grid grid-cols-1 lg:grid-cols-[1.2fr_1fr] gap-6 items-start">
              <div>
                <div className="inline-flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.16em] text-ink-mute font-semibold">
                  <Sparkles size={10} strokeWidth={2.25} className="text-brand-d" />
                  {t("dashboard.label_eyebrow")}
                </div>
                <h1 className="mt-3 text-[44px] sm:text-[56px] leading-[1.04] tracking-[-0.02em] text-ink max-w-[820px] font-serif">
                  {t("dashboard.hero_pre")}{" "}
                  <span className="text-grad">{t("dashboard.hero_highlight")}</span>
                  {" "}{t("dashboard.hero_post")}
                </h1>
                {/* File-type words rendered as pills, so this is hardcoded JSX
                    rather than the plain-text i18n string. */}
                <p className="mt-5 text-[15.5px] text-ink-soft max-w-[680px] leading-relaxed">
                  <span className="inline-flex items-center align-middle text-[10px] uppercase tracking-[0.08em] font-semibold text-ink bg-bg-2 border border-rule-strong rounded-full px-2 py-0.5">XLSX</span>
                  {" "}{t("common.or")}{" "}
                  <span className="inline-flex items-center align-middle text-[10px] uppercase tracking-[0.08em] font-semibold text-ink bg-bg-2 border border-rule-strong rounded-full px-2 py-0.5">PDF</span>
                  , {t("dash.heroBodyExported")} —{" "}
                  {["SAGA", "WinMentor", "SmartBill", "NEXTUP", "CIEL"].map((sys, i, arr) => (
                    <span key={sys}>
                      <span className="font-semibold text-brand-d">{sys}</span>
                      {i < arr.length - 1 ? ", " : ""}
                    </span>
                  ))}
                  . {t("dash.heroBodyTail")}
                </p>
                {/* Ask CFO AI (same secondary style as the Products hero's
                    button). The Import button that used to lead this row was
                    removed (2026-07-26 per operator) — the dropzone below is
                    the one import path. */}
                <div className="mt-5 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      openAskCfoAi(t("dash.askCfoAiPrompt"))
                    }
                    data-testid="dashboard-ask-cfo-ai"
                    className="
                      inline-flex items-center gap-2 h-10 px-4 rounded-lg
                      border border-rule bg-surface/70 backdrop-blur
                      text-[13px] font-medium text-ink
                      hover:bg-bg-2/60 hover:border-rule-strong
                      transition-colors
                    "
                  >
                    <Sparkles size={16} strokeWidth={2} className="text-brand-d" />
                    {t("topbar.ask")}
                  </button>
                </div>
              </div>
              <div className="relative">
                <DashboardTemplateCard />
              </div>
            </div>
          </section>
        )}

        {/* Accuracy banner moved 2026-07-25 — it now renders directly under the
            CFO briefing in the header (see the State B header column), not here
            above the KPI tiles. */}

        {/* Statutory-format limitation banner — only shows when this
            period was loaded from an ANAF Formular F30+F10 filing, where
            line-item drilldown isn't available. */}
        {hasPeriodLoaded && remotePeriod.detectedType === "statutory_f30_f10" && (
          <StatutoryFormatBanner />
        )}

        {/* Demo banner stays page-level (visible on every tab). The KPI
            card grid that used to render here moved into the Overview tab's
            "All metrics" disclosure (2026 redesign — progressive disclosure);
            its value overrides are hoisted into the `headline` memo above so
            the numbers stay byte-identical. */}
        {hasPeriodLoaded && statements && isDemoPeriod && (
          <DemoBanner onUpload={() => fileRef.current?.click()} />
        )}

        {/* Budget vs Actual dashboard entry point removed 2026-07-25 — it's now
            a first-class sidebar item ("Budget vs Actual" → /dashboard/variance),
            so the inline doorway here is redundant. */}

        {/* Invoice-analytics KPI row moved into the Overview tab's
            "All metrics" disclosure (2026 redesign). */}

        <div className={hasPeriodLoaded ? "mb-8" : ""} />

        {/* Width is governed site-wide by AppShell's content clamp — no
            per-page max-width here (see AppShell.tsx). */}
        <Tabs value={activeTab} onValueChange={onTabChange} className="w-full">
          {/* The tab bar (Overview · Statements · … · Recommendations ·
              Export) is hidden until a document is loaded — the empty state
              is just the upload surface, so the tab strip only appears once
              there's data to navigate. Enabled tabs render normally; tabs
              still missing their data render disabled (45% opacity + tooltip). */}
          {hasPeriodLoaded && (
          <div className="relative">
            <TabsList
              data-testid="tabs-list"
              className="
                h-auto bg-transparent p-0
                flex flex-nowrap sm:flex-wrap justify-start sm:justify-center gap-1
                overflow-x-auto sm:overflow-visible scrollbar-none
              "
            >
              {/* Overview chip — restored as the State B landing (2026
                  redesign). Rendered locally because the lib's TAB_SPECS no
                  longer lists it; always enabled. */}
              <TabsTrigger
                value="overview"
                data-testid="tab-overview"
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
                {t("dashV2.tabOverview")}
              </TabsTrigger>
              {tabs.map((tab) => {
                const isEnabled = enabled[tab.id];
                if (isEnabled) {
                  return (
                    <TabsTrigger
                      key={tab.id}
                      value={tab.id}
                      data-testid={`tab-${tab.id}`}
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
                      {t(tab.label)}
                    </TabsTrigger>
                  );
                }
                // Disabled tab — Radix won't fire tooltip events on a
                // disabled trigger, so we render a styled span lookalike
                // and wrap it in <Tooltip>.
                return (
                  <Tooltip key={tab.id}>
                    <TooltipTrigger asChild>
                      <span
                        role="tab"
                        aria-disabled="true"
                        data-testid={`tab-${tab.id}`}
                        className="
                          shrink-0 px-3.5 py-1.5 text-[12.5px] font-medium
                          rounded-xl whitespace-nowrap
                          opacity-40 cursor-not-allowed select-none text-ink-soft
                        "
                      >
                        {t(tab.label)}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-[280px] text-[12px] leading-snug">
                      {disabledHint(tab.id, t)}
                    </TooltipContent>
                  </Tooltip>
                );
              })}
              {/* "Guide me" moved OUT of the tab bar (2026-07-26) — it now
                  rides above the Source-files row, matching Products. Two
                  identical buttons on one screen would have been the cost of
                  copying that section over wholesale. It stays tab-aware:
                  the trigger still opens the ACTIVE tab's guide. */}
            </TabsList>
            <div aria-hidden className="sm:hidden pointer-events-none absolute inset-y-1 left-0 w-6 bg-gradient-to-r from-bg to-transparent" />
            <div aria-hidden className="sm:hidden pointer-events-none absolute inset-y-1 right-0 w-6 bg-gradient-to-l from-bg to-transparent" />
          </div>
          )}

        {/* OVERVIEW ─────────────────────────────────────────────────────── */}
        <TabsContent value="overview" className="mt-6 space-y-6">
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
          {/* 2026-07-25 — the benign "n/a" info pill (Claude-extracted
              uploads) and the "Extracted from · <file>" banner were removed
              from the overview per operator directive; the header briefing now
              carries the source context. `telemetryAvailable` is forced true so
              only the REAL >2% source-imbalance WARN can still render (kept: it
              flags trial balances that don't reconcile). */}
          <SourceQualityBanner
            sourceQuality={sourceDataQuality}
            currency={statements?.currency ?? "RON"}
            telemetryAvailable
          />

          {!hasPeriodLoaded ? (
            // STATE A — entry surface. The drop zone stays mounted during a
            // scan and renders the progress in-place (steps animate to the
            // top); there is no separate progress modal/card.
            //
            // ABOVE the dropzone, we surface the user's most recent public-
            // records upload as a Level-1 quick card (renders nothing when
            // there's no public-records data).
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
                onSimulate={simulateFileProcess}
                stagedFiles={stagedFiles}
                onDiscardStaged={discardStagedFile}
                onDismissAll={dismissAllStaged}
                onStartScan={startScan}
                scanning={scanning}
                inflight={uploadInFlight}
                onViewResults={viewResults}
              />
            </>
          ) : (
            <>
            {/* Notes & recommendations jump pill — moved down here
                (2026-07-26 per operator) so it sits directly above the
                metrics grid instead of at the top of the page. Colour ranks
                by the WORST severity present: red for critical/high, amber
                for watch, blue for info, teal when it's only
                recommendations. */}
            <NotesJumpPill
              alerts={remotePeriod.alerts ?? []}
              recommendationCount={remotePeriod.recommendations?.length ?? 0}
            />

            {/* ── 2026 narrative hierarchy ──────────────────────────────
                1. Hero verdict (health score + plain-language sentence)
                2. Four key metric cards (Revenue · EBITDA · Cash · Net debt)
                3. Recommendations (editorial action cards + filter)
                4. Collapsible: full KPI grid + invoice analytics
                5. Valuation (below the fold)
                6. Collapsible: templates & examples */}
            <HeroVerdictCard
              credit={heroCredit}
              companyName={statements?.companyName ?? null}
            />

            {statements && totals && headline && (
              <div
                className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 cards-stagger"
                data-testid="key-metrics"
              >
                <KeyMetricCard
                  label={t("dashV2.metricRevenue")}
                  desc={t("dashV2.metricRevenueDesc")}
                  value={headline.totalOperatingRevenue}
                  currency={statements.currency}
                  trend={trendFor("operating_revenue")}
                  testid="key-metric-revenue"
                />
                <KeyMetricCard
                  label={t("dashV2.metricEbitda")}
                  desc={t("dashV2.metricEbitdaDesc")}
                  value={headline.tileEbitdaRon}
                  currency={statements.currency}
                  trend={trendFor("ebitda")}
                  testid="key-metric-ebitda"
                />
                <KeyMetricCard
                  label={t("dashV2.metricCash")}
                  desc={t("dashV2.metricCashDesc")}
                  value={statements.balanceSheet.cash}
                  currency={statements.currency}
                  trend={trendFor("cash")}
                  testid="key-metric-cash"
                />
                <KeyMetricCard
                  label={t("dashV2.metricNetDebt")}
                  desc={t("dashV2.metricNetDebtDesc")}
                  value={totals.netDebt}
                  currency={statements.currency}
                  trend={null}
                  testid="key-metric-net-debt"
                />
              </div>
            )}

            {statements && recommendations.length > 0 && (
              <RecommendationsSection
                recommendations={recommendations}
                currency={statements.currency}
                testid="overview-recommendations"
              />
            )}

            {/* Full configurable KPI grid + invoice analytics — behind a
                disclosure so the overview's first paint stays focused. Open
                by default: the section sits below the fold, and the grid's
                testids stay reachable. */}
            {statements && totals && headline && (
              <DisclosureSection
                title={t("dashV2.allMetricsTitle")}
                subtitle={t("dashV2.allMetricsSub")}
                defaultOpen
                testid="overview-all-metrics"
              >
                <div title={headline.sourceTooltip ?? undefined}>
                  <DashboardProvider>
                    <DashboardViewProvider>
                      <ConfigurableDashboard
                        overrides={{
                          operating_revenue: headline.totalOperatingRevenue,
                          ebitda: headline.tileEbitdaRon,
                          net_profit: headline.tileNetProfitRon,
                          total_debt: totals.totalDebt,
                          open_risks: criticalCount + highCount,
                          open_opportunities: recommendations.filter(
                            (r) => r.priority === "medium" || r.priority === "info",
                          ).length,
                        }}
                        series={multiYearSeries}
                      />
                    </DashboardViewProvider>
                  </DashboardProvider>
                  {headline.sourceTooltip && remotePeriod.detectedType === "statutory_f30_f10" && (
                    <div
                      data-testid="kpi-source-badge"
                      className="text-[10.5px] text-ink-mute mb-3 mt-1"
                    >
                      {t("dash.sourceStatutoryBadge")}
                    </div>
                  )}
                </div>
                {invoices && invoices.length > 0 && <InvoiceKpiStrip invoices={invoices} />}
              </DisclosureSection>
            )}

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

            {/* Official template + example trial balances — tucked behind a
                closed disclosure in State B (State A keeps its hero card). */}
            <DisclosureSection
              title={t("dashV2.templatesTitle")}
              subtitle={t("dashV2.templatesSub")}
              testid="overview-templates"
            >
              <div className="max-w-[560px]">
                <DashboardTemplateCard />
              </div>
            </DisclosureSection>
            </>
          )}
        </TabsContent>

        {/* P&L ──────────────────────────────────────────────────────────── */}
        {enabled.pl && statements && (
          <TabsContent value="pl" className="mt-6 space-y-8 min-h-[400px]">
            <PLStatementView
              hideGuide
              statement={pickPLBuilder(
                {
                  lineItems: remotePeriod.lineItems,
                  entity: statements.companyName ?? t("dash.entity"),
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
                hideGuide
                periodId={remotePeriod.id ?? searchParams.get("period")}
                statement={buildBSStatement({
                  lineItems: remotePeriod.lineItems,
                  entity: statements.companyName ?? t("dash.entity"),
                  asOf: statements.periodLabel ?? t("dash.periodEndFallback"),
                  comparativeDate: t("dash.opening"),
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
                  // canonical_bs v2 — when the period carries the engine
                  // authority object, the whole statement renders from it
                  // verbatim (incl. the reconcile status strip); legacy
                  // periods keep the assembledBs path above unchanged.
                  canonicalBs: (statements as Statements).canonical_bs,
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
              hideGuide
              statement={buildCashFlowStatement({
                pl: (statements as Statements & { assembled_pl?: Record<string, number> }).assembled_pl,
                bs: (statements as Statements & { assembled_bs?: Record<string, number> }).assembled_bs,
                cf: (statements as Statements & { assembled_cf?: Record<string, number> }).assembled_cf,
                lineItems: remotePeriod.lineItems ?? [],
                entity: statements.companyName ?? t("dash.entity"),
                period: statements.periodLabel ?? t("dash.periodFallback"),
                currency: statements.currency,
                yearLabel: (() => {
                  const lbl = statements.periodLabel ?? "";
                  const m = lbl.match(/\b(20\d{2})\b/);
                  return m ? m[1] : t("dash.thePeriod");
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
                  if (explicitCre) reasonLines.push(t("dash.reasonIndustryCre", { industry: indRaw }));
                  if (rentalDominated) reasonLines.push(t("dash.reasonRentalDominated"));
                  if (engineSaysAssetBased) reasonLines.push(t("dash.reasonEngineAssetBased"));
                  if (assetIntensityHeavy && assetIntensity !== null) {
                    reasonLines.push(t("dash.reasonAssetIntensity", { intensity: (assetIntensity * 100).toFixed(0), threshold: (ASSET_INTENSITY_THRESHOLD * 100).toFixed(0) }));
                  }

                  return (
                    <>
                      <HeavyReReasonBanner reasonLines={reasonLines} />
                      {/* NAV cascade — PRIMARY for CRE */}
                      <NavValuationView
                        cascade={cascade}
                        entity={statements.companyName ?? t("dash.entity")}
                        period={statements.periodLabel ?? t("dash.periodFallback")}
                        currency={statements.currency}
                      />
                      {/* EBITDA-multiple SECOND — still visible because
                       *  lenders + brokers reference it, but explicitly
                       *  framed as the secondary method. */}
                      {canonical && (
                        <section className="space-y-3">
                          <header>
                            <div className="text-[10.5px] uppercase tracking-[0.14em] text-ink-mute font-semibold">
                              {t("dash.secondaryEbitdaCrossCheck")}
                            </div>
                          </header>
                          <EbitdaMultiplePrimaryCard
                            hideGuide
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
                        hideGuide
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
                          {t("dash.persistedAssumptions")}
                        </div>
                        <p className="text-[12.5px] text-ink-soft mt-1 max-w-[640px]">
                          {t("dash.persistedAssumptionsBody")}
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
          {statements && recommendations.length > 0 ? (
            <RecommendationsSection
              recommendations={recommendations}
              currency={statements.currency}
              testid="recommendations-tab-list"
            />
          ) : (
            <EmptyTabState
              title={t("dash.noRecsTitle")}
              body={t("dash.noRecsBody")}
              ctaTab="overview"
              onCta={() => onTabChange("overview")}
            />
          )}
        </TabsContent>

        {/* EXPORT ─────────────────────────────────────────────────────── */}
        <TabsContent value="export" className="mt-6 space-y-4 min-h-[400px]">
          {!statements ? (
            <EmptyTabState
              title={t("dash.nothingToExportTitle")}
              body={t("dash.nothingToExportBody")}
              ctaTab="overview"
              onCta={() => onTabChange("overview")}
            />
          ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-stretch">
          {/* HTML report — brand sleeve. */}
          <div className="relative flex overflow-hidden rounded-2xl border border-rule bg-surface min-h-[240px]">
            <div className="w-2 shrink-0 bg-brand" />
            <div className="relative flex-1 p-3.5 flex flex-col">
              <div aria-hidden className="pointer-events-none absolute -bottom-10 -left-8 text-brand opacity-[0.08]">
                <FileText size={230} strokeWidth={1} />
              </div>
              <div className="relative">
                <h3 className="font-serif text-[26px] leading-tight text-ink">{t("dash.exportHtmlTitle")}</h3>
                <p className="text-[13.5px] text-ink-soft mt-1">
                  {t("dash.exportHtmlBody")}
                </p>
              </div>
              <div className="relative mt-auto pt-6 flex justify-end">
                <button
                  onClick={() => downloadReport(statements)}
                  className="inline-flex items-center gap-2 h-10 px-4 rounded-lg ask-ai-anim-fill [animation-duration:10s] border border-brand/40 text-ink text-[13px] font-medium hover:border-brand/60 transition-colors"
                >
                  <ArrowDownToLine size={15} strokeWidth={2} />
                  {t("common.download")}
                </button>
              </div>
            </div>
          </div>

          {/* Excel workbook — green sleeve. */}
          <div className="relative flex overflow-hidden rounded-2xl border border-rule bg-surface min-h-[240px]">
            <div className="w-2 shrink-0 bg-green-600" />
            <div className="relative flex-1 p-3.5 flex flex-col">
              <div aria-hidden className="pointer-events-none absolute -bottom-10 -left-8 text-green-600 opacity-[0.09]">
                <FileSpreadsheet size={230} strokeWidth={1} />
              </div>
              <div className="relative">
                <h3 className="font-serif text-[26px] leading-tight text-ink">{t("dash.exportXlsxTitle")}</h3>
                <p className="text-[13.5px] text-ink-soft mt-1">
                  {t("dash.exportXlsxBody")}
                </p>
              </div>
              <div className="relative mt-auto pt-6 flex justify-end">
                <button
                  onClick={() =>
                    import("@/lib/financialExports").then((m) =>
                      m.downloadExcelReport(statements),
                    )
                  }
                  className="inline-flex items-center gap-2 h-10 px-4 rounded-lg ask-ai-anim-fill [animation-duration:10s] border border-brand/40 text-ink text-[13px] font-medium hover:border-brand/60 transition-colors"
                >
                  <ArrowDownToLine size={15} strokeWidth={2} />
                  {t("common.download")}
                </button>
              </div>
            </div>
          </div>

          {/* PowerPoint deck — orange sleeve. Coming next (no download yet). */}
          <div className="relative flex overflow-hidden rounded-2xl border border-rule bg-surface min-h-[240px]">
            <div className="w-2 shrink-0 bg-orange-500" />
            <div className="relative flex-1 p-3.5 flex flex-col">
              <div aria-hidden className="pointer-events-none absolute -bottom-10 -left-8 text-orange-500 opacity-[0.09]">
                <Presentation size={230} strokeWidth={1} />
              </div>
              <div className="relative">
                <h3 className="font-serif text-[26px] leading-tight text-ink">{t("dash.exportPptxTitle")}</h3>
                <p className="text-[13.5px] text-ink-soft mt-1">
                  {t("dash.exportPptxBody")}
                </p>
              </div>
              <div className="relative mt-auto pt-6 flex justify-end">
                <span className="inline-flex items-center gap-1.5 text-[11.5px] uppercase tracking-[0.1em] text-ink-mute font-medium">
                  <Sparkles size={11} strokeWidth={2} />
                  {t("dash.comingNext")}
                </span>
              </div>
            </div>
          </div>
          </div>
          )}
        </TabsContent>
      </Tabs>
        {/* Dev tools — bottom of the page, below every tab's content. Ships
            in production per the operator (2026-07-26); see DashboardDevTools. */}
        <DashboardDevTools />
        </>
        )}
      </TooltipProvider>

    </>
    </ReportingContextProvider>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

// friendlyUploadError() removed in the 2026 redesign — zero callers and
// EN-only literals (i18n stray). Recoverable from git history.

// ─── Period-end confirmation dialog ──────────────────────────────────────────
// Before a scan runs, the user resolves a date conflict as an ACTION
// (2026-07-26 per operator), not a date pick:
//   · "Change the period to match the file" — the selected period takes the
//     file's closing month. When the selected period is an empty container,
//     its row is literally renamed (updatePeriodEnd) BEFORE the upload, so
//     the periodEndHint then finds that same row by (org_id, period_end) and
//     adopts it — no dangling empty month, no sibling period.
//   · "Ignore the file's date" — the file uploads into the selected period,
//     whose month wins via periodEndHint.
// The free month input only returns as a fallback when NEITHER side offers a
// date.
function PeriodConfirmDialog({
  files,
  activePeriodEnd,
  activePeriodId,
  activePeriodEmpty,
  onConfirm,
  onCancel,
}: {
  files: File[];
  /** period_end of the app's currently selected period (ISO), null when no
   *  period is loaded — then only the file-date option renders. */
  activePeriodEnd?: string | null;
  /** Its id — needed to rename the container on "match the file". */
  activePeriodId?: string | null;
  /** True when the selected period has no source document yet. Renaming is
   *  only safe then: a period with an analysis keeps its month, and "match
   *  the file" degrades to filing under the file's month as its own period. */
  activePeriodEmpty?: boolean;
  /** Second arg — AI LANE (2026-08-19): the jurisdiction dropdown's value
   *  as an upload hint ("RO" | "HU" | "INTL"), or null for Auto-detect. */
  onConfirm: (
    dates: Record<string, string | null>,
    jurisdictionHint?: string | null,
  ) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const activeMonth =
    activePeriodEnd && /^\d{4}-\d{2}/.test(activePeriodEnd)
      ? activePeriodEnd.slice(0, 7)
      : null;

  // Duplicate-name guard (2026-08-04 source-line fix): staging a file whose
  // name matches a document already in this period gets an inline note that
  // scanning will REPLACE it in the analysis. Same cache entry as the
  // source-credit line — no extra fetch when it's already warm.
  const { data: existingDocs } = useQuery({
    queryKey: ["period-documents", activePeriodId ?? null, "financial"],
    queryFn: async () => {
      if (!activePeriodId) return [];
      const { listDocumentsForPeriod } = await import("@/lib/supabase");
      return listDocumentsForPeriod(activePeriodId, 50, "financial");
    },
    enabled: !!activePeriodId,
  });
  const hasDuplicateName = files.some((f) =>
    (existingDocs ?? []).some((d) => d.original_filename === f.name),
  );

  // What the FILE says, per file ("YYYY-MM"). Seeded synchronously from the
  // filename so the dialog opens with a value; upgraded from file CONTENT
  // once the async read resolves.
  const [detected, setDetected] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of files) {
      const iso = detectPeriodEndFromFilename(f.name);
      if (iso) init[f.name] = iso.slice(0, 7);
    }
    return init;
  });
  // Manual fallback month, only used when neither source has a date.
  const [manual, setManual] = useState<Record<string, string>>({});
  // AI LANE (2026-08-19) — accounting jurisdiction for the scan. Default
  // "auto" (engine detects); anything else rides the upload as
  // documents.jurisdiction_hint.
  const [jurisdiction, setJurisdiction] = useState<string>("auto");
  const [reading, setReading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const queryClient = useQueryClient();

  useEffect(() => {
    let cancelled = false;
    setReading(true);
    (async () => {
      const found: Record<string, string> = {};
      for (const f of files) {
        const iso = await detectPeriodEndFromFile(f);
        if (iso) found[f.name] = iso.slice(0, 7);
      }
      if (cancelled) return;
      setDetected((prev) => ({ ...prev, ...found }));
      setReading(false);
    })();
    return () => {
      cancelled = true;
    };
    // Files are fixed for the dialog's lifetime (a snapshot passed by startScan).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The decision lives in the FOOTER (2026-07-26 per operator) — the cards
  // above are informational (selected vs detected). Two actions:
  //   · "keep"   — Scan: ignore the file's date, upload into the selected
  //                period (its month is the hint).
  //   · "update" — Scan and update period: the period takes the file's month.
  async function confirm(action: "keep" | "update") {
    if (confirming) return;
    setConfirming(true);
    const lastDayIso = (ym: string) => {
      // Trial-balance convention: the period-end is the LAST day of the month.
      const [y, m] = ym.split("-").map(Number);
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      return `${ym}-${String(last).padStart(2, "0")}`;
    };
    // Per-file month under the chosen action. Either source may be missing;
    // the other fills in, then the manual fallback, then null (engine detects).
    const resolvedMonth = (f: File): string | null => {
      const fileYm = detected[f.name] ?? null;
      const m = manual[f.name];
      const manualYm = m && /^\d{4}-\d{2}$/.test(m) ? m : null;
      return action === "update"
        ? fileYm ?? activeMonth ?? manualYm
        : activeMonth ?? fileYm ?? manualYm;
    };

    const dates: Record<string, string | null> = {};
    for (const f of files) {
      const ym = resolvedMonth(f);
      dates[f.name] = ym ? lastDayIso(ym) : null; // null → the engine detects it
    }

    // "Scan and update period": rename the selected EMPTY container to the
    // file's month first, so the hint below adopts that same row instead of
    // leaving it dangling and creating a sibling. Only for empty periods —
    // one with an analysis keeps its month.
    const firstYm = files[0] ? detected[files[0].name] ?? null : null;
    if (
      action === "update" &&
      activePeriodId &&
      activePeriodEmpty &&
      firstYm &&
      firstYm !== activeMonth
    ) {
      const { updatePeriodEnd } = await import("@/lib/orgPeriods");
      const err = await updatePeriodEnd(activePeriodId, lastDayIso(firstYm));
      if (err) {
        // Non-fatal: the scan still files under the file's month (its own
        // period); the empty container just stays where it was.
        console.warn("[period-confirm] rename failed:", err);
      } else {
        void queryClient.invalidateQueries({ queryKey: ["org-periods"] });
        void queryClient.invalidateQueries({ queryKey: ["periods-with-documents"] });
      }
    }

    onConfirm(dates, jurisdictionHintFromSelection(jurisdiction));
  }

  // Mid-month day dodges timezone month-shift in toLocaleDateString.
  const monthLabel = (ym: string | null) =>
    ym ? formatDetectedMonth(`${ym}-15`) || ym : "";

  const multiple = files.length > 1;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent className="sm:max-w-[480px]" data-testid="period-confirm-dialog">
        {/* The header names the situation: a conflict gets the decision
            framing; agreement or a missing side gets a plain confirm. Based
            on the first file — uploads are single-file (2026-07-26). */}
        {(() => {
          const firstYm = files[0] ? detected[files[0].name] ?? null : null;
          const conflict = !!firstYm && !!activeMonth && firstYm !== activeMonth;
          return (
            <DialogHeader>
              <DialogTitle>
                {conflict ? t("dash.periodConflictTitle") : t("dash.periodConfirmTitle")}
              </DialogTitle>
              <DialogDescription>
                {conflict
                  ? t("dash.periodConflictDesc")
                  : t("dash.periodConfirmDesc")}
              </DialogDescription>
            </DialogHeader>
          );
        })()}

        {hasDuplicateName && (
          <p
            data-testid="period-confirm-duplicate-note"
            className="rounded-lg border border-amber-500/30 bg-amber-500/[0.08] px-3 py-2 text-[12px] leading-snug text-amber-600 dark:text-amber-300"
          >
            {t("srcline.dupNote")}
          </p>
        )}

        <div className="space-y-3 max-h-[46vh] overflow-y-auto">
          {files.map((f) => {
            const fileYm = detected[f.name] ?? null;
            const agree = !!fileYm && !!activeMonth && fileYm === activeMonth;
            const periodCard = (title: string, ym: string | null) => (
              <div className="flex-1 min-w-0 rounded-lg border border-rule bg-surface px-3 py-2.5 text-center">
                <span className="block text-[10px] uppercase tracking-[0.12em] font-semibold text-ink-mute">
                  {title}
                </span>
                <span className="block text-[13px] font-medium tabular-nums text-ink mt-0.5">
                  {ym ? monthLabel(ym) : "—"}
                </span>
              </div>
            );
            return (
              <div key={f.name} className="space-y-2">
                {/* The file itself, above the comparison — click opens its
                    preview in a new window (same renderer the staged-file
                    list uses), so what's being filed can be inspected before
                    deciding where it lands. */}
                <button
                  type="button"
                  onClick={() => void openStagedFile(f)}
                  data-testid="period-confirm-file-preview"
                  title={t("dash.openPreviewTitle")}
                  className="w-full flex items-center gap-2 rounded-lg border border-rule bg-bg-2/30 px-3 py-2.5 text-left hover:border-rule-strong hover:bg-bg-2/60 transition-colors"
                >
                  <FileSpreadsheet size={16} strokeWidth={1.75} className="text-ink-mute shrink-0" />
                  <span className="text-[12.5px] font-medium text-ink truncate">{f.name}</span>
                  <span className="ml-auto shrink-0 text-[10.5px] uppercase tracking-[0.08em] text-ink-mute">
                    {t("dash.preview")}
                  </span>
                </button>

                {agree ? (
                  // Both sources name the same month — nothing to decide.
                  <p className="text-[11.5px] text-ink-soft px-0.5">
                    <span className="font-medium text-ink">{monthLabel(fileYm)}</span>{" "}
                    {t("dash.fileMatchesPeriodTail")}
                  </p>
                ) : fileYm || activeMonth ? (
                  // Selected vs detected, side by side.
                  <div className="flex items-center gap-2.5" data-testid="period-confirm-vs">
                    {periodCard(t("dash.selectedPeriod"), activeMonth)}
                    <span className="shrink-0 text-[10.5px] uppercase tracking-[0.12em] font-semibold text-ink-mute">
                      {t("dash.vs")}
                    </span>
                    {fileYm ? (
                      periodCard(t("dash.detectedPeriod"), fileYm)
                    ) : (
                      <div className="flex-1 min-w-0 rounded-lg border border-dashed border-rule px-3 py-2.5 text-center">
                        <span className="block text-[10px] uppercase tracking-[0.12em] font-semibold text-ink-mute">
                          {t("dash.detectedPeriod")}
                        </span>
                        <span className="mt-0.5 inline-flex items-center gap-1.5 text-[11.5px] text-ink-mute">
                          {reading ? (
                            <>
                              <Loader2 size={11} className="animate-spin" />
                              {t("dash.reading")}
                            </>
                          ) : (
                            t("dash.noDateFound")
                          )}
                        </span>
                      </div>
                    )}
                  </div>
                ) : (
                  // Neither source has a date — the old manual picker returns
                  // as the last resort.
                  <div className="flex items-center justify-between gap-3">
                    <label className="text-[11.5px] text-ink-mute">
                      {reading ? t("dash.readingFile") : t("dash.noDateFoundPick")}
                    </label>
                    <input
                      type="month"
                      value={manual[f.name] ?? ""}
                      onChange={(e) =>
                        setManual((prev) => ({ ...prev, [f.name]: e.target.value }))
                      }
                      data-testid="period-confirm-month"
                      className="h-9 px-2.5 rounded-lg border border-rule bg-surface text-[13px] text-ink focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand-d/40"
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* AI LANE (2026-08-19) — accounting jurisdiction, decided BEFORE
            the scan. Auto-detect (default) sends no hint; a country choice
            rides the upload as jurisdiction_hint. */}
        <div className="flex items-center justify-between gap-3">
          <label
            htmlFor="period-confirm-jurisdiction"
            className="text-[11.5px] text-ink-mute"
          >
            {t("bsCanonical.jurisdiction.dialogLabel")}
          </label>
          <JurisdictionSelect
            id="period-confirm-jurisdiction"
            value={jurisdiction}
            onChange={setJurisdiction}
            data-testid="period-confirm-jurisdiction"
            className="h-9 rounded-lg border border-rule bg-surface px-2.5 text-[13px] text-ink focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand-d/40"
          />
        </div>

        {/* The footer IS the decision (2026-07-26 per operator — Cancel was
            replaced by the second action; Esc / the X still dismiss):
              · "Scan and update period" — the period takes the file's month.
                Only offered when the two sides actually disagree.
              · "Scan" — upload into the selected period as-is. */}
        {(() => {
          const firstYm = files[0] ? detected[files[0].name] ?? null : null;
          const conflict = !!firstYm && !!activeMonth && firstYm !== activeMonth;
          return (
            <DialogFooter className="gap-2">
              {/* "Scan and update period" is the PRIMARY (gradient) action on
                  the right; plain "Scan" sits secondary on the left
                  (2026-07-26 per operator — swapped from the initial cut).
                  With no conflict there's no update button, so "Scan" — the
                  only action — takes the primary treatment back. */}
              <button
                type="button"
                onClick={() => void confirm("keep")}
                disabled={confirming}
                data-testid="period-confirm-scan"
                className={
                  conflict
                    ? "inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg border border-rule text-[13px] font-medium text-ink hover:bg-bg-2/70 disabled:opacity-50 transition-colors"
                    : "inline-flex items-center gap-1.5 h-9 px-4 rounded-lg ask-ai-anim-fill [animation-duration:10s] border border-brand/40 text-ink text-[13px] font-medium hover:border-brand/60 disabled:opacity-50 transition-colors"
                }
              >
                {confirming && !conflict && <Loader2 size={14} className="animate-spin" />}
                {t("dash.scan")}
              </button>
              {conflict && (
                <button
                  type="button"
                  onClick={() => void confirm("update")}
                  disabled={confirming}
                  data-testid="period-confirm-scan-update"
                  className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg ask-ai-anim-fill [animation-duration:10s] border border-brand/40 text-ink text-[13px] font-medium hover:border-brand/60 disabled:opacity-50 transition-colors"
                >
                  {confirming && <Loader2 size={14} className="animate-spin" />}
                  {t("dash.scanAndUpdate")}
                </button>
              )}
            </DialogFooter>
          );
        })()}
      </DialogContent>
    </Dialog>
  );
}

// ExtractionConfidenceBanner removed in the 2026 redesign — unmounted since
// 2026-07-25 (header briefing carries the source context) and EN-only.

// ─── CFO Briefing card — currency-aware ─────────────────────────────────
// The briefing prose is generated by Opus 4.7 with numbers baked into the
// text ("8,121,590 RON revenue"). The top-bar currency toggle can't reformat
// baked text, so we re-POST to /briefing/regenerate?currency=X whenever the
// toggle changes. Server FX-converts briefing_facts before the LLM call,
// LLM re-narrates in the new currency. Loading state shows the cached RON
// briefing greyed out + a spinner so the user knows fresh prose is incoming.
// A briefing body that is actually an ERROR (the engine's old behavior
// persisted raw provider failures verbatim — "Narrative unavailable:
// Error code: 400 … credit balance is too low…"). Never render these as
// prose; show the localized fallback instead.
function isUnusableNarrative(s: string | null | undefined): boolean {
  if (!s) return true;
  return /\[NARRATIVE_UNAVAILABLE\]|Narrative unavailable|invalid_request_error|credit balance|Error code: \d/i.test(s);
}

function CFOBriefingCard({
  periodId,
  baseBriefing,
  collapsed = false,
  onToggle,
}: {
  periodId: string;
  baseBriefing: string;
  /** 2026 redesign — the header renders the briefing clamped to two lines by
   *  default so the overview's first paint stays hero + metrics + recs. The
   *  card stays MOUNTED either way (its currency/language regeneration
   *  effects keep running); only the presentation collapses. */
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const display = useDisplayCurrency();
  const baseUsable = !isUnusableNarrative(baseBriefing);
  const [text, setText] = useState<string>(baseUsable ? baseBriefing : "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Language awareness (2026-08-04): the persisted briefing was generated
  // in the UI language active AT SCAN TIME. If the user has since switched
  // EN↔RO, re-narrate in the language they're reading — "no RO body under
  // EN labels". Detection is cheap and reliable for this language pair:
  // Romanian business prose always carries diacritics, English never does.
  const activeLang = (i18n.language || "en").slice(0, 2);
  const baseLang = /[șțăîâȘȚĂÎÂ]/.test(baseBriefing) ? "ro" : "en";
  const langMismatch = activeLang !== baseLang && (activeLang === "ro" || activeLang === "en");

  // Reset to baseline if user switches periods (different periodId)
  // OR returns to RON (the canonical persisted briefing) in its own language.
  useEffect(() => {
    if (display === "RON" && !langMismatch) {
      setText(baseUsable ? baseBriefing : "");
      setError(null);
    }
  }, [baseBriefing, baseUsable, display, langMismatch]);

  useEffect(() => {
    if (display === "RON" && !langMismatch) return;
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
          `${apiUrl}/api/period/${periodId}/briefing/regenerate?currency=${display}&language=${activeLang}`,
          { method: "POST", headers: { Authorization: `Bearer ${token}` } },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (
          !cancelled &&
          typeof data.briefing === "string" &&
          data.briefing.length > 0 &&
          !isUnusableNarrative(data.briefing)
        ) {
          setText(data.briefing);
        } else if (!cancelled && isUnusableNarrative(data.briefing)) {
          // Regeneration failed upstream (e.g. provider billing). Keep
          // whatever prose we already have; surface a friendly note.
          setError(t("dash.narrativeUnavailable"));
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
    // eslint-disable-next-line react-hooks/exhaustive-deps — activeLang/langMismatch drive the same debounce
  }, [display, periodId, activeLang, langMismatch]);

  // Chrome-less (2026-07-25): the briefing IS the header's subtitle, so it
  // drops the bordered card and renders as plain prose styled like the
  // subtitle across the app's tab headers (soft ink, relaxed leading) — just
  // a small eyebrow label above and the accuracy note below.
  return (
    <div data-testid="cfo-briefing" className="mt-3 max-w-[1040px]">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-2 text-[10.5px] uppercase tracking-[0.1em] text-brand-d font-medium">
          <Sparkles size={11} strokeWidth={2} />
          {t("dash.cfoBriefingEyebrow")}
          {display !== "RON" && (
            <span className="text-ink-mute normal-case tracking-normal">
              · {t("dash.displayedIn", { currency: display })}
            </span>
          )}
        </div>
        {loading && (
          <div className="flex items-center gap-1.5 text-[11px] text-ink-mute">
            <Loader2 size={12} className="animate-spin" />
            {t("dash.regeneratingIn", { currency: display })}
          </div>
        )}
      </div>
      <p
        className={`text-[14px] sm:text-[14.5px] text-ink-soft leading-relaxed transition-opacity ${loading ? "opacity-60" : ""} ${collapsed ? "line-clamp-2" : ""}`}
      >
        {text}
      </p>
      {onToggle && (
        <button
          type="button"
          onClick={onToggle}
          data-testid="cfo-briefing-toggle"
          className="mt-1.5 inline-flex items-center gap-1 text-[11.5px] font-medium text-brand-d hover:text-brand transition-colors"
        >
          {collapsed ? t("dashV2.briefingShowMore") : t("dashV2.briefingShowLess")}
          <ChevronDown
            size={12}
            strokeWidth={2}
            className={`transition-transform duration-200 ${collapsed ? "" : "rotate-180"}`}
          />
        </button>
      )}
      {error && (
        <p className="mt-2 text-[11px] text-[#2AA89B]">
          {t("dash.regenFailed", { currency: display, error })}
        </p>
      )}
      {!collapsed && (
        <p className="mt-3 text-[11px] italic text-ink-mute leading-relaxed">
          {t("dash.briefingDisclaimer")}
        </p>
      )}
    </div>
  );
}

function InvoiceKpiStrip({ invoices }: { invoices: Invoice[] }) {
  const { t } = useTranslation();
  const customers = useMemo(() => customerAnalytics(invoices), [invoices]);
  const payments = useMemo(() => paymentsAnalytics(invoices), [invoices]);
  const vat = useMemo(() => vatAnalytics(invoices), [invoices]);
  const cur = invoices[0]?.currency ?? "RON";
  return (
    <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-3">
      <KpiTile
        label={t("dash.topCustomerShare")}
        value={`${(customers.top_1_share * 100).toFixed(1)}%`}
        sub={customers.customers[0]?.name?.slice(0, 26) ?? "—"}
      />
      <KpiTile
        label={t("workingCapital.dsoLabel")}
        value={`${payments.dso_days.toFixed(0)} ${t("common.unit.days")}`}
        sub={t("dash.dsoSub")}
      />
      <KpiTile
        label={t("dash.paidOnTime")}
        value={`${(payments.paid_on_time_pct * 100).toFixed(0)}%`}
        sub={t("dash.ofSettledInvoices")}
      />
      <KpiTile
        label={t("dash.netVat")}
        value={`${cur} ${(vat.net_vat / 1000).toFixed(0)}K`}
        sub={vat.net_vat > 0 ? t("dash.vatPayable") : t("dash.vatRefund")}
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
  const { t } = useTranslation();
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
        {t("dash.pickSampleOrUpload")}
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
  /** AI LANE (2026-08-19) — the period's canonical_bs, for the permanent
   *  AI-read badge on the accuracy line when extraction method is "llm". */
  canonicalBs?: CanonicalBs | null;
}

function AccuracyBanner({ assembledBs, sourceDataQuality, canonicalBs }: AccuracyBannerProps) {
  const { t } = useTranslation();
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
  // Clean-band threshold tightened 0.5% -> 0.1% (operator directive
  // 2026-08-27) — MUST match the "target: under 0.1%" copy in
  // dash.accClean*/accUnknownBody (en+ro); the two drifting apart makes
  // the banner claim a target it does not enforce.
  const band: "clean" | "watch" | "problem" | "unknown" =
    bsDriftPct === null && sourceImbalancePct === null
      ? "unknown"
      : worstPct < 0.1
      ? "clean"
      : worstPct < 2
      ? "watch"
      : "problem";

  // AI LANE — permanent AI-read badge on the accuracy line whenever the
  // period was llm-extracted (never removable, so it also renders on the
  // collapsed link state below).
  const aiReadBadge = (
    <AiReadBadge
      extraction={canonicalBs?.extraction}
      classification={canonicalBs?.classification ?? undefined}
    />
  );

  // Dismissed → small re-open link (always discoverable per disclosure
  // discipline; never hide drift warnings even when dismissed — see below).
  if (dismissed && band === "clean") {
    return (
      <span className="inline-flex items-center gap-2 mb-3">
        <button
          type="button"
          data-testid="accuracy-banner-link"
          onClick={() => {
            try { localStorage.removeItem("accuracy_banner_dismissed"); } catch { /* private mode */ }
            setDismissed(false);
          }}
          className="inline-flex items-center gap-1 text-[11.5px] text-ink-mute hover:text-ink"
        >
          <CheckCircle2 size={11} strokeWidth={1.75} className="text-[#2AA89B]" />
          {t("dash.qualityPassedLink")}
        </button>
        {aiReadBadge}
      </span>
    );
  }
  // Watch + problem bands ALWAYS render — dismissal doesn't suppress
  // real warnings. User can dismiss the green state only.

  // ── Render per band ───────────────────────────────────────────────
  const tone =
    band === "clean"
      ? {
          border: "border-[#8FE3D9]/40",
          bg: "bg-[#E6F7F4]/40 dark:bg-[#5CD3C5]/[0.06]",
          icon: <CheckCircle2 size={13} strokeWidth={1.75} className="text-[#2AA89B] mt-0.5 shrink-0" />,
          headline: "text-[#2AA89B] dark:text-[#5CD3C5]",
        }
      : band === "watch"
      ? {
          border: "border-[#8FE3D9]/50",
          bg: "bg-[#E6F7F4]/40 dark:bg-[#5CD3C5]/[0.06]",
          icon: <Info size={13} strokeWidth={1.75} className="text-[#2AA89B] mt-0.5 shrink-0" />,
          headline: "text-[#2AA89B] dark:text-[#5CD3C5]",
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
              <strong className={tone.headline}>{t("dash.accCleanTitle")}</strong>{" "}
              {t("dash.accCleanPre")} <strong>{(Math.floor(worstPct * 100) / 100).toFixed(2)}%</strong>{" "}
              {t("dash.accCleanPost")}
            </>
          )}
          {band === "watch" && (
            <>
              <strong className={tone.headline}>{t("dash.accWatchTitle")}</strong>{" "}
              {sourceImbalancePct !== null && sourceImbalancePct >= 0.5 ? (
                <>
                  {t("dash.accSrcImbalancePre")}{" "}
                  <strong>{t("dash.accImbalanceBold", { pct: sourceImbalancePct.toFixed(2) })}</strong>{" "}
                  {t("dash.accWatchSmallNote")}{" "}
                </>
              ) : null}
              {bsDriftPct !== null && bsDriftPct >= 0.5 ? (
                <>
                  {t("dash.accBsDriftPre")} <strong>{bsDriftPct.toFixed(2)}%</strong> {t("dash.accBsDriftPost")}{" "}
                </>
              ) : null}
              {t("dash.accWatchTail")}
            </>
          )}
          {band === "problem" && (
            <>
              <strong className={tone.headline}>{t("dash.accProblemTitle")}</strong>{" "}
              {sourceImbalancePct !== null && sourceImbalancePct >= 2 ? (
                <>
                  {t("dash.accSrcImbalancePre")}{" "}
                  <strong>{t("dash.accImbalanceBold", { pct: sourceImbalancePct.toFixed(2) })}</strong>{" "}
                  {t("dash.accProblemSrcTail")}{" "}
                </>
              ) : null}
              {bsDriftPct !== null && bsDriftPct >= 2 ? (
                <>
                  {t("dash.accProblemBsPre")}{" "}
                  <strong>{bsDriftPct.toFixed(2)}%</strong> {t("dash.accProblemBsTail")}{" "}
                </>
              ) : null}
              {t("dash.accProblemTail")}
            </>
          )}
          {band === "unknown" && (
            <>
              <strong className={tone.headline}>{t("dash.accUnknownTitle")}</strong>{" "}
              {t("dash.accUnknownBody")}
            </>
          )}
          {/* AI LANE — the badge sits ON the accuracy line itself. */}
          <span className="ml-2 inline-flex align-middle">{aiReadBadge}</span>
        </div>
      </div>
      {/* Dismiss (×) removed 2026-07-25 — the accuracy note now sits under the
          CFO briefing and always shows; it's a per-document signal, not a nag. */}
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
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      data-testid="statutory-format-banner"
      className="mb-3 rounded-lg border-l-[3px] border-[#5CD3C5] bg-[#E6F7F4]/40 dark:bg-[#5CD3C5]/[0.06] px-4 py-3"
    >
      <div className="flex items-start gap-2.5 text-[12.5px] leading-relaxed text-ink-soft">
        <Info size={13} strokeWidth={1.75} className="text-[#2AA89B] mt-0.5 shrink-0" />
        <div className="flex-1">
          <strong className="text-ink">{t("dash.statutoryDetected")}</strong>{" "}
          {t("dash.statutoryBody")}
          <button
            type="button"
            data-testid="statutory-banner-toggle"
            onClick={() => setExpanded((v) => !v)}
            className="ml-1 text-[12px] text-[#2AA89B] hover:text-[#1B7268] underline-offset-2 hover:underline"
          >
            {expanded ? t("upload.template.hideFormat") : t("dash.statutoryWhatsNot")}
          </button>
          {expanded && (
            <>
              <ul className="mt-2 list-disc pl-5 text-[12px] space-y-0.5">
                <li>{t("dash.statutoryLi1")}</li>
                <li>{t("dash.statutoryLi2")}</li>
                <li>{t("dash.statutoryLi3")}</li>
                <li>{t("dash.statutoryLi4")}</li>
              </ul>
              <p className="mt-2 text-[12px]">
                {t("dash.statutoryDeeper")}
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
  briefing,
  briefingPeriodId,
}: {
  statements: Statements | null;
  invoices: Invoice[] | null;
  activeSampleId: string | null;
  onPickSample: (id: string, opts?: { additive?: boolean }) => void;
  onTriggerFile: () => void;
  onReset: () => void;
  /** Server-generated CFO briefing (Opus 4.7). When present it becomes the
   *  header's subtitle — the briefing IS the description of the loaded
   *  workspace. Empty for samples, where the generic descriptive line shows
   *  instead. */
  briefing?: string | null;
  briefingPeriodId?: string | null;
}) {
  const { t } = useTranslation();
  const companyName =
    statements?.companyName
    ?? (invoices && invoices.length > 0 ? t("dash.invoiceRegister") : t("dash.loadedPeriod"));
  const rawPeriodLabel = statements?.periodLabel ?? (invoices ? t("dash.invoicesCount", { count: invoices.length }) : "");
  // Show month + year only — drop the day. A full date ("2026-05-26") becomes
  // "May 2026"; non-date labels ("FY 2025", "120 invoices") are left as-is.
  // A date-shaped label OUTSIDE the sane window (a corrupt period like
  // 2115-03-31) still formats via the loose path — a raw ISO string in the
  // page title reads as a glitch (operator-reported).
  const periodLabel =
    formatPeriodMonth(rawPeriodLabel)
    ?? formatPeriodMonthLoose(rawPeriodLabel)
    ?? rawPeriodLabel;

  // The Replace dropdown also offers "Add ... on top" for samples that
  // contribute a different document type than what's already loaded — that's
  // how the user assembles a full balance sheet + invoices workspace.
  const currentlyHas: DocumentType[] = [];
  if (statements) currentlyHas.push("bilant", "pl");
  if (invoices) currentlyHas.push("invoice_register");

  // 2026 redesign — the loaded-month header is COMPACT now: small eyebrow +
  // one-line company · period title (no serif hero here; the serif display
  // moment belongs to the health score on the hero verdict card), and the
  // CFO briefing clamped to two lines behind a "read more" toggle so the
  // overview's first paint is verdict + key metrics + recommendations.
  const [briefingOpen, setBriefingOpen] = useState(false);
  return (
    <header className="mb-2" data-testid="compact-period-header">
      <div className="inline-flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.16em] text-ink-mute font-semibold">
        <Sparkles size={10} strokeWidth={2.25} className="text-brand-d" />
        {t("dash.financialAnalysisEyebrow")}
      </div>
      <h1 className="mt-1.5 text-[24px] sm:text-[28px] font-semibold leading-tight tracking-[-0.015em] text-ink max-w-[820px]">
        {companyName}
        {periodLabel && (
          <span className="text-ink-soft font-normal"> · {periodLabel}</span>
        )}
      </h1>
      {/* The CFO briefing (Opus 4.7) stays the header's description of the
          loaded workspace — mounted always (its regeneration effects keep
          running), presented clamped until expanded. Samples have no
          briefing, so they fall back to the generic line. */}
      {briefing && briefingPeriodId ? (
        <CFOBriefingCard
          periodId={briefingPeriodId}
          baseBriefing={briefing}
          collapsed={!briefingOpen}
          onToggle={() => setBriefingOpen((v) => !v)}
        />
      ) : (
        <p className="mt-2 text-[13.5px] text-ink-soft max-w-[620px] leading-relaxed">
          {t("dash.heroFallbackSubtitle")}
        </p>
      )}
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
  // The deterministic English summary builder was removed in the 2026
  // redesign — it had been dead since 2026-07-25 (computed, never rendered)
  // and its EN-only prose was an i18n stray waiting to resurface.

  // Risks = critical + high recommendations (top 3).
  // Opportunities = medium / info recommendations (top 3).
  return (
    <div className="space-y-7" data-testid="state-b-overview">
      {/* The "CFO AI summary" card was removed 2026-07-25 — the header's CFO
          briefing (Opus 4.7) is now the single narrative summary, so a second
          shorter summary here was redundant. */}

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

      {/* The "Top 3 risks · Top 3 opportunities" section was removed
          2026-07-25 — those now surface as the Risks / Opportunities count
          cards in the KPI grid above (and in full in the Recommendations tab). */}
    </div>
  );
}

// buildDeterministicSummary / MiniStatements / MiniCard / RiskOpsList /
// CalloutCard / ExtractionAccuracyBanner removed in the 2026 redesign —
// all dead code (zero callers) carrying EN-only strings. Recoverable from
// git history.

// Preview an example workbook in a NEW TAB without downloading it. A plain
// <a href="*.xlsx" target="_blank"> just triggers a download (browsers
// can't render xlsx inline), so we parse the sheet with SheetJS and open a
// rendered HTML table instead. The tab is opened synchronously inside the
// click gesture (so it isn't popup-blocked) and filled once parsed.
// Module scope (2026-07-24) — used by BOTH the hero's template card
// (example trial balances) and the upload panel.
async function previewExampleInNewTab(file: string): Promise<void> {
  const tab = window.open("", "_blank");
  const loadingLabel = i18n.t("dash.loadingPreview");
  if (tab) {
    tab.document.write(
      `<!doctype html><title>${loadingLabel}</title>` +
      `<body style="font:14px system-ui;padding:24px">${loadingLabel}</body>`,
    );
  }
  try {
    const res = await fetch(`/examples/${file}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    const XLSX = await import("xlsx");
    const wb = XLSX.read(buf, { type: "array" });
    const sheetName = wb.SheetNames[0];
    const tableHtml = XLSX.utils.sheet_to_html(wb.Sheets[sheetName]);
    const doc =
      `<!doctype html><html><head><meta charset="utf-8"><title>${file}</title><style>` +
      "body{font:13px/1.4 system-ui,Segoe UI,Arial,sans-serif;margin:0;padding:24px;color:#0f172a;background:#fff}" +
      "h1{font-size:15px;margin:0 0 12px;color:#1B7268}" +
      "table{border-collapse:collapse;font-variant-numeric:tabular-nums}" +
      "td,th{border:1px solid #d6dde6;padding:4px 8px;white-space:nowrap;text-align:right}" +
      "tr:first-child td{background:#1B7268;color:#fff;font-weight:600;text-align:left}" +
      `</style></head><body>${previewBackButtonHtml()}<h1>${i18n.t("dash.previewSheetCaption", { file, sheet: sheetName })}</h1>${tableHtml}</body></html>`;
    if (tab) {
      tab.document.open();
      tab.document.write(doc);
      tab.document.close();
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "error";
    if (tab) {
      tab.document.open();
      tab.document.write(
        `<!doctype html><body style="font:14px system-ui;padding:24px;color:#b91c1c">` +
        previewBackButtonHtml() +
        `${i18n.t("dash.previewLoadFailed", { msg })} ` +
        `<a href="/examples/${file}" download>${i18n.t("dash.downloadInstead")}</a>.</body>`,
      );
      tab.document.close();
    }
  }
}

// DashboardMonthPills — the workspace's uploaded months as a pill row,
// pinned above the loaded-month header. The FIRST item is an "Add month"
// button (opens the file picker); the rest are the months newest-first,
// the active one highlighted, each switching ?period= on click.
/**
 * "Source files" for the active month on the Dashboard — the same tile row
 * Products renders under its pills (shared <SourceFilesRow />), fed with the
 * FINANCIAL documents pinned to this period. Each tile opens the stored file
 * in a preview tab via a short-lived signed URL.
 *
 * Renders nothing when the month has no documents: periods can also arrive
 * from a sample dataset or a re-analysis with no live upload behind them, and
 * an empty "Source files" heading would read as a broken section.
 */

// ── Dev tools: wipe this workspace's dashboard data ─────────────────────────
//
// Deletes every period in the active workspace through the engine's
// DELETE /api/period/{id}, which soft-deletes the attached documents (they
// stay restorable from Recently deleted for 30 days) and removes the
// derivatives — statements, metrics, briefings, alerts, recommendations.
//
// NOT build-gated (2026-07-26 per operator): this ships to production. It is
// an irreversible bulk action behind a confirm dialog; if it ever needs
// restricting, gate it on workspace role rather than build mode.
//
// The workspace is left with no periods, so `useEnsureCurrentPeriod` creates
// a fresh container for the current month on the next render — the user lands
// on the dropzone rather than a broken empty screen.
function DashboardDevTools() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // 2026 redesign — GitHub-style typed confirmation (mirrors Workspace's
  // PurgeWorkspaceDialog UX): the destructive button stays disabled until
  // the user types the localized confirmation word exactly.
  const [typed, setTyped] = useState("");
  const confirmWord = t("dashV2.dangerConfirmWord");
  const typedMatch = typed.trim().toUpperCase() === confirmWord.toUpperCase();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { org } = useActiveOrg();
  // Only offer the wipe once there is something to wipe. `useOrgPeriods`
  // already filters to periods that actually hold documents, so this is
  // "has the user uploaded anything into this workspace".
  //
  // Before this, a brand-new workspace showed a red "Danger zone /
  // permanent and cannot be undone" panel directly beneath the empty
  // dropzone — the most alarming thing on the first screen, offering to
  // destroy data that doesn't exist. (The button was not a no-op either:
  // it toasted "Already clean".)
  const { data: orgPeriods } = useOrgPeriods();
  const hasUploads = (orgPeriods?.periods.length ?? 0) > 0;

  async function wipe() {
    if (!org?.id) return;
    setBusy(true);
    try {
      const payload = await fetchWorkspacePeriodsDirect(org.id);
      const periods = payload?.periods ?? [];
      if (periods.length === 0) {
        toast({ title: t("dash.alreadyCleanTitle"), description: t("dash.alreadyCleanBody") });
        setOpen(false);
        setBusy(false);
        return;
      }
      let deleted = 0;
      const failed: string[] = [];
      for (const p of periods) {
        const ok = await cfoApi.deletePeriod(p.period_id).then(
          (r) => r.ok !== false,
          () => false,
        );
        if (ok) deleted += 1;
        else failed.push(formatPeriodMonth(p.period_end) ?? p.period_label);
      }
      // Repaint from scratch — every period-scoped cache entry is now stale.
      queryClient.removeQueries({ queryKey: ["period"] });
      queryClient.removeQueries({ queryKey: ["period-documents"] });
      void queryClient.invalidateQueries({ queryKey: ["org-periods"] });
      void queryClient.invalidateQueries({ queryKey: ["periods-with-documents"] });
      if (failed.length > 0) {
        toast({
          title: t("dash.periodsDeleteFailed", { count: failed.length }),
          description: failed.slice(0, 3).join(" · "),
          variant: "destructive",
        });
      } else {
        toast({
          title: t("dash.deletedPeriods", { count: deleted }),
          description: t("dash.filesMovedRecentlyDeleted"),
        });
      }
      setOpen(false);
      setBusy(false);
    } catch (err) {
      toast({
        title: t("dash.wipeFailedTitle"),
        description: err instanceof Error ? err.message : t("dash.unknownError"),
        variant: "destructive",
      });
      setBusy(false);
    }
  }

  // Nothing uploaded → no danger zone. Placed after every hook so the hook
  // order stays unconditional.
  if (!hasUploads) return null;

  return (
    <div
      data-testid="dashboard-dev-tools"
      className="mt-16 pt-6 border-t-2 border-dashed border-alert/40"
    >
      {/* Visually quarantined — a torn-off strip at the very bottom of the
          page: dashed red tear line above, muted red panel, nothing brand-
          colored anywhere near it. */}
      <div className="rounded-xl border border-alert/25 bg-alert/[0.04] px-4 py-4 flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="inline-flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.14em] font-semibold text-alert">
            <AlertTriangle size={11} strokeWidth={2.25} />
            {t("dash.dangerZone")}
          </div>
          <p className="text-[12px] text-ink-mute mt-1 max-w-[560px]">
            {t("dash.dangerZoneBody")}
          </p>
        </div>
        <button
          type="button"
          onClick={() => { setTyped(""); setOpen(true); }}
          data-testid="dashboard-wipe-data"
          title={t("dash.wipeButtonTitle")}
          className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-full border border-dashed border-alert/40 bg-alert/[0.06] text-[11px] font-mono uppercase tracking-[0.08em] text-alert hover:bg-alert/15 transition-colors"
        >
          <Trash2 size={12} strokeWidth={2} />
          {t("dash.wipeData")}
        </button>
      </div>

      <Dialog open={open} onOpenChange={(o) => { if (!busy) { setOpen(o); if (!o) setTyped(""); } }}>
        <DialogContent className="sm:max-w-[440px]" data-testid="dashboard-wipe-dialog">
          <DialogHeader>
            <DialogTitle>{t("dash.wipeDialogTitle")}</DialogTitle>
            <DialogDescription>
              {t("dash.wipeDialogBody1")}
              <br />
              <br />
              {t("dash.wipeDialogBody2")}
            </DialogDescription>
          </DialogHeader>
          {/* Typed confirmation — mirrors the Workspace purge dialog's UX
              (type the word, button unlocks). Reuses the same i18n label. */}
          <label className="block">
            <span className="block text-[11px] uppercase tracking-[0.12em] text-ink-mute font-semibold mb-1.5">
              {t("ws.typeToConfirm", { name: confirmWord }).replace(/<\/?1>/g, "")}
            </span>
            <input
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && typedMatch && !busy) void wipe(); }}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              placeholder={confirmWord}
              data-testid="dashboard-wipe-input"
              className="w-full h-10 px-3 rounded-lg border border-rule bg-surface text-[14px] text-ink placeholder:text-ink-mute focus:outline-none focus:ring-2 focus:ring-alert/30 focus:border-alert/40"
            />
          </label>
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
              disabled={busy || !typedMatch}
              data-testid="dashboard-wipe-confirm"
              className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg border border-alert/30 bg-alert/10 text-[13px] font-medium text-alert hover:bg-alert/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} strokeWidth={1.75} />}
              {busy ? t("dash.deleting") : t("dash.deleteAllPeriods")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** The "N notes" pill that scrolls to the Notes & recommendations section.
 *  Renders nothing when the period has no alerts and no recommendations. */
function NotesJumpPill({
  alerts,
  recommendationCount,
}: {
  alerts: Array<{ severity?: string }>;
  recommendationCount: number;
}) {
  const { t } = useTranslation();
  const notesTotal = recommendationCount + alerts.length;
  if (notesTotal === 0) return null;
  const sev = (a: { severity?: string }) => a.severity ?? "";
  const tone = alerts.some((a) => sev(a) === "critical" || sev(a) === "high")
    ? "border-red-500/50 bg-red-500/10 text-red-700 dark:text-red-300 hover:bg-red-500/20"
    : alerts.some((a) => sev(a) === "medium")
      ? "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20"
      : alerts.some((a) => sev(a) === "low" || sev(a) === "info")
        ? "border-blue-500/50 bg-blue-500/10 text-blue-700 dark:text-blue-300 hover:bg-blue-500/20"
        : "border-brand/50 bg-brand/10 text-brand-d hover:bg-brand/20";
  return (
    <div className="flex justify-end mb-3">
      <button
        type="button"
        onClick={() =>
          document
            .querySelector('[data-testid^="statement-notes-"]')
            ?.scrollIntoView({ behavior: "smooth", block: "start" })
        }
        data-testid="notes-jump-pill"
        title={t("dash.jumpToNotes")}
        className={`shrink-0 inline-flex items-center gap-1.5 h-8 px-3 rounded-full border text-[12px] font-semibold tabular-nums transition-colors ${tone}`}
      >
        <AlertTriangle size={17} strokeWidth={2} />
        {notesTotal}
      </button>
    </div>
  );
}

function DashboardSourceFiles({
  periodId,
  onAddFile,
  trailing,
}: {
  periodId: string | null;
  /** Chosen trial balance. Unlike Products (which uploads on the spot) the
   *  dashboard stages it and opens the add-month flow, so the
   *  period-confirmation step still runs. */
  onAddFile: (file: File) => void;
  /** Right-aligned content above the line — kept for API compatibility. */
  trailing?: ReactNode;
}) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // FINANCIAL scope only (2026-07-26) — a SKU workbook pinned to the same
  // month does not back these numbers. Scope is part of the query key.
  const { data: docs } = useQuery({
    queryKey: ["period-documents", periodId, "financial"],
    queryFn: async () => {
      if (!periodId) return [];
      const { listDocumentsForPeriod } = await import("@/lib/supabase");
      return listDocumentsForPeriod(periodId, 50, "financial");
    },
    enabled: !!periodId,
  });

  // ONE honest source line (2026-08-04 per operator): the old multi-tile
  // strip duplicated the Workspace hub's file management and implied a
  // choice it couldn't make (clicking a tile only previewed it). The
  // dashboard now credits exactly the document that BACKS the current
  // analysis — the most recently analyzed financial doc of this period —
  // with Replace + a link to the Workspace for real file management.
  const activeDoc = useMemo(() => pickActiveSourceDoc(docs), [docs]);

  return (
    <div className="mb-5 space-y-2" data-testid="dashboard-source-files">
      {trailing && (
        <div className="flex items-center justify-end" data-testid="dashboard-row-actions">
          {trailing}
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept={DASHBOARD_UPLOAD_ACCEPT}
        className="hidden"
        data-testid="source-files-add-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onAddFile(f);
          e.target.value = "";
        }}
      />
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[12px] text-ink-mute">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.12em]">{t("srcline.source")}</span>
        {activeDoc ? (
          <button
            type="button"
            data-testid="source-file"
            title={activeDoc.original_filename}
            onClick={() =>
              void openUploadedFilePreview(activeDoc.original_filename ?? t("dash.documentFallback"), async () => {
                const { signedDocumentUrl } = await import("@/lib/supabase");
                return signedDocumentUrl(activeDoc);
              })
            }
            className="inline-flex items-center gap-1.5 max-w-[260px] sm:max-w-[380px] text-ink-soft hover:text-ink transition-colors duration-150"
          >
            <FileSpreadsheet size={13} strokeWidth={1.75} className="shrink-0 text-ink-mute" />
            <span className="truncate font-medium">{activeDoc.original_filename}</span>
          </button>
        ) : (
          <span className="text-ink-mute">{t("srcline.none")}</span>
        )}
        {activeDoc && (
          <span className="tabular-nums">
            · {t("srcline.uploaded", { date: formatDateTime(activeDoc.created_at, { dateStyle: "medium" }) })}
          </span>
        )}
        <span aria-hidden className="hidden sm:inline">·</span>
        <button
          type="button"
          data-testid="source-files-add"
          onClick={() => fileInputRef.current?.click()}
          className="inline-flex items-center min-h-[44px] sm:min-h-0 text-brand-d hover:text-brand font-medium transition-colors duration-150"
        >
          {activeDoc ? t("srcline.replace") : t("srcline.add")}
        </button>
        <span aria-hidden className="hidden sm:inline">·</span>
        <Link
          to={periodId ? `/workspace?period=${encodeURIComponent(periodId)}` : "/workspace"}
          data-testid="source-files-manage"
          className="inline-flex items-center min-h-[44px] sm:min-h-0 gap-1 text-ink-soft hover:text-ink font-medium transition-colors duration-150"
        >
          {t("srcline.manage")}
          <ChevronRight size={12} strokeWidth={2} />
        </Link>
      </div>
    </div>
  );
}

// DashboardMonthPills deleted (2026-07-26 per operator). It rendered the
// workspace's months as pills above the loaded-month header ("Dec 2025", …)
// plus an "Add month" button. Both are gone: the sidebar stepper switches
// months, and the "Add file" tile in the Source-files row adds one.

// DashboardTemplateCard — the /products "Start from the official
// template" card, dashboard flavour: Trial Balance leads as required,
// and the example trial balances REPLACE the template Download/View
// buttons as the card's action rows. Mounted in the page hero's right
// column (beside the title), like /products.
function DashboardTemplateCard() {
  const { t } = useTranslation();
  return (
    <TemplateDownloadCard
      variant="prominent"
      context="dashboard"
      actions={
        <div className="mt-3.5" data-testid="trial-balance-examples">
          <div className="text-[10.5px] uppercase tracking-[0.14em] font-semibold text-ink-mute mb-2">
            {t("dash.exampleTrialBalances")}
          </div>
          <div className="space-y-2">
            {[
              { label: t("dash.exampleMultiCol"), file: "example_trial_balance_8col.xlsx", testid: "8col" },
              { label: t("dash.exampleSaga"), file: "example_trial_balance_6col.xlsx", testid: "6col" },
            ].map((ex) => (
              <div
                key={ex.file}
                className="flex items-center justify-between gap-3 rounded-lg border border-rule bg-bg-2/40 px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="text-[12.5px] font-medium text-ink truncate">
                    {ex.label} <span className="text-ink-mute font-normal">(XLSX)</span>
                  </div>
                  <div className="text-[10.5px] text-ink-mute">
                    {t("dash.fictionalData")}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => void previewExampleInNewTab(ex.file)}
                    data-testid={`view-example-${ex.testid}`}
                    className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium text-ink bg-surface hover:bg-bg-2 ring-1 ring-inset ring-rule transition-colors"
                  >
                    <ExternalLink size={12} strokeWidth={2} />
                    {t("dash.view")}
                  </button>
                  <a
                    href={`/examples/${ex.file}`}
                    download={ex.file}
                    data-testid={`download-example-${ex.testid}`}
                    className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium text-ink bg-surface hover:bg-bg-2 ring-1 ring-inset ring-rule transition-colors"
                  >
                    <ArrowDownToLine size={12} strokeWidth={2} />
                    {t("common.download")}
                  </a>
                </div>
              </div>
            ))}
          </div>
        </div>
      }
    />
  );
}

// DashboardAddMonthZone — the loaded-state ("State B") upload affordance: a
// compact drop target plus the official-template card, laid out like the
// empty-state hero / /products. Dropping or importing a file stages it (the
// same staged-files → Start scan → period-confirm flow the empty state uses),
// so a workspace that already has a month can take the next one in place.
function DashboardAddMonthZone({
  stagedFiles,
  scanning,
  onDrop,
  onTriggerFile,
  onViewStaged,
  onDiscardStaged,
  onDismissAll,
  onStartScan,
  onSimulate,
  hideHeader = false,
}: {
  stagedFiles: File[];
  scanning: boolean;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  onTriggerFile: () => void;
  onViewStaged: (file: File) => void;
  onDiscardStaged: (index: number) => void;
  onDismissAll: () => void;
  onStartScan: () => void;
  /** Localhost-only: simulate a scan without a real file/backend. */
  onSimulate?: () => void;
  /** Hide the "Add another month" eyebrow (the modal supplies its own title). */
  hideHeader?: boolean;
}) {
  const { t } = useTranslation();
  const [dragActive, setDragActive] = useState(false);
  const staged = stagedFiles.length > 0;
  const isLocalhost =
    typeof window !== "undefined" &&
    /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);
  return (
    <section className={hideHeader ? "" : "mb-8"} data-testid="dashboard-add-month">
      {!hideHeader && (
        <div className="mb-3 inline-flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.16em] text-ink-mute font-semibold">
          <UploadCloud size={12} strokeWidth={2.25} className="text-brand-d" />
          {t("dash.addAnotherMonth")}
        </div>
      )}
      {/* Drop target — full width now that the official-template card moved up
          beside the loaded-month header. */}
      <div>
        <div
          data-testid="dashboard-add-month-dropzone"
          onDragEnter={(e) => { e.preventDefault(); setDragActive(true); }}
          onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
          onDragLeave={(e) => { e.preventDefault(); setDragActive(false); }}
          onDrop={(e) => { setDragActive(false); onDrop(e); }}
          data-drag-active={dragActive ? "true" : "false"}
          className={`
            relative overflow-hidden rounded-2xl border-2 border-dashed
            p-5 sm:p-6 transition-all duration-150
            ${dragActive
              ? "border-brand bg-brand/10 ring-2 ring-inset ring-brand/30"
              : "border-rule/80 bg-gradient-to-br from-bg-2/30 via-surface/60 to-surface/40 hover:border-rule-strong hover:from-bg-2/50"}
          `}
        >
          <div aria-hidden className="pointer-events-none absolute -top-16 -right-10 h-40 w-40 rounded-full bg-brand/8 blur-3xl" />
          <div aria-hidden className="pointer-events-none absolute -bottom-24 -left-12 text-ink opacity-[0.06]">
            <Cloud size={280} strokeWidth={1} />
            <ArrowUp size={100} strokeWidth={2.5} className="absolute left-1/2 top-[60%] -translate-x-1/2 -translate-y-1/2" />
          </div>

          {/* Localhost-only debug button — simulate a scan without a real
              file or backend. Never rendered on the deployed site. */}
          {isLocalhost && onSimulate && (
            <button
              type="button"
              data-testid="debug-simulate-upload"
              onClick={onSimulate}
              className="absolute top-2.5 right-2.5 z-10 inline-flex items-center gap-1 rounded-lg border border-dashed border-rule bg-surface/90 backdrop-blur px-2.5 py-1 text-[11px] font-medium text-ink-mute hover:text-ink hover:border-rule-strong transition-colors"
            >
              {t("dash.debugSimulate")}
            </button>
          )}

          {!staged ? (
            <div className="relative flex flex-col items-center text-center py-2">
              <h3 className="text-[15px] font-semibold text-ink">
                {dragActive ? t("dash.dropFileToUpload") : t("dash.dropNextMonth")}
              </h3>
              <p className="text-[12px] text-ink-soft mt-1">{t("dash.formatsLimit")}</p>
              <button
                type="button"
                onClick={onTriggerFile}
                data-testid="dashboard-add-month-import"
                className="mt-3.5 inline-flex items-center justify-center h-9 px-3.5 rounded-lg border border-brand/40 ask-ai-anim-fill [animation-duration:10s] text-ink text-[12.5px] font-medium hover:border-brand/60 transition-colors"
              >
                {t("dash.import")}
              </button>
            </div>
          ) : (
            <div className="relative text-left" data-testid="dashboard-staged-files">
              <div className="text-[10.5px] uppercase tracking-[0.14em] font-semibold text-ink-mute mb-2">
                {t("dash.uploadedFiles")}
              </div>
              <div className="space-y-2">
                {/* The row ITSELF opens the preview (2026-07-26 per operator
                    — the separate Eye button was removed); X stays as its own
                    sibling since buttons can't nest. */}
                {stagedFiles.map((f, i) => (
                  <div
                    key={`${f.name}-${f.size}-${i}`}
                    className="flex items-center justify-between gap-3 rounded-lg border border-rule bg-bg-2/40 pr-3 transition-colors hover:border-rule-strong hover:bg-bg-2/70"
                  >
                    <button
                      type="button"
                      onClick={() => onViewStaged(f)}
                      aria-label={t("dash.previewFile", { name: f.name })}
                      title={t("dash.openPreviewTitle")}
                      className="flex flex-1 items-center gap-2 min-w-0 px-3 py-2 text-left"
                    >
                      <FileSpreadsheet size={14} strokeWidth={1.75} className="text-ink-mute shrink-0" />
                      <div className="min-w-0">
                        <div className="text-[12.5px] font-medium text-ink truncate">{f.name}</div>
                        <div className="text-[10.5px] text-ink-mute">{(f.size / 1024).toFixed(0)} KB</div>
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => onDiscardStaged(i)}
                      disabled={scanning}
                      aria-label={t("dash.removeFile", { name: f.name })}
                      className="inline-flex items-center justify-center h-7 w-7 shrink-0 rounded-lg text-ink-mute hover:text-ink hover:bg-bg-2 ring-1 ring-inset ring-rule transition-colors disabled:opacity-40"
                    >
                      <X size={14} strokeWidth={2} />
                    </button>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={onDismissAll}
                  disabled={scanning}
                  className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-[12.5px] font-medium text-ink-mute hover:text-ink hover:bg-bg-2 ring-1 ring-inset ring-rule transition-colors disabled:opacity-40"
                >
                  <X size={13} strokeWidth={2} />
                  {t("dash.dismissAll")}
                </button>
                <button
                  type="button"
                  onClick={onStartScan}
                  disabled={scanning}
                  data-testid="dashboard-add-month-start-scan"
                  className="inline-flex items-center gap-2 h-9 px-4 rounded-lg ask-ai-anim-fill [animation-duration:10s] border border-brand/40 text-ink text-[13px] font-medium hover:border-brand/60 transition-colors disabled:opacity-60"
                >
                  {scanning && <Loader2 size={13} strokeWidth={2} className="animate-spin" />}
                  {scanning ? t("dash.scanning") : stagedFiles.length > 1 ? t("dash.startScanN", { count: stagedFiles.length }) : t("dash.startScan")}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
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
  onSimulate,
  stagedFiles,
  onDiscardStaged,
  onDismissAll,
  onStartScan,
  scanning,
  inflight,
  onViewResults,
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
  /** Localhost-only: simulate a scan without a real file/backend. Renders a
   *  debug button over the drop zone when supplied AND running on localhost. */
  onSimulate?: () => void;
  /** Files staged for scanning (choosing/dropping adds; nothing uploads until
   *  onStartScan). When non-empty, the list replaces the example-files list. */
  stagedFiles: File[];
  onDiscardStaged: (index: number) => void;
  onDismissAll: () => void;
  onStartScan: () => void;
  scanning: boolean;
  /** Live per-file scan progress. When set, the drop zone renders progress
   *  in-place (council visualizer + steps) instead of the idle upload UI. */
  inflight: { status: import("@/lib/supabase").DocumentStatus; filename: string; docId: string } | null;
  /** Opens the just-finished analysis — wired to the scan view's "Scan
   *  complete" card so the user confirms the hand-off into State B. */
  onViewResults: () => void;
}) {
  const { t } = useTranslation();
  // Drag-over state — drives the dropzone's "file hovering" styling and the
  // "Drop your file to upload" affordance text.
  const [dragActive, setDragActive] = useState(false);

  // In-flight scan progress. `scanActive` flips the drop zone from its idle
  // upload UI to the in-place progress view (no separate modal/card).
  const scanActive = !!inflight;
  const PIPELINE_STEPS = [
    t("dash.stepDetect"),
    t("dash.stepExtract"),
    t("dash.stepRebuild"),
    t("dash.stepRatios"),
    t("dash.stepRecs"),
  ];
  const STATUS_ORDINAL: Record<string, number> = {
    queued: 0, extracting: 1, mapping: 2, computing: 3, narrating: 4, analyzed: 5, failed: 0,
  };
  const STATUS_LABEL: Record<string, string> = {
    queued: t("dash.statusQueued"),
    extracting: t("dash.statusExtracting"),
    mapping: t("dash.statusMapping"),
    computing: t("dash.statusComputing"),
    narrating: t("dash.statusNarrating"),
    analyzed: t("toasts.analysisComplete"),
    failed: t("dash.analysisFailedTitle"),
  };
  const currentOrdinal = inflight ? (STATUS_ORDINAL[inflight.status] ?? 0) : 0;
  const statusLabel = inflight ? (STATUS_LABEL[inflight.status] ?? inflight.status) : "";

  // Localhost-only gate for the "simulate scan" debug button — it must never
  // appear on the deployed site, only when developing against localhost.
  const isLocalhost =
    typeof window !== "undefined" &&
    /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);

  // ── SCANNING VIEW (2026-07-24) ─────────────────────────────────────
  // While a scan is in flight the entry surface reduces to exactly two
  // things: the pipeline steps pinned at the top of the page, and the
  // council sphere filling the rest of the viewport. The hero copy,
  // document-type guide, dropzone chrome, and samples all hide until
  // the scan settles (analyzed → State B takes over; failed → this
  // branch exits and the idle surface returns).
  if (scanActive && inflight) {
    return (
      <ScanProgressView
        status={inflight.status}
        steps={TRIAL_BALANCE_STEPS}
        onCancel={clearUpload}
        onViewResults={onViewResults}
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* ── HERO CALLOUT — empty-state primary CTA ──────────────────────
          Only the legacy listafirme.ro pitch (UploadHeroCallout) renders as
          a separate hero, and only when PUBLIC_RECORDS_ENABLED is on. In the
          current product (flag off) the guided trial-balance copy is NOT a
          separate card — it's folded into the drop-zone below as that card's
          header (see the header block inside data-testid="upload-dropzone").
          Rendered only on the empty state so the dashboard isn't crowded
          once the user has data. */}
      {PUBLIC_RECORDS_ENABLED && <UploadHeroCallout />}

      {/* Document-type guide — always-visible grid above the drop
          section, headed by the same "Expected format" section label
          /products uses. */}
      <h2 className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-semibold">
        {t("expectedFormat.eyebrow")}
      </h2>
      <div className="w-full grid grid-cols-1 sm:grid-cols-3 gap-2" data-testid="upload-document-guide">
        <DocGuideCard
          title={t("dash.docTb")}
          format="XLSX · CSV · PDF"
          shows={t("dash.docTbShows")}
          where={[
            { label: t("dash.docTbWhere1"), href: null },
            { label: t("dash.docTbWhere2"), href: null },
          ]}
          tone="best"
        />
        {PUBLIC_RECORDS_ENABLED && (
          <DocGuideCard
            title={t("dash.docPublicRecords")}
            format={t("dash.pdfOnly")}
            shows={t("dash.docPublicRecordsShows")}
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
          title={t("dash.docStatutory")}
          format="XLSX (Formular F30 + F10)"
          shows={t("dash.docStatutoryShows")}
          where={[
            { label: t("dash.docStatutoryWhere1"), href: "https://anaf.ro" },
            { label: t("dash.docStatutoryWhere2"), href: null },
          ]}
          tone="ok"
        />
        <DocGuideCard
          title={t("dash.docSales")}
          format={t("dash.docSalesFormat")}
          shows={t("dash.docSalesShows")}
          where={[
            { label: t("dash.docSalesWhere1"), href: null },
            { label: t("dash.docSalesWhere2"), href: null },
          ]}
          tone="ok"
        />
      </div>


      {/* The official-template card moved beside the page title (the
          hero's right column, like /products) — see DashboardTemplateCard
          rendered from the page hero. */}

      <div className={`grid grid-cols-1 ${SAMPLES_ENABLED ? "lg:grid-cols-[1.2fr_1fr]" : ""} gap-4`}>
      {/* Upload zone — premium AI ingestion surface. Same logic, same
       *  callbacks, same hidden <input ref={fileRef}> at the page root.
       *  Only the chrome was upgraded: glass card, gradient icon,
       *  ring-glow on drag-over, refined chip styling. */}
      <div
        data-testid="upload-dropzone"
        onDragEnter={(e) => { e.preventDefault(); setDragActive(true); }}
        onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
        onDragLeave={(e) => { e.preventDefault(); setDragActive(false); }}
        onDrop={(e) => { setDragActive(false); onDrop(e); }}
        data-drag-active={dragActive ? "true" : "false"}
        className={`
          relative overflow-hidden
          rounded-2xl border-2 border-dashed
          backdrop-blur-sm
          p-6 sm:p-7
          flex flex-col items-center justify-center text-center
          min-h-[240px]
          transition-all duration-150
          ${dragActive
            ? "border-brand bg-brand/10 ring-2 ring-inset ring-brand/30 shadow-[0_0_0_4px_rgba(92,211,197,0.08)]"
            : "border-rule/80 bg-gradient-to-br from-bg-2/30 via-surface/60 to-surface/40 hover:border-rule-strong hover:from-bg-2/50"}
        `}
      >
        {/* Atmospheric brand glow */}
        <div aria-hidden className="pointer-events-none absolute -top-20 -right-12 h-56 w-56 rounded-full bg-brand/8 blur-3xl" />

        {/* Oversized upload mark — decorative, pinned to the bottom-left
            corner and clipped by the card's overflow-hidden (2026-07-24;
            replaces the small icon tile that sat above the heading). */}
        {/* Composed cloud + up-arrow mark. `opacity` on the WRAPPER (not
            alpha in the stroke color): everything flattens to one layer
            first, so overlapping strokes — including where the arrow
            crosses the cloud — never stack to double opacity. */}
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

        {/* Localhost-only debug button — simulate a scan without a real file
            or backend. Never rendered on the deployed site. */}
        {isLocalhost && onSimulate && (
          <button
            type="button"
            data-testid="debug-simulate-upload"
            onClick={onSimulate}
            className="absolute top-2.5 right-2.5 z-10 inline-flex items-center gap-1 rounded-lg border border-dashed border-rule bg-surface/90 backdrop-blur px-2.5 py-1 text-[11px] font-medium text-ink-mute hover:text-ink hover:border-rule-strong transition-colors"
          >
            {t("dash.debugSimulate")}
          </button>
        )}

        {/* Idle head — drag & drop + Choose a file. Fades/collapses out when a
            scan starts (the progress steps then take over the drop zone). */}
        <AnimatePresence initial={false}>
          {!scanActive && (
            <motion.div
              key="dz-head"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, height: 0, marginBottom: 0 }}
              transition={{ duration: 0.25 }}
              className="relative flex flex-col items-center overflow-hidden"
            >
              {/* Products-style dropzone content (2026-07-24) — heading +
                  format line + bordered chooser; the icon moved to the
                  card's bottom-left corner as an oversized decorative
                  mark. */}
              <h3 className="text-[16px] font-semibold text-ink">
                {dragActive ? t("dash.dropFileToUpload") : t("dash.dropTrialBalanceHere")}
              </h3>
              <p className="text-[12.5px] text-ink-soft mt-1">
                {t("dash.formatsLimit")}
              </p>
              {/* Same treatment as the sidebar's ACTIVE tab: animated
                  teal gradient fill + brand border. */}
              <button
                onClick={onTriggerFile}
                className="mt-4 inline-flex items-center justify-center h-9 px-3.5 rounded-lg border border-brand/40 ask-ai-anim-fill [animation-duration:10s] text-ink text-[12.5px] font-medium hover:border-brand/60 transition-colors"
              >
                {t("dash.import")}
              </button>
              {uploadName && (
                <div className="mt-3 text-[11.5px] text-ink-mute">
                  {t("dash.received")} <span className="text-ink">{uploadName}</span>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
        {/* AI Council visualizer — the live "thinking" sphere, driven by the
         *  council's Supabase Realtime broadcast for this document. Renders
         *  only during a scan, scaled into the drop zone; wrapped so a canvas
         *  error degrades to the step progress below instead of crashing. */}
        <AnimatePresence initial={false}>
          {scanActive && inflight?.docId && (
            <motion.div
              key="dz-council"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="relative w-full"
            >
              <InlineErrorBoundary
                tag="CouncilVisualizer"
                label={t("dash.councilSnag")}
                onReset={() => { /* visual-only; nothing to reset */ }}
              >
                <CouncilVisualizer documentId={inflight.docId} />
              </InlineErrorBoundary>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Pipeline steps. Idle: a preview of what CFO AI will do. During a
         *  scan: the idle head above fades out and (via layout animation)
         *  these steps glide to the TOP of the drop zone, lighting up to the
         *  current stage — the in-place progress that replaces the old modal. */}
        <motion.ol
          layout
          transition={{ type: "spring", stiffness: 260, damping: 30 }}
          className={`relative w-full max-w-[560px] mx-auto flex items-start justify-between gap-2 ${scanActive ? "mt-1" : "mt-6"}`}
          aria-label={t("dash.analysisPipeline")}
          data-testid="upload-pipeline"
        >
          {/* Connector line — drawn behind the dots */}
          <span aria-hidden className="absolute top-4 left-3 right-3 h-px bg-gradient-to-r from-transparent via-rule to-transparent" />
          {PIPELINE_STEPS.map((label, i) => {
            const done = scanActive && i < currentOrdinal;
            const active = scanActive && i === currentOrdinal;
            return (
              <li key={label} className="relative flex-1 min-w-0 flex flex-col items-center text-center">
                <span className={`
                  relative z-10 inline-flex items-center justify-center
                  h-8 w-8 rounded-full text-[12px] font-semibold tabular-nums
                  shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-colors duration-300
                  ${done
                    ? "bg-brand text-paper border border-brand"
                    : active
                    ? "bg-brand/15 text-brand-d border border-brand ring-2 ring-brand/30"
                    : "bg-surface text-ink-soft border border-rule"}
                `}>
                  {/* Slow sonar glow while active; fades out (700ms) when
                      the next step starts — same treatment as
                      ScanProgressView's circles. */}
                  <span
                    aria-hidden
                    className={`absolute -inset-px rounded-full step-pulse transition-opacity duration-700 ease-out ${active ? "opacity-100" : "opacity-0"}`}
                  />
                  {`0${i + 1}`}
                </span>
                <span className={`mt-2 text-[11.5px] uppercase tracking-[0.08em] font-medium leading-tight max-w-[100px] ${active ? "text-ink" : "text-ink-mute"}`}>
                  {label}
                </span>
              </li>
            );
          })}
        </motion.ol>

        {/* Live status line during a scan. */}
        <AnimatePresence initial={false}>
          {scanActive && (
            <motion.p
              key="dz-status"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              aria-live="polite"
              className="relative mt-4 text-[13px] font-medium text-ink"
            >
              {statusLabel}
            </motion.p>
          )}
        </AnimatePresence>

        {!scanActive && (stagedFiles.length > 0 ? (
          /* Staged files — replaces the example list once files are added.
             Each has an X to discard; nothing uploads until Start scan. */
          <div className="relative mt-6 w-full max-w-[640px] mx-auto text-left" data-testid="staged-files">
            <div className="text-[10.5px] uppercase tracking-[0.14em] font-semibold text-ink-mute mb-2">
              {t("dash.uploadedFiles")}
            </div>
            <div className="space-y-2">
              {/* The row ITSELF opens the preview (2026-07-26 per operator —
                  the separate Eye button was removed); X stays as its own
                  sibling since buttons can't nest. */}
              {stagedFiles.map((f, i) => (
                <div
                  key={`${f.name}-${f.size}-${i}`}
                  className="flex items-center justify-between gap-3 rounded-lg border border-rule bg-bg-2/40 pr-3 transition-colors hover:border-rule-strong hover:bg-bg-2/70"
                >
                  <button
                    type="button"
                    onClick={() => void openStagedFile(f)}
                    aria-label={t("dash.previewFile", { name: f.name })}
                    title={t("dash.openPreviewTitle")}
                    data-testid={`view-staged-${i}`}
                    className="flex flex-1 items-center gap-2 min-w-0 px-3 py-2 text-left"
                  >
                    <FileSpreadsheet size={14} strokeWidth={1.75} className="text-ink-mute shrink-0" />
                    <div className="min-w-0">
                      <div className="text-[12.5px] font-medium text-ink truncate">{f.name}</div>
                      <div className="text-[10.5px] text-ink-mute">{(f.size / 1024).toFixed(0)} KB</div>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => onDiscardStaged(i)}
                    disabled={scanning}
                    aria-label={t("dash.removeFile", { name: f.name })}
                    data-testid={`discard-staged-${i}`}
                    className="inline-flex items-center justify-center h-7 w-7 shrink-0 rounded-lg text-ink-mute hover:text-ink hover:bg-bg-2 ring-1 ring-inset ring-rule transition-colors disabled:opacity-40"
                  >
                    <X size={14} strokeWidth={2} />
                  </button>
                </div>
              ))}
            </div>
            <div className="mt-3 flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={onDismissAll}
                disabled={scanning}
                data-testid="dismiss-all-staged"
                className="inline-flex items-center gap-1.5 h-10 px-3 rounded-lg text-[12.5px] font-medium text-ink-mute hover:text-ink hover:bg-bg-2 ring-1 ring-inset ring-rule transition-colors disabled:opacity-40"
              >
                <X size={13} strokeWidth={2} />
                {t("dash.dismissAll")}
              </button>
              <button
                type="button"
                onClick={onStartScan}
                disabled={scanning}
                data-testid="start-scan"
                className="inline-flex items-center gap-2 h-10 px-4 rounded-lg ask-ai-anim-fill [animation-duration:10s] border border-brand/40 text-ink text-[13px] font-medium hover:border-brand/60 transition-colors disabled:opacity-60"
              >
                {scanning && <Loader2 size={13} strokeWidth={2} className="animate-spin" />}
                {scanning ? t("dash.scanning") : stagedFiles.length > 1 ? t("dash.startScanN", { count: stagedFiles.length }) : t("dash.startScan")}
              </button>
            </div>
          </div>
        ) : null)}

        {/* The "Every upload is auto-checked" note was removed
            2026-07-24 per operator directive. */}
      </div>

      {/* Sample picker — production default OFF (set VITE_ENABLE_SAMPLES=true
          for development with fictional fixtures). When disabled, the entire
          right-rail panel is omitted and the dropzone above spans full-width. */}
      {SAMPLES_ENABLED && (
      <div data-testid="sample-picker-panel" className="rounded-2xl border border-rule bg-surface p-5">
        <div className="flex items-center justify-between mb-3 gap-2">
          <h3 className="font-serif text-[16px] text-ink">{t("dash.tryASample")}</h3>
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
                {t("common.reset")}
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

      {/* The "Every upload is auto-checked" note moved INSIDE the
          dropzone (2026-07-24). */}
    </div>
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
  const { t } = useTranslation();
  return (
    <div
      data-testid="upload-hero-callout"
      className="rounded-2xl px-6 py-6 sm:px-8 sm:py-7 text-white flex flex-col sm:flex-row items-start gap-4 sm:gap-5"
      style={{ background: "linear-gradient(135deg, #1B7268 0%, #2AA89B 100%)" }}
    >
      <div className="text-[36px] sm:text-[42px] leading-none shrink-0" aria-hidden>
        📊
      </div>
      <div className="flex-1 min-w-0">
        <h2 className="font-serif text-[20px] sm:text-[22px] leading-tight m-0 text-white">
          {t("dash.calloutTitle")}
        </h2>
        <p className="mt-2 text-[13.5px] sm:text-[14px] leading-relaxed text-white/85">
          {t("dash.calloutBody1")}{" "}
          <strong className="text-white">listafirme.ro</strong> {t("dash.calloutBody2")}{" "}
          <strong className="text-white">"Date de bilanț"</strong>, {t("dash.calloutBody3")}{" "}
          <strong className="text-white">"Print PDF"</strong>, {t("dash.calloutBody4")}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <a
            href="https://www.listafirme.ro"
            target="_blank"
            rel="noopener noreferrer"
            data-testid="upload-hero-cta"
            className="inline-flex items-center gap-1.5 rounded-lg px-5 py-2.5 text-[13.5px] font-semibold transition-colors"
            style={{ background: "#5CD3C5", color: "#1a1a1a" }}
          >
            {t("dash.calloutCta")}
          </a>
          <span className="text-[11.5px] text-white/70">
            {t("dash.calloutFooter")}
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
  const { t } = useTranslation();
  const borderClass =
    tone === "best" ? "border-l-brand"
    : tone === "free" ? "border-l-brand"
    : "border-l-rule-strong";
  const toneBadge =
    tone === "best" ? { label: t("dash.badgeMostData"), cls: "bg-[#E6F7F4] text-[#1B7268] dark:bg-[#5CD3C5]/[0.18] dark:text-[#8FE3D9]" }
    : tone === "free" ? { label: t("dash.badgeFreeInstant"), cls: "bg-[#E6F7F4] text-[#1B7268] dark:bg-[#5CD3C5]/[0.18] dark:text-[#8FE3D9]" }
    : { label: t("dash.badgeAggregate"), cls: "bg-bg-2 text-ink-soft" };
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
      <div className="text-[10.5px] uppercase tracking-[0.08em] text-ink-mute font-medium mb-1">{t("dash.whereToGet")}</div>
      <ul className="space-y-0.5">
        {where.map((w, i) => (
          <li key={i} className="text-[11.5px] text-ink-soft leading-tight">
            <span className="text-ink-mute mr-1">·</span>
            {w.href ? (
              <a href={w.href} target="_blank" rel="noopener noreferrer"
                 className="text-[#2AA89B] dark:text-[#8FE3D9] hover:underline underline-offset-2">
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
  const { t } = useTranslation();
  const [selected, setSelected] = useState<Ratio | null>(null);
  return (
    <>
      <RatioGroupSection title={t("dash.ratioLiquidity")}            ratios={ratios.liquidity}     onPick={setSelected} />
      <div data-guide="ratios-profitability">
        <RatioGroupSection title={t("dash.ratioProfitability")}      ratios={ratios.profitability} onPick={setSelected} />
      </div>
      <div data-guide="ratios-leverage">
        <RatioGroupSection title={t("dash.ratioLeverage")}           ratios={ratios.leverage}      onPick={setSelected} />
        <div className="mt-8">
          <RatioGroupSection title={t("dash.ratioCoverage")}         ratios={ratios.coverage}      onPick={setSelected} />
        </div>
      </div>
      <div data-guide="ratios-efficiency">
        <RatioGroupSection title={t("dash.ratioEfficiency")}          ratios={ratios.efficiency}    onPick={setSelected} />
      </div>
      <div data-guide="ratios-risk">
        <RatioGroupSection title={t("dash.ratioBankruptcy")}         ratios={ratios.bankruptcy}    onPick={setSelected} />
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
  const { t } = useTranslation();
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
      aria-label={clickable ? t("dash.openRatioDetail", { label: ratio.label }) : undefined}
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
          className={`text-[9.5px] font-semibold uppercase tracking-[0.06em] px-2 py-0.5 rounded-full border text-ink anim-fill-verdict ${
            ratio.verdict === "critical"
              ? "anim-fill-red border-red-500/40"
              : ratio.verdict === "watch"
                ? "anim-fill-amber border-amber-500/40"
                : "anim-fill-green border-brand/40"
          }`}
        >
          {/* Localized verdict label (was the EN-only lib verdictLabel()). */}
          {ratio.verdict === "strong"
            ? t("dashV2.ratioVerdictStrong")
            : ratio.verdict === "healthy"
              ? t("dashV2.ratioVerdictHealthy")
              : ratio.verdict === "watch"
                ? t("dashV2.ratioVerdictWatch")
                : t("dashV2.ratioVerdictCritical")}
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
          <span>{t("dash.openExplainer")}</span>
          <span aria-hidden>→</span>
        </div>
      )}
    </Tag>
  );
}

// ─── 2026 redesign: priority buckets ────────────────────────────────────────
// The engine's four severities collapse into three reader-facing buckets:
//   critical|high → "Critic" (red) · medium → "De urmărit" (amber) ·
//   info → "Info" (neutral). Shared by the badge on each card AND the
// filter row so the two can't drift.
type RecBucket = "critical" | "watch" | "info";
function recBucket(priority: Recommendation["priority"]): RecBucket {
  return priority === "critical" || priority === "high"
    ? "critical"
    : priority === "medium"
      ? "watch"
      : "info";
}
const REC_BUCKET_TONES: Record<RecBucket, { badge: string; iconWrap: string; activePill: string }> = {
  critical: {
    badge: "bg-alert/10 text-alert border border-alert/30",
    iconWrap: "bg-alert/10 text-alert",
    activePill: "bg-alert/10 text-alert border-alert/40",
  },
  watch: {
    badge: "bg-caution/10 text-caution border border-caution/30",
    iconWrap: "bg-caution/10 text-caution",
    activePill: "bg-caution/10 text-caution border-caution/40",
  },
  info: {
    badge: "bg-bg-2 text-ink-soft border border-rule",
    iconWrap: "bg-bg-2 text-ink-mute",
    activePill: "bg-bg-2 text-ink border-rule-strong",
  },
};
const REC_BUCKET_LABEL_KEY: Record<RecBucket, string> = {
  critical: "dashV2.badgeCritical",
  watch: "dashV2.badgeWatch",
  info: "dashV2.badgeInfo",
};

/** Recommendations as a filterable editorial card stack — used by BOTH the
 *  Overview's recommendations block and the Recommendations tab. */
function RecommendationsSection({
  recommendations,
  currency,
  testid,
}: {
  recommendations: Recommendation[];
  currency: string;
  testid?: string;
}) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<"all" | RecBucket>("all");
  const counts = useMemo(() => {
    const c: Record<RecBucket, number> = { critical: 0, watch: 0, info: 0 };
    for (const r of recommendations) c[recBucket(r.priority)] += 1;
    return c;
  }, [recommendations]);
  const filtered =
    filter === "all"
      ? recommendations
      : recommendations.filter((r) => recBucket(r.priority) === filter);
  const pills: Array<{ id: "all" | RecBucket; label: string; count: number }> = [
    { id: "all", label: t("dashV2.filterAll"), count: recommendations.length },
    { id: "critical", label: t("dashV2.filterCritical"), count: counts.critical },
    { id: "watch", label: t("dashV2.filterWatch"), count: counts.watch },
    { id: "info", label: t("dashV2.filterInfo"), count: counts.info },
  ];
  return (
    <section data-testid={testid}>
      <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
        <h2 className="text-[10.5px] uppercase tracking-[0.14em] text-ink-mute font-semibold">
          {t("dashV2.recsTitle")}
        </h2>
        <div className="flex items-center gap-1.5 flex-wrap" data-testid="recs-filter">
          {pills.map((p) => {
            const active = filter === p.id;
            const activeCls =
              p.id === "all"
                ? "bg-brand/10 text-brand-d border-brand/40"
                : REC_BUCKET_TONES[p.id].activePill;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setFilter(p.id)}
                data-testid={`recs-filter-${p.id}`}
                aria-pressed={active}
                className={`inline-flex items-center gap-1 h-7 px-2.5 rounded-full border text-[11.5px] font-medium transition-colors duration-150 ${
                  active
                    ? activeCls
                    : "border-transparent text-ink-mute hover:text-ink hover:bg-bg-2/70"
                }`}
              >
                {p.label}
                <span className="tabular-nums opacity-70">{p.count}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="space-y-3 cards-stagger" key={filter}>
        {filtered.map((rec) => (
          <RecommendationCard key={rec.id} rec={rec} currency={currency} />
        ))}
      </div>
    </section>
  );
}

function RecommendationCard({ rec, currency }: { rec: Recommendation; currency: string }) {
  const { t } = useTranslation();
  // 2026 redesign — editorial action card: icon chip + punchy title + priority
  // badge, one-line impact, always-visible rationale + trigger facts (e2e
  // contract), and the action text behind an expandable "Acțiuni" checklist.
  const [actionsOpen, setActionsOpen] = useState(false);
  const bucket = recBucket(rec.priority);
  const tone = REC_BUCKET_TONES[bucket];
  const BucketIcon =
    bucket === "critical" ? AlertTriangle : bucket === "watch" ? TrendingUp : Info;
  // Sentence-split the action prose into checklist items (display only — the
  // underlying text is unchanged). Falls back to one item for unsplittable
  // strings.
  const actionItems = rec.action
    .split(/(?<=\.)\s+(?=[A-ZĂÂÎȘȚ0-9])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

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
      return `${Math.round(value)} ${t("common.unit.days")}`;
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

  const askPrompt = t("dash.askRecPrompt", { title: rec.title });

  return (
    <div className="card-2026 p-4 sm:p-5" data-testid={`rec-card-${rec.id}`}>
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className={`grid place-items-center h-9 w-9 shrink-0 rounded-xl ${tone.iconWrap}`}
        >
          <BucketIcon size={16} strokeWidth={2} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-[14.5px] font-semibold text-ink leading-tight">{rec.title}</h3>
            <span className={`shrink-0 text-[10px] font-semibold uppercase tracking-[0.06em] px-2 py-0.5 rounded-full ${tone.badge}`}>
              <LearnableRowLabel conceptKey="alert_severity" value={0}>
                {t(REC_BUCKET_LABEL_KEY[bucket])}
              </LearnableRowLabel>
            </span>
          </div>
          {rec.estimatedImpact ? (
            <div className="mt-1 text-[12px] font-medium text-[#2AA89B]">
              <LearnableRowLabel conceptKey="recommendation_impact" value={rec.estimatedImpact}>{t("dash.estimatedImpact")}</LearnableRowLabel>:{" "}
              <LearnableNumber conceptKey="recommendation_impact" value={rec.estimatedImpact}>
                <Money value={rec.estimatedImpact} fromCurrency={currency as Currency} compact />
              </LearnableNumber>
              {" "}{t("dash.perYear")}
            </div>
          ) : null}
          <p className="text-[12.5px] text-ink-soft mt-1.5 leading-snug">
            <span className="text-ink font-medium">{t("dash.why")}</span> {rec.rationale}
          </p>
        </div>
      </div>

      {/* Expandable "Acțiuni" checklist — the rec's action text as steps. */}
      <div className="mt-3 sm:pl-12">
        <button
          type="button"
          onClick={() => setActionsOpen((v) => !v)}
          aria-expanded={actionsOpen}
          data-testid={`rec-actions-toggle-${rec.id}`}
          className="inline-flex items-center gap-1.5 text-[12px] font-medium text-ink-soft hover:text-ink transition-colors"
        >
          <ChevronDown
            size={13}
            strokeWidth={2}
            className={`transition-transform duration-200 ${actionsOpen ? "rotate-180" : ""}`}
          />
          {t("dashV2.actionsLabel")}
          <span className="tabular-nums text-ink-mute">({actionItems.length})</span>
        </button>
        {actionsOpen && (
          <ul className="mt-2 space-y-1.5" data-testid={`rec-actions-${rec.id}`}>
            {actionItems.map((item, i) => (
              <li key={i} className="flex items-start gap-2 text-[12.5px] text-ink-soft leading-snug">
                <CheckCircle2 size={13} strokeWidth={1.75} className="mt-0.5 shrink-0 text-brand-d" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {factEntries.length > 0 && (
        <div className="mt-3 sm:ml-12 rounded-lg border border-rule/70 bg-bg-2/40 px-3 py-2">
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-soft mb-1.5">
            {t("dash.triggeredBy")}
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
                      <LearnableRowLabel conceptKey={conceptKey} value={v}>{label}</LearnableRowLabel>
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

      <div className="mt-3 sm:ml-12 flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={() => openAskCfoAi(askPrompt)}
          className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-ink-soft hover:text-ink hover:bg-bg-2/60 border border-rule rounded-md px-2.5 py-1 transition-colors"
          data-testid={`rec-ask-${rec.id}`}
        >
          <Sparkles size={11} strokeWidth={2.25} />
          {t("dash.askAboutThis")}
        </button>
      </div>
    </div>
  );
}

// ─── 2026 redesign: hero verdict + key metric cards + disclosure ────────────

/** The ONE hero card at the top of the loaded overview: composite credit
 *  score + letter rating (byte-identical to the Risks tab — same
 *  computeCreditScore reader over the same engine envelopes), a
 *  plain-language verdict sentence keyed by score band, and a green/amber/
 *  red accent. Honest "analysis pending" state when no score exists. */
function HeroVerdictCard({
  credit,
  companyName,
}: {
  credit: ReturnType<typeof computeCreditScore> | null;
  companyName?: string | null;
}) {
  const { t } = useTranslation();
  if (!credit || !Number.isFinite(credit.score)) {
    return (
      <section className="card-2026 p-5 sm:p-6" data-testid="hero-verdict" data-band="pending">
        <div className="text-[10.5px] uppercase tracking-[0.14em] text-ink-mute font-semibold">
          {t("dashV2.verdictLabel")}
        </div>
        <div className="mt-2 flex items-center gap-3">
          <Shield size={28} strokeWidth={1.5} className="text-ink-mute" />
          <p className="text-[13.5px] text-ink-soft leading-relaxed max-w-[560px]">
            {t("dashV2.verdictPending")}
          </p>
        </div>
      </section>
    );
  }
  const band: "strong" | "solid" | "watch" | "critical" =
    credit.score >= 80 ? "strong" : credit.score >= 60 ? "solid" : credit.score >= 40 ? "watch" : "critical";
  const tone =
    band === "strong" || band === "solid"
      ? { accent: "text-success", bar: "bg-success", ring: "border-success/30", chip: "bg-success/10 text-success border border-success/30" }
      : band === "watch"
        ? { accent: "text-caution", bar: "bg-caution", ring: "border-caution/30", chip: "bg-caution/10 text-caution border border-caution/30" }
        : { accent: "text-alert", bar: "bg-alert", ring: "border-alert/30", chip: "bg-alert/10 text-alert border border-alert/30" };
  const verdictKey =
    band === "strong" ? "dashV2.verdictStrong"
    : band === "solid" ? "dashV2.verdictSolid"
    : band === "watch" ? "dashV2.verdictWatch"
    : "dashV2.verdictCritical";
  return (
    <section
      className="card-2026 relative overflow-hidden p-5 sm:p-6"
      data-testid="hero-verdict"
      data-band={band}
      data-score={credit.score}
    >
      {/* Slim accent bar — the card's green/amber/red signal. */}
      <span aria-hidden className={`absolute inset-y-0 left-0 w-1 ${tone.bar}`} />
      <div className="flex flex-col sm:flex-row sm:items-center gap-4 sm:gap-6">
        <div className="flex items-baseline gap-2 shrink-0">
          {/* The single serif display moment of the redesigned overview. */}
          <span className={`font-serif text-[56px] sm:text-[64px] leading-none tabular-nums ${tone.accent}`}>
            {credit.score}
          </span>
          <span className="text-[12px] text-ink-mute">{t("dashV2.verdictScoreOf")}</span>
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10.5px] uppercase tracking-[0.14em] text-ink-mute font-semibold">
              {t("dashV2.verdictLabel")}
            </span>
            <span
              className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full tabular-nums ${tone.chip}`}
              title={t("dashV2.ratingLabel")}
            >
              <Shield size={11} strokeWidth={2} />
              {credit.rating}
            </span>
          </div>
          <p className="mt-1.5 text-[14px] sm:text-[15px] text-ink leading-relaxed max-w-[640px]">
            {companyName ? <span className="font-medium">{companyName}: </span> : null}
            {t(verdictKey)}
          </p>
        </div>
      </div>
    </section>
  );
}

/** One of the four above-the-fold key metric cards. Value is rendered
 *  through <Money> (the app's canonical currency-aware formatter) so the
 *  figure matches every other surface to the cent. */
function KeyMetricCard({
  label,
  desc,
  value,
  currency,
  trend,
  testid,
}: {
  label: string;
  desc: string;
  value: number;
  currency: string;
  trend: { pct: number; prevLabel: string } | null;
  testid?: string;
}) {
  const { t } = useTranslation();
  const up = trend ? trend.pct >= 0 : false;
  return (
    <div className="card-2026 p-4 min-w-0" data-testid={testid}>
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-semibold truncate">
          {label}
        </div>
        {trend && (
          <span
            className={`shrink-0 inline-flex items-center gap-0.5 text-[10.5px] font-medium tabular-nums ${
              up ? "text-success" : "text-alert"
            }`}
            title={t("dashV2.vsLastPeriod", { period: trend.prevLabel })}
          >
            <ArrowUp
              size={11}
              strokeWidth={2.25}
              className={up ? "" : "rotate-180"}
            />
            {`${Math.abs(trend.pct * 100).toFixed(1)}%`}
          </span>
        )}
      </div>
      <div className="mt-2 text-[22px] sm:text-[24px] font-semibold text-ink leading-none tabular-nums tracking-[-0.01em] truncate">
        <Money value={value} fromCurrency={currency as Currency} compact />
      </div>
      <p className="mt-1.5 text-[11.5px] text-ink-soft leading-snug">{desc}</p>
      {trend && (
        <p className="mt-1 text-[10.5px] text-ink-mute">
          {t("dashV2.vsLastPeriod", { period: trend.prevLabel })}
        </p>
      )}
    </div>
  );
}

/** Minimal disclosure section — progressive-disclosure wrapper for overview
 *  blocks that shouldn't compete with the first paint. Content unmounts when
 *  closed; 200ms chevron rotation, transform/opacity only. */
function DisclosureSection({
  title,
  subtitle,
  defaultOpen = false,
  testid,
  children,
}: {
  title: string;
  subtitle?: string;
  defaultOpen?: boolean;
  testid?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section data-testid={testid} data-open={open ? "true" : "false"}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid={testid ? `${testid}-toggle` : undefined}
        className="group w-full flex items-center justify-between gap-3 rounded-xl border border-rule/70 bg-surface/60 px-4 py-3 text-left hover:border-rule-strong hover:bg-bg-2/40 transition-colors duration-150"
      >
        <span className="min-w-0">
          <span className="block text-[12.5px] font-semibold text-ink">{title}</span>
          {subtitle && (
            <span className="block text-[11.5px] text-ink-mute mt-0.5 truncate">{subtitle}</span>
          )}
        </span>
        <ChevronDown
          size={16}
          strokeWidth={2}
          className={`shrink-0 text-ink-mute group-hover:text-ink transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && <div className="mt-4">{children}</div>}
    </section>
  );
}

function BalanceSheetTable({ statements }: { statements: Statements }) {
  // `t` is taken by deriveTotals here — bind the translator as `tr`.
  const { t: tr } = useTranslation();
  const t = deriveTotals(statements);
  const bs = statements.balanceSheet;
  const cur = statements.currency;
  // 2026 redesign fix — this fallback table referenced a `fmtMoney` that was
  // never defined at module scope (a latent ReferenceError on the rare
  // no-line-items path). It now uses the same currency-aware formatter as
  // the valuation tables.
  const fmtMoney = useFmtMoney();
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
        <h2 className="font-serif text-[18px] text-ink">{tr("dash.balanceSheet")} · {statements.periodLabel}</h2>
      </div>
      <table className="w-full">
        <tbody>
          {row(tr("dash.bsCurrentAssets"), t.totalCurrentAssets, { subtotal: true })}
          {row(tr("dash.bsCash"), bs.cash, { indent: true })}
          {row(tr("dash.bsAccountsReceivable"), bs.accountsReceivable, { indent: true })}
          {row(tr("dash.bsInventory"), bs.inventory, { indent: true })}
          {row(tr("dash.bsOtherCurrentAssets"), bs.otherCurrentAssets, { indent: true })}
          {row(tr("dash.bsNonCurrentAssets"), t.totalNonCurrentAssets, { subtotal: true })}
          {row(tr("dash.bsPpe"), bs.propertyPlantEquipment, { indent: true })}
          {row(tr("dash.bsIntangibles"), bs.intangibles, { indent: true })}
          {row(tr("dash.bsOtherNonCurrentAssets"), bs.otherNonCurrentAssets, { indent: true })}
          {row(tr("dash.bsTotalAssets"), t.totalAssets, { total: true })}
          {row(tr("dash.bsCurrentLiabilities"), t.totalCurrentLiabilities, { subtotal: true })}
          {row(tr("dash.bsAccountsPayable"), bs.accountsPayable, { indent: true })}
          {row(tr("dash.bsShortTermDebt"), bs.shortTermDebt, { indent: true })}
          {row(tr("dash.bsOtherCurrentLiabilities"), bs.otherCurrentLiabilities, { indent: true })}
          {row(tr("dash.bsNonCurrentLiabilities"), t.totalNonCurrentLiabilities, { subtotal: true })}
          {row(tr("dash.bsLongTermDebt"), bs.longTermDebt, { indent: true })}
          {row(tr("dash.bsOtherNonCurrentLiabilities"), bs.otherNonCurrentLiabilities, { indent: true })}
          {row(tr("dash.bsTotalLiabilities"), t.totalLiabilities, { subtotal: true })}
          {row(tr("dash.bsShareCapital"), bs.shareCapital, { indent: true })}
          {row(tr("dash.bsRetainedEarnings"), bs.retainedEarnings, { indent: true })}
          {row(tr("dash.bsOtherEquity"), bs.otherEquity, { indent: true })}
          {row(tr("dash.bsTotalEquity"), t.totalEquity, { subtotal: true })}
          {row(tr("dash.bsTotalLiabEquity"), t.totalLiabilitiesAndEquity, { total: true })}
        </tbody>
      </table>
    </div>
  );
}

// IncomeStatementTable removed in the 2026 redesign — zero callers
// (BalanceSheetTable remains as the BS-tab fallback) and EN-only labels.

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
  const { t } = useTranslation();
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
        <h2 className="font-serif text-[22px] text-ink mb-3">{t("dash.freeCashFlow")}</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <KpiTile label={t("dash.netIncome")} value={<LearnableNumber conceptKey="net_profit" value={netIncomeView}>{fmtMoney(netIncomeView, cur)}</LearnableNumber>} sub={t("dash.statutoryView")} />
          <KpiTile label={t("dash.plusDa")} value={<LearnableNumber conceptKey="depreciation_amortization" value={depView}>{fmtMoney(depView, cur)}</LearnableNumber>} />
          <KpiTile label={t("dash.minusWc")} value={<LearnableNumber conceptKey="working_capital_changes" value={wcView}>{fmtMoney(wcView, cur)}</LearnableNumber>} />
          <KpiTile label={t("dash.eqCfo")} value={<LearnableNumber conceptKey="operating_cash_flow" value={cfoView}>{fmtMoney(cfoView, cur)}</LearnableNumber>} />
          <KpiTile
            label={t("dash.minusCapex")}
            value={<LearnableNumber conceptKey="capex" value={capexAbs}>{fmtMoney(capexAbs, cur)}</LearnableNumber>}
            sub={fb ? t("dash.capexReal") : t("dash.capexEstimated")}
          />
          <KpiTile
            label={t("dash.eqFcf")}
            value={<LearnableNumber conceptKey="free_cash_flow" value={fcfView}>{fmtMoney(fcfView, cur)}</LearnableNumber>}
            sub={
              fcfNegativeDev
                ? t("dash.devPhaseCashDrag")
                : fcfView > 0
                  ? t("dash.positiveCashGen")
                  : t("dash.cashBurning")
            }
          />
        </div>
      </div>

      {/* WACC */}
      <div>
        <h2 className="font-serif text-[22px] text-ink mb-3">{t("dash.costOfCapital")}</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <KpiTile label="WACC" value={<LearnableNumber conceptKey="wacc" value={wacc.wacc}>{pct(wacc.wacc, 2)}</LearnableNumber>} sub={t("dash.costOfEquitySub", { pct: pct(wacc.costOfEquity, 2) })} />
          <KpiTile label={t("dash.costOfEquity")} value={<LearnableNumber conceptKey="cost_of_equity" value={wacc.costOfEquity}>{pct(wacc.costOfEquity, 2)}</LearnableNumber>} sub={`Rf ${pct(wacc.riskFreeRate, 1)} + β${wacc.beta.toFixed(2)} × ERP ${pct(wacc.equityRiskPremium, 1)}`} />
          <KpiTile label={t("dash.costOfDebtAfterTax")} value={<LearnableNumber conceptKey="cost_of_debt" value={wacc.costOfDebtAfterTax}>{pct(wacc.costOfDebtAfterTax, 2)}</LearnableNumber>} sub={t("dash.preTaxSub", { pretax: pct(wacc.costOfDebtPreTax, 2), tax: pct(wacc.taxRate, 1) })} />
          <KpiTile label={t("dash.weightEquity")} value={pct(wacc.weightOfEquity, 1)} />
          <KpiTile label={t("dash.weightDebt")} value={pct(wacc.weightOfDebt, 1)} />
        </div>
      </div>

      {/* DCF */}
      <div>
        <h2 className="font-serif text-[22px] text-ink mb-3">{t("dash.dcfIntrinsic")}</h2>
        {fb?.is_development_phase && (
          <div className="mb-3 rounded-xl border border-info/40 bg-info-tint/40 px-4 py-3 text-[13px] text-ink leading-relaxed flex items-start gap-2">
            <Info size={14} strokeWidth={2} className="mt-0.5 shrink-0 text-info" />
            <span>
              {t("dash.devPhasePre")}{" "}
              <span className="tabular-nums font-medium">{fmtMoney(capexAbs, cur)}</span>{" "}
              {t("dash.devPhaseMid")} {fmtMoney(fb.stabilized_fcf, cur)}{t("dash.devPhasePost")}
            </span>
          </div>
        )}
        <div className="rounded-2xl border border-rule bg-surface overflow-hidden">
          {/* FIT-1 — header row stacks vertically on narrow widths so the
              long "Equity value RON 450,489,717" headline never collides
              with the description block on its left. */}
          <div className="px-5 py-3 bg-bg-2/40 border-b border-rule flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <div className="min-w-0">
              <div className="font-serif text-[16px] text-ink">{t("dash.dcfForecastTitle")}</div>
              <div className="text-[12px] text-ink-soft break-words">
                {t("dash.baseFcf")}{" "}
                <span className="text-ink font-medium tabular-nums">{fmtMoney(dcf.baseFcf, cur)}</span>
                {" · "}{t("dash.forecastGrowth")} {pct(dcf.forecastGrowthRate, 1)} · {t("dash.terminalGrowth")} {pct(dcf.terminalGrowthRate, 1)} · WACC {pct(dcf.wacc, 2)}
              </div>
              <div className="text-[11px] text-ink-mute mt-1 leading-snug">
                {t("dash.stabilizedFcfNote")}
              </div>
            </div>
            <div className="md:text-right min-w-0 md:shrink-0">
              <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium">{t("dash.equityValue")}</div>
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
                <th className="text-left py-2 px-4 font-medium text-ink-mute">{t("dash.year")}</th>
                <th className="text-right py-2 px-4 font-medium text-ink-mute">FCF</th>
                <th className="text-right py-2 px-4 font-medium text-ink-mute">{t("dash.discountFactor")}</th>
                <th className="text-right py-2 px-4 font-medium text-ink-mute">{t("dash.presentValue")}</th>
              </tr>
            </thead>
            <tbody>
              {dcf.yearByYear.map((y) => (
                <tr key={y.year} className="border-t border-rule">
                  <td className="py-2 px-4 text-ink">{t("dash.yearN", { n: y.year })}</td>
                  <td className="py-2 px-4 text-right tabular-nums text-ink">{fmtMoney(y.fcf, cur)}</td>
                  <td className="py-2 px-4 text-right tabular-nums text-ink-soft">{y.discountFactor.toFixed(4)}</td>
                  <td className="py-2 px-4 text-right tabular-nums text-ink">{fmtMoney(y.presentValue, cur)}</td>
                </tr>
              ))}
              <tr className="border-t border-rule bg-bg-2/30">
                <td className="py-2 px-4 text-ink font-medium" colSpan={3}>{t("dash.terminalValuePv")}</td>
                <td className="py-2 px-4 text-right tabular-nums text-ink font-medium">
                  <LearnableNumber conceptKey="terminal_value" value={dcf.terminalValuePresent}>
                    {fmtMoney(dcf.terminalValuePresent, cur)}
                  </LearnableNumber>
                </td>
              </tr>
              <tr className="border-t-2 border-ink/30 bg-bg-2/40">
                <td className="py-2 px-4 text-ink font-semibold" colSpan={3}>{t("dash.enterpriseValue")}</td>
                <td className="py-2 px-4 text-right tabular-nums text-ink font-semibold">
                  <LearnableNumber conceptKey="enterprise_value" value={dcf.enterpriseValue}>
                    {fmtMoney(dcf.enterpriseValue, cur)}
                  </LearnableNumber>
                </td>
              </tr>
              <tr className="border-t border-rule">
                <td className="py-2 px-4 text-ink-soft" colSpan={3}>{t("dash.minusNetDebt")}</td>
                <td className="py-2 px-4 text-right tabular-nums text-ink">{fmtMoney(-dcf.netDebt, cur)}</td>
              </tr>
              <tr className="border-t-2 border-ink/30 bg-brand-tint">
                <td className="py-2 px-4 text-ink font-semibold" colSpan={3}>{t("dash.equityValue")}</td>
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
                {t("dash.sensitivityHeading")} · {t("dash.forecastGShort")} {pct(dcf.forecastGrowthRate, 1)} · {t("dash.terminalGShort")} {pct(dcf.terminalGrowthRate, 1)}
              </div>
              <div className="overflow-x-auto -mx-2 sm:mx-0">
              <table className="w-full text-[13px] min-w-[560px] sm:min-w-0">
                <thead>
                  <tr className="bg-bg-2/40">
                    <th className="text-left py-2 px-3 font-medium text-ink-mute">{t("dash.scenario")}</th>
                    <th className="text-right py-2 px-3 font-medium text-ink-mute">WACC</th>
                    <th className="text-right py-2 px-3 font-medium text-ink-mute">{t("dash.enterpriseValue")}</th>
                    <th className="text-right py-2 px-3 font-medium text-ink-mute">{t("dash.minusNetDebt")}</th>
                    <th className="text-right py-2 px-3 font-medium text-ink-mute">{t("dash.equityValue")}</th>
                  </tr>
                </thead>
                <tbody>
                  {dcf.scenarios.map((sc) => (
                    <tr
                      key={sc.label}
                      className={`border-t border-rule ${sc.label === "Central" ? "bg-[#E6F7F4]/40 font-semibold" : ""}`}
                    >
                      <td className="py-2 px-3 text-ink">
                        {sc.label === "Optimistic"
                          ? t("dashV2.scenarioOptimistic")
                          : sc.label === "Central"
                            ? t("dashV2.scenarioCentral")
                            : sc.label === "Conservative"
                              ? t("dashV2.scenarioConservative")
                              : sc.label}
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums text-ink">{pct(sc.wacc, 2)}</td>
                      <td className="py-2 px-3 text-right tabular-nums text-ink">{fmtMoney(sc.enterpriseValue, cur)}</td>
                      <td className="py-2 px-3 text-right tabular-nums text-ink-soft">{fmtMoney(-sc.netDebt, cur)}</td>
                      <td className="py-2 px-3 text-right tabular-nums text-ink">{fmtMoney(sc.equityValue, cur)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
              {/* 2026-07-25 — inputs quoted from the ACTUAL cost-of-capital
                  object (not hardcoded prose), and the old real-estate
                  framing ("levered RE", "cap-rate-implied", "yielding RE
                  asset") was removed: this branch renders for companies the
                  router did NOT classify as CRE, so that narrative described
                  exactly the companies it doesn't apply to. Labeled as
                  illustrative defaults — no uploaded trial balance carries
                  market inputs, so Rf/ERP/β are standing RO-market defaults,
                  not derived from the user's data. */}
              <p className="text-[11.5px] text-ink-mute mt-2 leading-snug">
                {t("dash.inputsPrefix")} {pct(wacc.riskFreeRate, 2)} {t("dash.inputsRfSrc")} · ERP{" "}
                {pct(wacc.equityRiskPremium, 1)} {t("dash.inputsErpSrc")} · β {wacc.beta.toFixed(2)}{" "}
                {t("dash.inputsTail")}
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
        <h2 className="font-serif text-[22px] text-ink mb-3">{t("dash.grahamTitle")}</h2>
        <div className="rounded-2xl border border-rule bg-surface p-5">
          <div className="text-[12px] text-ink-soft mb-3 font-mono break-words">
            {graham.formula} &nbsp;·&nbsp; g = {pct(graham.growthRate, 1)} &nbsp;·&nbsp; Y = {pct(graham.bondYield, 2)}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="min-w-0">
              <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium truncate">{t("dash.netIncomeTtm")}</div>
              <div className="font-serif num-hero-fluid-sm text-ink tabular-nums break-words">
                {fmtMoney(graham.eps * (statements.supplementary.sharesOutstanding ?? 1), cur)}
              </div>
              <div className="text-[10.5px] text-ink-mute mt-0.5">{t("dash.statutoryView")}</div>
            </div>
            <div className="min-w-0">
              <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium truncate">{t("dash.grahamFairValue")}</div>
              <div className="font-serif num-hero-fluid-sm text-ink tabular-nums break-words">{fmtMoney(graham.intrinsicEquityValue, cur)}</div>
            </div>
          </div>
          {/* 2026-07-25 — honesty note: g and Y are standing defaults (no
              uploaded trial balance carries growth/bond-yield inputs). */}
          <p className="text-[11.5px] text-ink-mute mt-3 leading-snug">
            {t("dash.grahamNote")}
          </p>
        </div>
      </div>

      {/* Multi-period growth */}
      {growth.length > 0 && (
        <div>
          <h2 className="font-serif text-[22px] text-ink mb-3">{t("dash.multiPeriodGrowth")}</h2>
          <div className="rounded-2xl border border-rule bg-surface overflow-hidden">
            <div className="overflow-x-auto">
            <table className="w-full text-[13px] min-w-[560px] sm:min-w-0">
              <thead>
                <tr className="bg-bg-2/30">
                  <th className="text-left py-2 px-4 font-medium text-ink-mute">{t("dash.metric")}</th>
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
                    <td className={`py-2 px-4 text-right tabular-nums font-medium ${row.cagr >= 0 ? "text-[#2AA89B]" : "text-red-700"}`}>
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
  const { t } = useTranslation();
  const credit = useMemo(
    () => computeCreditScore(statements, creditEnvelope, piotroskiEnvelope, metricsByName),
    [statements, creditEnvelope, piotroskiEnvelope, metricsByName],
  );
  const piotroski = credit.piotroski;
  const altman = credit.altman;

  const ratingTone = (rating: string): string => {
    if (rating.startsWith("AAA") || rating.startsWith("AA") || rating === "A") return "bg-[#E6F7F4] text-[#2AA89B] border-[#8FE3D9]/60";
    if (rating.startsWith("BBB")) return "bg-[#E6F7F4] text-[#2AA89B] border-[#8FE3D9]/60";
    if (rating.startsWith("BB")) return "bg-[#E6F7F4] text-[#2AA89B] border-[#8FE3D9]/60";
    if (rating.startsWith("B") || rating === "CCC") return "bg-[#E6F7F4] text-[#2AA89B] border-[#8FE3D9]/60";
    return "bg-red-50 text-red-700 border-red-300/60";
  };

  // Localized grade + Piotroski band labels (the lib emits EN enums/prose;
  // unknown values fall through untranslated rather than breaking).
  const gradeLabel =
    credit.grade === "investment_grade" ? t("dashV2.gradeInvestmentGrade")
    : credit.grade === "boundary" ? t("dashV2.gradeBoundary")
    : credit.grade === "speculative" ? t("dashV2.gradeSpeculative")
    : credit.grade === "distress" ? t("dashV2.gradeDistress")
    : credit.grade.replace(/_/g, " ");
  const piotroskiBandLabel = piotroski.band.startsWith("Strong")
    ? t("dashV2.piotroskiStrong")
    : piotroski.band.startsWith("Solid")
      ? t("dashV2.piotroskiSolid")
      : piotroski.band.startsWith("Weak")
        ? t("dashV2.piotroskiWeak")
        : piotroski.band.startsWith("Distressed")
          ? t("dashV2.piotroskiDistressed")
          : piotroski.band;

  return (
    <>
      {/* Composite credit score */}
      <div>
        <h2 className="font-serif text-[22px] text-ink mb-3">{t("dash.compositeCreditScore")}</h2>
        <div className="rounded-2xl border-2 border-brand/40 ask-ai-anim-fill [--af-band:360px] [--af-shift:2036.5px] [animation-duration:36s] text-ink p-4 sm:p-6 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-[0.12em] font-medium opacity-80">{t("dash.creditRating")}</div>
            <div className="font-serif text-[clamp(40px,11vw,64px)] leading-none mt-1">{credit.rating}</div>
            <div className="text-[12px] mt-2 opacity-80">
              {t("dash.compositeScoreLabel")}: {credit.score} / 100 · <span className="capitalize">{gradeLabel}</span>
            </div>
          </div>
          <Shield className="opacity-30 shrink-0 h-12 w-12 sm:h-16 sm:w-16" strokeWidth={1.25} />
        </div>
        <div className="mt-3 rounded-2xl border border-rule bg-surface overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full text-[13px] min-w-[600px] sm:min-w-0">
            <thead>
              <tr className="bg-bg-2/30">
                <th className="text-left py-2 px-4 font-medium text-ink-mute">{t("dash.component")}</th>
                <th className="text-right py-2 px-4 font-medium text-ink-mute">{t("dash.value")}</th>
                <th className="text-right py-2 px-4 font-medium text-ink-mute">{t("decision_rules.weight")}</th>
                <th className="text-right py-2 px-4 font-medium text-ink-mute">{t("dash.contribution")}</th>
                <th className="text-left py-2 px-4 font-medium text-ink-mute">{t("dash.read")}</th>
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
        <h2 className="font-serif text-[22px] text-ink mb-3">{t("dash.piotroskiTitle")}</h2>
        <div className="rounded-2xl border border-rule bg-surface p-5 flex items-center justify-between mb-3">
          <div>
            <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium">{t("dash.piotroskiSub")}</div>
            <div className="font-serif text-[clamp(28px,7vw,40px)] text-ink leading-none mt-1">
              {piotroski.passCount}
              {piotroski.uncertainCount > 0 ? (
                <span className="text-[16px] text-ink-soft"> / {9 - piotroski.uncertainCount} {t("dash.confirmed")}</span>
              ) : (
                <span className="text-[16px] text-ink-soft"> / 9</span>
              )}
            </div>
            <div className="text-[12px] text-ink-soft mt-1">
              {piotroskiBandLabel}
              {piotroski.uncertainCount > 0
                ? ` · ${t("dash.checksUncertain", { count: piotroski.uncertainCount })}`
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
                <th className="text-left py-2 px-4 font-medium text-ink-mute">{t("dash.check")}</th>
                <th className="text-center py-2 px-4 font-medium text-ink-mute w-20">{t("dash.result")}</th>
                <th className="text-left py-2 px-4 font-medium text-ink-mute">{t("dash.detail")}</th>
              </tr>
            </thead>
            <tbody>
              {piotroski.checks.map((c) => {
                const tone =
                  c.result === "pass"
                    ? "text-[#2AA89B]"
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
          {t("dash.ratioBankruptcy")} · Altman {altman.variant}
        </h2>
        <div className="rounded-2xl border border-rule bg-surface p-5">
          <div className="flex items-baseline justify-between gap-4 flex-wrap">
            <div>
              <div className="font-serif text-[clamp(28px,7vw,40px)] text-ink leading-none">{altman.score.toFixed(2)}</div>
              <div className="text-[12px] text-ink-soft mt-1">
                {t("dash.altmanThresholds", { safe: altman.thresholds.safe.toFixed(2), distress: altman.thresholds.distress.toFixed(2) })}
              </div>
            </div>
            <span
              className={`text-[11px] font-semibold uppercase tracking-[0.06em] px-3 py-1 rounded-full border ${
                altman.zone === "safe"
                  ? "ask-ai-anim-fill [animation-duration:10s] border-brand/40 text-ink"
                  : altman.zone === "grey"
                    ? "bg-[#E6F7F4] text-[#2AA89B] border-transparent"
                    : "bg-red-50 text-red-700 border-transparent"
              }`}
            >
              {altman.zone === "safe" ? t("dash.safeZone") : altman.zone === "grey" ? t("dash.greyZone") : t("dash.distress")}
            </span>
          </div>
          <p className="text-[12.5px] text-ink-soft mt-3 leading-snug">{altman.methodologyNote}</p>
          <div className="mt-4 rounded-xl border border-rule bg-bg-2/30 overflow-hidden">
            <div className="overflow-x-auto">
            <table className="w-full text-[12.5px] min-w-[480px] sm:min-w-0">
              <thead>
                <tr className="bg-bg-2/40">
                  <th className="text-left py-2 px-3 font-medium text-ink-mute">{t("dash.component")}</th>
                  <th className="text-right py-2 px-3 font-medium text-ink-mute">{t("dash.coefficient")}</th>
                  <th className="text-right py-2 px-3 font-medium text-ink-mute">{t("dash.value")}</th>
                  <th className="text-right py-2 px-3 font-medium text-ink-mute">{t("dash.weighted")}</th>
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
                    {t("dash.altmanScoreLabel", { variant: altman.variant })}
                  </td>
                  <td
                    className={`py-2 px-3 text-right tabular-nums font-semibold ${
                      altman.zone === "safe"
                        ? "text-[#2AA89B]"
                        : altman.zone === "grey"
                          ? "text-[#2AA89B]"
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
      <div className="flex items-start gap-2.5 rounded-lg border-l-[3px] border-rule bg-bg-2/40 px-4 py-3 text-[12.5px] text-ink-soft leading-relaxed">
        <Info size={13} strokeWidth={1.75} className="text-ink-mute mt-0.5 shrink-0" />
        <div><strong className="text-ink">{t("dash.caveat")}</strong> {credit.caveat}</div>
      </div>
    </>
  );
}
