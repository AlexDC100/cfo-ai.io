// EbitdaMultiplePrimaryCard — Phase 2 primary valuation surface for
// non-real-estate companies (~99% of the book).
//
// Design contract from the spec:
//   · Computes EV = Core EBITDA × multiple, Equity = EV − net debt
//   · Default multiple = industry-benchmark P50 from the engine
//   · Bounded slider 2× – 20× with a synced numeric input
//   · LIVE recompute, client-side only — persists nothing
//   · Provenance line always visible: which basis (Core EBITDA), value,
//     net debt used — every figure on this card is traceable back to
//     the canonical metric object built in Phase 1
//   · Reads exclusively from the canonical metric object — never
//     recomputes its own EBITDA / net debt
//
// THIS COMPONENT NEVER WRITES TO THE BACKEND. The existing
// ValuationSection still handles the persisted-override flow if the
// user wants to set board-grade assumptions; this card is the first-
// read EBITDA-multiple view a CFO scans.

import { useEffect, useMemo, useRef, useState } from "react";
import { Calculator, Info, Sparkles, ChevronDown } from "lucide-react";
import type { CanonicalMetrics } from "@/lib/canonicalMetrics";
import { formatCanonicalFull, formatCanonicalCompact } from "@/lib/canonicalMetrics";
import type { PeriodValuation } from "@/lib/activePeriod";

interface Props {
  /** Canonical metric object — the single source of truth for Core
   *  EBITDA and net debt used in this card. */
  metrics: CanonicalMetrics;
  /** Optional engine-emitted valuation block — supplies the default
   *  multiple (industry-benchmark P50) and the source/date label. The
   *  card still works without it; default multiple falls back to 7×
   *  (the cross-industry SME median) with an honest "no benchmark"
   *  caption. */
  valuation: PeriodValuation | null | undefined;
  currency?: string;
  /** Optional: scroll target for the Reported→Core bridge so the
   *  "Bridge" link in the provenance line jumps there. */
  reconciliationAnchorId?: string;
}

// Spec-mandated slider bounds. Hard floor at 2× (no negative or near-
// zero EBITDA-multiples — those signal a distressed business and a
// different conversation); hard ceiling at 20× (above that, the user
// is in venture-style territory where EBITDA-multiple isn't the right
// lens). Inside this band the user can drag freely.
const MULTIPLE_MIN = 2;
const MULTIPLE_MAX = 20;
const MULTIPLE_FALLBACK_DEFAULT = 7; // cross-industry SME median when no benchmark on file
const MULTIPLE_STEP = 0.1;

export function EbitdaMultiplePrimaryCard({
  metrics, valuation, currency = "RON", reconciliationAnchorId = "ebitda-bridge",
}: Props) {
  const { ebitda, balance, provenance } = metrics;
  const coreEbitda = ebitda.core;
  const netDebt = balance.net_debt;

  // Default multiple — industry-benchmark P50 from the engine, clamped
  // into the bounded band. Falls back to 7× when no benchmark on file.
  const benchmarkP50 = valuation?.primary?.multiple_p50 ?? null;
  const benchmarkP25 = valuation?.primary?.multiple_p25 ?? null;
  const benchmarkP75 = valuation?.primary?.multiple_p75 ?? null;
  const defaultMultiple = useMemo(() => {
    if (benchmarkP50 !== null && Number.isFinite(benchmarkP50)) {
      return clamp(benchmarkP50, MULTIPLE_MIN, MULTIPLE_MAX);
    }
    return MULTIPLE_FALLBACK_DEFAULT;
  }, [benchmarkP50]);

  const [multiple, setMultiple] = useState<number>(defaultMultiple);
  // Reset when the upstream period changes (default flips with the
  // industry benchmark).
  useEffect(() => { setMultiple(defaultMultiple); }, [defaultMultiple]);

  // Live recompute, client-side only.
  const ev = coreEbitda * multiple;
  const equity = ev - netDebt;
  const equityLow = coreEbitda * clamp(benchmarkP25 ?? Math.max(multiple - 1, MULTIPLE_MIN), MULTIPLE_MIN, MULTIPLE_MAX) - netDebt;
  const equityHigh = coreEbitda * clamp(benchmarkP75 ?? Math.min(multiple + 1, MULTIPLE_MAX), MULTIPLE_MIN, MULTIPLE_MAX) - netDebt;

  // Synced numeric input — share state with the slider, clamp on blur.
  const numericRef = useRef<HTMLInputElement | null>(null);
  function setMultipleClamped(raw: string | number) {
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(n)) return;
    setMultiple(clamp(n, MULTIPLE_MIN, MULTIPLE_MAX));
  }

  const isAtBenchmark = benchmarkP50 !== null && Math.abs(multiple - benchmarkP50) < 0.05;

  return (
    <section
      data-testid="ebitda-multiple-primary"
      className="
        relative overflow-hidden rounded-3xl
        border border-brand/30 bg-surface
        ring-1 ring-inset ring-brand/10
        shadow-[0_24px_48px_-30px_rgba(45,191,179,0.25)]
        p-6 sm:p-7
      "
    >
      {/* Atmospheric brand glow */}
      <div aria-hidden className="pointer-events-none absolute -top-16 -right-16 h-56 w-56 rounded-full bg-brand/10 blur-3xl" />

      {/* ── Eyebrow + headline ─────────────────────────────────────── */}
      <div className="relative flex items-start justify-between gap-3 flex-wrap mb-3">
        <div>
          <div className="inline-flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.14em] text-brand-d font-semibold">
            <Sparkles size={10} strokeWidth={2.25} />
            Primary valuation method
          </div>
          <h2 className="mt-1 text-[20px] sm:text-[22px] font-semibold text-ink leading-tight">
            EBITDA multiple
            <span className="ml-2 text-[12px] uppercase tracking-[0.1em] text-ink-mute font-medium">
              on Core EBITDA
            </span>
          </h2>
          <p className="mt-1 text-[12.5px] text-ink-soft leading-relaxed max-w-[640px]">
            The peer-multiple view a buyer or lender will use first. Built on Core EBITDA
            (Reported less the 758 / 781 adjustments) so the multiple reflects repeatable
            earnings, not one-off provision reversals.
          </p>
        </div>
      </div>

      {/* ── Headline equity number ─────────────────────────────────── */}
      <div className="relative mt-4 grid grid-cols-1 sm:grid-cols-[1fr_auto] items-end gap-4">
        <div>
          <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium">
            Implied equity value
          </div>
          <div
            data-testid="ebitda-multiple-equity"
            className="mt-1 text-[36px] sm:text-[42px] font-semibold tabular-nums tracking-[-0.01em] text-ink leading-none"
          >
            {currency} {formatCanonicalFull(equity)}
          </div>
          <div className="mt-1 text-[12px] text-ink-soft">
            Range{" "}
            <span className="tabular-nums">{formatCanonicalCompact(equityLow, currency)}</span>
            {" – "}
            <span className="tabular-nums">{formatCanonicalCompact(equityHigh, currency)}</span>
            {(benchmarkP25 !== null && benchmarkP75 !== null) && (
              <span className="text-ink-mute"> (P25 – P75 peer band)</span>
            )}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium">
            Enterprise value
          </div>
          <div
            data-testid="ebitda-multiple-ev"
            className="mt-1 text-[20px] font-semibold tabular-nums text-ink-soft leading-none"
          >
            {currency} {formatCanonicalFull(ev)}
          </div>
        </div>
      </div>

      {/* ── Formula line ───────────────────────────────────────────── */}
      <div
        data-testid="ebitda-multiple-formula"
        className="relative mt-5 rounded-lg bg-bg-2/40 border border-rule px-4 py-3 font-mono text-[12.5px] text-ink-soft"
      >
        Equity = Core EBITDA
        <span className="mx-1 text-ink">({currency} {formatCanonicalFull(coreEbitda)})</span>
        × Multiple <span className="text-ink">({multiple.toFixed(2)}×)</span>
        {" − "}
        Net debt <span className="text-ink">({currency} {formatCanonicalFull(netDebt)})</span>
        {" = "}
        <span className="text-ink font-semibold">{currency} {formatCanonicalFull(equity)}</span>
      </div>

      {/* ── Slider + synced numeric input ──────────────────────────── */}
      <div className="relative mt-5 grid grid-cols-1 md:grid-cols-[1fr_auto] gap-4 items-end">
        <div className="min-w-0">
          <div className="flex items-baseline justify-between gap-2 mb-1.5">
            <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium">
              Multiple ·{" "}
              <span className="text-ink-soft normal-case tracking-normal">
                bounded {MULTIPLE_MIN}× – {MULTIPLE_MAX}×
              </span>
            </div>
            {benchmarkP50 !== null && (
              <button
                type="button"
                onClick={() => setMultiple(defaultMultiple)}
                disabled={isAtBenchmark}
                data-testid="ebitda-multiple-reset"
                className="
                  text-[11px] text-ink-mute hover:text-ink underline-offset-2 hover:underline
                  disabled:opacity-50 disabled:cursor-default disabled:no-underline
                "
              >
                Reset to benchmark ({benchmarkP50.toFixed(1)}×)
              </button>
            )}
          </div>
          <input
            data-testid="ebitda-multiple-slider"
            type="range"
            min={MULTIPLE_MIN}
            max={MULTIPLE_MAX}
            step={MULTIPLE_STEP}
            value={multiple}
            onChange={(e) => setMultipleClamped(e.target.value)}
            aria-label="EBITDA multiple"
            className="w-full accent-brand"
          />
          <div className="mt-1 flex items-center justify-between text-[10px] uppercase tracking-[0.08em] text-ink-mute tabular-nums">
            <span>{MULTIPLE_MIN}×</span>
            {benchmarkP25 !== null && benchmarkP25 >= MULTIPLE_MIN && benchmarkP25 <= MULTIPLE_MAX && (
              <span className="text-ink-mute">P25 {benchmarkP25.toFixed(1)}×</span>
            )}
            {benchmarkP50 !== null && (
              <span className="text-brand-d font-semibold normal-case tracking-normal">
                Benchmark {benchmarkP50.toFixed(1)}×
              </span>
            )}
            {benchmarkP75 !== null && benchmarkP75 >= MULTIPLE_MIN && benchmarkP75 <= MULTIPLE_MAX && (
              <span className="text-ink-mute">P75 {benchmarkP75.toFixed(1)}×</span>
            )}
            <span>{MULTIPLE_MAX}×</span>
          </div>
        </div>

        {/* Synced numeric input — kept in lockstep with the slider. */}
        <div>
          <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium mb-1.5">
            Value
          </div>
          <div className="inline-flex items-center gap-1 h-10 rounded-lg border border-rule bg-surface px-2 focus-within:border-brand/40 focus-within:ring-2 focus-within:ring-brand/15 transition-all">
            <input
              ref={numericRef}
              data-testid="ebitda-multiple-numeric"
              type="number"
              min={MULTIPLE_MIN}
              max={MULTIPLE_MAX}
              step={MULTIPLE_STEP}
              value={multiple.toFixed(1)}
              onChange={(e) => setMultipleClamped(e.target.value)}
              onBlur={(e) => setMultipleClamped(e.target.value)}
              aria-label="EBITDA multiple (numeric)"
              className="
                w-16 bg-transparent text-right
                text-[16px] tabular-nums font-semibold text-ink
                focus:outline-none
              "
            />
            <span className="text-[14px] text-ink-mute font-medium pr-1">×</span>
          </div>
        </div>
      </div>

      {/* ── Provenance line — every figure traceable ───────────────── */}
      <div
        data-testid="ebitda-multiple-provenance"
        className="
          relative mt-5 rounded-lg
          border border-rule bg-bg-2/40
          px-3.5 py-2.5
          flex items-start gap-2.5
          text-[11.5px] leading-relaxed
        "
      >
        <Info size={13} strokeWidth={1.75} className="text-ink-mute mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-ink">
            Basis: <span className="font-semibold">Core EBITDA</span> ={" "}
            <span className="tabular-nums">{currency} {formatCanonicalFull(coreEbitda)}</span>
            {ebitda.adjustments.length > 0 && (
              <>
                {" "}
                <span className="text-ink-mute">
                  (Reported {formatCanonicalCompact(ebitda.reported, currency)}
                  {ebitda.adjustments.map((a) =>
                    ` − ${a.account} ${formatCanonicalCompact(Math.abs(a.amount), currency)}`,
                  ).join("")})
                </span>
              </>
            )}
            <span className="mx-1 text-ink-mute">·</span>
            Net debt = <span className="tabular-nums">{currency} {formatCanonicalFull(netDebt)}</span>
          </div>
          <div className="mt-0.5 text-ink-mute">
            Source: canonical metric object · {provenance.source ?? "trial balance"}
            {provenance.period ? <> · {provenance.period}</> : null}
            {valuation?.multiples_source && (
              <> · benchmark multiples {valuation.multiples_source}{valuation.multiples_as_of_date ? ` (${valuation.multiples_as_of_date})` : ""}</>
            )}
            {" · "}
            <a href={`#${reconciliationAnchorId}`} className="text-ink-soft underline underline-offset-2 hover:text-ink">
              See the EBITDA bridge
            </a>
          </div>
        </div>
        <Calculator size={13} strokeWidth={1.75} className="text-ink-mute mt-0.5 shrink-0" />
      </div>
    </section>
  );
}

// ─── Cross-checks dropdown wrapper ──────────────────────────────────
//
// Phase 2 spec: DCF + Graham + EV/Revenue collapsed into ONE
// "Cross-checks" disclosure, default collapsed. Not deleted —
// the user can expand it to see the divergence flag work.
//
// This wraps whatever the caller passes as `children` (the existing
// ValuationPanel / football field / DCF panel etc.) in a `<details>`
// element with a styled summary chevron. Pure presentation.

export function ValuationCrossChecksDisclosure({
  children, defaultOpen = false, count,
}: {
  children: React.ReactNode;
  defaultOpen?: boolean;
  /** Optional count to surface in the summary (e.g. "3 methods"). */
  count?: number;
}) {
  return (
    <details
      data-testid="valuation-cross-checks-disclosure"
      className="group rounded-2xl border border-rule bg-surface/60 overflow-hidden"
      {...(defaultOpen ? { open: true } : {})}
    >
      <summary className="
        flex items-center justify-between gap-3
        px-5 py-3.5
        cursor-pointer list-none select-none
        hover:bg-bg-2/40 transition-colors
      ">
        <span>
          <span className="text-[10.5px] uppercase tracking-[0.14em] text-ink-mute font-semibold">
            Cross-checks
          </span>
          <span className="ml-2 text-[13px] text-ink-soft">
            DCF · WACC · Graham · EV / Revenue
            {count != null && <span className="text-ink-mute"> · {count} methods</span>}
          </span>
        </span>
        <ChevronDown size={15} strokeWidth={1.75} className="text-ink-mute transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-rule/60 px-5 py-5 space-y-6">
        <p className="text-[12.5px] text-ink-soft leading-relaxed max-w-[640px]">
          These methods exist to validate (or challenge) the primary EBITDA-multiple result. Convergence
          means high confidence; material divergence (&gt;30%) usually means a WACC or growth
          assumption needs review, not that the EBITDA multiple is wrong.
        </p>
        {children}
      </div>
    </details>
  );
}

// ─── Heavy-RE reason banner ─────────────────────────────────────────
//
// Surfaces the on-screen reason the engine picked NAV over EBITDA-
// multiple for this period. Reads from the engine's existing routing
// signal (`primary_method === "asset_based"`) plus the optional
// asset-intensity ratio computed FE-side.

export function HeavyReReasonBanner({
  reasonLines,
}: {
  reasonLines: string[];
}) {
  if (reasonLines.length === 0) return null;
  return (
    <aside
      data-testid="heavy-re-reason"
      className="
        rounded-2xl border border-rule bg-surface
        border-l-[3px] border-l-brand/60
        px-4 py-3
        flex items-start gap-2.5
      "
    >
      <Info size={14} strokeWidth={1.75} className="text-brand-d mt-0.5 shrink-0" />
      <div className="min-w-0">
        <div className="text-[10.5px] uppercase tracking-[0.14em] text-ink-mute font-semibold mb-1">
          Why NAV is primary for this company
        </div>
        <ul className="space-y-0.5">
          {reasonLines.map((r, i) => (
            <li key={i} className="text-[12.5px] text-ink-soft leading-relaxed">· {r}</li>
          ))}
        </ul>
      </div>
    </aside>
  );
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
