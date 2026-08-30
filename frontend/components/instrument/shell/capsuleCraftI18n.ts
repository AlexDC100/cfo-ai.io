// THE CAPSULE — craft-pass strings, bridge-registered.
//
// Same pattern as ./shellI18n.ts and ./capsuleEmpty/capsuleEmptyI18n.ts:
// register at module load with overwrite=false, under a namespace no
// other lane claims (`capsuleCraft`). The locale files under
// `i18n/locales/` are owned elsewhere and are not touched.
//
// Only strings the COMPOSITIONAL FLIP introduced live here. Anything the
// surface already said keeps saying it from its existing bundle — a new
// bundle that re-declares an old key is two sources for one sentence,
// and the one that loads second wins silently.
//
// Romanian is informal (tu-form) with full diacritics.

import i18n from "@/i18n";
import strings from "./capsuleCraftStrings.json";

i18n.addResourceBundle(
  "en", "translation", { capsuleCraft: strings.en.capsuleCraft }, true, false,
);
i18n.addResourceBundle(
  "ro", "translation", { capsuleCraft: strings.ro.capsuleCraft }, true, false,
);

/** Explicit no-op so a caller can express the dependency as a call rather
 *  than relying on import-for-side-effect surviving a tree shake. */
export function ensureCapsuleCraftStrings(): void {
  /* the module-level addResourceBundle calls above are the work */
}
