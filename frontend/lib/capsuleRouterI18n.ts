// Capsule intent router — i18n bundle, bridge-registered.
//
// Same pattern as components/instrument/shell/shellI18n.ts: strings
// register at module load via addResourceBundle with overwrite=false, so
// if the locale-file owners later merge these keys into
// i18n/locales/{en,ro}.json this becomes a no-op. Everything lives under
// the `capsuleRouter` top-level key. Romanian is informal (tu-form) with
// full diacritics, matching the rest of ro.json.
//
// `capsuleRouter.ts` deliberately does NOT import this file: the router
// is pure and must stay renderable in a worker, a test, or a benchmark
// without pulling i18n in. Any SURFACE that renders router rows must
// import this module (side-effect import) so the keys resolve:
//
//     import "@/lib/capsuleRouterI18n";
//
// Route rows reuse the rail's own `sidebar.*` names — one name per
// destination, already translated. Only the rows the router itself
// invents (groups, the Ask row, statement anchors, commands, entity
// kinds) need keys here.

import i18n from "@/i18n";
import strings from "./capsuleRouterStrings.json";

i18n.addResourceBundle(
  "en", "translation", { capsuleRouter: strings.en.capsuleRouter }, true, false,
);
i18n.addResourceBundle(
  "ro", "translation", { capsuleRouter: strings.ro.capsuleRouter }, true, false,
);

/** Explicit no-op so a caller can express the dependency as a call
 *  rather than relying on import-for-side-effect surviving a bundler's
 *  tree shake. */
export function ensureCapsuleRouterStrings(): void {
  /* the module-level addResourceBundle calls above are the work */
}
