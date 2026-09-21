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

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { SlidersHorizontal } from "lucide-react";

import { PageHeader as InstrumentPageHeader, Chip } from "@/components/instrument/Panel";
import { CompanyCards } from "@/components/cfo/CompanyCards";
import { ProjectedAmount } from "@/components/forecast/ProjectedAmount";
import { YearZeroStrip } from "@/components/forecast/YearZeroStrip";
import { ExecutiveStrip } from "@/components/forecast/ExecutiveStrip";
import { GrowthBasis } from "@/components/forecast/GrowthBasis";
import { LeverRail, cellToWire } from "@/components/forecast/LeverRail";
import {
  CapexDepreciationChart,
  CashCurveChart,
  FreeCashFlowChart,
  RevenueEbitdaChart,
} from "@/components/forecast/ForecastCharts";
import type { ActivePeriod } from "@/lib/activePeriod";
import { usePageCompany } from "@/lib/pageCompany";
import { useFeatureStatus } from "@/lib/features";
import { cfoApi, FORECAST_HORIZONS, type ForecastHorizon } from "@/lib/cfoApi";
import {
  readProjection,
  type AssumptionRef,
  type LeverRef,
  type ProjectionView,
} from "@/lib/forecastFacts";
import {
  assumptionValue,
  buildRecomputeBody,
  planYearLabels,
  type LeverEdit,
} from "@/lib/forecastLevers";
import { useActiveLocale } from "@/lib/locale";
import { servedDriverLabel, useServedText } from "@/lib/forecastSentences";

/** The months of plan year one the engine serves alongside the annual
 *  periods. Mirrors `HorizonBody.monthly_months`'s default; the response's own
 *  labels are what the page renders, this is only what it ASKS for. */
const MONTHLY_MONTHS = 12;

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


function AssumptionSchedule({
  view,
  locale,
}: {
  view: ProjectionView;
  locale: string;
}) {
  const { t } = useTranslation();
  const say = useServedText();
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
                <td className="px-4 py-2 text-ink">
                  {servedDriverLabel(t, a.id, a.label || a.id)}
                  {a.tier ? (
                    <span
                      data-testid={`forecast-tier-${a.id}`}
                      data-tier={a.tier}
                      className="ml-2 rounded-full border border-rule px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-ink-mute"
                    >
                      {t(`forecast.tier.${a.tier}`, a.tier)}
                    </span>
                  ) : null}
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-ink">
                  {assumptionValue(a, locale, absent)}
                </td>
                <td className="px-4 py-2 text-[12px] leading-snug text-ink-soft">
                  {say(a.basis)}
                  {a.inert ? (
                    <span
                      data-testid={`forecast-inert-${a.id}`}
                      className="mt-1 block text-ink-mute"
                    >
                      {say(a.inert)}
                    </span>
                  ) : null}
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
  // Whole units, EXCEPT a figure under one unit: the engine serves cents,
  // and a served 0.01 printed "RON 0" is a zero painted where a real value
  // exists (owner gate F5 — measured on agras: eighteen working-capital
  // movements of one cent rendered as "RON 0"). A sub-unit figure keeps its
  // cents; everything else rounds half away from zero, exactly as the
  // whole-unit format did.
  const fmt = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currency || "RON",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  // THE VALUE ARRIVES IN MAJOR UNITS. `<ProjectedAmount>` calls
  // `projectedDisplay`, whose docstring is explicit — "The single
  // division, at the edge, exactly like `Fact.to_float()` on the actuals
  // side" — and which has already done `minor / 100`.
  //
  // This function used to divide again. Every figure on the page rendered
  // at ONE HUNDREDTH of its value, while the assumption schedule's basis
  // prose beside it printed the same figures correctly (that text comes
  // from the engine, not through this path). The page contradicted itself
  // in two places on one screen: revenue FY as RON 4,137,276 against a
  // basis sentence saying 413,727,560.16.
  //
  // The boundary was right and the page was wrong. Nothing in the
  // producer or the serving lane needed changing.
  return (value: number) =>
    fmt.format(Math.abs(value) >= 1 ? Math.sign(value) * Math.round(Math.abs(value)) : value);
}

function StatementBlock({
  view,
  block,
  periods,
  format,
  projectedLabel,
}: {
  view: ProjectionView;
  block: (typeof BLOCKS)[number];
  /** The columns to paint. FY aggregates by default — the engine SERVES those
   *  totals (`projected_aggregate` rows), so choosing them is choosing which
   *  served figure to read, never summing months in the browser. */
  periods: readonly string[];
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
              {periods.map((period) => (
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
                  {t(`forecast.row.${row.line}`, row.label)}
                </td>
                {periods.map((period) => (
                  <td
                    key={period}
                    // WHICH PERIOD THIS CELL IS. Stated, not positional: the
                    // columns are FY aggregates by default and the months of
                    // year one behind a toggle, so a gate that reads a cell's
                    // period off its index is reading the old column choice.
                    data-period={period}
                    data-line={row.line}
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


/** ONE LEVER EDIT APPLIED TO THE SET. A cell the reader cleared goes back to
 *  `null`, which is the request saying "leave this year at the engine's own
 *  value" — not zero, which would be the reader asserting a rate of nothing. */
function withEdit(
  edits: readonly LeverEdit[],
  lever: LeverRef,
  index: number,
  wire: string | null,
  length: number,
): LeverEdit[] {
  const next = edits.filter((e) => e.key !== lever.key);
  const current = edits.find((e) => e.key === lever.key);
  const values: (string | null)[] = Array.from(
    { length },
    (_, i) => current?.values[i] ?? null,
  );
  values[index] = wire;
  if (values.every((v) => v === null)) return next;
  return [...next, { key: lever.key, values }].sort((a, b) =>
    a.key.localeCompare(b.key),
  );
}

/** THE ENGINE'S REFUSAL, IN ITS OWN WORDS.
 *
 *  `/api/forecast/{id}/recompute` raises `HTTPException(422, {"code", "text",
 *  "field"})`, so a refusal arrives as a structured detail — and `cfoApi`'s
 *  fallback, which has no `message` key to find, stringifies the whole object.
 *  Printing `{"code":"out_of_bounds","text":"…"}` at a reader is the envelope,
 *  not the sentence. `text` is what the engine wrote; `field` is the driver it
 *  names, which beats reading the key back out of the prose.
 *
 *  Anything that is not that shape falls back to the message, which is where a
 *  transport failure and a 500 already live. */
function readRefusal(err: unknown): { text: string; field: string | null } | null {
  const detail = (err as { detail?: unknown } | null)?.detail;
  if (detail && typeof detail === "object") {
    const rec = detail as { text?: unknown; field?: unknown };
    if (typeof rec.text === "string" && rec.text.length > 0) {
      return {
        text: rec.text,
        field: typeof rec.field === "string" ? rec.field : null,
      };
    }
  }
  const message = (err as Error | null)?.message;
  return typeof message === "string" && message.length > 0
    ? { text: message, field: null }
    : null;
}

/** THE COMPANY ON SCREEN (forecast-scenarios-live). The forecast always
 *  works on the active workspace's company and its analysed year. With no
 *  company, or a company with no analysed year, the page says so in one
 *  sentence and offers the user's companies — never a blank page, and never
 *  an upload control (the company page owns uploads). */
export default function Forecast() {
  const { t } = useTranslation();
  const onScreen = usePageCompany();
  const pageName = t("forecast.eyebrow", "Forecast");
  if (onScreen.status === "ready") {
    return <ForecastForPeriod key={onScreen.period.id} period={onScreen.period}
      companyName={onScreen.company?.name ?? null} />;
  }
  return (
    <div className="space-y-4 pb-16">
      <InstrumentPageHeader
        eyebrow={pageName}
        title={t("forecast.title", "Projection")}
        context={onScreen.company ? <span>{onScreen.company.name}</span> : undefined}
      />
      {onScreen.status === "loading" ? (
        <p className="px-1 text-[13px] text-ink-mute" data-testid="forecast-loading">
          {t("forecast.loading", "Projecting…")}
        </p>
      ) : (
        <CompanyCards reason={onScreen.status} pageName={pageName} />
      )}
    </div>
  );
}

function ForecastForPeriod({
  period,
  companyName,
}: {
  period: ActivePeriod;
  companyName: string | null;
}) {
  const { t } = useTranslation();
  const say = useServedText();
  const locale = useActiveLocale();
  const navigate = useNavigate();
  const scenariosOpen = useFeatureStatus("scenarios") === "active";
  const [horizon, setHorizon] = useState<ForecastHorizon>(5);
  /** FY columns by default. The monthly view is the SAME response — one GET
   *  already carries the months of plan year one and the annual periods after
   *  it — so the toggle changes which served labels are painted and fires no
   *  second request. */
  const [monthly, setMonthly] = useState(false);
  /** What the reader has typed. `committed` is what has been SENT. */
  const [edits, setEdits] = useState<readonly LeverEdit[]>([]);
  const [committed, setCommitted] = useState<readonly LeverEdit[]>([]);
  /** The levers of the last projection read, so a body can be built while a
   *  recompute is in flight (the shape decides how many values an override
   *  must carry, and a wrong length is 422 `override_length`). */
  const leversRef = useRef<readonly LeverRef[]>([]);

  const editsKey = JSON.stringify(edits);
  const committedKey = JSON.stringify(committed);

  const query = useQuery({
    queryKey: ["forecast", period.id, horizon, committedKey],
    queryFn: () =>
      committed.length === 0
        ? cfoApi.forecast(period.id as string, horizon)
        : cfoApi.forecastRecompute(
            period.id as string,
            buildRecomputeBody(
              horizon,
              MONTHLY_MONTHS,
              committed,
              leversRef.current,
            ) as unknown as Record<string, unknown>,
          ),
    enabled: !!period.id,
    // THE LAST ANSWER STAYS ON SCREEN WHILE THE NEXT ONE IS COMPUTED. Stated
    // here rather than inherited from the query client's defaults, because it
    // is this page's promise and not a convenience: while a recompute is in
    // flight the reader keeps looking at a projection the server actually
    // produced, with the rail saying so, instead of the page blanking or —
    // worse — filling the wait with figures computed in the browser.
    placeholderData: keepPreviousData,
    // A projection is deterministic in its inputs: same book, same horizon,
    // same levers, same bytes. Refetching on focus would spend a request to be
    // told the same thing.
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

  const ready = view && !("error" in view) ? (view as ProjectionView) : null;

  /** THE LAST PROJECTION THE SERVER ACTUALLY PRODUCED, for this book at this
   *  horizon.
   *
   *  A recompute the engine REFUSES — and it refuses any lever value outside
   *  the bounds it serves, by design — leaves the query with no data. Dropping
   *  the whole surface at that moment is the page telling the reader their book
   *  cannot be projected, which is false: it was projected, they then asked a
   *  question the plan cannot answer. So the last served projection stays on
   *  screen, the engine's sentence goes beside the control that caused it, and
   *  the reader can undo their own edit.
   *
   *  Keyed by book AND horizon: a horizon whose FIRST read fails has no earlier
   *  answer of its own, and showing the other horizon's projection under the
   *  new horizon's label would be a figure wearing the wrong span. */
  const answerKey = `${period.id}|${horizon}`;
  const [lastGood, setLastGood] = useState<{
    key: string;
    view: ProjectionView;
  } | null>(null);
  useEffect(() => {
    if (!ready) return;
    leversRef.current = ready.levers;
    setLastGood({ key: answerKey, view: ready });
  }, [ready, answerKey]);
  const held = lastGood && lastGood.key === answerKey ? lastGood.view : null;
  const shown = ready ?? held;
  /** The surface is showing an answer that is NOT the edit the reader has
   *  made. Said out loud rather than left for them to infer from figures that
   *  did not move. */
  const stale = !ready && !!held;

  /** THE DEBOUNCE IS THE PACK'S OWN (`client.debounce_ms`), read off the
   *  payload. A number typed here would be a cut-off written as prose. */
  const debounceMs = ready?.client.debounceMs ?? 0;
  useEffect(() => {
    if (editsKey === committedKey) return undefined;
    const id = setTimeout(() => setCommitted(JSON.parse(editsKey)), debounceMs);
    return () => clearTimeout(id);
  }, [editsKey, committedKey, debounceMs]);

  // A change of horizon resizes every per-year override; rather than send a
  // stale length the page drops the edits and re-opens on the engine's values.
  useEffect(() => {
    setEdits([]);
    setCommitted([]);
  }, [horizon, period.id]);

  const projectedLabel = t("forecast.projected", "projected");

  const onChange = (key: string, index: number, text: string) => {
    const lever = leversRef.current.find((l) => l.key === key);
    if (!lever) return;
    const length =
      lever.shape === "scalar"
        ? 1
        : planYearLabels(
            ready?.horizon ?? [],
            ready?.horizonAnnual ?? [],
          ).length || horizon;
    setEdits((prev) =>
      withEdit(prev, lever, index, text === "" ? null : cellToWire(text, lever), length),
    );
  };

  const onReset = (key: string) => {
    // Reset is DROPPING the override, not sending the old number back: the
    // engine then re-derives the value on its own ladder and re-states the
    // tier it stands on.
    setEdits((prev) => prev.filter((e) => e.key !== key));
  };

  const refusal = query.isError ? readRefusal(query.error) : null;
  const recomputeError = refusal?.text ?? null;
  /** The lever the engine NAMED. `field` comes straight off the refusal, so
   *  the marked cell is the engine's choice and not the page guessing from
   *  whichever control was touched last — which marks the wrong one whenever
   *  two edits settle into a single request. */
  const refusedLeverKey =
    refusal && leversRef.current.some((l) => l.key === refusal.field)
      ? refusal.field
      : null;

  const onAdopt = (key: string, values: readonly string[]) => {
    setEdits((prev) => [
      ...prev.filter((e) => e.key !== key),
      { key, values: [...values] },
    ].sort((a, b) => a.key.localeCompare(b.key)));
  };

  return (
    <div className="space-y-4 pb-16">
      <InstrumentPageHeader
        eyebrow={t("forecast.eyebrow", "Forecast")}
        title={t("forecast.title", "Projection")}
        context={
          companyName ? (
            <span data-testid="forecast-company">{companyName}</span>
          ) : undefined
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2" data-testid="forecast-horizon">
              {FORECAST_HORIZONS.map((h) => (
                <button
                  key={h}
                  type="button"
                  onClick={() => setHorizon(h)}
                  aria-pressed={h === horizon}
                  data-testid={`forecast-horizon-${h}`}
                  className={`rounded-md border px-3 py-1 font-mono text-[11px] uppercase tracking-wider transition-colors ${
                    h === horizon
                      ? "border-brand/60 bg-brand/10 text-ink"
                      : "border-rule text-ink-mute hover:text-ink"
                  }`}
                >
                  {t("forecast.years", "{{count}} years", { count: h })}
                </button>
              ))}
            </div>
            {/* THE ONE PRIMARY ACTION of this screen: stress the plan. The
                Scenarios page opens on the same company and period, and its
                base column IS this forecast (gate F4). */}
            {scenariosOpen ? (
              <button
                type="button"
                data-testid="forecast-open-scenarios"
                data-primary-action="true"
                onClick={() =>
                  navigate(`/dashboard/scenarios?period=${encodeURIComponent(period.id as string)}`)
                }
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3.5 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-brand-d"
              >
                <SlidersHorizontal size={14} strokeWidth={2} aria-hidden />
                {t("forecast.openScenarios", "Stress this plan")}
              </button>
            ) : null}
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
            // The PAYLOAD'S base period, not the app's active-period
            // context. The two can disagree — the context is the workspace
            // selection and the projection stands on the period the engine
            // actually read — and this sentence is the page's statement
            // about the one ACTUAL figure under every number on screen, so
            // it names that period or it says nothing useful. Before the
            // first answer there is no served period yet, and the context
            // is the honest stand-in; it can still be absent, which is what
            // the dash is for.
            // `shown`, not `ready`: when a recompute is refused the page
            // deliberately keeps the last projection the SERVER produced on
            // screen, and the sentence explaining what those figures stand
            // on must stay true for exactly as long as they are visible.
            { period: shown?.basePeriodLabel ?? period.label ?? "—" },
          )}
        </p>
      </div>

      {query.isPending ? (
        <p className="px-1 text-[13px] text-ink-mute" data-testid="forecast-loading">
          {t("forecast.loading", "Projecting…")}
        </p>
      ) : null}

      {/* "No projection" is the copy for the FIRST read failing — the book
          could not be projected at all. It is the wrong sentence for a reader
          who typed a number outside the engine's bounds, so it renders only
          when there is no served projection to stand on. */}
      {query.isError && !held ? (
        <div
          data-testid="forecast-refusal"
          className="rounded-xl border border-rule bg-surface px-4 py-3 text-[13px] leading-snug"
        >
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">
            {t("forecast.refused", "No projection")}
          </span>
          {/* THE ENGINE'S OWN SENTENCE, in the reader's language (the served
              words re-said under lib/forecastSentences' digit law, or verbatim
              when no rule says them). It names the driver that could not be
              measured and the basis that failed to measure it, which is the
              only thing that tells the reader what to do next. It is never
              replaced with a generic message. */}
          <p className="mt-1 text-ink-soft" data-testid="forecast-refusal-detail">
            {recomputeError ? say(recomputeError) : recomputeError}
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

      {shown ? (
        <YearZeroStrip period={period} currency={shown.currency} locale={locale} />
      ) : null}

      {shown ? (
        <ProjectionBody
          view={shown}
          locale={locale}
          projectedLabel={projectedLabel}
          monthly={monthly}
          onToggleMonthly={() => setMonthly((m) => !m)}
          edits={edits}
          recomputing={query.isFetching}
          stale={stale}
          recomputeError={recomputeError}
          refusedLeverKey={refusedLeverKey}
          onChange={onChange}
          onReset={onReset}
          onAdopt={onAdopt}
        />
      ) : null}
    </div>
  );
}

function ProjectionBody({
  view,
  locale,
  projectedLabel,
  monthly,
  onToggleMonthly,
  edits,
  recomputing,
  stale,
  recomputeError,
  refusedLeverKey,
  onChange,
  onReset,
  onAdopt,
}: {
  view: ProjectionView;
  locale: string;
  projectedLabel: string;
  monthly: boolean;
  onToggleMonthly: () => void;
  edits: readonly LeverEdit[];
  recomputing: boolean;
  stale: boolean;
  recomputeError: string | null;
  refusedLeverKey: string | null;
  onChange: (key: string, index: number, text: string) => void;
  onReset: (key: string) => void;
  onAdopt: (key: string, values: readonly string[]) => void;
}) {
  const { t } = useTranslation();
  const say = useServedText();
  const format = useMemo(
    () => makeFormatter(view.currency, locale),
    [view.currency, locale],
  );
  const chartProps = {
    basePeriodLabel: view.basePeriodLabel,
    format,
    projectedLabel,
  };
  const fyColumns = planYearLabels(view.horizon, view.horizonAnnual);
  /** A FLOW at the financial-year grain, read from the engine's own
   *  `projected_aggregate` rows.
   *
   *  Revenue, EBITDA, capex and depreciation are TOTALS OVER A LENGTH, and
   *  `series` serves them over the months of plan year one and then over the
   *  annual periods. Drawn on one axis, a month beside a year steps twelvefold
   *  and reads as explosive growth — every figure true, the picture false. The
   *  engine serves an FY aggregate for each of these lines, so the chart reads
   *  those instead. This is a SELECTION of served figures, not a sum: a browser
   *  adding twelve months would be stating a total the projection never did. */
  const fyFlow = (line: string) =>
    fyColumns.map((period) => ({ period, result: view.figure(line, period) }));
  // The monthly view is only offered when the engine actually served months.
  const hasMonths = view.horizon.some((p) => /^\d{4}-\d{2}$/.test(p));
  const columns = monthly && hasMonths ? view.horizon : fyColumns;
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
      {view.refusal ? (
        <div
          data-testid="forecast-partial-refusal"
          className="rounded border border-rule bg-surface px-4 py-3 text-[13px] text-ink"
        >
          {say(view.refusal.sentence)}
        </div>
      ) : null}

      {/* THE FIGURES BELOW ARE NOT THE EDIT. Said in a row of its own, because
          a reader who has just typed a number and seen nothing move would
          otherwise have to work out for themselves which projection they are
          looking at. */}
      {stale ? (
        <p
          data-testid="forecast-stale-notice"
          className="rounded border border-alert/40 bg-alert/5 px-4 py-2 text-[12px] leading-snug text-ink"
        >
          {t(
            "forecast.stale",
            "The server would not take that change, so every figure below is still the last projection it produced. Your edit is in the rail; correct it or reset the lever.",
          )}
        </p>
      ) : null}

      <ExecutiveStrip
        view={view}
        format={format}
        projectedLabel={projectedLabel}
      />

      <div className="grid grid-cols-1 gap-3 2xl:grid-cols-2">
        <RevenueEbitdaChart
          revenue={fyFlow("pl.revenue")}
          ebitda={fyFlow("pl.ebitda")}
          {...chartProps}
        />
        <CashCurveChart
          closingCash={view.series("closing_cash")}
          minCash={view.series("min_cash")}
          troughPeriod={view.summary.cashTrough.period}
          troughResult={view.summary.cashTrough.result}
          fundingGapPeriods={view.summary.fundingGapPeriods}
          {...chartProps}
        />
        <FreeCashFlowChart
          fcf={view.series("fcf")}
          cumulative={view.series("fcf_cumulative")}
          {...chartProps}
        />
        <CapexDepreciationChart
          capex={fyFlow("cf.capital_expenditure")}
          depreciation={fyFlow("pl.depreciation")}
          {...chartProps}
        />
      </div>

      <GrowthBasis view={view} format={format} />

      <LeverRail
        view={view}
        edits={edits}
        recomputing={recomputing}
        error={recomputeError}
        refusedKey={refusedLeverKey}
        onChange={onChange}
        onReset={onReset}
        onAdopt={onAdopt}
      />

      <AssumptionSchedule view={view} locale={locale} />

      {hasMonths ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="forecast-grain-toggle"
            aria-pressed={monthly}
            onClick={onToggleMonthly}
            className="rounded-md border border-rule px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-ink-mute hover:text-ink"
          >
            {monthly
              ? t("forecast.grain.showFy", "Show financial years")
              : t("forecast.grain.showMonthly", "Show months of year one")}
          </button>
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">
            {/* Both grains are SERVED totals. The browser does not sum months
                into a year — the engine serves the FY aggregate itself. */}
            {t("forecast.grain.note", "Both grains are served by the engine")}
          </span>
        </div>
      ) : null}

      {BLOCKS.map((block) => (
        <StatementBlock
          key={block.id}
          view={view}
          block={block}
          periods={columns}
          format={format}
          projectedLabel={projectedLabel}
        />
      ))}
      <BalanceCheck view={view} />
    </>
  );
}
