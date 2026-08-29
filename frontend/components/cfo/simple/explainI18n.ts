// Explain-anything strings — bridge-registered (same pattern as
// pages/cfo/opsI18n.ts and chat/chatDegradedI18n.ts): registered at
// module load with overwrite=false, so if the locale-file owners later
// merge these keys into i18n/locales/{en,ro}.json this registration
// becomes a harmless no-op — existing keys win.
//
// Everything lives under the `explain` top-level key. Romanian is
// informal (tu-form), with full diacritics.

import i18n from "@/i18n";
import strings from "./explainStrings.json";

i18n.addResourceBundle("en", "translation", { explain: strings.en.explain }, true, false);
i18n.addResourceBundle("ro", "translation", { explain: strings.ro.explain }, true, false);
