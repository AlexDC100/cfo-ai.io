// F6.0.1b (2026-06-21) — P&L variance table (Actual / Budget / Last Year).
//
// Modeled on the Scandia management pack: each P&L line shows Actual, Budget,
// Last Year, and the Δ vs each (absolute in the company currency + %). Δ is
// colored favorable / unfavorable using the line's higher-is-better
// convention (revenue/profit up = good; costs up = bad).
//
// Instrument pass (2026-08): one AmountGroup spans every money cell so the
// whole table shares a scale; the currency code lives once in the header
// strip instead of six times per row; deltas flow through <Amount
// kind="percent"> so an exploding % (near-zero base) renders as a signed
// multiplier, not "↓10834.3%". Rows are 32px on hairline rules; total
// lines (emphasis) carry a double hairline above.

import { Amount } from "@/components/instrument/Amount";
import {
  MoneyAmount,
  MoneyAmountGroup,
  useDisplayMoney,
} from "@/components/comparison/MoneyAmount";
import type { Currency } from "@/lib/rates";
import type { Delta, DeltaSentiment } from "@/lib/learning/computeDeltas";
import type { VarianceRow } from "@/lib/comparison/buildVariance";
import { cn } from "@/lib/utils";

export type VarianceView = "both" | "budget" | "last_year";

interface Props {
  rows: VarianceRow[];
  currency: string;
  view: VarianceView;
  hasBudget: boolean;
  hasLastYear: boolean;
}

function sentimentText(s: DeltaSentiment | null): string {
  // Favorable / unfavorable is the semantic verdict of a variance line;
  // these are the only colored cells in the table.
  if (s === "positive") return "text-success";
  if (s === "negative") return "text-alert";
  return "text-ink-mute";
}

function DeltaCell({
  d,
  sentiment,
  currency,
}: {
  d: Delta | null;
  sentiment: DeltaSentiment | null;
  currency: string;
}) {
  if (!d) return <span className="text-ink-mute">—</span>;
  return (
    <span className={cn("inline-flex flex-col items-end leading-tight", sentimentText(sentiment))}>
      <span className="text-[12px] font-medium">
        <MoneyAmount value={d.absolute} fromCurrency={currency as Currency} unit={false} signed />
      </span>
      {d.pct !== null && (
        <span className="text-[10.5px] opacity-80">
          <Amount kind="percent" value={d.pct} />
        </span>
      )}
    </span>
  );
}

function Val({ v, currency, emphasis }: { v: number | null; currency: string; emphasis?: boolean }) {
  if (v === null) return <span className="text-ink-mute">—</span>;
  return (
    <MoneyAmount
      value={v}
      fromCurrency={currency as Currency}
      unit={false}
      className={emphasis ? "font-semibold text-ink" : "text-ink-soft"}
    />
  );
}

export function VarianceTable({ rows, currency, view, hasBudget, hasLastYear }: Props) {
  const showBudget = view !== "last_year" && hasBudget;
  const showLastYear = view !== "budget" && hasLastYear;
  const { display } = useDisplayMoney();

  // Column template: Line | Actual | [Budget] | [Δ vs Bud] | [LY] | [Δ vs LY]
  const cols: string[] = ["minmax(150px,1.6fr)", "minmax(78px,1fr)"];
  if (showBudget) cols.push("minmax(78px,1fr)", "minmax(86px,1fr)");
  if (showLastYear) cols.push("minmax(78px,1fr)", "minmax(86px,1fr)");
  const gridTemplate = cols.join(" ");

  // One scale across every money cell in the table.
  const groupValues = rows.flatMap((r) => [
    r.actual,
    r.budget,
    r.lastYear,
    r.vsBudget?.absolute ?? null,
    r.vsLastYear?.absolute ?? null,
  ]);

  const Header = () => (
    // Sticky under the 56px app header. Solid bg so scrolled rows never
    // show through; sticking is inert on small screens where the wrapper
    // scrolls horizontally (overflow ancestors defeat sticky) — accepted.
    <div
      className="sticky top-14 z-10 grid gap-2 px-4 h-8 items-center border-b border-rule bg-surface text-[10.5px] uppercase tracking-[0.1em] text-ink-mute font-medium"
      style={{ gridTemplateColumns: gridTemplate }}
    >
      <div>P&amp;L line · {display}</div>
      <div className="text-right">Actual</div>
      {showBudget && <div className="text-right">Budget</div>}
      {showBudget && <div className="text-right">Δ vs Bud</div>}
      {showLastYear && <div className="text-right">Last year</div>}
      {showLastYear && <div className="text-right">Δ vs LY</div>}
    </div>
  );

  return (
    <div
      data-testid="variance-table"
      className="rounded-md border border-rule bg-surface overflow-x-auto lg:overflow-x-visible"
    >
      <MoneyAmountGroup values={groupValues} fromCurrency={currency as Currency}>
        <div className="min-w-[520px]">
          <Header />
          {rows.map((r) => (
            <div
              key={r.key}
              data-testid={`variance-row-${r.key}`}
              className={cn(
                "grid gap-2 items-center px-4 min-h-8 py-1 border-b border-rule-soft last:border-b-0",
                // Total lines: double hairline above, per the table spec.
                r.emphasis && "border-t-[3px] border-t-rule [border-top-style:double]",
              )}
              style={{ gridTemplateColumns: gridTemplate }}
            >
              <div className={cn("text-[12.5px] truncate", r.emphasis ? "font-semibold text-ink" : "text-ink")}>
                {r.label}
              </div>
              <div className="text-right text-[12.5px]">
                <Val v={r.actual} currency={currency} emphasis={r.emphasis} />
              </div>
              {showBudget && (
                <div className="text-right text-[12.5px]">
                  <Val v={r.budget} currency={currency} />
                </div>
              )}
              {showBudget && (
                <div className="text-right">
                  <DeltaCell d={r.vsBudget} sentiment={r.vsBudgetSentiment} currency={currency} />
                </div>
              )}
              {showLastYear && (
                <div className="text-right text-[12.5px]">
                  <Val v={r.lastYear} currency={currency} />
                </div>
              )}
              {showLastYear && (
                <div className="text-right">
                  <DeltaCell d={r.vsLastYear} sentiment={r.vsLastYearSentiment} currency={currency} />
                </div>
              )}
            </div>
          ))}
        </div>
      </MoneyAmountGroup>
    </div>
  );
}
