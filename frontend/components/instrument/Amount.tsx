// THE INSTRUMENT — <Amount>, the one component that renders a figure.
//
// Every numeric value in the product goes through here: mono face,
// tabular lining figures, locale from the UI language, magnitude from
// the enclosing <AmountGroup>, accounting negatives — all owned in one
// place so a screen cannot invent its own number style.
//
// THE SIGNATURE — provenance on hover. When (and only when) the value
// arrives with provenance in the payload, the figure gets a 1px dotted
// underline in accent at 40% and a hover/focus card naming the source,
// method, pack and snapshot. Where provenance isn't in the payload the
// figure renders WITHOUT the affordance — the component refuses a
// provenance prop with no substance (never fake trust; gate plants a
// fake and expects refusal).

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

// ── provenance ─────────────────────────────────────────────────────────

export interface AmountProvenance {
  /** "sheet Balanta · row 214 · col G" or "page 3". */
  source?: string;
  /** mechanical | mechanical_mapped | llm-verified. */
  method?: string;
  /** Verification score when the method carries one (0..1). */
  confidence?: number;
  /** e.g. "ro-omfp1802-v1". */
  pack?: string;
  /** ISO timestamp of the computation. */
  computedAt?: string;
  /** Short content hash of the snapshot. */
  snapshot?: string;
}

/** True when the payload actually carries something worth a tooltip.
 *  An empty object must NOT produce the affordance — that would be a
 *  trust chrome with nothing behind it. */
export function hasProvenance(p: AmountProvenance | null | undefined): p is AmountProvenance {
  if (!p) return false;
  return Boolean(p.source || p.method || p.pack || p.snapshot);
}

function ProvenanceCard({
  p,
  exact,
  conversionNote,
}: {
  p: AmountProvenance;
  exact: string;
  conversionNote?: string;
}) {
  return (
    <div className="max-w-[280px] space-y-1.5 text-left">
      <div className="font-mono text-[13px] tabular-nums text-ink">{exact}</div>
      <dl className="space-y-0.5 text-[11px] leading-snug text-ink-soft">
        {p.source && (
          <div>
            <dt className="inline text-ink-mute">Source&nbsp;</dt>
            <dd className="inline font-mono">{p.source}</dd>
          </div>
        )}
        {p.method && (
          <div>
            <dt className="inline text-ink-mute">Method&nbsp;</dt>
            <dd className="inline">
              {p.method}
              {typeof p.confidence === "number" && (
                <span className="font-mono tabular-nums"> · {Math.round(p.confidence * 100)}%</span>
              )}
            </dd>
          </div>
        )}
        {p.pack && (
          <div>
            <dt className="inline text-ink-mute">Pack&nbsp;</dt>
            <dd className="inline font-mono">{p.pack}</dd>
          </div>
        )}
        {(p.computedAt || p.snapshot) && (
          <div className="font-mono text-[10.5px] text-ink-mute">
            {p.computedAt ? `computed ${p.computedAt}` : null}
            {p.computedAt && p.snapshot ? " · " : null}
            {p.snapshot ? `snapshot ${p.snapshot}` : null}
          </div>
        )}
        {conversionNote && (
          <div className="pt-0.5 text-[10.5px] italic text-ink-mute">{conversionNote}</div>
        )}
      </dl>
    </div>
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

  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          data-provenance={withProvenance ? "true" : undefined}
          className={`cursor-help font-mono tabular-nums underline decoration-brand/40 decoration-dotted decoration-1 underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 ${className ?? ""}`.trim()}
        >
          {display}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="border-rule bg-popover text-popover-foreground shadow-3">
        {withProvenance ? (
          <ProvenanceCard p={provenance} exact={exact} conversionNote={conversionNote} />
        ) : (
          <span className="font-mono text-[12px] tabular-nums">{exact}</span>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
