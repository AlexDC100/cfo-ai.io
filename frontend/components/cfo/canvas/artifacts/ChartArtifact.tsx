// THE ARTIFACTS — 1/8 CHART. bar · line · stacked · WATERFALL · donut.
//
// Hand-drawn SVG over `artifactGeometry`, painted in tokens only. There
// is a chart library in this repo's package.json and it is deliberately
// not imported here: a library brings its own palette, grid, type scale
// and tooltip, and every one of those is a competing design system
// arriving under a component name. The Instrument has ONE accent,
// hairline rules and a mono face, in both Paper and Terminal — a chart
// that belongs to it has to be drawn with its own tokens.
//
// ── The signature: the waterfall ─────────────────────────────────────
//
// An EBITDA bridge or a cash movement is the one chart in finance that
// does arithmetic in front of the reader, and it is therefore the one
// where a rendering can lie without a single wrong input: drop a step,
// and every bar left is still correct while the story inverts. Two
// defences, both in `artifactResolve` rather than here:
//
//   · the running total is summed in INTEGER MINOR UNITS, so the closing
//     bar cannot drift off the engine's own figure by a cent;
//   · when the spec names the engine's own closing total, the derived
//     sum is COMPARED against it and a disagreement is printed on the
//     card. Neither figure is adjusted to meet the other. Two totals
//     that differ is information; picking the prettier one is how a
//     wrong number gets a chart drawn around it.
//
// ── Every figure is an <Amount> ──────────────────────────────────────
//
// Nothing in this file writes a digit into the DOM. Axis readouts, the
// hover card, the legend and the totals all go through `<Amount>`, which
// owns locale, magnitude, currency and the provenance affordance. That
// is why hovering a bar can name its source cell: the figure never
// stopped being a resolved fact on its way to the pixel.

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import "./artifactI18n";
import { ArtifactFigure } from "./ArtifactFigure";
import { artifactLabel } from "./artifactI18n";
import type { ChartSpec } from "./artifactSpec";
import {
  figuresOf,
  precisionDigits,
  resolveChart,
  type ResolvedChart,
  type ResolvedFigure,
} from "./artifactResolve";
import {
  DEFAULT_BOX,
  barLayout,
  donutLayout,
  lineLayout,
  stackLayout,
  waterfallLayout,
  type Box,
} from "./artifactGeometry";
import type { CapsuleEvidence } from "@/components/instrument/shell/capsuleAnswer/capsuleAnswerTypes";

// ── the one accent, at declared strengths ──────────────────────────────
//
// A stacked chart needs to separate its bands. The Instrument forbids a
// second hue, so separation is by OPACITY of the single accent — a ramp
// the eye reads as one material at different depths rather than as a
// palette. Semantic red stays reserved: it appears only on a NEGATIVE
// magnitude, never as "series 2".
const BAND_ALPHA = [1, 0.72, 0.52, 0.36, 0.24, 0.16] as const;

function bandFill(index: number): string {
  const a = BAND_ALPHA[Math.min(index, BAND_ALPHA.length - 1)];
  return `hsl(var(--brand) / ${a})`;
}

const NEGATIVE_FILL = "hsl(var(--alert))";
const RULE_STROKE = "hsl(var(--rule-strong))";
const AXIS_STROKE = "hsl(var(--rule))";

// ══════════════════════════════════════════════════════════════════════

export interface ChartArtifactProps {
  chart: ResolvedChart;
  /** Index of the hovered point, lifted so the readout can live outside
   *  the SVG (an SVG-native tooltip cannot carry an `<Amount>`). */
  onHover?: (figure: ResolvedFigure | null) => void;
  box?: Box;
}

interface HoverTarget {
  seriesIndex: number;
  pointIndex: number;
}

function ChartReadout({
  figure,
  label,
  digits,
}: {
  figure: ResolvedFigure;
  label: string;
  digits: number | undefined;
}) {
  return (
    <span className="inline-flex items-baseline gap-2">
      <span className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-mute">
        {label}
      </span>
      <ArtifactFigure figure={figure} fractionDigits={digits} className="text-[13px] text-ink" />
    </span>
  );
}

// ── the plots ──────────────────────────────────────────────────────────

function BarPlot({
  chart,
  box,
  hover,
  setHover,
}: {
  chart: ResolvedChart;
  box: Box;
  hover: HoverTarget | null;
  setHover: (h: HoverTarget | null) => void;
}) {
  const series = chart.series[0];
  const values = series ? series.points.map((p) => (p.figure.present ? p.figure.value : 0)) : [];
  const layout = useMemo(() => barLayout(values, box), [values, box]);
  return (
    <svg
      viewBox={`0 0 ${box.width} ${box.height}`}
      role="img"
      className="h-auto w-full"
      preserveAspectRatio="none"
    >
      {layout.zeroY !== null && (
        <line
          x1={0}
          x2={box.width}
          y1={layout.zeroY}
          y2={layout.zeroY}
          stroke={RULE_STROKE}
          strokeWidth={1}
        />
      )}
      {layout.bars.map((bar, i) => (
        <rect
          key={i}
          data-testid="artifact-chart-bar"
          x={bar.x}
          y={bar.y}
          width={bar.w}
          height={bar.h}
          fill={bar.negative ? NEGATIVE_FILL : bandFill(0)}
          opacity={hover && hover.pointIndex !== i ? 0.45 : 1}
          onMouseEnter={() => setHover({ seriesIndex: 0, pointIndex: i })}
          onMouseLeave={() => setHover(null)}
        />
      ))}
    </svg>
  );
}

function LinePlot({
  chart,
  box,
  hover,
  setHover,
}: {
  chart: ResolvedChart;
  box: Box;
  hover: HoverTarget | null;
  setHover: (h: HoverTarget | null) => void;
}) {
  return (
    <svg viewBox={`0 0 ${box.width} ${box.height}`} role="img" className="h-auto w-full">
      {chart.series.map((s, si) => {
        const values = s.points.map((p) => (p.figure.present ? p.figure.value : 0));
        const layout = lineLayout(values, box);
        return (
          <g key={si}>
            {si === 0 && layout.zeroY !== null && (
              <line
                x1={0}
                x2={box.width}
                y1={layout.zeroY}
                y2={layout.zeroY}
                stroke={AXIS_STROKE}
                strokeWidth={1}
              />
            )}
            <path
              data-testid="artifact-chart-line"
              d={layout.path}
              fill="none"
              stroke={bandFill(si)}
              strokeWidth={1.5}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {layout.points.map((p, pi) => (
              <circle
                key={pi}
                data-testid="artifact-chart-point"
                cx={p.x}
                cy={p.y}
                r={hover && hover.seriesIndex === si && hover.pointIndex === pi ? 4 : 2.5}
                fill="hsl(var(--surface))"
                stroke={bandFill(si)}
                strokeWidth={1.5}
                onMouseEnter={() => setHover({ seriesIndex: si, pointIndex: pi })}
                onMouseLeave={() => setHover(null)}
              />
            ))}
          </g>
        );
      })}
    </svg>
  );
}

function StackedPlot({
  chart,
  box,
  setHover,
}: {
  chart: ResolvedChart;
  box: Box;
  setHover: (h: HoverTarget | null) => void;
}) {
  const series = chart.series.map((s) =>
    s.points.map((p) => (p.figure.present ? p.figure.value : 0)),
  );
  const layout = useMemo(() => stackLayout(series, box), [series, box]);
  return (
    <svg
      viewBox={`0 0 ${box.width} ${box.height}`}
      role="img"
      className="h-auto w-full"
      preserveAspectRatio="none"
    >
      {layout.columns.map((segments, ci) =>
        segments.map((seg, si) => (
          <rect
            key={`${ci}-${si}`}
            data-testid="artifact-chart-segment"
            x={seg.x}
            y={seg.y}
            width={seg.w}
            height={seg.h}
            fill={seg.negative ? NEGATIVE_FILL : bandFill(seg.seriesIndex)}
            onMouseEnter={() => setHover({ seriesIndex: seg.seriesIndex, pointIndex: ci })}
            onMouseLeave={() => setHover(null)}
          />
        )),
      )}
    </svg>
  );
}

function WaterfallPlot({
  chart,
  box,
  hover,
  setHover,
}: {
  chart: ResolvedChart;
  box: Box;
  hover: HoverTarget | null;
  setHover: (h: HoverTarget | null) => void;
}) {
  const steps = chart.steps ?? [];
  const spans = useMemo(
    () => steps.map((s) => ({ from: s.fromMinor, to: s.toMinor })),
    [steps],
  );
  const layout = useMemo(() => waterfallLayout(spans, box), [spans, box]);
  return (
    <svg
      viewBox={`0 0 ${box.width} ${box.height}`}
      role="img"
      className="h-auto w-full"
      preserveAspectRatio="none"
    >
      {layout.zeroY !== null && (
        <line
          x1={0}
          x2={box.width}
          y1={layout.zeroY}
          y2={layout.zeroY}
          stroke={RULE_STROKE}
          strokeWidth={1}
        />
      )}
      {layout.bars.map((bar, i) => (
        <g key={i}>
          {bar.connector && (
            <line
              data-testid="artifact-chart-connector"
              x1={bar.connector.x1}
              y1={bar.connector.y1}
              x2={bar.connector.x2}
              y2={bar.connector.y2}
              stroke={AXIS_STROKE}
              strokeWidth={1}
              strokeDasharray="2 2"
            />
          )}
          <rect
            data-testid="artifact-chart-step"
            x={bar.x}
            y={bar.y}
            width={bar.w}
            height={bar.h}
            fill={bar.negative ? NEGATIVE_FILL : bandFill(0)}
            opacity={hover && hover.pointIndex !== i ? 0.45 : 1}
            onMouseEnter={() => setHover({ seriesIndex: 0, pointIndex: i })}
            onMouseLeave={() => setHover(null)}
          />
        </g>
      ))}
    </svg>
  );
}

function DonutPlot({
  chart,
  setHover,
}: {
  chart: ResolvedChart;
  setHover: (h: HoverTarget | null) => void;
}) {
  const { t } = useTranslation();
  const series = chart.series[0];
  const values = series ? series.points.map((p) => (p.figure.present ? p.figure.value : 0)) : [];
  const layout = useMemo(() => donutLayout(values), [values]);
  if (layout.refused) {
    return (
      <p data-testid="artifact-chart-refusal" className="py-6 text-[12px] text-ink-soft">
        {layout.refused === "negative"
          ? t("artifact.chart.donutNegative")
          : t("artifact.chart.donutEmpty")}
      </p>
    );
  }
  const size = layout.cx * 2;
  return (
    <svg viewBox={`0 0 ${size} ${size}`} role="img" className="mx-auto h-auto w-[168px]">
      {layout.slices.map((slice, i) => (
        <path
          key={i}
          data-testid="artifact-chart-slice"
          d={slice.path}
          fill="none"
          stroke={bandFill(i)}
          strokeWidth={layout.thickness}
          onMouseEnter={() => setHover({ seriesIndex: 0, pointIndex: i })}
          onMouseLeave={() => setHover(null)}
        />
      ))}
    </svg>
  );
}

// ══════════════════════════════════════════════════════════════════════

export function ChartArtifact({ chart, onHover, box = DEFAULT_BOX }: ChartArtifactProps) {
  const { t } = useTranslation();
  const [hover, setHoverState] = useState<HoverTarget | null>(null);
  const digits = precisionDigits(chart.precision);

  const setHover = (h: HoverTarget | null) => {
    setHoverState(h);
    if (!onHover) return;
    onHover(h ? figureAt(chart, h) : null);
  };

  // A chart with no figure on it until you hover is a picture, not an
  // instrument — and on a touch screen there is no hover at all. So the
  // readout shows the LATEST point at rest and the hovered one while
  // pointing. Nothing is derived to do it: `restFigure` picks an
  // already-resolved point, it does not compute a summary.
  const rest = restFigure(chart);
  const hovered = hover ? figureAt(chart, hover) : rest.figure;
  const hoveredLabel = hover ? labelAt(chart, hover) : rest.label;

  const empty =
    chart.form === "waterfall"
      ? !chart.steps || chart.steps.length === 0
      : chart.series.length === 0;

  if (empty) {
    return (
      <p data-testid="artifact-chart-empty" className="py-6 text-[12px] text-ink-soft">
        {chart.form === "waterfall"
          ? t("artifact.chart.waterfallRefused")
          : t("artifact.chart.empty")}
      </p>
    );
  }

  return (
    <div data-testid="artifact-chart" data-chart-form={chart.form}>
      <div className="relative">
        {chart.form === "bar" && (
          <BarPlot chart={chart} box={box} hover={hover} setHover={setHover} />
        )}
        {chart.form === "line" && (
          <LinePlot chart={chart} box={box} hover={hover} setHover={setHover} />
        )}
        {chart.form === "stacked" && <StackedPlot chart={chart} box={box} setHover={setHover} />}
        {chart.form === "waterfall" && (
          <WaterfallPlot chart={chart} box={box} hover={hover} setHover={setHover} />
        )}
        {chart.form === "donut" && <DonutPlot chart={chart} setHover={setHover} />}
      </div>

      {/* A ring with no labels is decoration. The legend carries the
          label and the FIGURE for every slice — through <Amount>, like
          everything else. */}
      {chart.form === "donut" && chart.series[0] && (
        <ul
          data-testid="artifact-chart-legend"
          className="mt-2 grid list-none grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3"
        >
          {chart.series[0].points.map((p, i) => (
            <li key={i} className="flex items-baseline justify-between gap-2">
              <span className="truncate font-mono text-[10px] uppercase tracking-[0.06em] text-ink-mute">
                <span
                  aria-hidden="true"
                  className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle"
                  style={{ background: bandFill(i) }}
                />
                {artifactLabel(t, p.label || chart.series[0].label)}
              </span>
              <ArtifactFigure figure={p.figure} fractionDigits={digits} className="text-[12px] text-ink" />
            </li>
          ))}
        </ul>
      )}

      {/* Ticks. The label is text; the VALUE beside it is an <Amount>,
          so a tick can never be a numeral this component typed — it is
          the same resolved fact the bar was drawn from, with the same
          provenance on hover.

          Values are printed only while they FIT: past
          `TICK_VALUE_LIMIT` points they would overlap and stop being
          readable, and an unreadable number is worse than a readable
          absence. Above that count the readout below carries the value
          and the pointer selects which one. */}
      {chart.form !== "donut" && (
        <ol
          data-testid="artifact-chart-ticks"
          className="mt-1 flex list-none justify-between gap-1 px-1 font-mono text-[10px] uppercase tracking-[0.05em] text-ink-mute"
        >
          {tickPoints(chart).map((point, i) => (
            <li key={i} className="min-w-0 truncate">
              <span className="block truncate">{artifactLabel(t, point.label)}</span>
              {tickPoints(chart).length <= TICK_VALUE_LIMIT && point.figure && (
                <ArtifactFigure
                  figure={point.figure}
                  fractionDigits={digits}
                  className="text-[11px] normal-case tracking-normal text-ink-soft"
                />
              )}
            </li>
          ))}
        </ol>
      )}

      {/* Readout: one line, always present, so the card never reflows
          when the pointer lands on a bar (CLS 0). */}
      <div
        data-testid="artifact-chart-readout"
        className="mt-2 flex min-h-[22px] items-baseline gap-3 border-t border-rule-soft pt-2"
      >
        {chart.axisLabel && (
          <span className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-faint">
            {artifactLabel(t, chart.axisLabel)}
          </span>
        )}
        {hovered && <ChartReadout figure={hovered} label={hoveredLabel} digits={digits} />}
      </div>

      {/* The bridge's reconciliation line. Printed whenever the spec
          named a total — agreeing OR not. Silence on agreement would
          make the disagreement message look like a bug report. */}
      {chart.totalAgrees !== null && chart.total && chart.steps && (
        <div
          data-testid="artifact-chart-reconciliation"
          data-agrees={chart.totalAgrees ? "true" : "false"}
          className={`mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-sm border px-2 py-1.5 text-[11px] ${
            chart.totalAgrees
              ? "border-rule bg-bg-2 text-ink-soft"
              : "border-alert/40 bg-alert-tint text-alert"
          }`}
        >
          <span>
            {chart.totalAgrees
              ? t("artifact.chart.totalAgrees")
              : t("artifact.chart.totalDisagrees")}
          </span>
          <span className="inline-flex items-baseline gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-mute">
              {t("artifact.chart.reportedTotal")}
            </span>
            <ArtifactFigure figure={chart.total} />
          </span>
          <span className="inline-flex items-baseline gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-mute">
              {t("artifact.chart.derivedTotal")}
            </span>
            {(() => {
              const last = chart.steps[chart.steps.length - 1];
              return last ? <ArtifactFigure figure={last.cumulative} /> : null;
            })()}
          </span>
        </div>
      )}
    </div>
  );
}

// ── helpers ────────────────────────────────────────────────────────────

function figureAt(chart: ResolvedChart, h: HoverTarget): ResolvedFigure | null {
  if (chart.form === "waterfall") {
    const step = chart.steps?.[h.pointIndex];
    return step ? step.figure : null;
  }
  const s = chart.series[h.seriesIndex];
  const p = s?.points[h.pointIndex];
  return p ? p.figure : null;
}

function labelAt(chart: ResolvedChart, h: HoverTarget): string {
  if (chart.form === "waterfall") return chart.steps?.[h.pointIndex]?.label ?? "";
  const s = chart.series[h.seriesIndex];
  return s?.points[h.pointIndex]?.label || s?.label || "";
}

/** The point the readout shows when nothing is hovered: the LATEST
 *  point of the first series, or a bridge's closing cumulative. Always
 *  an already-resolved figure — never a computed summary, because a
 *  summary the reader did not ask for is a figure with no question
 *  behind it. */
function restFigure(chart: ResolvedChart): { figure: ResolvedFigure | null; label: string } {
  if (chart.form === "waterfall") {
    const last = chart.steps?.[chart.steps.length - 1];
    return last ? { figure: last.cumulative, label: last.label } : { figure: null, label: "" };
  }
  const series = chart.series[0];
  if (!series || series.points.length === 0) return { figure: null, label: "" };
  const last = series.points[series.points.length - 1];
  return { figure: last.figure, label: last.label || series.label };
}

/** Above this many points a per-tick value stops fitting. Six is where
 *  a 640px plot's slots fall below the width of a grouped money figure
 *  in mono at 11px; past it the ticks collide and the reader loses both
 *  the labels and the values. */
export const TICK_VALUE_LIMIT = 6;

function tickPoints(
  chart: ResolvedChart,
): Array<{ label: string; figure: ResolvedFigure | null }> {
  if (chart.form === "waterfall") {
    return (chart.steps ?? []).map((s) => ({ label: s.label, figure: s.figure }));
  }
  const first = chart.series[0];
  if (!first) return [];
  return first.points.map((p) => ({ label: p.label, figure: p.figure }));
}

/** Convenience for hosts that hold a spec + evidence rather than an
 *  already-resolved chart. Kept beside the component so there is one
 *  obvious entry point per artifact kind. */
export function chartFrom(spec: ChartSpec, evidence: CapsuleEvidence, trust: string | null = null) {
  const { artifact, chart } = resolveChart(spec, evidence, trust);
  return { artifact, chart, figures: figuresOf(chart) };
}
