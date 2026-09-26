// previewFeatures.ts — the routes that swap WHOLE SCREENS on a preview.
//
// The engine's feature registry (`GET /api/features/status`, lib/features.ts)
// gained a fourth status on 2026-09-21: `preview`. Who sees it is decided in
// ONE place — `applyPreview` in lib/features.ts, the deployed per-account
// early-access mechanism: a signed-in user whose personal preference bag
// (`user_prefs.prefs.preview_features`, a JSON array of keys) names the key is
// served the row as `active` + `beta`; everyone else keeps the registry's
// answer, and `preview` reads as off (the current UI, unchanged). `active`
// is on for everybody (the engine's CFO_FEATURES_ACTIVE env promotes a key to
// `active` per request, no rebuild). This module adds NO second decision:
// `useFeatures()` already resolves the preview; what it adds is the hold.
//
// THE HOLD. The opt-in list is read from the prefs module (lib/prefs.ts),
// which hydrates `user_prefs.prefs` once per identity — asynchronously. A
// route that swaps whole screens (`/workspace`: the redesign or the current
// page) must not paint the old screen for one round-trip and then replace it,
// so the last known list is cached per user id in localStorage purely for
// first paint, and `loading` stays true while nothing is known yet. The cache
// is uid-scoped — a different user on the same browser misses it rather than
// inheriting someone else's opt-in. The cached list goes through the SAME
// `applyPreview`, so the early answer and the settled one cannot disagree.
//
// Defensive reads on purpose: these hooks are called by app-wide surfaces
// (AppShell, the dashboard, the bell) that also render in isolation — in a
// test with no <AuthProvider>, or with a partial module mock. A gate that
// cannot see a session is simply OFF; it must never take the surface down.

import { useEffect, useState } from "react";

import { useAuth } from "@/lib/auth";
import {
  PREVIEW_PREF_KEY,
  applyPreview,
  isFeatureActive,
  useFeatures,
  type FeatureKey,
  type FeatureStatus,
} from "@/lib/features";
import { getRemotePref, prefsHydrated, subscribePrefs } from "@/lib/prefs";

export { PREVIEW_PREF_KEY };

const CACHE_KEY = "cfoai.preview_features.v1";

/** Pure decision, exported for tests — `applyPreview` on one row. A
 *  signed-out viewer carries no opt-in list. */
export function isFeatureOnFor(
  status: FeatureStatus | undefined,
  optedIn: readonly string[],
  key: FeatureKey,
  signedIn: boolean,
): boolean {
  if (!status) return false;
  const one = { [key]: { status, label: "", description: "" } };
  return isFeatureActive(applyPreview(one, signedIn ? [...optedIn] : [])[key]?.status);
}

function normalizeKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function readCache(uid: string): string[] | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { uid?: unknown; keys?: unknown } | null;
    if (!parsed || parsed.uid !== uid) return null;
    return normalizeKeys(parsed.keys);
  } catch {
    return null;
  }
}

function writeCache(uid: string, keys: string[]): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ uid, keys }));
  } catch {
    /* private mode — the remote read still works this session */
  }
}

function sameKeys(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

/** The signed-in user's id, or null (signed out, loading, or no provider). */
function useSignedInUid(): string | null {
  let state: ReturnType<typeof useAuth> | null = null;
  try {
    state = useAuth();
  } catch {
    state = null;
  }
  return state && state.status === "signed_in" && state.user ? state.user.id : null;
}

/** The preview keys the signed-in user opted into (empty when signed out).
 *  `settled` is false only while nothing is known yet — no cached list and
 *  the remote bag not read — so a screen-swapping route can hold instead of
 *  painting the old screen for one round-trip. */
export function usePreviewKeys(uid: string | null): { keys: string[]; settled: boolean } {
  const [state, setState] = useState<{ keys: string[]; settled: boolean }>(() => {
    if (!uid) return { keys: [], settled: true };
    const cached = readCache(uid);
    return { keys: cached ?? [], settled: cached !== null };
  });

  useEffect(() => {
    if (!uid) {
      setState((prev) => (prev.keys.length || !prev.settled ? { keys: [], settled: true } : prev));
      return undefined;
    }
    const sync = () => {
      let hydrated = false;
      try {
        hydrated = prefsHydrated("user");
      } catch {
        // No prefs module to wait for (tests) — nothing will ever arrive.
        hydrated = true;
      }
      let next: { keys: string[]; settled: boolean };
      if (hydrated) {
        let remote: unknown;
        try {
          remote = getRemotePref<unknown>("user", PREVIEW_PREF_KEY);
        } catch {
          remote = undefined;
        }
        const keys = normalizeKeys(remote);
        writeCache(uid, keys);
        next = { keys, settled: true };
      } else {
        const cached = readCache(uid);
        next = { keys: cached ?? [], settled: cached !== null };
      }
      setState((prev) =>
        prev.settled === next.settled && sameKeys(prev.keys, next.keys) ? prev : next,
      );
    };
    sync();
    let unsubscribe: () => void = () => {};
    try {
      unsubscribe = subscribePrefs((scope) => {
        if (scope === "user") sync();
      });
    } catch {
      /* partial prefs module (tests) — the first read above stands */
    }
    // A prefs read that FAILS never emits. Stop waiting after a moment and
    // show what is known (OFF) rather than holding a route forever.
    const giveUp = setTimeout(() => {
      setState((prev) => (prev.settled ? prev : { ...prev, settled: true }));
    }, 4000);
    return () => {
      clearTimeout(giveUp);
      unsubscribe();
    };
  }, [uid]);

  return uid ? state : { keys: [], settled: true };
}

/** Is `key` on for the viewer? `loading` is true until the registry lands —
 *  a route that swaps whole screens on this should hold rather than flash
 *  the old screen first. The registry row already carries `applyPreview`'s
 *  answer from the hydrated prefs; the uid-scoped cache feeds the same
 *  function for the paint before hydration. */
export function useFeatureEnabled(key: FeatureKey): { enabled: boolean; loading: boolean } {
  const { features, loading } = useFeatures();
  const uid = useSignedInUid();
  const { keys, settled } = usePreviewKeys(uid);
  const status = features[key]?.status;
  return {
    enabled: isFeatureOnFor(status, keys, key, !!uid),
    // Waiting is only worth it when the answer can still flip to ON.
    loading: !!loading || (status === "preview" && !!uid && !settled),
  };
}

/** The workspace redesign (one company per workspace, one upload component). */
export function useWorkspaceV2(): boolean {
  return useFeatureEnabled("workspace_v2").enabled;
}

/** Same, with the registry's loading flag — for the routes that swap screens. */
export function useWorkspaceV2State(): { enabled: boolean; loading: boolean } {
  return useFeatureEnabled("workspace_v2");
}

/** Where an "Upload" shortcut (palette row, capsule menu, command center)
 *  leads: the redesign's home, whose drop zone is the one upload component —
 *  or `legacy` (the current dashboard upload surface) with the flag off. */
export function useUploadRoute(legacy: string): string {
  return useWorkspaceV2() ? "/workspace" : legacy;
}
