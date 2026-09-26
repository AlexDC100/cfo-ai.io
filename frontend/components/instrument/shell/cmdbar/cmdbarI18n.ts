// The command bar's strings (EN + RO, full diacritics), bridge-registered
// the way every Capsule bundle is: addResourceBundle at module load under
// ONE top-level key, `cmdbar`, which no other bundle claims.

import i18n from "@/i18n";
import strings from "./cmdbarStrings.json";

i18n.addResourceBundle("en", "translation", { cmdbar: strings.en.cmdbar }, true, false);
i18n.addResourceBundle("ro", "translation", { cmdbar: strings.ro.cmdbar }, true, false);

/** Explicit no-op so a caller can state the dependency as a call. */
export function ensureCmdbarStrings(): void {
  /* the module-level addResourceBundle calls above are the work */
}
