// Capsule empty state / degraded chrome — i18n bundle, bridge-registered.
//
// Same pattern as ../shellI18n.ts and lib/capsuleRouterI18n.ts: strings
// register at module load via addResourceBundle with overwrite=false, so
// if the locale-file owners later merge these keys into
// i18n/locales/{en,ro}.json this becomes a no-op. Everything lives under
// the `capsuleEmpty` top-level key — deliberately NOT `capsuleRouter.*`,
// which the router lane owns; two bundles must never claim one namespace.
// Romanian is informal (tu-form) with full diacritics.
//
// `lib/capsuleSuggestions.ts` deliberately does NOT import this file: the
// engine is pure and must stay runnable in a test or a worker without
// i18n. Any SURFACE that renders suggestion rows imports this module (and
// `@/lib/capsuleRouterI18n`, for the router's own row keys).

import i18n from "@/i18n";
import strings from "./capsuleEmptyStrings.json";

i18n.addResourceBundle(
  "en", "translation", { capsuleEmpty: strings.en.capsuleEmpty }, true, false,
);
i18n.addResourceBundle(
  "ro", "translation", { capsuleEmpty: strings.ro.capsuleEmpty }, true, false,
);

/** Explicit no-op so a caller can express the dependency as a call rather
 *  than relying on import-for-side-effect surviving a bundler tree shake. */
export function ensureCapsuleEmptyStrings(): void {
  /* the module-level addResourceBundle calls above are the work */
}
