// English-only i18n shim. Kept as a thin module for any legacy imports;
// the new CFO surface doesn't render localised strings — every label
// in the app is authored in English.
//
// If we ever need multi-language support again, re-introduce a translation
// dictionary here and switch consumers from string literals to t() calls.

import { useSyncExternalStore } from "react";

export type Lang = "en";

export function getLang(): Lang {
  return "en";
}

export function setLang(_lang: Lang): void {
  // No-op — single-language app.
}

/** No-op subscribe so any legacy hook callers don't break. */
export function useT(): [Lang, (key: string) => string] {
  // Subscribe to a never-firing store so React keeps the hook stable.
  useSyncExternalStore(
    () => () => {},
    () => "en",
    () => "en",
  );
  return ["en", (key: string) => key];
}

/** Translate by key — currently returns the key, since labels are
 *  authored in English directly in the components. */
export function t(key: string): string {
  return key;
}
