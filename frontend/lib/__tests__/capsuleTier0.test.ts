// THE CAPSULE — TIER-0 GATE (A1).
//
// The coverage fixture set is asserted line by line, and the resulting
// coverage is MEASURED and printed rather than asserted against the
// target. A gate that says `expect(coverage).toBeGreaterThan(0.6)` stops
// telling you anything the moment it passes; this one prints the number
// every run, so a regression from 73% to 62% is visible instead of
// merely still-green.
//
// The workspace under test is the same two REAL served periods the fact
// index suite uses (`fixtures/capsuleTier0/`, captured from the golden
// corpus through the real `/api/period` composition).

import { describe, it, expect, beforeEach } from "vitest";

import {
  resolveTier0,
  claimMetric,
  metricsNamedIn,
  stripOpeners,
  namedPeriodTokens,
  speculativeTerms,
  createSpeculativeResolver,
  prewarmCapsule,
  INTERPRETATION_TRIGGERS,
  TIER0_NOTE_KEYS,
  NOTE_ABSENT,
  NOTE_SINGLE_PERIOD,
  NOTE_NO_BASELINE,
  NOTE_CURRENCY_MISMATCH,
  NOTE_ENTITY_MISMATCH,
  NOTE_UNLABELLED_PERIOD,
  NOTE_BALANCED,
  NOTE_NOT_BALANCED,
  NOTE_DEFINITION,
  NOTE_FINDINGS,
  NOTE_IMBALANCE,
  NOTE_NO_BREAKDOWN,
} from "@/lib/capsuleTier0";
import {
  buildFactIndex,
  factFor,
  type CapsuleFactSnapshot,
  type FactIndex,
} from "@/lib/capsuleFactIndex";
import {
  CAPSULE_TIER0_FIXTURES,
  TIER0_ANSWERED,
  TIER0_HANDLED,
  TIER0_COVERAGE_TARGET,
} from "@/lib/capsuleTier0Fixtures";
import { resetLatency, snapshotLatency, LAT_SPECULATIVE, hasMark, LAT_CAPSULE_OPEN }
  from "@/lib/capsuleLatency";
import { foldQuery } from "@/lib/capsuleRouter";
import { GLOSSARY } from "@/lib/glossary";
import type { Statements } from "@/lib/financialReport";

import carniprodJson from "./fixtures/capsuleTier0/period_carniprod_fy2025.json";
import retailJson from "./fixtures/capsuleTier0/period_retail_fy2024.json";
import driftJson from "./fixtures/capsuleTier0/period_minor_drift.json";

const carniprod = carniprodJson as unknown as Statements;
const retail = retailJson as unknown as Statements;
const drift = driftJson as unknown as Statements;

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** The fixture workspace: two real periods of one company. Both blobs
 *  are real engine output; the workspace framing (one entity, two
 *  labelled periods) is what a two-upload workspace actually is. */
function snapshot(): CapsuleFactSnapshot {
  return {
    activePeriodId: "p-2025",
    periods: [
      { periodId: "p-2025", periodLabel: "FY 2025", statements: carniprod, docId: "d1" },
      { periodId: "p-2024", periodLabel: "FY 2024", statements: retail, docId: "d2" },
    ],
  };
}

const index: FactIndex = buildFactIndex(snapshot());
const singlePeriod: FactIndex = buildFactIndex({
  periods: [{ periodId: "p-2025", periodLabel: "FY 2025", statements: carniprod }],
});

// ══════════════════════════════════════════════════════════════════════
// The fixture gate + the measured coverage
// ══════════════════════════════════════════════════════════════════════

describe("Tier-0 coverage fixtures", () => {
  it("has thirty-four questions across the three honest sources", () => {
    expect(CAPSULE_TIER0_FIXTURES).toHaveLength(34);
    const bySource = CAPSULE_TIER0_FIXTURES.reduce<Record<string, number>>((acc, f) => {
      acc[f.source] = (acc[f.source] ?? 0) + 1;
      return acc;
    }, {});
    // The production log really is this thin — three distinct strings.
    expect(bySource.production_log).toBe(3);
    expect(bySource.router_fixture).toBeGreaterThanOrEqual(10);
  });

  for (const fixture of CAPSULE_TIER0_FIXTURES) {
    it(`[${fixture.source}] ${fixture.query}`, () => {
      const answer = resolveTier0(fixture.query, index);
      if (fixture.expect === null) {
        expect(answer, fixture.note).toBeNull();
        return;
      }
      expect(answer, fixture.note).not.toBeNull();
      expect(answer!.kind, fixture.note).toBe(fixture.expect);
      if (fixture.refused) {
        expect(answer!.refused, fixture.note).toBe(true);
        expect(answer!.facts, fixture.note).toEqual([]);
        expect(TIER0_NOTE_KEYS, fixture.note).toContain(answer!.note);
      } else {
        expect(answer!.refused).toBeFalsy();
      }
      if (fixture.factKey) {
        expect(answer!.factKeys?.[0], fixture.note).toBe(fixture.factKey);
        expect(answer!.facts[0].factKey, fixture.note).toBe(fixture.factKey);
      }
    });
  }

  it("MEASURED coverage — reported, not asserted against the target", () => {
    let answered = 0;
    let handled = 0;
    const missed: string[] = [];
    for (const fixture of CAPSULE_TIER0_FIXTURES) {
      const answer = resolveTier0(fixture.query, index);
      if (answer === null) {
        missed.push(fixture.query);
        continue;
      }
      handled += 1;
      if (!answer.refused) answered += 1;
    }
    const n = CAPSULE_TIER0_FIXTURES.length;
    const report = [
      "",
      `── TIER-0 COVERAGE (measured over ${n} real-shaped questions) ──`,
      `  answered with facts, zero model calls : ${answered}/${n}` +
        ` = ${((answered / n) * 100).toFixed(1)}%`,
      `  handled (answer OR honest refusal)    : ${handled}/${n}` +
        ` = ${((handled / n) * 100).toFixed(1)}%`,
      `  routed to the model (correctly)       : ${n - handled}/${n}`,
      `  brief's target                        : ${(TIER0_COVERAGE_TARGET * 100).toFixed(0)}%`,
      "",
    ].join("\n");
    // eslint-disable-next-line no-console
    console.log(report);

    // The fixture file and the resolver must agree about which lines are
    // Tier-0 — that is the real assertion. The percentage is evidence.
    expect(answered).toBe(TIER0_ANSWERED.length);
    expect(handled).toBe(TIER0_HANDLED.length);
  });
});

// ══════════════════════════════════════════════════════════════════════
// The three refusals to claim
// ══════════════════════════════════════════════════════════════════════

describe("T1 — an interpretation request is never a lookup", () => {
  it("declines every trigger even when the metric is known", () => {
    for (const trigger of INTERPRETATION_TRIGGERS) {
      const q = `${trigger} total assets`;
      expect(resolveTier0(q, index), q).toBeNull();
    }
  });

  it("still answers the same metric asked plainly", () => {
    expect(resolveTier0("total assets", index)!.kind).toBe("fact");
  });
});

describe("T2 — leftover meaning disqualifies a match", () => {
  it.each([
    "cash conversion cycle",
    "revenue per employee",
    "total assets excluding intangibles",
    "cash held at BCR",
  ])("does not claim %s", (q) => {
    expect(resolveTier0(q, index)).toBeNull();
  });

  it("claims the same metric once the leftovers are filler", () => {
    expect(claimMetric(foldQuery("how much cash do we have"), index)).toBe("cash");
    expect(claimMetric(foldQuery("what is our total assets"), index)).toBe("total_assets");
    expect(claimMetric(foldQuery("care este cifra de afaceri"), index)).toBe("revenue");
  });

  it("prefers the longer covering term", () => {
    expect(claimMetric(foldQuery("current ratio"), index)).toBe("current_ratio");
    expect(claimMetric(foldQuery("current assets"), index)).toBe("current_assets");
  });
});

describe("T3 — honest refusals, never a fabricated number", () => {
  it("refuses a known metric the period does not carry", () => {
    const bsOnly = clone(carniprod) as unknown as Record<string, unknown>;
    delete bsOnly.assembled_canonical_v1;
    delete bsOnly.assembled_pl;
    const bsIndex = buildFactIndex({
      periods: [{
        periodId: "p", periodLabel: "FY 2025",
        statements: bsOnly as unknown as Statements,
      }],
    });
    const answer = resolveTier0("revenue", bsIndex)!;
    expect(answer.refused).toBe(true);
    expect(answer.note).toBe(NOTE_ABSENT);
    expect(answer.facts).toEqual([]);
    // The refusal never carries the figure it does not have.
    expect(JSON.stringify(answer)).not.toMatch(/\d{4,}/);
  });

  it("refuses a compare when only one period is loaded", () => {
    const answer = resolveTier0("what changed vs last month", singlePeriod)!;
    expect(answer.refused).toBe(true);
    expect(answer.note).toBe(NOTE_SINGLE_PERIOD);
  });

  it("refuses when the question names a period the workspace does not hold", () => {
    const answer = resolveTier0("compare December and November revenue", index)!;
    expect(answer.refused).toBe(true);
    expect(answer.note).toBe(NOTE_NO_BASELINE);
    expect(answer.noteParams?.asked).toContain("december");
  });

  it("refuses a compare across two currencies", () => {
    const eur = clone(carniprod) as unknown as Statements;
    eur.currency = "EUR";
    const mixed = buildFactIndex({
      activePeriodId: "p-a",
      periods: [
        { periodId: "p-a", periodLabel: "FY 2025", statements: carniprod },
        { periodId: "p-b", periodLabel: "FY 2024", statements: eur },
      ],
    });
    const answer = resolveTier0("revenue vs last year", mixed)!;
    expect(answer.refused).toBe(true);
    expect(answer.note).toBe(NOTE_CURRENCY_MISMATCH);
  });

  it("refuses a compare across two entities", () => {
    const other = clone(carniprod) as unknown as Statements;
    other.companyName = "A Different SRL";
    const mixed = buildFactIndex({
      activePeriodId: "p-a",
      periods: [
        { periodId: "p-a", periodLabel: "FY 2025", statements: carniprod },
        { periodId: "p-b", periodLabel: "FY 2024", statements: other },
      ],
    });
    const answer = resolveTier0("revenue vs last year", mixed)!;
    expect(answer.refused).toBe(true);
    expect(answer.note).toBe(NOTE_ENTITY_MISMATCH);
  });

  it("refuses a compare against an unlabelled period", () => {
    const unlabelled = buildFactIndex({
      activePeriodId: "p-a",
      periods: [
        { periodId: "p-a", periodLabel: "FY 2025", statements: carniprod },
        { periodId: "p-b", periodLabel: "", statements: retail },
      ],
    });
    const answer = resolveTier0("revenue vs last year", unlabelled)!;
    expect(answer.refused).toBe(true);
    expect(answer.note).toBe(NOTE_UNLABELLED_PERIOD);
  });
});

// ══════════════════════════════════════════════════════════════════════
// The three shapes
// ══════════════════════════════════════════════════════════════════════

describe("FACT", () => {
  it("answers with the served fact, its unit and its provenance", () => {
    const answer = resolveTier0("total assets", index)!;
    expect(answer.kind).toBe("fact");
    expect(answer.facts).toHaveLength(1);
    const fact = answer.facts[0];
    expect(fact.factKey).toBe("total_assets");
    expect(fact.unit).toBe("money");
    expect(fact.currency).toBe("RON");
    expect(fact.periodId).toBe("p-2025");
    expect(fact.value).toBe(factFor(index, "total_assets")!.value);
  });

  it("answers about the ACTIVE period, not the first one indexed", () => {
    const activeIs2024 = buildFactIndex({
      activePeriodId: "p-2024",
      periods: snapshot().periods,
    });
    expect(resolveTier0("revenue", activeIs2024)!.facts[0].periodId).toBe("p-2024");
  });

  it("answers a dimensionless metric without a currency", () => {
    const answer = resolveTier0("current ratio", index)!;
    expect(answer.facts[0].unit).toBe("ratio");
    expect(answer.facts[0].currency).toBeUndefined();
  });
});

describe("META", () => {
  it("reports the engine's status for is-it-balanced", () => {
    const answer = resolveTier0("is it balanced", index)!;
    expect(answer.kind).toBe("meta");
    expect(answer.note).toBe(NOTE_BALANCED);
    expect(answer.noteParams?.status).toBe("BALANCED");
    expect(answer.facts[0].factKey).toBe("difference");
  });

  it("says NOT balanced on the drift period, and shows the real drift", () => {
    const driftIndex = buildFactIndex({
      periods: [{ periodId: "p-d", periodLabel: "FY 2025", statements: drift }],
    });
    const answer = resolveTier0("is it balanced", driftIndex)!;
    expect(answer.note).toBe(NOTE_NOT_BALANCED);
    expect(answer.noteParams?.status).toBe("MINOR_DRIFT");
    expect(answer.facts[0].value).toBe(drift.canonical_bs!.difference);
  });

  it("counts periods", () => {
    const answer = resolveTier0("how many periods", index)!;
    expect(answer.facts[0].value).toBe(2);
    expect(answer.facts[0].unit).toBe("count");
  });

  it("names the active period and currency without a figure", () => {
    const period = resolveTier0("what period is this", index)!;
    expect(period.noteParams?.period).toBe("FY 2025");
    expect(period.facts).toEqual([]);
    const currency = resolveTier0("what currency", index)!;
    expect(currency.noteParams?.currency).toBe("RON");
  });
});

describe("COMPARE", () => {
  it("computes a single-metric delta on native operands", () => {
    const answer = resolveTier0("revenue vs FY 2024", index)!;
    expect(answer.kind).toBe("compare");
    expect(answer.deltas).toHaveLength(1);
    const delta = answer.deltas![0];
    expect(delta.factKey).toBe("revenue");
    expect(delta.from.periodId).toBe("p-2024");
    expect(delta.to.periodId).toBe("p-2025");
    expect(delta.delta).toBe(delta.to.value - delta.from.value);
    expect(answer.deltaPct).toBeCloseTo(
      ((delta.to.value - delta.from.value) / Math.abs(delta.from.value)) * 100, 10,
    );
    // Facts read from → to, so a renderer never has to guess direction.
    expect(answer.facts.map((f) => f.periodId)).toEqual(["p-2024", "p-2025"]);
  });

  it("falls back to the headline metric set when none is named", () => {
    const answer = resolveTier0("what changed vs last month", index)!;
    expect(answer.kind).toBe("compare");
    expect(answer.deltas!.length).toBeGreaterThan(2);
    expect(answer.factKeys).toContain("revenue");
    expect(answer.factKeys).toContain("total_assets");
    // deltaPct is singular by contract — absent when several moved.
    expect(answer.deltaPct).toBeUndefined();
  });

  it("never subtracts across units", () => {
    const answer = resolveTier0("what changed vs last month", index)!;
    for (const delta of answer.deltas!) {
      expect(delta.from.unit).toBe(delta.to.unit);
      if (delta.from.unit === "money") {
        expect(delta.from.currency).toBe(delta.to.currency);
      }
    }
  });

  it("leaves deltaPct undefined when the baseline is zero", () => {
    const zeroed = clone(retail) as unknown as Statements;
    (zeroed.assembled_canonical_v1 as unknown as {
      methodology: { totals: Record<string, number> };
    }).methodology.totals.revenue_net = 0;
    const zeroIndex = buildFactIndex({
      activePeriodId: "p-a",
      periods: [
        { periodId: "p-a", periodLabel: "FY 2025", statements: carniprod },
        { periodId: "p-b", periodLabel: "FY 2024", statements: zeroed },
      ],
    });
    const answer = resolveTier0("revenue vs FY 2024", zeroIndex)!;
    expect(answer.deltas![0].from.value).toBe(0);
    expect(answer.deltas![0].deltaPct).toBeUndefined();
    expect(answer.deltaPct).toBeUndefined();
  });
});

describe("DEFINE — the glossary is a lookup, not a model call", () => {
  it("answers a definition from the shipped glossary, in both languages", () => {
    for (const q of ["what does EBITDA mean", "ce înseamnă EBITDA",
                     "define working capital"]) {
      const answer = resolveTier0(q, index)!;
      expect(answer, q).not.toBeNull();
      expect(answer.note, q).toBe(NOTE_DEFINITION);
      expect(answer.facts, q).toEqual([]);   // a definition carries no figure
      expect(GLOSSARY[answer.noteParams!.glossaryId], q).toBeTruthy();
    }
    expect(resolveTier0("ce înseamnă datorie netă", index)!.noteParams!.glossaryId)
      .toBe("net_debt");
  });

  it("maps a metric name onto its glossary entry under a different id", () => {
    expect(resolveTier0("what does net profit mean", index)!.noteParams!.glossaryId)
      .toBe("net_profit");
  });

  it("does not claim a long question that merely contains 'mean'", () => {
    // The real production-log question. It says "mean" and it names a
    // metric, but it is asking for industry context, not a definition.
    expect(resolveTier0(
      "Tell me more about Operating Revenue (413.73M RON) for my company. "
      + "What does this value mean in context, what's typical for my industry?",
      index,
    )).toBeNull();
  });

  it("leaves 'explain the 461 balance' to the model", () => {
    // "explain" is deliberately NOT a definition trigger: that question
    // wants THIS company's 461, not the dictionary entry.
    expect(resolveTier0("explain the 461 balance", index)).toBeNull();
  });

  it("returns null for a term the glossary does not carry", () => {
    expect(resolveTier0("what does goodwill mean", index)).toBeNull();
  });
});

describe("ACCOUNT — a code is a question", () => {
  it("answers with every served line that code sits on", () => {
    const answer = resolveTier0("what is sitting in account 461", index)!;
    expect(answer.kind).toBe("fact");
    expect(answer.facts.length).toBeGreaterThan(0);
    for (const fact of answer.facts) {
      expect(fact.periodId).toBe("p-2025");
      expect((fact.accountCodes ?? []).join(",")).toContain("461");
    }
  });

  it("accepts the Romanian prefix and the bare code", () => {
    expect(resolveTier0("cont 461", index)!.kind).toBe("fact");
    expect(resolveTier0("461", index)!.kind).toBe("fact");
  });

  it("refuses a well-formed code the period does not carry", () => {
    const answer = resolveTier0("account 999", index)!;
    expect(answer.refused).toBe(true);
    expect(answer.note).toBe(NOTE_ABSENT);
    expect(answer.noteParams?.account).toBe("999");
  });

  it("does not read a year inside a sentence as an account code", () => {
    // Unanchored, "2025" here would become account 2025.
    const answer = resolveTier0("Dec 2025 — where does the imbalance sit?", index)!;
    expect(answer.note).toBe(NOTE_IMBALANCE);
    expect(answer.factKeys).toEqual(["difference"]);
  });
});

describe("META — imbalance, findings, breakdown", () => {
  it("answers where the imbalance sits with the engine's diagnosis codes", () => {
    const driftIndex = buildFactIndex({
      periods: [{ periodId: "p-d", periodLabel: "FY 2025", statements: drift }],
    });
    const answer = resolveTier0("where does the imbalance sit", driftIndex)!;
    expect(answer.note).toBe(NOTE_IMBALANCE);
    expect(answer.noteParams?.status).toBe("MINOR_DRIFT");
    expect(answer.facts[0].factKey).toBe("difference");
    // Codes only — a diagnosis `detail` string carries figures.
    expect(answer.noteParams?.diagnosis ?? "").not.toMatch(/\d{4,}/);
  });

  it("counts findings when the caller loaded them", () => {
    const withFindings = buildFactIndex({
      periods: [{
        periodId: "p", periodLabel: "FY 2025", statements: carniprod,
        findings: [
          { key: "f1", ruleKey: "liquidity_cash_tight", factsCited: {}, factUnits: {} },
          { key: "f2", ruleKey: "fx_exposure", factsCited: {}, factUnits: {} },
        ],
      }],
    });
    const answer = resolveTier0("what findings fired this month", withFindings)!;
    expect(answer.note).toBe(NOTE_FINDINGS);
    expect(answer.facts[0].value).toBe(2);
    expect(answer.facts[0].unit).toBe("count");
  });

  it("refuses rather than reporting zero when findings were never loaded", () => {
    const answer = resolveTier0("what findings fired this month", index)!;
    expect(answer.refused).toBe(true);
    expect(answer.note).toBe(NOTE_ABSENT);
    // "none loaded" must never render as "none fired".
    expect(answer.facts).toEqual([]);
  });

  it("refuses a per-counterparty split and names what IS held", () => {
    for (const [q, concept] of [
      ["cine sunt cei mai mari clienți", "customers"],
      ["who are our biggest suppliers", "suppliers"],
      ["revenue by product", "products"],
    ] as const) {
      const answer = resolveTier0(q, index)!;
      expect(answer.refused, q).toBe(true);
      expect(answer.note, q).toBe(NOTE_NO_BREAKDOWN);
      expect(answer.noteParams?.concept, q).toBe(concept);
      expect(answer.noteParams?.held, q).toBeTruthy();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// Speculative retrieval — the Tier-1 hook
// ══════════════════════════════════════════════════════════════════════

describe("speculative resolver", () => {
  beforeEach(() => resetLatency());

  function fakeScheduler() {
    let queued: (() => void) | null = null;
    return {
      set: (fn: () => void) => { queued = fn; return 1; },
      clear: () => { queued = null; },
      run: () => { const fn = queued; queued = null; if (fn) fn(); },
      pending: () => queued !== null,
    };
  }

  it("fires once per settle, not once per keystroke", () => {
    const scheduler = fakeScheduler();
    const seen: string[] = [];
    const resolver = createSpeculativeResolver({
      index, scheduler, onResolve: (r) => seen.push(r.query),
    });
    for (const q of ["t", "to", "tot", "tota", "total", "total a", "total assets"]) {
      resolver.input(q);
    }
    expect(seen).toEqual([]);
    scheduler.run();
    expect(seen).toEqual(["total assets"]);
    expect(resolver.latest()!.facts.length).toBeGreaterThan(0);
    expect(resolver.latest()!.tier0!.kind).toBe("fact");
  });

  it("flush resolves immediately and cancels the pending timer", () => {
    const scheduler = fakeScheduler();
    const resolver = createSpeculativeResolver({ index, scheduler });
    resolver.input("total assets");
    expect(scheduler.pending()).toBe(true);
    const result = resolver.flush()!;
    expect(scheduler.pending()).toBe(false);
    expect(result.tier0!.facts[0].factKey).toBe("total_assets");
  });

  it("pre-resolves facts from a partial query", () => {
    expect(speculativeTerms("total ass", index)).toContain("total_assets");
    expect(speculativeTerms("cifra de af", index)).toContain("revenue");
    expect(speculativeTerms("", index)).toEqual([]);
  });

  it("records its own latency", () => {
    const scheduler = fakeScheduler();
    const resolver = createSpeculativeResolver({ index, scheduler });
    resolver.flush("total assets");
    expect(snapshotLatency()[LAT_SPECULATIVE]).toHaveLength(1);
  });
});

describe("prewarm", () => {
  beforeEach(() => resetLatency());

  it("stamps the latency origin and returns standing facts, not prose", () => {
    const facts = prewarmCapsule(index);
    expect(hasMark(LAT_CAPSULE_OPEN)).toBe(true);
    expect(facts.length).toBeGreaterThan(5);
    for (const fact of facts) expect(typeof fact.value).toBe("number");
  });
});

// ══════════════════════════════════════════════════════════════════════
// Small pure helpers
// ══════════════════════════════════════════════════════════════════════

describe("helpers", () => {
  it("strips openers and edge filler in both languages", () => {
    expect(stripOpeners(foldQuery("What is the total assets?"))).toBe("total assets");
    expect(stripOpeners(foldQuery("Care este cifra de afaceri"))).toBe("cifra de afaceri");
    expect(stripOpeners(foldQuery("how much cash do we have"))).toBe("cash");
  });

  it("detects named periods but not the words 'may' / 'mai'", () => {
    expect(namedPeriodTokens(foldQuery("vs December 2024")))
      .toEqual(["december", "2024"]);
    expect(namedPeriodTokens(foldQuery("cel mai mare vs may be"))).toEqual([]);
  });

  it("metricsNamedIn tolerates the leftovers a compare always has", () => {
    expect(metricsNamedIn(foldQuery("revenue vs FY 2024"), index)).toContain("revenue");
  });

  it("returns null on an empty index or an empty query", () => {
    expect(resolveTier0("total assets", buildFactIndex({ periods: [] }))).toBeNull();
    expect(resolveTier0("", index)).toBeNull();
    expect(resolveTier0("   ", index)).toBeNull();
  });
});
