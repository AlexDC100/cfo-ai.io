// Cash — working-capital command center for the active period.
//
// Step 4 of FIX-NOW: refactored to read exclusively from useActivePeriod().
// Cash trapped (kpi-cash-trapped testid for the gate) is the working
// capital absorbed in receivables + inventory minus payables — i.e. the
// cash the business has financed instead of holding. Cash position,
// runway, and CCC come from the same Statements engine that powers
// Dashboard + Statements so values can't drift between pages.

import { useMemo } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, FileText } from "lucide-react";
import { AppShell } from "@/components/cfo/AppShell";
import { useActivePeriod } from "@/lib/activePeriod";
import {
  computeRatios,
  deriveTotals,
  formatCurrency,
  type Statements,
} from "@/lib/financialReport";
import { deriveCashFlow } from "@/lib/financialValuation";

export default function Cash() {
  const period = useActivePeriod();
  if (!period.isLoaded || !period.statements) {
    return (
      <AppShell>
        <CashEmptyState />
      </AppShell>
    );
  }
  return (
    <AppShell>
      <CashLoaded statements={period.statements} />
    </AppShell>
  );
}

function CashEmptyState() {
  return (
    <section className="max-w-[680px] mx-auto py-16 text-center" data-testid="cash-empty">
      <div className="mx-auto h-14 w-14 rounded-2xl bg-bg-2 text-ink-mute flex items-center justify-center mb-4">
        <FileText size={22} strokeWidth={1.5} />
      </div>
      <h1 className="font-serif text-[34px] sm:text-[40px] leading-[1.1] tracking-[-0.02em] text-ink">
        No cash data yet
      </h1>
      <p className="mt-4 text-[15px] text-ink-soft max-w-[480px] mx-auto">
        Working capital, cash conversion cycle, and runway derive from a loaded
        balance sheet. Open Statements to load a sample or upload your own.
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

function CashLoaded({ statements }: { statements: Statements }) {
  const totals = useMemo(() => deriveTotals(statements), [statements]);
  const ratios = useMemo(() => computeRatios(statements), [statements]);
  const cashFlow = useMemo(() => deriveCashFlow(statements), [statements]);
  const cur = statements.currency;
  const bs = statements.balanceSheet;

  // Cash trapped = working capital absorbed in operating cycle (AR + Inventory − AP).
  // This is what's financed by the business itself, separate from cash on hand.
  const cashTrapped = bs.accountsReceivable + bs.inventory - bs.accountsPayable;

  const dso = ratios.efficiency.find((r) => r.key === "dso");
  const dio = ratios.efficiency.find((r) => r.key === "dio");
  const dpo = ratios.efficiency.find((r) => r.key === "dpo");
  const ccc = ratios.efficiency.find((r) => r.key === "ccc");
  const monthlyOutflow = (statements.incomeStatement.operatingExpenses + statements.incomeStatement.interestExpense) / 12;
  const runwayMonths = monthlyOutflow > 0 ? bs.cash / monthlyOutflow : 0;

  return (
    <div className="space-y-8">
      <header>
        <div className="label-eyebrow">Cash</div>
        <h1 className="mt-2 font-serif text-[36px] leading-[1.1] tracking-[-0.02em]">
          Working capital · cash conversion
        </h1>
        <p className="mt-3 text-[14.5px] text-ink-soft max-w-[640px]">
          {formatCurrency(bs.cash, cur)} on hand, {runwayMonths >= 60 ? "ample runway" : `${runwayMonths.toFixed(0)}-month runway`}.
          {" "}{formatCurrency(cashTrapped, cur)} financed in working capital.
        </p>
      </header>

      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi testId="kpi-cash" label="Cash position" value={formatCurrency(bs.cash, cur)} sub={`${runwayMonths.toFixed(0)} mo runway`} />
        <Kpi testId="kpi-cash-trapped" label="Cash trapped" value={formatCurrency(cashTrapped, cur)} sub="In AR + inventory − AP" />
        <Kpi testId="kpi-fcf" label="Free cash flow" value={formatCurrency(cashFlow.fcf, cur)} sub={`${((cashFlow.fcf / Math.max(statements.incomeStatement.revenue, 1)) * 100).toFixed(0)}% of revenue`} />
        <Kpi testId="kpi-ccc" label="Cash conversion cycle" value={ccc ? `${ccc.value.toFixed(0)} days` : "—"} sub={ccc?.benchmark} />
      </section>

      {/* Working capital decomposition */}
      <section className="rounded-2xl border border-rule bg-surface overflow-hidden">
        <div className="px-5 py-3 bg-bg-2/40 border-b border-rule">
          <h2 className="font-serif text-[18px] text-ink">Working capital decomposition</h2>
        </div>
        <table className="w-full text-[13.5px]">
          <tbody>
            <Row label="Accounts receivable" value={bs.accountsReceivable} cur={cur} kind="add" />
            <Row label="Inventory" value={bs.inventory} cur={cur} kind="add" />
            <Row label="Accounts payable" value={-bs.accountsPayable} cur={cur} kind="sub" />
            <Row label="= Net working capital" value={cashTrapped} cur={cur} kind="total" />
          </tbody>
        </table>
      </section>

      {/* Cash conversion cycle breakdown */}
      <section className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <CycleTile label="DSO" subtitle="Days sales outstanding" value={dso ? `${dso.value.toFixed(0)} days` : "—"} commentary={dso?.commentary} />
        <CycleTile label="DIO" subtitle="Days inventory outstanding" value={dio ? `${dio.value.toFixed(0)} days` : "—"} commentary={dio?.commentary} />
        <CycleTile label="DPO" subtitle="Days payables outstanding" value={dpo ? `${dpo.value.toFixed(0)} days` : "—"} commentary={dpo?.commentary} />
      </section>

      {/* Cash flow snapshot */}
      <section className="rounded-2xl border border-rule bg-surface overflow-hidden">
        <div className="px-5 py-3 bg-bg-2/40 border-b border-rule">
          <h2 className="font-serif text-[18px] text-ink">Cash flow (derived)</h2>
        </div>
        <table className="w-full text-[13.5px]">
          <tbody>
            <Row label="Net income" value={cashFlow.netIncome} cur={cur} kind="add" />
            <Row label="+ D&A" value={cashFlow.depreciationAmortization} cur={cur} kind="add" />
            <Row label="− ΔWorking capital" value={-cashFlow.workingCapitalChange} cur={cur} kind="sub" />
            <Row label="= Cash from operations" value={cashFlow.cfo} cur={cur} kind="subtotal" />
            <Row label="− Capex" value={-cashFlow.capex} cur={cur} kind="sub" />
            <Row label="= Free cash flow" value={cashFlow.fcf} cur={cur} kind="total" />
          </tbody>
        </table>
      </section>

      <section className="text-[12px] text-ink-mute">
        Source: <Link to="/dashboard?tab=ratios" className="text-brand-d hover:text-brand">Statements · Ratios tab</Link>{" "}
        · Cash flow derived from BS + P&L (indirect method).
      </section>
    </div>
  );
}

function Kpi({ testId, label, value, sub }: { testId: string; label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-rule bg-surface px-4 py-3" data-testid={testId}>
      <div className="text-[10.5px] uppercase tracking-[0.12em] text-ink-mute font-medium">{label}</div>
      <div className="mt-1.5 font-serif text-[22px] text-ink leading-tight">{value}</div>
      {sub && <div className="mt-0.5 text-[11.5px] text-ink-soft">{sub}</div>}
    </div>
  );
}

function CycleTile({ label, subtitle, value, commentary }: { label: string; subtitle: string; value: string; commentary?: string }) {
  return (
    <div className="rounded-xl border border-rule bg-surface px-4 py-4">
      <div className="text-[11px] uppercase tracking-[0.12em] text-ink-mute font-medium">{label}</div>
      <div className="text-[10.5px] text-ink-soft mt-0.5">{subtitle}</div>
      <div className="mt-2 font-serif text-[26px] text-ink leading-tight">{value}</div>
      {commentary && <p className="mt-2 text-[12px] text-ink-soft leading-snug">{commentary}</p>}
    </div>
  );
}

function Row({
  label,
  value,
  cur,
  kind,
}: {
  label: string;
  value: number;
  cur: string;
  kind: "add" | "sub" | "subtotal" | "total";
}) {
  const isSubtotal = kind === "subtotal" || kind === "total";
  const isTotal = kind === "total";
  return (
    <tr
      className={`${isTotal ? "border-y-2 border-ink/20 font-semibold" : isSubtotal ? "bg-bg-2/40 font-semibold" : "border-b border-rule"}`}
    >
      <td className="py-2.5 px-5 text-ink">{label}</td>
      <td className="py-2.5 px-5 text-right tabular-nums">
        <span className={value < 0 ? "text-red-700" : "text-ink"}>
          {value < 0 ? `(${formatCurrency(Math.abs(value), cur)})` : formatCurrency(value, cur)}
        </span>
      </td>
    </tr>
  );
}
