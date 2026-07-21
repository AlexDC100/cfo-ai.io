// workspaces.ts — client-side multi-workspace registry.
//
// The app historically had a SINGLE workspace: one name in localStorage
// (`workspaceName.ts`) plus whatever period was loaded via `?period=<id>`.
// This store generalises that to a LIST of workspaces the user can create
// and switch between, while keeping backward-compat:
//
//   · On first load it migrates the legacy single `workspaceName` into a
//     first workspace entry so existing users don't lose their name.
//   · Selecting/creating a workspace mirrors its name back into
//     `workspaceName` so the TopHeader tagline + sidebar identity (which
//     read `useWorkspaceName`) follow the active workspace with no change.
//
// Each workspace optionally remembers the last `periodId` it was viewing so
// switching can navigate straight back to that analysis.
//
// Reactive via useSyncExternalStore — every surface using `useWorkspaces()`
// re-renders on create / select / rename / remove (this tab immediately,
// other tabs via the native `storage` event).

import { useCallback, useSyncExternalStore } from "react";

import { readWorkspaceName, writeWorkspaceName } from "./workspaceName";

export interface Workspace {
  id: string;
  name: string;
  createdAt: string;
  /** Last period (analysis) this workspace was viewing, if any. */
  periodId?: string | null;
}

interface Snapshot {
  workspaces: Workspace[];
  currentId: string | null;
}

const LIST_KEY = "cfoai:v1:workspaces";
const CURRENT_KEY = "cfoai:v1:workspace-current";

function newId(): string {
  return `ws_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function parseList(): Workspace[] {
  try {
    const raw = localStorage.getItem(LIST_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (w): w is Workspace =>
        !!w && typeof (w as Workspace).id === "string" && typeof (w as Workspace).name === "string",
    );
  } catch {
    return [];
  }
}

function readCurrentId(): string | null {
  try {
    return localStorage.getItem(CURRENT_KEY);
  } catch {
    return null;
  }
}

// ── Cached snapshot ────────────────────────────────────────────────────
// useSyncExternalStore requires a STABLE reference between renders — parsing
// localStorage on every getSnapshot() would return a fresh array each time
// and loop forever. So we cache and only recompute on a mutation or a
// cross-tab storage event.
let cache: Snapshot = initialLoad();

function initialLoad(): Snapshot {
  const workspaces = parseList();
  let currentId = readCurrentId();

  // Migrate the legacy single-name workspace into a first entry.
  if (workspaces.length === 0) {
    const legacy = readWorkspaceName();
    if (legacy) {
      const ws: Workspace = { id: newId(), name: legacy, createdAt: new Date().toISOString() };
      workspaces.push(ws);
      currentId = ws.id;
      writeThrough(workspaces, currentId, /* syncName */ false);
    }
  }

  if (!currentId || !workspaces.some((w) => w.id === currentId)) {
    currentId = workspaces[0]?.id ?? null;
  }
  return { workspaces, currentId };
}

function writeThrough(workspaces: Workspace[], currentId: string | null, syncName = true): void {
  try {
    localStorage.setItem(LIST_KEY, JSON.stringify(workspaces));
  } catch {
    /* quota / private mode */
  }
  try {
    if (currentId) localStorage.setItem(CURRENT_KEY, currentId);
    else localStorage.removeItem(CURRENT_KEY);
  } catch {
    /* quota / private mode */
  }
  cache = { workspaces, currentId };
  // Mirror the active workspace name into the legacy store so the TopHeader
  // tagline + sidebar identity follow the switch.
  if (syncName) {
    const cur = workspaces.find((w) => w.id === currentId);
    writeWorkspaceName(cur?.name ?? "");
  }
}

// ── Pub/sub ────────────────────────────────────────────────────────────
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === LIST_KEY || e.key === CURRENT_KEY) {
      cache = initialLoad();
      cb();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

function getSnapshot(): Snapshot {
  return cache;
}

const SERVER_SNAPSHOT: Snapshot = { workspaces: [], currentId: null };
function getServerSnapshot(): Snapshot {
  return SERVER_SNAPSHOT;
}

// ── Mutations ──────────────────────────────────────────────────────────
export function createWorkspace(name: string): Workspace {
  const ws: Workspace = { id: newId(), name: name.trim(), createdAt: new Date().toISOString() };
  writeThrough([...cache.workspaces, ws], ws.id);
  emit();
  return ws;
}

export function selectWorkspace(id: string): void {
  if (!cache.workspaces.some((w) => w.id === id)) return;
  writeThrough(cache.workspaces, id);
  emit();
}

export function renameWorkspace(id: string, name: string): void {
  const workspaces = cache.workspaces.map((w) => (w.id === id ? { ...w, name: name.trim() } : w));
  writeThrough(workspaces, cache.currentId);
  emit();
}

/** Rename the current workspace, or create one if none exists yet. Used to
 *  reconcile the name typed in onboarding into the workspace list. */
export function upsertCurrentWorkspaceName(name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  if (cache.currentId && cache.workspaces.some((w) => w.id === cache.currentId)) {
    renameWorkspace(cache.currentId, trimmed);
  } else {
    createWorkspace(trimmed);
  }
}

export function removeWorkspace(id: string): void {
  const workspaces = cache.workspaces.filter((w) => w.id !== id);
  const currentId = cache.currentId === id ? (workspaces[0]?.id ?? null) : cache.currentId;
  writeThrough(workspaces, currentId);
  emit();
}

/** Remember the period a workspace is viewing so switching can restore it. */
export function setWorkspacePeriod(id: string, periodId: string | null): void {
  const target = cache.workspaces.find((w) => w.id === id);
  if (!target || target.periodId === periodId) return;
  const workspaces = cache.workspaces.map((w) => (w.id === id ? { ...w, periodId } : w));
  writeThrough(workspaces, cache.currentId, /* syncName */ false);
  emit();
}

// ── Hook ───────────────────────────────────────────────────────────────
export interface WorkspacesApi {
  workspaces: Workspace[];
  currentId: string | null;
  current: Workspace | null;
  create: (name: string) => Workspace;
  select: (id: string) => void;
  rename: (id: string, name: string) => void;
  upsertCurrentName: (name: string) => void;
  remove: (id: string) => void;
  setPeriod: (id: string, periodId: string | null) => void;
}

export function useWorkspaces(): WorkspacesApi {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const create = useCallback((name: string) => createWorkspace(name), []);
  const select = useCallback((id: string) => selectWorkspace(id), []);
  const rename = useCallback((id: string, name: string) => renameWorkspace(id, name), []);
  const upsertCurrentName = useCallback((name: string) => upsertCurrentWorkspaceName(name), []);
  const remove = useCallback((id: string) => removeWorkspace(id), []);
  const setPeriod = useCallback((id: string, periodId: string | null) => setWorkspacePeriod(id, periodId), []);

  return {
    workspaces: snap.workspaces,
    currentId: snap.currentId,
    current: snap.workspaces.find((w) => w.id === snap.currentId) ?? null,
    create,
    select,
    rename,
    upsertCurrentName,
    remove,
    setPeriod,
  };
}
