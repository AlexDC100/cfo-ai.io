// The i18n keys the ratio SURFACES resolve (tab, comparison table,
// band-movement lists, drawer, credit comparison), beside the formatter's
// own keys in ratioTable.ts.
//
// A LEAF MODULE: no imports. ratioTable.ts folds this list into
// `ratioCmpKeyCensus()`, so the census gate (ratioTableFormat.test.ts G4)
// still reds on any statements.ratioCmp key no reader resolves and on any
// resolved key with no EN or RO string. It lives apart from ratioTable.ts
// so the surfaces own their words without the formatter importing a
// component.
//
// LABELS. The engine serves `label_key: "ratioTable.<key>.label"` on every
// row (src/engine/ratios/table.py build_ratio_table, and
// src/engine/comparatives/ratio_compare.py for the composites and
// sub-scores). The words live under `statements.ratioCmp.label.<key>`;
// `ratioLabelI18nKey` maps a served label_key onto that key and refuses
// (null) a label_key outside the declared list, so a new engine row with
// no word is named on screen rather than printed as a raw key.
// ratioCompareTab.test.tsx reads the engine's census and composite lists
// and reds on a served key with no label here.

/** Every row key the engine serves a label_key for: the census
 *  (table.py CENSUS, in serve order), the three composites and the seven
 *  credit sub-scores (ratio_compare.py). */
export const RATIO_LABELLED_KEYS = [
  "current_ratio",
  "quick_ratio",
  "cash_ratio",
  "gross_margin",
  "ebitda_margin",
  "net_margin",
  "roa",
  "roe",
  "roic",
  "debt_to_ebitda",
  "debt_to_equity",
  "equity_ratio",
  "debt_to_assets",
  "interest_coverage",
  "dscr",
  "adjusted_dscr",
  "dscr_with_lt_principal",
  "dso",
  "dio",
  "dpo",
  "ccc",
  "asset_turnover",
  "net_debt_to_ebitda",
  "lt_debt_to_equity",
  "ebitda_to_interest",
  "operating_margin",
  "core_ebitda_margin",
  "inventory_turnover",
  "altman_z",
  "credit_composite",
  "letter_grade",
  "credit_subscore_altman",
  "credit_subscore_profitability",
  "credit_subscore_leverage",
  "credit_subscore_coverage",
  "credit_subscore_dscr",
  "credit_subscore_liquidity",
  "credit_subscore_equity",
] as const;

const LABELLED: ReadonlySet<string> = new Set(RATIO_LABELLED_KEYS);

/** The served row groups (RatioGroup in ratioTable.ts). */
export const RATIO_GROUP_KEYS = [
  "liquidity",
  "profitability",
  "leverage",
  "coverage",
  "efficiency",
  "distress",
  "credit",
] as const;

/** Surface sentences and headers, under statements.ratioCmp.ui. */
export const RATIO_CMP_UI_KEYS = [
  "tableTitle",
  "tableCaption",
  "colRatio",
  "colChange",
  "colBandNow",
  "colBandPrior",
  "colMovement",
  "subscoresTitle",
  "compositesTitle",
  "improvedTitle",
  "deterioratedTitle",
  "improvedEmpty",
  "deterioratedEmpty",
  "movementsTitle",
  "movementsCounts",
  "nothingCrossed",
  "movementsTitlePlain",
  "verdictsWithheldLater",
  "verdictsWithheldUnknown",
  "rankBasisLead",
  "noComparison",
  "comparisonRefused",
  "comparisonWithoutRatios",
  "comparisonLoading",
  "comparisonFailed",
  "comparisonFailedNoResponse",
  "currentDiffers",
  "priorEyebrow",
  "comparisonEyebrow",
  "ladderRungHigher",
  "ladderRungLower",
  "ladderFloorHigher",
  "ladderFloorLower",
  "ladderUnread",
  "vsPriorTitle",
  "creditAgainst",
  "asFiled",
  "asFiledRevisionUnknown",
  "asFiledValueAbsent",
  "asFiledValueWithdrawn",
  "asFiledWithdrawnNote",
  "unlabelled",
] as const;

export function ratioLabelI18nKey(labelKey: unknown): string | null {
  if (typeof labelKey !== "string") return null;
  const m = /^ratioTable\.([a-z_]+)\.label$/.exec(labelKey);
  if (!m || !LABELLED.has(m[1])) return null;
  return `statements.ratioCmp.label.${m[1]}`;
}

export function ratioGroupI18nKey(group: unknown): string | null {
  return typeof group === "string" && (RATIO_GROUP_KEYS as readonly string[]).includes(group)
    ? `statements.ratioCmp.group.${group}`
    : null;
}

/** Every statements.ratioCmp key the surfaces can resolve. */
export const RATIO_CMP_SURFACE_KEYS: readonly string[] = [
  ...RATIO_LABELLED_KEYS.map((k) => `statements.ratioCmp.label.${k}`),
  ...RATIO_GROUP_KEYS.map((k) => `statements.ratioCmp.group.${k}`),
  ...RATIO_CMP_UI_KEYS.map((k) => `statements.ratioCmp.ui.${k}`),
];
