// THE PRINT STYLESHEET — the A4 half of the standalone report.
//
// `financialReport.ts` builds ONE document. That document is read on a
// screen and printed to paper, and until this file existed the paper
// half was assembled out of `@media print` fragments scattered through a
// 600-line style template: an `@page` block at the top, a `@media print`
// block at the bottom, and a third set of rules inside
// `charts/documentShell.ts`. Three authors, no single place to read what
// the printed page actually does.
//
// This is that place. Everything the PAGE (as opposed to the screen)
// needs lives here, is emitted last, and therefore wins.
//
// ── WHAT THE PDF IS, AND WHY THAT MATTERS TO THIS FILE ────────────────
//
// The PDF is not a second rendering of the report. It is THIS document,
// paginated by a headless browser (`services/pdf/`), so a figure cannot
// differ between the HTML and the PDF — they are the same bytes through
// the same layout engine. That is the whole reason the renderer is a
// browser and not a PDF-drawing library: a library would re-implement
// the document and the two would drift.
//
// The consequence is that every print defect is a CSS defect, fixable
// here, and visible in any browser's own print preview.
//
// ── MEASURED, NOT ASSUMED (2026-09-08, real Agras export, Chromium) ───
//
//   before this file      30 pages · running head on page 3 only ·
//                         `RON 118,576,820` wrapped onto two lines in
//                         every KPI card · no table header repeated
//                         because no table happened to span a break
//   after                 see `pdf-lane1.md` for the re-measurement
//
// ── WHAT THIS FILE DELIBERATELY DOES NOT DO ───────────────────────────
//
// It sets no colour of its own. Every value it uses is imported from
// `charts/tokens.ts`, which is the document's one palette — a second
// palette here is how the printed page comes to disagree with the
// screen about what "muted" means.

import { INK, INK_MUTE, RULE, RULE_SOFT } from "./charts/tokens";

/**
 * The two facts the running head repeats on every page.
 *
 * They are the SAME two strings the cover prints. A running head that
 * names a different period from the cover is worse than no running head
 * at all, so both come from the caller's `Statements`, never from a
 * second read.
 */
export interface RunningHead {
  company: string;
  period: string;
}

/**
 * A company name, safe to sit inside a CSS string inside a `<style>`
 * element inside an HTML document.
 *
 * THREE escapes, three different attackers:
 *
 *   1. `<` and `>` are REMOVED, not escaped. This string is interpolated
 *      into a `<style>` element, and inside `<style>` the HTML parser
 *      recognises exactly one thing: the sequence `</style`. CSS-escaping
 *      the `<` (as `\3C`) does not help — the HTML tokeniser runs first
 *      and never sees the CSS. Removing the character is the only
 *      correct answer, and a company name has no legitimate `<` in it.
 *   2. `\` and `"` are backslash-escaped, which is what closes the CSS
 *      string-literal injection (a `"` would end the `content:` value
 *      and let the rest be parsed as declarations).
 *   3. Newlines, tabs and every other C0/C1 control are collapsed to a
 *      space: a raw newline terminates a CSS string and invalidates the
 *      whole declaration, which would silently drop the running head.
 *
 * Non-ASCII is left alone. Romanian company names carry ă â î ș ț, the
 * document is UTF-8, and mangling them to escapes would be a defect of
 * its own.
 */
export function cssString(raw: string): string {
  return raw
    .replace(/[<>]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .trim();
}

/**
 * The printed page.
 *
 * Emitted LAST in the document's `<style>`, so where it and an earlier
 * `@media print` rule disagree, this one is the answer.
 */
export function printCss(head: RunningHead): string {
  const company = cssString(head.company);
  const period = cssString(head.period);

  return `
    /* ══ A4, AND THE RUNNING HEAD ══════════════════════════════════════
       The head is written as LITERAL text, not \`string-set\` /
       \`content: string(...)\`. Both this document's facts are known at
       build time, and \`string-set\` is a paged-media feature Chromium
       does not implement — a head built on it would render EMPTY in the
       one engine that actually produces our PDF. The page counter is
       different: \`counter(page)\`/\`counter(pages)\` inside a margin box
       IS implemented (measured 2026-09-08, Chromium 143 via Playwright
       1.59.1 — every page of the 30-page Agras export printed its own
       "Page n of 30"), so it stays computed rather than baked. */
    /* ── THE DOCUMENT SAYS WHO IT IS ABOUT ────────────────────────────
       The same two strings the running head prints, in a place a
       machine can read. \`services/pdf/render.mjs\` names the downloaded
       file from THESE — not from what the caller told it — so the
       filename and the running head cannot name different companies.
       They are one interpolation of one argument; there is no second
       read to drift. */
    :root {
      --cfoai-doc-company: "${company}";
      --cfoai-doc-period: "${period}";
    }

    @page {
      size: A4;
      margin: 20mm 17mm 18mm 17mm;

      @top-left {
        content: "${company}";
        font-family: 'Inter', -apple-system, sans-serif;
        font-size: 7.5pt;
        font-weight: 600;
        letter-spacing: 0.10em;
        text-transform: uppercase;
        color: ${INK};
        vertical-align: bottom;
        padding-bottom: 5mm;
      }
      @top-right {
        content: "${period}";
        font-family: 'Inter', -apple-system, sans-serif;
        font-size: 7.5pt;
        letter-spacing: 0.10em;
        text-transform: uppercase;
        color: ${INK_MUTE};
        vertical-align: bottom;
        padding-bottom: 5mm;
      }
      @bottom-center {
        content: "Page " counter(page) " of " counter(pages);
        font-family: 'Inter', -apple-system, sans-serif;
        font-size: 8pt;
        letter-spacing: 0.04em;
        color: ${INK_MUTE};
        vertical-align: top;
        padding-top: 6mm;
      }
    }

    /* The cover carries its own identity in 26pt type. Repeating the
       company name 15mm above it in 7.5pt is noise, and a page number on
       a cover is a tell that nobody looked at the first page. */
    @page :first {
      @top-left { content: ""; }
      @top-right { content: ""; }
      @bottom-center { content: ""; }
    }

    @media print {
      /* ── ONE RUNNING HEAD, NOT TWO ────────────────────────────────
         \`.running-header\` is an in-flow div: it renders once, at the
         top of the body, i.e. on page 3 of 30 and nowhere else. It was
         the screen's header all along. On paper the @page margin box
         above does the job on EVERY page, so the div would be a second,
         contradicting head on exactly one page. */
      .running-header { display: none !important; }

      /* ── SECTION DIVIDERS ─────────────────────────────────────────
         Each of the report's ten sections opens a page. This is what
         makes it a board pack rather than a scroll: a reader handed
         "Credit and distress" can put a tab on it, and the printed
         contents page (target-counter, where the engine resolves it)
         addresses a page that begins with the section it names. */
      section.rsec { break-before: page; page-break-before: always; }
      /* …EXCEPT the first, which follows the header block on the page
         the contents opens onto. \`section.rsec:first-of-type\` does NOT
         express that: \`:first-of-type\` counts ELEMENT type, and the
         cover and the printed contents are \`<section>\` too, so it
         matched nothing and the first rule applied to all ten sections
         — measured as a page 3 carrying 144 characters and a page
         count of 32 instead of 31. The adjacency below names the real
         relationship: the executive summary opens directly under the
         header block. */
      .header-info + section.rsec {
        break-before: avoid;
        page-break-before: avoid;
      }

      /* The heading, its rule and whatever follows it stay together. */
      section.rsec > h2 {
        break-after: avoid;
        page-break-after: avoid;
        break-inside: avoid;
      }
      section.rsec > h2 + * { break-before: avoid; page-break-before: avoid; }
      section.rsec > .rsec-body > *:first-child {
        break-before: avoid;
        page-break-before: avoid;
      }

      /* ── TABLES THAT CROSS A PAGE ─────────────────────────────────
         \`<thead>\` repeats on every page a table spans — that is the
         default for \`display: table-header-group\`, and it is written
         out here because the default is the thing a later rule would
         quietly overwrite. Measured with a 60-row table forced across
         three pages: the header printed on all three. */
      table.fin { break-inside: auto; page-break-inside: auto; }
      table.fin thead {
        display: table-header-group;
        break-inside: avoid;
        break-after: avoid;
        page-break-after: avoid;
      }
      table.fin tfoot { display: table-footer-group; }
      table.fin tbody tr {
        break-inside: avoid;
        page-break-inside: avoid;
      }

      /* ── NO ORPHANED ROWS ─────────────────────────────────────────
         Four distinct ways a row is orphaned, four rules. \`orphans\`
         and \`widows\` are NOT among them: those properties count LINE
         boxes inside a block, and a table row is not a line box — the
         \`table.fin { orphans: 3; widows: 3 }\` that used to stand here
         was inert in every engine.

         (a) the first two body rows travel with the header, so a table
             never opens with a single stranded row; */
      table.fin tbody tr:first-child,
      table.fin tbody tr:first-child + tr { break-before: avoid; page-break-before: avoid; }
      /*  (b) a total or subtotal never opens a page alone, away from the
             rows it totals; */
      table.fin tbody tr.total,
      table.fin tbody tr.subtotal {
        break-before: avoid;
        page-break-before: avoid;
      }
      /*  (c) the row before a total travels with it, so the pair
             "…last line / Total" is never split; */
      table.fin tbody tr:has(+ tr.total),
      table.fin tbody tr:has(+ tr.subtotal) {
        break-after: avoid;
        page-break-after: avoid;
      }
      /*  (d) the last two body rows travel together, so a table never
             leaves one row alone on the following page. */
      table.fin tbody tr:nth-last-child(2) {
        break-after: avoid;
        page-break-after: avoid;
      }

      /* ── FIGURES THAT MUST NOT WRAP ───────────────────────────────
         MEASURED: at 19pt serif, "RON 118,576,820" is wider than a
         four-up A4 column (37.9mm of content width per card), so every
         KPI card in the executive summary broke its own figure across
         two lines and the four cards' baselines stopped agreeing. The
         screen has 1280px and no such problem; this is a print-only
         size. */
      .ratio-card .value {
        font-size: 13pt;
        overflow-wrap: normal;
        word-break: keep-all;
        hyphens: none;
        font-variant-numeric: tabular-nums;
      }
      .ratio-card .label {
        font-size: 7.5pt;
        letter-spacing: 0.08em;
      }
      /* One label in the headline strip runs to two lines — "Net income
         (account 121, as filed)" — and it pushed its own figure a line
         below the other three, so the four headline numbers stopped
         sharing a baseline. Reserving two lines in the four-up strip
         costs one blank line on the three short labels and buys an
         aligned row. Scoped to \`.grid-4\`, which is that strip and
         nothing else (measured on the Agras export: one \`.grid-4\`, six
         \`.grid-3\`), so the ratio grids keep their tight rhythm. */
      .grid-4 > .ratio-card .label { min-height: 2.5em; }
      .ratio-card { break-inside: avoid; page-break-inside: avoid; }

      /* ── CHARTS ───────────────────────────────────────────────────
         A chart is never split, and it never separates from the table
         that carries its figures — the document's rule is that no chart
         is the only place a number appears, and a chart on page 12 with
         its table on page 13 breaks that rule for a reader holding the
         paper. */
      .chart-block { break-inside: avoid; page-break-inside: avoid; }
      svg.chart { break-inside: avoid; page-break-inside: avoid; }
      svg.chart + table.fin { break-before: avoid; page-break-before: avoid; }

      /* The interactive furniture has no business on paper. \`.toolbar\`
         and \`.toc\` are already hidden by documentShell; \`.prov-card\`
         is the hover panel, which is \`hidden\` until JS shows it — and
         the PDF renderer runs with JS OFF, so it never appears. Stated
         anyway, because "it happens not to show" is not a rule. */
      #prov-card, .prov-card { display: none !important; }

      /* Links print as text. A blue underline pointing at an anchor the
         reader cannot click is ink spent on nothing. */
      a { color: ${INK}; text-decoration: none; }
      .toc-print a { color: ${INK}; }

      /* ── COLUMNS THAT TOUCH ───────────────────────────────────────
         Base cell padding is \`6.5px 0\` — no horizontal padding at all.
         At 1280px of screen that is invisible; at 176mm of A4 it is
         not. MEASURED on the executive summary's verdict table: the
         right-aligned "THIS BOOK" header and the left-aligned "VERDICT"
         header beside it printed as the single word \`THIS BOOKVERDICT\`.
         A gutter, in print only, so the screen keeps its own rhythm. */
      table.fin th + th, table.fin td + td { padding-left: 9px; }
      table.fin th.num, table.fin td.num { padding-left: 12px; }

      /* Hairlines survive a laser: sub-pixel borders drop out entirely
         on some drivers, so nothing is thinner than 0.5pt. */
      table.fin th { border-bottom-color: ${RULE}; }
      table.fin td { border-bottom-color: ${RULE_SOFT}; }
    }
  `;
}
