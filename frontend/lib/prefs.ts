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

// ── Local-write precedence ─────────────────────────────────────────────
//
// A value the user just set on THIS device must never be undone by a server
// read that predates it. Two ways that happened before this map existed
// (operator-reported 2026-07-26: the RON/EUR/USD toggle snapped back to RON
// moments after clicking):
//
//   1. RACE — `useActiveOrg` is mounted by many components, and every mount
//      calls load() → hydrateOrgPrefs(). One firing between the click and
//      the set_org_pref round-trip re-reads the OLD value, and usePrefSync
//      dutifully "adopts" it, reverting the click.
//   2. WRITE FAILURE — if the RPC errors (migration not applied, offline,
//      RLS), the server keeps returning the old value FOREVER, so every
//      later hydration reverts the choice again.
//
// Both are fixed by remembering what this device wrote and letting it win.
// A pending write is cleared only when the server confirms it, so case 2
// degrades to "device-local", which is this module's stated contract.
//
// A COMPANY write belongs to the company it was made for (2026-09-26, the
// live walkthrough: a comparison period chosen on Scandia's dashboard came
// back on EEI's as "period '<id>' is not in this workspace"). The pending
// map used to be keyed by the bag key alone, so an unconfirmed Scandia write
// was overlaid onto the NEXT company's freshly read bag — and the RPC read
// the active company when it fired, after `await getSession()`, so a switch
// landing in between sent Scandia's value into EEI's `org_prefs`. Company
// writes are now keyed by the company they were made for, captured when the
// setter runs, and only that company's writes shadow its bag.
const pendingUserWrites = new Map<string, unknown>();
const pendingOrgWrites = new Map<string, Map<string, unknown>>();

function pendingFor(scope: PrefScope, orgId: string | null): Map<string, unknown> | null {
  if (scope === "user") return pendingUserWrites;
  return orgId ? pendingOrgWrites.get(orgId) ?? null : null;
}

/** Overlay this device's unconfirmed writes onto a freshly-read bag — for
 *  the company scope, only the writes made for THAT company. */
function applyPendingWrites(scope: PrefScope, bag: Bag, orgId: string | null = null): Bag {
  const pending = pendingFor(scope, orgId);
  if (!pending) return bag;
  let out = bag;
  for (const [key, value] of pending) out = { ...out, [key]: value };
  return out;
}

/** Remote value for `key`, or undefined when unset / not yet hydrated.
 *  An unconfirmed local write shadows the server value (see above) — for
 *  the company scope, only a write made for the company whose bag this is. */
export function getRemotePref<T>(scope: PrefScope, key: string): T | undefined {
  const pending = pendingFor(scope, scope === "org" ? orgBagFor : null)?.get(key);
  if (pending !== undefined) return pending as T;
  const bag = scope === "user" ? userBag : orgBag;
  if (!bag) return undefined;
  return bag[key] as T | undefined;
}

/** The company whose bag the company scope holds (or is reading): the one
 *  `hydrateOrgPrefs` was last called for. Null when none. A store that is
 *  itself scoped to a company compares against this before it adopts a
 *  remote value or writes one. */
export function prefsOrgId(): string | null {
  return orgBagFor;
}

/** True once the scope's bag has been read from the server at least once. */
export function prefsHydrated(scope: PrefScope): boolean {
  return (scope === "user" ? userBag : orgBag) !== null;
}

function warn(op: string, message: string): void {
  console.warn(`[prefs] ${op} failed — staying device-local: ${message}`);
}

// ── Hydration ──────────────────────────────────────────────────────────
//
// ONE READ IN FLIGHT PER BAG (2026-09-26, defence in depth for the auth-lock
// flood). Every mounted `useActiveOrg()` — a dozen on a company page — calls
// both hydrations on each load, and each read takes supabase-js's auth Web
// Lock, which every tab of the origin shares. A page remounting in a loop
// turned that into 24 lock requests per remount. Concurrent callers now share
// the read already on its way; a call made after it settles reads afresh, so
// "hydrate again" still means what it meant.

// Bumped by resetPrefs(): a read that started before a sign-out must not
// land its answer in the next session's bag.
let generation = 0;
let userInflight: Promise<void> | null = null;
const orgInflight = new Map<string, Promise<void>>();

export function hydrateUserPrefs(): Promise<void> {
  if (userInflight) return userInflight;
  const started = generation;
  const read = (async () => {
    const client = getSupabase();
    if (!client) return;
    const { data: session } = await client.auth.getSession();
    const userId = session.session?.user?.id;
    if (started !== generation) return;
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
    if (started !== generation) return;
    userBag = applyPendingWrites("user", (data?.prefs as Bag | null) ?? {});
    emit("user");
  })();
  const shared = read.finally(() => {
    if (userInflight === shared) userInflight = null;
  });
  userInflight = shared;
  return shared;
}

export function hydrateOrgPrefs(orgId: string | null): Promise<void> {
  const client = getSupabase();
  if (!client || !orgId) {
    orgBag = null;
    orgBagFor = null;
    return Promise.resolve();
  }
  // Switching workspace must not leave the previous company's settings
  // readable for even one render.
  if (orgBagFor !== orgId) {
    orgBag = null;
    orgBagFor = orgId;
    emit("org");
  }
  const inflight = orgInflight.get(orgId);
  if (inflight) return inflight;
  const started = generation;
  const read = (async () => {
    const { data, error } = await client
      .from("org_prefs")
      .select("prefs")
      .eq("org_id", orgId)
      .maybeSingle();
    if (error) {
      warn("hydrateOrgPrefs", error.message);
      return;
    }
    if (started !== generation) return;
    if (orgBagFor !== orgId) return; // switched again mid-flight
    orgBag = applyPendingWrites("org", (data?.prefs as Bag | null) ?? {}, orgId);
    emit("org");
  })();
  const shared = read.finally(() => {
    if (orgInflight.get(orgId) === shared) orgInflight.delete(orgId);
  });
  orgInflight.set(orgId, shared);
  return shared;
}

/** Drop everything — sign-out / user switch. */
export function resetPrefs(): void {
  generation++;
  userInflight = null;
  orgInflight.clear();
  userBag = null;
  orgBag = null;
  orgBagFor = null;
  pendingUserWrites.clear();
  pendingOrgWrites.clear();
}

// ── Writes ─────────────────────────────────────────────────────────────

/**
 * Persist one preference. Fire-and-forget: the caller has already written
 * localStorage and re-rendered, so a failed sync degrades to device-local
 * rather than blocking the interaction.
 */
export function setPref(scope: PrefScope, key: string, value: unknown): void {
  // THE COMPANY THIS WRITE IS FOR, read NOW: `orgBagFor` rather than reading
  // lib/org.ts — keeping this module free of that import avoids a cycle,
  // since org.ts drives hydration here. Read again after the session await
  // below it could already name the NEXT company.
  const forOrg = scope === "org" ? orgBagFor : null;
  // No company bag yet: the write cannot be attributed to a company, so it
  // stays device-local (the caller has already written localStorage).
  if (scope === "org" && !forOrg) return;
  // Optimistic local mirror so a subsequent getRemotePref sees the new value.
  if (scope === "user") {
    if (userBag) userBag = { ...userBag, [key]: value };
  } else if (orgBag) {
    orgBag = { ...orgBag, [key]: value };
  }
  // Hold the write until the server confirms it, so a hydration that raced
  // the RPC (or an RPC that failed outright) can't revert the user's choice.
  let pending = pendingFor(scope, forOrg);
  if (!pending && forOrg) {
    pending = new Map<string, unknown>();
    pendingOrgWrites.set(forOrg, pending);
  }
  pending!.set(key, value);
  const held = pending!;

  const client = getSupabase();
  // No Supabase (signed-out / self-host): the choice is device-local and the
  // pending entry is the only thing keeping it authoritative. Keep it.
  if (!client) return;

  void (async () => {
    const { data: session } = await client.auth.getSession();
    if (!session.session?.user) return;

    if (scope === "user") {
      const { error } = await client.rpc("set_user_pref", {
        p_key: key,
        p_value: value ?? null,
      });
      if (error) { warn(`setPref(user:${key})`, error.message); return; }
      // Confirmed — later reads can come from the server again. Guard against
      // clearing a NEWER write that landed while this request was in flight.
      if (held.get(key) === value) held.delete(key);
      return;
    }

    const { error } = await client.rpc("set_org_pref", {
      p_org_id: forOrg,
      p_key: key,
      p_value: value ?? null,
    });
    if (error) { warn(`setPref(org:${key})`, error.message); return; }
    if (held.get(key) === value) held.delete(key);
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
  /** A company-scoped store names the company it holds (null: none yet).
   *  Only THAT company's bag is then adopted, and a change of company starts
   *  the hand-over afresh. Omitted: whichever company bag is hydrated. */
  owner?: string | null,
): void {
  // The last remote value handed to onAdopt. Adopters are allowed to
  // NORMALIZE what they receive (drop unknown keys, coerce types), so the
  // post-adopt local value may legitimately never equal the remote one —
  // without this ref that too would re-adopt forever. Each distinct remote
  // value is handed over exactly once — per company, for a store that names
  // its company.
  const lastAdopted = useRef<string | null>(null);
  const lastOwner = useRef<string | null | undefined>(owner);

  useEffect(() => {
    if (lastOwner.current !== owner) {
      lastOwner.current = owner;
      lastAdopted.current = null;
    }
    function check() {
      if (!prefsHydrated(scope)) return;
      if (owner !== undefined && scope === "org" && (!owner || orgBagFor !== owner)) return;
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
  }, [scope, key, value, onAdopt, owner]);
}
