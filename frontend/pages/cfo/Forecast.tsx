// FORECAST — the driver-based linked three-statement projection, on screen.
//
// The engine for this shipped complete and UNREACHABLE. `engine/forecast`
// built the projection, `engine/forecast_serving` wrapped it in the fp1
// contract, `lib/forecastFacts.ts` read it and `components/forecast/
// ProjectedAmount.tsx` painted it — and no route mounted, no page existed,
// and no menu row pointed anywhere. The owner found it the only way an
// unreachable feature is ever found: by looking for it in the product and
// not seeing it.
//
// ── THE ONE THING THIS PAGE MUST NEVER DO ───────────────────────────────
//
// Let a reader mistake a projection for a fact. Every other surface in this
// product paints numbers that resolve to a cell in an uploaded book. This one
// paints numbers that resolve to ASSUMPTIONS, and the whole credibility of
// the engine rests on the reader never confusing the two.
//
// The distinction is carried by the DATA, not by this file's styling. A
// projected amount arrives as `ProjectedMinor`, an opaque type with no
// widening path to `number`, so `total + figure.amountMinor` does not
// compile and the value only comes out through `projectedDisplay`, which
// hands the consumer the marker in the same call. `<ProjectedAmount>` is that
// consumer. This page cannot paint a projected figure any other way, and it
// cannot paint one whose assumptions do not resolve — that renders an
// em-dash naming the refusal, never a zero.
//
// ── WHAT THE READER GETS, IN THIS ORDER ─────────────────────────────────
//
//   1. A standing banner: these are projections, here is the book they
//      stand on, here is the horizon. It is not dismissible.
//   2. The ASSUMPTION SCHEDULE, ABOVE the statements. Every driver, its
//      value, its unit, and the basis it was measured from — including the
//      ones the book could not measure, which state so in their own words.
//      Deliberately first: a reader who has not seen the assumptions is not
//      ready to read the numbers.
//   3. The three projected statements, period by period.
//   4. The balance check. A projected balance sheet that does not close is
//      a hard error, shown as one, with no tolerance band.
//
// ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────
//
// It does not compute. Not one number on this page is calculated in the
// browser: the engine projects in integer minor units through `mul_div` with
// half-away-from-zero rounding, precisely so that the balance check is exact,
// and a second opinion computed in IEEE-754 here would be a different model
// wearing the same labels.

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";

import { PageHeader as InstrumentPageHeader, Chip } from "@/components/instrument/Panel";
import { PageHeader } from "@/components/cfo/ui/PageHeader";
import { ProjectedAmount } from "@/components/forecast/ProjectedAmount";
import { useActivePeriod } from "@/lib/activePeriod";
import { cfoApi, FORECAST_HORIZONS, type ForecastHorizon } from "@/lib/cfoApi";
import {
  readProjection,
  type AssumptionRef,
  type ProjectionView,
} from "@/lib/forecastFacts";
import { useActiveLocale } from "@/lib/locale";

/** The statement blocks, in the order an accountant reads them. Line ids
 *  mirror `engine.forecast.project`'s `PL_LINES` / `LINES` / `CF_LINES`
 *  exactly; a line the engine stops projecting renders as its own refusal
 *  rather than vanishing, which is how a missing line stays visible. */
const BLOCKS: ReadonlyArray<{
  id: string;
  titleKey: string;
  fallback: string;
  lines: ReadonlyArray<{ line: string; label: string; strong?: boolean }>;
}> = [
  {
    id: "pl",
    titleKey: "forecast.block.pl",
    fallback: "Profit and loss",
    lines: [
      { line: "pl.revenue", label: "Revenue", strong: true },
      { line: "pl.cost_of_sales", label: "Cost of sales" },
      { line: "pl.operating_costs", label: "Operating costs" },
      { line: "pl.other_operating_income", label: "Other operating income" },
      { line: "pl.ebitda", label: "EBITDA", strong: true },
      { line: "pl.depreciation", label: "Depreciation" },
      { line: "pl.amortisation", label: "Amortisation" },
      { line: "pl.ebit", label: "EBIT", strong: true },
      { line: "pl.interest_expense_debt", label: "Interest on debt" },
      { line: "pl.interest_expense_funding_line", label: "Interest on the funding line" },
      { line: "pl.interest_income", label: "Interest income" },
      { line: "pl.other_financial_income", label: "Other financial income" },
      { line: "pl.other_financial_expense", label: "Other financial expense" },
      { line: "pl.pretax_result", label: "Pre-tax result", strong: true },
      { line: "pl.income_tax", label: "Income tax" },
      { line: "pl.net_income", label: "Net income", strong: true },
    ],
  },
  {
    id: "bs",
    titleKey: "forecast.block.bs",
    fallback: "Balance sheet",
    lines: [
      { line: "bs.cash", label: "Cash" },
      { line: "bs.ar", label: "Trade receivables" },
      { line: "bs.inventory", label: "Inventory" },
      { line: "bs.other_current_assets", label: "Other current assets" },
      { line: "bs.ppe_net", label: "Property, plant and equipment, net" },
      { line: "bs.intangibles_net", label: "Intangibles, net" },
      { line: "bs.investment_property", label: "Investment property" },
      { line: "bs.other_non_current_assets", label: "Other non-current assets" },
      { line: "bs_totals.assets", label: "Total assets", strong: true },
      { line: "bs.ap", label: "Trade payables" },
      { line: "bs.other_current_liabilities", label: "Other current liabilities" },
      { line: "bs.st_debt", label: "Short-term debt" },
      { line: "bs.revolver", label: "Funding line" },
      { line: "bs.lt_debt", label: "Long-term debt" },
      { line: "bs.other_non_current_liabilities", label: "Other non-current liabilities" },
      { line: "bs.equity_contributed", label: "Contributed capital" },
      { line: "bs.equity_reserves", label: "Reserves" },
      { line: "bs.equity_retained", label: "Retained result" },
      { line: "bs.equity_other", label: "Other equity" },
      { line: "bs_totals.equity_plus_liabilities", label: "Total equity and liabilities", strong: true },
    ],
  },
  {
    id: "cf",
    titleKey: "forecast.block.cf",
    fallback: "Cash flow",
    lines: [
      { line: "cf.net_income", label: "Net income" },
      { line: "cf.depreciation", label: "Depreciation" },
      { line: "cf.amortisation", label: "Amortisation" },
      { line: "cf.change_in_receivables", label: "Change in receivables" },
      { line: "cf.change_in_inventory", label: "Change in inventory" },
      { line: "cf.change_in_payables", label: "Change in payables" },
      { line: "cf.cash_from_operating", label: "Cash from operating", strong: true },
      { line: "cf.capital_expenditure", label: "Capital expenditure" },
      { line: "cf.intangible_additions", label: "Intangible additions" },
      { line: "cf.cash_from_investing", label: "Cash from investing", strong: true },
      { line: "cf.debt_drawdowns", label: "Debt drawdowns" },
      { line: "cf.debt_repayments", label: "Debt repayments" },
      { line: "cf.dividends_paid", label: "Dividends paid" },
      { line: "cf.funding_line_movement", label: "Funding line movement" },
      { line: "cf.cash_from_financing", label: "Cash from financing", strong: true },
      { line: "cf.net_change_in_cash", label: "Net change in cash" },
      { line: "cf.closing_cash", label: "Closing cash", strong: true },
    ],
  },
];

/** A driver's value, in its own unit.
 *
 *  Absent renders as the WORDS, never as a zero: a rate the book could not
 *  measure and a rate of 0% are opposite claims, and the driver's own basis
 *  says which one this is.
 *
 *  `valuedFor === null` is a THIRD state and it is not absence — it is the
 *  ref saying nobody asked it about a period. Rendering the absent label
 *  there would put "not measurable from this book" beside a driver supplied
 *  at 8%, which is what this page did until a test caught it. */
function assumptionValue(
  a: AssumptionRef,
  locale: string,
  absentLabel: string,
): string {
  if (a.unit === "convention") return "—";
  if (a.valuedFor === null) return "—";
  if (a.value === null || a.value === undefined) return absentLabel;
  const n = a.value;
  if (a.unit === "pct" || a.unit === "ratio") {
    return `${(n * 100).toLocaleString(locale, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 2,
    })}%`;
  }
  if (a.unit === "days") {
    return `${n.toLocaleString(locale, { maximumFractionDigits: 1 })}`;
  }
  if (a.unit === "money_minor") {
    return (n / 100).toLocaleString(locale, { maximumFractionDigits: 0 });
  }
  return n.toLocaleString(locale, { maximumFractionDigits: 0 });
}

function AssumptionSchedule({
  view,
  locale,
}: {
  view: ProjectionView;
  locale: string;
}) {
  const { t } = useTranslation();
  const firstPeriod = view.horizon[0] ?? "";
  const absent = t("forecast.absent", "not measurable from this book");
  return (
    <section
      data-testid="forecast-assumptions"
      className="rounded-xl border border-rule bg-surface"
    >
      <header className="border-b border-rule px-4 py-3">
        <h2 className="font-mono text-[11px] uppercase tracking-wider text-ink-mute">
          {t("forecast.assumptions.title", "Assumptions")}
        </h2>
        <p className="mt-1 text-[12px] leading-snug text-ink-soft">
          {t(
            "forecast.assumptions.lead",
            "Every number below this table is produced by these drivers. A driver the book could not measure states so in its own words — it is not held at zero.",
          )}
        </p>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-rule-soft text-left font-mono text-[10px] uppercase tracking-wider text-ink-mute">
              <th className="px-4 py-2">{t("forecast.assumptions.driver", "Driver")}</th>
              <th className="px-4 py-2 text-right">
                {t("forecast.assumptions.value", "Value")}
              </th>
              <th className="px-4 py-2">{t("forecast.assumptions.basis", "Basis")}</th>
            </tr>
          </thead>
          <tbody>
            {view.assumptionsFor(firstPeriod).map((a) => (
              <tr
                key={a.id}
                data-testid={`forecast-assumption-${a.id}`}
                data-assumption-unit={a.unit}
                className="border-b border-rule-soft/60 align-top last:border-0"
              >
                <td className="px-4 py-2 text-ink">{a.label || a.id}</td>
                <td className="px-4 py-2 text-right tabular-nums text-ink">
                  {assumptionValue(a, locale, absent)}
                </td>
                <td className="px-4 py-2 text-[12px] leading-snug text-ink-soft">
                  {a.basis}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-rule px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-ink-mute">
        {t("forecast.assumptions.asOf", "Valued for")} {firstPeriod}
      </p>
    </section>
  );
}

/** THE PROJECTION IS FORMATTED IN THE BOOK'S OWN CURRENCY, and the display
 *  toggle deliberately does not reach it.
 *
 *  That toggle converts SERVED actuals through a stated FX rate as at a
 *  stated date. Putting a five-year projection through it would price
 *  2030 revenue at today's rate — an exchange-rate assumption nobody
 *  declared, riding invisibly beside a table whose whole point is that
 *  every assumption behind every number is written down above it. The
 *  currency is shown as a chip instead, so the reader is told rather than
 *  silently converted. */
function makeFormatter(currency: string, locale: string) {
  const fmt = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currency || "RON",
    maximumFractionDigits: 0,
  });
  return (minor: number) => fmt.format(minor / 100);
}

function StatementBlock({
  view,
  block,
  format,
  projectedLabel,
}: {
  view: ProjectionView;
  block: (typeof BLOCKS)[number];
  format: (v: number) => string;
  projectedLabel: string;
}) {
  const { t } = useTranslation();
  return (
    <section
      data-testid={`forecast-block-${block.id}`}
      className="rounded-xl border border-rule bg-surface"
    >
      <header className="border-b border-rule px-4 py-3">
        <h2 className="font-mono text-[11px] uppercase tracking-wider text-ink-mute">
          {t(block.titleKey, block.fallback)}
        </h2>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-rule-soft text-left font-mono text-[10px] uppercase tracking-wider text-ink-mute">
              <th className="sticky left-0 bg-surface px-4 py-2">
                {t("forecast.line", "Line")}
              </th>
              {view.horizon.map((period) => (
                <th key={period} className="px-4 py-2 text-right">
                  {period}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.lines.map((row) => (
              <tr
                key={row.line}
                data-testid={`forecast-row-${row.line}`}
                className="border-b border-rule-soft/60 last:border-0"
              >
                <td
                  className={`sticky left-0 bg-surface px-4 py-1.5 ${
                    row.strong ? "font-medium text-ink" : "text-ink-soft"
                  }`}
                >
                  {row.label}
                </td>
                {view.horizon.map((period) => (
                  <td
                    key={period}
                    className="px-4 py-1.5 text-right tabular-nums"
                  >
                    <ProjectedAmount
                      figure={view.figure(row.line, period)}
                      basePeriodLabel={view.basePeriodLabel}
                      format={format}
                      projectedLabel={projectedLabel}
                      className={
                        row.strong
                          ? "font-medium text-ink"
                          : "text-ink-soft"
                      }
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function BalanceCheck({ view }: { view: ProjectionView }) {
  const { t } = useTranslation();
  const broken = view.unbalancedPeriods.length > 0;
  return (
    <section
      data-testid="forecast-balance-check"
      data-balances={broken ? "false" : "true"}
      className={`rounded-xl border px-4 py-3 text-[13px] ${
        broken
          ? "border-danger/40 bg-danger/5 text-danger"
          : "border-rule bg-surface text-ink-soft"
      }`}
    >
      {broken
        ? t(
            "forecast.balance.broken",
            "The projected balance sheet does not close in: {{periods}}. This is a hard error, not a rounding note — the projection is built in integer minor units so the check is exact.",
            { periods: view.unbalancedPeriods.join(", ") },
          )
        : t(
            "forecast.balance.ok",
            "Every projected period balances to the cent. The check is exact, not a tolerance band.",
          )}
    </section>
  );
}

export default function Forecast() {
  const { t } = useTranslation();
  const locale = useActiveLocale();
  const period = useActivePeriod();
  const [horizon, setHorizon] = useState<ForecastHorizon>(5);

  const query = useQuery({
    queryKey: ["forecast", period.id, horizon],
    queryFn: () => cfoApi.forecast(period.id as string, horizon),
    enabled: !!period.id,
    // A projection is deterministic in its inputs: same book, same horizon,
    // same bytes. Refetching on focus would spend a request to be told the
    // same thing.
    refetchOnWindowFocus: false,
    retry: false,
  });

  const view = useMemo(() => {
    if (!query.data) return null;
    try {
      return readProjection(query.data);
    } catch (err) {
      // A payload claiming to be a projection and breaking its own contract
      // is a producer defect. It must not paint half a projection.
      return { error: err instanceof Error ? err.message : String(err) } as const;
    }
  }, [query.data]);

  if (!period.id) {
    return (
      <PageHeader
        eyebrow={t("forecast.eyebrow", "Forecast")}
        title={t("forecast.empty.title", "Load a period to project from")}
        subtitle={t(
          "forecast.empty.subtitle",
          "A projection stands on one closing balance sheet and one profit and loss account. Upload or open a period and the forecast opens with it.",
        )}
      />
    );
  }

  const projectedLabel = t("forecast.projected", "projected");

  return (
    <div className="space-y-4 pb-16">
      <InstrumentPageHeader
        eyebrow={t("forecast.eyebrow", "Forecast")}
        title={t("forecast.title", "Projection")}
        actions={
          <div className="flex items-center gap-2" data-testid="forecast-horizon">
            {FORECAST_HORIZONS.map((h) => (
              <button
                key={h}
                type="button"
                onClick={() => setHorizon(h)}
                aria-pressed={h === horizon}
                data-testid={`forecast-horizon-${h}`}
                className={`rounded-md px-3 py-1 font-mono text-[11px] uppercase tracking-wider transition-colors ${
                  h === horizon
                    ? "bg-brand text-white"
                    : "border border-rule text-ink-mute hover:text-ink"
                }`}
              >
                {t("forecast.years", "{{count}} years", { count: h })}
              </button>
            ))}
          </div>
        }
      />

      {/* NOT DISMISSIBLE. The reader must be able to see, at any scroll
          position that shows a number, that the number is a projection. */}
      <div
        data-testid="forecast-banner"
        className="rounded-xl border border-amber/40 bg-amber/5 px-4 py-3 text-[13px] leading-snug text-ink"
      >
        <span className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">
          {t("forecast.banner.eyebrow", "Every figure on this page is a projection")}
        </span>
        <p className="mt-1 text-ink-soft">
          {t(
            "forecast.banner.body",
            "Nothing here comes out of a cell in your trial balance. Each number is produced by the assumptions listed below and by the closing position of {{period}}, which is the only actual figure this page stands on.",
            { period: period.label ?? "—" },
          )}
        </p>
      </div>

      {query.isPending ? (
        <p className="px-1 text-[13px] text-ink-mute" data-testid="forecast-loading">
          {t("forecast.loading", "Projecting…")}
        </p>
      ) : null}

      {query.isError ? (
        <div
          data-testid="forecast-refusal"
          className="rounded-xl border border-rule bg-surface px-4 py-3 text-[13px] leading-snug"
        >
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">
            {t("forecast.refused", "No projection")}
          </span>
          {/* THE ENGINE'S OWN SENTENCE, verbatim. It names the driver that
              could not be measured and the basis that failed to measure it,
              which is the only thing that tells the reader what to do next.
              It is never replaced with a generic message. */}
          <p className="mt-1 text-ink-soft" data-testid="forecast-refusal-detail">
            {(query.error as Error)?.message}
          </p>
        </div>
      ) : null}

      {view && "error" in view ? (
        <div
          data-testid="forecast-contract-error"
          className="rounded-xl border border-danger/40 bg-danger/5 px-4 py-3 text-[13px] text-danger"
        >
          {view.error}
        </div>
      ) : null}

      {view && !("error" in view) && view !== null ? (
        <ProjectionBody
          view={view}
          locale={locale}
          projectedLabel={projectedLabel}
        />
      ) : null}
    </div>
  );
}

function ProjectionBody({
  view,
  locale,
  projectedLabel,
}: {
  view: ProjectionView;
  locale: string;
  projectedLabel: string;
}) {
  const { t } = useTranslation();
  const format = useMemo(
    () => makeFormatter(view.currency, locale),
    [view.currency, locale],
  );
  return (
    <>
          <div
            className="flex flex-wrap items-center gap-2"
            data-testid="forecast-provenance"
          >
            <Chip>
              {t("forecast.basePeriod", "Stands on")} {view.basePeriodLabel}
            </Chip>
            <Chip>{view.currency}</Chip>
            <Chip>
              {view.horizon.length} {t("forecast.periods", "periods")}
            </Chip>
          </div>
          <AssumptionSchedule view={view} locale={locale} />
          {BLOCKS.map((block) => (
            <StatementBlock
              key={block.id}
              view={view}
              block={block}
              format={format}
              projectedLabel={projectedLabel}
            />
          ))}
      <BalanceCheck view={view} />
    </>
  );
}
