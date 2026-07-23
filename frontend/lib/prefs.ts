// prefs.ts — cross-device preference sync.
//
// Backs the settings that used to live only in localStorage with
// `user_prefs.prefs` (personal) and `org_prefs.prefs` (company), see
// supabase/schema_phase_prefs.sql.
//
//   · PERSONAL — follows the human everywhere: theme, UI language, learning
//     mode, dismissed banners.
//   · COMPANY  — belongs to one SRL and changes when you switch workspace:
//     display currency, decision rules, scenario levers, dashboard view.
//
// Device-local state (sidebar collapsed, panel open flags, upload-resume) is
// NOT handled here — it describes this screen, not the user or the company.
//
// ── Contract ───────────────────────────────────────────────────────────
// localStorage stays the SOURCE OF FIRST PAINT. Every store keeps its
// existing synchronous read, so nothing has to become async and no surface
// flashes a default while the network resolves. This module:
//
//   1. hydrates the remote bag once per identity / workspace,
//   2. writes each key through to localStorage AND the server,
//   3. notifies subscribers when a remote value differs from the local one,
//      so a store can adopt what another device set.
//
// Writes go through the `set_user_pref` / `set_org_pref` RPCs, which merge
// server-side with `||`. A read-modify-write from the client would let two
// stores writing different keys clobber each other.

import { useEffect, useRef } from "react";

import { getSupabase } from "@/lib/supabase";

export type PrefScope = "user" | "org";

/**
 * JSON.stringify with recursively sorted object keys.
 *
 * Postgres `jsonb` does NOT preserve key order (it sorts by length, then
 * lexicographically), so an object round-tripped through `user_prefs.prefs`
 * comes back deep-equal but serialized differently. A naive
 * JSON.stringify(a) === JSON.stringify(b) then reports "changed" on every
 * hydration — which turned usePrefSync into an infinite adopt → setState →
 * re-check loop ("Maximum update depth exceeded"). Order-insensitive
 * comparison is the fix, not a nicety.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const rec = v as Record<string, unknown>;
      return Object.keys(rec)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = rec[k];
          return acc;
        }, {});
    }
    return v;
  });
}

type Bag = Record<string, unknown>;

// Latest known server state per scope. `null` means "not hydrated yet" —
// distinct from `{}` ("hydrated, nothing set"), because only the latter is
// safe to treat as authoritative.
let userBag: Bag | null = null;
let orgBag: Bag | null = null;
let orgBagFor: string | null = null;

const listeners = new Set<(scope: PrefScope) => void>();

function emit(scope: PrefScope): void {
  listeners.forEach((l) => l(scope));
}

/** Notified when a scope's remote bag lands or changes. */
export function subscribePrefs(cb: (scope: PrefScope) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Remote value for `key`, or undefined when unset / not yet hydrated. */
export function getRemotePref<T>(scope: PrefScope, key: string): T | undefined {
  const bag = scope === "user" ? userBag : orgBag;
  if (!bag) return undefined;
  return bag[key] as T | undefined;
}

/** True once the scope's bag has been read from the server at least once. */
export function prefsHydrated(scope: PrefScope): boolean {
  return (scope === "user" ? userBag : orgBag) !== null;
}

function warn(op: string, message: string): void {
  console.warn(`[prefs] ${op} failed — staying device-local: ${message}`);
}

// ── Hydration ──────────────────────────────────────────────────────────

export async function hydrateUserPrefs(): Promise<void> {
  const client = getSupabase();
  if (!client) return;
  const { data: session } = await client.auth.getSession();
  const userId = session.session?.user?.id;
  if (!userId) {
    userBag = null;
    return;
  }
  const { data, error } = await client
    .from("user_prefs")
    .select("prefs")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    warn("hydrateUserPrefs", error.message);
    return;
  }
  userBag = (data?.prefs as Bag | null) ?? {};
  emit("user");
}

export async function hydrateOrgPrefs(orgId: string | null): Promise<void> {
  const client = getSupabase();
  if (!client || !orgId) {
    orgBag = null;
    orgBagFor = null;
    return;
  }
  // Switching workspace must not leave the previous company's settings
  // readable for even one render.
  if (orgBagFor !== orgId) {
    orgBag = null;
    orgBagFor = orgId;
    emit("org");
  }
  const { data, error } = await client
    .from("org_prefs")
    .select("prefs")
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) {
    warn("hydrateOrgPrefs", error.message);
    return;
  }
  if (orgBagFor !== orgId) return; // switched again mid-flight
  orgBag = (data?.prefs as Bag | null) ?? {};
  emit("org");
}

/** Drop everything — sign-out / user switch. */
export function resetPrefs(): void {
  userBag = null;
  orgBag = null;
  orgBagFor = null;
}

// ── Writes ─────────────────────────────────────────────────────────────

/**
 * Persist one preference. Fire-and-forget: the caller has already written
 * localStorage and re-rendered, so a failed sync degrades to device-local
 * rather than blocking the interaction.
 */
export function setPref(scope: PrefScope, key: string, value: unknown): void {
  // Optimistic local mirror so a subsequent getRemotePref sees the new value.
  if (scope === "user") {
    if (userBag) userBag = { ...userBag, [key]: value };
  } else if (orgBag) {
    orgBag = { ...orgBag, [key]: value };
  }

  const client = getSupabase();
  if (!client) return;

  void (async () => {
    const { data: session } = await client.auth.getSession();
    if (!session.session?.user) return;

    if (scope === "user") {
      const { error } = await client.rpc("set_user_pref", {
        p_key: key,
        p_value: value ?? null,
      });
      if (error) warn(`setPref(user:${key})`, error.message);
      return;
    }

    // `orgBagFor` rather than reading lib/org.ts — keeping this module free of
    // that import avoids a cycle, since org.ts drives hydration here.
    if (!orgBagFor) return;
    const { error } = await client.rpc("set_org_pref", {
      p_org_id: orgBagFor,
      p_key: key,
      p_value: value ?? null,
    });
    if (error) warn(`setPref(org:${key})`, error.message);
  })();
}

// ── React glue ─────────────────────────────────────────────────────────

/**
 * Adopt a preference set on another device.
 *
 * The store keeps owning its own state and its own localStorage format; this
 * only watches for a remote value that differs from what's on screen and hands
 * it over. Pair it with `setPref(...)` in the store's setter.
 *
 * `serialize` exists because several stores hold objects — comparing by JSON
 * avoids adopting an equal-but-not-identical value on every hydration and
 * looping.
 */
export function usePrefSync<T>(
  scope: PrefScope,
  key: string,
  value: T,
  onAdopt: (remote: T) => void,
): void {
  // The last remote value handed to onAdopt. Adopters are allowed to
  // NORMALIZE what they receive (drop unknown keys, coerce types), so the
  // post-adopt local value may legitimately never equal the remote one —
  // without this ref that too would re-adopt forever. Each distinct remote
  // value is handed over exactly once.
  const lastAdopted = useRef<string | null>(null);

  useEffect(() => {
    function check() {
      if (!prefsHydrated(scope)) return;
      const remote = getRemotePref<T>(scope, key);
      if (remote === undefined || remote === null) return;
      const remoteStr = stableStringify(remote);
      if (remoteStr === stableStringify(value)) {
        lastAdopted.current = remoteStr;
        return;
      }
      if (lastAdopted.current === remoteStr) return;
      lastAdopted.current = remoteStr;
      onAdopt(remote);
    }
    check();
    return subscribePrefs((changed) => {
      if (changed === scope) check();
    });
  }, [scope, key, value, onAdopt]);
}
