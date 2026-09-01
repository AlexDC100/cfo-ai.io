// THE ARTIFACTS — the one way a figure appears inside an artifact.
//
// `<Amount>` is THE component that renders a number in this product, and
// this is a thin wrapper around it, not a replacement. It adds exactly
// two things, and both are about being checkable:
//
//   `data-fact` — the fact NAME behind the figure, in the DOM. It makes
//   the C1/C3 DOM law decidable on an artifact: the law walks text nodes
//   and asks whether each digit sits inside an element that names where
//   it came from, and `data-fact` is one of the four attributes it
//   accepts. Without it a resolved DIMENSIONLESS figure — a ratio, a
//   percent, a day count — is indistinguishable in the DOM from a number
//   a model typed, which is the exact distinction the law exists to
//   make. (`Amount` marks money and provenance-carrying figures itself;
//   it cannot mark the rest, and it is import-only for this lane.)
//
//   `data-unit` — the DECLARED unit, so a gate can assert that a percent
//   was rendered as a percent rather than as a bare ratio. Unit drift is
//   silent: 0.152 rendered without its unit reads as a multiple.
//
// It also owns the unit→`kind` mapping in ONE place. That mapping was
// duplicated across five artifact components while this lane was being
// built, and five copies of a mapping is five chances for a ratio to
// acquire a currency.
//
// ABSENCE renders the glyph and nothing else — no value attribute, no
// zero, nothing a scraper could mistake for a figure.

import { useTranslation } from "react-i18next";

import { Amount } from "@/components/instrument/Amount";

import "./artifactI18n";
import type { ResolvedFigure } from "./artifactResolve";

/** Declared unit → the `<Amount>` kind that renders it.
 *
 *  `ratio` maps to "multiple" (1,52×) and `percent` to "percent"
 *  (+15,2%) because those are the two renderings the product already
 *  uses for those units; `days`, `count` and `score` are plain counts.
 *  There is no default branch that reaches "money" — a unit this build
 *  does not know must never acquire a currency. */
export function amountKindFor(unit: string): "money" | "percent" | "multiple" | "count" {
  if (unit === "money") return "money";
  if (unit === "percent") return "percent";
  if (unit === "ratio") return "multiple";
  return "count";
}

export interface ArtifactFigureProps {
  figure: ResolvedFigure;
  fractionDigits?: number;
  /** Force a leading + on positives — delta columns only. */
  signed?: boolean;
  className?: string;
}

export function ArtifactFigure({
  figure,
  fractionDigits,
  signed,
  className,
}: ArtifactFigureProps) {
  const { t } = useTranslation();
  if (!figure.present) {
    return (
      <span
        data-testid="artifact-figure-absent"
        data-absent="true"
        className="font-mono text-ink-faint"
      >
        {t("artifact.missing")}
      </span>
    );
  }
  return (
    <span data-fact={figure.fact} data-unit={figure.unit}>
      <Amount
        value={figure.value}
        kind={amountKindFor(figure.unit)}
        currency={figure.currency}
        fractionDigits={fractionDigits}
        signed={signed}
        provenance={figure.provenance}
        className={className}
      />
    </span>
  );
}
