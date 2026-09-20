// RiskBreakdownPanel — a refused score renders its refusal, never a verdict.
//
// Engine ruling 2026-09-15: absent is never a neutral number. The engine
// serves a null category / composite with a ScoreRefusal. This reader used
// to run `score >= 25 ? ... : "low"` on the null (false on every comparison,
// so "low"), draw a 2% bar (`Math.max(2, Math.min(100, null))`) and show a
// blank composite over "/ 100" — a low-styled Financial / Operational row
// on every universe ticker beside "composite risk unavailable".
//
// TC-11, what this reds on after the repair: a level word or a bar for a
// null category; a "/ 100" or an empty level pill for a null composite; the
// refusal sentence missing from the screen.

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CategoryGrid, HeadlineCard } from "../RiskBreakdownPanel";
import type { PublicCompanyRiskScore } from "@/lib/publicCompanyIntelligence";

// The per-ticker route's payload for a live-shaped snapshot (no interest
// expense, no revenue growth) — see test_public_score_refusal_route.py.
const REFUSED: PublicCompanyRiskScore = {
  ticker: "AAPL",
  overall_risk_score: null,
  risk_level: null,
  categories: {
    macro: 55, supply_chain: 48, geopolitical: 40,
    financial: null, valuation: 62, operational: null, regulatory: 38,
  },
  top_risks: [],
  top_opportunities: [],
  explanation:
    "Composite risk unavailable: financial and operational inputs not reported for AAPL.",
  confidence: 0.6,
  computed_at: "2026-09-19T00:00:00Z",
  refusals: [
    { code: "risk_category_unavailable", component: "financial", inputs: ["interest_coverage"],
      text: "Financial risk unavailable: interest coverage not reported in this snapshot." },
    { code: "risk_category_unavailable", component: "operational", inputs: ["revenue_growth"],
      text: "Operational risk unavailable: revenue growth not reported in this snapshot." },
    { code: "risk_composite_unavailable", component: "overall",
      inputs: ["financial", "operational"],
      text: "Composite risk unavailable: financial and operational inputs not reported for AAPL." },
  ],
};

const MEASURED: PublicCompanyRiskScore = {
  ...REFUSED,
  overall_risk_score: 47,
  risk_level: "medium",
  categories: { ...REFUSED.categories, financial: 36, operational: 51 },
  explanation: "AAPL composite risk 47/100 (medium). Highest pressure: valuation (62/100).",
  refusals: [],
};

describe("HeadlineCard — a refused composite", () => {
  it("renders the refusal sentence, no number, no '/ 100', no level word", () => {
    render(<HeadlineCard score={REFUSED} />);
    const card = screen.getByTestId("risk-composite-unavailable");
    expect(card.textContent).toContain(
      "Composite risk unavailable: financial and operational inputs not reported for AAPL.",
    );
    expect(card.textContent).toContain("unavailable");
    expect(card.textContent).not.toContain("/ 100");
    expect(card.textContent).not.toMatch(/\b(low|medium|high|critical)\b/);
  });

  it("control: a measured composite renders its number and level", () => {
    render(<HeadlineCard score={MEASURED} />);
    expect(screen.queryByTestId("risk-composite-unavailable")).toBeNull();
    expect(screen.getByText("47")).toBeInTheDocument();
    expect(screen.getByText("/ 100")).toBeInTheDocument();
    expect(screen.getByText("medium")).toBeInTheDocument();
  });
});

describe("CategoryGrid — a refused category", () => {
  it("renders 'unavailable' plus the matching refusal text, no bar, no level", () => {
    render(<CategoryGrid score={REFUSED} />);
    for (const cat of ["financial", "operational"] as const) {
      const row = screen.getByTestId(`risk-category-${cat}`);
      expect(row.getAttribute("data-state")).toBe("unavailable");
      expect(within(row).getByText("unavailable")).toBeInTheDocument();
      expect(row.querySelector('div[style*="width"]')).toBeNull();
      expect(row.textContent).not.toMatch(/\b(low|medium|high|critical)\b/);
      expect(row.textContent).not.toMatch(/\b\d+\b/);
    }
    expect(screen.getByTestId("risk-category-financial").textContent).toContain(
      "Financial risk unavailable: interest coverage not reported in this snapshot.",
    );
    expect(screen.getByTestId("risk-category-operational").textContent).toContain(
      "Operational risk unavailable: revenue growth not reported in this snapshot.",
    );
  });

  it("control: a measured category renders its number and a bar", () => {
    render(<CategoryGrid score={REFUSED} />);
    const row = screen.getByTestId("risk-category-valuation");
    expect(row.getAttribute("data-state")).toBeNull();
    expect(within(row).getByText("62")).toBeInTheDocument();
    expect(row.querySelector('div[style*="width"]')).not.toBeNull();
  });
});
