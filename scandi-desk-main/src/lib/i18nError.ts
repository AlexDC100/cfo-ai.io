// I18nError — error class that carries a translation key + params instead
// of a raw string message. Forces every error path through i18n so we
// never leak a hardcoded English/Romanian message to a user whose UI is
// in another language.
//
// Pattern:
//   ❌  throw new Error("File too large")                  — language leak
//   ✓  throw new I18nError("errors.fileTooLarge", { max: "25 MB" })
//
//   In the catch/error-boundary site:
//     try { … } catch (e) { showError(e); }
//   The showError helper (toastWithI18n.ts) calls t(e.i18nKey, e.i18nParams)
//   and shows the result in the user's current language.
//
// Fallback safety: super(i18nKey) means even if the error escapes the
// i18n-aware handler (e.g. lands in console.error or Sentry), there's
// still a non-empty .message — just the key, not gibberish.

export class I18nError extends Error {
  public readonly i18nKey: string;
  public readonly i18nParams?: Record<string, unknown>;

  constructor(i18nKey: string, i18nParams?: Record<string, unknown>) {
    // Use the key as the fallback message — better than blank when this
    // escapes the i18n-aware handler and lands in raw console / telemetry.
    super(i18nKey);
    this.name = "I18nError";
    this.i18nKey = i18nKey;
    this.i18nParams = i18nParams;
    // Preserve prototype chain across transpilation (TS targeting ES5 helper).
    Object.setPrototypeOf(this, I18nError.prototype);
  }
}

/** Type guard. Cheaper than instanceof across realm boundaries. */
export function isI18nError(err: unknown): err is I18nError {
  return (
    err instanceof Error &&
    (err as Error).name === "I18nError" &&
    typeof (err as I18nError).i18nKey === "string"
  );
}
