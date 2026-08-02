// Workspace (organization) registry + switcher.
//
// A workspace IS an organization. One row per company (SRL), and because every
// org-scoped table already enforces `is_member_of(org_id)` RLS, holding more
// than one membership is what makes workspaces a real data-isolation boundary
// — documents, periods, metrics, alerts and chats all re-scope on a switch.
//
// Reads go through the `list_workspaces()` RPC and writes through
// `create_workspace()` / `archive_workspace()` / `restore_workspace()`
// (supabase/schema_phase_multi_workspace.sql). RPCs rather than plain inserts
// because there is deliberately no client INSERT policy on `organizations` or
// `memberships` — see the 42P17 recursion warning at schema_phase3.sql:193.
//
// Deleting a workspace is a SOFT delete: it is hidden, recoverable for 30
// days, then purged permanently by the scheduler.
//
// The active workspace lives in lib/activeOrg.ts (uid-scoped localStorage, for
// instant first paint) and is mirrored to `user_prefs.active_org_id` so it
// follows the user to another device.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getSupabase, supabaseEnabled } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import { clearActiveOrg, getActiveOrgId, setActiveOrgId } from "@/lib/activeOrg";
import { clearDataPresence } from "@/lib/dataPresence";
import { clearWorkspaceScopedData } from "@/lib/clearWorkspaceData";
import { queryClient } from "@/lib/queryClient";
import { writeWorkspaceName } from "@/lib/workspaceName";
import { hydrateOrgPrefs, hydrateUserPrefs, resetPrefs } from "@/lib/prefs";

export interface Organization {
  id: string;
  name: string;
  industry_key: string | null;
  industry_display_name: string | null;
  default_currency: string | null;
  role: "owner" | "admin" | "member";
  /** Set when the workspace is soft-deleted; null for live workspaces. */
  archived_at: string | null;
  /** When an archived workspace is permanently deleted. */
  purge_after: string | null;
  created_at: string;
}

// In-memory cache so non-React callers can read the active org synchronously
// after the first resolution.
let cachedOrg: Organization | null = null;
let cachedOrgListPromise: Promise<OrgListResult> | null = null;

// Cross-instance change bus. Every useActiveOrg() instance owns private
// useState copies of the list, so a mutation in one component must poke the
// others or they render stale data until a page reload.
const orgListeners = new Set<() => void>();
function emitOrgChange(): void {
  orgListeners.forEach((l) => l());
}

/**
 * Drop every module-global. Called on sign-out and on a user switch —
 * without this the memoised list promise below outlives the session and the
 * next user on this browser reads the previous user's workspaces.
 */
export function resetOrgCache(): void {
  cachedOrg = null;
  cachedOrgListPromise = null;
  clearActiveOrg();
  resetPrefs();
}

// Reset on sign-out / user switch. Owned here rather than in lib/auth.tsx
// because this module already imports useAuth — reaching back the other way
// would be an import cycle. Mirrors the narrow prior-vs-next identity check
// at auth.tsx:176 so a token refresh doesn't needlessly dump the cache.
{
  const supabase = getSupabase();
  if (supabase) {
    let priorUserId: string | null = null;
    supabase.auth.onAuthStateChange((event, session) => {
      const nextUserId = session?.user?.id ?? null;
      if ((priorUserId !== null && priorUserId !== nextUserId) || event === "SIGNED_OUT") {
        resetOrgCache();
      }
      priorUserId = nextUserId;
    });
  }
}

/** Result of a workspace-list fetch. `error: true` means the RPC (or the
 *  session read) FAILED — which must never be treated as "the user has zero
 *  workspaces": that mistake showed the create wizard to users who already
 *  had a workspace (inviting duplicates) and could trigger a bogus
 *  auto-create. Empty-with-no-error is the only true zero state. */
interface OrgListResult {
  orgs: Organization[];
  error: boolean;
}

/** Every workspace the signed-in user belongs to, archived ones included. */
async function fetchOrgsForUser(): Promise<OrgListResult> {
  const supabase = getSupabase();
  if (!supabase) return { orgs: [], error: false };
  const { data: session } = await supabase.auth.getSession();
  if (!session.session?.user) return { orgs: [], error: false };

  const { data, error } = await supabase.rpc("list_workspaces");
  if (error) {
    console.warn("[org] list_workspaces failed:", error.message);
    return { orgs: [], error: true };
  }
  return { orgs: (data ?? []) as Organization[], error: false };
}

/**
 * Pure decision: auto-create a default workspace ONLY on a true zero — the
 * list fetch succeeded and returned nothing at all (no live, no archived).
 * A fetch ERROR is a retry state (the user may have workspaces); archived-
 * only is a deliberate deletion (AuthGuard routes it to /workspace instead).
 * Exported for unit tests.
 */
export function shouldEnsureDefaultWorkspace(listError: boolean, orgCount: number): boolean {
  return !listError && orgCount === 0;
}

/**
 * Ensure-default: a signed-in user with ZERO workspaces (none live, none
 * archived — the trigger-failed / pre-phase3 / purged-everything case) gets
 * one created silently so the app never dead-ends. Named from the signup
 * company name when available, else "My workspace". Runs at most once per
 * user per page load (the ref below) and never on a failed list fetch.
 *
 * Deliberately NOT invoked when archived workspaces exist: that user chose
 * deletion, and /workspace offers Restore — auto-creating there would race
 * their intent. AuthGuard routes that state to /workspace instead.
 */
const ensuredDefaultFor = new Set<string>();
async function ensureDefaultWorkspace(userId: string): Promise<boolean> {
  if (ensuredDefaultFor.has(userId)) return false;
  ensuredDefaultFor.add(userId);
  const supabase = getSupabase();
  if (!supabase) return false;
  const { data: session } = await supabase.auth.getSession();
  const meta = (session.session?.user?.user_metadata ?? {}) as Record<string, unknown>;
  const company =
    typeof meta.company_name === "string" && meta.company_name.trim()
      ? meta.company_name.trim()
      : null;
  const name = company ? `${company}` : "My workspace";
  const id = await createWorkspaceOrg(name, null, null);
  if (id) {
    console.info("[org] auto-created default workspace:", name);
    setActiveOrgId(userId, id);
    void writeRemoteActiveOrgId(userId, id);
  }
  return !!id;
}

/** Live (non-archived) workspaces — what the switcher shows. */
export function activeWorkspaces(orgs: Organization[]): Organization[] {
  return orgs.filter((o) => !o.archived_at);
}

/** Soft-deleted workspaces still inside their 30-day recovery window. */
export function archivedWorkspaces(orgs: Organization[]): Organization[] {
  return orgs.filter((o) => !!o.archived_at);
}

/** Whole days left before an archived workspace is purged; 0 once due. */
export function daysUntilPurge(org: Organization): number {
  if (!org.purge_after) return 0;
  const ms = new Date(org.purge_after).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

/**
 * Synchronous read of the cached active org. Returns null until the first
 * async resolution lands. Non-React code calls this; React code should use
 * useActiveOrg() so it re-renders on change.
 */
export function getCachedActiveOrg(): Organization | null {
  return cachedOrg;
}

// ── user_prefs.active_org_id — the cross-device record ──────────────────

async function readRemoteActiveOrgId(userId: string): Promise<string | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("user_prefs")
    .select("active_org_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    // Migration not applied yet / PostgREST cache stale — fall back to the
    // device-local value rather than breaking the app.
    console.warn("[org] read user_prefs failed:", error.message);
    return null;
  }
  return (data?.active_org_id as string | null) ?? null;
}

async function writeRemoteActiveOrgId(userId: string, orgId: string): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;
  const { error } = await supabase
    .from("user_prefs")
    .upsert({ user_id: userId, active_org_id: orgId }, { onConflict: "user_id" });
  if (error) console.warn("[org] write user_prefs failed:", error.message);
}

/**
 * Pick the workspace to open: the device-local choice wins (it's what the user
 * last touched *here*), then the cross-device preference, then the oldest live
 * workspace. Archived workspaces are never auto-selected.
 */
async function resolveActive(
  userId: string,
  orgs: Organization[],
  opts: { listTrusted?: boolean } = {},
): Promise<Organization | null> {
  const live = activeWorkspaces(orgs);
  const local = getActiveOrgId(userId);
  let chosen = live.find((o) => o.id === local) ?? null;

  if (!chosen) {
    const remote = await readRemoteActiveOrgId(userId);
    chosen = live.find((o) => o.id === remote) ?? null;
  }
  if (!chosen) chosen = live[0] ?? null;

  if (chosen) {
    setActiveOrgId(userId, chosen.id);
    // Keep the header/sidebar first-paint cache in step with the real name.
    writeWorkspaceName(chosen.name);
    if (chosen.id !== local) void writeRemoteActiveOrgId(userId, chosen.id);
  } else if (local && opts.listTrusted) {
    // Nothing live matches the remembered id (it was archived or purged) —
    // clear it so downstream synchronous readers (currentOrgId, cfoApi's
    // X-Org-Id) stop targeting a workspace that no longer accepts data.
    // ONLY when the list actually loaded (listTrusted): a transient RPC
    // failure also yields an empty list, and wiping the remembered id on a
    // network blip would lose the user's choice for nothing.
    clearActiveOrg();
  }
  return chosen;
}

/**
 * Force a refresh of the active org. Called from /onboarding after the user
 * picks an industry — the next render needs to see the updated value.
 */
export async function refreshActiveOrg(): Promise<Organization | null> {
  cachedOrgListPromise = null;
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data: session } = await supabase.auth.getSession();
  const userId = session.session?.user?.id;
  if (!userId) return null;

  const { orgs, error } = await fetchOrgsForUser();
  cachedOrg = await resolveActive(userId, orgs, { listTrusted: !error });
  // Non-hook entry point (/onboarding uses it) — mounted hook instances
  // still need to hear about the change.
  emitOrgChange();
  return cachedOrg;
}

/** Update the active org's name / industry. */
export async function updateActiveOrg(patch: {
  name?: string;
  industry_key?: string;
  industry_display_name?: string;
}): Promise<boolean> {
  const supabase = getSupabase();
  const org = cachedOrg;
  if (!supabase || !org) return false;
  const { error } = await supabase.from("organizations").update(patch).eq("id", org.id);
  if (error) {
    console.warn("[org] updateActiveOrg failed:", error.message);
    return false;
  }
  await refreshActiveOrg();
  return true;
}

/** Rename any workspace the user owns (not only the active one). */
export async function renameWorkspaceOrg(orgId: string, name: string): Promise<boolean> {
  const supabase = getSupabase();
  const trimmed = name.trim();
  if (!supabase || !trimmed) return false;
  const { error } = await supabase.from("organizations").update({ name: trimmed }).eq("id", orgId);
  if (error) {
    console.warn("[org] rename failed:", error.message);
    return false;
  }
  return true;
}

/** Change the industry of any workspace the user owns (by id, not only the
 *  active one) — same members-can-UPDATE-organizations policy rename relies on.
 *  Writes both the key (drives benchmarks) and the display label together. */
export async function updateWorkspaceIndustryOrg(
  orgId: string,
  industryKey: string,
  industryDisplay: string,
): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase || !industryKey) return false;
  const { error } = await supabase
    .from("organizations")
    .update({ industry_key: industryKey, industry_display_name: industryDisplay })
    .eq("id", orgId);
  if (error) {
    console.warn("[org] update industry failed:", error.message);
    return false;
  }
  return true;
}

// ── Mutations via RPC ──────────────────────────────────────────────────

export async function createWorkspaceOrg(
  name: string,
  industryKey?: string | null,
  industryDisplay?: string | null,
): Promise<string | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data, error } = await supabase.rpc("create_workspace", {
    p_name: name.trim(),
    p_industry_key: industryKey ?? null,
    p_industry_display: industryDisplay ?? null,
  });
  if (error) {
    console.warn("[org] create_workspace failed:", error.message);
    return null;
  }
  return (data as string) ?? null;
}

/** Soft-delete. Returns the purge date, or null when the RPC refused. */
export async function archiveWorkspaceOrg(orgId: string): Promise<string | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data, error } = await supabase.rpc("archive_workspace", { p_org_id: orgId });
  if (error) {
    console.warn("[org] archive_workspace failed:", error.message);
    return null;
  }
  return (data as string) ?? null;
}

export async function restoreWorkspaceOrg(orgId: string): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;
  const { error } = await supabase.rpc("restore_workspace", { p_org_id: orgId });
  if (error) {
    console.warn("[org] restore_workspace failed:", error.message);
    return false;
  }
  return true;
}

/** Permanent, immediate deletion of an ARCHIVED workspace. The RPC enforces
 *  owner + archived; the UI enforces the type-the-name confirmation. */
export async function purgeWorkspaceOrg(orgId: string): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;
  const { error } = await supabase.rpc("purge_workspace", { p_org_id: orgId });
  if (error) {
    console.warn("[org] purge_workspace failed:", error.message);
    return false;
  }
  return true;
}

export interface ActiveOrgState {
  org: Organization | null;
  /** Live workspaces only — what the switcher lists. */
  orgs: Organization[];
  /** Soft-deleted workspaces inside the 30-day window. */
  archived: Organization[];
  loading: boolean;
  /** True when the workspace list could not be LOADED (RPC/network failure).
   *  Render "Could not load your workspace. Retry." — never the create
   *  wizard, which would invite duplicate workspaces. */
  loadError: boolean;
  /** True when the user is signed in but their active org has no industry_key. */
  needsOnboarding: boolean;
  refresh: () => Promise<void>;
  switchOrg: (orgId: string) => Promise<void>;
  createWorkspace: (
    name: string,
    industry?: { key: string; label: string } | null,
  ) => Promise<string | null>;
  renameWorkspace: (orgId: string, name: string) => Promise<boolean>;
  /** Change a workspace's industry (key + display label). */
  setWorkspaceIndustry: (orgId: string, key: string, label: string) => Promise<boolean>;
  archiveWorkspace: (orgId: string) => Promise<boolean>;
  restoreWorkspace: (orgId: string) => Promise<boolean>;
  /** Permanent deletion of an archived workspace — no recovery after this. */
  purgeWorkspace: (orgId: string) => Promise<boolean>;
}

/**
 * Read + manage the workspaces for the signed-in user. The returned object is
 * stable across re-renders so it can safely be used in dependency arrays.
 */
export function useActiveOrg(): ActiveOrgState {
  const { status, user } = useAuth();
  const userId = user?.id ?? null;
  const [all, setAll] = useState<Organization[]>([]);
  const [activeId, setActiveId] = useState<string | null>(() => getActiveOrgId(userId));
  const [loading, setLoading] = useState<boolean>(supabaseEnabled && status !== "signed_out");
  // True when the last list_workspaces fetch FAILED. Consumers must render a
  // retry state — never the "create your first workspace" wizard, and never
  // trigger ensure-default — because the user may well have workspaces.
  const [loadError, setLoadError] = useState(false);
  // Bumped by emitOrgChange() from any other hook instance. Every
  // useActiveOrg() call holds its OWN copy of the list — without this, the
  // instance that creates/renames/archives a workspace refreshes itself while
  // every other mounted instance keeps its stale list until a full page
  // reload. (That was the "new workspace only appears after F5" bug.)
  const [version, setVersion] = useState(0);
  // Only the FIRST resolution flips `loading` — AuthGuard renders a blank
  // full-screen while loading is true, and cross-instance reloads must not
  // flash the whole app blank every time a workspace is touched.
  const firstLoadRef = useRef(true);

  useEffect(() => {
    const cb = () => setVersion((v) => v + 1);
    orgListeners.add(cb);
    return () => {
      orgListeners.delete(cb);
    };
  }, []);

  const load = useCallback(async () => {
    if (!supabaseEnabled || status !== "signed_in" || !userId) {
      setAll([]);
      setLoading(false);
      setLoadError(false);
      cachedOrg = null;
      resetPrefs();
      return;
    }
    if (firstLoadRef.current) setLoading(true);
    if (!cachedOrgListPromise) cachedOrgListPromise = fetchOrgsForUser();
    let { orgs: list, error: listError } = await cachedOrgListPromise;

    // Ensure-default: a TRUE zero (no live, no archived, and the fetch
    // succeeded) means this account has no workspace at all — the signup
    // trigger failed, a pre-multi-workspace account was never backfilled, or
    // everything was purged. Create one silently and re-fetch so the user
    // lands in a working app instead of a dead upload hero. Never runs on a
    // fetch ERROR (that's a retry state, not a zero state).
    if (shouldEnsureDefaultWorkspace(listError, list.length)) {
      const created = await ensureDefaultWorkspace(userId);
      if (created) {
        cachedOrgListPromise = fetchOrgsForUser();
        ({ orgs: list, error: listError } = await cachedOrgListPromise);
      }
    }

    setAll(list);
    setLoadError(listError);
    const chosen = await resolveActive(userId, list, { listTrusted: !listError });
    setActiveId(chosen?.id ?? null);
    cachedOrg = chosen;
    firstLoadRef.current = false;
    setLoading(false);
    // Preferences are hydrated from here because this is the one place that
    // knows BOTH the identity and the active workspace, and re-runs whenever
    // either changes. Fire-and-forget: stores paint from localStorage first
    // and adopt a remote value only if another device set a different one.
    void hydrateUserPrefs();
    void hydrateOrgPrefs(chosen?.id ?? null);
  }, [status, userId]);

  useEffect(() => {
    void load();
    // `version` re-runs the (unchanged) callback when a sibling instance
    // mutated the list; the shared cachedOrgListPromise makes the N reloads
    // one fetch.
  }, [load, version]);

  const refresh = useCallback(async () => {
    cachedOrgListPromise = null;
    await load();
    // Tell every OTHER mounted instance the list changed.
    emitOrgChange();
  }, [load]);

  // Switching workspace changes which tenant's data is correct, so every
  // cached answer from the previous one has to go. Same treatment the auth
  // layer gives a user switch (lib/auth.tsx:176-187).
  const switchOrg = useCallback(
    async (orgId: string) => {
      if (!userId) return;
      const next = all.find((o) => o.id === orgId && !o.archived_at);
      if (!next || orgId === activeId) return;

      setActiveOrgId(userId, orgId);
      cachedOrg = next;
      setActiveId(orgId);
      writeWorkspaceName(next.name);
      queryClient.clear();
      clearDataPresence();
      // Device-local, non-org-keyed caches (SKU run, budget dataset, benchmark
      // peers) would otherwise bleed the previous workspace's data into the
      // Products / Variance / Benchmark tabs — wipe them so every tab reflects
      // the selected workspace.
      clearWorkspaceScopedData();
      // Company-level settings (currency, decision rules, scenario levers)
      // belong to the workspace, so they have to follow the switch.
      void hydrateOrgPrefs(orgId);
      await writeRemoteActiveOrgId(userId, orgId);
      // Other mounted instances re-resolve so their `org` follows the switch.
      emitOrgChange();
    },
    [all, activeId, userId],
  );

  const createWorkspace = useCallback(
    async (name: string, industry?: { key: string; label: string } | null) => {
      const id = await createWorkspaceOrg(name, industry?.key ?? null, industry?.label ?? null);
      if (!id || !userId) return id;
      // Land the user inside the workspace they just made.
      setActiveOrgId(userId, id);
      queryClient.clear();
      clearDataPresence();
      clearWorkspaceScopedData();
      await writeRemoteActiveOrgId(userId, id);
      await refresh();
      return id;
    },
    [refresh, userId],
  );

  const renameWorkspace = useCallback(
    async (orgId: string, name: string) => {
      const ok = await renameWorkspaceOrg(orgId, name);
      if (ok) await refresh();
      return ok;
    },
    [refresh],
  );

  const setWorkspaceIndustry = useCallback(
    async (orgId: string, key: string, label: string) => {
      const ok = await updateWorkspaceIndustryOrg(orgId, key, label);
      if (ok) await refresh();
      return ok;
    },
    [refresh],
  );

  const archiveWorkspace = useCallback(
    async (orgId: string) => {
      const wasActive = orgId === activeId;
      // Optimistic UI (2026-07-25): flip the workspace to archived locally and,
      // if it was the open one, fall through to another live workspace RIGHT
      // NOW — before the RPC + re-fetch round-trips land — so the tab reflects
      // the delete instantly. refresh() at the end reconciles with the server's
      // real archived_at / purge_after (and rolls back if the RPC failed).
      const nowIso = new Date().toISOString();
      const purgeIso = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      const nextLive = wasActive
        ? activeWorkspaces(all).find((o) => o.id !== orgId) ?? null
        : null;
      setAll((prev) =>
        prev.map((o) =>
          o.id === orgId
            ? { ...o, archived_at: o.archived_at ?? nowIso, purge_after: o.purge_after ?? purgeIso }
            : o,
        ),
      );
      if (wasActive) {
        setActiveId(nextLive?.id ?? null);
        cachedOrg = nextLive;
        if (userId) {
          if (nextLive) setActiveOrgId(userId, nextLive.id);
          else clearActiveOrg();
        }
        queryClient.clear();
        clearDataPresence();
        clearWorkspaceScopedData();
      }

      const purgeAfter = await archiveWorkspaceOrg(orgId);
      // Whether it succeeded or failed, refresh() re-fetches the truth: on
      // success it confirms the archive (real purge_after); on failure it
      // undoes the optimistic flip.
      await refresh();
      return !!purgeAfter;
    },
    [activeId, all, userId, refresh],
  );

  const restoreWorkspace = useCallback(
    async (orgId: string) => {
      const ok = await restoreWorkspaceOrg(orgId);
      if (ok) await refresh();
      return ok;
    },
    [refresh],
  );

  const purgeWorkspace = useCallback(
    async (orgId: string) => {
      const ok = await purgeWorkspaceOrg(orgId);
      if (ok) await refresh();
      return ok;
    },
    [refresh],
  );

  const org = useMemo(() => all.find((o) => o.id === activeId) ?? null, [all, activeId]);
  const orgs = useMemo(() => activeWorkspaces(all), [all]);
  const archived = useMemo(() => archivedWorkspaces(all), [all]);
  const needsOnboarding = !!org && !org.industry_key;

  return useMemo(
    () => ({
      org,
      orgs,
      archived,
      loading,
      loadError,
      needsOnboarding,
      refresh,
      switchOrg,
      createWorkspace,
      renameWorkspace,
      setWorkspaceIndustry,
      archiveWorkspace,
      restoreWorkspace,
      purgeWorkspace,
    }),
    [
      org,
      orgs,
      archived,
      loading,
      loadError,
      needsOnboarding,
      refresh,
      switchOrg,
      createWorkspace,
      renameWorkspace,
      setWorkspaceIndustry,
      archiveWorkspace,
      restoreWorkspace,
      purgeWorkspace,
    ],
  );
}
