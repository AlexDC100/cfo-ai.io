// F6.0.1b (2026-06-21) — Headline KPI variance cards (Revenue / EBITDA /
// Net profit), each showing Actual + Δ vs Budget + Δ vs Last Year.

import { Money } from "@/components/ui/Money";
import type { Currency } from "@/lib/rates";
import type { Delta, DeltaSentiment } from "@/lib/learning/computeDeltas";
import type { VarianceRow } from "@/lib/comparison/buildVariance";
import { VARIANCE_KPI_KEYS } from "@/lib/comparison/types";
import { cn } from "@/lib/utils";

function sentimentText(s: DeltaSentiment | null): string {
  if (s === "positive") return "text-[hsl(165,80%,42%)] dark:text-[hsl(165,70%,60%)]";
  if (s === "negative") return "text-rose-600 dark:text-rose-400";
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
        <span className={cn("tabular-nums text-[12px] font-medium", sentimentText(sentiment))}>
          <Money value={d.absolute} fromCurrency={currency as Currency} compact signed />
          {d.pct !== null && (
            <span className="ml-1 opacity-80">
              ({d.pct > 0 ? "+" : ""}
              {(d.pct * 100).toFixed(1)}%)
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
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3" data-testid="kpi-variance-strip">
      {VARIANCE_KPI_KEYS.map((k) => {
        const r = byKey.get(k);
        if (!r) return null;
        return (
          <div
            key={k}
            data-testid={`kpi-variance-${k}`}
            className="rounded-xl border border-rule bg-surface px-4 py-3"
          >
            <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium">
              {r.label}
            </div>
            <div className="mt-1 num-hero num-hero-fluid text-ink leading-none">
              {r.actual === null ? (
                <span className="text-ink-mute">—</span>
              ) : (
                <Money value={r.actual} fromCurrency={currency as Currency} compact />
              )}
            </div>
            <div className="mt-2 space-y-1 border-t border-rule/60 pt-2">
              <DeltaLine label="vs Budget" d={r.vsBudget} sentiment={r.vsBudgetSentiment} currency={currency} />
              <DeltaLine label="vs Last year" d={r.vsLastYear} sentiment={r.vsLastYearSentiment} currency={currency} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
