// THE ONE NOTE — printed only where the engine serves it.
//
// A property developer's margins are refused as not meaningful (turnover
// negligible against operating activity). Under the owner's one-EBITDA
// ruling (2026-09-26) its EBITDA INCLUDES the construction cost the book
// capitalised into stock through account 711 ("Variația stocurilor de
// produse"), and the note says so, with the figure. The ENGINE decides the
// case (packs/ratios/margin_meaning.yaml#note: margin refused, account mix
// read as real estate, a positive net 711) and renders the note with its
// figure read off the served `assembled_pl.inventory_variation.value` (the
// measured net 711). This component prints the served text in the reader's
// language and computes nothing; with no served note it renders nothing.

import { useTranslation } from "react-i18next";

import { marginNoteOf, pickMargin } from "@/lib/marginMeaning";

export function MarginMeaningNote({
  statements,
  className = "",
}: {
  statements: { margin_meaning?: unknown } | null | undefined;
  className?: string;
}) {
  const { i18n } = useTranslation();
  const note = marginNoteOf(statements);
  if (!note) return null;
  return (
    <p
      data-testid="margin-meaning-note"
      className={`rounded-md border border-rule bg-bg-2/50 px-3 py-2 text-[12.5px] leading-snug text-ink-soft ${className}`}
    >
      {pickMargin(note.display, i18n.language)}
    </p>
  );
}
