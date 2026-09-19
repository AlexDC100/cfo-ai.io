// RiskBreakdownPanel — a DROPPED category renders "not scored" with the
// producer's reason, and a composite over dropped categories renders what
// it covers with the applied weights read from the served block.
//
// R-PUBLIC-ABSENT (floor_rulings.md, 2026-09-19): a category whose input the
// row's data producer never carries is dropped, its weight redistributed,
// and the engine serves `coverage` {scored, dropped[{category, inputs,
// reason}], declared_weights, applied_weights} beside a refusal with code
// `risk_category_dropped`. Before this reader learned the code it would
// have shown "unavailable" (this company's own gap) for a category no
// company of that producer can ever score, and nothing stated the weights
// the composite actually used.
//
// TC-11, what this reds on after the repair: a level word, a bar or a digit
// rendered for a dropped category; "unavailable" beside a drop; a measured
// composite over dropped categories with no coverage statement; applied
// weights rendered from anywhere but the served block (a hand-typed 26%
// would red when the block says otherwise — TC-10).

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CategoryGrid, CoverageNote, HeadlineCard } from "../RiskBreakdownPanel";
import type { PublicCompanyRiskScore } from "@/lib/publicCompanyIntelligence";
import { categoryDropFor } from "@/lib/publicCompanyIntelligence";

// The per-ticker route's payload for a live row (mode "live": no interest
// expense, revenue growth None) — see test_risk_producer_coverage.py.
const DROPPED: PublicCompanyRiskScore = {
  ticker: "AAPL",
  overall_risk_score: 40,
  risk_level: "medium",
  categories: {
    macro: 65, supply_chain: 56, geopolitical: 4,
    financial: null, valuation: 80, operational: null, regulatory: 45,
  },
  top_risks: [],
  top_opportunities: [],
  explanation:
    "AAPL composite risk 40/100 (medium) over 5 of 7 categories: financial and operational not scored (input not carried by the data producer). Highest pressure: valuation (80/100).",
  confidence: 0.6,
  computed_at: "2026-09-19T00:00:00Z",
  refusals: [
    { code: "risk_category_dropped", component: "financial", inputs: ["interest_expense"],
      text: "Financial risk not scored: interest coverage is not carried by the data producer; its 22% weight is redistributed over the scored categories." },
    { code: "risk_category_dropped", component: "operational", inputs: ["revenue_growth"],
      text: "Operational risk not scored: revenue growth is not carried by the data producer; its 10% weight is redistributed over the scored categories." },
  ],
  coverage: {
    producer: "live",
    scored: ["macro", "supply_chain", "geopolitical", "valuation", "regulatory"],
    dropped: [
      { category: "financial", inputs: ["interest_expense"], reason: "input not carried by the data producer" },
      { category: "operational", inputs: ["revenue_growth"], reason: "input not carried by the data producer" },
    ],
    declared_weights: {
      macro: 0.18, supply_chain: 0.17, geopolitical: 0.13, financial: 0.22,
      valuation: 0.1, operational: 0.1, regulatory: 0.1,
    },
    // 0.18/0.68 etc. — the block is the only source the reader may print.
    applied_weights: {
      macro: 0.2647058823529412, supply_chain: 0.25, geopolitical: 0.19117647058823528,
      valuation: 0.14705882352941177, regulatory: 0.14705882352941177,
    },
  },
};

// The same live producer, this company lacking P/E: valuation REFUSES (its
// own gap), the drops stay drops, and the composite refuses.
const DROPPED_AND_REFUSED: PublicCompanyRiskScore = {
  ...DROPPED,
  ticker: "MSFT",
  overall_risk_score: null,
  risk_level: null,
  categories: { ...DROPPED.categories, valuation: null },
  explanation: "Composite risk unavailable: valuation inputs not reported for MSFT.",
  refusals: [
    ...DROPPED.refusals,
    { code: "risk_category_unavailable", component: "valuation", inputs: ["pe_ratio"],
      text: "Valuation risk unavailable: P/E not reported in this snapshot." },
    { code: "risk_composite_unavailable", component: "overall", inputs: ["valuation"],
      text: "Composite risk unavailable: valuation inputs not reported for MSFT." },
  ],
};

describe("CategoryGrid — a dropped category", () => {
  it("renders 'not scored' plus the engine's sentence: no bar, no level, no digit, not 'unavailable'", () => {
    render(<CategoryGrid score={DROPPED} />);
    for (const cat of ["financial", "operational"] as const) {
      const row = screen.getByTestId(`risk-category-${cat}`);
      expect(row.getAttribute("data-state")).toBe("dropped");
      expect(within(row).getByText("not scored")).toBeInTheDocument();
      expect(row.querySelector('div[style*="width"]')).toBeNull();
      expect(row.textContent).not.toContain("unavailable");
      // The engine's sentence carries "22%" / "10%" — the ONLY digits allowed
      // on the row are inside that sentence.
      const sentence = DROPPED.refusals.find((r) => r.component === cat)!.text;
      expect(row.textContent).toContain(sentence);
      const outside = row.textContent!.replace(sentence, "");
      expect(outside).not.toMatch(/\b(low|medium|high|critical)\b/);
      expect(outside).not.toMatch(/\d/);
    }
  });

  it("control: the scored categories still render a number and a bar", () => {
    render(<CategoryGrid score={DROPPED} />);
    const row = screen.getByTestId("risk-category-valuation");
    expect(row.getAttribute("data-state")).toBeNull();
    expect(within(row).getByText("80")).toBeInTheDocument();
    expect(row.querySelector('div[style*="width"]')).not.toBeNull();
  });

  it("a refused category beside dropped ones keeps its own 'unavailable' state", () => {
    render(<CategoryGrid score={DROPPED_AND_REFUSED} />);
    expect(screen.getByTestId("risk-category-valuation").getAttribute("data-state")).toBe("unavailable");
    expect(screen.getByTestId("risk-category-financial").getAttribute("data-state")).toBe("dropped");
  });

  it("falls back to the block's reason when the refusal list lacks the sentence", () => {
    const noSentence: PublicCompanyRiskScore = { ...DROPPED, refusals: [] };
    render(<CategoryGrid score={noSentence} />);
    const row = screen.getByTestId("risk-category-financial");
    expect(row.getAttribute("data-state")).toBe("dropped");
    expect(row.textContent).toContain("input not carried by the data producer");
  });

  it("categoryDropFor never mints a drop from a plain refusal or a scored category", () => {
    expect(categoryDropFor(DROPPED_AND_REFUSED, "valuation")).toBeNull();
    expect(categoryDropFor(DROPPED, "macro")).toBeNull();
    expect(categoryDropFor(DROPPED, "financial")?.inputs).toEqual(["interest_expense"]);
  });
});

describe("HeadlineCard — a composite over dropped categories", () => {
  it("renders the number AND what it covers, with the applied weights from the block", () => {
    render(<HeadlineCard score={DROPPED} />);
    expect(screen.getByText("40")).toBeInTheDocument();
    expect(screen.getByText("/ 100")).toBeInTheDocument();
    const note = screen.getByTestId("risk-coverage");
    expect(note.textContent).toContain("Scored over 5 of 7 categories.");
    expect(note.textContent).toContain("Not scored: Financial, Operational — input not carried by the data producer.");
    expect(note.textContent).toContain("Macro 26.5%");
    expect(note.textContent).toContain("Supply chain 25.0%");
    expect(note.textContent).toContain("Valuation 14.7%");
    expect(note.textContent).not.toContain("Financial 22");
  });

  it("prints the weights the block carries, never a remembered constant (TC-10)", () => {
    const shifted: PublicCompanyRiskScore = {
      ...DROPPED,
      coverage: {
        ...DROPPED.coverage!,
        applied_weights: { ...DROPPED.coverage!.applied_weights, macro: 0.5 },
      },
    };
    render(<CoverageNote coverage={shifted.coverage!} />);
    expect(screen.getByTestId("risk-coverage").textContent).toContain("Macro 50.0%");
  });

  it("renders no coverage note when nothing was dropped, or on a pre-coverage payload", () => {
    const { container } = render(
      <CoverageNote coverage={{ ...DROPPED.coverage!, dropped: [], scored: [
        "macro", "supply_chain", "geopolitical", "financial", "valuation", "operational", "regulatory",
      ] }} />,
    );
    expect(container.querySelector('[data-testid="risk-coverage"]')).toBeNull();
    render(<HeadlineCard score={{ ...DROPPED, coverage: undefined }} />);
    expect(screen.queryByTestId("risk-coverage")).toBeNull();
  });

  it("a refused composite beside drops renders the refusal, not a number", () => {
    render(<HeadlineCard score={DROPPED_AND_REFUSED} />);
    const card = screen.getByTestId("risk-composite-unavailable");
    expect(card.textContent).toContain("Composite risk unavailable: valuation inputs not reported for MSFT.");
    expect(card.textContent).not.toContain("/ 100");
  });
});
