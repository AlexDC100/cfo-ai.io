// THE INSTRUMENT — <Amount>, the one component that renders a figure.
//
// Every numeric value in the product goes through here: mono face,
// tabular lining figures, locale from the UI language, magnitude from
// the enclosing <AmountGroup>, accounting negatives — all owned in one
// place so a screen cannot invent its own number style.
//
// THE SIGNATURE — provenance on hover AND on focus. When (and only when)
// the value arrives with provenance in the payload, the figure gets a
// 1px dotted underline in accent at 40% and a card naming what the
// payload actually holds. The affordance itself lives in
// `./Provenance` — <Amount> is one of its callers, not its owner,
// because the money path (`lib/narrativeMoney`) and the statement
// renderers paint figures this component never sees and they need the
// SAME affordance, not a second one that drifts.
//
// Where provenance isn't in the payload the figure renders WITHOUT the
// affordance — `hasProvenance` refuses a provenance prop with no
// substance (never fake trust; the gate plants a fake and expects
// refusal).

import { ReactNode, createContext, useContext, useMemo } from "react";

import { useActiveLocale } from "@/lib/locale";
import {
  AMOUNT_MISSING,
  FormatAmountOptions,
  Magnitude,
  MAGNITUDE_UNIT,
  formatAmount,
  formatExact,
  formatMultiple,
  formatPercentDelta,
  pickMagnitude,
} from "@/lib/amountFormat";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ProvenanceAffordance,
  hasProvenance,
  type AmountProvenance,
} from "./Provenance";

// The payload type and its substance check are DEFINED in ./Provenance —
// every figure path shares one shape or they are not the same affordance.
// Re-exported here because <Amount> was their address for the whole
// codebase and moving a type should not be a rename across 40 files.
export { hasProvenance, type AmountProvenance };

// ── magnitude groups ───────────────────────────────────────────────────

const MagnitudeContext = createContext<Magnitude | null>(null);

/** Declares one shared scale for every <Amount kind="money"> inside.
 *  Pass the group's raw values; the largest member picks the scale, so
 *  "15,1 M€" beside "41.944,6 €" is impossible by construction. */
export function AmountGroup({
  values,
  children,
}: {
  values: Array<number | null | undefined>;
  children: ReactNode;
}) {
  const magnitude = useMemo(() => pickMagnitude(values), [values]);
  return (
    <MagnitudeContext.Provider value={magnitude}>
      {children}
    </MagnitudeContext.Provider>
  );
}

// ── the component ──────────────────────────────────────────────────────

export interface AmountProps {
  value: number | null | undefined;
  kind?: "money" | "percent" | "multiple" | "count";
  /** Display symbol ("€", "RON", "$"). Money only. */
  currency?: string | null;
  /** Explicit override; else the enclosing AmountGroup, else unit. */
  magnitude?: Magnitude;
  fractionDigits?: number;
  /** Force + on positives (delta chips). */
  signed?: boolean;
  /** Cap for kind="multiple" — renders "≥99×" with exact in tooltip. */
  cap?: number;
  provenance?: AmountProvenance | null;
  /** "1 EUR = 5,2489 RON · display only" — shown in the tooltip. */
  conversionNote?: string;
  className?: string;
}

/** The one way a figure appears on screen. Mono, tabular, locale-aware;
 *  provenance affordance only when the payload carries it. */
export function Amount({
  value,
  kind = "money",
  currency,
  magnitude,
  fractionDigits,
  signed,
  cap,
  provenance,
  conversionNote,
  className,
}: AmountProps) {
  const locale = useActiveLocale();
  const groupMag = useContext(MagnitudeContext);
  const mag = magnitude ?? (kind === "money" ? groupMag ?? MAGNITUDE_UNIT : MAGNITUDE_UNIT);

  let display: string;
  let tooltipExtra: string | null = null;
  if (kind === "percent") {
    const r = formatPercentDelta(value, { locale, fractionDigits });
    display = r ? r.display : AMOUNT_MISSING;
    if (r?.asMultiplier) tooltipExtra = r.exactPercent;
  } else if (kind === "multiple") {
    const r = formatMultiple(value, { locale, cap, fractionDigits });
    display = r ? r.display : AMOUNT_MISSING;
    if (r?.capped) tooltipExtra = r.exact;
  } else {
    const opts: FormatAmountOptions = {
      locale,
      currency: kind === "money" ? currency : null,
      magnitude: mag,
      fractionDigits,
      signed,
    };
    display = formatAmount(value, opts);
  }

  const base = (
    <span className={`font-mono tabular-nums ${className ?? ""}`.trim()}>{display}</span>
  );

  const withProvenance = hasProvenance(provenance);
  const needsTooltip = withProvenance || tooltipExtra !== null;
  if (!needsTooltip || value == null) return base;

  const exact =
    kind === "percent" || kind === "multiple"
      ? tooltipExtra ?? display
      : formatExact(value, { locale, currency: kind === "money" ? currency : null });

  // PROVENANCE goes to the shared affordance, so this figure and a
  // statement row and a Capsule money span all open the SAME card.
  if (withProvenance) {
    return (
      <ProvenanceAffordance
        provenance={provenance}
        value={value}
        exact={exact}
        conversionNote={conversionNote}
        className={`font-mono tabular-nums ${className ?? ""}`.trim()}
      >
        {display}
      </ProvenanceAffordance>
    );
  }

  // NOT provenance: a capped multiple ("≥99×") or a percent shown as a
  // multiplier still owes the reader its exact value. Deliberately a
  // plain tooltip with no `data-provenance` and no dotted underline —
  // the affordance means "this figure names its origin", and a rounding
  // disclosure that borrowed the same chrome would dilute it to
  // decoration on the figures that DO carry an origin.
  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className={`cursor-help font-mono tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 ${className ?? ""}`.trim()}
        >
          {display}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="border-rule bg-popover text-popover-foreground shadow-3">
        <span className="font-mono text-[12px] tabular-nums">{exact}</span>
      </TooltipContent>
    </Tooltip>
  );
}
