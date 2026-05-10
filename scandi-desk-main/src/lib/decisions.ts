// Local store for user decisions on individual SKUs (approve / dismiss).
//
// The engine recommends; the user confirms. We keep the confirmation locally
// so the UI shows "decided" state even after a reload. Future: sync to PG.

import { useSyncExternalStore } from "react";

export type DecisionStatus = "pending" | "approved" | "dismissed";

interface DecisionMap {
  [skuId: string]: { status: DecisionStatus; at: string };
}

const KEY = "aicfo.skuDecisions.v1";
const EMPTY: DecisionMap = Object.freeze({}) as DecisionMap;
const listeners = new Set<() => void>();
function emit() { listeners.forEach((l) => l()); }

let cached: DecisionMap = EMPTY;
let cachedRaw: string | null = null;

// IMPORTANT: must return a STABLE reference when storage hasn't changed,
// otherwise useSyncExternalStore loops forever.
function read(): DecisionMap {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) {
      if (cachedRaw !== null) { cached = EMPTY; cachedRaw = null; }
      return cached;
    }
    if (raw === cachedRaw) return cached;
    cachedRaw = raw;
    cached = JSON.parse(raw) as DecisionMap;
    return cached;
  } catch { return EMPTY; }
}

function write(map: DecisionMap) {
  const serialized = JSON.stringify(map);
  localStorage.setItem(KEY, serialized);
  cachedRaw = serialized;
  cached = map;
  emit();
}

export function setDecision(skuId: string, status: DecisionStatus): void {
  const map = { ...read() };
  if (status === "pending") delete map[skuId];
  else map[skuId] = { status, at: new Date().toISOString() };
  write(map);
}

export function setManyDecisions(skuIds: string[], status: DecisionStatus): void {
  const map = { ...read() };
  for (const id of skuIds) {
    if (status === "pending") delete map[id];
    else map[id] = { status, at: new Date().toISOString() };
  }
  write(map);
}

export function clearAllDecisions(): void {
  localStorage.removeItem(KEY);
  cached = EMPTY; cachedRaw = null;
  emit();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => { if (e.key === KEY) emit(); };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(cb); window.removeEventListener("storage", onStorage); };
}

export function useDecisions(): DecisionMap {
  return useSyncExternalStore(subscribe, read, () => EMPTY);
}

export function getDecisionStatus(map: DecisionMap, skuId: string): DecisionStatus {
  return map[skuId]?.status ?? "pending";
}

export function decisionCounts(map: DecisionMap): { approved: number; dismissed: number; total: number } {
  let approved = 0, dismissed = 0;
  for (const v of Object.values(map)) {
    if (v.status === "approved") approved++;
    else if (v.status === "dismissed") dismissed++;
  }
  return { approved, dismissed, total: approved + dismissed };
}
