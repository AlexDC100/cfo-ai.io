// THE ENGINE ARTIFACT WIRE under test — on REAL engine frames.
//
// Every frame this suite folds was emitted by the REAL Python resolver
// running over REAL trial balances committed to this repo, captured by
// `tests/engine/fixtures/artifacts/capture.py`. The fact index it
// summarises is built from the REAL period blobs under
// `fixtures/capsuleTier0/`. Nothing here hand-writes a frame, a cell or
// a period: a TypeScript author's idea of the wire shape is exactly the
// belief TC-1 exists to keep out of a fixture.
//
// FOUR THINGS THIS SUITE PROVES, and one it deliberately does not:
//
//   D   THE MIRROR DOES NOT DRIFT. The enums in `artifactSpec.ts` are
//       compared against the PYTHON SOURCE, parsed. A mirror that
//       drifts silently is worse than no mirror.
//   W1  THE SUMMARY LEAKS NO VALUE. Swept against every value in the
//       real index — not against "numbers in general", which a period
//       count would trip.
//   W2  A DIGIT WITHOUT A FACT AND A PROVENANCE IS REFUSED.
//   W3  THE SKELETON COMES FIRST, and a value before it is refused.
//
//   NOT here: parsing a model's spec. That belongs to the canvas lane's
//   `components/cfo/canvas/artifacts/artifactSpec.ts`, and a second
//   parser would be a second authority on the same question.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  ARTIFACT_KINDS,
  ARTIFACT_SPEC_VERSION,
  ARTIFACT_VERSION,
  DERIVATIONS,
  EMPHASES,
  ENGINE_VOCABULARY,
  GROUP_BY,
  SORTS,
  SPEC_INT_SLOTS,
  applyArtifactFrame,
  buildFactIndexSummary,
  cellKey,
  createArtifactView,
  foldArtifactFrames,
  frameViolations,
  isSettled,
  slotState,
  type CellFrame,
  type SkeletonFrame,
} from "@/lib/artifactSpec";
import { buildFactIndex, type CapsuleFactSnapshot } from "@/lib/capsuleFactIndex";
import type { Statements } from "@/lib/financialReport";

import carniprodJson from "./fixtures/capsuleTier0/period_carniprod_fy2025.json";
import retailJson from "./fixtures/capsuleTier0/period_retail_fy2024.json";

const repoRoot = resolve(__dirname, "../../..");
const readRepo = (p: string) => readFileSync(resolve(repoRoot, p), "utf-8");

const captured = JSON.parse(
  readRepo("tests/engine/fixtures/artifacts/resolved_artifacts_REAL_engine.json"),
) as {
  cases: Record<
    string,
    { frames: unknown[]; resolved: { cells: CellFrame[] }; frame_types: string[] }
  >;
};

function framesFor(name: string): unknown[] {
  const c = captured.cases[name];
  expect(c, `no captured case ${name}`).toBeTruthy();
  expect(Array.isArray(c.frames)).toBe(true);
  return c.frames;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

// ══════════════════════════════════════════════════════════════════════
// D — the mirror is compared against the Python source
// ══════════════════════════════════════════════════════════════════════

/**
 * Read a `NAME = (…)` tuple out of the Python source, RESOLVING member
 * constants to their literal values.
 *
 * The first draft matched string literals only and returned `[]` for
 * every tuple in the file, because the engine writes them as constant
 * references (`GROUP_BY = (GROUP_BY_PERIOD, GROUP_BY_METRIC)`). Every
 * comparison below would then have compared against an empty list and
 * passed — the exact shape of `check_metric_declared`'s first draft,
 * which reported "0 metrics" for a package containing dozens and
 * printed a pass. The canary test above is what caught it here, and the
 * empty-result guard below is what keeps it caught.
 */
function pyTuple(source: string, name: string): string[] {
  const rx = new RegExp(`^${name}\\s*=\\s*\\(([\\s\\S]*?)\\)`, "m");
  const m = rx.exec(source);
  expect(m, `DISCOVERY BROKEN: ${name} not found in the Python source`).toBeTruthy();
  const body = (m as RegExpExecArray)[1];
  const out: string[] = [];
  const item = /"([^"]*)"|'([^']*)'|([A-Z][A-Z0-9_]*)/g;
  let hit: RegExpExecArray | null;
  while ((hit = item.exec(body)) !== null) {
    if (hit[1] !== undefined) {
      out.push(hit[1]);
    } else if (hit[2] !== undefined) {
      out.push(hit[2]);
    } else {
      const ident = hit[3];
      const lit = new RegExp(`^${ident}\\s*=\\s*"([^"]*)"`, "m").exec(source);
      expect(
        lit,
        `DISCOVERY BROKEN: ${name} references ${ident}, which has no literal`,
      ).toBeTruthy();
      out.push((lit as RegExpExecArray)[1]);
    }
  }
  expect(out.length, `DISCOVERY BROKEN: ${name} resolved to nothing`).toBeGreaterThan(0);
  return out;
}

/** Read a `NAME = "value"` string constant. */
function pyConst(source: string, name: string): string {
  const rx = new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, "m");
  const m = rx.exec(source);
  expect(m, `DISCOVERY BROKEN: ${name} not found in the Python source`).toBeTruthy();
  return (m as RegExpExecArray)[1];
}

describe("the vocabulary mirrors the engine", () => {
  const specPy = readRepo("src/engine/api/_artifact_spec.py");
  const resolvePy = readRepo("src/engine/api/_artifact_resolve.py");

  it("resolves the Python constants at all — the canary before the compare", () => {
    // TC-3: a parser that found nothing would make every assertion below
    // pass against an empty list. Assert the discovery first.
    expect(specPy.length).toBeGreaterThan(5000);
    expect(resolvePy.length).toBeGreaterThan(5000);
    expect(pyTuple(specPy, "ARTIFACT_KINDS").length).toBeGreaterThanOrEqual(5);
    expect(pyTuple(specPy, "DERIVATIONS").length).toBeGreaterThanOrEqual(4);
  });

  it("kinds, grouping, sorts, emphases and derivations all match", () => {
    // The Python tuples are written as KIND_* references, so compare
    // against the VALUES the engine's own tuple members resolve to,
    // which the source spells out as `KIND_x = "x"` lines.
    const kinds = ["line", "bar", "table", "kpi_grid", "delta_table"];
    for (const kind of kinds) {
      expect(specPy).toContain(`= "${kind}"`);
    }
    expect([...ARTIFACT_KINDS]).toEqual(kinds);

    expect([...GROUP_BY]).toEqual(pyTuple(specPy, "GROUP_BY"));
    expect([...SORTS]).toEqual(pyTuple(specPy, "SORTS"));
    expect([...EMPHASES]).toEqual(pyTuple(specPy, "EMPHASES"));
    expect([...DERIVATIONS]).toEqual(pyTuple(specPy, "DERIVATIONS"));
  });

  it("the contract versions match", () => {
    expect(ARTIFACT_SPEC_VERSION).toBe(pyConst(specPy, "ARTIFACT_SPEC_VERSION"));
    expect(ARTIFACT_VERSION).toBe(pyConst(resolvePy, "ARTIFACT_VERSION"));
  });

  it("the two bounded integer slots match, bounds included", () => {
    const block = /_INT_SLOTS = \{([\s\S]*?)\}/.exec(specPy);
    expect(block, "DISCOVERY BROKEN: _INT_SLOTS not found").toBeTruthy();
    const body = (block as RegExpExecArray)[1];
    const found: Record<string, [number, number]> = {};
    const rx = /"([a-z_]+)":\s*\((\d+),\s*(\d+)\)/g;
    let hit: RegExpExecArray | null;
    while ((hit = rx.exec(body)) !== null) {
      found[hit[1]] = [Number(hit[2]), Number(hit[3])];
    }
    expect(Object.keys(found).sort()).toEqual(["decimals", "limit"]);
    expect(found).toEqual({ limit: [0, 50], decimals: [0, 4] });
    expect(SPEC_INT_SLOTS).toEqual(found);
  });

  it("the frame types match the resolver's own constants", () => {
    for (const name of [
      "FRAME_SKELETON",
      "FRAME_CELL",
      "FRAME_GAP",
      "FRAME_REFUSAL",
      "FRAME_COMPLETE",
    ]) {
      expect(pyConst(resolvePy, name)).toBeTruthy();
    }
    expect(pyConst(resolvePy, "FRAME_SKELETON")).toBe("skeleton");
    expect(pyConst(resolvePy, "FRAME_CELL")).toBe("cell");
  });

  it("exposes one frozen vocabulary object so drift has one place to show", () => {
    expect(ENGINE_VOCABULARY.kinds).toBe(ARTIFACT_KINDS);
    expect(Object.isFrozen(ENGINE_VOCABULARY)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════
// W1 — the summary carries names and shapes, never values
// ══════════════════════════════════════════════════════════════════════

function realIndex() {
  const snapshot: CapsuleFactSnapshot = {
    periods: [
      {
        periodId: "p-carniprod",
        periodLabel: "December 2025",
        statements: clone(carniprodJson) as unknown as Statements,
        docId: "doc-carniprod",
      },
      {
        periodId: "p-retail",
        periodLabel: "December 2024",
        statements: clone(retailJson) as unknown as Statements,
        docId: "doc-retail",
      },
    ],
    activePeriodId: "p-carniprod",
  };
  return buildFactIndex(snapshot);
}

describe("the fact index summary", () => {
  it("lists names, units and periods — and no value from the index", () => {
    const index = realIndex();
    const summary = buildFactIndexSummary(index);
    const text = JSON.stringify(summary);

    // CANARY + FLOOR, per component. A summary that stopped listing
    // facts, or stopped listing periods, must not read as a clean sweep
    // (TC-3/TC-9).
    expect(index.facts.length).toBeGreaterThan(20);
    expect(summary.facts.length).toBeGreaterThan(10);
    expect(summary.periods.length).toBe(2);
    expect(summary.facts.map((f) => f.factKey)).toContain("total_assets");
    expect(summary.periods.map((p) => p.periodId)).toContain("p-carniprod");

    // THE SWEEP: every value the index actually holds, checked against
    // the summary's own bytes. Exact, not heuristic — a heuristic would
    // have to allow "small numbers", and a period count is small.
    const leaked: Array<{ key: string; value: number }> = [];
    for (const ref of index.facts) {
      if (typeof ref.value !== "number" || !Number.isFinite(ref.value)) continue;
      for (const printed of [
        String(ref.value),
        String(Math.round(ref.value)),
        ref.value.toFixed(2),
      ]) {
        // Skip renderings that collide with a legitimate small count.
        if (printed.length < 4) continue;
        if (text.includes(printed)) leaked.push({ key: ref.factKey, value: ref.value });
      }
    }
    expect(leaked).toEqual([]);
  });

  it("has no field that could carry a figure", () => {
    const summary = buildFactIndexSummary(realIndex());
    for (const entry of summary.facts) {
      expect(entry).not.toHaveProperty("value");
      expect(entry).not.toHaveProperty("amount");
      expect(entry).not.toHaveProperty("amountMinor");
      expect(typeof entry.unit).toBe("string");
    }
  });

  it("counts availability instead of repeating a fact per period", () => {
    const summary = buildFactIndexSummary(realIndex());
    const keys = summary.facts.map((f) => f.factKey);
    expect(new Set(keys).size).toBe(keys.length);
    const totalAssets = summary.facts.find((f) => f.factKey === "total_assets");
    expect(totalAssets?.periods).toBe(2);
  });

  it("survives an absent index rather than inventing one", () => {
    const summary = buildFactIndexSummary(null);
    expect(summary.facts).toEqual([]);
    expect(summary.periods).toEqual([]);
    expect(summary.activePeriodId).toBeNull();
    expect(summary.kinds).toEqual(ARTIFACT_KINDS);
  });
});

// ══════════════════════════════════════════════════════════════════════
// W3 — the skeleton is the first frame
// ══════════════════════════════════════════════════════════════════════

describe("folding a real engine stream", () => {
  it("every captured case starts with a skeleton and ends complete", () => {
    const names = Object.keys(captured.cases);
    expect(names.length).toBeGreaterThanOrEqual(9);
    for (const name of names) {
      const frames = framesFor(name);
      expect((frames[0] as SkeletonFrame).type, name).toBe("skeleton");
      expect((frames[frames.length - 1] as { type: string }).type, name).toBe("complete");
    }
  });

  it("folds the real KPI stream into a view with every cell placed", () => {
    const view = foldArtifactFrames(framesFor("kpi_all_metrics"));
    expect(view.rejected).toEqual([]);
    expect(view.skeleton).toBeTruthy();
    expect(view.cells.size).toBe(12);
    expect(view.complete?.cells).toBe(12);

    const state = slotState(view, "total_assets", "p-scandia-fy2025");
    expect(state.state).toBe("resolved");
    if (state.state === "resolved") {
      expect(state.cell.kind).toBe("money");
      expect(state.cell.currency).toBe("RON");
      expect(state.cell.provenance.snapshot_id).toBeTruthy();
    }
    expect(isSettled(view)).toBe(true);
  });

  it("a value arriving before the skeleton is refused, not rendered", () => {
    const frames = framesFor("kpi_all_metrics");
    const cell = frames.find((f) => (f as { type: string }).type === "cell");
    const view = applyArtifactFrame(createArtifactView(), cell);
    expect(view.cells.size).toBe(0);
    expect(view.rejected).toHaveLength(1);
    expect(view.rejected[0].violations.map((v) => v.code)).toContain(
      "value_before_skeleton",
    );
  });

  it("the skeleton renders before any value has arrived", () => {
    const frames = framesFor("kpi_all_metrics");
    const view = applyArtifactFrame(createArtifactView(), frames[0]);
    expect(view.skeleton?.series.length).toBe(12);
    expect(view.skeleton?.slots.length).toBe(1);
    expect(view.skeleton?.caption).toBe("December 2025");
    expect(view.cells.size).toBe(0);
    // AND it is distinguishable from a finished artifact: every slot is
    // pending, not gapped. Collapsing those two would make a slow
    // network look like missing data.
    expect(slotState(view, "total_assets", "p-scandia-fy2025").state).toBe("pending");
    expect(isSettled(view)).toBe(false);
  });

  it("the real skeleton frame carries no figure", () => {
    for (const name of Object.keys(captured.cases)) {
      const skeleton = framesFor(name)[0] as Record<string, unknown>;
      expect(frameViolations(skeleton), name).toEqual([]);
      const text = JSON.stringify(skeleton);
      expect(text.includes('"amount_minor"'), name).toBe(false);
      expect(text.includes('"value"'), name).toBe(false);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// W2 — a digit without a fact and a provenance is refused
// ══════════════════════════════════════════════════════════════════════

describe("the frame guard", () => {
  function realCell(): CellFrame {
    const frames = framesFor("kpi_all_metrics");
    return clone(frames.find((f) => (f as { type: string }).type === "cell") as CellFrame);
  }

  it("passes every real cell the engine emitted", () => {
    let swept = 0;
    for (const name of Object.keys(captured.cases)) {
      for (const frame of framesFor(name)) {
        const violations = frameViolations(frame);
        expect(violations, `${name}: ${JSON.stringify(frame).slice(0, 200)}`).toEqual([]);
        swept += 1;
      }
    }
    // TC-3: a guard that swept nothing is not a passing guard.
    expect(swept).toBeGreaterThanOrEqual(40);
  });

  it("refuses a figure with no fact name", () => {
    const cell = realCell();
    cell.fact = "";
    expect(frameViolations(cell).map((v) => v.code)).toContain("value_without_fact");
  });

  it("refuses a figure with no provenance", () => {
    const cell = realCell();
    cell.provenance = {};
    expect(frameViolations(cell).map((v) => v.code)).toContain(
      "value_without_provenance",
    );
  });

  it("refuses a figure whose provenance names no snapshot", () => {
    const cell = realCell();
    cell.provenance = { period_id: "p-scandia-fy2025" };
    expect(frameViolations(cell).map((v) => v.code)).toContain(
      "value_without_provenance",
    );
  });

  it("accepts a DERIVED figure that names both snapshots instead of one", () => {
    // The delta cells the engine emits carry `to_snapshot_id` rather than
    // `snapshot_id`, because a change belongs to no single snapshot. The
    // guard must accept that shape or it would reject every real delta.
    const deltaFrames = framesFor("self_delta_is_exactly_zero");
    const deltas = deltaFrames.filter((f) => (f as { type: string }).type === "cell");
    expect(deltas.length).toBe(4);
    for (const frame of deltas) {
      expect(frameViolations(frame)).toEqual([]);
      const prov = (frame as CellFrame).provenance;
      expect(prov.from_snapshot_id).toBeTruthy();
      expect(prov.to_snapshot_id).toBeTruthy();
    }
  });

  it("refuses money with no currency", () => {
    const cell = realCell();
    delete (cell as unknown as Record<string, unknown>).currency;
    expect(frameViolations(cell).map((v) => v.code)).toContain("money_without_currency");
  });

  it("refuses a dimensionless figure dressed as money", () => {
    const ratio = clone(
      framesFor("ratios_one_period").find(
        (f) => (f as CellFrame).kind === "ratio",
      ) as CellFrame,
    );
    expect(frameViolations(ratio)).toEqual([]);
    (ratio as unknown as Record<string, unknown>).amount_minor = 100;
    expect(frameViolations(ratio).map((v) => v.code)).toContain("ratio_as_money");
  });

  it("refuses a gap or a refusal that carries a number", () => {
    const gapFrame = clone(
      framesFor("absent_period_gap").find(
        (f) => (f as { type: string }).type === "gap",
      ) as Record<string, unknown>,
    );
    expect(frameViolations(gapFrame)).toEqual([]);
    gapFrame.estimated_value = 4834908159;
    expect(frameViolations(gapFrame).map((v) => v.code)).toContain("figure_in_refusal");
  });

  it("refuses a skeleton that smuggled a value", () => {
    const skeleton = clone(framesFor("kpi_all_metrics")[0] as Record<string, unknown>);
    skeleton.value = 52764717.79;
    expect(frameViolations(skeleton).map((v) => v.code)).toContain("figure_in_skeleton");
  });

  it("refuses a frame that is not a frame", () => {
    expect(frameViolations(null).map((v) => v.code)).toEqual(["not_a_frame"]);
    expect(frameViolations({ type: "chart" }).map((v) => v.code)).toEqual([
      "unknown_frame_type",
    ]);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Gaps render in the cell, and stay distinct from "not yet"
// ══════════════════════════════════════════════════════════════════════

describe("gaps", () => {
  it("an absent period shows a gap card at its coordinate, not a zero", () => {
    const view = foldArtifactFrames(framesFor("absent_period_gap"));
    expect(view.rejected).toEqual([]);
    const state = slotState(view, "revenue", "p-scandia-nofile");
    expect(state.state).toBe("gap");
    if (state.state === "gap") {
      expect(state.gap.code).toBe("no_source_file");
      expect(state.gap.fix).toContain("Upload the trial balance");
    }
    // The resolved sibling is unaffected — one absence does not empty
    // the artifact.
    expect(slotState(view, "revenue", "p-scandia-fy2025").state).toBe("resolved");
    expect(isSettled(view)).toBe(true);
  });

  it("a whole-slot gap covers every series in that slot", () => {
    const view = foldArtifactFrames(framesFor("absent_period_gap"));
    // The engine files a period-level gap under series "" when it
    // belongs to no single row; the lookup must fall back to it rather
    // than reporting the cell as still loading.
    const gapKeys = [...view.gaps.keys()];
    expect(gapKeys.some((k) => k.endsWith("|p-scandia-nofile"))).toBe(true);
  });

  it("a refused artifact settles with no cells and a stated reason", () => {
    const view = foldArtifactFrames(framesFor("cross_entity_refused"));
    expect(view.cells.size).toBe(0);
    expect(view.refusals).toHaveLength(1);
    expect(view.refusals[0].code).toBe("same_entity");
    // The whole-artifact refusal is filed at ("", "") and therefore
    // covers every coordinate.
    expect(view.refusals[0].series_id).toBe("");
    expect(slotState(view, "revenue", "p-scandia-fy2025").state).toBe("refused");
    expect(isSettled(view)).toBe(true);
  });

  it("a refusal on ONE series does not declare the whole artifact settled", () => {
    // The defect this pins: an early draft returned settled as soon as
    // any refusal existed, so a reader would be told the artifact had
    // finished with half its bars still streaming.
    const skeleton = clone(framesFor("kpi_all_metrics")[0]) as SkeletonFrame;
    let view = applyArtifactFrame(createArtifactView(), skeleton);
    view = applyArtifactFrame(view, {
      type: "refusal",
      artifact_id: skeleton.artifact_id,
      kind: "refusal",
      series_id: "ebitda",
      slot_id: "p-scandia-fy2025",
      code: "no_delta_for_unit",
      detail: "refused",
      alternative: "",
    });
    expect(view.rejected).toEqual([]);
    expect(slotState(view, "ebitda", "p-scandia-fy2025").state).toBe("refused");
    expect(slotState(view, "revenue", "p-scandia-fy2025").state).toBe("pending");
    expect(isSettled(view)).toBe(false);
  });
});

describe("the coordinate key", () => {
  it("is stable and tolerates an empty series", () => {
    expect(cellKey("revenue", "p1")).toBe("revenue|p1");
    expect(cellKey("", "p1")).toBe("|p1");
  });
});
