// LEARN-FIX-2 (2026-06-13/14) — Reporting-metrics snapshot builder.
//
// Extracted from FinancialStatements.tsx so LearningPopover can call
// the same routine when it sits OUTSIDE the ReportingContextProvider
// (which is the case on Dashboard pages because PopoverStackRenderer
// mounts at the App root; the provider lives deeper).
//
// Without this helper, formula popovers like EBIT showed
// `Revenue 0 RON − COGS 0 RON − OpEx 0 RON` even though the same
// numbers were correct everywhere else on the page. The popover read
// from an empty `metrics` snapshot because the provider hadn't
// reached its tree.
//
// 2026-06-14 follow-up: initial extract read `inc.cogs` / `inc.ebit` /
// `inc.opex` / `inc.netIncome` — none of which exist on the
// IncomeStatement type. They live on DerivedTotals (built by
// `deriveTotals(s)`). Correct field names are:
//   IncomeStatement.{revenue, costOfGoodsSold, operatingExpenses,
//                    depreciationAmortization, interestExpense,
//                    taxExpense, financialIncome?, financialExpense?}
//   DerivedTotals.{grossProfit, ebitda, ebit, netFinancialResult,
//                  pbt, netIncome, totalAssets, totalEquity,
//                  totalDebt, totalCurrentAssets, totalCurrentLiabilities,
//                  workingCapital, netDebt}
//   BalanceSheet.{cash, accountsReceivable, inventory,
//                 propertyPlantEquipment, accountsPayable,
//                 shortTermDebt, longTermDebt, ...}
// This rev reads from those correctly.
//
// Keep this builder PURE — same input, same output. No date helpers,
// no random sources. The FinancialStatements caller and the popover
// caller must produce byte-identical snapshots from byte-identical
// inputs.

import { deriveTotals, type Statements } from "@/lib/financialReport";
import type { ReportingMetrics } from "@/lib/learning/concepts/_schema";

/** Build a ReportingMetrics snapshot from a Statements blob. Returns
 *  an empty object when statements is null (the empty-period state)
 *  so callers get a structurally consistent value. */
export function buildReportingMetricsSnapshot(
  statements: Statements | null,
): ReportingMetrics {
  if (!statements) return {};
  const is = statements.incomeStatement;
  const bs = statements.balanceSheet;
  const cf = statements.cashFlow;
  const t = deriveTotals(statements);
  return {
    // ── Income statement ──────────────────────────────────────
    revenue: is.revenue,
    grossProfit: t.grossProfit,
    cogs: is.costOfGoodsSold,
    opex: is.operatingExpenses,
    depreciation: is.depreciationAmortization,
    amortization: 0,
    ebitda: t.ebitda,
    ebit: t.ebit,
    netFinancialResult: t.netFinancialResult,
    incomeTax: is.taxExpense,
    netProfit: t.netIncome,
    // ── Balance sheet ────────────────────────────────────────
    totalAssets: t.totalAssets,
    currentAssets: t.totalCurrentAssets,
    cash: bs.cash,
    inventory: bs.inventory,
    receivables: bs.accountsReceivable,
    ppe: bs.propertyPlantEquipment,
    totalEquityAndLiab: t.totalLiabilitiesAndEquity,
    currentLiabilities: t.totalCurrentLiabilities,
    accountsPayable: bs.accountsPayable,
    shortTermDebt: bs.shortTermDebt,
    longTermDebt: bs.longTermDebt,
    totalDebt: t.totalDebt,
    shareholdersEquity: t.totalEquity,
    // ── Cash flow ────────────────────────────────────────────
    operatingCashFlow: cf?.cashFromOperating ?? undefined,
    capex: cf?.capex ?? undefined,
    investingCashFlow: cf?.cashUsedInInvesting ?? undefined,
    financingCashFlow: cf?.cashFromFinancing ?? undefined,
    netChangeInCash: cf?.netChangeInCash ?? undefined,
    openingCash: cf?.openingCash ?? undefined,
    closingCash: cf?.closingCashComputed ?? undefined,
  };
}
