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
  // Short machine-status labels — MIRROR of the engine presenter table
  // (src/engine/serving/status.py `_DISPLAY`, served on every canonical_bs
  // as `status_presentation`). sv1 locked invariant: the RECONCILED label
  // is NEVER a 'balanced'-family word in any language — the adjustment is
  // disclosed via the auto-adjusted micro-caption, not hidden behind a
  // "Balanced" headline. Consumed by servedFacts.presentStatus (the one
  // status presenter for chip + HTML footer + Excel status cell).
  status: {
    balanced: "Balanced",
    reconciled: "Reconciled",
    minorDrift: "Minor drift",
    materialImbalance: "Material imbalance",
  },
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
  // AI LANE (2026-08-19) — permanent provenance badge for llm-extracted
  // periods. Never removable: the badge renders whenever
  // extraction/classification method is "llm", in every status state.
  aiRead: {
    label: "AI-read",
    tooltip:
      "Numbers were read by AI, not mechanically extracted — review before external use.",
  },
  // DUAL-PATH CONSENSUS — distinct badge for mechanical_mapped periods.
  // NOT "AI-read": the structure was AI-interpreted but every NUMBER was
  // read mechanically from the file and cross-verified by two
  // independent readings (the engine's three-leg consensus verdict).
  mappedRead: {
    label: "Map-guided read",
    tooltip:
      "Structure AI-interpreted · numbers machine-read. Every figure was lifted mechanically from the file's own cells; two independent structural readings were compared cell by cell.",
    dualVerified: "dual-verified",
  },
  // Jurisdiction (country accounting pack) — pre-scan hint dropdown +
  // post-scan resolved badge with override → re-extraction.
  jurisdiction: {
    badge: "Jurisdiction",
    dialogLabel: "Accounting jurisdiction",
    auto: "Auto-detect",
    ro: "Romania",
    hu: "Hungary",
    intl: "International (IFRS-style reading)",
    groupIntl: "International",
    selectAria: "Accounting jurisdiction",
    overrideAria: "Change jurisdiction and re-extract",
    reextractBody: "Re-extraction re-reads the document with AI.",
    reextractConfirm: "Re-extract",
    cancel: "Cancel",
    reextractFailed: "Couldn't start re-extraction — try again.",
  },
  // AI-lane needs-review panel — low-confidence classified lines that sit
  // in the Unclassified rows until a human maps them.
  needsReviewPanel: {
    title: "Lines to review ({{count}})",
    body: "These values sit in Unclassified rows pending human mapping — review each line and map its account to confirm the statement.",
    confidence: "confidence",
    show: "Show lines",
    hide: "Hide lines",
  },
};

const bsCanonicalRo = {
  balanced: "Verificare de echilibru trecută — Active = Capitaluri + Datorii (verificat de motor)",
  minorDrift: "Abatere minoră de echilibru",
  material: "Dezechilibru material — acest bilanț nu se reconciliază",
  // Oglinda tabelului motorului (vezi nota EN) — "Reconciliat" nu este
  // niciodată un cuvânt din familia "echilibrat".
  status: {
    balanced: "Echilibrat",
    reconciled: "Reconciliat",
    minorDrift: "Abatere minoră",
    materialImbalance: "Dezechilibru semnificativ",
  },
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
  aiRead: {
    label: "Citit de AI",
    tooltip:
      "Cifrele au fost citite de AI, nu extrase mecanic — verifică-le înainte de a le folosi în exterior.",
  },
  mappedRead: {
    label: "Citire ghidată de hartă",
    tooltip:
      "Structură interpretată de AI · cifre citite mecanic. Fiecare cifră a fost preluată mecanic din celulele fișierului; două interpretări structurale independente au fost comparate celulă cu celulă.",
    dualVerified: "dublu verificat",
  },
  jurisdiction: {
    badge: "Jurisdicție",
    dialogLabel: "Jurisdicție contabilă",
    auto: "Detectare automată",
    ro: "România",
    hu: "Ungaria",
    intl: "Internațional (citire tip IFRS)",
    groupIntl: "Internațional",
    selectAria: "Jurisdicție contabilă",
    overrideAria: "Schimbă jurisdicția și re-extrage",
    reextractBody: "Re-extragerea recitește documentul cu AI.",
    reextractConfirm: "Re-extrage",
    cancel: "Anulează",
    reextractFailed: "Nu am putut porni re-extragerea — încearcă din nou.",
  },
  needsReviewPanel: {
    title: "Linii de verificat ({{count}})",
    body: "Aceste valori stau în rânduri Neclasificate până la maparea manuală — verifică fiecare linie și mapează-i contul ca să confirmi situația.",
    confidence: "încredere",
    show: "Arată liniile",
    hide: "Ascunde liniile",
  },
};

// Register under the app's single "translation" namespace. deep=true so the
// bundle merges alongside existing top-level keys; overwrite=false so any
// `bsCanonical` keys already merged into the locale files always win.
i18n.addResourceBundle("en", "translation", { bsCanonical: bsCanonicalEn }, true, false);
i18n.addResourceBundle("ro", "translation", { bsCanonical: bsCanonicalRo }, true, false);

export { bsCanonicalEn, bsCanonicalRo };
