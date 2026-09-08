// G-P1 — THE PRINTED PAGE.
//
// Everything here is asserted over the STYLESHEET THE DOCUMENT ACTUALLY
// SHIPS — `printCss()` directly for the rules, and the full
// `buildReportHtml()` output for the wiring, so a rule that is written
// but never reaches the document fails here rather than passing.
//
// WHAT THIS FILE REDS ON, once the product is correct (TC-11):
//   · the running head losing the company or the period, or gaining a
//     second copy (the in-flow `.running-header` div un-hidden);
//   · a company name escaping the CSS string it sits in, or breaking
//     out of the `<style>` element around it;
//   · the page counter being baked instead of counted;
//   · the ten sections stopping opening their own page, or the
//     executive summary starting to waste one;
//   · `<thead>` losing `table-header-group`, which is how a 60-row
//     table silently stops repeating its header on page two;
//   · a second `@page` block reappearing, which is how the printed
//     margins come to be set in two places that disagree.
//
// WHAT IT CANNOT SEE: whether Chromium honours any of it. CSS that
// parses is not CSS that paginates. `scripts/check_report_pdf.mjs`
// renders the real book and reads the produced PDF; this file is the
// cheap half that runs without a browser.

import { describe, it, expect } from "vitest";

import { printCss, cssString } from "@/lib/reportPrintCss";
import { exportHtml, withInsights, BOOKS } from "./exportBooks";

const HEAD = { company: "Agras Impex SRL", period: "FY2025" };

/**
 * The stylesheet with its COMMENTS REMOVED.
 *
 * Every "this rule is absent" assertion below has to read declarations
 * only. The comments in `reportPrintCss.ts` name the rules that were
 * REMOVED and why — `orphans`, `widows`, `:first-of-type` — so a naive
 * `not.toMatch(/orphans:/)` over the raw string matches the explanation
 * of the fix and reds on the repaired product. That is precisely the
 * "gate that encodes the defect" failure mode, inverted.
 */
function declarations(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, " ");
}

/** The `<style>` contents of the produced document, comments included. */
function styleBlock(html: string): string {
  const m = /<style>([\s\S]*?)<\/style>/.exec(html);
  if (m === null) throw new Error("the produced document carries no <style> element");
  return m[1];
}

describe("§1 the running head repeats, and says what it is looking at", () => {
  const css = printCss(HEAD);

  it("names the company in the top-left margin box", () => {
    expect(css).toMatch(/@top-left\s*\{[^}]*content:\s*"Agras Impex SRL"/);
  });

  it("names the period in the top-right margin box", () => {
    expect(css).toMatch(/@top-right\s*\{[^}]*content:\s*"FY2025"/);
  });

  it("COUNTS the page rather than baking a number", () => {
    // A literal "Page 3 of 31" would be right for exactly one document
    // and wrong for every re-render. The counter is the whole point.
    expect(css).toMatch(/@bottom-center\s*\{[^}]*counter\(page\)[^}]*counter\(pages\)/);
  });

  it("blanks all three boxes on the cover", () => {
    const first = /@page :first\s*\{([\s\S]*?)\n    \}/.exec(css);
    expect(first, "no `@page :first` rule in the stylesheet").not.toBeNull();
    const body = first![1];
    for (const box of ["@top-left", "@top-right", "@bottom-center"]) {
      expect(body, `${box} not blanked on the cover`).toMatch(
        new RegExp(`${box}\\s*\\{\\s*content:\\s*"";`),
      );
    }
  });

  it("writes the same two facts where a machine can read them", () => {
    // `services/pdf/render.mjs` names the downloaded file from these
    // custom properties rather than from what the caller told it, so
    // the filename and the running head are one interpolation of one
    // argument and cannot name different companies.
    expect(css).toMatch(/--cfoai-doc-company:\s*"Agras Impex SRL";/);
    expect(css).toMatch(/--cfoai-doc-period:\s*"FY2025";/);
  });

  it("hides the in-flow header div, so the head is not printed twice", () => {
    // `.running-header` renders ONCE, near the top of the body. On paper
    // that is one page carrying a header the other thirty do not, and it
    // is the page the margin box already headed.
    expect(css).toMatch(/\.running-header\s*\{\s*display:\s*none\s*!important;\s*\}/);
  });
});

describe("§2 a company name is not a CSS string until it is made one", () => {
  it("escapes the quote that would end the content value", () => {
    expect(cssString('ACME "GOLD" SRL')).toBe('ACME \\"GOLD\\" SRL');
  });

  it("escapes a backslash before it can escape something else", () => {
    expect(cssString("A\\B")).toBe("A\\\\B");
  });

  it("REMOVES angle brackets — CSS escaping cannot save a <style> block", () => {
    // The HTML tokeniser runs before the CSS parser and looks for the
    // literal characters `</style`. `\3C` is a CSS escape the tokeniser
    // never sees, so removal is the only correct answer.
    expect(cssString("A</style><script>alert(1)</script>B")).toBe(
      "A/stylescriptalert(1)/scriptB",
    );
    expect(cssString("</style>")).not.toContain("<");
  });

  it("collapses a newline, which would terminate the string and drop the head", () => {
    expect(cssString("ACME\nSRL")).toBe("ACME SRL");
    expect(cssString("ACME\r\n\tSRL")).toBe("ACME SRL");
  });

  it("leaves Romanian diacritics alone — the document is UTF-8", () => {
    expect(cssString("SOCIETATEA AGRICOLĂ ȘTEFAN ȚARĂ SRL")).toBe(
      "SOCIETATEA AGRICOLĂ ȘTEFAN ȚARĂ SRL",
    );
  });

  it("a hostile name cannot reach the document as markup or as a declaration", () => {
    const hostile = 'X</style><img src=x onerror=alert(1)>"; } body { display: none } .a{ content: "';
    const css = printCss({ company: hostile, period: "FY2025" });
    expect(css).not.toContain("</style");
    expect(css).not.toContain("<img");
    // Every `"` that survives is escaped, so the string never closes early.
    const inside = /@top-left\s*\{\s*content:\s*"((?:[^"\\]|\\.)*)"/.exec(css);
    expect(inside, "the top-left content value is not a well-formed CSS string").not.toBeNull();
  });
});

describe("§3 the shape of a board pack", () => {
  const css = printCss(HEAD);

  it("opens each section on its own page", () => {
    expect(css).toMatch(/section\.rsec\s*\{\s*break-before:\s*page;/);
  });

  it("…except the first, which follows the header block", () => {
    // Written as an ADJACENCY, not `:first-of-type`. `:first-of-type`
    // counts element type, and the cover and the printed contents are
    // `<section>` too — it matched nothing, and the measured cost was a
    // page 3 carrying 144 characters.
    expect(css).toMatch(/\.header-info \+ section\.rsec\s*\{[^}]*break-before:\s*avoid/);
    expect(declarations(css)).not.toMatch(/section\.rsec:first-of-type/);
  });

  it("repeats a table's header on every page the table spans", () => {
    expect(css).toMatch(/table\.fin thead\s*\{[^}]*display:\s*table-header-group/);
  });

  it("does not rely on `orphans`/`widows`, which do not apply to table rows", () => {
    // Those properties count LINE boxes inside a block. The rule they
    // replaced (`table.fin { orphans: 3; widows: 3 }`) was inert in
    // every engine, and reading it made the orphan problem look solved.
    expect(declarations(css)).not.toMatch(/orphans:/);
    expect(declarations(css)).not.toMatch(/widows:/);
  });

  it("keeps a total with the rows it totals, in both directions", () => {
    expect(css).toMatch(/tr\.total,[\s\S]{0,80}tr\.subtotal\s*\{[^}]*break-before:\s*avoid/);
    expect(css).toMatch(/tr:has\(\+ tr\.total\)/);
    expect(css).toMatch(/tr:nth-last-child\(2\)\s*\{[^}]*break-after:\s*avoid/);
  });

  it("never splits a chart from the table that carries its figures", () => {
    expect(css).toMatch(/svg\.chart \+ table\.fin\s*\{[^}]*break-before:\s*avoid/);
  });
});

describe("§4 it reaches the document, and it is the only page authority", () => {
  const html = exportHtml("agras", withInsights("agras"));

  it("the running head is in the shipped document, not just in the function", () => {
    expect(html).toContain("@top-left");
    expect(html).toMatch(/content:\s*"input"/); // the fixture's own company name
  });

  it("exactly ONE `@page` block ships", () => {
    // Two `@page` rules is how the printed margin comes to be set in two
    // places and the second one wins silently. The block that used to
    // open `financialReport.ts`'s style template is gone; this is that
    // assertion, over the bytes.
    const pageRules = html.match(/@page\s*\{/g) ?? [];
    expect(pageRules.length, `found ${pageRules.length} @page blocks`).toBe(1);
  });

  it("the print stylesheet is emitted LAST, so it wins", () => {
    // It is written to be the final word on the page; if another
    // `@media print` block moved after it, that stops being true and
    // nothing else in this file would notice. Read inside the <style>
    // element — `.toc-print` and friends also appear in the MARKUP,
    // which is after every stylesheet and would make any ordering
    // assertion over the whole document meaningless.
    const style = styleBlock(html);
    // The LAST `@media print` block in the document must be this one.
    // There are three in total — `financialReport.ts`'s own, the one in
    // `charts/documentShell.ts`, and this file's — and CSS is
    // last-declaration-wins, so which one is last is the whole
    // question. Anchored on a selector that exists nowhere else.
    const lastPrintBlock = style.slice(style.lastIndexOf("@media print"));
    expect(lastPrintBlock).toContain(".header-info + section.rsec");
    expect(style.match(/@media print/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("every book carries it — this is not one book's stylesheet", () => {
    for (const book of BOOKS) {
      const doc = exportHtml(book, withInsights(book));
      expect(doc, `${book} has no @page rule`).toContain("@page");
      expect(doc, `${book} has no repeating head`).toContain("@top-left");
    }
  });
});
