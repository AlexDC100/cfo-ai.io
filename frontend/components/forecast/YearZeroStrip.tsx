// YEAR 0 — the actuals every projected year stands on, as the dashboard shows
// them (owner gate F1).
//
// These four figures are ACTUALS, not projections: the dashboard's own key
// metrics — operating revenue, EBITDA, net profit and cash — computed by the
// ONE function the dashboard computes them with (`lib/dashboardHeadline.ts`)
// over the SAME served period payload (`GET /api/period/{id}`, shared through
// the `useActivePeriod` query cache). The projection's opening is that same
// period: the engine gate forecast-f-gates holds its anchor equal to these
// served figures to the cent, so year 0 on this page and on the dashboard are
// one set of numbers.
//
// This file never touches the projection namespace (no ProjectedMinor, no
// forecastFacts): scripts/check_forecast_boundary.mjs keeps an actual and a
// projection from ever sharing a primitive. The figures are formatted in the
// book's own currency, like the projection beside them, so year 0 and plan
// year one read in one unit.

import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { ActivePeriod } from "@/lib/activePeriod";
import { canonicalMarginsFrom, computeDashboardHeadline } from "@/lib/dashboardHeadline";
import { pickLang } from "@/lib/servedOneEbitda";

export interface YearZeroStripProps {
  readonly period: ActivePeriod;
  readonly currency: string;
  readonly locale: string;
}

export function YearZeroStrip({ period, currency, locale }: YearZeroStripProps) {
  const { t, i18n } = useTranslation();
  const headline = useMemo(() => {
    if (!period.statements) return null;
    try {
      return computeDashboardHeadline({
        statements: period.statements,
        lineItems: period.lineItems ?? [],
        metrics: period.metrics ?? [],
        entity: t("dash.entity"),
        canonicalMargins: canonicalMarginsFrom(period.metrics ?? []),
      });
    } catch {
      // A payload the dashboard itself could not build a headline from: the
      // strip says nothing rather than half of it.
      return null;
    }
  }, [period.statements, period.lineItems, period.metrics, t]);
  const fmt = useMemo(
    () =>
      new Intl.NumberFormat(locale, {
        style: "currency",
        currency: currency || "RON",
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      }),
    [currency, locale],
  );
  if (!headline) return null;
  // A refused EBITDA (the stock variation could not be measured) states the
  // engine's reason in place of a figure — never a zero.
  const ebitdaRefused = headline.tileEbitdaRon === null && headline.tileEbitdaRefusal
    ? pickLang(headline.tileEbitdaRefusal.text, i18n.language)
    : null;
  const cells: ReadonlyArray<{ id: string; label: string; value: number | null; refused?: string | null }> = [
    { id: "revenue", label: t("forecast.year0.revenue", "Net turnover"), value: headline.netTurnover },
    { id: "ebitda", label: t("forecast.year0.ebitda", "EBITDA"), value: headline.tileEbitdaRon, refused: ebitdaRefused },
    { id: "net_profit", label: t("forecast.year0.netProfit", "Net profit"), value: headline.tileNetProfitRon },
    { id: "cash", label: t("forecast.year0.cash", "Cash"), value: headline.cash },
  ];
  const label = period.statements?.periodLabel ?? period.periodEnd ?? "";
  return (
    <section
      data-testid="forecast-year0"
      data-actual="true"
      className="rounded-xl border border-rule bg-surface px-4 py-3"
    >
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-mono text-[11px] uppercase tracking-wider text-ink-mute">
          {t("forecast.year0.title", "Year 0 · actual")}
        </h2>
        <span className="font-mono text-[10.5px] uppercase tracking-wider text-ink-mute">{label}</span>
        <span className="text-[12px] leading-snug text-ink-soft">
          {t(
            "forecast.year0.lead",
            "The figures the dashboard shows. Every projected year below stands on them.",
          )}
        </span>
      </header>
      <dl className="mt-2 grid grid-cols-2 gap-3 md:grid-cols-4">
        {cells.map((c) => (
          <div key={c.id} data-testid={`forecast-year0-${c.id}`} data-actual-value={String(c.value)}>
            <dt className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">{c.label}</dt>
            <dd className="mt-0.5 text-[16px] font-medium tabular-nums text-ink">
              {typeof c.value === "number" && Number.isFinite(c.value)
                ? fmt.format(
                    // whole units, cents only under one unit (gate F5)
                    Math.abs(c.value) >= 1 ? Math.sign(c.value) * Math.round(Math.abs(c.value)) : c.value,
                  )
                : c.refused ?? t("forecast.absent", "not measurable from this book")}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export default YearZeroStrip;
