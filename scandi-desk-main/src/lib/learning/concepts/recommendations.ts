// F5.0 Phase 7 — Recommendations + Risk concepts.
//
// Six concepts that explain the *act* of recommending — what the system
// believes about severity, thresholds, impact, and priority. Each is
// authored once and consumed everywhere a recommendation card surfaces
// (FinancialStatements Recommendations tab, ComprehensiveReport, Alerts).
//
// These concepts deliberately do NOT decompose to RAS accounts — they
// are meta-concepts about the recommendation engine's logic, not raw
// numbers from the trial balance. sourceTrace points at the rule
// catalog itself ("calculated" variant with derivedFrom prose).

import type { Concept } from "./_schema";

const recommendation_impact: Concept = {
  key: "recommendation_impact",
  name: { en: "Recommendation Impact", ro: "Impact recomandare" },
  category: "Risk & Credit",
  shortDefinition: {
    en: "The estimated annual cash impact of executing this recommendation. " +
        "Computed by the rule that triggered it from quantified deltas " +
        "(interest savings, working-capital release, margin gain).",
    ro: "Impactul anual estimat în cash al executării recomandării. Calculat " +
        "de regula care a declanșat-o din deltas cuantificate.",
  },
  plainEnglish: {
    en: "If you act on this recommendation, this is roughly how much extra " +
        "cash the business should see per year. Numbers are conservative " +
        "estimates, not promises.",
    ro: "Dacă pui în practică recomandarea, aproximativ atâta cash în plus " +
        "ar trebui să vadă afacerea anual. Cifrele sunt estimări prudente.",
  },
  inlineFormula: "Δ Cash (estimated)",
  related: ["recommendation", "free_cash_flow"],
  sourceTrace: () => ({
    sourceType: "calculated",
    derivedFrom:
      "Rule-side estimate built from the metric delta that triggered the card " +
      "(e.g. interest savings = current rate − refinance rate, applied to bank debt).",
    confidence: 0.7,
  }),
};

const risk_score: Concept = {
  key: "risk_score",
  name: { en: "Risk Score", ro: "Scor de risc" },
  category: "Risk & Credit",
  shortDefinition: {
    en: "A composite 0-100 read of overall financial-distress risk. " +
        "Combines Altman Z″, Piotroski F, leverage, coverage, and liquidity " +
        "into a single number for at-a-glance triage.",
    ro: "Scor compus 0-100 al riscului financiar. Combină Altman Z″, " +
        "Piotroski F, levier, acoperire și lichiditate într-un singur număr.",
  },
  plainEnglish: {
    en: "One number for how worried a lender or investor should be. Above " +
        "70 = healthy. Under 40 = needs attention this quarter.",
    ro: "Un singur scor pentru cât de îngrijorat ar fi un creditor sau " +
        "investitor. Peste 70 = sănătos. Sub 40 = atenție urgentă.",
  },
  inlineFormula:
    "30% Altman Z″ + 20% Profitability + 15% Leverage + 10% Coverage + 10% DSCR + 10% Liquidity + 5% Equity",
  related: ["altman_z", "piotroski_f", "net_debt_ebitda", "interest_coverage"],
  sourceTrace: () => ({
    sourceType: "calculated",
    derivedFrom:
      "Composite of Altman Z″, Piotroski F, and leverage / coverage / liquidity sub-scores, " +
      "weighted as defined in financial_analysis.py build_credit_score().",
    confidence: 0.85,
  }),
};

const alert_severity: Concept = {
  key: "alert_severity",
  name: { en: "Alert Severity", ro: "Gravitate alertă" },
  category: "Risk & Credit",
  shortDefinition: {
    en: "How urgent the rule judged this finding to be. `critical` means " +
        "act within the quarter. `high` = current cycle. `medium` = next " +
        "planning cycle. `info` = opportunity, no clock.",
    ro: "Cât de urgentă a considerat regula constatarea. `critical` = acționează " +
        "în acest trimestru. `high` = ciclul curent. `medium` = următorul " +
        "ciclu de planificare. `info` = oportunitate, fără ceas.",
  },
  plainEnglish: {
    en: "How loud the alarm is. Red = stop everything and fix. Amber = " +
        "important, this cycle. Blue = useful, next cycle. Grey = nice to know.",
    ro: "Cât de puternic e alarma. Roșu = oprește tot și rezolvă. Galben = " +
        "important, acest ciclu. Albastru = util, ciclul viitor. Gri = de știut.",
  },
  related: ["risk_score", "action_priority"],
  sourceTrace: () => ({
    sourceType: "calculated",
    derivedFrom:
      "Set by the rule on detect(). Encoded inline in recommendationRules.ts; " +
      "severity is part of the rule contract, never inferred client-side.",
    confidence: 1.0,
  }),
};

const benchmark_threshold: Concept = {
  key: "benchmark_threshold",
  name: { en: "Benchmark Threshold", ro: "Prag benchmark" },
  category: "Benchmark",
  shortDefinition: {
    en: "The cutoff value a rule compares against. Most thresholds come " +
        "from industry benchmarks (Eurostat SBS / Damodaran / Bisnode) or " +
        "from lender covenants common in Romanian SME debt.",
    ro: "Valoarea-prag cu care compară regula. Cele mai multe praguri provin " +
        "din benchmark-uri sectoriale sau covenants bancare RO uzuale.",
  },
  plainEnglish: {
    en: "The line in the sand. When your number crosses this line, the " +
        "system fires the alert. Higher / lower / outside-range — depends " +
        "on the metric.",
    ro: "Linia critică. Când cifra ta o traversează, sistemul aprinde " +
        "alerta. Mai mare / mai mic / în afara intervalului — depinde de metric.",
  },
  related: ["alert_severity", "benchmark_p25_median_p75"],
  sourceTrace: () => ({
    sourceType: "calculated",
    derivedFrom:
      "Encoded per rule in recommendationRules.ts. For industry-anchored rules " +
      "the threshold is the P50 (median) or P75 of the Eurostat SBS / Bisnode " +
      "RO sector. For covenant-anchored rules, the threshold is the common " +
      "Romanian SME loan covenant level (e.g. DSCR 1.25×, Debt/EBITDA 4×).",
    confidence: 0.9,
  }),
};

const financial_impact: Concept = {
  key: "financial_impact",
  name: { en: "Financial Impact", ro: "Impact financiar" },
  category: "Risk & Credit",
  shortDefinition: {
    en: "The estimated annual P&L or cash-flow effect of the finding. " +
        "Cumulative when multiple rules cite overlapping levers — the " +
        "Recommendations tab does NOT add them; each card stands alone.",
    ro: "Efectul anual estimat asupra P&L sau cash-flow. Cumulativ când mai " +
        "multe reguli citează levere care se suprapun.",
  },
  plainEnglish: {
    en: "Concretely, in money: how much this issue costs you today, or how " +
        "much fixing it would save. Annualized; rough but defensible.",
    ro: "Concret, în bani: cât te costă azi această problemă, sau cât ai " +
        "economisi rezolvând-o. Anualizat; estimativ dar defensibil.",
  },
  related: ["recommendation_impact", "free_cash_flow"],
  sourceTrace: () => ({
    sourceType: "calculated",
    derivedFrom:
      "Per-rule calculation. Examples: interest_savings_if_repaid = bank_debt × current_rate; " +
      "potential_savings_per_50bps = bank_debt × 0.005.",
    confidence: 0.7,
  }),
};

const action_priority: Concept = {
  key: "action_priority",
  name: { en: "Action Priority", ro: "Prioritate acțiune" },
  category: "Risk & Credit",
  shortDefinition: {
    en: "The execution ranking the engine assigns. Sorted by severity " +
        "rank then financial-impact magnitude; tie-broken by rule order.",
    ro: "Clasamentul de execuție pe care motorul îl atribuie. Sortat după " +
        "rang de gravitate, apoi după magnitudinea impactului financiar.",
  },
  plainEnglish: {
    en: "What to do first. Critical items go on top. Then big-impact items. " +
        "Cards are listed in the order CFO AI thinks you should attack them.",
    ro: "Ce să faci primul. Punctele critice sunt sus. Apoi cele cu impact " +
        "mare. Cardurile sunt listate în ordinea în care CFO AI crede " +
        "că trebuie atacate.",
  },
  related: ["alert_severity", "financial_impact"],
  sourceTrace: () => ({
    sourceType: "calculated",
    derivedFrom:
      "Severity rank ('critical' > 'high' > 'medium' > 'info') with stable rule order tie-break.",
    confidence: 1.0,
  }),
};

export const RECOMMENDATIONS_CONCEPTS: Concept[] = [
  recommendation_impact,
  risk_score,
  alert_severity,
  benchmark_threshold,
  financial_impact,
  action_priority,
];

// ─── factsCited key → existing concept resolver ──────────────────────────
//
// The recommendation engine emits `factsCited` with keys like `dscr`,
// `total_debt`, `current_ratio`, `pe_ratio`. When we render the
// "Triggered by" block, each fact's label becomes a LearnableRowLabel —
// clicking opens the underlying concept popover (NOT the meta-concept
// above). The mapping is just key normalization.

const FACT_TO_CONCEPT: Readonly<Record<string, string>> = {
  // Liquidity
  current_ratio: "current_ratio",
  quick_ratio: "quick_ratio",
  cash_ratio: "cash_ratio",
  working_capital: "working_capital",
  // Leverage
  net_debt_ebitda: "net_debt_ebitda",
  debt_to_equity: "debt_to_equity",
  equity_ratio: "equity_ratio",
  debt_to_ebitda_adjusted: "net_debt_ebitda",
  bank_debt_total: "total_debt",
  total_debt: "total_debt",
  // Coverage
  dscr: "dscr",
  interest_coverage: "interest_coverage",
  // Profitability
  ebitda_margin: "ebitda_margin",
  net_margin: "net_margin",
  ebit_margin: "ebit_margin",
  roe: "roe",
  roa: "roa",
  roic: "roic",
  // Efficiency
  dio: "dio_days",
  dso: "dso_days",
  dpo: "dpo_days",
  ccc: "ccc_days",
  // Risk
  altman_z: "altman_z",
  altman_z_double_prime: "altman_z",
  // Balance Sheet scale
  cash: "cash",
  total_assets: "total_assets",
  total_equity: "shareholders_equity",
  // P&L scale
  revenue: "revenue",
  ebitda: "ebitda",
  net_profit: "net_profit",
  interest_expense: "interest_expense",
  // Engine-computed impact / threshold proxies → meta concepts
  interest_savings_if_repaid: "recommendation_impact",
  potential_savings_per_50bps: "recommendation_impact",
  current_rate: "interest_coverage",
};

/** Resolve a fact key from `Recommendation.factsCited` to a concept
 *  registry key. Returns undefined if no concept exists — caller renders
 *  the fact label as plain text. */
export function factToConceptKey(factKey: string): string | undefined {
  return FACT_TO_CONCEPT[factKey.toLowerCase().trim()];
}

/** Best-effort human label for a factsCited key. The engine emits
 *  snake_case; this turns it into Title Case prose with a handful of
 *  overrides for the common cases. */
const FACT_LABEL_OVERRIDE: Readonly<Record<string, string>> = {
  dscr: "DSCR",
  debt_to_ebitda_adjusted: "Adjusted Debt / EBITDA",
  net_debt_ebitda: "Net Debt / EBITDA",
  altman_z: "Altman Z″",
  altman_z_double_prime: "Altman Z″",
  bank_debt_total: "Total bank debt",
  potential_savings_per_50bps: "Potential savings (50 bps)",
  interest_savings_if_repaid: "Interest savings if repaid",
  current_rate: "Current borrow rate",
  ebitda_margin: "EBITDA margin",
  net_margin: "Net margin",
  ebit_margin: "EBIT margin",
  interest_coverage: "Interest coverage",
  dio: "DIO (days)",
  dso: "DSO (days)",
  dpo: "DPO (days)",
  ccc: "CCC (days)",
  roe: "ROE",
  roa: "ROA",
  roic: "ROIC",
};

export function factLabel(factKey: string): string {
  const k = factKey.toLowerCase().trim();
  return (
    FACT_LABEL_OVERRIDE[k] ??
    k
      .split("_")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  );
}
