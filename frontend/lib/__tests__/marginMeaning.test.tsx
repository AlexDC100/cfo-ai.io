/**
 * MARGIN-MEANING, THE PAGES — a margin over a negligible turnover is refused
 * with the engine's reason on every surface that prints one, and nothing
 * else moves.
 *
 * THE DEFECT (measured live 2026-09-26, reproduced on the corpus twin
 * `realestate`): a property developer in a building year printed "EBITDA
 * margin −17,884.9%" on the dashboard and the ratios tab, and the forecast
 * cockpit printed "margin −17,886.1% · today −17,884.9%" and repeated it in
 * its sentence. The ENGINE now rules such a margin not meaningful
 * (engine.ratios.margin_meaning over packs/ratios/margin_meaning.yaml) and
 * serves the verdict; the pages only print it.
 *
 * Every payload here is REAL ENGINE OUTPUT: the four firm books as the route
 * serves them (`exportBooks.statementsFor` joins the captured verdict,
 * tests/engine/fixtures/firm/margin_meaning.json) and the developer's cockpit
 * and bank export (tests/engine/fixtures/forecast/cockpit_realestate_*.json),
 * both held to the live route by tests/engine/test_margin_meaning.py.
 *
 * RED ON (TC-11, after the repair):
 *   · the developer printing a margin PERCENT on the P&L key margins, the
 *     KPI card, the ratio bundle (and so the Ratios tab fallback, the drawer,
 *     the printed report and the workbook), the EBITDA reconciliation, the
 *     served ratio row, the cockpit's four numbers or the bank export;
 *   · a refusal that is not the engine's text, in the reader's language
 *     (RO and EN);
 *   · the note missing on the developer, or printed on any other book;
 *   · any other book's margins, key margins or printed report moving at all
 *     (the route serves those books no verdict; a verdict that refuses
 *     nothing changes no byte, and their committed ratio-parity captures
 *     are unchanged);
 *   · THE OWNER'S ACCEPTANCE RULE on the developer's printed report and bank
 *     export: no percent of a thousand or more, in either direction.
 * CANNOT SEE: the engine's verdict itself (the engine gate), pixels.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import i18n from "@/i18n";
import { renderWithProviders } from "@/test/renderWithProviders";
import { PLStatementView } from "@/components/cfo/PLStatementView";
import { MarginMeaningNote } from "@/components/cfo/MarginMeaningNote";
import { EbitdaReconciliationPanel } from "@/components/cfo/EbitdaReconciliationPanel";
import { HeadlineNumbers } from "@/components/forecast/cockpit/HeadlineNumbers";
import { ConfigurableDashboard } from "@/components/dashboard/ConfigurableDashboard";
import { ReportingContextProvider } from "@/components/learning/ReportingContextProvider";
import { DashboardProvider } from "@/stores/dashboard";
import { DashboardViewProvider } from "@/stores/dashboardView";
import { pickPLBuilder } from "@/lib/buildPlStatement";
import { computeRatios, formatRatio, ratioBadgeLabel, type Ratio } from "@/lib/financialReport";
import { readCockpit } from "@/lib/forecastCockpit";
import { buildBankExportHtml } from "@/lib/forecastBankExport";
import { formatRatioSide, type RatioSide } from "@/lib/ratioTable";
import { MARGIN_CONCEPT_KEYS, marginNoteOf, marginRefusalOf, readMarginMeaning } from "@/lib/marginMeaning";

import { BOOKS, cardNamed, exportDoc, exportHtml, metricsFor, statementsFor, type Book } from "./exportBooks";

vi.mock("@/lib/dashboard/configApi", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/dashboard/configApi")>();
  return { ...real, fetchRemoteConfig: async () => null, persistRemoteConfig: async () => false };
});

const REPO = resolve(__dirname, "../../..");
const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve(REPO, "tests/engine/fixtures/forecast", name), "utf-8")) as unknown;

const DEVELOPER: Book = "realestate";
const REFUSAL = {
  ro: "marjă nesemnificativă: cifra de afaceri este 0,6% din activitate",
  en: "margin not meaningful: turnover is 0.6% of activity",
};
// The engine's note under the ONE EBITDA (owner ruling 2026-09-26): EBITDA
// INCLUDES the stock variation, and the note names the figure. (Before the
// ruling it said the opposite — "the EBITDA above does not include them" —
// and pointed at a second EBITDA "including 711"; there is no second one.)
const NOTE = {
  ro:
    "Pentru un dezvoltator imobiliar, costurile de construcție capitalizate în stocuri trec prin contul 711 " +
    "(Variația stocurilor de produse): EBITDA de mai sus le include — 29.589,8 mii RON.",
  en:
    "For a property developer, construction costs capitalised into inventory run through account 711 " +
    "(Variația stocurilor de produse): the EBITDA above includes them — 29,589.8K RON.",
};

/** A percent of a thousand or more, in either direction, as a document prints it. */
const ABSURD_PERCENT = /[−-]?\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?\s?%|[−-]?\d{4,}(?:[.,]\d+)?\s?%/;

/** The book as served, with the verdict removed. */
function withoutVerdict(book: Book) {
  const s = { ...statementsFor(book) };
  delete (s as { margin_meaning?: unknown }).margin_meaning;
  return s;
}

/** The book with a verdict that refuses nothing, as the engine would write
 *  one (the route serves none on these books; a reader handed one must
 *  print exactly what it prints without it). The committed ratio-parity
 *  captures of these three books are the other half: byte-identical to
 *  before the rule. */
function withMeaningfulVerdict(book: Book) {
  return {
    ...statementsFor(book),
    margin_meaning: { version: "margin_meaning/1", status: "meaningful", code: null, display: null, note: null },
  };
}

const profitability = (s: ReturnType<typeof statementsFor>, book: Book): Ratio[] =>
  computeRatios(s, undefined, metricsFor(book)).profitability;

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
});

describe("the served verdict, as the pages read it", () => {
  it("refuses the developer's margins and carries its note; no other book is refused", () => {
    for (const book of BOOKS) {
      const view = readMarginMeaning(statementsFor(book).margin_meaning);
      if (book === DEVELOPER) {
        expect(view).not.toBeNull();
        expect(view!.refused).toBe(true);
        expect(view!.display).toEqual(REFUSAL);
        expect(view!.note?.display).toEqual(NOTE);
      } else {
        // the route serves no verdict where the rule refuses nothing
        expect(view, book).toBeNull();
        expect("margin_meaning" in statementsFor(book), book).toBe(false);
        expect(marginRefusalOf(statementsFor(book)), book).toBeNull();
        expect(marginNoteOf(statementsFor(book)), book).toBeNull();
      }
    }
  });

  it("a payload with no verdict (or one it does not recognise) refuses nothing", () => {
    expect(readMarginMeaning(undefined)).toBeNull();
    expect(readMarginMeaning({ status: "maybe" })).toBeNull();
    expect(marginRefusalOf(withoutVerdict(DEVELOPER))).toBeNull();
  });
});

describe("the dashboard's ratio bundle (Ratios tab fallback, drawer, printed report, workbook)", () => {
  it("refuses the developer's three margins with the engine's sentence", () => {
    const rows = profitability(statementsFor(DEVELOPER), DEVELOPER).filter((r) => MARGIN_CONCEPT_KEYS.has(r.key));
    expect(rows.map((r) => r.key).sort()).toEqual(["ebitda_margin", "gross_margin", "net_margin"]);
    for (const r of rows) {
      expect(r.value, r.key).toBeNull();
      expect(r.unavailable?.kind, r.key).toBe("not_meaningful");
      expect(formatRatio(r), r.key).toBe(REFUSAL.en);
      expect(ratioBadgeLabel(r), r.key).toBe("Not meaningful");
      expect(r.commentary, r.key).toContain("at least 10% of activity");
    }
  });

  it("moves nothing on any other book", () => {
    for (const book of BOOKS.filter((b) => b !== DEVELOPER)) {
      const served = profitability(statementsFor(book), book);
      expect(served.every((r) => !MARGIN_CONCEPT_KEYS.has(r.key) || r.value !== null), book).toBe(true);
      expect(profitability(withMeaningfulVerdict(book), book), book).toEqual(served);
    }
  });
});

describe("the P&L key margins", () => {
  const build = (s: ReturnType<typeof statementsFor>) =>
    pickPLBuilder({ lineItems: [], entity: "x", period: "FY2025", canonicalMargins: { ebitdaMargin: null, netMargin: null } }, s);

  it("refuse on the developer, in both languages, and print no percent", async () => {
    const statement = build(statementsFor(DEVELOPER));
    expect(statement.keyMargins.length).toBeGreaterThan(0);
    for (const m of statement.keyMargins) {
      expect(m.value, m.label).toBeNull();
      expect(m.refusal, m.label).toEqual(REFUSAL);
    }
    renderWithProviders(<PLStatementView statement={statement} hideGuide />);
    const refused = screen.getAllByTestId("pl-margin-refused");
    expect(refused).toHaveLength(statement.keyMargins.length);
    for (const el of refused) expect(el).toHaveTextContent(REFUSAL.en);
    cleanup();
    await i18n.changeLanguage("ro");
    renderWithProviders(<PLStatementView statement={statement} hideGuide />);
    for (const el of screen.getAllByTestId("pl-margin-refused")) expect(el).toHaveTextContent(REFUSAL.ro);
  });

  it("are unchanged on every other book", () => {
    for (const book of BOOKS.filter((b) => b !== DEVELOPER)) {
      const served = build(statementsFor(book)).keyMargins;
      expect(served, book).toEqual(build(withMeaningfulVerdict(book)).keyMargins);
      expect(served.every((m) => m.refusal === undefined && m.value !== null), book).toBe(true);
    }
  });
});

describe("the dashboard's KPI grid and the one note", () => {
  const grid = (book: Book) => {
    const s = statementsFor(book);
    const pl = s.assembled_pl ?? {};
    return (
      <ReportingContextProvider metrics={{ revenue: pl.revenue, ebitda: pl.ebitda_statutory }} currency="RON">
        <DashboardProvider>
          <DashboardViewProvider>
            <ConfigurableDashboard
              marginRefusal={marginRefusalOf(s)}
              overrides={{ operating_revenue: pl.revenue, ebitda: pl.ebitda_statutory }}
            />
          </DashboardViewProvider>
        </DashboardProvider>
      </ReportingContextProvider>
    );
  };

  it("the developer's EBITDA-margin card states the refusal, RO and EN", async () => {
    renderWithProviders(grid(DEVELOPER));
    expect(screen.getByTestId("metric-card-refused-ebitda_margin")).toHaveTextContent(REFUSAL.en);
    // the only percent on the card is the share inside the engine's sentence
    const card = (screen.getByTestId("metric-card-ebitda_margin").textContent ?? "").replace(REFUSAL.en, "");
    expect(card).not.toMatch(/%/);
    cleanup();
    await i18n.changeLanguage("ro");
    renderWithProviders(grid(DEVELOPER));
    expect(screen.getByTestId("metric-card-refused-ebitda_margin")).toHaveTextContent(REFUSAL.ro);
  });

  it("every other book's card still prints its margin", () => {
    for (const book of BOOKS.filter((b) => b !== DEVELOPER)) {
      renderWithProviders(grid(book));
      expect(screen.queryByTestId("metric-card-refused-ebitda_margin"), book).toBeNull();
      expect(screen.getByTestId("metric-card-ebitda_margin").textContent ?? "", book).toMatch(/%/);
      cleanup();
    }
  });

  it("the note prints on the developer, RO and EN, and nowhere else", async () => {
    render(<MarginMeaningNote statements={statementsFor(DEVELOPER)} />);
    expect(screen.getByTestId("margin-meaning-note")).toHaveTextContent(NOTE.en);
    cleanup();
    await i18n.changeLanguage("ro");
    render(<MarginMeaningNote statements={statementsFor(DEVELOPER)} />);
    expect(screen.getByTestId("margin-meaning-note")).toHaveTextContent(NOTE.ro);
    cleanup();
    for (const book of BOOKS.filter((b) => b !== DEVELOPER)) {
      const { container } = render(<MarginMeaningNote statements={statementsFor(book)} />);
      expect(container.innerHTML, book).toBe("");
      cleanup();
    }
  });

  it("the EBITDA reconciliation states the refusal and prints no margin", () => {
    const s = statementsFor(DEVELOPER);
    renderWithProviders(<EbitdaReconciliationPanel statements={s} marginRefusal={marginRefusalOf(s)} />);
    expect(screen.getByTestId("ebitda-recon-margin-refused")).toHaveTextContent(REFUSAL.en);
    expect(screen.getByTestId("ebitda-reconciliation-panel").textContent ?? "").not.toMatch(/margin\s+[−-]?\d/);
    // No percent anywhere but the share inside the engine's own sentence.
    const text = (screen.getByTestId("ebitda-reconciliation-panel").textContent ?? "").replace(REFUSAL.en, "");
    expect(text).not.toMatch(/\d\s?%/);
  });
});

describe("the Ratios tab's served rows", () => {
  const side = (reason: Record<string, unknown>): RatioSide =>
    ({
      value: null, value_q: null, band: null, band_status: "refused", ladder: null,
      ladder_floor: null, operands: [], reason,
    }) as unknown as RatioSide;

  it("print the engine's sentence for margin_not_meaningful, in the reader's language", () => {
    const reason = {
      code: "margin_not_meaningful", inputs: ["assembled_pl.revenue"], display: REFUSAL,
      share: "0.005545", threshold: "0.10",
    };
    expect(formatRatioSide(side(reason), "pct", "en")).toBe(REFUSAL.en);
    expect(formatRatioSide(side(reason), "pct", "ro")).toBe(REFUSAL.ro);
    // with no served sentence, the code's own words — never a percent
    expect(formatRatioSide(side({ code: "margin_not_meaningful", inputs: [] }), "pct", "en")).toBe(
      "Margin not meaningful: turnover is negligible against operating activity.",
    );
  });
});

describe("the printed report (Export tab)", () => {
  it("the developer's EBITDA card states the refusal and the note; its margin cards print no figure", () => {
    const doc = exportDoc(DEVELOPER);
    const ebitda = cardNamed(doc, "EBITDA");
    expect(ebitda.meta).toBe(REFUSAL.en);
    const card = Array.from(doc.querySelectorAll(".ratio-card")).find(
      (c) => (c.querySelector(".label")?.textContent ?? "").trim() === "EBITDA",
    );
    expect(card?.querySelector("[data-margin-note]")?.textContent).toBe(NOTE.en);
    for (const label of ["Gross margin", "EBITDA margin", "Net margin"]) {
      expect(cardNamed(doc, label).value, label).toBe(REFUSAL.en);
    }
  });

  it("THE ACCEPTANCE RULE: no percent of a thousand or more anywhere in the developer's document", () => {
    const text = (exportDoc(DEVELOPER).body.textContent ?? "").replace(/\s+/g, " ");
    const hit = text.match(ABSURD_PERCENT);
    expect(hit, hit ? `the document prints ${hit[0]}` : "").toBeNull();
  });

  it("every other book's document is the same bytes with and without a verdict that refuses nothing", () => {
    for (const book of BOOKS.filter((b) => b !== DEVELOPER)) {
      expect(exportHtml(book), book).toBe(exportHtml(book, withMeaningfulVerdict(book)));
    }
  });
});

describe("the forecast cockpit and the bank export (the developer's real engine bytes)", () => {
  const cockpit = readCockpit(fixture("cockpit_realestate_base.json"))!;

  it("the four numbers print the refusal, RO and EN, and no margin percent", async () => {
    const e = cockpit.numbers.ebitda;
    expect(e.margin).toBeNull();
    expect(e.marginYear0).toBeNull();
    expect(e.marginRefused).toEqual(REFUSAL);
    expect(e.marginYear0Refused).toEqual(REFUSAL);
    render(<HeadlineNumbers cockpit={cockpit} lang="en" projectedLabel="projected" answerKey="k" />);
    expect(screen.getByTestId("cockpit-ebitda-margin-refused")).toHaveTextContent(REFUSAL.en);
    expect(screen.queryByTestId("cockpit-ebitda-margin")).toBeNull();
    // the only percent on the card is the share inside the engine's sentence
    const card = (screen.getByTestId("cockpit-ebitda-final").textContent ?? "").replace(REFUSAL.en, "");
    expect(card).not.toMatch(/%/);
    cleanup();
    render(<HeadlineNumbers cockpit={cockpit} lang="ro" projectedLabel="proiectat" answerKey="k" />);
    expect(screen.getByTestId("cockpit-ebitda-margin-refused")).toHaveTextContent(REFUSAL.ro);
  });

  // REWRITTEN (fixer round 1, 2026-09-27), not re-captured. The EBITDA
  // printed above the cockpit's note is the FINAL PLAN year's, and plan years
  // project net 711 at 0 (design A6 — the card's own year-0 step says so).
  // The previous law pinned the dashboard sentence plus a year — "the EBITDA
  // above includes them — RON 29.6M in 2025." — under an FY2030 EBITDA that
  // includes nothing of the kind, and the bank export printed it to a lender.
  // The plan-year note names the actual year the figure belongs to and says
  // the plan years carry none; its amount is in the unit of the plan-year
  // EBITDA above it (millions).
  it("the sentence carries no margin clause and the note names its year", () => {
    const COCKPIT_NOTE = {
      ro:
        "Pentru un dezvoltator imobiliar, costurile de construcție capitalizate în stocuri trec prin contul 711 " +
        "(Variația stocurilor de produse): EBITDA din 2025 le-a inclus — 29,6 mil. RON; anii de plan proiectează " +
        "variația stocurilor la 0, deci EBITDA de mai sus nu le include.",
      en:
        "For a property developer, construction costs capitalised into inventory run through account 711 " +
        "(Variația stocurilor de produse): the 2025 EBITDA included them — 29.6M RON; the plan years project " +
        "the stock variation at 0, so the EBITDA above does not include them.",
    };
    for (const lang of ["ro", "en"] as const) {
      expect(cockpit.sentence[lang]).not.toMatch(/%|marj|margin/);
      expect(cockpit.numbers.ebitda.note?.[lang]).toBe(COCKPIT_NOTE[lang]);
      // never the actual-year sentence under a plan-year EBITDA
      expect(cockpit.numbers.ebitda.note?.[lang]).not.toMatch(/above includes|de mai sus le include/);
    }
  });

  it("the bank export prints the refusal and the note, and no percent of a thousand or more", () => {
    // The committed export is the PESSIMIST case: its final plan year's
    // share is its own (the engine's), so the page must print what was
    // served for that year — read here from the served bytes.
    const payload = fixture("cockpit_realestate_export.json");
    const served = readCockpit((payload as { cockpit: unknown }).cockpit)!.numbers.ebitda;
    expect(served.margin).toBeNull();
    expect(served.marginRefused?.ro).toMatch(/^marjă nesemnificativă: cifra de afaceri este \d+,\d% din activitate$/);
    const t = i18n.getFixedT("ro");
    const html = buildBankExportHtml({
      payload,
      companyName: "realestate",
      lang: "ro",
      locale: "ro-RO",
      t,
      format: (v: number) => v.toFixed(0),
    });
    expect(html).toContain(`data-margin-refused="final"`);
    expect(html).toContain(served.marginRefused!.ro);
    expect(html).toContain(`data-margin-note="1"`);
    expect(html).toContain(served.note!.ro);
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const hit = text.match(ABSURD_PERCENT);
    expect(hit, hit ? `the bank export prints ${hit[0]}` : "").toBeNull();
  });

  it("a normal book's cockpit is untouched: margins as percents, no refusal, no note", () => {
    const agras = readCockpit(fixture("cockpit_agras_base.json"))!;
    expect(agras.numbers.ebitda.margin).not.toBeNull();
    expect(agras.numbers.ebitda.marginRefused).toBeNull();
    expect(agras.numbers.ebitda.marginYear0Refused).toBeNull();
    expect(agras.numbers.ebitda.note).toBeNull();
  });
});
