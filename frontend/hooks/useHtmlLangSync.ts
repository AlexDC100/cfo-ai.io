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

export function useHtmlLangSync(): void {
  const { i18n } = useTranslation();
  useEffect(() => {
    const lng = (i18n.language || "en").split("-")[0];
    document.documentElement.lang = lng;
  }, [i18n.language]);
}
