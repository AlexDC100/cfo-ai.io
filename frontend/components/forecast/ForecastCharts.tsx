// THE FOUR FORECAST CHARTS — revenue/EBITDA, the cash curve, free cash flow,
// and capex against depreciation.
//
// ── EVERY POINT IS A SERVED FIGURE ──────────────────────────────────────
//
// Nothing here is computed. Each chart reads ONE served key of fp1.2's
// `series` block; the trough marker is `summary.cash_trough` and the shaded
// band is `summary.funding_gap_periods`, both served. The browser does not sum
// months into a year and does not derive a trough by scanning a line: an FY
// aggregate for `fcf` / `min_cash` / `cash_before_funding` does not exist on
// the wire, and building one here would be `cf.cash_from_operating +
// cf.cash_from_investing` in IEEE-754 beside an engine that projects in
// integer minor units.
//
// ── THE GRAIN, STATED ON EVERY CHART ────────────────────────────────────
//
// `series` is served over the TIMELINE periods — the months of plan year one
// and then the annual periods — and never over the FY aggregates. The
// statement table below defaults to FY columns. Those are two different period
// grids over the same plan, so each chart says which one it is on rather than
// letting the reader assume they match.
//
// ── WHY GEOMETRY MAY TOUCH THE VALUE, AND WHAT PAYS FOR IT ──────────────
//
// An SVG path needs plain numbers. The value comes out through
// `unwrapProjected`, whose consumer signature hands over the marker in the
// same call, and every number this file puts in front of a READER — the axis
// extremes, the trough, the legend readouts — is painted by `<ProjectedAmount>`
// from the served figure itself. The alternative (geometry in a .ts module,
// paths only in the .tsx) satisfies the boundary gate's regex without
// satisfying its purpose; `check_forecast_boundary.mjs` names that as a blind
// spot it cannot see, and choosing it would be choosing to sit in the hole.
//
// ── TWO SERIES, TWO COLOURS THAT SURVIVE THE THEME ──────────────────────
//
// `brand-2` is NOT a class in this palette — the tokens are `accent2` / `gold`
// — so `stroke-brand-2` was a silent no-op and the bars painted black. And
// `gold` itself resolves to `--brand-2`, which in the dark palette is a second
// TEAL: the second series came out in the first series' colour. Categories are
// `brand` and `caution`, which differ in hue in both themes. `alert` is held
// back for the funding band and the trough and is never a category.
//
// ── INLINE SVG, NOT A CHART LIBRARY ─────────────────────────────────────
//
// The house idiom for a financial trend render (`pages/cfo/MultiYearHistory
// .tsx::TrendChart`): hand-rolled SVG whose colours flow through Tailwind
// stroke-/fill- token utilities, so it re-themes with the palette like every
// other surface and adds no vendor chunk. CLAUDE.md §19 records a
// `vendor-charts` manualChunk breaking prod boot; a new route chunk is not the
// place to re-run that.

import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { ProjectedAmount } from "@/components/forecast/ProjectedAmount";
import {
  isProjectedFigure,
  unwrapProjected,
  type ProjectedResult,
  type SeriesPoint,
} from "@/lib/forecastFacts";

/** One plotted point. `minor` is null when the engine REFUSED that period —
 *  on a partial refusal it serves three keys at the cut and nothing after it —
 *  and the line breaks there rather than being drawn through the gap. */
interface Plot {
  readonly period: string;
  readonly minor: number | null;
  readonly result: ProjectedResult;
}

function plotted(points: readonly SeriesPoint[], base: string): Plot[] {
  return points.map((p) => ({
    period: p.period,
    result: p.result,
    minor: isProjectedFigure(p.result)
      ? unwrapProjected(p.result, base, (value) => value)
      : null,
  }));
}

const W = 720;
const H = 200;
const PAD_L = 8;
const PAD_R = 8;
const PAD_T = 12;
const PAD_B = 22;
const INNER_W = W - PAD_L - PAD_R;
const INNER_H = H - PAD_T - PAD_B;

interface Scale {
  readonly x: (i: number) => number;
  readonly y: (v: number) => number;
  readonly band: number;
  readonly min: number;
  readonly max: number;
  readonly zero: number;
}

/** The plot box for one set of series. Zero is always inside the range: a bar
 *  chart whose baseline is off-screen reads as though nothing crossed it. */
function scaleFor(all: ReadonlyArray<readonly Plot[]>, n: number): Scale {
  const values = all.flat().map((p) => p.minor).filter((v): v is number => v !== null);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = max - min || 1;
  const band = n > 0 ? INNER_W / n : INNER_W;
  return {
    x: (i: number) => PAD_L + band * (i + 0.5),
    y: (v: number) => PAD_T + (1 - (v - min) / span) * INNER_H,
    band,
    min,
    max,
    zero: PAD_T + (1 - (0 - min) / span) * INNER_H,
  };
}

/** Segments of consecutive SERVED points. A refused period ENDS a segment:
 *  drawing from the point before it to the point after would put a line
 *  through a period the engine declined to state. */
function segments(points: readonly Plot[]): Array<Array<[number, number]>> {
  const out: Array<Array<[number, number]>> = [];
  let run: Array<[number, number]> = [];
  points.forEach((p, i) => {
    if (p.minor === null) {
      if (run.length) out.push(run);
      run = [];
      return;
    }
    run.push([i, p.minor]);
  });
  if (run.length) out.push(run);
  return out;
}

function linePath(points: readonly Plot[], s: Scale): string {
  return segments(points)
    .map((run) =>
      run
        .map(([i, v], k) => `${k === 0 ? "M" : "L"}${s.x(i)},${s.y(v)}`)
        .join(" "),
    )
    .join(" ");
}

/** The extreme a reader is owed on the axis: the served FIGURE holding it, so
 *  the label goes through `<ProjectedAmount>` rather than being a string this
 *  file formatted from a bare number. */
function extreme(points: readonly Plot[], pick: "max" | "min"): Plot | null {
  const served = points.filter((p) => p.minor !== null);
  if (!served.length) return null;
  return served.reduce((a, b) =>
    pick === "max"
      ? (b.minor as number) > (a.minor as number)
        ? b
        : a
      : (b.minor as number) < (a.minor as number)
        ? b
        : a,
  );
}

/** The last period the engine served on a line. For a RUNNING TOTAL that is
 *  the figure the reader is after — the total over the horizon — and it is not
 *  the extreme, which on a plan that spends cash is merely the least negative
 *  point on the way down. */
function lastServed(points: readonly Plot[]): Plot | null {
  const served = points.filter((p) => p.minor !== null);
  return served.length ? served[served.length - 1] : null;
}

export interface ChartProps {
  readonly basePeriodLabel: string;
  readonly format: (value: number) => string;
  readonly projectedLabel: string;
}

function Swatch({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className={`inline-block h-[3px] w-4 rounded-sm ${className}`} />
      {label}
    </span>
  );
}

function ChartFrame({
  id,
  title,
  grain,
  legend,
  children,
  footer,
}: {
  id: string;
  title: string;
  grain: string;
  legend: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <section
      data-testid={`forecast-chart-${id}`}
      className="rounded-xl border border-rule bg-surface"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-rule px-4 py-3">
        <h3 className="font-mono text-[11px] uppercase tracking-wider text-ink-mute">
          {title}
        </h3>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-soft">
          {legend}
        </div>
        {/* THE GRAIN. The charts and the statement table are on different
            period grids and the reader is told which, not left to assume. */}
        <p
          data-testid={`forecast-chart-grain-${id}`}
          className="w-full font-mono text-[10px] uppercase tracking-wider text-ink-mute"
        >
          {grain}
        </p>
      </header>
      <div className="px-2 pb-2 pt-3">{children}</div>
      {footer ? (
        <div className="border-t border-rule px-4 py-2 text-[11px] leading-snug text-ink-soft">
          {footer}
        </div>
      ) : null}
    </section>
  );
}

/** The index of the first ANNUAL period, or -1 when every point is one grain.
 *
 *  `series` is served over the months of plan year one and then over the
 *  annual periods. A month and a year are not the same length, so the step
 *  where the grain changes is drawn and labelled rather than left to read as
 *  growth. The flow charts avoid the question entirely by standing on the
 *  engine's own FY aggregates; the CASH chart keeps every served point
 *  because cash is a level, not a total over a length. */
function grainBreak(points: readonly Plot[]): number {
  return points.findIndex((p) => !/^\d{4}-\d{2}$/.test(p.period));
}

function GrainDivider({
  points,
  s,
  monthsLabel,
  yearsLabel,
}: {
  points: readonly Plot[];
  s: Scale;
  monthsLabel: string;
  yearsLabel: string;
}) {
  const at = grainBreak(points);
  if (at <= 0 || at >= points.length) return null;
  const x = PAD_L + s.band * at;
  return (
    <g data-testid="forecast-chart-grain-break">
      <line x1={x} y1={PAD_T} x2={x} y2={PAD_T + INNER_H} className="stroke-rule" strokeDasharray="3 3" />
      <text x={x - 4} y={PAD_T + 9} textAnchor="end" fontSize="8" className="fill-ink-mute font-mono">
        {monthsLabel}
      </text>
      <text x={x + 4} y={PAD_T + 9} textAnchor="start" fontSize="8" className="fill-ink-mute font-mono">
        {yearsLabel}
      </text>
    </g>
  );
}

/** X labels thin out on a narrow screen by rendering every other one; the
 *  first and last always render, so the span is never ambiguous. */
function XAxis({ points, s }: { points: readonly Plot[]; s: Scale }) {
  const every = points.length > 8 ? 3 : 1;
  return (
    <>
      {points.map((p, i) =>
        i % every === 0 || i === points.length - 1 ? (
          <text
            key={p.period}
            x={s.x(i)}
            y={H - 6}
            textAnchor="middle"
            fontSize="9"
            className="fill-ink-mute font-mono"
          >
            {p.period}
          </text>
        ) : null,
      )}
    </>
  );
}

function AxisReadout({
  label,
  plot,
  props,
  testid,
}: {
  label: string;
  plot: Plot | null;
  props: ChartProps;
  testid: string;
}) {
  if (!plot) return null;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-ink-soft">
      <span className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">
        {label}
      </span>
      <span data-testid={testid}>
        <ProjectedAmount
          figure={plot.result}
          basePeriodLabel={props.basePeriodLabel}
          format={props.format}
          projectedLabel={props.projectedLabel}
          className="tabular-nums text-ink"
        />
      </span>
    </span>
  );
}

/** The engine's own words for the periods it declined to serve. A chart that
 *  simply stops is a chart with an unexplained edge. */
function RefusedNote({ points }: { points: readonly Plot[] }) {
  const { t } = useTranslation();
  const refused = points.filter((p) => p.minor === null);
  if (!refused.length) return null;
  const first = refused[0].result;
  return (
    <p data-testid="forecast-chart-refused">
      {t("forecast.chart.refused", "Not served from {{period}}: ", {
        period: refused[0].period,
      })}
      {"refused" in first ? first.detail : ""}
    </p>
  );
}

// ── 1. Revenue and EBITDA ────────────────────────────────────────────────

export function RevenueEbitdaChart({
  revenue,
  ebitda,
  ...props
}: ChartProps & {
  revenue: readonly SeriesPoint[];
  ebitda: readonly SeriesPoint[];
}) {
  const { t } = useTranslation();
  const rev = useMemo(() => plotted(revenue, props.basePeriodLabel), [revenue, props.basePeriodLabel]);
  const eb = useMemo(() => plotted(ebitda, props.basePeriodLabel), [ebitda, props.basePeriodLabel]);
  const s = scaleFor([rev, eb], rev.length);
  if (!rev.length) return null;
  return (
    <ChartFrame
      id="revenue-ebitda"
      title={t("forecast.chart.trajectory", "Revenue and EBITDA")}
      grain={t("forecast.chart.grain", "Served periods: {{first}} → {{last}}", {
        first: rev[0].period,
        last: rev[rev.length - 1].period,
      })}
      legend={
        <>
          <Swatch className="bg-brand" label={t("forecast.chart.revenue", "Revenue")} />
          <Swatch className="bg-caution" label={t("forecast.chart.ebitda", "EBITDA")} />
          <AxisReadout
            label={t("forecast.chart.peak", "Peak")}
            plot={extreme(rev, "max")}
            props={props}
            testid="forecast-chart-revenue-peak"
          />
        </>
      }
      footer={<RefusedNote points={rev} />}
    >
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img">
        <line x1={PAD_L} y1={s.zero} x2={W - PAD_R} y2={s.zero} className="stroke-rule" strokeWidth="1" />
        <path d={linePath(rev, s)} fill="none" className="stroke-brand" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        <path d={linePath(eb, s)} fill="none" className="stroke-caution" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        <XAxis points={rev} s={s} />
      </svg>
    </ChartFrame>
  );
}

// ── 2. The cash curve ────────────────────────────────────────────────────

export function CashCurveChart({
  closingCash,
  minCash,
  troughPeriod,
  troughResult,
  fundingGapPeriods,
  ...props
}: ChartProps & {
  closingCash: readonly SeriesPoint[];
  minCash: readonly SeriesPoint[];
  troughPeriod: string | null;
  troughResult: ProjectedResult;
  fundingGapPeriods: readonly string[];
}) {
  const { t } = useTranslation();
  const cash = useMemo(() => plotted(closingCash, props.basePeriodLabel), [closingCash, props.basePeriodLabel]);
  const floor = useMemo(() => plotted(minCash, props.basePeriodLabel), [minCash, props.basePeriodLabel]);
  const s = scaleFor([cash, floor], cash.length);
  if (!cash.length) return null;
  const gap = new Set(fundingGapPeriods);
  const troughIndex = cash.findIndex((p) => p.period === troughPeriod);
  return (
    <ChartFrame
      id="cash-curve"
      title={t("forecast.chart.cash", "Cash")}
      grain={t("forecast.chart.grain", "Served periods: {{first}} → {{last}}", {
        first: cash[0].period,
        last: cash[cash.length - 1].period,
      })}
      legend={
        <>
          <Swatch className="bg-brand" label={t("forecast.chart.closingCash", "Closing cash")} />
          <Swatch className="bg-caution" label={t("forecast.chart.minCash", "Cash floor")} />
          <Swatch className="bg-alert/30" label={t("forecast.chart.onTheLine", "On the funding line")} />
          <span className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-ink-soft">
            <span className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">
              {t("forecast.chart.trough", "Trough")}
            </span>
            <span data-testid="forecast-chart-trough">
              <ProjectedAmount
                figure={troughResult}
                basePeriodLabel={props.basePeriodLabel}
                format={props.format}
                projectedLabel={props.projectedLabel}
                className="tabular-nums text-ink"
              />
            </span>
            {troughPeriod ? (
              <span className="font-mono text-[10px] text-ink-mute">{troughPeriod}</span>
            ) : null}
          </span>
        </>
      }
      footer={<RefusedNote points={cash} />}
    >
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img">
        {/* THE SHADED BAND IS SERVED (`summary.funding_gap_periods`), not
            inferred from the revolver line here. */}
        {cash.map((p, i) =>
          gap.has(p.period) ? (
            <rect
              key={`gap-${p.period}`}
              data-testid={`forecast-chart-gap-${p.period}`}
              x={PAD_L + s.band * i}
              y={PAD_T}
              width={s.band}
              height={INNER_H}
              className="fill-alert/15"
            />
          ) : null,
        )}
        <line x1={PAD_L} y1={s.zero} x2={W - PAD_R} y2={s.zero} className="stroke-rule" strokeWidth="1" />
        <path d={linePath(floor, s)} fill="none" className="stroke-caution" strokeWidth="1.5" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
        <path d={linePath(cash, s)} fill="none" className="stroke-brand" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        {troughIndex >= 0 && cash[troughIndex].minor !== null ? (
          <circle
            data-testid="forecast-chart-trough-mark"
            cx={s.x(troughIndex)}
            cy={s.y(cash[troughIndex].minor as number)}
            r="4"
            className="fill-alert"
          />
        ) : null}
        <GrainDivider
          points={cash}
          s={s}
          monthsLabel={t("forecast.chart.months", "months")}
          yearsLabel={t("forecast.chart.years", "years")}
        />
        <XAxis points={cash} s={s} />
      </svg>
    </ChartFrame>
  );
}

// ── 3. Free cash flow ────────────────────────────────────────────────────

export function FreeCashFlowChart({
  fcf,
  cumulative,
  ...props
}: ChartProps & {
  fcf: readonly SeriesPoint[];
  cumulative: readonly SeriesPoint[];
}) {
  const { t } = useTranslation();
  const bars = useMemo(() => plotted(fcf, props.basePeriodLabel), [fcf, props.basePeriodLabel]);
  const line = useMemo(() => plotted(cumulative, props.basePeriodLabel), [cumulative, props.basePeriodLabel]);
  const barsUntil = grainBreak(bars);
  /** TWO SERIES, TWO VERTICAL SCALES.
   *
   *  A per-period FLOW and a RUNNING TOTAL of that same flow do not share a
   *  range: by the end of the horizon the cumulative is the sum of every bar,
   *  so on one domain it sets the top and every bar renders a sliver on the
   *  axis — the chart read as a flat line. Each gets its own scale, the x band
   *  is shared so the periods still line up, and the header says so rather than
   *  leaving a reader to compare two heights that are not comparable.
   *
   *  The bar scale is built from the bars that are actually DRAWN. The annual
   *  points are deliberately not painted (no FY aggregate for `fcf` exists on
   *  the wire), and letting an undrawn point widen the domain would squash the
   *  ones that are. */
  const drawn = bars.filter((p, i) => !(barsUntil >= 0 && i >= barsUntil));
  const sBars = scaleFor([drawn], bars.length);
  const sLine = scaleFor([line], bars.length);
  if (!bars.length) return null;
  return (
    <ChartFrame
      id="fcf"
      title={t("forecast.chart.fcf", "Free cash flow")}
      grain={t("forecast.chart.grain", "Served periods: {{first}} → {{last}}", {
        first: bars[0].period,
        last: bars[bars.length - 1].period,
      })}
      legend={
        <>
          <Swatch className="bg-caution" label={t("forecast.chart.perPeriod", "Per period")} />
          <Swatch className="bg-brand" label={t("forecast.chart.cumulative", "Cumulative")} />
          <AxisReadout
            label={t("forecast.chart.weakest", "Weakest")}
            plot={extreme(bars, "min")}
            props={props}
            testid="forecast-chart-fcf-weakest"
          />
          <AxisReadout
            label={t("forecast.chart.overHorizon", "Over the horizon")}
            plot={lastServed(line)}
            props={props}
            testid="forecast-chart-fcf-cumulative"
          />
        </>
      }
      footer={
        <>
          <p data-testid="forecast-chart-fcf-scale-note">
            {t(
              "forecast.chart.fcfScaleNote",
              "The bars and the cumulative line are drawn on separate vertical scales: a running total ends at the sum of every bar, so on one scale the bars would be a flat line on the axis. Compare each series with itself, not with the other.",
            )}
          </p>
          {barsUntil > 0 ? (
            <p data-testid="forecast-chart-fcf-grain-note">
              {t(
                "forecast.chart.fcfBarsNote",
                "The per-period bars stop where the monthly periods do: this engine serves no financial-year total for free cash flow, and one summed here would be a figure the projection never stated. The cumulative line runs the whole horizon.",
              )}
            </p>
          ) : null}
          <RefusedNote points={bars} />
        </>
      }
    >
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img">
        <g data-scale="bars">
          <line x1={PAD_L} y1={sBars.zero} x2={W - PAD_R} y2={sBars.zero} className="stroke-rule" strokeWidth="1" />
          {bars.map((p, i) =>
            p.minor === null || (barsUntil >= 0 && i >= barsUntil) ? null : (
              <rect
                key={p.period}
                data-testid={`forecast-chart-fcf-bar-${p.period}`}
                x={PAD_L + sBars.band * i + sBars.band * 0.2}
                y={Math.min(sBars.zero, sBars.y(p.minor))}
                width={sBars.band * 0.6}
                height={Math.max(1, Math.abs(sBars.y(p.minor) - sBars.zero))}
                className={p.minor < 0 ? "fill-alert/70" : "fill-caution"}
              />
            ),
          )}
        </g>
        <g data-scale="cumulative">
          <path d={linePath(line, sLine)} fill="none" className="stroke-brand" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        </g>
        <GrainDivider
          points={bars}
          s={sBars}
          monthsLabel={t("forecast.chart.months", "months")}
          yearsLabel={t("forecast.chart.years", "years")}
        />
        <XAxis points={bars} s={sBars} />
      </svg>
    </ChartFrame>
  );
}

// ── 4. Capex against depreciation ────────────────────────────────────────

export function CapexDepreciationChart({
  capex,
  depreciation,
  ...props
}: ChartProps & {
  capex: readonly SeriesPoint[];
  depreciation: readonly SeriesPoint[];
}) {
  const { t } = useTranslation();
  // BOTH ARRIVE NEGATIVE from the engine and both are plotted on the sign the
  // engine gave them. Flipping one so the bars read nicely is a display-side
  // sign change on a projected figure, and the engine's sign is the fact.
  const cx = useMemo(() => plotted(capex, props.basePeriodLabel), [capex, props.basePeriodLabel]);
  const dep = useMemo(() => plotted(depreciation, props.basePeriodLabel), [depreciation, props.basePeriodLabel]);
  const s = scaleFor([cx, dep], cx.length);
  if (!cx.length) return null;
  return (
    <ChartFrame
      id="capex-depreciation"
      title={t("forecast.chart.capex", "Capex and depreciation")}
      grain={t("forecast.chart.grain", "Served periods: {{first}} → {{last}}", {
        first: cx[0].period,
        last: cx[cx.length - 1].period,
      })}
      legend={
        <>
          <Swatch className="bg-brand" label={t("forecast.chart.capexBar", "Capex")} />
          <Swatch className="bg-ink-mute" label={t("forecast.chart.depreciation", "Depreciation")} />
          <span className="whitespace-nowrap font-mono text-[10px] uppercase tracking-wider text-ink-mute">
            {t("forecast.chart.signNote", "Both are cash and charge OUT, as the engine signs them")}
          </span>
        </>
      }
      footer={<RefusedNote points={cx} />}
    >
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img">
        <line x1={PAD_L} y1={s.zero} x2={W - PAD_R} y2={s.zero} className="stroke-rule" strokeWidth="1" />
        {cx.map((p, i) =>
          p.minor === null ? null : (
            <rect
              key={`capex-${p.period}`}
              x={PAD_L + s.band * i + s.band * 0.12}
              y={Math.min(s.zero, s.y(p.minor))}
              width={s.band * 0.36}
              height={Math.max(1, Math.abs(s.y(p.minor) - s.zero))}
              className="fill-brand"
            />
          ),
        )}
        {dep.map((p, i) =>
          p.minor === null ? null : (
            <rect
              key={`dep-${p.period}`}
              x={PAD_L + s.band * i + s.band * 0.52}
              y={Math.min(s.zero, s.y(p.minor))}
              width={s.band * 0.36}
              height={Math.max(1, Math.abs(s.y(p.minor) - s.zero))}
              className="fill-ink-mute"
            />
          ),
        )}
        <XAxis points={cx} s={s} />
      </svg>
    </ChartFrame>
  );
}
