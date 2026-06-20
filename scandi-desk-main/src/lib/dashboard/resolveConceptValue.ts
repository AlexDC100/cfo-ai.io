// F6.0.4 (2026-06-20) — Concept value + format resolver.
//
// THE bridge between an F5.0 concept key and a renderable number. The
// configurable dashboard binds each card to a concept key; this module
// answers "what number do I show, and how do I format it?" from the
// active period's ReportingMetrics snapshot.
//
// Two classes of concept:
//   1. DIRECT — the value is a field on ReportingMetrics (revenue,
//      ebitda, cash, total_debt, ...). Read it straight.
//   2. DERIVED — a ratio computed from direct fields (ebitda_margin =
//      ebitda / revenue; current_ratio = currentAssets / currentLiabilities;
//      net_debt_ebitda = (totalDebt − cash) / ebitda). These are NOT
//      stored on ReportingMetrics (confirmed via the schema map) so we
//      compute them here, with strict zero-denominator guards.
//
// Format is INFERRED from the concept key (the Concept type carries no
// `format` field). Mirrors the inference the F5.0 popover already uses,
// kept in one place so a card and its popover agree on units.
//
// Unit convention for the returned `value` (so the LearnableNumber +
// popover format it correctly):
//   · currency   → raw amount in source currency (RON)
//   · percentage → DECIMAL (0.132 for 13.2%) — popover ×100s it
//   · ratio      → raw multiple (1.40 → "1.40×")
//   · days       → integer days
//   · score      → raw score

import type { ReportingMetrics } from "@/lib/learning/concepts/_schema";

export type CardValueFormat =
  | "currency"
  | "percentage"
  | "ratio"
  | "days"
  | "score";

export interface ResolvedCardValue {
  /** Renderable number in its native unit (see header), or null when the
   *  metric can't be computed for this period (missing field, zero
   *  denominator). Card renders an em-dash for null. */
  value: number | null;
  format: CardValueFormat;
}

/** Percentage concept keys (rendered as "13.2%", value stored as decimal). */
const PERCENTAGE_KEYS = new Set([
  "ebitda_margin",
  "ebit_margin",
  "net_margin",
  "gross_margin",
  "gross_margin_ratio",
  "operating_margin",
  "roe",
  "roa",
  "roic",
  "equity_ratio",
  "debt_to_assets",
  "fcf_yield",
  "dividend_yield",
]);

/** Ratio concept keys (rendered as "1.40×"). */
const RATIO_KEYS = new Set([
  "current_ratio",
  "quick_ratio",
  "cash_ratio",
  "net_debt_ebitda",
  "debt_to_equity",
  "lt_debt_to_equity",
  "interest_coverage",
  "ebitda_to_interest",
  "dscr",
  "asset_turnover",
  "inventory_turnover",
  "ev_ebitda_multiple",
  "pe_ratio",
]);

/** Day-count concept keys (rendered as "62d"). */
const DAYS_KEYS = new Set(["dio", "dso", "dpo", "ccc"]);

/** Score concept keys (rendered as raw number). */
const SCORE_KEYS = new Set([
  "altman_z",
  "altman_z_score",
  "piotroski_f_score",
  "composite_credit_score",
]);

/** Concept keys the resolver knows how to compute a value for. The
 *  concept picker intersects this with the registry so every addable
 *  card is guaranteed to show a real number (no dead em-dash cards). */
export const SUPPORTED_CONCEPT_KEYS: ReadonlySet<string> = new Set([
  // currency
  "revenue", "operating_revenue", "net_turnover", "cogs", "gross_profit",
  "operating_expenses", "opex", "ebit", "ebitda", "depreciation_amortization",
  "depreciation", "net_financial_result", "income_tax", "net_profit",
  "net_income", "total_assets", "current_assets", "cash", "inventory",
  "receivables", "ppe", "current_liabilities", "accounts_payable",
  "short_term_debt", "long_term_debt", "total_debt", "shareholders_equity",
  "total_equity", "operating_cash_flow", "capex", "free_cash_flow",
  "enterprise_value", "equity_value",
  // derived ratios
  "ebitda_margin", "ebit_margin", "net_margin", "gross_margin",
  "gross_margin_ratio", "current_ratio", "quick_ratio", "cash_ratio",
  "net_debt_ebitda", "debt_to_equity", "equity_ratio", "debt_to_assets",
  "roe", "roa", "ev_ebitda_multiple",
]);

export function inferCardFormat(conceptKey: string): CardValueFormat {
  if (PERCENTAGE_KEYS.has(conceptKey) || conceptKey.endsWith("_margin"))
    return "percentage";
  if (RATIO_KEYS.has(conceptKey)) return "ratio";
  if (DAYS_KEYS.has(conceptKey) || conceptKey.endsWith("_days")) return "days";
  if (SCORE_KEYS.has(conceptKey)) return "score";
  return "currency";
}

/** Safe division — null on zero/invalid denominator. */
function div(a: number | undefined, b: number | undefined): number | null {
  if (typeof a !== "number" || typeof b !== "number") return null;
  if (b === 0 || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  return a / b;
}

function n(v: number | undefined): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Resolve a concept key to its current value + display format.
 *
 * @param conceptKey  e.g. "ebitda", "ebitda_margin", "net_debt_ebitda"
 * @param metrics     the active period ReportingMetrics snapshot
 * @param overrides   optional canonical values keyed by conceptKey — the
 *                    page passes engine-routed numbers for the legacy
 *                    tiles so they stay byte-identical to pre-F6.0.4.
 */
export function resolveConceptValue(
  conceptKey: string,
  metrics: ReportingMetrics,
  overrides?: Record<string, number | null | undefined>,
): ResolvedCardValue {
  const format = inferCardFormat(conceptKey);

  // Canonical override wins for DIRECT values (legacy tiles routed through
  // engine metrics).
  if (overrides && conceptKey in overrides) {
    const ov = overrides[conceptKey];
    return { value: typeof ov === "number" && Number.isFinite(ov) ? ov : null, format };
  }

  // CRITICAL (caught in browser 2026-06-20): DERIVED ratios must use the
  // SAME basis as the canonical override cards, not the raw snapshot.
  // The EBITDA card shows engine statutory EBITDA (+2.1M for EEI) while
  // the snapshot's deriveTotals EBITDA is the cash view that collapses
  // near-zero/negative. Without overlaying the override, ebitda_margin
  // and net_debt_ebitda computed off the snapshot read "−1.3%" / "−343×"
  // right beside a "+2.1M" EBITDA card — visibly contradictory.
  //
  // Overlay the override values onto an effective-metrics object used for
  // EVERY downstream computation so the ratios reconcile with the tiles.
  const m: ReportingMetrics = overrides
    ? {
        ...metrics,
        ...(typeof overrides.operating_revenue === "number"
          ? { revenue: overrides.operating_revenue }
          : {}),
        ...(typeof overrides.ebitda === "number"
          ? { ebitda: overrides.ebitda }
          : {}),
        ...(typeof overrides.net_profit === "number"
          ? { netProfit: overrides.net_profit }
          : {}),
        ...(typeof overrides.total_debt === "number"
          ? { totalDebt: overrides.total_debt }
          : {}),
      }
    : metrics;

  switch (conceptKey) {
    // ── Direct currency fields ────────────────────────────────────
    case "revenue":
    case "operating_revenue":
    case "net_turnover":
      return { value: n(m.revenue) ?? null, format };
    case "cogs":
      return { value: n(m.cogs) ?? null, format };
    case "gross_profit":
      return { value: n(m.grossProfit) ?? null, format };
    case "operating_expenses":
    case "opex":
      return { value: n(m.opex) ?? null, format };
    case "ebit":
      return { value: n(m.ebit) ?? null, format };
    case "ebitda":
      return { value: n(m.ebitda) ?? null, format };
    case "depreciation_amortization":
    case "depreciation":
      return { value: n(m.depreciation) ?? null, format };
    case "net_financial_result":
      return { value: n(m.netFinancialResult) ?? null, format };
    case "income_tax":
      return { value: n(m.incomeTax) ?? null, format };
    case "net_profit":
    case "net_income":
      return { value: n(m.netProfit) ?? null, format };
    case "total_assets":
      return { value: n(m.totalAssets) ?? null, format };
    case "current_assets":
      return { value: n(m.currentAssets) ?? null, format };
    case "cash":
      return { value: n(m.cash) ?? null, format };
    case "inventory":
      return { value: n(m.inventory) ?? null, format };
    case "receivables":
      return { value: n(m.receivables) ?? null, format };
    case "ppe":
      return { value: n(m.ppe) ?? null, format };
    case "current_liabilities":
      return { value: n(m.currentLiabilities) ?? null, format };
    case "accounts_payable":
      return { value: n(m.accountsPayable) ?? null, format };
    case "short_term_debt":
      return { value: n(m.shortTermDebt) ?? null, format };
    case "long_term_debt":
      return { value: n(m.longTermDebt) ?? null, format };
    case "total_debt":
      return { value: n(m.totalDebt) ?? null, format };
    case "shareholders_equity":
    case "total_equity":
      return { value: n(m.shareholdersEquity) ?? null, format };
    case "operating_cash_flow":
      return { value: n(m.operatingCashFlow) ?? null, format };
    case "capex":
      return { value: n(m.capex) ?? null, format };
    case "free_cash_flow":
      return { value: n(m.freeCashFlow) ?? null, format };
    case "enterprise_value":
      return { value: n(m.enterpriseValue) ?? null, format };
    case "equity_value":
      return { value: n(m.equityValue) ?? null, format };

    // ── Derived ratios (NOT stored — compute with zero guards) ────
    case "ebitda_margin":
      return { value: div(m.ebitda, m.revenue), format };
    case "ebit_margin":
      return { value: div(m.ebit, m.revenue), format };
    case "net_margin":
      return { value: div(m.netProfit, m.revenue), format };
    case "gross_margin":
    case "gross_margin_ratio":
      return { value: div(m.grossProfit, m.revenue), format };
    case "current_ratio":
      return { value: div(m.currentAssets, m.currentLiabilities), format };
    case "quick_ratio": {
      const cash = n(m.cash) ?? 0;
      const ar = n(m.receivables) ?? 0;
      return { value: div(cash + ar, m.currentLiabilities), format };
    }
    case "cash_ratio":
      return { value: div(m.cash, m.currentLiabilities), format };
    case "net_debt_ebitda": {
      const debt = n(m.totalDebt) ?? 0;
      const cash = n(m.cash) ?? 0;
      return { value: div(debt - cash, m.ebitda), format };
    }
    case "debt_to_equity":
      return { value: div(m.totalDebt, m.shareholdersEquity), format };
    case "equity_ratio":
      return { value: div(m.shareholdersEquity, m.totalAssets), format };
    case "debt_to_assets":
      return { value: div(m.totalDebt, m.totalAssets), format };
    case "roe":
      return { value: div(m.netProfit, m.shareholdersEquity), format };
    case "roa":
      return { value: div(m.netProfit, m.totalAssets), format };
    case "ev_ebitda_multiple":
      return { value: div(m.enterpriseValue, m.ebitda), format };

    default:
      // Unknown / unmapped concept — render em-dash. The card still shows
      // the concept's name + definition; only the number is unavailable.
      return { value: null, format };
  }
}

/** Format a resolved value into a display string for the non-currency
 *  formats. Currency is handled by the <Money> component directly (it
 *  needs the currency store), so this returns null for currency and the
 *  card branches on format. */
export function formatCardValue(
  value: number | null,
  format: CardValueFormat,
): string | null {
  if (value === null) return "—";
  switch (format) {
    case "percentage":
      return `${(value * 100).toFixed(1)}%`;
    case "ratio":
      return `${value.toFixed(2)}×`;
    case "days":
      return `${Math.round(value)}d`;
    case "score":
      return value.toFixed(2);
    case "currency":
      // Caller renders <Money> — signal via null.
      return null;
  }
}
