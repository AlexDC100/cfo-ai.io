// A REFUSED SUB-SCORE CARRIES NO WEIGHT, ON EVERY SURFACE THAT PRINTS ONE.
//
// ─── THE DEFECT (R2b critic, 2026-09-15) ───────────────────────────────
//
// Credit model revision 2 refuses a sub-score whose base is not positive
// (liquidity with no current liabilities, Altman with no liabilities at all)
// and computes the composite over the rest, renormalised. The GET
// /api/period credit envelope then serves `composite_weights` with NO entry
// for the refused sub-score. The one FE reader read
// `numOrNull(weights.x) ?? <model default>`, so on the served
// `saga_compact_6_col` envelope every credit surface printed
//
//     weights 30/33/25/17/17/10/8          (140%)   beside composite 97.5
//
// and `/report` Section 7 said "Credit score not available — re-run the
// pipeline" (the card refused whenever Z″ was null) while the hero and the
// exported report printed 97.5 / AAA for the same period.
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
//   · the reader giving a refused row a weight or a contribution, or no
//     refusal; a scored row's weight differing from the served weight; the
//     scored weights not summing to one;
//   · the model sentence spelling a vector whose integers do not sum to 100,
//     or not naming what was not scored;
//   · the Risks tab, the hero, /report's card, the exported report, the
//     workbook or the credit-contribution chart printing a weight on a
//     refused row, or a weight column that does not sum to 100%;
//   · /report printing no card, or a composite / letter different from the
//     hero's and the exported report's, for a period with a composite;
//   · with no served weights (revision-2 rows, a sub-score absent) any row
//     printing the model table's weight.

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
  /** True when the envelope served the weights the composite used. */
  weightsServed: boolean;
}

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
        : KEYS.filter((k) => !(k in (credit.composite_weights ?? {})))
      : KEYS.filter((k) => metrics[`credit_subscore_${k}`] === null),
  );
  return { name: label, credit, metrics, refused, weightsServed: !!credit?.composite_weights };
}
const CASES = [
  ...["compact_serve", "compact_as_filed", "compact_ltd_only", "compact_metrics_only"].map((n) => caseOf(n)),
  // The shape the defect was measured on: renormalised weights with no
  // reasons beside them (an envelope from before the passthrough, or a
  // consumer that forwards `weights` alone). A key missing from the served
  // weights beside an absent sub-score is itself the refusal.
  caseOf("compact_serve", "compact_serve_weights_without_reasons", (credit) => {
    delete credit.refused_subscores;
    delete credit.model_weights;
  }),
];

function reader(c: Case): CreditScoreResult {
  return computeCreditScore(STATEMENTS, c.credit, undefined, c.metrics);
}

/** "30%" -> 30; "refused" / anything else -> null. */
const pct = (t: string): number | null => (/^\d+%$/.test(t.trim()) ? Number(t.trim().slice(0, -1)) : null);

/** Weight cells of a printed component table, keyed by row label. */
function assertWeightColumn(where: string, r: CreditScoreResult, c: Case, cellOf: (label: string) => string | null) {
  let sum = 0;
  r.components.forEach((row, i) => {
    const cell = cellOf(row.label);
    expect(cell, `${where}: no printed row for "${row.label}"`).not.toBeNull();
    if (c.refused.has(KEYS[i])) {
      expect(pct(cell as string), `${where}: refused "${row.label}" prints weight "${cell}"`).toBeNull();
      expect((cell as string).trim(), where).toBe("refused");
    } else if (c.weightsServed) {
      const p = pct(cell as string);
      expect(p, `${where}: scored "${row.label}" prints no weight ("${cell}")`).not.toBeNull();
      sum += p as number;
    }
  });
  if (c.weightsServed) {
    expect(Math.abs(sum - 100), `${where}: printed weights sum to ${sum}%`).toBeLessThanOrEqual(1);
  }
}

describe("non-vacuity: the served fixture carries refusals of both kinds", () => {
  it("the four cases, their refusals and their composites", () => {
    expect(CASES.map((c) => [c.name, [...c.refused].sort()])).toEqual([
      ["compact_serve", ["altman", "liquidity"]],
      ["compact_as_filed", ["altman", "liquidity"]],
      ["compact_ltd_only", ["liquidity"]],
      ["compact_metrics_only", ["altman", "liquidity"]],
      ["compact_serve_weights_without_reasons", ["altman", "liquidity"]],
    ]);
    for (const c of CASES) expect(reader(c).score, c.name).not.toBeNull();
  });
});

describe.each(CASES)("$name", (c) => {
  it("the reader: a refused row carries no weight and says why; the scored weights are the served ones", () => {
    const r = reader(c);
    expect(r.model).toBe("engine-canonical-v1");
    let scoredSum = 0;
    r.components.forEach((row, i) => {
      const key = KEYS[i];
      if (c.refused.has(key)) {
        expect([row.label, row.weight, row.contribution]).toEqual([row.label, null, null]);
        expect(row.refusal?.sentence, `${row.label}: refused without a sentence`).toMatch(/^Not scored — /);
        expect(row.refusal?.code ?? null).toBe(c.credit?.refused_subscores?.[key]?.code ?? null);
      } else {
        expect(row.refusal ?? null, `${row.label} is scored but carries a refusal`).toBeNull();
        if (c.weightsServed) {
          expect(row.weight, row.label).toBe(c.credit.composite_weights[key]);
          scoredSum += row.weight as number;
        } else {
          // Weights not served and the composite was renormalised over
          // weights this period did not ship: no row may print the table's.
          expect(row.weight, `${row.label} printed a model-table weight`).toBeNull();
        }
      }
    });
    if (c.weightsServed) expect(Math.abs(scoredSum - 1)).toBeLessThan(1e-9);
  });

  it("the model sentence spells the vector the composite used and names what was not scored", () => {
    const r = reader(c);
    const w = spellWeights(r.components);
    if (c.weightsServed) {
      expect(w, r.modelLabel).not.toBeNull();
      const total = (w as string).split("/").map(Number).reduce((a, b) => a + b, 0);
      expect(Math.abs(total - 100), `${r.modelLabel}: the spelled weights sum to ${total}`).toBeLessThanOrEqual(1);
      expect(r.modelLabel).toContain(`weights ${w} over ${7 - c.refused.size} of 7 sub-scores`);
    } else {
      expect(w).toBeNull();
      expect(r.modelLabel).not.toMatch(/weights \d/);
    }
    expect(r.modelLabel).toContain("not scored: ");
    if (c.refused.has("altman")) {
      expect(r.modelLabel).toContain("Altman Z″");
      expect(r.caveat).not.toContain("as the dominant signal");
    }
    if (c.refused.has("liquidity")) expect(r.modelLabel).toContain("liquidity");
  });

  it("the Risks tab prints no weight on a refused row and its weight column sums to 100%", () => {
    const r = reader(c);
    const { container } = render(
      <RisksPanel statements={STATEMENTS} creditEnvelope={c.credit} metricsByName={c.metrics} />,
    );
    expect(screen.getByTestId("credit-model").textContent?.trim()).toBe(r.modelLabel);
    const rows = Array.from(container.querySelectorAll("tr"));
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

  it("the hero prints the same composite and model sentence", () => {
    const r = reader(c);
    render(
      <TooltipProvider>
        <HeroVerdictCard credit={r} companyName="saga_compact_6_col" />
      </TooltipProvider>,
    );
    expect(screen.getByTestId("hero-credit-model").textContent?.trim()).toBe(r.modelLabel);
    expect(Number(screen.getByTestId("hero-verdict").getAttribute("data-score"))).toBe(r.score);
  });

  it("/report renders the card for a period with a composite, with the hero's composite and letter", async () => {
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
    // Revision-2 rows with no envelope ship no ladder, so no letter is
    // minted anywhere — /report included.
    expect(screen.queryByTestId("report-credit-letter")?.textContent?.trim() ?? null).toBe(r.rating);
    expect(card.textContent).toContain(String(Math.round(r.score as number)));
    expect(screen.getByTestId("report-credit-model").textContent).toContain(r.modelLabel);
    if (c.refused.has("altman")) {
      expect(screen.getByTestId("report-altman-refused").textContent).toContain(
        r.components[0].refusal?.sentence as string,
      );
    }
    let sum = 0;
    for (const el of Array.from(card.querySelectorAll("[data-weight]"))) {
      const w = el.getAttribute("data-weight");
      if (w !== "none") sum += Number(w);
    }
    for (const [i, key] of KEYS.entries()) {
      if (!c.refused.has(key)) continue;
      const label = ["Altman Z″", "Profitability", "Leverage", "Interest coverage", "DSCR", "Liquidity", "Equity ratio"][i];
      const bar = screen.getByTestId(`score-bar-absent-${label}`);
      expect(bar.getAttribute("data-weight"), `/report bar "${label}" carries a weight`).toBe("none");
      expect(screen.getByTestId(`score-bar-refusal-${label}`).textContent).toBe(r.components[i].refusal?.sentence);
    }
    if (c.weightsServed) expect(Math.abs(sum - 1), `/report bars sum to ${sum}`).toBeLessThan(1e-9);
  });

  it("the exported report and the workbook print the same weights, and no weight on a refused row", () => {
    const r = reader(c);
    const envelopes = { credit: c.credit, piotroski: undefined, metricsByName: c.metrics };
    const html = buildReportHtml(STATEMENTS, envelopes);
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(doc.querySelector("[data-report-credit-score]")?.textContent?.trim()).toBe(
      `${(r.score as number).toFixed(1)} / 100`,
    );
    expect(doc.querySelector("[data-report-credit-letter]")?.textContent?.trim()).toBe(r.rating ?? "not reported");
    const trs = Array.from(doc.querySelectorAll("tr"));
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
  });

  it("the credit-contribution chart draws no ceiling for a refused term", () => {
    const r = reader(c);
    const block = creditContributions({ credit: r } as unknown as ChartInputs);
    let ceilings = 0;
    block.rows.forEach((row: any, i: number) => {
      if (c.refused.has(KEYS[i])) {
        expect(row.ceiling, `chart term ${row.label} draws a ceiling`).toBeNull();
        expect(row.source).toContain("not scored, no weight");
      } else if (c.weightsServed) {
        ceilings += row.ceiling;
      }
    });
    if (c.weightsServed) expect(Math.abs(ceilings - 100)).toBeLessThan(1e-6);
    expect(block.caption).not.toContain("seven terms");
  });
});
