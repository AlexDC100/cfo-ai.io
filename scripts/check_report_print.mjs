#!/usr/bin/env node
/**
 * G-P4 — THE PRINTED DOCUMENT, MEASURED ON WHAT IT ACTUALLY PAINTS.
 *
 * `scripts/check_report_pdf.mjs` asserts the PAGE: A4, the running head,
 * the section dividers, the repeating table header. This gate asserts
 * the INK: the contrast of every glyph a chart draws against the colour
 * it is painted on, whether every stacked slice carries the mark its
 * caption promises, whether the printed contents draws a leader that
 * ends in nothing, whether a page is left near-blank, and whether the
 * document logs an error when a reader opens it.
 *
 * ── WHY THE MEASUREMENT IS PIXELS AND NOT CONSTANTS ───────────────────
 *
 * The defect this gate was written to end was invisible to a constant.
 * `primitives.ts` set every in-segment label to `PAPER`, and PAPER is
 * the correct ink — inside a dark slice. The ramp runs dark to light,
 * so the same correct constant printed white on #D2D8D6 at 5.9 pt:
 *
 *     Receivables    #FFFFFF on #D1D8D5   1.44 : 1
 *     Payables       #FFFFFF on #D1D8D5   1.44 : 1
 *     Inventory      #FFFFFF on #A8B3B0   2.15 : 1
 *
 * Every assertion that could have been written about the SOURCE would
 * have passed. So I1 renders the document in the browser that produces
 * the PDF, screenshots each chart twice — once with the glyphs, once
 * with them hidden — and reads the ground at the pixels where the glyph
 * is painted at full strength. Nothing is inferred from a token.
 *
 * ── WHAT IT REDS ON, once the document is correct (TC-11) ─────────────
 *   I1  any glyph inside any chart falls below 4.5 : 1 against what is
 *       actually painted underneath it — including via a token edit, a
 *       reordered stack, a new ramp step, or a label that drifts over a
 *       bar drawn after it
 *   I2  a stacked-column slice carries neither a label inside it nor a
 *       key tied to it, while the caption promises every slice a mark
 *   I3  the printed contents draws a dotted or dashed leader on a row
 *       whose page number does not resolve in this engine
 *   I4  a page that is NOT the cover, the contents, the last page, or
 *       the last page of a section is left more than 250 pt empty —
 *       the signature of a block that refused to break
 *   I5  opening the document logs a console error
 *   I6  a band-track value marker stops overhanging the band it sits
 *       on — the only thing that separates it from the darker zones
 *   I7  a stacked column is headed by a total its own slices do not
 *       reach, which is the balance sheet not balancing, one surface
 *       over
 *
 * ── WHAT IT CANNOT SEE ────────────────────────────────────────────────
 *   · whether a figure is RIGHT. That is the 2,591 export assertions,
 *     over the same HTML this gate paints.
 *   · a label that overflows onto WHITE rather than onto a filled shape.
 *     I1 measures legibility, not layout: an overhanging label on paper
 *     still reads at 19 : 1. `reportCharts.test.ts` holds the length
 *     proxy for that.
 *   · a book that is not one of the four committed here. A ratio label
 *     longer than any in these books could still overrun its column.
 *   · anything about a browser that is not the pinned Chromium — a
 *     different engine paginates and rasterises differently.
 *   · whether the contents page numbers are CORRECT where an engine does
 *     resolve `target-counter()`. I3 only asserts that a leader is not
 *     drawn without one.
 *
 * Requires a Chromium: `npx playwright install chromium-headless-shell`.
 * Run: `node scripts/check_report_print.mjs`
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";
import { chromium } from "playwright";

import { inkRows, pageTexts } from "./_pdf_read.mjs";

// fileURLToPath, not URL.pathname — the repo path contains spaces.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const firm = (name) => join(ROOT, "tests/engine/fixtures/firm", name);

const BOOKS = ["agras", "carniprod", "realestate", "retail"];

/** WCAG AA for text this size. The charts print at 5.2–6.5 pt. */
const MIN_CONTRAST = 4.5;

/**
 * How empty a page may be left when the break after it was NOT forced.
 *
 * 250 pt is a third of the 734 pt text block. The four committed books,
 * with the fragmentation rules in `reportPrintCss.ts`, leave at most
 * 122 pt on such a page — so this is 2× headroom over a correct
 * document, and it still reds on every defect that produced it:
 * 267 / 414 / 534 / 605 / 649 pt, all measured on the delivered pack.
 */
const MAX_TRAILING_PT = 250;

const A4_H = 841.89;
const CONTENT_TOP = A4_H - (20 / 25.4) * 72; // 20 mm top margin
const CONTENT_BOT = (18 / 25.4) * 72; // 18 mm bottom margin

const failures = [];
const notes = [];
function check(id, ok, message) {
  (ok ? notes : failures).push(`  ${ok ? "ok  " : "FAIL"} ${id}  ${message}`);
}

// ── the four books, as the route serves them ──────────────────────────
//
// `envelope.canonical_bs` is joined on, because that is the shape
// production serves and a render without it prints a balance sheet whose
// two sides do not agree. A gate that renders the write-path half alone
// is paginating a document no customer receives.

async function buildBooks() {
  const server = await createServer({
    configFile: join(ROOT, "vitest.config.ts"),
    root: ROOT,
    logLevel: "error",
    server: { middlewareMode: true, hmr: false },
  });
  try {
    const mod = await server.ssrLoadModule("/frontend/lib/financialExports.ts");
    const served = JSON.parse(readFileSync(firm("served_metrics.json"), "utf-8"));
    const insights = JSON.parse(readFileSync(firm("insights.json"), "utf-8"));
    return BOOKS.map((book) => {
      const fx = JSON.parse(readFileSync(firm(`saga_10_col_${book}.json`), "utf-8"));
      if (fx.envelope?.canonical_bs === undefined) {
        throw new Error(`saga_10_col_${book}.json carries no envelope.canonical_bs`);
      }
      const statements = {
        ...fx.statements,
        canonical_bs: fx.envelope.canonical_bs,
        insights: insights[book],
      };
      return {
        book,
        html: mod.buildReportHtml(statements, { metricsByName: served[book] ?? {} }),
        company: statements.companyName,
        period: statements.periodLabel,
      };
    });
  } finally {
    await server.close();
  }
}

// ── I1 / I2 / I3 / I5, in the browser ─────────────────────────────────

/**
 * Contrast of every chart glyph, from the pixels.
 *
 * Two screenshots of each chart — with the text and with
 * `visibility: hidden` on it — so the ground can be read at exactly the
 * pixels the glyph covers. The naive version (sample the glyph's
 * bounding box and take the extreme colour in it) reports a white
 * SEGMENT BORDER as the ink of a letter that never touches it: measured,
 * it called a 6.29 : 1 key 1.00 : 1. Only pixels the glyph covers FULLY
 * are counted; an antialiased edge is half ground by definition.
 */
async function measureInk(page) {
  const ids = await page.evaluate(() =>
    [...document.querySelectorAll("svg.chart")]
      .filter((s) => s.querySelector("text") !== null)
      .map((s) => s.getAttribute("data-chart")),
  );
  const shot = async (id) =>
    (await (await page.$(`svg.chart[data-chart="${id}"]`)).screenshot({ type: "png" })).toString("base64");
  const lit = new Map();
  for (const id of ids) lit.set(id, await shot(id));
  const hider = await page.addStyleTag({ content: "svg.chart text { visibility: hidden !important; }" });
  const dark = new Map();
  for (const id of ids) dark.set(id, await shot(id));
  await page.evaluate((el) => el.remove(), hider);

  const out = [];
  for (const id of ids) {
    out.push(
      ...(await page.evaluate(
        async ({ id, a64, b64 }) => {
          const svg = document.querySelector(`svg.chart[data-chart="${id}"]`);
          const host = svg.getBoundingClientRect();
          const load = async (b) => {
            const img = new Image();
            img.src = "data:image/png;base64," + b;
            await img.decode();
            const c = document.createElement("canvas");
            c.width = img.naturalWidth;
            c.height = img.naturalHeight;
            const g = c.getContext("2d", { willReadFrequently: true });
            g.drawImage(img, 0, 0);
            return { g, w: c.width, h: c.height };
          };
          const A = await load(a64);
          const B = await load(b64);
          const sx = A.w / host.width;
          const sy = A.h / host.height;
          const lin = (v) => {
            const x = v / 255;
            return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
          };
          const lum = (r, g2, b2) => 0.2126 * lin(r) + 0.7152 * lin(g2) + 0.0722 * lin(b2);
          const rgb = (css) => {
            const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(css);
            return m === null ? [0, 0, 0] : [+m[1], +m[2], +m[3]];
          };
          const hex = (k) => "#" + k.toString(16).padStart(6, "0").toUpperCase();
          const rows = [];
          for (const t of svg.querySelectorAll("text")) {
            const r = t.getBoundingClientRect();
            if (r.width < 0.4 || r.height < 0.4) continue;
            const pad = 2;
            const x0 = Math.max(0, Math.floor((r.left - host.left) * sx) - pad);
            const y0 = Math.max(0, Math.floor((r.top - host.top) * sy) - pad);
            const w = Math.min(A.w - x0, Math.ceil(r.width * sx) + pad * 2);
            const h = Math.min(A.h - y0, Math.ceil(r.height * sy) + pad * 2);
            if (w <= 0 || h <= 0) continue;
            const da = A.g.getImageData(x0, y0, w, h).data;
            const db = B.g.getImageData(x0, y0, w, h).data;
            const [ir, ig, ib] = rgb(getComputedStyle(t).fill);
            const inkL = lum(ir, ig, ib);
            const grounds = new Map();
            let solid = 0;
            for (let p = 0; p < da.length; p += 4) {
              if (da[p] === db[p] && da[p + 1] === db[p + 1] && da[p + 2] === db[p + 2]) continue;
              if (Math.abs(da[p] - ir) > 6 || Math.abs(da[p + 1] - ig) > 6 || Math.abs(da[p + 2] - ib) > 6) continue;
              solid += 1;
              const k = (db[p] << 16) | (db[p + 1] << 8) | db[p + 2];
              grounds.set(k, (grounds.get(k) ?? 0) + 1);
            }
            const label = (t.textContent ?? "").slice(0, 28);
            if (solid === 0) {
              rows.push({ id, label, contrast: null, ink: hex((ir << 16) | (ig << 8) | ib), ground: "n/a" });
              continue;
            }
            let worst = Infinity;
            let worstK = null;
            for (const [k, n] of grounds) {
              if (n / solid < 0.03) continue; // a stray pixel is not a ground
              const gl = lum((k >> 16) & 255, (k >> 8) & 255, k & 255);
              const cr = (Math.max(inkL, gl) + 0.05) / (Math.min(inkL, gl) + 0.05);
              if (cr < worst) {
                worst = cr;
                worstK = k;
              }
            }
            rows.push({
              id,
              label,
              contrast: Number(worst.toFixed(2)),
              ink: hex((ir << 16) | (ig << 8) | ib),
              ground: hex(worstK),
            });
          }
          return rows;
        },
        { id, a64: lit.get(id), b64: dark.get(id) },
      )),
    );
  }
  return out;
}

/**
 * Every slice of every stacked column carries a mark.
 *
 * A census of the drawing, not an annotation added for the gate: the
 * segments of a column are the rects that share one x and one width, and
 * a mark is either a `<text>` centred inside the slice or a leader
 * `<line>` starting on the slice's own edge. Read in SVG user units
 * straight off the attributes, so it is scale-independent.
 */
async function measureMarks(page) {
  return page.evaluate(() => {
    const unmarked = [];
    let segments = 0;
    for (const svg of document.querySelectorAll("svg.chart")) {
      const num = (el, a) => Number(el.getAttribute(a));
      const rects = [...svg.querySelectorAll("rect")].filter((r) => (r.getAttribute("fill") ?? "none") !== "none");
      const byColumn = new Map();
      for (const r of rects) {
        const key = `${num(r, "x")}:${num(r, "width")}`;
        if (!byColumn.has(key)) byColumn.set(key, []);
        byColumn.get(key).push(r);
      }
      const texts = [...svg.querySelectorAll("text")];
      const lines = [...svg.querySelectorAll("line")];
      for (const [key, group] of byColumn) {
        if (group.length < 3) continue; // a stack, not a bar or a zone strip
        const [x, w] = key.split(":").map(Number);
        // A STACK IS CONTIGUOUS. Without this, the contribution chart's
        // three equal-width ceiling bars — same x, same width, 34 px
        // apart — were read as a three-slice stack and reported as three
        // unmarked slices, which is the gate inventing a defect.
        const sorted = group.slice().sort((a, c) => num(a, "y") - num(c, "y"));
        const span =
          num(sorted[sorted.length - 1], "y") + num(sorted[sorted.length - 1], "height") - num(sorted[0], "y");
        const stacked = sorted.reduce((a, r) => a + num(r, "height"), 0);
        if (Math.abs(span - stacked) > 0.6) continue;
        for (const r of group) {
          const y = num(r, "y");
          const h = num(r, "height");
          segments += 1;
          const inside = texts.some((t) => {
            const ty = num(t, "y");
            const tx = num(t, "x");
            return ty > y && ty < y + h + 3 && tx >= x - 1 && tx <= x + w + 1;
          });
          const led = lines.some((l) => {
            const y1 = num(l, "y1");
            const x1 = num(l, "x1");
            return Math.abs(x1 - (x + w)) < 3 && y1 >= y - 0.6 && y1 <= y + h + 0.6;
          });
          if (!inside && !led) {
            unmarked.push(`${svg.getAttribute("data-chart")} x=${x} y=${y} h=${h.toFixed(2)}`);
          }
        }
      }
    }
    return { segments, unmarked };
  });
}

/**
 * The band-track value marker stands clear of the band it sits on.
 *
 * The marker's colour is not what separates it from the zone underneath.
 * Computed from the palette in `tokens.ts`: ACCENT on RAMP[1] is
 * 1.23 : 1 (ΔL* 5.7) and BREACH on RAMP[0] is 1.27 : 1 (ΔL* 6.8) — on
 * the "strong" zone, which is where a healthy company's marker lands.
 * What makes it visible is that it OVERHANGS the band onto white paper,
 * where the same marks read 5.10 : 1 and 9.29 : 1.
 *
 * That is a geometric fact with no colour in it, so nothing about the
 * palette would catch its removal. This does: a marker tucked inside its
 * band would keep every token unchanged and go invisible on exactly the
 * tracks a lender reads first.
 */
const MIN_OVERHANG = 2;

/**
 * The two colours a value marker is ever drawn in, READ OUT OF THE
 * SHIPPED TOKEN FILE rather than restated here — so a palette edit moves
 * this gate with it instead of quietly emptying its census.
 */
const MARKER_FILLS = ["ACCENT", "BREACH"].map((name) => {
  const m = new RegExp(`export const ${name}\\s*=\\s*"(#[0-9A-Fa-f]{6})"`).exec(
    readFileSync(join(ROOT, "frontend/lib/charts/tokens.ts"), "utf-8"),
  );
  if (m === null) throw new Error(`tokens.ts no longer exports ${name} as a hex literal`);
  return m[1].toLowerCase();
});

async function measureOverhang(page, markerFills) {
  return page.evaluate(
    ({ minOverhang, markerFills }) => {
      const bad = [];
      let markers = 0;
      let bands = 0;
      const isMarker = (r) => markerFills.includes((r.getAttribute("fill") ?? "").toLowerCase());
      for (const svg of document.querySelectorAll("svg.chart")) {
        const num = (el, a) => Number(el.getAttribute(a));
        const filled = [...svg.querySelectorAll("rect")].filter((r) => (r.getAttribute("fill") ?? "none") !== "none");
        // THE MARKER IS IDENTIFIED BY ITS OWN COLOUR, and the band is
        // built from everything that is NOT that colour.
        //
        // A first cut identified both by geometry — a narrow rect on a
        // row of tiling rects — and THE PLANT HID FROM IT. A marker
        // moved to sit exactly inside its band takes the band's y and
        // height, joins the band's own row, breaks the tiling test, and
        // the whole track stops being recognised: the gate went green
        // and its census fell from 100 markers to 79, which is the shape
        // of a gate that has stopped looking rather than one that has
        // found nothing. A rectangle cannot shed its colour by moving.
        const zoneRects = filled.filter((r) => !isMarker(r));
        const rows = [];
        const byRow = new Map();
        for (const r of zoneRects) {
          const key = `${num(r, "y")}:${num(r, "height")}`;
          if (!byRow.has(key)) byRow.set(key, []);
          byRow.get(key).push(r);
        }
        for (const group of byRow.values()) {
          if (group.length < 3) continue;
          const sorted = group.slice().sort((a, c) => num(a, "x") - num(c, "x"));
          // A band TILES: each zone starts where the last one ended. The
          // contribution chart's ceiling and value bars share a y and a
          // height too, but they start at the same x and overlap.
          const tiles = sorted.every(
            (r, i) => i === 0 || Math.abs(num(r, "x") - (num(sorted[i - 1], "x") + num(sorted[i - 1], "width"))) < 0.7,
          );
          if (!tiles) continue;
          const last = sorted[sorted.length - 1];
          rows.push({
            y: num(sorted[0], "y"),
            h: num(sorted[0], "height"),
            x0: num(sorted[0], "x"),
            x1: num(last, "x") + num(last, "width"),
          });
        }
        bands += rows.length;
        for (const m of filled) {
          if (!isMarker(m)) continue;
          const w = num(m, "width");
          const h = num(m, "height");
          if (w > 4) continue; // a marker is a hairline; a contribution bar is not
          const cx = num(m, "x") + w / 2;
          const cy = num(m, "y") + h / 2;
          const band = rows.find((b) => cy > b.y && cy < b.y + b.h && cx >= b.x0 - 2 && cx <= b.x1 + 2);
          if (band === undefined) continue; // not on a band: not a band marker
          markers += 1;
          const above = band.y - num(m, "y");
          const below = num(m, "y") + h - (band.y + band.h);
          if (above < minOverhang || below < minOverhang) {
            bad.push(
              `${svg.getAttribute("data-chart")}: marker overhangs its band by ${above.toFixed(1)} / ${below.toFixed(1)} units`,
            );
          }
        }
      }
      return { markers, bands, bad };
    },
    { minOverhang: MIN_OVERHANG, markerFills },
  );
}

/**
 * A stacked column sums to the total printed over it.
 *
 * Read out of the RENDERED figure: the total from the `.c-val` the
 * drawing prints above each column, the parts from the chart's own
 * table, both as the strings a reader sees. MEASURED before the
 * reconciling row existed: the Agras assets column was headed
 * RON 39,319,114 over slices totalling RON 39,272,501, and carniprod's
 * funding column was 15,751 short — the same two gaps that made the
 * printed balance sheet not balance, one surface over.
 */
async function measureColumnSums(page) {
  return page.evaluate(() => {
    const bad = [];
    let columns = 0;
    const parse = (s) => {
      const t = s.replace(/[^\d.,\-−]/g, "").replace(/−/g, "-").replace(/,/g, "");
      const v = Number(t);
      return Number.isFinite(v) ? v : null;
    };
    for (const fig of document.querySelectorAll("figure[data-chart-block]")) {
      const svg = fig.querySelector("svg.chart");
      if (svg === null) continue;
      const totals = [...svg.querySelectorAll("text.c-val")]
        .map((t) => ({ x: Number(t.getAttribute("x")), v: parse(t.textContent ?? "") }))
        .filter((t) => t.v !== null);
      // A STACK IS CONTIGUOUS — same test as I2. Without it the
      // contribution chart qualifies (three ceiling bars share an x and
      // a width) and the gate compares one term's ceiling against the
      // composite, which is two unrelated numbers.
      const num = (el, a) => Number(el.getAttribute(a));
      const rects = [...svg.querySelectorAll("rect")].filter((r) => (r.getAttribute("fill") ?? "none") !== "none");
      const byColumn = new Map();
      for (const r of rects) {
        const key = `${num(r, "x")}:${num(r, "width")}`;
        if (!byColumn.has(key)) byColumn.set(key, []);
        byColumn.get(key).push(r);
      }
      const stacks = [...byColumn.values()].filter((group) => {
        if (group.length < 3) return false;
        const sorted = group.slice().sort((a, c) => num(a, "y") - num(c, "y"));
        const last = sorted[sorted.length - 1];
        const span = num(last, "y") + num(last, "height") - num(sorted[0], "y");
        const stacked = sorted.reduce((a, r) => a + num(r, "height"), 0);
        return Math.abs(span - stacked) <= 0.6;
      });
      if (stacks.length === 0) continue;
      // The table half carries the parts, prefixed by the column name.
      const parts = new Map();
      for (const tr of fig.querySelectorAll("table.chart-table tbody tr")) {
        const td = tr.querySelectorAll("td");
        if (td.length < 2) continue;
        const label = (td[0].textContent ?? "").trim();
        const side = label.split(" ")[0];
        const v = parse(td[1].textContent ?? "");
        if (v === null) continue;
        parts.set(side, (parts.get(side) ?? 0) + v);
      }
      for (const [side, sum] of parts) {
        columns += 1;
        // Match the column to its printed total by size, not by position:
        // the totals are printed in column order and so are the table's
        // groups, so the nth group belongs to the nth total.
        const idx = [...parts.keys()].indexOf(side);
        const total = totals[idx]?.v;
        if (total === undefined) {
          bad.push(`${fig.getAttribute("data-chart-block")}: "${side}" column prints no total`);
          continue;
        }
        // The printed strings are rounded to the unit, so the parts can
        // differ from the total by at most half a unit per part.
        const slack = 0.5 + parts.size;
        if (Math.abs(total - sum) > slack) {
          bad.push(
            `${fig.getAttribute("data-chart-block")}: "${side}" is headed ${total.toLocaleString("en-US")} over parts totalling ${sum.toLocaleString("en-US")}`,
          );
        }
      }
    }
    return { columns, bad };
  });
}

/** A leader on the printed contents, and whether a number follows it. */
async function measureLeaders(page) {
  return page.evaluate(() => {
    const rows = [];
    for (const li of document.querySelectorAll(".toc-print li")) {
      const a = li.querySelector("a");
      const style = (el, pseudo) => getComputedStyle(el, pseudo);
      const leaderish = (el) =>
        ["borderBottomStyle", "borderTopStyle"].some((p) => /dotted|dashed/.test(style(el)[p]));
      const after = a === null ? "" : style(a, "::after").content;
      const before = a === null ? "" : style(a, "::before").content;
      const dotRun = /\.{4,}/.test(after) || /\.{4,}/.test(before);
      rows.push({
        text: (li.textContent ?? "").trim().slice(0, 40),
        leader: leaderish(li) || (a !== null && leaderish(a)) || dotRun,
        number: /\d/.test(after) || /\d/.test(before),
      });
    }
    return rows;
  });
}

// ── run ───────────────────────────────────────────────────────────────

const books = await buildBooks();
const browser = await chromium.launch({
  channel: "chromium-headless-shell",
  args: ["--font-render-hinting=none"],
});

const inkFailures = [];
const markFailures = [];
const leaderFailures = [];
const consoleFailures = [];
const overhangFailures = [];
let glyphs = 0;
let segments = 0;
let tocRows = 0;
let markers = 0;
let bands = 0;
let columns = 0;
const columnFailures = [];

for (const b of books) {
  const context = await browser.newContext({ deviceScaleFactor: 4, viewport: { width: 900, height: 1200 } });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.route("**/*", (route) => route.abort());
  await page.setContent(b.html, { waitUntil: "load" });
  await page.emulateMedia({ media: "print" });

  const ink = await measureInk(page);
  glyphs += ink.length;
  for (const g of ink) {
    if (g.contrast === null) {
      inkFailures.push(`${b.book}/${g.id} "${g.label}" painted no solid pixel — unreadable at this size`);
    } else if (g.contrast < MIN_CONTRAST) {
      inkFailures.push(`${b.book}/${g.id} "${g.label}" ${g.ink} on ${g.ground} = ${g.contrast}:1`);
    }
  }

  const marks = await measureMarks(page);
  segments += marks.segments;
  for (const m of marks.unmarked) markFailures.push(`${b.book}: ${m}`);

  const over = await measureOverhang(page, MARKER_FILLS);
  markers += over.markers;
  bands += over.bands;
  for (const o of over.bad) overhangFailures.push(`${b.book}: ${o}`);

  const sums = await measureColumnSums(page);
  columns += sums.columns;
  for (const c of sums.bad) columnFailures.push(`${b.book}: ${c}`);

  const leaders = await measureLeaders(page);
  tocRows += leaders.length;
  for (const r of leaders) {
    if (r.leader && !r.number) leaderFailures.push(`${b.book}: "${r.text}" — leader drawn, no number resolved`);
  }

  for (const e of errors) consoleFailures.push(`${b.book}: ${e.slice(0, 160)}`);
  await context.close();
}
await browser.close();

check(
  "I1",
  inkFailures.length === 0,
  inkFailures.length === 0
    ? `${glyphs} chart glyphs across ${books.length} books, every one ≥ ${MIN_CONTRAST}:1 against the colour it is painted on`
    : `${inkFailures.length} of ${glyphs} glyphs below ${MIN_CONTRAST}:1 — ${inkFailures.slice(0, 6).join("; ")}`,
);
check(
  "I2",
  markFailures.length === 0,
  markFailures.length === 0
    ? `${segments} stacked slices, every one carrying a label or a keyed leader`
    : `${markFailures.length} of ${segments} slices carry no mark under a caption promising one: ${markFailures.slice(0, 6).join("; ")}`,
);
check(
  "I6",
  overhangFailures.length === 0,
  overhangFailures.length === 0
    ? `${markers} band markers on ${bands} bands, every one standing ≥ ${MIN_OVERHANG} units clear at both ends`
    : `${overhangFailures.length} markers no longer overhang their band: ${overhangFailures.slice(0, 4).join("; ")}`,
);
check(
  "I7",
  columnFailures.length === 0,
  columnFailures.length === 0
    ? `${columns} stacked columns, every one summing to the total printed over it`
    : `${columnFailures.length} columns headed by a total their own slices do not reach: ${columnFailures.slice(0, 4).join("; ")}`,
);
check(
  "I3",
  leaderFailures.length === 0,
  leaderFailures.length === 0
    ? `${tocRows} printed contents rows, no leader drawn without a page number`
    : `${leaderFailures.length} dot leaders end in nothing: ${leaderFailures.slice(0, 4).join("; ")}`,
);
check(
  "I5",
  consoleFailures.length === 0,
  consoleFailures.length === 0
    ? `${books.length} documents opened, 0 console errors`
    : `${consoleFailures.length} console errors: ${[...new Set(consoleFailures.map((c) => c.split("  ")[0]))].slice(0, 3).join("; ")}`,
);

// ── I4, on the produced PDF ───────────────────────────────────────────

const { renderReport, closeBrowser } = await import(join(ROOT, "services/pdf/render.mjs"));
const entity = (t) =>
  t
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&middot;/g, "·")
    .replace(/&nbsp;/g, " ");

const wasteful = [];
let pagesJudged = 0;
for (const b of books) {
  const pdf = await renderReport(b.html, { company: b.company, period: b.period });
  const texts = pageTexts(pdf.bytes);
  const ink = inkRows(pdf.bytes);
  if (texts.length !== pdf.pages) {
    check("I4", false, `read text from ${texts.length} of ${pdf.pages} pages of the ${b.book} pack — the reader failed`);
    break;
  }
  // A section opens a page when its own <h2> is the first thing after the
  // running head and the page counter. The titles come from the DOCUMENT,
  // so a renamed section cannot silently drop out of the exemption.
  const heads = [...b.html.matchAll(/<h2[^>]*>([^<]{2,60})</g)].map((m) =>
    entity(m[1]).replace(/\s+/g, "").toUpperCase(),
  );
  const rows = texts.map((p, i) => {
    const norm = p.replace(/\s+/g, " ");
    const m = /Page\s*\d+\s*of\s*\d+/.exec(norm);
    const after = norm.slice(m === null ? 0 : m.index + m[0].length).trim();
    const flat = after.replace(/\s+/g, "").toUpperCase();
    const ys = ink[i].filter((y) => y >= CONTENT_BOT - 0.5 && y <= CONTENT_TOP + 6);
    return {
      page: i + 1,
      opens: i > 1 && heads.some((h) => h.length > 3 && flat.startsWith(h)),
      trailing: (ys.length === 0 ? CONTENT_TOP : Math.min(...ys)) - CONTENT_BOT,
      head: after.slice(0, 44),
    };
  });
  rows.forEach((r, i) => {
    // Exempt: the cover, the printed contents, the last page, and the
    // last page of a section — those breaks are FORCED, and the white
    // after them is the price of "every section opens a page", not a
    // block that refused to fit.
    const forced = i <= 1 || i === rows.length - 1 || (rows[i + 1]?.opens ?? false);
    if (forced) return;
    pagesJudged += 1;
    if (r.trailing > MAX_TRAILING_PT) {
      wasteful.push(`${b.book} p${r.page} ends ${Math.round(r.trailing)} pt short (${r.head})`);
    }
  });
}
await closeBrowser();

check(
  "I4",
  wasteful.length === 0,
  wasteful.length === 0
    ? `${pagesJudged} pages whose break was not forced, none left more than ${MAX_TRAILING_PT} pt empty`
    : `${wasteful.length} near-blank pages: ${wasteful.slice(0, 6).join("; ")}`,
);

// ── report ────────────────────────────────────────────────────────────

process.stdout.write("REPORT PRINT GATE — ink, marks, leaders, whitespace\n");
process.stdout.write("=".repeat(62) + "\n");
process.stdout.write(
  `GATE-WORK report-print units=${notes.length + failures.length} floor=7 label=painted-document-assertions\n`,
);
for (const line of notes) process.stdout.write(line + "\n");
for (const line of failures) process.stdout.write(line + "\n");
process.stdout.write("-".repeat(62) + "\n");

if (process.env.REPORT_PRINT_HTML_OUT) {
  for (const b of books) writeFileSync(`${process.env.REPORT_PRINT_HTML_OUT}/${b.book}.html`, b.html);
}

if (failures.length > 0) {
  process.stdout.write(`FAIL — ${failures.length} of ${notes.length + failures.length}\n`);
  process.exit(1);
}
process.stdout.write(`PASS — ${notes.length} assertions over ${books.length} books\n`);
