// pricingConfig.ts — frontend typed mirror of the backend pricing config.
//
// PAIRS WITH `src/engine/api/_pricing_config.py`. The shape returned by
// `GET /api/pricing/config` is what this module fetches. To change a
// price/limit:
//   1. Edit the env override (or default) in `_pricing_config.py`
//   2. Restart the backend (or reload the singleton via the admin endpoint)
//   3. Frontend picks it up automatically on next session
//
// There is NO copy of the prices in the frontend that can drift from the
// backend. The Pricing page, Settings card, and any other surface that
// mentions €X all read from this hook.

import { useEffect, useState } from "react";

const API_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";

// ─────────────────────────────────────────────────────────────────────
// Types — mirror the public dict returned by `_pricing_config.to_public_dict`
// ─────────────────────────────────────────────────────────────────────

// 2026-08 tier restructure: `solo` (RO Solo €4.99) and `multi`
// (Multi-Country €16.99) join; `starter` (€14.99) is RETIRED from
// purchase but stays in the type because legacy holders still resolve
// to it on plan-state surfaces until their subscription migrates.
export type PlanKey = "trial" | "intro" | "starter" | "solo" | "pro" | "multi";

export interface PlanConfig {
  key: PlanKey;
  display_name: string;
  blurb: string;
  /** Monthly recurring price for the paid tiers, one-time price for
   *  intro, 0 for trial. The `recurring` field disambiguates. */
  price_eur: number;
  recurring: boolean;
  requires_card: boolean;
  included_docs: number;
  /** Per-doc charge when over `included_docs`. null = no overage allowed. */
  extra_doc_eur: number | null;
  chat_daily_cap: number | null;
  chat_monthly_cap: number | null;
  /** Days that the trial/intro one-shot window stays valid. null = recurring. */
  window_days: number | null;
  // ── 2026-08 additive fields — ALL optional so an old backend that
  //    hasn't shipped the tier restructure still type-checks. ──────────
  /** False for retired tiers (starter) that legacy holders keep but new
   *  users must never be able to buy. Absent = old backend; treat the
   *  spec-retired keys as non-purchasable regardless. */
  purchasable?: boolean;
  /** Workspace cap for the tier (1 for trial/intro/solo, 5 for pro/multi). */
  max_workspaces?: number;
  /** Whether non-Romanian (jurisdiction != RO) documents are allowed. */
  allows_non_ro?: boolean;
  /** Non-RO docs included per month (multi only). */
  included_nonro_docs?: number;
  /** Per-doc charge for non-RO docs above the inclusion (multi only). */
  extra_nonro_doc_eur?: number | null;
}

export interface PricingPublicConfig {
  plans: PlanConfig[];
}

// ─────────────────────────────────────────────────────────────────────
// Cache + fetch
// ─────────────────────────────────────────────────────────────────────

let cache: PricingPublicConfig | null = null;
let inflight: Promise<PricingPublicConfig> | null = null;
let loadedAt = 0;
const STALE_MS = 10 * 60 * 1000;

type Listener = (cfg: PricingPublicConfig) => void;
const listeners = new Set<Listener>();

function publish(cfg: PricingPublicConfig) {
  cache = cfg;
  loadedAt = Date.now();
  for (const l of listeners) l(cfg);
}

async function loadOnce(force = false): Promise<PricingPublicConfig> {
  if (!force && cache && Date.now() - loadedAt < STALE_MS) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const r = await fetch(`${API_URL}/api/pricing/config`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const cfg = (await r.json()) as PricingPublicConfig;
      publish(cfg);
      return cfg;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

// ─────────────────────────────────────────────────────────────────────
// Public hook
// ─────────────────────────────────────────────────────────────────────

export function usePricingConfig(): {
  config: PricingPublicConfig | null;
  loading: boolean;
  /** Force a refresh from the server (e.g., after admin changes prices). */
  refresh: () => Promise<void>;
} {
  const [cfg, setCfg] = useState<PricingPublicConfig | null>(cache);
  const [loading, setLoading] = useState<boolean>(cache === null);

  useEffect(() => {
    let mounted = true;
    const listener: Listener = (c) => {
      if (!mounted) return;
      setCfg(c);
      setLoading(false);
    };
    listeners.add(listener);
    if (cache === null) {
      void loadOnce().catch(() => { if (mounted) setLoading(false); });
    } else {
      setLoading(false);
    }
    return () => {
      mounted = false;
      listeners.delete(listener);
    };
  }, []);

  return {
    config: cfg,
    loading,
    refresh: async () => { await loadOnce(true); },
  };
}

/** Imperative sync read — null until the first fetch resolves. Useful
 *  inside non-component code paths (event handlers, route guards). */
export function getPricingConfigSync(): PricingPublicConfig | null {
  return cache;
}

// ─────────────────────────────────────────────────────────────────────
// Helpers shared across the Pricing page + Settings card
// ─────────────────────────────────────────────────────────────────────

export function formatEur(amount: number, opts?: { dp?: number; trailZero?: boolean }): string {
  const dp = opts?.dp ?? 2;
  const v = amount.toFixed(dp);
  // Trim trailing .00 when caller wants compact display (e.g., "€14.99 / mo"
  // stays full, but "€0" or "€15" can drop the decimals).
  if (opts?.trailZero === false && v.endsWith("." + "0".repeat(dp))) {
    return `€${Math.trunc(amount)}`;
  }
  return `€${v}`;
}

export function planByKey(cfg: PricingPublicConfig | null, key: PlanKey): PlanConfig | null {
  if (!cfg) return null;
  return cfg.plans.find((p) => p.key === key) ?? null;
}

/** Tier keys retired from purchase (2026-08 restructure). They can still
 *  appear in the config (for legacy holders' plan-state fallbacks) but
 *  must NEVER render as a purchasable card, even when talking to an old
 *  backend that predates the `purchasable` flag. */
const RETIRED_PLAN_KEYS: ReadonlySet<string> = new Set(["starter"]);

/** The paid tiers a NEW user can buy, price-ascending — what the pricing
 *  grid renders. Filters: recurring, not explicitly `purchasable: false`,
 *  and never a spec-retired key (belt for old backends without the flag). */
export function purchasablePaidPlans(cfg: PricingPublicConfig | null): PlanConfig[] {
  if (!cfg) return [];
  return cfg.plans
    .filter(
      (p) =>
        p.recurring &&
        p.purchasable !== false &&
        !RETIRED_PLAN_KEYS.has(p.key),
    )
    .sort((a, b) => a.price_eur - b.price_eur);
}

// ─────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────

export function __setPricingConfigForTest(cfg: PricingPublicConfig): void {
  publish(cfg);
}

export function __clearPricingConfigForTest(): void {
  cache = null;
  inflight = null;
  loadedAt = 0;
}
