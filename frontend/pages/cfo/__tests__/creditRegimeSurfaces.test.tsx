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
// regime.
//
// WHAT THIS REDS ON (TC-11): a surface printing the regime twice, or not at
// all beside a regime grade, or on a standard book; the finding paraphrased
// (the owner's sentence is a literal here, in both languages); the cash
// components labelled with an EBITDA / EBIT basis under the regime; the
// hero saying "analysis pending" for a composite the engine refused; the
// weights printed as anything but the regime's served table; the command
// bar printing the regime while typing, or twice.

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
import { readCreditRegime, regimeLine } from "@/lib/creditRegime";
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
    const pending = screen.getByTestId("hero-verdict-pending").textContent ?? "";
    expect(pending).toBe(r.compositeRefusal!.sentence);
    expect(pending).not.toContain(i18n.t("dashV2.verdictPending"));
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
