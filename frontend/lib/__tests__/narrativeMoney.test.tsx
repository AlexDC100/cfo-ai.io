// NARRATIVE MONEY — the structural half of the one-currency-per-claim law.
//
// THE DEFECT (2026-08-30, live, severity-max). The Critical-461 note read:
//
//   "Account 461 (Debitori diverși) holds RON 7,692,203 — 19.6% of total
//    assets 7.467.122,25 €"
//
// A native RON figure beside a display-converted EUR figure in ONE claim.
// `c05eab2` contained it inside the linkifier by routing every RECOGNISED
// cited money fact through the currency path. Recognition is still a
// GUESS there: a regex that requires comma grouping, rejects a leading
// "-", and calls anything >= 1000 money.
//
// This module removes the guess. The engine — the only layer that knows
// which of its facts are money — emits a template that names the FACT
// ("{{money:total_assets}}") instead of a formatted number, and declares
// a unit for every fact. The renderer resolves those through the one
// money path. A figure the template does not name is never invented, and
// a template whose facts are incomplete is never partially rendered:
// it falls back whole to the stored plain text.
//
// Fixture values are the production row for period 11b8e759 verbatim.

import { describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import {
  parseNarrativeTemplate,
  resolveMoneyDisplay,
  NarrativeText,
} from "@/lib/narrativeMoney";

// ── The production row, verbatim ────────────────────────────────────────

const BODY =
  "Account 461 (Debitori diverși) holds RON 7,692,203 due from " +
  "related parties — 19.6% of total assets RON 39,194,178. " +
  "Recoverability and intent on settlement should be confirmed.";

const BODY_TEMPLATE =
  "Account 461 (Debitori diverși) holds {{money:intercompany_loans}} due from " +
  "related parties — 19.6% of total assets {{money:total_assets}}. " +
  "Recoverability and intent on settlement should be confirmed.";

const TITLE_TEMPLATE =
  "Intercompany receivable {{money:intercompany_loans}} = 19.6% of total assets";

const FACTS = {
  intercompany_loans: 7692202.74,
  total_assets: 39194178.46,
  pct_of_assets: 0.19625880786990732,
};

const UNITS = {
  intercompany_loans: "money",
  total_assets: "money",
  pct_of_assets: "percent",
};

const RATES_EUR = { EUR: 1, RON: 5.2489, USD: 1.16 };

// Intl separates an amount from its currency code with U+00A0. Normalise
// so assertions read as prose rather than as byte trivia.
const plain = (s: string) => s.replace(/\u00a0/g, " ");

// ══ N1 — the parser ═════════════════════════════════════════════════════

describe("N1 — a template names facts, never formatted digits", () => {
  it("both money figures of the claim resolve to money parts", () => {
    const parts = parseNarrativeTemplate(BODY_TEMPLATE, FACTS, UNITS);
    expect(parts).not.toBeNull();
    const money = parts!.filter((p) => p.kind === "money");
    expect(money.map((p) => (p as { fact: string }).fact)).toEqual([
      "intercompany_loans",
      "total_assets",
    ]);
    expect(money.map((p) => (p as { value: number }).value)).toEqual([
      7692202.74, 39194178.46,
    ]);
  });

  it("no currency word survives in the inert text — that stale label IS the mix", () => {
    const parts = parseNarrativeTemplate(BODY_TEMPLATE, FACTS, UNITS)!;
    const inert = parts
      .filter((p) => p.kind === "text")
      .map((p) => (p as { value: string }).value)
      .join("");
    expect(inert).not.toMatch(/\bRON\b/);
    expect(inert).not.toMatch(/7,692,203|39,194,178/);
    // The ratio is dimensionless and stays exactly where the engine put it.
    expect(inert).toContain("19.6%");
  });

  it("|abs is honoured — a body printing abs() must not flip sign", () => {
    const parts = parseNarrativeTemplate(
      "capex {{money:capex_real|abs}} this period",
      { capex_real: -2164079.83 },
      { capex_real: "money" },
    )!;
    const m = parts.find((p) => p.kind === "money") as { value: number };
    expect(m.value).toBe(2164079.83);
  });

  it("REFUSES the whole template when a cited fact is absent — ABSENT != ZERO", () => {
    expect(
      parseNarrativeTemplate(BODY_TEMPLATE, { total_assets: 39194178.46 }, UNITS),
    ).toBeNull();
    expect(parseNarrativeTemplate(BODY_TEMPLATE, null, UNITS)).toBeNull();
  });

  it("a non-money fact is never given a currency", () => {
    const parts = parseNarrativeTemplate(
      "leverage {{fact:debt_to_ebitda}}x against a {{fact:threshold}}x covenant",
      { debt_to_ebitda: 8.5, threshold: 12 },
      { debt_to_ebitda: "ratio", threshold: "ratio" },
    )!;
    expect(parts.filter((p) => p.kind === "money")).toHaveLength(0);
    const plain = parts.map((p) => (p as { value: unknown }).value).join("");
    expect(plain).toContain("8.5");
  });

  it("an UNDECLARED unit refuses rather than guessing money", () => {
    expect(
      parseNarrativeTemplate("x {{fact:mystery}}", { mystery: 12345 }, { mystery: "unknown" }),
    ).toBeNull();
  });
});

// ══ N2 — conversion, provenance, and the missing-rate case ══════════════

describe("N2 — one money path, with its provenance stated", () => {
  it("a converted figure carries the native value and the rate used", () => {
    const d = resolveMoneyDisplay(7692202.74, "RON", "EUR", RATES_EUR, "2026-05-22");
    expect(d.convertible).toBe(true);
    expect(d.text).toMatch(/€|EUR/);
    expect(plain(d.provenance)).toContain("7.692.202,74 RON");
    expect(plain(d.provenance)).toContain("1 EUR = 5.2489 RON");
  });

  it("a MISSING rate renders NATIVE with its label, never silently mixed", () => {
    const d = resolveMoneyDisplay(7692202.74, "RON", "EUR", { EUR: 1 } as never, null);
    expect(d.convertible).toBe(false);
    // Still money, still labelled — in RON, and it says so.
    expect(d.text).toMatch(/RON/);
    expect(d.text).not.toMatch(/€/);
    expect(d.provenance).toMatch(/RON/);
  });

  it("no conversion at all when display equals source", () => {
    const d = resolveMoneyDisplay(7692202.74, "RON", "RON", RATES_EUR, null);
    expect(d.convertible).toBe(true);
    expect(d.text).toMatch(/RON/);
  });
});

// ══ N3 — the rendered claim, at EUR display ═════════════════════════════

vi.mock("@/stores/currency", () => ({
  useCurrency: () => ({
    display: "EUR",
    rates: { rates: RATES_EUR, as_of: "2026-05-22", source: "BNR", stale: false },
    setDisplay: () => {},
    refresh: async () => {},
    refreshing: false,
  }),
  useDisplayCurrency: () => "EUR",
  useRates: () => ({ rates: RATES_EUR }),
}));

function renderNarrative(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe("N3 — the 461 claim renders in ONE currency", () => {
  it("body: neither RON digits nor a RON label reach the reader", () => {
    cleanup();
    const { container } = renderNarrative(
      <NarrativeText
        text={BODY}
        template={BODY_TEMPLATE}
        facts={FACTS}
        factUnits={UNITS}
        sourceCurrency="RON"
      />,
    );
    const out = container.textContent ?? "";
    expect(out).not.toMatch(/\bRON\b/);
    expect(out).not.toContain("7,692,203");
    expect(out).not.toContain("39,194,178");
    expect(out).toContain("19.6%");
  });

  it("title: the surface c05eab2 could not reach converts too", () => {
    cleanup();
    const { container } = renderNarrative(
      <NarrativeText
        text="Intercompany receivable RON 7,692,203 = 19.6% of total assets"
        template={TITLE_TEMPLATE}
        facts={FACTS}
        factUnits={UNITS}
        sourceCurrency="RON"
      />,
    );
    expect(container.textContent ?? "").not.toMatch(/\bRON\b/);
  });

  it("every money figure in the claim carries the SAME currency", () => {
    cleanup();
    const { container } = renderNarrative(
      <NarrativeText
        text={BODY}
        template={BODY_TEMPLATE}
        facts={FACTS}
        factUnits={UNITS}
        sourceCurrency="RON"
      />,
    );
    const amounts = Array.from(
      container.querySelectorAll("[data-narrative-money]"),
    ).map((n) => n.getAttribute("data-narrative-currency"));
    expect(amounts).toHaveLength(2);
    expect(new Set(amounts).size).toBe(1);
    expect(amounts[0]).toBe("EUR");
  });

  it("the provenance of a converted figure is one hover away", () => {
    cleanup();
    const { container } = renderNarrative(
      <NarrativeText
        text={BODY}
        template={BODY_TEMPLATE}
        facts={FACTS}
        factUnits={UNITS}
        sourceCurrency="RON"
      />,
    );
    const first = container.querySelector("[data-narrative-money]");
    const title = plain(first?.getAttribute("title") ?? "");
    expect(title).toContain("1 EUR = 5.2489 RON");
    expect(title).toContain("7.692.202,74 RON");
  });

  it("a legacy row with NO template still renders — the fallback is intact", () => {
    cleanup();
    renderNarrative(
      <NarrativeText text={BODY} template={null} facts={FACTS} sourceCurrency="RON" />,
    );
    // The containment fix still applies on the legacy path.
    expect(screen.getByText(/Account 461/)).toBeTruthy();
  });
});

// ══ N4 — the facts expander stops guessing money by magnitude ═══════════
//
// Live in production on two surfaces: `typeof v === "number" &&
// Math.abs(v) > 1 ? fmt(v) : String(v)`. Every fact over 1 is
// currency-formatted AND FX-converted — so `debt_to_ebitda: 8.5` renders
// as "€1.62" and `threshold: 12.0` as "€2.29". That is a conversion
// participating in a ratio, literally.

import { formatCitedFact } from "@/lib/narrativeMoney";

describe("N4 — a fact is formatted by its declared unit", () => {
  const asMoney = (v: number) => `MONEY(${v})`;
  const units = {
    bank_debt_total: "money",
    ebitda_statutory: "money",
    debt_to_ebitda: "ratio",
    threshold: "ratio",
    pct_of_assets: "percent",
  };

  it("money converts", () => {
    expect(formatCitedFact("bank_debt_total", 14083316, units, asMoney)).toBe(
      "MONEY(14083316)",
    );
  });

  it("a multiple NEVER converts — 8.5x is not an amount of money", () => {
    expect(formatCitedFact("debt_to_ebitda", 8.5, units, asMoney)).toBe("8.5");
    expect(formatCitedFact("threshold", 12, units, asMoney)).toBe("12");
  });

  it("a percentage never converts either", () => {
    expect(formatCitedFact("pct_of_assets", 0.196, units, asMoney)).toBe("0.196");
  });

  it("without declared units it keeps today's behaviour, so old rows never regress", () => {
    // Legacy rows carry no fact_units. Preserving the old guess is a
    // deliberate no-op, not an endorsement — the row becomes exact on the
    // next pipeline run.
    expect(formatCitedFact("debt_to_ebitda", 8.5, null, asMoney)).toBe("MONEY(8.5)");
    expect(formatCitedFact("pct_of_assets", 0.196, null, asMoney)).toBe("0.196");
  });

  it("non-numeric values pass through untouched", () => {
    expect(formatCitedFact("industry", "real_estate" as never, units, asMoney)).toBe(
      "real_estate",
    );
  });
});
