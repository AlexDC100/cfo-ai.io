// AutoMasters model — the rules the six screens apply, checked against the
// sample export in docs/automasters/sample-import.json (the prototype's own
// figures) and against hand-built edge cases.

import { describe, expect, it } from "vitest";
import sample from "../../../docs/automasters/sample-import.json";
import {
  EMPTY_DATA,
  aiSnapshot,
  alertsFor,
  centreTotals,
  classifyRecon,
  closeHint,
  closeState,
  formatMoney,
  funnelFor,
  knownPeriods,
  monthlyRevenue,
  parseImport,
  proposeMatches,
  segmentOf,
  sortCentres,
  type AmData,
  type ImportPayload,
} from "../automasters/model";

/** The import as the database would hand it back (ids assigned). */
function asData(p: ImportPayload, extra: Partial<AmData> = {}): AmData {
  return {
    ...EMPTY_DATA,
    bank: p.bank_lines.map((b, i) => ({ ...b, id: `b${i}` })),
    documents: p.documents.map((d, i) => ({ ...d, id: `d${i}` })),
    exports: p.exports.map((e, i) => ({ ...e, id: `e${i}`, retry_requested_at: null, updated_at: "2026-09-24T10:00:00Z" })),
    centres: p.centres,
    funnel: p.funnel,
    ...extra,
  };
}

function load(): AmData {
  const r = parseImport(sample);
  if ("errors" in r) throw new Error(r.errors.join("\n"));
  return asData(r.payload);
}

describe("parseImport", () => {
  it("accepts the sample export and counts every row", () => {
    const r = parseImport(sample);
    expect("errors" in r).toBe(false);
    if ("errors" in r) return;
    expect(r.counts).toEqual({ bank_lines: 5, documents: 6, exports: 10, centres: 63, funnel: 5 });
    expect(r.payload.bank_lines[0]).toMatchObject({ external_ref: "b1", currency: "EUR", suggested_document: "FF-2026-0433" });
  });

  it("refuses the wrong format, a bad row and a duplicate — with every reason", () => {
    expect(parseImport({ format: "other" })).toEqual({ ok: false, errors: ['"format" must be "automasters.cfo.v1".'] });
    const r = parseImport({
      format: "automasters.cfo.v1",
      bank_lines: [{ ref: "x", booked_on: "24.09.2026", payer: "A", amount: 1 }],
      documents: [{ number: "F1", customer: "A", amount: "abc" }, { number: "F1", customer: "B", amount: 2 }],
      exports: [{ channel: "fax", ref: "E1", status: "lost" }],
      centres: [{ period: "2026-13", centre: "X" }],
    });
    expect("errors" in r).toBe(true);
    if (!("errors" in r)) return;
    expect(r.errors).toEqual(expect.arrayContaining([
      "bank_lines[0].booked_on is missing or invalid.",
      "documents[0].amount is missing or invalid.",
      "documents has a duplicate entry: F1.",
      'exports[0].channel must be "saga" or "efactura".',
      "exports[0].status must be one of pending, sent, accepted, error, rejected, reconciled.",
      "centres[0].period is missing or invalid.",
    ]));
  });

  it("refuses a file with no rows", () => {
    expect(parseImport({ format: "automasters.cfo.v1" })).toEqual({ ok: false, errors: ["The file holds no rows."] });
  });
});

describe("reconciliation and month close", () => {
  it("classifies a difference by the 0.5% line, like am_close_period", () => {
    expect(classifyRecon(100, 100)).toBe("balanced");
    expect(classifyRecon(215000, 214548.5)).toBe("minor");   // 0.21%
    expect(classifyRecon(46200, 42780)).toBe("material");     // 7.40%
    expect(classifyRecon(1000, 995)).toBe("minor");           // exactly 0.5%
    expect(classifyRecon(1000, 994.99)).toBe("material");
    expect(classifyRecon(0, 1)).toBe("material");
    expect(classifyRecon(null, 1)).toBe("missing");
  });

  it("is not started until the month is opened", () => {
    expect(closeState(load(), "2026-09").status).toBe("not_started");
  });

  it("blocks on open checks first, then on the material centre, then allows", () => {
    const base = load();
    const keys = ["fx_rate", "close_reports"];
    const withChecks = (done: boolean, centres = base.centres): AmData => ({
      ...base,
      centres,
      periods: [{ period: "2026-09", status: "open", closed_at: null }],
      checks: keys.map((k, i) => ({ period: "2026-09", check_key: k, position: i, done, done_at: null })),
    });
    const open = closeState(withChecks(false), "2026-09");
    expect(open.block).toEqual({ kind: "open_checks", count: 2 });
    expect(open.canClose).toBe(false);
    expect(open.status).toBe("review"); // Warranty is material

    const material = closeState(withChecks(true), "2026-09");
    expect(material.block).toEqual({ kind: "material", centres: ["Warranty"] });

    const fixed = base.centres.map((c) => (c.centre === "Warranty" && c.period === "2026-09" ? { ...c, ledger_amount: 46200 } : c));
    const ok = closeState(withChecks(true, fixed), "2026-09");
    expect(ok).toMatchObject({ status: "open", canClose: true, block: null, material: [] });
  });

  it("hints what still disagrees beside a checklist item", () => {
    const d = load();
    expect(closeHint(d, "saga_export_clean", "2026-09")).toEqual({ tone: "warn", count: 1 });
    expect(closeHint(d, "advances_allocated", "2026-09")).toEqual({ tone: "warn", count: 2 });
    expect(closeHint(d, "warranty_claims", "2026-09")).toEqual({ tone: "warn", count: 1 });
    expect(closeHint(d, "fx_rate", "2026-09")).toBeNull();
  });
});

describe("profit centres and performance", () => {
  it("totals the year to date per centre and sorts by margin", () => {
    const rows = sortCentres(centreTotals(load().centres, 2026, "2026-09"), "margin");
    expect(rows.map((r) => r.centre)).toEqual(
      ["New Cars", "Service", "Parts", "Used Cars", "Accessories", "Warranty", "Internal"],
    );
    const nc = rows[0];
    expect(nc.months).toBe(9);
    expect(nc.revenue).toBe(21480000);
    expect(nc.vsBudgetPct).toBeCloseTo(4.2, 1);
    expect(nc.contributors[0]).toEqual({ name: "SF90 Stradale (9 VIN)", value: 412600 });
    expect(rows.find((r) => r.centre === "Internal")?.vsBudgetPct).toBeNull();
    expect(rows.reduce((a, r) => a + r.shareOfMargin, 0)).toBeCloseTo(100, 6);
  });

  it("stops at the month asked for", () => {
    const h1 = centreTotals(load().centres, 2026, "2026-06").find((r) => r.centre === "New Cars");
    expect(h1?.months).toBe(6);
    expect(h1?.revenue).toBe(13320000);
  });

  it("splits monthly revenue into segments", () => {
    expect(segmentOf("New Cars")).toBe("new_cars");
    expect(segmentOf("Auto noi")).toBe("new_cars");
    expect(segmentOf("Piese")).toBe("parts");
    expect(segmentOf("Warranty")).toBe("other");
    const sep = monthlyRevenue(load().centres, 2026).at(-1);
    expect(sep?.period).toBe("2026-09");
    expect(sep?.parts).toMatchObject({ new_cars: 2610000, service: 215000, parts: 150000 });
    // The sample splits "other" (445k) over four centres, each row rounded.
    expect(sep?.parts.other).toBeCloseTo(445000, -1);
  });

  it("reads the funnel with step conversions", () => {
    const f = funnelFor(load().funnel, "2026-09");
    expect(f.map((s) => [s.stage, s.width, s.conversion])).toEqual([
      ["Lead", 100, null], ["Opportunity", 57, 57], ["Expression of Interest", 40, 71], ["Order", 35, 86], ["Delivery", 31, 88],
    ]);
  });
});

describe("payments", () => {
  it("proposes the DMS's own suggestions and leaves the ambiguous to Finance", () => {
    const d = load();
    const p = proposeMatches(d);
    // b1–b4 carry a suggestion that names an open document; b5 has none and
    // its amount differs from FF-2026-0412 by 12.50 — not matched blindly.
    expect(p.map((x) => [x.bank_line_id, x.document_id, x.difference])).toEqual([
      ["b0", "d0", 0], ["b1", "d1", 0], ["b2", "d2", 0], ["b3", "d3", 0],
    ]);
  });

  it("never re-uses a matched payment or document", () => {
    const d = load();
    const matched: AmData = {
      ...d,
      matches: [{ id: "m", bank_line_id: "b0", document_id: "d0", difference: 0, method: "manual", matched_at: "" }],
    };
    expect(proposeMatches(matched).map((x) => x.bank_line_id)).toEqual(["b1", "b2", "b3"]);
  });

  it("matches on exact amount + payer when exactly one document fits", () => {
    const d = load();
    const data: AmData = { ...d, bank: [{ ...d.bank[4], amount: 571616.5 }], matches: [] };
    expect(proposeMatches(data)).toEqual([{ bank_line_id: "b4", document_id: "d4", difference: 0 }]);
  });
});

describe("Ask CFO AI snapshot and alerts", () => {
  it("states the figures the model may cite", () => {
    const s = aiSnapshot(load(), { company: "Bitton FR Holdings", today: new Date("2026-09-24T12:00:00Z") });
    expect(s).toContain("AutoMasters dealership — Bitton FR Holdings");
    expect(s).toContain("Snapshot date: 2026-09-24.");
    expect(s).toContain("- Warranty: DMS 46200.00 vs ledger 42780.00, difference 3420.00 (material)");
    expect(s).toContain("SAGA EXP-2026-09-24-03 error");
    expect(s).toContain("Sales funnel 2026-09: Lead 72 → Opportunity 41");
  });

  it("raises the open alerts", () => {
    expect(alertsFor(load()).map((a) => [a.key, a.centre ?? a.count])).toEqual([
      ["recon_minor", "Service"], ["recon_material", "Warranty"],
      ["exports_failed", 2], ["advances_open", 2], ["payments_open", 5],
    ]);
  });

  it("knows the periods newest first", () => {
    expect(knownPeriods(load())[0]).toBe("2026-09");
  });
});

describe("formatMoney", () => {
  it("never rounds, signs a negative with a minus", () => {
    expect(formatMoney(-12450, "EUR", "en-GB")).toBe("−12,450.00 EUR");
    expect(formatMoney(1802.9, "EUR", "en-GB")).toBe("1,802.90 EUR");
  });
});
