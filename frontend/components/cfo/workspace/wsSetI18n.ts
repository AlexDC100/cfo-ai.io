// Workspace-settings redesign (2026-08-04) — `wsSet` i18n bundle.
//
// The locale files (i18n/locales/{en,ro}.json) are owned by another
// workstream during the redesign sprint, so the new settings strings are
// registered HERE at module load via addResourceBundle with overwrite=false
// (same pattern as components/dashboard/metricsV2I18n.ts). The identical
// content ships as a fragment (scratchpad i18n-fragments/wssettings.json)
// for the coordinator to merge into the locale files; once merged, this
// registration becomes a harmless no-op — existing keys win.
//
// Everything is under the `wsSet` top-level key. Romanian is informal
// (tu-form), with full diacritics.

import i18n from "@/i18n";
import strings from "./wsSetStrings.json";

i18n.addResourceBundle("en", "translation", { wsSet: strings.en.wsSet }, true, false);
i18n.addResourceBundle("ro", "translation", { wsSet: strings.ro.wsSet }, true, false);

/** Industries whose workspaces get the full product decision-rules panel.
 *  Everything else (real estate, SaaS, services…) has no SKU catalog to
 *  classify, so the settings surface shows a "not applicable" card instead. */
export const PRODUCT_INDUSTRIES = [
  "fmcg",
  "retail_ecom",
  "manufacturing",
  "agriculture",
  "logistics",
] as const;

export function isProductIndustry(key: string | null | undefined): boolean {
  return !!key && (PRODUCT_INDUSTRIES as readonly string[]).includes(key);
}
