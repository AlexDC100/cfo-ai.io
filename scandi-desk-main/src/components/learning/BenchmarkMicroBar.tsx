// F5.0 Phase 1 — Benchmark micro-bar.
//
// Compact P25-Median-P75 band with the user's value as a vertical marker
// pin. Fits inside the 320px QuickExplain popover. Read in under a second.
//
// Visual idiom: soft brand-tinted band for the P25-P75 zone, a darker
// median tick, the user's value as a bold contrasting marker. No
// gridlines, no axis labels beyond P25/Median/P75 — the goal is "where
// am I" answered at a glance, not a full chart.

import { cn } from "@/lib/utils";
import type { ConceptBenchmark } from "@/lib/learning/concepts";

interface BenchmarkMicroBarProps {
  value: number;
  benchmark: ConceptBenchmark;
  className?: string;
}

export function BenchmarkMicroBar({
  value,
  benchmark,
  className,
}: BenchmarkMicroBarProps) {
  // Anchor the displayed band at [p25 − 1×range, p75 + 1×range] so the
  // marker has visual room when the user's value falls well outside the
  // P25-P75 zone. Values further out get clamped to the edges rather
  // than overflowing the bar.
  const range = benchmark.p75 - benchmark.p25;
  // Defensive: if range is degenerate (median == p25 == p75), fall back
  // to a band of ±20% around the median.
  const lo = range > 0 ? benchmark.p25 - range : benchmark.median * 0.8;
  const hi = range > 0 ? benchmark.p75 + range : benchmark.median * 1.2;
  const span = hi - lo;
  const clamp = (n: number) =>
    span > 0 ? Math.max(0, Math.min(100, ((n - lo) / span) * 100)) : 50;

  const markerPct = clamp(value);
  const p25Pct = clamp(benchmark.p25);
  const medianPct = clamp(benchmark.median);
  const p75Pct = clamp(benchmark.p75);

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-center justify-between text-[10px] text-ink-mute uppercase tracking-wider">
        <span>vs. peers</span>
        <span className="text-ink-soft normal-case tracking-normal truncate ml-2">
          {benchmark.source}
        </span>
      </div>
      <div className="relative h-2 rounded-full bg-bg-2 overflow-visible">
        {/* P25-P75 band */}
        <div
          className="absolute top-0 bottom-0 bg-brand/15 rounded-full"
          style={{
            left: `${p25Pct}%`,
            width: `${Math.max(0, p75Pct - p25Pct)}%`,
          }}
          aria-hidden
        />
        {/* Median tick */}
        <div
          className="absolute top-[-2px] bottom-[-2px] w-0.5 bg-brand/60 rounded-full"
          style={{ left: `${medianPct}%` }}
          aria-hidden
        />
        {/* User value marker */}
        <div
          className="absolute top-[-3px] bottom-[-3px] w-1 bg-ink rounded-full ring-2 ring-surface"
          style={{ left: `calc(${markerPct}% - 2px)` }}
          aria-label={`Your value at the ${markerPct.toFixed(0)}th percentile of the displayed range`}
        />
      </div>
      <div className="flex items-center justify-between text-[10px] text-ink-mute tabular-nums">
        <span>P25</span>
        <span className="text-ink-soft font-medium">Median</span>
        <span>P75</span>
      </div>
    </div>
  );
}
