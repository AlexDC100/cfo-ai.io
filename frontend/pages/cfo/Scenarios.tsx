// F6.0.5 (2026-06-20) — Scenario Planning / What-If page.
//
// "If next year's rent drops 20% (or we sell the asset), what happens to my
// leverage and covenants?" This page answers exactly that. It takes the live
// period (reconciled to the dashboard via buildScenarioBaseline), applies the
// user's lever adjustments through the deterministic cascade engine, and
// shows the baseline → scenario delta for every headline metric + ratio,
// plus a covenant compliance read.
//
// Architecture:
//   · buildScenarioBaseline(statements) — calibrated baseline that ties to
//     the dashboard tiles (4.9M / 2.1M / 5.92× for the EEI-style fixture).
//   · applyCascade(baseline, adjustments) — pure what-if recompute.
//   · ScenarioComparison / CovenantPanel — read-only renderers off both
//     states.
// The store (ScenarioProvider) owns only the INPUT (engaged levers).

import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { TrendingDown } from "lucide-react";
import { PageHeader } from "@/components/cfo/ui/PageHeader";
import { useActivePeriod } from "@/lib/activePeriod";
import { useActivePeriodFallback } from "@/hooks/useActivePeriodFallback";
import { ScenarioProvider, useScenario } from "@/stores/scenario";
import { buildScenarioBaseline } from "@/lib/scenarios/baseline";
import { buildDashboardCanonical } from "@/lib/scenarios/dashboardCanon";
import { applyCascade } from "@/lib/scenarios/cascade";
import type { PeriodLineItem, PeriodMetric } from "@/lib/activePeriod";
import { computeMetric, detectCovenantBreaches } from "@/lib/scenarios/covenants";
import { AdjustmentEditor } from "@/components/scenarios/AdjustmentEditor";
import { ScenarioComparison } from "@/components/scenarios/ScenarioComparison";
import { CovenantPanel } from "@/components/scenarios/CovenantPanel";
import type { Statements } from "@/lib/financialReport";

function ImpactSummary({
  leverageBase,
  leverageScen,
  breachCount,
}: {
  leverageBase: number | null;
  leverageScen: number | null;
  breachCount: number;
}) {
  const fmt = (v: number | null) =>
    v === null ? "n/a" : !Number.isFinite(v) ? ">99×" : `${v.toFixed(2)}×`;
  const worsened =
    leverageBase !== null && leverageScen !== null && leverageScen > leverageBase;
  return (
    <div
      data-testid="scenario-impact-summary"
      className="flex flex-wrap items-center gap-x-6 gap-y-2 py-1"
    >
      <div className="flex items-center gap-2">
        <TrendingDown
          className={`w-4 h-4 ${worsened ? "text-rose-500" : "text-ink-mute"}`}
          strokeWidth={1.75}
        />
        <span className="text-[12.5px] text-ink-mute">Net debt / EBITDA</span>
        <span className="text-[14px] font-semibold tabular-nums text-ink">
          {fmt(leverageBase)} <span className="text-ink-mute">→</span>{" "}
          <span className={worsened ? "text-rose-600 dark:text-rose-400" : "text-ink"}>
            {fmt(leverageScen)}
          </span>
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[12.5px] text-ink-mute">Covenants</span>
        {breachCount > 0 ? (
          <span className="text-[13px] font-semibold text-rose-600 dark:text-rose-400">
            {breachCount} breached
          </span>
        ) : (
          <span className="text-[13px] font-semibold text-[hsl(173,57%,42%)] dark:text-[hsl(173,57%,60%)]">
            all holding
          </span>
        )}
      </div>
    </div>
  );
}

function ScenariosInner({
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
  const { adjustments, covenants } = useScenario();
  const currency = statements.currency ?? "RON";

  const baseline = useMemo(
    () =>
      buildScenarioBaseline(
        statements,
        buildDashboardCanonical(statements, lineItems, metricRows),
      ),
    [statements, lineItems, metricRows],
  );
  const scenario = useMemo(
    () => applyCascade(baseline, adjustments),
    [baseline, adjustments],
  );

  const active = adjustments.length > 0;

  const leverageBase = computeMetric(baseline, "net_debt_to_ebitda");
  const leverageScen = computeMetric(scenario, "net_debt_to_ebitda");
  const breachCount = active
    ? detectCovenantBreaches(scenario, covenants).filter(
        (b) => b.severity === "breach",
      ).length
    : 0;

  return (
    <div className="max-w-[1180px] space-y-5">
      {/* Header — dashboard-style hero */}
      <PageHeader
        hero
        eyebrow="Scenario planning"
        title={<>Stress-test your numbers <span className="text-grad">before they happen</span>.</>}
        subtitle={
          <>
            Model a change — rent or revenue drops, costs rise, payments slow — and see
            instantly what it does to EBITDA, leverage, and your bank covenants. Built on{" "}
            <span className="text-ink">{periodLabel ?? "the loaded period"}</span>; your
            actuals are never changed.
          </>
        }
      />

      {active && (
        <ImpactSummary
          leverageBase={leverageBase}
          leverageScen={leverageScen}
          breachCount={breachCount}
        />
      )}

      {/* Two-column workspace: editor (left) + results (right). */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)] gap-5 items-start">
        <div className="lg:sticky lg:top-20">
          <AdjustmentEditor />
        </div>
        <div className="space-y-5">
          <ScenarioComparison
            baseline={baseline}
            scenario={scenario}
            currency={currency}
            active={active}
          />
          <CovenantPanel
            baseline={baseline}
            scenario={scenario}
            covenants={covenants}
            active={active}
          />
          {!active && (
            <p className="text-[12px] text-ink-mute px-1">
              Pick a template or drag a driver to see the scenario column fill
              in. Net debt / EBITDA, current ratio and your covenants update
              live as you move the sliders.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Scenarios() {
  useActivePeriodFallback();
  const period = useActivePeriod();
  const navigate = useNavigate();

  if (!period.statements) {
    return (
      <div className="max-w-[1180px] space-y-8">
        <PageHeader
          hero
          eyebrow="Scenario planning"
          title={<>Stress-test your numbers <span className="text-grad">before they happen</span>.</>}
          subtitle="Model what-if changes on top of a real trial balance — revenue or rent drops, cost shocks, slower collections — and see the impact on EBITDA, leverage and covenants. Upload or open a period to begin; your actuals are never changed."
        />
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => navigate("/dashboard")}
            data-testid="scenarios-empty-dashboard"
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-5 py-2.5 text-[13.5px] font-medium text-[#06302b] hover:bg-brand-dark hover:text-white transition-colors"
          >
            Go to dashboard
          </button>
          <button
            type="button"
            onClick={() => navigate("/dashboard?upload=1")}
            data-testid="scenarios-empty-upload"
            className="inline-flex items-center gap-1.5 rounded-lg border border-rule px-5 py-2.5 text-[13.5px] font-medium text-ink hover:bg-bg-2 transition-colors"
          >
            Upload a trial balance
          </button>
        </div>
        <p className="text-[12px] text-ink-mute">
          Your scenarios are saved on this device and never alter your actuals.
        </p>
      </div>
    );
  }

  return (
    <>
      <ScenarioProvider>
        <ScenariosInner
          statements={period.statements}
          periodLabel={period.label}
          lineItems={period.lineItems ?? []}
          metricRows={period.metrics ?? []}
        />
      </ScenarioProvider>
    </>
  );
}
