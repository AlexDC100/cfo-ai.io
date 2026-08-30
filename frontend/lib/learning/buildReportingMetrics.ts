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
  // `statements.cashFlow` DOES NOT EXIST on `Statements` — it never has.
  // Every read below resolved to `undefined`, so all seven cash-flow
  // metrics were permanently absent: the whole "Cash Flow" category in the
  // learning surface had no numbers, and `CascadeState` (= ReportingMetrics)
  // handed the scenario engine `undefined` for capex, so the capex lever
  // was adjusting `num(undefined) === 0` and could never move anything.
  //
  // The real source is the canonical engine view the CF tab already reads,
  // `statements.assembled_cf` — not `deriveCashFlow()`, which is an
  // approximation (`cfo = NI + D&A − ΔWC`) and would have put a second,
  // disagreeing cash-flow number on screen beside the CF tab's.
  //
  // Sign convention verified against real engine output rather than
  // assumed: the view's own fields satisfy CFO + CFI + CFF =
  // net_change_in_cash exactly, which is the identity the
  // `net_change_in_cash` concept declares, so CFI/CFF are already
  // outflow-negative as that concept expects.
  const acf = statements.assembled_cf;
  /** Read one canonical CF field; absent stays absent — never 0, so a
   *  missing view cannot render as "no cash moved". */
  const cfNum = (key: string): number | undefined => {
    const v = acf?.[key];
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  };
  const netChangeInCash = cfNum("net_change_in_cash");
  const closingCash = cfNum("closing_cash_actual");
  // `capex_total` is emitted as negative cash. ReportingMetrics.capex is a
  // magnitude — the codebase's other capex producer (`deriveCashFlow`)
  // returns it positive because `fcf = cfo − capex` requires that, and a
  // "raise capex 10%" lever reads on a magnitude. Keep the two agreeing.
  const capexTotal = cfNum("capex_total");
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
    operatingCashFlow: cfNum("cash_from_operating"),
    capex: capexTotal === undefined ? undefined : Math.abs(capexTotal),
    investingCashFlow: cfNum("cash_from_investing"),
    financingCashFlow: cfNum("cash_from_financing"),
    netChangeInCash,
    openingCash:
      closingCash !== undefined && netChangeInCash !== undefined
        ? closingCash - netChangeInCash
        : undefined,
    closingCash,
  };
}
