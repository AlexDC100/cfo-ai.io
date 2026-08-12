// Persist the TanStack Query cache to localStorage so a reload (or a return
// visit within 24h) paints every page from cached data INSTANTLY instead of
// re-fetching everything from the engine + Supabase on a cold cache.
//
// How it composes with lib/queryClient.ts tuning:
//   · dehydrate() preserves each query's `dataUpdatedAt`, so the existing
//     staleTime (30min) still governs freshness after hydration — data newer
//     than 30min renders with zero refetch; older data renders immediately
//     and revalidates in the background when a component mounts it.
//   · queryClient.clear() (sign-out in auth.tsx, workspace switch in org.ts)
//     fires cache events that this module observes, so the persisted copy is
//     wiped right along with the in-memory one — no cross-workspace or
//     cross-user carry-over.
//
// Scoping: the payload is stamped with the signed-in user's id, read
// SYNCHRONOUSLY from Supabase's own localStorage session (`sb-*-auth-token`)
// because supabase-js session resolution is async and hydration must happen
// before first render. Anonymous visitors get nothing persisted (the public
// pages barely use the query cache), and a uid mismatch on boot drops the
// blob instead of hydrating another user's data.
//
// No new dependency: dehydrate/hydrate ship with @tanstack/react-query.

import { dehydrate, hydrate } from "@tanstack/react-query";
import { queryClient } from "./queryClient";

const STORAGE_KEY = "cfoai-query-cache-v1";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
// localStorage quota is ~5MB; leave headroom for chat history + prefs +
// the aicfo.* run caches that share the same origin.
const MAX_BYTES = 3_500_000;
const WRITE_DEBOUNCE_MS = 800;

interface PersistedBlob {
  at: number;
  uid: string;
  state: unknown;
}

/** Synchronous best-effort read of the signed-in user's id from the
 *  supabase-js persisted session. Returns null when signed out or when
 *  the session blob is unreadable. */
function currentUserId(): string | null {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !/^sb-.+-auth-token$/.test(key)) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as {
        user?: { id?: string };
        currentSession?: { user?: { id?: string } };
      };
      const id = parsed?.user?.id ?? parsed?.currentSession?.user?.id;
      if (typeof id === "string" && id) return id;
    }
  } catch {
    /* storage unavailable (private mode) or malformed blob — treat as signed out */
  }
  return null;
}

function writeNow(): void {
  const uid = currentUserId();
  try {
    if (!uid) {
      // Signed out (or never signed in): never keep a payload around.
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    const state = dehydrate(queryClient, {
      // Only settled successes. Pending queries hold live promises (not
      // serializable) and errors shouldn't replay on the next boot.
      shouldDehydrateQuery: (q) => q.state.status === "success",
    });
    const blob: PersistedBlob = { at: Date.now(), uid, state };
    const serialized = JSON.stringify(blob);
    if (serialized.length > MAX_BYTES) return; // too big — keep last good copy
    localStorage.setItem(STORAGE_KEY, serialized);
  } catch {
    // Quota exceeded or serialization failure — drop the persisted copy so a
    // partial/corrupt blob can never hydrate on the next boot.
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* storage fully unavailable — nothing to do */
    }
  }
}

/**
 * Hydrate the query cache from localStorage (synchronous, call BEFORE the
 * first render) and start mirroring cache changes back to storage.
 */
export function setupQueryPersistence(): void {
  // ── Restore ─────────────────────────────────────────────────────────
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const blob = JSON.parse(raw) as PersistedBlob;
      const uid = currentUserId();
      const fresh = blob?.at && Date.now() - blob.at < MAX_AGE_MS;
      if (fresh && uid && blob.uid === uid && blob.state) {
        hydrate(queryClient, blob.state);
        // Disk-hydrated data paints instantly but must NOT be trusted as
        // fresh: a reload is a new session, and anything that changed
        // server-side while the tab was closed (or via another device /
        // an operator repair) would otherwise stay invisible for the full
        // 30-min staleTime — a repaired period kept rendering its old
        // corrupt date through hard reloads (2026-08-12).
        //
        // Mere staleness is NOT enough here: queryClient.ts sets
        // `refetchOnMount: false` and `refetchOnWindowFocus: false`, so
        // nothing in this app ever acts on a stale flag — only an ACTIVE
        // refetch does. So: wait for the first page's queries to mount
        // (they subscribe within the first render frames; 2.5s is
        // comfortable), then invalidate with refetchType "active" — every
        // query the visible page holds refetches once in the background
        // while the user already sees the cached paint. Hydrated entries
        // no page mounted stay cached and untouched, same as before.
        window.setTimeout(() => {
          void queryClient.invalidateQueries({ refetchType: "active" });
        }, 2500);
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
    }
  } catch {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }

  // ── Mirror ──────────────────────────────────────────────────────────
  let timer: number | undefined;
  const schedule = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(writeNow, WRITE_DEBOUNCE_MS);
  };
  queryClient.getQueryCache().subscribe(schedule);

  // Flush the debounce when the tab goes away so the freshest data (and any
  // just-issued clear()) lands in storage even on a fast close.
  const flush = () => {
    window.clearTimeout(timer);
    writeNow();
  };
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
}
