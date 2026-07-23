// activeOrg.ts — which workspace (organization) the user currently has open.
//
// Deliberately dependency-free. Both `lib/supabase.ts` (which resolves the
// org for every data read) and `lib/org.ts` (which owns the workspace list and
// the switcher) need this value, and importing one from the other would create
// a cycle. This module is the shared floor underneath both.
//
// ── uid-scoping ────────────────────────────────────────────────────────
// The persisted value carries the user id it belongs to, and every read
// requires the caller to say who is asking. A different user on the same
// browser therefore MISSES rather than inheriting the previous user's
// workspace — which would be a cross-tenant data leak, not just a cosmetic
// bug. Same self-correcting shape as `lib/dataPresence.ts`.
//
// localStorage is a cache for instant first paint; the durable record is
// `user_prefs.active_org_id` in Supabase, written by lib/org.ts so the active
// workspace follows the user to another device.

const KEY = "cfoai.active_org";

interface Stored {
  uid: string;
  orgId: string;
}

// In-memory mirror — the fast path, and the only one that works in private
// mode where localStorage throws.
let current: Stored | null = readPersisted();

function readPersisted(): Stored | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      !parsed ||
      typeof (parsed as Stored).uid !== "string" ||
      typeof (parsed as Stored).orgId !== "string"
    ) {
      return null;
    }
    return parsed as Stored;
  } catch {
    return null;
  }
}

function writePersisted(value: Stored | null): void {
  try {
    if (value) localStorage.setItem(KEY, JSON.stringify(value));
    else localStorage.removeItem(KEY);
  } catch {
    /* quota / private mode — the in-memory mirror still works this session */
  }
}

/**
 * The active workspace id for `uid`, or null when unknown (cold start, or the
 * stored value belongs to a different user). Callers treat null as "resolve it
 * from memberships and then remember the answer".
 */
export function getActiveOrgId(uid: string | null | undefined): string | null {
  if (!uid) return null;
  if (!current || current.uid !== uid) return null;
  return current.orgId;
}

export function setActiveOrgId(uid: string, orgId: string | null): void {
  const next = orgId ? { uid, orgId } : null;
  if (current?.uid === next?.uid && current?.orgId === next?.orgId) return;
  current = next;
  writePersisted(next);
  emit();
}

/** Wipe on sign-out / user switch so nothing survives into the next session. */
export function clearActiveOrg(): void {
  if (current === null) return;
  current = null;
  writePersisted(null);
  emit();
}

// ── Pub/sub ────────────────────────────────────────────────────────────
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((l) => l());
}

export function subscribeActiveOrg(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
