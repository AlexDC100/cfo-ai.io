// THE CAPSULE — the two identity keys this feature is scoped by.
//
//   userKey  the signed-in user. The ask budget hangs off this, because
//            the BUDGET hangs off this: billing is per user, not per
//            workspace (CLAUDE.md §16). Two workspaces open in two tabs
//            share one throttle, which is the correct behaviour.
//
//   orgKey   the active workspace. Recent questions hang off this: a
//            question about a RON manufacturer is noise in a EUR
//            property vehicle, the same reasoning that splits company
//            prefs from personal ones.
//
// Deliberately reads `lib/activeOrg` (the dependency-free, uid-scoped
// holder) rather than `useActiveOrg()` — the palette mounts on every ⌘K
// and must not trigger a workspace-list fetch to decide which cache key
// to use. uid-scoping also means a second user on the same browser MISSES
// rather than inheriting the previous user's recents.

import { useSyncExternalStore } from "react";

import { useAuth } from "@/lib/auth";
import { getActiveOrgId, subscribeActiveOrg } from "@/lib/activeOrg";

export interface CapsuleKeys {
  userKey: string | null;
  orgKey: string | null;
}

export function useCapsuleKeys(): CapsuleKeys {
  const { user } = useAuth();
  const userKey = user?.id ?? null;
  const orgKey = useSyncExternalStore(
    subscribeActiveOrg,
    () => getActiveOrgId(userKey),
    () => null,
  );
  return { userKey, orgKey };
}
