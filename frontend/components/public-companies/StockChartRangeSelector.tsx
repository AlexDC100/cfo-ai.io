// StockChartRangeSelector — segmented control for the StockPriceChart.
//
// PUB-200 — 8 ranges per the spec §12. Apple Stocks-style: small,
// underline-on-active, tight horizontal padding. Sits above the chart.

import { PRICE_RANGES, type PriceRange } from "@/lib/publicCompanyPriceHistory";

interface Props {
  value: PriceRange;
  onChange: (range: PriceRange) => void;
  /** When true, render in a smaller / denser size for the drawer. */
  compact?: boolean;
}

export function StockChartRangeSelector({ value, onChange, compact = false }: Props) {
  return (
    <div
      role="tablist"
      aria-label="Chart range"
      data-testid="stock-chart-range-selector"
      className={`
        inline-flex items-center
        ${compact ? "gap-0.5" : "gap-1"}
        border border-rule rounded-lg
        bg-surface
        ${compact ? "p-0.5" : "p-1"}
      `}
    >
      {PRICE_RANGES.map((r) => {
        const active = r === value;
        return (
          <button
            key={r}
            type="button"
            role="tab"
            aria-selected={active}
            data-testid={`range-${r.toLowerCase()}`}
            onClick={() => onChange(r)}
            className={`
              inline-flex items-center justify-center
              ${compact ? "h-6 px-2 text-[11px]" : "h-7 px-2.5 text-[12px]"}
              font-medium tracking-wide
              rounded-md transition-all
              ${active
                ? "bg-ink/90 text-bg shadow-sm"
                : "text-ink-soft hover:bg-bg-2/60 hover:text-ink"}
            `}
          >
            {r}
          </button>
        );
      })}
    </div>
  );
}
