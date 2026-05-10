// Active organization resolution.
//
// Phase 3 introduced multi-tenancy: a user can be a member of multiple
// orgs. For now (single-org-per-user), this hook returns the user's first
// (and only) membership. The contract is forward-compatible — when a real
// org-switcher lands, only this module needs to change.
//
// All RLS-scoped data reads (documents, financial_periods, calculated_metrics,
// briefings, alerts, recommendations, invoices) are tagged with the active
// org_id rather than auth.uid(). The bootstrap trigger guarantees every
// auth.users row has at least one membership; this hook surfaces it.

import { useCallback, useEffect, useMemo, useState } from "react";
import { getSupabase, supabaseEnabled } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";

export interface Organization {
  id: string;
  name: string;
  industry_key: string | null;
  industry_display_name: string | null;
  default_currency: string | null;
  role: "owner" | "admin" | "member";
}

const ACTIVE_ORG_KEY = "cfoai.active_org_id";

// In-memory cache so non-React callers (e.g. supabase.ts helpers) can read
// the active org synchronously after the first useActiveOrg() resolves.
let cachedOrg: Organization | null = null;
let cachedOrgListPromise: Promise<Organization[]> | null = null;

function readPersistedActiveId(): string | null {
  try { return localStorage.getItem(ACTIVE_ORG_KEY); } catch { return null; }
}

function writePersistedActiveId(id: string): void {
  try { localStorage.setItem(ACTIVE_ORG_KEY, id); } catch { /* quota */ }
}

/**
 * Fetch every org the signed-in user is a member of. Returns [] when
 * Supabase isn't configured or the user isn't signed in.
 */
async function fetchOrgsForUser(): Promise<Organization[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data: session } = await supabase.auth.getSession();
  if (!session.session?.user) return [];

  const { data, error } = await supabase
    .from("memberships")
    .select("role, org_id, organizations!inner(id,name,industry_key,industry_display_name,default_currency)")
    .eq("user_id", session.session.user.id);
  if (error) {
    console.warn("[org] fetchOrgsForUser failed:", error.message);
    return [];
  }
  return (data ?? []).map((row) => {
    const org = (row as { organizations: { id: string; name: string; industry_key: string | null; industry_display_name: string | null; default_currency: string | null } }).organizations;
    return {
      id: org.id,
      name: org.name,
      industry_key: org.industry_key ?? null,
      industry_display_name: org.industry_display_name ?? null,
      default_currency: org.default_currency ?? null,
      role: (row as { role: Organization["role"] }).role,
    };
  });
}

/**
 * Synchronous read of the cached active org. Returns null until the first
 * async resolution lands. Non-React code (the supabase.ts helpers) calls
 * this; React code should use useActiveOrg() so it re-renders on change.
 */
export function getCachedActiveOrg(): Organization | null {
  return cachedOrg;
}

/**
 * Force a refresh of the active org. Called from /onboarding after the user
 * picks an industry — the next render needs to see the updated value.
 */
export async function refreshActiveOrg(): Promise<Organization | null> {
  cachedOrgListPromise = null;
  const orgs = await fetchOrgsForUser();
  const persistedId = readPersistedActiveId();
  const next = orgs.find((o) => o.id === persistedId) ?? orgs[0] ?? null;
  cachedOrg = next;
  if (next) writePersistedActiveId(next.id);
  return next;
}

/** Update the org name + industry. Used by the onboarding page. */
export async function updateActiveOrg(patch: { name?: string; industry_key?: string; industry_display_name?: string }): Promise<boolean> {
  const supabase = getSupabase();
  const org = cachedOrg;
  if (!supabase || !org) return false;
  const { error } = await supabase
    .from("organizations")
    .update(patch)
    .eq("id", org.id);
  if (error) {
    console.warn("[org] updateActiveOrg failed:", error.message);
    return false;
  }
  await refreshActiveOrg();
  return true;
}

export interface ActiveOrgState {
  org: Organization | null;
  orgs: Organization[];
  loading: boolean;
  /** True when the user is signed in but has no industry_key set on their active org. */
  needsOnboarding: boolean;
  refresh: () => Promise<void>;
  switchOrg: (orgId: string) => Promise<void>;
}

/**
 * Read the active organization for the signed-in user. The returned object
 * is stable across re-renders so it can safely be used in dependency arrays.
 */
export function useActiveOrg(): ActiveOrgState {
  const { status } = useAuth();
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [activeId, setActiveId] = useState<string | null>(readPersistedActiveId);
  const [loading, setLoading] = useState<boolean>(supabaseEnabled && status !== "signed_out");

  const load = useCallback(async () => {
    if (!supabaseEnabled || status !== "signed_in") {
      setOrgs([]);
      setLoading(false);
      cachedOrg = null;
      return;
    }
    setLoading(true);
    if (!cachedOrgListPromise) {
      cachedOrgListPromise = fetchOrgsForUser();
    }
    const list = await cachedOrgListPromise;
    setOrgs(list);
    const persisted = readPersistedActiveId();
    const chosen = list.find((o) => o.id === persisted) ?? list[0] ?? null;
    setActiveId(chosen?.id ?? null);
    cachedOrg = chosen;
    if (chosen) writePersistedActiveId(chosen.id);
    setLoading(false);
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  const switchOrg = useCallback(async (orgId: string) => {
    const next = orgs.find((o) => o.id === orgId);
    if (!next) return;
    setActiveId(orgId);
    cachedOrg = next;
    writePersistedActiveId(orgId);
  }, [orgs]);

  const refresh = useCallback(async () => {
    cachedOrgListPromise = null;
    await load();
  }, [load]);

  const org = useMemo(() => orgs.find((o) => o.id === activeId) ?? null, [orgs, activeId]);
  const needsOnboarding = !!org && !org.industry_key;

  return useMemo(() => ({
    org,
    orgs,
    loading,
    needsOnboarding,
    refresh,
    switchOrg,
  }), [org, orgs, loading, needsOnboarding, refresh, switchOrg]);
}
