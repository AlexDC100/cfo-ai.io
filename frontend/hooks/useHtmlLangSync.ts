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
const META_DESCRIPTION: Record<string, string> = {
  en: "Upload your trial balance. Get analysis in 30 seconds. Auto-detects 15 European chart-of-accounts standards. Built for SME CFOs across Romania, Germany, France, Spain.",
  ro: "Încărcați balanța de verificare. Primiți analiza în 30 de secunde. Detectează automat 15 planuri de conturi europene. Creat pentru directorii financiari ai IMM-urilor din România și Europa.",
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
