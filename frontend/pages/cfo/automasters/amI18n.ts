// AutoMasters + Admin — i18n bundle, bridge-registered.
//
// Same pattern as pages/cfo/opsI18n.ts: registered at module load with
// overwrite=false, so if these keys are later merged into
// i18n/locales/{en,ro}.json the locale files win. Top-level keys: `am`
// (the AutoMasters screens), `admin` (the Admin page) and the two sidebar
// labels (`sidebar.admin`, `shell.nav.solutions`). Romanian is informal
// (tu-form), with full diacritics.

import i18n from "@/i18n";
import strings from "./amStrings.json";

i18n.addResourceBundle("en", "translation", strings.en, true, false);
i18n.addResourceBundle("ro", "translation", strings.ro, true, false);
