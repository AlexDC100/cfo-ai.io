// i18n bootstrap.
//
// LANGUAGE PRIORITY ORDER (highest first):
//   1. URL override               — ?lang=ro | de | fr …
//   2. User profile preference    — users.language (set in Settings)
//   3. Last-uploaded document     — documents.detected_language (auth only,
//                                   ONLY if the user opted into auto-detect)
//   4. Browser Accept-Language    — auth only, only if no documents loaded
//   5. Fallback                   — 'en'
//
// MARKETING PAGES (unauthenticated): ONLY URL `?lang=` and persisted
// localStorage are honored. Browser Accept-Language is explicitly ignored
// so a German visitor lands on English copy by default — Stripe / Linear /
// Notion pattern, not auto-detect. The user must pick a language
// explicitly via the footer switcher (which writes to localStorage).
//
// AUTHENTICATED PAGES: English by default. The product flips to a different
// language only after the user (a) explicitly picks one in Settings or
// (b) explicitly opts into "Auto-detect from documents" in Settings. We do
// NOT auto-flip on first upload — that produces the disorienting
// "I signed up in English, now my dashboard is in a language I don't read"
// failure mode.
//
// Resolution happens in two layers:
//   - i18next detection (this file) handles persistence + URL override
//   - useLanguage() (./useLanguage.ts) layers the auth-aware priority
//     chain on top and calls i18n.changeLanguage() via <LanguageSync />.
//
// Adding a language is a JSON drop in src/i18n/locales/<code>.json + an
// entry in SUPPORTED_LANGUAGES below. No code change in callers — they
// all read strings via the t('key.path') hook.

import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

import en from "./locales/en.json";
import ro from "./locales/ro.json";
import de from "./locales/de.json";
import fr from "./locales/fr.json";
import es from "./locales/es.json";
// IT / PT / NL / PL locale files remain on disk (`./locales/it.json` etc.)
// but are NOT imported or registered as resources here. The product
// languages are currently {en, ro, de, fr, es}; the others were
// removed from the visible switcher because they weren't being kept
// up-to-date with new translation keys. Re-adding any of them is a
// one-line revert of this list + the resources block below.

export const SUPPORTED_LANGUAGES = [
  { code: "en", label: "English",   flag: "🇬🇧" },
  { code: "ro", label: "Română",    flag: "🇷🇴" },
  { code: "de", label: "Deutsch",   flag: "🇩🇪" },
  { code: "fr", label: "Français",  flag: "🇫🇷" },
  { code: "es", label: "Español",   flag: "🇪🇸" },
] as const;

export type SupportedLanguageCode = (typeof SUPPORTED_LANGUAGES)[number]["code"];

export const SUPPORTED_LANGUAGE_CODES: readonly SupportedLanguageCode[] =
  SUPPORTED_LANGUAGES.map((l) => l.code);

export function isSupportedLanguage(code: string | null | undefined): code is SupportedLanguageCode {
  return !!code && (SUPPORTED_LANGUAGE_CODES as readonly string[]).includes(code);
}

export const LANGUAGE_STORAGE_KEY = "cfo.userLanguage";
/** Auth-only flag — when true, the user has explicitly opted in to letting
 *  document-detection drive UI language. Default is false (English-first). */
export const AUTO_DETECT_FLAG_KEY = "cfo.autoDetectLanguage";

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
    // FORCE English as the initial render language. <LanguageSync /> may
    // change it post-hydration based on the priority chain.
    lng: "en",
    fallbackLng: "en",
    supportedLngs: SUPPORTED_LANGUAGE_CODES as unknown as string[],
    interpolation: { escapeValue: false }, // React already escapes
    detection: {
      // querystring (?lang=) → localStorage → fallback. Browser Accept-Language
      // is explicitly OMITTED here. We don't want a German visitor to /
      // auto-flip into German before they've even read the headline.
      order: ["querystring", "localStorage"],
      lookupQuerystring: "lang",
      lookupLocalStorage: LANGUAGE_STORAGE_KEY,
      caches: ["localStorage"],
    },
    // Dev-only: surface missing translation keys so they don't ship to prod
    // unnoticed. Production builds tree-shake the import.meta.env.DEV branch.
    saveMissing: import.meta.env.DEV,
    missingKeyHandler: (lngs, ns, key) => {
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.warn(`[i18n] Missing key: ${key} (${Array.isArray(lngs) ? lngs.join(",") : lngs})`);
      }
    },
  });

export default i18n;

/** Imperative language change — persists to localStorage. Marketing footer
 *  switcher and Settings → Language both call this. */
export function setLanguage(code: string): void {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, code);
  } catch {
    /* private mode — best effort */
  }
  void i18n.changeLanguage(code);
}

/**
 * Authenticated language change — local persist (localStorage + i18next)
 * PLUS profile + auth-metadata mirror so the choice survives both a browser
 * cache clear AND wins over the priority chain in useLanguage.ts (which
 * reads user_metadata.language ABOVE storedLang on authenticated pages).
 *
 * Without this profile sync, the sidebar Globe popover would write to
 * localStorage but LanguageSync would immediately override back to whatever
 * user_metadata.language already says — making the click silently
 * ineffective. The auth-aware priority chain sits between the user and
 * their local-only override, so the Globe button must mirror to the
 * profile to "win" over the priority chain.
 *
 * Best-effort on the network calls — both Supabase updates are wrapped in
 * try/catch and a failed call doesn't roll back the local change.
 */
export async function pickLanguageWithProfileSync(
  code: string,
  user: { id: string } | null | undefined,
  supabase: {
    from: (table: string) => {
      update: (patch: Record<string, unknown>) => {
        eq: (col: string, val: string) => Promise<unknown>;
      };
    };
    auth: { updateUser: (args: { data: Record<string, unknown> }) => Promise<unknown> };
  } | null | undefined,
): Promise<void> {
  setLanguage(code);
  if (user && supabase) {
    try {
      await supabase.from("profiles").update({ language: code }).eq("id", user.id);
    } catch {
      /* `language` column may not exist yet — non-fatal */
    }
    try {
      await supabase.auth.updateUser({ data: { language: code } });
    } catch { /* non-fatal */ }
  }
}

/** Read the active language synchronously. Useful for backend calls
 *  that need to pass `output_language` to Opus. */
export function getActiveLanguage(): string {
  return i18n.language || "en";
}

/** Read the user's "auto-detect from documents" preference. Default: false.
 *  When false, document detection cannot flip the UI — the user must pick a
 *  language explicitly. This prevents the disorienting auto-flip on first
 *  upload. */
export function getAutoDetectLanguage(): boolean {
  try {
    return localStorage.getItem(AUTO_DETECT_FLAG_KEY) === "1";
  } catch {
    return false;
  }
}

export function setAutoDetectLanguage(enabled: boolean): void {
  try {
    localStorage.setItem(AUTO_DETECT_FLAG_KEY, enabled ? "1" : "0");
  } catch {
    /* private mode — best effort */
  }
}
