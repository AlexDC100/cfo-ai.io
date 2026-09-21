// THE SCENARIO OUTCOME — two served projections, placed side by side.
//
// plan/2 B13 (minimal cut). Every figure here is read out of an fp1.2
// response through `lib/forecastFacts` and painted through <ProjectedAmount>.
// The base column is one POST to /api/forecast/{id}/recompute, the template
// column is another. Nothing is computed between them: there is no delta
// column, because the engine does not serve one in this build (compare_base,
// plan_contract_v2 19.2, is not a landed want key) and a difference taken in
// the browser would be a second model wearing the engine's labels.
//
// ── CASH IS NEVER PAINTED BELOW ZERO ───────────────────────────────────
//
// The engine floors cash at min_cash and draws the funding line for every
// shortfall (6.4, S3). A served negative cash balance is therefore an engine
// defect, and the old page painted exactly that (defect 0.3: cash below zero
// with no funding line). If it ever arrives, the cash cell paints the
// funding line the engine served for that period, with a sentence saying why,
// and the chart is withheld — a negative cash point is never drawn.

import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { ProjectedAmount } from "@/components/forecast/ProjectedAmount";
import { CashCurveChart } from "@/components/forecast/ForecastCharts";
import {
  projectedSign,
  type ProjectedResult,
  type ProjectionView,
} from "@/lib/forecastFacts";
import { planYearLabels } from "@/lib/forecastLevers";

/** What one column of the comparison holds. A column is either a served
 *  projection, a refusal in the engine's own words, or still on its way —
 *  never a held projection from a different request. */
export type ColumnState =
  | { readonly kind: "ready"; readonly view: ProjectionView; readonly recomputing: boolean }
  | { readonly kind: "loading" }
  | { readonly kind: "refused"; readonly sentence: string }
  | { readonly kind: "contract"; readonly message: string };

export interface OutcomeColumn {
  readonly id: "base" | "template";
  readonly title: string;
  readonly state: ColumnState;
}

/** The rows, in the order a reader asks the question. Line ids are the
 *  engine's own (`engine.forecast.project`); each is served per period and as
 *  an FY aggregate of the monthly plan year (3.6), so a plan-year column is a
 *  SELECTION of served figures, never a sum.
 *
 *  `bs.revolver` is a BALANCE. Its FY aggregate is served with the formula
 *  "closing month": the funding line OUTSTANDING at the end of the plan year,
 *  not what was drawn during it. A line drawn in January and repaid by July
 *  closes the year at nil, and the row says "at year end" so that nil is not
 *  read as "never drawn" beside a peak the summary table serves. The engine
 *  serves no annual gross draw (`cf.funding_line_movement` is the net
 *  movement), and summing the months here would be a second model. */
const ROWS: ReadonlyArray<{ id: string; line: string; strong?: boolean; cash?: boolean }> = [
  { id: "revenue", line: "pl.revenue", strong: true },
  { id: "ebitda", line: "pl.ebitda", strong: true },
  { id: "net_income", line: "pl.net_income", strong: true },
  { id: "closing_cash", line: "bs.cash", cash: true },
  { id: "funding_line", line: "bs.revolver" },
  { id: "funding_interest", line: "pl.interest_expense_funding_line" },
];

/** The projection is formatted in the BOOK's own currency, exactly as the
 *  Forecast page does (see its `makeFormatter`): the display toggle converts
 *  served actuals at a stated rate and date, and pricing a projection through
 *  it would add an undeclared exchange-rate assumption. The value arrives in
 *  MAJOR units — `projectedDisplay` has already divided once. */
function useBookFormatter(currency: string, locale: string) {
  return useMemo(() => {
    const fmt = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: currency || "RON",
      maximumFractionDigits: 0,
    });
    return (value: number) => fmt.format(value);
  }, [currency, locale]);
}

function Figure({
  view,
  result,
  format,
  projectedLabel,
  strong,
}: {
  view: ProjectionView;
  result: ProjectedResult;
  format: (v: number) => string;
  projectedLabel: string;
  strong?: boolean;
}) {
  return (
    <ProjectedAmount
      figure={result}
      basePeriodLabel={view.basePeriodLabel}
      format={format}
      projectedLabel={projectedLabel}
      className={strong ? "font-medium text-ink" : "text-ink-soft"}
    />
  );
}

/** Closing cash for one period — or, if the engine ever served it below zero,
 *  the funding line it served instead. Never a negative cash figure. */
export function CashFigure({
  view,
  period,
  format,
  projectedLabel,
  testid,
}: {
  view: ProjectionView;
  period: string;
  format: (v: number) => string;
  projectedLabel: string;
  testid: string;
}) {
  const { t } = useTranslation();
  const cash = view.figure("bs.cash", period);
  if (projectedSign(cash) === -1) {
    return (
      <span
        data-testid={`${testid}-floored`}
        data-cash-floored="true"
        className="block text-left text-[11px] leading-snug text-alert"
      >
        {t(
          "scenarios.outcome.cashFloored",
          "The engine served cash below zero here, which it must not; cash is never shown below zero. The funding line balance it served at the close of this period:",
        )}{" "}
        <Figure
          view={view}
          result={view.figure("bs.revolver", period)}
          format={format}
          projectedLabel={projectedLabel}
        />
      </span>
    );
  }
  return (
    <Figure view={view} result={cash} format={format} projectedLabel={projectedLabel} />
  );
}

function StateCell({ state }: { state: ColumnState }) {
  const { t } = useTranslation();
  if (state.kind === "loading") {
    return (
      <span data-state="loading" className="text-ink-mute">
        {t("scenarios.outcome.cellLoading", "…")}
      </span>
    );
  }
  // A refused or broken column paints NO number: the sentence sits above the
  // table, and the cell is a dash naming the state.
  return (
    <span data-state={state.kind} className="text-ink-mute">
      —
    </span>
  );
}

function ColumnNotice({ column }: { column: OutcomeColumn }) {
  const { t } = useTranslation();
  if (column.state.kind === "refused") {
    return (
      <div
        data-testid={`scenarios-refusal-${column.id}`}
        className="rounded-xl border border-rule bg-surface px-4 py-3 text-[13px] leading-snug"
      >
        <span className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">
          {t("scenarios.outcome.refusedColumn", "{{name}}: no projection", {
            name: column.title,
          })}
        </span>
        {/* THE ENGINE'S OWN SENTENCE, verbatim. It names the lever and why the
            plan could not be built; it is never replaced with a generic line. */}
        <p
          className="mt-1 text-ink-soft"
          data-testid={`scenarios-refusal-${column.id}-sentence`}
        >
          {column.state.sentence}
        </p>
      </div>
    );
  }
  if (column.state.kind === "contract") {
    return (
      <div
        data-testid={`scenarios-contract-error-${column.id}`}
        className="rounded-xl border border-danger/40 bg-danger/5 px-4 py-3 text-[13px] text-danger"
      >
        {column.state.message}
      </div>
    );
  }
  if (column.state.kind === "ready" && column.state.view.refusal) {
    // 6.5: the engine served the plan up to the period the funding line could
    // not be priced in, and said so. Its sentence, verbatim.
    return (
      <div
        data-testid={`scenarios-partial-refusal-${column.id}`}
        className="rounded border border-rule bg-surface px-4 py-3 text-[13px] text-ink"
      >
        {column.title}: {column.state.view.refusal.sentence}
      </div>
    );
  }
  return null;
}

function SummaryRow({
  id,
  label,
  columns,
  render,
}: {
  id: string;
  label: string;
  columns: readonly OutcomeColumn[];
  render: (view: ProjectionView) => ReactNode;
}) {
  return (
    <tr data-testid={`scenarios-summary-${id}`} className="border-b border-rule-soft/60 last:border-0 align-top">
      <td className="sticky left-0 bg-surface px-4 py-2 text-ink-soft">{label}</td>
      {columns.map((c) => (
        <td
          key={c.id}
          data-testid={`scenarios-summary-${id}-${c.id}`}
          className="px-4 py-2 text-right tabular-nums"
        >
          {c.state.kind === "ready" ? render(c.state.view) : <StateCell state={c.state} />}
        </td>
      ))}
    </tr>
  );
}

export function ScenarioOutcome({
  columns,
  locale,
}: {
  columns: readonly OutcomeColumn[];
  locale: string;
}) {
  const { t } = useTranslation();
  const projectedLabel = t("forecast.projected", "projected");
  // The plan years come from the served horizon of the first column that has
  // one — the base, whenever it is served. Every column asks the engine for
  // the same horizon, and a label the other column does not carry is read as
  // the engine's own "outside the horizon" refusal, never filled in.
  const anchor = columns.find((c) => c.state.kind === "ready");
  const anchorView = anchor && anchor.state.kind === "ready" ? anchor.state.view : null;
  const format = useBookFormatter(anchorView?.currency ?? "", locale);
  if (!anchorView) {
    return (
      <div className="space-y-3">
        {columns.map((c) => (
          <ColumnNotice key={c.id} column={c} />
        ))}
        {columns.some((c) => c.state.kind === "loading") ? (
          <p className="px-1 text-[13px] text-ink-mute" data-testid="scenarios-loading">
            {t("scenarios.outcome.loading", "Projecting…")}
          </p>
        ) : null}
      </div>
    );
  }
  const years = planYearLabels(anchorView.horizon, anchorView.horizonAnnual);
  const serveDscr = columns.some(
    (c) => c.state.kind === "ready" && c.state.view.seriesKeys().includes("dscr"),
  );
  const cashChartColumn = [...columns].reverse().find((c) => c.state.kind === "ready");
  const chartView =
    cashChartColumn && cashChartColumn.state.kind === "ready"
      ? cashChartColumn.state.view
      : null;
  const chartHasNegativeCash = chartView
    ? chartView.series("closing_cash").some((p) => projectedSign(p.result) === -1)
    : false;

  return (
    <section data-testid="scenarios-outcome" className="space-y-3">
      {columns.map((c) => (
        <ColumnNotice key={c.id} column={c} />
      ))}

      <div className="rounded-xl border border-rule bg-surface">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-rule px-4 py-3">
          <div>
            <h2 className="font-mono text-[11px] uppercase tracking-wider text-ink-mute">
              {t("scenarios.outcome.title", "Outcome by plan year")}
            </h2>
            <p className="mt-1 text-[12px] leading-snug text-ink-soft">
              {t(
                "scenarios.outcome.lead",
                "Served figures from separate engine runs, placed side by side. No difference is computed on this page.",
              )}
            </p>
          </div>
          {columns.some((c) => c.state.kind === "ready" && c.state.recomputing) ? (
            <span
              data-testid="scenarios-recomputing"
              className="font-mono text-[10px] uppercase tracking-wider text-ink-mute"
            >
              {t("scenarios.outcome.recomputing", "Recomputing…")}
            </span>
          ) : null}
        </header>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]" data-testid="scenarios-outcome-table">
            <thead>
              <tr className="border-b border-rule-soft text-left font-mono text-[10px] uppercase tracking-wider text-ink-mute">
                <th className="sticky left-0 bg-surface px-4 py-2" rowSpan={columns.length > 1 ? 2 : 1}>
                  {t("scenarios.outcome.figure", "Figure")}
                </th>
                {years.map((year) => (
                  <th
                    key={year}
                    colSpan={columns.length}
                    className="px-4 py-2 text-right"
                  >
                    {year}
                  </th>
                ))}
              </tr>
              {columns.length > 1 ? (
                <tr className="border-b border-rule-soft font-mono text-[10px] uppercase tracking-wider text-ink-mute">
                  {years.map((year) =>
                    columns.map((c) => (
                      <th key={`${year}-${c.id}`} className="px-4 py-1.5 text-right font-normal">
                        {c.title}
                      </th>
                    )),
                  )}
                </tr>
              ) : null}
            </thead>
            <tbody>
              {ROWS.map((row) => (
                <tr
                  key={row.id}
                  data-testid={`scenarios-row-${row.id}`}
                  className="border-b border-rule-soft/60 last:border-0"
                >
                  <td
                    className={`sticky left-0 bg-surface px-4 py-1.5 ${
                      row.strong ? "font-medium text-ink" : "text-ink-soft"
                    }`}
                  >
                    {t(`scenarios.outcome.row.${row.id}`)}
                  </td>
                  {years.map((year) =>
                    columns.map((c) => {
                      const testid = `scenarios-cell-${c.id}-${row.id}-${year}`;
                      return (
                        <td
                          key={`${year}-${c.id}`}
                          data-testid={testid}
                          data-period={year}
                          data-line={row.line}
                          className="px-4 py-1.5 text-right tabular-nums"
                        >
                          {c.state.kind !== "ready" ? (
                            <StateCell state={c.state} />
                          ) : row.cash ? (
                            <CashFigure
                              view={c.state.view}
                              period={year}
                              format={format}
                              projectedLabel={projectedLabel}
                              testid={testid}
                            />
                          ) : (
                            <Figure
                              view={c.state.view}
                              result={c.state.view.figure(row.line, year)}
                              format={format}
                              projectedLabel={projectedLabel}
                              strong={row.strong}
                            />
                          )}
                        </td>
                      );
                    }),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-xl border border-rule bg-surface">
        <header className="border-b border-rule px-4 py-3">
          <h2 className="font-mono text-[11px] uppercase tracking-wider text-ink-mute">
            {t("scenarios.summary.title", "Funding line and cash floor, over the plan")}
          </h2>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]" data-testid="scenarios-summary-table">
            <thead>
              <tr className="border-b border-rule-soft text-left font-mono text-[10px] uppercase tracking-wider text-ink-mute">
                <th className="sticky left-0 bg-surface px-4 py-2">
                  {t("scenarios.outcome.figure", "Figure")}
                </th>
                {columns.map((c) => (
                  <th key={c.id} className="px-4 py-2 text-right">
                    {c.title}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <SummaryRow
                id="peak-funding"
                label={t("scenarios.summary.peak", "Peak funding line")}
                columns={columns}
                render={(view) => (
                  <>
                    <Figure
                      view={view}
                      result={view.strip.peakFundingGap.result}
                      format={format}
                      projectedLabel={projectedLabel}
                      strong
                    />
                    <span className="block text-[11px] text-ink-soft">
                      {view.strip.peakFundingGap.period
                        ? t("scenarios.summary.peakAt", "reached in {{period}}", {
                            period: view.strip.peakFundingGap.period,
                          })
                        : t("scenarios.summary.neverDraws", "the plan never draws on it")}
                    </span>
                  </>
                )}
              />
              <SummaryRow
                id="funding-interest"
                label={t("scenarios.summary.interest", "Interest on the funding line, whole plan")}
                columns={columns}
                render={(view) =>
                  view.summary.fundingInterestTotal ? (
                    <Figure
                      view={view}
                      result={view.summary.fundingInterestTotal}
                      format={format}
                      projectedLabel={projectedLabel}
                    />
                  ) : (
                    <span className="text-ink-mute">—</span>
                  )
                }
              />
              <SummaryRow
                id="first-shortfall"
                label={t("scenarios.summary.firstShortfall", "First shortfall")}
                columns={columns}
                render={(view) =>
                  view.summary.firstShortfallPeriod ? (
                    <>
                      <span className="font-medium text-ink">
                        {view.summary.firstShortfallPeriod}
                      </span>
                      {view.summary.firstShortfallAmount ? (
                        <span className="block text-[11px] text-ink-soft">
                          <Figure
                            view={view}
                            result={view.summary.firstShortfallAmount}
                            format={format}
                            projectedLabel={projectedLabel}
                          />
                        </span>
                      ) : null}
                    </>
                  ) : (
                    // The engine served no shortfall period. The runway row
                    // below carries its own sentence for why; a "none" typed
                    // here would be the page answering for the engine.
                    <span className="text-ink-mute">—</span>
                  )
                }
              />
              <SummaryRow
                id="runway"
                label={t("scenarios.summary.runway", "Months until cash reaches the floor")}
                columns={columns}
                render={(view) => (
                  <>
                    {view.summary.runwayMonths !== null ? (
                      <span className="font-medium text-ink">
                        {view.summary.runwayBound === "at_least"
                          ? t("scenarios.summary.runwayAtLeast", "at least {{months}}", {
                              months: view.summary.runwayMonths,
                            })
                          : String(view.summary.runwayMonths)}
                      </span>
                    ) : null}
                    {/* The engine's own sentence: which period cash reaches the
                        floor in, or that it does not within the horizon. */}
                    <span className="block text-[11px] text-ink-soft">
                      {view.summary.runwaySentence}
                    </span>
                  </>
                )}
              />
            </tbody>
          </table>
        </div>
        <div className="space-y-1 border-t border-rule px-4 py-2 text-[11px] leading-snug text-ink-soft">
          {anchorView.summary.fundingRateSentence ? (
            <p data-testid="scenarios-funding-rate">
              {t("scenarios.summary.fundingRate", "How the funding line is priced:")}{" "}
              {anchorView.summary.fundingRateSentence}
            </p>
          ) : null}
          {serveDscr ? null : (
            <p data-testid="scenarios-dscr-not-served">
              {t(
                "scenarios.summary.dscrNotServed",
                "Debt service coverage is not in this build's served response, so it is not shown.",
              )}
            </p>
          )}
        </div>
      </div>

      {cashChartColumn && chartView ? (
        chartHasNegativeCash ? (
          <p
            data-testid="scenarios-cash-chart-withheld"
            className="rounded border border-alert/40 bg-alert/5 px-4 py-2 text-[12px] leading-snug text-ink"
          >
            {t(
              "scenarios.outcome.chartWithheld",
              "The cash chart is withheld: the engine served a cash point below zero, and cash is never drawn below zero on this page.",
            )}
          </p>
        ) : (
          <div data-testid="scenarios-cash-chart" data-column={cashChartColumn.id}>
            <p className="mb-1 px-1 font-mono text-[10px] uppercase tracking-wider text-ink-mute">
              {t("scenarios.outcome.chartFor", "Cash and the funding line: {{name}}", {
                name: cashChartColumn.title,
              })}
            </p>
            <CashCurveChart
              closingCash={chartView.series("closing_cash")}
              minCash={chartView.series("min_cash")}
              troughPeriod={chartView.summary.cashTrough.period}
              troughResult={chartView.summary.cashTrough.result}
              fundingGapPeriods={chartView.summary.fundingGapPeriods}
              basePeriodLabel={chartView.basePeriodLabel}
              format={format}
              projectedLabel={projectedLabel}
            />
          </div>
        )
      ) : null}
    </section>
  );
}

export default ScenarioOutcome;
