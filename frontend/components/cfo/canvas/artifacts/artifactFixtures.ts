// THE ARTIFACTS — FIXTURES.
//
// ── TC-1, and how far it can be honoured here ────────────────────────
//
// The convention says a fixture representing engine output must be
// CAPTURED from a real run, never hand-built, because a hand-built one
// encodes the author's belief about the shape and then passes forever
// precisely because it was built to.
//
// The evidence objects below are therefore NOT literals. Every one is
// produced by running the PRODUCTION retrieval path —
// `planRetrieval` → `runPlan` → `mergeEvidence` — over the capsule
// lane's own tool transport. The object under test is built by the same
// merge that builds it in production, including the collision renaming,
// the currency rule and the gap typing. If `mergeEvidence` changes its
// shape, these fixtures change with it and the gates see it.
//
// What is NOT captured from a live engine is the tool PAYLOAD, because
// `capsuleAnswerFixtures` synthesises it from the plan's own arguments —
// and that module explains why in its own header: a hand-written blob
// drifts from the contract silently, whereas a synthesiser that reads
// `step.args` breaks loudly the moment the planner sends something the
// tool layer does not accept. Inheriting that transport is the closest
// thing to real output available on this side of the wire; what it
// cannot prove is that the ENGINE still emits these field names, which
// is what `capsuleAnswerClient.test` and the engine's own contract
// suite are for.
//
// The SPECS are hand-written on purpose — they stand in for the model,
// and a model's output is exactly the thing that must not be captured
// and trusted.

import {
  planRetrieval,
  runPlan,
  type RetrievalContext,
} from "@/components/instrument/shell/capsuleAnswer/capsuleRetrieval";
import {
  FIXTURE_PERIODS,
  fixtureToolTransport,
} from "@/components/instrument/shell/capsuleAnswer/capsuleAnswerFixtures";
import type { CapsuleEvidence } from "@/components/instrument/shell/capsuleAnswer/capsuleAnswerTypes";

import {
  ARTIFACT_SPEC_VERSION,
  type ChartSpec,
  type ComparisonSpec,
  type DocumentSpec,
  type FindingSpec,
  type ScenarioSpec,
  type SlideSpec,
  type SpreadsheetSpec,
  type TableSpec,
} from "./artifactSpec";

const CONTEXT: RetrievalContext = {
  periodId: FIXTURE_PERIODS[0].id,
  periodLabel: FIXTURE_PERIODS[0].label,
  periods: FIXTURE_PERIODS.map((p) => ({ id: p.id, label: p.label })),
};

/** Run one question through the real retrieval path. */
export async function evidenceFor(question: string): Promise<CapsuleEvidence> {
  const steps = planRetrieval(question, CONTEXT);
  const { evidence } = await runPlan(steps, fixtureToolTransport(0));
  return evidence;
}

/** The four questions the fixtures below are built on. Named so a gate
 *  can assert it examined all four rather than one that happened to
 *  work (TC-6 — per component, not per sum). */
export const FIXTURE_QUESTIONS = Object.freeze({
  /** One period, several metrics — the table / spreadsheet / slide base. */
  snapshot: "what are total assets, equity and revenue",
  /** Four periods of one metric — the line/bar chart base. */
  trend: "revenue trend",
  /** Two periods — the comparison base. */
  compare: "revenue vs last year",
  /** Ratios, for the scenario outputs. */
  ratios: "current ratio and ebitda margin",
});

// ══════════════════════════════════════════════════════════════════════
// SPECS — written the way a model would write them
// ══════════════════════════════════════════════════════════════════════

const V = ARTIFACT_SPEC_VERSION;

export function barChartSpec(facts: readonly string[], labels: readonly string[]): ChartSpec {
  return {
    version: V,
    kind: "chart",
    title: "Revenue by period",
    form: "bar",
    series: [{ label: "Revenue", points: facts.slice(), pointLabels: labels.slice() }],
  };
}

export function lineChartSpec(facts: readonly string[], labels: readonly string[]): ChartSpec {
  return { ...barChartSpec(facts, labels), form: "line", title: "Revenue trend" };
}

export function stackedChartSpec(a: readonly string[], b: readonly string[]): ChartSpec {
  return {
    version: V,
    kind: "chart",
    title: "Assets and liabilities",
    form: "stacked",
    series: [
      { label: "Equity", points: a.slice() },
      { label: "Liabilities", points: b.slice() },
    ],
  };
}

export function donutChartSpec(facts: readonly string[]): ChartSpec {
  return {
    version: V,
    kind: "chart",
    title: "Composition",
    form: "donut",
    series: [{ label: "Split", points: facts.slice() }],
  };
}

/** The signature chart. `total` names the engine's own closing figure so
 *  the resolver can DISAGREE with the sum of the steps out loud. */
export function waterfallSpec(
  steps: readonly string[],
  labels: readonly string[],
  total?: string,
): ChartSpec {
  const spec: ChartSpec = {
    version: V,
    kind: "chart",
    title: "EBITDA bridge",
    form: "waterfall",
    series: [{ label: "Bridge", points: steps.slice(), pointLabels: labels.slice() }],
  };
  if (total) spec.total = total;
  return spec;
}

export function tableSpec(rows: ReadonlyArray<{ label: string; fact: string | null; accounts?: string[] }>, total?: string | null): TableSpec {
  const spec: TableSpec = {
    version: V,
    kind: "table",
    title: "Balance sheet detail",
    columns: [
      { label: "Line", role: "label" },
      { label: "Amount", role: "value" },
    ],
    rows: rows.map((r) => ({
      label: r.label,
      cells: [r.fact],
      ...(r.accounts ? { accounts: r.accounts } : {}),
    })),
  };
  if (total !== undefined && total !== null) {
    spec.totalRow = { label: "Total", cells: [total] };
  }
  return spec;
}

export function spreadsheetSpec(table: TableSpec): SpreadsheetSpec {
  return {
    version: V,
    kind: "spreadsheet",
    title: "Balance sheet workbook",
    sheets: [
      {
        name: "Balance sheet",
        columns: table.columns,
        rows: table.rows,
        totalRow: table.totalRow,
        liveTotals: true,
      },
    ],
  };
}

export function slideSpec(facts: readonly string[], labels: readonly string[]): SlideSpec {
  return {
    version: V,
    kind: "slide",
    title: "Board pack",
    slides: [
      {
        heading: "Where the period landed",
        blocks: [
          { block: "headline", lines: ["The balance sheet closed reconciled."] },
          { block: "metrics", facts: facts.slice(), factLabels: labels.slice() },
          { block: "bullets", lines: ["Liquidity held.", "Leverage unchanged."] },
        ],
      },
    ],
  };
}

export function documentSpec(fact: string): DocumentSpec {
  return {
    version: V,
    kind: "document",
    title: "Period note",
    sections: [
      {
        heading: "Summary",
        paragraphs: [`The period closed with total assets of {{money:${fact}}}.`],
      },
    ],
  };
}

export function scenarioSpec(outputs: readonly string[]): ScenarioSpec {
  return {
    version: V,
    kind: "scenario",
    title: "Sensitivity",
    drivers: [
      { driver: "revenue", label: "artifact.driver.revenue", span: "normal" },
      { driver: "expenses", label: "artifact.driver.expenses", span: "normal" },
    ],
    outputs: outputs.slice(),
  };
}

export function comparisonSpec(
  rows: readonly string[],
  columns: ReadonlyArray<{ label: string; standard: string; currency?: string; cells: Array<string | null> }>,
): ComparisonSpec {
  return {
    version: V,
    kind: "comparison",
    title: "Period vs period",
    basis: "period",
    rows: rows.slice(),
    columns: columns.map((c) => ({ ...c, cells: c.cells.slice() })),
  };
}

export function findingSpec(facts: readonly string[]): FindingSpec {
  return {
    version: V,
    kind: "finding",
    title: "Concentration in other debtors",
    findingKey: "liquidity_cash_tight",
    facts: facts.slice(),
  };
}
