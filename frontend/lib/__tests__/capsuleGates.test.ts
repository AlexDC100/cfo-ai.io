// THE CAPSULE — GATES C1, C3, C4, C6, C7, C9: the FRONTEND half.
//
// The gates lane owns no product code. It owns the proof that the
// product code cannot do the thing it promises not to do. Every gate
// here has a PLANT — an edit or a stub that makes the defect real —
// which was applied, observed to trip the gate, and reverted. The exact
// plant and the exact text each gate emits are recorded in
// `design_review/capsule/GATES.md`. A gate whose plant was never run is
// a gate nobody has proven is wired to anything.
//
//   C1  NO MODEL NUMERALS. A figure reaches the DOM only through the
//       money path, carrying provenance. The law is enforced on the
//       RENDERED OUTPUT — `unprovenancedFigures()` below — so it holds
//       whatever the answer lane's guard is called and however it is
//       written. A fabricated figure is rejected at parse (the
//       placeholder parser refuses the whole template rather than
//       half-rendering it) and the surface falls back deterministically.
//   C3  GROUNDING. Every figure in an answer traces to a snapshot fact:
//       the money span names the FACT it came from, and the fact's value
//       is the one the tool payload carried.
//   C4  ROUTER ACCURACY. The 40-query fixture set classifies correctly
//       and the navigate / entity / action lanes never burn a model
//       call — asserted with every network primitive booby-trapped, over
//       every prefix of every fixture, which is what typing actually is.
//   C6  UNIT LAW. The same answer in RON and in EUR: identical
//       structure, identical facts, identical dimensionless values;
//       only the money PRESENTATION differs.
//   C7  DEGRADED PARITY. With AI dead, routing/search/actions still
//       work, the message is calm, and no raw payload reaches the DOM.
//   C9  LATENCY. Navigation results, measured. The numbers reported in
//       GATES.md are these, not the target.
//
// C2 (read-only), C5 (missing-data honesty) and the producer half of
// C1/C3/C6 are engine laws: `tests/engine/test_capsule_gates.py`.
// C8 (header budget) is a live-DOM law: `e2e/design/capsule.spec.ts`.
//
// Written as .ts, not .tsx: React is driven through `createElement`, so
// this file stays where the lane contract puts it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, type ReactElement } from "react";
import { render, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { FALLBACK_RATES } from "@/lib/rates";
import type { Currency } from "@/lib/rates";

// In-memory localStorage (this jsdom build ships a broken one) — the
// same shim the sibling narrative suites use.
const bag = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => bag.get(k) ?? null,
    setItem: (k: string, v: string) => void bag.set(k, String(v)),
    removeItem: (k: string) => void bag.delete(k),
    clear: () => void bag.clear(),
    key: (i: number) => [...bag.keys()][i] ?? null,
    get length() { return bag.size; },
  },
});

// The currency dial. ONLY the store is stubbed — the formatter, the
// rates table, `resolveMoneyDisplay` and both money components stay
// real, because C6 is a claim about what those produce.
let DISPLAY: Currency = "RON";
vi.mock("@/stores/currency", () => ({
  useCurrency: () => ({
    display: DISPLAY,
    rates: {
      base: "EUR", rates: FALLBACK_RATES, source: "test",
      as_of: "2026-08-30", fetched_at: "", stale: false,
    },
    setDisplay: (c: Currency) => { DISPLAY = c; },
    refresh: async () => {},
    refreshing: false,
  }),
  useDisplayCurrency: () => DISPLAY,
  useAmountFormatter: () => (v: number | null | undefined) =>
    v === null || v === undefined ? "—" : String(v),
}));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));

import {
  routeQuery,
  willCallModel,
  nextIndex,
  clearCapsuleRouterCache,
  foldQuery,
  ASK_ROW_ID,
  type CapsuleRouterResult,
} from "@/lib/capsuleRouter";
import {
  CAPSULE_ROUTER_FIXTURES,
  FIXTURE_CONTEXT,
  NAV_NEVER_MODEL,
  AMBIGUOUS_FIXTURES,
} from "@/lib/capsuleRouterFixtures";
import { NarrativeText, parseNarrativeTemplate } from "@/lib/narrativeMoney";
import {
  classifyAiFailure,
  classifyUpstreamAnswer,
  AI_FAILURE_REASON_KEY,
} from "@/lib/aiDegraded";
import degradedStrings from "@/components/cfo/chat/chatDegradedStrings.json";

afterEach(() => {
  cleanup();
  DISPLAY = "RON";
});

// ══════════════════════════════════════════════════════════════════════
// THE FIGURE LAW — one definition, mirrored from the engine half
// ══════════════════════════════════════════════════════════════════════
//
// IDENTIFIER  names a thing you can look up: a period label ("December
//             2024"), an account code ("461"), a served line id ("I18").
// FIGURE      states a quantity: separators between digits, a currency
//             or a percent beside it, or a number that names nothing in
//             the context.
//
// `tests/engine/test_capsule_gates.py::figures_in` is the same rule in
// Python and `design_review/capsule/GATES.md` states it in prose. Three
// files, one rule — deliberately, because the rule IS the gate.

const DIGIT_RUN = /\d[\d.,\u00a0\u202f ]*\d|\d/g;
const GROUPED = /\d[.,\u00a0\u202f ]\d/;
const CURRENCY_ADJACENT =
  /(?:(?:RON|EUR|USD|GBP|LEI|MDL|HUF|€|\$|£)\s*\d)|(?:\d\s*(?:RON|EUR|USD|GBP|LEI|MDL|HUF|€|\$|£|%|pp))/i;

const SEPARATORS = ".,\u00a0\u202f ";

/** Remove an allowed IDENTIFIER from `text`, but only where it stands on
 *  its own — never where it is part of a longer number. Stripping runs
 *  BEFORE the hard rules, so a licensed identifier that happens to
 *  contain a separator ("2.80" resolved from a placeholder) is not
 *  mistaken for a quantity, while "2.803" still is. */
function stripAllowed(text: string, allowed: readonly string[]): string {
  let out = text;
  for (const token of [...allowed].sort((a, b) => b.length - a.length)) {
    if (!token) continue;
    let from = 0;
    for (;;) {
      const i = out.indexOf(token, from);
      if (i < 0) break;
      const before = i > 0 ? out[i - 1] : "";
      const after = out[i + token.length] ?? "";
      const beforeBefore = i > 1 ? out[i - 2] : "";
      const afterAfter = out[i + token.length + 1] ?? "";
      const glued =
        /\d/.test(before) || /\d/.test(after) ||
        (SEPARATORS.includes(before) && /\d/.test(beforeBefore)) ||
        (SEPARATORS.includes(after) && /\d/.test(afterAfter));
      if (glued) {
        from = i + 1;
        continue;
      }
      out = out.slice(0, i) + " ".repeat(token.length) + out.slice(i + token.length);
      from = i + token.length;
    }
  }
  return out;
}

export function figuresIn(text: string, allowed: readonly string[]): string[] {
  if (!text) return [];
  const stripped = stripAllowed(text, allowed);
  if (GROUPED.test(stripped) || CURRENCY_ADJACENT.test(stripped)) {
    return [stripped.trim()];
  }
  const out: string[] = [];
  DIGIT_RUN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DIGIT_RUN.exec(stripped)) !== null) {
    const before = m.index > 0 ? stripped[m.index - 1] : "";
    const after = stripped[m.index + m[0].length] ?? "";
    // Letter-attached digits are identifiers: I18, ct1, v1, sha256.
    if (/[A-Za-z_]/.test(before) || /[A-Za-z_]/.test(after)) continue;
    out.push(m[0]);
  }
  return out;
}

/** Attributes that make a rendered figure TRACEABLE. Any one of them
 *  means the number went through the money path and carries where it
 *  came from; a figure with none of them is a bare numeral. */
const PROVENANCE_ATTRS = [
  "data-narrative-money",
  "data-traceable-source-statement",
  "data-provenance",
  "data-fact",
];

function hasProvenance(node: Element | null, root: Element): boolean {
  let el: Element | null = node;
  while (el) {
    for (const attr of PROVENANCE_ATTRS) {
      if (el.hasAttribute(attr)) return true;
    }
    if (el === root) return false;
    el = el.parentElement;
  }
  return false;
}

/** THE C1/C3 DOM LAW. Every figure in `root` must sit inside an element
 *  that names where it came from. Returns the offenders. */
export function unprovenancedFigures(
  root: HTMLElement,
  allowed: readonly string[] = [],
): Array<{ text: string; figures: string[] }> {
  const out: Array<{ text: string; figures: string[] }> = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null = walker.nextNode();
  while (node) {
    const text = node.textContent ?? "";
    const figures = figuresIn(text, allowed);
    if (figures.length && !hasProvenance(node.parentElement, root)) {
      out.push({ text, figures });
    }
    node = walker.nextNode();
  }
  return out;
}

// ── KNOWN GAP, quarantined by name (a ratchet, not an exemption) ──────
//
// `NarrativeText` attributes MONEY parts (`data-narrative-money`, the
// provenance in `title`) but renders a resolved DIMENSIONLESS fact — a
// ratio, a percent, a day count — as a bare `<span>` with no attribute
// at all (narrativeMoney.tsx: the `else` branch pushes a `text` part).
// In the DOM, "2.80" resolved from `{{fact:current_ratio|d2}}` is then
// indistinguishable from "2.80" a model typed, which is exactly the
// distinction C1 and C3 exist to make.
//
// `narrativeMoney.tsx` is import-only for this lane, so the gate cannot
// fix it. Instead it stays STRICT and licenses only the exact strings
// the parser is known to produce for this template — computed here from
// the template and the facts, so a figure that did NOT come from a
// placeholder is still caught. Recorded as a cross-lane need in
// design_review/capsule/GATES.md §C1/C3.
//
// THE FIX (for whoever owns narrativeMoney.tsx): give the dimensionless
// branch a `data-narrative-fact={fact}` span, the way the money branch
// already does. When that lands, delete this helper — the gate gets
// stricter for free.
const NON_MONEY_PLACEHOLDER =
  /\{\{(fact|ratio|percent|days|count|score):([A-Za-z0-9_]+)((?:\|[a-z0-9]+)*)\}\}/g;

function dimensionlessRenderings(
  template: string,
  facts: Record<string, number>,
  factUnits: Record<string, string>,
): string[] {
  const out: string[] = [];
  NON_MONEY_PLACEHOLDER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NON_MONEY_PLACEHOLDER.exec(template)) !== null) {
    const [, token, fact, rawOpts] = m;
    const value = facts[fact];
    if (typeof value !== "number") continue;
    const unit = token === "fact" ? factUnits[fact] : token;
    if (unit === "money") continue;
    const dec = (rawOpts ?? "").split("|").find((o) => /^d\d+$/.test(o));
    const text = dec ? value.toFixed(Number(dec.slice(1))) : String(value);
    out.push(unit === "percent" ? `${text}%` : text);
  }
  return out;
}

function renderNarrative(props: {
  text: string;
  template?: string | null;
  facts?: Record<string, number> | null;
  factUnits?: Record<string, string> | null;
  sourceCurrency?: Currency;
}): HTMLElement {
  const el = createElement(
    MemoryRouter,
    null,
    createElement(NarrativeText, props) as ReactElement,
  );
  return render(el).container;
}

// ══════════════════════════════════════════════════════════════════════
// THE ANSWER FIXTURE — what a Capsule answer is made of
// ══════════════════════════════════════════════════════════════════════
//
// Shaped exactly like the tool layer's payload (`facts` + `fact_units` +
// `currency`, contract ct1), so these gates are testing the real bridge
// and not a convenient invention. The values are the engine suite's own
// fixture book (December 2024: total assets 3,900.00 RON, current
// assets 1,400.00, current liabilities 500.00, current ratio 2.8).

const ANSWER_FACTS: Record<string, number> = {
  total_assets: 3900,
  current_assets: 1400,
  cur_liab: 500,
  current_ratio: 2.8,
};
const ANSWER_UNITS: Record<string, string> = {
  total_assets: "money",
  current_assets: "money",
  cur_liab: "money",
  current_ratio: "ratio",
};
/** The shape a grounded answer takes: every figure a placeholder. */
const GROUNDED_TEMPLATE =
  "December 2024 closes with total assets of {{money:total_assets}}, of " +
  "which {{money:current_assets}} is current against " +
  "{{money:cur_liab}} of current liabilities — a current ratio of " +
  "{{fact:current_ratio|d2}}.";
/** The same claim as the model would write it if nothing stopped it. */
const FABRICATED_ANSWER =
  "December 2024 closes with total assets of RON 3,900, of which RON 1,400 " +
  "is current against RON 500 of current liabilities — a current ratio of " +
  "2.8, roughly 15% better than last month.";
/** Identifiers a Capsule answer is allowed to name in prose. */
const ALLOWED_IDENTIFIERS = ["December 2024", "November 2024", "461", "5121"];

// ══════════════════════════════════════════════════════════════════════
// C1 — no model numerals
// ══════════════════════════════════════════════════════════════════════

describe("C1 — a numeral in model output is not a figure until it is resolved", () => {
  it("renders every figure through the money path when the answer is templated", () => {
    const container = renderNarrative({
      text: "December 2024 closes with total assets.",
      template: GROUNDED_TEMPLATE,
      facts: ANSWER_FACTS,
      factUnits: ANSWER_UNITS,
      sourceCurrency: "RON",
    });
    const offenders = unprovenancedFigures(container, [
      ...ALLOWED_IDENTIFIERS,
      ...dimensionlessRenderings(GROUNDED_TEMPLATE, ANSWER_FACTS, ANSWER_UNITS),
    ]);
    expect(offenders, JSON.stringify(offenders)).toHaveLength(0);
    // …and the figures really are there — a gate that passes on an
    // empty render is not a gate.
    expect(container.querySelectorAll("[data-narrative-money]").length).toBe(3);
  });

  it("REJECTS AT PARSE: a fabricated figure has no fact to bind, so the whole template is refused", () => {
    // THE PLANT. The model writes the number itself. There is no
    // placeholder, so there is nothing to resolve — and the parser
    // refuses the template rather than half-rendering it.
    const parsed = parseNarrativeTemplate(
      FABRICATED_ANSWER, ANSWER_FACTS, ANSWER_UNITS);
    expect(parsed, "a bare numeral must not parse as a resolved answer")
      .toBeNull();

    // A template that names a fact nobody supplied is refused too — the
    // second shape of fabrication (an invented FACT rather than an
    // invented digit).
    expect(parseNarrativeTemplate(
      "Cash was {{money:cash_at_bank}}.", ANSWER_FACTS, ANSWER_UNITS)).toBeNull();
    // …as is a fact whose unit was never declared. An undeclared unit is
    // a refusal, never an assumption that it is money.
    expect(parseNarrativeTemplate(
      "Headcount was {{fact:headcount}}.", { headcount: 12 }, {})).toBeNull();
  });

  it("and the DOM law catches the fabricated figure if it ever reaches a render", () => {
    const container = renderNarrative({
      text: FABRICATED_ANSWER,
      template: FABRICATED_ANSWER,
      facts: ANSWER_FACTS,
      factUnits: ANSWER_UNITS,
      sourceCurrency: "RON",
    });
    const offenders = unprovenancedFigures(container, ALLOWED_IDENTIFIERS);
    expect(offenders.length,
      "the DOM law missed a fabricated figure — C1 has no teeth")
      .toBeGreaterThan(0);
  });

  it("FALLS BACK DETERMINISTICALLY: the refused answer renders the same bytes every time", () => {
    const once = renderNarrative({
      text: "Total assets for December 2024 are not available.",
      template: "Total assets were {{money:not_a_fact}}.",
      facts: ANSWER_FACTS,
      factUnits: ANSWER_UNITS,
      sourceCurrency: "RON",
    }).innerHTML;
    cleanup();
    const twice = renderNarrative({
      text: "Total assets for December 2024 are not available.",
      template: "Total assets were {{money:not_a_fact}}.",
      facts: ANSWER_FACTS,
      factUnits: ANSWER_UNITS,
      sourceCurrency: "RON",
    }).innerHTML;
    expect(twice).toBe(once);
    // The fallback is the STORED text — it invents nothing.
    expect(once).toContain("not available");
    expect(once).not.toContain("3,900");
  });

  it("the figure law itself distinguishes a quantity from an identifier", () => {
    // Quantities.
    expect(figuresIn("RON 3,900", ALLOWED_IDENTIFIERS).length).toBeGreaterThan(0);
    expect(figuresIn("19.6% of total assets", ALLOWED_IDENTIFIERS).length)
      .toBeGreaterThan(0);
    expect(figuresIn("about 40000 short", ALLOWED_IDENTIFIERS).length)
      .toBeGreaterThan(0);
    // Identifiers.
    expect(figuresIn("December 2024 has no attached file.", ALLOWED_IDENTIFIERS))
      .toEqual([]);
    expect(figuresIn("Account 461 is not in this period.", ALLOWED_IDENTIFIERS))
      .toEqual([]);
    expect(figuresIn("served envelope carries no I18", ALLOWED_IDENTIFIERS))
      .toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════
// C3 — grounding
// ══════════════════════════════════════════════════════════════════════

describe("C3 — every figure traces to a snapshot fact", () => {
  it("names the fact it came from, and renders that fact's value", () => {
    const container = renderNarrative({
      text: "fallback",
      template: GROUNDED_TEMPLATE,
      facts: ANSWER_FACTS,
      factUnits: ANSWER_UNITS,
      sourceCurrency: "RON",
    });
    const spans = [...container.querySelectorAll("[data-narrative-money]")];
    expect(spans.length).toBe(3);
    for (const span of spans) {
      const fact = span.getAttribute("data-narrative-money")!;
      // The fact exists in the payload the tool layer handed over …
      expect(Object.keys(ANSWER_FACTS)).toContain(fact);
      expect(ANSWER_UNITS[fact]).toBe("money");
      // … the currency it is displayed in is stated on the element …
      expect(span.getAttribute("data-narrative-currency")).toBe("RON");
      // … and the provenance ("1,400.00 RON") rides the title attribute.
      expect(span.getAttribute("title") ?? "").not.toBe("");
    }
  });

  it("a dimensionless fact renders as itself, with no currency attached", () => {
    const container = renderNarrative({
      text: "fallback",
      template: "Current ratio is {{fact:current_ratio|d2}}.",
      facts: ANSWER_FACTS,
      factUnits: ANSWER_UNITS,
      sourceCurrency: "RON",
    });
    expect(container.textContent).toContain("2.80");
    expect(container.querySelectorAll("[data-narrative-money]").length).toBe(0);
    expect(container.textContent).not.toMatch(/RON\s*2\.80|2\.80\s*RON/);
  });
});

// ══════════════════════════════════════════════════════════════════════
// C4 — router accuracy, and the model-spend gate
// ══════════════════════════════════════════════════════════════════════

/** Booby-trap every way a browser can talk to a server. Returns a
 *  disposer and the list of attempts (which must stay empty). */
function trapTheNetwork(): { attempts: string[]; restore: () => void } {
  const attempts: string[] = [];
  const g = globalThis as unknown as Record<string, unknown>;
  const saved: Record<string, unknown> = {};
  const trap = (name: string) => {
    saved[name] = g[name];
    g[name] = (...args: unknown[]) => {
      attempts.push(`${name}(${String(args[0]).slice(0, 80)})`);
      throw new Error(`${name} called from a lane that must not spend`);
    };
  };
  for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource"]) {
    if (name in g) trap(name);
  }
  if (typeof navigator !== "undefined" && "sendBeacon" in navigator) {
    saved.sendBeacon = navigator.sendBeacon;
    (navigator as unknown as Record<string, unknown>).sendBeacon = (
      ...args: unknown[]
    ) => {
      attempts.push(`sendBeacon(${String(args[0]).slice(0, 80)})`);
      return false;
    };
  }
  return {
    attempts,
    restore: () => {
      for (const [name, value] of Object.entries(saved)) {
        if (name === "sendBeacon") {
          (navigator as unknown as Record<string, unknown>).sendBeacon = value;
        } else {
          g[name] = value;
        }
      }
    },
  };
}

describe("C4 — the 40-query fixture set, and no model call for navigation", () => {
  beforeEach(() => clearCapsuleRouterCache(FIXTURE_CONTEXT));

  it("classifies all 40 fixtures correctly, and prints the table", () => {
    const rows: Array<{ query: string; want: string; got: string; ok: boolean }> =
      [];
    for (const f of CAPSULE_ROUTER_FIXTURES) {
      const got = routeQuery(f.query, FIXTURE_CONTEXT).classification.lane;
      rows.push({ query: f.query, want: f.lane, got, ok: got === f.lane });
    }
    const misses = rows.filter((r) => !r.ok);
    const byLane: Record<string, { n: number; ok: number }> = {};
    for (const r of rows) {
      const b = (byLane[r.want] ??= { n: 0, ok: 0 });
      b.n += 1;
      if (r.ok) b.ok += 1;
    }
    console.log(
      "\n[C4] router accuracy " +
        `${rows.filter((r) => r.ok).length}/${rows.length} — ` +
        Object.entries(byLane)
          .map(([lane, b]) => `${lane} ${b.ok}/${b.n}`)
          .join(" · "),
    );
    expect(
      misses,
      misses.map((m) => `${JSON.stringify(m.query)} wanted ${m.want}, got ${m.got}`).join("\n"),
    ).toHaveLength(0);
  });

  it("never touches the network — not on a full query, not on any prefix of one", () => {
    const trap = trapTheNetwork();
    try {
      for (const f of CAPSULE_ROUTER_FIXTURES) {
        for (let i = 1; i <= f.query.length; i += 1) {
          const result = routeQuery(f.query.slice(0, i), FIXTURE_CONTEXT);
          // Exercise the keyboard path too — Tab/arrows must be free.
          for (const key of ["Tab", "ArrowDown", "ArrowUp", "Home", "End"]) {
            willCallModel(result, nextIndex(result, 0, key));
          }
        }
      }
    } finally {
      trap.restore();
    }
    expect(trap.attempts, trap.attempts.join("\n")).toHaveLength(0);
  });

  it("Enter on a navigation, entity or action query costs nothing — every prefix, every fixture", () => {
    const spenders: string[] = [];
    for (const f of NAV_NEVER_MODEL) {
      for (let i = 1; i <= f.query.length; i += 1) {
        const prefix = f.query.slice(0, i);
        const result = routeQuery(prefix, FIXTURE_CONTEXT);
        if (result.classification.lane === "ask") continue;
        // Nothing has matched YET ("down", "toggle sid"): the Ask row is
        // the only thing on offer, and offering it is not spending —
        // the user still has to choose it. The gate is about a match
        // being SHADOWED by Ask, not about an empty list.
        if (result.noResults) continue;
        if (willCallModel(result, result.defaultIndex)) {
          spenders.push(`${f.lane} fixture ${JSON.stringify(f.query)} spends at ${JSON.stringify(prefix)}`);
        }
      }
    }
    expect(spenders, spenders.join("\n")).toHaveLength(0);
  });

  it("the Ask row is always exactly one keystroke away, and it is the only paid row", () => {
    for (const f of CAPSULE_ROUTER_FIXTURES) {
      const result = routeQuery(f.query, FIXTURE_CONTEXT);
      const askRows = result.rows.filter((r) => r.kind === "ask");
      expect(askRows.length, f.query).toBe(1);
      expect(askRows[0].id).toBe(ASK_ROW_ID);
      expect(result.askIndex, f.query).toBeLessThanOrEqual(1);
      expect(result.askInOneKeystroke).toBe(true);
      expect(willCallModel(result, nextIndex(result, result.defaultIndex, "Tab")))
        .toBe(true);
      // Exactly one row in the whole result can spend.
      const paid = result.rows.filter((_r, i) => willCallModel(result, i));
      expect(paid.length, f.query).toBe(1);
    }
  });

  it("an ambiguous query offers BOTH readings, never one at the other's expense", () => {
    for (const query of AMBIGUOUS_FIXTURES) {
      const result = routeQuery(query, FIXTURE_CONTEXT);
      const kinds = new Set(result.rows.map((r) => r.kind));
      expect(kinds.has("ask"), query).toBe(true);
      expect(
        [...kinds].some((k) => k !== "ask"),
        `${query} offered only the Ask row`,
      ).toBe(true);
    }
  });

  it("routing is a pure function of (query, context) — same bytes twice", () => {
    for (const f of CAPSULE_ROUTER_FIXTURES) {
      clearCapsuleRouterCache(FIXTURE_CONTEXT);
      const a = JSON.stringify(routeQuery(f.query, FIXTURE_CONTEXT).rows);
      clearCapsuleRouterCache(FIXTURE_CONTEXT);
      const b = JSON.stringify(routeQuery(f.query, FIXTURE_CONTEXT).rows);
      expect(b, f.query).toBe(a);
      expect(foldQuery(f.query)).toBe(foldQuery(f.query));
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// C6 — the unit law
// ══════════════════════════════════════════════════════════════════════

describe("C6 — an answer is identical in RON and EUR except for presentation", () => {
  function renderIn(currency: Currency): HTMLElement {
    DISPLAY = currency;
    return renderNarrative({
      text: "fallback",
      template: GROUNDED_TEMPLATE,
      facts: ANSWER_FACTS,
      factUnits: ANSWER_UNITS,
      sourceCurrency: "RON",
    });
  }

  function skeleton(root: HTMLElement): string {
    return [...root.querySelectorAll("*")]
      .map((el) =>
        `${el.tagName}:${el.getAttribute("data-narrative-money") ?? ""}`)
      .join("|");
  }

  it("keeps the same facts in the same places, and converts only the money", () => {
    const ron = renderIn("RON");
    const ronText = ron.textContent ?? "";
    const ronSkeleton = skeleton(ron);
    const ronFacts = [...ron.querySelectorAll("[data-narrative-money]")]
      .map((el) => el.getAttribute("data-narrative-money"));
    cleanup();

    const eur = renderIn("EUR");
    const eurText = eur.textContent ?? "";

    expect(skeleton(eur)).toBe(ronSkeleton);
    expect([...eur.querySelectorAll("[data-narrative-money]")]
      .map((el) => el.getAttribute("data-narrative-money"))).toEqual(ronFacts);
    // The money moved …
    expect(eurText).not.toBe(ronText);
    for (const el of eur.querySelectorAll("[data-narrative-money]")) {
      expect(el.getAttribute("data-narrative-currency")).toBe("EUR");
    }
    // … and the prose around it did not.
    const strip = (s: string) => s.replace(/[\d.,\u00a0\u202f]+/g, "#")
      .replace(/RON|EUR|€|lei/gi, "¤");
    expect(strip(eurText)).toBe(strip(ronText));
  });

  it("the RATIO does not move — it is dimensionless and never converts", () => {
    const template = "Current ratio is {{fact:current_ratio|d2}} on " +
      "{{money:total_assets}} of assets.";
    DISPLAY = "RON";
    const ron = renderNarrative({
      text: "fallback", template, facts: ANSWER_FACTS,
      factUnits: ANSWER_UNITS, sourceCurrency: "RON",
    }).textContent ?? "";
    cleanup();
    DISPLAY = "EUR";
    const eur = renderNarrative({
      text: "fallback", template, facts: ANSWER_FACTS,
      factUnits: ANSWER_UNITS, sourceCurrency: "RON",
    }).textContent ?? "";

    expect(ron).toContain("2.80");
    expect(eur, "the ratio moved with the display currency — the 1553% class")
      .toContain("2.80");
    // And the ratio is never labelled with a currency in either.
    expect(eur).not.toMatch(/2\.80\s*(RON|EUR|€|lei)/i);
  });

  it("one claim, one currency — every money span in an answer agrees", () => {
    for (const currency of ["RON", "EUR"] as Currency[]) {
      DISPLAY = currency;
      const container = renderNarrative({
        text: "fallback",
        template: GROUNDED_TEMPLATE,
        facts: ANSWER_FACTS,
        factUnits: ANSWER_UNITS,
        sourceCurrency: "RON",
      });
      const seen = new Set(
        [...container.querySelectorAll("[data-narrative-money]")]
          .map((el) => el.getAttribute("data-narrative-currency")),
      );
      expect(seen.size, `${currency}: ${[...seen].join(" + ")}`).toBe(1);
      cleanup();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// C7 — degraded parity
// ══════════════════════════════════════════════════════════════════════

// A realistic Anthropic-style failure body: braces, request_id, slug.
const RAW_400 = JSON.stringify({
  type: "error",
  error: { type: "invalid_request_error", message: "max_tokens: field required" },
  request_id: "req_011CTHagbPFpjPQ2VYbAdi8n",
});
const FORBIDDEN = ["{", "}", "request_id", "req_011", "invalid_request_error",
  "max_tokens", "stack", "Traceback"];

describe("C7 — with AI dead, everything that is not AI keeps working", () => {
  it("search, navigation, entities and actions are unaffected by a dead model", () => {
    const trap = trapTheNetwork();
    try {
      for (const f of NAV_NEVER_MODEL) {
        const result = routeQuery(f.query, FIXTURE_CONTEXT);
        expect(result.rows.length, f.query).toBeGreaterThan(0);
        expect(result.noResults, f.query).toBe(false);
        const top = result.rows[result.defaultIndex];
        expect(top.kind, f.query).not.toBe("ask");
        // Every non-ask row resolves to somewhere to GO or something to
        // RUN — neither of which needs a model.
        expect(
          Boolean(top.to || top.commandId || top.entity),
          `${f.query} produced a row that does nothing`,
        ).toBe(true);
      }
    } finally {
      trap.restore();
    }
    expect(trap.attempts).toHaveLength(0);
  });

  it("every AI failure collapses onto ONE calm state", () => {
    const kinds = new Set([
      classifyAiFailure(new Error(RAW_400)),
      classifyAiFailure(new TypeError("Failed to fetch")),
      classifyAiFailure({ status: 500, body: RAW_400 }),
      classifyAiFailure(undefined),
    ]);
    for (const kind of kinds) {
      expect(Object.keys(AI_FAILURE_REASON_KEY)).toContain(kind);
    }
    // The Edge Function's wrapped-upstream sentinel is intercepted, so a
    // raw payload cannot walk in disguised as a successful answer.
    expect(classifyUpstreamAnswer(`Couldn't reach Claude: 400 ${RAW_400}`))
      .not.toBeNull();
    expect(classifyUpstreamAnswer("Revenue rose because volume rose."))
      .toBeNull();
  });

  it("the degraded copy the user sees contains no raw payload and no figure", () => {
    const bundle = (degradedStrings as Record<string, Record<string, Record<string, string>>>);
    for (const lang of ["en", "ro"]) {
      const strings = bundle[lang].chatDegraded;
      expect(Object.keys(strings).length).toBeGreaterThan(0);
      for (const [key, copy] of Object.entries(strings)) {
        for (const forbidden of FORBIDDEN) {
          expect(copy, `${lang}.${key} leaks ${forbidden}`)
            .not.toContain(forbidden);
        }
        expect(figuresIn(copy, []), `${lang}.${key} states a figure`)
          .toEqual([]);
      }
      // Every reason key the mapper can produce actually has copy.
      for (const reasonKey of Object.values(AI_FAILURE_REASON_KEY)) {
        expect(strings[reasonKey.split(".")[1]],
          `${lang} has no copy for ${reasonKey}`).toBeTruthy();
      }
    }
  });

  it("a degraded answer rendered into the DOM leaks nothing", () => {
    // The failure text is what a careless surface would render as the
    // answer body. Through the sanctioned renderer it stays inert
    // TEXT — and the DOM law confirms no figure claims provenance it
    // does not have.
    const container = renderNarrative({
      text: "CFO AI is unavailable right now — your figures are unaffected.",
      template: `Couldn't reach Claude: 400 ${RAW_400}`,
      facts: ANSWER_FACTS,
      factUnits: ANSWER_UNITS,
      sourceCurrency: "RON",
    });
    const html = container.innerHTML;
    for (const forbidden of FORBIDDEN) {
      expect(html, `raw payload fragment ${forbidden} reached the DOM`)
        .not.toContain(forbidden);
    }
    expect(unprovenancedFigures(container, ALLOWED_IDENTIFIERS)).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════
// C9 — latency, measured
// ══════════════════════════════════════════════════════════════════════

// Navigation results must feel instantaneous. The reported number is
// the measurement below, not this ceiling.
const NAV_CEILING_MS = 100;

describe("C9 — navigation latency", () => {
  it("routes every prefix of every fixture, cold, and reports the distribution", () => {
    const samples: number[] = [];
    let worst = { ms: 0, query: "" };
    for (const f of CAPSULE_ROUTER_FIXTURES) {
      for (let i = 1; i <= f.query.length; i += 1) {
        const prefix = f.query.slice(0, i);
        clearCapsuleRouterCache(FIXTURE_CONTEXT);
        const t0 = performance.now();
        routeQuery(prefix, FIXTURE_CONTEXT);
        const ms = performance.now() - t0;
        samples.push(ms);
        if (ms > worst.ms) worst = { ms, query: prefix };
      }
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    console.log(
      `\n[C9] capsule routing over ${samples.length} cold keystrokes: ` +
        `p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms ` +
        `max=${worst.ms.toFixed(3)}ms (${JSON.stringify(worst.query)})`,
    );
    expect(worst.ms,
      `slowest keystroke ${worst.ms.toFixed(1)}ms on ${JSON.stringify(worst.query)}`)
      .toBeLessThan(NAV_CEILING_MS);
  });

  it("a warm keystroke is free — the memo returns the same object", () => {
    clearCapsuleRouterCache(FIXTURE_CONTEXT);
    const first: CapsuleRouterResult = routeQuery("cash flow", FIXTURE_CONTEXT);
    const second: CapsuleRouterResult = routeQuery("cash flow", FIXTURE_CONTEXT);
    expect(second).toBe(first);
  });
});

// ══════════════════════════════════════════════════════════════════════
// C1 / C7 / C9 — bound to the LIVE answer pipeline
// ══════════════════════════════════════════════════════════════════════
//
// The sections above hold whatever the answer surface turns out to be:
// they are laws about rendered output and about the router, and they
// were written before the answer lane landed. These bind to the
// pipeline itself — `runAnswerTurn`, which takes its tool transport,
// its generation transport and its clock as arguments, so a gate can
// drive the whole "retrieve → generate → guard → regenerate once →
// fall back" path with no network and no model spend.
//
// Dynamic import: a missing module SKIPS loudly (the precedent is
// `designGateRawError.test.ts`) instead of exploding the run at
// transform time. If the module lands with a shape these probes cannot
// drive, the tests FAIL with instructions — a loud failure is the
// point; a silent pass is not.

const answerClient = await import(
  "@/components/instrument/shell/capsuleAnswer/capsuleAnswerClient"
).catch(() => null);
const answerGuard = await import(
  "@/components/instrument/shell/capsuleAnswer/capsuleAnswerGuard"
).catch(() => null);

type ToolPayload = {
  version: string; tool: string; read_only: boolean; ok: boolean;
  values: unknown[]; rows: unknown[]; gaps: unknown[]; limitations: unknown[];
  notes: string[]; facts: Record<string, number>;
  fact_units: Record<string, string>; currency: string | null;
};

/** A ct1 payload, shaped exactly as `_capsule_tools.to_payload()` emits
 *  it — same fact names, same provenance keys, same integer minor
 *  units. The fixture is the engine suite's December 2024 book. */
function factsPayload(): ToolPayload {
  return {
    version: "ct1", tool: "get_facts", read_only: true, ok: true,
    values: [{
      kind: "money", fact: "total_assets", metric: "total_assets",
      unit: "money", amount_minor: 390000, value: 3900, currency: "RON",
      scope: "December 2024", label_key: "capsule.metric.total_assets",
      provenance: {
        period_id: "p-dec", period_label: "December 2024",
        entity_id: "org-1", source: "assembled_canonical_v1",
        tier: "canonical_bs", snapshot_id: "sha256-p-dec",
      },
    }],
    rows: [], gaps: [], limitations: [], notes: [],
    facts: { total_assets: 3900 },
    fact_units: { total_assets: "money" },
    currency: "RON",
  };
}

const PLAN_STEP = {
  id: "get_facts:0",
  tool: "get_facts",
  args: { metric: "total_assets" },
  period: "p-dec",
  traceKey: "capsuleAnswer.trace.get_facts",
  traceParams: {},
};

const GROUNDED_ANSWER = "Total assets are {{money:total_assets}} for December 2024.";
const FABRICATED = "Total assets are RON 3,900 for December 2024.";

/** A generation transport that yields the given texts, one per call, and
 *  records how many times it was asked. */
function transportOf(...texts: string[]) {
  const calls: string[] = [];
  const generate = (req: { messages: { content: string }[] }) => {
    const i = calls.length;
    calls.push(req.messages[req.messages.length - 1]?.content ?? "");
    const text = texts[Math.min(i, texts.length - 1)];
    return (async function* () { yield text; })();
  };
  return { generate, calls };
}

describe.skipIf(!answerClient || !answerGuard)(
  "C1 — the live guard: reject at parse, regenerate ONCE, then fall back",
  () => {
    it("the guard refuses a fabricated figure and accepts the placeholder", () => {
      const input = {
        facts: { total_assets: 3900 },
        factUnits: { total_assets: "money" },
        literals: ["December 2024"],
      };
      const bad = answerGuard!.guardAnswer(FABRICATED, input);
      expect(bad.ok).toBe(false);
      expect(bad.violations.map((v: { kind: string }) => v.kind))
        .toContain("numeral");
      const good = answerGuard!.guardAnswer(GROUNDED_ANSWER, input);
      expect(good.ok, JSON.stringify(good.violations)).toBe(true);
      expect(good.citedFacts).toEqual(["total_assets"]);
      // A placeholder naming a fact retrieval never returned is refused
      // too — the second shape of fabrication.
      expect(answerGuard!.guardAnswer("Cash is {{money:cash}}.", input).ok)
        .toBe(false);
    });

    it("regenerates EXACTLY once, and renders the corrected answer", async () => {
      const t = transportOf(FABRICATED, GROUNDED_ANSWER);
      const turn = await answerClient!.runAnswerTurn({
        turnId: "t1", question: "what are total assets", history: [],
        plan: [PLAN_STEP], toolTransport: async () => factsPayload(),
        generate: t.generate, language: "en", now: () => 0,
      });
      expect(t.calls.length, "the pipeline must retry once, and only once")
        .toBe(2);
      expect(turn.regenerated).toBe(true);
      expect(turn.deterministic).toBe(false);
      expect(turn.blocks.length).toBeGreaterThan(0);
      expect(turn.citedFacts).toEqual(["total_assets"]);
      // The corrected prose carries the PLACEHOLDER, not the digits.
      const prose = turn.blocks.map((b: { template: string }) => b.template).join(" ");
      expect(prose).toContain("{{money:total_assets}}");
      expect(prose).not.toContain("3,900");
    });

    it("FALLS BACK DETERMINISTICALLY when the model fabricates twice", async () => {
      const t = transportOf(FABRICATED, FABRICATED);
      const turn = await answerClient!.runAnswerTurn({
        turnId: "t2", question: "what are total assets", history: [],
        plan: [PLAN_STEP], toolTransport: async () => factsPayload(),
        generate: t.generate, language: "en", now: () => 0,
      });
      expect(t.calls.length).toBe(2);
      expect(turn.regenerated).toBe(true);
      expect(turn.deterministic,
        "a twice-fabricating model must not reach the reader").toBe(true);
      // The prose is discarded WHOLE — no sanitised half-answer.
      expect(turn.blocks).toEqual([]);
      expect(turn.streaming).toBe("");
      expect(JSON.stringify(turn.blocks)).not.toContain("3,900");
      // …and the figures still get answered, from the evidence.
      expect(turn.citedFacts).toContain("total_assets");
      expect(turn.evidence.facts.total_assets).toBe(3900);
    });

    it("the deterministic fallback is the same answer twice", async () => {
      const run = async () => {
        const t = transportOf(FABRICATED, FABRICATED);
        const turn = await answerClient!.runAnswerTurn({
          turnId: "fixed", question: "what are total assets", history: [],
          plan: [PLAN_STEP], toolTransport: async () => factsPayload(),
          generate: t.generate, language: "en", now: () => 0,
        });
        return JSON.stringify({
          blocks: turn.blocks, cited: turn.citedFacts,
          deterministic: turn.deterministic, facts: turn.evidence.facts,
          violations: turn.violations,
        });
      };
      expect(await run()).toBe(await run());
    });
  },
);

describe.skipIf(!answerClient)("C7 — the live pipeline with the model dead", () => {
  it("degrades to one calm state, keeps the figures, and retains no raw payload", async () => {
    const raw = RAW_400;
    const turn = await answerClient!.runAnswerTurn({
      turnId: "t3", question: "what are total assets", history: [],
      plan: [PLAN_STEP], toolTransport: async () => factsPayload(),
      generate: () => (async function* () {
        throw new Error(raw);
        yield "";
      })(),
      language: "en", now: () => 0,
    });
    expect(turn.status).toBe("done");
    expect(turn.degraded, "a dead model must classify to one calm kind")
      .not.toBeNull();
    expect(Object.keys(AI_FAILURE_REASON_KEY)).toContain(turn.degraded);
    expect(turn.deterministic).toBe(true);
    expect(turn.blocks).toEqual([]);
    expect(turn.streaming).toBe("");
    // Retrieval already happened, so the answer is not empty — the
    // figures survive the model being gone.
    expect(turn.evidence.facts.total_assets).toBe(3900);
    // Nothing of the raw payload is retained anywhere on the turn.
    const blob = JSON.stringify(turn);
    for (const forbidden of ["request_id", "req_011", "invalid_request_error"]) {
      expect(blob, `raw payload fragment ${forbidden} survived on the turn`)
        .not.toContain(forbidden);
    }
  });

  it("a tool read that throws becomes a stated absence, not a failed turn", async () => {
    const t = transportOf("Nothing to report for {{money:total_assets}}.");
    const turn = await answerClient!.runAnswerTurn({
      turnId: "t4", question: "what are total assets", history: [],
      plan: [PLAN_STEP],
      toolTransport: async () => { throw new Error("engine down: " + RAW_400); },
      generate: t.generate, language: "en", now: () => 0,
    });
    expect(turn.status).toBe("done");
    expect(turn.trace.every((l: { state: string }) => l.state !== "pending")).toBe(true);
    const blob = JSON.stringify(turn);
    for (const forbidden of ["request_id", "req_011", "invalid_request_error"]) {
      expect(blob).not.toContain(forbidden);
    }
  });
});

describe.skipIf(!answerClient)("C9 — first token, measured on fixtures", () => {
  it("reports the surface's own first-token distribution", async () => {
    // What this measures: everything the CAPSULE does between the
    // question and the first generated chunk — plan, retrieval merge,
    // brief assembly — with the tool and model transports stubbed by
    // fixtures. It excludes Anthropic's own time by construction, which
    // is why the number is reported as the surface's overhead and not
    // as an end-to-end promise.
    const samples: number[] = [];
    const questions = [
      "what are total assets", "how did total assets change",
      "why is cash down this month", "what changed vs last month",
      "is the balance sheet balanced", "explain the 461 balance",
    ];
    for (const question of questions) {
      for (let i = 0; i < 5; i += 1) {
        const t = transportOf(GROUNDED_ANSWER);
        const turn = await answerClient!.runAnswerTurn({
          turnId: `q${i}`, question, history: [], plan: [PLAN_STEP],
          toolTransport: async () => factsPayload(),
          generate: t.generate, language: "en",
          // Sub-millisecond clock: Date.now() quantises this whole
          // measurement to 0 and reports a number nobody can act on.
          now: () => performance.now(),
        });
        expect(turn.timing.firstTokenMs, question).not.toBeNull();
        samples.push(turn.timing.firstTokenMs as number);
      }
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    console.log(
      `\n[C9] capsule first token over ${samples.length} fixture turns ` +
        `(model + tools stubbed): p50=${p50.toFixed(2)}ms ` +
        `p95=${p95.toFixed(2)}ms max=${sorted[sorted.length - 1].toFixed(2)}ms`,
    );
    expect(p50, "surface overhead alone must not eat the 1.5s budget")
      .toBeLessThan(1500);
  });
});
