// THE DIAL (Part E) — Simple-mode strings for the Scenarios surface,
// bridge-registered (same pattern as chat/chatDegradedI18n.ts and
// pages/cfo/opsI18n.ts): registered at module load with overwrite=false,
// so if the locale-file owners later merge these keys into
// i18n/locales/{en,ro}.json this registration becomes a harmless no-op.
//
// Everything lives under the `scenModes` top-level key:
//   · scenModes.templates.<key> — the Simple-mode QUESTION each template
//     card leads with ("What if sales drop 20%?"), phrased from the
//     template's own params in lib/scenarios/templates.ts (recession =
//     revenue −20%, growth = +25%, cost cut = OpEx −15%, covenant stress
//     = revenue falls until covenants break). An unknown template key has
//     no entry — the card falls back to its Pro rendering.
//   · scenModes.showAll / showFewer — the Simple results-table disclosure.
//
// Romanian is informal (tu-form), with full diacritics.

import i18n from "@/i18n";
import strings from "./modeStrings.json";

i18n.addResourceBundle("en", "translation", { scenModes: strings.en.scenModes }, true, false);
i18n.addResourceBundle("ro", "translation", { scenModes: strings.ro.scenModes }, true, false);
