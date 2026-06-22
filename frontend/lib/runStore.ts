// Tiny store for the active DailyRun. Reads from localStorage; falls back to the seed mock.

import { useSyncExternalStore } from "react";
import { dailyRun as seedRun, type DailyRun } from "@/data/dailyRun";
import type { RawSkuRow } from "@/lib/engine";
import type { Alert } from "@/lib/alerts";

const KEY = "aicfo.activeRun.v1";
const META_KEY = "aicfo.activeRun.meta.v1";
const ANALYSIS_KEY = "aicfo.analysis.v1";
const RAW_ROWS_KEY = "aicfo.rawRows.v1";
const ALERTS_KEY = "aicfo.alerts.v1";

export interface RunMeta {
  source: "seed" | "upload";
  fileName?: string;
  uploadedAt?: string;
  rowCount?: number;
}

export interface Proposition {
  title: string;
  detail: string;
  impact: string;
  priority: "high" | "medium" | "low";
}

export interface Elimination {
  name: string;
  real_margin_pct: number;
  absolute_profit_kron: number;
  verdict: "remove now" | "wind down" | "renegotiate or exit";
  reason: string;
  capital_freed_note: string;
}

export interface SkuRemoval {
  sku: string;
  category: string;
  volume_t: number;
  real_margin_pct: number;
  absolute_profit_kron: number;
  dio_days: number;
  verdict: "remove now" | "wind down" | "renegotiate or exit";
  reason: string;
}

export interface Analysis {
  headline: string;
  summary_en: string;
  summary_ro: string;
  eliminations?: Elimination[];
  sku_removals?: SkuRemoval[];
  proposition: Proposition[];
  confidence: "high" | "medium" | "low";
  generatedAt: string;
}

const listeners = new Set<() => void>();
function emit() { listeners.forEach((l) => l()); }

let cachedRun: DailyRun | null = null;
let cachedRunRaw: string | null = null;
let cachedMeta: RunMeta | null = null;
let cachedMetaRaw: string | null = null;

function read(): DailyRun {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) { cachedRunRaw = null; cachedRun = seedRun; return seedRun; }
    if (raw === cachedRunRaw && cachedRun) return cachedRun;
    cachedRunRaw = raw;
    cachedRun = JSON.parse(raw) as DailyRun;
    return cachedRun;
  } catch {
    return seedRun;
  }
}

// Stable seed reference — returned on storage-miss / parse-error so React's
// useSyncExternalStore doesn't loop forever on equality checks.
const SEED_META: RunMeta = Object.freeze({ source: "seed" }) as RunMeta;

function readMeta(): RunMeta {
  try {
    const raw = localStorage.getItem(META_KEY);
    if (!raw) {
      if (cachedMetaRaw !== null) { cachedMeta = SEED_META; cachedMetaRaw = null; }
      return cachedMeta ?? SEED_META;
    }
    if (raw === cachedMetaRaw && cachedMeta) return cachedMeta;
    cachedMetaRaw = raw;
    cachedMeta = JSON.parse(raw) as RunMeta;
    return cachedMeta;
  } catch {
    return SEED_META;
  }
}

export function setActiveRun(
  run: DailyRun,
  meta: Omit<RunMeta, "source"> & { source?: RunMeta["source"] },
  rawRows?: RawSkuRow[],
) {
  localStorage.setItem(KEY, JSON.stringify(run));
  localStorage.setItem(META_KEY, JSON.stringify({ source: "upload", ...meta }));
  localStorage.removeItem(ANALYSIS_KEY);
  // New dataset → drop the previous run's alerts so we don't show them
  // mixed with the new one. setUploadAlerts() repopulates them after this
  // returns when the caller has the upload response in hand.
  localStorage.removeItem(ALERTS_KEY);
  cachedAnalysisRaw = null; cachedAnalysis = null;
  cachedAlerts = null; cachedAlertsRaw = null;
  if (rawRows && rawRows.length) {
    // Cap to keep localStorage manageable; full payload goes through the server.
    try {
      localStorage.setItem(RAW_ROWS_KEY, JSON.stringify(rawRows));
      cachedRawRows = rawRows; cachedRawRowsRaw = localStorage.getItem(RAW_ROWS_KEY);
    } catch {
      // Quota exceeded — drop the cache; drill will need to be re-uploaded.
      localStorage.removeItem(RAW_ROWS_KEY);
      cachedRawRows = null; cachedRawRowsRaw = null;
    }
  } else {
    localStorage.removeItem(RAW_ROWS_KEY);
    cachedRawRows = null; cachedRawRowsRaw = null;
  }
  emit();
}

let cachedRawRows: RawSkuRow[] | null = null;
let cachedRawRowsRaw: string | null = null;
function readRawRows(): RawSkuRow[] | null {
  try {
    const raw = localStorage.getItem(RAW_ROWS_KEY);
    if (!raw) { cachedRawRowsRaw = null; cachedRawRows = null; return null; }
    if (raw === cachedRawRowsRaw && cachedRawRows) return cachedRawRows;
    cachedRawRowsRaw = raw;
    cachedRawRows = JSON.parse(raw) as RawSkuRow[];
    return cachedRawRows;
  } catch { return null; }
}

export function useRawRows(): RawSkuRow[] | null {
  return useSyncExternalStore(subscribe, readRawRows, () => null);
}

export function clearAnalysis() {
  localStorage.removeItem(ANALYSIS_KEY);
  cachedAnalysisRaw = null; cachedAnalysis = null;
  emit();
}

export function getStorageBytes(): number {
  let total = 0;
  for (const k of [KEY, META_KEY, ANALYSIS_KEY, RAW_ROWS_KEY]) {
    const v = localStorage.getItem(k);
    if (v) total += v.length + k.length;
  }
  return total;
}

export function clearActiveRun() {
  localStorage.removeItem(KEY);
  localStorage.removeItem(META_KEY);
  localStorage.removeItem(ANALYSIS_KEY);
  localStorage.removeItem(RAW_ROWS_KEY);
  localStorage.removeItem(ALERTS_KEY);
  // Also wipe per-SKU approve/dismiss state — those decisions only make sense
  // against the dataset they were made on.
  localStorage.removeItem("aicfo.skuDecisions.v1");
  cachedAnalysisRaw = null; cachedAnalysis = null;
  cachedRawRows = null; cachedRawRowsRaw = null;
  cachedAlerts = null; cachedAlertsRaw = null;
  emit();
  window.dispatchEvent(new StorageEvent("storage", { key: "aicfo.skuDecisions.v1" }));
}

export function setAnalysis(a: Analysis) {
  localStorage.setItem(ANALYSIS_KEY, JSON.stringify(a));
  emit();
}

// ─── Server-derived alerts from /api/upload-excel ───────────────────────────

let cachedAlerts: Alert[] | null = null;
let cachedAlertsRaw: string | null = null;

function readAlerts(): Alert[] | null {
  try {
    const raw = localStorage.getItem(ALERTS_KEY);
    if (!raw) { cachedAlertsRaw = null; cachedAlerts = null; return null; }
    if (raw === cachedAlertsRaw && cachedAlerts) return cachedAlerts;
    cachedAlertsRaw = raw;
    cachedAlerts = JSON.parse(raw) as Alert[];
    return cachedAlerts;
  } catch { return null; }
}

export function setUploadAlerts(alerts: Alert[] | null | undefined) {
  if (!alerts || alerts.length === 0) {
    localStorage.removeItem(ALERTS_KEY);
    cachedAlerts = null; cachedAlertsRaw = null;
  } else {
    localStorage.setItem(ALERTS_KEY, JSON.stringify(alerts));
    cachedAlerts = alerts; cachedAlertsRaw = localStorage.getItem(ALERTS_KEY);
  }
  emit();
}

/** Returns server alerts from the most recent upload, or null if none. */
export function useUploadAlerts(): Alert[] | null {
  return useSyncExternalStore(subscribe, readAlerts, () => null);
}

let cachedAnalysis: Analysis | null = null;
let cachedAnalysisRaw: string | null = null;
function readAnalysis(): Analysis | null {
  try {
    const raw = localStorage.getItem(ANALYSIS_KEY);
    if (!raw) { cachedAnalysisRaw = null; cachedAnalysis = null; return null; }
    if (raw === cachedAnalysisRaw && cachedAnalysis) return cachedAnalysis;
    cachedAnalysisRaw = raw;
    cachedAnalysis = JSON.parse(raw) as Analysis;
    return cachedAnalysis;
  } catch { return null; }
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (
      e.key === KEY ||
      e.key === META_KEY ||
      e.key === ANALYSIS_KEY ||
      e.key === RAW_ROWS_KEY ||
      e.key === ALERTS_KEY
    ) emit();
  };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(cb); window.removeEventListener("storage", onStorage); };
}

export function useDailyRun(): DailyRun {
  return useSyncExternalStore(subscribe, read, () => seedRun);
}

export function useRunMeta(): RunMeta {
  return useSyncExternalStore(subscribe, readMeta, () => SEED_META);
}

export function useAnalysis(): Analysis | null {
  return useSyncExternalStore(subscribe, readAnalysis, () => null);
}
