// THE NUMERAL GUARD — the gate that makes "the model never emits a
// numeral" a property of the code rather than a hope about a prompt.

import { describe, expect, it } from "vitest";

import { parseNarrativeTemplate } from "@/lib/narrativeMoney";

import {
  guardAnswer,
  toBlocks,
  violationBrief,
  type GuardInput,
} from "../capsuleAnswerGuard";
import { VIOLATING_ANSWERS } from "../capsuleAnswerFixtures";

const INPUT: GuardInput = {
  facts: {
    total_assets: 293050085.11,
    equity: 150151551.11,
    current_ratio: 1.36,
    equity_ratio: 51.2,
    account_461: 7692203,
  },
  factUnits: {
    total_assets: "money",
    equity: "money",
    current_ratio: "ratio",
    equity_ratio: "percent",
    account_461: "money",
  },
  literals: ["Dec 2025", "2025", "461"],
};

describe("guardAnswer — acceptance", () => {
  it("accepts prose whose every figure is a placeholder", () => {
    const r = guardAnswer(
      "Total assets are {{money:total_assets}}, of which equity funds {{fact:equity_ratio}}.",
      INPUT,
    );
    expect(r.ok).toBe(true);
    expect(r.citedFacts).toEqual(["total_assets", "equity_ratio"]);
  });

  it("accepts a qualitative answer that cites nothing", () => {
    const r = guardAnswer("Equity is thicker than the debt it carries.", INPUT);
    expect(r.ok).toBe(true);
    expect(r.citedFacts).toEqual([]);
  });

  it("allows a digit that the EVIDENCE supplied, verbatim", () => {
    const r = guardAnswer("Account 461 holds {{money:account_461}} at Dec 2025.", INPUT);
    expect(r.ok).toBe(true);
  });

  it("allows the reader's own premise to be restated", () => {
    const r = guardAnswer("A 10% fall would not change the ranking.", {
      ...INPUT,
      literals: [...INPUT.literals, "10%"],
    });
    expect(r.ok).toBe(true);
  });

  it("accepts the |abs and |dN options the renderer understands", () => {
    const r = guardAnswer("Equity is {{money:equity|abs}} ({{fact:equity_ratio|d1}}).", INPUT);
    expect(r.ok).toBe(true);
  });
});

describe("guardAnswer — refusal", () => {
  it.each(VIOLATING_ANSWERS.map((v) => [v.id, v.text, v.kind] as const))(
    "refuses %s",
    (_id, text, kind) => {
      const r = guardAnswer(text, INPUT);
      expect(r.ok).toBe(false);
      expect(r.violations.some((v) => v.kind === kind)).toBe(true);
    },
  );

  it("refuses a numeral even when a valid placeholder sits beside it", () => {
    const r = guardAnswer(
      "Assets are {{money:total_assets}}, up about 3% on the month.",
      INPUT,
    );
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.kind)).toContain("numeral");
  });

  it("refuses a fact the retrieval step did not return", () => {
    const r = guardAnswer("Cash is {{money:cash}}.", INPUT);
    expect(r.ok).toBe(false);
    expect(r.violations[0].kind).toBe("unknown_fact");
  });

  it("refuses a money token on a fact the engine declared dimensionless", () => {
    const r = guardAnswer("Liquidity is {{money:current_ratio}}.", INPUT);
    expect(r.violations[0].kind).toBe("unit_mismatch");
  });

  it("refuses a percent token on a fact declared as a ratio", () => {
    const r = guardAnswer("Liquidity is {{percent:current_ratio}}.", INPUT);
    expect(r.violations[0].kind).toBe("unit_mismatch");
  });

  it("does not let a short literal mask an unrelated numeral", () => {
    // "461" is allowed; "4612" is not the same string and must not pass
    // by prefix.
    const r = guardAnswer("It sits under 4612 units.", INPUT);
    expect(r.ok).toBe(false);
  });

  it("quotes the offending fragment back for the regeneration", () => {
    const r = guardAnswer("Assets are 293,050,085.", INPUT);
    const brief = violationBrief(r.violations);
    expect(brief).toMatch(/numeral/i);
    expect(brief.length).toBeGreaterThan(20);
  });
});

describe("guard ↔ renderer agreement", () => {
  it("every guarded placeholder resolves through parseNarrativeTemplate", () => {
    const text =
      "Assets are {{money:total_assets}} and the ratio is {{fact:current_ratio}}.";
    expect(guardAnswer(text, INPUT).ok).toBe(true);
    const parts = parseNarrativeTemplate(text, INPUT.facts, INPUT.factUnits);
    expect(parts).not.toBeNull();
    expect(parts!.some((p) => p.kind === "money" && p.fact === "total_assets")).toBe(true);
  });

  it("a guard-refused unknown fact is also refused by the renderer", () => {
    const text = "Cash is {{money:cash}}.";
    expect(guardAnswer(text, INPUT).ok).toBe(false);
    expect(parseNarrativeTemplate(text, INPUT.facts, INPUT.factUnits)).toBeNull();
  });
});

describe("toBlocks", () => {
  it("splits paragraphs and bullets, and strips markdown chrome", () => {
    const blocks = toBlocks(
      "## Heading\nFirst **paragraph** line.\n\n- one bullet\n* another\n\nLast.",
    );
    expect(blocks.map((b) => b.kind)).toEqual(["para", "bullet", "bullet", "para"]);
    expect(blocks[0].template).toBe("Heading First paragraph line.");
    expect(blocks[1].template).toBe("one bullet");
  });

  it("keeps placeholders intact through the split", () => {
    const blocks = toBlocks("- Assets {{money:total_assets}}");
    expect(blocks[0].template).toBe("Assets {{money:total_assets}}");
  });

  it("returns nothing for empty input", () => {
    expect(toBlocks("")).toEqual([]);
  });
});
