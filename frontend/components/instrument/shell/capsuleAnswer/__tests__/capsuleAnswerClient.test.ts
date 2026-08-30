// THE ANSWER PIPELINE — retrieval first, guard always, one regeneration,
// then the deterministic floor.

import { describe, expect, it, vi } from "vitest";

import { CfoApiError } from "@/lib/cfoApi";

import {
  answerToNativeText,
  buildBrief,
  buildDatasetSummary,
  runAnswerTurn,
  type GenerationTransport,
} from "../capsuleAnswerClient";
import { planRetrieval, CAPSULE_TOOLS, type ToolTransport } from "../capsuleRetrieval";
import {
  ANSWER_FIXTURES,
  FIXTURE_PERIODS,
  deadToolTransport,
  fixtureGenerationTransport,
  fixtureToolTransport,
} from "../capsuleAnswerFixtures";

const CTX = {
  periodId: FIXTURE_PERIODS[0].id,
  periodLabel: FIXTURE_PERIODS[0].label,
  periods: FIXTURE_PERIODS.map((p) => ({ id: p.id, label: p.label })),
};

function fixture(id: string) {
  const f = ANSWER_FIXTURES.find((x) => x.id === id);
  if (!f) throw new Error(`no fixture ${id}`);
  return f;
}

async function run(
  question: string,
  generate: GenerationTransport,
  toolTransport: ToolTransport = fixtureToolTransport(),
) {
  return runAnswerTurn({
    turnId: "t1",
    question,
    history: [],
    plan: planRetrieval(question, CTX),
    toolTransport,
    generate,
    language: "en",
    companyName: "Fixture SRL",
  });
}

describe("runAnswerTurn — the happy path", () => {
  it("renders a guarded answer with cited facts and a visual", async () => {
    const f = fixture("compare-revenue");
    const turn = await run(f.question, fixtureGenerationTransport(f.answer));
    expect(turn.status).toBe("done");
    expect(turn.degraded).toBeNull();
    expect(turn.deterministic).toBe(false);
    expect(turn.blocks).toHaveLength(1);
    expect(turn.citedFacts).toEqual(["revenue_a", "revenue_b", "revenue_delta"]);
    expect(turn.visuals[0]?.kind).toBe("comparison");
  });

  it("builds a sparkline from four period reads", async () => {
    const f = fixture("trend-revenue");
    const turn = await run(f.question, fixtureGenerationTransport(f.answer));
    expect(turn.visuals[0]).toMatchObject({ kind: "sparkline", metric: "revenue" });
    expect((turn.visuals[0] as { points: unknown[] }).points).toHaveLength(4);
  });

  it("marks the trace ok per step", async () => {
    const f = fixture("health");
    const turn = await run(f.question, fixtureGenerationTransport(f.answer));
    expect(turn.trace.length).toBeGreaterThan(0);
    expect(turn.trace.every((l) => l.state === "ok")).toBe(true);
  });

  it("times retrieval and first token", async () => {
    const f = fixture("assets");
    const turn = await run(f.question, fixtureGenerationTransport(f.answer));
    expect(turn.timing.retrievalMs).not.toBeNull();
    expect(turn.timing.firstTokenMs).not.toBeNull();
    expect(turn.timing.firstTokenMs!).toBeGreaterThanOrEqual(turn.timing.retrievalMs!);
    expect(turn.timing.totalMs!).toBeGreaterThanOrEqual(turn.timing.firstTokenMs!);
  });
});

describe("retrieval happens BEFORE generation", () => {
  it("no generation call is made until every read has resolved", async () => {
    const order: string[] = [];
    const tools: ToolTransport = async (step) => {
      await new Promise((r) => setTimeout(r, 4));
      order.push(`tool:${step.tool}`);
      return fixtureToolTransport()(step);
    };
    const generate: GenerationTransport = async function* (req) {
      order.push("generate");
      // The brief the model receives carries FACTS, never a file handle.
      expect(req.messages[req.messages.length - 1].content).toContain("FACTS");
      yield "Total assets are {{money:total_assets}}.";
    };
    await run("what are our total assets", generate, tools);
    expect(order[order.length - 1]).toBe("generate");
    expect(order.filter((o) => o.startsWith("tool:")).length).toBeGreaterThan(0);
  });

  it("only ever calls allowlisted read tools", async () => {
    const seen: string[] = [];
    const tools: ToolTransport = async (step) => {
      seen.push(step.tool);
      return fixtureToolTransport()(step);
    };
    for (const f of ANSWER_FIXTURES) {
      await run(f.question, fixtureGenerationTransport(f.answer), tools);
    }
    expect(seen.length).toBeGreaterThan(0);
    for (const tool of seen) expect(CAPSULE_TOOLS).toContain(tool);
  });
});

describe("the guard in the pipeline", () => {
  it("regenerates once when the first completion carries a numeral", async () => {
    const f = fixture("assets");
    let calls = 0;
    const generate: GenerationTransport = async function* () {
      calls += 1;
      yield calls === 1 ? "Total assets are 293,050,085 RON." : f.answer;
    };
    const turn = await run(f.question, generate);
    expect(calls).toBe(2);
    expect(turn.regenerated).toBe(true);
    expect(turn.deterministic).toBe(false);
    expect(turn.blocks[0].template).toContain("{{money:total_assets}}");
  });

  it("quotes the violation back on the retry", async () => {
    const briefs: string[] = [];
    const generate: GenerationTransport = async function* (req) {
      briefs.push(req.messages[req.messages.length - 1].content);
      yield briefs.length === 1
        ? "Assets are 293 million."
        : "Assets are {{money:total_assets}}.";
    };
    await run("what are our total assets", generate);
    expect(briefs).toHaveLength(2);
    expect(briefs[1]).toContain("rejected");
    expect(briefs[1]).toContain("293");
  });

  it("falls back deterministically when BOTH completions violate", async () => {
    const generate = fixtureGenerationTransport("Total assets are 293,050,085 RON.");
    const turn = await run("what are our total assets", generate);
    expect(turn.regenerated).toBe(true);
    expect(turn.deterministic).toBe(true);
    expect(turn.blocks).toEqual([]);
    // The figures are still there — the prose is what was discarded.
    expect(turn.citedFacts).toContain("total_assets");
    expect(turn.evidence.facts.total_assets).toBeCloseTo(293050085.11, 2);
  });

  it("never lets a numeral out of the pipeline", async () => {
    const generate = fixtureGenerationTransport("Assets rose 4.2% to 293,050,085.");
    const turn = await run("what are our total assets", generate);
    const prose = turn.blocks.map((b) => b.template).join(" ");
    expect(prose).toBe("");
    expect(turn.streaming).toBe("");
  });
});

describe("calm degradation (A2)", () => {
  it("maps an HTTP failure onto one typed kind, with no payload on the turn", async () => {
    const generate: GenerationTransport = async function* () {
      throw new CfoApiError("500 boom {\"request_id\": \"abc\"}", 500, { trace: "secret" });
      yield "";
    };
    const turn = await run("what are our total assets", generate);
    expect(turn.degraded).toBe("service");
    expect(turn.deterministic).toBe(true);
    expect(JSON.stringify(turn)).not.toContain("request_id");
    expect(JSON.stringify(turn)).not.toContain("secret");
  });

  it("intercepts the Edge Function's 200-wrapped upstream failure", async () => {
    const generate = fixtureGenerationTransport("x");
    const wrapped: GenerationTransport = async function* (req, signal) {
      // Reproduce what edgeGenerationTransport does with that sentinel.
      const { classifyUpstreamAnswer } = await import("@/lib/aiDegraded");
      const answer = "Couldn't reach Claude: 429 {\"error\":\"rate\"}. Try again in a moment.";
      const kind = classifyUpstreamAnswer(answer);
      if (kind) {
        const { UpstreamAnswerFailure } = await import("../capsuleAnswerClient");
        throw new UpstreamAnswerFailure(kind);
      }
      yield* generate(req, signal);
    };
    const turn = await run("what are our total assets", wrapped);
    expect(turn.degraded).toBe("usage");
    expect(JSON.stringify(turn)).not.toContain("Couldn't reach Claude");
  });

  it("still shows the retrieved figures when the assistant is down", async () => {
    const generate: GenerationTransport = async function* () {
      throw new TypeError("Failed to fetch");
      yield "";
    };
    const turn = await run("what are our total assets", generate);
    expect(turn.degraded).toBe("network");
    expect(Object.keys(turn.evidence.factMeta)).toContain("total_assets");
  });

  it("survives an engine that is down entirely", async () => {
    const f = fixture("assets");
    const turn = await run(
      f.question,
      fixtureGenerationTransport("Nothing is on file for that period yet."),
      deadToolTransport(),
    );
    expect(turn.status).toBe("done");
    expect(turn.evidence.gaps.map((g) => g.code)).toContain("tool_unreachable");
    expect(turn.trace.every((l) => l.state === "missing")).toBe(true);
  });

  it("an abort ends the turn without reporting a failure", async () => {
    const controller = new AbortController();
    const generate: GenerationTransport = async function* () {
      controller.abort();
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
      yield "";
    };
    const turn = await runAnswerTurn({
      turnId: "t-abort",
      question: "what are our total assets",
      history: [],
      plan: planRetrieval("what are our total assets", CTX),
      toolTransport: fixtureToolTransport(),
      generate,
      language: "en",
      signal: controller.signal,
    });
    expect(turn.status).toBe("failed");
    expect(turn.degraded).toBeNull();
  });
});

describe("the brief", () => {
  it("states the contract, lists the facts, and names the language", async () => {
    const f = fixture("assets");
    let brief = "";
    await run(f.question, async function* (req) {
      brief = req.messages[req.messages.length - 1].content;
      yield f.answer;
    });
    expect(brief).toContain("Write NO digits");
    expect(brief).toContain("total_assets · money · Dec 2025");
    expect(brief).toContain("English");
    // The Edge Function's currency directive is what makes a model cite
    // figures itself — this surface must never turn it on.
    expect(brief).not.toContain("display_currency");
  });

  it("says plainly when nothing was retrieved", () => {
    const brief = buildBrief("what is a good margin", {
      facts: {}, factUnits: {}, factMeta: {}, currency: null, values: [], rows: [],
      gaps: [], limitations: [], notes: [], tools: [], periods: [], snapshots: [],
      literals: [],
    }, "ro");
    expect(brief).toContain("none were retrieved");
    expect(brief).toContain("Romanian");
  });

  it("the dataset digest carries names, not values", async () => {
    const f = fixture("assets");
    const turn = await run(f.question, fixtureGenerationTransport(f.answer));
    const digest = buildDatasetSummary(turn.evidence);
    expect(digest).toContain("total_assets");
    expect(digest).not.toContain("293050085");
  });

  it("carries the prior turns as placeholder templates, not rendered text", async () => {
    let messages: { role: string; content: string }[] = [];
    await runAnswerTurn({
      turnId: "t2",
      question: "and the month before?",
      history: [{ question: "assets?", answer: "Assets are {{money:total_assets}}." }],
      plan: [],
      toolTransport: fixtureToolTransport(),
      generate: async function* (req) {
        messages = req.messages;
        yield "Nothing further is on file.";
      },
      language: "en",
    });
    expect(messages[1].content).toContain("{{money:total_assets}}");
  });
});

describe("native text (Copy / chat hand-off)", () => {
  it("resolves placeholders in the SOURCE currency, explicitly labelled", async () => {
    const f = fixture("assets");
    const turn = await run(f.question, fixtureGenerationTransport(f.answer));
    const text = answerToNativeText(turn.blocks, turn.evidence, { locale: "en-GB" });
    expect(text).not.toContain("{{");
    expect(text).toMatch(/RON|lei/i);
  });

  it("prints a dimensionless fact without a currency", async () => {
    const f = fixture("equity-ratio");
    const turn = await run(f.question, fixtureGenerationTransport(f.answer));
    const text = answerToNativeText(turn.blocks, turn.evidence, { locale: "en-GB" });
    expect(text).toContain("51.2%");
    expect(text).not.toMatch(/RON|EUR/);
  });
});

describe("onUpdate", () => {
  it("emits retrieving → generating → done", async () => {
    const states: string[] = [];
    const f = fixture("assets");
    await runAnswerTurn({
      turnId: "t3",
      question: f.question,
      history: [],
      plan: planRetrieval(f.question, CTX),
      toolTransport: fixtureToolTransport(),
      generate: fixtureGenerationTransport(f.answer),
      language: "en",
      onUpdate: (turn) => states.push(turn.status),
    });
    expect(states[0]).toBe("retrieving");
    expect(states).toContain("generating");
    expect(states[states.length - 1]).toBe("done");
  });

  it("never surfaces raw streamed text on the finished turn", async () => {
    const f = fixture("assets");
    const spy = vi.fn();
    const turn = await runAnswerTurn({
      turnId: "t4",
      question: f.question,
      history: [],
      plan: planRetrieval(f.question, CTX),
      toolTransport: fixtureToolTransport(),
      generate: fixtureGenerationTransport(f.answer, { chunks: 4 }),
      language: "en",
      onUpdate: spy,
    });
    expect(turn.streaming).toBe("");
    expect(spy).toHaveBeenCalled();
  });
});
