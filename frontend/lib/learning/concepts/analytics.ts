// F5.0 Phase 2 — Ratios + Valuation + Risk concept pack.
//
// Covers the entire analytic surface beyond statement lines:
//   · 25+ ratios across Profitability, Liquidity, Leverage, Coverage, Efficiency
//   · Valuation envelope (EV/EBITDA, DCF, NAV, WACC build-up)
//   · Risk + Credit (Altman Z", Piotroski F, composite credit score)
//
// Mirrors the methodology in CLAUDE.md Appendix A §5–§7.

import type { Concept } from "./_schema";

// ─── Profitability ratios ─────────────────────────────────────────────────

const ebit_margin: Concept = {
  key: "ebit_margin",
  name: { en: "EBIT Margin", ro: "Marja EBIT" },
  category: "Profitability",
  shortDefinition: {
    en: "Operating profit after depreciation, as a percentage of revenue. " +
        "Captures pure operating efficiency including the cost of using fixed assets.",
    ro: "Profitul operațional după amortizare, ca procent din venituri. " +
        "Surprinde eficiența pură operațională, inclusiv costul activelor fixe.",
  },
  inlineFormula: "EBIT / Revenue",
  benchmark: { p25: 0.05, median: 0.08, p75: 0.12 },
  related: ["ebitda_margin", "net_margin", "ebit", "operating_revenue"],
  computation: (ctx, v) => {
    const m = ctx.metrics ?? {};
    return {
      result: { value: v, format: "percentage" },
      layout: "fraction",
      tokens: [
        { type: "value", value: m.ebit ?? 0, conceptKey: "ebit", label: "EBIT", format: "currency" },
        { type: "operator", op: "÷" },
        { type: "value", value: m.revenue ?? 0, conceptKey: "revenue", label: "Revenue", format: "currency" },
      ],
    };
  },
  interpretation: {
    getSentiment: (v) => (v >= 0.10 ? "positive" : v >= 0.05 ? "neutral" : v >= 0 ? "neutral" : "negative"),
    getNarrative: (v) =>
      v < 0
        ? "Operating losses — the business is not profitable at the operating level."
        : v >= 0.10
          ? "Strong operating margin — efficient operations."
          : v >= 0.05
            ? "Adequate operating margin for most SME industries."
            : "Thin operating margin — vulnerable to cost shocks.",
  },
};

const net_margin: Concept = {
  key: "net_margin",
  name: { en: "Net Margin", ro: "Marja netă" },
  category: "Profitability",
  shortDefinition: {
    en: "Bottom-line profit as a percentage of revenue. After every cost, " +
        "interest, and tax. The cleanest single read on profitability.",
    ro: "Profitul net ca procent din venituri. După toate costurile, dobânzile " +
        "și impozitul. Cea mai curată citire a profitabilității.",
  },
  inlineFormula: "Net Profit / Revenue",
  benchmark: { p25: 0.03, median: 0.05, p75: 0.08 },
  related: ["net_profit", "ebit_margin", "ebitda_margin"],
  interpretation: {
    getSentiment: (v) => (v >= 0.07 ? "positive" : v >= 0.03 ? "neutral" : "negative"),
    getNarrative: (v) =>
      v < 0
        ? "Net loss — the business is unprofitable after all costs."
        : v >= 0.07
          ? "Healthy net margin for an SME."
          : v >= 0.03
            ? "Acceptable but slim net margin — leverage or cost pressure could erode it quickly."
            : "Near-zero margin — a small cost shock would push the business into losses.",
  },
  computation: (ctx, v) => {
    const m = ctx.metrics ?? {};
    return {
      result: { value: v, format: "percentage" },
      layout: "fraction",
      tokens: [
        { type: "value", value: m.netProfit ?? 0, conceptKey: "net_profit", label: "Net Profit", format: "currency" },
        { type: "operator", op: "÷" },
        { type: "value", value: m.revenue ?? 0, conceptKey: "revenue", label: "Revenue", format: "currency" },
      ],
    };
  },
};

const roe: Concept = {
  key: "roe",
  name: { en: "Return on Equity", ro: "Rentabilitatea capitalului propriu" },
  category: "Profitability",
  shortDefinition: {
    en: "Net profit divided by average shareholder equity. Tells you how much " +
        "profit the equity base is generating per RON invested.",
    ro: "Profitul net împărțit la capitalul propriu mediu. Arată cât profit " +
        "generează baza de capital propriu pentru fiecare RON investit.",
  },
  inlineFormula: "Net Profit / Avg Equity",
  plainEnglish: {
    en: "For every RON the shareholders have left in the business, how many " +
        "lei it earned for them this year. Bigger = capital is working harder.",
    ro: "Pentru fiecare RON pe care acționarii l-au lăsat în firmă, cât a câștigat " +
        "anul acesta. Mai mare = capitalul lucrează mai bine.",
  },
  benchmark: { p25: 0.08, median: 0.15, p75: 0.20 },
  related: ["roa", "roic", "shareholders_equity", "net_profit"],
  computation: (ctx, v) => {
    const m = ctx.metrics ?? {};
    return {
      result: { value: v, format: "percentage" },
      layout: "fraction",
      tokens: [
        { type: "value", value: m.netProfit ?? 0, conceptKey: "net_profit", label: "Net Profit", format: "currency" },
        { type: "operator", op: "÷" },
        { type: "value", value: m.shareholdersEquity ?? 0, conceptKey: "shareholders_equity", label: "Equity", format: "currency" },
      ],
    };
  },
  interpretation: {
    getSentiment: (v) => (v >= 0.15 ? "positive" : v >= 0.08 ? "neutral" : "negative"),
    getNarrative: (v) =>
      v < 0
        ? "Negative ROE — losses are eroding shareholder equity."
        : v >= 0.15
          ? "Strong ROE — capital is working hard."
          : v >= 0.08
            ? "Adequate ROE for industrial businesses."
            : "Low ROE — capital is not generating sufficient returns; consider whether the asset base is over-sized.",
  },
};

const roa: Concept = {
  key: "roa",
  name: { en: "Return on Assets", ro: "Rentabilitatea activelor" },
  category: "Profitability",
  shortDefinition: {
    en: "Net profit divided by average total assets. Tells you how efficiently " +
        "the asset base is generating earnings, regardless of how it's financed.",
    ro: "Profitul net împărțit la totalul activelor medii. Arată cât de eficient " +
        "baza de active generează profit, indiferent de finanțare.",
  },
  inlineFormula: "Net Profit / Avg Total Assets",
  plainEnglish: {
    en: "For every RON of stuff the business owns, how much profit it generated. " +
        "Doesn't care if it's funded by debt or equity — just asset efficiency.",
    ro: "Pentru fiecare RON de active deținute, cât profit a generat. Nu " +
        "contează cum sunt finanțate — doar eficiența activelor.",
  },
  benchmark: { p25: 0.04, median: 0.07, p75: 0.10 },
  related: ["roe", "roic", "total_assets", "net_profit"],
  computation: (ctx, v) => {
    const m = ctx.metrics ?? {};
    return {
      result: { value: v, format: "percentage" },
      layout: "fraction",
      tokens: [
        { type: "value", value: m.netProfit ?? 0, conceptKey: "net_profit", label: "Net Profit", format: "currency" },
        { type: "operator", op: "÷" },
        { type: "value", value: m.totalAssets ?? 0, conceptKey: "total_assets", label: "Total Assets", format: "currency" },
      ],
    };
  },
};

const roic: Concept = {
  key: "roic",
  name: { en: "Return on Invested Capital", ro: "Rentabilitatea capitalului investit" },
  category: "Profitability",
  shortDefinition: {
    en: "NOPAT divided by invested capital (equity + debt). The cleanest read " +
        "on whether the business is creating value above its cost of capital (WACC).",
    ro: "NOPAT împărțit la capitalul investit (capital propriu + datorii). Cea " +
        "mai bună măsură dacă afacerea creează valoare peste costul capitalului (WACC).",
  },
  inlineFormula: "EBIT × (1 − tax) / (Equity + Debt)",
  plainEnglish: {
    en: "What return the business earns on all the money tied up in it — " +
        "both equity and debt. If this beats the cost of borrowing, the " +
        "business is creating value.",
    ro: "Ce randament aduce afacerea pe toți banii investiți — capital și " +
        "datorii. Dacă depășește costul împrumuturilor, firma creează valoare.",
  },
  benchmark: { p25: 0.08, median: 0.12, p75: 0.18 },
  related: ["roe", "roa", "wacc"],
  interpretation: {
    getSentiment: (v) => (v >= 0.12 ? "positive" : v >= 0.08 ? "neutral" : "negative"),
    getNarrative: (v) =>
      v >= 0.12
        ? "Strong ROIC — the business is creating economic value."
        : v >= 0.08
          ? "Adequate ROIC — at or near typical cost of capital."
          : "ROIC below typical WACC — the business may be destroying economic value.",
  },
};

// ─── Liquidity ratios ─────────────────────────────────────────────────────

const current_ratio: Concept = {
  key: "current_ratio",
  name: { en: "Current Ratio", ro: "Lichiditatea curentă" },
  category: "Liquidity",
  shortDefinition: {
    en: "Current assets divided by current liabilities. Above 1.5× means " +
        "comfortable short-term solvency; below 1.0× is a warning sign.",
    ro: "Active circulante împărțite la datorii curente. Peste 1,5× = lichiditate " +
        "comodă; sub 1,0× = semnal de alarmă.",
  },
  inlineFormula: "Current Assets / Current Liabilities",
  plainEnglish: {
    en: "Can the business pay this year's bills with this year's assets? " +
        "Above 1.5× = comfortable. Under 1.0× = trouble.",
    ro: "Poate firma plăti facturile din acest an cu activele din acest an? " +
        "Peste 1,5× = e bine. Sub 1,0× = atenție.",
  },
  benchmark: { p25: 1.2, median: 1.5, p75: 2.0 },
  related: ["quick_ratio", "cash_ratio", "working_capital"],
  computation: (ctx, v) => {
    const m = ctx.metrics ?? {};
    return {
      result: { value: v, format: "ratio" },
      layout: "fraction",
      tokens: [
        { type: "value", value: m.currentAssets ?? 0, conceptKey: "current_assets", label: "Current Assets", format: "currency" },
        { type: "operator", op: "÷" },
        { type: "value", value: m.currentLiabilities ?? 0, conceptKey: "current_liabilities", label: "Current Liab", format: "currency" },
      ],
    };
  },
  interpretation: {
    getSentiment: (v) => (v >= 1.5 ? "positive" : v >= 1.0 ? "neutral" : "negative"),
    getNarrative: (v) =>
      v >= 1.5
        ? "Comfortable short-term liquidity."
        : v >= 1.0
          ? "Just covers short-term obligations — close watch needed."
          : "Below 1.0× — short-term liabilities exceed liquid assets. Liquidity risk.",
  },
};

const quick_ratio: Concept = {
  key: "quick_ratio",
  name: { en: "Quick Ratio", ro: "Lichiditatea rapidă" },
  category: "Liquidity",
  shortDefinition: {
    en: "Current assets minus inventory, divided by current liabilities. " +
        "Tests whether the business can meet short-term obligations without " +
        "having to sell inventory.",
    ro: "Active circulante minus stocuri, împărțite la datorii curente. Testează " +
        "dacă afacerea își poate acoperi datoriile curente fără să vândă stocul.",
  },
  inlineFormula: "(CA − Inventory) / CL",
  benchmark: { p25: 0.7, median: 1.0, p75: 1.3 },
  related: ["current_ratio", "cash_ratio", "inventory"],
  computation: (ctx, v) => {
    const m = ctx.metrics ?? {};
    const quickAssets = (m.currentAssets ?? 0) - (m.inventory ?? 0);
    return {
      result: { value: v, format: "ratio" },
      layout: "fraction",
      tokens: [
        { type: "group_open" },
        { type: "value", value: m.currentAssets ?? 0, conceptKey: "current_assets", label: "CA", format: "currency" },
        { type: "operator", op: "−" },
        { type: "value", value: m.inventory ?? 0, conceptKey: "inventory", label: "Inventory", format: "currency" },
        { type: "group_close" },
        { type: "operator", op: "÷" },
        { type: "value", value: m.currentLiabilities ?? 0, conceptKey: "current_liabilities", label: "CL", format: "currency" },
      ],
      // suppress unused
      ...(quickAssets >= 0 ? {} : {}),
    };
  },
};

const cash_ratio: Concept = {
  key: "cash_ratio",
  name: { en: "Cash Ratio", ro: "Lichiditatea imediată" },
  category: "Liquidity",
  shortDefinition: {
    en: "Cash divided by current liabilities. The most conservative liquidity " +
        "test — how much of short-term debts could be paid off today.",
    ro: "Cash împărțit la datorii curente. Cel mai conservator test de " +
        "lichiditate — câtă datorie curentă poate fi plătită imediat.",
  },
  inlineFormula: "Cash / Current Liabilities",
  benchmark: { p25: 0.10, median: 0.20, p75: 0.35 },
  related: ["cash", "current_ratio", "quick_ratio"],
  computation: (ctx, v) => {
    const m = ctx.metrics ?? {};
    return {
      result: { value: v, format: "ratio" },
      layout: "fraction",
      tokens: [
        { type: "value", value: m.cash ?? 0, conceptKey: "cash", label: "Cash", format: "currency" },
        { type: "operator", op: "÷" },
        { type: "value", value: m.currentLiabilities ?? 0, conceptKey: "current_liabilities", label: "Current Liab", format: "currency" },
      ],
    };
  },
  interpretation: {
    getSentiment: (v) => (v >= 0.20 ? "positive" : v >= 0.10 ? "neutral" : "negative"),
    getNarrative: (v) =>
      v >= 0.20
        ? "Comfortable cash buffer."
        : v >= 0.10
          ? "Adequate cash position — monitor."
          : "Tight cash position — vulnerable to revenue disruption or supplier squeeze.",
  },
};

const working_capital: Concept = {
  key: "working_capital",
  name: { en: "Working Capital", ro: "Capital de lucru" },
  category: "Working Capital",
  shortDefinition: {
    en: "Current assets minus current liabilities. Positive working capital " +
        "means the business has a short-term financial cushion; negative is " +
        "a warning unless the business model justifies it (e.g. retail).",
    ro: "Active circulante minus datorii curente. Pozitiv = pernă financiară " +
        "pe termen scurt; negativ = atenție, cu excepția modelelor specifice (ex. retail).",
  },
  plainEnglish: {
    en: "The cash cushion for the next 12 months: what you can turn into " +
        "cash soon, minus what you have to pay soon.",
    ro: "Perna de cash pentru următoarele 12 luni: ce poți încasa curând " +
        "minus ce trebuie să plătești curând.",
  },
  inlineFormula: "CA − CL",
  related: ["current_ratio", "current_assets", "current_liabilities"],
  computation: (ctx, v) => {
    const m = ctx.metrics ?? {};
    return {
      result: { value: v, format: "currency" },
      layout: "stacked",
      tokens: [
        { type: "value", value: m.currentAssets ?? 0, conceptKey: "current_assets", label: "Current Assets", format: "currency" },
        { type: "operator", op: "−" },
        { type: "value", value: m.currentLiabilities ?? 0, conceptKey: "current_liabilities", label: "Current Liabilities", format: "currency" },
      ],
    };
  },
};

// ─── Leverage / Solvency ratios ───────────────────────────────────────────

const equity_ratio: Concept = {
  key: "equity_ratio",
  name: { en: "Equity Ratio", ro: "Rata capitalului propriu" },
  category: "Leverage & Solvency",
  shortDefinition: {
    en: "Shareholder equity as a percentage of total assets. Above 30% means " +
        "the business is comfortably equity-funded; below 15% is highly leveraged.",
    ro: "Capital propriu ca procent din total active. Peste 30% = bine capitalizat; " +
        "sub 15% = îndatorat semnificativ.",
  },
  inlineFormula: "Equity / Total Assets",
  benchmark: { p25: 0.25, median: 0.40, p75: 0.55 },
  related: ["debt_to_equity", "debt_to_assets", "total_assets", "shareholders_equity"],
  computation: (ctx, v) => {
    const m = ctx.metrics ?? {};
    return {
      result: { value: v, format: "percentage" },
      layout: "fraction",
      tokens: [
        { type: "value", value: m.shareholdersEquity ?? 0, conceptKey: "shareholders_equity", label: "Equity", format: "currency" },
        { type: "operator", op: "÷" },
        { type: "value", value: m.totalAssets ?? 0, conceptKey: "total_assets", label: "Total Assets", format: "currency" },
      ],
    };
  },
  interpretation: {
    getSentiment: (v) => (v >= 0.40 ? "positive" : v >= 0.20 ? "neutral" : "negative"),
    getNarrative: (v) =>
      v >= 0.40
        ? "Strong equity cushion — well-capitalized."
        : v >= 0.20
          ? "Moderate leverage — typical for working-capital-heavy SMEs."
          : "Thin equity — most assets are debt-funded. Solvency risk on a downturn.",
  },
};

const debt_to_equity: Concept = {
  key: "debt_to_equity",
  name: { en: "Debt / Equity", ro: "Datorii / Capital propriu" },
  category: "Leverage & Solvency",
  shortDefinition: {
    en: "Total debt divided by shareholder equity. Higher = more leverage, " +
        "more risk in a downturn, but also higher return on equity if the " +
        "business is profitable.",
    ro: "Datorii totale împărțite la capitalul propriu. Mai mare = mai îndatorat, " +
        "mai mult risc la criză, dar și ROE potențial mai mare dacă afacerea " +
        "e profitabilă.",
  },
  inlineFormula: "Total Debt / Equity",
  plainEnglish: {
    en: "For every RON the shareholders put in, how many RON the business " +
        "borrowed from banks. Bigger = riskier in bad times.",
    ro: "Pentru fiecare RON al acționarilor, câți RON a împrumutat firma " +
        "de la bănci. Mai mare = mai riscant la criză.",
  },
  benchmark: { p25: 0.3, median: 0.6, p75: 1.2 },
  related: ["equity_ratio", "lt_debt_to_equity", "net_debt_ebitda"],
  computation: (ctx, v) => {
    const m = ctx.metrics ?? {};
    return {
      result: { value: v, format: "ratio" },
      layout: "fraction",
      tokens: [
        { type: "value", value: m.totalDebt ?? 0, conceptKey: "total_debt", label: "Total Debt", format: "currency" },
        { type: "operator", op: "÷" },
        { type: "value", value: m.shareholdersEquity ?? 0, conceptKey: "shareholders_equity", label: "Equity", format: "currency" },
      ],
    };
  },
};

const lt_debt_to_equity: Concept = {
  key: "lt_debt_to_equity",
  name: { en: "LT Debt / Equity", ro: "Datorii pe termen lung / Capital propriu" },
  category: "Leverage & Solvency",
  shortDefinition: {
    en: "Long-term debt divided by equity. Isolates structural leverage from " +
        "working-capital financing.",
    ro: "Datorii pe termen lung împărțite la capital propriu. Izolează " +
        "îndatorarea structurală de finanțarea capitalului de lucru.",
  },
  inlineFormula: "LT Debt / Equity",
  benchmark: { p25: 0.2, median: 0.4, p75: 0.7 },
  related: ["debt_to_equity", "long_term_debt", "shareholders_equity"],
};

const net_debt_ebitda: Concept = {
  key: "net_debt_ebitda",
  name: { en: "Net Debt / EBITDA", ro: "Datorie netă / EBITDA" },
  category: "Leverage & Solvency",
  shortDefinition: {
    en: "Net debt (debt minus cash) divided by EBITDA. The single most " +
        "important leverage metric for credit assessment. Below 2× = comfortable; " +
        "above 4× = stressed.",
    ro: "Datorie netă (datorii minus cash) împărțită la EBITDA. Cel mai important " +
        "indicator de îndatorare pentru evaluarea creditului. Sub 2× = comod; " +
        "peste 4× = stresat.",
  },
  inlineFormula: "(Total Debt − Cash) / EBITDA",
  plainEnglish: {
    en: "How many years of operating earnings it would take to pay off the " +
        "debt. Under 2× = banks are happy. Over 4× = banks worry.",
    ro: "Câți ani de profit operațional ar trebui să stingă datoria. Sub 2× = " +
        "băncile sunt liniștite. Peste 4× = băncile încep să se îngrijoreze.",
  },
  benchmark: { p25: 1.0, median: 2.0, p75: 3.0 },
  related: ["debt_to_equity", "ebitda", "total_debt", "cash", "interest_coverage"],
  computation: (ctx, v) => {
    const m = ctx.metrics ?? {};
    return {
      result: { value: v, format: "ratio" },
      layout: "fraction",
      tokens: [
        { type: "group_open" },
        { type: "value", value: m.totalDebt ?? 0, conceptKey: "total_debt", label: "Total Debt", format: "currency" },
        { type: "operator", op: "−" },
        { type: "value", value: m.cash ?? 0, conceptKey: "cash", label: "Cash", format: "currency" },
        { type: "group_close" },
        { type: "operator", op: "÷" },
        { type: "value", value: m.ebitda ?? 0, conceptKey: "ebitda", label: "EBITDA", format: "currency" },
      ],
    };
  },
  interpretation: {
    getSentiment: (v) => (v <= 2 ? "positive" : v <= 3.5 ? "neutral" : "negative"),
    getNarrative: (v) =>
      v <= 0
        ? "Net cash position — no leverage stress."
        : v <= 2
          ? "Comfortable leverage."
          : v <= 3.5
            ? "Moderate leverage — covenant attention required."
            : "Elevated leverage — covenant breach risk; refinancing depends on EBITDA stability.",
  },
};

const debt_to_assets: Concept = {
  key: "debt_to_assets",
  name: { en: "Debt / Assets", ro: "Datorii / Active" },
  category: "Leverage & Solvency",
  shortDefinition: {
    en: "Total debt as a percentage of total assets. Tells you how much of " +
        "the asset base is funded by debt vs. equity.",
    ro: "Datorii totale ca procent din total active. Arată cât din baza de " +
        "active este finanțată prin datorii vs. capital propriu.",
  },
  inlineFormula: "Total Debt / Total Assets",
  benchmark: { p25: 0.20, median: 0.35, p75: 0.50 },
  related: ["equity_ratio", "debt_to_equity"],
};

// ─── Coverage ratios ──────────────────────────────────────────────────────

const interest_coverage: Concept = {
  key: "interest_coverage",
  name: { en: "Interest Coverage", ro: "Acoperirea dobânzii" },
  category: "Coverage",
  shortDefinition: {
    en: "EBIT divided by interest expense. Tells you how many times operating " +
        "earnings could cover interest payments. Above 4× = safe; below 2× = stressed.",
    ro: "EBIT împărțit la cheltuielile cu dobânzile. Arată de câte ori EBIT " +
        "acoperă plățile de dobândă. Peste 4× = sigur; sub 2× = stresat.",
  },
  inlineFormula: "EBIT / Interest Expense",
  plainEnglish: {
    en: "How many times the operating earnings could pay the interest bill. " +
        "Above 4× = comfortable. Below 2× = the bank is nervous.",
    ro: "De câte ori profitul operațional acoperă dobânda. Peste 4× = e bine. " +
        "Sub 2× = banca începe să se îngrijoreze.",
  },
  benchmark: { p25: 3.0, median: 5.0, p75: 10.0 },
  related: ["ebitda_to_interest", "dscr", "interest_expense", "ebit"],
  computation: (ctx, v) => {
    const m = ctx.metrics ?? {};
    return {
      result: { value: v, format: "ratio" },
      layout: "fraction",
      tokens: [
        { type: "value", value: m.ebit ?? 0, conceptKey: "ebit", label: "EBIT", format: "currency" },
        { type: "operator", op: "÷" },
        { type: "value", value: m.interestExpense ?? 0, conceptKey: "interest_expense", label: "Interest", format: "currency" },
      ],
    };
  },
  interpretation: {
    getSentiment: (v) => (v >= 4 ? "positive" : v >= 2 ? "neutral" : "negative"),
    getNarrative: (v) =>
      v >= 4
        ? "Safe coverage — interest is well-covered by operating earnings."
        : v >= 2
          ? "Adequate but not comfortable — earnings volatility could squeeze coverage."
          : "Tight coverage — high risk of breaching covenants on a small EBIT drop.",
  },
};

const ebitda_to_interest: Concept = {
  key: "ebitda_to_interest",
  name: { en: "EBITDA / Interest", ro: "EBITDA / Dobândă" },
  category: "Coverage",
  shortDefinition: {
    en: "EBITDA divided by interest expense — a cash-based coverage measure " +
        "since D&A is non-cash. More generous than EBIT-based coverage.",
    ro: "EBITDA împărțit la dobândă — o măsură de acoperire bazată pe cash, " +
        "deoarece amortizarea nu e cash. Mai generoasă decât acoperirea EBIT.",
  },
  inlineFormula: "EBITDA / Interest Expense",
  benchmark: { p25: 4.0, median: 7.0, p75: 12.0 },
  related: ["interest_coverage", "dscr", "ebitda"],
};

const dscr: Concept = {
  key: "dscr",
  name: { en: "DSCR", ro: "DSCR (rata de acoperire)" },
  category: "Coverage",
  shortDefinition: {
    en: "Debt Service Coverage Ratio — EBITDA divided by interest plus current " +
        "portion of long-term debt. The bank covenant metric par excellence; " +
        "above 1.25× is typically required.",
    ro: "Debt Service Coverage Ratio — EBITDA împărțit la dobândă plus partea " +
        "curentă a datoriilor pe termen lung. Indicatorul cheie pentru covenants " +
        "bancare; peste 1,25× este de regulă necesar.",
  },
  inlineFormula: "EBITDA / (Interest + ST Debt Service)",
  benchmark: { p25: 1.25, median: 1.8, p75: 2.5 },
  related: ["interest_coverage", "ebitda_to_interest", "long_term_debt"],
  interpretation: {
    getSentiment: (v) => (v >= 1.5 ? "positive" : v >= 1.25 ? "neutral" : "negative"),
    getNarrative: (v) =>
      v >= 1.5
        ? "Strong DSCR — typically clears all bank covenants."
        : v >= 1.25
          ? "Just covers — covenant alert: small EBITDA dip puts you below 1.25×."
          : "Below 1.25× — typical covenant breach territory. Lender engagement needed.",
  },
};

// ─── Efficiency ratios ────────────────────────────────────────────────────

const asset_turnover: Concept = {
  key: "asset_turnover",
  name: { en: "Asset Turnover", ro: "Rotația activelor" },
  category: "Working Capital",
  shortDefinition: {
    en: "Revenue divided by average total assets. Measures how efficiently the " +
        "asset base generates sales. Higher = more efficient.",
    ro: "Venituri împărțite la totalul activelor medii. Măsoară cât de eficient " +
        "baza de active generează vânzări. Mai mare = mai eficient.",
  },
  inlineFormula: "Revenue / Avg Total Assets",
  benchmark: { p25: 0.8, median: 1.2, p75: 1.8 },
  related: ["inventory_turnover", "total_assets", "operating_revenue"],
  computation: (ctx, v) => {
    const m = ctx.metrics ?? {};
    return {
      result: { value: v, format: "ratio" },
      layout: "fraction",
      tokens: [
        { type: "value", value: m.revenue ?? 0, conceptKey: "revenue", label: "Revenue", format: "currency" },
        { type: "operator", op: "÷" },
        { type: "value", value: m.totalAssets ?? 0, conceptKey: "total_assets", label: "Total Assets", format: "currency" },
      ],
    };
  },
};

const inventory_turnover: Concept = {
  key: "inventory_turnover",
  name: { en: "Inventory Turnover", ro: "Rotația stocurilor" },
  category: "Working Capital",
  shortDefinition: {
    en: "Cost of goods sold divided by average inventory. How many times per " +
        "year inventory is sold and replaced. Higher = leaner inventory management.",
    ro: "Costul bunurilor vândute împărțit la stocul mediu. De câte ori pe an " +
        "se vinde și se înlocuiește stocul. Mai mare = stoc gestionat mai eficient.",
  },
  inlineFormula: "COGS / Avg Inventory",
  benchmark: { p25: 4.0, median: 7.0, p75: 12.0 },
  related: ["dio_days", "inventory", "cogs"],
};

const dio_days: Concept = {
  key: "dio_days",
  name: { en: "Days Inventory Outstanding", ro: "Zile stoc" },
  category: "Working Capital",
  shortDefinition: {
    en: "How many days of cost of goods sold the inventory represents. Lower " +
        "= leaner inventory; higher = more cash tied up in stock.",
    ro: "Câte zile de cost al bunurilor vândute reprezintă stocul. Mai mic = " +
        "stoc mai redus; mai mare = mai mult cash blocat.",
  },
  inlineFormula: "Inventory / COGS × 365",
  plainEnglish: {
    en: "How many days of sales the warehouse can supply from current stock. " +
        "55 days = stock turns about 6× a year. Lower = leaner.",
    ro: "Câte zile de vânzări poate susține depozitul din stocul actual. " +
        "55 zile = stocul se rotește de ~6 ori pe an. Mai mic = mai eficient.",
  },
  benchmark: { p25: 30, median: 55, p75: 90 },
  related: ["inventory_turnover", "ccc_days", "dso_days", "dpo_days"],
  computation: (ctx, v) => {
    const m = ctx.metrics ?? {};
    return {
      result: { value: v, format: "days" },
      layout: "inline",
      tokens: [
        { type: "value", value: m.inventory ?? 0, conceptKey: "inventory", label: "Inventory", format: "currency" },
        { type: "operator", op: "÷" },
        { type: "value", value: m.cogs ?? 0, conceptKey: "cogs", label: "COGS", format: "currency" },
        { type: "operator", op: "×" },
        { type: "literal", text: "365" },
      ],
    };
  },
};

const dso_days: Concept = {
  key: "dso_days",
  name: { en: "Days Sales Outstanding", ro: "Zile creanțe" },
  category: "Working Capital",
  shortDefinition: {
    en: "Average number of days customers take to pay. Lower = faster cash " +
        "collection; higher = more cash trapped in receivables.",
    ro: "Numărul mediu de zile în care clienții plătesc. Mai mic = încasare " +
        "mai rapidă; mai mare = mai mult cash blocat în creanțe.",
  },
  inlineFormula: "Receivables / Revenue × 365",
  plainEnglish: {
    en: "On average, how many days customers take to pay their invoice. " +
        "45 days = the typical SME wait. 90+ days = a problem.",
    ro: "În medie, în câte zile clienții plătesc factura. 45 zile = standard. " +
        "Peste 90 zile = problemă.",
  },
  benchmark: { p25: 30, median: 45, p75: 65 },
  related: ["receivables", "ccc_days", "dio_days"],
  computation: (ctx, v) => {
    const m = ctx.metrics ?? {};
    return {
      result: { value: v, format: "days" },
      layout: "inline",
      tokens: [
        { type: "value", value: m.receivables ?? 0, conceptKey: "receivables", label: "Receivables", format: "currency" },
        { type: "operator", op: "÷" },
        { type: "value", value: m.revenue ?? 0, conceptKey: "revenue", label: "Revenue", format: "currency" },
        { type: "operator", op: "×" },
        { type: "literal", text: "365" },
      ],
    };
  },
  interpretation: {
    getSentiment: (v) => (v <= 45 ? "positive" : v <= 65 ? "neutral" : "negative"),
    getNarrative: (v) =>
      v <= 45
        ? "Healthy collection — customers pay promptly."
        : v <= 65
          ? "Adequate collection — typical for B2B sales."
          : "Slow collection — cash is trapped in receivables. Tighten credit terms or invoice discounting.",
  },
};

const dpo_days: Concept = {
  key: "dpo_days",
  name: { en: "Days Payable Outstanding", ro: "Zile datorii furnizori" },
  category: "Working Capital",
  shortDefinition: {
    en: "Average number of days the company takes to pay suppliers. Higher = " +
        "longer-stretching free working-capital financing from suppliers.",
    ro: "Numărul mediu de zile în care compania plătește furnizorii. Mai mare = " +
        "finanțare gratuită mai lungă de la furnizori.",
  },
  inlineFormula: "Payables / COGS × 365",
  plainEnglish: {
    en: "On average, how many days the business takes to pay its suppliers. " +
        "Higher = free short-term financing — but suppliers eventually push back.",
    ro: "În medie, în câte zile firma își plătește furnizorii. Mai mare = " +
        "finanțare gratuită — dar furnizorii își pierd răbdarea în final.",
  },
  benchmark: { p25: 30, median: 50, p75: 75 },
  related: ["accounts_payable", "ccc_days", "dso_days"],
  computation: (ctx, v) => {
    const m = ctx.metrics ?? {};
    return {
      result: { value: v, format: "days" },
      layout: "inline",
      tokens: [
        { type: "value", value: m.accountsPayable ?? 0, conceptKey: "accounts_payable", label: "Payables", format: "currency" },
        { type: "operator", op: "÷" },
        { type: "value", value: m.cogs ?? 0, conceptKey: "cogs", label: "COGS", format: "currency" },
        { type: "operator", op: "×" },
        { type: "literal", text: "365" },
      ],
    };
  },
};

const ccc_days: Concept = {
  key: "ccc_days",
  name: { en: "Cash Conversion Cycle", ro: "Ciclul de conversie a cash-ului" },
  category: "Working Capital",
  shortDefinition: {
    en: "DIO + DSO − DPO. The number of days between paying suppliers and " +
        "collecting from customers — the working-capital funding requirement, " +
        "in days. Lower (or negative) is better.",
    ro: "DIO + DSO − DPO. Numărul de zile între plata furnizorilor și încasarea " +
        "de la clienți — nevoia de finanțare a capitalului de lucru în zile. " +
        "Mai mic (sau negativ) este mai bun.",
  },
  inlineFormula: "DIO + DSO − DPO",
  plainEnglish: {
    en: "How long the business's cash is locked up in one full operating " +
        "loop — buy stock, sell it, collect from the customer, pay the supplier. " +
        "Shorter = less working capital needed.",
    ro: "Cât timp e blocat cash-ul într-un ciclu complet — cumperi stoc, " +
        "vinzi, încasezi de la client, plătești furnizorul. Mai scurt = mai " +
        "puțin capital de lucru.",
  },
  benchmark: { p25: 30, median: 60, p75: 100 },
  related: ["dio_days", "dso_days", "dpo_days", "working_capital_changes"],
  interpretation: {
    getSentiment: (v) => (v <= 60 ? "positive" : v <= 100 ? "neutral" : "negative"),
    getNarrative: (v) =>
      v <= 0
        ? "Negative cash conversion cycle — customers pay before suppliers do (rare and excellent)."
        : v <= 60
          ? "Tight cash conversion — working capital is well-managed."
          : v <= 100
            ? "Moderate cash conversion — typical for mid-size SMEs."
            : "Long cash conversion — heavy working-capital financing need.",
  },
};

// ─── Valuation concepts ──────────────────────────────────────────────────

const enterprise_value: Concept = {
  key: "enterprise_value",
  name: { en: "Enterprise Value", ro: "Valoarea întreprinderii" },
  category: "Valuation",
  shortDefinition: {
    en: "Total value of the business including debt and excluding cash. The " +
        "price you'd pay to take over the whole enterprise — equity + net debt.",
    ro: "Valoarea totală a afacerii incluzând datoria și excluzând cash-ul. Prețul " +
        "pe care l-ai plăti pentru a prelua întreaga afacere — capital + datorie netă.",
  },
  plainEnglish: {
    en: "The total price of the business — what you'd pay shareholders AND " +
        "the banks combined to own everything debt-free.",
    ro: "Prețul total al afacerii — ce ai plăti acționarilor ȘI băncilor " +
        "împreună pentru a deține totul fără datorii.",
  },
  inlineFormula: "Core EBITDA × Multiple",
  related: ["equity_value", "ev_ebitda_multiple", "total_debt", "ebitda"],
  computation: (ctx, v) => {
    const m = ctx.metrics ?? {};
    const ebitda = m.ebitda ?? 0;
    const mult = m.evEbitdaMultiple ?? (ebitda ? v / ebitda : 0);
    return {
      result: { value: v, format: "currency" },
      layout: "stacked",
      tokens: [
        { type: "value", value: ebitda, conceptKey: "ebitda", label: "Core EBITDA", format: "currency" },
        { type: "operator", op: "×" },
        { type: "value", value: mult, conceptKey: "ev_ebitda_multiple", label: "Multiple", format: "ratio" },
      ],
    };
  },
};

const equity_value: Concept = {
  key: "equity_value",
  name: { en: "Equity Value", ro: "Valoarea capitalului propriu" },
  category: "Valuation",
  shortDefinition: {
    en: "Value of the business attributable to shareholders, after debt is " +
        "paid off and cash is added back. Enterprise Value − Gross Debt + Cash.",
    ro: "Valoarea afacerii ce revine acționarilor după plata datoriilor și " +
        "adăugarea cash-ului. Valoarea întreprinderii − Datoria brută + Cash.",
  },
  plainEnglish: {
    en: "What the shareholders walk away with after the buyer pays off the " +
        "bank — but you get to keep any cash already in the company.",
    ro: "Ce primesc acționarii după ce cumpărătorul stinge datoria la bancă — " +
        "dar cash-ul rămas în firmă tot la ei merge.",
  },
  inlineFormula: "EV − Gross Debt + Cash",
  related: ["enterprise_value", "total_debt", "cash"],
  computation: (ctx, v) => {
    const m = ctx.metrics ?? {};
    const ev = m.enterpriseValue ?? 0;
    const grossDebt = m.totalDebt ?? 0;
    const cash = m.cash ?? 0;
    return {
      result: { value: v, format: "currency" },
      layout: "stacked",
      tokens: [
        { type: "value", value: ev, conceptKey: "enterprise_value", label: "Enterprise Value", format: "currency" },
        { type: "operator", op: "−" },
        { type: "value", value: grossDebt, conceptKey: "total_debt", label: "Gross Debt", format: "currency" },
        { type: "operator", op: "+" },
        { type: "value", value: cash, conceptKey: "cash", label: "Cash", format: "currency" },
      ],
    };
  },
};

const ev_ebitda_multiple: Concept = {
  key: "ev_ebitda_multiple",
  name: { en: "EV / EBITDA Multiple", ro: "Multiplu EV/EBITDA" },
  category: "Valuation",
  shortDefinition: {
    en: "Enterprise Value divided by EBITDA. The most common multiple for " +
        "private-company valuation. RO SME range typically 5–10×.",
    ro: "Valoarea întreprinderii împărțită la EBITDA. Cel mai utilizat multiplu " +
        "pentru evaluarea companiilor private. Pentru IMM-uri din RO, intervalul " +
        "tipic este 5–10×.",
  },
  plainEnglish: {
    en: "How many years of operating earnings the buyer pays for the whole " +
        "business. Bigger multiple = market thinks the company is worth more.",
    ro: "Câți ani de profit operațional plătește cumpărătorul pentru întreaga " +
        "afacere. Multiplu mai mare = piața crede că firma valorează mai mult.",
  },
  inlineFormula: "EV / EBITDA",
  benchmark: { p25: 5.0, median: 7.0, p75: 10.0 },
  related: ["enterprise_value", "ebitda", "dcf_value"],
  computation: (ctx, v) => {
    const m = ctx.metrics ?? {};
    return {
      result: { value: v, format: "ratio" },
      layout: "fraction",
      tokens: [
        { type: "value", value: m.enterpriseValue ?? 0, conceptKey: "enterprise_value", label: "EV", format: "currency" },
        { type: "operator", op: "÷" },
        { type: "value", value: m.ebitda ?? 0, conceptKey: "ebitda", label: "EBITDA", format: "currency" },
      ],
    };
  },
};

const dcf_value: Concept = {
  key: "dcf_value",
  name: { en: "DCF Valuation", ro: "Valoare DCF" },
  category: "Valuation",
  shortDefinition: {
    en: "Discounted Cash Flow value — sum of forecast free cash flows " +
        "discounted at WACC, plus a terminal value. Theoretically the cleanest " +
        "valuation but very sensitive to assumptions.",
    ro: "Valoarea fluxurilor de numerar actualizate — suma fluxurilor previzionate " +
        "actualizate la WACC, plus o valoare terminală. Teoretic cea mai curată " +
        "evaluare, dar foarte sensibilă la presupuneri.",
  },
  inlineFormula: "Σ FCF / (1+WACC)^t + Terminal / (1+WACC)^5",
  related: ["enterprise_value", "wacc", "free_cash_flow", "terminal_value"],
};

const nav_value: Concept = {
  key: "nav_value",
  name: { en: "Net Asset Value", ro: "Valoarea activului net" },
  category: "Valuation",
  shortDefinition: {
    en: "Sum of asset values (often property at market) minus liabilities. The " +
        "right valuation lens for asset-heavy businesses (real estate, holdings).",
    ro: "Suma valorilor activelor (deseori imobile la valoarea de piață) minus " +
        "datorii. Lentila de evaluare potrivită pentru afaceri cu mult activ " +
        "(imobiliar, holding).",
  },
  related: ["enterprise_value", "shareholders_equity", "book_equity_value"],
};

const book_equity_value: Concept = {
  key: "book_equity_value",
  name: { en: "Book Equity", ro: "Capital propriu contabil" },
  category: "Valuation",
  shortDefinition: {
    en: "Equity value from the balance sheet — share capital + reserves + " +
        "retained earnings. The historical-cost floor under any valuation.",
    ro: "Valoarea capitalului propriu din bilanț — capital social + rezerve + " +
        "profit reportat. Pragul de la valoarea istorică sub orice evaluare.",
  },
  related: ["shareholders_equity", "equity_value"],
};

const wacc: Concept = {
  key: "wacc",
  name: { en: "WACC", ro: "WACC (cost mediu ponderat al capitalului)" },
  category: "Valuation",
  shortDefinition: {
    en: "Weighted Average Cost of Capital — the blended cost of equity and " +
        "debt financing. The discount rate in DCF; also the hurdle rate that " +
        "ROIC must beat to create value.",
    ro: "Costul mediu ponderat al capitalului — costul mixt al finanțării prin " +
        "capital propriu și datorii. Rata de actualizare în DCF; pragul minim " +
        "pe care ROIC trebuie să-l depășească pentru crearea de valoare.",
  },
  inlineFormula: "Wₑ·Kₑ + Wₐ·Kₐ·(1−t)",
  benchmark: { p25: 0.08, median: 0.10, p75: 0.13 },
  related: ["cost_of_equity", "cost_of_debt", "roic", "dcf_value"],
};

const cost_of_equity: Concept = {
  key: "cost_of_equity",
  name: { en: "Cost of Equity", ro: "Costul capitalului propriu" },
  category: "Valuation",
  shortDefinition: {
    en: "Return shareholders require for the risk they're taking. Built up as " +
        "Risk-Free Rate + Beta × Equity Risk Premium.",
    ro: "Randamentul cerut de acționari pentru riscul asumat. Construit ca: " +
        "Rata fără risc + Beta × Prima de risc.",
  },
  inlineFormula: "Rf + β × ERP",
  related: ["wacc", "risk_free_rate", "equity_risk_premium", "beta"],
};

const cost_of_debt: Concept = {
  key: "cost_of_debt",
  name: { en: "Cost of Debt", ro: "Costul datoriei" },
  category: "Valuation",
  shortDefinition: {
    en: "After-tax interest rate the business pays on its debt. Pre-tax rate " +
        "multiplied by (1 − tax rate); interest is tax-deductible in Romania.",
    ro: "Rata dobânzii după impozit pe care o plătește afacerea. Rata pre-impozit " +
        "înmulțită cu (1 − cota impozitului); dobânda e deductibilă în România.",
  },
  inlineFormula: "Pre-tax Kₐ × (1 − tax)",
  related: ["wacc", "interest_expense"],
};

const risk_free_rate: Concept = {
  key: "risk_free_rate",
  name: { en: "Risk-Free Rate", ro: "Rata fără risc" },
  category: "Valuation",
  shortDefinition: {
    en: "The yield on a long-dated government bond — typically RO 10Y for " +
        "Romanian valuations. The foundation of the cost-of-equity build-up.",
    ro: "Randamentul unei obligațiuni guvernamentale cu scadență lungă — de " +
        "regulă RO 10Y pentru evaluări românești. Baza calculului costului " +
        "capitalului propriu.",
  },
  related: ["cost_of_equity", "wacc"],
};

const equity_risk_premium: Concept = {
  key: "equity_risk_premium",
  name: { en: "Equity Risk Premium", ro: "Prima de risc capital" },
  category: "Valuation",
  shortDefinition: {
    en: "Extra return investors demand above the risk-free rate for holding " +
        "equity. For emerging markets like Romania, typically 7–8% (Damodaran).",
    ro: "Randamentul suplimentar cerut de investitori peste rata fără risc " +
        "pentru deținerea de acțiuni. Pentru piețe emergente ca România, de " +
        "regulă 7–8% (Damodaran).",
  },
  related: ["cost_of_equity", "wacc"],
};

const beta: Concept = {
  key: "beta",
  name: { en: "Beta", ro: "Beta" },
  category: "Valuation",
  shortDefinition: {
    en: "How volatile the stock is vs. the market. β > 1 means more volatile; " +
        "β < 1 means less. For unlisted businesses, use an industry-comparable beta.",
    ro: "Cât de volatilă este acțiunea față de piață. β > 1 = mai volatilă; " +
        "β < 1 = mai puțin. Pentru afaceri necotate, se folosește beta industriei.",
  },
  related: ["cost_of_equity"],
};

const terminal_growth_rate: Concept = {
  key: "terminal_growth_rate",
  name: { en: "Terminal Growth Rate", ro: "Rata de creștere terminală" },
  category: "Valuation",
  shortDefinition: {
    en: "Assumed perpetual growth rate used in the Gordon terminal value. " +
        "Usually 2–3% — inflation plus modest real GDP growth. Higher is " +
        "aggressive; lower is conservative.",
    ro: "Rata de creștere perpetuă presupusă pentru valoarea terminală Gordon. " +
        "De regulă 2–3% — inflație plus creștere modestă. Mai mare = agresiv; " +
        "mai mic = conservator.",
  },
  related: ["terminal_value", "dcf_value", "wacc"],
};

const terminal_value: Concept = {
  key: "terminal_value",
  name: { en: "Terminal Value", ro: "Valoarea terminală" },
  category: "Valuation",
  shortDefinition: {
    en: "Estimated value of the business beyond the explicit forecast period, " +
        "typically computed via the Gordon Growth Model. Usually 60–80% of " +
        "total DCF value.",
    ro: "Valoarea estimată a afacerii după perioada de previziune explicită, " +
        "de regulă calculată prin modelul Gordon. De obicei 60–80% din valoarea " +
        "totală DCF.",
  },
  inlineFormula: "FCF₅ × (1 + g) / (WACC − g)",
  related: ["dcf_value", "wacc", "terminal_growth_rate"],
};

const free_cash_flow: Concept = {
  key: "free_cash_flow",
  name: { en: "Free Cash Flow", ro: "Cash flow liber" },
  category: "Valuation",
  shortDefinition: {
    en: "Cash available to all capital providers (debt + equity) after " +
        "reinvesting in the business. Usually approximated as Net Profit + D&A " +
        "− Maintenance Capex.",
    ro: "Cash disponibil pentru toți furnizorii de capital (datorii + capital " +
        "propriu) după reinvestiția în afacere. De regulă aproximat ca: Profit " +
        "net + Amortizare − Capex de mentenanță.",
  },
  inlineFormula: "Net Profit + D&A − Maintenance Capex",
  related: ["operating_cash_flow", "capex", "dcf_value"],
  computation: (ctx, v) => {
    const m = ctx.metrics ?? {};
    return {
      result: { value: v, format: "currency" },
      layout: "stacked",
      tokens: [
        { type: "value", value: m.netProfit ?? 0, conceptKey: "net_profit", label: "Net Profit", format: "currency" },
        { type: "operator", op: "+" },
        { type: "value", value: m.depreciation ?? 0, conceptKey: "depreciation_amortization", label: "D&A", format: "currency" },
        { type: "operator", op: "−" },
        { type: "value", value: Math.abs(m.capex ?? 0), conceptKey: "capex", label: "Capex", format: "currency" },
      ],
    };
  },
};

// ─── Risk & Credit concepts ──────────────────────────────────────────────

const altman_z_score: Concept = {
  key: "altman_z_score",
  name: { en: "Altman Z″ Score", ro: "Scor Altman Z″" },
  category: "Risk & Credit",
  shortDefinition: {
    en: "Composite distress predictor (emerging-markets variant). Above 2.6 = " +
        "Safe zone; 1.10 to 2.60 = Grey; below 1.10 = Distress zone.",
    ro: "Predictor compus de faliment (varianta piețe emergente). Peste 2,6 = " +
        "zona Sigură; 1,10 până la 2,60 = Gri; sub 1,10 = zona de Pericol.",
  },
  inlineFormula: "6.56·X₁ + 3.26·X₂ + 6.72·X₃ + 1.05·X₄",
  benchmark: { p25: 1.5, median: 2.6, p75: 3.5 },
  related: ["composite_credit_score", "credit_grade", "piotroski_f_score"],
  interpretation: {
    getSentiment: (v) => (v >= 2.6 ? "positive" : v >= 1.1 ? "neutral" : "negative"),
    getNarrative: (v) =>
      v >= 2.6
        ? "Safe zone — low bankruptcy risk."
        : v >= 1.1
          ? "Grey zone — caution; some distress indicators are firing."
          : "Distress zone — historical bankruptcy probability is elevated.",
  },
};

const piotroski_f_score: Concept = {
  key: "piotroski_f_score",
  name: { en: "Piotroski F-Score", ro: "Scor Piotroski F" },
  category: "Risk & Credit",
  shortDefinition: {
    en: "0–9 anti-distress checklist. ≥7 = Strong; 4–6 = Average; ≤3 = Weak. " +
        "Each point comes from a specific accounting check (positive net income, " +
        "improving ROA, etc.).",
    ro: "O listă 0–9 de verificări anti-faliment. ≥7 = Puternic; 4–6 = Mediu; " +
        "≤3 = Slab. Fiecare punct provine dintr-o verificare contabilă (profit net " +
        "pozitiv, ROA în creștere, etc.).",
  },
  benchmark: { p25: 4, median: 5, p75: 7 },
  related: ["altman_z_score", "composite_credit_score"],
  interpretation: {
    getSentiment: (v) => (v >= 7 ? "positive" : v >= 4 ? "neutral" : "negative"),
    getNarrative: (v) =>
      v >= 7
        ? "Strong fundamental quality — multiple anti-distress checks pass."
        : v >= 4
          ? "Mixed signals — some quality checks pass, some don't."
          : "Weak quality — several anti-distress checks fail. Investigate each red flag.",
  },
};

const composite_credit_score: Concept = {
  key: "composite_credit_score",
  name: { en: "Composite Credit Score", ro: "Scor de credit compus" },
  category: "Risk & Credit",
  shortDefinition: {
    en: "0–100 weighted score blending Altman Z″, profitability, leverage, " +
        "coverage, and liquidity. Maps to a letter grade from AAA to D.",
    ro: "Scor 0–100 ponderat ce combină Altman Z″, profitabilitatea, îndatorarea, " +
        "acoperirea și lichiditatea. Se mapează la un rating de la AAA la D.",
  },
  benchmark: { p25: 55, median: 70, p75: 85 },
  related: ["altman_z_score", "credit_grade", "piotroski_f_score"],
  interpretation: {
    getSentiment: (v) => (v >= 75 ? "positive" : v >= 55 ? "neutral" : "negative"),
    getNarrative: (v) =>
      v >= 75
        ? "Investment-grade equivalent — strong credit profile."
        : v >= 55
          ? "Speculative-grade strong — credit risk is manageable."
          : "Speculative-grade weak — high credit risk; lender attention required.",
  },
};

const credit_grade: Concept = {
  key: "credit_grade",
  name: { en: "Credit Grade", ro: "Rating de credit" },
  category: "Risk & Credit",
  shortDefinition: {
    en: "Letter rating derived from the composite credit score. AAA/AA = " +
        "premium; A–BBB = investment grade; BB–B = speculative; CCC and below = distress.",
    ro: "Ratingul-literă derivat din scorul compus. AAA/AA = premium; A–BBB = " +
        "investment grade; BB–B = speculativ; CCC și mai jos = pericol.",
  },
  related: ["composite_credit_score"],
};

// ─── Other margin shortcuts ──────────────────────────────────────────────

// Some legacy bucket strings map onto these — keeping them registered makes
// the bucket→concept resolver more forgiving.

const gross_margin_ratio: Concept = {
  key: "gross_margin_ratio",
  name: { en: "Gross Margin", ro: "Marja brută" },
  category: "Profitability",
  shortDefinition: {
    en: "Gross profit as a percentage of revenue. The pricing-power read — " +
        "how much margin survives after the direct cost of goods.",
    ro: "Profitul brut ca procent din venituri. Citirea puterii de preț — câtă " +
        "marjă rămâne după costul direct.",
  },
  inlineFormula: "(Revenue − COGS) / Revenue",
  benchmark: { p25: 0.20, median: 0.35, p75: 0.50 },
  related: ["gross_profit", "cogs", "ebit_margin", "operating_revenue"],
};

// Real-estate-specific
const ltv: Concept = {
  key: "ltv",
  name: { en: "Loan-to-Value", ro: "LTV (raport credit / valoare)" },
  category: "Leverage & Solvency",
  shortDefinition: {
    en: "Debt as a percentage of the property's market value. The primary " +
        "leverage metric for real estate. Above 70% LTV is typically considered " +
        "leveraged; above 85% is high risk on a price decline.",
    ro: "Datorie ca procent din valoarea de piață a proprietății. Indicatorul " +
        "principal de îndatorare pentru imobiliar. Peste 70% = îndatorat; " +
        "peste 85% = risc ridicat la scăderea prețului.",
  },
  inlineFormula: "Total Debt / Property Market Value",
  benchmark: { p25: 0.45, median: 0.60, p75: 0.75 },
  related: ["debt_to_equity", "nav_value", "total_debt"],
};

// ─── Registration ────────────────────────────────────────────────────────

/** Analytics concept pack. Merged into the master registry by
 *  concepts/index.ts alongside SEED_CONCEPTS and STATEMENT_CONCEPTS. */
export const ANALYTICS_CONCEPTS: Readonly<Record<string, Concept>> = {
  // Profitability
  [ebit_margin.key]: ebit_margin,
  [net_margin.key]: net_margin,
  [gross_margin_ratio.key]: gross_margin_ratio,
  [roe.key]: roe,
  [roa.key]: roa,
  [roic.key]: roic,
  // Liquidity
  [current_ratio.key]: current_ratio,
  [quick_ratio.key]: quick_ratio,
  [cash_ratio.key]: cash_ratio,
  [working_capital.key]: working_capital,
  // Leverage
  [equity_ratio.key]: equity_ratio,
  [debt_to_equity.key]: debt_to_equity,
  [lt_debt_to_equity.key]: lt_debt_to_equity,
  [net_debt_ebitda.key]: net_debt_ebitda,
  [debt_to_assets.key]: debt_to_assets,
  // Coverage
  [interest_coverage.key]: interest_coverage,
  [ebitda_to_interest.key]: ebitda_to_interest,
  [dscr.key]: dscr,
  // Efficiency
  [asset_turnover.key]: asset_turnover,
  [inventory_turnover.key]: inventory_turnover,
  [dio_days.key]: dio_days,
  [dso_days.key]: dso_days,
  [dpo_days.key]: dpo_days,
  [ccc_days.key]: ccc_days,
  // Valuation
  [enterprise_value.key]: enterprise_value,
  [equity_value.key]: equity_value,
  [ev_ebitda_multiple.key]: ev_ebitda_multiple,
  [dcf_value.key]: dcf_value,
  [nav_value.key]: nav_value,
  [book_equity_value.key]: book_equity_value,
  [wacc.key]: wacc,
  [cost_of_equity.key]: cost_of_equity,
  [cost_of_debt.key]: cost_of_debt,
  [risk_free_rate.key]: risk_free_rate,
  [equity_risk_premium.key]: equity_risk_premium,
  [beta.key]: beta,
  [terminal_growth_rate.key]: terminal_growth_rate,
  [terminal_value.key]: terminal_value,
  [free_cash_flow.key]: free_cash_flow,
  // Risk & Credit
  [altman_z_score.key]: altman_z_score,
  [piotroski_f_score.key]: piotroski_f_score,
  [composite_credit_score.key]: composite_credit_score,
  [credit_grade.key]: credit_grade,
  // Real-estate-specific
  [ltv.key]: ltv,
  // ── Aliases — map the short keys used by computeRatios() in
  //    financialReport.ts to the same Concept objects, so RatioTile and
  //    other consumers can pass ratio.key directly to LearnableNumber
  //    without an intermediate translator. Aliases are pointer-equal to
  //    the primary concept; no duplication.
  gross_margin: gross_margin_ratio,
  debt_to_ebitda: net_debt_ebitda,
  dio: dio_days,
  dso: dso_days,
  dpo: dpo_days,
  ccc: ccc_days,
  altman_z: altman_z_score,
  adjusted_dscr: dscr,
  dscr_with_lt_principal: dscr,
};
