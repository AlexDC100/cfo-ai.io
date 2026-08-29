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
import { Lock, MoveRight, Sparkles } from "lucide-react";
// Two header systems on purpose: the serif hero survives ONLY on the
// no-period empty state; the loaded surface uses the compact instrument
// PageHeader (A3 hero eviction).
import { PageHeader } from "@/components/cfo/ui/PageHeader";
import { PageHeader as InstrumentPageHeader, Chip } from "@/components/instrument/Panel";
import { CappedMultiple } from "@/components/comparison/MoneyAmount";
import { openAskCfoAi } from "@/components/cfo/chat/openAskCfoAi";
import { useActivePeriod } from "@/lib/activePeriod";
import { useActivePeriodFallback } from "@/hooks/useActivePeriodFallback";
import { ScenarioProvider, useScenario } from "@/stores/scenario";
import { buildScenarioBaseline } from "@/lib/scenarios/baseline";
import { buildDashboardCanonical } from "@/lib/scenarios/dashboardCanon";
import { applyCascade } from "@/lib/scenarios/cascade";
import type { PeriodLineItem, PeriodMetric } from "@/lib/activePeriod";
import { computeMetric, detectCovenantBreaches } from "@/lib/scenarios/covenants";
import { AdjustmentEditor } from "@/components/scenarios/AdjustmentEditor";
import { ScenarioTemplateCards } from "@/components/scenarios/ScenarioTemplateCards";
import { ScenarioComparison } from "@/components/scenarios/ScenarioComparison";
import { CovenantPanel } from "@/components/scenarios/CovenantPanel";
import type { Statements } from "@/lib/financialReport";

// Before → after strip: baseline value, a quiet arrow, the scenario value
// carrying the semantic color. A non-finite scenario leverage renders as
// the ≥99× bound (never ">99×" / "Infinity×").
function ImpactSummary({
  leverageBase,
  leverageScen,
  breachCount,
}: {
  leverageBase: number | null;
  leverageScen: number | null;
  breachCount: number;
}) {
  const worsened =
    leverageBase !== null &&
    leverageScen !== null &&
    (!Number.isFinite(leverageScen) || leverageScen > leverageBase);
  return (
    <div
      data-testid="scenario-impact-summary"
      className="flex flex-wrap items-center gap-x-5 gap-y-2 py-1"
    >
      <div className="flex items-center gap-2">
        <span className="text-[12px] text-ink-soft">Net debt / EBITDA</span>
        <span className="text-[13px] font-semibold text-ink inline-flex items-center gap-1.5">
          <CappedMultiple value={leverageBase} className="text-ink-soft" />
          <MoveRight size={13} strokeWidth={1.75} className="text-ink-soft" aria-hidden />
          <CappedMultiple
            value={leverageScen}
            className={worsened ? "text-alert" : "text-ink"}
          />
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[12px] text-ink-soft">Covenants</span>
        {breachCount > 0 ? (
          <Chip tone="alert" dot>
            {breachCount} breached
          </Chip>
        ) : (
          <Chip tone="success" dot>
            all holding
          </Chip>
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
    <div className="max-w-[1560px] space-y-5">
      {/* Header — compact instrument header (A3 hero eviction). The old
          hero's promise survives in the context line; the "actuals are
          never changed" guarantee becomes the locked-source chip. */}
      <InstrumentPageHeader
        eyebrow="Analysis"
        title="Scenario planning"
        context={
          <>
            <span>
              What-if on <span className="text-ink">{periodLabel ?? "the loaded period"}</span> —
              EBITDA, leverage and covenants react live.
            </span>
            {/* nowrap: at 390px the pill must drop below the sentence as
                one piece, never wrap into a three-line lozenge. */}
            <Chip tone="neutral" className="whitespace-nowrap">
              <Lock size={11} strokeWidth={2} aria-hidden />
              Actuals never change
            </Chip>
          </>
        }
      />

      {/* Templates — full-width, above the drivers + results grid (2026-07-26
          per operator), styled like the Ask CFO AI prompt cards. The live
          impact summary (Net debt/EBITDA + covenants) sits to the right of the
          "Start from a template" label when a scenario is active. */}
      <ScenarioTemplateCards
        headerRight={
          active ? (
            <ImpactSummary
              leverageBase={leverageBase}
              leverageScen={leverageScen}
              breachCount={breachCount}
            />
          ) : undefined
        }
      />

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
            <p className="text-[12px] text-ink-soft px-1">
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
      <div className="max-w-[1560px] space-y-8">
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
            className="inline-flex items-center gap-1.5 rounded-lg ask-ai-anim-fill [animation-duration:10s] border border-brand/40 px-5 py-2.5 text-[13.5px] font-medium text-ink hover:border-brand/60 transition-colors"
          >
            Go to dashboard
          </button>
          <button
            type="button"
            onClick={() =>
              openAskCfoAi(
                "What can scenario planning do for me once my trial balance is uploaded? Walk me through the what-if levers and what they change.",
              )
            }
            data-testid="scenarios-empty-ask-cfo-ai"
            className="inline-flex items-center gap-2 h-10 px-4 rounded-lg border border-rule bg-surface/70 backdrop-blur text-[13px] font-medium text-ink hover:bg-bg-2/60 hover:border-rule-strong transition-colors"
          >
            <Sparkles size={16} strokeWidth={2} className="text-brand-d" />
            Ask CFO AI
          </button>
        </div>
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
