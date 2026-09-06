// The ONE sentence a public surface prints where a credit letter would go
// when the reader could not mint one. It names the FIGURE and the FILING —
// "Rating unavailable: retained earnings not reported in this filing" —
// and never the company's condition. These are indexable pages a stranger
// reads with zero context; a placeholder letter next to a real company's
// name is a fabrication, and a vague refusal reads as a verdict.
//
// The sentence is composed by `ratingRefusalSentence` from the same
// `publicCompany.*` keys in both locales, so EN and RO cannot drift.

import { useTranslation } from "react-i18next";

import { ratingRefusalSentence, type RatingRefusal } from "@/lib/publicCompanyAdapters";

export function RatingRefusalNote({
  refusal,
  className,
}: {
  refusal: RatingRefusal;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <p
      className={className ?? "text-[12px] leading-snug text-ink-soft"}
      data-testid="rating-refusal"
      data-figures={refusal.figures.join(",")}
    >
      {ratingRefusalSentence(refusal, (key, opts) => String(t(key, opts)))}
    </p>
  );
}
