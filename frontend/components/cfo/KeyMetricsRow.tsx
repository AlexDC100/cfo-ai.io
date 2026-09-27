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
// the YoY delta is a chip with <Amount kind="percent" change>: the one
// classifier (lib/changeKind.ts, plan_contract_v2 section 7) decides, so a
// change from zero, to zero or across sign shows the money change and its
// words ("turned negative"), never a percent — EBITDA 54.4M to −20.3M used
// to read "−137.2%" (defect 0.4).
//
// PROVENANCE rides on the item. The page builds it ONCE beside the figure
// (`lib/headlineProvenance`) and passes the same object to Simple's twins,
// so the origin a reader is shown cannot differ by mode any more than the
// figure can. An item with `provenance: null` renders plain — the
// affordance is never faked, and the YoY delta (a derived comparison
// over a series) never wears it.

import { useTranslation } from "react-i18next";

import { Amount, AmountGroup } from "@/components/instrument/Amount";
import type { AmountProvenance } from "@/components/instrument/Provenance";
import { Chip } from "@/components/instrument/Panel";
import { useConvertedAmounts } from "@/components/cfo/simple/convertedAmounts";
import {
  ROUNDED_MONEY_ZERO_FLOOR,
  classifyChange,
  deltaPctNumber,
  isWordKind,
  type ChangeResult,
} from "@/lib/changeKind";

/** A vs-last-period move: the two values in the statement currency, never
 *  a pre-divided ratio (a ratio cannot tell a flip from a same-sign move). */
export interface MetricTrend {
  base: number;
  current: number;
  prevLabel: string;
}

/** The chip for a trend: percent for a same-sign move, the converted money
 *  change plus words for every other kind. */
export function TrendChange({
  change,
  convertedDelta,
  currency,
}: {
  change: ChangeResult;
  convertedDelta: number | null;
  currency: string;
}) {
  const words = isWordKind(change.kind) || change.deltaPct === null;
  return (
    <>
      {words && (
        <span className="mr-1">
          <Amount value={convertedDelta} currency={currency} signed />
        </span>
      )}
      <Amount kind="percent" value={deltaPctNumber(change)} change={change} fractionDigits={1} />
    </>
  );
}

export interface KeyMetricItem {
  label: string;
  desc: string;
  /** null = the engine REFUSED the figure (then `refused` says why). */
  value: number | null;
  /** The engine's reason for a refused figure, in the reader's language —
   *  printed in place of the amount, never a zero. */
  refused?: string | null;
  trend: MetricTrend | null;
  testid: string;
  /** Where the figure came from, when the payload says. Omitted or null
   *  → the figure renders without the affordance. */
  provenance?: AmountProvenance | null;
}

export function KeyMetricsRow({ items, currency }: { items: KeyMetricItem[]; currency: string }) {
  const { converted, symbol: displaySymbol } = useConvertedAmounts(
    items.map((it) => it.value),
    currency,
  );
  const { converted: convertedDeltas } = useConvertedAmounts(
    items.map((it) => (it.trend ? it.trend.current - it.trend.base : null)),
    currency,
  );
  // The prior figure itself, printed under the tile (owner, 2026-09-26: the
  // Overview shows the year it compares with, not only the move).
  const { converted: convertedBases } = useConvertedAmounts(
    items.map((it) => (it.trend ? it.trend.base : null)),
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
            value={it.value === null ? null : converted[i] ?? null}
            refused={it.refused ?? null}
            displayCurrency={displaySymbol}
            trend={it.trend}
            convertedDelta={convertedDeltas[i] ?? null}
            convertedBase={convertedBases[i] ?? null}
            testid={it.testid}
            provenance={it.provenance ?? null}
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
  refused,
  displayCurrency,
  trend,
  convertedDelta,
  convertedBase,
  testid,
  provenance,
}: {
  label: string;
  desc: string;
  value: number | null;
  refused: string | null;
  displayCurrency: string;
  trend: MetricTrend | null;
  convertedDelta: number | null;
  /** The prior figure, in the display currency. */
  convertedBase: number | null;
  testid?: string;
  provenance: AmountProvenance | null;
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
            <TrendChange
              change={classifyChange(trend.base, trend.current, ROUNDED_MONEY_ZERO_FLOOR)}
              convertedDelta={convertedDelta}
              currency={displayCurrency}
            />
          </Chip>
        )}
      </div>
      <div
        className="mt-2 text-[22px] font-medium text-ink leading-none tracking-[-0.01em]"
        data-testid={testid ? `${testid}-amount` : undefined}
      >
        {value === null ? (
          <span className="text-[13px] text-ink-soft" data-testid={testid ? `${testid}-refused` : undefined}>
            {refused ?? t("forecast.absent", "not measurable from this book")}
          </span>
        ) : (
          <Amount value={value} currency={displayCurrency} provenance={provenance} />
        )}
      </div>
      <p className="mt-1.5 text-[11.5px] text-ink-soft leading-snug">{desc}</p>
      {trend && (
        <p
          className="mt-1 text-[10.5px] text-ink-soft"
          data-testid={testid ? `${testid}-prior` : undefined}
          title={t("dashV2.vsLastPeriod", { period: trend.prevLabel })}
        >
          {trend.prevLabel}:{" "}
          <Amount value={convertedBase} currency={displayCurrency} />
        </p>
      )}
    </div>
  );
}
