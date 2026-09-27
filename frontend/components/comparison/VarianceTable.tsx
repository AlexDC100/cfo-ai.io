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
// kind="percent" change> so the one classifier (lib/changeKind.ts,
// plan_contract_v2 section 7) decides: a same-sign change renders its
// percent (a large one as a signed multiplier), and a change from zero,
// to zero or across sign renders WORDS beside the absolute change — never
// a percent, never a multiplier (defect 0.4). Rows are 32px on hairline
// rules; total lines (emphasis) carry a double hairline above.

import { Amount } from "@/components/instrument/Amount";
import {
  MoneyAmount,
  MoneyAmountGroup,
  useDisplayMoney,
} from "@/components/comparison/MoneyAmount";
import type { Currency } from "@/lib/rates";
import type { Delta, DeltaSentiment } from "@/lib/learning/computeDeltas";
import { isWordKind } from "@/lib/changeKind";
import type { VarianceRow } from "@/lib/comparison/buildVariance";
import { cn } from "@/lib/utils";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";

export type VarianceView = "both" | "budget" | "last_year";

/** The actual EBITDA's two non-cash components, as served (one-EBITDA
 *  ruling, 2026-09-26): shown INSIDE the variance under the EBITDA row,
 *  actual only — the budget template is unchanged and carries neither. */
export interface ActualEbitdaComponents {
  inventoryVariation: number | null;
  capitalizedOwnWork: number | null;
  refusal: { readonly code: string; readonly text: { readonly ro: string; readonly en: string } } | null;
}

interface Props {
  rows: VarianceRow[];
  /** Net 711 and net 72x inside the actual EBITDA (and its refusal). */
  ebitdaComponents?: ActualEbitdaComponents | null;
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
  return "text-ink-soft";
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
  if (!d) return <span className="text-ink-soft">—</span>;
  return (
    <span className={cn("inline-flex flex-col items-end leading-tight", sentimentText(sentiment))}>
      <span className="text-[12px] font-medium">
        <MoneyAmount value={d.absolute} fromCurrency={currency as Currency} unit={false} signed />
      </span>
      {(d.pct !== null || (d.change !== null && isWordKind(d.change.kind))) && (
        <span className="text-[10.5px]">
          <Amount kind="percent" value={d.pct} change={d.change} />
        </span>
      )}
    </span>
  );
}

function Val({ v, currency, emphasis }: { v: number | null; currency: string; emphasis?: boolean }) {
  if (v === null) return <span className="text-ink-soft">—</span>;
  return (
    <MoneyAmount
      value={v}
      fromCurrency={currency as Currency}
      unit={false}
      className={emphasis ? "font-semibold text-ink" : "text-ink-soft"}
    />
  );
}

export function VarianceTable({ rows, ebitdaComponents = null, currency, view, hasBudget, hasLastYear }: Props) {
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
    // Sticky under the 56px app header — lg only: below lg the wrapper is
    // a horizontal scroller, which would become the sticky scrollport and
    // pin the header 56px INTO the panel at rest. Solid bg so scrolled
    // rows never show through.
    <div
      className="lg:sticky lg:top-14 z-10 grid gap-2 px-4 h-8 items-center border-b border-rule bg-surface text-[10.5px] uppercase tracking-[0.1em] text-ink-soft font-medium"
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
            <Fragment key={r.key}>
            <div
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
            {r.key === "ebitda" && ebitdaComponents && (
              <EbitdaComponentsRow c={ebitdaComponents} currency={currency} gridTemplate={gridTemplate} />
            )}
            </Fragment>
          ))}
        </div>
      </MoneyAmountGroup>
    </div>
  );
}

/** Under the ACTUAL EBITDA: the stock variation (711) and own work
 *  capitalised (72x) it includes, each signed as served — or the engine's
 *  refusal. Actual column only; budget / last-year cells stay empty on
 *  purpose (the template carries neither line). */
function EbitdaComponentsRow({
  c,
  currency,
  gridTemplate,
}: {
  c: ActualEbitdaComponents;
  currency: string;
  gridTemplate: string;
}) {
  const { i18n } = useTranslation();
  const ro = (i18n.language ?? "").toLowerCase().startsWith("ro");
  const parts: Array<{ key: string; label: string; v: number | null }> = [];
  if (c.inventoryVariation !== null && Math.abs(c.inventoryVariation) >= 0.005) {
    parts.push({ key: "inventory_variation", label: "Variația stocurilor de produse (711)", v: c.inventoryVariation });
  }
  if (c.capitalizedOwnWork !== null && Math.abs(c.capitalizedOwnWork) >= 0.005) {
    parts.push({
      key: "capitalized_own_work",
      label: ro ? "Producția imobilizată (72x)" : "Own work capitalised (72x)",
      v: c.capitalizedOwnWork,
    });
  }
  if (!c.refusal && parts.length === 0) return null;
  return (
    <div
      data-testid="variance-ebitda-components"
      className="grid gap-2 items-start px-4 py-1 border-b border-rule-soft text-[11.5px] text-ink-soft"
      style={{ gridTemplateColumns: gridTemplate }}
    >
      {c.refusal ? (
        <div className="col-span-full">
          {ro ? `EBITDA refuzată: ${c.refusal.text.ro}` : `EBITDA refused: ${c.refusal.text.en}`}
        </div>
      ) : (
        <>
          <div className="truncate">{ro ? "din care, în EBITDA:" : "of which, inside EBITDA:"}</div>
          <div className="text-right space-y-0.5">
            {parts.map((p) => (
              <div key={p.key} data-testid={`variance-ebitda-component-${p.key}`}>
                <span className="mr-1">{p.label}</span>
                <MoneyAmount value={p.v} fromCurrency={currency as Currency} unit={false} signed />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
