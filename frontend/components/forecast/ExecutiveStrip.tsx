// THE EXECUTIVE STRIP — the four figures a reader looks at before anything
// else: how much funding the plan needs and when, whether a covenant breaks,
// what cash it throws off over the horizon, and where cash ends.
//
// ── EVERY FIGURE IS THE ENGINE'S OWN ────────────────────────────────────
//
// `strip` has been on the wire since fp1.2 and each slot is a served amount
// with its own driver list and formula — "closing cash of the cash flow
// statement", "sum of operating and investing cash over the served periods".
// The engine's own gate asserts each one equals the figures it summarises, to
// the cent. This component composes nothing: a strip assembled here would be a
// second authority for facts the engine already states, which is the shape
// that produced B6RV2-5.
//
// ── THE COVENANT SLOT SAYS WHAT IT IS ───────────────────────────────────
//
// `strip.first_breach_period` is a STANDING REFUSAL in this build: the engine
// holds no covenant input, and `summary.runway.facility_limit` is itself
// refused. A shortfall is the plan running out of cash; a breach is a ratio
// crossing a lender's cutoff. Putting `first_shortfall_period` under a
// "covenant breach" label would be a fabrication, and printing "none in
// horizon" would be an absent read as a negative — the exact defect class this
// repo has already paid for on credit ratings. So the slot renders the
// engine's refusal in the engine's words.

import { useTranslation } from "react-i18next";

import { ProjectedAmount } from "@/components/forecast/ProjectedAmount";
import { isProjectedFigure, type ProjectionView } from "@/lib/forecastFacts";
import { servedFormula, servedSentence } from "@/lib/forecastSentences";

export interface ExecutiveStripProps {
  readonly view: ProjectionView;
  readonly format: (value: number) => string;
  readonly projectedLabel: string;
}

function Cell({
  id,
  label,
  children,
  note,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
  note?: React.ReactNode;
}) {
  return (
    <div
      data-testid={`forecast-strip-${id}`}
      className="min-w-0 rounded-xl border border-rule bg-surface px-4 py-3"
    >
      <p className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">
        {label}
      </p>
      <div className="mt-1 break-words text-[18px] font-medium tabular-nums text-ink">
        {children}
      </div>
      {note ? (
        <p className="mt-1 text-[11px] leading-snug text-ink-soft">{note}</p>
      ) : null}
    </div>
  );
}

export function ExecutiveStrip({
  view,
  format,
  projectedLabel,
}: ExecutiveStripProps) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const { strip, summary } = view;
  const breach = strip.firstBreachPeriod.result;
  const peak = strip.peakFundingGap;

  return (
    <section
      data-testid="forecast-strip"
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4"
    >
      <Cell
        id="peak-funding"
        label={t("forecast.strip.peakFunding", "Peak funding need")}
        note={
          // A zero peak with no period is a REAL answer — the plan never
          // draws — and it is not the same statement as an absent one.
          peak.period
            ? t("forecast.strip.peakAt", "Peak reached in {{period}}", {
                period: peak.period,
              })
            : t("forecast.strip.noDraw", "The plan never draws on the funding line")
        }
      >
        <ProjectedAmount
          figure={peak.result}
          basePeriodLabel={view.basePeriodLabel}
          format={format}
          projectedLabel={projectedLabel}
        />
      </Cell>

      <Cell
        id="first-breach"
        label={t("forecast.strip.firstBreach", "First covenant breach")}
        note={
          summary.firstShortfallPeriod
            ? t(
                "forecast.strip.shortfallInstead",
                "A cash shortfall — a different fact from a covenant breach — begins {{period}}.",
                { period: summary.firstShortfallPeriod },
              )
            : servedSentence(t, lang, summary.runwayCode, summary.runwaySentence)
        }
      >
        {/* The engine's sentence, verbatim. There is no covenant input in this
            build, so there is no year to name and no "none" to claim. */}
        <span
          data-testid="forecast-strip-breach-refusal"
          className="block text-[12px] font-normal leading-snug text-ink-soft"
        >
          {"refused" in breach && breach.refused
            ? servedSentence(t, lang, breach.servedCode, breach.detail)
            : t("forecast.strip.unexpected", "—")}
        </span>
      </Cell>

      <Cell
        id="cumulative-fcf"
        label={t("forecast.strip.cumulativeFcf", "Cumulative free cash flow")}
        note={
          isProjectedFigure(strip.cumulativeFcf.result)
            ? servedFormula(t, lang, strip.cumulativeFcf.result.formula)
            : undefined
        }
      >
        <ProjectedAmount
          figure={strip.cumulativeFcf.result}
          basePeriodLabel={view.basePeriodLabel}
          format={format}
          projectedLabel={projectedLabel}
        />
      </Cell>

      <Cell
        id="closing-cash"
        label={t("forecast.strip.closingCash", "Closing cash")}
        note={
          strip.closingCash.period
            ? t("forecast.strip.atPeriod", "At {{period}}", {
                period: strip.closingCash.period,
              })
            : undefined
        }
      >
        <ProjectedAmount
          figure={strip.closingCash.result}
          basePeriodLabel={view.basePeriodLabel}
          format={format}
          projectedLabel={projectedLabel}
        />
      </Cell>
    </section>
  );
}

export default ExecutiveStrip;
