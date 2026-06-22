// useDocumentTitle — sets document.title from an i18n key. Re-runs when
// the active language changes, so the browser tab updates instantly on
// language switch (otherwise the title stays in the previous language
// until the next nav).
//
// Usage in any page component:
//   useDocumentTitle('page.titles.products');
//
// With dynamic params (e.g. company name in title):
//   useDocumentTitle('page.titles.dashboard', { company: orgName });

import { useEffect } from "react";
import { useTranslation } from "react-i18next";

export function useDocumentTitle(
  i18nKey: string,
  params?: Record<string, unknown>,
): void {
  const { t, i18n } = useTranslation();

  useEffect(() => {
    const translated = t(i18nKey, params);
    if (typeof translated === "string" && translated.length > 0) {
      document.title = translated;
    }
    // Re-fire when language changes so the title swaps to the new locale
    // without waiting for the next nav. params is JSON-stringified for
    // dep tracking since callers commonly pass new object identities.
  }, [i18nKey, params, t, i18n.language]);
}

/** Standalone version for places that aren't React components (e.g. error
 *  pages that bypass the React tree). Use sparingly. */
export function setDocumentTitleFromKey(
  i18nKey: string,
  i18nInstance: ReturnType<typeof useTranslation>["i18n"],
  params?: Record<string, unknown>,
): void {
  const translated = i18nInstance.t(i18nKey, params);
  if (typeof translated === "string" && translated.length > 0) {
    document.title = translated;
  }
}
