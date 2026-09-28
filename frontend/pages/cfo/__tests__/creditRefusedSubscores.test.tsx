// A REFUSED SUB-SCORE REFUSES THE COMPOSITE AND THE LETTER, ON EVERY
// SURFACE THAT PRINTS ONE — AND THE WEIGHTS ARE NEVER RENORMALISED.
//
// ─── THE DEFECT (R2b critic, 2026-09-15; corrected by ruling Q2 /
// R-COMPOSITE the same day) ─────────────────────────────────────────────
//
// An earlier cut of credit model revision 2 refused a sub-score whose
// base was not positive and computed the composite over the rest,
// renormalised. Measured on the real route: `corpus/imbalance_03pct`
// served 39.2 CCC over 60% of the model; `saga_compact_6_col` served
// 97.5 AAA over five terms, and one FE reader printed 30/33/25/17/17/10/8
// (140%) beside it. A composite scored over part of its model is a
// different model wearing its name. Revision 2 as shipped REFUSES: any
// unscored component -> no composite, no letter, the refused components
// listed with their reasons; the weights stay the model's seven constants
// on every row (R-COMPOSITE), and the reader re-checks a served composite
// against the model's declared range before rendering (R-RANGE, C9.4).
//
// ─── WHAT THIS FILE READS ──────────────────────────────────────────────
//
// `frontend/lib/__tests__/fixtures/served_credit_refusals.json`, captured
// from the real route and the route's own envelope builder, kept fresh by
// `tests/engine/test_credit_refusal_fe_fixture.py`. Four cases: the serve
// branch (Altman + liquidity refused), the as_filed branch, the planted
// long-term-debt book (liquidity only), and revision-2 metric rows with no
// credit envelope (weights unknown).
//
// ─── WHAT THIS REDS ON, AFTER THE REPAIR (TC-11) ───────────────────────
//
//   · the reader minting a score or a letter for a period with a refused
//     component (or from a served composite beside one, or from a served
//     composite outside [0, 100]); a refused row carrying a contribution
//     or a value, or no refusal sentence; any row's weight differing from
//     the model's constant (served `composite_weights` verbatim); the
//     seven weights not summing to one;
//   · the model sentence spelling anything but the seven-term vector, or
//     not naming what was not scored and that there is no composite;
//   · the Risks tab, the hero, /report's card, the exported report, the
//     workbook or the credit-contribution chart printing a score, a
//     letter, or a renormalised weight, or omitting the composite's
//     refusal sentence and its refused components;
//   · /report printing no card for an engine period whose composite refused;
//   · the served declared rung (coverage / DSCR on the compact book) not
//     read as "declared, not measured".

import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import * as XLSX from "xlsx";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@/stores/currency", () => ({
  useCurrency: () => ({ display: "RON", rates: { rates: {} } }),
  useAmountFormatter:
    () =>
    (v: number | null | undefined): string =>
      v === null || v === undefined ? "—" : String(Math.round(v * 100) / 100),
  useDisplayCurrency: () => "RON",
  useRates: () => ({ rates: {} }),
  CurrencyProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock("@/lib/supabase", () => ({ getSupabase: () => null }));
const stableToast = { toast: () => undefined };
vi.mock("@/hooks/use-toast", () => ({ useToast: () => stableToast }));
vi.mock("@/hooks/useActivePeriodFallback", () => ({
  useActivePeriodFallback: () => ({ periodId: "p-compact", status: "resolved" }),
}));

import ComprehensiveReport from "@/pages/cfo/ComprehensiveReport";
import { HeroVerdictCard, RisksPanel } from "@/pages/cfo/FinancialStatements";
import { computeCreditScore, spellWeights, type CreditScoreResult } from "@/lib/financialValuation";
import { buildExcelWorkbook, buildReportHtml } from "@/lib/financialExports";
import { creditContributions, type ChartInputs } from "@/lib/charts/reportCharts";
import type { Statements } from "@/lib/financialReport";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/* eslint-disable @typescript-eslint/no-explicit-any */
const FIXTURE = resolve(__dirname, "../../../lib/__tests__/fixtures/served_credit_refusals.json");
const RAW = JSON.parse(readFileSync(FIXTURE, "utf-8")) as Record<string, any>;
const STATEMENTS = RAW.statements as Statements;
const KEYS = ["altman", "profitability", "leverage", "coverage", "dscr", "liquidity", "equity"] as const;
type Key = (typeof KEYS)[number];

interface Case {
  name: string;
  credit: any | undefined;
  metrics: Record<string, number | null>;
  /** The sub-scores the composite was scored without. */
  refused: Set<Key>;
  /** True when the envelope served its `composite_weights` object. */
  weightsServed: boolean;
}

const MODEL: Record<Key, number> = {
  altman: 0.3, profitability: 0.2, leverage: 0.15, coverage: 0.1, dscr: 0.1, liquidity: 0.1, equity: 0.05,
};

function caseOf(name: string, label = name, strip?: (credit: any) => void): Case {
  const c = JSON.parse(JSON.stringify(RAW[name]));
  const metrics: Record<string, number | null> = {};
  for (const r of c.metrics) metrics[r.name] = r.value;
  const credit = c.credit ?? undefined;
  if (credit && strip) strip(credit);
  const refused = new Set<Key>(
    credit
      ? credit.refused_subscores
        ? (Object.keys(credit.refused_subscores) as Key[])
        : KEYS.filter((k) => credit.subscores?.[k] === null)
      : KEYS.filter((k) => metrics[`credit_subscore_${k}`] === null),
  );
  return { name: label, credit, metrics, refused, weightsServed: !!credit?.composite_weights };
}
const CASES = [
  ...["compact_serve", "compact_as_filed", "compact_ltd_only", "compact_metrics_only"].map((n) => caseOf(n)),
  // (An envelope stripped of BOTH its reasons and its refused entries is
  // not a case here: the engine then states nothing about credit, and the
  // completeness law — financialCompletenessLaw.test.tsx — holds that
  // shape to "no card, no invented figure".)
  // THE RENORMALISED SHAPE ITSELF, planted: a composite and a letter served
  // beside a refused component, with five renormalised weights. The reader
  // must withhold the composite and the letter and print the model weights.
  caseOf("compact_serve", "compact_serve_renormalised_composite_planted", (credit) => {
    credit.composite_score = 97.5;
    credit.letter_grade = "AAA";
    credit.composite_weights = { profitability: 0.333, leverage: 0.25, coverage: 0.167, dscr: 0.167, equity: 0.083 };
  }),
  // A composite outside the model's declared range, planted (R-RANGE, C9.4).
  caseOf("compact_ltd_only", "compact_ltd_composite_out_of_range_planted", (credit) => {
    credit.composite_score = 140;
    credit.letter_grade = "AAA";
  }),
];

function reader(c: Case): CreditScoreResult {
  return computeCreditScore(STATEMENTS, c.credit, undefined, c.metrics);
}

/** "30%" -> 30; "refused" / anything else -> null. */
const pct = (t: string): number | null => (/^\d+%$/.test(t.trim()) ? Number(t.trim().slice(0, -1)) : null);

/** Weight cells of a printed component table, keyed by row label: EVERY
 *  row prints the model's constant, refused or not, and the seven sum to
 *  100% (R-COMPOSITE: never renormalised). */
function assertWeightColumn(where: string, r: CreditScoreResult, _c: Case, cellOf: (label: string) => string | null) {
  let sum = 0;
  r.components.forEach((row, i) => {
    const cell = cellOf(row.label);
    expect(cell, `${where}: no printed row for "${row.label}"`).not.toBeNull();
    const p = pct(cell as string);
    expect(p, `${where}: "${row.label}" prints no weight ("${cell}")`).not.toBeNull();
    expect(p, `${where}: "${row.label}" prints a weight that is not the model's`).toBe(Math.round(MODEL[KEYS[i]] * 100));
    sum += p as number;
  });
  expect(sum, `${where}: printed weights sum to ${sum}%`).toBe(100);
}

describe("non-vacuity: the served fixture carries refusals of both kinds, and every composite refuses", () => {
  it("the cases, their refusals and their composites", () => {
    expect(CASES.map((c) => [c.name, [...c.refused].sort()])).toEqual([
      ["compact_serve", ["altman", "liquidity"]],
      ["compact_as_filed", ["altman", "liquidity"]],
      ["compact_ltd_only", ["coverage", "dscr", "liquidity"]],
      ["compact_metrics_only", ["altman", "liquidity"]],
      ["compact_serve_renormalised_composite_planted", ["altman", "liquidity"]],
      ["compact_ltd_composite_out_of_range_planted", ["coverage", "dscr", "liquidity"]],
    ]);
    for (const c of CASES) {
      const r = reader(c);
      expect(r.score, c.name).toBeNull();
      expect(r.rating, c.name).toBeNull();
      expect(r.compositeRefusal?.sentence, c.name).toMatch(/^No composite and no letter/);
    }
    // the served envelope carries the model table, never a renormalised one
    expect(RAW.compact_serve.credit.composite_weights).toEqual(MODEL);
    expect(RAW.compact_serve.credit.reason.code).toBe("credit_component_undefined");
    expect(RAW.compact_serve.credit.reason.components.map((x: any) => x.component)).toEqual(["altman", "liquidity"]);
    // the R-D1 declared rung is served labelled on the compact book
    expect(Object.keys(RAW.compact_serve.credit.declared_rungs).sort()).toEqual(["coverage", "dscr"]);
  });

  it("the planted shapes are withheld with their own reason", () => {
    const renorm = reader(CASES[4]);
    expect(renorm.compositeRefusal?.code).toBe("credit_component_undefined");
    expect(renorm.compositeRefusal?.sentence).toContain("97.5");
    expect(renorm.compositeRefusal?.components).toEqual(["Altman Z″", "liquidity"]);
    const oor = reader(CASES[5]);
    expect(oor.compositeRefusal?.code).toBe("credit_out_of_range");
    expect(oor.compositeRefusal?.sentence).toContain("[0, 100]");
  });

  it("the served declared rung reads as declared, not measured", () => {
    const r = reader(CASES[0]);
    const coverage = r.components[3];
    const dscr = r.components[4];
    expect(coverage.declaredRung?.score).toBe(95);
    expect(dscr.declaredRung?.score).toBe(90);
    expect(coverage.read).toMatch(/^Declared rung 95, not measured — no interest-bearing debt/);
    expect(r.components[1].declaredRung ?? null).toBeNull();
  });
});

describe.each(CASES)("$name", (c) => {
  it("the reader: a refused row keeps the model weight, contributes nothing and says why; no composite, no letter", () => {
    const r = reader(c);
    expect(r.model).toBe("engine-canonical-v1");
    let sum = 0;
    r.components.forEach((row, i) => {
      const key = KEYS[i];
      // THE WEIGHT IS THE MODEL'S CONSTANT ON EVERY ROW — served verbatim
      // when the envelope carries the table; the planted renormalised
      // table is not read as a weight (its keys are absent or wrong).
      if (c.name === "compact_serve_renormalised_composite_planted") {
        expect(row.weight === null || row.weight === c.credit.composite_weights[key], row.label).toBe(true);
      } else {
        expect(row.weight, row.label).toBe(MODEL[key]);
        sum += row.weight as number;
      }
      if (c.refused.has(key)) {
        expect([row.value, row.subscore, row.contribution], `${row.label}: a refused row carries a figure`).toEqual([null, null, null]);
        expect(row.refusal?.sentence, `${row.label}: refused without a sentence`).toMatch(/^Not scored — /);
        expect(row.refusal?.code ?? null).toBe(c.credit?.refused_subscores?.[key]?.code ?? null);
        const servedText = c.credit?.refused_subscores?.[key]?.text;
        if (servedText) expect(row.refusal?.sentence).toBe(`Not scored — ${servedText}`);
      } else {
        expect(row.refusal ?? null, `${row.label} is scored but carries a refusal`).toBeNull();
        expect(row.contribution, row.label).not.toBeNull();
      }
    });
    if (c.name !== "compact_serve_renormalised_composite_planted") expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
    expect(r.score).toBeNull();
    expect(r.rating).toBeNull();
    expect(r.grade).toBeNull();
    const refusal = r.compositeRefusal!;
    expect(refusal.sentence).toMatch(/^No composite and no letter/);
    for (const key of c.refused) expect(refusal.sentence + refusal.components.join(" ")).toContain(
      key === "altman" ? "Altman" : key === "coverage" ? "coverage" : key === "dscr" ? "DSCR" : key,
    );
  });

  it("the model sentence spells the seven-term model vector and says there is no composite", () => {
    const r = reader(c);
    const w = spellWeights(r.components);
    if (c.name === "compact_serve_renormalised_composite_planted") {
      // a planted partial table is not a vector: nothing is spelled
      expect(w).toBeNull();
      expect(r.modelLabel).not.toMatch(/weights \d/);
    } else {
      expect(w).toBe("30/20/15/10/10/10/5");
      expect(r.modelLabel).toContain("weights 30/20/15/10/10/10/5");
      expect(r.modelLabel).not.toContain(" over ");
    }
    expect(r.modelLabel).toContain("not scored: ");
    expect(r.modelLabel).toContain("no composite and no letter");
    expect(r.caveat).toContain("never redistributed");
    if (c.refused.has("altman")) {
      expect(r.modelLabel).toContain("Altman Z″");
      expect(r.caveat).not.toContain("as the dominant signal");
    }
    if (c.refused.has("liquidity")) expect(r.modelLabel).toContain("liquidity");
  });

  it("the Risks tab prints the refusal, no rating, and the model weights on every row", () => {
    const r = reader(c);
    const { container } = render(
      <RisksPanel statements={STATEMENTS} creditEnvelope={c.credit} metricsByName={c.metrics} />,
    );
    expect(screen.getByTestId("credit-model").textContent?.trim()).toBe(r.modelLabel);
    expect(screen.getByTestId("credit-composite").textContent).toContain(r.compositeRefusal!.sentence);
    expect(screen.getByTestId("credit-rating").textContent).not.toMatch(/^(AAA|AA|A|BBB|BB|B|CCC|CC)$/);
    const rows = Array.from(container.querySelectorAll("tr"));
    if (c.name === "compact_serve_renormalised_composite_planted") return;
    assertWeightColumn("Risks tab", r, c, (label) => {
      const tr = rows.find((x) => x.querySelector("td")?.textContent?.trim() === label);
      return tr ? (tr.querySelectorAll("td")[2]?.textContent ?? "") : null;
    });
    for (const [i, row] of r.components.entries()) {
      if (!c.refused.has(KEYS[i])) continue;
      const tr = rows.find((x) => x.querySelector("td")?.textContent?.trim() === row.label)!;
      expect(tr.querySelectorAll("td")[4]?.textContent).toBe(row.refusal?.sentence);
    }
  });

  it("the hero prints no score and no letter for a refused composite", () => {
    const r = reader(c);
    render(
      <TooltipProvider>
        <HeroVerdictCard credit={r} companyName="saga_compact_6_col" />
      </TooltipProvider>,
    );
    const hero = screen.getByTestId("hero-verdict");
    expect(hero.getAttribute("data-band")).toBe("pending");
    expect(hero.getAttribute("data-score")).toBeNull();
    expect(hero.textContent).not.toMatch(/\b(AAA|AA|BBB|BB|CCC|CC)\b/);
  });

  it("/report renders the card with the composite refused, its reason, and no letter", async () => {
    const r = reader(c);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          period: { id: "p-compact", period_end: "2025-12-31", currency: "RON",
                    source_document: { filename: "balanta.xlsx", id: "d1" } },
          statements: STATEMENTS,
          metrics: Object.entries(c.metrics).map(([name, value]) => ({ name, value })),
          alerts: [], recommendations: [], line_items: [],
          assembled_metrics: { credit: c.credit ?? null },
        }),
      })),
    );
    const { container } = render(
      <TooltipProvider>
        <MemoryRouter initialEntries={["/report?period=p-compact"]}>
          <ComprehensiveReport />
        </MemoryRouter>
      </TooltipProvider>,
    );
    await screen.findByTestId("comprehensive-report");
    const card = await screen.findByTestId("credit-score-card");
    expect(container.textContent).not.toContain("Credit score not available");
    expect(screen.queryByTestId("report-credit-letter")).toBeNull();
    expect(screen.getByTestId("report-credit-refused").textContent).toBe("refused");
    expect(screen.getByTestId("report-credit-composite-refusal").textContent).toBe(r.compositeRefusal!.sentence);
    expect(screen.getByTestId("report-credit-model").textContent).toContain(r.modelLabel);
    if (c.refused.has("altman")) {
      expect(screen.getByTestId("report-altman-refused").textContent).toContain(
        r.components[0].refusal?.sentence as string,
      );
    }
    for (const [i, key] of KEYS.entries()) {
      if (!c.refused.has(key)) continue;
      const label = ["Altman Z″", "Profitability", "Leverage", "Interest coverage", "DSCR", "Liquidity", "Equity ratio"][i];
      expect(screen.getByTestId(`score-bar-refusal-${label}`).textContent).toBe(r.components[i].refusal?.sentence);
    }
  });

  it("the exported report and the workbook print the refusal, no letter, and the model weights", () => {
    const r = reader(c);
    const envelopes = { credit: c.credit, piotroski: undefined, metricsByName: c.metrics };
    const html = buildReportHtml(STATEMENTS, envelopes);
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(doc.querySelector("[data-report-credit-score]")?.textContent?.trim()).toBe("not reported");
    expect(doc.querySelector("[data-report-credit-letter]")?.textContent?.trim() ?? "not reported").toBe("not reported");
    expect(doc.querySelector("[data-report-credit-composite-refusal]")?.textContent).toContain(r.compositeRefusal!.sentence);
    // The model's COMPONENT table (Component | Value | Weight | Contribution
    // | Read) — not the first row anywhere in the document that happens to
    // carry the label: the executive summary lists the Altman ratio too
    // whenever it is among the top graded rows.
    const componentTable = Array.from(doc.querySelectorAll("table")).find((t) => {
      const head = t.querySelector("thead")?.textContent ?? "";
      return /Weight/.test(head) && /Contribution/.test(head);
    });
    expect(componentTable, "the exported report prints no component table").toBeDefined();
    const trs = Array.from(componentTable!.querySelectorAll("tbody tr"));
    if (c.name === "compact_serve_renormalised_composite_planted") return;
    assertWeightColumn("exported report", r, c, (label) => {
      const tr = trs.find((x) => x.querySelector("td")?.textContent?.trim() === label);
      return tr ? (tr.querySelectorAll("td")[2]?.textContent ?? "") : null;
    });

    const wb = buildExcelWorkbook(STATEMENTS, undefined, envelopes);
    const dir = mkdtempSync(join(tmpdir(), "credit-refused-"));
    let back: XLSX.WorkBook;
    try {
      XLSX.writeFile(wb, join(dir, "book.xlsx"));
      back = XLSX.read(readFileSync(join(dir, "book.xlsx")), { type: "buffer" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const rows = XLSX.utils.sheet_to_json<(string | number)[]>(back.Sheets["Credit & Risk"], { header: 1 });
    assertWeightColumn("workbook", r, c, (label) => {
      const row = rows.find((x) => String(x[0]) === label);
      return row ? String(row[2] ?? "") : null;
    });
    const refusedRow = rows.find((x) => String(x[0]) === "Composite and rating refused");
    expect(refusedRow?.[1]).toBe(r.compositeRefusal!.sentence);
    expect(rows.find((x) => String(x[0]) === "Rating")?.[1]).toBe("not reported");
  });

  it("the credit-contribution chart keeps the model ceiling and draws no contribution for a refused term", () => {
    const r = reader(c);
    const block = creditContributions({ credit: r } as unknown as ChartInputs);
    let ceilings = 0;
    block.rows.forEach((row: any, i: number) => {
      if (c.refused.has(KEYS[i])) {
        expect(row.value, `chart term ${row.label} draws a contribution`).toBeNull();
        expect(row.printed).toBe("refused");
        expect(row.source).toContain("not scored: ");
      }
      if (row.ceiling !== null) ceilings += row.ceiling;
    });
    if (c.name !== "compact_serve_renormalised_composite_planted") expect(Math.abs(ceilings - 100)).toBeLessThan(1e-6);
  });
});

// ─── R-RANGE on a FULLY SCORED envelope (C9.4; B8 verifier D7) ──────────────
// Over the compact cases a planted composite 140 is withheld by the
// beside-refused branch anyway, so the reader's own range re-check was
// pinned by nothing. agras scores every component: with the range branch
// off, the planted 140 / AAA would print on every surface.
describe("a served composite outside the model's range on a fully scored envelope (agras)", () => {
  const raw = JSON.parse(JSON.stringify(RAW.agras_serve));
  const statements = raw.statements as Statements;
  const metrics: Record<string, number | null> = {};
  for (const r of raw.metrics) metrics[r.name] = r.value;
  const planted = { ...raw.credit, composite_score: 140, letter_grade: "AAA" };
  const plantedMetrics = { ...metrics, credit_composite: 140 };

  it("non-vacuity: the served envelope scores every component with a composite and a letter", () => {
    expect(raw.credit.refused_subscores).toEqual({});
    const r = computeCreditScore(statements, raw.credit, undefined, metrics);
    expect(r.score).toBe(raw.credit.composite_score);
    expect(r.rating).toBe(raw.credit.letter_grade);
    expect(r.components.every((c) => !c.refusal)).toBe(true);
    expect(r.compositeRefusal ?? null).toBeNull();
  });

  it("the reader withholds the planted 140 / AAA with credit_out_of_range and no refused component", () => {
    const r = computeCreditScore(statements, planted, undefined, plantedMetrics);
    expect(r.score).toBeNull();
    expect(r.rating).toBeNull();
    expect(r.grade).toBeNull();
    expect(r.compositeRefusal?.code).toBe("credit_out_of_range");
    expect(r.compositeRefusal?.sentence).toContain("140");
    expect(r.compositeRefusal?.sentence).toContain("[0, 100]");
    expect(r.compositeRefusal?.components).toEqual([]);
    expect(r.components.every((c) => !c.refusal)).toBe(true);
  });

  // AN UNREAD FIGURE DOES NOT RENDER (credit re-verify, medium, FE half).
  // An envelope that states a `basis` left the engine under the revision-2
  // serving contract, whose boundary (ratios/credit_boundary.py) serves
  // `ranges` beside every figure. With `ranges` stripped the reader once
  // fell back to a LITERAL [0, 100] kept in the browser (TC-10) and had no
  // Altman bound at all: a persisted Z″ 1584.89 / composite 88.5 on an
  // as-filed envelope rendered "Altman Z″ 1584.89, 88.5 AA".
  // REDS ON, after the repair: any figure rendering off a basis-stating
  // envelope that serves no range for it. CANNOT SEE: an envelope with no
  // `basis` (a body cached before the contract) - finiteness alone there.
  it.each(["as_filed", "serve"])("a %s envelope that serves no ranges renders no figure", (basis) => {
    const env = { ...raw.credit, basis, ranges: null, altman_z_score: 1584.89, composite_score: 88.5, letter_grade: "AA",
      altman_components: { ...raw.credit.altman_components, x4: 1500 } };
    for (const m of [{ ...metrics, altman_z_score: 1584.89, altman_x4: 1500, credit_composite: 88.5 }, undefined]) {
      const r = computeCreditScore(statements, env, undefined, m as Record<string, number | null> | undefined);
      expect(r.score).toBeNull();
      expect(r.rating).toBeNull();
      expect(r.components[0].value).toBeNull();
      expect(r.components[0].subscore).toBeNull();
      expect(r.components.every((c) => c.subscore === null)).toBe(true);
      expect(JSON.stringify(r)).not.toContain("1584.89");
    }
  });

  // R-RANGE on the ALTMAN figures (B8 repair round): the 1-RON-liabilities
  // shape, Z″ 10416.74 / X4 10000, served beside the envelope's own
  // `ranges.altman_z.bound` 114.83 and `altman_x4.max` 100. Before the
  // repair the reader printed "Altman Z″ 10416.74, sub-score 100, 80.7 AA".
  // REDS ON, after the repair: a served Z″, X1 or X4 above the bound the
  // same envelope declares rendering a value, a sub-score, a composite or
  // a letter. CANNOT SEE: an envelope that serves no Altman bounds (the
  // bounds are pack data, read only as served — the engine's as-filed
  // branch withdraws those itself, test_credit_model_rungs_and_ranges.py).
  it.each([
    ["Z″ and X4", { altman_z_score: 10416.74, altman_x4: 10000 }, { altman_z_score: 10416.74, x4: 10000 }],
    ["Z″ alone, above its bound", { altman_z_score: 120 }, { altman_z_score: 120 }],
    ["X1 above 1", { altman_x1: 1.5 }, { x1: 1.5 }],
  ])("a served Altman figure outside its declared range is withheld: %s", (_n, rowPlant, envPlant) => {
    expect(raw.credit.ranges.altman_z.bound).toBeGreaterThan(100);
    expect(raw.credit.ranges.altman_x4.max).toBe(100);
    const { altman_z_score: envZ, ...comps } = envPlant as Record<string, number>;
    const env = {
      ...raw.credit,
      ...(envZ !== undefined ? { altman_z_score: envZ } : {}),
      altman_components: { ...raw.credit.altman_components, ...comps },
    };
    // through the metric rows AND through the envelope alone
    for (const m of [{ ...metrics, ...rowPlant }, undefined]) {
      const r = computeCreditScore(statements, env, undefined, m as Record<string, number | null> | undefined);
      const altman = r.components[0];
      expect(altman.label).toContain("Altman");
      expect(altman.value).toBeNull();
      expect(altman.subscore).toBeNull();
      expect(altman.refusal?.code).toBe("credit_out_of_range");
      expect(r.score).toBeNull();
      expect(r.rating).toBeNull();
      expect(r.compositeRefusal?.components).toEqual(["Altman Z″"]);
    }
  });

  it("the hero and the Risks tab print no score and no letter", () => {
    const r = computeCreditScore(statements, planted, undefined, plantedMetrics);
    render(
      <TooltipProvider>
        <HeroVerdictCard credit={r} companyName="agras" />
      </TooltipProvider>,
    );
    const hero = screen.getByTestId("hero-verdict");
    expect(hero.getAttribute("data-band")).toBe("pending");
    expect(hero.getAttribute("data-score")).toBeNull();
    expect(hero.textContent).not.toMatch(/\b(AAA|AA|BBB|BB|CCC|CC)\b/);
    expect(hero.textContent).not.toContain("140");
    render(<RisksPanel statements={statements} creditEnvelope={planted} metricsByName={plantedMetrics} />);
    expect(screen.getByTestId("credit-composite").textContent).toContain(r.compositeRefusal!.sentence);
    expect(screen.getByTestId("credit-rating").textContent).not.toMatch(/^(AAA|AA|A|BBB|BB|B|CCC|CC)$/);
  });

  it("the exported report and the workbook print no score and no letter", () => {
    const r = computeCreditScore(statements, planted, undefined, plantedMetrics);
    const envelopes = { credit: planted, piotroski: undefined, metricsByName: plantedMetrics };
    const html = buildReportHtml(statements, envelopes);
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(doc.querySelector("[data-report-credit-score]")?.textContent?.trim()).toBe("not reported");
    expect(doc.querySelector("[data-report-credit-letter]")?.textContent?.trim() ?? "not reported").toBe("not reported");
    expect(doc.querySelector("[data-report-credit-composite-refusal]")?.textContent).toContain(r.compositeRefusal!.sentence);
    const wb = buildExcelWorkbook(statements, undefined, envelopes);
    const sheet = XLSX.utils.sheet_to_json<(string | number)[]>(wb.Sheets["Credit & Risk"], { header: 1 });
    const cellOf = (label: string) => sheet.find((row) => String(row[0]) === label)?.[1];
    expect(cellOf("Score (0–100)")).toBe("not reported");
    expect(cellOf("Rating")).toBe("not reported");
    const flat = sheet.map((row) => row.map((v) => String(v ?? "")).join("|")).join("\n");
    expect(flat).toContain(r.compositeRefusal!.sentence);
  });
});
