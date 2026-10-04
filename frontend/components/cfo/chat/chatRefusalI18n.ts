// Ask CFO AI refusal strings — bridge-registered (same pattern as
// chatDegradedI18n.ts): registered at module load with overwrite=false, so
// if the locale-file owners later merge these keys into
// i18n/locales/{en,ro}.json this registration becomes a harmless no-op.
//
// Everything lives under the `chatRefusal` top-level key. Romanian is
// informal (tu-form), with full diacritics. The sentences are rendered from
// the function's CODES (lib/chatRefusal.ts) — never from its own English.

import i18n from "@/i18n";
import strings from "./chatRefusalStrings.json";

i18n.addResourceBundle("en", "translation", { chatRefusal: strings.en.chatRefusal }, true, false);
i18n.addResourceBundle("ro", "translation", { chatRefusal: strings.ro.chatRefusal }, true, false);
