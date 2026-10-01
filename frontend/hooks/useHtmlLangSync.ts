// useHtmlLangSync — keeps <html lang="..."> in sync with the active i18n
// language. Mount once at the app root. Cheap (one effect, only runs on
// language change).
//
// Why this matters:
//   · Screen readers (VoiceOver, NVDA) switch phoneme set based on
//     <html lang>. Without this, German visitors who change to English
//     get English text read with German phonemes.
//   · Browser spell-check uses <html lang> to pick a dictionary.
//   · Translation services (Google Translate, Lingvo) use it to decide
//     whether to offer to translate the page.
//   · Search engines use it as a signal for language-targeted indexing.
//
// The default Vite template ships with <html lang="en"> hardcoded in
// index.html. This hook overrides it at runtime.

import { useEffect } from "react";
import { useTranslation } from "react-i18next";

// Localized <meta name="description"> + og:description/og:locale.
// index.html ships the English copy; when the UI language flips we swap
// the meta tags too so shares + SERP snippets match the page language.
//
// COVERAGE WORDING (2026-10-01): this sentence is what a search result and a
// link preview show. It said "other European charts of accounts read with AI
// assistance" while every test in the repository was a Romanian trial
// balance. It now states what is tested and what is not, and it is exported
// so the gate `public-claims` reads the exact strings the hook writes.
export const META_DESCRIPTION: Record<string, string> = {
  en: "Upload a Romanian trial balance (RAS) and get a CFO-grade analysis in 90 seconds — statements, 22 ratios, valuation, credit score. Computed by a deterministic engine. Files from other countries are not supported yet.",
  ro: "Încarcă o balanță de verificare românească (RAS) și primești o analiză de nivel CFO în 90 de secunde — situații, 22 de indicatori, evaluare, scor de credit. Calculată de un motor determinist. Fișierele din alte țări nu sunt încă suportate.",
};
const OG_LOCALE: Record<string, string> = { en: "en_GB", ro: "ro_RO" };

function setMeta(selector: string, content: string) {
  const el = document.head.querySelector<HTMLMetaElement>(selector);
  if (el) el.setAttribute("content", content);
}

export function useHtmlLangSync(): void {
  const { i18n } = useTranslation();
  useEffect(() => {
    const lng = (i18n.language || "en").split("-")[0];
    document.documentElement.lang = lng;
    const desc = META_DESCRIPTION[lng] ?? META_DESCRIPTION.en;
    setMeta('meta[name="description"]', desc);
    setMeta('meta[property="og:description"]', desc);
    setMeta('meta[name="twitter:description"]', desc);
    setMeta('meta[property="og:locale"]', OG_LOCALE[lng] ?? OG_LOCALE.en);
  }, [i18n.language]);
}
