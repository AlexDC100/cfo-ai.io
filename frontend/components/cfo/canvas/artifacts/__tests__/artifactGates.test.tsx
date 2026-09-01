// THE ARTIFACTS — GATES B1..B9.
//
// Part B's contract, asserted. Every gate here follows the conventions
// in docs/engine_book/testing_conventions.md, and the three that bite
// hardest are worth naming at the top because they shaped the file:
//
//   TC-3  a census that finds nothing is a BROKEN gate. Every discovery
//         loop below records what it examined, and the floors are
//         asserted AFTER the loop, never inside it.
//   TC-6  a recorded expectation PER COMPONENT. The components here are
//         the EIGHT ARTIFACT KINDS. A single total would let one kind
//         collapse to zero while the sum stayed healthy — which is
//         exactly how `import-boundary` printed "boundary holds" with a
//         live violation planted. So `WORK` is a per-kind map and every
//         entry is checked.
//   TC-9  would a clean result be distinguishable from "no subject"?
//         The DOM law returning zero offenders is meaningless on a
//         render that produced zero figures, so every DOM-law assertion
//         is paired with an ATTRIBUTED-FIGURE COUNT.
//
// The plant log — what was planted, the RED observed, the revert — is in
// design_review/artifacts/GATES.md.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";

import { TestProviders } from "@/test/renderWithProviders";
import type {
  CapsuleEvidence,
} from "@/components/instrument/shell/capsuleAnswer/capsuleAnswerTypes";

import {
  ARTIFACT_KINDS,
  ARTIFACT_SPEC_VERSION,
  guardArtifactSpec,
  parseArtifactSpec,
  type ArtifactSpec,
} from "../artifactSpec";
import { SCENARIO_REGISTRY, evaluateScenario, evaluateExclusion, restPositions, DRIVERS, OUTPUTS } from "../artifactScenario";
import { resolveChart, resolveTable, figuresOf } from "../artifactResolve";
import {
  barLayout,
  donutLayout,
  lineLayout,
  scaleOf,
  stackLayout,
  waterfallLayout,
} from "../artifactGeometry";
import {
  applyRefine,
  canUndo,
  currentVersion,
  newHistory,
  parseRefineDirective,
  planRefine,
  undo,
} from "../artifactRefine";
import { Artifact } from "../Artifact";
import { ChartArtifact, chartFrom } from "../ChartArtifact";
import { TableArtifact, tableFrom } from "../TableArtifact";
import { ComparisonArtifact, comparisonFrom } from "../ComparisonArtifact";
import { SlideArtifact, slideDeckFrom } from "../SlideArtifact";
import { SpreadsheetArtifact, spreadsheetFrom } from "../SpreadsheetArtifact";
import { ScenarioArtifact } from "../ScenarioArtifact";
import { DocumentArtifact, documentExportSections } from "../DocumentArtifact";
import { FindingArtifact } from "../FindingArtifact";
import {
  barChartSpec,
  comparisonSpec,
  documentSpec,
  donutChartSpec,
  evidenceFor,
  findingSpec,
  FIXTURE_QUESTIONS,
  lineChartSpec,
  scenarioSpec,
  slideSpec,
  spreadsheetSpec,
  stackedChartSpec,
  tableSpec,
  waterfallSpec,
} from "../artifactFixtures";
import {
  PROVENANCE_ATTRS,
  attributedFigureCount,
  unattributedFigures,
} from "./artifactDomLaw";

afterEach(cleanup);

// ══════════════════════════════════════════════════════════════════════
// WORK CENSUS — per kind, asserted at the end (TC-3 / TC-6 / TC-9)
// ══════════════════════════════════════════════════════════════════════

type Kind = (typeof ARTIFACT_KINDS)[number];

const WORK: Record<Kind, { guarded: number; planted: number; rendered: number; figures: number }> =
  Object.fromEntries(
    ARTIFACT_KINDS.map((k) => [k, { guarded: 0, planted: 0, rendered: 0, figures: 0 }]),
  ) as Record<Kind, { guarded: number; planted: number; rendered: number; figures: number }>;

function noteGuard(kind: Kind) {
  WORK[kind].guarded += 1;
}
function notePlant(kind: Kind) {
  WORK[kind].planted += 1;
}
function noteRender(kind: Kind, figures: number) {
  WORK[kind].rendered += 1;
  WORK[kind].figures += figures;
}

/** TC-7 — the census must name WHICH COMPONENT rendered, not merely
 *  that figures appeared somewhere in the container.
 *
 *  The first draft did not, and a refuter proved it: deleting
 *  `data-testid="artifact-comparison"` from `ComparisonArtifact` left
 *  all 43 tests GREEN, because the figures inside it still rendered and
 *  nothing was bound to the component that produced them. That is the
 *  Capsule lane's own `CapsuleJumpList` miss in a new suite — a fix (or
 *  a break) applied to a surface no assertion was looking at. */
const ROOT_TESTID: Record<Kind, string> = {
  chart: "artifact-chart",
  table: "artifact-table",
  spreadsheet: "artifact-spreadsheet",
  slide: "artifact-slides",
  document: "artifact-document",
  scenario: "artifact-scenario",
  comparison: "artifact-comparison",
  finding: "artifact-finding",
};

/** Every kind must have been guarded, planted against, and RENDERED at
 *  least once. The figure floors are per kind and per THIS fixture set;
 *  a kind that stops resolving figures fails even while the others keep
 *  the total healthy. */
const FIGURE_FLOOR: Record<Kind, number> = {
  // Measured on the fixtures below (chart 10, table 8, spreadsheet 8,
  // slide 6, document 2, scenario 5, comparison 4, finding 4), then
  // rounded DOWN with slack. Floors exist to catch a COLLAPSE — a kind
  // that stops resolving figures — not to ratchet a count upward.
  chart: 8,
  table: 6,
  spreadsheet: 6,
  slide: 4,
  document: 2,
  scenario: 4,
  comparison: 4,
  finding: 3,
};

// ══════════════════════════════════════════════════════════════════════
// Fixtures, loaded once
// ══════════════════════════════════════════════════════════════════════

let snapshot: CapsuleEvidence;
let trend: CapsuleEvidence;
let compare: CapsuleEvidence;
let ratios: CapsuleEvidence;
/** revenue + expenses + net_result on ONE period — the scenario parity
 *  probe needs all three, or `verifiedCount` is zero and the parity
 *  claim would be vacuous (TC-9). */
let pnl: CapsuleEvidence;

beforeAll(async () => {
  snapshot = await evidenceFor(FIXTURE_QUESTIONS.snapshot);
  trend = await evidenceFor(FIXTURE_QUESTIONS.trend);
  compare = await evidenceFor(FIXTURE_QUESTIONS.compare);
  ratios = await evidenceFor(FIXTURE_QUESTIONS.ratios);
  pnl = await evidenceFor("revenue, expenses and net profit");
});

function renderIn(ui: React.ReactElement) {
  return render(<TestProviders>{ui}</TestProviders>);
}

/** Ordered trend fact names, oldest → newest, as the merge produced
 *  them. Derived from `factMeta.step` rather than assumed, because the
 *  merge's renaming rule is the thing under test elsewhere and must not
 *  be re-implemented here. */
function trendFacts(): { facts: string[]; labels: string[] } {
  const metas = Object.values(trend.factMeta).sort((a, b) => a.step - b.step);
  return {
    facts: metas.map((m) => m.fact),
    labels: metas.map((m) => m.periodLabel ?? ""),
  };
}

// ══════════════════════════════════════════════════════════════════════
// B1 — A MODEL DIGIT IS REJECTED AT PARSE
// ══════════════════════════════════════════════════════════════════════

describe("B1 — the model composes; a digit it typed never becomes a figure", () => {
  /** One clean spec per kind, plus the plant that must break it. */
  function specsFor(): Array<{ kind: Kind; spec: ArtifactSpec; plant: (s: any) => void }> {
    const { facts, labels } = trendFacts();
    const snapFacts = Object.keys(snapshot.facts);
    const cmpFacts = Object.keys(compare.factMeta).filter((f) => !f.endsWith("_delta"));
    const table = tableSpec(
      snapFacts.map((f) => ({ label: f, fact: f })),
      snapFacts[0],
    );
    return [
      {
        kind: "chart",
        spec: barChartSpec(facts, labels),
        // The most tempting exception in the whole lane: "it is just an
        // axis tick". A tick the model typed is a measurement with no
        // source cell, so it is refused like any other digit.
        plant: (s) => {
          s.series[0].pointLabels[0] = "Q4 1999";
        },
      },
      {
        kind: "table",
        spec: table,
        plant: (s) => {
          s.rows[0].label = "Cash 1 234 567";
        },
      },
      {
        kind: "spreadsheet",
        spec: spreadsheetSpec(table),
        plant: (s) => {
          s.sheets[0].name = "Sheet 2024 totals 88";
        },
      },
      {
        kind: "slide",
        spec: slideSpec(snapFacts, snapFacts),
        plant: (s) => {
          s.slides[0].blocks[0].lines[0] = "Revenue reached 413,727,560 RON.";
        },
      },
      {
        kind: "document",
        spec: documentSpec(snapFacts[0]),
        plant: (s) => {
          s.sections[0].paragraphs[0] = "Total assets were 293,050,085 RON.";
        },
      },
      {
        kind: "scenario",
        spec: scenarioSpec(["net_result", "net_margin"]),
        // A NUMBER TYPE anywhere in the tree, in a field the schema does
        // not even define. L1 scans the RAW object, so a number hiding in
        // an unknown field is caught before any narrowing.
        plant: (s) => {
          s.drivers[0].step = 0.05;
        },
      },
      {
        kind: "comparison",
        spec: comparisonSpec(
          ["Revenue"],
          [
            { label: "A", standard: "RAS/IFRS", cells: [cmpFacts[0]] },
            { label: "B", standard: "RAS/IFRS", cells: [cmpFacts[1]] },
          ],
        ),
        plant: (s) => {
          s.columns[0].label = "FY2019";
        },
      },
      {
        kind: "finding",
        spec: findingSpec(snapFacts.slice(0, 2)),
        plant: (s) => {
          s.title = "Account 461 holds 7,692,203";
        },
      },
    ];
  }

  it("ACCEPTS a clean spec for every one of the eight kinds", () => {
    for (const { kind, spec } of specsFor()) {
      const r = guardArtifactSpec(spec, evidenceFor_(kind), SCENARIO_REGISTRY);
      expect(r.ok, `${kind}: ${JSON.stringify(r.violations)}`).toBe(true);
      // TC-9: an "ok" verdict on a walk that examined nothing is not a
      // verdict. Every kind must have examined real positions.
      expect(r.examined, `${kind} examined nothing`).toBeGreaterThan(4);
      noteGuard(kind);
    }
  });

  it("REFUSES the planted digit in every one of the eight kinds", () => {
    for (const { kind, spec, plant } of specsFor()) {
      const planted = JSON.parse(JSON.stringify(spec));
      plant(planted);
      const r = guardArtifactSpec(planted, evidenceFor_(kind), SCENARIO_REGISTRY);
      expect(r.ok, `${kind} accepted a model digit`).toBe(false);
      // TC-2: a RED for the wrong reason is not evidence. The violation
      // must name the numeral, not some unrelated shape complaint.
      const kinds = r.violations.map((v) => v.kind);
      expect(
        kinds.includes("numeral") || kinds.includes("number_literal"),
        `${kind} refused for the wrong reason: ${JSON.stringify(r.violations)}`,
      ).toBe(true);
      expect(parseArtifactSpec(planted, evidenceFor_(kind), SCENARIO_REGISTRY)).toBeNull();
      notePlant(kind);
    }
  });

  it("REFUSES a fact the retrieval never returned — the second shape of fabrication", () => {
    const { labels } = trendFacts();
    const spec = barChartSpec(["revenue_from_thin_air"], labels.slice(0, 1));
    const r = guardArtifactSpec(spec, trend, SCENARIO_REGISTRY);
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.kind)).toContain("unknown_fact");
  });

  it("REFUSES an account code the evidence never mentioned — fabricated provenance", () => {
    const f = Object.keys(snapshot.facts)[0];
    const spec = tableSpec([{ label: "Cash", fact: f, accounts: ["5121"] }]);
    const r = guardArtifactSpec(spec, snapshot, SCENARIO_REGISTRY);
    expect(r.violations.map((v) => v.kind)).toContain("unknown_account");
  });

  it("REFUSES a series that mixes a money fact with a ratio — two rulers, one axis", () => {
    const money = Object.keys(ratios.factMeta).find((f) => ratios.factMeta[f].unit === "money");
    const ratio = Object.keys(ratios.factMeta).find((f) => ratios.factMeta[f].unit === "ratio");
    expect(money && ratio, "the ratios fixture lost one of its two units").toBeTruthy();
    const spec = barChartSpec([money as string, ratio as string], ["a", "b"]);
    const r = guardArtifactSpec(spec, ratios, SCENARIO_REGISTRY);
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.kind)).toContain("unit_mixed");
  });

  it("REFUSES a spec stamped with a contract version this build does not speak", () => {
    const { facts, labels } = trendFacts();
    const spec = { ...barChartSpec(facts, labels), version: "as0" };
    const r = guardArtifactSpec(spec, trend, SCENARIO_REGISTRY);
    expect(r.violations.map((v) => v.kind)).toContain("bad_version");
  });

  function evidenceFor_(kind: Kind): CapsuleEvidence {
    if (kind === "chart") return trend;
    if (kind === "comparison") return compare;
    if (kind === "scenario") return pnl;
    return snapshot;
  }
});

// ══════════════════════════════════════════════════════════════════════
// B2 — THE DOM LAW: every rendered digit names where it came from
// ══════════════════════════════════════════════════════════════════════

describe("B2 — a rendered figure is attributed, or it is a violation", () => {
  it("holds across every artifact kind that renders figures", async () => {
    const { facts, labels } = trendFacts();
    const snapFacts = Object.keys(snapshot.facts);
    const cmpFacts = Object.keys(compare.factMeta).filter((f) => !f.endsWith("_delta"));
    const table = tableSpec(
      snapFacts.map((f) => ({ label: f, fact: f })),
      snapFacts[0],
    );

    const cases: Array<{ kind: Kind; ui: React.ReactElement; allowed: readonly string[] }> = [
      {
        kind: "chart",
        ui: <ChartArtifact chart={chartFrom(barChartSpec(facts, labels), trend).chart} />,
        allowed: trend.literals,
      },
      {
        kind: "table",
        ui: <TableArtifact table={tableFrom(table, snapshot).table} />,
        allowed: snapshot.literals,
      },
      {
        kind: "spreadsheet",
        ui: (
          <SpreadsheetArtifact
            spreadsheet={spreadsheetFrom(spreadsheetSpec(table), snapshot).spreadsheet}
          />
        ),
        allowed: snapshot.literals,
      },
      {
        kind: "slide",
        ui: <SlideArtifact deck={slideDeckFrom(slideSpec(snapFacts, snapFacts), snapshot).deck} />,
        allowed: snapshot.literals,
      },
      {
        kind: "comparison",
        ui: (
          <ComparisonArtifact
            comparison={
              comparisonFrom(
                comparisonSpec(
                  ["Revenue"],
                  [
                    { label: "Earlier", standard: "RAS/IFRS", cells: [cmpFacts[0]] },
                    { label: "Later", standard: "RAS/IFRS", cells: [cmpFacts[1]] },
                  ],
                ),
                compare,
              ).comparison
            }
          />
        ),
        allowed: compare.literals,
      },
      {
        kind: "scenario",
        ui: <ScenarioArtifact spec={scenarioSpec(["net_result", "net_margin"])} evidence={pnl} />,
        allowed: pnl.literals,
      },
      {
        kind: "finding",
        ui: <FindingArtifact spec={findingSpec(snapFacts.slice(0, 2))} evidence={snapshot} />,
        allowed: snapshot.literals,
      },
      {
        kind: "document",
        ui: <DocumentArtifact spec={documentSpec(snapFacts[0])} evidence={snapshot} />,
        allowed: snapshot.literals,
      },
    ];

    for (const { kind, ui, allowed } of cases) {
      const { container, unmount } = renderIn(ui);
      // TC-7 FIRST: bind the count to the component that produced it.
      expect(
        container.querySelector(`[data-testid="${ROOT_TESTID[kind]}"]`),
        `${kind}: ${ROOT_TESTID[kind]} did not render, so any count below describes something else`,
      ).toBeTruthy();
      const offenders = unattributedFigures(container, allowed);
      const attributed = attributedFigureCount(container);
      // TC-9 — "zero offenders" on a render with zero figures is the
      // no-subject result wearing the clean result's clothes.
      const expectedFloor = Math.max(FIGURE_FLOOR[kind], 1);
      expect(
        attributed,
        `${kind}: ${attributed} attributed figure(s), floor ${expectedFloor} — nothing was examined`,
      ).toBeGreaterThanOrEqual(expectedFloor);
      expect(offenders, `${kind}: ${JSON.stringify(offenders)}`).toHaveLength(0);
      noteRender(kind, attributed);
      unmount();
    }
    expect(cases.map((c) => c.kind).sort()).toEqual([...ARTIFACT_KINDS].sort());
  });

  it("CATCHES a bare numeral planted beside the artifact — the law has teeth", () => {
    const { facts, labels } = trendFacts();
    const { container } = renderIn(
      <div>
        <ChartArtifact chart={chartFrom(barChartSpec(facts, labels), trend).chart} />
        {/* THE PLANT: a figure typed straight into the DOM, exactly as a
            model-authored axis label would arrive. */}
        <span>Revenue 413,727,560 RON</span>
      </div>,
    );
    const offenders = unattributedFigures(container, trend.literals);
    expect(offenders.length, "the DOM law missed a bare numeral — B2 has no teeth").toBeGreaterThan(0);
  });

  it("has not drifted from the Capsule lane's own attribute list", () => {
    // The list here is a deliberate copy (see artifactDomLaw.ts). This
    // is the alarm that keeps the copy honest: one law, two call sites.
    const source = readFileSync(
      join(process.cwd(), "frontend/lib/__tests__/capsuleGates.test.ts"),
      "utf8",
    );
    const block = /const PROVENANCE_ATTRS = \[([\s\S]*?)\];/.exec(source);
    expect(block, "could not find PROVENANCE_ATTRS in capsuleGates.test.ts").toBeTruthy();
    const theirs = Array.from((block as RegExpExecArray)[1].matchAll(/"([^"]+)"/g)).map((m) => m[1]);
    expect(theirs.sort()).toEqual([...PROVENANCE_ATTRS].sort());
  });
});

// ══════════════════════════════════════════════════════════════════════
// B3 — ABSENT IS NOT ZERO
// ══════════════════════════════════════════════════════════════════════

describe("B3 — an absence renders as an absence, never as zero", () => {
  it("a null cell resolves to a typed absence carrying no value at all", () => {
    const f = Object.keys(snapshot.facts)[0];
    const { table } = resolveTable(
      tableSpec([{ label: "Present", fact: f }, { label: "Absent", fact: null }]),
      snapshot,
    );
    const absent = table.rows[1].cells[0].figure;
    expect(absent.present).toBe(false);
    // The discriminated union is the enforcement: there is no `value`
    // field on the absent branch, so a renderer cannot read a zero off it.
    expect(Object.prototype.hasOwnProperty.call(absent, "value")).toBe(false);
  });

  it("renders the missing glyph and no zero", () => {
    const f = Object.keys(snapshot.facts)[0];
    const { container } = renderIn(
      <TableArtifact
        table={resolveTable(tableSpec([{ label: "Absent", fact: null }, { label: "Present", fact: f }]), snapshot).table}
      />,
    );
    expect(container.querySelectorAll('[data-absent="true"]').length).toBe(1);
    const absentCell = container.querySelector('[data-absent="true"]') as HTMLElement;
    expect(absentCell.textContent).not.toMatch(/\d/);
  });

  it("drops a chart series whole rather than plotting a gap at zero", () => {
    const { facts, labels } = trendFacts();
    const withHole = [...facts];
    withHole[1] = "not_a_fact";
    const { chart } = resolveChart(
      { ...barChartSpec(withHole, labels), version: ARTIFACT_SPEC_VERSION },
      trend,
    );
    // A missing point would silently reshape the claim — a downward
    // trend can become a flat one by losing its last bar.
    expect(chart.series).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════
// B4 — THE WATERFALL RECONCILES, OR SAYS SO
// ══════════════════════════════════════════════════════════════════════

describe("B4 — the bridge sums in minor units and never adjusts a total to fit", () => {
  /** A small bridge whose steps DO add to a named total, built from the
   *  compare fixture (two levels + the engine's own delta). */
  function bridgeEvidence(): { evidence: CapsuleEvidence; steps: string[]; total: string } {
    const facts = Object.keys(compare.factMeta);
    const a = facts.find((f) => f.endsWith("_a")) as string;
    const delta = facts.find((f) => f.endsWith("_delta")) as string;
    const b = facts.find((f) => f.endsWith("_b")) as string;
    return { evidence: compare, steps: [a, delta], total: b };
  }

  it("agrees when the steps reproduce the engine's own closing total", () => {
    const { evidence, steps, total } = bridgeEvidence();
    const { chart } = resolveChart(
      waterfallSpec(steps, ["Opening", "Movement"], total),
      evidence,
    );
    expect(chart.steps, "the bridge refused — the fixture lost its minor units").not.toBeNull();
    expect(chart.totalAgrees).toBe(true);
    // The comparison is on INTEGER minor units, not floats.
    const last = (chart.steps as NonNullable<typeof chart.steps>)[1];
    expect(Number.isInteger(last.toMinor)).toBe(true);
    expect(last.toMinor).toBe(
      (chart.total as Extract<typeof chart.total, { present: true }>).minor,
    );
  });

  it("SURFACES a disagreement instead of adjusting either figure", () => {
    const { evidence, steps } = bridgeEvidence();
    // THE PLANT: name a total that is NOT the sum of the steps.
    const wrongTotal = steps[0];
    const { chart } = resolveChart(
      waterfallSpec(steps, ["Opening", "Movement"], wrongTotal),
      evidence,
    );
    expect(chart.totalAgrees).toBe(false);
    const { container } = renderIn(<ChartArtifact chart={chart} />);
    const banner = container.querySelector('[data-testid="artifact-chart-reconciliation"]');
    expect(banner, "a disagreeing bridge rendered no reconciliation banner").toBeTruthy();
    expect(banner?.getAttribute("data-agrees")).toBe("false");
    // BOTH figures are on screen; neither was moved to meet the other.
    expect(container.querySelectorAll("[data-fact]").length).toBeGreaterThanOrEqual(2);
  });

  it("REFUSES to draw a bridge whose steps carry no integer amounts", () => {
    const ratio = Object.keys(ratios.factMeta).find((f) => ratios.factMeta[f].unit === "ratio");
    const { chart } = resolveChart(waterfallSpec([ratio as string], ["Ratio"]), ratios);
    expect(chart.steps).toBeNull();
    const { container } = renderIn(<ChartArtifact chart={chart} />);
    expect(container.querySelector('[data-testid="artifact-chart-empty"]')).toBeTruthy();
  });
});

// ══════════════════════════════════════════════════════════════════════
// B5 — NO CROSS-STANDARD BLENDING
// ══════════════════════════════════════════════════════════════════════

describe("B5 — a comparison is one ruler, or it is refused", () => {
  function cells() {
    return Object.keys(compare.factMeta).filter((f) => !f.endsWith("_delta"));
  }

  it("ACCEPTS one standard and NAMES it on the card", () => {
    const [a, b] = cells();
    const spec = comparisonSpec(
      ["Revenue"],
      [
        { label: "Earlier", standard: "RAS/IFRS", cells: [a] },
        { label: "Later", standard: "RAS/IFRS", cells: [b] },
      ],
    );
    expect(guardArtifactSpec(spec, compare, SCENARIO_REGISTRY).ok).toBe(true);
    const { container } = renderIn(
      <ComparisonArtifact comparison={comparisonFrom(spec, compare).comparison} />,
    );
    const named = container.querySelector('[data-testid="artifact-comparison-standard"]');
    expect(named?.textContent).toContain("RAS/IFRS");
  });

  it("REFUSES two standards — the percentile law, applied to an artifact", () => {
    const [a, b] = cells();
    const spec = comparisonSpec(
      ["Revenue"],
      [
        { label: "BVB", standard: "RAS/IFRS", cells: [a] },
        { label: "US peer", standard: "US_GAAP", cells: [b] },
      ],
    );
    const r = guardArtifactSpec(spec, compare, SCENARIO_REGISTRY);
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.kind)).toContain("cross_standard");
  });

  it("REFUSES two currencies — the same defect wearing FX", () => {
    const [a, b] = cells();
    const spec = comparisonSpec(
      ["Revenue"],
      [
        { label: "RON", standard: "IFRS", currency: "RON", cells: [a] },
        { label: "EUR", standard: "IFRS", currency: "EUR", cells: [b] },
      ],
    );
    const r = guardArtifactSpec(spec, compare, SCENARIO_REGISTRY);
    expect(r.violations.map((v) => v.kind)).toContain("currency_mixed");
  });
});

// ══════════════════════════════════════════════════════════════════════
// B6 — THE SCENARIO REPRODUCES THE ENGINE AT REST, OR WITHHOLDS
// ══════════════════════════════════════════════════════════════════════

describe("B6 — baseline parity is the licence to project", () => {
  it("reproduces the engine EXACTLY at rest, and actually verified something", () => {
    const reading = evaluateScenario(
      pnl,
      ["net_result", "net_margin"],
      restPositions(DRIVERS.map((d) => d.id)),
    );
    // TC-9 — `parityHolds === true` with nothing verified is the
    // no-subject result. The count is asserted first, deliberately.
    expect(
      reading.verifiedCount,
      "nothing was verified, so 'parity holds' would mean nothing",
    ).toBeGreaterThan(0);
    expect(reading.parityHolds).toBe(true);
    for (const o of reading.outputs) {
      if (o.parity === "unverifiable") continue;
      expect(o.parity, `${o.id} drifted by ${o.parityGap}`).toBe("exact");
    }
  });

  it("WITHHOLDS the projection when the transcription disagrees with the engine", () => {
    // THE PLANT: an evidence object whose served `net_result` does not
    // equal revenue − expenses. That is precisely the state a wrong
    // transcription would produce, and the card must not project from it.
    const planted: CapsuleEvidence = {
      ...pnl,
      facts: { ...pnl.facts, net_result: (pnl.facts.net_result ?? 0) * 1.05 },
    };
    const reading = evaluateScenario(planted, ["net_result"], restPositions(["revenue"]));
    expect(reading.verifiedCount).toBeGreaterThan(0);
    expect(reading.parityHolds).toBe(false);
    expect(reading.outputs[0].parity).toBe("drift");

    const { container } = renderIn(
      <ScenarioArtifact spec={scenarioSpec(["net_result"])} evidence={planted} />,
    );
    expect(
      container.querySelector('[data-testid="artifact-scenario-withheld"]'),
      "a drifting scenario projected anyway",
    ).toBeTruthy();
  });

  it("reports 'unverifiable' as its own state, never as agreement", () => {
    // The engine published no `cash_ratio` here, so there is nothing to
    // check against. That must not read as a clean check.
    const reading = evaluateScenario(pnl, ["cash_ratio"], restPositions([]));
    expect(reading.outputs[0].parity).toBe("unverifiable");
    expect(reading.verifiedCount).toBe(0);
  });

  it("moves the result when a lever moves, and only through the registry", () => {
    const base = evaluateScenario(pnl, ["net_result"], restPositions(DRIVERS.map((d) => d.id)));
    const moved = evaluateScenario(pnl, ["net_result"], { revenue: 1.1 });
    expect(moved.outputs[0].value).not.toBe(base.outputs[0].value);
    // The lever scaled the FACT, and the registry formula did the rest.
    expect(moved.applied.revenue).toBeCloseTo((pnl.facts.revenue ?? 0) * 1.1, 6);
  });

  it("offers no slider for a driver the evidence does not carry", () => {
    const { container } = renderIn(
      <ScenarioArtifact spec={scenarioSpec(["net_result"])} evidence={ratios} />,
    );
    // `ratios` carries ebitda + current_ratio, neither of which is a
    // driver this spec names.
    expect(container.querySelectorAll('[data-testid="artifact-scenario-driver"]').length).toBe(0);
  });

  it("a registry dependency always precedes its dependents", () => {
    // `net_margin` reads `net_result`, which is itself an output. The
    // evaluation folds results forward in registry order, so the order
    // is load-bearing rather than cosmetic.
    const ids = OUTPUTS.map((o) => o.id);
    for (const def of OUTPUTS) {
      for (const input of def.inputs) {
        if (!ids.includes(input)) continue;
        expect(
          ids.indexOf(input),
          `${def.id} reads ${input}, which is evaluated after it`,
        ).toBeLessThan(ids.indexOf(def.id));
      }
    }
  });

  it("recomputes without an item, and refuses when the counterfactual would invent a sign", () => {
    const revenue = "revenue";
    const ok = evaluateExclusion(pnl, "net_result", "expenses");
    expect(ok, "the exclusion path returned nothing").toBeTruthy();
    // THE REFUSAL: removing revenue from itself leaves the other operand
    // below the amount removed, so the counterfactual is refused rather
    // than producing a number that never existed.
    const refused = evaluateExclusion(ratios, "net_result", revenue);
    expect(refused?.refusal).toBeTruthy();
  });
});

// ══════════════════════════════════════════════════════════════════════
// B7 — REFINE IS CONVERSATIONAL, VERSIONED AND UNDOABLE
// ══════════════════════════════════════════════════════════════════════

describe("B7 — a refine regenerates in place, and a reshape cannot add a figure", () => {
  it("reads the phrases the brief names, in EN and RO", () => {
    expect(parseRefineDirective("make it quarterly")).toEqual({
      kind: "granularity",
      grain: "quarterly",
    });
    expect(parseRefineDirective("pe trimestre")).toEqual({
      kind: "granularity",
      grain: "quarterly",
    });
    expect(parseRefineDirective("add last year")).toEqual({
      kind: "add_period",
      which: "prior_year",
    });
    expect(parseRefineDirective("exclude intercompany")).toEqual({
      kind: "exclude",
      subject: "intercompany",
    });
    expect(parseRefineDirective("show it as a line")).toEqual({ kind: "chart_form", form: "line" });
  });

  it("escalates a retrieval and reshapes locally — the free path cannot introduce a fact", () => {
    const { facts, labels } = trendFacts();
    const spec = barChartSpec(facts, labels);
    const reshape = planRefine(spec, {}, "show it as a line");
    expect(reshape.mode).toBe("reshape");
    if (reshape.mode === "reshape") {
      // The fact set is IDENTICAL. That is the property that makes the
      // free path safe: a reshape has no way to name a new figure.
      const before = guardArtifactSpec(spec, trend, SCENARIO_REGISTRY).citedFacts;
      const after = guardArtifactSpec(reshape.spec, trend, SCENARIO_REGISTRY).citedFacts;
      expect(after).toEqual(before);
    }
    expect(planRefine(spec, {}, "add last year").mode).toBe("retrieve");
  });

  it("REFUSES a directive that does not apply, by name, instead of appearing to work", () => {
    const plan = planRefine(documentSpec(Object.keys(snapshot.facts)[0]), {}, "make it a waterfall");
    expect(plan.mode).toBe("refused");
  });

  it("versions in place and undoes to the byte-identical previous spec", () => {
    const { facts, labels } = trendFacts();
    const spec = barChartSpec(facts, labels);
    let history = newHistory(spec);
    expect(canUndo(history)).toBe(false);
    const plan = planRefine(spec, {}, "show it as a line");
    history = applyRefine(history, plan, "show it as a line");
    expect(history.versions).toHaveLength(2);
    expect((currentVersion(history).spec as any).form).toBe("line");
    history = undo(history);
    expect(JSON.stringify(currentVersion(history).spec)).toBe(JSON.stringify(spec));
  });

  it("regenerates IN PLACE on the card — one artifact, a new version", () => {
    const { facts, labels } = trendFacts();
    renderIn(<Artifact spec={barChartSpec(facts, labels)} evidence={trend} />);
    expect(screen.getAllByTestId("artifact-card")).toHaveLength(1);
    const input = screen.getByTestId("artifact-refine-input");
    fireEvent.change(input, { target: { value: "show it as a line" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getAllByTestId("artifact-card")).toHaveLength(1);
    expect(screen.getByTestId("artifact-chart").getAttribute("data-chart-form")).toBe("line");
    expect(screen.getByTestId("artifact-version").textContent).toContain("2");
    fireEvent.click(screen.getByTestId("artifact-undo"));
    expect(screen.getByTestId("artifact-chart").getAttribute("data-chart-form")).toBe("bar");
  });

  it("a refused spec renders the refusal and NOT a partial artifact", () => {
    renderIn(<Artifact spec={barChartSpec(["ghost_fact"], ["x"])} evidence={trend} />);
    expect(screen.getByTestId("artifact-refused")).toBeTruthy();
    expect(screen.queryByTestId("artifact-chart")).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════
// B8 — GEOMETRY IS DETERMINISTIC AND DOES NOT EXAGGERATE
// ══════════════════════════════════════════════════════════════════════

describe("B8 — the same values always draw the same shape", () => {
  const VALUES = [30122880400, 34011229900, 37880114500, 41372756000];

  it("is byte-identical across repeated layouts", () => {
    expect(JSON.stringify(barLayout(VALUES))).toBe(JSON.stringify(barLayout(VALUES)));
    expect(lineLayout(VALUES).path).toBe(lineLayout(VALUES).path);
    expect(JSON.stringify(waterfallLayout([{ from: 0, to: 5 }, { from: 5, to: 3 }]))).toBe(
      JSON.stringify(waterfallLayout([{ from: 0, to: 5 }, { from: 5, to: 3 }])),
    );
    expect(JSON.stringify(donutLayout([1, 2, 3]))).toBe(JSON.stringify(donutLayout([1, 2, 3])));
    expect(JSON.stringify(stackLayout([[1, 2], [3, 4]]))).toBe(
      JSON.stringify(stackLayout([[1, 2], [3, 4]])),
    );
  });

  it("a magnitude scale always includes zero — the axis cannot flatter the data", () => {
    // Four values within 40% of each other. Without a zero baseline the
    // first bar would render as a sliver and the last as full height,
    // which is the single most common way a correct number tells a false
    // story.
    const scale = scaleOf(VALUES);
    expect(scale.min).toBe(0);
    expect(scale.zeroFraction).toBe(0);
    const bars = barLayout(VALUES).bars;
    const ratio = bars[0].h / bars[3].h;
    expect(ratio).toBeGreaterThan(0.5);
  });

  it("REFUSES a share of a whole that includes a negative", () => {
    expect(donutLayout([5, -2, 3]).refused).toBe("negative");
    expect(donutLayout([]).refused).toBe("empty");
    expect(donutLayout([1, 1]).refused).toBeNull();
  });

  it("stacks a negative segment downward rather than folding it into the total", () => {
    const layout = stackLayout([[10], [-4]]);
    const [positive, negative] = layout.columns[0];
    expect(negative.negative).toBe(true);
    // The negative band sits BELOW the positive one; if it had been
    // folded into the column height they would overlap.
    expect(negative.y).toBeGreaterThanOrEqual(positive.y + positive.h - 1);
  });
});

// ══════════════════════════════════════════════════════════════════════
// B9 — THE CARD ALWAYS CITES, AND THE MOTION NEVER MOVES THE LAYOUT
// ══════════════════════════════════════════════════════════════════════

describe("B9 — the citation footer is the card's, not the artifact's", () => {
  it("names period, snapshot and source on every kind", () => {
    const { facts, labels } = trendFacts();
    renderIn(<Artifact spec={barChartSpec(facts, labels)} evidence={trend} trust="reconciled" />);
    const footer = screen.getByTestId("artifact-citation");
    expect(footer.querySelector('[data-citation="period"]')).toBeTruthy();
    expect(footer.querySelector('[data-citation="snapshot"]')).toBeTruthy();
    expect(footer.querySelector('[data-citation="source"]')).toBeTruthy();
    expect(footer.querySelector('[data-citation="trust"]')?.textContent).toContain("reconciled");
  });

  it("says so when the retrieval reported a gap, instead of presenting a partial as complete", () => {
    const { facts, labels } = trendFacts();
    const gapped: CapsuleEvidence = {
      ...trend,
      gaps: [
        {
          kind: "gap",
          tool: "get_facts",
          code: "no_period",
          missing: ["p-2025-08"],
          detail: "",
          fix: "",
          upsell_key: "",
        },
      ],
    };
    renderIn(<Artifact spec={barChartSpec(facts, labels)} evidence={gapped} />);
    expect(
      screen.getByTestId("artifact-citation").querySelector('[data-citation="incomplete"]'),
    ).toBeTruthy();
  });

  it("puts the values in the DOM from the first paint — CLS 0 by construction", () => {
    const { facts, labels } = trendFacts();
    const { container } = renderIn(
      <ChartArtifact chart={chartFrom(barChartSpec(facts, labels), trend).chart} />,
    );
    // No skeleton element stands in for a value; the reveal animates
    // OPACITY over the value's own box, so layout never moves.
    expect(container.querySelectorAll("[data-artifact-skeleton]").length).toBe(0);
    expect(container.querySelectorAll('[data-testid="artifact-chart-bar"]').length).toBe(
      facts.length,
    );
  });

  it("never counts a number up — the figure is right on the first frame", () => {
    // A CALL, not the word. The first draft matched /useCountUp/ and
    // went red on this lane's own header comment ("motion.useCountUp
    // exists in this codebase and is deliberately unused here") — a
    // detector that fires on the prose describing the rule rather than
    // on the rule being broken. Both halves of TC-2 in one line: it was
    // a red for the wrong reason.
    const CALL = /\buseCountUp\s*\(/;

    // TC-3 — the canary. If this detector stopped matching real usage,
    // every file below would pass for the wrong reason.
    const motion = readFileSync(join(process.cwd(), "frontend/lib/motion.ts"), "utf8");
    expect(
      motion,
      "the count-up detector no longer matches the helper it is meant to find",
    ).toMatch(/export function useCountUp/);

    const files = [
      "ArtifactReveal.tsx",
      "ArtifactCard.tsx",
      "ArtifactFigure.tsx",
      "ChartArtifact.tsx",
      "TableArtifact.tsx",
      "SlideArtifact.tsx",
      "ComparisonArtifact.tsx",
      "FindingArtifact.tsx",
      "ScenarioArtifact.tsx",
      "SpreadsheetArtifact.tsx",
      "DocumentArtifact.tsx",
    ];
    for (const file of files) {
      const body = readFileSync(
        join(process.cwd(), "frontend/components/cfo/canvas/artifacts", file),
        "utf8",
      );
      expect(body, `${file} animates a figure`).not.toMatch(CALL);
    }
    expect(files.length, "the count-up census examined nothing").toBeGreaterThanOrEqual(11);
  });
});

// ══════════════════════════════════════════════════════════════════════
// B10 — EVERY CHART FORM DRAWS, AND THE DOCUMENT EXPORT RESOLVES
// ══════════════════════════════════════════════════════════════════════

describe("B10 — all five chart forms, and the export resolves its placeholders", () => {
  it("draws each of the five forms and marks which one it drew", () => {
    const { facts, labels } = trendFacts();
    const snapFacts = Object.keys(snapshot.facts);
    const cmp = Object.keys(compare.factMeta).filter((f) => !f.endsWith("_delta"));
    const cases: Array<[string, React.ReactElement, string]> = [
      ["bar", <ChartArtifact chart={chartFrom(barChartSpec(facts, labels), trend).chart} />, "artifact-chart-bar"],
      ["line", <ChartArtifact chart={chartFrom(lineChartSpec(facts, labels), trend).chart} />, "artifact-chart-line"],
      [
        "stacked",
        <ChartArtifact
          chart={chartFrom(stackedChartSpec([snapFacts[0]], [snapFacts[1]]), snapshot).chart}
        />,
        "artifact-chart-segment",
      ],
      [
        "waterfall",
        <ChartArtifact
          chart={
            chartFrom(
              waterfallSpec(
                [cmp[0], Object.keys(compare.factMeta).find((f) => f.endsWith("_delta")) as string],
                ["Opening", "Movement"],
              ),
              compare,
            ).chart
          }
        />,
        "artifact-chart-step",
      ],
      [
        "donut",
        <ChartArtifact chart={chartFrom(donutChartSpec(snapFacts.slice(0, 2)), snapshot).chart} />,
        "artifact-chart-slice",
      ],
    ];
    let drawn = 0;
    for (const [form, ui, mark] of cases) {
      const { container, unmount } = renderIn(ui);
      expect(
        container.querySelector('[data-testid="artifact-chart"]')?.getAttribute("data-chart-form"),
        `${form} rendered as something else`,
      ).toBe(form);
      expect(
        container.querySelectorAll(`[data-testid="${mark}"]`).length,
        `${form} drew no marks`,
      ).toBeGreaterThan(0);
      // Same law, every form.
      expect(unattributedFigures(container, snapshot.literals.concat(trend.literals, compare.literals))).toHaveLength(0);
      drawn += 1;
      noteRender("chart", attributedFigureCount(container));
      unmount();
    }
    expect(drawn, "the form census examined nothing").toBe(5);
  });

  it("resolves every placeholder to a NATIVE figure before a .docx leaves the product", () => {
    const fact = Object.keys(snapshot.facts)[0];
    const sections = documentExportSections(documentSpec(fact), snapshot);
    expect(sections).toHaveLength(1);
    const para = sections[0].paragraphs[0];
    // A file has nowhere to carry a rate, so the figure is NATIVE and
    // the placeholder is gone. Both halves matter: a `{{money:…}}` in a
    // reader's inbox is worse than a number, and a silently converted
    // figure with no rate stamped on it is worse than both.
    expect(para).not.toContain("{{");
    expect(para).toMatch(/\d/);
    expect(para).toContain(snapshot.currency as string);
  });

  it("counts every figure a resolved artifact will render, for the export payload", () => {
    const snapFacts = Object.keys(snapshot.facts);
    const { table } = tableFrom(
      tableSpec(snapFacts.map((f) => ({ label: f, fact: f })), snapFacts[0]),
      snapshot,
    );
    // `figuresOf` is what the card feeds <AmountGroup> and what the
    // export builder walks; a miscount there is a silently dropped cell.
    expect(figuresOf(table).length).toBe(snapFacts.length + 1);
  });
});

// ══════════════════════════════════════════════════════════════════════
// B11 — THE DISPATCHER ACTUALLY DISPATCHES ALL EIGHT
// ══════════════════════════════════════════════════════════════════════

describe("B11 — every kind reaches its renderer through <Artifact>, not just in the source", () => {
  it("renders all eight through the top-level component, each inside a card that cites", () => {
    // `check_artifact_law.mjs` proves the BRANCH EXISTS. This proves it
    // WORKS: a branch can be present and still resolve to a refusal, an
    // empty body or the wrong component, and the static census cannot
    // tell the difference (TC-7 — confirm which component renders).
    const { facts, labels } = trendFacts();
    const snapFacts = Object.keys(snapshot.facts);
    const cmp = Object.keys(compare.factMeta).filter((f) => !f.endsWith("_delta"));
    const table = tableSpec(snapFacts.map((f) => ({ label: f, fact: f })), snapFacts[0]);

    const specs: Array<[Kind, ArtifactSpec, CapsuleEvidence]> = [
      ["chart", barChartSpec(facts, labels), trend],
      ["table", table, snapshot],
      ["spreadsheet", spreadsheetSpec(table), snapshot],
      ["slide", slideSpec(snapFacts, snapFacts), snapshot],
      ["document", documentSpec(snapFacts[0]), snapshot],
      ["scenario", scenarioSpec(["net_result", "net_margin"]), pnl],
      [
        "comparison",
        comparisonSpec(
          ["Revenue"],
          [
            { label: "Earlier", standard: "RAS/IFRS", cells: [cmp[0]] },
            { label: "Later", standard: "RAS/IFRS", cells: [cmp[1]] },
          ],
        ),
        compare,
      ],
      ["finding", findingSpec(snapFacts.slice(0, 2)), snapshot],
    ];

    let dispatched = 0;
    for (const [kind, spec, evidence] of specs) {
      const { container, unmount } = renderIn(<Artifact spec={spec} evidence={evidence} />);
      expect(
        container.querySelector('[data-testid="artifact-refused"]'),
        `${kind}: the dispatcher refused a spec the guard accepted`,
      ).toBeNull();
      const card = container.querySelector('[data-testid="artifact-card"]');
      expect(card, `${kind}: no card`).toBeTruthy();
      expect(card?.getAttribute("data-artifact-kind")).toBe(kind);
      expect(
        container.querySelector(`[data-testid="${ROOT_TESTID[kind]}"]`),
        `${kind}: the card rendered but ${ROOT_TESTID[kind]} did not`,
      ).toBeTruthy();
      // The footer is the CARD's, so every kind gets one for free — and
      // that is exactly the property worth asserting per kind.
      expect(container.querySelector('[data-testid="artifact-citation"]')).toBeTruthy();
      dispatched += 1;
      unmount();
    }
    expect(dispatched, "the dispatch census examined nothing").toBe(ARTIFACT_KINDS.length);
  });
});

// ══════════════════════════════════════════════════════════════════════
// THE CENSUS — asserted AFTER every discovery loop (TC-3 / TC-6)
// ══════════════════════════════════════════════════════════════════════

describe("WORK — what these gates actually examined", () => {
  it("examined every one of the eight kinds, per kind, not in aggregate", () => {
    const lines: string[] = [];
    for (const kind of ARTIFACT_KINDS) {
      const w = WORK[kind];
      lines.push(
        `GATE-WORK artifact-${kind} guarded=${w.guarded} planted=${w.planted} rendered=${w.rendered} figures=${w.figures}`,
      );
    }
    // Printed so a reader of a green run can see WHAT was examined.
    // eslint-disable-next-line no-console
    console.log(lines.join("\n"));

    for (const kind of ARTIFACT_KINDS) {
      const w = WORK[kind];
      expect(w.guarded, `${kind}: no clean spec was ever guarded`).toBeGreaterThan(0);
      expect(w.planted, `${kind}: no plant was ever refused`).toBeGreaterThan(0);
      expect(w.rendered, `${kind}: never rendered`).toBeGreaterThan(0);
      expect(
        w.figures,
        `${kind}: rendered ${w.figures} attributed figure(s), floor ${FIGURE_FLOOR[kind]}`,
      ).toBeGreaterThanOrEqual(FIGURE_FLOOR[kind]);
    }
    expect(ARTIFACT_KINDS).toHaveLength(8);
  });
});
