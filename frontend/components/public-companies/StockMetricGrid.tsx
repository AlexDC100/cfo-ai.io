// StockMetricGrid — three-group metric block for the StockDetailDrawer.
//
// PUB-200 spec §13: Market / Financial / Quality groups. Missing values
// render as em-dash (never fake zero). Money cells use the Money
// primitive so the active currency flows through automatically.

import { Money } from "@/components/ui/Money";
import type { Currency } from "@/lib/rates";

import type { PublicCompanyFinancialSnapshot } from "@/lib/publicCompanyUniverse";
import { snapshotCurrency } from "@/lib/publicCompanyUniverse";

interface Props {
  snapshot: PublicCompanyFinancialSnapshot | null;
}

const DASH = "—";

function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !isFinite(v)) return DASH;
  return `${v.toFixed(digits)}%`;
}

function fmtMult(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !isFinite(v)) return DASH;
  return `${v.toFixed(digits)}x`;
}

function MoneyOrDash({
  amount,
  fromCurrency,
}: {
  amount: number | null | undefined;
  fromCurrency: Currency;
}) {
  if (amount === null || amount === undefined || !isFinite(amount)) {
    return <span className="text-ink-mute">{DASH}</span>;
  }
  return <Money value={amount} fromCurrency={fromCurrency} compact />;
}

interface RowSpec {
  label: string;
  render: (snap: PublicCompanyFinancialSnapshot, currency: Currency) => React.ReactNode;
}

const MARKET_ROWS: RowSpec[] = [
  { label: "Market Cap", render: (s, c) => <MoneyOrDash amount={s.marketCap} fromCurrency={c} /> },
  { label: "Enterprise Value", render: (s, c) => <MoneyOrDash amount={s.enterpriseValue} fromCurrency={c} /> },
  { label: "P/E", render: (s) => fmtMult(s.peRatio) },
  { label: "EV / EBITDA", render: (s) => fmtMult(s.evToEbitda) },
  { label: "FCF Yield", render: (s) => fmtPct(s.fcfYield) },
  { label: "Dividend Yield", render: (s) => fmtPct(s.dividendYield, 2) },
];

const FINANCIAL_ROWS: RowSpec[] = [
  { label: "Revenue", render: (s, c) => <MoneyOrDash amount={s.revenue} fromCurrency={c} /> },
  { label: "Revenue Growth", render: (s) => fmtPct(s.revenueGrowth) },
  { label: "EBITDA Margin", render: (s) => fmtPct(s.ebitdaMargin) },
  { label: "Net Margin", render: (s) => fmtPct(s.netMargin) },
  { label: "Free Cash Flow", render: (s, c) => <MoneyOrDash amount={s.freeCashFlow} fromCurrency={c} /> },
  { label: "Net Debt / EBITDA", render: (s) => fmtMult(s.netDebtToEbitda, 2) },
];

const QUALITY_ROWS: RowSpec[] = [
  { label: "ROE", render: (s) => fmtPct(s.roe) },
  { label: "ROA", render: (s) => fmtPct(s.roa) },
  { label: "ROIC", render: (s) => fmtPct(s.roic) },
  { label: "Gross Margin", render: (s) => fmtPct(s.grossMargin) },
  { label: "Debt / Equity", render: (s) => fmtMult(s.debtToEquity, 2) },
  { label: "Current Ratio", render: (s) => fmtMult(s.currentRatio, 2) },
];

function MetricGroup({
  title,
  rows,
  snapshot,
  currency,
}: {
  title: string;
  rows: RowSpec[];
  snapshot: PublicCompanyFinancialSnapshot;
  currency: Currency;
}) {
  return (
    <div data-testid={`metric-group-${title.toLowerCase()}`}>
      <h3 className="
        text-[10px] uppercase tracking-[0.08em] font-semibold
        text-ink-mute mb-2
      ">
        {title}
      </h3>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
        {rows.map(({ label, render }) => (
          <div
            key={label}
            className="flex items-baseline justify-between gap-2 text-[12px]"
          >
            <span className="text-ink-soft">{label}</span>
            <span className="text-ink font-medium tabular-nums text-right">
              {render(snapshot, currency)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function StockMetricGrid({ snapshot }: Props) {
  if (!snapshot) {
    return (
      <div className="text-[12px] text-ink-mute italic px-3 py-6">
        No metrics available for this ticker.
      </div>
    );
  }
  const currency = snapshotCurrency(snapshot);
  return (
    <div data-testid="stock-metric-grid" className="space-y-5">
      <MetricGroup title="Market" rows={MARKET_ROWS} snapshot={snapshot} currency={currency} />
      <MetricGroup title="Financial" rows={FINANCIAL_ROWS} snapshot={snapshot} currency={currency} />
      <MetricGroup title="Quality" rows={QUALITY_ROWS} snapshot={snapshot} currency={currency} />
    </div>
  );
}
