// canonical_bs v2 status-strip strings (2026-08-13).
//
// The locale files (i18n/locales/{en,ro}.json) are owned by the i18n
// workstream, so these keys are registered HERE at module load via
// addResourceBundle with overwrite=false — same pattern as
// components/dashboard/metricsV2I18n.ts. If the keys are later merged into
// the locale JSONs, the merged values win and this becomes a harmless no-op.
//
// Everything lives under the `bsCanonical` top-level key. RO register is
// informal (tu-form) with diacritics, matching the existing ro.json voice.

import i18n from "@/i18n";

const bsCanonicalEn = {
  balanced: "Balance check passed — Assets = Equity + Liabilities (engine-verified)",
  minorDrift: "Minor balance drift",
  material: "Material imbalance — this balance sheet does not reconcile",
  materialBody:
    "Assets do not equal Equity + Liabilities. The engine flagged the causes below; do not rely on the figures in this tab until this is resolved.",
  difference: "Difference",
  diagnosis: "Engine diagnosis",
  // AUTO-RECONCILE (2026-08-19) — the engine closes sub-threshold drifts
  // server-side before serving; the UI only shows the calm verdict, a
  // tap-receipt, and Undo. No manual Reconcile action exists anymore.
  reconcile: {
    autoAdjusted: "· auto-adjusted {{amount}}",
    receipt: "{{amount}} moved to {{placement}} · verified against source · {{origin}}",
    placementBs: "Diferențe de reconciliere (balance sheet)",
    placementPnl: "Diferențe de reconciliere (P&L)",
    originDeterministic: "deterministic",
    originLlm: "AI-proposed, engine-verified",
    undo: "Undo",
    needsReview: "Needs manual mapping",
    needsReviewBody:
      "The engine could not close this difference automatically without altering source figures — map the flagged accounts to resolve it.",
    undoFailed: "Couldn't undo the adjustment — try again.",
    syntheticRowAria: "Reconciliation adjustment row",
    receiptToggleAria: "Show reconciliation details",
  },
};

const bsCanonicalRo = {
  balanced: "Verificare de echilibru trecută — Active = Capitaluri + Datorii (verificat de motor)",
  minorDrift: "Abatere minoră de echilibru",
  material: "Dezechilibru material — acest bilanț nu se reconciliază",
  materialBody:
    "Activele nu sunt egale cu Capitalurile + Datoriile. Motorul a marcat cauzele mai jos; nu te baza pe cifrele din acest tab până la rezolvare.",
  difference: "Diferență",
  diagnosis: "Diagnostic motor",
  reconcile: {
    autoAdjusted: "· ajustat automat {{amount}}",
    receipt: "{{amount}} mutat în {{placement}} · verificat cu sursa · {{origin}}",
    placementBs: "Diferențe de reconciliere (bilanț)",
    placementPnl: "Diferențe de reconciliere (P&L)",
    originDeterministic: "determinist",
    originLlm: "propus de AI, verificat de motor",
    undo: "Anulează",
    needsReview: "Necesită mapare manuală",
    needsReviewBody:
      "Motorul nu a putut închide această diferență automat fără să modifice cifrele din sursă — mapează conturile marcate ca să o rezolvi.",
    undoFailed: "Nu am putut anula ajustarea — încearcă din nou.",
    syntheticRowAria: "Rând de ajustare din reconciliere",
    receiptToggleAria: "Arată detaliile reconcilierii",
  },
};

// Register under the app's single "translation" namespace. deep=true so the
// bundle merges alongside existing top-level keys; overwrite=false so any
// `bsCanonical` keys already merged into the locale files always win.
i18n.addResourceBundle("en", "translation", { bsCanonical: bsCanonicalEn }, true, false);
i18n.addResourceBundle("ro", "translation", { bsCanonical: bsCanonicalRo }, true, false);

export { bsCanonicalEn, bsCanonicalRo };
