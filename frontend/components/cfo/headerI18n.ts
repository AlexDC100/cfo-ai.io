// Header chrome (TopHeader + AccountMenu) — i18n bundle, bridge-registered.
//
// Same pattern as instrument/shell/shellI18n.ts: strings register at module
// load via addResourceBundle with overwrite=false, so if the locale-file
// owners later merge these keys into i18n/locales/{en,ro}.json this becomes
// a no-op. Everything lives under the `header` top-level key. Romanian is
// informal (tu-form) with full diacritics, matching ro.json.
//
// Imported for its side effect by TopHeader.tsx and AccountMenu.tsx.

import i18n from "@/i18n";
import strings from "./headerStrings.json";

i18n.addResourceBundle("en", "translation", { header: strings.en.header }, true, false);
i18n.addResourceBundle("ro", "translation", { header: strings.ro.header }, true, false);
