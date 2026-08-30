// THE CAPSULE — FACT INDEX GATE (A2).
//
// Every fixture in this suite is REAL ENGINE OUTPUT. The three period
// blobs under `fixtures/capsuleTier0/` were captured by
// `fixtures/capsuleTier0/capture_fixtures.py`, which composes exactly
// what `/api/period` composes — `RomaniaPack.parse_trial_balance` →
// `assemble_parsed_tb` → `pipeline.stage_persist` →
// `pipeline._apply_envelope_truth_to_statements` — over the golden
// corpus inputs. Nothing in them is hand-written; the only edit is a
// deletion (`leaves` / `aggregates`, which Tier 0 never reads) and the
// run-time timestamp scrub the corpus replay itself applies.
//
// That matters here more than anywhere else in the lane. A hand-built
// statements object would have carried whatever P&L number the author
// expected. Two of the assertions below only exist because the real
// output settled a question the author had guessed wrong: `revenue` and
// `ebitda` are read from the methodology block (what the engine's own
// gateway reads) and today that AGREES with `assembled_pl` — while the
// F3.8 regression baseline committed in this repo for the same company
// shows the two objects 15% and a sign apart. The convergence test is
// the alarm for the next time they part.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  buildFactIndex,
  lookupFacts,
  factFor,
  standingContextFacts,
  amountKindFor,
  amountProvenanceFor,
  ENGINE_MONEY_FACTS,
  ENGINE_CAPSULE_METRICS,
  RESULT_ROW_IDS,
  METRIC_TERMS,
  FACT_PERIOD_COUNT,
  type CapsuleFactSnapshot,
} from "@/lib/capsuleFactIndex";
import type { Statements } from "@/lib/financialReport";

import carniprodJson from "./fixtures/capsuleTier0/period_carniprod_fy2025.json";
import retailJson from "./fixtures/capsuleTier0/period_retail_fy2024.json";
import driftJson from "./fixtures/capsuleTier0/period_minor_drift.json";

const carniprod = carniprodJson as unknown as Statements;
const retail = retailJson as unknown as Statements;
const drift = driftJson as unknown as Statements;

const repoRoot = resolve(__dirname, "../../..");
const readRepo = (p: string) => readFileSync(resolve(repoRoot, p), "utf-8");

/** Deep clone so a test that removes a block cannot leak into the next. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function twoPeriodSnapshot(): CapsuleFactSnapshot {
  return {
    activePeriodId: "p-carniprod",
    periods: [
      {
        periodId: "p-carniprod",
        periodLabel: "FY 2025",
        statements: carniprod,
        docId: "doc-carniprod",
      },
      {
        periodId: "p-retail",
        periodLabel: "FY 2024",
        statements: retail,
        docId: "doc-retail",
      },
    ],
  };
}

describe("buildFactIndex — real served periods", () => {
  const index = buildFactIndex(twoPeriodSnapshot());

  it("indexes both periods, active first", () => {
    expect(index.periods.map((p) => p.periodId)).toEqual(["p-carniprod", "p-retail"]);
    expect(index.activePeriodId).toBe("p-carniprod");
    expect(index.periods[0].currency).toBe("RON");
    expect(index.periods[0].bsStatus).toBe("BALANCED");
    expect(index.periods[0].factCount).toBeGreaterThan(40);
  });

  it("takes balance-sheet totals from the served gateway, cent-for-cent", () => {
    // The same object the corpus golden pins. Read it here so a change to
    // the engine's serve path fails on THIS assertion rather than
    // silently redefining what Tier 0 answers.
    const golden = JSON.parse(
      readRepo("corpus/saga_10_col_carniprod/expected/served_envelope.json"),
    ) as { totals: Record<string, number>; difference: number };

    expect(factFor(index, "total_assets")!.value).toBe(golden.totals.assets);
    expect(factFor(index, "equity")!.value).toBe(golden.totals.equity);
    expect(factFor(index, "total_liabilities")!.value).toBe(golden.totals.liabilities);
    expect(factFor(index, "current_assets")!.value).toBe(golden.totals.current_assets);
    expect(factFor(index, "current_liabilities")!.value)
      .toBe(golden.totals.current_liabilities);
    expect(factFor(index, "difference")!.value).toBe(golden.difference);
  });

  // ── THE SOURCE-OF-TRUTH GATE ──────────────────────────────────────
  it("takes revenue and EBITDA from the same block the engine gateway reads", () => {
    const methodology = (carniprod as unknown as {
      assembled_canonical_v1: {
        methodology: { totals: Record<string, number>; ebitda: Record<string, number> };
      };
    }).assembled_canonical_v1.methodology;

    // `engine.serving.facts.FactsGateway.revenue` reads
    // `totals.revenue_net`; `.ebitda` reads `ebitda.reported`. Tier 0
    // must name the numbers the model tier will name.
    expect(factFor(index, "revenue")!.value).toBe(methodology.totals.revenue_net);
    expect(factFor(index, "ebitda")!.value).toBe(methodology.ebitda.reported);
    expect(factFor(index, "revenue")!.source).toBe("methodology");
  });

  it("CONVERGENCE: assembled_pl still agrees with methodology", () => {
    // Today they agree, so reading either would produce the same answer.
    // They have NOT always: the F3.8 regression baseline committed in
    // this repo for the same company reports assembled_pl revenue
    // 86,217,270.73 and EBITDA −3,122,134.74 against the methodology
    // block's 99,424,740.16 / 9,588,744.57. This assertion is the alarm
    // for the next divergence — when it fires, `assembled_pl` has moved
    // and every surface reading it is now answering a different question
    // from the Capsule's model tier.
    const stale = JSON.parse(readRepo(
      "src/engine/country_packs/ro_romania/fixtures/regression_baselines/"
      + "carniprod_fy2025.json",
    )) as { assembled: { statements: { assembled_pl: Record<string, number> } } };
    expect(stale.assembled.statements.assembled_pl.revenue).toBe(86217270.73);
    expect(stale.assembled.statements.assembled_pl.ebitda).toBe(-3122134.74);

    for (const [statements, label] of [[carniprod, "carniprod"], [retail, "retail"]] as const) {
      const methodology = (statements as unknown as {
        assembled_canonical_v1: {
          methodology: { totals: Record<string, number>; ebitda: Record<string, number> };
        };
      }).assembled_canonical_v1.methodology;
      const assembledPl = statements.assembled_pl as Record<string, number>;
      expect(methodology.totals.revenue_net, `${label} revenue`).toBe(assembledPl.revenue);
      expect(methodology.ebitda.reported, `${label} ebitda`).toBe(assembledPl.ebitda);
    }
  });

  it("sums net_result from exactly the engine's result rows", () => {
    const rows = (carniprod.canonical_bs!.rows ?? [])
      .filter((r) => RESULT_ROW_IDS.indexOf(r.id) >= 0);
    expect(rows.length).toBeGreaterThan(0);
    const expected = rows.reduce((sum, r) => sum + r.amount, 0);
    expect(factFor(index, "net_result")!.value).toBe(expected);
  });

  it("defines expenses as revenue − net_result, the gateway's own rule", () => {
    const revenue = factFor(index, "revenue")!.value;
    const netResult = factFor(index, "net_result")!.value;
    expect(factFor(index, "expenses")!.value).toBe(revenue - netResult);
  });

  it("carries statement lines verbatim, with their account codes", () => {
    const line = factFor(index, "bs.row.ar_intercompany");
    expect(line).not.toBeNull();
    const row = carniprod.canonical_bs!.rows.find((r) => r.id === "ar_intercompany")!;
    expect(line!.value).toBe(row.amount);
    expect(line!.label).toBe(row.label);
    expect(line!.accountCodes).toEqual(row.account_codes);
    expect(line!.provenance?.account).toContain("461");
  });

  it("resolves every metric name the engine's Capsule tool registry exposes", () => {
    const unresolved = ENGINE_CAPSULE_METRICS.filter((m) => factFor(index, m) === null);
    expect(unresolved).toEqual([]);
  });

  it("declares a unit on every fact and a currency on money only", () => {
    for (const fact of index.facts) {
      expect(typeof fact.unit).toBe("string");
      expect(fact.unit.length).toBeGreaterThan(0);
      if (fact.unit === "money") expect(fact.currency).toBe("RON");
      else expect(fact.currency).toBeUndefined();
      expect(Number.isFinite(fact.value)).toBe(true);
    }
  });

  it("is deterministic — same snapshot, byte-identical index", () => {
    const again = buildFactIndex(twoPeriodSnapshot());
    expect(JSON.stringify(again.facts)).toBe(JSON.stringify(index.facts));
  });

  it("counts periods once, not once per period", () => {
    const refs = index.byKey.get(FACT_PERIOD_COUNT)!;
    expect(refs).toHaveLength(1);
    expect(refs[0].value).toBe(2);
    expect(refs[0].unit).toBe("count");
  });
});

describe("ABSENT is not ZERO", () => {
  it("builds no revenue fact when the period carries no methodology", () => {
    const bsOnly = clone(carniprod) as unknown as Record<string, unknown>;
    // The shape a BS-only / pre-canonical period actually serves: the
    // balance sheet is there, the P&L block is not. Deletion only — no
    // number is altered.
    delete bsOnly.assembled_canonical_v1;
    delete bsOnly.assembled_pl;
    delete bsOnly.incomeStatement;

    const index = buildFactIndex({
      periods: [{
        periodId: "p-bs-only",
        periodLabel: "FY 2025",
        statements: bsOnly as unknown as Statements,
      }],
    });

    expect(factFor(index, "revenue")).toBeNull();
    expect(factFor(index, "ebitda")).toBeNull();
    expect(factFor(index, "net_margin")).toBeNull();
    // …and the balance sheet still answers, so this is a partial period
    // rather than a dead one.
    expect(factFor(index, "total_assets")).not.toBeNull();
  });

  it("refuses a ratio whose denominator is zero rather than emitting Infinity", () => {
    const zeroLiabilities = clone(carniprod) as unknown as Statements;
    zeroLiabilities.canonical_bs!.totals.current_liabilities = 0;
    const index = buildFactIndex({
      periods: [{ periodId: "p", periodLabel: "FY 2025", statements: zeroLiabilities }],
    });
    expect(factFor(index, "current_ratio")).toBeNull();
    expect(factFor(index, "cash_ratio")).toBeNull();
    for (const fact of index.facts) expect(Number.isFinite(fact.value)).toBe(true);
  });

  it("drops a finding fact whose unit the engine refused to declare", () => {
    const index = buildFactIndex({
      periods: [{
        periodId: "p", periodLabel: "FY 2025", statements: carniprod,
        findings: [{
          key: "f1", ruleKey: "liquidity_cash_tight",
          factsCited: { cash: 1_168_047, mystery_number: 42 },
          factUnits: { cash: "money", mystery_number: "unknown" },
        }],
      }],
    });
    expect(index.byKey.has("mystery_number")).toBe(false);
    expect(factFor(index, "cash")).not.toBeNull();
  });
});

describe("engine mirrors — pinned against the Python sources", () => {
  it("RESULT_ROW_IDS matches engine.serving.facts._RESULT_ROW_IDS", () => {
    const src = readRepo("src/engine/serving/facts.py");
    const match = /_RESULT_ROW_IDS\s*=\s*\(([^)]*)\)/.exec(src);
    expect(match, "_RESULT_ROW_IDS not found in facts.py").toBeTruthy();
    const engineIds = Array.from(match![1].matchAll(/"([^"]+)"/g)).map((m) => m[1]);
    expect(RESULT_ROW_IDS.slice().sort()).toEqual(engineIds.slice().sort());
  });

  it("ENGINE_MONEY_FACTS matches engine.api._ratio_units._MONEY_FACTS", () => {
    const src = readRepo("src/engine/api/_ratio_units.py");
    const match = /_MONEY_FACTS\s*=\s*frozenset\(\[([\s\S]*?)\]\)/.exec(src);
    expect(match, "_MONEY_FACTS not found in _ratio_units.py").toBeTruthy();
    const engineNames = Array.from(match![1].matchAll(/"([^"]+)"/g)).map((m) => m[1]);
    expect(ENGINE_MONEY_FACTS.slice().sort()).toEqual(
      Array.from(new Set(engineNames)).sort(),
    );
  });

  it("ENGINE_CAPSULE_METRICS matches _capsule_tools.METRICS", () => {
    const src = readRepo("src/engine/api/_capsule_tools.py");
    const block = /METRICS = MappingProxyType\(\{([\s\S]*?)\n\}\)/.exec(src);
    expect(block, "METRICS registry not found in _capsule_tools.py").toBeTruthy();
    const engineNames = Array.from(
      block![1].matchAll(/_(?:money|ratio)_metric\(\s*"([^"]+)"/g),
    ).map((m) => m[1]);
    expect(engineNames.length).toBeGreaterThan(10);
    expect(ENGINE_CAPSULE_METRICS.slice().sort()).toEqual(engineNames.slice().sort());
  });

  it("flags every money fact the engine has NOT declared", () => {
    const index = buildFactIndex(twoPeriodSnapshot());
    const undeclared = Array.from(
      new Set(
        index.facts
          .filter((f) => f.unit === "money" && f.source !== "statement_line" &&
                         f.engineDeclared === false)
          .map((f) => f.factKey),
      ),
    ).sort();
    // These are FE-resolvable but absent from `_ratio_units._MONEY_FACTS`.
    // They are safe here (every FactRef declares its own unit) but a
    // finding that cited one would resolve to UNIT_UNKNOWN — a refusal.
    // Pinned so the list cannot grow silently; see the lane write-up.
    expect(undeclared).toEqual(["non_current_assets", "non_current_liabilities"]);
  });
});

describe("lookupFacts", () => {
  const index = buildFactIndex(twoPeriodSnapshot());

  it("returns both periods' facts for one term, active first", () => {
    const hits = lookupFacts(index, ["total assets"]);
    expect(hits).toHaveLength(2);
    expect(hits[0].periodId).toBe("p-carniprod");
    expect(hits[1].periodId).toBe("p-retail");
  });

  it("reaches every statement line an account code appears on", () => {
    // 461 sits on `ar_intercompany` in both periods and additionally on
    // the retail period's `ap_intercompany` (451, 461). One code naming
    // two rows must surface BOTH — dropping one would hide half the
    // balance behind the number the user actually typed.
    const keys = Array.from(new Set(lookupFacts(index, ["461"]).map((f) => f.factKey)));
    expect(keys.slice().sort())
      .toEqual(["bs.row.ap_intercompany", "bs.row.ar_intercompany"]);
  });

  it("matches Romanian with and without diacritics", () => {
    const withDiacritics = lookupFacts(index, ["cifră de afaceri"]);
    const without = lookupFacts(index, ["cifra de afaceri"]);
    expect(withDiacritics.map((f) => f.factKey))
      .toEqual(without.map((f) => f.factKey));
    expect(without[0].factKey).toBe("revenue");
  });

  it("dedupes and stays deterministic across term order permutations", () => {
    const a = lookupFacts(index, ["cash", "cash", "numerar"]);
    const b = lookupFacts(index, ["numerar", "cash"]);
    expect(a.map((f) => `${f.factKey}@${f.periodId}`))
      .toEqual(b.map((f) => `${f.factKey}@${f.periodId}`));
  });

  it("returns nothing for a term the index does not know", () => {
    expect(lookupFacts(index, ["dividend yield"])).toEqual([]);
  });
});

describe("render helpers", () => {
  const index = buildFactIndex(twoPeriodSnapshot());

  it("maps every emitted unit onto an Amount kind", () => {
    for (const fact of index.facts) {
      expect(["money", "percent", "multiple", "count"])
        .toContain(amountKindFor(fact.unit));
    }
  });

  it("builds provenance only when something is behind the figure", () => {
    const line = factFor(index, "bs.row.ar_intercompany")!;
    const provenance = amountProvenanceFor(line)!;
    expect(provenance.source).toContain("461");
    expect(amountProvenanceFor({
      factKey: "x", label: "x", value: 1, unit: "count",
      periodId: "p", periodLabel: "L",
    })).toBeNull();
  });

  it("standing context is facts, never prose", () => {
    const facts = standingContextFacts(index);
    expect(facts.length).toBeGreaterThan(5);
    for (const fact of facts) {
      expect(fact.periodId).toBe("p-carniprod");
      expect(typeof fact.value).toBe("number");
    }
  });
});

describe("the drift period stays honest", () => {
  const index = buildFactIndex({
    periods: [{ periodId: "p-drift", periodLabel: "FY 2025", statements: drift }],
  });

  it("reports the engine's MINOR_DRIFT status and its real difference", () => {
    expect(index.periods[0].bsStatus).toBe("MINOR_DRIFT");
    expect(factFor(index, "difference")!.value).toBe(drift.canonical_bs!.difference);
    expect(factFor(index, "difference")!.value).not.toBe(0);
  });

  it("carries the engine's diagnosis CODES and none of its detail strings", () => {
    const codes = index.periods[0].diagnosisCodes;
    expect(codes.length).toBeGreaterThan(0);
    const served = drift.canonical_bs!.diagnosis ?? [];
    expect(codes.slice()).toEqual(served.map((d) => d.code));
    // A `detail` string carries figures; only the codes travel. The real
    // code shape is D<n>_<REASON> (e.g. D1_SOURCE_IMBALANCED), never a
    // sentence and never a number.
    for (const code of codes) expect(code).toMatch(/^D\d+(?:_[A-Z_]+)?$/);
    expect(codes.join(" ")).not.toMatch(/\d{3,}/);
  });
});

describe("finding_count — loaded and not-loaded are different states", () => {
  it("is absent when no findings array was supplied", () => {
    const index = buildFactIndex({
      periods: [{ periodId: "p", periodLabel: "FY 2025", statements: carniprod }],
    });
    expect(factFor(index, "finding_count")).toBeNull();
  });

  it("is zero — a real, loaded zero — for an empty array", () => {
    const index = buildFactIndex({
      periods: [{
        periodId: "p", periodLabel: "FY 2025", statements: carniprod, findings: [],
      }],
    });
    expect(factFor(index, "finding_count")!.value).toBe(0);
    expect(factFor(index, "finding_count")!.unit).toBe("count");
  });
});

describe("vocabulary hygiene", () => {
  it("has no metric term that is a bare single letter or empty", () => {
    for (const [key, terms] of Object.entries(METRIC_TERMS)) {
      for (const term of terms) {
        expect(term.trim().length, `${key}: ${JSON.stringify(term)}`)
          .toBeGreaterThan(1);
      }
    }
  });

  it("has no term claimed by two different metrics", () => {
    const owner = new Map<string, string>();
    for (const [key, terms] of Object.entries(METRIC_TERMS)) {
      for (const term of terms) {
        const previous = owner.get(term);
        expect(previous, `"${term}" is claimed by both ${previous} and ${key}`)
          .toBeUndefined();
        owner.set(term, key);
      }
    }
  });
});
