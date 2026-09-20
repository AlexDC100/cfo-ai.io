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
// G8 the export statements losing the served comparatives document;
// G9 the page no longer feeding its surfaces the served documents: a
//    RatioCompareCtx provider handed anything but the one view, the view
//    built from anything but the served table and comparatives query, a
//    hero or the Risks tab without its CreditComparison, an export handed
//    anything but the served-document statements (useRatioSurfaces run
//    over the fixture, plus a source gate over FinancialStatements.tsx);
//    and a requested prior that is loading or failed printed as "no
//    comparison period is loaded";
// G10 a band-only disagreement between the two documents (the comparison
//    withholding sector bands because the PRIOR's industry signal blocks)
//    printed as "the figures differ" instead of the served change and the
//    served sector_unconfirmed movement, or a badge graded on a band the
//    comparison withheld for both periods (pair_prior_blocks.json, rebuilt
//    and drift-checked by test_ratio_compare_fe_fixture.py);
// G11 a band-now, band-prior or movement cell, badge colour, movement
//    colour or ladder line on the tile or in the table that is not the
//    served side through the one formatter;
// G12 the drawer printing anything computeRatios decided beside a served
//    row: a formula result, a ladder or range, a badge colour or text.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";

import en from "@/i18n/locales/en.json";
import ro from "@/i18n/locales/ro.json";
import { renderWithProviders } from "@/test/renderWithProviders";
import { RatioCompareCtx } from "@/components/cfo/ComparativesPanel";
import { RatiosTabContent } from "@/components/cfo/ratios/RatiosTab";
import { BADGE_BY_TONE, toneText } from "@/components/cfo/ratios/RatioComparisonTable";
import { CreditComparison } from "@/components/cfo/ratios/CreditComparison";
import { HeroVerdictCard, RisksPanel } from "@/pages/cfo/FinancialStatements";
import { altmanRatio, computeRatios, formatRatio, ladderSentence, type Statements } from "@/lib/financialReport";
import { computeCreditScore } from "@/lib/financialValuation";
import { statementsForExportOf, type ComparativesResponse } from "@/lib/comparatives";
import {
  ENGINE_KEY_OF_FE_KEY,
  asFiledSentence,
  bandSideOf,
  bandTone,
  buildRatioCompareView,
  engineKeyOf,
  ladderText,
  printRatioRow,
  readRatioTable,
  servedCreditEnvelopes,
  type RatioCompareView,
} from "@/lib/ratioCompareView";
import { ratioSurfacesOf } from "@/lib/useRatioSurfaces";
import { RATIO_LABELLED_KEYS, ratioLabelI18nKey } from "@/lib/ratioCompareKeys";
import { MONEY_MISSING } from "@/lib/money";
import {
  formatRatioBand,
  formatRatioDelta,
  formatRatioMovement,
  movementTone,
  serializeRatioCompareRow,
  type RatioComparisonV1,
  type RatioTableV1,
} from "@/lib/ratioTable";

import pairJson from "./fixtures/comparatives/pair_served.json";
import priorBlocksJson from "./fixtures/comparatives/pair_prior_blocks.json";

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

/** The same current body against the same prior whose served
 *  industry_signal blocks sector content (pair_prior_blocks.json). */
const priorBlocks = (): Pair => {
  const p = fresh();
  p.comparatives = JSON.parse(JSON.stringify((priorBlocksJson as { comparatives: unknown }).comparatives)) as Pair["comparatives"];
  return p;
};

/** The badge tone the browser verdict would have painted (the deleted
 *  legacy mapping), for counting the rows where it and the served band
 *  part: the non-vacuity of the colour gates. */
const browserTone = (v: string) =>
  v === "unknown" || v === "ungraded" ? "neutral" : v === "critical" ? "alert" : v === "watch" ? "caution" : "success";

/** The period served with no persisted metric rows: computeRatios then
 *  falls back to its own arithmetic and ladders, which is where a browser
 *  verdict and the served band part. */
const withoutMetricRows = (p: Pair): Pair => {
  p.current_body.metrics = [];
  return p;
};

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
    // one printed form on every surface, and the served row as the handle
    expect(vs.getAttribute("data-ratio-printed-json")).toBe(tr.getAttribute("data-ratio-printed-json"));
    expect(tl.getAttribute("data-ratio-printed-json")).toBe(tr.getAttribute("data-ratio-printed-json"));
    expect(vs.getAttribute("data-ratio-cmp-json")).toBe(tr.getAttribute("data-ratio-cmp-json"));
    expect(tl.getAttribute("data-ratio-cmp-json")).toBe(tr.getAttribute("data-ratio-cmp-json"));
    expect(tr.getAttribute("data-ratio-cmp-json")).toBe(serializeRatioCompareRow(row));
  });

  it("every tile the engine served a row for is served-sourced and byte-equal to its table row", () => {
    const p = fresh();
    renderTab(p);
    const tiles = [...document.querySelectorAll<HTMLElement>('[data-testid="ratio-tile"]')];
    expect(tiles.length).toBeGreaterThanOrEqual(23);
    for (const tl of tiles) {
      const engineKey = tl.getAttribute("data-engine-key")!;
      expect(tl.getAttribute("data-source"), engineKey).toBe("served");
      expect(tl.getAttribute("data-ratio-printed-json"), engineKey).toBe(
        tableRow(engineKey).getAttribute("data-ratio-printed-json"),
      );
      expect(tl.getAttribute("data-ratio-cmp-json"), engineKey).toBe(
        tableRow(engineKey).getAttribute("data-ratio-cmp-json"),
      );
    }
  });

  it("G12 the drawer prints nothing computeRatios decided beside a served row", () => {
    const p = fresh();
    const { ratios } = pageInputs(p);
    const fe = ratios.liquidity.find((r) => r.key === "current_ratio")!;
    const planted = "9.99";
    tableOf(p).rows.find((r) => r.key === "current_ratio")!.value_q = planted;
    p.comparatives.ratios.rows.find((r) => r.key === "current_ratio")!.current.value_q = planted;
    const browserFigure = formatRatio(fe);
    expect(browserFigure).not.toBe(unit("x", planted)); // non-vacuity
    renderTab(p);
    const tl = tile("current_ratio");
    fireEvent.click(tl);
    const drawer = screen.getByTestId("ratio-detail-drawer");
    expect(within(drawer).getByTestId("ratio-detail-formula-result").textContent).toBe(unit("x", planted));
    expect(drawer.textContent).not.toContain(browserFigure);
    const tileLadder = within(tl).getByTestId("ratio-ladder").textContent;
    expect(within(drawer).getByTestId("ratio-detail-ladder").textContent).toBe(tileLadder);
    expect(within(drawer).getByTestId("ratio-detail-good-range").querySelector("p")?.textContent).toBe(tileLadder);
  });

  const q = (root: ParentNode, id: string) => root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  for (const [name, make] of [["with persisted metric rows", fresh], ["without persisted metric rows", () => withoutMetricRows(fresh())]] as const) {
    it(`G12 on every served tile ${name}, the drawer's badge, ladder, range and related figures are the tile's`, () => {
      const p = make();
      const { ratios } = pageInputs(p);
      const all = [...ratios.liquidity, ...ratios.profitability, ...ratios.leverage, ...ratios.coverage, ...ratios.efficiency];
      const view = viewOf(p);
      const counters = { divergentLadders: 0, divergentBadges: 0, ranges: 0, chips: 0 };
      for (const fe of all) {
        const key = engineKeyOf(fe.key);
        if (!view.periodTable?.rows.some((r) => r.key === key)) continue;
        const r = renderTab(p, view);
        const tl = tile(fe.key);
        const side = bandSideOf(view, key);
        fireEvent.click(tl);
        const drawer = q(document, "ratio-detail-drawer")!;
        const badge = q(drawer, "ratio-detail-band-now")!;
        expect(badge, fe.key).not.toBeNull();
        expect(badge.textContent, fe.key).toBe(q(tl, "ratio-band-now")!.textContent);
        const tone = BADGE_BY_TONE[bandTone(side)];
        expect(badge.className, fe.key).toContain(tone);
        for (const other of Object.values(BADGE_BY_TONE)) {
          if (other !== tone) expect(badge.className, `${fe.key} ${other}`).not.toContain(other.split(" ")[0]);
        }
        const tileLadder = q(tl, "ratio-ladder")!.textContent ?? "";
        expect(q(drawer, "ratio-detail-ladder")!.textContent, fe.key).toBe(tileLadder);
        if (fe.ladder) {
          const browserLadder = ladderSentence(fe.ladder, fe.unit);
          if (browserLadder !== "" && browserLadder !== tileLadder) {
            counters.divergentLadders++;
            expect(drawer.textContent, fe.key).not.toContain(browserLadder);
          }
        }
        for (const chip of drawer.querySelectorAll<HTMLElement>('[data-testid="ratio-related-chip"]')) {
          const rk = engineKeyOf(chip.getAttribute("data-ratio-key")!);
          if (!view.periodTable?.rows.some((x) => x.key === rk)) continue;
          counters.chips++;
          expect(cell(chip, "current"), `${fe.key} -> ${rk}`).toBe(printRatioRow(view, rk, "en")!.current);
        }
        // a ratio with no knowledge entry opens the fallback body, which
        // has no range section; every other drawer has one
        const range = q(drawer, "ratio-detail-good-range");
        if (range) {
          counters.ranges++;
          const knowledgeRange = range.textContent ?? "";
          expect(knowledgeRange.startsWith(tileLadder), fe.key).toBe(true);
          expect(knowledgeRange.slice(tileLadder.length), fe.key).not.toMatch(/\d/);
        }
        if (browserTone(fe.verdict) !== bandTone(side)) counters.divergentBadges++;
        r.unmount();
      }
      // non-vacuity: the fixture carries the splits this gate exists for
      expect(counters.divergentLadders).toBeGreaterThan(0);
      expect(counters.ranges).toBeGreaterThan(15);
      expect(counters.chips).toBeGreaterThan(10);
      if (name === "without persisted metric rows") expect(counters.divergentBadges).toBeGreaterThan(0);
    }, 30_000);
  }

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

  it("a withdrawn filed Z″ and composite print as withdrawn with the engine's note, never as figures", () => {
    // What revision 1 persisted for a zero-liability book (X4 = equity /
    // max(TL, 1)): Z″ 1584.89, composite 88.5 AA. The engine withdraws
    // both (R-RANGE) and serves the note; the surface must print neither
    // number, and must not call them "not filed".
    const p = fresh();
    const view = viewOf(p);
    const note = "withdrawn: computed under revision 1 on a substituted operand (altman_x4 outside its range)";
    tableOf(p).credit.as_filed = {
      composite: null,
      altman_z: null,
      letter: null,
      credit_model_revision: 1,
      withdrawn: [
        { figure: "altman_z_score", value: 1584.89, text: note },
        { figure: "credit_composite", value: 88.5, text: note },
      ],
    };
    tableOf(p).credit.as_filed_differs = true;
    renderWithProviders(
      <RatioCompareCtx.Provider value={view}>
        <CreditComparison surface="hero" />
      </RatioCompareCtx.Provider>,
    );
    const text = screen.getByTestId("credit-as-filed-hero").textContent ?? "";
    expect(text).toContain("composite withdrawn, letter withdrawn, Altman Z″ withdrawn");
    expect(text).toContain(note);
    expect(text).not.toContain("1584.89");
    expect(text).not.toContain("88.5");
    expect(text).not.toContain(bundle("en", "statements.ratioCmp.ui.asFiledValueAbsent"));
    // a payload that still carries the number beside the withdrawal
    // prints "withdrawn", not the number (the reader re-checks)
    tableOf(p).credit.as_filed!.composite = 88.5;
    tableOf(p).credit.as_filed!.altman_z = 1584.89;
    expect(asFiledSentence(tableOf(p).credit, "en")).not.toContain("1584.89");
    expect(asFiledSentence(tableOf(p).credit, "en")).not.toContain("88.5");
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

// ── G9 ────────────────────────────────────────────────────────────────

describe("G9 the page feeds every ratio surface the served documents", () => {
  const base = (p: Pair) => ({
    assembledMetrics: p.current_body.assembled_metrics,
    statements: p.current_body.statements,
    metricsByName: metricsOf(p),
    currentLabel: p.current_body.statements.periodLabel,
    periodId: "period-agras-fy2025",
    priorId: "period-carniprod-fy2024" as string | null,
  });

  it("useRatioSurfaces over the fixture: the view, the export and the credit are the served blocks", () => {
    const p = fresh();
    const s = ratioSurfacesOf({ ...base(p), comparatives: { data: { kind: "ok", data: p.comparatives } } });
    expect(s.cmpDoc).toBe(p.comparatives);
    expect(s.ratioCompareView?.periodTable).toBe(tableOf(p));
    expect(s.ratioCompareView?.comparison).toBe(p.comparatives.ratios);
    expect(s.ratioCompareView?.prior.kind).toBe("compared");
    expect(s.statementsForExport?.comparatives).toBe(p.comparatives);
    expect(s.creditEnvelopes.source).toBe("ratio_table");
    expect(s.creditEnvelopes.credit?.composite_score).toBe(tableOf(p).credit.composite);
  });

  it("a refused, failed, pending or unrequested prior is each its own state", () => {
    const p = fresh();
    const kind = (over: Partial<Parameters<typeof ratioSurfacesOf>[0]>) =>
      ratioSurfacesOf({ ...base(p), comparatives: {}, ...over }).ratioCompareView?.prior;
    expect(kind({ comparatives: { data: { kind: "refused", code: "x", message: "period not in workspace" } } })).toEqual({
      kind: "refused",
      message: "period not in workspace",
    });
    expect(kind({ comparatives: { data: { kind: "error", status: 502 } } })).toEqual({ kind: "failed", status: 502 });
    expect(kind({ comparatives: { isError: true } })).toEqual({ kind: "failed", status: 0 });
    expect(kind({ comparatives: {} })).toEqual({ kind: "loading" });
    expect(kind({ priorId: null, comparatives: {} })).toEqual({ kind: "no_comparison" });
    expect(kind({ priorId: "period-agras-fy2025", comparatives: {} })).toEqual({ kind: "no_comparison" });
  });

  it("a loading or failed prior prints its own sentence, never 'no comparison period is loaded'", () => {
    const p = fresh();
    const cases: [Parameters<typeof ratioSurfacesOf>[0]["comparatives"], string][] = [
      [{}, bundle("en", "statements.ratioCmp.ui.comparisonLoading").replace("{{current}}", "Dec 2025")],
      [
        { data: { kind: "error", status: 502 } },
        bundle("en", "statements.ratioCmp.ui.comparisonFailed").replace("{{status}}", "502").replace("{{current}}", "Dec 2025"),
      ],
      [{ isError: true }, bundle("en", "statements.ratioCmp.ui.comparisonFailedNoResponse").replace("{{current}}", "Dec 2025")],
    ];
    for (const [comparatives, sentence] of cases) {
      const view = ratioSurfacesOf({ ...base(p), comparatives }).ratioCompareView!;
      const r = renderTab(p, view);
      const table = screen.getByTestId("ratio-compare-table");
      expect(within(table).getByTestId("ratio-prior-state").textContent).toBe(sentence);
      expect(within(screen.getByTestId("band-movements")).getByTestId("ratio-prior-state").textContent).toBe(sentence);
      r.unmount();
    }
  });

  // THE JOIN. No gate above renders FinancialStatements itself (it needs
  // the router, Supabase and the period queries), so the page's use of the
  // one decision is held by reading its source: the one hook call and its
  // served inputs, every provider handed its result, both heroes and the
  // Risks tab given their CreditComparison, every export handed the
  // served-document statements, and no second place building any of it.
  describe("FinancialStatements.tsx uses the one decision everywhere", () => {
    const raw = readFileSync(resolve(REPO, "frontend/pages/cfo/FinancialStatements.tsx"), "utf8");
    const page = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const segments = (open: string) => {
      const out: string[] = [];
      let at = page.indexOf(open);
      while (at >= 0) {
        const close = page.indexOf("\n", page.indexOf("/>", page.indexOf("</RatioCompareCtx.Provider>", at)));
        out.push(page.slice(at, close < 0 ? undefined : close));
        at = page.indexOf(open, at + open.length);
      }
      return out;
    };

    it("one useRatioSurfaces call over the served table and the comparatives query", () => {
      expect(page).toMatch(/const cmpQuery = useComparatives\(remotePeriod\.id, cmpPriorId\);/);
      const calls = [...page.matchAll(/const \{([^}]*)\} = useRatioSurfaces\(\{([\s\S]*?)\}\);/g)];
      expect(calls.length).toBe(1);
      const names = calls[0][1].split(",").map((x) => x.trim());
      for (const n of ["cmpDoc", "cmpRefused", "ratioCompareView", "statementsForExport", "creditEnvelopes"]) expect(names).toContain(n);
      const args = calls[0][2];
      expect(args).toMatch(/assembledMetrics: remotePeriod\.assembled_metrics,/);
      expect(args).toMatch(/(^|\s)statements,/);
      expect(args).toMatch(/(^|\s)metricsByName,/);
      expect(args).toMatch(/periodId: remotePeriod\.id,/);
      expect(args).toMatch(/priorId: cmpPriorId,/);
      expect(args).toMatch(/comparatives: cmpQuery,/);
      for (const second of [/buildRatioCompareView\(/, /statementsForExportOf\(/, /servedCreditEnvelopes\(/, /readRatioTable\(/, /const (ratioCompareView|statementsForExport|creditEnvelopes|cmpDoc)\b/]) {
        expect(page).not.toMatch(second);
      }
    });

    it("four providers, each handed the one view: the Ratios tab, both heroes, the Risks tab", () => {
      const values = [...page.matchAll(/<RatioCompareCtx\.Provider value=\{([^}]*)\}>/g)].map((m) => m[1]);
      expect(values).toEqual(["ratioCompareView", "ratioCompareView", "ratioCompareView", "ratioCompareView"]);
      expect(page).toMatch(/<RatioCompareCtx\.Provider value=\{ratioCompareView\}>\s*<RatiosTabContent\b/);
      const heroes = segments("<HeroVerdictCard");
      expect(heroes.length).toBe(2);
      for (const h of heroes) {
        expect(h).toMatch(/footer=\{\s*<RatioCompareCtx\.Provider value=\{ratioCompareView\}>\s*<CreditComparison surface="hero" \/>/);
      }
      const risks = segments("<RisksPanel");
      expect(risks.length).toBe(1);
      expect(risks[0]).toMatch(/creditComparison=\{\s*<RatioCompareCtx\.Provider value=\{ratioCompareView\}>\s*<CreditComparison surface="risks" \/>/);
      expect(risks[0]).toMatch(/creditEnvelope=\{creditEnvelopes\.credit\}/);
    });

    it("every export is handed the served-document statements and the served credit", () => {
      const exportsCalls = [...page.matchAll(/\.(downloadHtmlReport|downloadExcelReport|buildReportHtml)\(([^)]*)\)/g)];
      expect(exportsCalls.map((m) => m[1]).sort()).toEqual(["buildReportHtml", "downloadExcelReport", "downloadHtmlReport"]);
      for (const m of exportsCalls) expect(m[2].replace(/\s+/g, " ").trim(), m[1]).toBe("statementsForExport ?? statements, creditEnvelopes");
    });
  });
});

// ── G10 ───────────────────────────────────────────────────────────────

describe("G10 a band withheld by the comparison is not a disagreement about the figure", () => {
  it("only the prior blocks: the served change and the served sector_unconfirmed movement print, one band decision everywhere", () => {
    const p = priorBlocks();
    const table = tableOf(p);
    const view = viewOf(p);
    const split = p.comparatives.ratios.rows.filter((r) => {
      const t = table.rows.find((x) => x.key === r.key)!;
      return t.band_status === "graded" && r.current.band_status === "ungraded_sector";
    });
    // non-vacuity: the case exists on this fixture, with a computable change
    expect(split.map((r) => r.key)).toEqual(expect.arrayContaining(["dso", "ebitda_margin"]));
    expect(p.comparatives.ratios.rows.find((r) => r.key === "dso")!.delta.value).toBe("-14");
    const { ratios } = pageInputs(p);
    const feKeys = new Map(
      [...ratios.liquidity, ...ratios.profitability, ...ratios.leverage, ...ratios.coverage, ...ratios.efficiency].map((r) => [engineKeyOf(r.key), r.key]),
    );
    renderTab(p, view);
    for (const r of split) {
      const tr = tableRow(r.key);
      expect(table.rows.find((x) => x.key === r.key)!.value_q).toBe(r.current.value_q);
      expect(tr.getAttribute("data-movement"), r.key).toBe("not_comparable");
      if (r.delta.value !== null) expect(cell(tr, "delta"), r.key).toBe(formatRatioDelta(r.delta, "en").primary);
      expect(cell(tr, "movement"), r.key).toBe(formatRatioMovement(r.movement, "en"));
      expect(cell(tr, "movement"), r.key).toBe(bundle("en", "statements.ratioCmp.reason.sector_unconfirmed"));
      expect(cell(tr, "band_now"), r.key).toBe(formatRatioBand(r.current, "en"));
      expect(cell(tr, "band_prior"), r.key).toBe(formatRatioBand(r.prior, "en"));
      const fe = feKeys.get(r.key);
      if (!fe) continue;
      const tl = tile(fe);
      expect(within(tl).getByTestId("ratio-band-now").textContent, r.key).toBe(formatRatioBand(r.current, "en"));
      expect(within(tl).getByTestId("ratio-band-now").className, r.key).toContain(BADGE_BY_TONE.neutral);
      expect(within(tl).getByTestId("ratio-ladder").textContent, r.key).toBe(
        ladderText(r.current, r.higher_is_better, r.display_unit, "en"),
      );
      expect(cell(tl, "movement"), r.key).toBe(cell(tr, "movement"));
      expect(cell(tl, "delta"), r.key).toBe(cell(tr, "delta"));
    }
    expect(document.querySelector('[data-movement="current_differs"]')).toBeNull();
  });
});

// ── G11 ───────────────────────────────────────────────────────────────

describe("G11 the band columns, badges, ladders and colours are the served sides, on the table and the tile", () => {
  for (const [name, make] of [["with persisted metric rows", fresh], ["without persisted metric rows", () => withoutMetricRows(fresh())]] as const) {
    it(`every census row and composite, ${name}`, () => {
      const p = make();
      const view = viewOf(p);
      const r = p.comparatives.ratios;
      renderTab(p, view);
      for (const row of [...r.rows, ...r.composites]) {
        const tr = tableRow(row.key);
        expect(cell(tr, "band_now"), row.key).toBe(formatRatioBand(bandSideOf(view, row.key), "en"));
        expect(cell(tr, "band_prior"), row.key).toBe(formatRatioBand(row.prior, "en"));
        expect(cell(tr, "movement"), row.key).toBe(formatRatioMovement(row.movement, "en"));
        expect(tr.querySelector('[data-col="movement"]')!.className, row.key).toContain(toneText(movementTone(row.movement)));
      }
      const tiles = [...document.querySelectorAll<HTMLElement>('[data-testid="ratio-tile"][data-source="served"]')];
      expect(tiles.length).toBeGreaterThanOrEqual(23);
      let toneSplits = 0;
      const { ratios } = pageInputs(p);
      const verdictOf = new Map(
        [...ratios.liquidity, ...ratios.profitability, ...ratios.leverage, ...ratios.coverage, ...ratios.efficiency].map((x) => [x.key, x.verdict]),
      );
      for (const tl of tiles) {
        const key = tl.getAttribute("data-engine-key")!;
        const side = bandSideOf(view, key);
        const served = r.rows.find((x) => x.key === key) ?? r.composites.find((x) => x.key === key)!;
        const badge = within(tl).getByTestId("ratio-band-now");
        expect(badge.textContent, key).toBe(formatRatioBand(side, "en"));
        const tone = bandTone(side);
        expect(badge.className, key).toContain(BADGE_BY_TONE[tone]);
        const v = verdictOf.get(tl.getAttribute("data-ratio-key")!);
        if (v && browserTone(v) !== tone) toneSplits++;
        expect(within(tl).getByTestId("ratio-ladder").textContent, key).toBe(
          ladderText(side, served.higher_is_better, served.display_unit, "en"),
        );
        expect(cell(tl, "band_prior"), key).toBe(formatRatioBand(served.prior, "en"));
        expect(cell(tl, "movement"), key).toBe(formatRatioMovement(served.movement, "en"));
        expect(tl.querySelector('[data-col="movement"]')!.className, key).toContain(toneText(movementTone(served.movement)));
      }
      if (name === "without persisted metric rows") expect(toneSplits).toBeGreaterThan(0);
    });
  }

  it("a crossed_up row is green and a crossed_down row is red, in the table and on the tile", () => {
    const p = fresh();
    const rows = p.comparatives.ratios.rows;
    const up = rows.find((r) => r.movement.status === "crossed_up" && r.key === "current_ratio")!;
    const down = rows.find((r) => r.movement.status === "crossed_down" && r.key === "cash_ratio")!;
    renderTab(p);
    expect(tableRow(up.key).querySelector('[data-col="movement"]')!.className).toContain("text-success");
    expect(tableRow(down.key).querySelector('[data-col="movement"]')!.className).toContain("text-alert");
    expect(tile(up.key).querySelector('[data-col="movement"]')!.className).toContain("text-success");
    expect(tile(down.key).querySelector('[data-col="movement"]')!.className).toContain("text-alert");
  });

  it("the divergent ltv / debt_to_assets tile prints the served rungs, not the browser's", () => {
    const p = fresh();
    const view = viewOf(p);
    const { ratios } = pageInputs(p);
    const fe = ratios.leverage.find((r) => r.key === "ltv")!;
    renderTab(p, view);
    const served = p.comparatives.ratios.rows.find((r) => r.key === "debt_to_assets")!;
    const text = within(tile("ltv")).getByTestId("ratio-ladder").textContent;
    expect(text).toBe(ladderText(bandSideOf(view, "debt_to_assets"), served.higher_is_better, served.display_unit, "en"));
    expect(text).not.toBe(fe.benchmark);
    expect(fe.ladder && ladderSentence(fe.ladder, fe.unit)).not.toBe(text);
  });

  it("the counts sentence says 'in at least one period' for the refused list, which holds both_refused", () => {
    const p = fresh();
    expect(p.comparatives.ratios.band_movements.refused.some((x) => x.reason_code === "both_refused")).toBe(true);
    renderTab(p);
    const counts = screen.getByTestId("band-movements-counts").textContent ?? "";
    expect(counts).toContain(`Without a figure in at least one period: ${p.comparatives.ratios.band_movements.refused.length}.`);
    expect(counts).not.toMatch(/in one period/);
  });

  it("each table row names its served group in the reader's words", () => {
    const p = fresh();
    renderTab(p);
    for (const row of p.comparatives.ratios.rows) {
      expect(cell(tableRow(row.key), "group"), row.key).toBe(bundle("en", `statements.ratioCmp.group.${row.group}`));
    }
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

// ── G13 ───────────────────────────────────────────────────────────────
//
// The tile and the drawer printed a turns row's change as TWO strings a
// margin apart ("+0.28×" then "+15.4%") while the table, the lists, the
// report and the workbook print the one joined cell "+0.28× (+15.4%)"
// (B8 verifier). The change is one cell on every tab surface.

describe("G13 the tile and the drawer print a turns change as the table's one joined cell", () => {
  const joined = (root: ParentNode): string =>
    (root.querySelector('[data-cell="delta"]')?.textContent ?? "").replace(/\s+/g, " ").trim();

  it("on every served turns row with a percent, the tile's and the drawer's delta cell equal the table's — including the percent", () => {
    const p = fresh();
    renderTab(p);
    // Served-only keys (net_debt_to_ebitda, …) have no tile; the rows the
    // tab tiles are the ones this gate walks.
    const turns = p.comparatives.ratios.rows.filter(
      (r) => r.delta.unit === "turns" && r.delta.pct_change !== null && document.querySelector(`[data-testid="ratio-tile"][data-ratio-key="${r.key}"]`),
    );
    expect(turns.length, "non-vacuity: no tiled turns row carries a percent").toBeGreaterThan(0);
    for (const row of turns) {
      const tableCell = joined(tableRow(row.key));
      expect(tableCell, `${row.key}: the table's cell carries no percent`).toMatch(/\(.+%\)$/);
      expect(joined(tile(row.key)), `${row.key}: the tile's change is not the table's one cell`).toBe(tableCell);
      fireEvent.click(tile(row.key));
      const drawer = screen.getByTestId("ratio-detail-drawer");
      expect(joined(within(drawer).getByTestId("ratio-detail-vs-prior")), `${row.key}: the drawer's change is not the table's one cell`).toBe(tableCell);
      fireEvent.keyDown(drawer, { key: "Escape" });
    }
  });
});
