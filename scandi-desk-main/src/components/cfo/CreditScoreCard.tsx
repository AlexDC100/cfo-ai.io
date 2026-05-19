// Credit Score Card — surfaces the deterministic Altman Z″ + composite
// 0-100 score + letter grade computed server-side in `stage_compute`
// (see src/engine/api/pipeline.py — Stage 2 of the build plan).
//
// This card is the single trust signal on the Dashboard / Report header
// that says "we ran the numbers, here's the grade." It DOES NOT do its
// own arithmetic — the backend is the source of truth. The FE only maps
// the composite to a letter grade for display consistency.
//
// Inputs come from `calculated_metrics` rows persisted by stage_compute:
//   credit_composite              0-100 score
//   altman_z_score                raw Z″ value
//   altman_x1..x4                 Z″ components
//   credit_subscore_*             7 weighted sub-scores
//
// Renders three blocks:
//   1. Big composite + grade (the headline)
//   2. Altman Z″ value + zone (safe / grey / distress)
//   3. Component breakdown (sub-scores as horizontal bars)

import { formatRON } from "@/lib/formatRon";

export interface CreditScoreData {
  composite: number;          // 0-100
  altmanZ: number;            // raw Z″
  altmanX1: number;
  altmanX2: number;
  altmanX3: number;
  altmanX4: number;
  subscores: {
    altman: number;
    profitability: number;
    leverage: number;
    coverage: number;
    dscr: number;
    liquidity: number;
    equity: number;
  };
}

/**
 * Map composite 0-100 to letter grade (mirrors the same mapping in
 * pipeline.py — `if composite >= 90: AAA …`).
 */
export function compositeToGrade(composite: number): string {
  if (composite >= 90) return "AAA";
  if (composite >= 80) return "A";
  if (composite >= 70) return "BBB";
  if (composite >= 60) return "BB";
  if (composite >= 50) return "B";
  if (composite >= 40) return "CCC";
  return "CC";
}

/** Map Z″ to the 3 zones from the methodology. */
export function altmanZone(z: number): "safe" | "grey" | "distress" {
  if (z >= 2.60) return "safe";
  if (z >= 1.10) return "grey";
  return "distress";
}

/**
 * Pull credit fields from a calculated_metrics map. Returns `null` when
 * the back-end didn't write the new fields yet (older cached periods —
 * the user can re-run the pipeline to regenerate).
 */
export function readCreditFromMetrics(
  metrics: Record<string, number | null>,
): CreditScoreData | null {
  const composite = metrics.credit_composite;
  const altmanZ = metrics.altman_z_score;
  if (composite == null || altmanZ == null) return null;
  return {
    composite,
    altmanZ,
    altmanX1: metrics.altman_x1 ?? 0,
    altmanX2: metrics.altman_x2 ?? 0,
    altmanX3: metrics.altman_x3 ?? 0,
    altmanX4: metrics.altman_x4 ?? 0,
    subscores: {
      altman:        metrics.credit_subscore_altman        ?? 0,
      profitability: metrics.credit_subscore_profitability ?? 0,
      leverage:      metrics.credit_subscore_leverage      ?? 0,
      coverage:      metrics.credit_subscore_coverage      ?? 0,
      dscr:          metrics.credit_subscore_dscr          ?? 0,
      liquidity:     metrics.credit_subscore_liquidity     ?? 0,
      equity:        metrics.credit_subscore_equity        ?? 0,
    },
  };
}

interface Props {
  data: CreditScoreData;
  /** Show the compact one-row header version (Dashboard) vs the expanded
   *  card with sub-score bars (Comprehensive Report Section 7). */
  variant?: "compact" | "full";
}

export function CreditScoreCard({ data, variant = "full" }: Props) {
  const grade = compositeToGrade(data.composite);
  const zone = altmanZone(data.altmanZ);

  const gradeColor =
    data.composite >= 70 ? "text-emerald-700 dark:text-emerald-400"
    : data.composite >= 50 ? "text-amber-700 dark:text-amber-400"
    : "text-red-700 dark:text-red-400";

  const zoneLabel = zone === "safe" ? "Safe" : zone === "grey" ? "Grey" : "Distress";
  const zoneClass =
    zone === "safe" ? "bg-success-tint text-[hsl(var(--success))] border-[hsl(var(--success)/0.3)]"
    : zone === "grey" ? "bg-[hsl(var(--warning-2-tint))] text-[hsl(var(--warning-2))] border-[hsl(var(--warning-2)/0.3)]"
    : "bg-alert-tint text-[hsl(var(--alert))] border-[hsl(var(--alert)/0.3)]";

  if (variant === "compact") {
    return (
      <div
        data-testid="credit-score-compact"
        className="inline-flex items-center gap-3 rounded-xl border border-rule bg-surface px-4 py-2.5"
      >
        <div>
          <div className="text-[10px] uppercase tracking-[0.1em] text-ink-mute font-medium">
            Credit score
          </div>
          <div className={`font-serif text-[22px] leading-none ${gradeColor}`}>
            {Math.round(data.composite)}<span className="text-[14px] text-ink-mute"> / 100</span>
          </div>
        </div>
        <div className="h-8 w-px bg-rule/60" />
        <div>
          <div className="text-[10px] uppercase tracking-[0.1em] text-ink-mute font-medium">
            Grade
          </div>
          <div className={`font-serif text-[22px] leading-none ${gradeColor}`}>{grade}</div>
        </div>
        <div className="h-8 w-px bg-rule/60" />
        <div>
          <div className="text-[10px] uppercase tracking-[0.1em] text-ink-mute font-medium">
            Altman Z″
          </div>
          <div className="font-serif text-[18px] leading-none text-ink">{data.altmanZ.toFixed(2)}</div>
        </div>
        <span className={`text-[10px] uppercase tracking-[0.1em] font-medium px-2 py-0.5 rounded-md border ${zoneClass}`}>
          {zoneLabel}
        </span>
      </div>
    );
  }

  return (
    <section data-testid="credit-score-card" className="rounded-2xl border border-rule bg-surface p-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium">
            Credit score
          </div>
          <div className="mt-2 flex items-baseline gap-3">
            <span className={`font-serif text-[56px] leading-none ${gradeColor}`}>
              {Math.round(data.composite)}
            </span>
            <span className="text-[20px] text-ink-mute">/ 100</span>
            <span className={`font-serif text-[40px] leading-none ${gradeColor}`}>{grade}</span>
          </div>
          <div className="mt-2 text-[12px] text-ink-soft">
            Composite score · weighted average of 7 risk dimensions
          </div>
        </div>
        <div className="rounded-xl border border-rule bg-bg-2/40 p-4 min-w-[220px]">
          <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium">
            Altman Z″ score
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="font-serif text-[32px] text-ink">{data.altmanZ.toFixed(2)}</span>
            <span className={`text-[11px] uppercase tracking-[0.08em] font-medium px-2 py-0.5 rounded-md border ${zoneClass}`}>
              {zoneLabel}
            </span>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-[11.5px] tabular-nums">
            <span className="text-ink-mute">X1 (working capital)</span>
            <span className="text-right">{data.altmanX1.toFixed(2)}</span>
            <span className="text-ink-mute">X2 (retained / assets)</span>
            <span className="text-right">{data.altmanX2.toFixed(2)}</span>
            <span className="text-ink-mute">X3 (EBIT / assets)</span>
            <span className="text-right">{data.altmanX3.toFixed(2)}</span>
            <span className="text-ink-mute">X4 (equity / liab)</span>
            <span className="text-right">{data.altmanX4.toFixed(2)}</span>
          </div>
        </div>
      </div>

      {/* Sub-score breakdown — horizontal bars showing each weighted input */}
      <div className="mt-6">
        <div className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium mb-3">
          Component breakdown
        </div>
        <div className="space-y-2">
          <ScoreBar label="Altman Z″"          value={data.subscores.altman}        weight={30} />
          <ScoreBar label="Profitability"      value={data.subscores.profitability} weight={20} />
          <ScoreBar label="Leverage"           value={data.subscores.leverage}      weight={15} />
          <ScoreBar label="Interest coverage"  value={data.subscores.coverage}      weight={10} />
          <ScoreBar label="DSCR"               value={data.subscores.dscr}          weight={10} />
          <ScoreBar label="Liquidity"          value={data.subscores.liquidity}     weight={10} />
          <ScoreBar label="Equity ratio"       value={data.subscores.equity}        weight={5} />
        </div>
      </div>
    </section>
  );
}

function ScoreBar({ label, value, weight }: { label: string; value: number; weight: number }) {
  const pct = Math.max(0, Math.min(100, value));
  const color =
    value >= 70 ? "bg-emerald-500"
    : value >= 50 ? "bg-amber-500"
    : "bg-red-500";
  return (
    <div className="grid grid-cols-[140px_1fr_56px_44px] items-center gap-3 text-[12px]">
      <div className="text-ink">{label}</div>
      <div className="h-1.5 rounded-full bg-bg-2 overflow-hidden">
        <div className={`h-full transition-all duration-500 ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="text-right text-ink tabular-nums">{Math.round(value)}</div>
      <div className="text-right text-[11px] text-ink-mute tabular-nums">{weight}%</div>
    </div>
  );
}

// Unused export to keep formatRON imported (referenced for future $-value
// rendering in the expanded card).
void formatRON;
