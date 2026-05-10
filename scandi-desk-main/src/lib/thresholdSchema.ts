// Threshold metadata: one entry per slider in the Tuning tab. Drives bounds
// enforcement, calibrated markers, captions, and group rendering. Frontend
// values are clamped through `clampThresholds` before the engine sees them,
// so the 233-day zero-sales bug is impossible by construction.

import type { Thresholds } from "@/lib/thresholds";
import { DEFAULTS } from "@/lib/thresholds";

export type ThresholdKey = keyof Pick<Thresholds,
  | "costOfCapitalPct" | "fxEurRon"
  | "anchorTopPct" | "anchorMinRevenuePct" | "anchorVolumeThresholdT"
  | "highVolumeFloorPct" | "anchorAbsoluteFloorPct"
  | "microVolumeT" | "microProfitKron" | "dioCapitalTrap"
  | "capitalTrapRealMarginPct" | "zeroSalesWindowDays" | "cccCategoryRedDays"
  | "warningThinMarginPct" | "warningLongDio" | "warningTrendLookbackMonths"
  | "warningMinVolumeT" | "warningMaxVolumeT" | "warningMinProfitKron"
  | "scaleHighMarginPct" | "scaleHighMarginVolumeT" | "scaleVolumePlayPct"
  | "scaleVolumePlayVolumeT" | "scaleGmroiiPct" | "scaleHighVolumeDioMax"
>;

export type GroupKey = "financial" | "anchor" | "eliminate" | "warning" | "scale";

export interface ThresholdSpec {
  key: ThresholdKey;
  label: string;       // plain English
  caption: string;     // one-line consequence, not the math
  min: number;
  max: number;
  step: number;
  calibrated: number;
  /** Render the value next to the label. Default uses the unit string. */
  format?: (v: number) => string;
}

const fmtPct = (v: number) => `${v.toFixed(1)}%`;
const fmtPctInt = (v: number) => `${Math.round(v)}%`;
const fmtFx = (v: number) => v.toFixed(2);
const fmtTons = (v: number) => `${v.toFixed(1)} t`;
const fmtTonsInt = (v: number) => `${Math.round(v)} t`;
const fmtKron = (v: number) => `${v.toFixed(1)} kRON`;
const fmtDays = (v: number) => `${Math.round(v)} d`;
const fmtMonths = (v: number) => `${Math.round(v)} m`;

export const GROUPS: { key: GroupKey; label: string }[] = [
  { key: "financial",  label: "Financial" },
  { key: "anchor",     label: "Anchor protection" },
  { key: "eliminate",  label: "Eliminate rules" },
  { key: "warning",    label: "Warning rules" },
  { key: "scale",      label: "Scale opportunities" },
];

export const SPECS: Record<GroupKey, ThresholdSpec[]> = {
  financial: [
    {
      key: "costOfCapitalPct", label: "Cost of capital",
      caption: "Used to compute real margin. Lower this if you have cheaper financing.",
      min: 3, max: 12, step: 0.1, calibrated: 6.5, format: fmtPct,
    },
    {
      key: "fxEurRon", label: "FX rate (EUR → RON)",
      caption: "Conversion rate used wherever revenue is reported in EUR.",
      min: 4.5, max: 5.5, step: 0.01, calibrated: 4.97, format: fmtFx,
    },
  ],
  anchor: [
    {
      key: "anchorTopPct", label: "Top % by absolute profit",
      caption: "What share of top contributors per category get anchor protection.",
      min: 10, max: 40, step: 1, calibrated: 20, format: fmtPctInt,
    },
    {
      key: "anchorMinRevenuePct", label: "Min profit share",
      caption: "An anchor must contribute at least this share of category profit.",
      min: 1, max: 15, step: 0.5, calibrated: 5.0, format: fmtPct,
    },
    {
      key: "anchorVolumeThresholdT", label: "Volume threshold (monthly)",
      caption: "SKUs above this volume can be anchors even without dominant profit share.",
      min: 10, max: 200, step: 5, calibrated: 50, format: fmtTonsInt,
    },
    {
      key: "highVolumeFloorPct", label: "High-volume anchor floor",
      caption: "Minimum real margin to keep anchor status when volume is the only reason.",
      min: 1, max: 15, step: 0.5, calibrated: 5.0, format: fmtPct,
    },
    {
      key: "anchorAbsoluteFloorPct", label: "Absolute floor (real margin)",
      caption: "Below this real margin, even an anchor gets a review alert.",
      min: -10, max: 0, step: 0.5, calibrated: -2.0, format: fmtPct,
    },
  ],
  eliminate: [
    {
      key: "microVolumeT", label: "Micro volume",
      caption: "SKUs below this volume that also miss the profit floor get eliminated.",
      min: 0.1, max: 20, step: 0.1, calibrated: 5, format: (v) => `< ${fmtTons(v)}`,
    },
    {
      key: "microProfitKron", label: "Micro profit",
      caption: "SKUs earning less than this (and below micro volume) get eliminated.",
      min: 0, max: 50, step: 0.5, calibrated: 5, format: (v) => `< ${fmtKron(v)}`,
    },
    {
      key: "dioCapitalTrap", label: "Capital trap DIO",
      caption: "Days a SKU can sit in stock before it's flagged as locking up cash.",
      min: 60, max: 365, step: 5, calibrated: 150, format: (v) => `> ${fmtDays(v)}`,
    },
    {
      key: "capitalTrapRealMarginPct", label: "Capital trap real margin",
      caption: "If real margin is below this AND DIO is too long, SKU is eliminated.",
      min: 0, max: 15, step: 0.5, calibrated: 5.0, format: (v) => `< ${fmtPct(v)}`,
    },
    {
      key: "zeroSalesWindowDays", label: "Zero-sales window",
      caption: "Days without a sale before a SKU is treated as dead inventory.",
      min: 30, max: 180, step: 5, calibrated: 60, format: fmtDays,
    },
    {
      key: "cccCategoryRedDays", label: "CCC red threshold (category)",
      caption: "Cash conversion cycle above this length flags the whole category.",
      min: 60, max: 240, step: 5, calibrated: 120, format: (v) => `> ${fmtDays(v)}`,
    },
  ],
  warning: [
    {
      key: "warningThinMarginPct", label: "Thin real margin",
      caption: "Real margin below this triggers WARNING (non-anchors only).",
      min: 0, max: 10, step: 0.5, calibrated: 3.0, format: (v) => `< ${fmtPct(v)}`,
    },
    {
      key: "warningLongDio", label: "Long DIO",
      caption: "Slow-moving inventory threshold for the WARNING bucket.",
      min: 60, max: 200, step: 5, calibrated: 100, format: (v) => `> ${fmtDays(v)}`,
    },
    {
      key: "warningMinVolumeT", label: "Min volume floor",
      caption: "Below this volume, thin-margin items go to ELIMINATE — too small to renegotiate.",
      min: 0, max: 50, step: 1, calibrated: 5, format: (v) => `> ${fmtTonsInt(v)}`,
    },
    {
      key: "warningMaxVolumeT", label: "High-volume escalation",
      caption: "Above this volume, thin-margin items escalate to urgent renegotiation (the Pickled Goods 188t case).",
      min: 50, max: 500, step: 10, calibrated: 150, format: (v) => `> ${fmtTonsInt(v)}`,
    },
    {
      key: "warningMinProfitKron", label: "Min absolute profit",
      caption: "Below this absolute profit, treat as ELIMINATE regardless of volume. 0 disables this gate.",
      min: 0, max: 50, step: 1, calibrated: 0, format: (v) => v === 0 ? "off" : `> ${fmtKron(v)}`,
    },
    {
      key: "warningTrendLookbackMonths", label: "Trend lookback",
      caption: "How many months of history feed the trend signal.",
      min: 1, max: 12, step: 1, calibrated: 3, format: fmtMonths,
    },
  ],
  scale: [
    {
      key: "scaleHighMarginPct", label: "High-margin floor",
      caption: "Real margin a SKU must exceed to be a scale candidate by margin.",
      min: 5, max: 25, step: 0.5, calibrated: 10, format: (v) => `> ${fmtPct(v)}`,
    },
    {
      key: "scaleHighMarginVolumeT", label: "High-margin min volume",
      caption: "Minimum volume so a high-margin SKU is worth scaling.",
      min: 5, max: 100, step: 5, calibrated: 30, format: (v) => `> ${fmtTonsInt(v)}`,
    },
    {
      key: "scaleVolumePlayPct", label: "Volume play floor",
      caption: "Real margin floor for the volume-play scale path.",
      min: 1, max: 15, step: 0.5, calibrated: 5.0, format: (v) => `> ${fmtPct(v)}`,
    },
    {
      key: "scaleVolumePlayVolumeT", label: "Volume play min",
      caption: "Volume above which a thinner-margin SKU is still scalable.",
      min: 50, max: 500, step: 10, calibrated: 100, format: (v) => `> ${fmtTonsInt(v)}`,
    },
    {
      key: "scaleGmroiiPct", label: "GMROII floor",
      caption: "Gross-margin return on inventory investment minimum to scale.",
      min: 50, max: 400, step: 25, calibrated: 150, format: (v) => `> ${fmtPctInt(v)}`,
    },
    {
      key: "scaleHighVolumeDioMax", label: "High-volume DIO max",
      caption: "Inventory days cap that protects a high-volume scale candidate.",
      min: 15, max: 90, step: 5, calibrated: 45, format: (v) => `< ${fmtDays(v)}`,
    },
  ],
};

// Flat list, in canonical order — handy for clamping and migrations.
export const ALL_SPECS: ThresholdSpec[] = GROUPS.flatMap((g) => SPECS[g.key]);

/** Clamp every numeric threshold into its declared [min, max] range and
 *  round to the nearest step. Run before persisting so a stale localStorage
 *  value (e.g. zero-sales=233 from before bounds were enforced) self-heals. */
export function clampThresholds(t: Thresholds): Thresholds {
  const out: Thresholds = { ...t };
  for (const spec of ALL_SPECS) {
    const v = (t as any)[spec.key];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      (out as any)[spec.key] = spec.calibrated;
      continue;
    }
    const clamped = Math.min(spec.max, Math.max(spec.min, v));
    // Round to step from min — same rule as the slider thumb.
    const stepped = Math.round((clamped - spec.min) / spec.step) * spec.step + spec.min;
    (out as any)[spec.key] = +stepped.toFixed(4);
  }
  // Display tab fields are not in SPECS; clamp those manually.
  out.gmDisplayMaxPct = Math.min(100, Math.max(20, t.gmDisplayMaxPct ?? DEFAULTS.gmDisplayMaxPct));
  out.periodMonths = Math.min(12, Math.max(1, Math.round(t.periodMonths ?? DEFAULTS.periodMonths)));
  return out;
}

/** True when the value is within one step of the calibrated default. */
export function isAtCalibrated(spec: ThresholdSpec, value: number): boolean {
  return Math.abs(value - spec.calibrated) < spec.step / 2;
}

/** True when *any* engine threshold differs from calibrated. */
export function hasDriftFromCalibrated(t: Thresholds): boolean {
  return ALL_SPECS.some((s) => !isAtCalibrated(s, (t as any)[s.key] as number));
}
