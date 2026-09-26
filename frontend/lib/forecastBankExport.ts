// "EXPORTĂ PENTRU BANCĂ" — the cockpit's case as a PDF a bank can read, in
// the CFO Report's own style (Paper palette, serif headings, hairline tables,
// the same A4 running head from `reportPrintCss.ts`), rendered by the SAME
// pipeline the CFO Report uses: the engine serves the export's DATA (POST
// /api/forecast/{id}/cockpit/export → {document, cockpit, assumptions_page}),
// this module lays it out as a standalone HTML document, and `lib/reportPdf.ts`
// posts that to /api/report/pdf, where the cfo-ai-pdf sidecar paginates it
// with JavaScript off.
//
// WHAT THE DOCUMENT CARRIES, IN THIS ORDER
//   1. the cover — company, the case, the period the plan stands on, the
//      engine's note that every ◇ figure is projected;
//   2. the four numbers, the engine's sentence, the chart, the bridge from the
//      base case;
//   3. THE ASSUMPTIONS PAGE — the case and its basis; every lever with its
//      value, where the value came from and its basis; the DSCR formula and
//      threshold; the funding line; the measured fixed/variable split; the
//      model's conventions; what it does not model; every external source;
//   4. the projected profit and loss, balance sheet and cash flow, year 0
//      (actual) beside the five plan years.
//
// THE DOCUMENT DOES NO MATH, exactly like the page: the four numbers and the
// sentence are the engine's own formatted text; every other amount is a served
// amount read through the cockpit gateway ONCE, in `paint` (`cockpitDisplay`),
// ◇ on a projection; the chart reads each value ONCE, in `plotValue`
// (`cockpitPlot`), for pixels. cockpitNoMoneyMath.test.ts holds both.

import type { TFunction } from "i18next";

import {
  bookAmount,
  cockpitDisplay,
  cockpitPlot,
  pick,
  readCockpit,
  type Bilingual,
  type CockpitAmount,
  type CockpitView,
  type StatementRow,
} from "@/lib/forecastCockpit";
import { servedText } from "@/lib/forecastSentences";
import { printCss } from "@/lib/reportPrintCss";
import { ACCENT, BREACH, INK, INK_MUTE, INK_SOFT, PAPER, RULE, RULE_SOFT } from "@/lib/charts/tokens";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface BankExportInput {
  /** The raw answer of POST .../cockpit/export. */
  readonly payload: unknown;
  /** The company on screen (the payload's own name wins when it serves one). */
  readonly companyName: string;
  readonly lang: string;
  readonly locale: string;
  readonly t: TFunction;
  /** The page's full-money formatter, one value at a time. */
  readonly format: (value: number) => string;
}

const MARK = `<sup class="pm" aria-label="projected">◇</sup>`;

type Raw = Record<string, unknown>;
const rec = (x: unknown): Raw | null =>
  typeof x === "object" && x !== null && !Array.isArray(x) ? (x as Raw) : null;
const str = (x: unknown): string => (typeof x === "string" ? x : "");
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const two = (x: unknown): Bilingual | null => {
  const r = rec(x);
  if (r && (typeof r.ro === "string" || typeof r.en === "string")) {
    return { ro: str(r.ro) || str(r.en), en: str(r.en) || str(r.ro) };
  }
  if (r && typeof r.text === "string") return { ro: r.text, en: r.text };
  return typeof x === "string" && x ? { ro: x, en: x } : null;
};

/** THE ONE READ of an amount in this module: a served amount as printed text
 *  with its mark (projected) or without (actual), or an em dash. */
function paint(amount: CockpitAmount, format: (v: number) => string, lang: string): string {
  const html = cockpitDisplay(amount, (value, marker) =>
    marker.projected
      ? `<span class="num" data-projected="true" data-period="${esc(marker.period)}">${esc(format(value))}${MARK}</span>`
      : `<span class="num" data-actual="true">${esc(format(value))}</span>`,
  );
  return html ?? `<span class="refused" title="${esc(pick(amount.refusal, lang))}">—</span>`;
}

/** The chart's one geometry read (pixels only; nothing printed from it). */
function plotValue(amount: CockpitAmount): number | null {
  return cockpitPlot(amount);
}

function chartSvg(c: CockpitView): string {
  const W = 640;
  const H = 200;
  const PX = 12;
  const PT = 12;
  const PB = 24;
  const columns = c.chart.ebitda.map((b) => b.period);
  const n = Math.max(columns.length, 1);
  const band = (W - PX * 2) / n;
  const colOf = (p: string) => columns.indexOf(/^FY\d{4}$/.test(p) ? p : `FY${p.slice(0, 4)}`);
  const monthsIn = new Map<number, number>();
  for (const p of c.chart.cash) {
    if (/^\d{4}-\d{2}$/.test(p.period)) monthsIn.set(colOf(p.period), (monthsIn.get(colOf(p.period)) ?? 0) + 1);
  }
  const seen = new Map<number, number>();
  const pts = c.chart.cash.flatMap((p) => {
    const col = colOf(p.period);
    if (col < 0) return [];
    const months = monthsIn.get(col) ?? 0;
    let x = PX + band * (col + 0.5);
    if (/^\d{4}-\d{2}$/.test(p.period) && months > 0) {
      const k = seen.get(col) ?? 0;
      seen.set(col, k + 1);
      x = PX + band * col + (band * (k + 0.5)) / months;
    }
    return [{ x, level: plotValue(p.cash), gap: p.gap ? plotValue(p.cashBeforeFunding) : null, w: months > 0 ? band / months : band * 0.6 }];
  });
  const bars = c.chart.ebitda.map((b) => plotValue(b.amount));
  const vals = [...bars, ...pts.flatMap((p) => [p.level, p.gap])].filter((v): v is number => v !== null);
  const lo = Math.min(0, ...vals);
  const hi = Math.max(0, ...vals);
  const span = hi - lo || 1;
  const y = (v: number) => PT + ((hi - v) / span) * (H - PT - PB);
  const zero = y(0);
  const bw = Math.min(52, band * 0.46);
  const parts: string[] = [`<line x1="${PX}" x2="${W - PX}" y1="${zero}" y2="${zero}" stroke="${RULE}" stroke-width="1"/>`];
  for (const p of pts) {
    if (p.gap !== null) {
      parts.push(`<rect x="${p.x - p.w / 2}" width="${p.w}" y="${zero}" height="${Math.max(0, y(p.gap) - zero)}" fill="${BREACH}" fill-opacity="0.2"/>`);
    }
  }
  c.chart.ebitda.forEach((b, i) => {
    const v = bars[i];
    const x = PX + band * (i + 0.5);
    if (v !== null) {
      parts.push(
        `<rect x="${x - bw / 2}" width="${bw}" y="${Math.min(y(v), zero)}" height="${Math.max(1, Math.abs(y(v) - zero))}" fill="${INK_SOFT}" fill-opacity="${b.amount.kind === "actual" ? "0.45" : "1"}"/>`,
      );
    }
    parts.push(`<text x="${x}" y="${H - 6}" text-anchor="middle" font-size="10" fill="${INK_MUTE}">${esc(b.period.replace(/^FY/, ""))}</text>`);
  });
  const line = pts
    .filter((p) => p.level !== null)
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${y(p.level as number)}`)
    .join(" ");
  if (line) parts.push(`<path d="${line}" fill="none" stroke="${ACCENT}" stroke-width="2.5"/>`);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" width="100%" role="img">${parts.join("")}</svg>`;
}

function statementTable(title: string, rows: readonly StatementRow[], years: readonly string[], withYear0: boolean, input: BankExportInput): string {
  const { t, lang, format } = input;
  const plan = years.slice(1);
  const head =
    (withYear0 ? `<th class="num">${esc(years[0] ?? "")} · ${esc(t("forecast.cockpit.appendixActual", "actual"))}</th>` : "") +
    plan.map((y) => `<th class="num">${esc(y)}</th>`).join("");
  const body = rows
    .map((r) => {
      const y0 = withYear0 ? `<td class="num">${r.year0 ? paint(r.year0, format, lang) : ""}</td>` : "";
      const cells = r.values.map((v) => `<td class="num">${paint(v, format, lang)}</td>`).join("");
      return `<tr><td>${esc(pick(r.label, lang))}</td>${y0}${cells}</tr>`;
    })
    .join("");
  return `<section class="rsec"><h2>${esc(title)}</h2><table class="fin"><thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody></table></section>`;
}

/** The whole bank document, as the standalone HTML the PDF renderer prints.
 *  Throws when the payload is not the engine's export (nothing half-made is
 *  ever sent to the renderer). */
export function buildBankExportHtml(input: BankExportInput): string {
  const { t, lang, format } = input;
  const root = rec(input.payload) ?? {};
  const doc = rec(root.document) ?? {};
  const page = rec(root.assumptions_page) ?? {};
  const c = readCockpit(root.cockpit);
  if (!c) throw new Error("the engine's export carries no cockpit");
  const lng = lang.toLowerCase().startsWith("ro") ? "ro" : "en";
  const company = str(doc.company_name) || c.companyName || input.companyName;
  const caseName = pick(two(rec(doc.case)?.label) ?? c.caseLabel, lang);
  const n = c.numbers;
  const sections = rec(doc.sections) ?? {};
  const section = (key: string, fallback: string) => pick(two(sections[key]), lang) || fallback;
  const say = (text: string) => servedText(t, lang, text);

  const kpi = (label: string, value: string, sub: string, tone = "") =>
    `<div class="kpi ${tone}"><div class="l">${esc(label)}</div><div class="v"><span class="num" data-projected="true">${esc(value)}${MARK}</span></div>${sub ? `<div class="s">${sub}</div>` : ""}</div>`;
  const cash =
    n.cash.kind === "funding_need"
      ? kpi(
          t("forecast.cockpit.numbers.fundingNeed", "Funding need"),
          pick(n.cash.amount, lang),
          `${esc(
            n.cash.firstGranularity === "annual"
              ? t("forecast.cockpit.numbers.fundingDuring", "during {{year}}", { year: pick(n.cash.when, lang) })
              : t("forecast.cockpit.numbers.fundingFrom", "from {{month}}", { month: pick(n.cash.when, lang) }),
          )} · ${esc(t("forecast.cockpit.numbers.fundingInterest", "interest"))} <span class="num" data-projected="true">${esc(pick(n.cash.interest, lang))}${MARK}</span>`,
          "warn",
        )
      : kpi(
          t("forecast.cockpit.numbers.minCash", "Lowest cash"),
          pick(n.cash.amount, lang),
          esc(t("forecast.cockpit.numbers.minCashWhen", "in {{month}} · no funding needed", { month: pick(n.cash.when, lang) })),
        );
  const year = (p: string) => p.replace(/^FY/, "");
  const dscr =
    n.dscr.kind === "served"
      ? kpi(
          t("forecast.cockpit.numbers.dscr", "DSCR {{year}}", { year: year(n.dscr.period) }),
          pick(n.dscr.value, lang),
          `${esc(n.dscr.below ? t("forecast.cockpit.numbers.dscrBelow", "below the bank's threshold") : t("forecast.cockpit.numbers.dscrAbove", "above the bank's threshold"))} ${esc(t("forecast.cockpit.numbers.dscrThreshold", "of {{threshold}}", { threshold: pick(n.dscr.threshold, lang) }))}`,
          n.dscr.below ? "bad" : "good",
        )
      : `<div class="kpi"><div class="l">${esc(t("forecast.cockpit.numbers.dscr", "DSCR {{year}}", { year: year(n.dscr.period) }))}</div><div class="s">${esc(t("forecast.cockpit.numbers.dscrNone", "Not applicable: the plan carries no debt service in {{year}}", { year: year(n.dscr.period) }))}</div></div>`;
  // The same sub-line the page prints: the margin with today's beside it,
  // or — where the ENGINE refused the margin because turnover is negligible
  // against operating activity — the engine's sentence, never a percent.
  const refusedMargin = n.ebitda.marginRefused ?? n.ebitda.marginYear0Refused;
  const ebitdaSub = n.ebitda.margin
    ? `${esc(t("forecast.cockpit.numbers.margin", "margin"))} <span class="num" data-projected="true">${esc(pick(n.ebitda.margin, lang))}${MARK}</span>${
        n.ebitda.marginYear0
          ? ` · ${esc(t("forecast.cockpit.numbers.today", "today"))} ${esc(pick(n.ebitda.marginYear0, lang))}`
          : n.ebitda.marginYear0Refused
            ? ` · ${esc(t("forecast.cockpit.numbers.today", "today"))}: <span data-margin-refused="today">${esc(pick(n.ebitda.marginYear0Refused, lang))}</span>`
            : ""
      }`
    : refusedMargin
      ? `<span data-margin-refused="final">${esc(pick(refusedMargin, lang))}</span>${
          n.ebitda.marginRefused && !n.ebitda.marginYear0Refused && n.ebitda.marginYear0
            ? ` · ${esc(t("forecast.cockpit.numbers.today", "today"))} ${esc(pick(n.ebitda.marginYear0, lang))}`
            : ""
        }`
      : "";
  // The engine's one note for its one case (a developer's capitalised 711).
  const marginNote = n.ebitda.note
    ? `<p class="note" data-margin-note="1">${esc(pick(n.ebitda.note, lang))}</p>`
    : "";

  const bridgeOf = (b: CockpitView["bridge"]["horizon"], title: string) =>
    b
      ? `<h3>${esc(title)}</h3><table class="fin"><tbody>${b.steps
          .map((s) => `<tr${s.total || s.subtotal ? ' class="total"' : ""}><td>${esc(pick(s.label, lang))}</td><td class="num">${paint(s.amount, format, lang)}</td></tr>`)
          .join("")}</tbody></table>`
      : "";
  const showBridge = c.caseId !== "base" || c.caseModified;
  const bridge = showBridge
    ? [
        `<h2>${esc(section("bridge", t("forecast.cockpit.bridge.title", "Bridge from {{from}}", { from: "base" })))}</h2>`,
        bridgeOf(c.bridge.yearOne, t("forecast.cockpit.bridge.yearOne", "Year one")),
        bridgeOf(c.bridge.horizon, t("forecast.cockpit.bridge.horizon", "To {{year}}", { year: year(c.bridge.horizon?.period ?? "") })),
      ].join("")
    : "";

  const pcase = rec(page.case) ?? {};
  const leverRows = arr(page.levers)
    .map((raw) => {
      const l = rec(raw) ?? {};
      const locked = str(rec(l.locked)?.text);
      const inert = pick(two(l.inert), lang);
      const note = [locked, inert].filter(Boolean).map((x) => `<div class="note-s">${esc(x)}</div>`).join("");
      return `<tr><td>${esc(pick(two(l.label), lang))}</td><td class="num">${esc(pick(two(l.display), lang) || t("forecast.cockpit.levers.notMeasured", "not measured"))}</td><td>${esc(pick(two(l.origin_label), lang))}</td><td class="basis">${esc(pick(two(l.basis), lang))}${note}</td></tr>`;
    })
    .join("");
  const dscrPage = rec(page.dscr) ?? {};
  const funding = rec(page.funding_line) ?? {};
  const refBasis = pick(two(rec(funding.reference)?.basis), lang);
  const rateBasis = str(rec(funding.rate_basis)?.text) || str(funding.rate_basis);
  const pools = arr(page.cost_behaviour)
    .map((raw) => {
      const p = rec(raw) ?? {};
      const share = typeof p.fixed_share_ppm === "number" ? `${new Intl.NumberFormat(input.locale, { style: "percent", maximumFractionDigits: 1 }).format(p.fixed_share_ppm / 1_000_000)}` : "—";
      return `<tr><td>${esc(pick(two(p.label), lang) || str(p.pool))}</td><td class="num">${paint(bookAmount(p.base_minor, c.basePeriodLabel), format, lang)}</td><td class="num">${esc(share)}</td><td class="basis">${esc(say(str(p.sentence)))}</td></tr>`;
    })
    .join("");
  const list = (items: unknown[]) =>
    `<ul>${items
      .map((raw) => {
        const x = rec(raw) ?? {};
        return `<li>${esc(say(str(x.sentence) || str(rec(x.sentence)?.text)))}</li>`;
      })
      .join("")}</ul>`;
  const sources = arr(page.sources)
    .map((raw) => {
      const s = rec(raw) ?? {};
      const url = str(s.source_url);
      return `<li>${esc(str(s.source) || str(s.series_id))}${url ? ` — ${esc(url)}` : ""}</li>`;
    })
    .join("");

  const css = `
    :root { --serif: 'Source Serif Pro', 'Source Serif 4', Charter, Georgia, 'Times New Roman', serif; --sans: 'Inter', -apple-system, 'Segoe UI', system-ui, Arial, sans-serif; }
    * { box-sizing: border-box; }
    html, body { background: ${PAPER}; }
    body { font-family: var(--sans); font-size: 10.5pt; line-height: 1.5; color: ${INK_SOFT}; margin: 0 auto; padding: 40px 48px; max-width: 880px; }
    .num { font-variant-numeric: tabular-nums lining-nums; white-space: nowrap; }
    .pm { font-size: 0.62em; color: ${INK_MUTE}; margin-left: 0.15em; }
    .refused { color: ${INK_MUTE}; }
    h1, h2, h3 { font-family: var(--serif); color: ${INK}; font-weight: 600; }
    h2 { font-size: 15pt; margin: 0 0 10px; padding-bottom: 6px; border-bottom: 1px solid ${RULE}; }
    h3 { font-size: 11.5pt; margin: 18px 0 6px; }
    .cover { min-height: 70vh; display: flex; flex-direction: column; justify-content: center; }
    .cover-rule { height: 3px; width: 72px; background: ${INK}; margin-bottom: 24px; }
    .cover-kicker { font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.18em; color: ${INK_MUTE}; margin-bottom: 12px; }
    .cover h1 { font-size: 34pt; line-height: 1.05; margin: 0 0 10px; letter-spacing: -0.02em; }
    .cover-case { font-family: var(--serif); font-size: 16pt; color: ${INK_SOFT}; margin-bottom: 26px; }
    .cover dl { display: grid; grid-template-columns: 170px 1fr; gap: 6px 16px; border-top: 1px solid ${RULE}; padding-top: 16px; font-size: 10pt; }
    .cover dt { color: ${INK_MUTE}; text-transform: uppercase; letter-spacing: 0.10em; font-size: 8.25pt; }
    .cover dd { margin: 0; color: ${INK}; }
    .note { border-left: 3px solid ${ACCENT}; padding: 8px 12px; font-size: 9.5pt; color: ${INK_SOFT}; }
    .note-s { font-size: 8pt; color: ${BREACH}; margin-top: 2px; }
    .sentence { font-family: var(--serif); font-size: 13pt; color: ${INK}; margin: 14px 0; }
    .kpis { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin: 8px 0 4px; }
    .kpi { border: 1px solid ${RULE}; border-left: 3px solid ${RULE}; padding: 9px 12px; break-inside: avoid; }
    .kpi.good { border-left-color: ${ACCENT}; } .kpi.bad, .kpi.warn { border-left-color: ${BREACH}; }
    .kpi .l { font-size: 8pt; text-transform: uppercase; letter-spacing: 0.10em; color: ${INK_MUTE}; }
    .kpi .v { font-family: var(--serif); font-size: 17pt; color: ${INK}; margin-top: 2px; }
    .kpi .s { font-size: 9pt; color: ${INK_SOFT}; margin-top: 2px; }
    .chart { display: block; margin: 12px 0 2px; }
    .legend { font-size: 8.5pt; color: ${INK_MUTE}; }
    table.fin { width: 100%; border-collapse: collapse; font-size: 8.75pt; margin: 4px 0 12px; }
    table.fin th { text-align: left; font-weight: 600; color: ${INK_MUTE}; font-size: 8pt; text-transform: uppercase; letter-spacing: 0.06em; border-bottom: 1px solid ${RULE}; padding: 4px 6px; }
    table.fin td { border-bottom: 1px solid ${RULE_SOFT}; padding: 3px 6px; vertical-align: top; }
    table.fin .num { text-align: right; }
    table.fin tr.total td { color: ${INK}; font-weight: 600; }
    td.basis { font-size: 8.5pt; color: ${INK_SOFT}; }
    ul { margin: 4px 0 12px; padding-left: 18px; font-size: 9pt; }
    section.rsec { break-before: page; page-break-before: always; }
  `;

  const title = pick(two(doc.title), lang) || t("forecast.cockpit.export.title", "Financial projection");
  const s = c.statements;
  return `<!DOCTYPE html>
<html lang="${lng}"><head><meta charset="UTF-8"><title>${esc(`${company} — ${title}`)}</title>
<style>${css}${printCss({ company, period: `${caseName} · ${c.basePeriodLabel}` })}</style></head>
<body data-forecast-export="bank">
<section class="cover">
  <div class="cover-rule"></div>
  <div class="cover-kicker">${esc(title)}</div>
  <h1>${esc(company)}</h1>
  <div class="cover-case">${esc(t("forecast.cockpit.export.case", "Case: {{name}}", { name: caseName }))}</div>
  <dl>
    <dt>${esc(t("forecast.cockpit.export.standsOn", "Stands on"))}</dt><dd>${esc(c.basePeriodLabel)}</dd>
    <dt>${esc(t("forecast.cockpit.export.horizon", "Horizon"))}</dt><dd>${esc(c.years.join(", "))}</dd>
    <dt>${esc(t("forecast.cockpit.export.currency", "Currency"))}</dt><dd>${esc(c.currency)}</dd>
  </dl>
  <p class="note">${esc(pick(two(doc.projected_note), lang) || t("forecast.cockpit.export.projectedNote", "Every figure marked ◇ is a projection.", { base: c.basePeriodLabel }))}</p>
</section>
<section class="rsec" id="summary">
  <h2>${esc(section("numbers", t("forecast.cockpit.export.summary", "The plan in four numbers")))}</h2>
  <div class="kpis">
    ${kpi(t("forecast.cockpit.numbers.ebitda", "EBITDA {{year}}", { year: year(n.ebitda.period) }), pick(n.ebitda.amount, lang), ebitdaSub)}
    ${kpi(t("forecast.cockpit.numbers.fcf", "Free cash flow {{from}}–{{to}}", { from: year(n.fcf.from), to: year(n.fcf.to) }), pick(n.fcf.amount, lang), esc(pick(n.fcf.formula, lang)))}
    ${cash}
    ${dscr}
  </div>
  ${marginNote}
  <p class="sentence">${esc(pick(two(doc.sentence) ?? c.sentence, lang))}</p>
  <h3>${esc(section("chart", t("forecast.cockpit.chart.aria", "EBITDA and cash")))}</h3>
  ${chartSvg(c)}
  <div class="legend">${esc(t("forecast.cockpit.export.legend", "Bars: EBITDA. Line: cash. Shaded: below zero before the funding line."))}</div>
  ${bridge}
</section>
<section class="rsec" id="assumptions">
  <h2>${esc(pick(two(page.title), lang) || t("forecast.cockpit.export.assumptions", "Assumptions"))}</h2>
  <p><strong>${esc(pick(two(pcase.label), lang) || caseName)}</strong> — ${esc(pick(two(pcase.basis), lang))}</p>
  <h3>${esc(section("levers", t("forecast.cockpit.levers.title", "Assumptions")))}</h3>
  <table class="fin"><thead><tr><th>${esc(t("forecast.assumptions.driver", "Driver"))}</th><th class="num">${esc(t("forecast.assumptions.value", "Value"))}</th><th>${esc(t("forecast.cockpit.export.origin", "From"))}</th><th>${esc(t("forecast.assumptions.basis", "Basis"))}</th></tr></thead><tbody>${leverRows}</tbody></table>
  <h3>DSCR</h3>
  <p>${esc(pick(two(dscrPage.formula), lang))} · ${esc(t("forecast.cockpit.export.threshold", "threshold"))} ${esc(str(dscrPage.threshold))}</p>
  <h3>${esc(t("forecast.cockpit.export.fundingLine", "The credit line"))}</h3>
  <p>${esc(say(rateBasis))}${refBasis ? `<br>${esc(refBasis)}` : ""}</p>
  <h3>${esc(section("cost_behaviour", t("forecast.cockpit.export.costBehaviour", "Fixed and variable costs")))}</h3>
  <table class="fin"><thead><tr><th></th><th class="num">${esc(c.basePeriodLabel)}</th><th class="num">${esc(t("forecast.cockpit.export.fixedShare", "fixed share"))}</th><th>${esc(t("forecast.assumptions.basis", "Basis"))}</th></tr></thead><tbody>${pools}</tbody></table>
  <h3>${esc(section("conventions", t("forecast.cockpit.conventions", "Model conventions")))}</h3>
  ${list(arr(page.conventions))}
  <h3>${esc(section("not_modelled", t("forecast.cockpit.notModelled", "What this forecast does not model")))}</h3>
  ${list(arr(page.not_modelled))}
  ${sources ? `<h3>${esc(section("sources", t("forecast.cockpit.export.sources", "External sources")))}</h3><ul>${sources}</ul>` : ""}
</section>
${statementTable(t("forecast.block.pl", "Profit and loss"), s.pl, s.years, true, input)}
${statementTable(t("forecast.block.bs", "Balance sheet"), s.bs, s.years, true, input)}
${statementTable(t("forecast.block.cf", "Cash flow"), s.cf, s.years, false, input)}
</body></html>`;
}
