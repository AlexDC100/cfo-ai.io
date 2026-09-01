// THE ARTIFACTS — i18n bundle, bridge-registered.
//
// Same pattern as `capsuleAnswerI18n.ts`: strings register at module
// load with overwrite=false, so if the locale-file owners later merge
// these keys into i18n/locales/{en,ro}.json this becomes a no-op.
// Everything lives under the `artifact` top-level key. Romanian is
// informal (tu-form) with full diacritics.
//
// The pure modules in this folder (`artifactSpec`, `artifactResolve`,
// `artifactGeometry`, `artifactScenario`, `artifactRefine`) deliberately
// do NOT import this file — they emit KEYS and stay runnable in a
// worker, a test or a gate without i18n. Components import it.

import i18n from "@/i18n";
import strings from "./artifactStrings.json";

i18n.addResourceBundle("en", "translation", { artifact: strings.en.artifact }, true, false);
i18n.addResourceBundle("ro", "translation", { artifact: strings.ro.artifact }, true, false);

/** Explicit no-op so a caller can express the dependency as a call
 *  rather than relying on import-for-side-effect surviving tree shaking. */
export function ensureArtifactStrings(): void {
  /* the module-level addResourceBundle calls above are the work */
}

/** True when THIS build actually has copy for the key. Probing with
 *  `i18n.exists` rather than "call t() and compare to the key": the
 *  missing-key handler logs, so the compare idiom turns every
 *  deliberate fallback into console noise. */
export function hasArtifactCopy(key: string): boolean {
  try {
    return i18n.exists(key);
  } catch {
    return false;
  }
}

/** A label the MODEL authored is rendered verbatim (it passed the text
 *  guard). A label that is an i18n KEY is translated. Deciding which is
 *  which by "does copy exist for it" keeps the spec free to carry either
 *  without a second field to get out of sync. */
export function artifactLabel(
  t: (key: string, opts?: Record<string, unknown>) => string,
  label: string,
): string {
  if (!label) return "";
  return hasArtifactCopy(label) ? t(label) : label;
}
