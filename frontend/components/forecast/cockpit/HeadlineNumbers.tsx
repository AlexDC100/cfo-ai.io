// THE FOUR NUMBERS A BANK ASKS FOR — every one of them served, and served
// FORMATTED: the engine prints each figure per language (`numbers.*.display`),
// so this component neither computes nor formats a single digit.
//
//   1. EBITDA in the final plan year, with its margin against today's;
//   2. cumulative free cash flow over the plan;
//   3. the lowest cash — or, when the plan needs money it does not have,
//      "Necesar de finanțare X" with WHEN the line first draws — the month
//      in plan year one, the YEAR after it (the engine projects monthly only
//      in year one, so "din 2028" would claim a precision the plan does not
//      have: it reads "în cursul anului 2028") — and the interest it costs;
//   4. DSCR in plan year one against the bank's threshold, coloured by the
//      ENGINE's verdict (`status`; the page never compares the two numbers).
//
// Each projected figure carries the ◇ mark (<ProjectedText>); today's margin
// is an actual and carries none.

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { pick, type CockpitView } from "@/lib/forecastCockpit";
import { yearLabel } from "./format";
import { ProjectedText } from "./ProjectedText";

function Card({
  testId,
  label,
  tone = "neutral",
  children,
  sub,
}: {
  testId: string;
  label: string;
  tone?: "neutral" | "good" | "bad" | "warn";
  children: ReactNode;
  sub?: ReactNode;
}) {
  const edge =
    tone === "good"
      ? "border-l-success"
      : tone === "bad"
        ? "border-l-alert"
        : tone === "warn"
          ? "border-l-caution"
          : "border-l-rule-strong";
  return (
    <div
      data-testid={testId}
      data-tone={tone}
      className={`min-w-0 rounded-lg border border-rule border-l-[3px] ${edge} bg-surface px-4 py-3`}
    >
      <div className="font-mono text-[10.5px] uppercase tracking-wider text-ink-mute">{label}</div>
      <div className="mt-1 truncate text-[24px] font-semibold leading-tight tabular-nums text-ink sm:text-[26px]">
        {children}
      </div>
      {sub ? <div className="mt-1 text-[12px] leading-snug text-ink-soft">{sub}</div> : null}
    </div>
  );
}

export function HeadlineNumbers({
  cockpit,
  lang,
  projectedLabel,
  answerKey,
}: {
  cockpit: CockpitView;
  lang: string;
  projectedLabel: string;
  /** Changes with every served answer: each value re-settles (the animation)
   *  when the ENGINE answers, never while the reader drags. */
  answerKey: string;
}) {
  const { t } = useTranslation();
  const n = cockpit.numbers;
  const settle = (node: ReactNode) => (
    <span key={answerKey} className="cockpit-settle inline-block max-w-full">
      {node}
    </span>
  );
  const ebitda = n.ebitda;
  const cash = n.cash;
  const dscr = n.dscr;
  // The engine's refusal of the margin (turnover negligible against
  // operating activity): the final plan year's, else today's.
  const refusedMargin = ebitda.marginRefused ?? ebitda.marginYear0Refused;

  return (
    <section
      data-testid="cockpit-numbers"
      aria-label={t("forecast.cockpit.numbers.aria", "The four numbers a bank asks for")}
      className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 xl:grid-cols-4"
    >
      <Card
        testId="cockpit-ebitda-final"
        label={t("forecast.cockpit.numbers.ebitda", "EBITDA {{year}}", { year: yearLabel(ebitda.period) })}
        sub={
          ebitda.margin ? (
            <span data-testid="cockpit-ebitda-margin">
              {t("forecast.cockpit.numbers.margin", "margin")}{" "}
              <ProjectedText
                text={pick(ebitda.margin, lang)}
                period={ebitda.period}
                projectedLabel={projectedLabel}
                className="font-medium text-ink"
              />
              {ebitda.marginYear0 ? (
                <span data-testid="cockpit-ebitda-margin-today" data-actual="true">
                  {" · "}
                  {t("forecast.cockpit.numbers.today", "today")} {pick(ebitda.marginYear0, lang)}
                </span>
              ) : ebitda.marginYear0Refused ? (
                <span data-testid="cockpit-ebitda-margin-today-refused" data-actual="true">
                  {" · "}
                  {t("forecast.cockpit.numbers.today", "today")}: {pick(ebitda.marginYear0Refused, lang)}
                </span>
              ) : null}
            </span>
          ) : refusedMargin ? (
            // The ENGINE refused the margin (turnover negligible against
            // operating activity): its sentence, never a percent.
            <span data-testid="cockpit-ebitda-margin-refused">
              {pick(refusedMargin, lang)}
              {ebitda.marginRefused && !ebitda.marginYear0Refused && ebitda.marginYear0 ? (
                <span data-testid="cockpit-ebitda-margin-today" data-actual="true">
                  {" · "}
                  {t("forecast.cockpit.numbers.today", "today")} {pick(ebitda.marginYear0, lang)}
                </span>
              ) : null}
            </span>
          ) : null
        }
      >
        {settle(<ProjectedText text={pick(ebitda.amount, lang)} period={ebitda.period} projectedLabel={projectedLabel} />)}
        {ebitda.year0Step ? (
          // THE YEAR-0 → PLAN STEP, as served: year 0's EBITDA includes the
          // stock variation (711) and own work capitalised (72x); the plan
          // years project them at 0, and the card says so with the figures.
          <div data-testid="cockpit-ebitda-year0-step" className="mt-1 text-[11px] leading-snug text-ink-mute">
            {ebitda.year0Step.ebitdaYear0 && ebitda.year0Step.step
              ? `${t("forecast.cockpit.numbers.today", "today")} ${pick(ebitda.year0Step.ebitdaYear0, lang)} (${pick(ebitda.year0Step.step, lang)}) — `
              : ""}
            {pick(ebitda.year0Step.text, lang)}
          </div>
        ) : null}
      </Card>

      <Card
        testId="cockpit-cumulative-fcf"
        label={t("forecast.cockpit.numbers.fcf", "Free cash flow {{from}}–{{to}}", {
          from: yearLabel(n.fcf.from),
          to: yearLabel(n.fcf.to),
        })}
        sub={pick(n.fcf.formula, lang) || undefined}
      >
        {settle(<ProjectedText text={pick(n.fcf.amount, lang)} period={n.fcf.to} projectedLabel={projectedLabel} />)}
      </Card>

      {cash.kind === "funding_need" ? (
        <Card
          testId="cockpit-funding-need"
          tone="warn"
          label={t("forecast.cockpit.numbers.fundingNeed", "Funding need")}
          sub={
            <span>
              <span data-testid="cockpit-funding-month" data-granularity={cash.firstGranularity}>
                {cash.firstGranularity === "annual"
                  ? t("forecast.cockpit.numbers.fundingDuring", "during {{year}}", { year: pick(cash.when, lang) })
                  : t("forecast.cockpit.numbers.fundingFrom", "from {{month}}", { month: pick(cash.when, lang) })}
              </span>
              {" · "}
              <span data-testid="cockpit-funding-interest">
                {t("forecast.cockpit.numbers.fundingInterest", "interest")}{" "}
                <ProjectedText text={pick(cash.interest, lang)} period={cash.firstPeriod} projectedLabel={projectedLabel} />
              </span>
            </span>
          }
        >
          {settle(<ProjectedText text={pick(cash.amount, lang)} period={cash.firstPeriod} projectedLabel={projectedLabel} />)}
        </Card>
      ) : (
        <Card
          testId="cockpit-min-cash"
          label={t("forecast.cockpit.numbers.minCash", "Lowest cash")}
          sub={t("forecast.cockpit.numbers.minCashWhen", "in {{month}} · no funding needed", {
            month: pick(cash.when, lang),
          })}
        >
          {settle(<ProjectedText text={pick(cash.amount, lang)} period={pick(cash.when, "en")} projectedLabel={projectedLabel} />)}
        </Card>
      )}

      {dscr.kind === "served" ? (
        <Card
          testId="cockpit-dscr"
          tone={dscr.below ? "bad" : "good"}
          label={t("forecast.cockpit.numbers.dscr", "DSCR {{year}}", { year: yearLabel(dscr.period) })}
          sub={
            <span data-testid="cockpit-dscr-verdict" data-below={dscr.below ? "true" : "false"}>
              <span className={dscr.below ? "font-medium text-alert" : "font-medium text-success"}>
                {dscr.below
                  ? t("forecast.cockpit.numbers.dscrBelow", "below the bank's threshold")
                  : t("forecast.cockpit.numbers.dscrAbove", "above the bank's threshold")}
              </span>{" "}
              {t("forecast.cockpit.numbers.dscrThreshold", "of {{threshold}}", {
                threshold: pick(dscr.threshold, lang),
              })}
            </span>
          }
        >
          {settle(
            <ProjectedText
              text={pick(dscr.value, lang)}
              period={dscr.period}
              projectedLabel={projectedLabel}
              className={dscr.below ? "text-alert" : "text-success"}
              testId="cockpit-dscr-value"
            />,
          )}
        </Card>
      ) : (
        <Card
          testId="cockpit-dscr"
          label={t("forecast.cockpit.numbers.dscr", "DSCR {{year}}", { year: yearLabel(dscr.period) })}
          sub={pick(dscr.formula, lang) || undefined}
        >
          <span
            data-testid="cockpit-dscr-refusal"
            data-projected="refused"
            className="block whitespace-normal text-[13px] font-normal leading-snug text-ink-soft"
          >
            {t("forecast.cockpit.numbers.dscrNone", "Not applicable: the plan carries no debt service in {{year}}", {
              year: yearLabel(dscr.period),
            })}
          </span>
        </Card>
      )}
    </section>
  );
}
