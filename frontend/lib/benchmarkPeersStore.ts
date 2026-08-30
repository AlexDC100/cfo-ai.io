// Per-user benchmark peer selections — localStorage-backed store.
//
// NASDAQ-11 shipped this as a FE-only store so the "Add as peer" UX works
// instantly without backend round-trips. A later sprint will sync to the
// `benchmark_peers` Supabase table (schema_phase_nasdaq_public_companies.sql)
// so peers persist across devices.
//
// ── GLOBAL PUBLIC MARKETS (2026-08-30) ────────────────────────────────
// A peer used to be a BVB ticker and nothing else, so a ticker alone was
// its whole identity and the Benchmarking panel could resolve it out of
// the loaded (BVB-only) universe. Neither holds once a peer can come
// from the US tab:
//
//   1. IDENTITY is (market, ticker). Two registries may both list "ABC"
//      and they are not the same company. Peers are keyed on the pair.
//   2. A peer carries its OWN market, currency and accounting standard,
//      because that triple is what decides which population it may sit
//      in (lib/benchmarkGroups.ts). Losing it is exactly how a USD
//      US_GAAP filer lands inside a RON RAS/IFRS median.
//   3. A peer the loaded universe cannot resolve carries the RATIOS its
//      own filing supports, computed at add time from that document's
//      figures. Absent stays ABSENT — a metric the filing never gave is
//      simply not on the entry, never a zero.
//
// Legacy entries (ticker/name/sector/exchange/currency only) still load;
// `normalizePeer` fills `marketId` from the exchange where the mapping is
// unambiguous and leaves it absent otherwise.

import { useSyncExternalStore } from "react";

/** Ratio metrics a peer may carry from its own filing, in NATIVE units
 *  and percentage POINTS (the same convention `WatchlistRow` uses). Every
 *  field is optional on purpose: a filing that never stated EBITDA has no
 *  EBITDA margin, and that is a different fact from an EBITDA margin of
 *  zero. Keys mirror the Benchmarking panel's metric keys 1:1. */
export interface PeerMetrics {
  revenue_growth_pct?: number;
  ebitda_margin_pct?: number;
  net_margin_pct?: number;
  net_debt_to_ebitda?: number;
  debt_to_equity?: number;
  fcf_yield_pct?: number;
  ev_ebitda?: number;
  dividend_yield_pct?: number;
}

export interface PeerEntry {
  ticker: string;
  name: string;
  sector: string | null;
  exchange: string | null;
  currency: string;
  source: "public";
  addedAt: string; // ISO timestamp
  /** Registry market_id ("ro", "us", …) the peer was resolved in. */
  marketId?: string | null;
  /** Accounting standard as markets.yaml spells it ("US_GAAP"). Stored
   *  for provenance/display; the grouping law re-derives its own copy
   *  from the market id so there is one authority for a cohort key. */
  accountingStandard?: string | null;
  /** Fiscal label of the figures below ("FY2025"). */
  fiscalLabel?: string | null;
  /** Ratios derived from the peer's own document at add time. */
  metrics?: PeerMetrics;
}

const STORAGE_KEY = "cfo:benchmark-peers:v1";

/** Exchanges whose market is unambiguous, for back-filling legacy rows.
 *  Deliberately tiny: only venues that map to exactly one registry
 *  market. Anything else keeps `marketId` absent and falls back to the
 *  exchange path in benchmarkGroups. */
const LEGACY_EXCHANGE_MARKET: Readonly<Record<string, string>> = {
  BVB: "ro",
  NYSE: "us",
  NASDAQ: "us",
};

/** The (market, ticker) identity. An entry with no market keys on the
 *  ticker alone, which is what every pre-2026-08-30 entry did. */
export function peerKey(
  ticker: string,
  marketId?: string | null,
): string {
  return `${(marketId ?? "").trim().toLowerCase()}|${ticker.trim().toUpperCase()}`;
}

export function peerEntryKey(p: PeerEntry): string {
  return peerKey(p.ticker, p.marketId);
}

function normalizePeer(p: PeerEntry): PeerEntry {
  if (p.marketId) return p;
  const ex = (p.exchange ?? "").trim().toUpperCase();
  const inferred = LEGACY_EXCHANGE_MARKET[ex];
  return inferred ? { ...p, marketId: inferred } : p;
}

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
    return parsed
      .filter(
        (p): p is PeerEntry =>
          p && typeof p.ticker === "string" && typeof p.name === "string",
      )
      .map(normalizePeer);
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

/** Membership test. With `marketId` the test is scoped to that market —
 *  the only correct question once two registries can both list a ticker.
 *  Without it the legacy ticker-wide test is preserved, so every caller
 *  that predates multi-market peers keeps its exact behaviour. */
export function isPeer(ticker: string, marketId?: string | null): boolean {
  const t = ticker.trim().toUpperCase();
  if (marketId == null) return snapshot.some((p) => p.ticker === t);
  const key = peerKey(t, marketId);
  return snapshot.some((p) => peerEntryKey(p) === key);
}

export function addPeer(
  entry: Omit<PeerEntry, "addedAt" | "source"> & { source?: "public" },
): void {
  const ticker = entry.ticker.trim().toUpperCase();
  if (!ticker) return;
  const candidate = normalizePeer({
    ...entry,
    ticker,
    source: entry.source ?? "public",
    addedAt: new Date().toISOString(),
  } as PeerEntry);
  const key = peerEntryKey(candidate);
  if (snapshot.some((p) => peerEntryKey(p) === key)) return; // already a peer
  setSnapshot([...snapshot, candidate]);
}

/** Remove one peer. Scoped to a market when given; otherwise removes
 *  every entry with that ticker, matching the pre-multi-market callers. */
export function removePeer(ticker: string, marketId?: string | null): void {
  const t = ticker.trim().toUpperCase();
  if (marketId == null) {
    setSnapshot(snapshot.filter((p) => p.ticker !== t));
    return;
  }
  const key = peerKey(t, marketId);
  setSnapshot(snapshot.filter((p) => peerEntryKey(p) !== key));
}

export function clearPeers(): void {
  setSnapshot([]);
}

/** Synchronous read for non-React callers (e.g. analytics, future
 *  Supabase sync). React components should use `useBenchmarkPeers`. */
export function getPeers(): PeerEntry[] {
  return snapshot;
}
