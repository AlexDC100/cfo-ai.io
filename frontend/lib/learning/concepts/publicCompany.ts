// F5.0 Phase 6 — Public-market concepts.
//
// Six concepts owned by the public-company dashboard. Each one:
//   · plainEnglish: friendly one-liner
//   · shortDefinition: finance-grade definition
//   · inlineFormula: short string
//   · sourceTrace: returns a `nasdaq` / `public_company_dataset` / `calculated`
//     variant pointing at Sharadar SF1 (the only live source CFO AI ships
//     today for public-market data)
//   · related: cross-links so the popover stack drilling works
//
// Demo handling: when the active envelope is the synthetic demo
// universe (operator hasn't configured a Sharadar key), the dashboard
// flips a `demo` flag in ConceptContext. sourceTrace inspects that and
// returns a "Demo" provider chip instead of pretending the number came
// from a live data feed.

import type { Concept } from "./_schema";

// Helpers ----------------------------------------------------------------

function nasdaqOrDemo(
  ctx: Parameters<NonNullable<Concept["sourceTrace"]>>[0],
  field: string,
):
  | { sourceType: "nasdaq"; dataset: string; asOf?: string; confidence?: number }
  | { sourceType: "public_summary"; provider: string; asOf?: string } {
  const m = (ctx.metrics ?? {}) as {
    publicCompanyIsDemo?: boolean;
    publicCompanyAsOf?: string;
  };
  if (m.publicCompanyIsDemo) {
    return {
      sourceType: "public_summary",
      provider: `Demo · ${field}`,
      asOf: m.publicCompanyAsOf,
    };
  }
  return {
    sourceType: "nasdaq",
    dataset: `SHARADAR/SF1 · ${field}`,
    asOf: m.publicCompanyAsOf,
    confidence: 0.95,
  };
}

// Concepts ---------------------------------------------------------------

const market_cap: Concept = {
  key: "market_cap",
  name: { en: "Market Cap", ro: "Capitalizare bursieră" },
  category: "Public Company",
  shortDefinition: {
    en: "Stock price × shares outstanding. The current price the market " +
        "puts on the entire equity stake — what buying every share would cost today.",
    ro: "Preț acțiune × număr acțiuni. Prețul curent pe care piața îl pune " +
        "pe întreaga capitalizare — costul de a cumpăra toate acțiunile azi.",
  },
  plainEnglish: {
    en: "If you bought every share of the company at today's price, this is " +
        "what you'd pay. It's the market's vote on what the equity is worth.",
    ro: "Dacă ai cumpăra toate acțiunile la prețul de azi, asta e cât ai " +
        "plăti. Este verdictul pieței asupra valorii capitalului.",
  },
  inlineFormula: "Stock Price × Shares Outstanding",
  related: ["enterprise_value", "stock_price", "pe_ratio"],
  sourceTrace: (ctx) => nasdaqOrDemo(ctx, "marketcap"),
};

const stock_price: Concept = {
  key: "stock_price",
  name: { en: "Stock Price", ro: "Preț acțiune" },
  category: "Public Company",
  shortDefinition: {
    en: "The last traded price for one share — for US tickers, the closing " +
        "price from the most recent trading day on the listed exchange.",
    ro: "Ultimul preț tranzacționat pentru o acțiune — pentru tickere US, " +
        "prețul de închidere din ultima zi de tranzacționare.",
  },
  plainEnglish: {
    en: "What one share trades for today. Multiply by total shares and you " +
        "get market cap; divide net income by it and you get EPS.",
    ro: "Prețul unei acțiuni azi. Înmulțit cu numărul total de acțiuni dă " +
        "capitalizarea; profitul net împărțit la acest preț dă EPS.",
  },
  related: ["market_cap", "pe_ratio"],
  sourceTrace: (ctx) => nasdaqOrDemo(ctx, "closeunadj (latest)"),
};

const pe_ratio: Concept = {
  key: "pe_ratio",
  name: { en: "Price / Earnings", ro: "Preț / Profit" },
  category: "Public Company",
  shortDefinition: {
    en: "Market cap divided by net income (or stock price ÷ EPS). How many " +
        "years of current earnings the market is paying for the equity.",
    ro: "Capitalizarea împărțită la profitul net (sau preț ÷ EPS). Câți ani " +
        "de profit curent plătește piața pentru capital.",
  },
  plainEnglish: {
    en: "How many years of profit the market is paying upfront. A high P/E " +
        "means investors expect growth; low P/E means they're cautious.",
    ro: "Câți ani de profit plătește piața în avans. P/E mare = investitorii " +
        "așteaptă creștere; P/E mic = sunt prudenți.",
  },
  inlineFormula: "Market Cap / Net Income",
  benchmark: { p25: 10, median: 18, p75: 28 },
  related: ["market_cap", "stock_price", "net_profit"],
  sourceTrace: (ctx) => nasdaqOrDemo(ctx, "pe (rolling)"),
  computation: (ctx, v) => {
    const m = (ctx.metrics ?? {}) as {
      marketCap?: number;
      netProfit?: number;
    };
    return {
      result: { value: v, format: "ratio" },
      layout: "fraction",
      tokens: [
        { type: "value", value: m.marketCap ?? 0, conceptKey: "market_cap", label: "Market Cap", format: "currency" },
        { type: "operator", op: "÷" },
        { type: "value", value: m.netProfit ?? 0, conceptKey: "net_profit", label: "Net Income", format: "currency" },
      ],
    };
  },
};

const fcf_yield: Concept = {
  key: "fcf_yield",
  name: { en: "Free Cash Flow Yield", ro: "Randament FCF" },
  category: "Public Company",
  shortDefinition: {
    en: "Free cash flow divided by market cap. The cash return on each " +
        "RON / USD of equity at today's price. Inverse of the price-to-FCF multiple.",
    ro: "Free cash flow împărțit la capitalizare. Randamentul de cash pe " +
        "fiecare RON / USD de capital la prețul de azi.",
  },
  plainEnglish: {
    en: "If you bought every share today, this is the cash return the " +
        "business throws off each year as a % of your purchase price. " +
        "5% is healthy; 10%+ is cheap (or risky).",
    ro: "Dacă ai cumpăra toate acțiunile azi, ăsta e cash-ul anual ca % " +
        "din prețul plătit. 5% e sănătos; 10%+ înseamnă ieftin (sau riscant).",
  },
  inlineFormula: "Free Cash Flow / Market Cap",
  benchmark: { p25: 0.03, median: 0.05, p75: 0.08 },
  related: ["market_cap", "operating_cash_flow", "capex"],
  sourceTrace: (ctx) => nasdaqOrDemo(ctx, "fcf ÷ marketcap"),
  computation: (ctx, v) => {
    const m = (ctx.metrics ?? {}) as {
      freeCashFlow?: number;
      marketCap?: number;
    };
    return {
      result: { value: v, format: "percentage" },
      layout: "fraction",
      tokens: [
        { type: "value", value: m.freeCashFlow ?? 0, conceptKey: "operating_cash_flow", label: "Free Cash Flow", format: "currency" },
        { type: "operator", op: "÷" },
        { type: "value", value: m.marketCap ?? 0, conceptKey: "market_cap", label: "Market Cap", format: "currency" },
      ],
    };
  },
};

const net_debt: Concept = {
  key: "net_debt",
  name: { en: "Net Debt", ro: "Datorie netă" },
  category: "Leverage & Solvency",
  shortDefinition: {
    en: "Total interest-bearing debt minus cash. The net amount a buyer " +
        "would need to refinance (or pay off) to take over the business " +
        "debt-free.",
    ro: "Datoria totală cu dobândă minus cash. Suma netă pe care un cumpărător " +
        "ar trebui să o refinanțeze pentru a prelua firma fără datorii.",
  },
  plainEnglish: {
    en: "What the company owes to banks, minus what's sitting in the bank. " +
        "If it's negative, the company has more cash than debt — rare and great.",
    ro: "Cât datorează firma băncilor, minus cash-ul din bancă. Dacă e " +
        "negativ, firma are mai mult cash decât datorii — rar și foarte bine.",
  },
  inlineFormula: "Gross Debt − Cash",
  related: ["total_debt", "cash", "enterprise_value"],
  sourceTrace: (ctx) => nasdaqOrDemo(ctx, "debt − cashneq"),
  computation: (ctx, v) => {
    const m = (ctx.metrics ?? {}) as {
      totalDebt?: number;
      cash?: number;
    };
    return {
      result: { value: v, format: "currency" },
      layout: "stacked",
      tokens: [
        { type: "value", value: m.totalDebt ?? 0, conceptKey: "total_debt", label: "Gross Debt", format: "currency" },
        { type: "operator", op: "−" },
        { type: "value", value: m.cash ?? 0, conceptKey: "cash", label: "Cash", format: "currency" },
      ],
    };
  },
};

const public_company_risk_score: Concept = {
  key: "public_company_risk_score",
  name: { en: "Public Risk Score", ro: "Scor de risc public" },
  category: "Risk & Credit",
  shortDefinition: {
    en: "A composite read of public-company risk built from Altman Z, " +
        "Piotroski F, leverage, and volatility. Higher = lower bankruptcy / " +
        "earnings-quality risk.",
    ro: "Un scor compus al riscului unei companii listate, construit din " +
        "Altman Z, Piotroski F, levier și volatilitate. Mai mare = risc mai mic.",
  },
  plainEnglish: {
    en: "A single 0-100 health number for the company. Combines the bankruptcy " +
        "risk score, earnings quality, and how much debt it carries. " +
        "Above 70 = healthy. Under 40 = needs attention.",
    ro: "Un singur scor 0-100 al sănătății firmei. Combină riscul de " +
        "faliment, calitatea profiturilor și nivelul de îndatorare. " +
        "Peste 70 = sănătos. Sub 40 = atenție.",
  },
  inlineFormula: "30% Altman Z + 25% Piotroski F + 25% Leverage + 20% Vol",
  related: ["altman_z", "piotroski_f", "net_debt_ebitda"],
  sourceTrace: (ctx) => ({
    sourceType: "calculated",
    derivedFrom:
      "Altman Z (Sharadar SF1) + Piotroski F (Sharadar SF1) + leverage and 200-day price volatility (SHARADAR/SEP).",
    confidence: 0.85,
  }),
};

export const PUBLIC_COMPANY_CONCEPTS: Concept[] = [
  market_cap,
  stock_price,
  pe_ratio,
  fcf_yield,
  net_debt,
  public_company_risk_score,
];
