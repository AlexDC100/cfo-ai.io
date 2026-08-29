// Key metric stat panels (THE INSTRUMENT) — the Pro overview's
// above-the-fold row. Extracted verbatim from pages/cfo/FinancialStatements
// (THE DIAL, gate M1) so the mode-parity test can render the REAL Pro row
// beside Simple's StoryOverview from one fixture and assert the <Amount>
// strings are cent-identical. Rendering is unchanged.
//
// One <AmountGroup> wraps the whole row so the four figures share a single
// magnitude — "295,1 M" beside "17,7 M", never "295,1 M" beside "17.703.055".
// Values convert to the display currency HERE (one place, the shared
// useConvertedAmounts hook Simple also reads) and render through <Amount>;
// the YoY delta is a chip with <Amount kind="percent">. No provenance is
// passed — these are assembled aggregates whose payload carries no source
// ref, and the affordance is never faked.

import { useTranslation } from "react-i18next";

import { Amount, AmountGroup } from "@/components/instrument/Amount";
import { Chip } from "@/components/instrument/Panel";
import { useConvertedAmounts } from "@/components/cfo/simple/convertedAmounts";

export interface KeyMetricItem {
  label: string;
  desc: string;
  value: number;
  trend: { pct: number; prevLabel: string } | null;
  testid: string;
}

export function KeyMetricsRow({ items, currency }: { items: KeyMetricItem[]; currency: string }) {
  const { converted, symbol: displaySymbol } = useConvertedAmounts(
    items.map((it) => it.value),
    currency,
  );
  return (
    <AmountGroup values={converted}>
      <div
        className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3"
        data-testid="key-metrics"
      >
        {items.map((it, i) => (
          <KeyMetricCard
            key={it.testid}
            label={it.label}
            desc={it.desc}
            value={converted[i] ?? 0}
            displayCurrency={displaySymbol}
            trend={it.trend}
            testid={it.testid}
          />
        ))}
      </div>
    </AmountGroup>
  );
}

/** One of the four above-the-fold key metric stat panels. Value arrives
 *  already converted to the display currency (KeyMetricsRow owns the one
 *  conversion) and renders through <Amount> under the row's shared scale. */
function KeyMetricCard({
  label,
  desc,
  value,
  displayCurrency,
  trend,
  testid,
}: {
  label: string;
  desc: string;
  value: number;
  displayCurrency: string;
  trend: { pct: number; prevLabel: string } | null;
  testid?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-md border border-rule bg-surface p-4 min-w-0" data-testid={testid}>
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] uppercase tracking-[0.08em] text-ink-soft font-medium truncate">
          {label}
        </div>
        {trend && (
          <Chip
            tone="neutral"
            className="shrink-0"
            title={t("dashV2.vsLastPeriod", { period: trend.prevLabel })}
          >
            <Amount kind="percent" value={trend.pct} fractionDigits={1} />
          </Chip>
        )}
      </div>
      <div
        className="mt-2 text-[22px] font-medium text-ink leading-none tracking-[-0.01em]"
        data-testid={testid ? `${testid}-amount` : undefined}
      >
        <Amount value={value} currency={displayCurrency} />
      </div>
      <p className="mt-1.5 text-[11.5px] text-ink-soft leading-snug">{desc}</p>
      {trend && (
        <p className="mt-1 text-[10.5px] text-ink-soft">
          {t("dashV2.vsLastPeriod", { period: trend.prevLabel })}
        </p>
      )}
    </div>
  );
}
