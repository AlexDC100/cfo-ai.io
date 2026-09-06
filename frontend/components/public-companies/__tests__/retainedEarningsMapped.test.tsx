// RETAINED EARNINGS — mapped from the filing, refused only when truly absent.
//
// The owner's ruling: a rating built on a placeholder is a fabrication,
// and worse on a public page a stranger reads with zero context. But the
// "absence" the honest rule acted on for every US company was
// MANUFACTURED: the frontend read a leaf named
// `retained_earnings_accumulated` that no adapter ever emitted, while
// Apple's 10-K carries the figure under us-gaap:RetainedEarningsAccumulatedDeficit
// and EDGAR serves it with an accession. Map the concept first; then the
// refusal — in the owner's exact register, naming the figure and the
// filing, never the company — applies to what is still truly absent.
//
// Every number below is REAL: `us_AAPL_pm1.json` is the verbatim body of
// `GET /api/public/markets/company/us/AAPL` built from committed SEC bytes
// through the real adapter, store and route; `aapl_envelope.json` is the
// real Sharadar-normalised FY2024 body. Nothing is hand-written.

import { render as rtlRender, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import i18n from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";

import { MarketCompanyDocumentView } from "../MarketSurface";
import { RatingRefusalNote } from "../RatingRefusalNote";
import type { MarketCompanyDocument, MarketEnvelope } from "@/lib/marketApi";
import {
  buildPublicStatements,
  ratingRefusalFor,
  ratingRefusalSentence,
  reportedRetainedEarnings,
} from "@/lib/publicCompanyAdapters";
import { computeCreditScore } from "@/lib/financialValuation";
import type { PublicCompanyEnvelope } from "@/lib/publicCompanyApi";

import pm1Fixture from "./fixtures/us_AAPL_pm1.json";
import sharadarFixture from "@/lib/__tests__/fixtures/publicCompany/aapl_envelope.json";

const pm1 = pm1Fixture as unknown as MarketCompanyDocument;
const sharadar = sharadarFixture as unknown as PublicCompanyEnvelope;

const APPLE_ACCESSION_FY2025 = "0000320193-25-000079";
const APPLE_RETAINED_FY2025_CENTS = -1_426_400_000_000; // -14,264,000,000 USD, a deficit
const APPLE_RETAINED_FY2024 = -19_154_000_000; // the Sharadar FY2024 body, same sign

const OTHER_FIGURES = [
  "revenue", "net_income", "total_assets", "equity", "total_debt", "shares_outstanding",
] as const;

const render = (ui: React.ReactElement) =>
  rtlRender(<TooltipProvider>{ui}</TooltipProvider>);

/** The pm1 document with the concept DELETED and the refusal the adapter
 *  emits for it — the shape `edgar._select_simple` writes on
 *  CONCEPT_ABSENT, copied field for field. */
function withoutRetainedEarnings(doc: MarketCompanyDocument): MarketCompanyDocument {
  const figures = { ...(doc.envelope.figures ?? {}) };
  delete figures.retained_earnings;
  const envelope: MarketEnvelope = {
    ...doc.envelope,
    figures,
    refusals: [
      ...(doc.envelope.refusals ?? []),
      {
        figure: "retained_earnings",
        code: "CONCEPT_ABSENT",
        detail: "no annual instant fact for any of RetainedEarningsAccumulatedDeficit",
      },
    ],
  };
  return { ...doc, envelope };
}

// ── the EDGAR path: the figure, with its accession ─────────────────────

describe("EDGAR pm1 — retained earnings is a figure with an accession", () => {
  it("the real AAPL document carries retained_earnings, negative, under the FY2025 10-K accession", () => {
    const fig = pm1.envelope.figures?.retained_earnings;
    expect(fig, "retained_earnings is not in the pm1 envelope — the concept map lacks RetainedEarningsAccumulatedDeficit").toBeDefined();
    expect(fig!.value_minor).toBe(APPLE_RETAINED_FY2025_CENTS);
    expect(fig!.currency).toBe("USD");
    expect(fig!.provenance?.accession).toBe(APPLE_ACCESSION_FY2025);
    expect(fig!.provenance?.concept).toBe("RetainedEarningsAccumulatedDeficit");
    expect(pm1.envelope.refusals).toEqual([]);
  });

  it("renders the figure on the document with its provenance affordance", () => {
    const { container } = render(<MarketCompanyDocumentView result={{ ok: true, document: pm1 }} />);
    expect(screen.getByText("Retained Earnings")).toBeInTheDocument();
    // seven sourced figures, seven affordances — the new one is not a bare number
    const affordances = container.querySelectorAll('[data-provenance="true"]').length;
    expect(affordances).toBe(Object.keys(pm1.envelope.figures ?? {}).length);
    expect(screen.queryByTestId("market-document-refusals")).toBeNull();
  });

  it("deleting the concept yields the named refusal and every other figure still renders", () => {
    const doc = withoutRetainedEarnings(pm1);
    render(<MarketCompanyDocumentView result={{ ok: true, document: doc }} />);
    expect(screen.queryByText("Retained Earnings")).toBeNull();
    const list = screen.getByTestId("market-document-refusals");
    expect(within(list).getByTestId("market-document-refusal-retained_earnings")).toHaveTextContent(
      "Retained earnings not reported in this filing",
    );
    expect(screen.getByText("1 figure refused rather than estimated")).toBeInTheDocument();
    for (const name of OTHER_FIGURES) {
      const label = name
        .split("_")
        .map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
        .join(" ");
      expect(screen.getByText(label), name).toBeInTheDocument();
    }
  });

  it("the refusal line is about the figure and the filing in Romanian too", async () => {
    const doc = withoutRetainedEarnings(pm1);
    await i18n.changeLanguage("ro");
    try {
      render(<MarketCompanyDocumentView result={{ ok: true, document: doc }} />);
      expect(screen.getByTestId("market-document-refusal-retained_earnings")).toHaveTextContent(
        "Rezultat reportat — neraportat în această raportare",
      );
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});

// ── the Sharadar-shaped path: the leaf nothing produced ────────────────

describe("statements adapter — retained earnings is read from where the feed put it", () => {
  it("the real FY2024 body shelves the reported value under unmapped, and the adapter reads it, signed", () => {
    const period = sharadar.periods[0];
    // the leaf this adapter used to read does not exist — and never did
    expect(period.leaves["retained_earnings_accumulated"]).toBeUndefined();
    const shelved = period.unmapped.find((u) => u.name === "retained_earnings");
    expect(shelved?.reason).toBe("canonical_leaf_not_in_schema_v1");
    expect(shelved?.amount).toBe(APPLE_RETAINED_FY2024);
    expect(reportedRetainedEarnings(period)).toBe(APPLE_RETAINED_FY2024);
  });

  it("retained earnings is REPORTED on the statements, not declared absent, and the BS line carries it", () => {
    const built = buildPublicStatements(sharadar)!;
    expect(built.statements.balanceSheet.retainedEarnings).toBe(APPLE_RETAINED_FY2024);
    expect(built.statements.absentInputs).not.toContain("retainedEarnings");
    const equity = built.bs.equityLiabSections.find((sec) => sec.header === "EQUITY")!;
    const line = equity.lines.find((l) => l.label === "Retained earnings")!;
    expect(line.closing).toBe(APPLE_RETAINED_FY2024);
    expect(line.opening).toBe(-214_000_000); // FY2023, the prior period of the same body
  });

  it("Altman X2 computes from the reported book — but no letter is minted while X1's inputs are unreported", () => {
    const built = buildPublicStatements(sharadar)!;
    const credit = computeCreditScore(built.statements);
    expect(credit.altman.components.x2_re_to_assets).toBeCloseTo(APPLE_RETAINED_FY2024 / 364_980_000_000, 12);
    // The feed reports no current-asset / current-liability split, so X1 —
    // and therefore the score and the letter — REFUSE. A letter here would
    // sit on a working capital that treats every liability as current.
    expect(credit.altman.components.x1_wc_to_assets).toBeNull();
    expect(credit.altman.score).toBeNull();
    expect(credit.rating).toBeNull();
    const refusal = ratingRefusalFor(built.statements, credit);
    expect(refusal?.figures).toEqual(["currentAssets", "currentLiabilities"]);
    expect(refusal?.figures).not.toContain("retainedEarnings");
  });

  it("with the shelved record removed, retained earnings is truly absent and the sentence is the owner's, in both languages", () => {
    const period = sharadar.periods[0];
    const stripped: PublicCompanyEnvelope = {
      ...sharadar,
      periods: [
        { ...period, unmapped: period.unmapped.filter((u) => u.name !== "retained_earnings") },
        ...sharadar.periods.slice(1),
      ],
    };
    const built = buildPublicStatements(stripped)!;
    expect(built.statements.absentInputs).toContain("retainedEarnings");
    const credit = computeCreditScore(built.statements);
    expect(credit.altman.components.x2_re_to_assets).toBeNull();
    expect(credit.rating).toBeNull();
    const refusal = ratingRefusalFor(built.statements, credit)!;
    expect(refusal.figures).toContain("retainedEarnings");

    const only = { figures: ["retainedEarnings" as const] };
    const t = (key: string, opts?: Record<string, unknown>) => String(i18n.t(key, opts));
    expect(ratingRefusalSentence(only, t)).toBe(
      "Rating unavailable: retained earnings not reported in this filing",
    );
    const ro = i18n.getFixedT("ro");
    expect(ratingRefusalSentence(only, (k, o) => String(ro(k, o)))).toBe(
      "Rating indisponibil: rezultatul reportat nu este raportat în această situație financiară depusă",
    );
    // every figure and ratio the page CAN compute still renders: the same
    // statements, minus exactly one input
    const intact = buildPublicStatements(sharadar)!;
    expect(new Set(built.statements.absentInputs)).toEqual(
      new Set([...(intact.statements.absentInputs ?? []), "retainedEarnings"]),
    );
    expect(built.statements.reportedTotals).toEqual(intact.statements.reportedTotals);
    expect(built.pl).toEqual(intact.pl);
    expect(built.bs.totalAssets).toEqual(intact.bs.totalAssets);
    expect(built.bs.totalEquityLiab).toEqual(intact.bs.totalEquityLiab);
  });

  it("the note renders the sentence where a letter would go, and names its figures for the DOM", () => {
    render(<RatingRefusalNote refusal={{ figures: ["retainedEarnings"] }} />);
    const note = screen.getByTestId("rating-refusal");
    expect(note).toHaveTextContent("Rating unavailable: retained earnings not reported in this filing");
    expect(note.getAttribute("data-figures")).toBe("retainedEarnings");
  });

  it("a rating that WAS minted has no refusal to print", () => {
    // A complete private-style statement: the reader mints a letter and
    // the refusal helper returns null — the sentence never shadows a real
    // verdict.
    const built = buildPublicStatements(sharadar)!;
    const complete = {
      ...built.statements,
      absentInputs: [],
      reportedTotals: {
        ...built.statements.reportedTotals,
        totalCurrentAssets: 152_987_000_000, // Apple FY2024 10-K, for the shape only
        totalCurrentLiabilities: 176_392_000_000,
      },
    };
    const credit = computeCreditScore(complete);
    expect(credit.rating).not.toBeNull();
    expect(ratingRefusalFor(complete, credit)).toBeNull();
  });
});
