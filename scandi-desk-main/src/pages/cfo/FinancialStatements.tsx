// /dashboard — Financial Statement Intelligence flagship page.
//
// Multi-tab dashboard wrapped in the standard AppShell:
//   Overview · Statements · Ratios · Valuation · Risks · Recommendations · Export
//
// Inputs:
//   • Sample picker (synthetic fictional datasets — Step 2 of the REAL-AUTH prompt)
//   • Drop-zone upload (PDF/XLSX/CSV/JPG/PNG) — backend extraction coming next
//   • "Paste trial balance" dialog — Romanian chart-of-accounts parser maps
//     pasted balanță de verificare lines into a full Statements object so the
//     entire analysis surface lights up immediately
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
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AppShell } from "@/components/cfo/AppShell";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  FileSpreadsheet,
  FileText,
  Loader2,
  RefreshCw,
  Shield,
  Sparkles,
  TrendingUp,
  UploadCloud,
} from "lucide-react";
import {
  computeRatios,
  deriveTotals,
  downloadReport,
  formatCurrency,
  formatRatio,
  generateRecommendations,
  verdictColor,
  verdictLabel,
  type Ratio,
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
  DEMO_RO_TRIAL_BALANCE,
  parseTrialBalance,
} from "@/lib/trialBalanceParser";
import { downloadExcelReport } from "@/lib/financialExports";
import { SAMPLE_DATASETS, SAMPLES_ENABLED } from "@/data/sampleStatements";
import { useActivePeriod } from "@/lib/activePeriod";
import { DocsToggle, useDocsCount } from "@/components/cfo/DocsPanel";
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
import { CustomersTab } from "./dashboard/tabs/CustomersTab";
import { PaymentsTab } from "./dashboard/tabs/PaymentsTab";
import { VatTab } from "./dashboard/tabs/VatTab";
import { MarginTab } from "./dashboard/tabs/MarginTab";
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
  const [tbDialogOpen, setTbDialogOpen] = useState(false);
  const [tbInput, setTbInput] = useState<string>("");
  const [parseSource, setParseSource] = useState<{
    documentName: string;
    confidence: number;
    warnings: string[];
    accountCount: number;
  } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

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
      return sp;
    }, { replace: true });
  }

  function applyTrialBalance(text: string) {
    const result = parseTrialBalance(text);
    if (result.lines.length === 0) {
      toast({
        title: "Could not parse trial balance",
        description: "No lines starting with a 3- or 4-digit account code were detected. Check the format and try again.",
        variant: "destructive",
      });
      return;
    }
    const built = buildStatementsFromTrialBalance(result, {
      companyName: "Imported entity",
      currency: "RON",
      periodLabel: "Imported period",
    });
    setStatements(built);
    setAvailableTypes(new Set(["bilant", "pl", "trial_balance"]));
    setActiveSampleId("imported");
    setTbDialogOpen(false);
    toast({
      title: `Parsed ${result.lines.length} accounts`,
      description: result.unmatched.length
        ? `${result.unmatched.length} unmatched line(s) — review the chart of accounts coverage.`
        : "All lines mapped to standard schema.",
    });
  }

  // Statements-derived metrics — only computed when statements is non-null,
  // otherwise the tabs that need them aren't visible anyway.
  const totals = useMemo(() => (statements ? deriveTotals(statements) : null), [statements]);
  const ratios = useMemo(() => (statements ? computeRatios(statements) : null), [statements]);
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

  function resetWorkspace() {
    setStatements(null);
    setInvoices(null);
    setAvailableTypes(new Set());
    setActiveSampleId(null);
    setUploadName(null);
    setParseSource(null);
    setSearchParams((prev) => {
      const sp = new URLSearchParams(prev);
      sp.delete("tab");
      sp.delete("period");
      return sp;
    }, { replace: true });
  }

  // ─── URL hydration ──────────────────────────────────────────────────────
  // ?period=<sample_id|uuid> on first render → resolve via useActivePeriod()
  // (handles both fictional samples and pipeline-produced uploads). Hydrates
  // local statements/invoices/availableTypes in sync with the URL so the rest
  // of this page (which still uses local state) stays correct.
  const remotePeriod = useActivePeriod();
  useEffect(() => {
    if (!remotePeriod.isLoaded || !remotePeriod.statements) return;
    setStatements(remotePeriod.statements);
    if (remotePeriod.invoices) setInvoices(remotePeriod.invoices);
    setAvailableTypes(new Set(remotePeriod.availableTypes));
    setActiveSampleId(remotePeriod.id ?? "remote");
    if (remotePeriod.source === "upload") {
      setParseSource({
        documentName: remotePeriod.label ?? "Uploaded document",
        confidence: 1,
        warnings: [],
        accountCount: 0,
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
  const [uploadInFlight, setUploadInFlight] = useState<{
    docId: string;
    filename: string;
    status: import("@/lib/supabase").DocumentStatus;
    error?: string | null;
  } | null>(null);

  async function onFileChosen(file: File) {
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
    setUploadInFlight({ docId: "", filename: file.name, status: "queued" });
    const { uploadDocument, enqueuePipeline, subscribeToDocumentStatus } =
      await import("@/lib/supabase");
    const { row, error } = await uploadDocument(file);
    if (!row) {
      setUploadInFlight(null);
      toast({
        title: "Upload failed",
        description: error ?? "Unknown error.",
        variant: "destructive",
      });
      return;
    }
    setUploadInFlight({ docId: row.id, filename: file.name, status: "queued" });
    const enqueued = await enqueuePipeline(row.id);
    if (!enqueued) {
      setUploadInFlight((prev) => prev && { ...prev, status: "failed", error: "Backend unreachable." });
      toast({
        title: "Couldn't start analysis",
        description: "Backend is unreachable. The file uploaded but analysis didn't start.",
        variant: "destructive",
      });
      return;
    }
    const unsub = subscribeToDocumentStatus(row.id, (next) => {
      setUploadInFlight((prev) => prev && { ...prev, status: next.status, error: next.error });
      if (next.status === "analyzed" && next.period_id) {
        toast({
          title: "Analysis ready",
          description: `${file.name} loaded into Dashboard.`,
        });
        unsub();
        setSearchParams((prev) => {
          const sp = new URLSearchParams(prev);
          sp.set("period", next.period_id!);
          return sp;
        }, { replace: true });
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

  return (
    <AppShell>
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
      <TooltipProvider delayDuration={150}>
        {hasPeriodLoaded ? (
          <CompactPeriodHeader
            statements={statements}
            invoices={invoices}
            activeSampleId={activeSampleId}
            onPickSample={pickSample}
            onTriggerFile={() => fileRef.current?.click()}
            onPasteTrialBalance={() => setTbDialogOpen(true)}
            onReset={resetWorkspace}
          />
        ) : (
          <section className="mb-10 transition-opacity duration-200">
            <div className="label-eyebrow">{t("dashboard.label_eyebrow")}</div>
            <h1 className="mt-3 font-serif text-[40px] sm:text-[48px] leading-[1.05] tracking-[-0.02em] text-ink max-w-[820px]">
              {t("dashboard.hero_pre")}{" "}
              <span className="text-grad font-medium">{t("dashboard.hero_highlight")}</span>
              {" "}{t("dashboard.hero_post")}
            </h1>
            <p className="mt-5 text-[15.5px] text-ink-soft max-w-[680px]">
              {t("dashboard.hero_subtitle")}
            </p>
          </section>
        )}

        {/* KPI strip — only in State B. State A keeps the hero visually big. */}
        {hasPeriodLoaded && statements && totals && (
          <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
            <KpiTile data-testid="kpi-revenue" label="Revenue" value={formatCurrency(statements.incomeStatement.revenue, statements.currency)} />
            <KpiTile
              data-testid="kpi-ebitda"
              label="EBITDA"
              value={formatCurrency(totals.ebitda, statements.currency)}
              sub={`${((totals.ebitda / Math.max(statements.incomeStatement.revenue, 1)) * 100).toFixed(1)}% margin`}
            />
            <KpiTile
              data-testid="kpi-net-income"
              label="Net income"
              value={formatCurrency(totals.netIncome, statements.currency)}
              sub={`${((totals.netIncome / Math.max(statements.incomeStatement.revenue, 1)) * 100).toFixed(1)}% margin`}
            />
            <KpiTile
              data-testid="kpi-total-debt"
              label="Total debt"
              value={formatCurrency(totals.totalDebt, statements.currency)}
              sub={`${(totals.totalDebt / Math.max(totals.ebitda, 1)).toFixed(2)}× EBITDA`}
            />
          </section>
        )}

        {/* Second KPI row — invoice analytics (when invoices loaded). */}
        {hasPeriodLoaded && invoices && invoices.length > 0 && <InvoiceKpiStrip invoices={invoices} />}

        {/* Server-generated CFO briefing. Only renders when the active period
            came from the pipeline (Opus 4.7 narrate stage). Empty for samples. */}
        {hasPeriodLoaded && remotePeriod.briefing && (
          <section className="mt-3">
            <article
              data-testid="cfo-briefing"
              className="rounded-2xl border border-brand/25 bg-brand-tint/40 p-5"
            >
              <div className="flex items-center gap-2 text-[10.5px] uppercase tracking-[0.1em] text-brand-d font-medium mb-2">
                <Sparkles size={11} strokeWidth={2} />
                CFO briefing — Opus 4.7
              </div>
              <p className="text-[14px] text-ink leading-relaxed">{remotePeriod.briefing}</p>
            </article>
          </section>
        )}
        <div className={hasPeriodLoaded ? "mb-8" : ""} />

        <Tabs value={activeTab} onValueChange={onTabChange} className="w-full">
          {/* Phase F: every tab is always visible — disabled tabs render with
              the same width but at 45% opacity, cursor-not-allowed, and a
              tooltip explaining the data needed to enable them. The user
              can see the platform's full capability surface on first visit. */}
          <div className="relative">
            <TabsList className="bg-bg-2/60 border border-rule rounded-xl p-1 h-auto flex flex-nowrap sm:flex-wrap gap-1 overflow-x-auto sm:overflow-visible scrollbar-none" data-testid="tabs-list">
              {tabs.map((t) => {
                const isEnabled = enabled[t.id];
                if (isEnabled) {
                  return (
                    <TabsTrigger
                      key={t.id}
                      value={t.id}
                      data-testid={`tab-${t.id}`}
                      className="shrink-0 px-4 py-2 text-[13px] data-[state=active]:bg-surface data-[state=active]:text-ink data-[state=active]:shadow-sm rounded-lg whitespace-nowrap"
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
                        className="shrink-0 px-4 py-2 text-[13px] rounded-lg whitespace-nowrap opacity-45 cursor-not-allowed select-none text-ink-soft"
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
          {parseSource && <ExtractionConfidenceBanner source={parseSource} />}

          {!hasPeriodLoaded ? (
            // STATE A — entry surface. Upload zone + sample picker only.
            // While a pipeline run is in flight, swap the dropzone for an
            // in-place progress card so the user sees the analysis is
            // happening without leaving the page.
            uploadInFlight ? (
              <UploadProgressCard inflight={uploadInFlight} />
            ) : (
              <UploadAndSamplePanel
                statements={statements}
                activeSampleId={activeSampleId}
                uploadName={uploadName}
                onPickSample={pickSample}
                onReset={undefined}
                onTriggerFile={() => fileRef.current?.click()}
                onPasteTrialBalance={() => {
                  setTbInput(DEMO_RO_TRIAL_BALANCE);
                  setTbDialogOpen(true);
                }}
                onDrop={onDrop}
                fileRef={fileRef}
                onFileChosen={onFileChosen}
              />
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
            />
          )}
        </TabsContent>

        {/* STATEMENTS ───────────────────────────────────────────────────── */}
        {enabled.statements && statements && (
          <TabsContent value="statements" className="mt-6 space-y-8 min-h-[400px]">
            <BalanceSheetTable statements={statements} />
            <IncomeStatementTable statements={statements} />
          </TabsContent>
        )}

        {/* RATIOS ──────────────────────────────────────────────────────── */}
        {enabled.ratios && ratios && (
          <TabsContent value="ratios" className="mt-6 space-y-8 min-h-[400px]">
            <RatioGroupSection title="Liquidity" ratios={ratios.liquidity} />
            <RatioGroupSection title="Profitability" ratios={ratios.profitability} />
            <RatioGroupSection title="Leverage" ratios={ratios.leverage} />
            <RatioGroupSection title="Coverage" ratios={ratios.coverage} />
            <RatioGroupSection title="Efficiency · working capital cycle" ratios={ratios.efficiency} />
            <RatioGroupSection title="Bankruptcy risk" ratios={ratios.bankruptcy} />
          </TabsContent>
        )}

        {/* CUSTOMERS ──────────────────────────────────────────────────── */}
        {enabled.customers && invoices && (
          <TabsContent value="customers" className="mt-6 min-h-[400px]">
            <CustomersTab invoices={invoices} currency={statements?.currency ?? "RON"} />
          </TabsContent>
        )}

        {/* PAYMENTS ──────────────────────────────────────────────────── */}
        {enabled.payments && invoices && (
          <TabsContent value="payments" className="mt-6 min-h-[400px]">
            <PaymentsTab invoices={invoices} currency={statements?.currency ?? "RON"} />
          </TabsContent>
        )}

        {/* MARGIN ────────────────────────────────────────────────────── */}
        {enabled.margin && invoices && (
          <TabsContent value="margin" className="mt-6 min-h-[400px]">
            <MarginTab
              invoices={invoices}
              totalCogs={statements?.incomeStatement.costOfGoodsSold}
              currency={statements?.currency ?? "RON"}
            />
          </TabsContent>
        )}

        {/* VAT ──────────────────────────────────────────────────────── */}
        {enabled.vat && invoices && (
          <TabsContent value="vat" className="mt-6 min-h-[400px]">
            <VatTab
              invoices={invoices}
              currency={statements?.currency ?? "RON"}
              onUploadD394={() => fileRef.current?.click()}
            />
          </TabsContent>
        )}

        {/* VALUATION ───────────────────────────────────────────────────── */}
        {enabled.valuation && statements && (
          <TabsContent value="valuation" className="mt-6 space-y-6 min-h-[400px]">
            <ValuationPanel statements={statements} />
          </TabsContent>
        )}

        {/* RISKS & CREDIT ──────────────────────────────────────────────── */}
        {enabled.risks && statements && (
          <TabsContent value="risks" className="mt-6 space-y-6 min-h-[400px]">
            <RisksPanel statements={statements} />
          </TabsContent>
        )}

        {/* RECOMMENDATIONS ─────────────────────────────────────────────── */}
        <TabsContent value="recommendations" className="mt-6 space-y-3 min-h-[400px]">
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

      <Dialog open={tbDialogOpen} onOpenChange={setTbDialogOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t("upload.paste_text_dialog_title")}</DialogTitle>
            <DialogDescription>
              {t("upload.paste_text_dialog_description")}
            </DialogDescription>
          </DialogHeader>
          <textarea
            value={tbInput}
            onChange={(e) => setTbInput(e.target.value)}
            spellCheck={false}
            className="w-full h-[360px] rounded-lg border border-rule bg-bg-2/30 p-3 text-[11.5px] font-mono leading-snug text-ink resize-none focus:outline-none focus:border-brand-d/40"
            placeholder={t("upload.paste_text_placeholder")}
          />
          <DialogFooter>
            <button
              onClick={() => setTbDialogOpen(false)}
              className="h-9 px-4 rounded-lg text-[12.5px] font-medium text-ink-soft hover:text-ink hover:bg-bg-2 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => applyTrialBalance(tbInput)}
              disabled={!tbInput.trim()}
              className="h-9 px-4 rounded-lg bg-brand text-paper text-[12.5px] font-medium hover:bg-brand-d transition-colors disabled:opacity-50"
            >
              Parse & analyze
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function ExtractionConfidenceBanner({
  source,
}: {
  source: { documentName: string; confidence: number; warnings: string[]; accountCount: number };
}) {
  const pct = Math.round(source.confidence * 100);
  const low = source.confidence < 0.8;
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
          <strong>{low ? "Verifică datele extrase" : "Extracted from"}</strong> ·{" "}
          <span className="font-mono text-[12px]">{source.documentName}</span> ·{" "}
          {source.accountCount} accounts · <strong>{low ? "încredere" : "confidence"} {pct}%</strong>
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

function KpiTile({
  label,
  value,
  sub,
  ...rest
}: {
  label: string;
  value: string;
  sub?: string;
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className="rounded-xl border border-rule bg-surface px-4 py-3" {...rest}>
      <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium">{label}</div>
      <div className="mt-1.5 font-serif text-[22px] text-ink leading-tight">{value}</div>
      {sub && <div className="mt-0.5 text-[11.5px] text-ink-soft">{sub}</div>}
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
  onPasteTrialBalance,
  onReset,
}: {
  statements: Statements | null;
  invoices: Invoice[] | null;
  activeSampleId: string | null;
  onPickSample: (id: string, opts?: { additive?: boolean }) => void;
  onTriggerFile: () => void;
  onPasteTrialBalance: () => void;
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

  return (
    <header className="mb-6 flex items-start justify-between gap-3 flex-wrap" data-testid="compact-period-header">
      <div className="min-w-0">
        <div className="label-eyebrow">Period loaded</div>
        <h1 className="mt-1 font-serif text-[26px] sm:text-[30px] leading-[1.15] tracking-[-0.01em] text-ink truncate max-w-[640px]">
          {companyName}
          {periodLabel && (
            <span className="text-ink-soft font-normal"> · {periodLabel}</span>
          )}
        </h1>
      </div>
      <div className="flex items-center gap-2">
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
              onClick={onTriggerFile}
              className="text-[12.5px] cursor-pointer"
            >
              <UploadCloud size={13} strokeWidth={1.75} className="mr-1.5" />
              Choose a file…
            </DropdownMenuItem>
            <DropdownMenuItem
              data-testid="replace-menu-paste"
              onClick={onPasteTrialBalance}
              className="text-[12.5px] cursor-pointer"
            >
              <ClipboardPaste size={13} strokeWidth={1.75} className="mr-1.5" />
              Paste trial balance text
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
        <button
          data-testid="rerun-analysis"
          onClick={() => activeSampleId && onPickSample(activeSampleId)}
          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-rule bg-surface text-[12.5px] font-medium text-ink-soft hover:text-ink hover:bg-bg-2 transition-colors"
          title="Re-run the analysis pipeline on the current period"
        >
          <RefreshCw size={12.5} strokeWidth={2} />
          Re-run
        </button>
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
}: {
  statements: Statements | null;
  invoices: Invoice[] | null;
  ratios: ReturnType<typeof computeRatios> | null;
  recommendations: Recommendation[];
  criticalCount: number;
  highCount: number;
  onJumpToTab: (tab: string) => void;
}) {
  const summary = useMemo(
    () => buildDeterministicSummary({ statements, invoices, ratios, criticalCount, highCount }),
    [statements, invoices, ratios, criticalCount, highCount],
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

      {/* Mini financial statements — BS / P&L / CF top-6 lines. */}
      {statements && <MiniStatements statements={statements} onJumpToTab={onJumpToTab} />}

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
}: {
  statements: Statements | null;
  invoices: Invoice[] | null;
  ratios: ReturnType<typeof computeRatios> | null;
  criticalCount: number;
  highCount: number;
}): string {
  const parts: string[] = [];
  if (statements && ratios) {
    const totals = deriveTotals(statements);
    const ebitdaMargin = (totals.ebitda / Math.max(statements.incomeStatement.revenue, 1)) * 100;
    const dteRatio = ratios.leverage.find((r) => r.key === "debt_to_ebitda");
    parts.push(
      `Revenue ${formatCurrency(statements.incomeStatement.revenue, statements.currency)} with ` +
      `${ebitdaMargin.toFixed(1)}% EBITDA margin and net income ${formatCurrency(totals.netIncome, statements.currency)}.`,
    );
    if (dteRatio) {
      parts.push(
        `Leverage ${dteRatio.value.toFixed(2)}× Debt/EBITDA — ${
          dteRatio.value > 4.5 ? "stretched, refinancing risk elevated"
          : dteRatio.value > 3 ? "elevated, monitor covenants"
          : "comfortable"
        }.`,
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
                    Estimated impact: {formatCurrency(rec.estimatedImpact, currency)} / yr
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
}: {
  inflight: { docId: string; filename: string; status: import("@/lib/supabase").DocumentStatus; error?: string | null };
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
  return (
    <div
      data-testid="dashboard-upload-progress"
      className="rounded-2xl border border-rule bg-surface p-7 max-w-[640px] mx-auto"
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          {isFailed ? (
            <AlertCircle size={16} className="text-alert" strokeWidth={2} />
          ) : (
            <Loader2 size={16} className="text-brand animate-spin" strokeWidth={2} />
          )}
          <span className="text-[14px] font-medium text-ink">
            {isFailed ? "Couldn't finish analysis" : "Analyzing your document…"}
          </span>
        </div>
        {!isFailed && (
          <span className="text-[11.5px] text-ink-mute tabular-nums">
            Step {stage.ordinal} of {total}
          </span>
        )}
      </div>
      <div className="text-[13px] text-ink-soft mb-3">
        <span className="text-ink font-medium">{inflight.filename}</span>{" "}
        · {stage.label}
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
  );
}

function UploadAndSamplePanel({
  statements,
  activeSampleId,
  uploadName,
  onPickSample,
  onReset,
  onTriggerFile,
  onPasteTrialBalance,
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
  onPasteTrialBalance: () => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  fileRef: React.RefObject<HTMLInputElement>;
  onFileChosen: (file: File) => void;
}) {
  return (
    <div className={`grid grid-cols-1 ${SAMPLES_ENABLED ? "lg:grid-cols-[1.2fr_1fr]" : ""} gap-4`}>
      {/* Upload zone */}
      <div
        data-testid="upload-dropzone"
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        className="rounded-2xl border-2 border-dashed border-rule bg-bg-2/30 p-6 flex flex-col items-center justify-center text-center min-h-[220px]"
      >
        <div className="h-12 w-12 rounded-2xl bg-brand-tint text-brand-d flex items-center justify-center mb-3">
          <UploadCloud size={20} strokeWidth={1.75} />
        </div>
        <h3 className="font-serif text-[18px] text-ink">Upload financial documents</h3>
        <p className="text-[12.5px] text-ink-soft mt-1 max-w-[420px]">
          PDF · XLSX · CSV · JPG · PNG — invoices, balance sheets, P&L, trial
          balance, annual reports. Auto-detected on drop.
        </p>
        {/* Recognized invoice-export formats — visual hint for accountants. */}
        <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5 max-w-[460px] mx-auto">
          {["SAF-T", "e-Factura XML", "SmartBill CSV", "WinMentor", "Saga", "generic CSV"].map((f) => (
            <span
              key={f}
              className="inline-flex items-center text-[10.5px] uppercase tracking-[0.06em] font-medium text-ink-mute bg-bg-2/60 border border-rule rounded-md px-2 py-0.5"
            >
              {f}
            </span>
          ))}
        </div>
        <div className="mt-4 flex items-center gap-2">
          <button
            onClick={onTriggerFile}
            className="inline-flex items-center gap-2 h-9 px-4 rounded-lg bg-surface border border-rule text-[12.5px] font-medium text-ink hover:bg-bg-2 transition-colors"
          >
            Choose a file
          </button>
          <button
            onClick={onPasteTrialBalance}
            className="inline-flex items-center gap-2 h-9 px-4 rounded-lg bg-ink text-paper text-[12.5px] font-medium hover:bg-ink/90 transition-colors"
          >
            <ClipboardPaste size={13} strokeWidth={2} />
            Paste trial balance
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,.xlsx,.xls,.csv,.jpg,.jpeg,.png"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFileChosen(f);
          }}
        />
        {uploadName && (
          <div className="mt-3 text-[11.5px] text-ink-mute">
            Received: <span className="text-ink">{uploadName}</span>
          </div>
        )}
        <div className="mt-4 inline-flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium">
          <Sparkles size={10} strokeWidth={2} />
          Detect · OCR · extract · ratios · Opus 4.7 narrative — end-to-end
        </div>
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
  );
}

function RatioGroupSection({ title, ratios }: { title: string; ratios: Ratio[] }) {
  return (
    <div>
      <h2 className="font-serif text-[22px] text-ink mb-3">{title}</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {ratios.map((r) => (
          <RatioTile key={r.key} ratio={r} />
        ))}
      </div>
    </div>
  );
}

function RatioTile({ ratio }: { ratio: Ratio }) {
  const c = verdictColor(ratio.verdict);
  return (
    <div className="rounded-xl border border-rule bg-surface p-4">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="text-[11px] uppercase tracking-[0.1em] text-ink-mute font-medium">{ratio.label}</div>
        <span
          className="text-[9.5px] font-semibold uppercase tracking-[0.06em] px-2 py-0.5 rounded-full"
          style={{ backgroundColor: c.bg, color: c.text }}
        >
          {verdictLabel(ratio.verdict)}
        </span>
      </div>
      <div className="font-serif text-[24px] text-ink leading-tight">{formatRatio(ratio)}</div>
      <div className="text-[11px] text-ink-mute mt-1">{ratio.benchmark}</div>
      <p className="text-[12px] text-ink-soft leading-snug mt-2">{ratio.commentary}</p>
    </div>
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
  return (
    <div className="rounded-2xl border border-rule bg-surface p-5">
      <div className="flex items-start gap-3 mb-2">
        <span className={`text-[10.5px] font-semibold uppercase tracking-[0.06em] px-2.5 py-1 rounded ${t.pillBg} ${t.pillText}`}>
          {rec.priority}
        </span>
        <h3 className="font-serif text-[16.5px] text-ink leading-tight">{rec.title}</h3>
      </div>
      <p className="text-[13px] text-ink-soft mt-2"><span className="text-ink font-medium">Why:</span> {rec.rationale}</p>
      <p className="text-[13px] text-ink-soft mt-2"><span className="text-ink font-medium">Action:</span> {rec.action}</p>
      {rec.estimatedImpact && (
        <div className="mt-3 inline-flex items-center text-[11.5px] font-medium text-emerald-700 bg-emerald-50 px-3 py-1 rounded-md">
          Estimated impact: {formatCurrency(rec.estimatedImpact, currency)} / year
        </div>
      )}
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

function fmtMoney(n: number, currency: string): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}${currency} ${abs.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

// ─── VALUATION PANEL ──────────────────────────────────────────────────────

function ValuationPanel({ statements }: { statements: Statements }) {
  const wacc = useMemo(() => computeCostOfCapital(statements), [statements]);
  const dcf = useMemo(() => runDcf(statements), [statements]);
  const graham = useMemo(() => runGraham(statements), [statements]);
  const cf = useMemo(() => deriveCashFlow(statements), [statements]);
  const growth = useMemo(() => multiPeriodGrowth(statements), [statements]);
  const cur = statements.currency;

  const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;

  return (
    <>
      {/* Cash flow snapshot */}
      <div>
        <h2 className="font-serif text-[22px] text-ink mb-3">Free cash flow</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <KpiTile label="Net income" value={fmtMoney(cf.netIncome, cur)} />
          <KpiTile label="+ D&A" value={fmtMoney(cf.depreciationAmortization, cur)} />
          <KpiTile label="− ΔWorking capital" value={fmtMoney(cf.workingCapitalChange, cur)} />
          <KpiTile label="= CFO" value={fmtMoney(cf.cfo, cur)} />
          <KpiTile label="− Capex" value={fmtMoney(cf.capex, cur)} />
          <KpiTile label="= FCF" value={fmtMoney(cf.fcf, cur)} sub={cf.fcf > 0 ? "Positive cash generation" : "Cash burning"} />
        </div>
      </div>

      {/* WACC */}
      <div>
        <h2 className="font-serif text-[22px] text-ink mb-3">Cost of capital (WACC)</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <KpiTile label="WACC" value={pct(wacc.wacc, 2)} sub={`Cost of equity ${pct(wacc.costOfEquity, 2)}`} />
          <KpiTile label="Cost of equity" value={pct(wacc.costOfEquity, 2)} sub={`Rf ${pct(wacc.riskFreeRate, 1)} + β${wacc.beta.toFixed(2)} × ERP ${pct(wacc.equityRiskPremium, 1)}`} />
          <KpiTile label="Cost of debt (after tax)" value={pct(wacc.costOfDebtAfterTax, 2)} sub={`Pre-tax ${pct(wacc.costOfDebtPreTax, 2)} · tax ${pct(wacc.taxRate, 1)}`} />
          <KpiTile label="Weight equity" value={pct(wacc.weightOfEquity, 1)} />
          <KpiTile label="Weight debt" value={pct(wacc.weightOfDebt, 1)} />
        </div>
      </div>

      {/* DCF */}
      <div>
        <h2 className="font-serif text-[22px] text-ink mb-3">DCF intrinsic value</h2>
        <div className="rounded-2xl border border-rule bg-surface overflow-hidden">
          <div className="px-5 py-3 bg-bg-2/40 border-b border-rule flex items-center justify-between">
            <div>
              <div className="font-serif text-[16px] text-ink">5-year explicit forecast + Gordon terminal</div>
              <div className="text-[12px] text-ink-soft">
                Forecast growth {pct(dcf.forecastGrowthRate, 1)} · Terminal growth {pct(dcf.terminalGrowthRate, 1)} · WACC {pct(dcf.wacc, 2)}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium">Equity value</div>
              <div className="font-serif text-[28px] text-ink leading-tight">{fmtMoney(dcf.equityValue, cur)}</div>
            </div>
          </div>
          <table className="w-full text-[13px]">
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
                <td className="py-2 px-4 text-right tabular-nums text-ink font-medium">{fmtMoney(dcf.terminalValuePresent, cur)}</td>
              </tr>
              <tr className="border-t-2 border-ink/30 bg-bg-2/40">
                <td className="py-2 px-4 text-ink font-semibold" colSpan={3}>Enterprise value</td>
                <td className="py-2 px-4 text-right tabular-nums text-ink font-semibold">{fmtMoney(dcf.enterpriseValue, cur)}</td>
              </tr>
              <tr className="border-t border-rule">
                <td className="py-2 px-4 text-ink-soft" colSpan={3}>− Net debt</td>
                <td className="py-2 px-4 text-right tabular-nums text-ink">{fmtMoney(-dcf.netDebt, cur)}</td>
              </tr>
              <tr className="border-t-2 border-ink/30 bg-brand-tint">
                <td className="py-2 px-4 text-ink font-semibold" colSpan={3}>Equity value</td>
                <td className="py-2 px-4 text-right tabular-nums text-ink font-semibold">{fmtMoney(dcf.equityValue, cur)}</td>
              </tr>
            </tbody>
          </table>
          <div className="px-5 py-3 border-t border-rule bg-bg-2/20 grid grid-cols-2 gap-4">
            <div>
              <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium">EV / EBITDA</div>
              <div className="font-serif text-[18px] text-ink">{dcf.evToEbitda.toFixed(2)}×</div>
            </div>
            <div>
              <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium">EV / Revenue</div>
              <div className="font-serif text-[18px] text-ink">{dcf.evToRevenue.toFixed(2)}×</div>
            </div>
          </div>
        </div>
      </div>

      {/* Graham */}
      <div>
        <h2 className="font-serif text-[22px] text-ink mb-3">Graham intrinsic value</h2>
        <div className="rounded-2xl border border-rule bg-surface p-5">
          <div className="text-[12px] text-ink-soft mb-3 font-mono">
            {graham.formula} &nbsp;·&nbsp; g = {pct(graham.growthRate, 1)} &nbsp;·&nbsp; Y = {pct(graham.bondYield, 2)}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium">Net income (TTM)</div>
              <div className="font-serif text-[20px] text-ink">{fmtMoney(graham.eps * (statements.supplementary.sharesOutstanding ?? 1), cur)}</div>
            </div>
            <div>
              <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium">Graham fair equity value</div>
              <div className="font-serif text-[20px] text-ink">{fmtMoney(graham.intrinsicEquityValue, cur)}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Multi-period growth */}
      {growth.length > 0 && (
        <div>
          <h2 className="font-serif text-[22px] text-ink mb-3">Multi-period growth</h2>
          <div className="rounded-2xl border border-rule bg-surface overflow-hidden">
            <table className="w-full text-[13px]">
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
      )}
    </>
  );
}

// ─── RISKS & CREDIT PANEL ─────────────────────────────────────────────────

function RisksPanel({ statements }: { statements: Statements }) {
  const credit = useMemo(() => computeCreditScore(statements), [statements]);
  const piotroski = useMemo(() => runPiotroski(statements), [statements]);
  const altmanZ = computeRatios(statements).bankruptcy[0];

  const ratingTone = (rating: string): string => {
    if (rating.startsWith("AAA") || rating.startsWith("AA")) return "bg-emerald-50 text-emerald-700 border-emerald-300/60";
    if (rating.startsWith("A") || rating.startsWith("BBB")) return "bg-blue-50 text-blue-700 border-blue-300/60";
    if (rating.startsWith("BB") || rating.startsWith("B")) return "bg-amber-50 text-amber-700 border-amber-300/60";
    return "bg-red-50 text-red-700 border-red-300/60";
  };

  return (
    <>
      {/* Composite credit score */}
      <div>
        <h2 className="font-serif text-[22px] text-ink mb-3">Composite credit score</h2>
        <div className={`rounded-2xl border-2 ${ratingTone(credit.rating)} p-6 flex items-center justify-between`}>
          <div>
            <div className="text-[11px] uppercase tracking-[0.12em] font-medium opacity-80">Credit rating</div>
            <div className="font-serif text-[64px] leading-none mt-1">{credit.rating}</div>
            <div className="text-[12px] mt-2 opacity-80">Composite score: {credit.score} / 100</div>
          </div>
          <Shield size={64} strokeWidth={1.25} className="opacity-30" />
        </div>
        <div className="mt-3 rounded-2xl border border-rule bg-surface overflow-hidden">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="bg-bg-2/30">
                <th className="text-left py-2 px-4 font-medium text-ink-mute">Component</th>
                <th className="text-right py-2 px-4 font-medium text-ink-mute">Value</th>
                <th className="text-right py-2 px-4 font-medium text-ink-mute">Weight</th>
                <th className="text-right py-2 px-4 font-medium text-ink-mute">Contribution</th>
              </tr>
            </thead>
            <tbody>
              {credit.components.map((c) => (
                <tr key={c.label} className="border-t border-rule">
                  <td className="py-2 px-4 text-ink">{c.label}</td>
                  <td className="py-2 px-4 text-right tabular-nums text-ink">{c.value.toFixed(2)}</td>
                  <td className="py-2 px-4 text-right tabular-nums text-ink-soft">{(c.weight * 100).toFixed(0)}%</td>
                  <td className="py-2 px-4 text-right tabular-nums text-ink">{c.contribution.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Piotroski F-Score */}
      <div>
        <h2 className="font-serif text-[22px] text-ink mb-3">Piotroski F-Score</h2>
        <div className="rounded-2xl border border-rule bg-surface p-5 flex items-center justify-between mb-3">
          <div>
            <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium">9-point quality screen</div>
            <div className="font-serif text-[40px] text-ink leading-none mt-1">{piotroski.score} <span className="text-[16px] text-ink-soft">/ 9</span></div>
            <div className="text-[12px] text-ink-soft mt-1">{piotroski.band}</div>
          </div>
          <TrendingUp size={48} strokeWidth={1.25} className="text-ink-mute opacity-50" />
        </div>
        <div className="rounded-2xl border border-rule bg-surface overflow-hidden">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="bg-bg-2/30">
                <th className="text-left py-2 px-4 font-medium text-ink-mute">Check</th>
                <th className="text-center py-2 px-4 font-medium text-ink-mute w-20">Result</th>
                <th className="text-left py-2 px-4 font-medium text-ink-mute">Detail</th>
              </tr>
            </thead>
            <tbody>
              {piotroski.checks.map((c) => (
                <tr key={c.key} className="border-t border-rule">
                  <td className="py-2 px-4 text-ink">{c.label}</td>
                  <td className={`py-2 px-4 text-center font-semibold ${c.pass ? "text-emerald-700" : "text-red-700"}`}>
                    {c.pass ? "✓" : "✗"}
                  </td>
                  <td className="py-2 px-4 text-ink-soft">{c.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Altman Z */}
      <div>
        <h2 className="font-serif text-[22px] text-ink mb-3">Bankruptcy risk · Altman Z</h2>
        <div className="rounded-2xl border border-rule bg-surface p-5">
          <div className="flex items-baseline justify-between gap-4 flex-wrap">
            <div>
              <div className="font-serif text-[40px] text-ink leading-none">{altmanZ.value.toFixed(2)}</div>
              <div className="text-[12px] text-ink-soft mt-1">{altmanZ.benchmark}</div>
            </div>
            <span className={`text-[11px] font-semibold uppercase tracking-[0.06em] px-3 py-1 rounded-full ${
              altmanZ.verdict === "strong" ? "bg-emerald-50 text-emerald-700" :
              altmanZ.verdict === "healthy" ? "bg-blue-50 text-blue-700" :
              altmanZ.verdict === "watch" ? "bg-amber-50 text-amber-700" :
              "bg-red-50 text-red-700"
            }`}>
              {verdictLabel(altmanZ.verdict)}
            </span>
          </div>
          <p className="text-[13px] text-ink-soft mt-3 leading-snug">{altmanZ.commentary}</p>
        </div>
      </div>
    </>
  );
}
