// F6.0.5 (2026-06-20) — Baseline → Scenario comparison table.
//
// The answer surface: for each headline metric + ratio, show the baseline
// value (the live period, reconciled to the dashboard), the scenario value
// (the cascaded what-if), and the change between them.
//
// Math discipline (locked in computeDeltas.ts):
//   · currency rows  → delta() → relative % (or absolute via toggle)
//   · percentage rows→ deltaRatio() → percentage POINTS (pp)
//   · multiple rows  → absolute change in × units ("+5.28×"). DeltaBadge's
//     pp rendering is WRONG for multiples (5.92×→11.2× is +5.28×, not
//     +528pp), so multiples get a dedicated × badge here.

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
import { DeltaBadge } from "@/components/period/DeltaBadge";
import { Money } from "@/components/ui/Money";
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

function formatStatic(
  value: number | null,
  kind: ScenarioMetricRow["kind"],
): string {
  if (value === null) return "—";
  if (kind === "percentage") return `${(value * 100).toFixed(1)}%`;
  if (kind === "ratio") return Number.isFinite(value) ? `${value.toFixed(2)}×` : ">99×";
  return ""; // currency handled by <Money>
}

function sentimentClasses(s: DeltaSentiment): string {
  if (s === "positive")
    return "bg-[hsl(165,75%,55%)]/10 text-[hsl(165,80%,42%)] dark:text-[hsl(165,70%,60%)]";
  if (s === "negative") return "bg-rose-500/10 text-rose-600 dark:text-rose-400";
  return "bg-white/[0.04] text-ink-mute";
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
  // Guarded ratios (net debt/EBITDA, debt/equity) are lower-is-better; a
  // non-finite scenario (denominator wiped out) is unambiguously worse.
  const sentiment: DeltaSentiment = !bothFinite
    ? "negative"
    : d === 0
      ? "neutral"
      : (d > 0) === higherIsBetter
        ? "positive"
        : "negative";
  const arrow = !bothFinite ? "↑" : d > 0 ? "↑" : d < 0 ? "↓" : "·";
  return (
    <span
      data-testid="delta-badge"
      data-delta-sign={!bothFinite || d > 0 ? "pos" : d < 0 ? "neg" : "zero"}
      className={cn(
        "inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md",
        "text-[10px] font-medium tabular-nums whitespace-nowrap",
        sentimentClasses(sentiment),
      )}
    >
      <span aria-hidden>{arrow}</span>
      <span>
        {!bothFinite ? "off scale" : `${d > 0 ? "+" : d < 0 ? "−" : ""}${Math.abs(d).toFixed(2)}×`}
      </span>
    </span>
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
    return (
      <DeltaBadge delta={d} sentiment={sentimentFor(d, { invert: !row.higherIsBetter })} />
    );
  }
  // currency
  const d = deltaAbs(scen, base);
  return (
    <DeltaBadge delta={d} sentiment={sentimentFor(d, { invert: !row.higherIsBetter })} />
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
  const cls = cn(
    "tabular-nums",
    emphasis ? "text-ink font-semibold" : "text-ink-soft",
  );
  if (value === null) return <span className="text-ink-mute">—</span>;
  if (kind === "currency") {
    return (
      <span className={cls}>
        <Money value={value} fromCurrency={currency as Currency} compact />
      </span>
    );
  }
  return <span className={cls}>{formatStatic(value, kind)}</span>;
}

export function ScenarioComparison({ baseline, scenario, currency, active }: Props) {
  return (
    <div
      data-testid="scenario-comparison"
      className="rounded-xl border border-rule bg-surface overflow-hidden"
    >
      {/* Header row */}
      <div className="grid grid-cols-[1.4fr_1fr_1fr_auto] gap-2 px-4 py-2.5 border-b border-rule bg-bg-2/40">
        <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-semibold">
          Metric
        </div>
        <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-semibold text-right">
          Baseline
        </div>
        <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-semibold text-right">
          Scenario
        </div>
        <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-semibold text-right min-w-[68px]">
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
              <div className="px-4 pt-3 pb-1 text-[10px] uppercase tracking-[0.14em] text-ink-mute/80 font-semibold border-t border-rule">
                Ratios &amp; leverage
              </div>
            )}
            <div
              data-testid={`scenario-row-${row.conceptKey}`}
              className="grid grid-cols-[1.4fr_1fr_1fr_auto] gap-2 items-center px-4 py-2.5 border-b border-rule/60 last:border-b-0"
            >
              <div className="text-[12.5px] text-ink truncate">{row.label}</div>
              <div className="text-right text-[13px]">
                <ValueCell value={base} kind={row.kind} currency={currency} />
              </div>
              <div className="text-right text-[13px]">
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
    </div>
  );
}
