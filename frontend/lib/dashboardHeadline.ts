// THE DASHBOARD'S HEADLINE FIGURES — one computation, two surfaces.
//
// The dashboard's four key-metric cards (operating revenue, EBITDA, net
// profit, cash) and the Forecast page's YEAR 0 read this ONE function over the
// SAME served period payload (`GET /api/period/{id}`, shared through the
// `useActivePeriod` query cache). Until forecast-scenarios-live the dashboard
// computed these inline in `pages/cfo/FinancialStatements.tsx`; they were
// hoisted here unchanged so the forecast's year 0 cannot be a second opinion
// about the actuals it stands on (owner gate F1: "year 0 of the forecast
// equals the latest actuals shown on the dashboard, same served-figures
// authority").
//
// Every expression below is the dashboard's, verbatim:
//   · operating revenue — the P&L builder's first section subtotal (net
//     turnover since the one-EBITDA ruling), else the statement's revenue;
//   · EBITDA — `assembled_pl.ebitda_statutory` (an alias of the one EBITDA)
//     first, the P&L statement's served figure next; a refused EBITDA stays
//     null with its reason (`tileEbitdaRefusal`);
//   · net profit — `resolveHeadlineNetProfit`, the one seam that figure is
//     decided at (account 121 first);
//   · cash — the served balance sheet's cash.
// NOTHING here is a projection, and nothing here imports the projection
// namespace (scripts/check_forecast_boundary.mjs keeps actuals and
// projections apart).

import { pickPLBuilder } from "@/lib/buildPlStatement";
import { resolveHeadlineNetProfit } from "@/lib/headlineFigures";
import type { PeriodLineItem, PeriodMetric } from "@/lib/activePeriod";
import type { Statements } from "@/lib/financialReport";
import type { ServedRefusal } from "@/lib/servedOneEbitda";

export interface CanonicalMargins {
  ebitdaMargin: number | null;
  netMargin: number | null;
}

/** The engine-canonical margin pair the dashboard hands the P&L builder,
 *  read off the persisted metric rows exactly as the dashboard reads it. */
export function canonicalMarginsFrom(metrics: readonly PeriodMetric[]): CanonicalMargins {
  const ebitdaRow = metrics.find((mt) => mt.name === "ebitda_margin");
  const netRow = metrics.find((mt) => mt.name === "net_margin");
  return {
    ebitdaMargin: typeof ebitdaRow?.value === "number" ? ebitdaRow.value : null,
    netMargin: typeof netRow?.value === "number" ? netRow.value : null,
  };
}

export interface DashboardHeadline {
  /** Net turnover (cifra de afaceri netă) — the P&L's first subtotal. The
   *  name predates the one-EBITDA ruling; the figure is turnover only. */
  totalOperatingRevenue: number;
  /** THE ONE EBITDA as served; null when the engine REFUSED it (the stock
   *  variation could not be measured) — then `tileEbitdaRefusal` says why.
   *  Never a zero, never an EBITDA rebuilt without 711. */
  tileEbitdaRon: number | null;
  tileEbitdaRefusal: ServedRefusal | null;
  tileNetProfitRon: number;
  /** The P&L builder's "Total operating expenses" subtotal; null when
   *  the builder produced no such section (absent is not zero). */
  totalOperatingExpenses: number | null;
  /** The served balance sheet's cash, as the cash card prints it. */
  cash: number;
  pl: ReturnType<typeof pickPLBuilder>;
}

export function computeDashboardHeadline(args: {
  statements: Statements;
  lineItems: PeriodLineItem[];
  metrics: readonly PeriodMetric[];
  entity: string;
  canonicalMargins: CanonicalMargins;
}): DashboardHeadline {
  const { statements, lineItems, metrics, entity, canonicalMargins } = args;
  const pl = pickPLBuilder(
    {
      lineItems,
      entity: statements.companyName ?? entity,
      period: statements.periodLabel,
      currency: statements.currency,
      canonicalMargins,
    },
    statements,
  );
  const totalOperatingRevenue =
    pl.sections[0]?.subtotalAmount ?? statements.incomeStatement.revenue;
  const tileEbitdaCanonical =
    typeof statements.assembled_pl?.ebitda_statutory === "number"
      ? statements.assembled_pl.ebitda_statutory
      : null;
  // `ebitda_statutory` is an alias of the one EBITDA (null when refused);
  // the statement carries the same served figure, or the refusal.
  const tileEbitdaRon = tileEbitdaCanonical ?? pl.ebitda;
  const tileEbitdaRefusal = tileEbitdaRon === null ? pl.ebitdaRefusal ?? null : null;
  const tileNetProfitRon = resolveHeadlineNetProfit(statements, metrics as PeriodMetric[], pl);
  const totalOperatingExpenses =
    pl.sections.find((s) => s.subtotalLabel?.startsWith("Total operating expenses"))
      ?.subtotalAmount ?? null;
  return {
    totalOperatingRevenue,
    tileEbitdaRon,
    tileEbitdaRefusal,
    tileNetProfitRon,
    totalOperatingExpenses,
    cash: statements.balanceSheet.cash,
    pl,
  };
}
