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
};

const bsCanonicalRo = {
  balanced: "Verificare de echilibru trecută — Active = Capitaluri + Datorii (verificat de motor)",
  minorDrift: "Abatere minoră de echilibru",
  material: "Dezechilibru material — acest bilanț nu se reconciliază",
  materialBody:
    "Activele nu sunt egale cu Capitalurile + Datoriile. Motorul a marcat cauzele mai jos; nu te baza pe cifrele din acest tab până la rezolvare.",
  difference: "Diferență",
  diagnosis: "Diagnostic motor",
};

// Register under the app's single "translation" namespace. deep=true so the
// bundle merges alongside existing top-level keys; overwrite=false so any
// `bsCanonical` keys already merged into the locale files always win.
i18n.addResourceBundle("en", "translation", { bsCanonical: bsCanonicalEn }, true, false);
i18n.addResourceBundle("ro", "translation", { bsCanonical: bsCanonicalRo }, true, false);

export { bsCanonicalEn, bsCanonicalRo };
