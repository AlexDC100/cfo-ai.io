// THE ARTIFACTS — GEOMETRY. Pure numbers in, pure coordinates out.
//
// Every chart in this lane is hand-drawn SVG over these functions. That
// is a deliberate refusal of the chart library sitting in package.json:
// a library brings its own palette, its own type scale, its own grid and
// its own tooltip, and every one of those is a second design system
// smuggled in under a component name. The Instrument has ONE accent, one
// mono face and hairline rules; a chart that looks like the rest of the
// product has to be drawn with the product's own tokens.
//
// The functions here are pure and total: no clock, no randomness, no
// DOM, no rounding of the underlying values. Same input always draws the
// same path, which is what makes a screenshot gate meaningful and what
// lets the geometry be unit-tested without a renderer.
//
// Coordinates are rounded to two decimals on the way out — enough to
// keep a path stable across platforms, not enough to move a pixel.

export interface Box {
  width: number;
  height: number;
  /** Inner padding. Axis labels live outside the plot area. */
  padX: number;
  padY: number;
}

export const DEFAULT_BOX: Box = { width: 640, height: 220, padX: 8, padY: 10 };

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Plot area, after padding. */
export function plotArea(box: Box): { x: number; y: number; w: number; h: number } {
  return {
    x: box.padX,
    y: box.padY,
    w: Math.max(0, box.width - box.padX * 2),
    h: Math.max(0, box.height - box.padY * 2),
  };
}

// ── scale ──────────────────────────────────────────────────────────────

export interface Scale {
  min: number;
  max: number;
  /** True when every value is identical — callers draw a flat baseline
   *  rather than dividing by a zero range. */
  flat: boolean;
  /** Where zero sits in the range, 0..1 from the BOTTOM. Null when the
   *  range excludes zero, in which case there is no zero rule to draw. */
  zeroFraction: number | null;
}

/**
 * A scale that always includes zero for magnitude charts. A bar chart
 * whose axis starts at 90% of the smallest bar exaggerates every
 * difference on it; that is the single most common way a correct number
 * tells a false story, so it is not an option here — `includeZero` is
 * the default and the caller has to ask for anything else.
 */
export function scaleOf(values: readonly number[], includeZero = true): Scale {
  const usable = values.filter((v) => Number.isFinite(v));
  if (usable.length === 0) return { min: 0, max: 0, flat: true, zeroFraction: null };
  let min = Math.min(...usable);
  let max = Math.max(...usable);
  if (includeZero) {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }
  const flat = max - min === 0;
  const range = flat ? 1 : max - min;
  const zeroFraction = min <= 0 && max >= 0 ? (0 - min) / range : null;
  return { min, max, flat, zeroFraction };
}

/** Value → fraction of the plot height, measured from the BOTTOM. */
export function fractionOf(value: number, scale: Scale): number {
  if (scale.flat) return 0.5;
  return (value - scale.min) / (scale.max - scale.min);
}

// ── bars ───────────────────────────────────────────────────────────────

export interface BarRect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** True when the bar hangs below the zero rule. */
  negative: boolean;
}

export interface BarLayout {
  bars: BarRect[];
  /** y of the zero rule in the box, or null when zero is off-scale. */
  zeroY: number | null;
  scale: Scale;
}

/** Evenly spaced bars with a gap expressed as a fraction of the slot. */
export function barLayout(
  values: readonly number[],
  box: Box = DEFAULT_BOX,
  gap = 0.28,
): BarLayout {
  const area = plotArea(box);
  const scale = scaleOf(values);
  const n = values.length;
  if (n === 0) return { bars: [], zeroY: null, scale };
  const slot = area.w / n;
  const barW = Math.max(1, slot * (1 - gap));
  const baseFraction = scale.zeroFraction ?? 0;
  const zeroY = scale.zeroFraction === null ? null : round2(area.y + area.h * (1 - baseFraction));
  const bars = values.map((v, i) => {
    const f = fractionOf(v, scale);
    const top = area.y + area.h * (1 - Math.max(f, baseFraction));
    const bottom = area.y + area.h * (1 - Math.min(f, baseFraction));
    return {
      x: round2(area.x + slot * i + (slot - barW) / 2),
      y: round2(top),
      w: round2(barW),
      h: round2(Math.max(1, bottom - top)),
      negative: v < 0,
    };
  });
  return { bars, zeroY, scale };
}

// ── line ───────────────────────────────────────────────────────────────

export interface LineLayout {
  path: string;
  points: Array<{ x: number; y: number }>;
  scale: Scale;
  zeroY: number | null;
}

export function lineLayout(
  values: readonly number[],
  box: Box = DEFAULT_BOX,
  includeZero = false,
): LineLayout {
  const area = plotArea(box);
  const scale = scaleOf(values, includeZero);
  const n = values.length;
  if (n === 0) return { path: "", points: [], scale, zeroY: null };
  const step = n > 1 ? area.w / (n - 1) : 0;
  const points = values.map((v, i) => ({
    x: round2(area.x + step * i + (n === 1 ? area.w / 2 : 0)),
    // SVG y grows downward — the largest value must sit highest.
    y: round2(area.y + area.h * (1 - fractionOf(v, scale))),
  }));
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
  const zeroY =
    scale.zeroFraction === null ? null : round2(area.y + area.h * (1 - scale.zeroFraction));
  return { path, points, scale, zeroY };
}

// ── stacked ────────────────────────────────────────────────────────────

export interface StackSegment extends BarRect {
  seriesIndex: number;
}

export interface StackLayout {
  columns: StackSegment[][];
  scale: Scale;
}

/**
 * Stacked columns. `series[s][c]` — series-major, so a series is one
 * colour band across every column.
 *
 * A stack is only honest when the parts share a sign: mixing a positive
 * and a negative segment in one column makes the column height mean
 * nothing. Negative values are therefore stacked DOWNWARD from zero in
 * their own run, never folded into the positive total.
 */
export function stackLayout(
  series: ReadonlyArray<readonly number[]>,
  box: Box = DEFAULT_BOX,
  gap = 0.28,
): StackLayout {
  const area = plotArea(box);
  const columnCount = series.reduce((m, s) => Math.max(m, s.length), 0);
  const totals: number[] = [];
  for (let c = 0; c < columnCount; c += 1) {
    let up = 0;
    let down = 0;
    for (const s of series) {
      const v = s[c];
      if (!Number.isFinite(v)) continue;
      if (v >= 0) up += v;
      else down += v;
    }
    totals.push(up, down);
  }
  const scale = scaleOf(totals);
  if (columnCount === 0) return { columns: [], scale };
  const slot = area.w / columnCount;
  const barW = Math.max(1, slot * (1 - gap));
  const zeroFraction = scale.zeroFraction ?? 0;

  const columns: StackSegment[][] = [];
  for (let c = 0; c < columnCount; c += 1) {
    const segs: StackSegment[] = [];
    let up = 0;
    let down = 0;
    series.forEach((s, si) => {
      const v = s[c];
      if (!Number.isFinite(v) || v === 0) return;
      const from = v >= 0 ? up : down;
      const to = from + v;
      if (v >= 0) up = to;
      else down = to;
      const fFrom = fractionOf(from, scale);
      const fTo = fractionOf(to, scale);
      const top = area.y + area.h * (1 - Math.max(fFrom, fTo));
      const bottom = area.y + area.h * (1 - Math.min(fFrom, fTo));
      segs.push({
        seriesIndex: si,
        x: round2(area.x + slot * c + (slot - barW) / 2),
        y: round2(top),
        w: round2(barW),
        h: round2(Math.max(1, bottom - top)),
        negative: v < 0,
      });
    });
    columns.push(segs);
  }
  void zeroFraction;
  return { columns, scale };
}

// ── waterfall ──────────────────────────────────────────────────────────

export interface WaterfallBar extends BarRect {
  /** A connector line from the previous bar's end to this bar's start. */
  connector: { x1: number; y1: number; x2: number; y2: number } | null;
  /** True for the closing total bar, which is drawn from zero. */
  isTotal: boolean;
}

export interface WaterfallLayout {
  bars: WaterfallBar[];
  zeroY: number | null;
  scale: Scale;
}

/**
 * The signature chart. `steps` are spans in MINOR UNITS — `from` and
 * `to` per bar, already accumulated by the resolver, so this function
 * does no arithmetic on money at all. It only turns two integers into a
 * rectangle.
 *
 * The last element may be a TOTAL bar (drawn from zero to its own `to`),
 * which is how an EBITDA bridge closes.
 */
export function waterfallLayout(
  steps: ReadonlyArray<{ from: number; to: number; isTotal?: boolean }>,
  box: Box = DEFAULT_BOX,
  gap = 0.34,
): WaterfallLayout {
  const area = plotArea(box);
  const bounds: number[] = [];
  for (const s of steps) bounds.push(s.from, s.to);
  const scale = scaleOf(bounds);
  const n = steps.length;
  if (n === 0) return { bars: [], zeroY: null, scale };
  const slot = area.w / n;
  const barW = Math.max(1, slot * (1 - gap));
  const yOf = (v: number) => area.y + area.h * (1 - fractionOf(v, scale));
  const zeroY = scale.zeroFraction === null ? null : round2(area.y + area.h * (1 - scale.zeroFraction));

  const bars: WaterfallBar[] = [];
  steps.forEach((s, i) => {
    const from = s.isTotal ? 0 : s.from;
    const yFrom = yOf(from);
    const yTo = yOf(s.to);
    const x = area.x + slot * i + (slot - barW) / 2;
    const prev = steps[i - 1];
    const connector =
      prev && !s.isTotal
        ? {
            x1: round2(area.x + slot * (i - 1) + (slot - barW) / 2 + barW),
            y1: round2(yOf(prev.to)),
            x2: round2(x),
            y2: round2(yOf(prev.to)),
          }
        : null;
    bars.push({
      x: round2(x),
      y: round2(Math.min(yFrom, yTo)),
      w: round2(barW),
      h: round2(Math.max(1, Math.abs(yTo - yFrom))),
      negative: s.to < from,
      isTotal: Boolean(s.isTotal),
      connector,
    });
  });
  return { bars, zeroY, scale };
}

// ── donut ──────────────────────────────────────────────────────────────

export interface DonutSlice {
  /** SVG path for the ring segment. */
  path: string;
  /** Share of the whole, 0..1. Derived, and reported so the renderer can
   *  put it in a legend instead of printing an invented percentage. */
  fraction: number;
}

export interface DonutLayout {
  slices: DonutSlice[];
  /** Null when the values cannot form a share (all zero, or any
   *  negative — a share of a negative whole is not a thing). */
  refused: "negative" | "empty" | null;
  cx: number;
  cy: number;
  r: number;
  thickness: number;
}

export function donutLayout(
  values: readonly number[],
  size = 168,
  thickness = 22,
): DonutLayout {
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - thickness / 2;
  const usable = values.filter((v) => Number.isFinite(v));
  const base: DonutLayout = { slices: [], refused: null, cx, cy, r, thickness };
  if (usable.length === 0) return { ...base, refused: "empty" };
  if (usable.some((v) => v < 0)) return { ...base, refused: "negative" };
  const total = usable.reduce((a, b) => a + b, 0);
  if (total <= 0) return { ...base, refused: "empty" };

  let angle = -Math.PI / 2; // start at 12 o'clock
  const slices: DonutSlice[] = [];
  for (const v of usable) {
    const fraction = v / total;
    const sweep = fraction * Math.PI * 2;
    const end = angle + sweep;
    const x1 = round2(cx + r * Math.cos(angle));
    const y1 = round2(cy + r * Math.sin(angle));
    const x2 = round2(cx + r * Math.cos(end));
    const y2 = round2(cy + r * Math.sin(end));
    const large = sweep > Math.PI ? 1 : 0;
    // A full circle cannot be drawn as one arc — its endpoints coincide.
    const path =
      fraction >= 1
        ? `M${round2(cx - r)},${round2(cy)} a${round2(r)},${round2(r)} 0 1 1 ${round2(r * 2)},0 a${round2(r)},${round2(r)} 0 1 1 ${round2(-r * 2)},0`
        : `M${x1},${y1} A${round2(r)},${round2(r)} 0 ${large} 1 ${x2},${y2}`;
    slices.push({ path, fraction });
    angle = end;
  }
  return { ...base, slices };
}
