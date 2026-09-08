// F6.0.1b (2026-06-21) — Budget vs Actual vs Last-Year variance page.
//
// The management variance report from the Scandia decks: for the loaded
// period, show each P&L line's Actual / Budget / Last Year + Δ-vs-Budget +
// Δ-vs-LY. Actuals reconcile to the dashboard tiles; budget + last-year come
// from an uploaded file (or a clearly-labeled demo on the test workspace).

import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Upload, Sparkles } from "lucide-react";
// A3 hero eviction — the compact instrument header replaces the serif
// hero on this always-authenticated surface.
import { PageHeader as InstrumentPageHeader } from "@/components/instrument/Panel";
import { openAskCfoAi } from "@/components/cfo/chat/openAskCfoAi";
import { useActivePeriod } from "@/lib/activePeriod";
import { useOrgPeriods } from "@/lib/orgPeriods";
import { useActivePeriodFallback } from "@/hooks/useActivePeriodFallback";
import { isPublicTestMode } from "@/lib/testMode";
import { buildReportingMetricsSnapshot } from "@/lib/learning/buildReportingMetrics";
import { buildDashboardCanonical } from "@/lib/scenarios/dashboardCanon";
import { buildActualLines, buildVarianceRows, normalizeDatasetCurrency } from "@/lib/comparison/buildVariance";
import { useRates } from "@/stores/currency";
import { buildDemoComparison } from "@/lib/comparison/demoSeed";
import { useBudgetComparison } from "@/stores/budget";
import { KpiVarianceStrip } from "@/components/comparison/KpiVarianceStrip";
import { VarianceTable, type VarianceView } from "@/components/comparison/VarianceTable";
import { BudgetUploadCard, BudgetTemplateCard } from "@/components/comparison/BudgetUploadCard";
import { LastYearSourcePicker, type LastYearSelection } from "@/components/comparison/LastYearSourcePicker";
import type { Statements } from "@/lib/financialReport";
import type { PeriodLineItem, PeriodMetric } from "@/lib/activePeriod";
import type { ComparisonDataset, VarianceLineKey } from "@/lib/comparison/types";
import { cn } from "@/lib/utils";

const VIEWS: { key: VarianceView; label: string }[] = [
  { key: "both", label: "Budget + LY" },
  { key: "budget", label: "vs Budget" },
  { key: "last_year", label: "vs Last year" },
];

function VarianceInner({
  statements,
  periodLabel,
  lineItems,
  metricRows,
}: {
  // Nullable: the page renders the header + budget upload UI even with no
  // period loaded (the blocking "Load a period…" empty state was removed
  // 2026-07-25). Statements-dependent parts (actuals, LY picker) are gated
  // on it below.
  statements: Statements | null;
  periodLabel: string | null;
  lineItems: PeriodLineItem[];
  metricRows: PeriodMetric[];
}) {
  const currency = statements?.currency ?? "RON";
  const [view, setView] = useState<VarianceView>("both");
  const { uploaded, save, clear } = useBudgetComparison();
  const [params] = useSearchParams();
  const activePeriodId = params.get("period");
  // F6.1b — Last-year source chosen via the period picker (a prior year of
  // this analysis, or another uploaded period). null until the picker emits.
  const [lySel, setLySel] = useState<LastYearSelection | null>(null);

  const actualLines = useMemo(() => {
    if (!statements) return {} as Record<VarianceLineKey, number | null>;
    const snap = buildReportingMetricsSnapshot(statements);
    const canon = buildDashboardCanonical(statements, lineItems, metricRows);
    return buildActualLines(snap, canon);
  }, [statements, lineItems, metricRows]);

  // Effective comparison: an upload always wins; otherwise the test workspace
  // shows a labeled demo; a real workspace with no upload shows none.
  const rawDataset = useMemo(() => {
    if (uploaded) return uploaded;
    if (isPublicTestMode) return buildDemoComparison(actualLines);
    return null;
  }, [uploaded, actualLines]);

  // Normalize the budget/LY into the period's currency (e.g. an EUR'000
  // budget deck on a RON workspace) so deltas don't mix currencies.
  const ratesPayload = useRates();
  const { dataset, convertedFrom } = useMemo(() => {
    if (!rawDataset)
      return { dataset: null as ComparisonDataset | null, convertedFrom: null as string | null };
    return normalizeDatasetCurrency(rawDataset, currency, ratesPayload.rates);
  }, [rawDataset, currency, ratesPayload.rates]);

  const isDemo = !uploaded && rawDataset?.source === "demo";
  // Whether the uploaded file itself carries a Last-year column (drives the
  // picker's "Budget file column" option — demo seed doesn't count).
  const budgetHasLastYear = !!uploaded && !!dataset && Object.keys(dataset.lastYear).length > 0;

  // F6.1b — overlay the picker's Last-year choice onto the (currency-
  // normalized) dataset. "period" → the chosen period's actuals; "none" →
  // blank the column; "budget"/unset → keep the file's Last-year column.
  const effectiveDataset = useMemo<ComparisonDataset | null>(() => {
    if (!dataset && lySel?.kind !== "period") return dataset;
    const base = dataset ?? { budget: {}, lastYear: {}, source: "upload" as const };
    if (lySel?.kind === "period") {
      const ly: Partial<Record<VarianceLineKey, number>> = {};
      for (const [k, v] of Object.entries(lySel.lines) as [VarianceLineKey, number | null][]) {
        if (v !== null && Number.isFinite(v)) ly[k] = v;
      }
      return { ...base, lastYear: ly };
    }
    if (lySel?.kind === "none") return { ...base, lastYear: {} };
    return base;
  }, [dataset, lySel]);

  const rows = useMemo(
    () => buildVarianceRows(actualLines, effectiveDataset),
    [actualLines, effectiveDataset],
  );
  const hasBudget = !!effectiveDataset && Object.keys(effectiveDataset.budget).length > 0;
  const hasLastYear = !!effectiveDataset && Object.keys(effectiveDataset.lastYear).length > 0;
  // ── WHAT THIS PAGE COMPARES, AND WHAT IT WAITS FOR ──────────────────
  //
  // It used to wait for a BUDGET FILE: `showComparison = !!uploaded ||
  // !!isDemo`. That is why it was called "Budget vs Actual vs LY" and why
  // it read as unavailable to anyone who had never uploaded one — even a
  // workspace with three years of attached periods saw nothing.
  //
  // The comparison it can always render is PERIOD vs PRIOR PERIOD vs LAST
  // YEAR, and those come from the periods already in the workspace. The
  // budget is a FOURTH column that unlocks on upload. So the gate is now
  // "is there a second period to compare against", and the budget is
  // additive rather than a precondition.
  //
  // `useOrgPeriods` already filters to periods that HAVE DOCUMENTS, so a
  // freshly-created empty month cannot count as something to compare with.
  const orgPeriods = useOrgPeriods();
  const attachedPeriods = orgPeriods.data?.periods ?? [];
  const hasSecondPeriod = attachedPeriods.length >= 2;
  const showComparison = hasSecondPeriod || !!uploaded || !!isDemo;
  // One period and no budget is a REAL state with a next action, not an
  // empty page. Distinguished from "still loading" so a slow query never
  // renders as "you have nothing".
  const periodsLoading = orgPeriods.isPending;
  const needsSecondPeriod =
    !showComparison && !periodsLoading && attachedPeriods.length <= 1;

  return (
    <div className="max-w-[1560px] space-y-5">
      {/* Top-left "Replace budget" pill — styled like the dashboard month
          pills (brand accent, circled icon). Shown ONLY once a budget file is
          uploaded (2026-07-26 per operator); before that, the under-header
          Import button + dropzone handle the first upload. Opens the picker in
          <BudgetUploadCard> via a window event (the card owns the input). */}
      {uploaded && (
        <div className="flex items-center">
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent("cfo:request-budget-upload"))}
            data-testid="variance-replace-budget"
            title="Replace budget file"
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full border border-rule bg-surface text-[12px] font-medium text-ink hover:bg-bg-2 transition-colors duration-micro"
          >
            <Upload size={12} strokeWidth={2} className="text-brand-dark dark:text-brand-light" />
            Replace budget
          </button>
        </div>
      )}

      {/* Hero row — header on the left, the official budget-template card on
          the right (2026-07-25 per operator, mirroring the dashboard/products
          hero). The full-width dropzone sits beneath both. */}
      <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr] items-start">
        <div className="space-y-3">
          {/* "Comparison" (2026-09-08 per operator) — matches the sidebar
              item's label exactly.
              It was "Budget vs Actual vs LY", which named the budget first
              and made the whole surface read as unavailable until someone
              uploaded one. It is not: the comparison this page always
              renders is PERIOD vs PRIOR PERIOD vs LAST YEAR, from the
              periods already attached to the workspace. The budget is a
              FOURTH column that unlocks on upload. */}
          <InstrumentPageHeader
            eyebrow="Management reporting"
            title="Comparison"
            context={
              <span>
                {periodLabel ?? "The loaded period"} · board-pack view
              </span>
            }
            actions={
              /* Ask CFO AI — header action, same entry point as before.
                  The Import button that used to lead this row was removed
                  (2026-07-26 per operator); the upload card below is the one
                  import path. */
              <button
                type="button"
                onClick={() => openAskCfoAi("Help me read my Budget vs Actual vs Last-Year variance — which lines are favorable or unfavorable, and what's driving the biggest gaps?")}
                data-testid="variance-ask-cfo-ai"
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-rule bg-surface text-[12.5px] font-medium text-ink hover:bg-bg-2 hover:border-rule-strong transition-colors duration-micro"
              >
                <Sparkles size={14} strokeWidth={2} className="text-brand-dark dark:text-brand-light" />
                Ask CFO AI
              </button>
            }
          />
          <p className="text-[12.5px] leading-relaxed text-ink-soft max-w-[64ch]">
            Every P&amp;L line of{" "}
            <span className="text-ink">{periodLabel ?? "the loaded period"}</span> set
            side-by-side against the <span className="text-ink">previous period</span>{" "}
            and the <span className="text-ink">same period last year</span> — each gap
            shown in both value and %, and flagged{" "}
            <span className="text-ink">favorable</span> or{" "}
            <span className="text-ink">unfavorable</span>. Built from the periods already
            attached to this workspace; upload a budget and it joins as a fourth column.
          </p>
        </div>
        <BudgetTemplateCard />
      </div>

      {/* THE BUDGET AFFORDANCE IS PERSISTENT (2026-09-08 per operator).
          It used to sit inside <ComingSoon>, blurred and inert — which was
          right while the whole surface was "not yet", and wrong now that
          the page renders a real comparison without a budget. The budget
          unlocks a fourth column, so the way to add one stays on screen
          whether or not the comparison is already showing. The feature as a
          whole is hidden for the launch cut at the registry, which is the
          honest place for "not yet" to live. */}
      <BudgetUploadCard uploaded={uploaded} isDemo={!!isDemo} onSave={save} onClear={clear} />

      {/* ONE PERIOD IS A STATE WITH A NEXT ACTION, NEVER AN EMPTY PAGE.
          Rendered only when we KNOW there is one period — a pending query
          shows nothing rather than telling a user with ten periods that
          they have none. */}
      {needsSecondPeriod && (
        <div
          data-testid="variance-needs-second-period"
          className="rounded-xl border border-rule bg-surface p-6"
        >
          <div className="text-[13.5px] font-medium text-ink">
            Attach a second period to compare
          </div>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-soft max-w-[64ch]">
            This workspace has one period with documents attached. A comparison
            needs something to compare against: upload the previous period, or
            the same period last year, and every P&amp;L line is set side by side
            automatically. A budget is optional and adds a fourth column.
          </p>
          <Link
            to="/workspace"
            data-testid="variance-attach-period"
            className="mt-3 inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-rule bg-surface text-[12.5px] font-medium text-ink hover:bg-bg-2 hover:border-rule-strong transition-colors duration-micro"
          >
            <Upload size={13} strokeWidth={2} className="text-brand-dark dark:text-brand-light" />
            Attach a period
          </Link>
        </div>
      )}

      {/* The comparison section — the "Compare against last year" picker, the
          KPI variance strip, and the variance table — only renders once a
          budget FILE is uploaded (2026-07-26 per operator). Before that, a
          period alone produced a meaningless self-comparison (Actual == Last
          year, every Δ +0). The test-workspace demo (isDemo) still shows it. */}
      {showComparison && (
        <>
          {statements && (
            <LastYearSourcePicker
              statements={statements}
              activeCurrency={currency}
              activePeriodId={activePeriodId}
              hasBudgetLastYear={budgetHasLastYear}
              rates={ratesPayload.rates}
              onChange={setLySel}
            />
          )}

          {(hasBudget || hasLastYear) && (
            <>
              <KpiVarianceStrip rows={rows} currency={currency} />

              {/* View toggle */}
              <div className="flex items-center gap-1 rounded-md border border-rule bg-surface p-1 w-fit" data-testid="variance-view-toggle">
                {VIEWS.map((v) => (
                  <button
                    key={v.key}
                    type="button"
                    onClick={() => setView(v.key)}
                    data-testid={`variance-view-${v.key}`}
                    className={cn(
                      "px-3 min-h-[30px] rounded-sm text-[12px] font-medium transition-colors duration-micro",
                      view === v.key
                        ? "bg-brand-tint text-brand-dark dark:text-brand-light"
                        : "text-ink-soft hover:text-ink hover:bg-bg-2",
                    )}
                  >
                    {v.label}
                  </button>
                ))}
              </div>
            </>
          )}

          <VarianceTable
            rows={rows}
            currency={currency}
            view={view}
            hasBudget={hasBudget}
            hasLastYear={hasLastYear}
          />

          {convertedFrom && (
            <p className="text-[11px] text-ink-soft px-1 italic" data-testid="variance-fx-note">
              Budget converted from {convertedFrom} to {currency} at the current FX rate so the
              comparison is in one currency.
            </p>
          )}

          {isDemo && (
            <p className="text-[11px] text-ink-soft px-1 italic">
              Budget &amp; last-year figures shown are illustrative demo data on the test workspace,
              derived from the actuals — not real plan numbers. Upload your budget to replace them.
            </p>
          )}
        </>
      )}
    </div>
  );
}

export default function Variance() {
  useActivePeriodFallback();
  const period = useActivePeriod();

  // No blocking empty state (removed 2026-07-25): the page always renders
  // its header + budget upload UI. VarianceInner tolerates a null period and
  // gates the actuals-dependent parts (LY picker, variance table) internally.
  return (
    <VarianceInner
      statements={period.statements ?? null}
      periodLabel={period.label}
      lineItems={period.lineItems ?? []}
      metricRows={period.metrics ?? []}
    />
  );
}
