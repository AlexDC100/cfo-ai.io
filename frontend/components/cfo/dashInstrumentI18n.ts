// Dashboard (THE INSTRUMENT migration) — i18n bundle, bridge-registered.
//
// Same pattern as pages/cfo/opsI18n.ts: strings register at module load
// via addResourceBundle with overwrite=false, so when the locale-file
// owners later merge these keys into i18n/locales/{en,ro}.json this
// registration becomes a harmless no-op — existing keys win.
//
// Everything lives under the `dashIx` top-level key. Romanian is informal
// (tu-form), with full diacritics.

import i18n from "@/i18n";
import strings from "./dashInstrumentStrings.json";

i18n.addResourceBundle("en", "translation", { dashIx: strings.en.dashIx }, true, false);
i18n.addResourceBundle("ro", "translation", { dashIx: strings.ro.dashIx }, true, false);
