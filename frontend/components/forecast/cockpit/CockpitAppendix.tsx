// THE COLLAPSED APPENDIX — the full projected profit and loss, balance sheet
// and cash flow, one column per plan year with year 0 (the actual book) beside
// them, then the model's conventions and what it does not model (owner spec
// 2026-09-21: "tables are the appendix, never the first thing you see").
//
// Every cell is a SERVED amount (`statements.*[].values`, the engine's plan-
// year aggregates: flows summed over the year's periods, balances at its
// close) painted by <CockpitAmountView>: ◇ on a projection, none on year 0,
// an em dash naming the engine's reason where it refused. Nothing is summed
// here — not a month into a year, not a line into a total.
//
// Above the tables, YEAR 0 AS THE DASHBOARD SHOWS IT (gate F1's page half):
// the dashboard's own four headline actuals over the same served period
// payload, which the engine gate holds equal to the plan's opening to the cent.

import { useTranslation } from "react-i18next";

import { YearZeroStrip } from "@/components/forecast/YearZeroStrip";
import type { ActivePeriod } from "@/lib/activePeriod";
import { pick, type CockpitView, type StatementRow } from "@/lib/forecastCockpit";
import { useServedText } from "@/lib/forecastSentences";
import { CockpitAmountView } from "./CockpitAmountView";
import type { MoneyFormat } from "./format";

const STRONG = new Set([
  "pl.revenue",
  "pl.ebitda",
  "pl.ebit",
  "pl.pretax_result",
  "pl.net_income",
  "bs_totals.assets",
  "bs_totals.equity",
  "bs_totals.equity_plus_liabilities",
  "cf.cash_from_operating",
  "cf.cash_from_investing",
  "cf.cash_from_financing",
  "cf.closing_cash",
]);

function Statement({
  id,
  title,
  rows,
  years,
  withYear0,
  format,
  projectedLabel,
  lang,
}: {
  id: string;
  title: string;
  rows: readonly StatementRow[];
  years: readonly string[];
  withYear0: boolean;
  format: MoneyFormat;
  projectedLabel: string;
  lang: string;
}) {
  const { t } = useTranslation();
  const planYears = years.slice(1);
  return (
    <section data-testid={`forecast-block-${id}`} className="rounded-xl border border-rule bg-surface">
      <header className="border-b border-rule px-4 py-3">
        <h2 className="font-mono text-[11px] uppercase tracking-wider text-ink-mute">{title}</h2>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="border-b border-rule-soft text-left font-mono text-[10px] uppercase tracking-wider text-ink-mute">
              <th className="sticky left-0 bg-surface px-3 py-2">{t("forecast.line", "Line")}</th>
              {withYear0 ? (
                <th className="px-3 py-2 text-right" data-actual-column="true">
                  {years[0]} · {t("forecast.cockpit.appendixActual", "actual")}
                </th>
              ) : null}
              {planYears.map((y) => (
                <th key={y} className="px-3 py-2 text-right">
                  {y}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const strong = STRONG.has(row.line);
              return (
                <tr key={row.line} data-testid={`forecast-row-${row.line}`} className="border-b border-rule-soft/60 last:border-0">
                  <td className={`sticky left-0 bg-surface px-3 py-1.5 ${strong ? "font-medium text-ink" : "text-ink-soft"}`}>
                    {pick(row.label, lang)}
                  </td>
                  {withYear0 ? (
                    <td className="px-3 py-1.5 text-right tabular-nums text-ink-mute" data-line={row.line} data-period={years[0]}>
                      {row.year0 ? (
                        <CockpitAmountView amount={row.year0} format={format} projectedLabel={projectedLabel} lang={lang} />
                      ) : null}
                    </td>
                  ) : null}
                  {row.values.map((v) => (
                    <td
                      key={v.period}
                      data-line={row.line}
                      data-period={v.period}
                      className={`px-3 py-1.5 text-right tabular-nums ${strong ? "font-medium text-ink" : "text-ink-soft"}`}
                    >
                      <CockpitAmountView amount={v} format={format} projectedLabel={projectedLabel} lang={lang} />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function CockpitAppendix({
  cockpit,
  period,
  locale,
  lang,
  format,
  projectedLabel,
}: {
  cockpit: CockpitView;
  period: ActivePeriod;
  locale: string;
  lang: string;
  format: MoneyFormat;
  projectedLabel: string;
}) {
  const { t } = useTranslation();
  // The conventions and the not-modelled list are the engine's English
  // sentences; a Romanian page re-says them under the digit law, or prints
  // them as served when no rule says them (lib/forecastSentences).
  const say = useServedText();
  const s = cockpit.statements;
  return (
    <div className="space-y-4" data-testid="forecast-appendix">
      <YearZeroStrip period={period} currency={cockpit.currency} locale={locale} />
      <Statement id="pl" title={t("forecast.block.pl", "Profit and loss")} rows={s.pl} years={s.years} withYear0 format={format} projectedLabel={projectedLabel} lang={lang} />
      <Statement id="bs" title={t("forecast.block.bs", "Balance sheet")} rows={s.bs} years={s.years} withYear0 format={format} projectedLabel={projectedLabel} lang={lang} />
      <Statement id="cf" title={t("forecast.block.cf", "Cash flow")} rows={s.cf} years={s.years} withYear0={false} format={format} projectedLabel={projectedLabel} lang={lang} />
      {cockpit.fundingLine?.referenceBasis ? (
        <p data-testid="cockpit-funding-reference" className="rounded-lg border border-rule bg-surface px-4 py-2 text-[12px] leading-snug text-ink-soft">
          {pick(cockpit.fundingLine.referenceBasis, lang)}
        </p>
      ) : null}
      {cockpit.conventions.length > 0 ? (
        <section data-testid="cockpit-conventions" className="rounded-xl border border-rule bg-surface px-4 py-3">
          <h2 className="font-mono text-[11px] uppercase tracking-wider text-ink-mute">
            {t("forecast.cockpit.conventions", "Model conventions")}
          </h2>
          <ul className="mt-2 list-disc space-y-1 pl-4 text-[12px] leading-snug text-ink-soft">
            {cockpit.conventions.map((c) => (
              <li key={c.id} data-convention={c.id}>
                {say(c.sentence, c.id)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {cockpit.notModelled.length > 0 ? (
        <section data-testid="cockpit-not-modelled" className="rounded-xl border border-rule bg-surface px-4 py-3">
          <h2 className="font-mono text-[11px] uppercase tracking-wider text-ink-mute">
            {t("forecast.cockpit.notModelled", "What this forecast does not model")}
          </h2>
          <ul className="mt-2 list-disc space-y-1 pl-4 text-[12px] leading-snug text-ink-soft">
            {cockpit.notModelled.map((c) => (
              <li key={c.id} data-not-modelled={c.id}>
                {say(c.sentence, c.id)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
