// SourceText — wraps source-data strings (product names, category codes,
// brand names, parser column-name examples) that are NOT translated.
//
// Why this exists:
//   When the UI language is English/French and the data is Romanian, a
//   screen reader (VoiceOver, NVDA) reads Romanian words with the wrong
//   phonemes — "Denumire produs" pronounced with English syllables sounds
//   awful and unintelligible. Setting `lang="ro"` on the wrapping element
//   tells the AT to switch to Romanian phonemes for that subtree.
//
//   For sighted users this changes nothing visually; for assistive-tech
//   users it changes everything.
//
// Usage:
//   <SourceText lang="ro">NAVODUL PLIN Sardina in ulei 120g</SourceText>
//   <SourceText lang="ro">Denumire produs</SourceText>   (parser column name)
//
// Default `lang="ro"` because that's the dominant source-data language in
// this product today. Override when wrapping other-language source data.

import type { ReactNode } from "react";

export interface SourceTextProps {
  children: ReactNode;
  /** BCP-47 language tag for the wrapped content. Default 'ro' (Romanian). */
  lang?: string;
  className?: string;
}

export function SourceText({ children, lang = "ro", className }: SourceTextProps) {
  return (
    <span lang={lang} className={className}>
      {children}
    </span>
  );
}
