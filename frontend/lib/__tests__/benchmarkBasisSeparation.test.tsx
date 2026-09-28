// BENCHMARK-BASIS-SEPARATION — the split measure is never rendered beside
// the filed-basis quartiles (owner spec 2026-09-26 P1 point 3: "the sector
// comparison stays stock ÷ turnover on BOTH sides, labelled 'bază depusă
// (stoc ÷ cifra de afaceri) — nu aceeași cu zilele de stoc din analiză'.
// Never compare the split measure to the filed one."; design B3).
//
// Served bytes: the sector document GET /api/period/{id}/sector-benchmark
// serves for corpus Agras, CAEN 1011 (fixtures/sectorBenchmark/served_pair
// .json, held byte-for-byte to the route by test_sector_benchmark_route_
// real_app.py), and the same period's statements with its served
// inventory-days block (the firm fixture, exportBooks.statementsFor; the
// comparatives pair for the Ratios tab). The engine half —
// `benchmark-basis-separation-engine` — holds the document itself.
//
// WHAT THIS REDS ON, AFTER THE REPAIR (TC-11):
//   · the Benchmark page's filed-basis row (inventory_days_on_turnover)
//     printing anything but the filed company figure — the split's total,
//     a leg, a leg's label or the split block inside the sector section;
//   · the DIO tile (and the cycle tile, which is built on the split) printing a sector band — the filed row's median
//     or middle half — or `data-band-source="sector"`, EVEN WHEN a document
//     serves one (an engine regression the browser must refuse, not print);
//   · the DIO tile's band line not the never-compared sentence, EN and RO;
//   · the CFO report putting the split inside its sector section, or a
//     sector row inside the section that prints the split, or a sector band
//     beside the split's cards.
// WHAT IT CANNOT SEE: whether the filed quartiles are right (engine
// benchmarks_ro gates); the engine document (the engine half).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";

import en from "@/i18n/locales/en.json";
import ro from "@/i18n/locales/ro.json";
import i18n from "@/i18n";
import { renderWithProviders } from "@/test/renderWithProviders";
import { SectorBenchmarkCtx, SectorBenchmarkView } from "@/components/cfo/benchmark/SectorBenchmarkSection";
import { RatioCompareCtx } from "@/components/cfo/ComparativesPanel";
import { RatiosTabContent } from "@/components/cfo/ratios/RatiosTab";
import { altmanRatio, computeRatios, type Statements } from "@/lib/financialReport";
import { computeCreditScore } from "@/lib/financialValuation";
import { buildRatioCompareView, readRatioTable, servedCreditEnvelopes } from "@/lib/ratioCompareView";
import { buildReportHtml } from "@/lib/financialExports";
import {
  bandSourceOf,
  bandSourceText,
  printSectorRows,
  readSectorBenchmark,
  SPLIT_BASIS_CARDS,
  type SectorBenchmarkDoc,
} from "@/lib/sectorBenchmark";

import served from "./fixtures/sectorBenchmark/served_pair.json";
import pairJson from "./fixtures/comparatives/pair_served.json";
import { metricsFor, statementsFor } from "./exportBooks";

type Json = Record<string, unknown>;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const DOC = (): SectorBenchmarkDoc => readSectorBenchmark(clone(served.with_prior))!;
const ROW_KEY = "inventory_days_on_turnover";
/** The owner's label, read from THE pack the engine serves it from
 *  (`packs/ratios/inventory_days.yaml#filed_basis.label`, carried on every
 *  block as `filed_basis_pointer`) — never a hand-typed copy: the page's EN
 *  label and the pack's had drifted apart ("not the inventory days …" vs
 *  "not the same as the inventory days …"). */
const OWNER_LABEL = ((): { ro: string; en: string } => {
  const pack = readFileSync(resolve(__dirname, "../../../packs/ratios/inventory_days.yaml"), "utf-8");
  const m = /\nfiled_basis:[\s\S]*?\n  label: \{ro: "([^"]+)",\s*en: "([^"]+)"\}/.exec(pack);
  if (!m) throw new Error("packs/ratios/inventory_days.yaml carries no filed_basis.label");
  return { ro: m[1], en: m[2] };
})();

/** THE REGRESSION the browser must refuse: a document that hangs the filed
 *  row's quartiles on every card built on the split, as if they were the
 *  split's sector band. */
function regressedDoc(): SectorBenchmarkDoc {
  const doc = DOC();
  const row = doc.rows.find((r) => r.key === ROW_KEY)!;
  const s = row.sector as Record<string, unknown>;
  for (const key of SPLIT_BASIS_CARDS) {
    (doc.ratio_cards as Record<string, unknown>)[key] = {
      band_source: "sector", sector_key: ROW_KEY, unit: row.unit,
      median: s.median, p25: s.p25, p75: s.p75, n: s.n, year: s.year, source: s.source,
      sector_caen: s.sector_caen, level: s.level, size_band: (doc as unknown as Json).size_band,
      position: (row as unknown as Json).position, vs_sector: (row as unknown as Json).vs_sector,
    };
  }
  return doc;
}

interface Pair {
  current_body: {
    assembled_metrics: Json;
    statements: Statements & { periodLabel: string; inventory_days?: Json };
    metrics: { name: string; value: number | null }[];
  };
}
const pair = (): Pair => clone(pairJson) as unknown as Pair;
const split = () => pair().current_body.statements.inventory_days as unknown as {
  total: { value_q: string };
  groups: { key: string; label_en: string; label_ro: string; value_q: string | null }[];
};

/** Every string the split puts on a page: its legs' labels and days, its
 *  total (both decimal marks). None may appear beside the filed quartiles. */
function splitStrings(): string[] {
  const b = split();
  const out = [b.total.value_q, b.total.value_q.replace(".", ",")];
  for (const g of b.groups) {
    out.push(g.label_en, g.label_ro);
    if (g.value_q) out.push(`${g.value_q} days`, `${g.value_q.replace(".", ",")} zile`);
  }
  return out;
}

function renderTab(doc: SectorBenchmarkDoc) {
  const p = pair();
  const statements = p.current_body.statements;
  const metricsByName: Record<string, number | null> = {};
  for (const m of p.current_body.metrics) metricsByName[m.name] = typeof m.value === "number" ? m.value : null;
  const ratios = computeRatios(
    statements,
    { ebitdaMargin: metricsByName.ebitda_margin ?? null, netMargin: metricsByName.net_margin ?? null },
    metricsByName,
  );
  const env = servedCreditEnvelopes(p.current_body.assembled_metrics, statements, metricsByName);
  const credit = computeCreditScore(statements, env.credit, env.piotroski, env.metricsByName);
  const view = buildRatioCompareView({
    periodTable: readRatioTable(p.current_body.assembled_metrics),
    comparativesDoc: null, refusal: null, currentLabel: statements.periodLabel,
  });
  return renderWithProviders(
    <SectorBenchmarkCtx.Provider value={doc}>
      <RatioCompareCtx.Provider value={view}>
        <RatiosTabContent ratios={ratios} statements={statements} altman={altmanRatio(credit)} />
      </RatioCompareCtx.Provider>
    </SectorBenchmarkCtx.Provider>,
  );
}

const tile = (key: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[data-testid="ratio-tile"][data-ratio-key="${key}"]`);
  if (!el) throw new Error(`no ${key} tile`);
  return el;
};

/** The filed row's quartile strings as the page prints them. */
function quartileStrings(doc: SectorBenchmarkDoc, lang: "en" | "ro"): string[] {
  const r = printSectorRows(doc, lang).find((x) => x.key === ROW_KEY)!;
  expect(r.status).toBe("sourced");
  expect(r.median).not.toBe("");
  return [r.median, r.iqr];
}

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
});

describe("the Benchmark page's filed-basis row", () => {
  for (const lang of ["en", "ro"] as const) {
    it(`prints the filed company figure under the owner's label, never the split (${lang})`, async () => {
      await i18n.changeLanguage(lang);
      const doc = DOC();
      const docRow = doc.rows.find((r) => r.key === ROW_KEY)!;
      const printed = printSectorRows(doc, lang).find((r) => r.key === ROW_KEY)!;
      renderWithProviders(<SectorBenchmarkView doc={doc} />);
      const section = document.querySelector<HTMLElement>('[data-testid="sector-benchmark"]')!;
      const row = section.querySelector<HTMLElement>(`[data-sector-row="${ROW_KEY}"]`)!;
      expect(row.querySelector('[data-cell="label"]')!.textContent).toContain(OWNER_LABEL[lang]);
      // The company side is the FILED figure the engine served for this row
      // (stock ÷ net turnover × 365), printed by the page's own printer.
      expect(docRow.company.value).not.toBeNull();
      expect(row.querySelector('[data-cell="company"]')!.textContent).toBe(printed.company);
      expect(row.querySelector('[data-cell="median"]')!.textContent).toBe(printed.median);
      // Nothing of the split inside the sector section.
      expect(section.querySelector("[data-inventory-days]")).toBeNull();
      expect(section.querySelector("[data-inventory-leg]")).toBeNull();
      expect(section.querySelector('[data-testid="inventory-days-split"]')).toBeNull();
      const text = section.textContent ?? "";
      for (const s of splitStrings()) expect(text, `the split's "${s}" sits in the sector section`).not.toContain(s);
    });
  }
});

describe("the cards built on the split carry no sector band", () => {
  for (const [name, make] of [["as served", DOC], ["even when a document serves one", regressedDoc]] as const) {
    it(`the DIO, inventory-turnover and cycle tiles — ${name}`, async () => {
      const doc = make();
      renderTab(doc);
      const quartiles = quartileStrings(doc, "en");
      // The Ratios tab prints a DIO and a cycle tile (inventory turnover is
      // a metric row, not a tile); both must exist.
      const present = ["dio", "inventory_turnover", "ccc"].filter((k) =>
        document.querySelector(`[data-testid="ratio-tile"][data-ratio-key="${k}"]`));
      expect(present).toEqual(expect.arrayContaining(["dio", "ccc"]));
      for (const key of present) {
        const t = tile(key);
        const band = t.querySelector<HTMLElement>('[data-testid="ratio-band-source"]');
        expect(band, `${key} prints no band-source line`).not.toBeNull();
        expect(band!.getAttribute("data-band-source"), key).toBe("general");
        for (const q of quartiles) expect(t.textContent ?? "", `${key} prints the filed quartile ${q}`).not.toContain(q);
      }
      expect(tile("dio").querySelector('[data-testid="ratio-band-source"]')!.textContent)
        .toBe(en.benchmarkPage.sector.bandNeverCompared);
      // the split IS on the DIO tile — beside no sector figure
      expect(tile("dio").querySelector('[data-testid="inventory-days-split"]')).not.toBeNull();
    });
  }

  it("the band line is the never-compared sentence in both languages, for every document", () => {
    for (const doc of [DOC(), regressedDoc()]) {
      expect(bandSourceText(doc, "dio", "en")).toBe(en.benchmarkPage.sector.bandNeverCompared);
      expect(bandSourceText(doc, "dio", "ro")).toBe(ro.benchmarkPage.sector.bandNeverCompared);
      for (const key of SPLIT_BASIS_CARDS) {
        expect(bandSourceOf(doc, key), key).toBe("general");
        for (const lang of ["en", "ro"] as const) {
          for (const q of quartileStrings(doc, lang)) expect(bandSourceText(doc, key, lang)).not.toContain(q);
        }
      }
    }
    // the refusal is specific to the split: a same-definition card keeps its
    // sector band
    expect(bandSourceOf(DOC(), "net_margin")).toBe("sector");
  });
});

describe("the CFO report keeps the split and the filed quartiles apart", () => {
  for (const [name, make] of [["as served", DOC], ["even when a document serves a band", regressedDoc]] as const) {
    it(`sector section without the split, the split without a sector row — ${name}`, () => {
      const doc = make();
      const html = buildReportHtml({ ...statementsFor("agras"), sectorBenchmark: doc } as never,
        { metricsByName: metricsFor("agras") });
      const dom = new DOMParser().parseFromString(html, "text/html");
      // The report's sector section (#sec-sector, the whole numbered
      // section, not only the table the printer returns).
      const sector = dom.querySelector<HTMLElement>("#sec-sector");
      expect(sector, "the report prints no sector section").not.toBeNull();
      expect(sector!.querySelector(`[data-sector-row="${ROW_KEY}"]`)).not.toBeNull();
      expect(sector!.querySelector("[data-inventory-days]")).toBeNull();
      const agrasSplit = (statementsFor("agras") as unknown as { inventory_days: ReturnType<typeof split> }).inventory_days;
      for (const g of agrasSplit.groups) expect(sector!.textContent ?? "").not.toContain(g.label_en);
      // EVERY split the report prints sits in a section with no sector row.
      const splits = Array.from(dom.querySelectorAll<HTMLElement>('[data-inventory-days="split"]'));
      expect(splits.length, "the report prints no split").toBeGreaterThan(0);
      for (const el of splits) expect(el.closest("section")!.querySelector("[data-sector-row]")).toBeNull();
      const dioBand = dom.querySelector<HTMLElement>('[data-ratio-band-source="dio"]');
      expect(dioBand).not.toBeNull();
      expect(dioBand!.textContent).toBe(en.benchmarkPage.sector.bandNeverCompared);
      const quartiles = quartileStrings(doc, "en");
      for (const key of SPLIT_BASIS_CARDS) {
        const el = dom.querySelector<HTMLElement>(`[data-ratio-band-source="${key}"]`);
        if (el) for (const q of quartiles) expect(el.textContent ?? "", key).not.toContain(q);
      }
    });
  }
});
