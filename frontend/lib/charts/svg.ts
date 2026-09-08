// SVG PRIMITIVES AND THE CHART BLOCK CONTRACT.
//
// No chart library, no runtime dependency, no canvas: every chart in the
// printed report is a string of SVG this module builds. That is not a
// preference. A chart drawn in the browser after load is a figure the
// printed document does not contain, cannot be diffed, and cannot be
// asserted over by a gate that parses the bytes — and the bytes are the
// artefact the owner reads.
//
// ── R5, MADE STRUCTURAL ────────────────────────────────────────────────
// "No chart without its table" is not a convention here. A `ChartBlock`
// carries ONE `rows` array; `svg` draws it and `table` prints it, and
// both render the SAME `row.printed` string. A chart cannot round
// differently from its table, cannot show a series the table omits, and
// cannot be emitted without the table because `renderChartBlock` writes
// both or neither.
//
// ── DETERMINISM ────────────────────────────────────────────────────────
// No clock, no `Math.random`, no `hash()`, no id counter that depends on
// call order. Element ids are derived from the block's own literal slug.
// Two runs over one envelope produce byte-identical SVG.
//
// ── ABSENT ≠ ZERO ──────────────────────────────────────────────────────
// A row whose value is `null` is NOT drawn as a zero-height bar. A chart
// whose inputs the envelope did not carry renders `gapCard()` — which
// names what is missing and what would supply it — and never an axis
// with nothing on it.

export interface ChartRow {
  key: string;
  label: string;
  /** The number the chart draws. `null` is a stated gap, never a bar. */
  value: number | null;
  /** THE ONE SPELLING — the SVG data label and the table cell print this
   *  identical string, so a chart and its table cannot disagree. */
  printed: string;
  /** Where the figure comes from: account codes, or the served field. */
  source: string;
  /** Semantic red + a glyph. A BREACH, never "a negative number". */
  breach?: boolean;
  /** The engine flagged this figure as an approximation — drawn hatched. */
  approximated?: boolean;
  /** Waterfall only: an `anchor` is an absolute level, a `delta` a step. */
  kind?: "anchor" | "delta";
}

export interface ChartAbsence {
  /** The inputs the envelope did not carry, named as a reader would. */
  missing: string[];
  /** Why the chart cannot be drawn from what IS carried. */
  because: string;
  /** What would supply it. */
  toFix: string;
}

export interface ChartBlock {
  id: string;
  title: string;
  status: "drawn" | "absent";
  /** The drawing, or the gap card. Never an empty axis. */
  svg: string;
  rows: ChartRow[];
  /** The chart's own table, printed from the same rows. */
  table: string;
  caption: string;
  absence?: ChartAbsence;
}

// ── text ───────────────────────────────────────────────────────────────

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A coordinate, rounded so the bytes are stable across engines. */
export function n(v: number): string {
  if (!Number.isFinite(v)) return "0";
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? "0" : String(r);
}

interface TextOpts {
  anchor?: "start" | "middle" | "end";
  cls?: string;
  fill?: string;
  size?: number;
  weight?: number;
  dy?: number;
}

/**
 * One `<text>`.
 *
 * ── WHY `fill` IS WRITTEN AS A STYLE AND NOT AS AN ATTRIBUTE ──────────
 *
 * A presentation attribute (`fill="…"`) loses to ANY matching CSS rule,
 * and `chartCss()` gives four of the five text classes a `fill`. So
 * every `fill:` this function was passed for a `.c-val`, `.c-cat`,
 * `.c-src` or `.c-zone` was silently discarded by the class beside it.
 *
 * MEASURED on the delivered Agras PDF: `bandTracks` asks for the
 * measured value in ACCENT or, on a breach, in BREACH; all six printed
 * INK, the `.c-val` class default. The zone words printed their class
 * default too, which is what made the ink impossible to derive from the
 * ground it lands on.
 *
 * An inline style wins over a class rule, so a colour the DRAWING
 * computed now reaches the page. The class keeps the typography and
 * supplies the default for every call that does not pass one.
 */
export function text(x: number, y: number, body: string, o: TextOpts = {}): string {
  const attrs = [
    `x="${n(x)}"`,
    `y="${n(y)}"`,
    o.anchor ? `text-anchor="${o.anchor}"` : "",
    `class="${o.cls ?? "c-lab"}"`,
    o.fill ? `style="fill:${o.fill}"` : "",
    o.size ? `font-size="${n(o.size)}"` : "",
    o.weight ? `font-weight="${o.weight}"` : "",
    o.dy ? `dy="${n(o.dy)}"` : "",
  ].filter(Boolean);
  return `<text ${attrs.join(" ")}>${esc(body)}</text>`;
}

export function rect(
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  extra = "",
): string {
  return `<rect x="${n(x)}" y="${n(y)}" width="${n(Math.max(0, w))}" height="${n(Math.max(0, h))}" fill="${fill}"${extra ? ` ${extra}` : ""}/>`;
}

export function line(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  stroke: string,
  extra = "",
): string {
  return `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="${stroke}"${extra ? ` ${extra}` : ""}/>`;
}

// ── frame ──────────────────────────────────────────────────────────────

/**
 * The outer `<svg>`. `width="100%"` + a viewBox is what makes a chart
 * survive both an 880 px screen column and a 174 mm A4 text block
 * without a second rendering path.
 *
 * `role="img"` + `<title>`/`<desc>` are not decoration: the printed
 * document is read by screen readers and by the search box this report
 * ships, and both index `<desc>`.
 *
 * NO `height` ATTRIBUTE. `auto` is not a valid SVG length — SVG 1.1
 * takes a `<length>` and SVG 2 takes `auto` only as a CSS property, not
 * as a presentation attribute — so Chromium rejected it and logged
 * `Error: <svg> attribute height: Expected length, "auto"` ONCE PER
 * CHART: 26 console errors on every opened report, measured on the
 * Agras export (5 full charts + 21 band chips). It was redundant as
 * well as invalid: `chartCss()` already sets `svg.chart { height: auto }`
 * as a real CSS declaration, which is where `auto` belongs and where it
 * has been doing the work all along.
 */
export function frame(
  id: string,
  w: number,
  h: number,
  title: string,
  desc: string,
  body: string,
): string {
  return (
    `<svg class="chart" data-chart="${esc(id)}" viewBox="0 0 ${n(w)} ${n(h)}" ` +
    `width="100%" preserveAspectRatio="xMidYMin meet" ` +
    `role="img" aria-labelledby="${esc(id)}-t ${esc(id)}-d" ` +
    `xmlns="http://www.w3.org/2000/svg">` +
    `<title id="${esc(id)}-t">${esc(title)}</title>` +
    `<desc id="${esc(id)}-d">${esc(desc)}</desc>` +
    body +
    `</svg>`
  );
}

// ── the table half of every block ──────────────────────────────────────

/**
 * The chart's table. Printed from the SAME rows the SVG drew, with the
 * SAME `printed` strings, plus the source column — so every series in
 * every chart traces to gateway facts on the page itself (R5).
 */
export function rowsTable(rows: ChartRow[], valueHeader: string): string {
  const body = rows
    .map(
      (r) =>
        `<tr${r.breach ? ' class="breach"' : ""}>` +
        `<td>${esc(r.label)}</td>` +
        `<td class="num">${esc(r.printed)}</td>` +
        `<td class="src">${esc(r.source)}</td>` +
        `</tr>`,
    )
    .join("");
  return (
    `<table class="fin chart-table">` +
    `<thead><tr><th>Series</th><th class="num">${esc(valueHeader)}</th><th>Source</th></tr></thead>` +
    `<tbody>${body}</tbody></table>`
  );
}

/**
 * THE GAP CARD. What renders when the envelope did not carry the inputs.
 *
 * It is deliberately not a chart: no axis, no frame, no zero bars. A
 * reader who sees an axis assumes a measurement was made and came out
 * flat. This says which inputs are missing, why the figure cannot be
 * built from what IS here, and what would supply it.
 */
export function gapCard(title: string, a: ChartAbsence): string {
  return (
    `<div class="chart-gap" data-chart-gap="1">` +
    `<div class="chart-gap-h">${esc(title)} — not charted</div>` +
    `<p class="chart-gap-b"><strong>Missing:</strong> ${esc(a.missing.join("; "))}.</p>` +
    `<p class="chart-gap-b">${esc(a.because)}</p>` +
    `<p class="chart-gap-b"><strong>To produce it:</strong> ${esc(a.toFix)}</p>` +
    `</div>`
  );
}

/** Compose the two halves. Both, or neither — that is R5. */
export function renderChartBlock(b: ChartBlock): string {
  const table = b.status === "drawn" ? b.table : "";
  return (
    `<figure class="chart-figure" data-chart-block="${esc(b.id)}" data-chart-status="${b.status}">` +
    b.svg +
    table +
    `<figcaption>${esc(b.caption)}</figcaption>` +
    `</figure>`
  );
}
