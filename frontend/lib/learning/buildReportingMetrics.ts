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
import { equityRefusalOf, plLevelsOf, readNetProvisions } from "@/lib/servedOneEbitda";
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
  // INTEREST EXPENSE — the denominator of the Ratios card's
  // `interest_coverage` and so of its "How it's computed" popover. It was
  // never set, and the concept printed `Interest 0 RON` under every served
  // coverage (retail 0.32x, agras 28.14x, Scandia 13.27x): operands that
  // do not recompute the figure beside them. Read from the authority the
  // engine's row divides — `assembled_pl.interest_expense`, else the
  // income statement's line (the same `pick` financialReport.ts uses for
  // this figure). ABSENT stays absent, never 0: a source that declares the
  // line absent, or carries no number for it, has no interest to print.
  const interestDeclaredAbsent = (statements.absentInputs ?? []).includes("interestExpense");
  const finite = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const interestExpense = interestDeclaredAbsent
    ? undefined
    : (finite(statements.assembled_pl?.interest_expense) ?? finite(is.interestExpense));
  // THE ONE EBITDA. Gross profit, EBITDA, EBIT and the result are the
  // ENGINE's levels (711 and 72x inside, `deriveTotals` → `plLevelsOf`);
  // a level the engine refused stays ABSENT here (undefined), so a popover
  // can never show a rebuilt figure under a refused one — and "revenue" is
  // net turnover (70x − 709), every margin's denominator.
  const t = deriveTotals(statements);
  const levels = plLevelsOf(statements);
  const present = (v: number | null): number | undefined => (v === null ? undefined : v);
  // Total equity the engine REFUSED as the company's equity (it excludes a
  // refused year's result — critic round 2, 2026-09-27) stays ABSENT: the
  // dashboard resolver divided the rows' short sum into an equity ratio
  // (0.4925) and debt / equity (0.4515) on the real developer without 121.
  const equityRefused = equityRefusalOf(statements) !== null;
  return {
    // ── Income statement ──────────────────────────────────────
    revenue: levels.turnover,
    grossProfit: present(t.grossProfit),
    cogs: is.costOfGoodsSold,
    opex: is.operatingExpenses,
    depreciation: is.depreciationAmortization,
    amortization: 0,
    // R2 (2026-09-28): the served P&L chain — D&A without the ruled
    // charges, and their net with the ruled reversals, outside EBITDA.
    plDepreciation: finite(statements.assembled_pl?.depreciation),
    netProvisions: readNetProvisions(statements.assembled_pl)?.value,
    ebitda: present(t.ebitda),
    ebit: present(t.ebit),
    netFinancialResult: t.netFinancialResult,
    interestExpense,
    incomeTax: is.taxExpense,
    netProfit: present(t.netIncome),
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
    shareholdersEquity: equityRefused ? undefined : t.totalEquity,
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
