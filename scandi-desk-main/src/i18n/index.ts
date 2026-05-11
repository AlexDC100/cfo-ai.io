// i18n bootstrap.
//
// Language resolution order (highest priority first):
//   1. localStorage `cfoai.language` — explicit user pick from Settings.
//   2. The most recent upload's `documents.detected_language` — the magic
//      bit. A German user drops a Saldenliste; UI flips to German until
//      they explicitly change it. (Wired by useDetectedLanguageEffect.)
//   3. Browser `navigator.language` via i18next-browser-languagedetector.
//   4. Fallback: 'en'.
//
// Adding a language is a JSON drop in src/i18n/locales/<code>.json + an
// entry in SUPPORTED below. No code change in callers — they all read
// strings via the t('key.path') hook.

import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

import en from "./locales/en.json";
import ro from "./locales/ro.json";
import de from "./locales/de.json";
import fr from "./locales/fr.json";
import es from "./locales/es.json";

export const SUPPORTED_LANGUAGES = [
  { code: "en", label: "English",   flag: "🇬🇧" },
  { code: "ro", label: "Română",    flag: "🇷🇴" },
  { code: "de", label: "Deutsch",   flag: "🇩🇪" },
  { code: "fr", label: "Français",  flag: "🇫🇷" },
  { code: "es", label: "Español",   flag: "🇪🇸" },
] as const;

export const LANGUAGE_STORAGE_KEY = "cfoai.language";

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      ro: { translation: ro },
      de: { translation: de },
      fr: { translation: fr },
      es: { translation: es },
    },
    lng: "en",
    fallbackLng: "en",
    supportedLngs: SUPPORTED_LANGUAGES.map((l) => l.code),
    interpolation: { escapeValue: false }, // React already escapes
    detection: {
      // localStorage only — if the user explicitly picks a language in
      // Settings → Language, persist that. Otherwise stay in English.
      // Browser-language auto-detection was removed in the english-default
      // pass: too many users were getting flipped into Romanian/German
      // unexpectedly. Multi-country narrative still flows when the user
      // picks their language explicitly OR when the document-detection
      // stage ships and overrides per-upload.
      order: ["localStorage"],
      lookupLocalStorage: LANGUAGE_STORAGE_KEY,
      caches: ["localStorage"],
    },
  });

export default i18n;

/** Imperative language change — persists to localStorage. */
export function setLanguage(code: string): void {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, code);
  } catch {
    /* private mode — best effort */
  }
  void i18n.changeLanguage(code);
}

/** Read the active language synchronously. Useful for backend calls
 *  that need to pass `output_language` to Opus. */
export function getActiveLanguage(): string {
  return i18n.language || "en";
}
