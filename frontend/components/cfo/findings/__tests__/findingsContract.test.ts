// THE ONE RULE THIS LAYER APPLIES, under test.
//
// `_finding.to_payload` stamps `surfaced` from its own validator, so the
// client's job is not to re-judge findings — it is to make sure the
// screen cannot disagree with that stamp in the dangerous direction. The
// asymmetry is the whole point:
//
//   demoting is allowed   — a truncated payload must not render as a
//                           complete card
//   promoting is not      — no severity, no rank, no "looks important"
//                           may turn a demoted row into a recommendation
//
// Every assertion below runs against `engineFixture.ts`, which is the
// engine's own bytes rather than a hand-written approximation of them.

import { describe, expect, it } from "vitest";

import {
  buildDismissal,
  buildFindingsReport,
  formatDimensionless,
  parseFinding,
  resolveMoneyFact,
  surfacedOf,
} from "@/lib/findings";

import { ENGINE_REPORT, ENGINE_SILENCE } from "./engineFixture";

const report = ENGINE_REPORT as {
  surfaced: unknown[];
  demoted: unknown[];
  checks: unknown[];
};

function surfacedRow(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(report.surfaced[0])) as Record<string, unknown>;
}

// ── parsing the real payload ───────────────────────────────────────────

describe("parseFinding", () => {
  it("reads all seven elements off the engine's own row", () => {
    const f = parseFinding(report.surfaced[0]);
    expect(f).not.toBeNull();
    expect(f!.elements.subject?.accounts[0].code).toBe("461");
    expect(f!.elements.subject?.accounts.map((a) => a.code)).toEqual([
      "461", "451", "452", "455",
    ]);
    expect(f!.elements.evidence?.figures).toHaveLength(4);
    expect(f!.elements.evidence?.provenance?.snapshot_id).toBe("snap-agras_fy2025");
    expect(f!.elements.threshold?.rule_id).toBe("concentration_related_party");
    expect(f!.elements.impact?.kind).toBe("recomputed_ratio");
    expect(f!.elements.why_here?.profile_label).toContain("inventory-heavy");
    expect(f!.elements.action?.steps).toHaveLength(2);
    expect(f!.elements.confidence?.level).toBe("medium");
    expect(f!.missingElements).toEqual([]);
    expect(surfacedOf(f!)).toBe(true);
  });

  it("returns null for a legacy alert row so the caller can fall back", () => {
    // The production 461 row as it exists today: prose, facts, templates —
    // and not one contract element.
    expect(
      parseFinding({
        id: "a1",
        rule_key: "concentration_intercompany_loan",
        severity: "high",
        title: "Intercompany receivable RON 7,692,203 = 19.6% of total assets",
        body: "Recoverability and intent on settlement should be confirmed.",
        facts_cited: { intercompany_loans: 7692202.74 },
      }),
    ).toBeNull();
  });
});

// ── the asymmetry ──────────────────────────────────────────────────────

describe("demotion is the default path", () => {
  it("demotes a row that claims surfaced while missing an element", () => {
    const row = surfacedRow();
    (row.contract_elements as Record<string, unknown>).action = null;
    expect(row.surfaced).toBe(true); // the payload still claims it

    const f = parseFinding(row)!;
    expect(f.engineSurfaced).toBe(true);
    expect(f.missingElements).toEqual(["action"]);
    expect(surfacedOf(f)).toBe(false);
  });

  it("demotes a structurally-empty element rather than rendering a blank slot", () => {
    const row = surfacedRow();
    (row.contract_elements as Record<string, unknown>).action = { steps: [] };
    expect(surfacedOf(parseFinding(row)!)).toBe(false);
  });

  it("never promotes: a demoted critical row stays off the surfaced list", () => {
    const row = surfacedRow();
    row.surfaced = false;
    row.severity = "critical";
    row.effective_severity = "critical";
    row.rank = 1;
    const built = buildFindingsReport([row]);
    expect(built.surfaced).toHaveLength(0);
    expect(built.demoted).toHaveLength(1);
  });

  it("honours the cap: a complete finding held back is not a recommendation", () => {
    const row = surfacedRow();
    row.disposition = "all_checks";
    const built = buildFindingsReport([row]);
    expect(built.surfaced).toHaveLength(0);
    expect(built.demoted).toHaveLength(1);
  });
});

// ── the report ─────────────────────────────────────────────────────────

describe("buildFindingsReport", () => {
  it("partitions the engine's ranked report the way the engine did", () => {
    const built = buildFindingsReport(ENGINE_REPORT);
    expect(built.surfaced.map((f) => f.ruleKey)).toEqual([
      "concentration_related_party",
      "liquidity_cash_tight",
    ]);
    // Complete, but under the materiality floor — never a recommendation.
    expect(built.info.map((f) => f.ruleKey)).toEqual(["fx_exposure"]);
    expect(built.demoted.map((f) => f.ruleKey)).toEqual(["input_cost_exposure"]);
    expect(built.hasContractRows).toBe(true);
    // The engine's own sentence about what is shown, not a re-derived one.
    expect(built.statement).toContain("2 finding(s) surfaced");
  });

  it("gives every demoted finding a check row carrying the missing element", () => {
    const built = buildFindingsReport(ENGINE_REPORT);
    const row = built.checks.find((c) => c.note.includes("no action supplied"));
    expect(row).toBeDefined();
    expect(row!.rule_id).toBe("input_cost_exposure");
    expect(row!.fired).toBe(true);
    // The rule and its numbers survive the demotion — only the prose is
    // withheld. 59.5% of revenue against a 35% limit.
    expect(row!.parameter).toBe("share_of_revenue_high");
    expect(row!.limit).toBeCloseTo(0.35, 12);
    expect(row!.observed).toBeCloseTo(0.5950329490554045, 12);
  });

  it("lists every rule ONCE, and keeps the row that carries the reason", () => {
    // Two duplicate sources meet here: the runner writes a check row when
    // a finding is added, and `rank_findings` writes another carrying the
    // demotion reason. Keeping the FIRST silently dropped the reason —
    // the one thing the checks list exists to carry.
    const built = buildFindingsReport(ENGINE_REPORT);
    const ids = built.checks.map((c) => `${c.rule_id}|${c.parameter}`);
    expect(new Set(ids).size).toBe(ids.length);
    const withReason = built.checks.filter((c) =>
      c.note.includes("no action supplied"),
    );
    expect(withReason).toHaveLength(1);
    expect(withReason[0].rule_id).toBe("input_cost_exposure");
  });

  it("says hasContractRows=false for a period of legacy rows only", () => {
    const built = buildFindingsReport([
      { id: "a1", rule_key: "legacy", severity: "high", title: "x", body: "y" },
    ]);
    expect(built.hasContractRows).toBe(false);
    expect(built.silence).toBeNull();
  });

  it("carries the silence statement verbatim, with its checks", () => {
    const built = buildFindingsReport({ report: { surfaced: [] }, silence: ENGINE_SILENCE });
    expect(built.surfaced).toHaveLength(0);
    expect(built.silence?.statement).toBe(
      (ENGINE_SILENCE as { statement: string }).statement,
    );
    expect(built.checks.length).toBe(
      (ENGINE_SILENCE as { checks: unknown[] }).checks.length,
    );
    expect(built.checks.map((c) => c.rule_id)).toContain("leverage_debt_to_ebitda");
    expect(built.hasContractRows).toBe(true);
  });

  it("drops the silence claim the moment something surfaces", () => {
    const built = buildFindingsReport({ report: ENGINE_REPORT, silence: ENGINE_SILENCE });
    expect(built.surfaced).toHaveLength(2);
    expect(built.silence).toBeNull();
  });
});

// ── absent is not zero ─────────────────────────────────────────────────

describe("absent is not zero", () => {
  it("keeps an absent limit null instead of defaulting it to 0", () => {
    const row = surfacedRow();
    const th = (row.contract_elements as Record<string, Record<string, unknown>>).threshold;
    th.limit = null;
    const f = parseFinding(row)!;
    expect(f.elements.threshold?.limit).toBeNull();
  });

  it("refuses to format money as a dimensionless value", () => {
    expect(formatDimensionless(7692202.74, "money")).toBeNull();
    expect(formatDimensionless(7692202.74, "unknown")).toBeNull();
  });

  it("formats each declared unit the way the engine prints it", () => {
    expect(formatDimensionless(0.19625880786990732, "percent")).toBe("19.6%");
    expect(formatDimensionless(2.5, "ratio")).toBe("2.50×");
    expect(formatDimensionless(45.2, "days", { daysWord: "days" })).toBe("45 days");
  });
});

// ── money never leaves the currency path ───────────────────────────────

describe("resolveMoneyFact", () => {
  it("names the cited fact a bare money value belongs to", () => {
    const facts = { intercompany_loans: 7692202.74, total_assets: 39194178.46 };
    const units = { intercompany_loans: "money", total_assets: "money" };
    expect(resolveMoneyFact(7692202.74, facts, units)).toBe("intercompany_loans");
    expect(resolveMoneyFact(39194178.46, facts, units)).toBe("total_assets");
  });

  it("skips facts the engine declared as something other than money", () => {
    const facts = { pct_of_assets: 0.5, some_money: 0.5 };
    const units = { pct_of_assets: "percent", some_money: "money" };
    expect(resolveMoneyFact(0.5, facts, units)).toBe("some_money");
  });

  it("returns undefined rather than guessing when nothing matches", () => {
    expect(resolveMoneyFact(123, { a: 456 }, { a: "money" })).toBeUndefined();
  });
});

// ── dismissal is not deletion ──────────────────────────────────────────

describe("buildDismissal", () => {
  it("scopes to the rule AND the subject, and carries the reason", () => {
    const f = parseFinding(report.surfaced[0])!;
    const d = buildDismissal(f, "settles on 15 Jan, sub-ledger with the auditor");
    expect(d.rule_id).toBe("concentration_related_party");
    // Rule-only scoping would silence this test on a different account in
    // a different company. The scope is the ROOT CAUSE the ranker
    // published — every ledger account the finding is about.
    expect(d.scope_key).toBe("461+451+452+455");
    expect(d.reason).toContain("15 Jan");
    // Open-ended by default is the engine's own default; the UI asks for
    // a reason, not for a duration.
    expect(d.periods).toBeNull();
  });
});
