// THE ONE CHART — EBITDA bars and the cash line: year 0 (actual) and the five
// plan years, with the funding gap shaded where cash would have gone below
// zero before the funding line caught it.
//
// EVERY POINT IS A SERVED FIGURE: `chart.ebitda` (one bar per year, year 0 an
// actual) and `chart.cash` (every projected period close — monthly in plan
// year one, annual after — with the cash BEFORE the funding line and the
// engine's own `gap` flag). Nothing is summed, differenced or derived here:
// whether a period is shaded is the engine's flag, never a subtraction of the
// funding line from the cash, and the year-end cash under each column is the
// served close of that year's LAST period — a selection, not a sum.
//
// WHY GEOMETRY MAY TOUCH THE VALUE: an SVG coordinate needs a plain number.
// Each served value comes out through `cockpitPlot` ONCE, in `plotValue`, for
// pixels only. Every number a READER sees is painted by <CockpitAmountView>
// from the served amount itself (◇ on a projection, none on the actual year),
// so this file formats no number of its own (cockpitNoMoneyMath.test.ts).
//
// Colours: EBITDA bars in `caution` (year 0 hatched lighter), the cash line
// in `brand`, the gap in `alert` — three hues that differ in the dark palette
// and in Paper.

import { useTranslation } from "react-i18next";

import { cockpitPlot, type CockpitAmount, type ChartBar, type ChartCashPoint } from "@/lib/forecastCockpit";
import { CockpitAmountView } from "./CockpitAmountView";
import { yearLabel, type MoneyFormat } from "./format";

const W = 640;
const H = 220;
const PAD_X = 12;
const PAD_T = 14;
const PAD_B = 14;

/** THE ONE READ of a served value for geometry (null: a refusal draws
 *  nothing — it is not drawn at zero). */
function plotValue(amount: CockpitAmount): number | null {
  return cockpitPlot(amount);
}

/** Which year column a served period belongs to: an FY label is its own
 *  column; a month "YYYY-MM" belongs to FY<YYYY>. */
function columnOf(period: string, columns: readonly string[]): number {
  const fy = /^FY\d{4}$/.test(period) ? period : `FY${period.slice(0, 4)}`;
  return columns.indexOf(fy);
}

export function CockpitChart({
  bars,
  cash,
  format,
  projectedLabel,
  lang,
  answerKey,
}: {
  bars: readonly ChartBar[];
  cash: readonly ChartCashPoint[];
  format: MoneyFormat;
  projectedLabel: string;
  lang: string;
  answerKey: string;
}) {
  const { t } = useTranslation();
  const columns = bars.map((b) => b.period);
  const n = Math.max(columns.length, 1);
  const band = (W - PAD_X * 2) / n;

  // x of each served cash point: an annual close at its column's centre, a
  // month spread across its year's column in order.
  const monthsIn = new Map<number, number>();
  for (const p of cash) {
    const c = columnOf(p.period, columns);
    if (/^\d{4}-\d{2}$/.test(p.period)) monthsIn.set(c, (monthsIn.get(c) ?? 0) + 1);
  }
  const seen = new Map<number, number>();
  const cashPoints = cash.flatMap((p) => {
    const c = columnOf(p.period, columns);
    if (c < 0) return [];
    let x = PAD_X + band * (c + 0.5);
    const months = monthsIn.get(c) ?? 0;
    if (/^\d{4}-\d{2}$/.test(p.period) && months > 0) {
      const k = seen.get(c) ?? 0;
      seen.set(c, k + 1);
      x = PAD_X + band * c + (band * (k + 0.5)) / months;
    }
    return [
      {
        point: p,
        column: c,
        x,
        cash: plotValue(p.cash),
        gap: p.gap ? plotValue(p.cashBeforeFunding) : null,
        width: months > 0 && /^\d{4}-\d{2}$/.test(p.period) ? band / months : band * 0.6,
      },
    ];
  });
  const barValues = bars.map((b) => plotValue(b.amount));
  const plotted = [...barValues, ...cashPoints.flatMap((p) => [p.cash, p.gap])].filter(
    (v): v is number => v !== null,
  );
  const lo = Math.min(0, ...plotted);
  const hi = Math.max(0, ...plotted);
  const span = hi - lo || 1;
  const y = (v: number) => PAD_T + ((hi - v) / span) * (H - PAD_T - PAD_B);
  const zero = y(0);
  const barW = Math.min(56, band * 0.46);
  const anyGap = cashPoints.some((p) => p.gap !== null);
  const cashPath = cashPoints
    .filter((p) => p.cash !== null)
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${y(p.cash as number)}`)
    .join(" ");

  // The year-end close under each column: the LAST served point of that year.
  const closeOf = new Map<string, ChartCashPoint>();
  for (const p of cashPoints) closeOf.set(columns[p.column], p.point);

  return (
    <section
      data-testid="cockpit-chart"
      data-funding-gap={anyGap ? "true" : "false"}
      className="rounded-xl border border-rule bg-surface px-4 pb-3 pt-4"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-ink-soft">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-[2px] bg-caution" />
          {t("forecast.cockpit.chart.ebitda", "EBITDA")}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-[2px] w-4 bg-brand" />
          {t("forecast.cockpit.chart.cash", "Cash at year end")}
        </span>
        {anyGap ? (
          <span className="inline-flex items-center gap-1.5" data-testid="cockpit-chart-gap-legend">
            <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-[2px] bg-alert/30" />
            {t("forecast.cockpit.chart.gap", "Below zero before the funding line")}
          </span>
        ) : null}
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="mt-2 h-[180px] w-full sm:h-[220px]"
        role="img"
        aria-label={t("forecast.cockpit.chart.aria", "EBITDA and cash, five plan years")}
      >
        <line x1={PAD_X} x2={W - PAD_X} y1={zero} y2={zero} className="stroke-rule" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        {cashPoints.map((p) =>
          p.gap === null ? null : (
            <rect
              key={`gap-${p.point.period}`}
              data-testid={`cockpit-chart-gap-${p.point.period}`}
              x={p.x - p.width / 2}
              width={p.width}
              y={zero}
              height={Math.max(0, y(p.gap) - zero)}
              className="cockpit-bar fill-alert/25"
            />
          ),
        )}
        {bars.map((b, i) => {
          const v = barValues[i];
          if (v === null) return null;
          const x = PAD_X + band * (i + 0.5);
          return (
            <rect
              key={`bar-${b.period}`}
              data-testid={`cockpit-chart-bar-${b.period}`}
              data-kind={b.amount.kind}
              x={x - barW / 2}
              width={barW}
              y={Math.min(y(v), zero)}
              height={Math.max(1, Math.abs(y(v) - zero))}
              className={`cockpit-bar ${b.amount.kind === "actual" ? "fill-caution/45" : "fill-caution"}`}
            />
          );
        })}
        {cashPath ? (
          <path
            d={cashPath}
            fill="none"
            className="cockpit-line stroke-brand"
            strokeWidth="2.5"
            vectorEffect="non-scaling-stroke"
            data-testid="cockpit-chart-cash-line"
          />
        ) : null}
      </svg>

      {/* THE NUMBERS BEHIND THE PICTURE, painted from the served amounts. */}
      <div
        key={answerKey}
        className="cockpit-settle mt-2 grid gap-x-2 text-[11px] leading-tight tabular-nums"
        style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}
        data-testid="cockpit-chart-readouts"
      >
        {bars.map((b) => {
          const close = closeOf.get(b.period);
          return (
            <div key={b.period} className="min-w-0 text-center" data-period={b.period}>
              <div className="font-mono text-[10.5px] text-ink-mute">{yearLabel(b.period)}</div>
              <div className="truncate text-ink" data-series="ebitda">
                <CockpitAmountView amount={b.amount} format={format} projectedLabel={projectedLabel} lang={lang} />
              </div>
              <div className="truncate text-brand-d" data-series="cash">
                {close ? (
                  <CockpitAmountView amount={close.cash} format={format} projectedLabel={projectedLabel} lang={lang} />
                ) : (
                  <span data-projected="refused">—</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
