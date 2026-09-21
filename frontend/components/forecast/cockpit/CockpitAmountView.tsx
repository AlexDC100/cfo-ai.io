// <CockpitAmountView> — the ONE component that paints a cockpit amount (a
// chart readout, a bridge step, a statement cell). The cockpit's sibling of
// <ProjectedAmount>, for the `forecast_cockpit/1` payload.
//
// A PROJECTED amount carries the ◇ mark, rendered in the same expression as
// the value from the same marker (`cockpitDisplay` hands both over in one
// call), so no path paints one without the other. An ACTUAL amount — year 0,
// read out of the book — carries `data-actual` and no mark. A REFUSED amount
// paints an em dash with the engine's reason on hover: "not served" and
// "zero" are different claims, and only one of them may look like a number.
//
// `format` is the caller's (one value at a time; lives in ./format.ts).

import { cockpitDisplay, pick, type CockpitAmount } from "@/lib/forecastCockpit";
import type { MoneyFormat } from "./format";

export function CockpitAmountView({
  amount,
  format,
  projectedLabel,
  lang,
  className,
}: {
  amount: CockpitAmount;
  format: MoneyFormat;
  projectedLabel: string;
  lang: string;
  className?: string;
}) {
  const painted = cockpitDisplay(amount, (value, marker) => (
    <span
      className={[marker.projected ? "forecast-projected" : undefined, className].filter(Boolean).join(" ")}
      data-projected={marker.projected ? "true" : undefined}
      data-actual={marker.projected ? undefined : "true"}
      data-period={marker.period}
    >
      <span data-projected-value="true">{format(value)}</span>
      {marker.projected ? (
        <sup
          aria-label={projectedLabel}
          title={projectedLabel}
          data-projected-mark="true"
          className="ml-[0.15em] select-none text-[0.65em] font-normal not-italic text-ink-mute"
        >
          ◇
        </sup>
      ) : null}
    </span>
  ));
  if (painted !== null) return painted;
  return (
    <span className={className} data-projected="refused" title={pick(amount.refusal, lang)}>
      —
    </span>
  );
}
