// F5.0 Wave 3 — Valuation bridge.
//
// The CFO-grade visualization of the EBITDA-multiple valuation. Every
// component is tappable and opens its concept popover — including the
// cash add-back the older one-line formula buried. The bridge reads:
//
//   Core EBITDA × Multiple = Enterprise Value
//   Enterprise Value − Gross Debt + Cash = Equity Value
//
// Design: stacked formula cards with operators between them, the result
// row anchored visually as a "summed total". Tapping any row pushes the
// concept onto the popover stack (LearnableMetricCard semantics — full
// card click target).

import { Calculator, ChevronRight } from "lucide-react";
import { LearnableMetricCard } from "@/components/learning/LearnableMetricCard";
import { useAmountFormatter } from "@/stores/currency";

interface Props {
  /** Core EBITDA in source currency. */
  coreEbitda: number;
  /** EV/EBITDA multiple applied. */
  multiple: number;
  /** Computed Enterprise Value. */
  ev: number;
  /** Gross interest-bearing debt (LT + ST). */
  grossDebt: number;
  /** Cash + cash equivalents added back on the equity bridge. */
  cash: number;
  /** Computed Equity Value (EV − Gross Debt + Cash). */
  equityValue: number;
  /** Source currency code (e.g. "RON", "EUR"). */
  currency: string;
}

export function LearnableValuationBridge({
  coreEbitda,
  multiple,
  ev,
  grossDebt,
  cash,
  equityValue,
  currency,
}: Props) {
  const fmt = useAmountFormatter(currency);

  return (
    <section
      data-testid="learnable-valuation-bridge"
      data-guide="valuation-bridge"
      aria-label="Valuation bridge"
      className="
        rounded-2xl border border-rule bg-surface
        px-5 py-5
        space-y-5
      "
    >
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header className="flex items-baseline justify-between gap-3">
        <div>
          <div className="inline-flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.14em] text-brand-d font-semibold">
            <Calculator size={11} strokeWidth={2.25} />
            Valuation bridge
          </div>
          <h3 className="mt-1 text-[16px] font-semibold text-ink leading-tight">
            From operating earnings to equity value
          </h3>
          <p className="mt-0.5 text-[12px] text-ink-soft">
            Every step is tappable — see the formula, the source accounts,
            and what each number means.
          </p>
        </div>
      </header>

      {/* ── Stage 1: EBITDA × Multiple = EV ─────────────────────────────── */}
      <div>
        <StageLabel index="1" title="What buyers pay for the business" />
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr_auto_1fr] gap-2 items-stretch">
          <LearnableMetricCard
            label="Core EBITDA"
            conceptKey="ebitda"
            value={coreEbitda}
            display={
              <span className="tabular-nums">
                {currency} {fmt(coreEbitda)}
              </span>
            }
            sub="Reported less 758 / 781 adjustments"
            tone="default"
          />
          <Operator op="×" />
          <LearnableMetricCard
            label="Multiple"
            conceptKey="ev_ebitda_multiple"
            value={multiple}
            display={
              <span className="tabular-nums">{multiple.toFixed(2)}×</span>
            }
            sub="Peer-benchmark range typically 5–10×"
            tone="default"
            formatHint="ratio"
          />
          <Operator op="=" />
          <LearnableMetricCard
            label="Enterprise Value"
            conceptKey="enterprise_value"
            value={ev}
            display={
              <span className="tabular-nums">
                {currency} {fmt(ev)}
              </span>
            }
            sub="Total business value, debt-free basis"
            tone="positive"
          />
        </div>
      </div>

      <BridgeArrow />

      {/* ── Stage 2: EV − Gross Debt + Cash = Equity Value ──────────────── */}
      <div>
        <StageLabel index="2" title="What the shareholders walk away with" />
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] gap-2 items-stretch">
          <LearnableMetricCard
            label="Enterprise Value"
            conceptKey="enterprise_value"
            value={ev}
            display={
              <span className="tabular-nums">
                {currency} {fmt(ev)}
              </span>
            }
            sub="From stage 1"
            tone="default"
          />
          <Operator op="−" />
          <LearnableMetricCard
            label="Gross Debt"
            conceptKey="total_debt"
            value={grossDebt}
            display={
              <span className="tabular-nums">
                {currency} {fmt(grossDebt)}
              </span>
            }
            sub="Bank loans + leasing (162 · 167 · 519)"
            tone="warn"
          />
          <Operator op="+" />
          <LearnableMetricCard
            label="Cash"
            conceptKey="cash"
            value={cash}
            display={
              <span className="tabular-nums">
                {currency} {fmt(cash)}
              </span>
            }
            sub="Bank balances (5121 · 5124 · 531)"
            tone="positive"
          />
          <Operator op="=" />
          <LearnableMetricCard
            label="Equity Value"
            conceptKey="equity_value"
            value={equityValue}
            display={
              <span className="tabular-nums">
                {currency} {fmt(equityValue)}
              </span>
            }
            sub="The shareholders' take"
            tone="positive"
          />
        </div>
      </div>

      {/* ── Why the cash add-back ───────────────────────────────────────── */}
      <div
        data-testid="valuation-bridge-cash-explainer"
        className="
          rounded-lg border border-rule bg-bg-2/40
          px-3.5 py-2.5
          text-[12px] text-ink-soft leading-relaxed
        "
      >
        <span className="font-semibold text-ink">Why cash is added back.</span>{" "}
        Enterprise Value is the price for the whole business <em>debt-free and
        cash-free</em>. When the buyer pays the bank to clear the debt, any cash
        sitting in the company at closing belongs to the seller — so it adds
        to the equity proceeds. This is why{" "}
        <strong>Equity Value = EV − Gross Debt + Cash</strong>, not just{" "}
        <span className="line-through text-ink-mute">EV − Net Debt</span>.
      </div>
    </section>
  );
}

// ─── Small helpers ───────────────────────────────────────────────────

function StageLabel({ index, title }: { index: string; title: string }) {
  return (
    <div className="flex items-center gap-2 mb-2">
      <span
        className="
          inline-flex items-center justify-center
          w-5 h-5 rounded-full
          bg-brand/15 text-brand-d
          text-[10px] font-semibold tabular-nums
        "
        aria-hidden
      >
        {index}
      </span>
      <span className="text-[11px] uppercase tracking-[0.12em] text-ink-mute font-semibold">
        Stage {index}
      </span>
      <span className="text-[12.5px] text-ink-soft">— {title}</span>
    </div>
  );
}

function Operator({ op }: { op: "×" | "−" | "+" | "=" }) {
  return (
    <div
      className="
        hidden sm:flex items-center justify-center
        text-[20px] font-semibold text-ink-mute
        select-none
      "
      aria-hidden
    >
      {op}
    </div>
  );
}

function BridgeArrow() {
  return (
    <div
      className="
        hidden sm:flex items-center justify-center gap-1
        text-ink-mute/60
      "
      aria-hidden
    >
      <ChevronRight size={12} className="rotate-90" />
    </div>
  );
}
