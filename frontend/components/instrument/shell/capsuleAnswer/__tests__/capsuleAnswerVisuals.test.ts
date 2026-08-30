// MINI-VISUALS — derived from facts, never from prose.

import { describe, expect, it } from "vitest";

import {
  comparisonsFrom,
  sparkGeometry,
  sparklinesFrom,
  visualsFrom,
  MAX_VISUALS,
} from "../capsuleAnswerVisuals";
import { mergeEvidence, planRetrieval, runPlan } from "../capsuleRetrieval";
import {
  FIXTURE_PERIODS,
  fixturePayload,
  fixtureToolTransport,
} from "../capsuleAnswerFixtures";
import { emptyEvidence } from "../capsuleAnswerTypes";

const CTX = {
  periodId: FIXTURE_PERIODS[0].id,
  periodLabel: FIXTURE_PERIODS[0].label,
  periods: FIXTURE_PERIODS.map((p) => ({ id: p.id, label: p.label })),
};

async function evidenceFor(question: string) {
  const plan = planRetrieval(question, CTX);
  const { evidence } = await runPlan(plan, fixtureToolTransport());
  return evidence;
}

describe("comparisons", () => {
  it("builds a three-row table from the engine's own _a/_b/_delta triple", async () => {
    const ev = await evidenceFor("how did revenue change vs last month");
    const [cmp] = comparisonsFrom(ev);
    expect(cmp).toMatchObject({
      kind: "comparison",
      metric: "revenue",
      factA: "revenue_a",
      factB: "revenue_b",
      factDelta: "revenue_delta",
    });
    expect(cmp.labelA).toBe("Nov 2025");
    expect(cmp.labelB).toBe("Dec 2025");
  });

  it("reads direction from the delta's SIGN, never from a judgement", async () => {
    const ev = await evidenceFor("how did revenue change vs last month");
    expect(comparisonsFrom(ev)[0].direction).toBe("up");
    // Same machinery on a metric where "up" is bad — the module still
    // reports the sign and lets the reader judge.
    const ev2 = await evidenceFor("compare expenses vs last month");
    expect(comparisonsFrom(ev2)[0].direction).toBe("up");
  });

  it("refuses to pair two sides of different units", () => {
    const ev = emptyEvidence();
    ev.factMeta = {
      x_a: { fact: "x_a", metric: "x", unit: "money", value: 1, scope: "", labelKey: "",
        periodId: "p1", periodLabel: "A", snapshotId: null, currency: "RON", tool: "t",
        alias: null, step: 0 },
      x_b: { fact: "x_b", metric: "x", unit: "percent", value: 2, scope: "", labelKey: "",
        periodId: "p2", periodLabel: "B", snapshotId: null, currency: null, tool: "t",
        alias: null, step: 0 },
    };
    expect(comparisonsFrom(ev)).toEqual([]);
  });

  it("emits nothing when only one side is present", () => {
    const ev = emptyEvidence();
    ev.factMeta = {
      x_a: { fact: "x_a", metric: "x", unit: "money", value: 1, scope: "", labelKey: "",
        periodId: "p1", periodLabel: "A", snapshotId: null, currency: "RON", tool: "t",
        alias: null, step: 0 },
    };
    expect(comparisonsFrom(ev)).toEqual([]);
  });
});

describe("sparklines", () => {
  it("needs three distinct periods of the same metric", async () => {
    const ev = await evidenceFor("revenue trend over time");
    const [spark] = sparklinesFrom(ev);
    expect(spark.points.map((p) => p.label)).toEqual([
      "Sep 2025", "Oct 2025", "Nov 2025", "Dec 2025",
    ]);
  });

  it("does not draw one from a single read", async () => {
    const ev = await evidenceFor("what are our total assets");
    expect(sparklinesFrom(ev)).toEqual([]);
  });

  it("does not mistake comparison legs for series points", async () => {
    const ev = await evidenceFor("how did revenue change vs last month");
    expect(sparklinesFrom(ev)).toEqual([]);
  });

  it("caps how many visuals one answer carries", async () => {
    const ev = await evidenceFor("revenue trend over time");
    expect(visualsFrom(ev).length).toBeLessThanOrEqual(MAX_VISUALS);
  });
});

describe("sparkGeometry", () => {
  it("is pure — same input, same path", () => {
    const a = sparkGeometry([1, 5, 3, 9]);
    const b = sparkGeometry([1, 5, 3, 9]);
    expect(a.path).toBe(b.path);
  });

  it("puts the largest value highest (SVG y grows downward)", () => {
    const g = sparkGeometry([1, 9]);
    expect(g.points[1].y).toBeLessThan(g.points[0].y);
  });

  it("draws a flat line rather than dividing by a zero range", () => {
    const g = sparkGeometry([7, 7, 7]);
    expect(g.flat).toBe(true);
    expect(new Set(g.points.map((p) => p.y)).size).toBe(1);
  });

  it("survives an empty series", () => {
    expect(sparkGeometry([])).toEqual({ path: "", points: [], flat: true });
  });
});

describe("visuals never read prose", () => {
  it("a merge with no values yields no visuals, whatever the model wrote", () => {
    const step = {
      id: "get_facts:0", tool: "get_facts",
      args: { metric: "not_a_metric" }, period: null,
      traceKey: "capsuleAnswer.trace.get_facts", traceParams: {},
    };
    const ev = mergeEvidence([{ step, payload: fixturePayload(step) }]);
    expect(visualsFrom(ev)).toEqual([]);
    expect(ev.gaps[0].code).toBe("unknown_metric");
  });
});
