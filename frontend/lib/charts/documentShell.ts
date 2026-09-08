// THE DOCUMENT SHELL — one HTML file that is interactive, offline and
// still prints as a board pack.
//
// Everything below is inert markup, one stylesheet and one script. There
// is no external call of any kind: no font CDN fetch at read time, no
// analytics, no image host. The file opens from a USB stick on a laptop
// with the wifi off and behaves identically.
//
// ── R6, AND WHY IT IS THE HARD ONE ─────────────────────────────────────
//
// A toggle must recompute from values the ENGINE emitted, never from
// client-side arithmetic invented in the browser. The temptation is
// obvious and cheap: read "RON 18,420,491" out of the DOM, strip the
// separators, multiply by an FX rate, write it back. That produces a
// figure no engine ever computed, with no provenance, rounded by a
// browser — and it will be quoted in a credit committee.
//
// So the rule here is structural, not a promise: EVERY STATE OF EVERY
// TOGGLE IS RENDERED INTO THE DOCUMENT AT BUILD TIME, and the script's
// only power is to change which pre-rendered state is visible. The
// script below contains no arithmetic on any figure at all — no
// `parseFloat`, no `Number(`, no `toFixed`, no `Math.`, no separator
// stripping. `reportInteractive.test.ts` reds if any of those appear,
// and its plant is exactly the tempting version: a browser-side FX
// conversion.
//
// A consequence worth stating: where the engine did NOT emit a variant,
// the toggle says so on the row rather than showing the unswitched
// figure as though it had switched. A silent no-op is how a reader comes
// to believe a number is something it is not.

import { INK, INK_MUTE, INK_SOFT, RULE, RULE_SOFT, ACCENT, PAPER, BREACH } from "./tokens";
import { esc } from "./svg";

export interface ShellSection {
  id: string;
  title: string;
}

/** The report's own contents, printed and sticky. */
export function contentsRail(sections: ShellSection[]): string {
  const items = sections
    .map(
      (s) =>
        `<li><a href="#${esc(s.id)}" data-toc-for="${esc(s.id)}"><span class="toc-dot" aria-hidden="true"></span>${esc(s.title)}</a></li>`,
    )
    .join("");
  return (
    `<nav class="toc" aria-label="Contents"><div class="toc-h">Contents</div><ol>${items}</ol>` +
    `<div class="toc-progress"><span class="toc-progress-bar" data-toc-progress></span></div></nav>`
  );
}

/**
 * The printed contents page. Page numbers are emitted with the Paged
 * Media `target-counter()` function, which resolves in a real paginator
 * (Prince, WeasyPrint, `weasyprint`-backed PDF services). Chrome's own
 * print does NOT implement it — and where it does not resolve, NOTHING
 * renders. That is the deliberate choice: a contents page listing "p. 4"
 * beside a section that is on page 6 is worse than one with no numbers,
 * and there is no way to know the page a section lands on from inside
 * the document.
 */
export function contentsPage(sections: ShellSection[]): string {
  const items = sections
    .map((s) => `<li><a href="#${esc(s.id)}">${esc(s.title)}</a></li>`)
    .join("");
  return `<section class="toc-print" aria-label="Contents"><h2>Contents</h2><ol>${items}</ol></section>`;
}

export interface CoverFacts {
  company: string;
  period: string;
  currency: string;
  industryLine: string;
  verdict: string;
  generated: string;
  /** Stated, never implied: which balance-sheet status this book is in. */
  statusLine: string;
}

export function coverPage(c: CoverFacts): string {
  return `
  <section class="cover" id="cover">
    <div class="cover-rule"></div>
    <div class="cover-kicker">Comprehensive financial analysis</div>
    <h1 class="cover-title">${esc(c.company)}</h1>
    <div class="cover-period">${esc(c.period)}</div>
    <dl class="cover-facts">
      <dt>Reporting currency</dt><dd>${esc(c.currency)}</dd>
      <dt>Industry</dt><dd>${esc(c.industryLine)}</dd>
      <dt>Balance sheet</dt><dd>${esc(c.statusLine)}</dd>
      <dt>Prepared</dt><dd>${esc(c.generated)}</dd>
    </dl>
    <div class="cover-verdict"><span class="cover-verdict-l">Overall verdict</span>${esc(c.verdict)}</div>
    <div class="cover-foot">CFO AI &nbsp;·&nbsp; Financial Statement Intelligence &nbsp;·&nbsp; Confidential — for internal use only</div>
  </section>`;
}

export interface ToggleOption {
  value: string;
  label: string;
  /** Why this state exists / what it shows. Printed as the control's title. */
  hint: string;
}

export interface ToggleSpec {
  /** Becomes `body[data-<attr>]`. */
  attr: string;
  label: string;
  options: ToggleOption[];
  /** Absent-capable: a toggle with nothing to switch is NOT rendered as a
   *  dead control; the reason is printed instead. */
  unavailableReason?: string;
}

export function toggleBar(specs: ToggleSpec[]): string {
  const groups = specs
    .map((t) => {
      if (t.unavailableReason) {
        return `<div class="tg" data-toggle-unavailable="${esc(t.attr)}"><span class="tg-l">${esc(t.label)}</span><span class="tg-off">${esc(t.unavailableReason)}</span></div>`;
      }
      const btns = t.options
        .map(
          (o, i) =>
            `<button type="button" class="tg-b" data-toggle="${esc(t.attr)}" data-value="${esc(o.value)}" title="${esc(o.hint)}"${i === 0 ? ' aria-pressed="true"' : ' aria-pressed="false"'}>${esc(o.label)}</button>`,
        )
        .join("");
      return `<div class="tg"><span class="tg-l">${esc(t.label)}</span>${btns}</div>`;
    })
    .join("");
  return `<div class="toolbar" role="toolbar" aria-label="Report view">
    <div class="tg tg-search">
      <label class="tg-l" for="report-search">Find</label>
      <input id="report-search" type="search" placeholder="account, ratio, word…" autocomplete="off" />
      <span class="tg-count" data-search-count></span>
    </div>
    ${groups}
  </div>`;
}

/** The hover / tap provenance card and the copy affordance. */
export function provenanceCard(): string {
  return `<div class="prov" id="prov-card" role="status" aria-live="polite" hidden>
    <div class="prov-l" data-prov-slot="label"></div>
    <div class="prov-v" data-prov-slot="value"></div>
    <dl>
      <dt>Formula</dt><dd data-prov-slot="formula"></dd>
      <dt>Accounts</dt><dd data-prov-slot="accounts"></dd>
      <dt>Method</dt><dd data-prov-slot="method"></dd>
      <dt>Snapshot</dt><dd data-prov-slot="snapshot"></dd>
    </dl>
    <button type="button" class="prov-copy" data-prov-copy>Copy figure with provenance</button>
  </div>`;
}

/**
 * Attributes that make any figure in the document provenanced. Rendered
 * onto the element that carries the printed number.
 */
export function provAttrs(p: {
  label: string;
  value: string;
  formula?: string;
  accounts?: string;
  method?: string;
  snapshot?: string;
}): string {
  return [
    `data-prov="1"`,
    `data-prov-label="${esc(p.label)}"`,
    `data-prov-value="${esc(p.value)}"`,
    p.formula ? `data-prov-formula="${esc(p.formula)}"` : "",
    p.accounts ? `data-prov-accounts="${esc(p.accounts)}"` : "",
    p.method ? `data-prov-method="${esc(p.method)}"` : "",
    p.snapshot ? `data-prov-snapshot="${esc(p.snapshot)}"` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function shellCss(): string {
  return `
    /* design-lint-allow-hex standalone generated report doc (shell block) */

    /* ── COVER ──────────────────────────────────────────────────────── */
    .cover { min-height: 60vh; display: flex; flex-direction: column; justify-content: center; padding: 40px 0 56px; }
    .cover-rule { height: 3px; background: ${INK}; width: 72px; margin-bottom: 26px; }
    .cover-kicker { font-family: var(--sans); font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.18em; color: ${INK_MUTE}; margin-bottom: 14px; }
    h1.cover-title { font-family: var(--serif); font-size: 40pt; line-height: 1.05; margin: 0 0 10px; color: ${INK}; letter-spacing: -0.02em; }
    .cover-period { font-family: var(--serif); font-size: 17pt; color: ${INK_SOFT}; margin-bottom: 34px; }
    .cover-facts { display: grid; grid-template-columns: 168px 1fr; gap: 7px 18px; margin: 0 0 30px; font-size: 10pt; border-top: 1px solid ${RULE}; padding-top: 18px; }
    .cover-facts dt { color: ${INK_MUTE}; text-transform: uppercase; letter-spacing: 0.10em; font-size: 8.25pt; padding-top: 2px; }
    .cover-facts dd { margin: 0; color: ${INK}; }
    .cover-verdict { border-top: 1px solid ${INK}; border-bottom: 1px solid ${INK}; padding: 14px 0; font-family: var(--serif); font-size: 13pt; color: ${INK}; }
    .cover-verdict-l { display: block; font-family: var(--sans); font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.10em; color: ${ACCENT}; margin-bottom: 5px; }
    .cover-foot { margin-top: auto; padding-top: 40px; font-size: 8.25pt; color: ${INK_MUTE}; letter-spacing: 0.05em; }

    /* ── CONTENTS RAIL ──────────────────────────────────────────────── */
    .toc { position: fixed; left: 16px; top: 92px; width: 186px; font-size: 9pt; z-index: 40; }
    .toc-h { text-transform: uppercase; letter-spacing: 0.12em; font-size: 8pt; color: ${INK_MUTE}; margin-bottom: 8px; }
    .toc ol { list-style: none; margin: 0; padding: 0; }
    .toc li { margin: 0 0 3px; }
    .toc a { color: ${INK_MUTE}; text-decoration: none; display: flex; gap: 7px; align-items: baseline; padding: 2px 0; line-height: 1.3; }
    .toc a:hover { color: ${INK}; }
    .toc a[aria-current="true"] { color: ${INK}; font-weight: 600; }
    .toc-dot { width: 5px; height: 5px; border-radius: 50%; background: ${RULE}; flex: none; position: relative; top: -2px; }
    .toc a[aria-current="true"] .toc-dot { background: ${ACCENT}; }
    .toc-progress { margin-top: 12px; height: 2px; background: ${RULE_SOFT}; }
    .toc-progress-bar { display: block; height: 2px; background: ${ACCENT}; width: 0%; }
    @media (max-width: 1220px) { .toc { display: none; } }

    .toc-print { display: none; }

    /* ── TOOLBAR ────────────────────────────────────────────────────── */
    .toolbar { position: sticky; top: 0; z-index: 50; display: flex; flex-wrap: wrap; gap: 8px 22px; align-items: center;
      background: ${PAPER}; border-bottom: 1px solid ${RULE}; padding: 9px 0; margin: 0 0 22px; }
    .tg { display: flex; align-items: center; gap: 6px; }
    .tg-l { font-size: 8pt; text-transform: uppercase; letter-spacing: 0.10em; color: ${INK_MUTE}; }
    .tg-b { font-family: var(--sans); font-size: 8.5pt; padding: 3px 9px; border: 1px solid ${RULE}; background: none; color: ${INK_SOFT}; cursor: pointer; border-radius: 2px; }
    .tg-b[aria-pressed="true"] { background: ${INK}; color: ${PAPER}; border-color: ${INK}; }
    .tg-off { font-size: 8.5pt; color: ${INK_MUTE}; font-style: italic; }
    .tg-search input { font-family: var(--sans); font-size: 9pt; padding: 3px 8px; border: 1px solid ${RULE}; border-radius: 2px; min-width: 190px; color: ${INK}; background: ${PAPER}; }
    .tg-count { font-size: 8.5pt; color: ${INK_MUTE}; font-variant-numeric: tabular-nums; }
    mark.hit { background: #FBF0C9; color: ${INK}; } /* design-lint-allow-hex standalone generated report document */
    .search-dim { display: none !important; }

    /* ── SECTIONS / COLLAPSE ────────────────────────────────────────── */
    section.rsec { scroll-margin-top: 60px; }
    section.rsec > h2 { cursor: pointer; display: flex; align-items: baseline; gap: 10px; }
    section.rsec > h2::before { content: "−"; font-family: var(--sans); font-size: 11pt; color: ${INK_MUTE}; width: 12px; }
    section.rsec[data-collapsed="1"] > h2::before { content: "+"; }
    section.rsec[data-collapsed="1"] > .rsec-body { display: none; }

    /* ── PROVENANCE ─────────────────────────────────────────────────── */
    [data-prov] { cursor: help; border-bottom: 1px dotted ${RULE}; }
    .prov { position: fixed; z-index: 90; max-width: 340px; background: ${PAPER}; border: 1px solid ${INK}; padding: 11px 13px; font-size: 8.75pt; color: ${INK_SOFT}; line-height: 1.45; }
    .prov-l { font-size: 8pt; text-transform: uppercase; letter-spacing: 0.10em; color: ${INK_MUTE}; }
    .prov-v { font-family: var(--serif); font-size: 14pt; color: ${INK}; margin: 2px 0 8px; font-variant-numeric: tabular-nums lining-nums; }
    .prov dl { display: grid; grid-template-columns: 72px 1fr; gap: 3px 10px; margin: 0; }
    .prov dt { color: ${INK_MUTE}; text-transform: uppercase; font-size: 7.5pt; letter-spacing: 0.08em; padding-top: 1px; }
    .prov dd { margin: 0; }
    .prov-copy { margin-top: 9px; font-family: var(--sans); font-size: 8pt; padding: 3px 8px; border: 1px solid ${RULE}; background: none; color: ${INK_SOFT}; cursor: pointer; }
    .prov-copy[data-copied="1"] { border-color: ${ACCENT}; color: ${ACCENT}; }

    /* ── PRE-RENDERED TOGGLE STATES ─────────────────────────────────── */
    /* Every variant is IN the document; the script only changes which one
       is shown. Default state matches the first option of each toggle. */
    tr[data-variant], span[data-variant], div[data-variant], td[data-variant], p[data-variant] { display: none; }
    body[data-pl-view="reconstructed"] tr[data-variant="pl-reconstructed"] { display: table-row; }
    body[data-pl-view="filed"] tr[data-variant="pl-filed"] { display: table-row; }
    /* …AND the inline spellings. Without these two rules the control
       flipped body[data-pl-view] and nothing on the page moved: the
       reconstruction variant is a <span> inside a card's meta line, and
       only the <tr> selectors existed. Caught by clicking it in a real
       browser — the gate had checked that the markup was PRESENT, which
       it was, all along, invisible. */
    body[data-pl-view="reconstructed"] span[data-variant="pl-reconstructed"] { display: inline; }
    body[data-pl-view="filed"] span[data-variant="pl-filed"] { display: inline; }
    body[data-voice="pro"] p[data-variant="voice-pro"],
    body[data-voice="pro"] div[data-variant="voice-pro"] { display: block; }
    body[data-voice="simple"] p[data-variant="voice-simple"],
    body[data-voice="simple"] div[data-variant="voice-simple"] { display: block; }
    body[data-ccy="base"] span[data-variant="ccy-base"] { display: inline; }
    body[data-ccy="alt"] span[data-variant="ccy-alt"] { display: inline; }
    body[data-ic="with"] tr[data-variant="ic-with"] { display: table-row; }
    body[data-ic="without"] tr[data-variant="ic-without"] { display: table-row; }
    .no-variant { color: ${INK_MUTE}; font-style: italic; }
    .breach-word { color: ${BREACH}; }

    /* ── PRINT ──────────────────────────────────────────────────────── */
    @media print {
      .toolbar, .toc, .prov { display: none !important; }
      .cover { min-height: 232mm; break-after: page; page-break-after: always; }
      .toc-print { display: block; break-after: page; page-break-after: always; }
      .toc-print ol { list-style: none; padding: 0; margin: 0; font-size: 11pt; }
      /* ── NO DOT LEADER ────────────────────────────────────────────
         There used to be a dotted border-bottom on every row here, and
         it was drawn UNCONDITIONALLY while the number after it came
         from target-counter() — which Chromium does not implement, and
         Chromium is the engine that produces our PDF (services/pdf/
         render.mjs). MEASURED on the delivered Agras pack: page 2 read

             Executive summary . . . . . . . . . . . . . . . . . . .
             Financial statements  . . . . . . . . . . . . . . . . .

         ten times over, every rule running to the right margin and
         ending in white space. A dotted leader is a typographic promise
         of a number; a leader with nothing at the end of it tells the
         reader a fact went missing.

         The a::after rule STAYS: in an engine that resolves it the
         contents gains real page numbers, and where it does not it
         renders nothing at all — which is a plain list, and a plain
         list promises nothing. What was removed is the half that
         promised. */
      .toc-print li { padding: 7px 0; display: flex; justify-content: space-between; gap: 10px; }
      .toc-print a { color: ${INK}; text-decoration: none; }
      /* Paged-media page numbers. Resolves in a real paginator; renders
         NOTHING where it does not — never a wrong number. */
      .toc-print li a::after { content: target-counter(attr(href), page); color: ${INK_MUTE}; float: right; font-variant-numeric: tabular-nums; }
      section.rsec { break-before: auto; }
      section.rsec > h2::before { content: "" !important; width: 0; }
      section.rsec[data-collapsed="1"] > .rsec-body { display: block !important; }
      .search-dim { display: revert !important; }
      /* No orphaned rows: a table never leaves fewer than two rows behind. */
      table.fin { orphans: 3; widows: 3; }
      table.fin tbody tr.subtotal, table.fin tbody tr.total { break-before: avoid; page-break-before: avoid; }
      [data-prov] { border-bottom: none; }
    }
  `;
}

/**
 * The document's only script. Read it as a whole: there is no arithmetic
 * in it. It moves a class, sets an attribute, copies a string, and shows
 * or hides pre-rendered nodes — nothing else. That is what makes R6 an
 * assertion rather than an intention.
 */
export function shellScript(): string {
  return `
(function () {
  var body = document.body;

  // ── toggles: switch which PRE-RENDERED state is visible ─────────────
  var buttons = document.querySelectorAll("[data-toggle]");
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].addEventListener("click", function (ev) {
      var b = ev.currentTarget;
      var attr = b.getAttribute("data-toggle");
      var val = b.getAttribute("data-value");
      body.setAttribute("data-" + attr, val);
      var peers = document.querySelectorAll('[data-toggle="' + attr + '"]');
      for (var p = 0; p < peers.length; p++) {
        peers[p].setAttribute("aria-pressed", peers[p] === b ? "true" : "false");
      }
    });
  }

  // ── collapsible sections ────────────────────────────────────────────
  var heads = document.querySelectorAll("section.rsec > h2");
  for (var h = 0; h < heads.length; h++) {
    heads[h].setAttribute("tabindex", "0");
    heads[h].setAttribute("role", "button");
    var toggleSec = function (ev) {
      var sec = ev.currentTarget.parentNode;
      sec.setAttribute("data-collapsed", sec.getAttribute("data-collapsed") === "1" ? "0" : "1");
    };
    heads[h].addEventListener("click", toggleSec);
    heads[h].addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggleSec(ev); }
    });
  }

  // ── contents: current section + progress ────────────────────────────
  var links = document.querySelectorAll("[data-toc-for]");
  var bar = document.querySelector("[data-toc-progress]");
  var sections = document.querySelectorAll("section.rsec");
  if (window.IntersectionObserver && links.length) {
    var seen = {};
    var io = new IntersectionObserver(function (entries) {
      for (var e = 0; e < entries.length; e++) {
        seen[entries[e].target.id] = entries[e].isIntersecting;
      }
      var current = null;
      for (var s = 0; s < sections.length; s++) {
        if (seen[sections[s].id]) { current = sections[s].id; break; }
      }
      var doneCount = 0;
      for (var l = 0; l < links.length; l++) {
        var id = links[l].getAttribute("data-toc-for");
        links[l].setAttribute("aria-current", id === current ? "true" : "false");
        if (id === current) { doneCount = l; }
      }
      if (bar) {
        bar.style.width = "calc(100% * " + doneCount + " / " + links.length + ")";
      }
    }, { rootMargin: "-10% 0px -70% 0px" });
    for (var s2 = 0; s2 < sections.length; s2++) io.observe(sections[s2]);
  }

  // ── provenance card ─────────────────────────────────────────────────
  var card = document.getElementById("prov-card");
  var slots = {};
  if (card) {
    var ss = card.querySelectorAll("[data-prov-slot]");
    for (var q = 0; q < ss.length; q++) slots[ss[q].getAttribute("data-prov-slot")] = ss[q];
  }
  var active = null;
  function fill(el) {
    active = el;
    var get = function (k) { return el.getAttribute("data-prov-" + k) || "not stated"; };
    slots.label.textContent = get("label");
    slots.value.textContent = get("value");
    slots.formula.textContent = get("formula");
    slots.accounts.textContent = get("accounts");
    slots.method.textContent = get("method");
    slots.snapshot.textContent = get("snapshot");
    var copyBtn = card.querySelector("[data-prov-copy]");
    if (copyBtn) copyBtn.setAttribute("data-copied", "0");
  }
  function place(ev) {
    var pad = 14;
    card.hidden = false;
    var w = card.offsetWidth;
    var hgt = card.offsetHeight;
    var x = ev.clientX + pad;
    var y = ev.clientY + pad;
    if (x + w > window.innerWidth) x = window.innerWidth - w - pad;
    if (y + hgt > window.innerHeight) y = ev.clientY - hgt - pad;
    card.style.left = x + "px";
    card.style.top = y + "px";
  }
  var figures = document.querySelectorAll("[data-prov]");
  for (var f = 0; f < figures.length; f++) {
    figures[f].setAttribute("tabindex", "0");
    figures[f].addEventListener("mouseenter", function (ev) { fill(ev.currentTarget); place(ev); });
    figures[f].addEventListener("mousemove", function (ev) { if (active === ev.currentTarget) place(ev); });
    figures[f].addEventListener("mouseleave", function () { if (card) card.hidden = true; });
    figures[f].addEventListener("click", function (ev) { fill(ev.currentTarget); place(ev); });
    figures[f].addEventListener("focus", function (ev) {
      var r = ev.currentTarget.getBoundingClientRect();
      fill(ev.currentTarget);
      card.hidden = false;
      card.style.left = r.left + "px";
      card.style.top = r.bottom + "px";
    });
  }
  if (card) {
    card.addEventListener("mouseleave", function () { card.hidden = true; });
    var cb = card.querySelector("[data-prov-copy]");
    if (cb) {
      cb.addEventListener("click", function () {
        if (!active) return;
        var g = function (k) { return active.getAttribute("data-prov-" + k) || "not stated"; };
        var payload = g("label") + ": " + g("value")
          + " | formula: " + g("formula")
          + " | accounts: " + g("accounts")
          + " | method: " + g("method")
          + " | snapshot: " + g("snapshot");
        var done = function () { cb.setAttribute("data-copied", "1"); cb.textContent = "Copied with provenance"; };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(payload).then(done, function () {});
        } else {
          var ta = document.createElement("textarea");
          ta.value = payload;
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand("copy"); done(); } catch (e) {}
          document.body.removeChild(ta);
        }
      });
    }
  }

  // ── find within the report ──────────────────────────────────────────
  var input = document.getElementById("report-search");
  var count = document.querySelector("[data-search-count]");
  var targets = document.querySelectorAll("table.fin tbody tr, .ratio-card, .rec, .commentary, .risk, .chart-gap");
  if (input) {
    input.addEventListener("input", function () {
      var q = input.value.trim().toLowerCase();
      var hits = 0;
      for (var t = 0; t < targets.length; t++) {
        if (q === "") { targets[t].classList.remove("search-dim"); continue; }
        var txt = (targets[t].textContent || "").toLowerCase();
        if (txt.indexOf(q) >= 0) { targets[t].classList.remove("search-dim"); hits++; }
        else { targets[t].classList.add("search-dim"); }
      }
      if (count) count.textContent = q === "" ? "" : hits + " matching";
    });
  }

  // ── print: nothing hidden by a reader's session goes missing ────────
  function openAll() {
    for (var s = 0; s < sections.length; s++) sections[s].setAttribute("data-collapsed", "0");
    for (var t = 0; t < targets.length; t++) targets[t].classList.remove("search-dim");
  }
  if (window.matchMedia) {
    var mq = window.matchMedia("print");
    if (mq.addListener) mq.addListener(function (m) { if (m.matches) openAll(); });
  }
  window.addEventListener("beforeprint", openAll);
})();
`;
}
