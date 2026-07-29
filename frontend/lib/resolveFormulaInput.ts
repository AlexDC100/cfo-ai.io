// Resolves a `FormulaValueKey` against the live company statements.
// Used by RatioDetailDrawer to pull the actual numeric value that
// each `<TraceableNumber>` in an inline formula should display.
//
// Single source of truth for the mapping between "what the formula
// says it needs" (e.g. "totalCurrentLiabilities") and "where that
// number lives on the Statements object". Keeping the mapping in one
// place means a future renamer of `bs.cash` → `bs.cashAndEquivalents`
// fails fast in TypeScript, not silently across 20 ratio entries.

import type { Statements } from "./financialReport";
import { deriveTotals } from "./financialReport";
import type { FormulaValueKey } from "./ratioKnowledge";

export function resolveFormulaInput(
  key: FormulaValueKey,
  statements: Statements,
): number {
  const bs = statements.balanceSheet;
  const is = statements.incomeStatement;
  const t = deriveTotals(statements);
  switch (key) {
    // Balance Sheet
    case "cash":                       return bs.cash;
    case "accountsReceivable":         return bs.accountsReceivable;
    case "inventory":                  return bs.inventory;
    case "totalCurrentAssets":         return t.totalCurrentAssets;
    case "totalAssets":                return t.totalAssets;
    case "accountsPayable":            return bs.accountsPayable;
    case "shortTermDebt":              return bs.shortTermDebt;
    case "totalCurrentLiabilities":    return t.totalCurrentLiabilities;
    case "longTermDebt":               return bs.longTermDebt;
    case "totalLiabilities":           return t.totalLiabilities;
    case "totalEquity":                return t.totalEquity;
    case "totalDebt":                  return t.totalDebt;
    case "netDebt":                    return t.netDebt;
    // P&L (Phase C)
    case "revenue":                    return is.revenue;
    case "costOfGoodsSold":            return is.costOfGoodsSold;
    case "operatingExpenses":          return is.operatingExpenses;
    case "depreciationAmortization":   return is.depreciationAmortization;
    case "ebitda":                     return t.ebitda;
    case "ebit":                       return t.ebit;
    case "interestExpense":            return is.interestExpense;
    case "netIncome":                  return t.netIncome;
    // Exhaustiveness — TS will fail this branch if a key is added to
    // FormulaValueKey without a case above. Defensive runtime fallback.
    default: {
      const _exhaustive: never = key;
      return Number.NaN; // unreachable in practice; flagged by tsc
    }
  }
}
