// WHAT THE REVENUE GROWTH STANDS ON — the one default a reader will argue
// with, shown with the evidence under it.
//
// When a comparable prior year exists in this workspace the engine measures
// the growth from the book's OWN two turnovers and serves both of them, with
// the period end each was read at. This renders those two figures and the
// growth they imply — the growth is the served driver value, not a division
// done here.
//
// When there is no prior the ladder falls through and the engine says so, rung
// by rung, in its own words. A company with only one year grows at its
// SECTOR's median net-turnover growth (forecast-scenarios-live): the engine
// serves the evidence — the CAEN class (or the division, stated), the size
// band, n filers, the two filed years and the source — and this renders it
// with the served sentence. With no sector figure the macro anchor stands,
// with its source and the date it was stated as of. A flat zero-percent plan
// is only ever shown when the book's own history measures zero, and then it
// is a MEASURED zero with two turnovers beside it.

import { useTranslation } from "react-i18next";

import type { LeverRef, ProjectionView } from "@/lib/forecastFacts";
import { displaySuffix, wireToDisplay } from "@/lib/forecastLevers";

export interface GrowthBasisProps {
  readonly view: ProjectionView;
  /** The book's own currency formatter, in MAJOR units — the two turnovers
   *  are ACTUALS the engine measured, quoted inside the driver's basis. */
  readonly format: (value: number) => string;
}

export function GrowthBasis({ view, format }: GrowthBasisProps) {
  const { t } = useTranslation();
  const lever: LeverRef | null = view.lever("revenue_growth");
  if (!lever) return null;
  const tier = lever.basis.tier;
  const inputs = lever.basis.bookInputs;
  const value = wireToDisplay(lever.valueTexts[0] ?? null, lever);

  return (
    <section
      data-testid="forecast-growth-basis"
      data-growth-tier={tier ?? ""}
      className="rounded-xl border border-rule bg-surface px-4 py-3"
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="font-mono text-[11px] uppercase tracking-wider text-ink-mute">
          {t("forecast.growth.title", "Revenue growth stands on")}
        </h2>
        <span
          data-testid="forecast-growth-tier"
          data-tier={tier ?? ""}
          className="rounded-full border border-rule px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-ink-mute"
        >
          {t(`forecast.tier.${tier}`, tier ?? "")}
        </span>
        <span className="text-[13px] tabular-nums text-ink" data-testid="forecast-growth-value">
          {value}
          {displaySuffix(lever)}
        </span>
      </div>

      {inputs.length > 0 ? (
        <ul
          data-testid="forecast-growth-inputs"
          className="mt-2 space-y-1 text-[12px] leading-snug text-ink-soft"
        >
          {inputs.map((input) => (
            <li key={`${input.fact}-${input.periodEnd}`} className="tabular-nums">
              <span className="font-mono text-[10px] uppercase tracking-wider text-ink-mute">
                {input.periodEnd}
              </span>{" "}
              {input.value === null
                ? t("forecast.growth.absentInput", "not measurable from this book")
                : format(input.value)}
              <span className="text-ink-mute"> · {input.fact}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {lever.basis.sector ? (
        <p
          data-testid="forecast-growth-sector"
          className="mt-2 font-mono text-[10.5px] uppercase tracking-wider text-ink-mute"
        >
          {t("forecast.growth.sectorLine", {
            caen: lever.basis.sector.sectorCaen,
            label: lever.basis.sector.sectorLabel,
            band: t(`forecast.growth.band.${lever.basis.sector.sizeBand}`, lever.basis.sector.sizeBand),
            n: lever.basis.sector.n ?? "",
            prior: lever.basis.sector.priorYear ?? "",
            year: lever.basis.sector.year ?? "",
            defaultValue: "CAEN {{caen}} · {{band}} · n={{n}} · FY{{prior}}→FY{{year}}",
          })}
          {lever.basis.sector.level === "caen2"
            ? ` · ${t("forecast.growth.division", "CAEN division, not the class")}`
            : null}
        </p>
      ) : null}
      {lever.basis.macro ? (
        <p
          data-testid="forecast-growth-macro"
          className="mt-2 font-mono text-[10.5px] uppercase tracking-wider text-ink-mute"
        >
          {t("forecast.growth.macroLine", {
            source: lever.basis.macro.source,
            date: lever.basis.macro.statedAsOf,
            defaultValue: "{{source}} · stated as of {{date}}",
          })}
        </p>
      ) : null}

      <p className="mt-2 text-[12px] leading-snug text-ink-soft">
        {lever.basis.sentence}
      </p>

      {/* EVERY RUNG THE LADDER TRIED. A reader who asks "why not the book's
          own history?" is owed the engine's answer, not silence. */}
      {lever.basis.fallbackSteps.length > 0 ? (
        <ul
          data-testid="forecast-growth-ladder"
          className="mt-2 space-y-0.5 text-[11px] leading-snug text-ink-mute"
        >
          {lever.basis.fallbackSteps.map((step) => (
            <li key={`${step.tier}-${step.outcome}`} data-rung={step.tier}>
              {t(`forecast.tier.${step.tier}`, step.tier)}: {step.reason}
            </li>
          ))}
        </ul>
      ) : null}

      {/* The candidates the engine considered and passed over, each with the
          verdict it left. `held` is what the growth was measured from. */}
      {view.history.excluded.length > 0 ? (
        <ul
          data-testid="forecast-growth-history"
          className="mt-2 space-y-0.5 text-[11px] leading-snug text-ink-mute"
        >
          {view.history.excluded.map((row) => (
            <li key={`${row.periodId}-${row.label}`}>
              {row.label} — {row.sentence}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export default GrowthBasis;
