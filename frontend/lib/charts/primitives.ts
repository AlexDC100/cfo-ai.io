// THE CHART PRIMITIVES — five shapes, every chart in the report.
//
// Deliberately few. A waterfall, a stacked column pair, a band track, a
// contribution bar and the gap card cover every figure this document has
// gateway facts for; a sixth shape would be a shape with one caller and
// no gate. The working-capital cycle is a waterfall in days, not a
// bespoke chart, so DSO + DIO − DPO = CCC is drawn by the same code that
// draws the EBITDA bridge and reds through the same assertions.
//
// NO PIES. The brief allows one for a ≤ 4-slice funding mix; nothing in
// this document has ≤ 4 slices AND needs an angle to be read, so the
// primitive is not written. A pie that exists is a pie that gets used.

import {
  ACCENT,
  BREACH,
  BREACH_SOFT,
  HATCH_ID,
  INK,
  INK_MUTE,
  INK_SOFT,
  PAPER,
  RULE,
  RULE_SOFT,
  STEP_ANCHOR,
  STEP_DOWN,
  STEP_UP,
  hatchDefs,
  inkOn,
  rampTone,
} from "./tokens";
import { esc, frame, line, n, rect, text, type ChartRow } from "./svg";

const W = 760;

/** Split a label onto at most two lines, deterministically.
 *
 *  A served field name is one unbreakable token —
 *  `assembled_cf.working_capital_change`, 35 characters, no spaces — and
 *  the word-splitter returned it whole, which put it across the bar
 *  beside it (measured in a browser on the agras export). A token wider
 *  than the line is cut at the line, not left to run. */
function wrap2(s: string, per: number): string[] {
  if (s.length <= per) return [s];
  if (!s.includes(" ")) return [s.slice(0, per), s.slice(per, per * 2)];
  const words = s.split(" ");
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur === "") cur = w;
    else if ((cur + " " + w).length <= per) cur = cur + " " + w;
    else {
      out.push(cur);
      cur = w;
    }
    if (out.length === 1 && cur.length > per) break;
  }
  if (cur !== "") out.push(cur);
  if (out.length <= 2) return out;
  return [out[0], out.slice(1).join(" ")];
}

function twoLineLabel(x: number, y: number, label: string, per: number): string {
  const lines = wrap2(label, per);
  return lines
    .map((l, i) => text(x, y + i * 11.5, l, { anchor: "middle", cls: "c-cat" }))
    .join("");
}

// ── WATERFALL ──────────────────────────────────────────────────────────
//
// `anchor` rows are absolute levels (opening / closing). `delta` rows are
// steps between them. The running total is carried across the row list,
// so the drawing IS the arithmetic: a bridge whose steps do not reach the
// closing anchor draws a visible gap, it does not silently re-base.

export interface WaterfallOpts {
  id: string;
  title: string;
  /** Axis unit word for the table header and the `<desc>`. */
  unit: string;
  rows: ChartRow[];
}

export function waterfall(o: WaterfallOpts): string {
  const rows = o.rows.filter((r) => r.value !== null);
  const padL = 8;
  const padR = 8;
  const padT = 34;
  const padB = 68;
  const H = 310;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const slot = plotW / Math.max(1, rows.length);
  const barW = Math.min(78, slot * 0.62);

  // Running totals — the arithmetic the picture shows.
  let run = 0;
  const spans = rows.map((r) => {
    const v = r.value as number;
    if (r.kind === "anchor") {
      const s = { from: 0, to: v };
      run = v;
      return s;
    }
    const s = { from: run, to: run + v };
    run = run + v;
    return s;
  });

  const lo = Math.min(0, ...spans.map((s) => Math.min(s.from, s.to)));
  const hi = Math.max(0, ...spans.map((s) => Math.max(s.from, s.to)));
  const span = hi - lo === 0 ? 1 : hi - lo;
  const yOf = (v: number): number => padT + plotH - ((v - lo) / span) * plotH;

  const zero = yOf(0);
  let body = hatchDefs();
  body += line(padL, zero, W - padR, zero, RULE, 'stroke-width="1"');

  rows.forEach((r, i) => {
    const cx = padL + slot * i + slot / 2;
    const x = cx - barW / 2;
    const s = spans[i];
    const yTop = Math.min(yOf(s.from), yOf(s.to));
    const yBot = Math.max(yOf(s.from), yOf(s.to));
    const h = Math.max(1.5, yBot - yTop);
    const fill = r.breach
      ? BREACH
      : r.kind === "anchor"
        ? STEP_ANCHOR
        : (r.value as number) >= 0
          ? STEP_UP
          : STEP_DOWN;
    const extra = r.approximated ? ` stroke="${INK_MUTE}" stroke-width="0.8"` : "";
    body += rect(x, yTop, barW, h, r.approximated ? `url(#${HATCH_ID})` : fill, extra.trim());
    if (r.approximated) body += rect(x, yTop, barW, h, "none", `stroke="${fill}" stroke-width="1.4"`);

    // The printed figure, above the bar — the SAME string the table prints.
    body += text(cx, yTop - 7, (r.breach ? "▲ " : "") + r.printed, {
      anchor: "middle",
      cls: "c-val",
      fill: r.breach ? BREACH : INK,
    });
    // Category label, below the axis line, two lines max.
    body += twoLineLabel(cx, H - padB + 16, r.label, 15);
    // The accounts this step is made of — R5, on the drawing itself.
    // WRAPPED, not truncated: measured in a browser on the agras export,
    // `assembled_cf.working_capital_change` at 8 px ran 158 px wide in a
    // 149 px slot and overlapped `assembled_cf.cash_from_investing` beside
    // it. Truncating would have cost the field name that makes the figure
    // traceable, which is the one thing this line is for.
    body += wrap2(r.source, 20)
      .map((l, li) => text(cx, H - padB + 40 + li * 9.5, l, { anchor: "middle", cls: "c-src" }))
      .join("");

    // Connector to the next bar — what makes it a bridge and not a bar chart.
    if (i < rows.length - 1 && rows[i + 1].kind !== "anchor") {
      const yEnd = yOf(s.to);
      body += line(x + barW, yEnd, padL + slot * (i + 1) + slot / 2 - barW / 2, yEnd, RULE, 'stroke-width="1" stroke-dasharray="2 2"');
    } else if (i < rows.length - 1) {
      const yEnd = yOf(s.to);
      body += line(x + barW, yEnd, padL + slot * (i + 1) + slot / 2 - barW / 2, yEnd, RULE_SOFT, 'stroke-width="1" stroke-dasharray="2 2"');
    }
  });

  const desc =
    `Waterfall in ${o.unit}. ` +
    rows.map((r) => `${r.label} ${r.printed}`).join("; ") +
    ".";
  return frame(o.id, W, H, o.title, desc, body);
}

// ── STACKED COLUMNS ────────────────────────────────────────────────────
//
// Two columns, side by side, each summing to its own total — the shape a
// balance sheet actually has. Stacked bars, never pies: a reader compares
// two compositions here, and comparing two pies is comparing angles.

export interface StackedOpts {
  id: string;
  title: string;
  columns: Array<{ label: string; totalPrinted: string; segments: ChartRow[] }>;
}

export function stackedColumns(o: StackedOpts): string {
  const padT = 46;
  const padB = 34;
  const H = 340;
  const plotH = H - padT - padB;
  const colW = 168;
  const gap = 120;
  const totalW = o.columns.length * colW + (o.columns.length - 1) * gap;
  const startX = (W - totalW) / 2;

  const colSums = o.columns.map((c) =>
    c.segments.reduce((a, s) => a + Math.abs(s.value ?? 0), 0),
  );
  const scaleMax = Math.max(1, ...colSums);

  let body = "";
  o.columns.forEach((c, ci) => {
    const x = startX + ci * (colW + gap);
    const colH = (colSums[ci] / scaleMax) * plotH;
    let y = padT + (plotH - colH);
    // Slices too thin to hold a mark, collected here and keyed in the
    // margin after the stack is drawn — see the block below the loop.
    const margin: Array<{ key: string; midY: number }> = [];
    body += text(x + colW / 2, padT - 24, c.label, { anchor: "middle", cls: "c-cat", weight: 600, fill: INK });
    body += text(x + colW / 2, padT - 10, c.totalPrinted, { anchor: "middle", cls: "c-val", fill: INK });
    c.segments.forEach((s, si) => {
      const v = Math.abs(s.value ?? 0);
      const h = (v / scaleMax) * plotH;
      const tone = rampTone(si);
      // THE INK IS READ OFF THE GROUND IT LANDS ON. It used to be PAPER
      // for every branch below, and the ramp runs dark to light, so the
      // two lightest tones printed white on near-white — 1.44 : 1 at
      // 5.9 pt on the delivered PDF. `inkOn` keeps the white where white
      // is legible and swaps to INK where it is not.
      const ink = inkOn(tone, PAPER);
      body += rect(x, y, colW, h, tone, `stroke="${PAPER}" stroke-width="1"`);
      // Direct label inside the segment when it fits; otherwise a
      // one-letter tone key that the table repeats.
      //
      // THE LEADER LINES ARE GONE and that is the fix, not a compromise.
      // Measured in a browser on the agras export: five pairs of thin
      // segments overprinted each other, three names ran into the figures
      // beside them, and pushing the labels clear pushed five of them
      // outside the frame. A leader line into a 4 px slice is a label
      // looking for room that is not there. The key is two characters
      // wide, always fits, and the table beside the chart carries the
      // name, the figure and the accounts under the same letter.
      // A 168 px slice holds about 26 characters of 9 px text. "Other
      // non-current" beside "RON 57,588,648" is 30 and they overprinted
      // on the retail book (measured). Too long for one line goes on two
      // when the slice is tall enough, and falls back to the letter key
      // when it is not.
      const fitsOneLine = s.label.length + s.printed.length <= 26;
      if (h >= 17 && fitsOneLine) {
        body += text(x + 8, y + h / 2 - 1, s.label, { cls: "c-seg", fill: ink });
        body += text(x + colW - 8, y + h / 2 - 1, s.printed, { anchor: "end", cls: "c-seg", fill: ink });
      } else if (h >= 26) {
        body += text(x + 8, y + h / 2 - 5, s.label, { cls: "c-seg", fill: ink });
        body += text(x + 8, y + h / 2 + 7, s.printed, { cls: "c-seg", fill: ink });
      } else if (h >= 17) {
        body += text(x + 8, y + h / 2 - 1, String.fromCharCode(65 + si), { cls: "c-seg", fill: ink });
        body += text(x + colW - 8, y + h / 2 - 1, s.printed, { anchor: "end", cls: "c-seg", fill: ink });
      } else if (h >= 9) {
        body += text(x + colW / 2, y + h / 2 + 3, String.fromCharCode(65 + si), { anchor: "middle", cls: "c-seg", fill: ink });
      } else {
        // TOO THIN FOR A MARK OF ITS OWN — so the mark leaves the stack
        // rather than being dropped.
        //
        // It used to be dropped, on the reasoning that a key printed on
        // top of a neighbour's key is worse than no key. That reasoning
        // is right about the INSIDE of the column and wrong about the
        // drawing: the caption printed under this chart promises every
        // thin slice a letter, and on the Agras export four slices got
        // none — Intangibles (4.45 px), Other non-current (0.45 px),
        // Other non-current liabilities (6.23 px) and CASH (7.72 px),
        // the one item the document's own verdict grades critical.
        //
        // The key goes in the margin beside the column instead, where a
        // character always fits, and a hairline ties it to the slice.
        // The collision the old comment describes is answered by pushing
        // each key clear of the last one (segments come in y order, so
        // pushing down is enough), not by printing nothing.
        margin.push({ key: String.fromCharCode(65 + si), midY: y + h / 2 });
      }
      y += h;
    });
    body += rect(x, padT + (plotH - colH), colW, colH, "none", `stroke="${INK_SOFT}" stroke-width="1"`);

    const keyX = x + colW + 9;
    let lastKeyY = -Infinity;
    for (const m of margin) {
      const ky = Math.max(m.midY, lastKeyY + 10);
      lastKeyY = ky;
      body += line(x + colW + 1, m.midY, keyX - 2.5, ky, RULE, 'stroke-width="0.75"');
      body += text(keyX, ky + 3, m.key, { cls: "c-seg", fill: INK });
    }
  });

  const desc = o.columns
    .map((c) => `${c.label} total ${c.totalPrinted}: ` + c.segments.map((s) => `${s.label} ${s.printed}`).join(", "))
    .join(". ");
  return frame(o.id, W, H, o.title, desc, body);
}

// ── BAND TRACK (bullet) ────────────────────────────────────────────────
//
// The measured value against the bands the ENGINE served — the chart that
// replaces a word chip. The zones are drawn from `assembled_bands`; this
// module holds no threshold of its own, so a re-band moves the picture on
// the same deploy that moves the badge.

export interface BandZone {
  /** Zone start / end in the ratio's own unit. */
  from: number;
  to: number;
  label: string;
  breachZone?: boolean;
}

export interface BandTrackRow {
  key: string;
  label: string;
  value: number | null;
  printed: string;
  source: string;
  breach?: boolean;
  zones: BandZone[];
  /** The THRESHOLDS themselves, at their own positions — never a padded
   *  axis end. A padded bound is a numeral the document prints nowhere
   *  else, which is a figure that lives only in a picture; these are the
   *  served thresholds, spelled exactly as the table's source column
   *  spells them. */
  ticks: Array<{ at: number; printed: string }>;
}

export function bandTracks(id: string, title: string, tracks: BandTrackRow[]): string {
  const rowH = 56;
  const padT = 14;
  const padB = 12;
  const labW = 214;
  const trackX = labW + 12;
  const trackW = W - trackX - 96;
  const H = padT + padB + tracks.length * rowH;

  let body = "";
  tracks.forEach((t, i) => {
    const y = padT + i * rowH;
    const lo = Math.min(...t.zones.map((z) => z.from), t.value ?? Infinity);
    const hi = Math.max(...t.zones.map((z) => z.to), t.value ?? -Infinity);
    const span = hi - lo === 0 ? 1 : hi - lo;
    const xOf = (v: number): number => trackX + ((v - lo) / span) * trackW;

    body += text(0, y + 15, t.label, { cls: "c-cat", fill: INK, anchor: "start" });
    body += text(0, y + 28, t.source, { cls: "c-src", anchor: "start" });

    t.zones.forEach((z, zi) => {
      const x0 = xOf(z.from);
      const x1 = xOf(z.to);
      const ground = z.breachZone ? BREACH_SOFT : rampTone(4 - Math.min(4, zi));
      body += rect(x0, y + 8, x1 - x0, 18, ground, `stroke="${PAPER}" stroke-width="0.75"`);
      // Same rule as a stacked segment: the zone word is printed INSIDE
      // the zone, so its ink is derived from the zone's own tone. The
      // muted slate stays where it is legible — on the two lightest
      // zones and on the breach tint — and is dropped on the darker
      // ones, where it measured 1.39 : 1 and 2.48 : 1 at 5.2 pt.
      if (x1 - x0 > 40) {
        body += text((x0 + x1) / 2, y + 21, z.label, { anchor: "middle", cls: "c-zone", fill: inkOn(ground, INK_SOFT) });
      }
    });
    body += rect(trackX, y + 8, trackW, 18, "none", `stroke="${RULE}" stroke-width="0.75"`);

    if (t.value === null) {
      // In the VALUE slot, not across the track. Centred over the bands
      // it printed on top of the zone label beneath it (measured on the
      // carniprod book: "not reported" over "healthy"), which read as a
      // ratio sitting in a band it was never placed in.
      body += text(W - 90, y + 21, "not reported", { anchor: "start", cls: "c-zone", fill: INK_MUTE });
    } else {
      const vx = xOf(t.value);
      const c = t.breach ? BREACH : ACCENT;
      // THE OVERHANG IS LOAD-BEARING, not a flourish. The zone band is
      // 18 units tall at `y + 8`; the marker is 28 at `y + 3`, so it
      // stands 5 units clear of the band at each end, on white paper.
      //
      // It has to, because against the band itself the marker barely
      // separates — computed from the palette this file draws with:
      //
      //     ACCENT on RAMP[1]  1.23 : 1   ΔL*  5.7   ("strong")
      //     BREACH on RAMP[0]  1.27 : 1   ΔL*  6.8   ("strong", inverted)
      //     ACCENT on RAMP[2]  1.44 : 1   ΔL* 10.3
      //
      // Against paper the same marks read 5.10 : 1 and 9.29 : 1. So a
      // geometry change that tucked the marker inside the band would not
      // move a colour and would still make the measured value invisible
      // on exactly the tracks where the verdict is "strong".
      // `check_report_print.mjs` I6 measures the overhang for that
      // reason; the marker's own y/height are what it reds on.
      body += rect(vx - 1.6, y + 3, 3.2, 28, c);
      body += text(W - 90, y + 21, (t.breach ? "▲ " : "") + t.printed, { anchor: "start", cls: "c-val", fill: c });
    }
    // STAGGERED. On a track whose measured value stretches the domain
    // (interest coverage 66.28× against bands at 1.5/3/6) the three
    // thresholds land within 30 px of each other and overprint —
    // measured in a browser, four colliding pairs on the agras export.
    // Alternating rows keeps every threshold readable without dropping
    // one, which would be hiding a band the verdict was decided by.
    // Greedy level assignment, not `ti % 2`: alternating rows still put
    // ticks 0 and 2 on the same line, and on the retail book's
    // debt-to-EBITDA track (bands 2 / 3 / 4.5, domain stretched by the
    // measured value) those two overprinted. A tick drops to the next
    // level until it clears the last label on that level by 30 px — the
    // width of a five-character figure at 8 px.
    const lastAtLevel: number[] = [];
    for (const tick of t.ticks) {
      const tx = xOf(tick.at);
      let level = 0;
      while (lastAtLevel[level] !== undefined && tx - lastAtLevel[level] < 30) level += 1;
      lastAtLevel[level] = tx;
      const drop = level * 9.5;
      body += line(tx, y + 26, tx, y + 31 + drop, RULE, 'stroke-width="0.75"');
      body += text(tx, y + 40 + drop, tick.printed, { cls: "c-src", anchor: "middle" });
    }
  });

  const desc = tracks
    .map((t) => `${t.label} ${t.printed} against bands ${t.zones.map((z) => z.label).join(" / ")}`)
    .join(". ");
  return frame(id, W, H, title, desc, body);
}

// ── CONTRIBUTION BARS ──────────────────────────────────────────────────
//
// Each weighted component's actual contribution against the most it
// could have contributed (weight × 100). The headroom is the point: a
// composite of 24.4 reads very differently when you can see which two
// terms gave up 30 points between them.

export interface ContribRow extends ChartRow {
  /** The most this term could contribute — weight × 100. */
  ceiling: number | null;
  ceilingPrinted: string;
}

export function contributionBars(id: string, title: string, rows: ContribRow[]): string {
  const rowH = 34;
  const padT = 24;
  const padB = 16;
  const labW = 210;
  const barX = labW + 10;
  const barW = W - barX - 130;
  const H = padT + padB + rows.length * rowH;
  const maxCeil = Math.max(1, ...rows.map((r) => r.ceiling ?? 0));

  let body = text(barX, 12, "contribution to the composite, out of the weight's ceiling", { cls: "c-src" });
  rows.forEach((r, i) => {
    const y = padT + i * rowH;
    // THE LABEL IS WRAPPED TO ITS OWN COLUMN, not left to run.
    //
    // It was drawn as one line from x = 0 with nothing to stop it, and
    // the bars are painted AFTER it, from x = 220. MEASURED on the
    // delivered Agras PDF: five of the seven term names ran past 220 and
    // the accent bar printed over the tail of each —
    // "Term: Interest-coverage sub-score 0–100 (EBIT ÷ interest)" is
    // ~262 px of 9.5 px text in a 210 px column, so ~42 px of it was
    // buried under teal. `labW / 4.9` is the character budget at that
    // size; two lines cover every term name the composite carries.
    const labelLines = wrap2(r.label, Math.floor(labW / 4.9));
    labelLines.forEach((l, li) => {
      // One line sits on the bar's own centre line; two straddle it.
      const dy = labelLines.length === 1 ? 16 : li === 0 ? 11 : 22;
      body += text(0, y + dy, l, { cls: "c-cat", fill: INK, anchor: "start" });
    });
    const cw = ((r.ceiling ?? 0) / maxCeil) * barW;
    body += rect(barX, y + 5, cw, 16, RULE_SOFT);
    if (r.value === null) {
      // Printed on the ceiling track, not on paper: INK_MUTE measures
      // 3.90 : 1 against RULE_SOFT, so the muted slate takes over.
      body += text(barX + 6, y + 17, "not reported", { cls: "c-zone", fill: inkOn(RULE_SOFT, INK_MUTE, INK_SOFT) });
    } else {
      const vw = ((r.value as number) / maxCeil) * barW;
      body += rect(barX, y + 5, vw, 16, r.breach ? BREACH : ACCENT);
    }
    body += rect(barX, y + 5, cw, 16, "none", `stroke="${RULE}" stroke-width="0.75"`);
    body += text(W - 122, y + 17, r.printed, { anchor: "start", cls: "c-val" });
    body += text(W - 52, y + 17, `of ${r.ceilingPrinted}`, { anchor: "start", cls: "c-src" });
  });

  const desc = rows.map((r) => `${r.label} contributed ${r.printed} of ${r.ceilingPrinted}`).join("; ");
  return frame(id, W, H, title, desc, body);
}


// ── MINI BAND TRACK ────────────────────────────────────────────────────
//
// The chip that replaces the word. A verdict word says which bucket a
// ratio landed in; it cannot say whether it landed a hair inside the
// bucket or a mile into it, and those are different facts for a lender.
// This draws the ratio on its own bands, at card scale.
//
// It carries NO NUMERALS — the figure is already the largest thing on the
// card and the thresholds are in the caption of the full track below. So
// nothing here can become a figure whose only home is a picture.
//
// The verdict word stays beside it. Partly because a word is the
// accessible reading of this shape, and partly because
// `oneVerdictLeavesTheBuilding.test.tsx:326` asserts the Altman card's
// badge text equals `verdictLabel(verdict)` — a gate belonging to
// another lane, which this lane does not get to edit to make its own
// change land.
export function miniTrack(
  id: string,
  zones: BandZone[],
  value: number | null,
  breach: boolean,
  label: string,
): string {
  const W2 = 208;
  const H2 = 16;
  const lo = Math.min(...zones.map((z) => z.from), value ?? Infinity);
  const hi = Math.max(...zones.map((z) => z.to), value ?? -Infinity);
  const span = hi - lo === 0 ? 1 : hi - lo;
  const xOf = (v: number): number => ((v - lo) / span) * W2;
  let body = "";
  zones.forEach((z, zi) => {
    const x0 = xOf(z.from);
    body += rect(x0, 4, xOf(z.to) - x0, 8, z.breachZone ? BREACH_SOFT : rampTone(4 - Math.min(4, zi)), `stroke="${PAPER}" stroke-width="0.6"`);
  });
  body += rect(0, 4, W2, 8, "none", `stroke="${RULE}" stroke-width="0.6"`);
  if (value !== null) {
    const vx = xOf(value);
    body += rect(vx - 1.1, 1, 2.2, 14, breach ? BREACH : ACCENT);
  }
  const desc = `${label} placed on its bands: ${zones.map((z) => z.label).join(", ")}.`;
  return frame(id, W2, H2, `${label} band position`, desc, body);
}

/** The CSS every chart above needs. Injected once into the document. */
export function chartCss(): string {
  return `
    /* design-lint-allow-hex standalone generated report doc (chart block) */
    .ratio-card svg.chart.mini { width: 100%; max-width: 208px; height: 16px; margin: 6px 0 2px; }
    /* NO break-inside HERE. A figure is a chart PLUS its table plus its
       caption, and on the balance-sheet composition that is taller than
       an A4 text block — so "never split" cost the rest of whatever page
       it started on (534 pt of white, measured). The print rules own the
       fragmentation: reportPrintCss.ts keeps the DRAWING whole, starts
       the table on the drawing's page, and lets the table alone flow. */
    .chart-figure { margin: 14px 0 26px; padding: 0; }
    svg.chart { display: block; width: 100%; height: auto; overflow: visible; }
    svg.chart text { font-family: var(--sans); font-variant-numeric: tabular-nums lining-nums; font-feature-settings: "tnum" 1, "lnum" 1; }
    svg.chart .c-val { font-size: 10px; font-weight: 600; fill: ${INK}; letter-spacing: 0.01em; }
    svg.chart .c-cat { font-size: 9.5px; fill: ${INK_SOFT}; }
    svg.chart .c-src { font-size: 8px; fill: ${INK_MUTE}; letter-spacing: 0.02em; }
    svg.chart .c-seg { font-size: 9px; font-weight: 500; }
    svg.chart .c-seg-out { font-size: 8.5px; fill: ${INK_SOFT}; }
    svg.chart .c-zone { font-size: 8px; fill: ${INK_SOFT}; text-transform: uppercase; letter-spacing: 0.06em; }
    .chart-figure figcaption { font-size: 8.75pt; color: ${INK_MUTE}; line-height: 1.5; margin-top: 6px; border-top: 1px solid ${RULE_SOFT}; padding-top: 6px; }
    table.chart-table { font-size: 9pt; margin: 10px 0 6px; }
    table.chart-table td.src, table.chart-table th:last-child { font-size: 8pt; color: ${INK_MUTE}; }
    table.chart-table tr.breach td { color: ${BREACH}; }
    .chart-gap { border: 1px solid ${RULE}; border-left: 2px solid ${INK_MUTE}; padding: 12px 14px; margin: 12px 0; background: none; break-inside: avoid; page-break-inside: avoid; }
    .chart-gap-h { font-family: var(--sans); font-size: 8.5pt; font-weight: 600; text-transform: uppercase; letter-spacing: 0.10em; color: ${INK}; margin-bottom: 6px; }
    .chart-gap-b { font-size: 9.25pt; color: ${INK_SOFT}; margin: 4px 0; line-height: 1.5; }
    @media print {
      svg.chart { max-height: 92mm; }
    }
  `;
}

/** Re-exported so callers need one import. */
export { esc, n, rect, line, text };
