// Currency convention for the CFO AI display layer.
//
// The seed dataset is stored in kRON (legacy unit). The product UI shows
// numbers in EUR. We convert at the derivation boundary; nothing in the UI
// renders RON anymore, so MoneyValue defaults to EUR and every helper here
// returns euro amounts.
//
// When live customer data lands, replace `convertKronToEur` with the
// per-tenant FX rate (or a no-op if the upload is already in EUR).

export const CURRENCY = "EUR";

/** Reference RON→EUR rate. Match config.yaml's `fx_eur_ron` so backend and
 *  frontend report the same numbers. */
export const FX_RON_TO_EUR = 4.97;

/** Convert a kRON amount to kEUR. */
export function convertKronToEur(kron: number): number {
  return kron / FX_RON_TO_EUR;
}

/** Convert an MRON amount to MEUR. */
export function convertMronToMeur(mron: number): number {
  return mron / FX_RON_TO_EUR;
}
