// LanguageSync — mount once at the app root (inside <BrowserRouter> and
// <AuthProvider>, since it reads URL + session). On every render it
// resolves the active language via useLanguage() and pushes the result
// into i18next via i18n.changeLanguage() if it differs from the current.
//
// Also keeps the document-level <html lang="..."> attribute aligned with
// the active code — SEO, screen readers, and CSS :lang() selectors rely on
// this matching the rendered content.

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useLanguage } from "./useLanguage";

export function LanguageSync(): null {
  const language = useLanguage();
  const { i18n } = useTranslation();

  useEffect(() => {
    if (i18n.language !== language) {
      void i18n.changeLanguage(language);
    }
    if (typeof document !== "undefined" && document.documentElement.lang !== language) {
      document.documentElement.lang = language;
    }
  }, [language, i18n]);

  return null;
}
