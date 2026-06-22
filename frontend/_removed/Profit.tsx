// Profit — margin decomposition for the active period.
//
// Step 4 of FIX-NOW: refactored to read exclusively from useActivePeriod().
// The page mirrors Dashboard's revenue KPI (data-testid="kpi-revenue") so
// the architectural assertion "Profit revenue === Dashboard revenue" holds.
// Margin waterfall is computed from the same Statements object — no
// per-page parsing, no per-page mock fallback.
//
// When no period is loaded, renders the canonical empty-state CTA.

import { useMemo } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, FileText } from "lucide-react";
import { AppShell } from "@/components/cfo/AppShell";
import { useActivePeriod } from "@/lib/activePeriod";
import {
  computeRatios,
  deriveTotals,
  formatCurrency,
} from "@/lib/financialReport";

export default function Profit() {
  const period = useActivePeriod();

  if (!period.isLoaded || !period.statements) {
    return (
      <AppShell>
        <ProfitEmptyState />
      </AppShell>
    );
  }

  return (
    <AppShell>
      <ProfitLoaded statements={period.statements} />
    </AppShell>
  );
}

function ProfitEmptyState() {
  return (
    <section className="max-w-[680px] mx-auto py-16 text-center" data-testid="profit-empty">
      <div className="mx-auto h-14 w-14 rounded-2xl bg-bg-2 text-ink-mute flex items-center justify-center mb-4">
        <FileText size={22} strokeWidth={1.5} />
      </div>
      <h1 className="font-serif text-[34px] sm:text-[40px] leading-[1.1] tracking-[-0.02em] text-ink">
        No profit data yet
      </h1>
      <p className="mt-4 text-[15px] text-ink-soft max-w-[480px] mx-auto">
        Margin decomposition derives from a loaded P&L. Open Statements to load
        a sample or upload your own.
      </p>
      <Link
        to="/dashboard"
        className="mt-6 inline-flex items-center gap-2 h-11 px-5 rounded-lg bg-brand text-paper text-[14px] font-medium hover:bg-brand-d transition-colors"
      >
        Open Financial Statements
        <ArrowRight size={14} strokeWidth={2} />
      </Link>
    </section>
  );
}

function ProfitLoaded({ statements }: { statements: NonNullable<ReturnType<typeof useActivePeriod>["statements"]> }) {
  const totals = useMemo(() => deriveTotals(statements), [statements]);
  const ratios = useMemo(() => computeRatios(statements), [statements]);
  const cur = statements.currency;
  const is = statements.incomeStatement;

  // Margin waterfall steps. Each step is a deduction (or addition for
  // otherIncome) that walks Revenue → Net Income.
  const steps = [
    { label: "Revenue", value: is.revenue, kind: "in" as const },
    { label: "− COGS", value: -is.costOfGoodsSold, kind: "out" as const },
    { label: "= Gross profit", value: totals.grossProfit, kind: "subtotal" as const },
    { label: "− Operating expenses", value: -is.operatingExpenses, kind: "out" as const },
    { label: "+ Other income", value: is.otherIncome, kind: "in" as const },
    { label: "= EBITDA", value: totals.ebitda, kind: "subtotal" as const },
    { label: "− D&A", value: -is.depreciationAmortization, kind: "out" as const },
    { label: "= EBIT", value: totals.ebit, kind: "subtotal" as const },
    { label: "+ Net financial result", value: totals.netFinancialResult, kind: "in" as const },
    { label: "− Tax", value: -is.taxExpense, kind: "out" as const },
    { label: "= Net income", value: totals.netIncome, kind: "total" as const },
  ];

  const grossMargin = (totals.grossProfit / Math.max(is.revenue, 1)) * 100;
  const ebitdaMargin = (totals.ebitda / Math.max(is.revenue, 1)) * 100;
  const ebitMargin = (totals.ebit / Math.max(is.revenue, 1)) * 100;
  const netMargin = (totals.netIncome / Math.max(is.revenue, 1)) * 100;

  return (
    <div className="space-y-8">
      <header>
        <div className="label-eyebrow">Profit</div>
        <h1 className="mt-2 font-serif text-[36px] leading-[1.1] tracking-[-0.02em]">
          Margin decomposition
        </h1>
        <p className="mt-3 text-[14.5px] text-ink-soft max-w-[640px]">
          Revenue {formatCurrency(is.revenue, cur)} converts at {ebitdaMargin.toFixed(1)}% EBITDA → {netMargin.toFixed(1)}% net.
        </p>
      </header>

      {/* KPI row — Revenue must equal Dashboard's exactly (gate 4). */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi testId="kpi-revenue" label="Revenue" value={formatCurrency(is.revenue, cur)} />
        <Kpi testId="kpi-gross-margin" label="Gross margin" value={`${grossMargin.toFixed(1)}%`} sub={formatCurrency(totals.grossProfit, cur)} />
        <Kpi testId="kpi-ebitda-margin" label="EBITDA margin" value={`${ebitdaMargin.toFixed(1)}%`} sub={formatCurrency(totals.ebitda, cur)} />
        <Kpi testId="kpi-net-margin" label="Net margin" value={`${netMargin.toFixed(1)}%`} sub={formatCurrency(totals.netIncome, cur)} />
      </section>

      {/* Margin waterfall — one row per step, sign-coded. */}
      <section className="rounded-2xl border border-rule bg-surface overflow-hidden" data-testid="margin-waterfall">
        <div className="px-5 py-3 bg-bg-2/40 border-b border-rule">
          <h2 className="font-serif text-[18px] text-ink">Margin waterfall · {statements.periodLabel}</h2>
        </div>
        <table className="w-full text-[13.5px]">
          <tbody>
            {steps.map((s) => {
              const isSubtotal = s.kind === "subtotal" || s.kind === "total";
              const isTotal = s.kind === "total";
              return (
                <tr
                  key={s.label}
                  className={`${isTotal ? "border-y-2 border-ink/20 font-semibold" : isSubtotal ? "bg-bg-2/40 font-semibold" : "border-b border-rule"}`}
                >
                  <td className="py-2.5 px-5 text-ink">{s.label}</td>
                  <td className="py-2.5 px-5 text-right tabular-nums">
                    <span className={s.value < 0 ? "text-red-700" : isSubtotal ? "text-ink" : "text-ink"}>
                      {s.value < 0 ? `(${formatCurrency(Math.abs(s.value), cur)})` : formatCurrency(s.value, cur)}
                    </span>
                  </td>
                  <td className="py-2.5 px-5 text-right tabular-nums text-ink-soft text-[12px] w-24">
                    {is.revenue > 0 ? `${((s.value / is.revenue) * 100).toFixed(1)}%` : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {/* Profitability ratios — pulled from the same engine that powers
          the Statements Ratios tab so the numbers can never drift. */}
      <section className="rounded-2xl border border-rule bg-surface overflow-hidden">
        <div className="px-5 py-3 bg-bg-2/40 border-b border-rule">
          <h2 className="font-serif text-[18px] text-ink">Profitability ratios</h2>
        </div>
        <ul className="divide-y divide-rule/50">
          {ratios.profitability.map((r) => (
            <li key={r.key} className="px-5 py-3 flex items-center justify-between gap-4">
              <div>
                <div className="text-[13.5px] text-ink font-medium">{r.label}</div>
                <div className="text-[12px] text-ink-soft">{r.benchmark}</div>
              </div>
              <div className="text-right">
                <div className="font-serif text-[18px] text-ink">
                  {r.unit === "%" ? `${r.value.toFixed(1)}%` : r.unit === "x" ? `${r.value.toFixed(2)}×` : r.value.toFixed(2)}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/* Tail margin context */}
      <section className="text-[12px] text-ink-mute">
        Source: <Link to="/dashboard?tab=ratios" className="text-brand-d hover:text-brand">Statements · Ratios tab</Link>{" "}
        · EBIT margin {ebitMargin.toFixed(1)}% · Net financial result {formatCurrency(totals.netFinancialResult, cur)}.
      </section>
    </div>
  );
}

function Kpi({ testId, label, value, sub }: { testId: string; label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-rule bg-surface px-4 py-3" data-testid={testId}>
      <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium">{label}</div>
      <div className="mt-2 num-hero text-[30px] text-ink leading-none">{value}</div>
      {sub && <div className="mt-0.5 text-[11.5px] text-ink-soft">{sub}</div>}
    </div>
  );
}
