// Period-filing i18n bundle (`pf`) — the correction path's strings.
//
// Registered here at module load via addResourceBundle (overwrite=false),
// the same pattern as wsSetI18n / metricsV2I18n: the locale files
// (i18n/locales/{en,ro}.json) are owned by another workstream, so a new
// feature ships its own strings and merges later. Existing keys always
// win, so the registration becomes a harmless no-op once merged.
//
// Romanian is informal (tu-form) with full diacritics, matching ro.json.

import i18n from "@/i18n";
import strings from "./periodFilingStrings.json";

i18n.addResourceBundle("en", "translation", { pf: strings.en.pf }, true, false);
i18n.addResourceBundle("ro", "translation", { pf: strings.ro.pf }, true, false);
