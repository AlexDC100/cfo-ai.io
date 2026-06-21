// F6.0.5 (2026-06-20) — User-facing adjustment levers.
//
// A "lever" is the friendly control the user actually touches in the
// editor — "Revenue / rent −20%", "Customer payment days → 90". Each lever
// declares the underlying cascade Adjustment target + how its slider value
// maps to an AdjustmentOperation. This keeps the cascade's typed vocabulary
// (concept/driver targets, pct_change/set_driver operations) out of the UI
// while still producing exactly the Adjustment[] the engine consumes.
//
// The levers chosen are the ones a Romanian SME / real-estate CFO reaches
// for first. "Revenue / rent" is deliberately labelled for both — for an
// operating company it's turnover, for EEI-style single-asset real estate
// it's the rent roll, and the math is identical (top-line ±%).

import type { Adjustment, AdjustmentTarget, AdjustmentOperation } from "./types";

export type LeverKind = "pct" | "days" | "rate_pct";

export interface ScenarioLever {
  key: string;
  label: string;
  /** One-line plain-English hint shown under the lever. */
  hint: string;
  target: AdjustmentTarget;
  kind: LeverKind;
  /** Slider bounds + step in the lever's native unit:
   *  · pct      → percent change, e.g. −50..+50 (step 1), stored as ÷100
   *  · days     → absolute day count, e.g. 0..180 (step 5)
   *  · rate_pct → absolute percent, e.g. 0..60 (step 1), stored as ÷100  */
  min: number;
  max: number;
  step: number;
  /** Neutral value = "no change" (0 for pct; for days/rate the baseline
   *  is unknown ahead of time so we treat the slider as an explicit set,
   *  and the editor seeds it from the current baseline-derived value). */
  neutral: number;
  /** Unit suffix for display ("%", "d", "%"). */
  unit: string;
}

export const SCENARIO_LEVERS: ScenarioLever[] = [
  {
    key: "revenue",
    label: "Revenue / rent",
    hint: "Top-line change. For a property company this is the rent roll; a −20% models a fifth of the rent lost.",
    target: { type: "concept", conceptKey: "revenue" },
    kind: "pct",
    min: -100,
    max: 50,
    step: 1,
    neutral: 0,
    unit: "%",
  },
  {
    key: "opex",
    label: "Operating costs",
    hint: "Overheads, admin, services below gross margin (excludes cost of sales).",
    target: { type: "concept", conceptKey: "opex" },
    kind: "pct",
    min: -50,
    max: 50,
    step: 1,
    neutral: 0,
    unit: "%",
  },
  {
    key: "cogs",
    label: "Cost of sales",
    hint: "Direct cost of goods / materials. Move it to model input-price shocks.",
    target: { type: "concept", conceptKey: "cogs" },
    kind: "pct",
    min: -50,
    max: 50,
    step: 1,
    neutral: 0,
    unit: "%",
  },
  {
    key: "capex",
    label: "CapEx",
    hint: "Capital expenditure for the year. Up to fund expansion, down to conserve cash.",
    target: { type: "concept", conceptKey: "capex" },
    kind: "pct",
    min: -100,
    max: 200,
    step: 5,
    neutral: 0,
    unit: "%",
  },
  {
    key: "dso",
    label: "Customer payment days (DSO)",
    hint: "How long customers take to pay. Higher days ties up more cash in receivables.",
    target: { type: "driver", driverKey: "dso_days" },
    kind: "days",
    min: 0,
    max: 180,
    step: 5,
    neutral: 45,
    unit: "d",
  },
  {
    key: "dio",
    label: "Inventory days (DIO)",
    hint: "How long stock sits before sale. Lower frees up working capital.",
    target: { type: "driver", driverKey: "dio_days" },
    kind: "days",
    min: 0,
    max: 240,
    step: 5,
    neutral: 60,
    unit: "d",
  },
  {
    key: "tax",
    label: "Effective tax rate",
    hint: "Tax as a share of operating profit. Romania's standard profit tax is 16%.",
    target: { type: "driver", driverKey: "effective_tax_rate" },
    kind: "rate_pct",
    min: 0,
    max: 40,
    step: 1,
    neutral: 16,
    unit: "%",
  },
];

/** Convert a lever + its slider value into the cascade Adjustment. Pure. */
export function leverToAdjustment(
  lever: ScenarioLever,
  sliderValue: number,
  id: string,
  createdAt: string,
): Adjustment {
  let operation: AdjustmentOperation;
  if (lever.kind === "pct") {
    operation = { type: "pct_change", value: sliderValue / 100 };
  } else if (lever.kind === "days") {
    operation = { type: "set_driver", driverValue: sliderValue };
  } else {
    // rate_pct → driver value as a decimal fraction (16 → 0.16)
    operation = { type: "set_driver", driverValue: sliderValue / 100 };
  }
  return {
    id,
    target: lever.target,
    operation,
    note: `${lever.label}: ${sliderValue}${lever.unit}`,
    createdAt,
  };
}

/** Is a slider value a no-op (so we can skip emitting an adjustment)? For
 *  pct levers, 0 = neutral. For days / rate levers every value is an
 *  explicit set, so only skip when the user hasn't engaged the lever
 *  (signalled by the store storing `null`). */
export function isNeutralPct(lever: ScenarioLever, sliderValue: number): boolean {
  return lever.kind === "pct" && sliderValue === 0;
}
