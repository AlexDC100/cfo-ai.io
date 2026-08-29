// Shell chrome (header + rail + palette) — i18n bundle, bridge-registered.
//
// Same pattern as pages/cfo/opsI18n.ts: strings register at module load via
// addResourceBundle with overwrite=false, so if the locale-file owners later
// merge these keys into i18n/locales/{en,ro}.json this becomes a no-op.
// Everything lives under the `shell` top-level key. Romanian is informal
// (tu-form) with full diacritics, matching the rest of ro.json.

import i18n from "@/i18n";
import strings from "./shellStrings.json";

i18n.addResourceBundle("en", "translation", { shell: strings.en.shell }, true, false);
i18n.addResourceBundle("ro", "translation", { shell: strings.ro.shell }, true, false);

/** Platform-aware modifier label for shortcut hints ("⌘" on Mac, "Ctrl+"
 *  elsewhere). Pure display — the handlers accept both meta and ctrl. */
export function modKeyLabel(): string {
  if (typeof navigator === "undefined") return "⌘";
  const mac = /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
  return mac ? "⌘" : "Ctrl+";
}
