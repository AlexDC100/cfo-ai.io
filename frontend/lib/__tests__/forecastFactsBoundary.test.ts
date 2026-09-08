// F2 + F4, THE FRONTEND HALF — where a projected figure could actually be
// painted as a fact.
//
// The engine half (tests/engine/test_forecast_serving_boundary.py) proves the
// wire form carries the distinction. This half proves a renderer cannot drop
// it, and it is the load-bearing one: Python can refuse an accessor at
// runtime, but only TypeScript can refuse it BEFORE the code ships. The
// `@ts-expect-error` blocks below are the actual gate — each one asserts that
// the line beneath it does NOT compile, and `node scripts/check_tsc.mjs`
// fails if any of them starts compiling cleanly.
//
// ── WHAT THIS GATE REDS ON, AFTER THE REPAIR (TC-11) ────────────────────
//
//   · a projected amount becoming assignable to `number` — that is the whole
//     compile-time barrier, and if it widens, every actuals formatter and
//     every figure primitive in the product silently accepts a projection;
//   · a way to reach the value without receiving the marker in the same call;
//   · a projected figure reaching an ACTUALS payload, at any depth, including
//     one whose marker a serializer stripped;
//   · a source-cell affordance on a projected figure (the LACKS_SHOWS bucket
//     of design_review/PROVENANCE_CENSUS.json), with `base_period.snapshot_id`
//     the single exemption;
//   · a figure whose assumptions do not resolve being served as a number
//     instead of a refusal;
//   · a refusal carrying a number;
//   · an unbalanced projected year reported as balanced;
//   · the fp1 constants drifting from the engine's own contract module — the
//     Python file is read and compared, not paraphrased.
//
// ── WHAT IT CANNOT SEE (TC-11) ──────────────────────────────────────────
//
//   · a surface that never uses `ProjectedAmount` and paints
//     `String(...)` of a value it obtained by casting through `unknown`. The
//     cast is deliberate friction and grep-able, not a wall; the wall is that
//     no ordinary code path produces a bare number.
//   · what the EXPORTS do. They do not exist yet — wave 2 — and the reason
//     the distinction is carried by data rather than by CSS is precisely so
//     that when they arrive they consume the same marker.
//   · whether the projection is any GOOD. It measures the boundary, not the
//     forecast.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ACTUAL_PROVENANCE_FIELDS,
  ASSUMPTION_UNITS,
  BASE_PERIOD_KEYS,
  PRODUCER_SCHEMAS,
  FORECAST_CONTRACT_VERSION,
  PROJECTED_MARKER,
  PROJECTION_KIND,
  actualProvenanceOnProjection,
  assertNoActualProvenance,
  assertNoProjectionInActuals,
  isProjectedFigure,
  isProjectionRefusal,
  projectedDisplay,
  looksProjected,
  projectionLeaksIntoActuals,
  readProjection,
  unwrapProjected,
  type ProjectedFigure,
  type ProjectedMarker,
} from "@/lib/forecastFacts";
// The real actuals-side functions, imported so the compile proof is against
// the product and not against a stand-in.
import { toDisplay } from "@/lib/servedFacts";
import { formatAmount } from "@/lib/amountFormat";

const REPO = resolve(__dirname, "../../..");
const FP1 = resolve(REPO, "tests/engine/fixtures/forecast/fp1_agras.json");
// The SERVED wire form — what `ProjectionGateway.as_dict()` really puts on the
// wire, and therefore what a browser really receives. See the round-trip
// describe block near the bottom of this file for why it is here and what its
// absence cost.
const FP1_SERVED = resolve(
  REPO,
  "tests/engine/fixtures/forecast/fp1_agras_served.json",
);
const AGRAS = resolve(REPO, "tests/engine/fixtures/firm/saga_10_col_agras.json");

// The SAME BYTES the engine gate reads — not a second hand-kept copy. The
// Python suite asserts this file is exactly what its builder produces, so the
// two halves can never be measured on different data.
const payload = () => JSON.parse(readFileSync(FP1, "utf8")) as unknown;
const book = () => JSON.parse(readFileSync(AGRAS, "utf8")) as unknown;

const view = () => {
  const v = readProjection(payload());
  if (!v) throw new Error("the committed fp1 fixture did not read as a projection");
  return v;
};

const revenueY1 = (): ProjectedFigure => {
  const f = view().figure("revenue", "FY+1");
  if (!isProjectedFigure(f)) throw new Error(`revenue/FY+1 refused: ${JSON.stringify(f)}`);
  return f;
};

// ─── F2: the compile-time barrier ───────────────────────────────────────

describe("a projected amount is not a number to the type checker", () => {
  it("cannot be used in arithmetic with an actual", () => {
    const figure = revenueY1();
    const actualMinor = 11857681964; // agras revenue, measured, in cents
    // @ts-expect-error a projected amount has no arithmetic with an actual
    const bogus = actualMinor + figure.amountMinor;
    // At RUNTIME the value is an ordinary number and the sum is real — which
    // is exactly why the barrier has to be at compile time. This assertion
    // records that the runtime offers no protection at all: the
    // `@ts-expect-error` above is the entire gate, and it fails if the line
    // ever starts compiling.
    expect(typeof bogus).toBe("number");
    expect(bogus).toBe(11857681964 + 12806296521);
  });

  it("cannot be passed where a number is expected", () => {
    const figure = revenueY1();
    const formatter = (value: number) => `${value}`;
    // @ts-expect-error a money formatter built for actuals must not accept it
    formatter(figure.amountMinor);
    expect(true).toBe(true);
  });

  it("cannot be compared against an actual threshold", () => {
    const figure = revenueY1();
    // @ts-expect-error a projection is not on the same scale as a fact
    const over = figure.amountMinor > 0;
    expect(typeof over).toBe("boolean");
  });

  // The three above use a local formatter. These two use the REAL product
  // functions a careless author would actually reach for — the actuals
  // gateway's own cents→display conversion, and the one amount formatter
  // every figure in the product is painted through. If either ever accepts a
  // projection, the barrier is decorative.

  it("cannot be handed to servedFacts.toDisplay, the ACTUALS conversion", () => {
    const figure = revenueY1();
    // @ts-expect-error toDisplay is the actuals cents→display boundary
    const asIfActual = toDisplay(figure.amountMinor);
    expect(asIfActual).toBe(128062965.21);
  });

  it("cannot be handed to formatAmount, the product's figure formatter", () => {
    const figure = revenueY1();
    // @ts-expect-error every figure in the product is painted through this
    const painted = formatAmount(figure.amountMinor);
    expect(typeof painted).toBe("string");
  });

  it("the value only comes out with its marker attached", () => {
    const figure = revenueY1();
    let seen: ProjectedMarker | null = null;
    const value = projectedDisplay(figure, "Imported period", (v, marker) => {
      seen = marker;
      return v;
    });
    // 118,576,819.64 grown 8% — the same figure the engine gate measures.
    expect(value).toBe(128062965.21);
    expect(seen).not.toBeNull();
    const marker = seen as unknown as ProjectedMarker;
    expect(marker.projected).toBe(true);
    expect(marker.period).toBe("FY+1");
    expect(marker.basePeriodLabel).toBe("Imported period");
    expect(marker.basis.length).toBeGreaterThan(0);
    expect(marker.formula).toContain("revenue_growth");
  });

  it("unwrapProjected hands over minor units, never a bare float", () => {
    const minor = unwrapProjected(revenueY1(), "base", (m) => m);
    expect(minor).toBe(12806296521);
    expect(Number.isInteger(minor)).toBe(true);
  });
});

// ─── F2: the namespace holds at runtime too ─────────────────────────────

describe("actuals and projections cannot be mixed in one payload", () => {
  it("the committed book carries no projection", () => {
    expect(projectionLeaksIntoActuals(book())).toEqual([]);
    expect(() => assertNoProjectionInActuals(book())).not.toThrow();
  });

  it("PLANT: a projected figure dropped into the served book is caught", () => {
    const planted = JSON.parse(readFileSync(AGRAS, "utf8"));
    planted.statements.assembled_pl.revenue_next_year = {
      kind: PROJECTION_KIND,
      projected: true,
      line: "revenue",
      period: "FY+1",
      amount_minor_projected: 12806296521,
    };
    const leaks = projectionLeaksIntoActuals(planted);
    expect(leaks).toEqual(["$.statements.assembled_pl.revenue_next_year"]);
    expect(() => assertNoProjectionInActuals(planted)).toThrow(/ACTUALS/);
  });

  it("PLANT: a projection whose marker was stripped is still caught", () => {
    const planted = JSON.parse(readFileSync(AGRAS, "utf8"));
    planted.line_items.push({
      line: "revenue",
      period: "FY+1",
      amount_minor: 12806296521,
      assumption_ids: ["revenue_growth"],
    });
    expect(projectionLeaksIntoActuals(planted).length).toBeGreaterThan(0);
  });

  it("readProjection returns null for an actuals payload, and does not throw", () => {
    expect(readProjection(book())).toBeNull();
    expect(readProjection(null)).toBeNull();
    expect(readProjection({ kind: "period" })).toBeNull();
  });

  it("a payload claiming fp1 at the wrong version throws rather than degrading", () => {
    const wrong = { ...(payload() as Record<string, unknown>), contract: "fp2" };
    expect(() => readProjection(wrong)).toThrow(/fp1/);
  });
});

// ─── F4: provenance resolves to assumptions ─────────────────────────────

describe("every projected figure resolves to its drivers", () => {
  it("each served figure carries a non-empty, fully-stated basis", () => {
    const v = view();
    const served = v.figures().filter(isProjectedFigure);
    expect(served.length).toBe(15);
    for (const figure of served) {
      expect(figure.basis.length).toBeGreaterThan(0);
      for (const a of figure.basis) {
        expect(a.id).not.toBe("");
        expect(a.basis.trim().length).toBeGreaterThan(0);
        expect(ASSUMPTION_UNITS as readonly string[]).toContain(a.unit);
        // The driver's value is the one for THIS figure's year.
        expect(a.value).not.toBeNull();
      }
    }
  });

  it("the driver value tracks the period, not the first year twice", () => {
    const v = view();
    const y1 = v.figure("revenue", "FY+1");
    const y2 = v.figure("revenue", "FY+2");
    if (!isProjectedFigure(y1) || !isProjectedFigure(y2)) throw new Error("refused");
    expect(y1.basis.find((a) => a.id === "revenue_growth")?.value).toBe(0.08);
    expect(y2.basis.find((a) => a.id === "revenue_growth")?.value).toBe(0.06);
  });

  it("no projected figure carries a source cell", () => {
    const root = payload() as Record<string, unknown>;
    expect(actualProvenanceOnProjection(root.figures)).toEqual([]);
    expect(() => assertNoActualProvenance(root.figures)).not.toThrow();
  });

  it("PLANT: a source cell on a projected figure is caught", () => {
    const root = JSON.parse(readFileSync(FP1, "utf8"));
    root.figures[0].provenance = {
      snapshot_id: "saga_10_col_agras",
      line_id: "pl_revenue",
    };
    expect(actualProvenanceOnProjection(root.figures)).toEqual([
      "$[0].provenance.snapshot_id",
      "$[0].provenance.line_id",
    ]);
    expect(() => readProjection(root)).toThrow(/no source cell/);
  });

  it("base_period.snapshot_id is the one permitted source reference", () => {
    const root = payload() as Record<string, unknown>;
    expect(actualProvenanceOnProjection(root)).toEqual([]);
    expect(view().baseSnapshotId).toBe("saga_10_col_agras");
    for (const figure of view().figures()) {
      expect(JSON.stringify(figure)).not.toContain("snapshot_id");
      expect(JSON.stringify(figure)).not.toContain("line_id");
    }
  });

  it("a figure whose assumptions do not resolve is refused, not numbered", () => {
    const root = JSON.parse(readFileSync(FP1, "utf8"));
    root.figures[0].assumption_ids = ["a_driver_nobody_declared"];
    const v = readProjection(root);
    const figure = v!.figure("revenue", "FY+1");
    expect(isProjectionRefusal(figure)).toBe(true);
    if (!isProjectionRefusal(figure)) throw new Error("unreachable");
    expect(figure.code).toBe("no_assumptions_behind_it");
    for (const value of Object.values(figure)) {
      expect(typeof value).not.toBe("number");
    }
  });

  it("a line the projection does not carry is a refusal carrying no number", () => {
    const figure = view().figure("goodwill", "FY+1");
    expect(isProjectionRefusal(figure)).toBe(true);
    if (!isProjectionRefusal(figure)) throw new Error("unreachable");
    expect(figure.code).toBe("not_projected");
    expect(figure.projected).toBe(true);
  });

  it("a period outside the horizon is refused, never extrapolated", () => {
    const figure = view().figure("revenue", "FY+9");
    expect(isProjectionRefusal(figure)).toBe(true);
    if (!isProjectionRefusal(figure)) throw new Error("unreachable");
    expect(figure.code).toBe("outside_horizon");
    expect(figure.detail).toContain("FY+1, FY+2, FY+3");
  });
});

// ─── the balance check: a hard error, not a rounding note ───────────────

describe("the projected balance sheet", () => {
  it("closes to the cent on the real book", () => {
    const v = view();
    expect(v.balanceCheck.length).toBe(3);
    for (const row of v.balanceCheck) {
      expect(row.differenceMinor).toBe(0);
      expect(row.balances).toBe(true);
    }
    expect(v.unbalancedPeriods).toEqual([]);
  });

  it("PLANT: one cent of imbalance is an unbalanced year, not a rounding note", () => {
    const root = JSON.parse(readFileSync(FP1, "utf8"));
    root.balance_check[2].difference_minor = 1;
    const v = readProjection(root)!;
    expect(v.unbalancedPeriods).toEqual(["FY+3"]);
    expect(v.balanceCheck[2].balances).toBe(false);
  });

  it("unbalanced years come back in horizon order, never Set order", () => {
    const root = JSON.parse(readFileSync(FP1, "utf8"));
    for (const row of root.balance_check) row.difference_minor = 7;
    expect(readProjection(root)!.unbalancedPeriods).toEqual([
      "FY+1",
      "FY+2",
      "FY+3",
    ]);
  });
});

// ─── the contract does not drift from the engine's ──────────────────────

describe("fp1 constants agree with the engine's own contract module", () => {
  const contractPy = readFileSync(
    resolve(REPO, "src/engine/forecast_serving/contract.py"),
    "utf8",
  );

  it("the version and the discriminant", () => {
    expect(contractPy).toContain(`CONTRACT_VERSION = "${FORECAST_CONTRACT_VERSION}"`);
    expect(contractPy).toContain(`KIND = "${PROJECTION_KIND}"`);
  });

  it("the units", () => {
    for (const unit of ASSUMPTION_UNITS) {
      expect(contractPy).toContain(`"${unit}"`);
    }
  });

  it("the actual-provenance field list", () => {
    for (const field of ACTUAL_PROVENANCE_FIELDS) {
      expect(contractPy).toContain(`"${field}"`);
    }
  });

  it("the marker name", () => {
    const projectionPy = readFileSync(
      resolve(REPO, "src/engine/forecast_serving/projection.py"),
      "utf8",
    );
    expect(projectionPy).toContain(`PROJECTED_MARKER = "${PROJECTED_MARKER}"`);
  });
});

// ─── determinism ────────────────────────────────────────────────────────

describe("determinism", () => {
  it("two reads of the same bytes produce the same figures", () => {
    const a = JSON.stringify(view().figures());
    const b = JSON.stringify(view().figures());
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(2000);
  });

  it("lines() is sorted, not insertion- or Set-ordered", () => {
    expect(view().lines()).toEqual([
      "ebitda",
      "revenue",
      "total_assets",
      "total_equity",
      "total_liabilities",
    ]);
  });
});

// ─── W1: THE SERVED SHAPE, READ BY ITS OWN READER ───────────────────────
//
// Everything above reads `fp1_agras.json` — the INPUT payload the engine is
// handed. That is not what a browser receives. What a browser receives is
// `ProjectionGateway.as_dict()`, and until this block existed NOTHING on
// either side of the boundary ever read it: the Python suite called
// `as_dict()` seven times and never fed it back, and this file only ever
// handed `readProjection` a hand-written input-shaped payload.
//
// MEASURED on the engine's own bytes, before the repair:
//   readProjection(gateway.as_dict())
//     -> 15 figures, 0 served, 15 refused
//     -> {"projected":true,"refused":true,"code":"no_assumptions_behind_it"}
//   which ProjectedAmount.tsx:100-113 paints as an em-dash.
// So every projected figure on every surface would have rendered "—" while
// the engine held the number and considered it served.
//
// Cause: `as_dict()` renamed the amount to `amount_minor_projected` and
// replaced `assumption_ids` with an expanded `basis`, and `basisFor()` above
// resolves a basis from `assumption_ids`/`assumptionIds` and nothing else.
//
// A shape nobody feeds back is a shape nobody has read.

describe("the wire form the engine actually serves", () => {
  const served = () => JSON.parse(readFileSync(FP1_SERVED, "utf8")) as unknown;

  it("reads as a projection at all", () => {
    expect(readProjection(served())).not.toBeNull();
  });

  it("serves every figure — none of them refused", () => {
    const figures = readProjection(served())!.figures();
    expect(figures.length).toBe(15);
    const refused = figures.filter(isProjectionRefusal);
    expect(
      refused.map((r) => `${r.line}/${r.period}: ${r.code}`),
    ).toEqual([]);
    expect(figures.filter(isProjectedFigure).length).toBe(15);
  });

  it("carries the same number as the input form, to the cent", () => {
    const f = readProjection(served())!.figure("revenue", "FY+1");
    if (!isProjectedFigure(f)) throw new Error(`refused: ${JSON.stringify(f)}`);
    expect(unwrapProjected(f, "base", (m) => m)).toBe(12806296521);
  });

  it("carries the DRIVER VALUES, not a schedule serialized away", () => {
    // The second half of the same defect: the wire form used to emit a
    // period-less AssumptionRef and drop the `values` map, so every driver
    // read back as `value: null` — ABSENT — while the payload it came from
    // stated 0.08. A schedule serialized away reads as absent and is not.
    const f = readProjection(served())!.figure("revenue", "FY+1");
    if (!isProjectedFigure(f)) throw new Error(`refused: ${JSON.stringify(f)}`);
    expect(f.basis.map((a) => [a.id, a.value])).toEqual([
      ["revenue_growth", 0.08],
    ]);
    expect(f.basis[0].basis.length).toBeGreaterThan(20);
  });

  it("agrees with the input form on every figure and every basis", () => {
    const fromInput = readProjection(payload())!;
    const fromWire = readProjection(served())!;
    expect(fromWire.horizon).toEqual(fromInput.horizon);
    expect(fromWire.lines()).toEqual(fromInput.lines());
    expect(fromWire.unbalancedPeriods).toEqual(fromInput.unbalancedPeriods);
    for (const [i, a] of fromInput.figures().entries()) {
      const b = fromWire.figures()[i];
      expect(isProjectedFigure(b)).toBe(true);
      if (!isProjectedFigure(a) || !isProjectedFigure(b)) continue;
      expect([b.line, b.period]).toEqual([a.line, a.period]);
      expect(unwrapProjected(b, "x", (m) => m)).toBe(
        unwrapProjected(a, "x", (m) => m),
      );
      expect(b.basis.map((r) => [r.id, r.value])).toEqual(
        a.basis.map((r) => [r.id, r.value]),
      );
    }
  });

  it("carries no source cell on any figure", () => {
    const root = served() as Record<string, unknown>;
    expect(actualProvenanceOnProjection(root.figures)).toEqual([]);
    expect(() => assertNoActualProvenance(root)).not.toThrow();
  });

  it("still reads the unmistakable amount name, so neither can be dropped", () => {
    // Both names ride on the wire and carry the identical integer. The
    // unmistakable one exists so no actuals consumer reaches it by habit;
    // the contract's one exists so the payload reads back. Emitting only one
    // is what caused the em-dash above, in either direction.
    const figures = (served() as { figures: Record<string, unknown>[] }).figures;
    for (const f of figures) {
      expect(f.amount_minor).toBe(f.amount_minor_projected);
      expect(f.assumption_ids).toEqual(
        (f.basis as { id: string }[]).map((a) => a.id),
      );
      expect(f[PROJECTED_MARKER]).toBe(true);
    }
  });
});

// ─── W2: the guard sees the PRODUCER'S shape, not only the served one ───
//
// `engine.forecast.Projection.as_dict()` stamps `schema: "forecast_v1"` and
// carries no `kind`, no `projected` marker, no `assumption_ids` — so every
// other branch of `looksProjected` misses it. Measured on the engine side
// before the repair: a real 16-period projection pasted into a real served
// envelope produced ZERO leak paths.

describe("the producer's own shape is recognised as a projection", () => {
  const producerShaped = {
    schema: "forecast_v1",
    opening: { snapshot_id: "sha256-abc", currency: "RON", lines: [] },
    periods: [{ period: { label: "2026-01" }, pl: { revenue: 10876580.61 } }],
  };

  it("looksProjected sees it", () => {
    expect(looksProjected(producerShaped)).toBe(true);
  });

  it("PLANT: it is caught inside an actuals payload, at its path", () => {
    const planted = JSON.parse(readFileSync(AGRAS, "utf8"));
    planted.envelope.forecast = producerShaped;
    expect(projectionLeaksIntoActuals(planted)).toContain("$.envelope.forecast");
    expect(() => assertNoProjectionInActuals(planted)).toThrow(
      /sitting inside an ACTUALS/,
    );
  });

  it("and the untouched book is still clean — the key `schema` is NOT the signal", () => {
    // Load-bearing: the committed book carries `envelope.canonical_bs.schema
    // === "bs_v2"`. A guard keyed on the key name rather than on its value
    // would flag every book in the product.
    const clean = JSON.parse(readFileSync(AGRAS, "utf8"));
    expect(clean.envelope.canonical_bs.schema).toBe("bs_v2");
    expect(projectionLeaksIntoActuals(clean)).toEqual([]);
  });

  it("the producer's base-book pointer is not read as a source cell", () => {
    // `opening.snapshot_id` is the same pointer fp1 calls
    // `base_period.snapshot_id`, under the producer's own word for it.
    expect(actualProvenanceOnProjection(producerShaped)).toEqual([]);
    expect(() => assertNoActualProvenance(producerShaped)).not.toThrow();
  });

  it("but a source cell on a producer FIGURE still is", () => {
    const planted = JSON.parse(JSON.stringify(producerShaped));
    planted.periods[0].line_id = "pl_revenue";
    expect(actualProvenanceOnProjection(planted)).toEqual([
      "$.periods[0].line_id",
    ]);
    expect(() => assertNoActualProvenance(planted)).toThrow(
      /no source cell/,
    );
  });
});

describe("the producer-facing constants agree with the engine's", () => {
  const contractPy = readFileSync(
    resolve(REPO, "src/engine/forecast_serving/contract.py"),
    "utf8",
  );

  it("the producer schema roster", () => {
    for (const schema of PRODUCER_SCHEMAS) {
      expect(contractPy).toContain(`PRODUCER_SCHEMAS = ("${schema}",)`);
    }
  });

  it("the base-period key roster", () => {
    // `basePeriod` is the FE's own camelCase tolerance and has no Python
    // counterpart; the two snake_case names must exist on both sides.
    for (const key of BASE_PERIOD_KEYS) {
      if (key === "basePeriod") continue;
      expect(contractPy).toContain(`"${key}"`);
    }
    expect(contractPy).toContain("BASE_PERIOD_KEYS = (");
  });
});

// ─── W3: an unreadable driver value is ABSENT on the read side ──────────
//
// The engine contract now REFUSES a schedule it cannot read (a string, a
// bool, a NaN) — `assumption_values_not_a_schedule` /
// `assumption_value_neither_number_nor_absent` — so a payload shaped like
// this should never reach a browser. This block pins what happens if one
// does: `null`, never `0`. A consumer coercing that null to 0 is the next
// absent-as-zero, and the type (`value: number | null`) is what makes the
// coercion a decision somebody has to write down.

describe("a driver value the payload does not state reads as ABSENT", () => {
  const withValues = (values: unknown) => {
    const root = JSON.parse(readFileSync(FP1, "utf8"));
    root.assumptions[0].values = values;
    return readProjection(root)!.figure("revenue", "FY+1");
  };

  it("null for a period the model could not derive — not zero", () => {
    const f = withValues({ "FY+1": null, "FY+2": 0.06, "FY+3": 0.05 });
    if (!isProjectedFigure(f)) throw new Error("refused");
    expect(f.basis[0].value).toBeNull();
    expect(f.basis[0].value).not.toBe(0);
    // The driver is still SHOWN — it exists, and its value for this year is
    // stated as not stated. That is a different fact from "0%".
    expect(f.basis[0].id).toBe("revenue_growth");
    expect(f.basis[0].basis.length).toBeGreaterThan(20);
  });

  it.each([
    ["a string", { "FY+1": "0.08" }],
    ["a boolean", { "FY+1": true }],
    ["a NaN-ish string", { "FY+1": "NaN" }],
    ["not a map at all", "eight percent"],
    ["a period the schedule never names", { "FY+9": 0.08 }],
  ])("%s reads as null, never 0", (_label, values) => {
    const f = withValues(values);
    if (!isProjectedFigure(f)) throw new Error("refused");
    expect(f.basis[0].value).toBeNull();
  });
});
