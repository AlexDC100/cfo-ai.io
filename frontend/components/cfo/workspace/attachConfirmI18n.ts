// Attach/replace confirm step (2026-08-30, period-assignment fix) —
// `attachConfirm` i18n bundle, bridge-registered.
//
// Same pattern as ./wsSetI18n.ts and pages/cfo/opsI18n.ts: registered at
// module load via addResourceBundle with overwrite=false, so when the
// locale-file owners merge these keys into i18n/locales/{en,ro}.json this
// registration becomes a harmless no-op — existing keys win. The locale
// files themselves are owned by another lane and are not touched here.
//
// Everything lives under the `attachConfirm` top-level key. Romanian is
// informal (tu-form), with full diacritics.

import i18n from "@/i18n";
import strings from "./attachConfirmStrings.json";

i18n.addResourceBundle(
  "en",
  "translation",
  { attachConfirm: strings.en.attachConfirm },
  true,
  false,
);
i18n.addResourceBundle(
  "ro",
  "translation",
  { attachConfirm: strings.ro.attachConfirm },
  true,
  false,
);
