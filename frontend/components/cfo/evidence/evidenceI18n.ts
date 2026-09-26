// The account view's strings (EN + RO, full diacritics), registered the way
// the command bar's are: addResourceBundle at module load under ONE
// top-level key, `evidence`, which no other bundle claims.
// evidenceLanding.test.tsx holds the two languages to the same key set.

import i18n from "@/i18n";
import strings from "./evidenceStrings.json";

i18n.addResourceBundle("en", "translation", { evidence: strings.en.evidence }, true, false);
i18n.addResourceBundle("ro", "translation", { evidence: strings.ro.evidence }, true, false);

export function ensureEvidenceStrings(): void {
  /* the module-level addResourceBundle calls above are the work */
}
