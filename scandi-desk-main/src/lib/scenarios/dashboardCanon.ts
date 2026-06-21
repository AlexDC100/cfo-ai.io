// F6.0.5 (2026-06-20, review #1/#2/#3) — Dashboard-canonical value resolver.
//
// THE single source of the four headline numbers the dashboard KPI tiles
// render: operating revenue, statutory EBITDA, statutory net profit, total
// debt. The scenario baseline MUST tie to these exact values at zero
// adjustments, and the adversarial review caught that the scenario was
// re-deriving them from a DIFFERENT path (engine `assembled_pl.*` canonical)
// than the dashboard tile (the FE P&L builder `pl.sections[0].subtotalAmount`
// + the `net_income_statutory` metric row). They diverged by the 767/708
// wedge (~22k RON on EEI) — Revenue appeared to change with no input.
//
// This helper replicates the dashboard's EXACT derivation (FinancialStatements
// .tsx ~lines 902-1002) so the scenario page and the dashboard share one
// computation. Mirror any future change to the tile derivation here (and vice
// versa); ideally FinancialStatements is refactored to call this too.

import { deriveTotals, type Statements } from "@/lib/financialReport";
import { pickPLBuilder } from "@/lib/buildPlStatement";
import type { PeriodLineItem, PeriodMetric } from "@/lib/activePeriod";

export interface DashboardCanonical {
  operatingRevenue: number;
  ebitda: number;
  netProfit: number;
  totalDebt: number;
}

export function buildDashboardCanonical(
  statements: Statements,
  lineItems: PeriodLineItem[],
  metricRows: PeriodMetric[],
): DashboardCanonical {
  const totals = deriveTotals(statements);

  // Same FE P&L builder + inputs the dashboard tile uses (canonicalMargins is
  // display-only and does not change the absolute subtotals, so it's omitted).
  const pl = pickPLBuilder(
    {
      lineItems,
      entity: statements.companyName ?? "Entity",
      period: statements.periodLabel,
      currency: statements.currency,
    },
    statements,
  );

  const operatingRevenue =
    pl.sections[0]?.subtotalAmount ?? statements.incomeStatement.revenue;

  const ap = (statements as Statements & { assembled_pl?: Record<string, number> })
    .assembled_pl;

  // EBITDA tile: engine `ebitda_statutory` when present, else FE operating
  // view `pl.ebitda` — identical ladder to FinancialStatements.tsx:979-983.
  const ebitda =
    typeof ap?.ebitda_statutory === "number" ? ap.ebitda_statutory : pl.ebitda;

  // Net profit tile: `net_income_statutory` metric row → pl.netProfitStatutory
  // → pl.netProfit — identical ladder to FinancialStatements.tsx:994-1002.
  const niStatRow = metricRows.find((m) => m.name === "net_income_statutory");
  const netProfit =
    typeof niStatRow?.value === "number"
      ? niStatRow.value
      : typeof pl.netProfitStatutory === "number"
        ? pl.netProfitStatutory
        : pl.netProfit;

  return { operatingRevenue, ebitda, netProfit, totalDebt: totals.totalDebt };
}
