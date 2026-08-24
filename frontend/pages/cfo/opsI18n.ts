// Ops page (engine health) — i18n bundle, bridge-registered.
//
// Same pattern as components/cfo/workspace/wsSetI18n.ts and
// components/dashboard/metricsV2I18n.ts: the strings are registered at
// module load via addResourceBundle with overwrite=false, so when the
// locale-file owners later merge these keys into i18n/locales/{en,ro}.json
// this registration becomes a harmless no-op — existing keys win.
//
// Everything lives under the `ops` top-level key. Romanian is informal
// (tu-form), with full diacritics.

import i18n from "@/i18n";
import strings from "./opsStrings.json";

i18n.addResourceBundle("en", "translation", { ops: strings.en.ops }, true, false);
i18n.addResourceBundle("ro", "translation", { ops: strings.ro.ops }, true, false);
