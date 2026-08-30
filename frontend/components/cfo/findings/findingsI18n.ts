// Findings i18n bundle (`fnd`) — the chrome around the contract.
//
// Registered here at module load via addResourceBundle (overwrite=false),
// the same pattern as narrativeMoneyI18n / storyI18n: the locale files
// (i18n/locales/{en,ro}.json) are owned by another workstream, so a new
// feature ships its own strings and merges later. Existing keys always
// win, so the registration becomes a harmless no-op once merged.
//
// Romanian is informal (tu-form) with full diacritics, matching ro.json.
//
// WHAT IS DELIBERATELY NOT TRANSLATED: the engine's own rendered claim
// (`title` / `body` and their templates). That prose is COMPOSED FROM the
// seven typed elements by `_finding.render()`; re-writing it on the
// client would be a narrative mutation with no fingerprint check behind
// it — exactly what `apply_advisory_narrative` exists to forbid. The
// labels around the claim are translated; the claim is quoted.

import i18n from "@/i18n";
import strings from "./findingsStrings.json";

i18n.addResourceBundle("en", "translation", { fnd: strings.en.fnd }, true, false);
i18n.addResourceBundle("ro", "translation", { fnd: strings.ro.fnd }, true, false);
