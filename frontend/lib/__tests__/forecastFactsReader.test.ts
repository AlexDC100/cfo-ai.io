/**
 * forecastFactsReader — the fp1.2 reader over the bytes the engine REALLY
 * serves (plan/2 B6, plan_contract_v2 3.1-3.7, 3.14).
 *
 * The fixture is tests/engine/fixtures/forecast/fp1_2_agras_served.json: GET
 * /api/forecast/{id}?horizon=3 on the agras corpus book through create_app,
 * held to the route by test_forecast_serving_boundary.py. Nothing here is a
 * hand-written payload, so a reader that parses only what its author imagined
 * cannot pass.
 *
 * REDS ON: a driver losing its tier or the value of its plan year; a
 * convention rendered as a quantity; an FY aggregate missing or summed in the
 * browser instead of read; a refused figure or aggregate painted as a number;
 * periodPayloadSnapshotId disagreeing with the engine's rule
 * (FactsGateway._snapshot_id_of: content_hash, else source_document_id) on
 * any of the four corpus books.
 * CANNOT SEE: what the page paints (forecastPage.test.tsx).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DRIVER_TIERS,
  FORECAST_CONTRACT_VERSION,
  isProjectedFigure,
  isProjectionRefusal,
  periodPayloadSnapshotId,
  readProjection,
  unwrapProjected,
} from "@/lib/forecastFacts";

const REPO = resolve(__dirname, "../../..");
const read = (p: string) => JSON.parse(readFileSync(resolve(REPO, p), "utf8"));
const SERVED = "tests/engine/fixtures/forecast/fp1_2_agras_served.json";
const BOOKS = ["agras", "carniprod", "realestate", "retail"];

describe("the fp1.2 reader over the real served bytes", () => {
  const raw = read(SERVED) as Record<string, any>;
  const view = readProjection(raw)!;

  it("speaks fp1.2 and refuses anything else by name", () => {
    expect(raw.contract).toBe(FORECAST_CONTRACT_VERSION);
    expect(() => readProjection({ ...raw, contract: "fp1" })).toThrow(/fp1\.2/);
  });

  it("every driver carries one of the six tiers, and a convention carries none", () => {
    const refs = view.assumptionsFor(view.horizon[0]);
    const drivers = refs.filter((r) => r.unit !== "convention");
    expect(drivers.length).toBe(raw.driver_order.length);
    for (const d of drivers) {
      expect(DRIVER_TIERS as readonly string[]).toContain(d.tier);
      expect(d.tier).toBe(raw.drivers[d.id].basis.tier);
    }
    const conventions = refs.filter((r) => r.unit === "convention");
    expect(conventions.length).toBe(Object.keys(raw.conventions).length);
    for (const c of conventions) {
      expect(c.value).toBeNull();
      expect(c.tier).toBeNull();
      expect(c.basis.length).toBeGreaterThan(0);
    }
  });

  it("values a per-year driver for the plan year of the period asked", () => {
    const served = raw.drivers.revenue_growth.values as number[];
    const first = view.assumptionsFor(view.horizon[0]).find((r) => r.id === "revenue_growth")!;
    const last = view
      .assumptionsFor(view.horizon[view.horizon.length - 1])
      .find((r) => r.id === "revenue_growth")!;
    expect(first.value).toBe(served[0] / 1_000_000);
    expect(last.value).toBe(served[served.length - 1] / 1_000_000);
    expect(view.assumptions.every((r) => r.valuedFor === null && r.value === null)).toBe(true);
  });

  it("an absent driver reads as ABSENT, never zero", () => {
    const absent = Object.values(raw.drivers as Record<string, any>).filter(
      (d) => d.basis.tier === "absent",
    );
    for (const d of absent) {
      const ref = view.assumptionsFor(view.horizon[0]).find((r) => r.id === d.key)!;
      expect(ref.value).toBeNull();
      expect(ref.tier).toBe("absent");
    }
  });

  it("an inert driver carries the engine's sentence", () => {
    const inert = Object.values(raw.drivers as Record<string, any>).filter(
      (d) => d.inert_in_this_plan,
    );
    expect(inert.length).toBeGreaterThan(0);
    for (const d of inert) {
      const ref = view.assumptions.find((r) => r.id === d.key)!;
      expect(ref.inert).toBe(d.inert_in_this_plan.text);
    }
  });

  it("reads the FY aggregate as a served figure equal to the served bytes", () => {
    expect(view.horizonAnnual).toEqual(raw.horizon.labels_annual);
    const fy = view.horizonAnnual[0];
    const figure = view.figure("pl.revenue", fy);
    expect(isProjectedFigure(figure)).toBe(true);
    const wire = (raw.figures as any[]).find(
      (f) => f.line === "pl.revenue" && f.period === fy,
    );
    expect(wire.kind).toBe("projected_aggregate");
    if (isProjectedFigure(figure)) {
      expect(unwrapProjected(figure, "test", (m) => m)).toBe(wire.amount_minor);
    }
  });

  it("a refused aggregate or period is a refusal with the engine's sentence, never a number", () => {
    const doctored = JSON.parse(JSON.stringify(raw));
    const fy = doctored.horizon.labels_annual[0];
    const sentence = { code: "plan_year_not_fully_served", text: "SYNTHETIC not served" };
    for (const f of doctored.figures) {
      if (f.period === fy) {
        delete f.amount_minor;
        f.refused = sentence;
      }
    }
    const refused = readProjection(doctored)!.figure("pl.revenue", fy);
    expect(isProjectionRefusal(refused)).toBe(true);
    if (isProjectionRefusal(refused)) expect(refused.detail).toBe(sentence.text);
  });

  it("serves the pins, the hash and the horizon the page reads, and holds no copy", () => {
    expect(view.bodyHash).toBe(raw.body_hash);
    expect(view.servedThrough).toBe(raw.horizon.served_through);
    expect(view.refusal).toBeNull();
    expect(view.notes.length).toBe(raw.notes.length);
  });
});

describe("periodPayloadSnapshotId (3.14) agrees with the engine's rule", () => {
  it.each(BOOKS)("%s: content_hash, else source_document_id", (name) => {
    const book = read(`tests/engine/fixtures/firm/saga_10_col_${name}.json`);
    const provenance = book.envelope.provenance ?? {};
    const expected = provenance.content_hash || provenance.source_document_id || null;
    const payload = { statements: { assembled_canonical_v1: book.envelope } };
    expect(periodPayloadSnapshotId(payload)).toBe(expected);
    expect(expected, `${name}: TC-3, the book states no snapshot id`).toBeTruthy();
  });

  it("answers null, never a guess, when the path is absent", () => {
    expect(periodPayloadSnapshotId({})).toBeNull();
    expect(periodPayloadSnapshotId({ statements: {} })).toBeNull();
  });
});
