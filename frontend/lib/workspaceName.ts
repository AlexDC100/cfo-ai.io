// workspaceName.ts — the active workspace's display name.
//
// Historically this was a standalone localStorage string, written during
// onboarding and read by the TopHeader tagline + sidebar identity. Now that a
// workspace IS an organization (lib/org.ts), the name belongs to the
// `organizations` row and this module is a thin read-through so those surfaces
// didn't have to change.
//
// THE NAME IS THIS TAB'S (2026-09-26, P0). It is the company on THIS screen —
// the header names it and the company holds (lib/companyOnScreen) wait until
// it agrees with the page. It used to be ONE browser-wide localStorage value
// that every tab re-read on the `storage` event, so two tabs on two companies
// fought forever: each tab's write was the other tab's cue to hold its page
// and write its own company back. Every flip unmounted and remounted a page,
// each remount read preferences and sessions through Supabase, and the auth
// Web Lock every tab of the origin shares queued 35,066 requests — the other
// tabs hung on "Signing you in…". Gate: components/cfo/__tests__/
// authLockFlood.test.tsx.
//
// So the value lives in memory, per tab. localStorage keeps a copy purely as
// the NEXT page load's first paint (without it the header would flash empty
// on every reload while the org list resolves); it is written, read once at
// start-up, and never listened to. lib/org.ts pushes the authoritative name in
// via `writeWorkspaceName` whenever the active workspace resolves or changes.

import { useSyncExternalStore } from "react";

const KEY = "cfoai:v1:workspace-name";
const EVENT = "cfoai:workspace-name-changed";

function readPersisted(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

// This tab's name. Seeded from the last page load's copy the first time it is
// read (not at import, so a test that seeds storage before rendering is read).
let current: string | null = null;

export function readWorkspaceName(): string {
  if (current === null) current = readPersisted();
  return current;
}

export function writeWorkspaceName(name: string): void {
  // Unchanged: nothing to tell anyone. Every org load re-asserts the name, and
  // an event per assertion re-rendered every header for nothing.
  if (readWorkspaceName() === name) return;
  current = name;
  try {
    if (name) localStorage.setItem(KEY, name);
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode — fail soft; this tab's name still changed */
  }
  try {
    window.dispatchEvent(new Event(EVENT));
  } catch {
    /* SSR / older browsers */
  }
}

function subscribe(cb: () => void): () => void {
  // THIS tab's writes only — deliberately no `storage` listener (see above).
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
}

/** Reactive read of the active workspace name — this tab's. Re-renders on a
 *  change made in this tab. Empty string when unset. */
export function useWorkspaceName(): string {
  return useSyncExternalStore(subscribe, readWorkspaceName, () => "");
}
