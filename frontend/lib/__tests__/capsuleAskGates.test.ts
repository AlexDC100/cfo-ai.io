// THE CAPSULE — ASK-FIRST GATES K2, K3, K4, K5, K9: the jsdom half.
//
// The gates lane owns no product code. It owns the proof that the product
// code cannot do the thing it promises not to do. Every gate here has a
// PLANT — a defect made real, run, observed to trip the gate, reverted —
// recorded with its exact diff and exact output in
// `design_review/capsule/GATES.md`. A gate whose plant was never run is a
// gate nobody has proven is wired to anything.
//
//   K2  EMPTY-STATE BUDGET — ≤3 zones, ≤8 rows. The COUNTER lives here
//       and is proven against planted DOM; it is applied to the live
//       surface in `e2e/design/capsule.spec.ts`. Deliberately mirrored
//       rather than shared: an in-page evaluator cannot import a module.
//   K3  TIER-0 COVERAGE — ≥60% of the 30-question set answered with ZERO
//       model calls, each under 100 ms. Network is booby-trapped, so
//       "zero model calls" is observed, not asserted from reading code.
//   K4  FACT BEFORE PROSE — the ORDERING, not timing luck: the first
//       pipeline state that carries any prose already carries the facts.
//   K5  LATENCY — measured, then regression-gated against the numbers
//       recorded in `design_review/capsule/LATENCY.md`.
//   K9  ROUTER <5 ms, and NAVIGATION NEVER SPENDS. Re-proven on the new
//       surface over every PREFIX of every fixture, because that is what
//       typing actually is.
//
// C1 (numerals), C3 (provenance), C6 (units) and C7 (degraded) live in
// the sibling `capsuleGates.test.ts` and are re-proven on the live DOM by
// `capsule.spec.ts` §K9. The engine half is
// `tests/engine/test_capsule_gates.py`.
//
// NO MODEL SPEND. Anthropic credits are live and billing. Every transport
// here is a fixture and every network primitive is trapped.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  CAPSULE_ROUTER_FIXTURES,
  FIXTURE_CONTEXT,
} from "@/lib/capsuleRouterFixtures";
import { routeQuery, willCallModel } from "@/lib/capsuleRouter";
import { factsFrom } from "@/lib/servedFacts";
import type { Statements } from "@/lib/financialReport";
import {
  ANSWER_FIXTURES,
  FIXTURE_PERIODS,
  fixtureGenerationTransport,
  fixtureToolTransport,
} from "@/components/instrument/shell/capsuleAnswer/capsuleAnswerFixtures";
import { planRetrieval } from "@/components/instrument/shell/capsuleAnswer/capsuleRetrieval";
import { runAnswerTurn, type CapsuleTurn } from "@/components/instrument/shell/capsuleAnswer/capsuleAnswerClient";

const REPO_ROOT = resolve(__dirname, "../../..");

// jsdom in this build ships a broken localStorage; the sibling capsule
// suites use the same in-memory shim.
const bag = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => bag.get(k) ?? null,
    setItem: (k: string, v: string) => void bag.set(k, String(v)),
    removeItem: (k: string) => void bag.delete(k),
    clear: () => void bag.clear(),
    key: (i: number) => [...bag.keys()][i] ?? null,
    get length() {
      return bag.size;
    },
  },
});

// ══════════════════════════════════════════════════════════════════════
// THE SPEED-LANE CONTRACT
// ══════════════════════════════════════════════════════════════════════
//
// `capsuleFactIndex.ts`, `capsuleTier0.ts` and `capsuleLatency.ts` are
// published by the speed lane with signatures fixed in the wave contract.
// This lane imports them and assumes them from minute one.
//
// They are loaded through `import.meta.glob` rather than a static import
// for ONE reason, and it is a gate-design reason, not a convenience:
//
//   A missing module must make the gate go RED, not make the repository
//   fail to COMPILE.
//
// A static import of a not-yet-published module takes `tsc --noEmit`
// down for every lane at once, which converts one lane's schedule into
// everybody's outage and — worse — tempts the next person to delete the
// gate to get their build back. With the glob, the gate reports exactly
// which module is missing, in the language of the contract, and every
// other gate in this file keeps running and keeps meaning something.
//
// It is emphatically NOT a skip. A gate whose subject is absent FAILS.
const LANE_MODULES = import.meta.glob("../capsule*.ts");

interface FactRef {
  factKey: string;
  label: string;
  value: number;
  unit: string;
  currency?: string;
  provenance?: { docId?: string; cell?: string; account?: string };
  periodId: string;
  periodLabel: string;
}
interface Tier0Answer {
  kind: "fact" | "compare" | "meta";
  facts: FactRef[];
  deltaPct?: number;
  note?: string;
}

async function laneModule(name: string): Promise<Record<string, unknown>> {
  const key = `../${name}.ts`;
  const loader = LANE_MODULES[key];
  if (!loader) {
    throw new Error(
      `SPEED-LANE CONTRACT UNMET — frontend/lib/${name}.ts is not published.\n` +
        `  The wave contract fixes its signature; this gate imports it and assumes it.\n` +
        `  Published siblings found: ${Object.keys(LANE_MODULES).sort().join(", ") || "(none)"}\n` +
        `  This is a RED gate, not a skipped one: K3/K5 measure a surface that does not exist yet.`,
    );
  }
  return (await loader()) as Record<string, unknown>;
}

function requireExport<T>(mod: Record<string, unknown>, name: string, where: string): T {
  const v = mod[name];
  if (typeof v !== "function") {
    throw new Error(
      `SPEED-LANE CONTRACT UNMET — ${where} does not export \`${name}\` as a function.\n` +
        `  Exports present: ${Object.keys(mod).sort().join(", ") || "(none)"}`,
    );
  }
  return v as T;
}

// ══════════════════════════════════════════════════════════════════════
// THE NETWORK BOOBY TRAP
// ══════════════════════════════════════════════════════════════════════
//
// "Zero model calls" is not something you read off the source; it is
// something you OBSERVE. Every primitive that can reach the wire is
// replaced with one that records and throws, so a spend cannot hide
// behind a swallowed promise rejection either — the record survives the
// catch.

interface Trap {
  calls: string[];
  restore: () => void;
}

function trapNetwork(): Trap {
  const calls: string[] = [];
  const g = globalThis as unknown as Record<string, unknown>;
  const saved: Record<string, unknown> = {};
  const note = (label: string) => {
    calls.push(label);
    throw new Error(`NETWORK CALL during a zero-spend section: ${label}`);
  };
  for (const key of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource"]) {
    saved[key] = g[key];
  }
  saved.sendBeacon = (g.navigator as Navigator | undefined)?.sendBeacon;

  g.fetch = (input: unknown) => note(`fetch ${String(input)}`);
  g.XMLHttpRequest = class {
    open(_m: string, url: string) {
      note(`xhr ${url}`);
    }
  };
  g.WebSocket = class {
    constructor(url: string) {
      note(`ws ${url}`);
    }
  };
  g.EventSource = class {
    constructor(url: string) {
      note(`sse ${url}`);
    }
  };
  try {
    Object.defineProperty(globalThis.navigator, "sendBeacon", {
      configurable: true,
      value: (url: string) => note(`beacon ${url}`),
    });
  } catch {
    /* some jsdom builds seal navigator; the four above are the paths that matter */
  }

  return {
    calls,
    restore() {
      for (const [k, v] of Object.entries(saved)) {
        if (k === "sendBeacon") continue;
        g[k] = v;
      }
      try {
        Object.defineProperty(globalThis.navigator, "sendBeacon", {
          configurable: true,
          value: saved.sendBeacon,
        });
      } catch {
        /* see above */
      }
    },
  };
}

// ══════════════════════════════════════════════════════════════════════
// K2 — THE EMPTY-STATE BUDGET, and the counter that enforces it
// ══════════════════════════════════════════════════════════════════════
//
// Production stacked FIVE zones and eighteen rows into the thing a user
// sees before typing a single character. The budget is:
//
//     ≤ 3 ZONES      a zone is a titled or landmarked region
//     ≤ 8 ROWS       a row is a selectable line
//
// The counting rules matter more than the numbers, because a lane that
// wants to keep five zones will reach for the definition first:
//
//   · A ZONE is a region with a heading, a `role="group"`, a
//     `role="region"`, or an `aria-label` on a container that holds
//     rows. Restyling a heading into an uppercase `<div>` does not make
//     it stop being a zone, so the counter takes ANY of those signals.
//   · A ROW is anything the reader can pick: `role="option"`,
//     `role="menuitem"`, `<li>` with a click target, or a `<button>`
//     inside a list region. Turning options into buttons is a
//     refactor, not a reduction.
//   · The PROSE INPUT is not a row. It is the surface.
//
// Mirrored into `capsule.spec.ts` as an in-page evaluator — an in-page
// function cannot import a module, and the sibling `figuresIn` law is
// mirrored across three files for exactly the same reason.

export interface BudgetCensus {
  zones: number;
  rows: number;
  zoneLabels: string[];
  rowLabels: string[];
}

const ROW_SELECTOR = [
  '[role="option"]',
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  "li button",
  "li a[href]",
  '[role="listbox"] button',
  '[role="list"] button',
].join(", ");

const ZONE_SELECTOR = [
  '[role="group"]',
  '[role="region"]',
  "section",
  "h1, h2, h3, h4, h5, h6",
].join(", ");

export function budgetCensus(root: Element): BudgetCensus {
  const visible = (el: Element) => {
    const style = (el.ownerDocument.defaultView ?? window).getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden";
  };

  const rows = [...root.querySelectorAll(ROW_SELECTOR)].filter(visible);
  // De-duplicate nesting: a <li><button> is ONE row, not two.
  const topRows = rows.filter((el) => !rows.some((o) => o !== el && o.contains(el)));

  const zoneEls = [...root.querySelectorAll(ZONE_SELECTOR)].filter(visible);
  // An aria-labelled container that holds rows is a zone even with no
  // heading element — that is how a "quiet" group is usually built.
  for (const el of [...root.querySelectorAll("[aria-label], [aria-labelledby]")]) {
    if (!visible(el)) continue;
    if (el.matches(ROW_SELECTOR)) continue;
    if (!topRows.some((r) => el.contains(r))) continue;
    if (!zoneEls.includes(el)) zoneEls.push(el);
  }
  // A heading inside a zone container names that zone; count the NAME
  // once, not the wrapper and the heading separately.
  const zones = zoneEls.filter((el) => !zoneEls.some((o) => o !== el && o.contains(el) && el.tagName.length > 2));

  const text = (el: Element) => (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 48);
  return {
    zones: zones.length,
    rows: topRows.length,
    zoneLabels: zones.map(text),
    rowLabels: topRows.map(text),
  };
}

export const ZONE_BUDGET = 3;
export const ROW_BUDGET = 8;

describe("K2 — the empty-state budget, and a counter with teeth", () => {
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
  });
  afterEach(() => host.remove());

  it("counts an ASK-FIRST empty state as within budget", () => {
    // What the rebuilt surface is meant to be: one prose input, one
    // quiet context line, and a short list of resolved questions.
    host.innerHTML = `
      <div data-testid="capsule-empty">
        <input role="combobox" placeholder="Ask about December 2024…" />
        <section aria-label="Context"><p>December 2024 · balanced</p></section>
        <section aria-label="Try"><div role="listbox">
          <div role="option">What are total assets?</div>
          <div role="option">How did equity move?</div>
          <div role="option">Why was 461 flagged?</div>
        </div></section>
      </div>`;
    const c = budgetCensus(host);
    expect(c.zones, `zones: ${c.zoneLabels.join(" | ")}`).toBeLessThanOrEqual(ZONE_BUDGET);
    expect(c.rows, `rows: ${c.rowLabels.join(" | ")}`).toBeLessThanOrEqual(ROW_BUDGET);
  });

  it("the prose input is NOT counted as a row", () => {
    host.innerHTML = `<div><input role="combobox" /><div role="listbox">
      <div role="option">one</div></div></div>`;
    expect(budgetCensus(host).rows).toBe(1);
  });

  it("a <li><button> row is counted ONCE, not twice", () => {
    host.innerHTML = `<ul><li><button>recent question</button></li></ul>`;
    expect(budgetCensus(host).rows).toBe(1);
  });

  // ── PLANT — production's own empty state, rebuilt from the live DOM ──
  //
  // Five zones, sixteen rows: the structure `capsule.spec.ts` measured on
  // /dashboard before this wave. If the counter cannot see THIS, it
  // cannot see anything.
  it("PLANT: production's five-zone, sixteen-row empty state trips both budgets", () => {
    const row = (t: string) => `<div role="option">${t}</div>`;
    host.innerHTML = `
      <div data-testid="capsule-empty">
        <section aria-label="Context"><p>Period · not verified</p></section>
        <section aria-label="Recent questions"><div role="listbox">
          ${row("why did 461 move")}${row("total assets")}
        </div></section>
        <section aria-label="From this workspace"><div role="listbox">
          ${row("Aug 2026 has no file yet — what should I upload?")}
        </div></section>
        <section aria-label="Pages"><div role="listbox">
          ${row("Dashboard")}${row("Ask a question")}${row("Workspaces")}
          ${row("Scenarios")}${row("Benchmark")}${row("Products")}
          ${row("Budget vs Actual vs LY")}${row("Public Companies")}
          ${row("Ask CFO AI")}${row("Settings")}
        </div></section>
        <section aria-label="Actions"><div role="listbox">
          ${row("Upload a document")}${row("Export statements")}${row("Toggle sidebar")}
        </div></section>
      </div>`;
    const c = budgetCensus(host);
    expect(c.zones).toBeGreaterThan(ZONE_BUDGET);
    expect(c.rows).toBeGreaterThan(ROW_BUDGET);
    // The failure message a lane will actually read:
    expect(
      `${c.zones} zones / ${c.rows} rows`,
      "K2 PLANT: the pre-wave empty state must exceed both budgets",
    ).toBe("5 zones / 16 rows");
  });
});

// ══════════════════════════════════════════════════════════════════════
// K3 — TIER-0 COVERAGE
// ══════════════════════════════════════════════════════════════════════
//
// ── The corpus, and what it honestly is ──────────────────────────────
//
// The brief asks for coverage "against the real recent-questions log".
// THERE IS NO SUCH LOG, and saying so is the finding: recent questions
// live in `localStorage` under `cfo:capsule-recents:v1:<org>`, are
// declared device-local on purpose (`capsuleRecents.ts`, and CLAUDE.md
// §16 Milestone C's "deliberately NOT synced" list), and are never
// mirrored to Supabase. Nothing server-side has ever recorded a Capsule
// question. Quoting a percentage against a log that does not exist would
// be exactly the fabrication these gates were built to stop.
//
// So the corpus is assembled from the three places in this repository
// where real product questions are written down, each named:
//
//   A. `capsuleEmptyStrings.json` → `capsuleEmpty.suggest.*`
//      The questions the PRODUCT PUTS IN FRONT OF THE USER, generated
//      from live workspace state, in Simple and Pro register, EN and RO.
//      A user clicking one of these IS an asked question — this is the
//      highest-fidelity source available anywhere in the repo.
//   B. `capsuleAnswerFixtures.ts` → `ANSWER_FIXTURES` (12)
//      The answer lane's own retrieval-branch corpus.
//   C. `capsuleRouterFixtures.ts` → the `ask` and `ambiguous` lanes
//      Written as "forty queries a real operator of this product
//      actually types".
//
// Thirty, deterministically ordered, so the percentage is reproducible.

function suggestQuestions(): string[] {
  const path = resolve(
    REPO_ROOT,
    "frontend/components/instrument/shell/capsuleEmpty/capsuleEmptyStrings.json",
  );
  const bundle = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  const out: string[] = [];
  const walk = (node: unknown, dotted: string) => {
    if (typeof node === "string") {
      if (!/\.suggest\./.test(dotted)) return;
      // Resolve the templates with the values the fixture book carries,
      // so the corpus is real sentences and not `{{period}}` husks.
      const resolved = node
        .replace(/\{\{period\}\}/g, FIXTURE_PERIODS[0].label)
        .replace(/\{\{subject\}\}/g, "inventory")
        .replace(/\{\{n\}\}/g, "2");
      if (/[?？]$/.test(resolved)) out.push(resolved);
      return;
    }
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) walk(v, dotted ? `${dotted}.${k}` : k);
    }
  };
  walk(bundle.en, "");
  return out;
}

function tier0Corpus(): string[] {
  const seen = new Set<string>();
  const push = (q: string) => {
    const k = q.trim().toLowerCase();
    if (!k || seen.has(k)) return;
    seen.add(k);
  };
  const ordered: string[] = [];
  const add = (q: string) => {
    const k = q.trim().toLowerCase();
    if (!k || seen.has(k)) return;
    seen.add(k);
    ordered.push(q.trim());
  };
  void push;
  for (const f of ANSWER_FIXTURES) add(f.question); // B — 12
  for (const f of CAPSULE_ROUTER_FIXTURES) {
    if (f.lane === "ask" || f.lane === "ambiguous") add(f.query); // C
  }
  for (const q of suggestQuestions()) add(q); // A
  return ordered.slice(0, 30);
}

/**
 * THE REAL WORKSPACE, from REAL ENGINE OUTPUT.
 *
 * `served_balanced.json` and `served_reconciled_bs.json` are served
 * envelopes (`docs/served_envelope.schema.json`, served_v1) — the same
 * engine↔FE contract `servedFactsContract.test.ts` pins field-by-field.
 * Two periods, so the compare branch has a real baseline to compare
 * against rather than a synthetic one.
 *
 * Per the project's testing convention: fixtures come from REAL ENGINE
 * OUTPUT, not hand-built objects. Three defects surfaced last wave only
 * when a fixture stopped being hand-built — and one surfaced HERE, on
 * the first run of this gate: an earlier draft of this function invented
 * a `{ metrics: [{name, value, unit}] }` snapshot from the suggestion
 * engine's shape. `buildFactIndex` takes `{ periods: [...] }`, so the
 * index came back empty, `resolveTier0` short-circuited on
 * `periods.length === 0`, and coverage measured 0/30. The gate reported
 * a real contract mismatch on its first run, which is the whole argument
 * for building the fixture out of the engine's own bytes.
 */
function realStatements(name: string): Statements {
  return JSON.parse(
    readFileSync(resolve(REPO_ROOT, `frontend/lib/__tests__/fixtures/${name}.json`), "utf-8"),
  ) as Statements;
}

function realSnapshot() {
  const current = realStatements("served_balanced");
  const prior = realStatements("served_reconciled_bs");
  const metricsFor = (st: Statements) => {
    const f = factsFrom(st);
    const cl = f.currentLiabilities();
    const ta = f.totalAssets();
    return {
      total_assets: f.totalAssets(),
      total_equity: f.totalEquity(),
      total_liabilities: f.totalLiabilities(),
      current_assets: f.currentAssets(),
      current_liabilities: cl,
      working_capital: f.workingCapital(),
      current_ratio: cl ? f.currentAssets() / cl : null,
      equity_ratio: ta ? f.totalEquity() / ta : null,
    } as Record<string, number | null>;
  };
  return {
    activePeriodId: FIXTURE_PERIODS[0].id,
    periods: [
      {
        periodId: FIXTURE_PERIODS[0].id,
        periodLabel: FIXTURE_PERIODS[0].label,
        statements: current,
        metrics: metricsFor(current),
        docId: "doc-served-balanced",
      },
      {
        periodId: FIXTURE_PERIODS[1].id,
        periodLabel: FIXTURE_PERIODS[1].label,
        statements: prior,
        metrics: metricsFor(prior),
        docId: "doc-served-reconciled",
      },
    ],
  };
}

/**
 * AN INDEPENDENT READ OF WHAT A QUESTION WANTS.
 *
 * Deliberately NOT `capsuleTier0.INTERPRETATION_TRIGGERS`. Importing the
 * resolver's own vocabulary to excuse the resolver's own misses is a
 * tautology dressed as a diagnostic — every miss would classify as
 * "correctly refused" by construction. This list is written here, by the
 * gates lane, from the questions themselves.
 *
 * A question wanting a JUDGEMENT (why / should / risk / forecast) is
 * Tier-1 by design and its miss is CORRECT. A question wanting a LOOKUP
 * ("what is EBITDA", "cum stăm cu lichiditatea curentă") that misses is
 * a real coverage gap, and the failure message must say which is which
 * or the speed lane cannot act on it.
 */
const JUDGEMENT_MARKERS: readonly string[] = Object.freeze([
  "why", "de ce", "explain", "explica", "should", "ar trebui",
  "recommend", "recomand", "risk", "risc", "what if", "ce se intampla daca",
  "afford", "permit", "drove", "drove it", "worry", "worth",
  "how are we doing", "cum stam cu totul", "biggest risk", "first fix",
  "unlocks", "what drove",
]);

function wantsJudgement(q: string): boolean {
  const folded = q.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return JUDGEMENT_MARKERS.some((m) => folded.includes(m));
}

const TIER0_COVERAGE_FLOOR = 0.6;
const TIER0_BUDGET_MS = 100;

describe("K3 — Tier-0 coverage: answered without the model, under 100 ms", () => {
  it("≥60% of the 30-question corpus resolves with ZERO model calls", async () => {
    const corpus = tier0Corpus();
    expect(
      corpus.length,
      "the corpus must be 30 questions; fewer means a source stopped yielding",
    ).toBe(30);

    const indexMod = await laneModule("capsuleFactIndex");
    const tier0Mod = await laneModule("capsuleTier0");
    const buildFactIndex = requireExport<(s: unknown) => unknown>(
      indexMod,
      "buildFactIndex",
      "frontend/lib/capsuleFactIndex.ts",
    );
    const resolveTier0 = requireExport<(q: string, i: unknown) => Tier0Answer | null>(
      tier0Mod,
      "resolveTier0",
      "frontend/lib/capsuleTier0.ts",
    );

    const index = buildFactIndex(realSnapshot());

    // Warm the code paths once so the first question is not charged for
    // module init — that would measure the harness, not the surface.
    resolveTier0(corpus[0], index);

    const trap = trapNetwork();
    const rows: { q: string; hit: boolean; ms: number }[] = [];
    try {
      for (const q of corpus) {
        const t0 = performance.now();
        const answer = resolveTier0(q, index);
        const ms = performance.now() - t0;
        rows.push({ q, hit: answer !== null, ms });
      }
    } finally {
      trap.restore();
    }

    expect(
      trap.calls,
      `K3: Tier-0 resolution reached the network — ${trap.calls.join(", ")}. ` +
        `Tier 0 is the tier that costs nothing; a call here is a billed answer ` +
        `to a question the index already held.`,
    ).toEqual([]);

    const hits = rows.filter((r) => r.hit);
    const coverage = hits.length / rows.length;
    const slow = rows.filter((r) => r.hit && r.ms >= TIER0_BUDGET_MS);

    // eslint-disable-next-line no-console
    console.log(
      `[K3] tier-0 coverage ${(coverage * 100).toFixed(1)}% ` +
        `(${hits.length}/${rows.length}) · ` +
        `max ${Math.max(...rows.map((r) => r.ms)).toFixed(2)}ms · ` +
        `refused-by-design ${rows.filter((r) => !r.hit && wantsJudgement(r.q)).length} · ` +
        `real gaps ${rows.filter((r) => !r.hit && !wantsJudgement(r.q)).length}`,
    );

    expect(
      slow.map((r) => `${r.q} = ${r.ms.toFixed(1)}ms`),
      `K3: a Tier-0 answer took ≥${TIER0_BUDGET_MS}ms. Tier 0 exists to be ` +
        `instant; past 100ms the reader has already started waiting.`,
    ).toEqual([]);

    // Split the misses so the number is ACTIONABLE. A gate that reports
    // "22 misses" sends someone to read 22 strings; a gate that reports
    // "9 correct refusals, 13 real gaps, here they are" sends them to
    // the 13.
    const misses = rows.filter((r) => !r.hit);
    const refusedByDesign = misses.filter((r) => wantsJudgement(r.q));
    const realGaps = misses.filter((r) => !wantsJudgement(r.q));

    expect(
      coverage,
      `K3: Tier-0 coverage ${(coverage * 100).toFixed(1)}% ` +
        `(${hits.length}/${rows.length}) is below the ${TIER0_COVERAGE_FLOOR * 100}% floor.\n\n` +
        `  CORRECTLY REFUSED (${refusedByDesign.length}) — these want a judgement, ` +
        `not a lookup; Tier 1 is the right home:\n` +
        refusedByDesign.map((r) => `    · ${r.q}`).join("\n") +
        `\n\n  REAL COVERAGE GAPS (${realGaps.length}) — these name a fact the ` +
        `index either holds or should:\n` +
        realGaps.map((r) => `    · ${r.q}`).join("\n") +
        `\n\n  CROSS-LANE: closing the gaps is the speed lane's call — RO metric ` +
        `vocabulary, account lookup, and the findings/glossary metas are the ` +
        `three clusters above. The floor is not moved to meet the measurement.`,
    ).toBeGreaterThanOrEqual(TIER0_COVERAGE_FLOOR);
  });

  it("every Tier-0 fact carries provenance and a period — a bare number is not an answer", async () => {
    const indexMod = await laneModule("capsuleFactIndex");
    const tier0Mod = await laneModule("capsuleTier0");
    const buildFactIndex = requireExport<(s: unknown) => unknown>(indexMod, "buildFactIndex", "capsuleFactIndex");
    const resolveTier0 = requireExport<(q: string, i: unknown) => Tier0Answer | null>(
      tier0Mod,
      "resolveTier0",
      "capsuleTier0",
    );
    const index = buildFactIndex(realSnapshot());

    const offenders: string[] = [];
    for (const q of tier0Corpus()) {
      const a = resolveTier0(q, index);
      if (!a) continue;
      for (const f of a.facts) {
        if (!f.periodId || !f.periodLabel) offenders.push(`${q} → ${f.factKey} has no period`);
        if (!f.unit) offenders.push(`${q} → ${f.factKey} has no unit`);
        if (typeof f.value !== "number" || Number.isNaN(f.value)) {
          offenders.push(`${q} → ${f.factKey} value is not a number`);
        }
      }
    }
    expect(
      offenders,
      "K3/C3: a Tier-0 fact reached the reader without the things that make " +
        "it checkable. ABSENT is not ZERO and a number with no period is not a fact.",
    ).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════
// K4 — FACT BEFORE PROSE (the ORDERING, not timing luck)
// ══════════════════════════════════════════════════════════════════════
//
// The claim is not "the fact card is usually quicker". It is that the
// pipeline CANNOT emit prose before it has emitted facts. So the test
// records the sequence of states the pipeline pushes and asserts a
// property of the SEQUENCE: the first state carrying any prose already
// carries the evidence. A transport made instant, or made slow, changes
// nothing about whether that holds.

describe("K4 — the fact card is emitted before the first model token", () => {
  it("no pipeline state carries prose before it carries facts", async () => {
    const ctx = {
      periodId: FIXTURE_PERIODS[0].id,
      periodLabel: FIXTURE_PERIODS[0].label,
      periods: FIXTURE_PERIODS.map((p) => ({ id: p.id, label: p.label })),
    };
    const violations: string[] = [];
    const skipped: string[] = [];

    for (const f of ANSWER_FIXTURES) {
      const states: { prose: boolean; facts: number; status: string }[] = [];
      const turn: CapsuleTurn = await runAnswerTurn({
        turnId: `k4-${f.id}`,
        question: f.question,
        history: [],
        plan: planRetrieval(f.question, ctx),
        toolTransport: fixtureToolTransport(0),
        // Generation yields IMMEDIATELY and in one chunk — the most
        // hostile ordering for this gate. If facts still land first
        // under a zero-latency model, the ordering is structural.
        generate: fixtureGenerationTransport(f.answer, { chunks: 1, firstTokenMs: 0 }),
        language: "en",
        onUpdate: (t) =>
          states.push({
            prose: t.streaming.length > 0 || t.blocks.length > 0,
            facts: Object.keys(t.evidence.factMeta).length,
            status: t.status,
          }),
      });
      expect(turn.status).toBe("done");

      const finalFacts = Object.keys(turn.evidence.factMeta).length;

      // A HELP ANSWER HAS NO FIGURES, and demanding a fact card for one
      // would invent a figure — the exact defect C1 exists to stop.
      // ABSENT is not ZERO applies to the gate as much as to the
      // product: a turn that legitimately ends with no facts is outside
      // this law, not a violation of it. (Found on the first run: the
      // `help` fixture reached "generating" with 0 facts, correctly.)
      if (finalFacts === 0) {
        skipped.push(f.id);
        continue;
      }

      const firstProse = states.findIndex((st) => st.prose);
      if (firstProse === -1) continue; // deterministic path: no prose at all

      if (states[firstProse].facts === 0) {
        violations.push(
          `${f.id}: prose appeared at state ${firstProse} (status ${states[firstProse].status}) ` +
            `with 0 facts in hand, and the finished turn carries ${finalFacts}`,
        );
        continue;
      }
      // The STRONGER half: the card must be WHOLE before the prose
      // starts, not merely non-empty. A card that grows underneath the
      // running text is a card the reader has to re-read.
      if (states[firstProse].facts !== finalFacts) {
        violations.push(
          `${f.id}: prose started with ${states[firstProse].facts} of ${finalFacts} facts ` +
            `on screen — the fact card was still filling in underneath the text`,
        );
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      `[K4] ${ANSWER_FIXTURES.length - skipped.length} of ${ANSWER_FIXTURES.length} fixtures ` +
        `carry facts and were ordering-checked · no-fact answers (outside the law): ` +
        `${skipped.join(", ") || "none"}`,
    );

    expect(
      violations,
      "K4: the reader saw words before they saw a checkable figure. The fact " +
        "card is the answer; the prose is the gloss on it.",
    ).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════
// K5 — LATENCY, MEASURED AND REGRESSION-GATED
// ══════════════════════════════════════════════════════════════════════
//
// `design_review/capsule/LATENCY.md` carries a machine-readable block.
// This gate parses it and compares TODAY against the recorded baseline.
// The baseline is a ceiling, not a target: a number that drifts up
// silently is how "answers feel slow" happened the first time.

interface Baseline {
  key: string;
  p50: number;
  p95: number;
}

function readLatencyBaseline(): Baseline[] {
  const path = resolve(REPO_ROOT, "design_review/capsule/LATENCY.md");
  let src: string;
  try {
    src = readFileSync(path, "utf-8");
  } catch {
    throw new Error(
      "K5: design_review/capsule/LATENCY.md is missing. The regression gate " +
        "has no baseline to compare against, so it cannot pass.",
    );
  }
  const block = /```latency-baseline\n([\s\S]*?)```/.exec(src);
  if (!block) {
    throw new Error(
      "K5: LATENCY.md carries no ```latency-baseline``` block. The published " +
        "table must be machine-readable or it is decoration.",
    );
  }
  const rows: Baseline[] = [];
  for (const line of block[1].split("\n")) {
    const m = /^\s*([a-z0-9_.-]+)\s+([\d.]+)\s+([\d.]+)\s*$/i.exec(line);
    if (m) rows.push({ key: m[1], p50: Number(m[2]), p95: Number(m[3]) });
  }
  if (rows.length === 0) throw new Error("K5: the latency-baseline block parsed to zero rows.");
  return rows;
}

function pct(values: number[], q: number): number {
  const s = [...values].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return s[i];
}

describe("K5 — latency is measured, published, and gated against its baseline", () => {
  it("the published baseline is machine-readable", () => {
    const rows = readLatencyBaseline();
    expect(rows.map((r) => r.key)).toContain("pipeline_overhead_ms");
  });

  it("the latency module records marks and reports a snapshot", async () => {
    const mod = await laneModule("capsuleLatency");
    const mark = requireExport<(n: string) => void>(mod, "mark", "capsuleLatency");
    const measure = requireExport<(n: string, f: string) => number>(mod, "measure", "capsuleLatency");
    const snapshotLatency = requireExport<() => Record<string, number[]>>(
      mod,
      "snapshotLatency",
      "capsuleLatency",
    );
    mark("k5:start");
    mark("k5:end");
    const ms = measure("k5:span", "k5:start");
    expect(typeof ms).toBe("number");
    expect(ms).toBeGreaterThanOrEqual(0);
    const snap = snapshotLatency();
    expect(
      Object.keys(snap).length,
      "K5: snapshotLatency() returned nothing after two marks and a measure — " +
        "the instrument that is supposed to make speed observable is not recording.",
    ).toBeGreaterThan(0);
  });

  it("pipeline overhead has not regressed past the recorded baseline", async () => {
    const ctx = {
      periodId: FIXTURE_PERIODS[0].id,
      periodLabel: FIXTURE_PERIODS[0].label,
      periods: FIXTURE_PERIODS.map((p) => ({ id: p.id, label: p.label })),
    };
    const overhead: number[] = [];
    for (const f of ANSWER_FIXTURES) {
      const t0 = performance.now();
      const turn = await runAnswerTurn({
        turnId: `k5-${f.id}`,
        question: f.question,
        history: [],
        plan: planRetrieval(f.question, ctx),
        toolTransport: fixtureToolTransport(0),
        generate: fixtureGenerationTransport(f.answer, { chunks: 1, firstTokenMs: 0 }),
        language: "en",
      });
      expect(turn.status).toBe("done");
      overhead.push(performance.now() - t0);
    }
    const measured = { p50: pct(overhead, 0.5), p95: pct(overhead, 0.95) };
    // eslint-disable-next-line no-console
    console.log(
      `[K5] pipeline overhead p50 ${measured.p50.toFixed(2)}ms · p95 ${measured.p95.toFixed(2)}ms ` +
        `(n=${overhead.length}, zero-cost transports — this is OUR cost, not the model's)`,
    );

    const base = readLatencyBaseline().find((r) => r.key === "pipeline_overhead_ms");
    expect(base, "K5: no `pipeline_overhead_ms` row in the baseline block").toBeTruthy();
    // A generous multiplier: this runs on whatever CI hands us, and a
    // gate that fails on a noisy neighbour teaches people to ignore it.
    // 3× still catches an order-of-magnitude regression, which is the
    // class that actually reaches a user.
    expect(
      measured.p95,
      `K5: pipeline overhead p95 ${measured.p95.toFixed(2)}ms is more than 3× the ` +
        `recorded baseline ${base!.p95}ms. Something in the retrieval/merge/guard ` +
        `path got materially slower.`,
    ).toBeLessThan(Math.max(base!.p95 * 3, 30));
  });
});

// ══════════════════════════════════════════════════════════════════════
// K9 — the existing invariants, re-proven on the new surface
// ══════════════════════════════════════════════════════════════════════

describe("K9 — the router still costs nothing, and ASK-FIRST did not change that", () => {
  it("every fixture: correctly laned, and p95 under the 5 ms budget", () => {
    const timings: number[] = [];
    const wrong: string[] = [];
    for (const f of CAPSULE_ROUTER_FIXTURES) {
      const t0 = performance.now();
      const result = routeQuery(f.query, FIXTURE_CONTEXT);
      timings.push(performance.now() - t0);
      if (result.classification.lane !== f.lane) {
        wrong.push(
          `${JSON.stringify(f.query)} → ${result.classification.lane}, expected ${f.lane} ` +
            `(${f.note})`,
        );
      }
    }
    // eslint-disable-next-line no-console
    console.log(
      `[K9] router p50 ${pct(timings, 0.5).toFixed(3)}ms · p95 ${pct(timings, 0.95).toFixed(3)}ms ` +
        `· max ${Math.max(...timings).toFixed(3)}ms over ${timings.length} fixtures`,
    );
    expect(wrong, "K9: the router mislaned a fixture").toEqual([]);
    expect(
      pct(timings, 0.95),
      "K9: router p95 exceeded the 5 ms budget — the router is what makes " +
        "typing feel free.",
    ).toBeLessThan(5);
  });

  // ── THE NEW TENSION THIS WAVE CREATES ──────────────────────────────
  //
  // K1 promotes ASK to the DEFAULT ENTER ACTION. That is precisely the
  // change most likely to break C4: if "answer on Enter" is implemented
  // by making the Ask row the default selection, then typing "dashboard"
  // and pressing Enter starts billing Anthropic for a navigation.
  //
  // So the law is stated as a CONJUNCTION, and both halves are asserted
  // over every prefix, because typing is prefixes:
  //
  //     ask query      → Enter costs a model call   (the feature)
  //     nav/entity/act → Enter costs nothing        (the invariant)
  it("Enter answers an ASK query and still navigates a NAV query, free", () => {
    const trap = trapNetwork();
    const billedNavigation: string[] = [];
    const freeAsk: string[] = [];
    try {
      for (const f of CAPSULE_ROUTER_FIXTURES) {
        if (f.lane === "ask") {
          const r = routeQuery(f.query, FIXTURE_CONTEXT);
          // One keystroke at most — Tab reaches Ask (INV-1).
          if (!r.askInOneKeystroke || r.askIndex > 1) {
            freeAsk.push(`${JSON.stringify(f.query)} askIndex=${r.askIndex}`);
          }
          continue;
        }
        for (let n = 1; n <= f.query.length; n += 1) {
          const prefix = f.query.slice(0, n);
          const r = routeQuery(prefix, FIXTURE_CONTEXT);
          // THE `noResults` CARVE-OUT, adopted deliberately from the
          // router lane's own law (`capsuleGates.test.ts` → "Enter on a
          // navigation, entity or action query costs nothing"): at "d"
          // nothing has matched yet, Ask is the only row on offer, and
          // offering is not spending. This gate is about a real match
          // being SHADOWED by Ask, not about an empty list.
          //
          // ASK-FIRST does move where the remaining risk lives, and this
          // is the note the next reader needs: once Enter's DEFAULT
          // action is the answer, a one-character query plus Enter is a
          // billed turn. That is a property of the live input, not of
          // the router, so it is asserted where it is true —
          // `capsule.spec.ts` §K9 counts real requests while typing a
          // destination through the real surface.
          if (r.noResults) continue;
          if (willCallModel(r, r.defaultIndex)) {
            billedNavigation.push(
              `${JSON.stringify(prefix)} (typing ${JSON.stringify(f.query)}, lane ${f.lane})`,
            );
          }
        }
      }
    } finally {
      trap.restore();
    }
    expect(trap.calls, `K9: routing touched the network — ${trap.calls.join(", ")}`).toEqual([]);
    expect(
      freeAsk,
      "K9: an ask query does not put the Ask row within one keystroke — the " +
        "ASK-FIRST promise is not reachable from the keyboard.",
    ).toEqual([]);
    expect(
      billedNavigation.slice(0, 12),
      "K9: a navigation/entity/action prefix would spend a model call on Enter. " +
        "Anthropic credits are live; this is a bug with an invoice attached.",
    ).toEqual([]);
  });
});
