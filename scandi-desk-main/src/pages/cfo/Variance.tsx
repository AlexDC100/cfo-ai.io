// F6.0.1b (2026-06-21) — Budget vs Actual vs Last-Year variance page.
//
// The management variance report from the Scandia decks: for the loaded
// period, show each P&L line's Actual / Budget / Last Year + Δ-vs-Budget +
// Δ-vs-LY. Actuals reconcile to the dashboard tiles; budget + last-year come
// from an uploaded file (or a clearly-labeled demo on the test workspace).

import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Scale } from "lucide-react";
import { AppShell } from "@/components/cfo/AppShell";
import { EmptyState } from "@/components/cfo/ui/EmptyState";
import { useActivePeriod } from "@/lib/activePeriod";
import { useActivePeriodFallback } from "@/hooks/useActivePeriodFallback";
import { isPublicTestMode } from "@/lib/testMode";
import { buildReportingMetricsSnapshot } from "@/lib/learning/buildReportingMetrics";
import { buildDashboardCanonical } from "@/lib/scenarios/dashboardCanon";
import { buildActualLines, buildVarianceRows } from "@/lib/comparison/buildVariance";
import { buildDemoComparison } from "@/lib/comparison/demoSeed";
import { useBudgetComparison } from "@/stores/budget";
import { KpiVarianceStrip } from "@/components/comparison/KpiVarianceStrip";
import { VarianceTable, type VarianceView } from "@/components/comparison/VarianceTable";
import { BudgetUploadCard } from "@/components/comparison/BudgetUploadCard";
import type { Statements } from "@/lib/financialReport";
import type { PeriodLineItem, PeriodMetric } from "@/lib/activePeriod";
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
  statements: Statements;
  periodLabel: string | null;
  lineItems: PeriodLineItem[];
  metricRows: PeriodMetric[];
}) {
  const currency = statements.currency ?? "RON";
  const [view, setView] = useState<VarianceView>("both");
  const { uploaded, save, clear } = useBudgetComparison();

  const actualLines = useMemo(() => {
    const snap = buildReportingMetricsSnapshot(statements);
    const canon = buildDashboardCanonical(statements, lineItems, metricRows);
    return buildActualLines(snap, canon);
  }, [statements, lineItems, metricRows]);

  // Effective comparison: an upload always wins; otherwise the test workspace
  // shows a labeled demo; a real workspace with no upload shows none.
  const dataset = useMemo(() => {
    if (uploaded) return uploaded;
    if (isPublicTestMode) return buildDemoComparison(actualLines);
    return null;
  }, [uploaded, actualLines]);

  const isDemo = !uploaded && dataset?.source === "demo";
  const rows = useMemo(() => buildVarianceRows(actualLines, dataset), [actualLines, dataset]);
  const hasBudget = !!dataset && Object.keys(dataset.budget).length > 0;
  const hasLastYear = !!dataset && Object.keys(dataset.lastYear).length > 0;

  return (
    <div className="max-w-[1180px] mx-auto px-4 sm:px-6 py-6 space-y-5">
      <div>
        <div className="text-[10.5px] uppercase tracking-[0.18em] text-ink-mute font-semibold">
          Management reporting
        </div>
        <h1 className="text-[26px] sm:text-[30px] leading-tight font-semibold tracking-[-0.01em] text-ink mt-0.5">
          Budget vs Actual vs Last year
        </h1>
        <p className="text-[13px] text-ink-soft mt-1.5 max-w-[680px]">
          Every P&amp;L line of{" "}
          <span className="text-ink">{periodLabel ?? "the loaded period"}</span> against your
          budget and last year, with favorable / unfavorable variances — the board-pack view.
        </p>
      </div>

      <BudgetUploadCard uploaded={uploaded} isDemo={!!isDemo} onSave={save} onClear={clear} />

      {(hasBudget || hasLastYear) && (
        <>
          <KpiVarianceStrip rows={rows} currency={currency} />

          {/* View toggle */}
          <div className="flex items-center gap-1 rounded-lg border border-rule bg-surface p-1 w-fit" data-testid="variance-view-toggle">
            {VIEWS.map((v) => (
              <button
                key={v.key}
                type="button"
                onClick={() => setView(v.key)}
                data-testid={`variance-view-${v.key}`}
                className={cn(
                  "px-3 min-h-[34px] rounded-md text-[12px] font-medium transition-colors",
                  view === v.key
                    ? "bg-brand/12 text-brand-d"
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

      {!hasBudget && !hasLastYear && (
        <p className="text-[12px] text-ink-mute px-1">
          Showing Actuals only. Upload a budget above to see the variance columns fill in.
        </p>
      )}

      {isDemo && (
        <p className="text-[11px] text-ink-mute px-1 italic">
          Budget &amp; last-year figures shown are illustrative demo data on the test workspace,
          derived from the actuals — not real plan numbers. Upload your budget to replace them.
        </p>
      )}
    </div>
  );
}

export default function Variance() {
  useActivePeriodFallback();
  const period = useActivePeriod();
  const navigate = useNavigate();

  if (!period.statements) {
    return (
      <AppShell>
        <div className="max-w-[1180px] mx-auto px-4 sm:px-6 py-10">
          <EmptyState
            icon={Scale}
            title="Load a period to compare against budget"
            subtitle="The Budget vs Actual vs Last-Year report needs a period of actuals. Upload or open a period, then add your budget file to see every P&L line's variance."
            primary={{
              label: "Go to dashboard",
              onClick: () => navigate("/dashboard"),
              testid: "variance-empty-dashboard",
            }}
            secondary={{
              label: "Upload a trial balance",
              onClick: () => navigate("/dashboard?upload=1"),
              testid: "variance-empty-upload",
            }}
            footnote="Budget data is saved on this device and never alters your actuals."
          />
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <VarianceInner
        statements={period.statements}
        periodLabel={period.label}
        lineItems={period.lineItems ?? []}
        metricRows={period.metrics ?? []}
      />
    </AppShell>
  );
}
