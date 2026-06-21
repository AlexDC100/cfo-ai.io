// F6.0.1b (2026-06-21) — P&L variance table (Actual / Budget / Last Year).
//
// Modeled on the Scandia management pack: each P&L line shows Actual, Budget,
// Last Year, and the Δ vs each (absolute in the company currency + %). Δ is
// colored favorable (green) / unfavorable (red) using the line's
// higher-is-better convention (revenue/profit up = good; costs up = bad).

import { Money } from "@/components/ui/Money";
import type { Currency } from "@/lib/rates";
import type { Delta, DeltaSentiment } from "@/lib/learning/computeDeltas";
import type { VarianceRow } from "@/lib/comparison/buildVariance";
import { cn } from "@/lib/utils";

export type VarianceView = "both" | "budget" | "last_year";

interface Props {
  rows: VarianceRow[];
  currency: string;
  view: VarianceView;
  hasBudget: boolean;
  hasLastYear: boolean;
}

function sentimentText(s: DeltaSentiment | null): string {
  if (s === "positive") return "text-[hsl(165,80%,42%)] dark:text-[hsl(165,70%,60%)]";
  if (s === "negative") return "text-rose-600 dark:text-rose-400";
  return "text-ink-mute";
}

function DeltaCell({
  d,
  sentiment,
  currency,
}: {
  d: Delta | null;
  sentiment: DeltaSentiment | null;
  currency: string;
}) {
  if (!d) return <span className="text-ink-mute">—</span>;
  return (
    <span className={cn("inline-flex flex-col items-end leading-tight", sentimentText(sentiment))}>
      <span className="tabular-nums text-[12.5px] font-medium">
        <Money value={d.absolute} fromCurrency={currency as Currency} compact signed />
      </span>
      {d.pct !== null && (
        <span className="tabular-nums text-[10.5px] opacity-80">
          {d.pct > 0 ? "+" : ""}
          {(d.pct * 100).toFixed(1)}%
        </span>
      )}
    </span>
  );
}

function Val({ v, currency, emphasis }: { v: number | null; currency: string; emphasis?: boolean }) {
  if (v === null) return <span className="text-ink-mute">—</span>;
  return (
    <span className={cn("tabular-nums", emphasis ? "font-semibold text-ink" : "text-ink-soft")}>
      <Money value={v} fromCurrency={currency as Currency} compact />
    </span>
  );
}

export function VarianceTable({ rows, currency, view, hasBudget, hasLastYear }: Props) {
  const showBudget = view !== "last_year" && hasBudget;
  const showLastYear = view !== "budget" && hasLastYear;

  // Column template: Line | Actual | [Budget] | [Δ vs Bud] | [LY] | [Δ vs LY]
  const cols: string[] = ["minmax(150px,1.6fr)", "minmax(78px,1fr)"];
  if (showBudget) cols.push("minmax(78px,1fr)", "minmax(86px,1fr)");
  if (showLastYear) cols.push("minmax(78px,1fr)", "minmax(86px,1fr)");
  const gridTemplate = cols.join(" ");

  const Header = () => (
    <div
      className="grid gap-2 px-4 py-2.5 border-b border-rule bg-bg-2/40 text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-semibold"
      style={{ gridTemplateColumns: gridTemplate }}
    >
      <div>P&amp;L line</div>
      <div className="text-right">Actual</div>
      {showBudget && <div className="text-right">Budget</div>}
      {showBudget && <div className="text-right">Δ vs Bud</div>}
      {showLastYear && <div className="text-right">Last year</div>}
      {showLastYear && <div className="text-right">Δ vs LY</div>}
    </div>
  );

  return (
    <div
      data-testid="variance-table"
      className="rounded-xl border border-rule bg-surface overflow-x-auto"
    >
      <div className="min-w-[520px]">
        <Header />
        {rows.map((r) => (
          <div
            key={r.key}
            data-testid={`variance-row-${r.key}`}
            className={cn(
              "grid gap-2 items-center px-4 py-2.5 border-b border-rule/60 last:border-b-0",
              r.emphasis && "bg-bg-2/30",
            )}
            style={{ gridTemplateColumns: gridTemplate }}
          >
            <div className={cn("text-[12.5px] truncate", r.emphasis ? "font-semibold text-ink" : "text-ink")}>
              {r.label}
            </div>
            <div className="text-right text-[13px]">
              <Val v={r.actual} currency={currency} emphasis={r.emphasis} />
            </div>
            {showBudget && (
              <div className="text-right text-[13px]">
                <Val v={r.budget} currency={currency} />
              </div>
            )}
            {showBudget && (
              <div className="text-right">
                <DeltaCell d={r.vsBudget} sentiment={r.vsBudgetSentiment} currency={currency} />
              </div>
            )}
            {showLastYear && (
              <div className="text-right text-[13px]">
                <Val v={r.lastYear} currency={currency} />
              </div>
            )}
            {showLastYear && (
              <div className="text-right">
                <DeltaCell d={r.vsLastYear} sentiment={r.vsLastYearSentiment} currency={currency} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
