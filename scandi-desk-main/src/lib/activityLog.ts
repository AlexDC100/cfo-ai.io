// Append-only activity log shown in the Settings → Data tab.
// Captures who did what to the engine state — applied tuning changes,
// dataset uploads, AI regens, decisions, resets. Persisted in localStorage;
// per-browser only (single-tenant for v2). Capped at 100 entries.

import { useSyncExternalStore } from "react";
import { getCurrentUserName } from "@/lib/identity";

const KEY = "aicfo.activityLog.v1";
const CAP = 100;

export type ActivityKind =
  | "upload"
  | "tuning_applied"
  | "tuning_reverted"
  | "ai_regenerated"
  | "ai_cleared"
  | "data_reset"
  | "data_cleared"
  | "decision_marked";

export interface ActivityEntry {
  ts: string;            // ISO
  user: string;
  kind: ActivityKind;
  detail: string;        // human one-liner shown in the list
}

const listeners = new Set<() => void>();
function emit() { listeners.forEach((l) => l()); }

// Stable empty array — useSyncExternalStore requires the snapshot to keep
// the same identity across reads when nothing changed, otherwise React loops.
const EMPTY: ActivityEntry[] = Object.freeze([]) as unknown as ActivityEntry[];

let cached: ActivityEntry[] = EMPTY;
let cachedRaw: string | null = null;

function read(): ActivityEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) {
      if (cachedRaw !== null) { cached = EMPTY; cachedRaw = null; }
      return cached;
    }
    if (raw === cachedRaw) return cached;
    cachedRaw = raw;
    cached = JSON.parse(raw) as ActivityEntry[];
    return cached;
  } catch { return EMPTY; }
}

export function logActivity(kind: ActivityKind, detail: string) {
  const entry: ActivityEntry = {
    ts: new Date().toISOString(),
    user: getCurrentUserName(),
    kind,
    detail,
  };
  const next = [entry, ...read()].slice(0, CAP);
  localStorage.setItem(KEY, JSON.stringify(next));
  cachedRaw = localStorage.getItem(KEY); cached = next;
  emit();
}

export function clearActivityLog() {
  localStorage.removeItem(KEY);
  cached = EMPTY; cachedRaw = null;
  emit();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) emit();
  };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(cb); window.removeEventListener("storage", onStorage); };
}

export function useActivityLog(): ActivityEntry[] {
  return useSyncExternalStore(subscribe, read, () => EMPTY);
}

/** Format the timestamp into the "16:13 today / 14:22 yesterday / 5 May" style
 *  used in the run history list. */
export function formatActivityTime(iso: string, now = new Date()): string {
  const t = new Date(iso);
  const sameDay = t.toDateString() === now.toDateString();
  if (sameDay) {
    return `${t.getHours().toString().padStart(2, "0")}:${t.getMinutes().toString().padStart(2, "0")} today`;
  }
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (t.toDateString() === y.toDateString()) {
    return `${t.getHours().toString().padStart(2, "0")}:${t.getMinutes().toString().padStart(2, "0")} yesterday`;
  }
  return t.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** Look up the most recent applied tuning change for a given group key
 *  (e.g. "anchor", "eliminate"). Used to render "Last changed by Alex"
 *  next to each group title. */
export function lastTuningChangeFor(group: string, log: ActivityEntry[]): ActivityEntry | null {
  return log.find((e) => e.kind === "tuning_applied" && e.detail.toLowerCase().includes(group.toLowerCase())) ?? null;
}
