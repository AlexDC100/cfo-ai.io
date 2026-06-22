// Benchmarking panel — peer-group medians + range for the headline metrics.
//
// Computed from whatever rows are loaded (live or demo). Each tile shows
// the median + 25th/75th percentiles, and a "leader / laggard" callout
// based on the same dataset. Pure presentational — no API calls.

import { Activity, ArrowDown, ArrowUp, Layers, Percent, Scale, TrendingUp, Wallet } from "lucide-react";
import { DEMO_WATCHLIST, type WatchlistRow } from "@/lib/publicCompanyWatchlist";

interface Props {
  rows?: WatchlistRow[];
}

interface Metric {
  key: keyof Pick<WatchlistRow,
    "revenue_growth_pct" | "ebitda_margin_pct" | "net_debt_to_ebitda" |
    "fcf_yield_pct" | "ev_ebitda" | "dividend_yield_pct">;
  label: string;
  icon: typeof Activity;
  unit: "pct" | "x";
  goodHigh: boolean;       // when true, higher is better; affects leader/laggard
  shortLabel: string;
}

const METRICS: Metric[] = [
  { key: "revenue_growth_pct",  label: "Revenue Growth",   shortLabel: "Growth",   icon: TrendingUp, unit: "pct", goodHigh: true  },
  { key: "ebitda_margin_pct",   label: "EBITDA Margin",    shortLabel: "EBITDA",   icon: Percent,    unit: "pct", goodHigh: true  },
  { key: "net_debt_to_ebitda",  label: "Debt / EBITDA",    shortLabel: "Leverage", icon: Scale,      unit: "x",   goodHigh: false },
  { key: "fcf_yield_pct",       label: "FCF Yield",        shortLabel: "FCF",      icon: Wallet,     unit: "pct", goodHigh: true  },
  { key: "ev_ebitda",           label: "Valuation Multiple", shortLabel: "EV/EBITDA", icon: Layers,  unit: "x",   goodHigh: false },
  { key: "dividend_yield_pct",  label: "Dividend Yield",   shortLabel: "Dividend", icon: Activity,   unit: "pct", goodHigh: true  },
];

export function BenchmarkingPanel({ rows = DEMO_WATCHLIST }: Props) {
  return (
    <section
      data-testid="public-companies-benchmark-panel"
      className="rounded-3xl border border-rule bg-surface p-5 sm:p-7"
    >
      <div className="mb-5">
        <div className="text-[10.5px] uppercase tracking-[0.14em] font-semibold text-ink-mute">
          Step 3 · Compare across the peer group
        </div>
        <h2 className="font-serif text-[22px] text-ink leading-tight tracking-[-0.005em] mt-1">
          Benchmarking
        </h2>
        <p className="text-[12.5px] text-ink-soft mt-1.5 max-w-[560px]">
          Median + 25th/75th percentile across the {rows.length} companies on
          your watchlist. Click a metric tile to drill down.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {METRICS.map((m) => (
          <BenchmarkTile key={m.key} metric={m} rows={rows} />
        ))}
      </div>
    </section>
  );
}

function BenchmarkTile({ metric, rows }: { metric: Metric; rows: WatchlistRow[] }) {
  const values = rows.map((r) => r[metric.key] as number).filter(Number.isFinite);
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const median = quantile(sorted, 0.5);
  const p25 = quantile(sorted, 0.25);
  const p75 = quantile(sorted, 0.75);

  // Leader = the company with the best score in metric.goodHigh direction
  const idxBest = metric.goodHigh
    ? values.indexOf(Math.max(...values))
    : values.indexOf(Math.min(...values));
  const idxWorst = metric.goodHigh
    ? values.indexOf(Math.min(...values))
    : values.indexOf(Math.max(...values));
  const leader = rows[idxBest];
  const laggard = rows[idxWorst];
  const Icon = metric.icon;

  return (
    <div
      data-testid={`public-companies-benchmark-${metric.key}`}
      className="
        rounded-2xl border border-rule bg-bg-2/30
        p-4
        hover:border-brand/30 transition-colors
      "
    >
      <div className="flex items-center justify-between gap-3">
        <div className="
          flex h-9 w-9 items-center justify-center
          rounded-lg bg-bg-2 text-ink-soft
        ">
          <Icon size={15} strokeWidth={1.75} />
        </div>
        <span className="text-[10.5px] uppercase tracking-[0.1em] font-semibold text-ink-mute">
          {metric.shortLabel}
        </span>
      </div>

      <div className="mt-3">
        <div className="text-[11px] text-ink-mute">Median</div>
        <div className="font-serif text-[22px] text-ink leading-tight tabular-nums tracking-[-0.005em]">
          {formatMetric(median, metric.unit)}
        </div>
        <div className="mt-1 text-[10.5px] text-ink-mute tabular-nums">
          P25 {formatMetric(p25, metric.unit)} · P75 {formatMetric(p75, metric.unit)}
        </div>
      </div>

      <div className="mt-3 pt-3 border-t border-rule/60 space-y-1">
        <LeaderRow
          icon={<ArrowUp size={11} className="text-emerald-700 dark:text-emerald-300" />}
          label="Leader"
          ticker={leader.ticker}
          value={formatMetric(values[idxBest], metric.unit)}
        />
        <LeaderRow
          icon={<ArrowDown size={11} className="text-amber-700 dark:text-amber-300" />}
          label="Laggard"
          ticker={laggard.ticker}
          value={formatMetric(values[idxWorst], metric.unit)}
        />
      </div>
    </div>
  );
}

function LeaderRow({
  icon, label, ticker, value,
}: { icon: React.ReactNode; label: string; ticker: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2 text-[11.5px]">
      <span className="inline-flex items-center gap-1 text-ink-mute">
        {icon} {label}
      </span>
      <span className="text-ink tabular-nums">
        <span className="font-mono font-semibold">{ticker}</span>
        <span className="text-ink-mute ml-1.5">{value}</span>
      </span>
    </div>
  );
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

function formatMetric(value: number, unit: "pct" | "x"): string {
  if (!Number.isFinite(value)) return "—";
  return unit === "pct" ? `${value.toFixed(1)}%` : `${value.toFixed(2)}×`;
}
