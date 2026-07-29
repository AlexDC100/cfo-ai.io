// presets.ts — five well-thought-out rule packages the operator can
// apply with one click. Each preset is a recipe: combination mode +
// per-rule (enabled + thresholds) + financing params.
//
// Thresholds can be:
//   • a number — used as-is (absolute threshold, business rule)
//   • a string like "gmPct.p67" — resolved to a percentile of the
//     CURRENT dataset at apply time, so the same preset behaves
//     sensibly on any portfolio
//
// Rule IDs match the catalog in decisionRules.ts:
//   gross_profit | volume | dio | margin_pct | revenue | adjusted_gm_pct

import type {
  CombinationMode,
  DecisionRulesState,
  FinancingParams,
  RuleState,
  SkuLite,
} from "./decisionRules";
import {
  DEFAULT_FINANCING,
  RULES,
  defaultRulesState,
} from "./decisionRules";
import {
  computeDatasetPercentiles,
  type DatasetPercentiles,
  type PercentileKey,
} from "./percentiles";

export type ThresholdSpec = number | `${keyof DatasetPercentiles}.${PercentileKey}`;

export interface PresetRule {
  enabled: boolean;
  thresholds?: [ThresholdSpec, ThresholdSpec];
  weight?: number;
}

export interface Preset {
  id: string;
  label: string;
  description: string;
  combinationMode: CombinationMode;
  /** Map of rule id → preset config. Rules omitted here are disabled
   *  in the resolved state. */
  rules: Partial<Record<string, PresetRule>>;
  financing: FinancingParams;
}

// ─── Catalog ────────────────────────────────────────────────────────────────

export const PRESETS: readonly Preset[] = [
  {
    id: "logical_default",
    label: "Logical default",
    description:
      "Volume × Margin matrix with hard cuts for negative margin and excess DIO. Recommended starting point.",
    combinationMode: "worst_wins",
    rules: {
      margin_pct: { enabled: true, thresholds: ["gmPct.p33", "gmPct.p67"] },
      volume:     { enabled: true, thresholds: ["volume.p33", "volume.p67"] },
      adjusted_gm_pct: { enabled: true, thresholds: [0, "adjustedGmPct.p67"] },
      dio:        { enabled: true, thresholds: [120, 365] },
    },
    financing: { costOfFinancing: 5.5, bankSpread: 2.0 },
  },
  {
    id: "cash_protection",
    label: "Cash protection",
    description:
      "Aggressive on slow movers and negative-margin SKUs. Use when working capital is tight.",
    combinationMode: "worst_wins",
    rules: {
      margin_pct: { enabled: true, thresholds: [5, "gmPct.p75"] },
      adjusted_gm_pct: { enabled: true, thresholds: [3, 12] },
      dio:        { enabled: true, thresholds: [90, 180] },
      volume:     { enabled: true, thresholds: ["volume.p25", "volume.p67"] },
    },
    financing: { costOfFinancing: 7.0, bankSpread: 2.5 },
  },
  {
    id: "growth_mode",
    label: "Growth mode",
    description:
      "Lenient thresholds. Keeps emerging SKUs in Watch instead of Wind down. Use during expansion.",
    combinationMode: "worst_wins",
    rules: {
      margin_pct: { enabled: true, thresholds: ["gmPct.p25", "gmPct.p67"] },
      adjusted_gm_pct: { enabled: true, thresholds: [-2, "adjustedGmPct.p67"] },
      volume:     { enabled: true, thresholds: ["volume.p25", "volume.p75"] },
      dio:        { enabled: false },
    },
    financing: { costOfFinancing: 5.5, bankSpread: 1.5 },
  },
  {
    id: "pure_profitability",
    label: "Pure profitability",
    description:
      "Volume is ignored. Decisions based only on margin and financing cost.",
    combinationMode: "worst_wins",
    rules: {
      margin_pct: { enabled: true, thresholds: [0, 15] },
      adjusted_gm_pct: { enabled: true, thresholds: [0, 10] },
      volume:     { enabled: false },
      dio:        { enabled: false },
    },
    financing: { costOfFinancing: 5.5, bankSpread: 2.0 },
  },
  {
    id: "working_capital_lens",
    label: "Working capital lens",
    description:
      "Optimized for cash-cycle decisions. Heavy weight on DIO and financing cost.",
    combinationMode: "worst_wins",
    rules: {
      dio:        { enabled: true, thresholds: [60, 150] },
      adjusted_gm_pct: { enabled: true, thresholds: [0, "adjustedGmPct.p67"] },
      margin_pct: { enabled: true, thresholds: ["gmPct.p25", "gmPct.p75"] },
      volume:     { enabled: true, thresholds: ["volume.p33", "volume.p67"] },
    },
    financing: { costOfFinancing: 6.5, bankSpread: 2.5 },
  },
];

export function getPreset(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}

// ─── Resolver ───────────────────────────────────────────────────────────────

function isPercentileSpec(t: ThresholdSpec): t is `${keyof DatasetPercentiles}.${PercentileKey}` {
  return typeof t === "string";
}

export function resolveThreshold(t: ThresholdSpec, pcts: DatasetPercentiles): number {
  if (!isPercentileSpec(t)) return t;
  const [metric, key] = t.split(".") as [keyof DatasetPercentiles, PercentileKey];
  const block = pcts[metric];
  if (!block) return 0;
  return block[key] ?? 0;
}

/**
 * Resolve a preset against the current dataset's percentiles and produce
 * a complete DecisionRulesState ready to write to the store atomically.
 *
 * Every rule in the catalog ends up in the state — rules NOT named by the
 * preset are emitted as disabled with default thresholds, so the preset
 * fully describes the visible surface.
 */
export function resolvePreset(preset: Preset, skus: readonly SkuLite[]): DecisionRulesState {
  const pcts = computeDatasetPercentiles(skus, preset.financing);
  const base = defaultRulesState();
  const rules: Record<string, RuleState> = { ...base.rules };

  for (const rule of RULES) {
    const presetRule = preset.rules[rule.id];
    if (!presetRule) {
      // Rule not in preset → disabled with default thresholds.
      rules[rule.id] = { ...rules[rule.id]!, enabled: false };
      continue;
    }
    const t0 = presetRule.thresholds?.[0];
    const t1 = presetRule.thresholds?.[1];
    rules[rule.id] = {
      enabled: presetRule.enabled,
      thresholds: presetRule.thresholds
        ? [
            resolveThreshold(t0!, pcts),
            resolveThreshold(t1!, pcts),
          ]
        : [...rule.defaultThresholds],
      weight: presetRule.weight ?? rules[rule.id]!.weight,
    };
  }

  return {
    combinationMode: preset.combinationMode,
    rules,
    financing: { ...preset.financing },
  };
}

/** Default financing fallback for callers that haven't loaded a SKU
 *  list yet but need a placeholder. */
export const PRESET_DEFAULT_FINANCING = DEFAULT_FINANCING;

// ─── Drift detection ────────────────────────────────────────────────────────

/** Decide whether the current state matches what `presetId` would
 *  resolve to against the given SKUs. Used by the modal to display
 *  "Logical default · modified" when the operator has dragged a
 *  threshold post-apply.
 *
 *  Tolerance: 0.5 (units of each metric). Percentile resolutions
 *  produce floats that may round-trip slightly when persisted, so an
 *  exact-equality check would false-positive "modified" on round-trip. */
export function isStateDrifted(
  current: DecisionRulesState,
  presetId: string,
  skus: readonly SkuLite[],
): boolean {
  const preset = getPreset(presetId);
  if (!preset) return true;
  const resolved = resolvePreset(preset, skus);
  if (current.combinationMode !== resolved.combinationMode) return true;
  const curFin = current.financing ?? PRESET_DEFAULT_FINANCING;
  const resFin = resolved.financing!;
  if (Math.abs(curFin.costOfFinancing - resFin.costOfFinancing) > 0.05) return true;
  if (Math.abs(curFin.bankSpread     - resFin.bankSpread)     > 0.05) return true;
  for (const rule of RULES) {
    const c = current.rules[rule.id]!;
    const r = resolved.rules[rule.id]!;
    if (c.enabled !== r.enabled) return true;
    if (!c.enabled) continue;
    if (Math.abs(c.thresholds[0] - r.thresholds[0]) > 0.5) return true;
    if (Math.abs(c.thresholds[1] - r.thresholds[1]) > 0.5) return true;
  }
  return false;
}
