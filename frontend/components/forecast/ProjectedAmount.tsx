// THE PROJECTED INSTRUMENT — <ProjectedAmount>, the ONE component that
// renders a projected figure. The sibling of `instrument/Amount.tsx`, and
// deliberately not it.
//
// <Amount> paints a FACT. Where the payload carries provenance it offers a
// dotted-underline jump to the source cell the number came out of. Every one
// of its callers is written on the assumption that the number is measured.
//
// A projection is not measured. It cannot be given to <Amount>: the value it
// would need is `ProjectedMinor`, an opaque type with no widening path to
// `number` (see `lib/forecastFacts.ts`), so `<Amount value={fig.amountMinor}/>`
// does not compile. The value only comes out through `projectedDisplay`, whose
// consumer signature hands you the marker in the same call. This component is
// what that consumer looks like when the destination is a screen.
//
// ── WHY THE DISTINCTION IS NOT A CSS CLASS ──────────────────────────────
//
// Because a class is a property of one renderer, and this product has at
// least four: screen, PDF, XLSX and the chat context builder. Four of five
// known defects in this repo lived in exactly that gap — a fix applied to the
// surface the author was looking at, and not to the export, which is different
// code. So the distinction is carried by the DATA (`marker.projected`, the
// basis list, the formula) and this component is one consumer of that data,
// not the owner of the distinction. Wave 2's exports consume the same marker.
//
// ── WHAT IT REFUSES ─────────────────────────────────────────────────────
//
// A projected figure whose basis is empty. `readProjection` cannot produce
// one — an unresolvable figure comes back as a `ProjectionRefusal` — but a
// caller can hand-build the interface, and a projected number with nothing
// behind it must never paint. It renders the refusal instead, naming the line.
//
// ── FORMATTING IS THE CALLER'S ──────────────────────────────────────────
//
// `format` is a required prop, not an internal helper. Locale, magnitude and
// currency placement belong to the surface's own amount context; a second
// formatter here would be a second opinion about how money looks, which is the
// drift this repo already pays for elsewhere.

import { type ReactNode } from "react";

import {
  isProjectedFigure,
  projectedDisplay,
  type ProjectedFigure,
  type ProjectedMarker,
  type ProjectionRefusal,
} from "@/lib/forecastFacts";

export interface ProjectedAmountProps {
  /** The figure, straight from `readProjection(...).figure(line, period)`. */
  figure: ProjectedFigure | ProjectionRefusal;
  /** The ACTUAL period the whole projection stands on. */
  basePeriodLabel: string;
  /** Turn the display value into the string this surface paints. Required —
   *  see the note above on why there is no formatter in here. */
  format: (value: number) => string;
  /** The word for "projected" in the active UI language. Passed in rather
   *  than resolved here so this component pulls in no i18n dependency; the
   *  surfaces that mount it own their own copy. */
  projectedLabel?: string;
  /** Rendered beside the figure — the assumptions affordance. Given the
   *  marker so it can list drivers, values and stated bases. */
  renderBasis?: (marker: ProjectedMarker) => ReactNode;
  className?: string;
}

/** The class every projected figure on every screen carries. Exported so a
 *  gate can assert its presence rather than trusting that it was applied —
 *  and note that it is the SECONDARY signal: the primary one is that the
 *  value could not have reached this component except through the marker. */
export const PROJECTED_FIGURE_CLASS = "forecast-projected";

/** The `data-` attribute a DOM-level gate reads. A screenshot cannot be
 *  asserted on; this can. */
export const PROJECTED_FIGURE_ATTR = "data-projected";

export function ProjectedAmount({
  figure,
  basePeriodLabel,
  format,
  projectedLabel = "projected",
  renderBasis,
  className,
}: ProjectedAmountProps) {
  if (!isProjectedFigure(figure)) {
    // A refusal carries no number, so nothing numeric is painted. The reader
    // is told the projection does not carry this line, which is a different
    // fact from "this line is zero".
    return (
      <span
        className={className}
        data-projected="refused"
        data-projected-code={figure.code}
        title={figure.detail}
      >
        —
      </span>
    );
  }

  if (figure.basis.length === 0) {
    return (
      <span
        className={className}
        data-projected="refused"
        data-projected-code="no_assumptions_behind_it"
        title={`${figure.line} carries no assumptions, so no number is shown`}
      >
        —
      </span>
    );
  }

  return projectedDisplay(figure, basePeriodLabel, (value, marker) => (
    <span
      className={[PROJECTED_FIGURE_CLASS, className].filter(Boolean).join(" ")}
      data-projected="true"
      data-projected-period={marker.period}
      data-projected-basis={marker.basis.map((a) => a.id).join(",")}
      data-projected-base-period={marker.basePeriodLabel}
    >
      <span data-projected-value="true">{format(value)}</span>
      <span
        aria-label={projectedLabel}
        data-projected-mark="true"
        // The mark is not decoration and is not optional: it is rendered in
        // the same expression as the value, from the same marker, so there is
        // no code path that paints one without the other.
      >
        {projectedLabel}
      </span>
      {renderBasis ? renderBasis(marker) : null}
    </span>
  ));
}

export default ProjectedAmount;
