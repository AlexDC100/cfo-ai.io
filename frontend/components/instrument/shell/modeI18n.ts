// THE DIAL — mode-switcher + role-onboarding strings, bridge-registered.
//
// Same pattern as shellI18n.ts / pages/cfo/opsI18n.ts: strings register at
// module load via addResourceBundle with overwrite=false, so if the locale-
// file owners later merge these keys into i18n/locales/{en,ro}.json this
// becomes a no-op. Everything lives under the `modes` top-level key.
// Romanian is informal (tu-form) with full diacritics, matching ro.json.
//
// Imported for its side effect by ModeSwitch.tsx and pages/cfo/Onboarding.tsx.

import i18n from "@/i18n";
import strings from "./modeStrings.json";

i18n.addResourceBundle("en", "translation", { modes: strings.en.modes }, true, false);
i18n.addResourceBundle("ro", "translation", { modes: strings.ro.modes }, true, false);
