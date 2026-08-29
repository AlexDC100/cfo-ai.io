// Settings page (THE INSTRUMENT pass) — i18n bundle, bridge-registered.
//
// Same pattern as opsI18n.ts: strings registered at module load via
// addResourceBundle with overwrite=false, so when the locale-file owners
// later merge these keys into i18n/locales/{en,ro}.json this registration
// becomes a harmless no-op — existing keys win.
//
// Everything lives under the `settingsX` top-level key (the plain
// `settings` namespace already exists in the locale files and must not
// be shadowed). Romanian is informal (tu-form), with full diacritics.

import i18n from "@/i18n";
import strings from "./settingsXStrings.json";

i18n.addResourceBundle("en", "translation", { settingsX: strings.en.settingsX }, true, false);
i18n.addResourceBundle("ro", "translation", { settingsX: strings.ro.settingsX }, true, false);
