// NARRATIVE-UNIT GATES — the frontend half of U1, U2, U4 and U5.
//
// Production, 2026-08-30 (severity-max). The Critical note for account
// 461 rendered:
//
//     Account 461 (Debitori diverși) holds RON 7,692,203 — 19.6% of
//     total assets 7.467.122,25 €
//
// One claim, two currencies. `c05eab2` contained it. This file is the
// law that keeps it contained, and — the part that matters — it pins the
// case in BOTH display currencies. The existing
// `noteCurrencyUnity.test.tsx` pins the PARSER on the RON side; this
// file extends that to the RENDERED OUTPUT under a real currency
// toggle. It deliberately does not restate what that file already
// proves.
//
// WHAT MAKES THIS DIFFERENT FROM A PARSER TEST
//   The defect was never visible in the parser's output. It appeared
//   only once one part had been through `<Money>` and another had not.
//   So everything below renders through the REAL `linkifyAlertBody`,
//   the REAL `<Money>` / `<TraceableNumber>`, and the REAL
//   `formatMoneyFrom` — with only the currency STORE stubbed, because
//   that is the dial the user turns.
//
// Every figure is real production data (period 11b8e759, org b2025358).
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { FALLBACK_RATES } from "@/lib/rates";
import type { Currency } from "@/lib/rates";

// In-memory localStorage (this jsdom build ships a broken one) — same
// shim as the sibling suites.
const bag = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => bag.get(k) ?? null,
    setItem: (k: string, v: string) => void bag.set(k, String(v)),
    removeItem: (k: string) => void bag.delete(k),
    clear: () => void bag.clear(),
    key: (i: number) => [...bag.keys()][i] ?? null,
    get length() { return bag.size; },
  },
});

// The currency dial. Only the STORE is stubbed; the formatter, the
// rates table and both money components stay real, because the whole
// defect lived in the seam between them.
let DISPLAY: Currency = "RON";
vi.mock("@/stores/currency", () => ({
  useCurrency: () => ({
    display: DISPLAY,
    rates: { base: "EUR", rates: FALLBACK_RATES, source: "test",
             as_of: "2026-08-30", fetched_at: "", stale: false },
    setDisplay: (c: Currency) => { DISPLAY = c; },
    refresh: async () => {},
    refreshing: false,
  }),
  useDisplayCurrency: () => DISPLAY,
  useAmountFormatter: () => (v: number | null | undefined) =>
    v === null || v === undefined ? "—" : String(v),
}));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));

import { linkifyAlertBody, parseLinkifiedBody } from "../linkifyAlertBody";

// ── the live row, verbatim ─────────────────────────────────────────────

const TITLE =
  "Intercompany receivable RON 7,692,203 = 19.6% of total assets";
const BODY =
  "Account 461 (Debitori diverși) holds RON 7,692,203 due from related " +
  "parties — 19.6% of total assets RON 39,194,178. Recoverability and " +
  "intent on settlement should be confirmed. Lenders typically haircut " +
  "related-party receivables during covenant measurement.";
const FACTS = {
  intercompany_loans: 7692202.74,
  total_assets: 39194178.46,
  pct_of_assets: 0.19625880786990732,
};

// ── currency detection ─────────────────────────────────────────────────
//
// A currency counts only when it LABELS A FIGURE. "Movements in EUR/RON
// create P&L volatility" names two currencies and labels none; a gate
// that failed on that sentence would be switched off inside a week and
// then it would be protecting nothing.
const NUM = String.raw`\d[\d.,  ]*\d|\d`;
const CURRENCY_UNITS: Array<[string, RegExp]> = [
  ["RON", new RegExp(`(?:\\bRON\\b|\\blei\\b)\\s*(?:${NUM})|(?:${NUM})\\s*(?:\\bRON\\b|\\blei\\b)`)],
  ["EUR", new RegExp(`(?:\\bEUR\\b|€)\\s*(?:${NUM})|(?:${NUM})\\s*(?:\\bEUR\\b|€)`)],
  ["USD", new RegExp(`(?:\\bUSD\\b|\\$)\\s*(?:${NUM})|(?:${NUM})\\s*(?:\\bUSD\\b|\\$)`)],
];

function currenciesIn(text: string): string[] {
  return CURRENCY_UNITS.filter(([, rx]) => rx.test(text)).map(([code]) => code);
}

function renderClaim(body: string, facts: Record<string, number> | null) {
  const { container } = render(
    <MemoryRouter>
      <div>{linkifyAlertBody(body, facts)}</div>
    </MemoryRouter>,
  );
  // `textContent` is exactly what a reader sees — which is the only
  // thing this gate is allowed to have an opinion about.
  return container.textContent ?? "";
}

beforeEach(() => { DISPLAY = "RON"; });
afterEach(() => { cleanup(); });

// ══════════════════════════════════════════════════════════════════════
// U5 — the live 461 case, pinned in BOTH display currencies
// ══════════════════════════════════════════════════════════════════════

describe("U5 — the 461 note renders one currency in RON AND in EUR", () => {
  it("RON display: every figure is RON, none is anything else", () => {
    DISPLAY = "RON";
    const text = renderClaim(BODY, FACTS);
    expect(currenciesIn(text)).toEqual(["RON"]);
  });

  it("EUR display: every figure moved — no RON survives beside them", () => {
    DISPLAY = "EUR";
    const text = renderClaim(BODY, FACTS);
    expect(
      currenciesIn(text),
      `two currencies in one claim: "${text}"`,
    ).toEqual(["EUR"]);
  });

  it("USD display too — the law is about unity, not about EUR", () => {
    DISPLAY = "USD";
    expect(currenciesIn(renderClaim(BODY, FACTS))).toEqual(["USD"]);
  });

  it("PLANT — the pre-c05eab2 render is caught in EUR", () => {
    // The exact live defect: `total_assets` had a FACT_TO_SOURCE bucket
    // and converted; `intercompany_loans` did not and stayed literal,
    // keeping its RON label. Re-armed by hiding the unbucketed fact.
    DISPLAY = "EUR";
    const onlyBucketed = { total_assets: FACTS.total_assets };
    const text = renderClaim(BODY, onlyBucketed);
    expect(text).toContain("RON 7,692,203");
    expect(
      currenciesIn(text).sort(),
      "the gate failed to see the original defect",
    ).toEqual(["EUR", "RON"]);
  });

  it("PLANT — an un-armed plant is not a pass", () => {
    // A plant that changes nothing proves nothing. If the fixture ever
    // drifts so the replacement is a no-op, fail here rather than in a
    // green run six months later.
    expect(BODY).toContain("RON 7,692,203");
    expect(BODY).toContain("RON 39,194,178");
  });
});

// ══════════════════════════════════════════════════════════════════════
// U2 — the ratio does not move when the dial does
// ══════════════════════════════════════════════════════════════════════

describe("U2 — the percentage is invariant under the display currency", () => {
  it("19.6% is byte-identical in RON, EUR and USD", () => {
    const seen = (["RON", "EUR", "USD"] as Currency[]).map((c) => {
      DISPLAY = c;
      const text = renderClaim(BODY, FACTS);
      cleanup();
      const m = text.match(/(\d+\.\d)%/);
      return m ? m[1] : "MISSING";
    });
    expect(seen).toEqual(["19.6", "19.6", "19.6"]);
  });

  it("the ratio's operands are native and the quotient reproduces it", () => {
    const pct = FACTS.intercompany_loans / FACTS.total_assets;
    expect(pct).toBeCloseTo(FACTS.pct_of_assets, 12);
    expect((pct * 100).toFixed(1)).toBe("19.6");
  });

  it("PLANT — a ratio computed after conversion is a different number", () => {
    // Not a style point: this is the arithmetic the rendered sentence
    // LOOKED like it was doing. If it were, the answer would be ~103%.
    const ronPerEur = FALLBACK_RATES.RON / FALLBACK_RATES.EUR;
    const bogus = FACTS.intercompany_loans / (FACTS.total_assets / ronPerEur);
    expect(Math.abs(bogus * 100 - 19.63)).toBeGreaterThan(50);
  });
});

// ══════════════════════════════════════════════════════════════════════
// U1 — one currency per rendered claim, as a general law
// ══════════════════════════════════════════════════════════════════════

describe("U1 — a rendered claim carries at most one currency", () => {
  const CASES: Array<{ name: string; body: string; facts: Record<string, number> }> = [
    {
      // Both facts bucketed → both were always converted.
      name: "leverage_debt_to_ebitda_high",
      body: "Bank debt RON 32,986,479 divided by statutory EBITDA RON " +
            "5,256,298 = 6.28×, above the 6.0× critical threshold.",
      facts: { bank_debt_total: 32986478.75, ebitda_statutory: 5256298.14 },
    },
    {
      // Neither fact bucketed → the c05eab2 fix is what makes this pass.
      name: "equity_quality_revaluation_reserves",
      body: "Account 105 (Rezerve din reevaluare) of RON 60,154,927 " +
            "represents 56% of total equity RON 106,895,968.",
      facts: { revaluation_reserves: 60154926.76, total_equity: 106895967.91 },
    },
  ];

  for (const c of CASES) {
    it(`${c.name} is single-currency in every display currency`, () => {
      for (const display of ["RON", "EUR", "USD"] as Currency[]) {
        DISPLAY = display;
        const text = renderClaim(c.body, c.facts);
        cleanup();
        expect(
          currenciesIn(text),
          `${c.name} @ ${display}: "${text}"`,
        ).toEqual([display]);
      }
    });
  }

  it("KNOWN RED — the sign trap: a negative fact can never convert", () => {
    // Live today in 4 rows across 2 orgs (fcf_negative_development_phase,
    // earnings_quality_capitalized_own_work). The linkify regex does not
    // consume a leading `-`, so the token `2,164,080` is compared against
    // `capex_real = -2164079.83`, misses by 2x the value, and keeps its
    // RON label beside a converted sibling.
    //
    // Asserted as a FACT, not skipped: when the sign trap is fixed this
    // test fails and tells whoever fixed it to promote the case into
    // U1's CASES table above. OWNER: the engine-rules / linkify lane.
    DISPLAY = "EUR";
    const body =
      "Operating cash flow RON 1,781,405 minus capex RON 2,164,080 " +
      "produces negative FCF this period.";
    const facts = { cash_from_operating: 1781404.53, capex_real: -2164079.83 };
    const text = renderClaim(body, facts);
    expect(
      currenciesIn(text).sort(),
      "the sign trap is FIXED — move this case into the CASES table above " +
      "and delete this test",
    ).toEqual(["EUR", "RON"]);
  });
});

// ══════════════════════════════════════════════════════════════════════
// U4 — cross-surface parity: the note and the money primitive agree
// ══════════════════════════════════════════════════════════════════════

describe("U4 — the same fact reads identically wherever it is rendered", () => {
  it("the note's figure is cent-identical to a bare <Money> of the fact", () => {
    for (const display of ["RON", "EUR", "USD"] as Currency[]) {
      DISPLAY = display;
      const inNote = renderClaim(BODY, FACTS);
      cleanup();
      const { container } = render(
        <MemoryRouter>
          <div>
            {linkifyAlertBody("RON 39,194,178", { total_assets: FACTS.total_assets })}
          </div>
        </MemoryRouter>,
      );
      const standalone = (container.textContent ?? "").trim();
      cleanup();
      expect(
        inNote.includes(standalone),
        `@${display}: the note shows a different string for total_assets ` +
        `than the money primitive does ("${standalone}")`,
      ).toBe(true);
    }
  });

  it("parser and renderer agree on which figures are money", () => {
    const parts = parseLinkifiedBody(BODY, FACTS);
    const moneyParts = parts.filter((p) => p.kind === "link");
    expect(moneyParts).toHaveLength(2);
    DISPLAY = "EUR";
    const text = renderClaim(BODY, FACTS);
    // Two converted figures on screen, and no RON label orphaned behind
    // them — the exact shape of the original defect, inverted.
    expect((text.match(/€/g) ?? []).length).toBe(2);
    expect(currenciesIn(text)).toEqual(["EUR"]);
  });
});
