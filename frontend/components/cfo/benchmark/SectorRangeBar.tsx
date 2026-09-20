// The sector's middle half with the company marked on it.
//
// Every number it draws comes from the printed row's `bar`, which exists
// only on a lawful sourced row (`printSectorRows`): no bar without a
// source, a year and n. The axis is derived from the served p25 / p75 /
// company value alone — no cut-off is typed here.

import type { VsSector } from "@/lib/sectorBenchmark";

export interface SectorRangeBarProps {
  bar: { p25: number; median: number; p75: number; company: number };
  vsSector: VsSector;
  ariaLabel: string;
}

function pct(v: number, lo: number, hi: number): number {
  if (hi <= lo) return 50;
  return Math.min(100, Math.max(0, ((v - lo) / (hi - lo)) * 100));
}

export function SectorRangeBar({ bar, vsSector, ariaLabel }: SectorRangeBarProps) {
  const lo0 = Math.min(bar.p25, bar.company);
  const hi0 = Math.max(bar.p75, bar.company);
  const pad = (hi0 - lo0) * 0.08 || Math.abs(hi0) * 0.08 || 1;
  const lo = lo0 - pad;
  const hi = hi0 + pad;
  const left = pct(bar.p25, lo, hi);
  const right = pct(bar.p75, lo, hi);
  const marker = vsSector === "better" ? "bg-success" : vsSector === "worse" ? "bg-alert" : "bg-ink";
  return (
    <div
      role="img"
      aria-label={ariaLabel}
      data-testid="sector-range-bar"
      className="relative h-3 w-full min-w-[96px] rounded-sm border border-rule bg-bg-2"
    >
      <div
        className="absolute inset-y-0 rounded-[1px] border-x border-brand/40 bg-brand-tint"
        style={{ left: `${left}%`, width: `${Math.max(right - left, 1)}%` }}
      />
      <div className="absolute inset-y-0 w-px bg-ink-soft" style={{ left: `${pct(bar.median, lo, hi)}%` }} />
      <div
        data-testid="sector-range-marker"
        className={`absolute -top-[3px] -bottom-[3px] w-[3px] -translate-x-1/2 rounded-full ${marker}`}
        style={{ left: `${pct(bar.company, lo, hi)}%` }}
      />
    </div>
  );
}
