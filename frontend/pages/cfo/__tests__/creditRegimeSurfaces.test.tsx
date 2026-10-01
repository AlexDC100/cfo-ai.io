// THE STOCK-BUILD CREDIT REGIME, ONCE, ON EVERY SURFACE THAT PRINTS THE
// GRADE (credit model revision 5, owner ruling R1, 2026-09-28).
//
// The ruling: when the 711 stock build exceeds turnover materially, the
// credit model weights cash flow and liquidity, not EBITDA, and a finding
// states "EBITDA pozitivă din stocuri capitalizate — numerarul a fost
// consumat de construcție." The engine serves the regime beside the grade
// (`assembled_metrics.credit.regime`, the attention document's
// `credit_regime`); these surfaces READ it and print it once.
//
// WHAT THIS FILE READS: `frontend/lib/__tests__/fixtures/served_credit_regime.json`,
// captured from the real route and the route's own envelope builder, kept
// fresh by `tests/engine/test_credit_regime_fe_fixture.py`: the corpus
// developer (regime, cash approximated -> composite refused), the same
// statements with the cash flow stated as measured (the bottom rung, 33.9 on
// the regime's weights, CCC), agras (no regime), the attention document's
// regime, and a SYNTHETIC withheld case (the credit-stock-build gate's
// constructed book with EBITDA -8.85M and cash measured -8M: the regime and a
// letter, the finding WITHHELD because the served EBITDA is not positive).
//
// WHAT THIS REDS ON (TC-11): a surface printing the regime twice, or not at
// all beside a regime grade, or on a standard book; the finding paraphrased
// (the owner's sentence is a literal here, in both languages); the cash
// components labelled with an EBITDA / EBIT basis under the regime; the
// hero saying "analysis pending" for a composite the engine refused; the
// weights printed as anything but the regime's served table; the command
// bar printing the regime while typing, or twice; the owner's sentence
// printed on any surface where the engine WITHHELD it (its premise
// contradicted by the served figures), or the regime dropped with it.

import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as XLSX from "xlsx";
import { TooltipProvider } from "@/components/ui/tooltip";
import i18n from "@/i18n";

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

import { HeroVerdictCard, RisksPanel } from "@/pages/cfo/FinancialStatements";
import { CreditScoreCard, creditCardData } from "@/components/cfo/CreditScoreCard";
import { CmdbarList } from "@/components/instrument/shell/cmdbar/CmdbarList";
import { servedMoney } from "@/components/instrument/shell/cmdbar/cmdbarFigures";
import { computeCreditScore, engineCreditResult, type CreditEnvelope } from "@/lib/financialValuation";
import { buildExcelWorkbook, buildReportHtml } from "@/lib/financialExports";
import { printRegimeAmount, readCreditRegime, regimeDocumentText, regimeLine } from "@/lib/creditRegime";
import { foreignNumber, plainSpaces } from "@/test/numberLanguage";
import type { Statements } from "@/lib/financialReport";

const OWNER_RO = "EBITDA pozitivă din stocuri capitalizate — numerarul a fost consumat de construcție.";
const OWNER_EN = "Positive EBITDA from capitalised stock — the cash was consumed by construction.";

interface Case {
  credit: CreditEnvelope;
  metrics: { name: string; value: number | null }[];
  statements?: Statements;
}
const FIX = JSON.parse(
  readFileSync(resolve(__dirname, "../../../lib/__tests__/fixtures/served_credit_regime.json"), "utf-8"),
) as {
  developer: Case;
  developer_measured_cash: Case;
  manufacturer: Case;
  attention_developer: { credit_regime: unknown; currency: string | null };
  developer_withheld: Case;
};

const byName = (c: Case): Record<string, number | null> =>
  Object.fromEntries(c.metrics.map((m) => [m.name, m.value]));

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
});

function risks(c: Case, statements: Statements) {
  return render(
    <TooltipProvider>
      <RisksPanel statements={statements} creditEnvelope={c.credit} metricsByName={byName(c)} />
    </TooltipProvider>,
  );
}

describe("the served regime, read", () => {
  it("the developer's envelope carries the stock-build regime with the owner's sentence", () => {
    const r = readCreditRegime(FIX.developer.credit.regime);
    expect(r?.code).toBe("stock_build");
    expect(r?.finding?.text.ro).toBe(OWNER_RO);
    expect(r?.finding?.text.en).toBe(OWNER_EN);
    expect(r?.finding?.severity).toBe("high");
    expect(r?.cash?.status).toBe("approximated");
    // CFO is approximated: the finding carries no figure for it
    expect(r?.finding?.figures.find((f) => f.key === "cash_from_operations")?.value).toBeNull();
    expect(readCreditRegime(FIX.manufacturer.credit.regime)).toBeNull();
    expect(readCreditRegime(FIX.attention_developer.credit_regime)).toEqual(r);
  });
});

describe("the Risks tab prints the regime once", () => {
  it("developer (EN): one regime block, the finding, the refused composite, the cash bases", () => {
    const statements = FIX.developer.statements!;
    risks(FIX.developer, statements);
    const blocks = screen.getAllByTestId("credit-regime");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].getAttribute("data-regime")).toBe("stock_build");
    expect(screen.getByTestId("credit-regime-finding").textContent).toContain(OWNER_EN);
    expect(screen.getByTestId("credit-regime-cash").getAttribute("data-status")).toBe("approximated");
    expect(screen.getByTestId("credit-rating").textContent).not.toMatch(/^(AAA|AA|A|BBB|BB|B|CCC|CC)$/);
    const text = document.body.textContent ?? "";
    expect(text).toContain("net debt ÷ cash from operations");
    expect(text).toContain("cash from operations ÷ interest");
    expect(text).toContain("cash from operations ÷ debt service");
    expect(text).not.toContain("net debt ÷ EBITDA");
    expect(text).not.toContain("(EBIT ÷ interest)");
  });

  it("developer (RO): the owner's sentence verbatim", async () => {
    await i18n.changeLanguage("ro");
    risks(FIX.developer, FIX.developer.statements!);
    expect(screen.getAllByTestId("credit-regime")).toHaveLength(1);
    expect(screen.getByTestId("credit-regime-finding").textContent).toContain(OWNER_RO);
  });

  it("measured cash: the bottom rung, a composite on the regime's weights, the letter, the regime once", () => {
    const c = FIX.developer_measured_cash;
    const r = computeCreditScore(FIX.developer.statements!, c.credit, undefined, byName(c));
    expect(r.score).toBe(c.credit.composite_score);
    expect(r.rating).toBe(c.credit.letter_grade);
    const w = Object.fromEntries(r.components.map((x) => [x.label.split(" ")[0], x.weight]));
    expect(w.Liquidity).toBe(0.2);
    expect(w.Profitability).toBe(0.1);
    risks(c, FIX.developer.statements!);
    expect(screen.getAllByTestId("credit-regime")).toHaveLength(1);
    expect(screen.getByTestId("credit-regime-cash").getAttribute("data-status")).toBe("measured");
    expect(screen.getByTestId("credit-rating").textContent).toBe(c.credit.letter_grade);
  });

  it("a manufacturer prints no regime", () => {
    risks(FIX.manufacturer, FIX.manufacturer.statements!);
    expect(screen.queryByTestId("credit-regime")).toBeNull();
    expect(document.body.textContent).toContain("net debt ÷ EBITDA");
  });
});

describe("the hero and /report's card print the regime once", () => {
  it("the hero states the refusal, not 'analysis pending', and the regime once", () => {
    const c = FIX.developer;
    const r = computeCreditScore(c.statements!, c.credit, undefined, byName(c));
    render(
      <TooltipProvider>
        <HeroVerdictCard credit={r} companyName="saga_10_col_realestate" />
      </TooltipProvider>,
    );
    expect(screen.getAllByTestId("hero-credit-regime")).toHaveLength(1);
    // the engine's words for why there is no score, in place of "pending"
    expect(screen.getByTestId("hero-credit-regime-cash").textContent).toBe(r.regime!.cash!.refusal!.text.en);
    expect(screen.queryByTestId("hero-verdict-pending")).toBeNull();
    expect(screen.getByTestId("hero-verdict").textContent).not.toContain(i18n.t("dashV2.verdictPending"));
    expect(screen.getByTestId("hero-verdict").textContent).not.toMatch(/\b(AAA|AA|A|BBB|BB|B|CCC|CC)\b/);
  });

  it("a manufacturer's hero prints no regime", () => {
    const c = FIX.manufacturer;
    const r = computeCreditScore(c.statements!, c.credit, undefined, byName(c));
    render(
      <TooltipProvider>
        <HeroVerdictCard credit={r} companyName="agras" />
      </TooltipProvider>,
    );
    expect(screen.queryByTestId("hero-credit-regime")).toBeNull();
  });

  it("/report's credit card prints the regime once, and none for a manufacturer", () => {
    const dev = creditCardData(engineCreditResult(FIX.developer.credit, undefined, byName(FIX.developer)));
    expect(dev?.regime?.code).toBe("stock_build");
    render(<TooltipProvider><CreditScoreCard data={dev!} /></TooltipProvider>);
    expect(screen.getAllByTestId("report-credit-regime")).toHaveLength(1);
    expect(screen.getByTestId("report-credit-regime-finding").textContent).toContain(OWNER_EN);
    cleanup();
    const man = creditCardData(engineCreditResult(FIX.manufacturer.credit, undefined, byName(FIX.manufacturer)));
    render(<TooltipProvider><CreditScoreCard data={man!} /></TooltipProvider>);
    expect(screen.queryByTestId("report-credit-regime")).toBeNull();
  });
});

describe("the printed documents state the regime once", () => {
  it("the exported report and the workbook: the regime and the finding for the developer, nothing for agras", () => {
    for (const [c, regime] of [[FIX.developer, true], [FIX.manufacturer, false]] as const) {
      const envelopes = { credit: c.credit, piotroski: undefined, metricsByName: byName(c) };
      const html = buildReportHtml(c.statements!, envelopes);
      const doc = new DOMParser().parseFromString(html, "text/html");
      const blocks = doc.querySelectorAll("[data-report-credit-regime]");
      expect(blocks.length).toBe(regime ? 1 : 0);
      const wb = buildExcelWorkbook(c.statements!, undefined, envelopes);
      const sheet = XLSX.utils.sheet_to_json<(string | number)[]>(wb.Sheets["Credit & Risk"], { header: 1 });
      const rows = sheet.filter((row) => String(row[0]) === "Credit regime");
      expect(rows.length).toBe(regime ? 1 : 0);
      if (regime) {
        expect(blocks[0].textContent).toContain(OWNER_EN);
        expect(String(rows[0][1])).toContain(OWNER_EN);
        // the approximated cash flow is stated, never printed as a figure
        expect(blocks[0].textContent).toContain("not measured (approximated)");
      }
    }
  });
});

describe("a WITHHELD finding: the regime once, the owner's sentence nowhere", () => {
  const c = FIX.developer_withheld;
  const noSentence = (text: string) => {
    expect(text).not.toContain(OWNER_EN);
    expect(text).not.toContain(OWNER_RO);
  };

  it("the reader: the regime, no finding, the failed premise, the served currency", () => {
    const r = readCreditRegime(c.credit.regime)!;
    expect(r.code).toBe("stock_build");
    expect(r.finding).toBeNull();
    expect(r.findingWithheld).toEqual({ failed: ["ebitda_positive"] });
    expect(r.currency).toBe("RON");
    // the stated developer carries no withheld block
    expect(readCreditRegime(FIX.developer.credit.regime)!.findingWithheld).toBeNull();
  });

  it("the Risks tab (EN and RO) and /report's card print the regime once and no sentence", async () => {
    risks(c, FIX.developer.statements!);
    expect(screen.getAllByTestId("credit-regime")).toHaveLength(1);
    expect(screen.queryByTestId("credit-regime-finding")).toBeNull();
    // the measured cash is printed in the currency it was served in
    expect(screen.getByTestId("credit-regime-cash").textContent).toContain("RON");
    noSentence(document.body.textContent ?? "");
    cleanup();
    await i18n.changeLanguage("ro");
    risks(c, FIX.developer.statements!);
    expect(screen.getAllByTestId("credit-regime")).toHaveLength(1);
    noSentence(document.body.textContent ?? "");
    cleanup();
    // with no finding figures, the cash still prints in the SERVED currency
    // (read off the withheld premise's unit) — never a default
    const eur = JSON.parse(JSON.stringify(c.credit)) as CreditEnvelope & {
      regime: { finding_withheld: { premise: { unit: string }[] }; cash: { value: number } };
    };
    for (const t of eur.regime.finding_withheld.premise) t.unit = "EUR";
    risks({ ...c, credit: eur }, FIX.developer.statements!);
    const cashText = screen.getByTestId("credit-regime-cash").textContent ?? "";
    expect(cashText).toContain(printRegimeAmount(eur.regime.cash.value, "EUR"));
    expect(cashText).not.toContain(printRegimeAmount(eur.regime.cash.value, "RON"));
    cleanup();
    const card = creditCardData(engineCreditResult(c.credit, undefined, byName(c)));
    render(<TooltipProvider><CreditScoreCard data={card!} /></TooltipProvider>);
    expect(screen.getAllByTestId("report-credit-regime")).toHaveLength(1);
    expect(screen.queryByTestId("report-credit-regime-finding")).toBeNull();
    noSentence(document.body.textContent ?? "");
  });

  it("the documents and the command bar: the regime's label, no sentence", () => {
    const envelopes = { credit: c.credit, piotroski: undefined, metricsByName: byName(c) };
    const doc = new DOMParser().parseFromString(buildReportHtml(FIX.developer.statements!, envelopes), "text/html");
    const blocks = doc.querySelectorAll("[data-report-credit-regime]");
    expect(blocks.length).toBe(1);
    noSentence(blocks[0].textContent ?? "");
    const r = readCreditRegime(c.credit.regime)!;
    for (const lang of ["en", "ro"] as const) {
      const line = regimeLine(r, lang, servedMoney("RON"));
      expect(line).toBe(`${r.label[lang]}.`);
      noSentence(line ?? "");
    }
  });
});

describe("the command bar prints the regime once, in the rest state", () => {
  it("the line: the label, the owner's sentence, the served net 711 and turnover in the served currency", () => {
    const reg = readCreditRegime(FIX.attention_developer.credit_regime)!;
    const print = servedMoney(FIX.attention_developer.currency);
    const ro = regimeLine(reg, "ro", print)!;
    expect(ro).toContain(OWNER_RO);
    const net = reg.finding!.figures.find((f) => f.key === "net_711")!;
    const turn = reg.finding!.figures.find((f) => f.key === "net_turnover")!;
    expect(ro).toContain(print(net.value));
    expect(ro).toContain(print(turn.value));
    expect(regimeLine(reg, "en", print)).toContain(OWNER_EN);
  });

  it("CmdbarList renders it once at rest and not while typing", () => {
    const reg = readCreditRegime(FIX.attention_developer.credit_regime)!;
    const line = regimeLine(reg, "en", servedMoney("RON"))!;
    const props = { header: "h", rows: [], activeIdx: -1, onActivate: () => {}, onRun: () => {},
                    caveat: null, status: null };
    render(<CmdbarList {...props} regime={line} mode="rest" />);
    expect(screen.getAllByTestId("cmdbar-credit-regime")).toHaveLength(1);
    cleanup();
    render(<CmdbarList {...props} regime={line} mode="typing" />);
    expect(screen.queryByTestId("cmdbar-credit-regime")).toBeNull();
  });
});

// EVERY REGIME FIGURE IN THE READER'S LANGUAGE (owner ticket 2026-09-28 /
// rulings 2026-09-29, CLAUDE.md §26; release r-rulings2, 2026-10-01). The
// regime's surfaces were written before that ruling: `printRegimeAmount`
// printed in whatever the ACTIVE language was — so the English-by-contract
// report and workbook printed "29,6 mil."-shaped Romanian figures inside an
// English sentence for a Romanian reader — and the command bar's line used an
// unbound printer. The expected strings below are STATED, and the rendered
// surfaces are read by the independent number-shape detector
// (frontend/test/numberLanguage.ts) — never by the printer under test.
//
// WHAT THIS REDS ON (TC-11): the regime's money printed in the currency's or
// the active language's locale instead of the surface's; a code before the
// figure; "lei"; a share printed with the other language's decimal; the
// exported documents following the UI language.
describe("the regime's figures follow the reader's language", () => {
  const LANGS = ["en", "ro"] as const;

  it("bound to a language, the amount prints that language whatever the UI language — the code after the figure", async () => {
    const want = {
      en: ["-8,000,000.00 RON", "13,650,000.50 EUR"],
      ro: ["-8.000.000,00 RON", "13.650.000,50 EUR"],
    } as const;
    for (const global of LANGS) {
      await i18n.changeLanguage(global);
      for (const lang of LANGS) {
        expect(
          [plainSpaces(printRegimeAmount(-8_000_000, "RON", lang)), plainSpaces(printRegimeAmount(13_650_000.5, "EUR", lang))],
          `${lang} (UI ${global})`,
        ).toEqual([...want[lang]]);
      }
      // unbound: the active language's
      expect(plainSpaces(printRegimeAmount(-8_000_000, "RON"))).toBe(want[global][0]);
    }
  });

  for (const lang of LANGS) {
    it(`the Risks tab's note (${lang}): every figure it prints is in the note's language, money with its code after the figure`, async () => {
      await i18n.changeLanguage(lang);
      let figures = 0;
      let money = 0;
      for (const c of [FIX.developer, FIX.developer_measured_cash, FIX.developer_withheld]) {
        risks(c, FIX.developer.statements!);
        const note = screen.getByTestId("credit-regime");
        const nodes = Array.from(note.querySelectorAll(".tabular-nums"));
        const cash = screen.getByTestId("credit-regime-cash");
        if (cash.getAttribute("data-status") === "measured") nodes.push(cash);
        for (const el of nodes) {
          const text = plainSpaces(el.textContent);
          if (!/\d/.test(text)) continue;
          figures++;
          expect(foreignNumber(text, lang), `${lang}: "${text}" is in the other language's format`).toBeNull();
          if (/RON/.test(text)) {
            money++;
            expect(text).toMatch(/\d RON$/);
            expect(text).not.toMatch(/RON -?\d/);
          }
          expect(text).not.toMatch(/\blei\b/);
        }
        cleanup();
      }
      expect(figures, "VACUITY: regime figures read").toBeGreaterThanOrEqual(12);
      expect(money, "VACUITY: regime money figures read").toBeGreaterThanOrEqual(6);
      console.log(`GATE-WORK credit-regime-ui-language ${lang} figures=${figures} money=${money}`);
    });
  }

  it("the documents are English by contract: under a Romanian UI the regime sentence still prints English figures", async () => {
    const r = readCreditRegime(FIX.developer.credit.regime)!;
    const measured = readCreditRegime(FIX.developer_measured_cash.credit.regime)!;
    await i18n.changeLanguage("en");
    const english = [regimeDocumentText(r), regimeDocumentText(measured)];
    await i18n.changeLanguage("ro");
    const underRo = [regimeDocumentText(r), regimeDocumentText(measured)];
    expect(underRo).toEqual(english);
    for (const text of underRo) {
      expect(foreignNumber(plainSpaces(text), "en"), `a Romanian figure in the English document: "${text}"`).toBeNull();
      expect((plainSpaces(text).match(/\d RON\b/g) ?? []).length, "VACUITY: served money in the sentence").toBeGreaterThanOrEqual(2);
    }
  });

  it("the command bar's line: a printer bound to the bar's language prints it whatever the UI language", async () => {
    const reg = readCreditRegime(FIX.attention_developer.credit_regime)!;
    for (const global of LANGS) {
      await i18n.changeLanguage(global);
      for (const lang of LANGS) {
        const line = plainSpaces(regimeLine(reg, lang, servedMoney(FIX.attention_developer.currency, { lang })));
        expect(foreignNumber(line, lang), `${lang} line under a ${global} UI: "${line}"`).toBeNull();
        expect((line.match(/\d RON\b/g) ?? []).length).toBe(2);
      }
    }
  });
});
