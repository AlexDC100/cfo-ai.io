// THE ONE EBITDA ON THE RENDERED COMPONENTS STAGE F2 CHANGED (design A7).
//
// The three A8 gates (one-ebitda, turnover-denominator, refusal-carries)
// hold the MODELS every surface is built from. This file holds the
// components whose own rendering the ruling changed, one assertion per
// defect it closes:
//   · a briefing written under the previous EBITDA definition is hidden
//     with the engine's note (design A9) — never shown with stale numbers;
//   · the Valuation tab never offers a refused EBITDA as an editable 0,
//     states the refusal, the served routing basis and the "saved under
//     the previous EBITDA definition" flag — in a sentence that names no
//     revision's content (it told users whose rows were saved under the
//     2026-09-26 revision to re-check 711 / 72x, which that revision already
//     held inside — review 2026-10-01) and prints in the reader's language,
//     the served flag included (CLAUDE.md §26);
//   · the budget variance shows the actual EBITDA's 711 / 72x components
//     (template unchanged) or its refusal;
//   · the benchmark page renders the engine's "refused" verdict (it
//     crashed: `meta[verdict]` was undefined) and prints the refusal in the
//     company column and the headline;
//   · the overview's prior EBITDA move is withheld across definitions;
//   · the NAV cascade's NOI proxy is EBITDA − net 711 (the developer's NAV
//     must not move by the definition).
// REDS ON: any of those regressing. CANNOT SEE: the models (the A8 gates).
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";

import i18n from "@/i18n";
import { renderWithProviders } from "@/test/renderWithProviders";
import { briefingVisibility } from "@/lib/briefingDefinition";
import { ValuationSection } from "@/components/cfo/ValuationSection";
import { VarianceTable } from "@/components/comparison/VarianceTable";
import { ComparisonSection, HeadlineGrid, VerdictBadge } from "@/pages/cfo/BenchmarkReport";
import { overviewPriorOf } from "@/lib/overviewComparison";
import { buildNavCascade } from "@/lib/buildNavCascade";
import { deriveTotals } from "@/lib/financialReport";
import type { PeriodValuation } from "@/lib/activePeriod";
import type { VarianceRow } from "@/lib/comparison/buildVariance";
import type { ComparativesResponse } from "@/lib/comparatives";

import { constructedBook, firmBook } from "./oneEbitdaSurfaceBooks";

afterEach(() => cleanup());

describe("a briefing written under the previous EBITDA definition is hidden with the engine's note", () => {
  // The engine's note (pipeline.BRIEFING_PREVIOUS_DEFINITION_NOTE), GENERIC
  // since the stamp moved twice (deploy-readiness review, 2026-09-29): it
  // names no content an earlier definition lacked.
  const NOTE = {
    ro: "Comentariul a fost scris sub o definiție anterioară a EBITDA și este ascuns; reanalizați perioada pentru un comentariu nou.",
    en: "This briefing was written under an earlier EBITDA definition and is hidden; re-analyse the period for a new one.",
  };
  it("hidden: no body, the served note", () => {
    const v = briefingVisibility({
      body: "EBITDA was 10.8M …",
      definition: { written_under: null, current_definition: "x", written_under_previous_definition: true, note: NOTE },
    });
    expect(v.body).toBeNull();
    expect(v.hiddenNote).toEqual(NOTE);
  });
  it("current: shown as served", () => {
    const v = briefingVisibility({
      body: "EBITDA was 11.8M …",
      definition: { written_under: "x", current_definition: "x", written_under_previous_definition: false, note: null },
    });
    expect(v).toEqual({ body: "EBITDA was 11.8M …", hiddenNote: null });
  });
  it("no definition block (a sample): shown", () => {
    expect(briefingVisibility({ body: "prose" }).body).toBe("prose");
  });
  it("a hidden briefing served without its note: the fallback restates the engine's generic note", () => {
    const v = briefingVisibility({
      body: "EBITDA was 10.8M …",
      definition: { written_under: "x-earlier", current_definition: "x", written_under_previous_definition: true, note: null },
    });
    expect(v.body).toBeNull();
    expect(v.hiddenNote).toEqual(NOTE);
  });
});

function valuationOf(over: Partial<PeriodValuation>): PeriodValuation {
  return {
    primary_method: "asset_based",
    confidence: "low",
    multiples_source: null,
    multiples_as_of_date: null,
    formula_text: "",
    method_warnings: [],
    inputs: { ebitda_used: null, revenue_used: 1_000_000, total_debt_used: 0, cash_used: 0 },
    primary: {
      method: "asset_based", multiple_p25: 6, multiple_p50: 8, multiple_p75: 10,
      ev_p25: null, ev_p50: null, ev_p75: null, equity_p25: null, equity_p50: null, equity_p75: null,
    },
    cross_checks: {
      revenue_multiple: { multiple_p25: null, multiple_p50: null, multiple_p75: null, equity_p25: null, equity_p50: null, equity_p75: null },
      dcf: { wacc: null, terminal_growth: null, enterprise_value: null, equity_value: null, sensitivity_low: null, sensitivity_high: null },
    },
    football_field: [],
    user_assumptions: null,
    ...over,
  } as PeriodValuation;
}

describe("Valuation tab — a refused EBITDA is not an editable 0", () => {
  it("states the refusal, forms no multiple, offers no EBITDA input", () => {
    renderWithProviders(
      <ValuationSection
        periodId="p"
        currency="RON"
        valuation={valuationOf({
          ebitda_refusal: { code: "account_121_anchor_absent", text_en: "account 121 is absent" },
          routing: { basis: "ebitda_refused" },
        })}
      />,
    );
    expect(screen.getByTestId("valuation-ebitda-refused").textContent).toContain("account 121 is absent");
    expect(screen.getByTestId("valuation-formula").textContent).toContain("EBITDA (refused)");
    expect(screen.getByTestId("valuation-formula").textContent).not.toMatch(/EBITDA \(RON 0|EBITDA \(0/);
    expect(screen.queryByTestId("valuation-input-ebitda")).toBeNull();
    expect(screen.getByTestId("valuation-input-ebitda-refused").textContent).toContain("account 121 is absent");
    expect(screen.getByTestId("valuation-routing").textContent).toContain("EBITDA is refused");
  });

  // The engine's flag (`_valuation.PREVIOUS_DEFINITION_FLAG`) and the two
  // stamps it is served on: an unstamped row (saved before the stamp
  // existed) and a row stamped with the revision before today's
  // (`chart_of_accounts.EBITDA_DEFINITION_PREVIOUS_REVISIONS`).
  const FLAG = { ro: "salvat sub definiția anterioară a EBITDA", en: "saved under the previous EBITDA definition" };
  const CURRENT = "ebitda/2026-09-28:711-72x-inside,767-financial,provisions-6812-6814-7812-7814-outside,7411-turnover";
  const PREVIOUS = "ebitda/2026-09-26:711-72x-inside,767-financial";
  const SENTENCE = {
    en: "Your saved figures were saved under the previous EBITDA definition — they still apply; re-check the EBITDA you typed against today's definition.",
    ro: "Valorile tale: salvat sub definiția anterioară a EBITDA. Se aplică în continuare; verifică EBITDA pe care ai introdus-o față de definiția actuală.",
  } as const;
  // A word naming what some revision moved — true of one stamp, false of another.
  const CONTENT_WORDS = /711|72x|7411|6812|6814|7812|7814|stock variation|own work|stocurilor|imobilizat|provision|provizi/i;

  const flagged = (savedUnder: string | null) =>
    valuationOf({
      primary_method: "ev_ebitda",
      inputs: { ebitda_used: 11_848_065.27, revenue_used: 110_798_309.14, total_debt_used: 0, cash_used: 0 },
      routing: { basis: "margin_not_meaningful" },
      user_assumptions: {
        ebitda_used: 10_776_378.24, multiple_used: null, debt_used: null, cash_used: null,
        definition: {
          saved_under: savedUnder, current_definition: CURRENT, saved_under_previous_definition: true, flag: FLAG,
        },
      },
    });

  it("a served EBITDA: the editor, the routing basis and the previous-definition flag", () => {
    renderWithProviders(<ValuationSection periodId="p" currency="RON" valuation={flagged(null)} />);
    expect(screen.queryByTestId("valuation-ebitda-refused")).toBeNull();
    expect(screen.getByTestId("valuation-input-ebitda")).toBeTruthy();
    expect(screen.getByTestId("valuation-routing").textContent).toContain("the margin rule");
    expect(screen.getByTestId("valuation-override-definition-flag").textContent).toContain(
      "saved under the previous EBITDA definition",
    );
  });

  it("the flag's sentence names no revision's content and prints in the reader's language, on either stamp", async () => {
    try {
      for (const savedUnder of [null, PREVIOUS]) {
        for (const lang of ["en", "ro"] as const) {
          await i18n.changeLanguage(lang);
          renderWithProviders(<ValuationSection periodId="p" currency="RON" valuation={flagged(savedUnder)} />);
          const text = screen.getByTestId("valuation-override-definition-flag").textContent ?? "";
          expect(text, `${savedUnder ?? "unstamped"} (${lang})`).toBe(SENTENCE[lang]);
          expect(text, `${savedUnder ?? "unstamped"} (${lang}): no content word`).not.toMatch(CONTENT_WORDS);
          cleanup();
        }
      }
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});

const row = (key: VarianceRow["key"], label: string, actual: number | null): VarianceRow => ({
  key, label, emphasis: key === "ebitda", higherIsBetter: true, actual, budget: null, lastYear: null,
  vsBudget: null, vsBudgetSentiment: null, vsLastYear: null, vsLastYearSentiment: null,
});

describe("budget variance — the actual EBITDA's 711 / 72x components inside the variance", () => {
  it("prints net 711 and net 72x under the EBITDA row", () => {
    renderWithProviders(
      <VarianceTable
        rows={[row("operating_revenue", "Revenue", 1_000_000), row("ebitda", "EBITDA", 290_000)]}
        ebitdaComponents={{ inventoryVariation: 50_000, capitalizedOwnWork: 40_000, refusal: null }}
        currency="RON" view="both" hasBudget={false} hasLastYear={false}
      />,
    );
    expect(screen.getByTestId("variance-ebitda-component-inventory_variation").textContent).toContain(
      "Variația stocurilor de produse (711)",
    );
    expect(screen.getByTestId("variance-ebitda-component-capitalized_own_work")).toBeTruthy();
  });
  it("prints the refusal when the engine refused EBITDA", () => {
    renderWithProviders(
      <VarianceTable
        rows={[row("ebitda", "EBITDA", null)]}
        ebitdaComponents={{
          inventoryVariation: null, capitalizedOwnWork: 0,
          refusal: { code: "c", text: { ro: "contul 121 lipsește", en: "account 121 is absent" } },
        }}
        currency="RON" view="both" hasBudget={false} hasLastYear={false}
      />,
    );
    expect(screen.getByTestId("variance-ebitda-components").textContent).toContain("EBITDA refused: account 121 is absent");
  });
});

describe("benchmark — the engine's 'refused' verdict renders its reason", () => {
  const REFUSAL = { code: "margin_not_meaningful", display: { ro: "marjă nesemnificativă …", en: "margin not meaningful: turnover is 0.6% of activity" } };
  it("the verdict badge renders (it crashed on an unknown verdict)", () => {
    renderWithProviders(<VerdictBadge verdict="refused" />);
    expect(screen.getByText("Refuzat")).toBeTruthy();
  });
  it("the comparison row prints the refusal in the company column", () => {
    renderWithProviders(
      <ComparisonSection
        periodId="p"
        testId="benchmark-profitability"
        section={{
          title_ro: "Profitabilitate", title_en: "Profitability",
          comparisons: [{
            metric_name: "ebitda_margin", display: { ro: "Marja EBITDA", en: "EBITDA margin" },
            company_value: null,
            benchmark: { p25: 5, p50: 9, p75: 13, unit: "pct", source: "ins", source_year: 2023, confidence: "verified" },
            verdict: "refused", gap_pp: null, lower_is_better: false, refusal: REFUSAL,
          }],
        } as never}
      />,
    );
    expect(screen.getByTestId("benchmark-row-refused-ebitda_margin").textContent).toBe(REFUSAL.display.en);
  });
  it("the headline prints the refusal instead of a dash", () => {
    renderWithProviders(
      <HeadlineGrid
        section={{
          title_ro: "t", title_en: "Headline", metrics: ["ebitda"],
          company_values: { ebitda: null }, display: { ebitda: { ro: "EBITDA", en: "EBITDA" } },
          refusals: { ebitda: { code: "ebitda_refused", display: { ro: "EBITDA refuzată …", en: "EBITDA is refused for this period" } } },
        } as never}
      />,
    );
    expect(screen.getByTestId("benchmark-headline-refused-ebitda").textContent).toBe("EBITDA is refused for this period");
  });
});

describe("the overview's prior EBITDA move needs one definition on both sides", () => {
  const doc = (): ComparativesResponse => {
    const b = constructedBook("closed_bridge");
    return {
      prior: { label: "FY2024" }, prior_statements: b.statements, prior_line_items: b.lineItems, prior_metrics: [],
    } as unknown as ComparativesResponse;
  };
  const netDebtOf = (s: Parameters<typeof deriveTotals>[0]) => deriveTotals(s).netDebt;
  it("same definition: the prior EBITDA is the prior's served figure", () => {
    const def = (constructedBook("closed_bridge").apl.ebitda_definition as string);
    expect(overviewPriorOf(doc(), "E", netDebtOf, def)?.figures.ebitda).toBe(250000);
  });
  it("another definition: no EBITDA move (the definition change is not a movement)", () => {
    expect(overviewPriorOf(doc(), "E", netDebtOf, "ebitda/previous")?.figures.ebitda).toBeNull();
  });
});

describe("NAV cascade — the NOI proxy is EBITDA − net 711 (the developer's NAV does not move by the definition)", () => {
  it("realestate: NOI = the pre-ruling build-up, not the one EBITDA", () => {
    const b = firmBook("realestate");
    const pl = b.statements.assembled_pl as Record<string, number>;
    const nav = buildNavCascade({
      pl, bs: b.statements.assembled_bs as Record<string, number>,
      lineItems: [{ ro_account_code: "215", statement: "BS", amount: 1_000_000 } as never],
    });
    const adj = nav.assetAdjustments.find((a) => a.accountCode === "215");
    const noi = (pl.ebitda as number) - ((pl as unknown as { inventory_variation: { value: number } }).inventory_variation.value);
    expect(Math.abs(noi - -29_038_838.12)).toBeLessThan(0.01);
    expect(adj?.assumptions.noi).toBeCloseTo(noi, 2);
  });
  it("a served NOI proxy is read as served", () => {
    const b = firmBook("realestate");
    const nav = buildNavCascade({
      pl: b.statements.assembled_pl as Record<string, number>,
      bs: b.statements.assembled_bs as Record<string, number>,
      lineItems: [{ ro_account_code: "215", statement: "BS", amount: 1_000_000 } as never],
      noiApproximation: 123_456,
    });
    expect(nav.assetAdjustments.find((a) => a.accountCode === "215")?.assumptions.noi).toBe(123_456);
  });
});
