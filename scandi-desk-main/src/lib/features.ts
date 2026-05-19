// features.ts — typed frontend client for the backend feature registry.
//
// Pairs with `src/engine/api/_features.py` → `GET /api/features/status`.
// Lives at /lib (not /components) because it's pure data + a hook; every
// surface that gates UI (Command Center rows, Sidebar items, Settings
// sections) imports from here.
//
// WHY A REGISTRY HOOK (instead of `if (FEATURE_X_ENABLED)` everywhere)
//   · One round-trip per app load, fanned out via React state.
//   · Status can flip without a frontend redeploy (e.g., flip
//     `erp_connector` to `active` server-side and the UI updates on
//     next session).
//   · One place to mock in tests (override `__setFeaturesForTest`).
//
// FETCH POLICY
//   The registry is small (~30 keys, ~4KB) and rarely changes. We load
//   once on first call, share the promise across concurrent callers,
//   and refresh on `window` focus after a 10-min staleness window. No
//   react-query dependency — the cache is a module-level singleton.
//
// FAILURE MODE
//   If the endpoint is unreachable (backend down, first-paint race,
//   user offline), the hook returns an "unknown" state. Callers should
//   render rows as `coming_soon` by default in that branch — never
//   crash, never block the UI.

import { useEffect, useState } from "react";

const API_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8000";

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

export type FeatureStatus = "active" | "coming_soon" | "hidden";

/** Stable string keys — mirror `FEATURES` in `_features.py`. Adding a
 *  feature here without adding it backend (or vice versa) is a build-time
 *  contract violation: the hook returns `undefined` for unknown keys and
 *  the row falls through to its default coming-soon render. */
export type FeatureKey =
  | "upload_trial_balance"
  | "upload_financial_statement"
  | "upload_invoice"
  | "upload_inventory"
  | "import_history"
  | "data_quality"
  | "reprocess_latest"
  | "erp_connector"
  | "accounting_connector"
  | "public_registry_connector"
  | "ask_cfo_ai"
  | "ask_about_current_company"
  | "generate_action_list"
  | "generate_board_summary"
  | "generate_bank_memo"
  | "generate_90_day_plan"
  | "generate_public_report"
  | "simulate_cost_of_capital"
  | "simulate_debt_reduction"
  | "simulate_margin_improvement"
  | "change_password"
  | "two_factor_auth"
  | "manage_profile"
  | "manage_billing"
  | "workspace_switcher"
  | "user_invites"
  | "dashboard"
  | "benchmarks"
  | "industry_classification"
  | "reports"
  | "decisions"
  | "alerts"
  | "public_records"
  | "inventory"
  | "invoices"
  | "products_legacy";

export interface FeatureDefinition {
  status: FeatureStatus;
  label: string;
  description: string;
  endpoint?: string;
  required_plan?: string;
  required_data_depth?: string[];
}

export type FeatureRegistry = Partial<Record<FeatureKey, FeatureDefinition>>;

// ──────────────────────────────────────────────────────────────────────
// Module-level cache
// ──────────────────────────────────────────────────────────────────────

let cache: FeatureRegistry | null = null;
let inflight: Promise<FeatureRegistry> | null = null;
let lastLoadedAt = 0;
const STALE_MS = 10 * 60 * 1000; // 10 min

// Subscribers — every mounted `useFeatures*` hook registers a setter so
// a refresh fans out without a global event bus.
type Listener = (r: FeatureRegistry) => void;
const listeners = new Set<Listener>();

function publish(r: FeatureRegistry) {
  cache = r;
  lastLoadedAt = Date.now();
  for (const l of listeners) l(r);
}

async function loadOnce(force = false): Promise<FeatureRegistry> {
  if (!force && cache && Date.now() - lastLoadedAt < STALE_MS) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const r = await fetch(`${API_URL}/api/features/status`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = (await r.json()) as { features: FeatureRegistry };
      const next = body.features ?? {};
      publish(next);
      return next;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

// ──────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────

/** Read the entire registry. Triggers a fetch on first call. */
export function useFeatures(): {
  features: FeatureRegistry;
  /** True before the first fetch resolves. */
  loading: boolean;
  /** Force a refresh from the server. */
  refresh: () => Promise<void>;
} {
  const [features, setFeatures] = useState<FeatureRegistry>(cache ?? {});
  const [loading, setLoading] = useState<boolean>(cache === null);

  useEffect(() => {
    // `mounted` guard prevents post-unmount setState (vitest teardown
    // races with a still-pending fetch otherwise — see the "unhandled
    // rejection" trace in early Phase 9 runs).
    let mounted = true;
    const listener: Listener = (r) => {
      if (!mounted) return;
      setFeatures(r);
      setLoading(false);
    };
    listeners.add(listener);
    // Kick the load if the cache hasn't been populated yet.
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

  // Refresh on tab focus — cheap insurance against a long-sleeping tab
  // seeing a stale registry.
  useEffect(() => {
    function onFocus() {
      if (Date.now() - lastLoadedAt > STALE_MS) {
        void loadOnce(true).catch(() => { /* keep showing cache on failure */ });
      }
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  return {
    features,
    loading,
    refresh: async () => { await loadOnce(true); },
  };
}

/** Read the status of one feature. Returns `undefined` until first fetch
 *  resolves or for unknown keys (treat undefined as coming_soon in UI). */
export function useFeatureStatus(key: FeatureKey): FeatureStatus | undefined {
  const { features } = useFeatures();
  return features[key]?.status;
}

/** Read a full feature definition (status + label + description). */
export function useFeature(key: FeatureKey): FeatureDefinition | undefined {
  const { features } = useFeatures();
  return features[key];
}

/** Imperative sync read — useful in places that can't call hooks
 *  (event handlers, route guards). Returns the last-loaded value or
 *  `undefined` if the cache is cold. */
export function getFeatureStatus(key: FeatureKey): FeatureStatus | undefined {
  return cache?.[key]?.status;
}

/** Convenience: "should this row render at all?" — `hidden` and any
 *  unknown key returns false. */
export function shouldRenderFeature(
  status: FeatureStatus | undefined,
): boolean {
  return status === "active" || status === "coming_soon";
}

/** Convenience: "is this row clickable?" — coming_soon AND unknown
 *  both return false so we never wire onClick to a stub. */
export function isFeatureActive(
  status: FeatureStatus | undefined,
): boolean {
  return status === "active";
}

// ──────────────────────────────────────────────────────────────────────
// Test helper — bypasses the network for unit tests.
// ──────────────────────────────────────────────────────────────────────

/** Test-only: seed the module cache with a fixture and fan out to any
 *  mounted hooks. Removes the need to mock `fetch` in component tests. */
export function __setFeaturesForTest(r: FeatureRegistry): void {
  publish(r);
}

/** Test-only: clear the cache (companion to `__setFeaturesForTest`). */
export function __clearFeaturesForTest(): void {
  cache = null;
  inflight = null;
  lastLoadedAt = 0;
}
