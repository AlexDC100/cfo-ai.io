// Metrics redesign (2026-08-04) — `metricsV2` i18n bundle.
//
// The locale files (i18n/locales/{en,ro}.json) are owned by another
// workstream during the redesign sprint, so the new dashboard strings are
// registered HERE at module load via addResourceBundle with
// overwrite=false. Once the fragment (scratchpad i18n-fragments/
// metricsv2.json — same content, same shape) is merged into the locale
// files, this registration becomes a harmless no-op: existing keys win.
//
// Everything is under the `metricsV2` top-level key. The `concepts.*`
// entries are the PLAIN-LANGUAGE one-liner tooltips (spec item 1) — one
// per addable dashboard concept (SUPPORTED_CONCEPT_KEYS ∩ registry) plus
// the two count cards. Romanian is informal (tu-form), with diacritics.

import i18n from "@/i18n";
import { metricsV2En, metricsV2Ro } from "./metricsV2Strings";

export { metricsV2En, metricsV2Ro };

// Register under the app's single "translation" namespace. deep=true so the
// bundle merges alongside existing top-level keys; overwrite=false so any
// `metricsV2` keys already merged into the locale files always win.
i18n.addResourceBundle("en", "translation", { metricsV2: metricsV2En }, true, false);
i18n.addResourceBundle("ro", "translation", { metricsV2: metricsV2Ro }, true, false);

/** Map a ConceptCategory display string to its `metricsV2.category.*` key. */
export function conceptCategoryKey(category: string): string {
  const slug = category
    .toLowerCase()
    .replace(/&/g, " ")
    .replace(/[^a-z]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `metricsV2.category.${slug}`;
}
