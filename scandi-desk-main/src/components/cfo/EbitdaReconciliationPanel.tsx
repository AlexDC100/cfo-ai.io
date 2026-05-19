// EbitdaReconciliationPanel — itemized Reported → Core EBITDA bridge.
//
// Renders the canonical bridge: Reported EBITDA − 758 (Other operating
// income) − 781 (Provision reversals) = Core EBITDA. Lines come from
// the canonical metric object (which extracts them from the per-account
// line items already shipped on `/api/period/{id}`); arithmetic is
// exact and traceable. No engine recompute here.
//
// Spec mandate (Phase 1 G1): the bridge MUST be exact and itemized,
// with each adjustment showing account + label + amount.

import type { CanonicalMetrics } from "@/lib/canonicalMetrics";
import { formatCanonicalFull, formatCanonicalPct } from "@/lib/canonicalMetrics";
import { Info } from "lucide-react";

interface Props {
  metrics: CanonicalMetrics;
  currency?: string;
  testid?: string;
}

export function EbitdaReconciliationPanel({ metrics, currency = "RON", testid = "ebitda-reconciliation-panel" }: Props) {
  const { ebitda } = metrics;
  const hasAdjustments = ebitda.adjustments.length > 0;

  return (
    <section
      data-testid={testid}
      className="
        rounded-2xl border border-rule bg-surface
        p-5 sm:p-6
      "
    >
      <header className="flex items-start justify-between gap-3 flex-wrap mb-4">
        <div>
          <div className="text-[10.5px] uppercase tracking-[0.14em] text-ink-mute font-semibold inline-flex items-center gap-1.5">
            <Info size={11} strokeWidth={2} className="text-brand-d" />
            EBITDA reconciliation · Reported → Core
          </div>
          <h3 className="mt-1.5 text-[16px] font-semibold text-ink leading-tight">
            One company. Two valid EBITDAs. Here&rsquo;s the bridge between them.
          </h3>
          <p className="mt-1 text-[12.5px] text-ink-soft leading-relaxed max-w-[640px]">
            <span className="text-ink font-medium">Reported</span> is the legally filed view used for lender ratios and reconciliation.{" "}
            <span className="text-ink font-medium">Core</span> strips non-recurring items (758 other operating income, 781 provision reversals) and is the basis used for valuation.
          </p>
        </div>
      </header>

      <ol className="space-y-2 text-[13px]" data-testid="ebitda-reconciliation-rows">
        {/* Reported (anchor) */}
        <li className="grid grid-cols-[100px_1fr_180px] gap-3 items-baseline py-1.5">
          <span className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-semibold">Anchor</span>
          <span className="text-ink font-medium">Reported EBITDA</span>
          <span className="text-right tabular-nums font-semibold text-ink">
            {currency} {formatCanonicalFull(ebitda.reported)}
          </span>
        </li>

        {/* Itemized adjustments — only render the rule's account and
         *  its actual computed amount. When the engine emits zero for
         *  that account, the row is omitted (per `extractAdjustments`
         *  semantics). NEVER a placeholder. */}
        {hasAdjustments ? (
          ebitda.adjustments.map((a) => (
            <li
              key={a.account}
              className="grid grid-cols-[100px_1fr_180px] gap-3 items-baseline py-1.5 border-t border-rule/60"
            >
              <span className="font-mono text-[11px] text-ink-mute">{a.account}</span>
              <span className="text-ink-soft">
                <span className="text-ink-mute mr-1">−</span>
                {a.label}
              </span>
              <span className="text-right tabular-nums text-ink-soft">
                <span className="text-ink-mute mr-0.5">−</span>
                {currency} {formatCanonicalFull(Math.abs(a.amount))}
              </span>
            </li>
          ))
        ) : (
          <li className="grid grid-cols-[100px_1fr_180px] gap-3 items-baseline py-1.5 border-t border-rule/60">
            <span className="text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-semibold">Note</span>
            <span className="text-ink-soft">No 758 or 781 movements on file — Reported = Core for this period.</span>
            <span className="text-right tabular-nums text-ink-soft">{currency} 0</span>
          </li>
        )}

        {/* Core (basis for valuation) */}
        <li className="grid grid-cols-[100px_1fr_180px] gap-3 items-baseline py-2.5 border-t-2 border-ink/80 mt-1">
          <span className="text-[10.5px] uppercase tracking-[0.1em] text-brand-d font-semibold">= Core</span>
          <span className="text-ink font-semibold">
            Core EBITDA
            <span className="ml-2 text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium">basis for valuation</span>
          </span>
          <span className="text-right tabular-nums font-semibold text-ink text-[14px]">
            {currency} {formatCanonicalFull(ebitda.core)}
          </span>
        </li>
      </ol>

      <footer className="mt-4 pt-3 border-t border-rule/60 flex items-center justify-between gap-3 flex-wrap text-[11.5px] text-ink-mute">
        <span>
          Reported margin{" "}
          <span className="text-ink-soft tabular-nums">{formatCanonicalPct(ebitda.reported_margin_pct)}</span>
          <span className="mx-1.5">·</span>
          Core margin{" "}
          <span className="text-ink-soft tabular-nums">{formatCanonicalPct(ebitda.core_margin_pct)}</span>
        </span>
        <span className="text-ink-mute">
          Bridge math: every figure traces to {metrics.provenance.source ?? "the trial balance"} — no engine recompute.
        </span>
      </footer>
    </section>
  );
}
