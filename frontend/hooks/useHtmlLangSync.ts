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
//
// NO SPEED, NO COUNT (2026-10-02). It also said "in 90 seconds" and "22
// ratios" — on the title-adjacent description, both share descriptions, the
// image alt, the manifest and the share image itself. Nobody has measured
// upload-to-report in production, and 22 is the Excel export's ratio-spec
// count while the report the landing links to states 30. Both are gone from
// every share surface until they are measured (gate `landing-proof`,
// "quotes no unmeasured speed").
export const META_DESCRIPTION: Record<string, string> = {
  en: "Upload a Romanian trial balance (RAS) and get a CFO-grade analysis — statements, ratios, a valuation range and a credit score. The tested file layouts are read by a deterministic engine. Files from other countries are not supported yet.",
  ro: "Încarcă o balanță de verificare românească (RAS) și primești o analiză de nivel CFO — situații, indicatori, un interval de evaluare și un scor de credit. Formatele de fișier testate sunt citite de un motor determinist. Fișierele din alte țări nu sunt încă suportate.",
};
/** The document title and its share twins, per language. index.html ships
 *  the English one; the title used to stay English on the Romanian page. */
export const META_TITLE: Record<string, string> = {
  en: "CFO AI — CFO-grade analysis from a Romanian trial balance",
  ro: "CFO AI — analiză de nivel CFO dintr-o balanță de verificare românească",
};
/** The share image is drawn in English (scripts/build_og_image.mjs); its
 *  alt text says what it shows, in the reader's language. */
export const META_IMAGE_ALT: Record<string, string> = {
  en: "CFO AI: turn a Romanian trial balance into a CFO-grade analysis.",
  ro: "CFO AI: transformă o balanță de verificare românească într-o analiză de nivel CFO. Textul din ilustrație este în engleză.",
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
    const title = META_TITLE[lng] ?? META_TITLE.en;
    setMeta('meta[property="og:title"]', title);
    setMeta('meta[name="twitter:title"]', title);
    const alt = META_IMAGE_ALT[lng] ?? META_IMAGE_ALT.en;
    setMeta('meta[property="og:image:alt"]', alt);
    setMeta('meta[name="twitter:image:alt"]', alt);
    // The landing's own document title; a page that sets its own (the
    // public sample, the app's routes) overwrites it after this effect.
    if (Object.values(META_TITLE).includes(document.title)) document.title = title;
  }, [i18n.language]);
}
