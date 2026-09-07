// G-C2 — THE INTERACTIVE DOCUMENT: R6, offline, and the print structure.
//
// R6 is the hard one and it is enforced STRUCTURALLY, not by promise.
// Every state of every toggle is rendered into the document at build
// time; the document's one script can only change which pre-rendered
// state is visible. The temptation it forecloses is specific and cheap:
// read "RON 18,420,491" out of the DOM, strip the separators, multiply by
// an FX rate, write it back — a figure no engine ever computed, rounded
// by a browser, with a provenance card still attached claiming it came
// off account 121.
//
// So the assertion is: THE SCRIPT CONTAINS NO ARITHMETIC. Not "no
// arithmetic on figures" — none at all, once strings and comments are
// stripped. That is checkable; "no arithmetic on figures" is not.
//
// ── WHAT IT REDS ON, after the repair (TC-11) ─────────────────────────
//  · any arithmetic operator or numeric-parse call entering the script
//  · a toggle whose alternate state is not pre-rendered in the document
//    (a control that would have to compute to do its job)
//  · a toggle rendered as a live control with nothing to switch, instead
//    of as a stated absence
//  · an external URL of any kind — the document must open offline
//  · a contents entry with no section, or a section with no entry
//  · a provenance card whose value disagrees with the figure it hangs on
//  · the print stylesheet losing the cover break, the contents page, the
//    forced-open sections, or the running page counter
//
// ── WHAT IT CANNOT SEE ────────────────────────────────────────────────
//  · whether the script WORKS. jsdom does not lay out, does not paginate
//    and does not print; a click handler that throws at runtime would
//    pass every assertion here. This gate is about what the document is
//    allowed to contain, not about interaction behaviour — that needs a
//    browser and is not claimed.
//  · pagination itself: whether a table actually breaks cleanly, whether
//    a chart fits a page. `@page`, `break-inside` and `orphans` are
//    asserted as PRESENT, never as EFFECTIVE.

import { describe, expect, it } from "vitest";

import { BOOKS, type Book, exportDoc, exportHtml } from "./exportBooks";

function scriptOf(html: string): string {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("the printed document carries no script");
  return m[1];
}

/** The script with comments and string literals removed — what is left is
 *  code, and code is where arithmetic would hide. */
function codeOnly(js: string): string {
  return js
    .replace(/\/\/[^\n]*/g, "")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

describe("G-C2 — R6: a toggle can never invent a number", () => {
  it.each(BOOKS)("%s: the document's script contains no arithmetic at all", (b: Book) => {
    const code = codeOnly(scriptOf(exportHtml(b)));
    for (const forbidden of [
      "parseFloat",
      "parseInt",
      "Number(",
      "toFixed",
      "Math.",
      "eval(",
      "Function(",
      "toLocaleString",
    ]) {
      expect(code, `the script calls ${forbidden}`).not.toContain(forbidden);
    }
    const operators = code.match(/[*%]|(?<![:/])\/(?![/*])/g) ?? [];
    expect(operators, "arithmetic operators outside string literals").toEqual([]);
  });

  it.each(BOOKS)("%s: every switchable state is already in the document", (b: Book) => {
    const doc = exportDoc(b);
    const live = Array.from(doc.querySelectorAll("[data-toggle]"));
    const attrs = new Set(live.map((x) => x.getAttribute("data-toggle") ?? ""));
    // A live control must have at least two states, and each state must
    // have markup waiting for it. Nothing is computed on click.
    for (const attr of attrs) {
      const values = live
        .filter((x) => x.getAttribute("data-toggle") === attr)
        .map((x) => x.getAttribute("data-value") ?? "");
      expect(values.length, `toggle ${attr} has fewer than two states`).toBeGreaterThan(1);
      const prefix = attr === "pl-view" ? "pl" : attr;
      const css = (exportHtml(b).match(/<style>([\s\S]*?)<\/style>/) ?? ["", ""])[1];
      for (const v of values) {
        const pre = Array.from(doc.querySelectorAll(`[data-variant="${prefix}-${v}"]`));
        expect(pre.length, `toggle ${attr}=${v} has no pre-rendered markup — it would have to compute`).toBeGreaterThan(0);
        // PRESENT IS NOT VISIBLE. Every variant node starts `display:
        // none`; a state whose markup exists but whose stylesheet never
        // reveals it is a DEAD CONTROL — the button lights up, the body
        // attribute flips, and nothing on the page moves. That is what
        // the reconstruction toggle did: it was a <span>, and only the
        // <tr> selectors had been written. Found by clicking it in a
        // browser, which is why this assertion now reads the CSS.
        for (const el of pre) {
          const tag = el.tagName.toLowerCase();
          const reveal = new RegExp(
            `body\\[data-${attr}="${v}"\\][^{}]*${tag}\\[data-variant="${prefix}-${v}"\\][^{}]*\\{[^}]*display:\\s*(?!none)`,
          );
          expect(reveal.test(css), `toggle ${attr}=${v} never reveals its <${tag}> variant — a dead control`).toBe(true);
        }
      }
    }
    // …and a control with nothing to switch is a STATED absence, never a
    // dead button.
    for (const off of Array.from(doc.querySelectorAll("[data-toggle-unavailable]"))) {
      expect(off.querySelector(".tg-b"), "an unavailable toggle still rendered buttons").toBeNull();
      expect((off.querySelector(".tg-off")?.textContent ?? "").length).toBeGreaterThan(12);
    }
  });

  it.each(BOOKS)("%s: the currency control states why it is not there", (b: Book) => {
    const doc = exportDoc(b);
    const off = doc.querySelector('[data-toggle-unavailable="ccy"] .tg-off');
    expect(off, "the currency control vanished instead of stating its absence").not.toBeNull();
    expect(off?.textContent ?? "").toMatch(/no display currency or FX rate/);
  });
});

describe("G-C2b — the document is self-contained", () => {
  it.each(BOOKS)("%s: no external call of any kind", (b: Book) => {
    const html = exportHtml(b);
    const urls: string[] = (html.match(/https?:\/\/[^"'\s)]+/g) ?? []).filter(
      (u: string) => !u.startsWith("http://www.w3.org/"),
    );
    expect(urls, "the document reaches out to the network").toEqual([]);
    expect(html).not.toMatch(/<link[^>]+rel="stylesheet"/);
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/@import/);
  });

  it.each(BOOKS)("%s: contents and sections agree exactly", (b: Book) => {
    const doc = exportDoc(b);
    const sections = Array.from(doc.querySelectorAll("section.rsec")).map((s) => s.id);
    const rail = Array.from(doc.querySelectorAll("[data-toc-for]")).map(
      (a) => a.getAttribute("data-toc-for") ?? "",
    );
    const printed = Array.from(doc.querySelectorAll(".toc-print a")).map((a) =>
      (a.getAttribute("href") ?? "").replace("#", ""),
    );
    expect(sections.length).toBeGreaterThan(6);
    expect(rail).toEqual(sections);
    expect(printed).toEqual(sections);
  });

  it.each(BOOKS)("%s: every provenanced figure agrees with its own card", (b: Book) => {
    const doc = exportDoc(b);
    const figs = Array.from(doc.querySelectorAll("[data-prov]"));
    expect(figs.length, "no figure carries provenance").toBeGreaterThan(15);
    for (const f of figs) {
      const shown = (f.textContent ?? "").replace(/\s+/g, " ").trim();
      const claimed = (f.getAttribute("data-prov-value") ?? "").replace(/\s+/g, " ").trim();
      expect(claimed, `a provenance card with no value on "${shown}"`).not.toBe("");
      expect(claimed, `provenance says ${claimed} where the document prints ${shown}`).toBe(shown);
      expect((f.getAttribute("data-prov-label") ?? "").length).toBeGreaterThan(2);
    }
    // and the card itself is present to receive them
    expect(doc.querySelector("#prov-card")).not.toBeNull();
    expect(doc.querySelector("[data-prov-copy]"), "no copy-with-provenance affordance").not.toBeNull();
  });

  it.each(BOOKS)("%s: find-within-the-report has a box and something to search", (b: Book) => {
    const doc = exportDoc(b);
    expect(doc.querySelector("#report-search")).not.toBeNull();
    expect(doc.querySelectorAll("table.fin tbody tr").length).toBeGreaterThan(20);
  });
});

describe("G-C2c — the print structure (R8)", () => {
  const cssOf = (html: string): string => (html.match(/<style>([\s\S]*?)<\/style>/) ?? ["", ""])[1];

  it.each(BOOKS)("%s: A4, a running page counter, a cover and a contents page", (b: Book) => {
    const css = cssOf(exportHtml(b));
    expect(css).toMatch(/@page\s*\{[\s\S]*size:\s*A4/);
    expect(css).toMatch(/counter\(page\)/);
    expect(css).toMatch(/counter\(pages\)/);
    expect(css).toMatch(/\.cover\s*\{[\s\S]*?break-after:\s*page/);
    expect(css).toMatch(/\.toc-print\s*\{\s*display:\s*block/);
    // page numbers in the contents are emitted the only honest way: a
    // paged-media counter that renders nothing where it cannot resolve
    expect(css).toMatch(/target-counter\(attr\(href\), page\)/);
  });

  it.each(BOOKS)("%s: the reader's session never removes content from the print", (b: Book) => {
    const css = cssOf(exportHtml(b));
    expect(css).toMatch(/section\.rsec\[data-collapsed="1"\]\s*>\s*\.rsec-body\s*\{\s*display:\s*block\s*!important/);
    expect(css).toMatch(/\.search-dim\s*\{\s*display:\s*revert\s*!important/);
    expect(css).toMatch(/\.toolbar,\s*\.toc,\s*\.prov\s*\{\s*display:\s*none\s*!important/);
    const js = scriptOf(exportHtml(b));
    expect(js, "nothing re-opens the document before printing").toContain("beforeprint");
  });

  it.each(BOOKS)("%s: no orphaned rows, and charts stay whole", (b: Book) => {
    const css = cssOf(exportHtml(b));
    expect(css).toMatch(/table\.fin\s*\{\s*orphans:\s*3;\s*widows:\s*3/);
    expect(css).toMatch(/tr\.subtotal,\s*table\.fin\s*tbody\s*tr\.total\s*\{\s*break-before:\s*avoid/);
    expect(css).toMatch(/\.chart-figure\s*\{[\s\S]*?break-inside:\s*avoid/);
  });

  it.each(BOOKS)("%s: every chart lives inside a named section", (b: Book) => {
    const doc = exportDoc(b);
    for (const f of Array.from(doc.querySelectorAll("[data-chart-block]"))) {
      const sec = f.closest("section.rsec");
      expect(sec, `${f.getAttribute("data-chart-block")} is outside every section`).not.toBeNull();
    }
  });
});
