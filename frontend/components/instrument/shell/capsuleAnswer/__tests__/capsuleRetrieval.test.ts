// RETRIEVAL BEFORE GENERATION — the plan, and the merge that keeps two
// periods of the same metric from collapsing into one binding.

import { describe, expect, it } from "vitest";

import {
  MAX_STEPS,
  matchAccounts,
  matchScenario,
  mergeEvidence,
  planRetrieval,
  runPlan,
  type CapsulePlanStep,
} from "../capsuleRetrieval";
import {
  ANSWER_FIXTURES,
  FIXTURE_PERIODS,
  deadToolTransport,
  fixtureMoney,
  fixturePayload,
  fixtureToolTransport,
} from "../capsuleAnswerFixtures";
import type { CapsuleToolPayload } from "../capsuleAnswerTypes";

const CTX = {
  periodId: FIXTURE_PERIODS[0].id,
  periodLabel: FIXTURE_PERIODS[0].label,
  periods: FIXTURE_PERIODS.map((p) => ({ id: p.id, label: p.label })),
};

describe("planRetrieval — the twelve fixtures", () => {
  it.each(ANSWER_FIXTURES.map((f) => [f.id, f.question, f.tools] as const))(
    "%s reaches for the right tools",
    (_id, question, tools) => {
      const plan = planRetrieval(question, CTX);
      const planned = new Set(plan.map((s) => s.tool));
      for (const tool of tools) expect(planned).toContain(tool);
    },
  );

  it("never exceeds the step cap", () => {
    for (const f of ANSWER_FIXTURES) {
      expect(planRetrieval(f.question, CTX).length).toBeLessThanOrEqual(MAX_STEPS);
    }
  });

  it("gives every step a trace key and stable id", () => {
    const plan = planRetrieval("how are we doing overall", CTX);
    expect(plan.length).toBeGreaterThan(0);
    for (const step of plan) {
      expect(step.traceKey.startsWith("capsuleAnswer.trace.")).toBe(true);
      expect(step.id).toMatch(/^[a-z_]+:\d+$/);
    }
  });

  it("is deterministic — same question, same plan", () => {
    const a = planRetrieval("how did revenue change vs last month", CTX);
    const b = planRetrieval("how did revenue change vs last month", CTX);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("planRetrieval — restraint", () => {
  it("plans nothing for a bare navigation phrase", () => {
    // Navigation must never cost a read, let alone a model call.
    expect(planRetrieval("dashboard", CTX)).toEqual([]);
    expect(planRetrieval("scenarios", CTX)).toEqual([]);
  });

  it("plans nothing for an unmatched open-domain question", () => {
    expect(planRetrieval("what is a good gross margin in general", CTX)).toEqual([]);
  });

  it("a help question reads help ONLY — no balance sheet", () => {
    const plan = planRetrieval("how do i export the balance sheet", CTX);
    expect(plan.map((s) => s.tool)).toEqual(["search_help"]);
  });

  it("does not pay twice for a metric a comparison already covers", () => {
    const plan = planRetrieval("compare revenue vs last month", CTX);
    expect(plan.filter((s) => s.tool === "get_facts")).toHaveLength(0);
  });

  it("a trend walks the periods oldest → newest", () => {
    const plan = planRetrieval("revenue trend over time", CTX);
    const labels = plan
      .filter((s) => s.tool === "get_facts")
      .map((s) => s.traceParams.period);
    expect(labels).toEqual(["Sep 2025", "Oct 2025", "Nov 2025", "Dec 2025"]);
  });

  it("falls back to nothing when a compare has only one period", () => {
    const plan = planRetrieval("revenue vs last month", {
      ...CTX,
      periods: [CTX.periods[0]],
    });
    expect(plan.some((s) => s.tool === "compare_periods")).toBe(false);
  });
});

describe("shape matching", () => {
  it("reads account codes and ignores years", () => {
    expect(matchAccounts("what is in cont 461")).toEqual(["461"]);
    expect(matchAccounts("revenue in 2025")).toEqual([]);
    expect(matchAccounts("account 5121 and 401")).toEqual(["5121", "401"]);
  });

  it("parses a what-if only when driver AND magnitude are both present", () => {
    expect(matchScenario("what if revenue drops 10%")).toEqual({
      metric: "revenue",
      mode: "pct",
      value: -10,
    });
    expect(matchScenario("daca cheltuielile cresc cu 5%")).toEqual({
      metric: "expenses",
      mode: "pct",
      value: 5,
    });
    expect(matchScenario("what if revenue falls")).toBeNull();
  });

  it("refuses a ticker the host does not know", () => {
    const plan = planRetrieval("VAT", CTX);
    expect(plan.some((s) => s.tool === "get_public_company")).toBe(false);
  });
});

// ── the merge ──────────────────────────────────────────────────────────

function step(tool: string, args: Record<string, unknown>, id = "s:0"): CapsulePlanStep {
  return { id, tool, args, period: null, traceKey: `capsuleAnswer.trace.${tool}`, traceParams: {} };
}

describe("mergeEvidence", () => {
  it("renames on collision so two periods cannot share one binding", () => {
    const entries = FIXTURE_PERIODS.slice(0, 3).map((p, i) => {
      const s = step("get_facts", { metric: "revenue", period: p.id }, `get_facts:${i}`);
      return { step: s, payload: fixturePayload(s) };
    });
    const ev = mergeEvidence(entries);
    const names = Object.keys(ev.facts);
    expect(names).toEqual(["revenue", "revenue__2", "revenue__3"]);
    // Each name keeps ITS OWN period — this is the whole point.
    expect(ev.factMeta.revenue.periodLabel).toBe("Dec 2025");
    expect(ev.factMeta.revenue__2.periodLabel).toBe("Nov 2025");
    expect(new Set(Object.values(ev.facts)).size).toBe(3);
  });

  it("dedupes an identical read rather than minting a second name", () => {
    const s = step("get_facts", { metric: "equity", period: FIXTURE_PERIODS[0].id });
    const payload = fixturePayload(s);
    const ev = mergeEvidence([
      { step: s, payload },
      { step: { ...s, id: "get_facts:1" }, payload },
    ]);
    expect(Object.keys(ev.facts)).toEqual(["equity"]);
  });

  it("declares units from the payload and never infers them", () => {
    const s = step("get_facts", { metric: "current_ratio" });
    const ev = mergeEvidence([{ step: s, payload: fixturePayload(s) }]);
    expect(ev.factUnits.current_ratio).toBe("ratio");
    expect(ev.currency).toBeNull(); // a ratio carries no currency
  });

  it("refuses to bind a fact whose unit the engine did not declare", () => {
    const s = step("get_facts", { metric: "revenue" });
    const payload = fixturePayload(s);
    (payload.values[0] as { unit: string }).unit = "furlongs";
    const ev = mergeEvidence([{ step: s, payload }]);
    expect(Object.keys(ev.facts)).toEqual([]);
  });

  it("drops money from a SECOND currency instead of mixing it in", () => {
    const s1 = step("get_facts", { metric: "revenue" }, "get_facts:0");
    const p1 = fixturePayload(s1);
    const s2 = step("get_facts", { metric: "equity" }, "get_facts:1");
    const p2 = fixturePayload(s2);
    const eur = fixtureMoney("equity", "equity", 3000000000, 0);
    (eur as { currency: string }).currency = "EUR";
    p2.values = [eur];
    p2.currency = "EUR";

    const ev = mergeEvidence([
      { step: s1, payload: p1 },
      { step: s2, payload: p2 },
    ]);
    expect(ev.currency).toBe("RON");
    expect(ev.facts.equity).toBeUndefined();
    expect(ev.limitations.some((l) => l.rule === "native_units")).toBe(true);
  });

  it("collects the digit literals an answer may quote", () => {
    const s = step("get_account", { code: "461" });
    const ev = mergeEvidence([{ step: s, payload: fixturePayload(s) }]);
    expect(ev.literals).toContain("461");
    expect(ev.literals).toContain("2025");
  });

  it("carries period and snapshot through for the citation footer", () => {
    const s = step("get_facts", { metric: "total_assets" });
    const ev = mergeEvidence([{ step: s, payload: fixturePayload(s) }]);
    expect(ev.periods).toEqual([{ id: "p-2025-12", label: "Dec 2025" }]);
    expect(ev.snapshots).toEqual(["snap-a1b2c3d4"]);
  });
});

describe("runPlan", () => {
  it("merges in PLAN order, not arrival order", async () => {
    const plan = planRetrieval("revenue trend over time", CTX);
    // A transport whose newest period is slowest — arrival order is the
    // reverse of plan order.
    const transport = async (s: CapsulePlanStep): Promise<CapsuleToolPayload> => {
      const idx = FIXTURE_PERIODS.findIndex((p) => p.id === s.period);
      await new Promise((r) => setTimeout(r, idx * 5));
      return fixturePayload(s);
    };
    const { evidence } = await runPlan(plan, transport);
    expect(evidence.factMeta.revenue.periodLabel).toBe("Sep 2025");
    expect(evidence.factMeta.revenue__4.periodLabel).toBe("Dec 2025");
  });

  it("turns an unreachable engine into typed gaps, not a throw", async () => {
    const plan = planRetrieval("what are our total assets", CTX);
    const { evidence, outcomes } = await runPlan(plan, deadToolTransport());
    expect(outcomes.every((o) => !o.ok)).toBe(true);
    expect(evidence.gaps.map((g) => g.code)).toContain("tool_unreachable");
    expect(Object.keys(evidence.facts)).toEqual([]);
  });

  it("keeps the reads that DID land when one fails", async () => {
    const plan = planRetrieval("how are we doing overall", CTX);
    const good = fixtureToolTransport();
    let n = 0;
    const flaky = async (s: CapsulePlanStep) => {
      n += 1;
      if (n === 2) throw new TypeError("Failed to fetch");
      return good(s);
    };
    const { evidence } = await runPlan(plan, flaky);
    expect(Object.keys(evidence.facts).length).toBeGreaterThan(0);
    expect(evidence.gaps.some((g) => g.code === "tool_unreachable")).toBe(true);
  });
});
