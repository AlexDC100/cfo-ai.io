// THE DIAL (Part E) — Simple-mode chat chip strings, bridge-registered
// (same pattern as chatDegradedI18n.ts / pages/cfo/opsI18n.ts): registered
// at module load with overwrite=false, so if the locale-file owners later
// merge these keys into i18n/locales/{en,ro}.json this registration
// becomes a harmless no-op — existing keys win.
//
// Everything lives under the `roleChips` top-level key. Romanian is
// informal (tu-form), with full diacritics.

import i18n from "@/i18n";
import strings from "./roleChipsStrings.json";

i18n.addResourceBundle("en", "translation", { roleChips: strings.en.roleChips }, true, false);
i18n.addResourceBundle("ro", "translation", { roleChips: strings.ro.roleChips }, true, false);
