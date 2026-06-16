// Per-user benchmark peer selections — localStorage-backed Zustand store.
//
// NASDAQ-11 ships this as a FE-only store so the "Add as peer" UX works
// instantly without backend round-trips. A later sprint will sync to the
// `benchmark_peers` Supabase table (schema_phase_nasdaq_public_companies.sql)
// so peers persist across devices.
//
// Shape per stored peer:
//   { ticker, name, sector, exchange, currency, addedAt }
// Source is always "public" in v1 (Nasdaq tickers). Reserved for "private"
// peer-dashboards later.

import { useSyncExternalStore } from "react";

export interface PeerEntry {
  ticker: string;
  name: string;
  sector: string | null;
  exchange: string | null;
  currency: string;
  source: "public";
  addedAt: string; // ISO timestamp
}

const STORAGE_KEY = "cfo:benchmark-peers:v1";

let listeners: Set<() => void> = new Set();
let snapshot: PeerEntry[] = readFromStorage();

function readFromStorage(): PeerEntry[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Defensive filter — drop malformed entries from older builds.
    return parsed.filter(
      (p): p is PeerEntry =>
        p && typeof p.ticker === "string" && typeof p.name === "string",
    );
  } catch {
    return [];
  }
}

function writeToStorage(next: PeerEntry[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore quota / privacy-mode failures
  }
}

function setSnapshot(next: PeerEntry[]): void {
  snapshot = next;
  writeToStorage(next);
  for (const cb of listeners) cb();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): PeerEntry[] {
  return snapshot;
}

// ── Public API ────────────────────────────────────────────────────────

export function useBenchmarkPeers(): PeerEntry[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function isPeer(ticker: string): boolean {
  const t = ticker.trim().toUpperCase();
  return snapshot.some((p) => p.ticker === t);
}

export function addPeer(entry: Omit<PeerEntry, "addedAt" | "source"> & { source?: "public" }): void {
  const ticker = entry.ticker.trim().toUpperCase();
  if (!ticker) return;
  if (snapshot.some((p) => p.ticker === ticker)) return; // already a peer
  const next: PeerEntry[] = [
    ...snapshot,
    {
      ticker,
      name: entry.name,
      sector: entry.sector,
      exchange: entry.exchange,
      currency: entry.currency,
      source: entry.source ?? "public",
      addedAt: new Date().toISOString(),
    },
  ];
  setSnapshot(next);
}

export function removePeer(ticker: string): void {
  const t = ticker.trim().toUpperCase();
  setSnapshot(snapshot.filter((p) => p.ticker !== t));
}

export function clearPeers(): void {
  setSnapshot([]);
}

/** Synchronous read for non-React callers (e.g. analytics, future
 *  Supabase sync). React components should use `useBenchmarkPeers`. */
export function getPeers(): PeerEntry[] {
  return snapshot;
}
