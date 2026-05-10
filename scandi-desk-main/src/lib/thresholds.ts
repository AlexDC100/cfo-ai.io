// Engine threshold store. Persists to localStorage and notifies subscribers
// (the Settings drawer writes; the dashboard reads + re-fetches on change).
// `gmDisplayMaxPct`, `language`, and `periodMonths` are kept here too because
// they live in the same Settings panel, but only the engine-relevant fields
// are sent to the backend (see thresholdsToBackendOverrides).

import { useSyncExternalStore } from "react";
import { clampThresholds } from "@/lib/thresholdSchema";

export const STORAGE_KEY = "aicfo.thresholds.v1";

export const DEFAULTS = {
  // Financial
  costOfCapitalPct: 6.5,
  fxEurRon: 4.97,

  // Anchor classification
  anchorTopPct: 20,
  anchorMinRevenuePct: 5.0,
  anchorVolumeThresholdT: 50,
  highVolumeFloorPct: 5.0,
  anchorAbsoluteFloorPct: -2.0,

  // Eliminate
  microVolumeT: 5,
  microProfitKron: 5,
  dioCapitalTrap: 150,
  capitalTrapRealMarginPct: 5.0,
  zeroSalesWindowDays: 60,
  cccCategoryRedDays: 120,

  // Warning
  warningThinMarginPct: 3.0,
  warningLongDio: 100,
  warningTrendLookbackMonths: 3,
  warningMinVolumeT: 5,           // Below this, thin-margin items go to ELIMINATE
  warningMaxVolumeT: 150,         // Above this, thin-margin items escalate to "renegotiate urgently"
  warningMinProfitKron: 0,        // Absolute-profit floor (0 = disabled)

  // Scale
  scaleHighMarginPct: 10,
  scaleHighMarginVolumeT: 30,
  scaleVolumePlayPct: 5.0,
  scaleVolumePlayVolumeT: 100,
  scaleGmroiiPct: 150,
  scaleHighVolumeDioMax: 45,

  // Display / data (frontend-only)
  periodMonths: 10,
  gmDisplayMaxPct: 50,
  language: "en" as "en" | "ro",
};

export type Thresholds = typeof DEFAULTS;

// ────────────── Backend payload shape ──────────────
// Mirrors EngineOverrides in src/engine/api/frontend.py. Sent on every
// classification call so the engine reclassifies with the user's sliders.

export interface BackendOverrides {
  cost_of_capital_pct?: number;
  fx_eur_ron?: number;
  anchor?: {
    top_pct_by_absolute_profit?: number;
    min_revenue_share_pct?: number;
    volume_threshold_tons_default?: number;
    floor_real_margin_pct?: number;
    high_volume_anchor_floor_pct?: number;
  };
  eliminate?: {
    micro_volume_tons?: number;
    micro_profit_kron?: number;
    dio_capital_trap?: number;
    capital_trap_real_margin?: number;
    zero_sales_window_days?: number;
    ccc_category_red_days?: number;
  };
  warning?: {
    thin_real_margin_max_pct?: number;
    long_dio_days?: number;
    trend_lookback_months?: number;
    min_volume_tons?: number;
    max_volume_tons?: number;
    min_profit_kron?: number;
  };
  scale?: {
    high_margin_min_pct?: number;
    high_margin_min_volume?: number;
    volume_play_min_pct?: number;
    volume_play_min_volume?: number;
    gmroii_min_pct?: number;
    high_volume_dio_max?: number;
  };
}

export function thresholdsToBackendOverrides(t: Thresholds): BackendOverrides {
  return {
    cost_of_capital_pct: t.costOfCapitalPct,
    fx_eur_ron: t.fxEurRon,
    anchor: {
      top_pct_by_absolute_profit: t.anchorTopPct,
      min_revenue_share_pct: t.anchorMinRevenuePct,
      volume_threshold_tons_default: t.anchorVolumeThresholdT,
      floor_real_margin_pct: t.anchorAbsoluteFloorPct,
      high_volume_anchor_floor_pct: t.highVolumeFloorPct,
    },
    eliminate: {
      micro_volume_tons: t.microVolumeT,
      micro_profit_kron: t.microProfitKron,
      dio_capital_trap: t.dioCapitalTrap,
      capital_trap_real_margin: t.capitalTrapRealMarginPct,
      zero_sales_window_days: t.zeroSalesWindowDays,
      ccc_category_red_days: t.cccCategoryRedDays,
    },
    warning: {
      thin_real_margin_max_pct: t.warningThinMarginPct,
      long_dio_days: t.warningLongDio,
      trend_lookback_months: t.warningTrendLookbackMonths,
      min_volume_tons: t.warningMinVolumeT,
      max_volume_tons: t.warningMaxVolumeT,
      min_profit_kron: t.warningMinProfitKron,
    },
    scale: {
      high_margin_min_pct: t.scaleHighMarginPct,
      high_margin_min_volume: t.scaleHighMarginVolumeT,
      volume_play_min_pct: t.scaleVolumePlayPct,
      volume_play_min_volume: t.scaleVolumePlayVolumeT,
      gmroii_min_pct: t.scaleGmroiiPct,
      high_volume_dio_max: t.scaleHighVolumeDioMax,
    },
  };
}

// ────────────── Persisted store ──────────────

const listeners = new Set<() => void>();
function emit() { listeners.forEach((l) => l()); }

let cached: Thresholds | null = null;
let cachedRaw: string | null = null;

export function readThresholds(): Thresholds {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      if (cachedRaw !== null) { cached = DEFAULTS; cachedRaw = null; }
      return cached ?? DEFAULTS;
    }
    if (raw === cachedRaw && cached) return cached;
    cachedRaw = raw;
    // Clamp on read so legacy out-of-range values from before bounds were
    // enforced self-heal (e.g. the 233-day zero-sales bug).
    const merged = { ...DEFAULTS, ...JSON.parse(raw) } as Thresholds;
    cached = clampThresholds(merged);
    return cached;
  } catch {
    return DEFAULTS;
  }
}

export function writeThresholds(t: Thresholds) {
  const safe = clampThresholds(t);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(safe));
  // Force-refresh cache so subscribers see the new value synchronously.
  cachedRaw = localStorage.getItem(STORAGE_KEY);
  cached = safe;
  emit();
}

export function clearThresholdOverrides() {
  localStorage.removeItem(STORAGE_KEY);
  cachedRaw = null;
  cached = null;
  emit();
}

export function hasCustomThresholds(): boolean {
  return localStorage.getItem(STORAGE_KEY) !== null;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) emit();
  };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(cb); window.removeEventListener("storage", onStorage); };
}

export function useThresholds(): Thresholds {
  return useSyncExternalStore(subscribe, readThresholds, () => DEFAULTS);
}

// Stable cache key for React Query / useEffect deps. Changes whenever the
// backend-relevant subset changes; pure display fields are excluded so
// flipping the GM display ceiling doesn't refetch.
export function backendOverridesKey(t: Thresholds): string {
  return JSON.stringify(thresholdsToBackendOverrides(t));
}
