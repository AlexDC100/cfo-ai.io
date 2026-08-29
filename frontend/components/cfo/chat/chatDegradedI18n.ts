// Degraded-AI-state strings — bridge-registered (same pattern as
// pages/cfo/opsI18n.ts): registered at module load with overwrite=false,
// so if the locale-file owners later merge these keys into
// i18n/locales/{en,ro}.json this registration becomes a harmless no-op.
//
// Everything lives under the `chatDegraded` top-level key. Romanian is
// informal (tu-form), with full diacritics.

import i18n from "@/i18n";
import strings from "./chatDegradedStrings.json";

i18n.addResourceBundle("en", "translation", { chatDegraded: strings.en.chatDegraded }, true, false);
i18n.addResourceBundle("ro", "translation", { chatDegraded: strings.ro.chatDegraded }, true, false);
