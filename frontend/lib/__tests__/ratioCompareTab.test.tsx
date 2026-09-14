// GATE RATIOS-B6 — the dashboard's ratio surfaces are READERS of the two
// served ratio documents.
//
// ── THE DEFECT CLASS ──────────────────────────────────────────────────
//
// The engine serves every ratio, band, change, band movement and credit
// composite for both periods (`assembled_metrics.ratio_table` on GET
// /api/period, `ratios` on /comparatives). Before this batch the tab
// printed none of it: the prior column was `computeRatios` re-run over the
// prior's statements, flattened to a Map of key to number, and the tile
// subtracted and formatted the change inline; the prior Altman, credit
// score and letter did not exist. A served table nobody reads is the
// complete-and-unreachable class (ratios critic, unreachable_risk 1 and 4).
//
// ── THE FIXTURE (TC-1) ────────────────────────────────────────────────
//
// fixtures/comparatives/pair_served.json is the real GET /api/period body
// for the agras corpus book and the compare_payloads document for agras
// against carniprod, rebuilt from the committed corpus by
// tests/engine/test_ratio_compare_fe_fixture.py, which reds when these
// bytes drift from what the engine serves today.
//
// ── WHAT EACH GATE FAILS ON AFTER THE REPAIR (TC-11) ─────────────────
//
// G1 a tile or table cell printing a figure the served row did not carry
//    (computeRatios, a toFixed, an inline subtraction);
// G2 a census row, composite or sub-score missing from the table, or a
//    cell printing a dash, a raw key or nothing;
// G3 the band-movement lists sorted, filtered or re-ranked by the reader,
//    or an empty list printed without the served counts;
// G4 a prior composite printed from anything but the served composites,
//    or a refused one printed as a dash;
// G5 the hero or Risks credit reading a metric row over the served table,
//    or the as-filed disclosure shown without the engine's flag;
// G6 the deleted prior arithmetic coming back (grep);
// G7 a served label or FE key the reader has no word or mapping for;
// G8 the export statements losing the served comparatives document.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";

import en from "@/i18n/locales/en.json";
import ro from "@/i18n/locales/ro.json";
import { renderWithProviders } from "@/test/renderWithProviders";
import { RatioCompareCtx } from "@/components/cfo/ComparativesPanel";
import { RatiosTabContent } from "@/components/cfo/ratios/RatiosTab";
import { CreditComparison } from "@/components/cfo/ratios/CreditComparison";
import { HeroVerdictCard, RisksPanel } from "@/pages/cfo/FinancialStatements";
import { altmanRatio, computeRatios, type Statements } from "@/lib/financialReport";
import { computeCreditScore } from "@/lib/financialValuation";
import { statementsForExportOf, type ComparativesResponse } from "@/lib/comparatives";
import {
  ENGINE_KEY_OF_FE_KEY,
  buildRatioCompareView,
  printRatioRow,
  readRatioTable,
  servedCreditEnvelopes,
  type RatioCompareView,
} from "@/lib/ratioCompareView";
import { RATIO_LABELLED_KEYS, ratioLabelI18nKey } from "@/lib/ratioCompareKeys";
import { MONEY_MISSING } from "@/lib/money";
import type { RatioComparisonV1, RatioTableV1 } from "@/lib/ratioTable";

import pairJson from "./fixtures/comparatives/pair_served.json";

const REPO = resolve(__dirname, "../../..");

interface Pair {
  current_body: {
    assembled_metrics: Record<string, unknown>;
    statements: Statements & { periodLabel: string };
    metrics: { name: string; value: number | null }[];
  };
  comparatives: ComparativesResponse & { ratios: RatioComparisonV1 };
}

const fresh = (): Pair => JSON.parse(JSON.stringify(pairJson)) as Pair;

const bundle = (lang: "en" | "ro", key: string): string => {
  const v = key
    .split(".")
    .reduce<unknown>((n, p) => (n && typeof n === "object" ? (n as Record<string, unknown>)[p] : undefined), lang === "en" ? en : ro);
  if (typeof v !== "string") throw new Error(`${lang}.json has no string at ${key}`);
  return v;
};

function metricsOf(p: Pair): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const m of p.current_body.metrics) out[m.name] = typeof m.value === "number" ? m.value : null;
  return out;
}

function viewOf(p: Pair, opts: { withComparison?: boolean; refusal?: string } = {}): RatioCompareView {
  const v = buildRatioCompareView({
    periodTable: readRatioTable(p.current_body.assembled_metrics),
    comparativesDoc: opts.withComparison === false ? null : p.comparatives,
    refusal: opts.refusal ? { message: opts.refusal } : null,
    currentLabel: p.current_body.statements.periodLabel,
  });
  if (!v) throw new Error("fixture served no ratio table");
  return v;
}

function tableOf(p: Pair): RatioTableV1 {
  const t = readRatioTable(p.current_body.assembled_metrics);
  if (!t) throw new Error("fixture served no ratio table");
  return t;
}

/** The page's own inputs, the way FinancialStatements builds them. */
function pageInputs(p: Pair) {
  const statements = p.current_body.statements;
  const metricsByName = metricsOf(p);
  const margins = {
    ebitdaMargin: metricsByName.ebitda_margin ?? null,
    netMargin: metricsByName.net_margin ?? null,
  };
  const ratios = computeRatios(statements, margins, metricsByName);
  const env = servedCreditEnvelopes(p.current_body.assembled_metrics, statements, metricsByName);
  const credit = computeCreditScore(statements, env.credit, env.piotroski, env.metricsByName);
  return { statements, ratios, credit, env, metricsByName };
}

function renderTab(p: Pair, view: RatioCompareView = viewOf(p)) {
  const { statements, ratios, credit } = pageInputs(p);
  return renderWithProviders(
    <RatioCompareCtx.Provider value={view}>
      <RatiosTabContent ratios={ratios} statements={statements} altman={altmanRatio(credit)} />
    </RatioCompareCtx.Provider>,
  );
}

function tile(key: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-testid="ratio-tile"][data-ratio-key="${key}"]`);
  if (!el) throw new Error(`no tile for ${key}`);
  return el;
}

function tableRow(key: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-testid="ratio-compare-row"][data-ratio-key="${key}"]`);
  if (!el) throw new Error(`no table row for ${key}`);
  return el;
}

const cell = (root: HTMLElement, col: string) =>
  (root.querySelector(`[data-col="${col}"]`)?.textContent ?? "").trim();

const unit = (key: string, v: string) => bundle("en", `statements.ratioCmp.unit.${key}`).replace("{{v}}", v);

// ── G1 ────────────────────────────────────────────────────────────────

describe("G1 the tile and the table print the served strings, not a browser computation", () => {
  it("a planted served current and change print on the tile, the table and the drawer", () => {
    const p = fresh();
    const { ratios } = pageInputs(p);
    const fe = ratios.liquidity.find((r) => r.key === "current_ratio");
    expect(fe?.value).not.toBeNull();
    // Plant a value computeRatios cannot produce from these statements, on
    // BOTH served documents (they must agree, see G1b), and a change that
    // is not current minus prior.
    const planted = "9.99";
    tableOf(p).rows.find((r) => r.key === "current_ratio")!.value_q = planted;
    const row = p.comparatives.ratios.rows.find((r) => r.key === "current_ratio")!;
    row.current.value_q = planted;
    row.delta.value = "+0.07";
    renderTab(p);

    const tl = tile("current_ratio");
    expect(within(tl).getByTestId("ratio-current").textContent).toContain(unit("x", planted));
    expect(cell(tl, "delta")).toBe(unit("turns", "+0.07"));
    const tr = tableRow("current_ratio");
    expect(cell(tr, "current")).toBe(unit("x", planted));
    expect(cell(tr, "delta")).toBe(unit("turns", "+0.07"));
    // the served percent change beside a turns change, verbatim
    expect(cell(tr, "delta_secondary")).toBe(
      bundle("en", "statements.ratioCmp.unit.turnsPct").replace("{{v}}", row.delta.pct_change!),
    );
    expect(cell(tl, "delta_secondary")).toBe(cell(tr, "delta_secondary"));
    // the served prior, verbatim
    expect(cell(tr, "prior")).toBe(unit("x", row.prior.value_q!));

    fireEvent.click(tl);
    const drawer = screen.getByTestId("ratio-detail-drawer");
    expect(within(drawer).getByTestId("ratio-detail-current").textContent).toContain(unit("x", planted));
    const vs = within(drawer).getByTestId("ratio-detail-vs-prior");
    expect(cell(vs, "delta")).toBe(unit("turns", "+0.07"));
    // one printed form on every surface
    expect(vs.getAttribute("data-ratio-cmp-json")).toBe(tr.getAttribute("data-ratio-cmp-json"));
    expect(tl.getAttribute("data-ratio-cmp-json")).toBe(tr.getAttribute("data-ratio-cmp-json"));
  });

  it("every tile the engine served a row for is served-sourced and byte-equal to its table row", () => {
    const p = fresh();
    renderTab(p);
    const tiles = [...document.querySelectorAll<HTMLElement>('[data-testid="ratio-tile"]')];
    expect(tiles.length).toBeGreaterThanOrEqual(23);
    for (const tl of tiles) {
      const engineKey = tl.getAttribute("data-engine-key")!;
      expect(tl.getAttribute("data-source"), engineKey).toBe("served");
      expect(tl.getAttribute("data-ratio-cmp-json"), engineKey).toBe(
        tableRow(engineKey).getAttribute("data-ratio-cmp-json"),
      );
    }
  });

  it("G1b when the two documents disagree about the current figure, no change is printed", () => {
    const p = fresh();
    tableOf(p).rows.find((r) => r.key === "dso")!.value_q = "99";
    renderTab(p);
    const tr = tableRow("dso");
    const served = p.comparatives.ratios.rows.find((r) => r.key === "dso")!;
    expect(cell(tr, "current")).toBe(unit("days", "99"));
    expect(cell(tr, "delta")).not.toContain(served.delta.value!);
    expect(cell(tr, "delta")).toContain(unit("days", "99"));
    expect(cell(tr, "delta")).toContain(unit("days", served.current.value_q!));
    expect(tr.getAttribute("data-movement")).toBe("current_differs");
  });

  it("the colour of a change is the served verdict: a fall in days that the engine calls improved is green", () => {
    const p = fresh();
    renderTab(p);
    const served = p.comparatives.ratios.rows.find((r) => r.key === "dso")!;
    expect(served.higher_is_better).toBe(false);
    expect(served.delta.favourable).toBe("improved");
    expect(served.delta.value!.startsWith("-")).toBe(true);
    const d = tableRow("dso").querySelector('[data-col="delta"]')!.closest("td")!;
    expect(d.className).toContain("text-success");
    expect(within(tile("dso")).getByText(cell(tableRow("dso"), "delta")).className).toContain("text-success");
  });
});

// ── G2 ────────────────────────────────────────────────────────────────

describe("G2 every census row, composite and sub-score has all six cells", () => {
  it("rows = census + composites + sub-scores, each cell a printed figure or a sentence", () => {
    const p = fresh();
    renderTab(p);
    const r = p.comparatives.ratios;
    const expected = [...r.rows, ...r.composites, ...r.subscores].map((x) => x.key);
    const rendered = [...document.querySelectorAll('[data-testid="ratio-compare-row"]')].map((e) =>
      e.getAttribute("data-ratio-key"),
    );
    expect(rendered).toEqual(expected);
    expect(rendered.length).toBe(r.coverage.census_count + 3 + 7);
    for (const key of expected) {
      const tr = tableRow(key);
      for (const col of ["current", "prior", "delta", "band_now", "band_prior", "movement"]) {
        const text = cell(tr, col);
        expect(text, `${key}.${col}`).not.toBe("");
        expect(text, `${key}.${col}`).not.toBe(MONEY_MISSING);
        expect(text, `${key}.${col}`).not.toBe("-");
        expect(text, `${key}.${col}`).not.toMatch(/statements\.ratioCmp|dashV2\.|\{\{/);
      }
    }
  });

  it("a refused prior prints its served reason with its inputs, on the tile and in the table", () => {
    const p = fresh();
    const row = p.comparatives.ratios.rows.find((r) => r.key === "interest_coverage")!;
    expect(row.prior.value_q).toBeNull();
    expect(row.prior.reason?.code).toBe("zero_denominator");
    renderTab(p);
    const tr = tableRow("interest_coverage");
    expect(cell(tr, "prior")).toMatch(/^Undefined: the figure for .+ is zero/);
    const prior = within(tile("interest_coverage")).getByTestId("ratio-prior");
    expect(prior.getAttribute("data-ratio-prior")).toBe("refused");
    expect(cell(prior, "prior")).toBe(cell(tr, "prior"));
  });

  it("without a comparison the table states why and prints no prior column; tiles print no prior line", () => {
    const p = fresh();
    renderTab(p, viewOf(p, { withComparison: false }));
    const table = screen.getByTestId("ratio-compare-table");
    expect(table.getAttribute("data-prior-state")).toBe("no_comparison");
    expect(within(table).getByTestId("ratio-prior-state").textContent).toBe(
      bundle("en", "statements.ratioCmp.ui.noComparison").replace("{{current}}", "Dec 2025"),
    );
    expect(tableRow("current_ratio").querySelector('[data-col="prior"]')).toBeNull();
    expect(document.querySelector('[data-testid="ratio-prior"]')).toBeNull();
    // the tiles still read the served current
    expect(tile("current_ratio").getAttribute("data-source")).toBe("served");
  });

  it("an engine refusal of the comparison is printed in its words", () => {
    const p = fresh();
    renderTab(p, viewOf(p, { withComparison: false, refusal: "period not in workspace" }));
    const note = within(screen.getByTestId("band-movements")).getByTestId("ratio-prior-state");
    expect(note.textContent).toBe("No comparison: period not in workspace");
  });
});

// ── G3 ────────────────────────────────────────────────────────────────

describe("G3 the band-movement lists are the served lists, in served order", () => {
  const order = (id: string) =>
    [...screen.getByTestId(id).querySelectorAll('[data-testid="band-movement-item"]')].map((e) =>
      e.getAttribute("data-ratio-key"),
    );

  it("improved and deteriorated render in served rank order with the served basis sentence", () => {
    const p = fresh();
    const bm = p.comparatives.ratios.band_movements;
    expect(bm.improved.length).toBeGreaterThan(0);
    expect(bm.deteriorated.length).toBeGreaterThan(0);
    renderTab(p);
    expect(order("band-improved")).toEqual(bm.improved);
    expect(order("band-deteriorated")).toEqual(bm.deteriorated);
    expect(screen.getByTestId("band-movements-rank-basis").textContent).toBe(
      `Order: ${bundle("en", "statements.ratioCmp.rankBasis")}`,
    );
    expect(screen.getByTestId("band-movements-counts").textContent).toContain(
      `${bm.improved.length} improved and ${bm.deteriorated.length} deteriorated`,
    );
  });

  it("a reversed served list renders reversed: the reader does not rank", () => {
    const p = fresh();
    p.comparatives.ratios.band_movements.improved.reverse();
    renderTab(p);
    expect(order("band-improved")).toEqual(p.comparatives.ratios.band_movements.improved);
  });

  it("nothing crossed prints the sentence and the served counts, never an empty box", () => {
    const p = fresh();
    const bm = p.comparatives.ratios.band_movements;
    bm.improved = [];
    bm.deteriorated = [];
    renderTab(p);
    expect(screen.getByTestId("band-movements-nothing").textContent).toBe(
      "No ratio crossed a band between Dec 2024 and Dec 2025.",
    );
    const counts = screen.getByTestId("band-movements-counts").textContent ?? "";
    expect(counts).toContain(`${bm.unchanged.length} held their band`);
    expect(counts).toContain(`of ${p.comparatives.ratios.coverage.both_sides} valued in both periods`);
  });
});

// ── G4 ────────────────────────────────────────────────────────────────

describe("G4 the prior Altman, credit score and letter are the served composites", () => {
  it("the table, the hero and the Risks tab print the served prior composites", () => {
    const p = fresh();
    const comps = Object.fromEntries(p.comparatives.ratios.composites.map((c) => [c.key, c]));
    for (const k of ["altman_z", "credit_composite", "letter_grade"]) expect(comps[k].prior.value_q).not.toBeNull();
    const view = viewOf(p);
    const { statements, credit, env } = pageInputs(p);
    renderWithProviders(
      <>
        <HeroVerdictCard
          credit={credit}
          footer={
            <RatioCompareCtx.Provider value={view}>
              <CreditComparison surface="hero" />
            </RatioCompareCtx.Provider>
          }
        />
        <RisksPanel
          statements={statements}
          creditEnvelope={env.credit}
          piotroskiEnvelope={env.piotroski}
          metricsByName={env.metricsByName}
          creditComparison={
            <RatioCompareCtx.Provider value={view}>
              <CreditComparison surface="risks" />
            </RatioCompareCtx.Provider>
          }
        />
      </>,
    );
    for (const surface of ["hero", "risks"]) {
      const root = screen.getByTestId(`credit-comparison-${surface}`);
      const z = within(root).getByTestId("credit-prior-altman_z");
      expect(cell(z, "prior")).toBe(comps.altman_z.prior.value_q);
      expect(cell(within(root).getByTestId("credit-prior-credit_composite"), "prior")).toBe(
        comps.credit_composite.prior.value_q,
      );
      const letter = within(root).getByTestId("credit-prior-letter_grade");
      expect(cell(letter, "prior")).toBe(comps.letter_grade.prior.value_q);
      expect(cell(letter, "delta")).toBe(bundle("en", "statements.ratioCmp.unit.notchesOne").replace("{{v}}", "+1"));
    }
  });

  it("a prior composite the engine could not score prints the engine's reason, never a dash", () => {
    const p = fresh();
    const z = p.comparatives.ratios.composites.find((c) => c.key === "altman_z")!;
    z.prior = { ...z.prior, value: null, value_q: null, band: null, band_status: "refused", ladder: null, ladder_floor: null, operands: [], reason: { code: "credit_inputs_absent", inputs: [] } };
    z.delta = { ...z.delta, value: null, favourable: null, reason_code: "prior_refused" };
    renderTab(p);
    const tr = tableRow("altman_z");
    expect(cell(tr, "prior")).toBe(bundle("en", "statements.ratioCmp.reason.credit_inputs_absent"));
    expect(cell(tr, "delta")).toBe(bundle("en", "statements.ratioCmp.reason.prior_refused"));
  });
});

// ── G5 ────────────────────────────────────────────────────────────────

describe("G5 the hero and Risks credit read the served table", () => {
  it("the reader is handed ratio_table.credit and a metric row cannot override it", () => {
    const p = fresh();
    const table = tableOf(p);
    const { statements, metricsByName } = pageInputs(p);
    // a credit row that disagrees with the served table
    const planted = { ...metricsByName, credit_composite: 12.3, altman_z_score: 0.11 };
    const env = servedCreditEnvelopes(p.current_body.assembled_metrics, statements, planted);
    expect(env.source).toBe("ratio_table");
    const credit = computeCreditScore(statements, env.credit, env.piotroski, env.metricsByName);
    expect(credit.score).toBe(table.credit.composite);
    expect(credit.rating).toBe(table.credit.letter);
    expect(credit.altman.score).toBe(table.credit.altman.z);
    // and it is the comparison's current composite, printed
    const comp = p.comparatives.ratios.composites.find((c) => c.key === "credit_composite")!;
    expect(comp.current.value).toBe(credit.score);
    // non-credit rows still reach the ratio reader
    expect(env.metricsByName.dso).toBe(metricsByName.dso);
  });

  it("an as_filed body keeps its own envelope and rows", () => {
    const p = fresh();
    (p.current_body.assembled_metrics.credit as Record<string, unknown>).basis = "as_filed";
    const { statements, metricsByName } = pageInputs(p);
    const env = servedCreditEnvelopes(p.current_body.assembled_metrics, statements, metricsByName);
    expect(env.source).toBe("envelope");
    expect(env.metricsByName).toBe(metricsByName);
  });

  it("the as-filed disclosure renders only when the engine flags a difference", () => {
    const p = fresh();
    const view = viewOf(p);
    const mount = () =>
      renderWithProviders(
        <RatioCompareCtx.Provider value={view}>
          <CreditComparison surface="hero" />
        </RatioCompareCtx.Provider>,
      );
    const first = mount();
    expect(screen.queryByTestId("credit-as-filed-hero")).toBeNull();
    first.unmount();
    tableOf(p).credit.as_filed = { composite: 71.7, altman_z: 2.41, letter: "A", credit_model_revision: "unknown" };
    tableOf(p).credit.as_filed_differs = true;
    mount();
    const text = screen.getByTestId("credit-as-filed-hero").textContent ?? "";
    expect(text).toContain("composite 71.7, letter A, Altman Z″ 2.41");
    expect(text).toContain(bundle("en", "statements.ratioCmp.ui.asFiledRevisionUnknown"));
  });
});

// ── G6 ────────────────────────────────────────────────────────────────

describe("G6 the browser prior arithmetic stays deleted", () => {
  const read = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("no computeRatios over the prior, no Map-of-numbers prior, no prior subtraction", () => {
    const page = code(read("frontend/pages/cfo/FinancialStatements.tsx"));
    const panel = code(read("frontend/components/cfo/ComparativesPanel.tsx"));
    expect(page).not.toMatch(/computeRatios\(\s*priorStatements/);
    expect(page + panel).not.toMatch(/ratioPriorFromBundle|RatioPriorCtx|useRatioPrior|priorRatios/);
    for (const rel of [
      "frontend/components/cfo/ratios/RatiosTab.tsx",
      "frontend/components/cfo/ratios/RatioComparisonTable.tsx",
      "frontend/components/cfo/ratios/BandMovementLists.tsx",
      "frontend/components/cfo/ratios/CreditComparison.tsx",
      "frontend/lib/ratioCompareView.ts",
    ]) {
      const src = code(read(rel));
      expect(src, rel).not.toMatch(/\.toFixed\(|toPrecision\(|Math\.round|parseFloat\(|Number\(/);
      expect(src, rel).not.toMatch(/ratioPriorFromBundle|computeRatios\(/);
    }
    // RatiosTab keeps the guide anchors the learning tours point at
    const tab = read("frontend/components/cfo/ratios/RatiosTab.tsx");
    for (const g of ["ratios-profitability", "ratios-leverage", "ratios-efficiency", "ratios-risk"]) {
      expect(tab).toContain(`data-guide="${g}"`);
    }
  });
});

// ── G7 ────────────────────────────────────────────────────────────────

describe("G7 every served label and key has a reader word and mapping", () => {
  const tablePy = readFileSync(resolve(REPO, "src/engine/ratios/table.py"), "utf8");
  const specs = [...tablePy.matchAll(/_Spec\(\s*"(\w+)",\s*"\w+",\s*"\w+",\s*(?:True|False),\s*(None|"(\w+)")/g)].map(
    (m) => ({ key: m[1], fe: m[3] ?? null }),
  );

  it("the engine census parses (non-vacuity) and every row key has a label in EN and RO", () => {
    expect(specs.length).toBe(fresh().comparatives.ratios.coverage.census_count);
    const p = fresh();
    const served = [...p.comparatives.ratios.rows, ...p.comparatives.ratios.composites, ...p.comparatives.ratios.subscores];
    for (const r of served) {
      const k = ratioLabelI18nKey(r.label_key);
      expect(k, r.label_key).not.toBeNull();
      expect(bundle("en", k!).trim()).not.toBe("");
      expect(bundle("ro", k!).trim()).not.toBe("");
    }
    for (const s of specs) expect(RATIO_LABELLED_KEYS as readonly string[]).toContain(s.key);
  });

  it("the FE-to-engine key map is exactly the engine's fe_key renames", () => {
    const renames = Object.fromEntries(specs.filter((s) => s.fe && s.fe !== s.key).map((s) => [s.fe!, s.key]));
    expect(ENGINE_KEY_OF_FE_KEY).toEqual(renames);
  });

  it("an unknown served label is named, not printed as a raw key", () => {
    const p = fresh();
    p.comparatives.ratios.rows[0].label_key = "ratioTable.brand_new.label";
    tableOf(p).rows[0].label_key = "ratioTable.brand_new.label";
    const printed = printRatioRow(viewOf(p), p.comparatives.ratios.rows[0].key, "en")!;
    expect(printed.label).toContain(p.comparatives.ratios.rows[0].key);
    expect(printed.label).not.toMatch(/^ratioTable\./);
  });

  it("Romanian prints the same served digits with a decimal comma and Romanian words", () => {
    const p = fresh();
    const row = printRatioRow(viewOf(p), "current_ratio", "ro")!;
    const served = tableOf(p).rows.find((r) => r.key === "current_ratio")!.value_q!;
    expect(row.current).toBe(bundle("ro", "statements.ratioCmp.unit.x").replace("{{v}}", served.replace(".", ",")));
    expect(row.label).toBe(bundle("ro", "statements.ratioCmp.label.current_ratio"));
  });
});

// ── G8 ────────────────────────────────────────────────────────────────

describe("G8 the export statements carry the served comparatives document", () => {
  it("attached verbatim with the prior's statements; null without a comparison", () => {
    const p = fresh();
    const withDoc = statementsForExportOf(p.current_body.statements, p.comparatives)!;
    expect(withDoc.comparatives).toBe(p.comparatives);
    expect(withDoc.prior?.periodLabel).toBe("Dec 2024");
    const without = statementsForExportOf(p.current_body.statements, null)!;
    expect(without.comparatives).toBeNull();
    expect(without.prior).toBeUndefined();
    expect(statementsForExportOf(null, p.comparatives)).toBeNull();
  });
});
