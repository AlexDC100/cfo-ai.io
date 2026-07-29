// workspaces.ts — the workspace registry, as consumed by the UI.
//
// A workspace IS an organization; lib/org.ts owns the data (Supabase-backed,
// RPC-driven, RLS-isolated). This module is the presentation-shaped adapter
// over it, so pages work with a flat `Workspace` rather than an `Organization`
// plus membership role, and so the "last period this workspace was viewing"
// memory has a home.
//
// Everything that mutates is async now — a workspace is a real row, not a
// string in localStorage. Callers fire and forget; lib/org.ts refreshes the
// list and re-renders every subscriber.
//
// The remembered period stays DEVICE-LOCAL on purpose: it is "where I was
// looking on this machine", not a property of the company. (Milestone C moves
// genuinely company-level settings into org_prefs.)

import { useCallback, useMemo } from "react";

import { daysUntilPurge, useActiveOrg, type Organization } from "./org";
import { blockedByScan } from "./scanGuard";

export interface Workspace {
  id: string;
  name: string;
  createdAt: string;
  /** Last period (analysis) this workspace was viewing, if any. */
  periodId?: string | null;
  /** Set when soft-deleted; the workspace is in its recovery window. */
  archivedAt?: string | null;
  /** Whole days until permanent deletion. Only meaningful when archived. */
  daysLeft?: number;
  role?: Organization["role"];
  /** Org-profile industry (organizations.industry_key), if set. */
  industryKey?: string | null;
}

// ── Remembered period (device-local, keyed by workspace) ───────────────
const PERIOD_KEY = "cfoai:v1:workspace-periods";

function readPeriods(): Record<string, string | null> {
  try {
    const raw = localStorage.getItem(PERIOD_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, string | null>;
  } catch {
    return {};
  }
}

function writePeriods(map: Record<string, string | null>): void {
  try {
    localStorage.setItem(PERIOD_KEY, JSON.stringify(map));
  } catch {
    /* quota / private mode */
  }
}

/** Remember the period a workspace is viewing so switching can restore it. */
export function setWorkspacePeriod(id: string, periodId: string | null): void {
  const map = readPeriods();
  if (map[id] === periodId) return;
  map[id] = periodId;
  writePeriods(map);
}

export function getWorkspacePeriod(id: string): string | null {
  return readPeriods()[id] ?? null;
}

function toWorkspace(org: Organization, periods: Record<string, string | null>): Workspace {
  return {
    id: org.id,
    name: org.name,
    createdAt: org.created_at,
    periodId: periods[org.id] ?? null,
    archivedAt: org.archived_at,
    daysLeft: org.archived_at ? daysUntilPurge(org) : undefined,
    role: org.role,
    industryKey: org.industry_key,
  };
}

export interface WorkspacesApi {
  workspaces: Workspace[];
  /** Soft-deleted workspaces still inside their 30-day recovery window. */
  archived: Workspace[];
  currentId: string | null;
  current: Workspace | null;
  loading: boolean;
  /** False when this is the user's only workspace — archiving it is refused. */
  canDelete: boolean;
  create: (
    name: string,
    industry?: { key: string; label: string } | null,
  ) => Promise<string | null>;
  select: (id: string) => Promise<void>;
  rename: (id: string, name: string) => Promise<boolean>;
  /** Change a workspace's industry (key + display label). */
  setIndustry: (id: string, key: string, label: string) => Promise<boolean>;
  upsertCurrentName: (name: string) => Promise<void>;
  /** Soft-delete: recoverable for 30 days, then purged. */
  remove: (id: string) => Promise<boolean>;
  restore: (id: string) => Promise<boolean>;
  /** Permanent, immediate deletion of an archived workspace. Irreversible. */
  purge: (id: string) => Promise<boolean>;
  setPeriod: (id: string, periodId: string | null) => void;
}

export function useWorkspaces(): WorkspacesApi {
  const {
    org,
    orgs,
    archived,
    loading,
    createWorkspace,
    renameWorkspace,
    setWorkspaceIndustry,
    archiveWorkspace,
    restoreWorkspace,
    purgeWorkspace,
    switchOrg,
  } = useActiveOrg();

  // One localStorage read per list rebuild, so all three views agree on the
  // same snapshot of remembered periods.
  const { workspaces, archivedList, current } = useMemo(() => {
    const periods = readPeriods();
    return {
      workspaces: orgs.map((o) => toWorkspace(o, periods)),
      archivedList: archived.map((o) => toWorkspace(o, periods)),
      current: org ? toWorkspace(org, periods) : null,
    };
  }, [orgs, archived, org]);

  const upsertCurrentName = useCallback(
    async (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      if (org) await renameWorkspace(org.id, trimmed);
      else await createWorkspace(trimmed);
    },
    [org, renameWorkspace, createWorkspace],
  );

  const setPeriod = useCallback((id: string, periodId: string | null) => {
    setWorkspacePeriod(id, periodId);
  }, []);

  // Every workspace switcher in the app (TopHeader, the hub cards, the
  // sidebar) goes through this one `select`, so guarding here covers them
  // all: switchOrg clears the whole query cache, which would pull the rug
  // out from under a running scan.
  const select = useCallback(
    async (id: string) => {
      if (blockedByScan("workspace")) return;
      await switchOrg(id);
    },
    [switchOrg],
  );

  return {
    workspaces,
    archived: archivedList,
    currentId: org?.id ?? null,
    current,
    loading,
    // Deleting the LAST workspace is allowed (2026-07-25): it drops the user
    // into the same zero-workspace state a brand-new signup starts from (the
    // hub's empty state + Create flow), so there's nothing to protect against.
    canDelete: orgs.length >= 1,
    create: createWorkspace,
    select,
    rename: renameWorkspace,
    setIndustry: setWorkspaceIndustry,
    upsertCurrentName,
    remove: archiveWorkspace,
    restore: restoreWorkspace,
    purge: purgeWorkspace,
    setPeriod,
  };
}
