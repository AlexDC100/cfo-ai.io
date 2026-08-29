// F6.0.5 (2026-06-20) — Baseline → Scenario comparison table.
//
// The answer surface: for each headline metric + ratio, show the baseline
// value (the live period, reconciled to the dashboard), the scenario value
// (the cascaded what-if), and the change between them.
//
// Math discipline (locked in computeDeltas.ts):
//   · currency rows  → delta() → relative % (rendered through <Amount
//     kind="percent">, so a near-zero base explodes into a signed
//     multiplier — "−108×" — instead of "↓10834.3%")
//   · percentage rows→ deltaRatio() → percentage POINTS (pp)
//   · multiple rows  → absolute change in × units ("+5.28×"); pp would be
//     wrong (5.92×→11.2× is +5.28×, not +528pp)
//
// Instrument pass (2026-08): Panel + hairline 32px rows, one AmountGroup
// across both value columns, semantic color only on the change badge.

import { resolveConceptValue } from "@/lib/dashboard/resolveConceptValue";
import { computeMetric, type CovenantMetricKey } from "@/lib/scenarios/covenants";
import {
  SCENARIO_METRIC_ROWS,
  type ScenarioMetricRow,
} from "@/lib/scenarios/baseline";

// Ratios whose denominator (EBITDA, equity) can go non-positive under a
// shock and flip the sign — route these through the GUARDED computeMetric
// (which returns +Infinity worst-case) instead of resolveConceptValue's raw
// division, so a wiped-out EBITDA reads as "off the scale" not "improved".
const GUARDED_RATIO: Record<string, CovenantMetricKey> = {
  net_debt_ebitda: "net_debt_to_ebitda",
  debt_to_equity: "debt_to_equity",
};

function resolveRowValue(
  conceptKey: string,
  state: ReportingMetrics,
): number | null {
  const guarded = GUARDED_RATIO[conceptKey];
  if (guarded) return computeMetric(state, guarded);
  return resolveConceptValue(conceptKey, state).value;
}
import {
  delta as deltaAbs,
  deltaRatio,
  sentimentFor,
  type DeltaSentiment,
} from "@/lib/learning/computeDeltas";
import type { ReactNode } from "react";
import { Amount } from "@/components/instrument/Amount";
import { Panel } from "@/components/instrument/Panel";
import {
  CappedMultiple,
  MoneyAmount,
  MoneyAmountGroup,
  PercentLevel,
  PpDelta,
  useDisplayMoney,
} from "@/components/comparison/MoneyAmount";
import type { Currency } from "@/lib/rates";
import type { ReportingMetrics } from "@/lib/learning/concepts/_schema";
import { cn } from "@/lib/utils";

interface Props {
  baseline: ReportingMetrics;
  scenario: ReportingMetrics;
  currency: string;
  /** True when the user has engaged at least one lever — drives whether the
   *  scenario column + delta render at all (no point showing a delta of 0). */
  active: boolean;
}

function sentimentClasses(s: DeltaSentiment): string {
  if (s === "positive") return "bg-success-tint text-success";
  if (s === "negative") return "bg-alert-tint text-alert";
  return "bg-bg-2 text-ink-mute";
}

function BadgeShell({
  sentiment,
  sign,
  children,
}: {
  sentiment: DeltaSentiment;
  sign: "pos" | "neg" | "zero";
  children: ReactNode;
}) {
  return (
    <span
      data-testid="delta-badge"
      data-delta-sign={sign}
      className={cn(
        "inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full",
        "text-[10.5px] font-medium whitespace-nowrap",
        sentimentClasses(sentiment),
      )}
    >
      {children}
    </span>
  );
}

/** Dedicated × badge for multiples (net debt / EBITDA, current ratio). */
function MultipleDeltaBadge({
  base,
  scen,
  higherIsBetter,
}: {
  base: number | null;
  scen: number | null;
  higherIsBetter: boolean;
}) {
  if (base === null || scen === null) return <span className="text-ink-mute text-[10px]">—</span>;
  // Non-finite scenario (EBITDA/equity wiped out → +Infinity worst-case):
  // the direction is unambiguously "worse" for a lower-is-better ratio.
  const bothFinite = Number.isFinite(base) && Number.isFinite(scen);
  const d = scen - base;
  const sentiment: DeltaSentiment = !bothFinite
    ? "negative"
    : d === 0
      ? "neutral"
      : (d > 0) === higherIsBetter
        ? "positive"
        : "negative";
  return (
    <BadgeShell
      sentiment={sentiment}
      sign={!bothFinite || d > 0 ? "pos" : d < 0 ? "neg" : "zero"}
    >
      {!bothFinite ? (
        <span className="font-mono">off scale</span>
      ) : (
        <span className="font-mono tabular-nums">
          <Amount kind="count" value={d} fractionDigits={2} signed />×
        </span>
      )}
    </BadgeShell>
  );
}

function RowDelta({
  row,
  base,
  scen,
}: {
  row: ScenarioMetricRow;
  base: number | null;
  scen: number | null;
}) {
  if (base === null || scen === null)
    return <span className="text-ink-mute text-[10px]">—</span>;

  if (row.kind === "ratio") {
    return (
      <MultipleDeltaBadge base={base} scen={scen} higherIsBetter={row.higherIsBetter} />
    );
  }
  if (row.kind === "percentage") {
    const d = deltaRatio(scen, base);
    const s = sentimentFor(d, { invert: !row.higherIsBetter });
    return (
      <BadgeShell sentiment={s} sign={d.absolute > 0 ? "pos" : d.absolute < 0 ? "neg" : "zero"}>
        <PpDelta value={d.absolute} />
      </BadgeShell>
    );
  }
  // currency — relative % through the percent-sanity gate.
  const d = deltaAbs(scen, base);
  const s = sentimentFor(d, { invert: !row.higherIsBetter });
  return (
    <BadgeShell sentiment={s} sign={d.absolute > 0 ? "pos" : d.absolute < 0 ? "neg" : "zero"}>
      <Amount kind="percent" value={d.pct} />
    </BadgeShell>
  );
}

function ValueCell({
  value,
  kind,
  currency,
  emphasis,
}: {
  value: number | null;
  kind: ScenarioMetricRow["kind"];
  currency: string;
  emphasis?: boolean;
}) {
  const cls = emphasis ? "text-ink font-semibold" : "text-ink-soft";
  if (value === null) return <span className="text-ink-mute">—</span>;
  if (kind === "currency") {
    return (
      <MoneyAmount value={value} fromCurrency={currency as Currency} unit={false} className={cls} />
    );
  }
  if (kind === "percentage") {
    return <PercentLevel value={value * 100} className={cls} />;
  }
  return <CappedMultiple value={value} className={cls} />;
}

export function ScenarioComparison({ baseline, scenario, currency, active }: Props) {
  const { display } = useDisplayMoney();
  // One scale for BOTH columns of every currency row, so baseline and
  // scenario can never render in different magnitudes.
  const groupValues = SCENARIO_METRIC_ROWS.flatMap((row) => {
    if (row.kind !== "currency") return [];
    return [resolveRowValue(row.conceptKey, baseline), resolveRowValue(row.conceptKey, scenario)];
  });
  return (
    <Panel data-testid="scenario-comparison" className="overflow-hidden">
      <MoneyAmountGroup values={groupValues} fromCurrency={currency as Currency}>
        {/* Header row */}
        <div className="grid grid-cols-[1.4fr_1fr_1fr_auto] gap-2 items-center px-4 h-8 border-b border-rule bg-surface sticky top-14 z-10">
          <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium">
            Metric · {display}
          </div>
          <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium text-right">
            Baseline
          </div>
          <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium text-right">
            Scenario
          </div>
          <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium text-right min-w-[68px]">
            Change
          </div>
        </div>

        {SCENARIO_METRIC_ROWS.map((row) => {
          const base = resolveRowValue(row.conceptKey, baseline);
          const scen = resolveRowValue(row.conceptKey, scenario);
          const isRatiosGroup = row.groupStart === "ratios";
          return (
            <div key={row.conceptKey}>
              {isRatiosGroup && (
                <div className="px-4 pt-2.5 pb-1 text-[10px] uppercase tracking-[0.14em] text-ink-mute font-medium border-t border-rule">
                  Ratios &amp; leverage
                </div>
              )}
              <div
                data-testid={`scenario-row-${row.conceptKey}`}
                className="grid grid-cols-[1.4fr_1fr_1fr_auto] gap-2 items-center px-4 min-h-8 py-1 border-b border-rule-soft last:border-b-0"
              >
                <div className="text-[12.5px] text-ink truncate">{row.label}</div>
                <div className="text-right text-[12.5px]">
                  <ValueCell value={base} kind={row.kind} currency={currency} />
                </div>
                <div className="text-right text-[12.5px]">
                  {active ? (
                    <ValueCell value={scen} kind={row.kind} currency={currency} emphasis />
                  ) : (
                    <span className="text-ink-mute text-[12px]">—</span>
                  )}
                </div>
                <div className="text-right min-w-[68px]">
                  {active ? <RowDelta row={row} base={base} scen={scen} /> : null}
                </div>
              </div>
            </div>
          );
        })}
      </MoneyAmountGroup>
    </Panel>
  );
}
