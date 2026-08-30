// Narrative-money i18n bundle (`nm`) — provenance + non-convertible copy.
//
// Registered here at module load via addResourceBundle (overwrite=false),
// the same pattern as periodFilingI18n / wsSetI18n: the locale files
// (i18n/locales/{en,ro}.json) are owned by another workstream, so a new
// feature ships its own strings and merges later. Existing keys always
// win, so the registration becomes a harmless no-op once merged.
//
// Romanian is informal (tu-form) with full diacritics, matching ro.json.

import i18n from "@/i18n";
import strings from "./narrativeMoneyStrings.json";

i18n.addResourceBundle("en", "translation", { nm: strings.en.nm }, true, false);
i18n.addResourceBundle("ro", "translation", { nm: strings.ro.nm }, true, false);
