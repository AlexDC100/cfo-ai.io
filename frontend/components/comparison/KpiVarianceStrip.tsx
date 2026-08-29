// F6.0.1b (2026-06-21) — Headline KPI variance cards (Revenue / EBITDA /
// Net profit), each showing Actual + Δ vs Budget + Δ vs Last Year.
//
// Instrument pass (2026-08): the three actuals share ONE AmountGroup so
// the row reads on a single scale; deltas render through <Amount>
// (money + percent), colored only by the favorable/unfavorable verdict.

import { Amount } from "@/components/instrument/Amount";
import { Panel } from "@/components/instrument/Panel";
import {
  MoneyAmount,
  MoneyAmountGroup,
  useDisplayMoney,
} from "@/components/comparison/MoneyAmount";
import type { Currency } from "@/lib/rates";
import type { Delta, DeltaSentiment } from "@/lib/learning/computeDeltas";
import type { VarianceRow } from "@/lib/comparison/buildVariance";
import { VARIANCE_KPI_KEYS } from "@/lib/comparison/types";
import { cn } from "@/lib/utils";

function sentimentText(s: DeltaSentiment | null): string {
  // Favorable / unfavorable IS the semantic verdict of this surface —
  // success green and alert red are earned here, not decoration.
  if (s === "positive") return "text-success";
  if (s === "negative") return "text-alert";
  return "text-ink-mute";
}

function DeltaLine({
  label,
  d,
  sentiment,
  currency,
}: {
  label: string;
  d: Delta | null;
  sentiment: DeltaSentiment | null;
  currency: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[11px] text-ink-mute">{label}</span>
      {d ? (
        <span className={cn("text-[12px] font-medium", sentimentText(sentiment))}>
          <MoneyAmount
            value={d.absolute}
            fromCurrency={currency as Currency}
            unit={false}
            signed
          />
          {d.pct !== null && (
            <span className="ml-1.5 opacity-80">
              <Amount kind="percent" value={d.pct} />
            </span>
          )}
        </span>
      ) : (
        <span className="text-ink-mute text-[12px]">—</span>
      )}
    </div>
  );
}

export function KpiVarianceStrip({
  rows,
  currency,
}: {
  rows: VarianceRow[];
  currency: string;
}) {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const kpis = VARIANCE_KPI_KEYS.map((k) => byKey.get(k)).filter(
    (r): r is VarianceRow => !!r,
  );
  const { display } = useDisplayMoney();
  // One scale for the whole strip — actuals AND their deltas, so a small
  // delta beside a large actual can't render in a different magnitude.
  const groupValues = kpis.flatMap((r) => [
    r.actual,
    r.vsBudget?.absolute ?? null,
    r.vsLastYear?.absolute ?? null,
  ]);
  return (
    <MoneyAmountGroup values={groupValues} fromCurrency={currency as Currency}>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3" data-testid="kpi-variance-strip">
        {kpis.map((r) => (
          <Panel key={r.key} data-testid={`kpi-variance-${r.key}`} className="px-4 py-3">
            <div className="flex items-baseline justify-between gap-2">
              <div className="text-[11px] uppercase tracking-[0.1em] text-ink-mute font-medium">
                {r.label}
              </div>
              <span className="font-mono text-[10.5px] text-ink-mute">{display}</span>
            </div>
            <div className="mt-1.5 text-[22px] font-semibold leading-none text-ink">
              <MoneyAmount
                value={r.actual}
                fromCurrency={currency as Currency}
                unit={false}
              />
            </div>
            <div className="mt-2.5 space-y-1 border-t border-rule-soft pt-2">
              <DeltaLine label="vs Budget" d={r.vsBudget} sentiment={r.vsBudgetSentiment} currency={currency} />
              <DeltaLine label="vs Last year" d={r.vsLastYear} sentiment={r.vsLastYearSentiment} currency={currency} />
            </div>
          </Panel>
        ))}
      </div>
    </MoneyAmountGroup>
  );
}
