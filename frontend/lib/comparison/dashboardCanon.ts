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
import { plLevelsOf, type ServedRefusal } from "@/lib/servedOneEbitda";

export interface DashboardCanonical {
  /** Net turnover (70x − 709) — the dashboard's first P&L subtotal. */
  operatingRevenue: number;
  /** The one EBITDA as served; null when the engine refused it (never 0). */
  ebitda: number | null;
  /** Gross profit on the one definition (turnover − cost of sales ± net
   *  711), served; null when refused with EBITDA. */
  grossProfit: number | null;
  /** The two non-cash lines INSIDE EBITDA, as served: net 711 ("Variația
   *  stocurilor de produse") and net 72x; null when refused / not served. */
  inventoryVariation: number | null;
  capitalizedOwnWork: number | null;
  /** The engine's refusal of EBITDA, when it refused it. */
  ebitdaRefusal: ServedRefusal | null;
  /** True when the ENGINE assembled this period's P&L (`assembled_pl`): the
   *  levels above are its served figures, and so is `ebit`. */
  served: boolean;
  /** The operating result AS SERVED (`assembled_pl.ebit`) — never EBITDA
   *  less a D&A taken in the browser. null when the engine refused it, and
   *  on a payload the engine did not assemble (`served` false). */
  ebit: number | null;
  /** null when neither the metric row nor the statement states one. */
  netProfit: number | null;
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

  // EBITDA tile: THE ONE EBITDA as served (`plLevelsOf`), else — a payload
  // the engine did not assemble — the P&L statement's figure; null, never a
  // rebuilt EBITDA, when the engine refused it.
  void ap;
  const levels = plLevelsOf(statements);
  const ebitda = levels.source === "served" ? levels.ebitda : pl.ebitda;

  // Net profit tile: `net_income_statutory` metric row → pl.netProfitStatutory
  // → pl.netProfit — identical ladder to FinancialStatements.tsx:994-1002.
  const niStatRow = metricRows.find((m) => m.name === "net_income_statutory");
  const netProfit =
    typeof niStatRow?.value === "number"
      ? niStatRow.value
      : typeof pl.netProfitStatutory === "number"
        ? pl.netProfitStatutory
        : pl.netProfit;

  return {
    operatingRevenue,
    ebitda,
    grossProfit: levels.grossProfit,
    inventoryVariation: levels.source === "served" ? levels.inventoryVariation : null,
    capitalizedOwnWork: levels.source === "served" ? levels.capitalizedOwnWork : null,
    ebitdaRefusal: ebitda === null ? levels.refusal ?? pl.ebitdaRefusal ?? null : null,
    served: levels.source === "served",
    ebit: levels.source === "served" ? levels.ebit : null,
    netProfit,
    totalDebt: totals.totalDebt,
  };
}
