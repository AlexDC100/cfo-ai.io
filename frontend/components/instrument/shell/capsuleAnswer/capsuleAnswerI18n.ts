// Capsule answer surface — i18n bundle, bridge-registered.
//
// Same pattern as `shellI18n.ts` and `capsuleRouterI18n.ts`: strings
// register at module load via addResourceBundle with overwrite=false, so
// if the locale-file owners later merge these keys into
// i18n/locales/{en,ro}.json this becomes a no-op. Everything lives under
// the `capsuleAnswer` top-level key. Romanian is informal (tu-form) with
// full diacritics.
//
// The pure modules in this folder (`capsuleRetrieval`,
// `capsuleAnswerGuard`, `capsuleAnswerVisuals`, `capsuleAnswerClient`)
// deliberately do NOT import this file — they emit KEYS, and stay
// runnable in a worker, a test or the latency harness without i18n. Any
// component that renders those keys imports this module.

import i18n from "@/i18n";
import strings from "./capsuleAnswerStrings.json";
import tier0Strings from "./capsuleTier0Strings.json";

i18n.addResourceBundle(
  "en", "translation", { capsuleAnswer: strings.en.capsuleAnswer }, true, false,
);
i18n.addResourceBundle(
  "ro", "translation", { capsuleAnswer: strings.ro.capsuleAnswer }, true, false,
);

// `lib/capsuleTier0.ts` emits `capsuleTier0.note.*` KEYS and says in its
// own header that the SURFACE lane registers them. This is that lane, so
// this is that registration. The namespace is deliberately the resolver's
// and not `capsuleAnswer.*`: the resolver owns which notes exist, and a
// note it adds tomorrow must land in a bundle whose name it already
// knows, without an edit here to rename it.
i18n.addResourceBundle(
  "en", "translation", { capsuleTier0: tier0Strings.en.capsuleTier0 }, true, false,
);
i18n.addResourceBundle(
  "ro", "translation", { capsuleTier0: tier0Strings.ro.capsuleTier0 }, true, false,
);

/** Explicit no-op so a caller can express the dependency as a call
 *  rather than relying on import-for-side-effect surviving tree shaking. */
export function ensureCapsuleAnswerStrings(): void {
  /* the module-level addResourceBundle calls above are the work */
}

/** True when THIS build actually has copy for the key.
 *
 *  Probing with `i18n.exists` rather than "call t() and compare to the
 *  key" matters: the missing-key handler logs, so the compare-to-key
 *  idiom turns every deliberate fallback into console noise — and the
 *  fallbacks here are deliberate, because the engine's metric vocabulary
 *  is allowed to grow ahead of this bundle. */
export function hasCopy(key: string): boolean {
  try {
    return i18n.exists(key);
  } catch {
    return false;
  }
}

/** Human label for a metric name, falling back to the engine's own
 *  string when this build has no translation for it. Never invents a
 *  label from a fact name the engine did not describe. */
export function metricLabel(
  t: (key: string, opts?: Record<string, unknown>) => string,
  metric: string,
  fallback = "",
): string {
  if (!metric) return fallback;
  const key = `capsuleAnswer.metric.${metric}`;
  return hasCopy(key) ? t(key) : fallback || metric;
}

/** Copy for a gap code / limitation rule, with an explicit unknown
 *  bucket — a new engine code must read as "that read came back empty",
 *  never as a raw identifier on screen. */
export function codeCopy(
  t: (key: string, opts?: Record<string, unknown>) => string,
  group: "gap" | "limitation",
  code: string,
): string {
  const key = `capsuleAnswer.${group}.${code}`;
  if (hasCopy(key)) return t(key);
  return t(`capsuleAnswer.${group}.unknown`);
}
